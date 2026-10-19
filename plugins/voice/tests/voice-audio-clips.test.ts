import { expect, test } from "bun:test";
import { defineApp, type AppContext } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
import { planVoiceClipRange, readVoiceClipPcm, transcribeVoiceClip, VOICE_CLIP_BOARD_LEAD_MS, VoiceClipCapture, type VoiceClipPorts } from "../src/voice-audio-clips";

type Fixture = ConstructorParameters<typeof MockHost>[0]["audioClips"];

async function setup(audioClips?: Fixture) {
  let ctx!: AppContext;
  const manifest = {
    appId: "com.reai.voice",
    contributes: { surfaces: [{ id: "main" }] },
    requires: { hostCapabilities: ["audio.capture@1", "audio.clips@1"] },
    permissions: [{ id: "audio.capture@1" }, { id: "audio.clips@1" }],
  };
  const host = new MockHost({
    manifest,
    ...(audioClips ? { audioClips } : {}),
    audioClipsAccountGeneration: "account",
    loadApp: async () => ({ default: defineApp({ activate(c) { ctx = c; c.surfaces.register("main", (surface) => surface.ready()); } }) }),
  } as ConstructorParameters<typeof MockHost>[0]);
  await host.installAndEnable();
  await host.openSurface("main");
  return { host, ctx };
}

function ports(now: { value: number }): VoiceClipPorts {
  let seq = 0;
  return {
    now: () => now.value,
    sleep: async (ms) => { now.value += ms; await new Promise((resolve) => setTimeout(resolve, 0)); },
    requestId: () => `voice-clip-test-${++seq}`,
  };
}

const fixture = (approvedStartMs = 1_000, now = { value: 10_000 }) => ({
  consumers: [{ consumerId: "consumer", approvedStartMs, approvedEndMs: 1_000_000, epoch: "epoch" }],
  now: () => now.value,
});

test("range plan: lead, 0–2s tail, 10-minute cap and invalid input", () => {
  expect(planVoiceClipRange({ pressedAtMs: 5_000, releasedAtMs: 6_000 })).toEqual({ startMs: 5_000, fallbackStartMs: 5_000, endMs: 7_500 });
  expect(planVoiceClipRange({ pressedAtMs: 5_000, releasedAtMs: 6_000, leadMs: 2_000, tailMs: 9_000 })).toEqual({ startMs: 3_000, fallbackStartMs: 5_000, endMs: 8_000 });
  expect(planVoiceClipRange({ pressedAtMs: 5_000, releasedAtMs: 6_000, tailMs: 0 })?.endMs).toBe(6_000);
  expect(planVoiceClipRange({ pressedAtMs: 0, releasedAtMs: 700_000 })?.endMs).toBe(600_000);
  expect(planVoiceClipRange({ pressedAtMs: 6_000, releasedAtMs: 6_000 })).toBeNull();
  expect(planVoiceClipRange({ pressedAtMs: 1.5, releasedAtMs: 6_000 })).toBeNull();
});

test("Host without audio.clips: Voice keeps its existing pipeline (unavailable, no guess)", async () => {
  const { host, ctx } = await setup();
  const now = { value: 10_000 };
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-1" }, ports(now));
  expect(result).toEqual({ kind: "unavailable", code: "HOST_CAPABILITY_NOT_AVAILABLE" });
  await host.disable();
});

test("approved Host: tail waits for real audio, transcript returns, clip is released", async () => {
  const now = { value: 6_000 };
  const { host, ctx } = await setup(fixture(1_000, now));
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-1" }, ports(now));
  expect(result.kind).toBe("transcript");
  if (result.kind !== "transcript") throw new Error("unreachable");
  expect(result.text).toBe("Synthetic transcription");
  expect(result.clip.requestedEndMs).toBe(7_500);
  expect(now.value).toBeGreaterThanOrEqual(7_500);
  // 已释放：再读同一 clip 失败。
  await expect(ctx.audioClips.read({ requestId: "after", clipId: result.clip.clipId, offset: 0, maxBytes: 4 })).rejects.toMatchObject({ code: "AUDIO_CLIP_NOT_FOUND" });
  await host.disable();
});

