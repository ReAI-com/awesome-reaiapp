import { expect, test } from "bun:test";
import { defineApp, type AppContext, type AudioClipRef, type AudioRangeReceipt, type AudioTranscriptionReceipt } from "@reai/app-sdk/v1";
import { MockHost } from "../src/v1/index";
import type { MockAudioClipsFixture } from "../src/v1/mock-host";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const fixture = (extra: Partial<MockAudioClipsFixture> = {}): MockAudioClipsFixture => ({
  consumers: [{ consumerId: "consumer", approvedStartMs: 10, approvedEndMs: 1000000, epoch: "epoch" }], now: () => 1000000, ...extra,
});
async function setup(audioClips?: MockAudioClipsFixture, appId = "app.a", generation = "account") {
  let ctx!: AppContext;
  const manifest = { appId, contributes: { surfaces: [{ id: "main" }] }, requires: { hostCapabilities: ["audio.capture@1", "audio.clips@1"] }, permissions: [{ id: "audio.capture@1" }, { id: "audio.clips@1" }] };
  const host = new MockHost({ manifest, ...(audioClips ? { audioClips } : {}), audioClipsAccountGeneration: generation,
    loadApp: async () => ({ default: defineApp({ activate(c) { ctx = c; c.surfaces.register("main", surface => surface.ready()); } }) }) });
  await host.installAndEnable(); const mount = await host.openSurface("main");
  return { host, ctx, mount, manifest };
}
let seq = 0;
async function range(host: MockHost, startMs = 10) {
  return host.bridge.request<AudioRangeReceipt>("audio.ranges.start", { requestId: "start-" + ++seq, consumerId: "consumer", startMs });
}
async function finish(host: MockHost, rangeId: string, endMs = 20) {
  return host.bridge.request<AudioClipRef>("audio.ranges.finish", { requestId: "finish-" + ++seq, rangeId, endMs });
}
async function clip(host: MockHost, duration = 10) { const r = await range(host); return finish(host, r.rangeId, 10 + duration); }
const read = (host: MockHost, clipId: string, offset = 0, maxBytes = 4) => host.bridge.request<{ bytes: number; offset: number; eof: boolean; bodyBase64: string }>("audio.clips.read", { requestId: "read-" + ++seq, clipId, offset, maxBytes });
const transcribe = (host: MockHost, clipId: string, key = "key") => host.bridge.request<AudioTranscriptionReceipt>("audio.clips.transcribe", { requestId: "stt-" + ++seq, clipId, idempotencyKey: key });
const status = (host: MockHost, jobId: string) => host.bridge.request<AudioTranscriptionReceipt>("audio.clips.transcriptionStatus", { requestId: "status-" + ++seq, jobId });
const cancel = (host: MockHost, rangeId: string) => host.bridge.request("audio.ranges.cancel", { requestId: "cancel-" + ++seq, rangeId });
const release = (host: MockHost, clipId: string) => host.bridge.request("audio.clips.release", { requestId: "release-" + ++seq, clipId });
const failure = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

