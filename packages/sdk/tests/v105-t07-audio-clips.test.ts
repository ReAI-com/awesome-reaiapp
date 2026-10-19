import { expect, test } from "bun:test";
import { runApp, PLATFORM_CONTRACTS, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const methods = PLATFORM_CONTRACTS.capabilities["audio.clips@1"].methods;
const payloads = [
  { requestId: "start", consumerId: "consumer", startMs: 10 },
  { requestId: "finish", rangeId: "range", endMs: 20 },
  { requestId: "cancel", rangeId: "range" },
  { requestId: "read", clipId: "clip", offset: 0, maxBytes: 4 },
  { requestId: "release", clipId: "clip" },
  { requestId: "transcribe", clipId: "clip", idempotencyKey: "key" },
  { requestId: "status", jobId: "job" },
];
const descriptor = (mount = "mount", available = true, list: readonly string[] = methods) => ({
  audioClips: { runtimeSessionId: "runtime", surfaceMountId: mount,
    platformCapabilities: { version: 1, capabilities: { "audio.clips@1": { version: 1, available, methods: list } } } },
});
function reply(method: string, input: unknown): unknown {
  const p = input as Record<string, unknown>;
  if (method === methods[0]) return { rangeId: "range", requestId: p.requestId, consumerId: p.consumerId, epoch: "epoch", requestedStartMs: p.startMs };
  if (method === methods[1]) return { version: 1, clipId: "clip", requestId: p.requestId, owner: { appId: "app", accountGeneration: "generation" }, epoch: "epoch", requestedStartMs: 10, requestedEndMs: 20, effectiveStartMs: 10, effectiveEndMs: 20, expiresAtMs: 300020, sizeBytes: 640, sampleRate: 16000, channels: 1, format: "f32le" };
  if (method === methods[3]) return { bodyBase64: "AAAAAA==", offset: 0, bytes: 4, eof: false };
  if (method === methods[5] || method === methods[6]) return { jobId: "job", clipId: "clip", state: "queued" };
  return undefined;
}
function harness(snapshot: unknown = descriptor()) {
  let receive!: (m: HostMessage) => void;
  let context!: AppContext;
  const calls: { method: string; params: unknown }[] = [];
  const state: { snapshot: unknown; intercept?: (method: string, input: unknown) => Promise<unknown> } = { snapshot };
  const bridge: HostBridge = {
    async request(method, input) {
      calls.push({ method, params: input });
      if (state.intercept) return await state.intercept(method, input) as never;
      return (method === "environment.get" ? state.snapshot : reply(method, input)) as never;
    },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp({ activate(ctx) { context = ctx; ctx.surfaces.register("main", surface => surface.ready()); } }, bridge);
  receive({ type: "activate", runtimeSessionId: "runtime" });
  receive({ type: "surface.mount", surfaceMountId: "mount", surfaceId: "main", root: {} });
  return { calls, state, running, send: (m: HostMessage) => receive(m), get ctx() { return context; } };
}
const invoke = (ctx: AppContext, i: number) => {
  const names = ["start", "finish", "cancel", "read", "release", "transcribe", "transcriptionStatus"] as const;
  return (ctx.audioClips[names[i]!] as (p: unknown) => Promise<unknown>)(payloads[i]);
};

test("seven frozen methods use exact payloads and never acquire capture", async () => {
  const h = harness(); await tick();
  for (let i = 0; i < 7; i++) await invoke(h.ctx, i);
  expect(h.calls.filter(c => c.method.startsWith("audio."))).toEqual(methods.map((method, i) => ({ method, params: payloads[i] })));
  expect(h.calls.filter(c => c.method === "environment.get").length).toBeGreaterThanOrEqual(7);
  await h.running.dispose();
});
test("old, withheld, incomplete, wrong-version and wrong-binding descriptors fail closed", async () => {
  const badVersion = descriptor(); badVersion.audioClips.platformCapabilities.version = 2;
  for (const snapshot of [undefined, {}, descriptor("mount", false), descriptor("mount", true, methods.slice(1)), badVersion]) {
    const h = harness(snapshot); h.state.snapshot = snapshot; await tick();
    for (let i = 0; i < 7; i++) await expect(invoke(h.ctx, i)).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE" });
    expect(h.calls.some(c => c.method.startsWith("audio."))).toBe(false); await h.running.dispose();
  }
  const h = harness(descriptor("other")); await tick();
  await expect(invoke(h.ctx, 0)).rejects.toMatchObject({ code: "AUDIO_CONSUMER_STALE" }); await h.running.dispose();
});
test("unknown fields and invalid numbers/IDs are rejected rather than stripped", async () => {
  const h = harness(); await tick();
  for (const input of [null, undefined, [], { ...payloads[0], owner: "forged" }, { ...payloads[0], startMs: NaN }, { ...payloads[0], startMs: 0.5 }, { ...payloads[0], consumerId: "c".repeat(129) }]) {
    await expect(h.ctx.audioClips.start(input as never)).rejects.toMatchObject({ code: "AUDIO_RANGE_INVALID" });
  }
  for (const name of ["finish", "cancel", "read", "release", "transcribe", "transcriptionStatus"] as const) await expect(h.ctx.audioClips[name](null as never)).rejects.toMatchObject({ code: "AUDIO_RANGE_INVALID" });
  expect(h.calls.some(c => c.method.startsWith("audio."))).toBe(false); await h.running.dispose();
});
test("actual Host denial codes survive SDK wrapping", async () => {
  const h = harness(); await tick();
  h.state.intercept = async (method, input) => {
    if (method === "environment.get") return h.state.snapshot;
    throw { code: "AUDIO_PERMISSION_DENIED", message: "denied" };
  };
  await expect(invoke(h.ctx, 0)).rejects.toMatchObject({ code: "AUDIO_PERMISSION_DENIED" }); await h.running.dispose();
});
test("each late method receipt after unmount is rejected", async () => {
  for (let i = 0; i < 7; i++) {
    const h = harness(); await tick(); let settle!: (v: unknown) => void;
    h.state.intercept = async (method, input) => method === "environment.get" ? h.state.snapshot : await new Promise(resolve => { settle = resolve; });
    const result = invoke(h.ctx, i); const observed = result.catch(error => error); await tick();
    h.send({ type: "surface.unmount", surfaceMountId: "mount" }); settle(reply(methods[i]!, payloads[i])); expect(await observed).toMatchObject({ code: "AUDIO_CONSUMER_STALE" }); await h.running.dispose();
  }
});
test("descriptor reply arriving after unmount never causes an audio operation", async () => {
  const h = harness(); await tick(); let settle!: (v: unknown) => void;
  h.state.intercept = async () => await new Promise(resolve => { settle = resolve; });
  const result = invoke(h.ctx, 0); const observed = result.catch(error => error);
  h.send({ type: "surface.unmount", surfaceMountId: "mount" }); settle(descriptor()); expect(await observed).toMatchObject({ code: "AUDIO_CONSUMER_STALE" });
  expect(h.calls.some(c => c.method.startsWith("audio."))).toBe(false); await h.running.dispose();
});
test("range/clip/job receipts cannot transfer to a new mount", async () => {
  const h = harness(); await tick(); await invoke(h.ctx, 0); await invoke(h.ctx, 1); await invoke(h.ctx, 5);
  h.send({ type: "surface.unmount", surfaceMountId: "mount" });
  h.send({ type: "surface.mount", surfaceMountId: "mount2", surfaceId: "main", root: {} }); await tick(); h.state.snapshot = descriptor("mount2");
  const prior = h.calls.length;
  for (const i of [1, 2, 3, 4, 5, 6]) await expect(invoke(h.ctx, i)).rejects.toMatchObject({ code: "AUDIO_CONSUMER_STALE" });
  expect(h.calls.length).toBe(prior); await h.running.dispose();
});