test("lead beyond the approved window falls back to the press time once", async () => {
  const now = { value: 10_000 };
  const { host, ctx } = await setup(fixture(5_000, now));
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, leadMs: 3_000, tailMs: 0, idempotencyKey: "rec-2" }, ports(now));
  expect(result.kind).toBe("transcript");
  if (result.kind === "transcript") expect(result.clip.requestedStartMs).toBe(5_000);
  await host.disable();
});

test("abort before finish cancels the range instead of issuing a clip", async () => {
  const now = { value: 6_000 };
  const { host, ctx } = await setup(fixture(1_000, now));
  const controller = new AbortController();
  const p = ports(now);
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-3", signal: controller.signal }, {
    ...p,
    sleep: async (ms) => { controller.abort(); await p.sleep(ms); },
  });
  expect(result).toEqual({ kind: "failed", code: "AUDIO_CANCELLED" });
  await host.disable();
});

test("reads a clip back as contiguous f32 PCM", async () => {
  const now = { value: 10_000 };
  const { host, ctx } = await setup(fixture(1_000, now));
  const range = await ctx.audioClips.start({ requestId: "s", consumerId: "consumer", startMs: 5_000 });
  const clip = await ctx.audioClips.finish({ requestId: "f", rangeId: range.rangeId, endMs: 5_100 });
  const pcm = await readVoiceClipPcm(ctx, clip, ports(now));
  expect(pcm.length).toBe(clip.sizeBytes / 4);
  await ctx.audioClips.release({ requestId: "r", clipId: clip.clipId });
  await host.disable();
});

function fakeClips(overrides: Partial<AppContext["audioClips"]>) {
  const calls: string[] = [];
  const clip = { version: 1, clipId: "clip-1", requestId: "f", owner: { appId: "com.reai.voice", accountGeneration: "g" }, epoch: "e",
    requestedStartMs: 5_000, requestedEndMs: 7_500, effectiveStartMs: 5_000, effectiveEndMs: 7_500, expiresAtMs: 1, sizeBytes: 160_000,
    sampleRate: 16000, channels: 1, format: "f32le" } as const;
  const base: AppContext["audioClips"] = {
    async start() { calls.push("start"); return { rangeId: "range-1", requestId: "s", consumerId: "consumer", epoch: "e", requestedStartMs: 5_000 }; },
    async finish() { calls.push("finish"); return clip; },
    async cancel() { calls.push("cancel"); },
    async read() { throw new Error("unused"); },
    async release() { calls.push("release"); },
    async transcribe() { calls.push("transcribe"); return { jobId: "job-1", clipId: "clip-1", state: "running" }; },
    async transcriptionStatus() { calls.push("status"); return { jobId: "job-1", clipId: "clip-1", state: "complete", transcript: "late text" }; },
  };
  return { ctx: { audioClips: { ...base, ...overrides } }, calls };
}

test("finish refused by the Host cancels the range instead of leaking an active slot", async () => {
  const { ctx, calls } = fakeClips({ async finish() { calls.push("finish"); throw Object.assign(new Error("full"), { code: "AUDIO_QUEUE_FULL" }); } });
  const now = { value: 8_000 };
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-4" }, ports(now));
  expect(result).toEqual({ kind: "failed", code: "AUDIO_QUEUE_FULL" });
  expect(calls).toEqual(["start", "finish", "cancel"]);
});

test("cancel during transcription never delivers a late transcript and still releases the clip", async () => {
  const controller = new AbortController();
  const { ctx, calls } = fakeClips({});
  const now = { value: 8_000 };
  const p = ports(now);
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-5", signal: controller.signal }, {
    ...p,
    sleep: async (ms) => { if (calls.includes("transcribe")) controller.abort(); await p.sleep(ms); },
  });
  expect(result).toEqual({ kind: "failed", code: "AUDIO_CANCELLED" });
  expect(calls.at(-1)).toBe("release");
  expect(calls).not.toContain("cancel");
});

