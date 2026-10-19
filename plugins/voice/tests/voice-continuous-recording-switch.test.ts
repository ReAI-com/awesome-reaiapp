/**
 * 2.14.6：设置 › 记录保留的「全天存档」开关接线（应用级）。
 * 开关读 Host 时间线 `continuousRecordingEnabled`，点击经 `voice.timeline.set-recording` 提交；
 * 点下后按目标值显示，旧状态读数不能把它拨回去；连点只保留最后一次意图；
 * 失败时回读 Host 真值，设置页顶部给出可读原因（§6.0 / §6.1）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, VoiceInputStatus } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS, POLISH_LIGHT_DEFAULT_MIGRATION_KEY } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
  setVoiceLocale("zh");
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean, message: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check(), message).toBeTrue();
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
const status = (enabled: boolean): VoiceInputStatus => ({
  phase: "idle", source: "board", modelId: "sensevoice-small-int8", sourceReady: true,
  timeline: {
    state: "running", route: "usb_vendor_hid", hotRingDurationMs: 10_000, cacheDurationMs: 60_000,
    cacheHealth: "healthy", continuousRecordingEnabled: enabled, recordingState: enabled ? "running" : "disabled",
    sttBacklog: 0, hostLocalDropFrames: 0,
  },
}) as VoiceInputStatus;

type Outcome = "ok" | "fail" | "fail-after-apply";
const archive = (enabled: boolean) => ({ continuousRecordingEnabled: enabled, recordingState: enabled ? "running" as const : "disabled" as const });

async function harness(options: { outcome?: Outcome; hold?: boolean; hangStatusAfterWrite?: boolean; initial?: boolean } = {}) {
  document.body.replaceChildren();
  const initial = options.initial ?? true;
  const host = new MockHost({
    manifest: structuredClone(manifest) as never,
    voiceInputStatus: status(initial),
    loadApp: async () => {
      const { default: app } = await import(`../src/app?archive=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  } as ConstructorParameters<typeof MockHost>[0]);
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const setRecording: boolean[] = [];
  const releases: Array<() => void> = [];
  let outcome: Outcome = options.outcome ?? "ok";
  let holdMethod: string | undefined;
  const methodHolds: Array<() => void> = [];
  wire.handleRequest = async (method, params) => {
    if (method === holdMethod) {
      holdMethod = undefined;
      await new Promise<void>(resolve => methodHolds.push(resolve));
    }
    if (method === "voice.status" && options.hangStatusAfterWrite && setRecording.length > 0) {
      return await new Promise(() => undefined);
    }
    if (method !== "voice.timeline.set-recording") return await original(method, params);
    const enabled = params["enabled"] === true;
    setRecording.push(enabled);
    // 结果按发起这笔请求时的设定决定（挂起期间改 outcome 只影响之后的请求）。
    const callOutcome = outcome;
    // 与真机同口径：回执是发起时的时间线快照；Host 只改存档位，之后的状态查询读到新存档位。
    const snapshot = current().timeline!;
    if (options.hold) await new Promise<void>(resolve => releases.push(resolve));
    if (callOutcome === "fail") throw new Error("set-recording rejected by fixture");
    const now = current();
    host.setVoiceInputStatus({ ...now, timeline: { ...now.timeline!, ...archive(enabled) } });
    if (callOutcome === "fail-after-apply") throw new Error("applied but confirmation failed");
    return { ...snapshot, ...archive(enabled) };
  };
  function current(): VoiceInputStatus { return (host as unknown as { voiceInputStatus: VoiceInputStatus }).voiceInputStatus; }
  await host.installAndEnable();
  let mount = (await host.openSurface("main")).surfaceMountId;
  expect((await host.invokeCommand("com.reai.voice.open-settings")).ok).toBeTrue();
  const archiveSwitch = () => document.querySelector<HTMLButtonElement>('[data-settings-target="replay-cache"] [role="switch"]');
  const checked = () => archiveSwitch()?.getAttribute("aria-checked");
  await until(() => checked() === String(initial), "设置页显示 Host 真值");
  return {
    host, archiveSwitch, checked, setRecording, releases, methodHolds, current,
    holdNext: (method: string) => { holdMethod = method; },
    remount: async () => {
      await host.unmountSurface(mount);
      mount = (await host.openSurface("main")).surfaceMountId;
    },
    setOutcome: (next: Outcome) => { outcome = next; },
    dispose: async () => { try { await host.disable(); } finally { wire.handleRequest = original; } },
  };
}

test("关掉全天存档：提交 enabled=false；之后的状态轮询与重开设置都保持关闭", async () => {
  const h = await harness();
  try {
    h.archiveSwitch()!.click();
    await until(() => h.setRecording.length === 1, "提交一次 set-recording");
    expect(h.setRecording).toEqual([false]);
    // 跨过至少一次 1 秒的状态轮询。
    await wait(1_500);
    expect(h.checked()).toBe("false");
    expect(document.querySelector(".settings-error")).toBeNull();
    expect((await h.host.invokeCommand("com.reai.voice.back-to-root")).ok).toBeTrue();
    expect((await h.host.invokeCommand("com.reai.voice.open-settings")).ok).toBeTrue();
    await until(() => h.checked() !== undefined, "重开设置页");
    expect(h.checked()).toBe("false");
  } finally { await h.dispose(); }
}, 15_000);

test("Host 还没确认时：开关按目标值显示，期间的旧状态读数不把它拨回去", async () => {
  const h = await harness({ hold: true });
  try {
    h.archiveSwitch()!.click();
    await until(() => h.releases.length === 1, "写入挂起");
    // 挂起期间 Host 状态仍是「开着」，轮询会读到旧值。
    await wait(1_500);
    expect(h.checked()).toBe("false");
    h.releases.shift()!();
    await wait(1_200);
    expect(h.checked()).toBe("false");
    expect(h.setRecording).toEqual([false]);
  } finally { await h.dispose(); }
}, 15_000);

test("连点：只保留最后一次意图，第一笔写完再补写最新目标", async () => {
  const h = await harness({ hold: true });
  try {
    h.archiveSwitch()!.click();
    await until(() => h.releases.length === 1, "第一笔写入挂起");
    expect(h.checked()).toBe("false");
    h.archiveSwitch()!.click();
    await until(() => h.checked() === "true", "第二次点击后按新目标显示");
    expect(h.setRecording).toEqual([false]);
    h.releases.shift()!();
    await until(() => h.releases.length === 1, "补写最新目标");
    expect(h.setRecording).toEqual([false, true]);
    expect(h.checked()).toBe("true");
    h.releases.shift()!();
    await wait(1_200);
    expect(h.checked()).toBe("true");
    expect(document.querySelector(".settings-error")).toBeNull();
  } finally { await h.dispose(); }
}, 15_000);

test("Host 拒绝：开关回到 Host 真值（仍开着），设置页顶部给出可读原因", async () => {
  const h = await harness({ outcome: "fail" });
  try {
    h.archiveSwitch()!.click();
    await until(() => document.querySelector(".settings-error") !== null, "显示设置页错误");
    expect(h.setRecording).toEqual([false]);
    expect(h.checked()).toBe("true");
    expect(h.archiveSwitch()!.classList.contains("on")).toBeTrue();
  } finally { await h.dispose(); }
}, 15_000);

test("Host 已关掉但确认失败：回读真值显示关闭，同时给出原因", async () => {
  const h = await harness({ outcome: "fail-after-apply" });
  try {
    h.archiveSwitch()!.click();
    await until(() => document.querySelector(".settings-error") !== null, "显示设置页错误");
    expect(h.checked()).toBe("false");
    // 修好后可以重试。
    h.setOutcome("ok");
    h.archiveSwitch()!.click();
    await until(() => h.setRecording.length === 2, "重试提交");
    await until(() => h.checked() === "true", "重试成功后显示开启");
  } finally { await h.dispose(); }
}, 15_000);

test("关闭失败且回读挂起：立刻报错并显示上次确认的值（开着），不停在「关」", async () => {
  const h = await harness({ outcome: "fail", hangStatusAfterWrite: true });
  try {
    h.archiveSwitch()!.click();
    await until(() => document.querySelector(".settings-error") !== null, "立刻显示设置页错误", 1_000);
    expect(h.checked()).toBe("true");
  } finally { await h.dispose(); }
}, 15_000);

test("旧请求失败时用户已改回开启：不丢掉后来的意图，接着写最新目标", async () => {
  const h = await harness({ hold: true, outcome: "fail-after-apply" });
  try {
    h.archiveSwitch()!.click();
    await until(() => h.releases.length === 1, "关闭写入挂起");
    h.archiveSwitch()!.click();
    await until(() => h.checked() === "true", "按新目标显示开启");
    h.setOutcome("ok");
    // 第一笔按发起时的设定「已生效但确认失败」；第二笔（补写）按 ok 处理。
    h.releases.shift()!();
    await until(() => h.releases.length === 1, "补写最新目标");
    expect(h.setRecording).toEqual([false, true]);
    h.releases.shift()!();
    await wait(1_200);
    expect(h.checked()).toBe("true");
    expect(document.querySelector(".settings-error")).toBeNull();
  } finally { await h.dispose(); }
}, 15_000);

test("整页刷新读完状态后还在等别的请求时关掉存档：旧读数发布时不把开关拨回去", async () => {
  const h = await harness();
  try {
    // 重新挂载触发整页刷新；状态先读回（开着），权限检查挂起。
    h.holdNext("voice.permissions.check");
    await h.remount();
    await until(() => h.methodHolds.length === 1, "整页刷新挂在权限检查上");
    expect((await h.host.invokeCommand("com.reai.voice.open-settings")).ok).toBeTrue();
    await until(() => h.checked() === "true", "设置页显示开着");
    h.archiveSwitch()!.click();
    await until(() => h.setRecording.length === 1, "关闭写入完成");
    await until(() => h.checked() === "false", "确认关闭");
    h.methodHolds.shift()!();
    await wait(300);
    expect(h.checked()).toBe("false");
  } finally { await h.dispose(); }
}, 15_000);

test("写入期间切到电脑麦：旧回执只更新存档位，不把切源后的时间线盖回键盘", async () => {
  const h = await harness({ hold: true, initial: false });
  try {
    h.archiveSwitch()!.click();
    await until(() => h.releases.length === 1, "开启写入挂起（回执是键盘时间线快照）");
    const now = h.current();
    h.host.setVoiceInputStatus({ ...now, timeline: { ...now.timeline!, route: "system", state: "unavailable" } });
    expect((await h.host.invokeCommand("com.reai.voice.back-to-root")).ok).toBeTrue();
    const ctx = () => document.querySelector<HTMLElement>('[data-cap-seg="ctx"]')?.textContent;
    // 等过至少一次 1 秒的状态轮询，让插件读到切源后的时间线。
    await wait(1_500);
    // 电脑麦空闲时不会再有轮询来纠正：这里把下一次状态读取挂住来模拟。
    h.holdNext("voice.status");
    h.releases.shift()!();
    await wait(1_500);
    expect(ctx()).not.toBe("在听");
    expect(ctx()).toBe("时间线不可用");
  } finally { await h.dispose(); }
}, 15_000);
