/**
 * §6.0（#waiting-failure-minimum）在真实 SDK → MockHost 线路上的端到端行为：
 * Voice 页可见时经 system.tasks@1 读 App（Host）版本；复制诊断真的写进剪贴板；
 * Host 浮层（结果面板 / 任务卡）只拿安全诊断——码、步骤、两端版本、时间，没有上游原文与用户说的话。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import {
  COMMAND_HISTORY_KEY,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  POLISH_LIGHT_DEFAULT_MIGRATION_KEY,
  type VoiceCommandHistoryItem,
  type VoiceHistoryItem,
} from "../src/data";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { VOICE_PLUGIN_VERSION } from "../src/voice-diagnostics";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(check(), message).toBeTrue();
}
const settle = () => new Promise(resolve => setTimeout(resolve, 40));

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
const STDERR = "INVALID_REQUEST: upstream echoed 测试语音命令 with Authorization: Bearer abc.def and sk-ABCDEFGH1234 phone 13800138000 enc %E6%B5%8B%E8%AF%95";

async function harness(
  hook?: (ctx: AppContext) => void,
  versionStatus?: () => Promise<unknown>,
  rewrite?: (method: string, result: unknown) => unknown,
) {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?diagnostics=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" });
        hook?.(ctx);
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const clipboard: string[] = [];
  let versionCalls = 0;
  wire.handleRequest = async (method, params) => {
    if (method === "clipboard.writeText") clipboard.push(String(params.text));
    if (method === "system.tasks.version-status" && versionStatus) {
      versionCalls += 1;
      return await versionStatus();
    }
    if (method === "environment.get") return { developerMode: true };
    const result = await original(method, params);
    return rewrite ? rewrite(method, result) : result;
  };
  await host.installAndEnable();
  const answers = () => host.voiceCommandRequests
    .filter(request => request.method === "voice.command.present-answer")
    .map(request => request.params as { status?: string; canCopy?: boolean; text?: string; sections?: { label: string; text: string }[] });
  const tasks = () => host.voiceCommandRequests
    .filter(request => request.method === "voice.command.present-task")
    .map(request => request.params as { state?: string; stageLabel?: string });
  const history = async () => await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [];
  const inputHistory = async () => await context!.storage.private("voice-state").get<VoiceHistoryItem[]>("history") ?? [];
  const run = async (eventId: string) => {
    expect((await host.invokeCommand(eventId)).ok).toBeTrue();
    expect((await host.invokeCommand(eventId)).ok).toBeTrue();
  };
  return {
    host, clipboard, answers, tasks, history, inputHistory, run, versionCalls: () => versionCalls,
    dispose: async () => { try { await host.disable(); } finally { wire.handleRequest = original; } },
  };
}

test("前台结果面板：回答分段是去掉 Markdown 标记的纯文本（Host 按纯文本显示），「复制」仍是模型原文", async () => {
  const h = await harness();
  try {
    const reply = "## 明天天气\n\n**天气：**多云转晴\n- **气温：**18~26℃\n- 风力 3级";
    h.host.setNextAgentSendText(reply);
    await h.run("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 回答进入前台结果面板");
    const answer = h.answers()[0]!;
    expect(answer.status).toBe("succeeded");
    const section = answer.sections?.find(item => item.label === t("app.answer"))?.text;
    expect(section).toBe("明天天气\n天气：多云转晴\n• 气温：18~26℃\n• 风力 3级");
    expect(section).not.toContain("**");
    expect(answer.text).toBe(reply);
  } finally { await h.dispose(); }
});

test("前台失败面板：复制内容是主句 + 白名单诊断；原文不落盘、不复制，只在页面主动展开；复制真的写进剪贴板", async () => {
  const h = await harness();
  try {
    h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: STDERR });
    await h.run("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 失败进入前台结果面板");
    const answer = h.answers()[0]!;
    expect(answer.status).toBe("failed");
    expect(answer.canCopy).toBeTrue();
    expect(answer.text).not.toContain("AGENT_ENGINE");
    // Host API 1.22（#953）：结构化错误码单独交给面板；原始原因（detail）不传。
    expect((answer as { errorCode?: string }).errorCode).toBe("AGENT_ENGINE");
    expect(answer).not.toHaveProperty("detail");
    expect(answer.text).not.toContain(VOICE_PLUGIN_VERSION);
    expect(answer.text).not.toContain("当前步骤:");
    // 浮层对旁人可见：诊断不带上游原文、凭据与用户说的话；业务内容（原话一节）照旧。
    for (const leaked of ["INVALID_REQUEST", "Bearer", "sk-ABCDEFGH1234", "测试语音命令", "13800138000", "%E6%B5%8B"]) expect(answer.text).not.toContain(leaked);
    expect(answer.sections?.find(section => section.label === "原文")?.text).toBe("测试语音命令");
    expect(answer.sections?.find(section => section.label === "诊断信息")).toBeUndefined();

    const [item] = await h.history();
    // 落盘只有结构化字段：原文字符数、来源类别、时间；上游原文（含回显的原话与凭据）一个字都不落。
    expect(item!.errorRawLength).toBeGreaterThan(0);
    expect(item!.errorSource).toBe("agent");
    for (const leaked of ["upstream echoed", "INVALID_REQUEST", "abc.def", "sk-ABCDEFGH1234"]) expect(JSON.stringify(item)).not.toContain(leaked);
    expect(Number.isFinite(Date.parse(item!.failedAt!))).toBeTrue();

    // 打开 Voice 页 = 可见 Surface：读一次 App 版本，失败条目的诊断能复制到剪贴板。
    const main = await h.host.openSurface("main");
    const root = main.root!;
    await until(() => h.host.systemTaskRequests.some(request => request.method === "system.tasks.version-status"), "Voice 页可见后读 App 版本");
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    (root.querySelector(".command-history-item") as HTMLButtonElement).click();
    await until(() => root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-versions")?.textContent
      === `Voice ${VOICE_PLUGIN_VERSION} · App 0.1.0`, "诊断状态行显示插件与 App 版本");
    (root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-toggle") as HTMLButtonElement).click();
    (root.querySelector(".voice-diag-copy") as HTMLButtonElement).click();
    await until(() => h.clipboard.length === 1, "复制诊断经 surface.clipboard@1 写入剪贴板");
    const copied = h.clipboard[0]!;
    expect(copied).toContain("App 版本: 0.1.0");
    expect(copied).toContain("错误码: AGENT_ENGINE");
    expect(copied).toContain(`原始原因: 原始信息可能含用户内容，已省略（${item!.errorRawLength} 字符）`);
    expect(copied).toContain("错误来源: Agent (agent)");
    for (const leaked of ["测试语音命令", "kind: engine", "upstream echoed", "Bearer", "abc.def", "sk-ABCDEFGH1234", "13800138000", "%E6%B5%8B"]) expect(copied).not.toContain(leaked);
    // 原文只在插件自己的界面里、用户主动展开时可见（本次运行的内存里）。
    const expander = root.querySelector<HTMLDetailsElement>(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-rawbox");
    expect(expander?.open).toBeFalse();
    expect(expander?.querySelector(".voice-diag-rawtext")?.textContent).toContain("upstream echoed");
    expect(h.host.systemTaskRequests.filter(request => request.method === "system.tasks.version-status")).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("Agent 失败按 Host 阶段细化（2.14.2）：面板与历史主句说人话，阶段 / 退出码 / 上游码进浮层、落盘与复制，原文只在展开区", async () => {
  const h = await harness();
  const tail = "DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: upstream echoed 测试语音命令 Authorization: Bearer abc.def";
  try {
    h.host.rejectNextAgentSend({ kind: "engine", code: "AGENT_ENGINE", message: `引擎错误：${tail}`, stderr_tail: tail } as never);
    await h.run("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 失败进入前台结果面板");
    const answer = h.answers()[0]!;
    const sentence = "上游模型限流。你的内容已保存，请稍后重新发送。";
    expect(answer.sections?.find(section => section.label === "错误")?.text).toBe(sentence);
    expect(answer.text).toStartWith(sentence);
    for (const line of ["错误码: AGENT_ENGINE", "Agent 阶段: 引擎异常退出 (DSH_ENGINE_EXITED)", "引擎退出码: 1", "引擎上报的上游码: AI_RATE_LIMITED"]) {
      expect(answer.text).not.toContain(line);
    }
    for (const leaked of ["Error:", "upstream echoed", "Bearer", "abc.def"]) expect(answer.text).not.toContain(leaked);

    const [item] = await h.history();
    expect(item).toMatchObject({ errorCode: "AGENT_ENGINE", errorAgentStage: "DSH_ENGINE_EXITED", errorExitCode: 1,
      errorUpstreamCode: "AI_RATE_LIMITED", userMessage: sentence });
    expect(item!.messages?.at(-1)?.text).toBe(sentence);
    for (const leaked of ["Error:", "upstream echoed", "Bearer", "abc.def"]) expect(JSON.stringify(item)).not.toContain(leaked);

    const main = await h.host.openSurface("main");
    const root = main.root!;
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    (root.querySelector(".command-history-item") as HTMLButtonElement).click();
    const toggle = () => root.querySelector<HTMLButtonElement>(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-toggle");
    await until(() => toggle() !== null, "失败条目挂诊断");
    toggle()!.click();
    const rows = () => root.querySelector(".voice-diag[data-diag-key^='chat-failed'] dl")?.textContent ?? "";
    await until(() => rows().includes("引擎退出码1"), "诊断区列出阶段字段");
    expect(rows()).toContain("Agent 阶段引擎异常退出 (DSH_ENGINE_EXITED)");
    expect(rows()).toContain("引擎上报的上游码AI_RATE_LIMITED");
    (root.querySelector(".voice-diag-copy") as HTMLButtonElement).click();
    await until(() => h.clipboard.length === 1, "复制诊断写入剪贴板");
    const copied = h.clipboard[0]!;
    for (const line of ["Agent 阶段: 引擎异常退出 (DSH_ENGINE_EXITED)", "引擎退出码: 1", "引擎上报的上游码: AI_RATE_LIMITED"]) expect(copied).toContain(line);
    for (const leaked of ["Error:", "upstream echoed", "Bearer", "abc.def", "测试语音命令"]) expect(copied).not.toContain(leaked);
    // 原文未经改动，只在用户主动展开的原始信息区。
    expect(root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-rawtext")?.textContent).toContain(tail);
  } finally { await h.dispose(); }
});

test("Host 给的具体失败码（预算）原样保留：面板、历史、胶囊都说对应人话并显示该码，不再包成 AGENT_ENGINE（V1.0 真机回归）", async () => {
  const h = await harness();
  try {
    h.host.rejectNextAgentSend({ kind: "engine", code: "AGENT_MODEL_BUDGET_EXCEEDED",
      message: "这次任务已达到模型调用次数上限，尚未完成。请缩小问题后再试。", stderr_tail: "AGENT_MODEL_BUDGET_EXCEEDED" } as never);
    await h.run("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 失败进入前台结果面板");
    const answer = h.answers()[0]! as { errorCode?: string; text?: string; sections?: { label: string; text: string }[] };
    const sentence = "这次任务已达到模型调用次数上限，请缩小问题后再试。你的内容已保存。";
    expect(answer.errorCode).toBe("AGENT_MODEL_BUDGET_EXCEEDED");
    expect(answer.sections?.find(section => section.label === "错误")?.text).toBe(sentence);
    expect(answer.text).toBe(sentence);
    expect(answer.text).not.toContain("AGENT_ENGINE");
    const [item] = await h.history();
    expect(item).toMatchObject({ errorCode: "AGENT_MODEL_BUDGET_EXCEEDED", userMessage: sentence });
    const main = await h.host.openSurface("main");
    const root = main.root!;
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    (root.querySelector(".command-history-item") as HTMLButtonElement).click();
    await until(() => (root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-code")?.textContent ?? "")
      .includes("AGENT_MODEL_BUDGET_EXCEEDED"), "Voice 页失败条目显示该码");
  } finally { await h.dispose(); }
});

test("Host 给的未登记失败码：走兜底主句，不改写成 AGENT_ENGINE；导出只写个数，码在展开区原文里", async () => {
  const h = await harness();
  try {
    h.host.rejectNextAgentSend({ kind: "engine", code: "AGENT_FUTURE_THING", stderr_tail: "Error: legacy crash" } as never);
    await h.run("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "Agent 失败进入前台结果面板");
    const answer = h.answers()[0]! as { errorCode?: string; text?: string; sections?: { label: string; text: string }[] };
    expect(answer.sections?.find(section => section.label === "错误")?.text).toBe("暂时无法生成回复。你的内容已保存，请稍后重新发送。");
    expect(answer.errorCode).toBeUndefined();
    expect(answer.text).not.toContain("AGENT_ENGINE");
    const [item] = await h.history();
    expect(item!.errorCode).toBeUndefined();
    expect(item!.errorOmittedCodes).toBe(1);
    const main = await h.host.openSurface("main");
    const root = main.root!;
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    (root.querySelector(".command-history-item") as HTMLButtonElement).click();
    const toggle = () => root.querySelector<HTMLButtonElement>(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-toggle");
    await until(() => toggle() !== null, "失败条目挂诊断");
    toggle()!.click();
    (root.querySelector(".voice-diag-copy") as HTMLButtonElement).click();
    await until(() => h.clipboard.length === 1, "复制诊断");
    expect(h.clipboard[0]).toContain("未登记的错误码: 1 个");
    expect(h.clipboard[0]).not.toContain("AGENT_FUTURE_THING");
    expect(h.clipboard[0]).not.toContain("AGENT_ENGINE");
    expect(root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-rawtext")?.textContent).toContain("AGENT_FUTURE_THING");
  } finally { await h.dispose(); }
});

test("段总结失败：诊断沿用已采集的上游码与完整原文，不因包成插件码而丢；原文不进复制", async () => {
  const h = await harness();
  try {
    const start = new Date();
    start.setHours(9, 48, 0, 0);
    h.host.setVoiceRecordings([{ id: "seg-2", wallStartMs: start.getTime(), durationMs: 7 * 60_000, transport: "usb_vendor_hid",
      transcriptText: "扩展商城得能试用。", transcribedAtMs: start.getTime() + 1_000 }]);
    const main = await h.host.openSurface("main");
    const root = main.root!;
    await until(() => root.querySelector('[data-voice-tab="context"]') !== null, "Voice 主页渲染出 Context 档");
    root.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')!.click();
    await until(() => root.querySelector(".recording-copy") !== null, "Context 档列出段");
    root.querySelector<HTMLButtonElement>(".recording-copy")!.click();
    await until(() => root.querySelector(".ctx-view") !== null, "进入段详情页");
    Array.from(root.querySelectorAll<HTMLButtonElement>(".ctx-tab")).find((tab) => tab.textContent === "总结")!.click();
    h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: STDERR });
    root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]')!.click();
    const toggle = () => root.querySelector<HTMLButtonElement>(".ctx-view .voice-error-block .voice-diag-toggle");
    await until(() => toggle() !== null, "总结失败就地报错并挂诊断");
    toggle()!.click();
    const panel = () => root.querySelector(".ctx-view .voice-error-block .voice-diag-panel");
    await until(() => panel() !== null, "展开诊断");
    const rows = panel()!.querySelector("dl")!.textContent ?? "";
    // 外层是插件包的码，真实的上游码与原文字符数保留下来。
    expect(rows).toContain("错误码com.reai.voice/DSH_ENGINE");
    expect(rows).toContain("上游错误码DSH_ENGINE");
    expect(rows).toContain("错误来源Agent (agent)");
    expect(rows).toMatch(/已省略（\d+ 字符）/);
    expect(panel()!.querySelector(".voice-diag-rawtext")?.textContent).toContain("upstream echoed");
    for (const leaked of ["upstream echoed", "13800138000", "Bearer"]) expect(rows).not.toContain(leaked);
  } finally { await h.dispose(); }
});

test("命令失败交回 SDK / Host 的回执只有登记码与固定文案：未登记码、上游 userMessage、带凭据的 cause 都不出插件", async () => {
  const SECRET = "Authorization: Bearer syntheticSecret";
  const h = await harness((ctx) => {
    Object.assign(ctx.agent, { backends: async () => {
      throw Object.assign(new Error(SECRET), { code: "PRIVATE_ACCOUNT_DATA", userMessage: "Host said 13800138000", cause: SECRET });
    } });
  });
  try {
    const settlement = await h.host.invokeCommand("com.reai.voice.command.agent");
    const wire = JSON.stringify(settlement);
    expect(settlement.ok).toBeFalse();
    for (const leaked of ["PRIVATE_ACCOUNT_DATA", "syntheticSecret", "13800138000", "Host said"]) expect(wire).not.toContain(leaked);
    expect(wire).toContain("com.reai.voice/VOICE_COMMAND_FAILED");
  } finally { await h.dispose(); }
});

test("未登记的码：条目只存个数，同一次运行与重开页面后复制诊断都写「未登记的错误码」，码本身不落盘", async () => {
  const UNREGISTERED = ("ghp_" + "A".repeat(36));
  const h = await harness((ctx) => {
    Object.assign(ctx.agent, { waitForTurn: async () => { throw Object.assign(new Error("upstream failed"), { code: UNREGISTERED }); } });
  });
  try {
    await h.run("com.reai.voice.command.agent");
    for (let index = 0; index < 300 && !(await h.history()).some((entry) => entry.status === "failed"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [item] = await h.history();
    expect(item!.errorOmittedCodes).toBe(1);
    expect(JSON.stringify(item)).not.toContain(UNREGISTERED);
    const main = await h.host.openSurface("main");
    const root = main.root!;
    await until(() => root.querySelector('[data-voice-tab="command"]') !== null, "Voice 页渲染");
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    (root.querySelector(".command-history-item") as HTMLButtonElement).click();
    await until(() => root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-toggle") !== null, "失败条目挂诊断");
    (root.querySelector(".voice-diag[data-diag-key^='chat-failed'] .voice-diag-toggle") as HTMLButtonElement).click();
    (root.querySelector(".voice-diag-copy") as HTMLButtonElement).click();
    await until(() => h.clipboard.length === 1, "复制诊断");
    expect(h.clipboard[0]).toContain("未登记的错误码: 1 个");
    expect(h.clipboard[0]).not.toContain(UNREGISTERED);
  } finally { await h.dispose(); }
});

test("插件固定文案的失败（Voice 页没打开）：回执原样带插件主句，不被降级成通用短句", async () => {
  const h = await harness();
  try {
    const settlement = await h.host.invokeCommand("com.reai.voice.back-to-root");
    expect(settlement.ok).toBeFalse();
    const error = (settlement as { error?: { code?: string; userMessage?: string } }).error;
    expect(error?.code).toBe("com.reai.voice/NO_ACTIVE_VIEW");
    expect(error?.userMessage).toBe(t("app.theVoiceInterfaceIsNotOpen"));
  } finally { await h.dispose(); }
});

test("运行组件导航失败：回执保留插件自己的主句与登记码，导航异常原文不进回执", async () => {
  const SECRET = "Authorization: Bearer syntheticSecret";
  const h = await harness();
  try {
    h.host.setAgentPiStatus({ available: false, detail: "", downloadRequired: true });
    h.host.setAgentDshStatus({ available: false, detail: "", downloadRequired: true });
    h.host.rejectNextSystemTaskOpen(SECRET);
    const settlement = await h.host.invokeCommand("com.reai.voice.command.agent");
    const wire = JSON.stringify(settlement);
    expect(wire).toContain("AGENT_BACKEND_UNAVAILABLE");
    expect(wire).not.toContain("syntheticSecret");
    expect(wire).not.toContain("diagnostic");
  } finally { await h.dispose(); }
});

test("门禁失败的结果面板只放按码查表的固定短句：Host 的 userMessage 不上浮层", async () => {
  const LEAK = "Host said: 13800138000 请把合同发给王经理 Bearer abc.def";
  const h = await harness((ctx) => {
    Object.assign(ctx.agent, { backends: async () => {
      throw Object.assign(new Error(LEAK), { code: "AGENT_BACKEND_UNAVAILABLE", userMessage: LEAK });
    } });
  });
  try {
    await h.host.invokeCommand("com.reai.voice.command.agent");
    await until(() => h.answers().length === 1, "门禁失败进入结果面板");
    const answer = h.answers()[0]!;
    expect((answer as { errorCode?: string }).errorCode).toBe("AGENT_BACKEND_UNAVAILABLE");
    const shown = [answer.text ?? "", ...(answer.sections ?? []).map((section) => section.text)].join(" | ");
    for (const piece of ["13800138000", "请把合同", "Bearer", "Host said"]) expect(shown).not.toContain(piece);
  } finally { await h.dispose(); }
});

test("转入后台后失败：胶囊只放一句简短人话，不带错误码、版本、原文（与 Host #953 口径一致）", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const h = await harness((ctx) => {
    const wait = ctx.agent.waitForTurn.bind(ctx.agent);
    Object.assign(ctx.agent, { waitForTurn: async (...args: Parameters<typeof wait>) => { await held; return await wait(...args); } });
  });
  try {
    h.host.rejectNextAgentSend({ kind: "engine", stderr_tail: STDERR });
    await h.run("com.reai.voice.command.agent");
    await until(() => h.tasks().some(task => task.state === "running"), "超过 3 秒转入后台", 5000);
    release();
    await until(() => h.tasks().some(task => task.state === "failed"), "后台失败帧");
    const failed = h.tasks().find(task => task.state === "failed")!;
    expect(failed.stageLabel).toBe("Agent 提问失败 · 未完成 · 点开看原因");
    for (const leaked of ["AGENT_ENGINE", "INVALID_REQUEST", VOICE_PLUGIN_VERSION, "诊断"]) expect(failed.stageLabel).not.toContain(leaked);
    await settle();
  } finally {
    release();
    await h.dispose();
  }
}, 15_000);

test("Voice 页关掉之后，晚到的版本读取失败不再安排重试（W6）", async () => {
  let fail!: (cause: unknown) => void;
  const h = await harness(undefined, () => new Promise((_resolve, reject) => { fail = reject; }));
  try {
    const main = await h.host.openSurface("main");
    await until(() => h.versionCalls() === 1, "挂载后读一次 App 版本");
    await h.host.unmountSurface(main.surfaceMountId);
    fail({ code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED", message: "not visible" });
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    expect(h.versionCalls()).toBe(1);
  } finally { await h.dispose(); }
}, 10_000);

test("没有写回目标又润色失败：两个阶段的失败都按条目落盘（W3）", async () => {
  const h = await harness(undefined, undefined, (method, result) => {
    if (method !== "voice.toggle" || !result || typeof result !== "object") return result;
    const { deliveryTarget: _target, ...rest } = result as Record<string, unknown>;
    return rest;
  });
  try {
    h.host.failNextAiTextGenerate("AI_INVALID_REQUEST");
    await h.run("com.reai.voice.toggle-input");
    await until(() => h.host.storageKeys().includes("com.reai.voice/voice-state/history"), "历史落盘");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [item] = await h.inputHistory();
    expect(item!.warningCode).toBe("no_input_target");
    expect(item!.deliveryFailure?.code).toBe("no_input_target");
    // 取回卡同样收到结构化错误码（Host 的码形状），不收原始原因。
    const card = h.host.cloudRequests.find((request) => request.method.includes("takeback"))?.params as Record<string, unknown> | undefined;
    expect(card?.errorCode).toBe("no_input_target");
    expect(card).not.toHaveProperty("detail");
    expect(item!.polishFailure?.code).toBe("AI_INVALID_REQUEST");
  } finally { await h.dispose(); }
});