test("cancel while the clip is being released still suppresses the transcript", async () => {
  const controller = new AbortController();
  const { ctx, calls } = fakeClips({ async release() { calls.push("release"); controller.abort(); } });
  const now = { value: 8_000 };
  const result = await transcribeVoiceClip(ctx, { consumerId: "consumer", pressedAtMs: 5_000, releasedAtMs: 6_000, idempotencyKey: "rec-6", signal: controller.signal }, ports(now));
  expect(result).toEqual({ kind: "failed", code: "AUDIO_CANCELLED" });
  expect(calls.at(-1)).toBe("release");
});

// ---- VoiceClipCapture：输入法片段增强协调器 ----

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const notOpened = () => Object.assign(new Error("no"), { code: "HOST_CAPABILITY_NOT_AVAILABLE" });

function fakeCapture(acquire: () => Promise<{ consumerId: string; route?: { source: string } }>, status?: () => Promise<{ route: { source: string } }>) {
  const calls: string[] = [];
  return {
    calls,
    capture: {
      async acquire() { calls.push("acquire"); const r = await acquire(); return { route: { source: "board-usb-hid" }, ...r } as never; },
      async release(input: { consumerId: string }) { calls.push(`release:${input.consumerId}`); },
      ...(status ? { async status() { calls.push("status"); return await status() as never; } } : {}),
    },
  };
}

async function ready(clips: ReturnType<typeof fakeClips>, consumerId = "consumer", extra: Partial<ConstructorParameters<typeof VoiceClipCapture>[0]> = {}) {
  const fake = fakeCapture(async () => ({ consumerId }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }), ...extra });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  return { coordinator, fake };
}

