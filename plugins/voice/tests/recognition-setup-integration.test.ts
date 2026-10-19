import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import type { AudioTimelineStatus } from "@reai/app-sdk/v1";
import { DEFAULT_SETTINGS, DEFAULT_VOICE_FEATURE_SETTINGS } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";

beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
afterEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await tick();
  expect(check()).toBeTrue();
}
const createHost = () => new MockHost({
  manifest: structuredClone(manifest) as never,
  loadApp: () => import("../src/app"),
  createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
});
const storage = (host: MockHost) => (host as unknown as { storage: Map<string, unknown> }).storage;
const key = (name: string) => `com.reai.voice/voice-state/${name}`;

test("ordinary cloud switch shows an invalid saved choice and blocks capture until a real option is saved", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  storage(host).set(key("voice-feature-settings-v1"), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-default" });
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    Array.from(surface.root!.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent === "云端引擎")!.click();
    await until(() => (storage(host).get(key("settings")) as typeof DEFAULT_SETTINGS)?.engine === "cloud");
    const select = surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")!;
    expect(select.value).toBe("transcribe-default");
    expect(select.textContent).toContain("暂无可用选项");
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
    expect(host.cloudRequests.filter(r => r.method === "ai.audio.transcribe")).toHaveLength(0);
    select.value = "transcribe-free";
    select.dispatchEvent(new Event("change"));
    await until(() => (storage(host).get(key("voice-feature-settings-v1")) as typeof DEFAULT_VOICE_FEATURE_SETTINGS).cloudModelId === "transcribe-free");
    await host.invokeCommand("com.reai.voice.toggle-input");
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.cloudRequests.filter(r => r.method === "ai.audio.transcribe").at(-1)?.params)
      .toMatchObject({ model: "transcribe-free" });
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("recovered cloud failure preserves attempted engine and never claims local transcription", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  host.setRecoverableVoiceInputSessions([{
    recordingId: "failed-cloud", sessionId: "cloud-attempt", mode: "input", source: "System",
    requestedStartMs: Date.now() - 7000, requestedEndMs: Date.now(),
    effectiveStartMs: Date.now() - 7000, effectiveEndMs: Date.now(),
    stopReason: "finished", transcriptionStatus: "failed", requestedEngine: "cloud",
  }]);
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await until(() => (storage(host).get(key("history")) as unknown[])?.length === 1);
    const item = (storage(host).get(key("history")) as Record<string, unknown>[])[0]!;
    expect(item.requestedEngine).toBe("cloud");
    expect(item.recognitionEngine).toBeUndefined();
    surface.root!.querySelector<HTMLButtonElement>(".task-item")!.click();
    expect(surface.root!.querySelector(".input-detail-text")).toBeNull();
    expect(surface.root!.querySelector(".voice-retry-panel")?.textContent).toContain("云端识别");
    expect(surface.root!.textContent).not.toContain("仅在这台电脑上完成转写");
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("cloud model selection is durable and frozen for the active recording", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  host.setCloudModels([
    { id: "transcribe-free", kind: "transcribe", label: "Free" },
    { id: "transcribe-paid", kind: "transcribe", label: "Paid" },
  ]);
  storage(host).set(key("recognition-engine-choice-v1"), "cloud");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "cloud", polish: "raw" });
  storage(host).set(key("voice-feature-settings-v1"), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" });
  await host.installAndEnable();
  let surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    await host.invokeCommand("com.reai.voice.toggle-input");
    const select = surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")!;
    select.value = "transcribe-paid";
    select.dispatchEvent(new Event("change"));
    await until(() => (storage(host).get(key("voice-feature-settings-v1")) as typeof DEFAULT_VOICE_FEATURE_SETTINGS).cloudModelId === "transcribe-paid");
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.cloudRequests.filter(r => r.method === "ai.audio.transcribe").at(-1)?.params)
      .toMatchObject({ model: "transcribe-free" });
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
    await host.installAndEnable();
    surface = await host.openSurface("main");
    await host.invokeCommand("com.reai.voice.open-settings");
    expect(surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")?.value).toBe("transcribe-paid");
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("failed cloud option save keeps both storage and displayed selection unchanged", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "cloud");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "cloud" });
  storage(host).set(key("voice-feature-settings-v1"), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-default" });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let rejected = false;
  transport.handleRequest = async (method, params) => {
    if (method === "storage.set" && params.key === "voice-feature-settings-v1") {
      rejected = true;
      throw Error("storage unavailable");
    }
    return original(method, params);
  };
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    const select = surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")!;
    select.value = "transcribe-free";
    select.dispatchEvent(new Event("change"));
    await until(() => rejected);
    await tick();
    expect((storage(host).get(key("voice-feature-settings-v1")) as typeof DEFAULT_VOICE_FEATURE_SETTINGS).cloudModelId).toBe("transcribe-default");
    expect(surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")?.value).toBe("transcribe-default");
  } finally {
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("capture waits for all already queued cloud option saves", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  host.setCloudModels([
    { id: "transcribe-free", kind: "transcribe", label: "Free" },
    { id: "transcribe-paid", kind: "transcribe", label: "Paid" },
  ]);
  storage(host).set(key("recognition-engine-choice-v1"), "cloud");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "cloud", polish: "raw" });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let release: (() => void) | undefined;
  let hold = true;
  transport.handleRequest = async (method, params) => {
    if (hold && method === "storage.set" && params.key === "voice-feature-settings-v1") {
      hold = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return original(method, params);
  };
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await host.invokeCommand("com.reai.voice.open-settings");
    const select = surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model")!;
    select.value = "transcribe-free";
    select.dispatchEvent(new Event("change"));
    await until(() => !!release);
    select.value = "transcribe-paid";
    select.dispatchEvent(new Event("change"));
    // MockHost.invokeCommand only drains short microtasks. Dispatch directly so
    // this deliberately held storage operation can outlive that helper's flush.
    const bus = host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean }> };
    const correlationId = "capture-after-queued-options";
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-input", correlationId, input: {}, timeoutMs: 5000 });
    await tick();
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
    release!();
    await until(() => bus.settlements.has(correlationId));
    expect(bus.settlements.get(correlationId)?.ok).toBeTrue();
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.cloudRequests.filter(r => r.method === "ai.audio.transcribe").at(-1)?.params)
      .toMatchObject({ model: "transcribe-paid" });
  } finally {
    release?.();
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test.each(["local", "cloud"] as const)("fresh Voice %s choice persists through activation and does not invoke recognition", async engine => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  host.setCloudModels([{ id: "transcribe-free", kind: "transcribe", label: "Free", isDefault: true, billingPolicy: "free" }]);
  await host.installAndEnable();
  let surface = await host.openSurface("main");
  try {
    expect(surface.root?.querySelector(".voice-recognition-setup")).not.toBeNull();
    await until(() => !!surface.root?.querySelector(".voice-recognition-setup"));
    // Even when Host has a cached model, fresh Voice must ask for the user's choice.
    const buttons = surface.root!.querySelectorAll<HTMLButtonElement>(".voice-recognition-choice button");
    buttons[engine === "local" ? 0 : 1]!.click();
    await until(() => storage(host).get(key("recognition-engine-choice-v1")) === engine);
    await until(() => !surface.root?.querySelector(".voice-recognition-setup"));
    expect((storage(host).get(key("settings")) as { engine: string }).engine).toBe(engine);
    expect(host.voiceInputRequests.filter(r => r.method === "voice.models.download")).toHaveLength(0); // Cached usable models must not be downloaded again.
    expect(host.cloudRequests.filter(r => r.method !== "ai.models.list")).toHaveLength(0);
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
    await host.installAndEnable();
    surface = await host.openSurface("main");
    await tick();
    expect(surface.root?.querySelector(".voice-recognition-setup")).toBeNull();
    expect((storage(host).get(key("settings")) as { engine: string }).engine).toBe(engine);
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("idle ready Board recovers a starting timeline without any settings navigation", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  const timeline: AudioTimelineStatus = {
    state: "unavailable", unavailableReason: "route_reconciling", route: null,
    hotRingDurationMs: 0, cacheDurationMs: 0, cacheHealth: "healthy",
    continuousRecordingEnabled: true, recordingState: "running", sttBacklog: 0, hostLocalDropFrames: 0,
  };
  const status = { phase: "idle" as const, source: "board" as const, sourceReady: true,
    modelId: "sensevoice-small-int8", timeline };
  host.setVoiceInputStatus(status);
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await until(() => surface.root!.textContent!.includes("正在连接音频"));
    const stableContent = surface.root!.querySelector(".voice-view")?.firstElementChild ?? surface.root!.firstElementChild;
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(surface.root!.querySelector(".voice-view")?.firstElementChild ?? surface.root!.firstElementChild).toBe(stableContent);
    host.setVoiceInputStatus({ ...status, timeline: { ...timeline, state: "running", unavailableReason: undefined, route: "usb_vendor_hid" } });
    await until(() => !surface.root!.textContent!.includes("正在连接音频"));
    expect(surface.root!.textContent).not.toContain("时间线不可用");
    expect(surface.root!.querySelector(".voice-settings-view")).toBeNull();
    expect(host.voiceInputRequests.filter(r => r.method === "voice.status").length).toBeGreaterThan(1);
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("idle continuous recording refreshes new Context segments without rebuilding unchanged content", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  host.setVoiceInputStatus({ phase: "idle", source: "board", sourceReady: true,
    modelId: "sensevoice-small-int8", timeline: {
      state: "running", route: "usb_vendor_hid", hotRingDurationMs: 0, cacheDurationMs: 0,
      cacheHealth: "healthy", continuousRecordingEnabled: true, recordingState: "running",
      sttBacklog: 0, hostLocalDropFrames: 0,
    } });
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  try {
    await tick();
    surface.root!.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')!.click();
    host.setVoiceRecordings([{
      id: "idle-context-segment", wallStartMs: Date.now(), durationMs: 30_000,
      transport: "usb_vendor_hid", transcriptText: "空闲时新录音应自动出现",
      transcribedAtMs: Date.now(),
    }]);
    await until(() => surface.root!.textContent!.includes("空闲时新录音应自动出现"));
    const stableContent = surface.root!.querySelector(".ctx-seg");
    expect(stableContent).not.toBeNull();
    await new Promise(resolve => setTimeout(resolve, 5200));
    expect(surface.root!.querySelector(".ctx-seg")).toBe(stableContent);
    expect(surface.root!.querySelector(".voice-settings-view")).toBeNull();
  } finally {
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
}, 12_000);

test("an in-flight idle recording poll cannot overwrite a newer explicit refresh", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  host.setVoiceInputStatus({ phase: "idle", source: "board", sourceReady: true,
    modelId: "sensevoice-small-int8", timeline: {
      state: "running", route: "usb_vendor_hid", hotRingDurationMs: 0, cacheDurationMs: 0,
      cacheHealth: "healthy", continuousRecordingEnabled: true, recordingState: "running",
      sttBacklog: 0, hostLocalDropFrames: 0,
    } });
  const segment = { id: "context-race", wallStartMs: Date.now(), durationMs: 30_000,
    transport: "usb_vendor_hid" as const, transcriptText: "旧的现场记录", transcribedAtMs: Date.now() };
  host.setVoiceRecordings([segment]);
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  const transport = host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let release: (() => void) | undefined;
  let armed = true;
  transport.handleRequest = async (method, params) => {
    const result = await original(method, params);
    if (armed && method === "voice.recordings.list") {
      armed = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return result;
  };
  try {
    surface.root!.querySelector<HTMLButtonElement>('[data-voice-tab="context"]')!.click();
    await until(() => !!release);
    host.setVoiceRecordings([{ ...segment, transcriptText: "已刷新的现场记录" }]);
    await host.invokeCommand("com.reai.voice.refresh-day-digest");
    await until(() => surface.root!.textContent!.includes("已刷新的现场记录"));
    release!();
    await tick();
    expect(surface.root!.textContent).toContain("已刷新的现场记录");
    expect(surface.root!.textContent).not.toContain("旧的现场记录");
  } finally {
    release?.();
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test('ordinary local selection starts a missing model and publishes progress before a full refresh', async () => {
 const host=createHost(); storage(host).set(key('recognition-engine-choice-v1'),'cloud');
 const transport=host as unknown as {handleRequest(method:string,params:unknown):Promise<unknown>};
 const original=transport.handleRequest.bind(host);
 let release: (()=>void)|undefined, downloadStarted=false;
 const m={id:'sensevoice-small-int8',name:'SenseVoice',description:'',sizeBytes:100,state:'missing',active:false,updateAvailable:false};
 transport.handleRequest=async(method,params)=>{
  if(method==='voice.models.list') return {models:[m]};
  if(method==='voice.models.download') {downloadStarted=true; await new Promise<void>(r=>{release=r;}); return {...m,state:'downloading',downloadedBytes:40};}
  return original(method,params);
 };
 await host.installAndEnable(); const surface=await host.openSurface('main');
 try {
  await tick(); await host.invokeCommand('com.reai.voice.open-settings');
  const buttons=Array.from(surface.root!.querySelectorAll<HTMLButtonElement>('button'));
  buttons.find(b=>b.textContent==='本地引擎')!.click();
  await until(()=>downloadStarted);
  expect(surface.root!.querySelector('[data-model-state="preparing"]')).not.toBeNull();
  release!();
  await until(()=>surface.root!.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='40');
 } finally {release?.(); await host.unmountSurface(surface.surfaceMountId); await host.disable();}
});

for (const locale of ["zh", "en"] as const) for (const [code, zh, en] of [["AI_PAYMENT_REQUIRED", "额度", "quota"], ["AI_NETWORK_ERROR", "网络", "network"], ["AI_SUBSCRIPTION_REQUIRED", "订阅", "subscription"], ["AI_SUBSCRIPTION_UNAVAILABLE", "订阅", "subscription"], ["AI_UNAVAILABLE", "服务", "service"]] as const) {
  test(`${locale} live cloud transcription wrapper presents ${code} and preserves failure`, async () => {
    const needle = locale === "zh" ? zh : en;
    const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
    host.setLocale(locale);
    storage(host).set(key("recognition-engine-choice-v1"), "cloud");
    storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "cloud" });
    storage(host).set(key("voice-feature-settings-v1"), { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" });
    await host.installAndEnable();
    const surface = await host.openSurface("main");
    try {
      await host.invokeCommand("com.reai.voice.open-settings");
      host.failNextAiAudioTranscribe(code);
      await host.invokeCommand("com.reai.voice.toggle-input");
      await host.invokeCommand("com.reai.voice.toggle-input");
      await until(() => surface.root!.querySelector(".settings-error")?.textContent?.includes(needle) === true);
      expect(surface.root!.querySelector(".settings-error")?.textContent).not.toContain(code);
      expect(host.cloudRequests.filter(request => request.method === "voice.deliver.commit")).toHaveLength(0);
      expect(host.cloudRequests.filter(request => request.method === "ai.audio.transcribe")).toHaveLength(1);
    } finally {
      await host.unmountSurface(surface.surfaceMountId);
      await host.disable();
    }
  });
}

for (const code of ["AI_NETWORK_ERROR", "AI_SUBSCRIPTION_REQUIRED", "AI_SUBSCRIPTION_UNAVAILABLE", "AI_UNAVAILABLE"] as const) {
  test(`initial catalog failure ${code} shows English recovery without diagnostics`, async () => {
    const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
    host.setLocale("en");
    storage(host).set(key("recognition-engine-choice-v1"), "local");
    const original = host.bridge.request.bind(host.bridge);
    const failModels = true;
    host.bridge.request = async (method, params, options) => {
      if (failModels && method === "ai.models.list") throw Object.assign(new Error("PRIVATE_SENTINEL"), { code });
      return original(method, params, options);
    };
    await host.installAndEnable();
    const surface = await host.openSurface("main");
    try {
      await host.invokeCommand("com.reai.voice.open-settings");
      Array.from(surface.root!.querySelectorAll<HTMLButtonElement>("button"))
        .find(button => button.textContent === "Cloud engine")!.click();
      await until(() => {
        const select = surface.root!.querySelector<HTMLSelectElement>(".settings-cloud-model");
        return select?.disabled === true && select.getAttribute("aria-busy") === "false";
      });
      expect(surface.root!.textContent).toContain("No options available yet");
      expect(Array.from(surface.root!.querySelectorAll("button")).some(button => button.textContent === "Refresh options")).toBeTrue();
      expect(surface.root!.textContent).not.toContain(code);
      expect(surface.root!.textContent).not.toContain("PRIVATE_SENTINEL");
      expect(surface.root!.textContent).not.toContain("未完成");
      expect(host.cloudRequests.filter(request => request.method === "ai.audio.transcribe")).toHaveLength(0);
    } finally {
      await host.unmountSurface(surface.surfaceMountId);
      await host.disable();
      host.setLocale("zh");
    }
  });
}

test("a stalled home status refresh exits checking and a late snapshot cannot clear its failure", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  await host.installAndEnable();
  const transport = host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let release: (() => void) | undefined;
  let armed = true;
  transport.handleRequest = async (method, params) => {
    const result = await original(method, params);
    if (armed && method === "voice.status") {
      armed = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return result;
  };
  const surface = await host.openSurface("main");
  try {
    await until(() => !!release);
    await new Promise(resolve => setTimeout(resolve, 8_100));
    expect(surface.root!.textContent).toContain("读取语音状态 8 秒内没有返回（超时），可以重新检查。");
    release!();
    await tick();
    expect(surface.root!.textContent).toContain("读取语音状态 8 秒内没有返回（超时），可以重新检查。");
    surface.root!.querySelector<HTMLButtonElement>(".voice-cap button")!.click();
    await until(() => !surface.root!.textContent!.includes("读取语音状态 8 秒内没有返回（超时），可以重新检查。"));
    expect(surface.root!.textContent).not.toContain("检查中");
  } finally {
    release?.();
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
}, 12_000);

test("operation command starts explicitly and paired end finishes exact session once", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "local", polish: "raw" });
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  await tick();
  const bus = host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean; output?: { sessionId?: string } }> };
  const invoke = async (correlationId: string, phase: "start" | "end") => {
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-input", correlationId, input: {}, timeoutMs: 3000, operation: { id: "paired-capture", phase } });
    await until(() => bus.settlements.has(correlationId));
    expect(bus.settlements.get(correlationId)?.ok).toBeTrue();
  };
  try {
    await invoke("operation-start", "start");
    const sessionId = bus.settlements.get("operation-start")?.output?.sessionId;
    expect(sessionId).toBeString();
    await invoke("operation-end", "end");
    await invoke("operation-end-again", "end");
    const toggles = host.voiceInputRequests.filter(r => r.method === "voice.toggle");
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.params).toMatchObject({ action: "start" });
    expect(toggles[1]?.params).toEqual({ action: "finish", sessionId });
  } finally { await host.unmountSurface(surface.surfaceMountId); await host.disable(); }
});

test("command key shows global preparing before Agent readiness and clears it on cancellation", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "local", polish: "raw" });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let holdReadiness = false;
  let release!: () => void;
  transport.handleRequest = async (method, params) => {
    if (holdReadiness && method === "agent.v2.backends.list") {
      await new Promise<void>(resolve => { release = resolve; });
    }
    return original(method, params);
  };
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  await tick();
  const bus = host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean }> };
  holdReadiness = true;
  try {
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-command", correlationId: "preparing-command", input: {}, timeoutMs: 30000 });
    await until(() => host.voiceInputRequests.some(r => r.method === "voice.preparing" && (r.params as { action?: string }).action === "begin"));
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
    bus.dispatch({ type: "command.cancel", correlationId: "preparing-command" });
    release();
    await until(() => host.voiceInputRequests.some(r => r.method === "voice.preparing" && (r.params as { action?: string }).action === "end"));
    const preparing = host.voiceInputRequests.filter(r => r.method === "voice.preparing");
    expect(preparing).toHaveLength(2);
    expect((preparing[1]!.params as { requestId?: string }).requestId)
      .toBe((preparing[0]!.params as { requestId?: string }).requestId);
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
  } finally {
    release?.();
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("cancel sends preparing end even when begin response arrives late", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let releaseBegin!: () => void;
  let beginArrived = false;
  transport.handleRequest = async (method, params) => {
    if (method === "voice.preparing" && params.action === "begin") {
      beginArrived = true;
      await new Promise<void>(resolve => { releaseBegin = resolve; });
    }
    return original(method, params);
  };
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  await tick();
  const bus = host as unknown as { dispatch(event: unknown): void };
  try {
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-command", correlationId: "late-begin", input: {}, timeoutMs: 30000 });
    await until(() => beginArrived);
    bus.dispatch({ type: "command.cancel", correlationId: "late-begin" });
    await until(() => host.voiceInputRequests.some(r => r.method === "voice.preparing" && (r.params as { action?: string }).action === "end"));
    releaseBegin();
    await until(() => host.voiceInputRequests.filter(r => r.method === "voice.preparing").length === 2);
    const requests = host.voiceInputRequests.filter(r => r.method === "voice.preparing");
    expect((requests[0]!.params as { action: string }).action).toBe("end");
    expect((requests[1]!.params as { action: string }).action).toBe("begin");
    expect((requests[0]!.params as { requestId: string }).requestId)
      .toBe((requests[1]!.params as { requestId: string }).requestId);
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
  } finally {
    releaseBegin?.();
    transport.handleRequest = original;
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  }
});

