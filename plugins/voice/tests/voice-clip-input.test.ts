/**
 * v1.0.5 T14：输入法接入共享音频片段（audio.capture@1 + audio.clips@1）的应用级合同。
 * Host 未开放 / 未批准 / 设置不匹配时必须与旧版完全一致（写回 Host 会话自己的识别结果、
 * 不发任何片段请求）；开放并批准时，键盘持续收音的输入用片段转写结果写回。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, VoiceInputSettings, VoiceInputStatus } from "@reai/app-sdk/v1";
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

/** 片段结束时刻允许的墙钟落后量：覆盖 1.5 秒顺延里 1000ppm 的漂移与毫秒取整，远小于任何真实错误。 */
const FINISH_CLOCK_SLACK_MS = 20;

type Wire = { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
const keyboardContinuous: VoiceInputStatus = {
  phase: "idle", source: "board", modelId: "sensevoice-small-int8", sourceReady: true,
  timeline: {
    state: "running", route: "usb_vendor_hid", hotRingDurationMs: 10_000, cacheDurationMs: 60_000,
    cacheHealth: "healthy", continuousRecordingEnabled: true, recordingState: "running",
  },
} as VoiceInputStatus;

async function harness(options: {
  settings?: Partial<VoiceInputSettings>;
  status?: VoiceInputStatus;
  approved?: boolean;
  declared?: boolean;
}) {
  document.body.replaceChildren();
  const appManifest = structuredClone(manifest) as typeof manifest;
  if (options.declared === false) {
    const drop = new Set(["audio.capture@1", "audio.clips@1", "surface.escape@1"]);
    appManifest.requires.hostCapabilities = appManifest.requires.hostCapabilities.filter(cap => !drop.has(cap));
    appManifest.permissions = appManifest.permissions.filter(permission => !drop.has(permission.id));
  }
  const host = new MockHost({
    manifest: appManifest as never,
    ...(options.status ? { voiceInputStatus: options.status } : {}),
    ...(options.approved ? {
      platformServices: { approvals: ["audio.capture@1"] },
      audioClips: {
        consumers: [{ consumerId: "voice-consumer", epoch: "e", approvedStartMs: 0, approvedEndMs: Number.MAX_SAFE_INTEGER }],
        transcribe: () => "片段里的完整一句话",
      },
      audioClipsAccountGeneration: "mock-account",
    } : {}),
    loadApp: async () => {
      const { default: app } = await import(`../src/app?clip=${crypto.randomUUID()}`);
      return { default: { ...app, async activate(ctx: AppContext) {
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw", ...options.settings });
        await store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        await store.set("voice-feature-settings-v1", { ...DEFAULT_VOICE_FEATURE_SETTINGS });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  } as ConstructorParameters<typeof MockHost>[0]);
  const wire = host as unknown as Wire;
  const original = wire.handleRequest.bind(host);
  const methods: string[] = [];
  // 两个夹具各自发号：平台服务（audio.capture）发的是 mock-consumer-N，片段夹具（audio.clips）
  // 只认预置的 voice-consumer。对 Voice 统一呈现 voice-consumer，并把它发回的 status / release
  // 换回平台服务的真实号——否则 Voice 每 2 秒一次的来源复核会被平台服务判 AUDIO_CONSUMER_STALE，
  // 随即交还消费者，CI 满载时用例一旦拖过 2 秒，按键就退回 Host 原结果（2026-10 macOS CI 偶发根因）。
  let platformConsumerId: string | undefined;
  wire.handleRequest = async (method, params) => {
    methods.push(method);
    // Voice 用计时器（单调时钟）睡到片段结束时刻 endMs 再 finish，片段夹具却按墙钟（Date.now）严格判
    // 「endMs 不能晚于现在」，两者之间没有余量。CI 虚拟机里墙钟会被校时拖慢（真实 Host 的片段时钟按
    // 1000ppm 漂移留了容差），计时器到点时 Date.now 可能还差 1ms，夹具判 AUDIO_RANGE_UNAVAILABLE，
    // Voice 就交还消费者并退回 Host 原结果（2026-10 macOS CI 偶发的第二个根因，失败时长恒为约 1.5 秒顺延）。
    // 进程内夹具没有真实 Bridge 的往返延迟，这里只补回这一点：至多吸收 FINISH_CLOCK_SLACK_MS 的提前量，
    // 等墙钟追上 endMs 再转发；提前更多的 finish 原样交给夹具拒绝。实际等待另按单调时钟封顶，
    // 墙钟回拨或停走时也不会死等，到点照常转发、由夹具裁决。
    if (method === "audio.ranges.finish" && typeof params.endMs === "number") {
      const endMs = params.endMs;
      if (endMs - Date.now() <= FINISH_CLOCK_SLACK_MS) {
        const waitUntil = performance.now() + FINISH_CLOCK_SLACK_MS;
        while (Date.now() < endMs && performance.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 1));
      }
    }
    const forwarded = (method === "audio.consumers.status" || method === "audio.consumers.release")
      && params.consumerId === "voice-consumer" && platformConsumerId
      ? { ...params, consumerId: platformConsumerId } : params;
    const result = await original(method, forwarded);
    if (method === "audio.consumers.acquire") {
      const receipt = result as { consumerId: string; route?: unknown };
      platformConsumerId = receipt.consumerId;
      const route = receipt.route;
      // Voice 拿到回执后在同一段同步代码里读 route.source、随即把消费者标成可用（ready）。
      // SDK 原样透传这个对象，所以「route 被读过」就是 Voice 已就绪的确定信号，不靠固定等待。
      return Object.defineProperty({ ...receipt, consumerId: "voice-consumer" }, "route", {
        enumerable: true,
        get() {
          if (!methods.includes("audio.consumers.acquire:consumed")) methods.push("audio.consumers.acquire:consumed");
          return route;
        },
      });
    }
    return result;
  };
  /** Voice 已持有并标记可用的采集消费者（按键会走片段路径的前提）。 */
  const clipReady = () => until(() => methods.includes("audio.consumers.acquire:consumed"), "Voice 持有可用的采集消费者");
  await host.installAndEnable();
  await host.openSurface("main");
  const commits = () => host.cloudRequests.filter(r => r.method === "voice.deliver.commit").map(r => (r.params as { text?: string }).text);
  const toggle = async () => {
    expect((await host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
    expect((await host.invokeCommand("com.reai.voice.toggle-input")).ok).toBeTrue();
  };
  return { host, methods, commits, toggle, clipReady, dispose: async () => { try { await host.disable(); } finally { wire.handleRequest = original; } } };
}

const clipCalls = (methods: string[]) => methods.filter(m => m.startsWith("audio.ranges.") || (m.startsWith("audio.clips.") && m !== "audio.clips.transcriptionStatus"));

test("old Host (no audio services): keyboard input writes the Host transcript, no clip requests", async () => {
  const h = await harness({ status: keyboardContinuous });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    await h.toggle();
    await until(() => h.commits().length === 1, "写回一次");
    expect(h.commits()).toEqual(["测试语音输入"]);
    expect(clipCalls(h.methods)).toEqual([]);
  } finally { await h.dispose(); }
});

test("capabilities not declared/approved: behaviour identical to the old version", async () => {
  for (const options of [{ approved: false }, { approved: true, declared: false }]) {
    const h = await harness({ status: keyboardContinuous, ...options });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      await h.toggle();
      await until(() => h.commits().length === 1, "写回一次");
      expect(h.commits()).toEqual(["测试语音输入"]);
      expect(clipCalls(h.methods)).toEqual([]);
    } finally { await h.dispose(); }
  }
});

test("approved Host + keyboard continuous capture: input writes the clip transcript (lead + tail)", async () => {
  const h = await harness({ status: keyboardContinuous, approved: true });
  try {
    // 等 Voice 真正把消费者标成可用再按键（见 harness 的 clipReady），不靠固定等待。
    await h.clipReady();
    await h.toggle();
    await until(() => h.commits().length === 1, "写回一次", 8000);
    expect(h.commits()).toEqual(["片段里的完整一句话"]);
    expect(h.methods).toContain("audio.ranges.start");
    expect(h.methods).toContain("audio.clips.release");
  } finally { await h.dispose(); }
}, 15_000);

test("all-day archive off does not turn off the clip lead/tail: input still writes the clip transcript", async () => {
  // 2026-10-15 用户拍板：常驻收音是转写的工程冗余，全天存档开关只管长期保存全天转写。
  const archiveOff = { ...keyboardContinuous, timeline: { ...keyboardContinuous.timeline!, continuousRecordingEnabled: false, recordingState: "disabled" } } as VoiceInputStatus;
  const h = await harness({ status: archiveOff, approved: true });
  try {
    // 全天存档关着也持有采集消费者。
    await h.clipReady();
    await h.toggle();
    await until(() => h.commits().length === 1, "写回一次", 8000);
    expect(h.commits()).toEqual(["片段里的完整一句话"]);
    expect(h.methods).toContain("audio.ranges.start");
  } finally { await h.dispose(); }
}, 15_000);

test("toggling the all-day archive switch keeps the same capture consumer (no release / re-acquire)", async () => {
  const h = await harness({ status: keyboardContinuous, approved: true });
  try {
    await h.clipReady();
    const acquires = h.methods.filter(m => m === "audio.consumers.acquire").length;
    expect((await h.host.invokeCommand("com.reai.voice.open-settings")).ok).toBeTrue();
    const archive = () => document.querySelector<HTMLButtonElement>('[data-settings-target="replay-cache"] [role="switch"]');
    await until(() => archive() !== null, "设置页出现全天存档开关");
    archive()!.click();
    await until(() => h.methods.includes("voice.timeline.set-recording"), "提交全天存档开关");
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.methods.filter(m => m === "audio.consumers.acquire").length).toBe(acquires);
    expect(h.methods).not.toContain("audio.consumers.release");
  } finally { await h.dispose(); }
}, 15_000);

test("approved Host but settings differ from the clip transcription (language) or computer microphone: Host transcript", async () => {
  for (const options of [
    { status: keyboardContinuous, settings: { language: "zh-CN" } },
    { status: { ...keyboardContinuous, timeline: { ...keyboardContinuous.timeline!, route: "system" } } as VoiceInputStatus },
  ]) {
    const h = await harness({ ...options, approved: true });
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      await h.toggle();
      await until(() => h.commits().length === 1, "写回一次");
      expect(h.commits()).toEqual(["测试语音输入"]);
      expect(clipCalls(h.methods)).toEqual([]);
    } finally { await h.dispose(); }
  }
}, 20_000);

test("Host 切片口径为 span-markers-v1：同样批准了片段能力也不再申请消费者、不做第二次识别", async () => {
  // 正对照是上面的「approved Host + keyboard continuous capture」：同样的夹具只差 captureModel。
  const h = await harness({ status: { ...keyboardContinuous, captureModel: "span-markers-v1" } as VoiceInputStatus, approved: true });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    await h.toggle();
    await until(() => h.commits().length === 1, "写回一次");
    expect(h.commits()).toEqual(["测试语音输入"]);
    expect(h.methods).not.toContain("audio.consumers.acquire");
    expect(clipCalls(h.methods)).toEqual([]);
  } finally { await h.dispose(); }
}, 15_000);