test("capture: Host without audio.capture never acquires and enhance falls back (old behaviour)", async () => {
  const { ctx, calls } = fakeClips({});
  const coordinator = new VoiceClipCapture({ ctx, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(coordinator.active).toBe(false);
  expect(coordinator.press(5_000)).toBeUndefined();
  expect(calls).toEqual([]);
});

test("capture: refused audio.capture stays unavailable without retry storms; a real state change retries once", async () => {
  const { ctx, calls } = fakeClips({});
  const fake = fakeCapture(async () => { throw notOpened(); });
  const coordinator = new VoiceClipCapture({ ctx: { ...ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(fake.calls).toEqual(["acquire"]);
  expect(coordinator.press(5_000)).toBeUndefined();
  coordinator.setWanted("ble_gatt:running");
  await flush();
  expect(fake.calls).toEqual(["acquire", "acquire"]);
  // 只有无副作用的能力探测，没有任何范围或片段请求。
  expect(calls.filter((c) => c !== "status")).toEqual([]);
});

test("capture: audio.clips withheld means no capture consumer is ever acquired", async () => {
  const clips = fakeClips({ async transcriptionStatus() { calls.push("status"); throw notOpened(); } });
  const calls = clips.calls;
  const { coordinator, fake } = await ready(clips);
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual([]);
  expect(calls).toEqual(["status"]);
});

test("capture: acquires only while mounted and wanted; releases when either turns off", async () => {
  const clips = fakeClips({});
  let n = 0;
  const fake = fakeCapture(async () => ({ consumerId: `consumer-${++n}` }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(fake.calls).toEqual([]);
  coordinator.setMounted(true);
  await flush();
  expect(coordinator.active).toBe(true);
  coordinator.setWanted(undefined);
  await flush();
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual(["acquire", "release:consumer-1"]);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  coordinator.setMounted(false);
  await flush();
  expect(fake.calls).toEqual(["acquire", "release:consumer-1", "acquire", "release:consumer-2"]);
});

test("capture: a receipt arriving after the state changed is handed back immediately", async () => {
  const { ctx } = fakeClips({});
  let resolve!: (value: { consumerId: string }) => void;
  const fake = fakeCapture(() => new Promise((r) => { resolve = r; }));
  const coordinator = new VoiceClipCapture({ ctx: { ...ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(fake.calls).toEqual(["acquire"]);
  coordinator.setMounted(false);
  resolve({ consumerId: "late" });
  await flush();
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual(["acquire", "release:late"]);
});

test("capture: keyboard route reads back lead audio and returns the clip transcript", async () => {
  const starts: number[] = [];
  const clips = fakeClips({
    async start(input) { starts.push(input.startMs); return { rangeId: "range-1", requestId: "s", consumerId: "consumer", epoch: "e", requestedStartMs: input.startMs }; },
  });
  const { coordinator } = await ready(clips);
  const token = coordinator.press(5_000)!;
  expect(await coordinator.enhance({ token, releasedAtMs: 6_000, boardRoute: true })).toBe("late text");
  expect(starts).toEqual([5_000 - VOICE_CLIP_BOARD_LEAD_MS]);
  expect(await coordinator.enhance({ token, releasedAtMs: 6_000, boardRoute: false })).toBe("late text");
  expect(starts.at(-1)).toBe(5_000);
});

test("capture: a consumer replaced between press and release is not used", async () => {
  const clips = fakeClips({});
  let n = 0;
  const fake = fakeCapture(async () => ({ consumerId: `consumer-${++n}` }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  const token = coordinator.press(5_000)!;
  coordinator.setWanted("ble_gatt:running");
  await flush();
  expect(coordinator.active).toBe(true);
  expect(await coordinator.enhance({ token, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  expect(clips.calls.filter((c) => c === "start")).toEqual([]);
});

test("capture: empty transcript or failure fall back to the Host result; retired consumer is re-acquired once", async () => {
  const empty = fakeClips({ async transcriptionStatus() { return { jobId: "job-1", clipId: "clip-1", state: "complete", transcript: "   " }; } });
  const a = await ready(empty);
  expect(await a.coordinator.enhance({ token: a.coordinator.press(5_000)!, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  expect(a.coordinator.active).toBe(true);
  const stale = fakeClips({ async start() { throw Object.assign(new Error("x"), { code: "AUDIO_CONSUMER_STALE" }); } });
  const b = await ready(stale);
  expect(await b.coordinator.enhance({ token: b.coordinator.press(5_000)!, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  await flush();
  expect(b.fake.calls).toEqual(["acquire", "release:consumer", "acquire"]);
  const revoked = fakeClips({ async start() { throw Object.assign(new Error("x"), { code: "AUDIO_NOT_GRANTED" }); } });
  const c = await ready(revoked);
  expect(await c.coordinator.enhance({ token: c.coordinator.press(5_000)!, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  await flush();
  expect(c.coordinator.active).toBe(false);
  expect(c.fake.calls).toEqual(["acquire", "release:consumer"]);
});

test("capture: budget timeout falls back and actively cancels the pending range", async () => {
  const clips = fakeClips({ async finish() { clips.calls.push("finish"); return await new Promise(() => undefined); } });
  const { coordinator } = await ready(clips, "consumer", { budgetMs: 20 });
  expect(await coordinator.enhance({ token: coordinator.press(5_000)!, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  await flush();
  expect(clips.calls).toContain("cancel");
});

test("capture: a consumer the Host resolved to the computer mic is never held", async () => {
  const clips = fakeClips({});
  const fake = fakeCapture(async () => ({ consumerId: "sys", route: { source: "system" } }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual(["acquire", "release:sys"]);
});

test("capture: a held consumer that falls back to the computer mic is handed back by the route check", async () => {
  const clips = fakeClips({});
  let source = "board-usb-hid";
  const fake = fakeCapture(async () => ({ consumerId: "c" }), async () => ({ route: { source } }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }), routeCheckMs: 5 });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(coordinator.active).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(coordinator.active).toBe(true);
  source = "system";
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toContain("release:c");
  coordinator.dispose();
});

test("capture: a late capability probe from an old generation does not block the new one", async () => {
  let rejectProbe!: (error: unknown) => void;
  let probes = 0;
  const clips = fakeClips({ async transcriptionStatus() { probes += 1; if (probes === 1) return await new Promise((_, reject) => { rejectProbe = reject; }); return { jobId: "j", clipId: "c", state: "complete" }; } });
  let n = 0;
  const fake = fakeCapture(async () => ({ consumerId: `c-${++n}` }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  coordinator.setWanted("ble_gatt:running");
  rejectProbe(notOpened());
  await flush();
  await flush();
  expect(coordinator.active).toBe(true);
  coordinator.dispose();
});

test("capture: no consumer is held while the capability probe is pending; switching off cancels the attempt", async () => {
  let resolveProbe!: (value: never) => void;
  const clips = fakeClips({ async transcriptionStatus() { return await new Promise((resolve) => { resolveProbe = resolve; }); } });
  const fake = fakeCapture(async () => ({ consumerId: "pending" }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }) });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual([]);
  coordinator.setWanted(undefined);
  resolveProbe({ jobId: "j", clipId: "c", state: "complete" } as never);
  await flush();
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toEqual([]);
});

test("capture: a route check that never answers hands the consumer back at its deadline", async () => {
  const clips = fakeClips({});
  const fake = fakeCapture(async () => ({ consumerId: "slow" }), () => new Promise(() => undefined));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }), routeCheckMs: 5 });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toContain("release:slow");
  coordinator.dispose();
});

test("capture: a probe that never answers does not block the next generation", async () => {
  let probes = 0;
  const clips = fakeClips({ async transcriptionStatus() { probes += 1; if (probes === 1) return await new Promise(() => undefined); return { jobId: "j", clipId: "c", state: "complete" }; } });
  let n = 0;
  const fake = fakeCapture(async () => ({ consumerId: `c-${++n}` }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }), routeCheckMs: 10_000 });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  coordinator.setWanted("ble_gatt:running");
  await flush();
  expect(coordinator.active).toBe(true);
  expect(fake.calls).toEqual(["acquire"]);
  coordinator.dispose();
});

test("capture: timeout after the clip was issued releases the clip instead of cancelling the range", async () => {
  const clips = fakeClips({ async transcriptionStatus(input) {
    if (input.jobId === "voice-capability-probe") return { jobId: "p", clipId: "p", state: "complete" };
    clips.calls.push("status"); return await new Promise(() => undefined);
  } });
  const { coordinator } = await ready(clips, "consumer", { budgetMs: 20 });
  expect(await coordinator.enhance({ token: coordinator.press(5_000)!, releasedAtMs: 6_000, boardRoute: true })).toBeUndefined();
  await flush();
  expect(clips.calls).toContain("release");
  expect(clips.calls).not.toContain("cancel");
});

test("capture: revoking only audio.clips while holding hands the capture consumer back", async () => {
  let clipsOpen = true;
  const clips = fakeClips({ async transcriptionStatus() { if (!clipsOpen) throw Object.assign(new Error("x"), { code: "AUDIO_NOT_GRANTED" }); return { jobId: "j", clipId: "c", state: "complete" }; } });
  const fake = fakeCapture(async () => ({ consumerId: "held" }), async () => ({ route: { source: "board-usb-hid" } }));
  const coordinator = new VoiceClipCapture({ ctx: { ...clips.ctx, audioCapture: fake.capture }, ports: ports({ value: 8_000 }), routeCheckMs: 5 });
  coordinator.setMounted(true);
  coordinator.setWanted("usb_vendor_hid:running");
  await flush();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(coordinator.active).toBe(true);
  clipsOpen = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(coordinator.active).toBe(false);
  expect(fake.calls).toContain("release:held");
  coordinator.dispose();
});
