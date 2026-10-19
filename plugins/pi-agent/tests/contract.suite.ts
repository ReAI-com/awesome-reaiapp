import { defineContractSuite } from "@reai/app-test/v1";

async function waitUntil(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const snapshot = {
  runtime: { state: "ready" as const, scope: "app-bundled" as const },
  turns: [{
    key: "voice:s1:t1",
    appId: "com.reai.voice",
    logicalSessionId: "s1",
    turnId: "t1",
    state: "active" as const,
    summary: "整理今天的输入摘要",
    startedMs: 1_700_000_000_000,
    temporary: false,
  }],
  sessions: [{
    sessionId: "s1",
    appId: "com.reai.voice",
    appName: "Voice",
    title: "整理今天的输入摘要",
    status: "active" as const,
    temporary: false,
    createdMs: 1_700_000_000_000,
    updatedMs: 1_700_000_000_100,
    model: "text-default",
    workspace: "App 私有工作区",
    directory: "pi-agent/sessions/voice/s1",
    systemPrompt: "只整理用户当天的输入，不编造事实。",
    skills: [{ id: "daily-digest", title: "当日总结", digest: "sha256:demo" }],
    tools: ["read_context"],
    mcp: [],
    memory: "session" as const,
  }],
  settings: { defaultModel: "text-default", appOverrides: {} },
};

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.25.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.pi-agent.back-to-root", "com.reai.pi-agent.open-settings"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [
    {
      name: "只读页按插件展示目录、环境、任务、Skill、Tools 与 MCP",
      async run({ host }) {
        host.setPiManagementSnapshot(snapshot);
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        if (!root.textContent?.includes("整理今天的输入摘要")) throw new Error("没有展示当前任务");
        if (!root.textContent.includes("pi-agent/sessions/voice/s1")) throw new Error("没有展示脱敏目录");
        if (!root.textContent.includes("App 私有工作区")) throw new Error("没有展示运行环境");
        if (!root.textContent.includes("不读取电脑独立安装的 Pi 或 DSH")) throw new Error("隔离边界没有说清楚");

        root.querySelector<HTMLButtonElement>('[data-tab="config"]')?.click();
        if (!root.textContent?.includes("只整理用户当天的输入")) throw new Error("没有展示系统提示词");
        if (!root.textContent.includes("当日总结")) throw new Error("没有展示 Skill");
        if (!root.textContent.includes("read_context")) throw new Error("没有展示 Tools");
        if (!root.textContent.includes("未连接")) throw new Error("没有展示 MCP 状态");

        const search = root.querySelector<HTMLInputElement>(".pa-search input");
        if (!search) throw new Error("缺少会话搜索");
        search.value = "不存在";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        if (!root.textContent?.includes("没有匹配的会话")) throw new Error("搜索没有过滤列表");
      },
    },
    {
      name: "标题栏进入设置、保存新会话模型，再经面包屑命令返回主页",
      async run({ host }) {
        host.setPiManagementSnapshot(snapshot);
        host.setPiManagementModels([
          { id: "text-default", label: "通用文本", verified: true, selectable: true },
          { id: "text-fast", label: "快速文本", verified: true, selectable: true },
          { id: "text-quality", label: "高质量文本", verified: false, selectable: false },
        ]);
        const main = await host.openSurface("main");
        const root = main.root;
        if (!root) throw new Error("DOM 环境不可用");
        await host.sendIntent(main.surfaceMountId, {
          source: "host.titlebarAction",
          actionId: "settings",
          deliveryId: "pi-settings-1",
          payload: { type: "open-settings" },
        });
        if (!root.textContent?.includes("Pi Agent 设置")) throw new Error("标题栏设置没有打开");
        if (main.navReports.at(-1)?.key !== "settings") throw new Error("设置页没有上报面包屑");
        const localeSelect = root.querySelector("[data-default]");
        host.setLocale("en");
        if (!root.textContent.includes("Pi Agent settings")) throw new Error("Host locale did not update settings");
        if (main.navReports.at(-1)?.label !== "Settings") throw new Error("Navigation label stayed Chinese");
        if (root.querySelector("[data-default]") !== localeSelect) throw new Error("Locale replaced select");
        host.setLocale("zh");
        const quality = root.querySelector<HTMLOptionElement>('option[value="text-quality"]');
        if (!quality?.disabled) throw new Error("未验证模型没有 fail closed");

        const select = root.querySelector<HTMLSelectElement>("[data-default]");
        if (!select) throw new Error("缺少默认模型选择器");
        select.value = "text-fast";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await waitUntil(
          () => host.piManagementRequests.some((request) =>
            request.method === "pi.management.settings.update" &&
            (request.params as { defaultModel?: string }).defaultModel === "text-fast"
          ),
          "模型设置没有保存到 Host",
        );

        const settled = await host.invokeCommand("com.reai.pi-agent.back-to-root");
        if (!settled.ok) throw new Error("返回主页命令失败");
        if (!root.textContent?.includes("范围：App 内 Agent")) throw new Error("没有回到管理主页");
        if (main.navReports.at(-1) !== null) throw new Error("返回主页后没有清理面包屑");
      },
    },
  ],
});
