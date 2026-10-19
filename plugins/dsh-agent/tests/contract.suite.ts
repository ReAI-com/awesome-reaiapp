import { defineContractSuite } from "@reai/app-test/v1";

const session = {
  sessionId: "s1",
  agentSessionId: "agent-1",
  source: { appId: "com.reai.voice", name: "Voice", iconDataUrl: null, installed: true, openable: true, unavailableReason: null },
  title: "整理今天的语音记录",
  status: "completed",
  currentTask: null,
  outcome: { kind: "completed", status: "completed", summary: "回合已完成", error: null },
  nextAction: { kind: "return_to_source", label: "回到来源 App", enabled: true, reason: null },
  updatedMs: 1_700_000_000_000,
  createdMs: 1_699_999_999_000,
  startedMs: 1_699_999_999_500,
  durationMs: 500,
  stale: false,
  orphan: false,
  turnCount: 1,
  workspace: "/App Support/reai-vibe-board/dsh/workspace",
  modelAlias: "text-default",
  currentTurnId: null,
  configurationKnown: true,
};

export default defineContractSuite({
  appDirectory: "..",
  hostApi: "1.25.0",
  expect: {
    surfaces: ["main"],
    commands: ["com.reai.dsh-agent.back-to-root", "com.reai.dsh-agent.open-settings"],
    intents: [],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all",
    noResourcesAfterUnmount: true,
  },
  scenarios: [{
    name: "安装后作为普通插件展示真实 DSH 数据并只设置新会话模型",
    async run({ host }) {
      host.setDshObserverSnapshot({
        schemaVersion: 1,
        revision: 1,
        runtime: {
          state: "available", code: "ready", detail: "DSH runtime ready", target: "test",
          dshVersion: "1", profileVersion: "1", workspace: session.workspace,
          components: [{ id: "@deepseek-ai/dsh-base", version: "1.0.0", digest: "sha256:base" }],
        },
        sessions: [session],
      });
      host.setDshObserverSessionDetail({
        schemaVersion: 1, revision: 1, sessionRevision: 1, sessionId: "s1", agentSessionId: "agent-1", source: session.source,
        modelAlias: "text-default", configurationKnown: true, systemPromptConfigured: true, systemPromptDigest: "sha256:redacted", systemPromptChars: 42,
        skills: [{ id: "daily", title: "当日总结", digest: "sha256:skill" }],
        tools: [{ id: "read_context", source: "host", permission: "read_only", available: true, reason: null }], currentTask: null, historyTruncated: false,
        diagnostics: { sessionId: "s1", agentSessionId: "agent-1", currentTurnId: null, workspace: session.workspace, profileVersion: "1", dshVersion: "1" },
      });
      host.setDshObserverHistoryPage({
        schemaVersion: 1, revision: 1, sessionRevision: 1, sessionId: "s1", cursor: null, nextCursor: null, historyTruncated: false,
        items: [{ kind: "assistant_message", text: "已整理完成", seq: 1, time_ms: 1 }],
      });
      host.setDshObserverSettings({
        selectedModel: "text-default",
        options: [
          { id: "text-default", label: "通用文本", availability: "available", reason: null },
          { id: "text-quality", label: "高质量文本", availability: "available", reason: null },
        ],
      });
      const main = await host.openSurface("main");
      const root = main.root;
      if (!root?.textContent?.includes("整理今天的语音记录")) throw new Error("没有展示真实会话");
      root.querySelector<HTMLButtonElement>('[data-tab="conversation"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!root.textContent.includes("已整理完成")) throw new Error("没有展示分页历史");
      root.querySelector<HTMLButtonElement>('[data-tab="capabilities"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!root.textContent.includes("完整内容不下发 WebView")) throw new Error("没有展示脱敏边界");
      if (root.textContent.includes("清空全部会话")) {
        throw new Error("透明度插件出现了会话管理能力");
      }
      await host.sendIntent(main.surfaceMountId, {
        source: "host.titlebarAction",
        actionId: "settings",
        deliveryId: "dsh-settings-1",
        payload: { type: "open-settings" },
      });
      if (!root.textContent.includes("DSH 设置")) throw new Error("标题栏设置没有打开");
      const localeSelect = root.querySelector("[data-default-model]");
      host.setLocale("en");
      if (!root.textContent.includes("DSH settings")) throw new Error("Host locale did not update settings");
      if (main.navReports.at(-1)?.label !== "Settings") throw new Error("Navigation label stayed Chinese");
      if (root.querySelector("[data-default-model]") !== localeSelect) throw new Error("Locale replaced select");
      host.setLocale("zh");
      if (!root.textContent.includes("仅影响之后创建的新会话")) throw new Error("新会话边界没有说清楚");
      if (!root.textContent.includes("@deepseek-ai/dsh-base")) throw new Error("没有展示只读 runtime 组件");
      for (const forbidden of ["安装组件", "停用组件", "卸载组件", "升级组件"]) {
        if (root.textContent.includes(forbidden)) throw new Error(`出现了越界操作：${forbidden}`);
      }
      const select = root.querySelector<HTMLSelectElement>("[data-default-model]");
      if (!select) throw new Error("缺少默认模型选择器");
      select.value = "text-quality";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const settled = await host.invokeCommand("com.reai.dsh-agent.back-to-root");
      if (!settled.ok || !root.textContent.includes("真实会话")) throw new Error("面包屑返回主页失败");
      if (main.navReports.at(-1) !== null) throw new Error("返回主页后没有清理面包屑");
      const methods = host.dshObserverRequests.map((item) => item.method);
      for (const method of ["dsh.observe.snapshot", "dsh.observe.session.detail", "dsh.observe.session.history.page", "dsh.observe.settings", "dsh.observe.settings.update"]) {
        if (!methods.includes(method)) throw new Error(`缺少 observer 方法：${method}`);
      }
    },
  }],
});