test("Mock stays unavailable without an explicit synthetic fixture", async () => {
  const h = await setup(); await failure(h.ctx.audioClips.start({ requestId: "r", consumerId: "consumer", startMs: 10 }), "HOST_CAPABILITY_NOT_AVAILABLE");
  await failure(range(h.host), "HOST_CAPABILITY_NOT_AVAILABLE"); await h.host.disable();
});
test("SDK consumes the mock seven methods; refs and transcription are synthetic, not native evidence", async () => {
  const h = await setup(fixture());
  const r = await h.ctx.audioClips.start({ requestId: "r", consumerId: "consumer", startMs: 10 });
  const c = await h.ctx.audioClips.finish({ requestId: "f", rangeId: r.rangeId, endMs: 20 });
  expect(c).toMatchObject({ owner: { appId: "app.a", accountGeneration: "account" }, sizeBytes: 640, sampleRate: 16000, channels: 1, format: "f32le" });
  expect(await h.ctx.audioClips.read({ requestId: "read", clipId: c.clipId, offset: 0, maxBytes: 4 })).toMatchObject({ bytes: 4, bodyBase64: "AAAAAA==" });
  const j = await h.ctx.audioClips.transcribe({ requestId: "t", clipId: c.clipId, idempotencyKey: "key" }); await tick();
  expect(await h.ctx.audioClips.transcriptionStatus({ requestId: "s", jobId: j.jobId })).toMatchObject({ state: "complete", transcript: "Synthetic transcription" });
  await h.ctx.audioClips.release({ requestId: "release", clipId: c.clipId }); await h.host.disable();
});
test("strict unknown fields, IDs, finite integers and read bounds reject in the Host", async () => {
  const h = await setup(fixture());
  for (const bad of [null, [], {}, { requestId: "r", consumerId: "consumer", startMs: 10, owner: "forged" }, { requestId: "r", consumerId: "consumer", startMs: NaN }, { requestId: "r", consumerId: "consumer", startMs: 10.5 }, { requestId: "r", consumerId: "c".repeat(129), startMs: 10 }]) await failure(h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", bad), "AUDIO_RANGE_INVALID");
  const c = await clip(h.host);
  for (const maxBytes of [0, 262145, Infinity, -1]) await failure(read(h.host, c.clipId, 0, maxBytes), "AUDIO_RANGE_INVALID");
  await failure(read(h.host, c.clipId, 641), "AUDIO_RANGE_INVALID");
  expect(await read(h.host, c.clipId, 639, 4)).toMatchObject({ bytes: 1, offset: 639, eof: true });
  expect(await read(h.host, c.clipId, 640, 4)).toMatchObject({ bytes: 0, eof: true });
  for (const [method, input] of [
    ["audio.ranges.finish", { requestId: "f", rangeId: "x", endMs: 20 }], ["audio.ranges.cancel", { requestId: "c", rangeId: "x" }],
    ["audio.clips.read", { requestId: "r", clipId: c.clipId, offset: 0, maxBytes: 4 }], ["audio.clips.release", { requestId: "r", clipId: c.clipId }],
    ["audio.clips.transcribe", { requestId: "r", clipId: c.clipId, idempotencyKey: "key" }], ["audio.clips.transcriptionStatus", { requestId: "r", jobId: "j" }],
  ] as const) await failure(h.host.bridge.request(method, { ...input, epoch: "forged" }), "AUDIO_RANGE_INVALID");
  await h.host.disable();
});
test("both declarations and both permissions are checked per operation", async () => {
  const h = await setup(fixture()); const c = await clip(h.host);
  h.manifest.requires.hostCapabilities.splice(0, 1); await failure(read(h.host, c.clipId), "AUDIO_NOT_GRANTED");
  h.manifest.requires.hostCapabilities.push("audio.capture@1"); h.manifest.permissions.splice(0, 1); await failure(read(h.host, c.clipId), "AUDIO_PERMISSION_REQUIRED"); await h.host.disable();
});
test("start/finish payload equality, stable clip/job identities, and cancel terminal race", async () => {
  const h = await setup(fixture()); const input = { requestId: "same", consumerId: "consumer", startMs: 10 };
  const r = await h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", input);
  expect(await h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", { startMs: 10, consumerId: "consumer", requestId: "same" })).toEqual(r);
  await failure(h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", { ...input, startMs: 11 }), "AUDIO_RANGE_INVALID");
  const f = { requestId: "finish", rangeId: r.rangeId, endMs: 20 }; const c = await h.host.bridge.request<AudioClipRef>("audio.ranges.finish", f);
  expect(await h.host.bridge.request<AudioClipRef>("audio.ranges.finish", f)).toEqual(c);
  await failure(h.host.bridge.request<AudioClipRef>("audio.ranges.finish", { ...f, endMs: 21 }), "AUDIO_RANGE_INVALID");
  await failure(cancel(h.host, r.rangeId), "AUDIO_RANGE_INVALID");
  const j = await transcribe(h.host, c.clipId); expect((await transcribe(h.host, c.clipId)).jobId).toBe(j.jobId);
  const cancelled = await range(h.host); await cancel(h.host, cancelled.rangeId); await cancel(h.host, cancelled.rangeId);
  await failure(finish(h.host, cancelled.rangeId), "AUDIO_CANCELLED"); await release(h.host, c.clipId); await release(h.host, c.clipId); await h.host.disable();
});
test("cross-app, account, runtime and mount receipts never transfer", async () => {
  const shared = fixture(); const a = await setup(shared); const b = await setup(shared, "app.b");
  const r = await range(a.host); const c = await finish(a.host, r.rangeId); const j = await transcribe(a.host, c.clipId);
  await failure(finish(b.host, r.rangeId), "AUDIO_CLIP_FORBIDDEN"); await failure(read(b.host, c.clipId), "AUDIO_CLIP_FORBIDDEN"); await failure(status(b.host, j.jobId), "AUDIO_CLIP_FORBIDDEN");
  const changed = await setup(shared, "app.a", "other-account"); await failure(read(changed.host, c.clipId), "AUDIO_CLIP_FORBIDDEN");
  const restarted = await setup(shared); await failure(read(restarted.host, c.clipId), "AUDIO_CLIP_FORBIDDEN");
  await a.host.unmountSurface(a.mount.surfaceMountId); await a.host.openSurface("main"); await failure(read(a.host, c.clipId), "AUDIO_CLIP_FORBIDDEN"); await failure(range(a.host), "AUDIO_CONSUMER_STALE");
  expect((await clip(b.host)).owner.appId).toBe("app.b");
  for (const h of [a, b, changed, restarted]) await h.host.disable();
});
test("approved window, acquisition lower, future time and exact duration are enforced", async () => {
  const h = await setup(fixture());
  await failure(range(h.host, 9), "AUDIO_RANGE_UNAVAILABLE"); await failure(range(h.host, 1000001), "AUDIO_RANGE_UNAVAILABLE");
  const future = await range(h.host, 999990); await failure(finish(h.host, future.rangeId, 1000001), "AUDIO_RANGE_UNAVAILABLE"); await cancel(h.host, future.rangeId);
  const r = await range(h.host); await failure(finish(h.host, r.rangeId, 10), "AUDIO_RANGE_INVALID");
  expect((await finish(h.host, r.rangeId, 600010)).sizeBytes).toBe(38400000);
  const r2 = await range(h.host); await failure(finish(h.host, r2.rangeId, 600011), "AUDIO_RANGE_INVALID");
  h.host.setAudioClipSource("consumer", { epoch: "epoch", gap: false, approvedStartMs: 15, approvedEndMs: 1000000 }); await failure(finish(h.host, r2.rangeId), "AUDIO_RANGE_UNAVAILABLE"); await h.host.disable();
});
test("gap is sticky; epoch changes cannot splice ranges or reopen prior history", async () => {
  const h = await setup(fixture()); const c = await clip(h.host); const r = await range(h.host);
  const source = { epoch: "epoch", gap: true, approvedStartMs: 10, approvedEndMs: 1000000 };
  h.host.setAudioClipSource("consumer", source); await failure(finish(h.host, r.rangeId), "AUDIO_RANGE_UNAVAILABLE"); await failure(read(h.host, c.clipId), "AUDIO_RANGE_UNAVAILABLE"); await failure(range(h.host), "AUDIO_RANGE_UNAVAILABLE");
  h.host.setAudioClipSource("consumer", { ...source, gap: false }); await failure(range(h.host), "AUDIO_RANGE_UNAVAILABLE");
  h.host.setAudioClipSource("consumer", { ...source, epoch: "new-epoch", gap: false, approvedStartMs: 1000000 });
  await failure(range(h.host, 10), "AUDIO_RANGE_UNAVAILABLE"); await failure(read(h.host, c.clipId), "AUDIO_RANGE_UNAVAILABLE"); await h.host.disable();
});
test("gap/epoch during extraction suppress late publication", async () => {
  for (const change of ["gap", "epoch"] as const) {
    let done!: () => void; const h = await setup(fixture({ slice: async () => await new Promise<void>(resolve => { done = resolve; }) }));
    const r = await range(h.host); const p = finish(h.host, r.rangeId); const observed = p.catch(error => error); await tick();
    h.host.setAudioClipSource("consumer", { epoch: change === "epoch" ? "changed" : "epoch", gap: change === "gap", approvedStartMs: change === "epoch" ? 1000000 : 10, approvedEndMs: 1000000 }); done(); expect(await observed).toMatchObject({ code: "AUDIO_RANGE_UNAVAILABLE" }); await h.host.disable();
  }
});
test("TTL is issuance-fixed, arbitrary bounded reads never extend it, and metadata expires", async () => {
  let now = 1000000; const h = await setup(fixture({ now: () => now })); const c = await clip(h.host);
  now += 299999; expect((await read(h.host, c.clipId, 1, 262144)).bytes).toBe(639);
  now++; await failure(read(h.host, c.clipId), "AUDIO_CLIP_EXPIRED"); await failure(transcribe(h.host, c.clipId), "AUDIO_CLIP_EXPIRED");
  now += 300000; await failure(read(h.host, c.clipId), "AUDIO_CLIP_NOT_FOUND"); await h.host.disable();
});
test("per-app range/clip/byte limits and global 32-range/256MiB budgets never evict neighbors", async () => {
  const h = await setup(fixture()); const ranges = [];
  for (let i = 0; i < 8; i++) ranges.push(await range(h.host)); await failure(range(h.host), "AUDIO_BUDGET_EXCEEDED");
  for (const r of ranges) await cancel(h.host, r.rangeId);
  for (let i = 0; i < 8; i++) await clip(h.host); const r = await range(h.host); await failure(finish(h.host, r.rangeId), "AUDIO_BUDGET_EXCEEDED"); await h.host.disable();
  const bytes = await setup(fixture()); await clip(bytes.host, 600000); const large = await range(bytes.host); await failure(finish(bytes.host, large.rangeId, 600010), "AUDIO_BUDGET_EXCEEDED"); await bytes.host.disable();
  const shared = fixture(); const apps = [];
  for (let a = 0; a < 5; a++) apps.push(await setup(shared, "ranges." + a));
  for (let i = 0; i < 32; i++) await range(apps[Math.floor(i / 8)]!.host); await failure(range(apps[4]!.host), "AUDIO_BUDGET_EXCEEDED");
  for (const app of apps) await app.host.disable();
  const sharedBytes = fixture(); const owners = [];
  for (let i = 0; i < 7; i++) owners.push(await setup(sharedBytes, "bytes." + i));
  const retained = []; for (let i = 0; i < 6; i++) retained.push(await clip(owners[i]!.host, 600000));
  await failure(clip(owners[6]!.host, 600000), "AUDIO_BUDGET_EXCEEDED"); expect((await read(owners[0]!.host, retained[0]!.clipId)).bytes).toBe(4);
  for (const owner of owners) await owner.host.disable();
});
test("slice queue is 2+16; cancellation retains running slots and reservations until actual exit", async () => {
  const exits: (() => void)[] = []; const shared = fixture({ slice: async () => await new Promise<void>(resolve => exits.push(resolve)) });
  const apps = []; for (let i = 0; i < 4; i++) apps.push(await setup(shared, "queue." + i));
  const records: { host: MockHost; rangeId: string; result: Promise<unknown> }[] = [];
  for (let i = 0; i < 18; i++) { const host = apps[Math.floor(i / 6)]!.host; const r = await range(host); const result = finish(host, r.rangeId).catch(error => error); records.push({ host, rangeId: r.rangeId, result }); }
  await tick(); expect(exits.length).toBe(2); const extra = await range(apps[3]!.host); await failure(finish(apps[3]!.host, extra.rangeId), "AUDIO_QUEUE_FULL");
  await cancel(records[0]!.host, records[0]!.rangeId); expect(await records[0]!.result).toMatchObject({ code: "AUDIO_CANCELLED" }); await failure(finish(apps[3]!.host, extra.rangeId), "AUDIO_QUEUE_FULL"); expect(exits.length).toBe(2);
  exits[0]!(); await tick(); expect(exits.length).toBe(3);
  for (const app of apps) await app.host.disable(); for (const done of exits) done(); await Promise.all(records.map(r => r.result));
});
test("cancel before and during extraction has one winner; running bytes remain charged", async () => {
  let done!: () => void; const h = await setup(fixture({ slice: async () => await new Promise<void>(resolve => { done = resolve; }) })); const r = await range(h.host);
  const p = finish(h.host, r.rangeId, 600010); const observed = p.catch(error => error); await tick(); await cancel(h.host, r.rangeId); expect(await observed).toMatchObject({ code: "AUDIO_CANCELLED" });
  const other = await range(h.host); await failure(finish(h.host, other.rangeId, 600010), "AUDIO_BUDGET_EXCEEDED"); done(); await tick(); await cancel(h.host, other.rangeId); await h.host.disable();
});
test("STT uses a separate 2+16 queue and retired/expired/gapped work cannot publish text", async () => {
  const exits: (() => void)[] = []; const shared = fixture({ transcribe: async () => { await new Promise<void>(resolve => exits.push(resolve)); return "late"; } });
  const apps = []; for (let i = 0; i < 3; i++) apps.push(await setup(shared, "stt." + i));
  const clips = []; for (const a of apps) clips.push(await clip(a.host));
  const jobs = []; for (let i = 0; i < 18; i++) jobs.push(await transcribe(apps[Math.floor(i / 6)]!.host, clips[Math.floor(i / 6)]!.clipId, "key-" + i));
  await tick(); expect(exits.length).toBe(2); await failure(transcribe(apps[2]!.host, clips[2]!.clipId, "overflow"), "AUDIO_QUEUE_FULL");
  expect((await clip(apps[2]!.host)).sizeBytes).toBe(640); await release(apps[0]!.host, clips[0]!.clipId);
  for (let i = 0; i < 4; i++) await transcribe(apps[2]!.host, clips[2]!.clipId, "refill-" + i);
  await failure(transcribe(apps[2]!.host, clips[2]!.clipId, "overflow-2"), "AUDIO_QUEUE_FULL");
  exits[0]!(); await tick(); expect(exits.length).toBe(3); await failure(status(apps[0]!.host, jobs[0]!.jobId), "AUDIO_CLIP_NOT_FOUND");
  for (const a of apps) await a.host.disable(); for (const done of exits) done(); await tick();
  for (const kind of ["gap", "expiry", "retire"] as const) {
    let now = 1000000; let done!: () => void; const a = await setup(fixture({ now: () => now, transcribe: async () => { await new Promise<void>(resolve => { done = resolve; }); return "must not publish"; } })); const c = await clip(a.host); const j = await transcribe(a.host, c.clipId); await tick();
    if (kind === "gap") a.host.setAudioClipSource("consumer", { epoch: "epoch", gap: true, approvedStartMs: 10, approvedEndMs: 1000000 });
    if (kind === "expiry") now += 300000;
    if (kind === "retire") await a.host.unmountSurface(a.mount.surfaceMountId);
    done(); await tick();
    await failure(status(a.host, j.jobId), kind === "gap" ? "AUDIO_RANGE_UNAVAILABLE" : kind === "expiry" ? "AUDIO_CLIP_EXPIRED" : "AUDIO_CONSUMER_STALE"); await a.host.disable();
  }
});

test("withdrawn permissions suppress extraction and transcription publication", async () => {
  let finishSlice!: () => void;
  const a = await setup(fixture({ slice: async () => await new Promise<void>(resolve => { finishSlice = resolve; }) }));
  const r = await range(a.host); const pending = finish(a.host, r.rangeId).catch(error => error); await tick();
  a.manifest.permissions.splice(0, 1); finishSlice();
  expect(await pending).toMatchObject({ code: "AUDIO_CONSUMER_STALE" }); await a.host.disable();
  let finishStt!: () => void;
  const b = await setup(fixture({ transcribe: async () => { await new Promise<void>(resolve => { finishStt = resolve; }); return "must not publish"; } }));
  const c = await clip(b.host); const job = await transcribe(b.host, c.clipId); await tick();
  b.manifest.requires.hostCapabilities.splice(0, 1); finishStt(); await tick();
  b.manifest.requires.hostCapabilities.push("audio.capture@1");
  expect(await status(b.host, job.jobId)).toMatchObject({ state: "failed", errorCode: "AUDIO_CONSUMER_STALE" });
  expect((await status(b.host, job.jobId)).transcript).toBeUndefined(); await b.host.disable();
});

test("synthetic consumer and retained metadata caps reject without eviction and reclaim expired entries", async () => {
  const seeds = Array.from({ length: 8 }, (_, i) => ({ consumerId: "c" + i, epoch: "epoch", approvedStartMs: 10, approvedEndMs: 1000000 }));
  const valid = await setup(fixture({ consumers: seeds })); await valid.host.disable();
  await failure(setup(fixture({ consumers: [...seeds, { ...seeds[0]!, consumerId: "c8" }] })), "AUDIO_BUDGET_EXCEEDED");
  let now = 1000000; const shared = fixture({ now: () => now });
  const apps = []; const receipts = [];
  for (let i = 0; i < 16; i++) {
    const a = await setup(shared, "metadata." + i); apps.push(a);
    const input = { requestId: "retained", consumerId: "consumer", startMs: 10 };
    receipts.push(await a.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", input));
    for (let k = 0; k < 253; k++) await failure(read(a.host, "absent"), "AUDIO_CLIP_NOT_FOUND");
    await failure(range(a.host), "AUDIO_BUDGET_EXCEEDED");
    expect(await a.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", input)).toEqual(receipts[i]!);
  }
  const outside = await setup(shared, "metadata.outside"); await failure(range(outside.host), "AUDIO_BUDGET_EXCEEDED");
  now += 300000; expect((await range(outside.host)).consumerId).toBe("consumer");
  for (const a of [...apps, outside]) await a.host.disable();
});
test("slice and STT deadline boundaries suppress success without an intervening polling request", async () => {
  let now = 1000000; let done!: () => void;
  const a = await setup(fixture({ now: () => now, slice: async () => await new Promise<void>(resolve => { done = resolve; }) }));
  const r = await range(a.host); const pending = finish(a.host, r.rangeId).catch(error => error); await tick();
  now += 30000; done(); expect(await pending).toMatchObject({ code: "AUDIO_CANCELLED" }); await a.host.disable();
  now = 1000000;
  const b = await setup(fixture({ now: () => now, transcribe: async () => { await new Promise<void>(resolve => { done = resolve; }); return "past deadline"; } }));
  const c = await clip(b.host); const j = await transcribe(b.host, c.clipId); await tick(); now += 120000; done(); await tick();
  expect(await status(b.host, j.jobId)).toMatchObject({ state: "cancelled", errorCode: "AUDIO_CANCELLED" }); await b.host.disable();
});

test("active range payload equality survives request-cache expiry", async () => {
  let now = 1000000; const h = await setup(fixture({ now: () => now }));
  const input = { requestId: "long-lived", consumerId: "consumer", startMs: 10 };
  const receipt = await h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", input); now += 300000;
  await failure(h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", { ...input, startMs: 11 }), "AUDIO_RANGE_INVALID");
  expect(await h.host.bridge.request<AudioRangeReceipt>("audio.ranges.start", input)).toEqual(receipt); await h.host.disable();
});