test("operation capture remains cancelable after start settled", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "local", polish: "raw" });
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  await tick();
  const bus = host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean; output?: { sessionId?: string } }> };
  try {
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-input", correlationId: "cancel-start", input: {}, timeoutMs: 3000, operation: { id: "cancel-capture", phase: "start" } });
    await until(() => bus.settlements.has("cancel-start"));
    const sessionId = bus.settlements.get("cancel-start")?.output?.sessionId;
    expect(sessionId).toBeString();
    bus.dispatch({ type: "command.cancel", correlationId: "cancel-start" });
    await until(() => host.voiceInputRequests.some(r => r.method === "voice.cancel"));
    expect(host.voiceInputRequests.find(r => r.method === "voice.cancel")?.params).toEqual({ sessionId });
  } finally { await host.unmountSurface(surface.surfaceMountId); await host.disable(); }
});

test("hung capture preparation expires and releases admission for a fresh command", async () => {
  const host = createHost();
  host.setVoiceContextCapture({ sessionEpoch: "setup-test-account" });
  storage(host).set(key("recognition-engine-choice-v1"), "local");
  storage(host).set(key("settings"), { ...DEFAULT_SETTINGS, engine: "local", polish: "raw" });
  const transport = host as unknown as { handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> };
  const original = transport.handleRequest.bind(host);
  let held = false;
  let armed = false;
  let release!: () => void;
  transport.handleRequest = async (method, params) => {
    if (armed && method === "voice.configure" && !held) {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
      return undefined;
    }
    return original(method, params);
  };
  await host.installAndEnable();
  const surface = await host.openSurface("main");
  await tick();
  armed = true;
  const bus = host as unknown as { dispatch(event: unknown): void; settlements: Map<string, { ok: boolean; output?: { sessionId?: string } }> };
  try {
    bus.dispatch({ type: "command.invoke", commandId: "com.reai.voice.toggle-input", correlationId: "hung-start", input: {}, timeoutMs: 30000 });
    await tick();
    if (!held && bus.settlements.has("hung-start")) throw new Error(JSON.stringify(bus.settlements.get("hung-start")));
    await until(() => held);
    await new Promise(resolve => setTimeout(resolve, 3100));
    expect(bus.settlements.get("hung-start")?.ok).toBeFalse();
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(0);
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(1);
    release();
    await tick();
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(1);
    // Leave the capture started by this test settled before the next MockHost activates.
    await host.invokeCommand("com.reai.voice.toggle-input");
    expect(host.voiceInputRequests.filter(r => r.method === "voice.toggle")).toHaveLength(2);
  } finally { release?.(); transport.handleRequest = original; await host.unmountSurface(surface.surfaceMountId); await host.disable(); }
});
