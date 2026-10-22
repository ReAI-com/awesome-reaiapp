/**
 * 2.14.3-rc.2 隐私小修的端到端守卫（真实 SDK → MockHost 线路）：Host 给了一个自定义本地模型（自取的
 * ID、含用户名的路径作显示名）且它下载失败时，诊断相关的出口——剪贴板里的复制诊断、落盘的失败历史
 * （storage）、前台结果面板的诊断字段——以及插件日志（Host 会把 console 转进 App 日志）都不带它的名字或路径。
 * 范围：这个场景里没有用该模型真正识别过；识别选择快照（Host API 1.19 的显示快照，重新转写要用）是功能性
 * 数据，不在诊断出口之列，不由这条用例覆盖。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, POLISH_LIGHT_DEFAULT_MIGRATION_KEY } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

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

const CUSTOM_ID = "alice-private-asr";
const CUSTOM_NAME = "/Users/alice/Models/私人模型.onnx";
const PRIVATE = [CUSTOM_ID, CUSTOM_NAME, "alice", "/Users", "私人模型", ".onnx"];
const CUSTOM_MODEL = {
  id: CUSTOM_ID, name: CUSTOM_NAME, description: "", sizeBytes: 1000, state: "failed",
  active: false, updateAvailable: false, error: `cannot open ${CUSTOM_NAME}`,
};

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

test("自定义模型：复制诊断、落盘、交给 Host 的诊断字段与日志都不带模型名字或路径", async () => {
  document.body.replaceChildren();
  const logs: string[] = [];
  const saved = CONSOLE_METHODS.map(name => [name, console[name]] as const);
  for (const name of CONSOLE_METHODS) {
    console[name] = (...args: unknown[]) => { logs.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); };
  }
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import(`../src/app?model-privacy=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  /** 插件 → Host 的每一次请求（含 storage 写入、剪贴板、结果面板 / 任务卡的参数）。 */
  const sent: string[] = [];
  const clipboard: string[] = [];
  wire.handleRequest = async (method, params) => {
    sent.push(JSON.stringify({ method, params }));
    if (method === "clipboard.writeText") clipboard.push(String(params.text));
    if (method === "environment.get") return { developerMode: true };
    const result = await original(method, params);
    return method === "voice.models.list" ? { models: [structuredClone(CUSTOM_MODEL)] } : result;
  };
  try {
    await host.installAndEnable();
    // 前台失败面板（交给 Host 的诊断字段）与失败历史（落盘）在自定义模型在场时同样干净。
    host.rejectNextAgentSend({ kind: "engine", stderr_tail: "engine exited" });
    for (let index = 0; index < 2; index += 1) expect((await host.invokeCommand("com.reai.voice.command.agent")).ok).toBeTrue();
    await until(() => host.voiceCommandRequests.some(request => request.method === "voice.command.present-answer"), "Agent 失败进入前台结果面板");

    const main = await host.openSurface("main");
    const root = main.root!;
    const selector = `.voice-diag[data-diag-key='warn:model:${CUSTOM_ID}']`;
    await until(() => !!root.querySelector(`${selector} .voice-diag-toggle`), "自定义模型下载失败的 warn 行带诊断入口");
    // 用户自己看的界面（warn 行的原因）不经过白名单：Host 给的原因原样显示。
    expect(root.querySelector(".voice-warn[data-warn='model']")?.textContent).toContain(CUSTOM_NAME);
    (root.querySelector(`${selector} .voice-diag-toggle`) as HTMLButtonElement).click();
    (root.querySelector(`${selector} .voice-diag-copy`) as HTMLButtonElement).click();
    await until(() => clipboard.length === 1, "复制诊断经 surface.clipboard@1 写入剪贴板");
    expect(clipboard[0]).toContain("当前步骤: 下载本地语音模型 自定义模型");
    expect(clipboard[0]).toContain("  - 模型: 自定义模型 (local) · failed");
    await host.disable();

    const outbound = sent.join("\n");
    // 日志截获不是空转：命令生命周期轨迹等确实经 console 出去了。
    expect(logs.length).toBeGreaterThan(0);
    expect(outbound).toContain("storage.set");
    expect(outbound).toContain("voice.command.present-answer");
    for (const piece of PRIVATE) {
      if (outbound.includes(piece)) throw new Error(`交给 Host 的请求里泄露「${piece}」`);
      const leaked = logs.find(line => line.includes(piece));
      if (leaked) throw new Error(`日志泄露「${piece}」：${leaked}`);
    }
  } finally {
    wire.handleRequest = original;
    for (const [name, fn] of saved) console[name] = fn as never;
  }
});
