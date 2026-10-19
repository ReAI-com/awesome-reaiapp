import workflowSchema from "@reai/app-sdk/developer-workflow-schema";
/**
 * Mock Host —— 在测试里扮演 Host 的那一侧。
 *
 * 它实现 [`HostBridge`](@reai/app-sdk)，因此 App 代码**一个字都不用改**就能在测试里跑。
 * 这是「合同测试」能成立的前提：如果测试要 App 做任何特殊适配，那测的就不是它上线
 * 之后的行为。
 *
 * Mock Host 刻意**把 Host 的约束照做**而不是放宽：
 * - 只允许读写 Manifest 里声明过的 store，命名空间强制为 `appId/storeId`；
 * - `ready` / `fail` 每个 mount 只认第一次；
 * - 未声明的 Surface / Command 注册会被记下来，供「声明与实际必须一致」的断言。
 */

import {
  NotifyMethod,
  RequestMethod,
  audioClipsRequestMethod,
  PLATFORM_CONTRACT_LIMITS,
  type AudioClipsRequestMethod,
  type AudioClipRef,
  type AudioRangeReceipt,
  type AudioTranscriptionReceipt,
  type PlatformContractErrorCode,
  type CommandSettlement,
  type CloudDeliveryResult,
  type HostBridge,
  type HostMessage,
  type RegistrationReport,
  type DeveloperPlatformRequest,
  type DeveloperWorkflowRequest,
  type WireError,
} from "@reai/app-sdk/v1";
import { MockNetworkUploads } from "./network-upload";
import { MockPlatformServices, type MockPlatformServicesFixture } from "./mock-platform-services";

export interface MockNetworkResponse {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
  url?: string;
}
export type MockNetworkHandler = (input: {
  request: Readonly<Record<string, unknown>>;
  body: Blob;
  signal: AbortSignal;
}) => MockNetworkResponse | Promise<MockNetworkResponse>;

export type DeveloperPlatformMockHandler = (
  request: DeveloperPlatformRequest,
) => unknown | Promise<unknown>;

export interface MockHostOptions {
  /** Explicit synthetic source/admission fixture. Never grants product capability or native proof. */
  ownedConversationOpen?: {
    accountGeneration: string; packageDigest: string; admitted: boolean;
    decision: "granted" | "pending" | "denied";
    userCeiling?: "off" | "in_app" | "system";
    sessionIds?: string[]; now?: () => number;
  };
  /**
   * v1.0.5 grant-gated 平台服务（audio.capture@1 / tasks.present@1 / notifications.publish@1）的
   * 显式夹具。`approvals` 模拟平台审核批准，缺省（不传本项或空数组）一律拒绝。
   */
  platformServices?: MockPlatformServicesFixture;
  /** Explicit virtual PCM/STT fixture only; absent means unavailable. Never a native proof. */
  audioClips?: MockAudioClipsFixture;
  audioClipsAccountGeneration?: string;
  /** Deterministic UI locale; independent of the machine running the tests. */
  locale?: import("@reai/app-sdk/v1").UiLocale;
  /** App 的 Manifest（已解析）。 */
  manifest: AppManifestLike;
  /** 加载 App 入口模块，返回其 default 导出。 */
  loadApp: () => Promise<{ default: unknown }>;
  /** 创建 Surface 的 DOM 根节点。没有 DOM 环境时留空。 */
  createRoot?: () => HTMLElement;
  /** account.status 的最小返回；合同 happy path 默认模拟已登录，未登录场景显式传入。 */
  accountStatus?: { enabled: boolean; loggedIn: boolean };
  voiceCommandStatus?: { configured: boolean; loggedIn: boolean };
  voiceCommandResult?: { runId: string; status: "completed"; reply: string; durationMs: number };
  /** `dsh.status` 的返回；缺省按「引擎可用、已登录、模型权限已授予」模拟。 */
  dshStatus?: import("@reai/app-sdk/v1").DshStatus;
  voiceInputStatus?: import("@reai/app-sdk/v1").VoiceInputStatus;
  systemTaskVersionStatus?: import("@reai/app-sdk/v1").SystemTaskVersionStatus;
  /**
   * apps.status 的返回（A3-24 门控数据源）。缺省按「已安装且启用」模拟——
   * 合同测试关注的是插件把状态用对，而不是宿主侧注册表本身。
   */
  appsStatus?: { installed: boolean; enabled: boolean };
  /** http.fetch 的确定性响应；测试不访问真实网络。 */
  networkResponse?: MockNetworkResponse;
  /** Explicit synthetic response fixture. It must not call a real network service. */
  networkHandler?: MockNetworkHandler;
  /** Controlled clock for lazy upload expiry checks; defaults to Date.now. */
  networkUploadNow?: () => number;
  /**
   * 开放平台确定性 fixture 的唯一入口。只有测试显式注入时才可成功；缺省与
   * F3A 产品 Host 一样 fail closed，不提供环境变量或隐式产品开关。
   */
  developerPlatformHandler?: DeveloperPlatformMockHandler;
}

/** Mock Host 用到的 Manifest 子集。 */
export interface AppManifestLike {
  appId: string;
  contributes?: {
    notificationScenes?: { key: string; maxLevel: "off" | "in_app" | "system" }[];
    surfaces?: { id: string }[];
    commands?: { id: string; timeoutMs?: number }[];
    intents?: { id: string }[];
    services?: { id: string; implementation?: string; methods: { id: string }[] }[];
  };
  data?: { privateStores?: { id: string }[] };
  requires?: { hostCapabilities?: string[]; services?: { id: string }[] };
  permissions?: { id: string }[];
  network?: {
    endpoints?: {
      id: string;
      origins: string[];
      pathPrefixes: string[];
      methods: string[];
    }[];
  };
}

/** 一次 Surface mount 在 Host 侧的观察结果。 */
export interface SurfaceObservation {
  surfaceId: string;
  surfaceMountId: string;
  root: HTMLElement | undefined;
  /** `ready` 收到的次数。合同要求恰好 1。 */
  readyCount: number;
  /** `fail` 收到的次数。与 ready 互斥。 */
  failCount: number;
  failure?: WireError;
  /** 收到的意图，按顺序（含 mount 时携带的 initialIntent）。 */
  intents: unknown[];
  /** 非致命错误上报。 */
  errors: WireError[];
  /** surface.nav 上报序列（面包屑合同，审计 B2-3）。null = 回根页。 */
  navReports: ({ key: string; label: string } | null)[];
  unmounted: boolean;
}

/**
 * 真实 Host 的 `BridgeError` 序列化是 `{code, message}`（`apps/host.rs` 的
 * `#[serde(rename_all = "camelCase")]` 结构体），Tauri `invoke()` 拒绝时
 * 直接把这个 JSON 形状扔给 JS，不是包在某个 Error 子类里。
 *
 * 这里补一个可选 `code`，让测试能构造出与生产环境同形状的拒绝——插件侧
 * `wrapBridgeErrors`/`normalizeBridgeError` 读的正是 `{code, message}`；
 * 不带 `code` 的话，插件侧任何按稳定错误码分支的逻辑在测试里永远走不到，
 * 只能测出「失败了」，测不出「失败得对不对」。
 */
export class MockHostError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "MockHostError";
    if (code !== undefined) this.code = code;
  }
}

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export interface MockAudioClipSource {
  epoch: string;
  gap: boolean;
  approvedStartMs: number;
  approvedEndMs: number;
}
export interface MockAudioClipsFixture {
  /** Already-admitted synthetic consumers, not an implicit capture acquire. */
  consumers: readonly (Omit<MockAudioClipSource, "gap"> & { consumerId: string; gap?: boolean })[];
  now?: () => number;
  slice?: (input: { range: AudioRangeReceipt; endMs: number }, signal: AbortSignal) => void | Promise<void>;
  transcribe?: (clip: AudioClipRef, signal: AbortSignal) => string | Promise<string>;
}
type MockAudioOwner = { key: string; appId: string; generation: string; live: () => boolean };
type MockConsumer = { owner: MockAudioOwner; source: MockAudioClipSource };
type MockRange = {
  owner: MockAudioOwner; consumer: MockConsumer; receipt: AudioRangeReceipt;
  state: "active" | "pending" | "finished" | "cancelled" | "failed";
  expires: number; reserved: number; running: boolean;
  finish?: { requestId: string; endMs: number; promise: Promise<AudioClipRef> };
  clipId?: string; error?: string; cancel?: () => void;
};
type MockClip = { owner: MockAudioOwner; consumer: MockConsumer; ref: AudioClipRef; borrowers: number; dead?: string; retainedUntil: number };
type MockStt = { owner: MockAudioOwner; clip: MockClip; key: string; receipt: AudioTranscriptionReceipt; running: boolean; expires: number; cancel?: () => void };
const mockAudioLimits = PLATFORM_CONTRACT_LIMITS.audio;
function mockAudioFail(code: string): never { throw new MockHostError(code, code); }
const mockAudioId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const mockAudioInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
type MockAudioWork = { owner: string; deadline: number; running: boolean; stopped: boolean; controller: AbortController; run: (signal: AbortSignal) => Promise<void>; fail: (code: string) => void; release: () => void };
/** Slots follow actual hook completion, even when cancellation settles the caller first. */
class MockAudioQueue {
  private readonly waiting: MockAudioWork[] = [];
  private readonly work = new Set<MockAudioWork>();
  private running = 0;
  assertCapacity(): void {
    if (this.running >= 2 && this.waiting.length >= 16) mockAudioFail("AUDIO_QUEUE_FULL");
  }
  enqueue(owner: string, deadline: number, run: MockAudioWork["run"], fail: MockAudioWork["fail"], release: () => void): () => void {
    this.assertCapacity();
    const item: MockAudioWork = { owner, deadline, run, fail, release, running: false, stopped: false, controller: new AbortController() };
    this.work.add(item); this.waiting.push(item); this.pump();
    return () => this.stop(item);
  }
  private stop(item: MockAudioWork): void {
    if (!this.work.has(item) || item.stopped) return;
    item.stopped = true; item.controller.abort(); item.fail("AUDIO_CANCELLED");
    if (!item.running) {
      const index = this.waiting.indexOf(item); if (index >= 0) this.waiting.splice(index, 1);
      this.work.delete(item); item.release(); this.pump();
    }
  }
  expire(now: number): void { for (const item of this.work) if (now >= item.deadline) this.stop(item); }
  private pump(): void {
    while (this.running < 2 && this.waiting.length) {
      const item = this.waiting.shift()!; item.running = true; this.running++;
      void Promise.resolve().then(() => item.run(item.controller.signal)).catch(error => {
        const code = error instanceof MockHostError && error.code?.startsWith("AUDIO_") ? error.code : "AUDIO_RANGE_UNAVAILABLE";
        item.fail(code);
      }).finally(() => { this.work.delete(item); this.running--; item.release(); this.pump(); });
    }
  }
}
/** One explicitly shared fixture can model one multi-app synthetic Host. */
class MockAudioClips {
  private readonly consumers = new Map<string, MockConsumer>();
  private readonly ranges = new Map<string, MockRange>();
  private readonly clips = new Map<string, MockClip>();
  private readonly jobs = new Map<string, MockStt>();
  private readonly operations = new Map<string, { owner: MockAudioOwner; fingerprint: string; expires: number }>();
  private readonly seeds: MockAudioClipsFixture["consumers"];
  private readonly slices = new MockAudioQueue();
  private readonly stt = new MockAudioQueue();
  private lastNow = 0;
  constructor(private readonly fixture: MockAudioClipsFixture) {
    if (fixture.consumers.length > mockAudioLimits.maxConsumersPerApp || new Set(fixture.consumers.map(c => c.consumerId)).size !== fixture.consumers.length) mockAudioFail("AUDIO_BUDGET_EXCEEDED");
    for (const consumer of fixture.consumers) {
      if (!mockAudioId(consumer.consumerId) || !mockAudioId(consumer.epoch) || !mockAudioInt(consumer.approvedStartMs) || !mockAudioInt(consumer.approvedEndMs) || consumer.approvedEndMs < consumer.approvedStartMs) mockAudioFail("AUDIO_RANGE_INVALID");
    }
    this.seeds = structuredClone(fixture.consumers);
  }
  private now(): number {
    const now = this.fixture.now?.() ?? Date.now();
    if (!mockAudioInt(now) || now < this.lastNow || now > Number.MAX_SAFE_INTEGER - 600000) mockAudioFail("AUDIO_RANGE_UNAVAILABLE");
    this.lastNow = now; return now;
  }
  private metadata(owner: MockAudioOwner): void {
    const all = [...this.consumers.values(), ...this.ranges.values(), ...this.clips.values(), ...this.jobs.values(), ...this.operations.values()];
    if (all.length >= 4096 || all.filter(x => x.owner.appId === owner.appId).length >= 256) mockAudioFail("AUDIO_BUDGET_EXCEEDED");
  }
  private consumer(owner: MockAudioOwner, id: string): MockConsumer {
    const key = JSON.stringify([owner.appId, id]); let consumer = this.consumers.get(key);
    if (!consumer) {
      const seed = this.seeds.find(c => c.consumerId === id); if (!seed) mockAudioFail("AUDIO_CONSUMER_STALE");
      this.metadata(owner);
      consumer = { owner, source: { epoch: seed.epoch, gap: seed.gap ?? false, approvedStartMs: seed.approvedStartMs, approvedEndMs: seed.approvedEndMs } };
      this.consumers.set(key, consumer);
    }
    if (consumer.owner.key !== owner.key || !consumer.owner.live()) mockAudioFail("AUDIO_CONSUMER_STALE");
    return consumer;
  }
  private window(consumer: MockConsumer, epoch: string, start: number, end: number): void {
    if (!consumer.owner.live()) mockAudioFail("AUDIO_CONSUMER_STALE");
    const now = this.now(); const source = consumer.source;
    if (source.gap || source.epoch !== epoch || start < source.approvedStartMs || end > Math.min(now, source.approvedEndMs)) mockAudioFail("AUDIO_RANGE_UNAVAILABLE");
  }
  setSource(owner: MockAudioOwner, consumerId: string, source: MockAudioClipSource): void {
    if (!mockAudioId(source.epoch) || typeof source.gap !== "boolean" || !mockAudioInt(source.approvedStartMs) || !mockAudioInt(source.approvedEndMs) || source.approvedEndMs < source.approvedStartMs) mockAudioFail("AUDIO_RANGE_INVALID");
    const now = this.now(); const consumer = this.consumer(owner, consumerId); const previous = consumer.source;
    consumer.source = { ...source, approvedStartMs: Math.max(source.approvedStartMs, previous.approvedStartMs, source.epoch === previous.epoch ? 0 : now), gap: source.epoch === previous.epoch ? previous.gap || source.gap : source.gap };
  }
  private own<T extends { owner: MockAudioOwner }>(item: T | undefined, owner: MockAudioOwner, absent: string): T {
    if (!item) mockAudioFail(absent);
    if (item.owner.key !== owner.key) mockAudioFail("AUDIO_CLIP_FORBIDDEN");
    return item;
  }
  private cancelJobs(clip: MockClip): void { for (const job of this.jobs.values()) if (job.clip === clip) job.cancel?.(); }
  private prune(now: number): void {
    this.slices.expire(now); this.stt.expire(now);
    for (const [id, clip] of this.clips) {
      if (!clip.dead && now >= clip.ref.expiresAtMs) { clip.dead = "AUDIO_CLIP_EXPIRED"; this.cancelJobs(clip); }
      if (clip.dead && clip.borrowers === 0 && now >= clip.retainedUntil) this.clips.delete(id);
    }
    for (const [id, range] of this.ranges) if (!range.running && range.expires <= now) this.ranges.delete(id);
    for (const [id, job] of this.jobs) if (!job.running && job.expires <= now) this.jobs.delete(id);
    for (const [id, op] of this.operations) if (op.expires <= now) this.operations.delete(id);
  }
  private borrow(owner: MockAudioOwner, id: string): MockClip {
    const clip = this.own(this.clips.get(id), owner, "AUDIO_CLIP_NOT_FOUND");
    if (clip.dead) mockAudioFail(clip.dead);
    if (this.now() >= clip.ref.expiresAtMs) mockAudioFail("AUDIO_CLIP_EXPIRED");
    this.window(clip.consumer, clip.ref.epoch, clip.ref.effectiveStartMs, clip.ref.effectiveEndMs); return clip;
  }
  private reserve(owner: MockAudioOwner, bytes: number): void {
    const held = [...this.clips.values()].filter(c => !c.dead || c.borrowers > 0);
    const reserved = [...this.ranges.values()].filter(r => r.reserved > 0);
    const appBytes = held.filter(c => c.owner.appId === owner.appId).reduce((sum, c) => sum + c.ref.sizeBytes, 0) + reserved.filter(r => r.owner.appId === owner.appId).reduce((sum, r) => sum + r.reserved, 0);
    const total = held.reduce((sum, c) => sum + c.ref.sizeBytes, 0) + reserved.reduce((sum, r) => sum + r.reserved, 0);
    if (appBytes + bytes > mockAudioLimits.maxBytesPerApp || total + bytes > mockAudioLimits.maxBytesGlobal || held.filter(c => c.owner.appId === owner.appId).length + reserved.filter(r => r.owner.appId === owner.appId).length >= mockAudioLimits.maxClipsPerApp) mockAudioFail("AUDIO_BUDGET_EXCEEDED");
  }
  request(owner: MockAudioOwner, method: AudioClipsRequestMethod, input: unknown): unknown {
    const now = this.now(); this.prune(now);
    const fields: Record<AudioClipsRequestMethod, readonly string[]> = {
      "audio.ranges.start": ["requestId", "consumerId", "startMs"], "audio.ranges.finish": ["requestId", "rangeId", "endMs"], "audio.ranges.cancel": ["requestId", "rangeId"],
      "audio.clips.read": ["requestId", "clipId", "offset", "maxBytes"], "audio.clips.release": ["requestId", "clipId"], "audio.clips.transcribe": ["requestId", "clipId", "idempotencyKey"], "audio.clips.transcriptionStatus": ["requestId", "jobId"],
    };
    const keys = fields[method];
    if (!input || typeof input !== "object" || Array.isArray(input)) mockAudioFail("AUDIO_RANGE_INVALID");
    const p = input as Record<string, unknown>;
    if (Object.keys(p).some(k => !keys.includes(k)) || keys.some(k => !(k in p))) mockAudioFail("AUDIO_RANGE_INVALID");
    for (const k of keys) if (k.endsWith("Ms") || k === "offset" || k === "maxBytes" ? !mockAudioInt(p[k]) : !mockAudioId(p[k])) mockAudioFail("AUDIO_RANGE_INVALID");
    if (method === RequestMethod.AudioClipsRead && ((p.maxBytes as number) < 1 || (p.maxBytes as number) > mockAudioLimits.maxReadBytes)) mockAudioFail("AUDIO_RANGE_INVALID");
    // Active range identities outlive the bounded request cache; preserve payload equality.
    if (method === RequestMethod.AudioRangesStart) {
      const saved = [...this.ranges.values()].find(r => r.owner.key === owner.key && r.receipt.requestId === p.requestId);
      if (saved && (saved.receipt.consumerId !== p.consumerId || saved.receipt.requestedStartMs !== p.startMs)) mockAudioFail("AUDIO_RANGE_INVALID");
    }
    if (method === RequestMethod.AudioRangesFinish) {
      const saved = this.ranges.get(p.rangeId as string);
      if (saved?.owner.key === owner.key && saved.finish && (saved.finish.requestId !== p.requestId || saved.finish.endMs !== p.endMs)) mockAudioFail("AUDIO_RANGE_INVALID");
    }
    const operation = JSON.stringify([owner.key, p.requestId]); const fingerprint = JSON.stringify([method, ...keys.slice().sort().map(k => [k, p[k]])]);
    const prior = this.operations.get(operation);
    if (prior && prior.fingerprint !== fingerprint) mockAudioFail("AUDIO_RANGE_INVALID");
    if (!prior) { this.metadata(owner); this.operations.set(operation, { owner, fingerprint, expires: now + 300000 }); }
    if (method === RequestMethod.AudioRangesStart) {
      const consumer = this.consumer(owner, p.consumerId as string); this.window(consumer, consumer.source.epoch, p.startMs as number, p.startMs as number);
      const priorRange = [...this.ranges.values()].find(r => r.owner.key === owner.key && r.receipt.requestId === p.requestId);
      if (priorRange) return structuredClone(priorRange.receipt);
      const active = [...this.ranges.values()].filter(r => r.state === "active" || r.state === "pending" || r.running);
      if (active.length >= mockAudioLimits.maxRangesGlobal || active.filter(r => r.owner.appId === owner.appId).length >= mockAudioLimits.maxRangesPerApp) mockAudioFail("AUDIO_BUDGET_EXCEEDED");
      this.metadata(owner);
      const receipt: AudioRangeReceipt = { rangeId: nextId("range"), requestId: p.requestId as string, consumerId: p.consumerId as string, requestedStartMs: p.startMs as number, epoch: consumer.source.epoch };
      this.ranges.set(receipt.rangeId, { owner, consumer, receipt, state: "active", expires: Infinity, reserved: 0, running: false }); return structuredClone(receipt);
    }
    if (method === RequestMethod.AudioRangesCancel || method === RequestMethod.AudioRangesFinish) {
      const range = this.own(this.ranges.get(p.rangeId as string), owner, "AUDIO_RANGE_INVALID");
      if (method === RequestMethod.AudioRangesCancel) {
        if (range.state === "finished" || range.state === "failed") mockAudioFail("AUDIO_RANGE_INVALID");
        range.state = "cancelled"; range.expires = now + 300000; range.cancel?.(); return undefined;
      }
      if (range.state === "cancelled") mockAudioFail("AUDIO_CANCELLED");
      if (range.state === "failed") mockAudioFail(range.error ?? "AUDIO_RANGE_UNAVAILABLE");
      const end = p.endMs as number; const start = range.receipt.requestedStartMs;
      if (end <= start || end - start > mockAudioLimits.maxRangeMs) mockAudioFail("AUDIO_RANGE_INVALID");
      this.window(range.consumer, range.receipt.epoch, start, end);
      if (range.finish) {
        if (range.finish.requestId !== p.requestId || range.finish.endMs !== end) mockAudioFail("AUDIO_RANGE_INVALID");
        if (range.clipId) this.borrow(owner, range.clipId);
        return range.finish.promise;
      }
      const bytes = (end - start) * 64; this.reserve(owner, bytes); this.slices.assertCapacity();
      let resolve!: (value: AudioClipRef) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<AudioClipRef>((yes, no) => { resolve = yes; reject = no; });
      range.finish = { requestId: p.requestId as string, endMs: end, promise }; range.reserved = bytes; range.running = true; range.state = "pending";
      range.cancel = this.slices.enqueue(owner.key, now + 30000, async signal => {
        if (signal.aborted || this.now() >= now + 30000) mockAudioFail("AUDIO_CANCELLED");
        this.window(range.consumer, range.receipt.epoch, start, end);
        await this.fixture.slice?.({ range: structuredClone(range.receipt), endMs: end }, signal);
        if (signal.aborted || this.now() >= now + 30000 || range.state !== "pending") mockAudioFail("AUDIO_CANCELLED");
        this.window(range.consumer, range.receipt.epoch, start, end); this.metadata(owner);
        const issued = this.now(); const ref: AudioClipRef = { version: 1, clipId: nextId("clip"), requestId: p.requestId as string, owner: { appId: owner.appId, accountGeneration: owner.generation }, epoch: range.receipt.epoch, requestedStartMs: start, requestedEndMs: end, effectiveStartMs: start, effectiveEndMs: end, expiresAtMs: issued + mockAudioLimits.clipTtlMs, sizeBytes: bytes, sampleRate: 16000, channels: 1, format: "f32le" };
        this.clips.set(ref.clipId, { owner, consumer: range.consumer, ref, borrowers: 0, retainedUntil: ref.expiresAtMs + 300000 });
        range.state = "finished"; range.clipId = ref.clipId; range.reserved = 0; range.expires = ref.expiresAtMs + 300000; resolve(structuredClone(ref));
      }, code => {
        if (range.state !== "finished" && range.state !== "failed") { range.state = code === "AUDIO_CANCELLED" ? "cancelled" : "failed"; range.error = code; range.expires = this.lastNow + 300000; reject(new MockHostError(code, code)); }
      }, () => { range.running = false; range.reserved = 0; delete range.cancel; });
      return promise;
    }
    if (method === RequestMethod.AudioClipsRelease) {
      const clip = this.own(this.clips.get(p.clipId as string), owner, "AUDIO_CLIP_NOT_FOUND");
      if (!clip.dead) { clip.dead = "AUDIO_CLIP_NOT_FOUND"; clip.retainedUntil = now + 300000; this.cancelJobs(clip); } return undefined;
    }
    if (method === RequestMethod.AudioClipsTranscriptionStatus) {
      const job = this.own(this.jobs.get(p.jobId as string), owner, "AUDIO_CLIP_NOT_FOUND"); this.borrow(owner, job.clip.ref.clipId); return structuredClone(job.receipt);
    }
    const clip = this.borrow(owner, p.clipId as string);
    if (method === RequestMethod.AudioClipsRead) {
      const offset = p.offset as number; if (offset > clip.ref.sizeBytes) mockAudioFail("AUDIO_RANGE_INVALID");
      const bytes = Math.min(p.maxBytes as number, clip.ref.sizeBytes - offset);
      // Virtual zero PCM: only this bounded block is materialized, never a ten-minute buffer.
      return { offset, bytes, bodyBase64: Buffer.alloc(bytes).toString("base64"), eof: offset + bytes === clip.ref.sizeBytes };
    }
    const key = JSON.stringify([owner.key, clip.ref.clipId, p.idempotencyKey]); const previous = [...this.jobs.values()].find(j => j.key === key);
    if (previous) return structuredClone(previous.receipt);
    this.metadata(owner); this.stt.assertCapacity();
    const receipt: AudioTranscriptionReceipt = { jobId: nextId("stt"), clipId: clip.ref.clipId, state: "queued" };
    const job: MockStt = { owner, clip, key, receipt, running: true, expires: Infinity }; this.jobs.set(receipt.jobId, job); clip.borrowers++;
    job.cancel = this.stt.enqueue(owner.key, now + 120000, async signal => {
      if (signal.aborted || this.now() >= now + 120000) mockAudioFail("AUDIO_CANCELLED"); this.borrow(owner, clip.ref.clipId); receipt.state = "running";
      const transcript = await (this.fixture.transcribe?.(structuredClone(clip.ref), signal) ?? "Synthetic transcription");
      if (signal.aborted || this.now() >= now + 120000) mockAudioFail("AUDIO_CANCELLED"); this.borrow(owner, clip.ref.clipId);
      if (typeof transcript !== "string") mockAudioFail("AUDIO_RANGE_INVALID");
      receipt.state = "complete"; receipt.transcript = transcript;
    }, code => { receipt.state = code === "AUDIO_CANCELLED" ? "cancelled" : "failed"; receipt.errorCode = code as PlatformContractErrorCode; delete receipt.transcript; }, () => { job.running = false; job.expires = this.lastNow + 300000; clip.borrowers--; delete job.cancel; });
    return structuredClone(receipt);
  }
  retire(owner: MockAudioOwner): void {
    const now = this.now();
    for (const range of this.ranges.values()) if (range.owner.key === owner.key && (range.state === "active" || range.state === "pending")) { range.state = "cancelled"; range.expires = now + 300000; range.cancel?.(); }
    for (const clip of this.clips.values()) if (clip.owner.key === owner.key && !clip.dead) { clip.dead = "AUDIO_CLIP_NOT_FOUND"; clip.retainedUntil = now + 300000; this.cancelJobs(clip); }
  }
}
const mockAudioHosts = new WeakMap<MockAudioClipsFixture, MockAudioClips>();

const MAX_NOTIFICATION_TITLE_CHARS = 80;
const MAX_NOTIFICATION_BODY_CHARS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function developerPlatformInvalid(message: string): never {
  throw new MockHostError(message, "DEVELOPER_PLATFORM_INVALID_REQUEST");
}

function developerPlatformRecord(params: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return developerPlatformInvalid("developer.platform 参数必须是对象");
  }
  const record = params as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return developerPlatformInvalid("developer.platform 参数包含缺失或额外字段");
  }
  return record;
}

function requireUuid(record: Record<string, unknown>, key: string): void {
  const value = record[key];
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    developerPlatformInvalid(`${key} 必须是 UUID`);
  }
}

function requireNonEmpty(record: Record<string, unknown>, key: string, max = 500): void {
  const value = record[key];
  if (
    typeof value !== "string"
    || !value.trim()
    || new TextEncoder().encode(value).byteLength > max
  ) {
    developerPlatformInvalid(`${key} 必须是 1–${max} 字节的非空字符串`);
  }
}

function validateDeveloperPlatformRequest(method: string, params: unknown): DeveloperPlatformRequest {
  switch (method) {
    case RequestMethod.DeveloperPlatformWorkflow: {
      const record = developerPlatformRecord(params, ["action", "input"]);
      const schema=(workflowSchema.requests as Record<string, unknown>)[String(record.action)];
      const matches=(value:unknown,s:any):boolean=>{
        if(!s)return false;
        if(s.anyOf)return s.anyOf.some((x:any)=>matches(value,x));
        if('const' in s)return value===s.const;
        if(s.type==='null')return value===null;
        if(s.type==='undefined')return value===undefined;
        if(s.type==='array')return Array.isArray(value)&&value.length<=1000&&value.every(v=>matches(v,s.items));
        if(s.type==='object')return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>k in s.fields)&&Object.entries(s.fields).every(([k,f]:[string,any])=>f.optional&&!(k in value)||matches((value as any)[k],f.schema));
        return typeof value===s.type;
      };
      if(typeof record.action!=='string'||!matches(record.input,schema))return developerPlatformInvalid("Invalid workflow operation");
      const input=record.input as Record<string,unknown>;
      for(const key of ['operationId','teamId','productId','managementClientId','releaseId','submissionId','requestId','idempotencyKey','expectedCurrentPublicRevisionId','userId','testerUserId','fileId','artifactId'])if(input[key]!=null)requireUuid(input,key);
      for(const key of ['page','pageSize','settlementPage'])if(input[key]!=null&&(!Number.isInteger(input[key])||Number(input[key])<1||Number(input[key])>(key==='pageSize'?50:10000)))return developerPlatformInvalid("Invalid workflow page");
      return { method, params: record as unknown as DeveloperWorkflowRequest };
    }
    case RequestMethod.DeveloperPlatformContextGet:
      return {
        method,
        params: developerPlatformRecord(params, []) as Record<string, never>,
      };
    case RequestMethod.DeveloperPlatformProjectsList:
    case RequestMethod.DeveloperPlatformProductsList: {
      const record = developerPlatformRecord(params, ["teamId"]);
      requireUuid(record, "teamId");
      return { method, params: record as { teamId: string } };
    }
    case RequestMethod.DeveloperPlatformScopesList: {
      const record = developerPlatformRecord(params, ["teamId", "projectId", "context"]);
      requireUuid(record, "teamId");
      requireUuid(record, "projectId");
      if (record["context"] !== "development") {
        developerPlatformInvalid("context 只允许 development");
      }
      return {
        method,
        params: record as { teamId: string; projectId: string; context: "development" },
      };
    }
    case RequestMethod.DeveloperPlatformProductsCreate: {
      const record = developerPlatformRecord(params, [
        "teamId",
        "projectId",
        "name",
        "purpose",
        "scopeCodes",
        "idempotencyKey",
      ]);
      requireUuid(record, "teamId");
      requireUuid(record, "projectId");
      requireNonEmpty(record, "name", 120);
      requireNonEmpty(record, "purpose", 4_000);
      requireNonEmpty(record, "idempotencyKey", 128);
      if (!/^[A-Za-z0-9._-]+$/.test(record["idempotencyKey"] as string)) {
        developerPlatformInvalid("idempotencyKey 只允许 ASCII 字母、数字、点、下划线和连字符");
      }
      if (
        !Array.isArray(record["scopeCodes"])
        || record["scopeCodes"].length > 32
        || record["scopeCodes"].some((scope) => typeof scope !== "string" || !scope.trim())
        || new Set(record["scopeCodes"]).size !== record["scopeCodes"].length
      ) {
        developerPlatformInvalid("scopeCodes 必须是无重复的非空字符串数组");
      }
      return {
        method,
        params: record as unknown as {
          teamId: string;
          projectId: string;
          name: string;
          purpose: string;
          scopeCodes: string[];
          idempotencyKey: string;
        },
      };
    }
    case RequestMethod.DeveloperPlatformClientsGet: {
      const record = developerPlatformRecord(params, ["teamId", "managementClientId"]);
      requireUuid(record, "teamId");
      requireUuid(record, "managementClientId");
      return {
        method,
        params: record as { teamId: string; managementClientId: string },
      };
    }
    case RequestMethod.DeveloperPlatformTestersList: {
      const record = developerPlatformRecord(params, ["teamId", "productId"]);
      requireUuid(record, "teamId");
      requireUuid(record, "productId");
      return { method, params: record as { teamId: string; productId: string } };
    }
    case RequestMethod.DeveloperPlatformTestersAdd: {
      const record = developerPlatformRecord(params, [
        "teamId",
        "productId",
        "userId",
        "idempotencyKey",
      ]);
      requireUuid(record, "teamId");
      requireUuid(record, "productId");
      requireUuid(record, "userId");
      requireNonEmpty(record, "idempotencyKey", 128);
      if (!/^[A-Za-z0-9._-]+$/.test(record["idempotencyKey"] as string)) {
        developerPlatformInvalid("idempotencyKey 只允许 ASCII 字母、数字、点、下划线和连字符");
      }
      return {
        method,
        params: record as {
          teamId: string;
          productId: string;
          userId: string;
          idempotencyKey: string;
        },
      };
    }
    case RequestMethod.DeveloperPlatformTestersRemove: {
      const record = developerPlatformRecord(params, ["teamId", "productId", "testerUserId"]);
      requireUuid(record, "teamId");
      requireUuid(record, "productId");
      requireUuid(record, "testerUserId");
      return {
        method,
        params: record as { teamId: string; productId: string; testerUserId: string },
      };
    }
    default:
      return developerPlatformInvalid(`未知的 developer.platform 方法：${method}`);
  }
}

function validateNotificationParams(params: unknown): { title: string; body: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new MockHostError("通知 title/body 必须是字符串，且不能包含额外字段");
  }
  const record = params as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "body" ||
    keys[1] !== "title" ||
    typeof record["title"] !== "string" ||
    typeof record["body"] !== "string"
  ) {
    throw new MockHostError("通知 title/body 必须是字符串，且不能包含额外字段");
  }
  const title = record["title"].trim();
  const body = record["body"].trim();
  if (!title || !body) throw new MockHostError("通知 title/body 不能为空");
  if ([...title].length > MAX_NOTIFICATION_TITLE_CHARS) {
    throw new MockHostError(`通知 title 最多 ${MAX_NOTIFICATION_TITLE_CHARS} 个字符`);
  }
  if ([...body].length > MAX_NOTIFICATION_BODY_CHARS) {
    throw new MockHostError(`通知 body 最多 ${MAX_NOTIFICATION_BODY_CHARS} 个字符`);
  }
  const unsafeFormat = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;
  if ([...title].some((character) => /\p{Cc}/u.test(character) || unsafeFormat.test(character))) {
    throw new MockHostError("通知 title 不能包含控制字符或不可见排版字符");
  }
  if (
    [...body].some(
      (character) =>
        unsafeFormat.test(character) ||
        (/\p{Cc}/u.test(character) && character !== "\n" && character !== "\t"),
    )
  ) {
    throw new MockHostError("通知 body 包含禁止的控制字符或不可见排版字符");
  }
  return { title, body };
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  return prefix === "/" || path === prefix ||
    (prefix.endsWith("/") ? path.startsWith(prefix) : path.startsWith(`${prefix}/`));
}

function matchesNetworkEndpoint(
  manifest: AppManifestLike,
  params: Record<string, unknown>,
): boolean {
  let url: URL;
  try { url = new URL(String(params["url"])); } catch { return false; }
  const requestedId = typeof params["endpointId"] === "string" ? params["endpointId"] : undefined;
  const method = typeof params["method"] === "string" ? params["method"].toUpperCase() : "GET";
  return (manifest.network?.endpoints ?? []).some((endpoint) =>
    (requestedId === undefined || endpoint.id === requestedId) &&
    endpoint.origins.includes(url.origin) &&
    endpoint.methods.includes(method) &&
    endpoint.pathPrefixes.some((prefix) => pathMatchesPrefix(url.pathname, prefix)),
  );
}

export class MockHost {
  readonly ownedConversationCommits: { sessionId: string; openToken: string; revision: number }[] = [];
  private readonly ownedOpenOperations = new Map<string, {
    session: string; owner: string; revision: number; expires: number; committed: boolean; hostDelivered: boolean;
  }>();
  private readonly ownedNoticeRevisions = new Map<string, number>();
  private failOwnedOpenCommit = false;
  failNextConversationOpenCommit(): void { this.failOwnedOpenCommit = true; }
  advanceOwnedConversationNotice(sessionId: string): void {
    this.ownedNoticeRevisions.set(sessionId, (this.ownedNoticeRevisions.get(sessionId) ?? 0) + 1);
  }
  private isOwnedConversationSession(session: string): boolean {
    return !!this.options.ownedConversationOpen && (this.options.ownedConversationOpen.sessionIds?.includes(session)
      || this.agentV2Sessions.has(session)
      || (session === "mock-agent-session-1" && this.agentRequests.some(r => r.method === RequestMethod.AgentSessionCreate)));
  }
  private ownedOpenSource(session: string) {
    const fixture = this.options.ownedConversationOpen;
    const fail = (code: string): never => { throw new MockHostError(code, code); };
    if (!fixture) return fail("HOST_CAPABILITY_NOT_AVAILABLE");
    if (!fixture.admitted) return fail("TASK_NOT_GRANTED");
    if (fixture.decision !== "granted") return fail(fixture.decision === "denied" ? "TASK_PERMISSION_DENIED" : "TASK_PERMISSION_REQUIRED");
    const scene = this.options.manifest.contributes?.notificationScenes?.find(s => s.key === "task.lifecycle");
    if (!scene || !["off", "in_app", "system"].includes(scene.maxLevel)
      || !fixture.userCeiling || !["off", "in_app", "system"].includes(fixture.userCeiling)) return fail("TASK_PERMISSION_REQUIRED");
    const mounts = [...this.mounts.values()].filter(m => !m.unmounted);
    if (mounts.length !== 1 || !this.runtimeSessionId || !fixture.accountGeneration
      || !/^[a-fA-F0-9]{64}$/.test(fixture.packageDigest)
      || !this.isOwnedConversationSession(session)) return fail("TASK_SOURCE_STALE");
    const mount = mounts[0]!;
    return { mount, owner: JSON.stringify([fixture.accountGeneration, this.options.manifest.appId,
      fixture.packageDigest, this.runtimeSessionId, mount.surfaceMountId, scene.maxLevel, fixture.userCeiling]),
      revision: this.ownedNoticeRevisions.get(session) ?? 0, now: fixture.now?.() ?? Date.now() };
  }
  private ownedOpenRequest(p: Record<string, unknown>): unknown {
    if (Object.keys(p).some(k => !["sessionId", "phase", "openToken"].includes(k))
      || typeof p.sessionId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(p.sessionId)) throw new MockHostError("TASK_INVALID_REQUEST", "TASK_INVALID_REQUEST");
    const source = this.ownedOpenSource(p.sessionId);
    if (p.phase === "prepare") {
      if (p.openToken !== undefined) throw new MockHostError("TASK_INVALID_REQUEST", "TASK_INVALID_REQUEST");
      for (const [token, op] of this.ownedOpenOperations) if (op.expires <= source.now || op.owner !== source.owner) this.ownedOpenOperations.delete(token);
      if (this.ownedOpenOperations.size >= 16) throw new MockHostError("TASK_LIMIT_EXCEEDED", "TASK_LIMIT_EXCEEDED");
      const openToken = nextId("mock-open");
      this.ownedOpenOperations.set(openToken, { session: p.sessionId, owner: source.owner,
        revision: source.revision, expires: source.now + 15_000, committed: false, hostDelivered: false });
      return { openToken };
    }
    if (!["commit", "cancel"].includes(String(p.phase)) || typeof p.openToken !== "string") throw new MockHostError("TASK_INVALID_REQUEST", "TASK_INVALID_REQUEST");
    const op = this.ownedOpenOperations.get(p.openToken);
    if (!op || op.session !== p.sessionId || op.owner !== source.owner || op.revision !== source.revision
      || op.expires <= source.now) throw new MockHostError("TASK_SOURCE_STALE", "TASK_SOURCE_STALE");
    if (p.phase === "cancel") { this.ownedOpenOperations.delete(p.openToken); return { acknowledged: false }; }
    if (source.mount.readyCount !== 1 || source.mount.failCount) throw new MockHostError("TASK_NAVIGATION_FAILED", "TASK_NAVIGATION_FAILED");
    if (this.failOwnedOpenCommit) { this.failOwnedOpenCommit = false; throw new MockHostError("TASK_NAVIGATION_FAILED", "TASK_NAVIGATION_FAILED"); }
    if (!op.committed) {
      op.committed = true;
      this.ownedConversationCommits.push({ sessionId: p.sessionId, openToken: p.openToken, revision: source.revision });
    }
    return { opened: true, acknowledged: true };
  }
  async deliverOwnedConversationOpen(sessionId: string): Promise<{ openToken: string }> {
    const receipt = this.ownedOpenRequest({ sessionId, phase: "prepare" }) as { openToken: string };
    const { mount } = this.ownedOpenSource(sessionId);
    this.ownedOpenOperations.get(receipt.openToken)!.hostDelivered = true;
    await this.sendIntent(mount.surfaceMountId, { source: "host.taskConversation", actionId: "open-conversation",
      deliveryId: receipt.openToken, payload: { entityId: sessionId, openToken: receipt.openToken } });
    return receipt;
  }
  private readonly options: MockHostOptions;
  private readonly networkUploads: MockNetworkUploads;
  private readonly handlers = new Set<(message: HostMessage) => void>();
  private readonly storage = new Map<string, unknown>();
  private readonly mounts = new Map<string, SurfaceObservation>();
  private readonly presentationTokens = new Map<string, string>();
  private readonly settlements = new Map<string, CommandSettlement>();

  /** App 实际注册了什么（`app.registered` 上报）。 */
  registration?: RegistrationReport;
  /** Explicit deterministic service fixtures; absent handlers fail closed. */
  serviceHandler?: (request: { serviceId: string; method: string; input: unknown }) => unknown | Promise<unknown>;
  private gatewayHandles = new Map<string, import("@reai/app-sdk/v1").GatewayHandle>();
  gatewayIssueHandler?: (scope: unknown) => import("@reai/app-sdk/v1").GatewayConnection;
  readonly serviceSettlements = new Map<string, { ok: boolean; output?: unknown; error?: WireError }>();
  /** activate 抛错时的原因。 */
  activateFailure?: WireError;
  /** App 请求打开自身 Surface 的记录。 */
  readonly surfaceOpenRequests: { surfaceId: string; intent: unknown }[] = [];
  /** App 请求投递给别的 App 的意图。 */
  readonly appsOpenRequests: { appId: string; intent: string; input: unknown }[] = [];
  /** App 查询跨插件依赖安装状态（apps.status）的记录。 */
  readonly appsStatusRequests: { appId: string }[] = [];
  /** App 请求发送的系统通知；Mock 只记录，不触发真实系统副作用。 */
  readonly notificationRequests: { title: string; body: string }[] = [];
  readonly networkRequests: Record<string, unknown>[] = [];
  /** 被拒绝的越权访问（读写未声明的 store 等）。 */
  readonly rejections: { method: string; reason: string }[] = [];
  /** Voice Input 窄口调用记录；合同测试只给 deterministic fake，不碰真实麦克风。 */
  readonly voiceInputRequests: { method: string; params: unknown }[] = [];
  readonly voiceCommandRequests: { method: string; params: unknown }[] = [];
  /** agent.dsh@1 窄口调用记录；Mock 不孵化任何真实引擎进程。 */
  readonly dshRequests: { method: string; params: unknown }[] = [];
  /** agent.session@1 通用窄口调用记录；Mock 不孵化任何真实 Agent 进程。 */
  readonly agentRequests: { method: string; params: unknown }[] = [];
  /** agent.pi-management@1 官方管理窄口调用记录。 */
  readonly piManagementRequests: { method: string; params: unknown }[] = [];
  private piManagementSnapshot: import("@reai/app-sdk/v1").PiManagementSnapshot = {
    runtime: { state: "ready", scope: "app-bundled" },
    turns: [],
    sessions: [],
    settings: { defaultModel: "text-default", appOverrides: {} },
  };
  private piManagementModels: import("@reai/app-sdk/v1").PiManagementModel[] = [
    { id: "text-default", label: "通用文本", verified: true, selectable: true },
    { id: "text-quality", label: "高质量文本", verified: false, selectable: false },
  ];
  /** agent.dsh-observe@1 官方透明度窄口调用记录。 */
  readonly dshObserverRequests: { method: string; params: unknown }[] = [];
  private dshObserverSnapshot: import("@reai/app-sdk/v1").DshObserverSnapshot = {
    schemaVersion: 1,
    revision: 1,
    runtime: {
      state: "available",
      code: "ready",
      detail: "DSH runtime ready",
      target: "aarch64-apple-darwin",
      dshVersion: "test",
      profileVersion: "test",
      workspace: "App 私有 DSH 工作区",
      components: [],
    },
    sessions: [],
  };
  private dshObserverDetails = new Map<string, import("@reai/app-sdk/v1").DshObserverSessionDetail>();
  private dshObserverHistory = new Map<string, import("@reai/app-sdk/v1").DshObserverHistoryPage>();
  private dshObserverSettings: import("@reai/app-sdk/v1").DshObserverSettings = {
    selectedModel: "text-default",
    options: [
      { id: "text-default", label: "通用文本", availability: "available", reason: null },
      { id: "text-quality", label: "高质量文本", availability: "available", reason: null },
    ],
  };
  readonly systemTaskRequests: { method: string; params: unknown }[] = [];
  /** 两条云端 AI 通道与结果写回的调用记录；Mock 不发任何真实请求。 */
  readonly cloudRequests: { method: string; params: unknown }[] = [];
  /** terminal.session@1 调用记录；Mock 不启动真实 shell。 */
  readonly terminalRequests: { method: string; params: unknown }[] = [];
  /** developer.platform@1 的已校验调用记录。 */
  readonly developerPlatformRequests: DeveloperPlatformRequest[] = [];
  private readonly terminalSessions = new Map<string, { id: string; sequence: number; cwd: string }>();
  /** C-3b：Action 层挂载清单（键 = `kind/itemId`）。 */
  readonly actionMounts = new Map<string, Record<string, unknown>>();
  private voiceListening = false;
  /** surface.nav 订阅者（harness 面包屑演示条用）。 */
  private readonly navListeners = new Set<(nav: { key: string; label: string } | null) => void>();
  /** 最近一次 surface.nav 上报；null = 回根页。 */
  lastNav: { key: string; label: string } | null = null;
  private voiceRetainAudio = false;
  private voiceHoldOverlayUntilAck = false;
  private cloudModels: import("@reai/app-sdk/v1").CloudModelOption[] = [
    { id: "text-default", kind: "text", label: "通用文本" },
    { id: "transcribe-free", kind: "transcribe", label: "语音转写" },
  ];

  setCloudModels(models: import("@reai/app-sdk/v1").CloudModelOption[]): void {
    this.cloudModels = structuredClone(models);
  }

  private voiceSessionId = "";
  /** 已把本地 command 结果交给调用方、等待它确认消费的 session。 */
  private voicePendingResultSessionId: string | undefined;
  /** 与生产 Host 一致：同一次待确认里阶段只进不退（转写中 < 转写完成 < 润色 / 翻译中 < 写入失败）。 */
  private voicePendingStageRank = 0;
  private voiceDeliveryTargetId = "";
  /** 被 Host 自己的界面消费后撤销的写回凭证：commit 返回 `expired`（与生产一致）。 */
  private readonly revokedVoiceDeliveryTargets = new Set<string>();
  /** 下一段本地识别被 Tab 层搜索消费（Host API 1.22 `consumedBy`）。 */
  private nextVoiceResultConsumedByTabLayer = false;
  /** 下一段录音被 Host 判定为没有内容（#1291 `noSpeechReason`）。 */
  private nextVoiceNoSpeechReason: "too_short" | "silence" | "suppressed" | undefined;
  /** 下一次 `ai.audio.transcribe` 的文本被 Host 置空（#1291 `suppressedReason`）。 */
  private nextAiAudioTranscribeSuppressedReason:
    | "punctuation_only"
    | "hallucination_phrase"
    | "silence"
    | undefined;
  private voiceMode: "input" | "command" = "input";
  private voiceInsertText = true;
  private nextVoiceCommandTranscriptValue = "测试语音命令";
  private voiceInputStatus: import("@reai/app-sdk/v1").VoiceInputStatus;
  /** 与生产 Host 一致，按 session 保留尚未确认的异步停止终态。 */
  private readonly voiceInputTerminalStatuses = new Map<
    string,
    import("@reai/app-sdk/v1").VoiceInputStatus
  >();
  /**
   * 持久录音列表（`voice.recordings.list` 的数据源）。默认空；场景测试用
   * `setVoiceRecordings` 注入带转写 / 句级时间戳的段，`set-summary` 会就地改这里。
   */
  private voiceRecordings: import("@reai/app-sdk/v1").VoiceRecordingSegment[] = [];
  /** Esc/中断后已保存、仍可补转写的 Voice Input 会话。 */
  private recoverableVoiceInputSessions: import("@reai/app-sdk/v1").RecoverableVoiceInputSession[] = [];
  /** 本地补转写的确定性结果；测试可以覆盖，默认不碰真实模型。 */
  private savedInputAttempts = new Map<string, { request: string; receipt: import("@reai/app-sdk/v1").SavedInputReceipt }>();
  private savedInputCancellations = new Set<string>();
  private nextVoiceInputSessionTranscriptValue = "测试重新转写";
  private dshStatusOverride: import("@reai/app-sdk/v1").DshStatus | undefined;
  private agentDshStatusOverride: import("@reai/app-sdk/v1").AgentBackendStatus | undefined;
  private agentPiStatusOverride: import("@reai/app-sdk/v1").AgentBackendStatus | undefined;
  private agentCodexStatusOverride: import("@reai/app-sdk/v1").AgentBackendStatus | undefined;
  /** 「录音缓存」现状。默认与产品默认档一致：24 小时、空缓存。 */
  private voiceReplayCache: import("@reai/app-sdk/v1").VoiceReplayCacheStatus = {
    retention: "24h",
    clipCount: 0,
    usedBytes: 0,
    retainedSinceMs: null,
  };
  private nextSystemTaskOpenError: string | undefined;
  /** 下一次 `voice.command.run` 要失败的错误串（一次性，用完即清）。 */
  private nextVoiceCommandRunError: string | undefined;
  /**
   * 让下一次 `dsh.session.send` 以该终局失败（一次性，用完即清）。
   *
   * Dsh 回合的失败是**返回值**（`failure` 字段）不是 throw——插件侧要走的正是
   * 「终局如实报错、不编造文本、不写回」那条路。默认永远成功的话，Agent 命令
   * 的失败分支在合同测试里永远执行不到。
   */
  private nextDshSendFailure: import("@reai/app-sdk/v1").DshTurnFailure | undefined;
  /** 下一次通用 Agent send 返回的终局失败。 */
  private nextAgentSendFailure: import("@reai/app-sdk/v1").AgentSendResult["failure"] | undefined;
  private nextAgentSendTextValue = "这是测试 Agent 回复";
  private agentV2Sequence = 0;
  private readonly agentV2Sessions = new Map<string, { runtime: "pi" | "dsh" | "codex"; memory: string; createdAt: number }>();
  private readonly agentV2Turns = new Map<string, import("@reai/app-sdk/v1").AgentTurnSnapshot>();
  private readonly agentV2Keys = new Map<string, { request: string; turnId: string }>();
  /**
   * 让下一次 `ai.cancel` 失败一次。
   *
   * 取消失败恰恰是插件最该允许重试的时刻，而 Mock 默认永远成功——那条路径
   * 没有开关就测不到，只能靠读源码猜，而读源码猜正是这轮被审查抓到的问题。
   */
  private failNextAiCancel = false;
  /**
   * 让下一次 `ai.audio.transcribe` 失败一次（默认 `AI_UNAVAILABLE`）。
   *
   * 云端转写失败是 Voice 引擎切换要显式处理的路径（不静默回退本地、不编造
   * 文本），默认永远成功的话，这条「失败要给清楚的行内错误、且不打断下一次
   * 重试」的行为就没有开关能测到。
   */
  private failNextAiAudioTranscribeCode: string | undefined;
  /**
   * `ai.audio.transcribe` 成功时返回的文本，默认 `"测试云端转写"`。
   *
   * 云端也可能识别出空文本（整段静音一类）——插件必须像本地路径一样安静
   * 回到 idle，不写回、不编一条空历史。默认永远非空的话，这条分支永远
   * 测不到。
   */
  private nextAiAudioTranscribeTextValue = "测试云端转写";
  /**
   * 让下一次 `voice.deliver.commit` 抛错（而不是走既有的 `committed:false`
   * 分支），稳定码可指定。用完即复位。
   *
   * 权限未授权（`VOICE_DELIVER_NOT_GRANTED` 一类）是双层能力门禁的异常路径
   * （throw），不是业务性的 `committed:false`——插件侧要把这种情况和普通写回
   * 失败区分开、给指路文案，这条分支没有注入开关就测不到。
   */
  private failNextVoiceDeliverCommitCode: string | undefined;
  /**
   * 让下一次 `voice.deliver.commit` 按业务性的 `committed:false` 返回
   * （而不是权限门禁那种 throw），reason 可指定，默认走既有的 targetId
   * 不匹配分支。`denied`/`expired` 这类正常业务失败的文案没有独立注入
   * 开关就只能靠"造一个不匹配的 targetId"间接凑出 denied 一种，测不到
   * expired，也测不到「文案真的显示出来」这件事本身。
   */
  private nextVoiceDeliverCommitReason: Exclude<CloudDeliveryResult, { committed: true }>["reason"] | undefined;
  /** 下一次 `ai.text.generate` 抛这个稳定码。用完即复位。 */
  private failNextAiTextGenerateCode: string | undefined;
  /** 非流式 `ai.text.generate` 的返回文本。 */
  private nextAiTextGenerateTextValue = "测试生成结果";
  /** 下一次非流式 `ai.text.generate` 永不返回（验调用方的超时兜底）。用完即复位。 */
  private holdNextAiTextGenerateValue = false;
  /** `voice.context.capture` 的返回事实。 */
  private voiceContextCaptureValue: Record<string, unknown> | undefined;
  /**
   * 按住流式终局不发，直到 `releaseStream()`。
   *
   * 默认的流式一个微任务里就把 delta 和 done 都发完了——插件那边「生成正在跑」
   * 这个状态短到根本抓不住，于是所有「跑到一半时……」的行为都没法验。
   */
  private holdStreamTerminal = false;
  private heldStreamTerminals: (() => void)[] = [];

  /**
   * 下一次 `ai.text.generate` 抛错，稳定码可指定。用完即复位。
   *
   * 润色是「失败必须回退原样注入」的那一步，这条注入口是那条回退路径唯一的
   * 自动化验法——没有它就只能等后端真的坏一次。
   */
  failNextAiTextGenerate(code = "AI_UNAVAILABLE"): void {
    this.failNextAiTextGenerateCode = code;
  }

  /** 之后 `ai.text.generate` 非流式成功时返回这段文本。 */
  setNextAiTextGenerateText(text: string): void {
    this.nextAiTextGenerateTextValue = text;
  }

  /** 让下一次非流式 `ai.text.generate` 永不返回，用来验调用方自己的超时兜底。 */
  holdNextAiTextGenerate(): void {
    this.holdNextAiTextGenerateValue = true;
  }

  /** 设定 `voice.context.capture` 的返回事实（权限路由分支靠它铺场景）。 */
  setVoiceContextCapture(capture: Record<string, unknown>): void {
    this.voiceContextCaptureValue = capture;
  }

  /** 下一次 `ai.cancel` 抛错。用完即复位，不影响后续场景。 */
  failNextCancel(): void {
    this.failNextAiCancel = true;
  }

  /** 下一次 `ai.audio.transcribe` 抛错，稳定码可指定。用完即复位。 */
  failNextAiAudioTranscribe(code = "AI_UNAVAILABLE"): void {
    this.failNextAiAudioTranscribeCode = code;
  }

  /** 之后 `ai.audio.transcribe` 成功时返回这段文本（可传空串测「没听清」分支）。 */
  setNextAiAudioTranscribeText(text: string): void {
    this.nextAiAudioTranscribeTextValue = text;
  }

  /** 下一次 `voice.deliver.commit` 抛错（而不是 `committed:false`），稳定码可指定。用完即复位。 */
  failNextVoiceDeliverCommit(code = "VOICE_DELIVER_NOT_GRANTED"): void {
    this.failNextVoiceDeliverCommitCode = code;
  }

  /**
   * 下一次 `voice.deliver.commit` 按业务失败返回 `{committed:false, reason}`。用完即复位。
   * Host API 1.22 起可注入 `not_editable`（事前判断确定不可输入）与 `not_received`
   * （粘贴后约 1 秒无人取剪贴板）。
   */
  setNextVoiceDeliverCommitReason(reason: Exclude<CloudDeliveryResult, { committed: true }>["reason"]): void {
    this.nextVoiceDeliverCommitReason = reason;
  }

  /**
   * 下一段本地识别（输入模式、非 `retainAudio`）被 Tab 层语音搜索消费：结果带
   * `consumedBy: "tab_layer"`、不插入，并撤销该会话写回凭证（随后的 commit 返回
   * `expired`）。与生产 Host API 1.22 一致。用完即复位。
   */
  consumeNextVoiceResultByTabLayer(): void {
    this.nextVoiceResultConsumedByTabLayer = true;
  }

  /**
   * 下一段录音被 Host 判定为没有内容（整段静音 / 太短 / 文本被抑制，#1291）：结果
   * `transcript: ""`、不带 `audio`（即便 `retainAudio`）、带 `noSpeechReason` 与
   * `warningCode: "no_speech"`，不插入、不留待确认记录（提示由 Host 自行计时）。用完即复位。
   */
  setNextVoiceNoSpeech(reason: "too_short" | "silence" | "suppressed" = "silence"): void {
    this.nextVoiceNoSpeechReason = reason;
  }

  /**
   * 下一次 `ai.audio.transcribe` 的文本被 Host 置空（#1291）：返回 `text: ""` 与
   * `suppressedReason`。用完即复位。
   */
  suppressNextAiAudioTranscribe(
    reason: "punctuation_only" | "hallucination_phrase" | "silence" = "hallucination_phrase",
  ): void {
    this.nextAiAudioTranscribeSuppressedReason = reason;
  }

  /** 之后的流式生成只发增量、按住终局，好让「跑到一半」这个状态可观察。 */
  holdStream(): void {
    this.holdStreamTerminal = true;
  }

  /** 放掉被按住的终局。 */
  async releaseStream(): Promise<void> {
    this.holdStreamTerminal = false;
    const pending = this.heldStreamTerminals.splice(0);
    for (const send of pending) send();
    await flush();
  }

  private uiLocale: import("@reai/app-sdk/v1").UiLocale;
  private localeRevision = 0;
  private runtimeSessionId = "";
  private running?: { dispose(): Promise<void> };
  private readonly audioClipsMock?: MockAudioClips;
  /** grant-gated 平台服务模拟；`continued` 记录结果「继续」实际回到的来源会话。 */
  readonly platformServices?: MockPlatformServices;

  constructor(options: MockHostOptions) {
    this.options = options;
    if (options.platformServices) {
      this.platformServices = new MockPlatformServices(options.platformServices, () => this.options.manifest,
        (code) => { throw new MockHostError(code, code); });
    }
    if (options.audioClips) {
      let mock = mockAudioHosts.get(options.audioClips);
      if (!mock) { mock = new MockAudioClips(options.audioClips); mockAudioHosts.set(options.audioClips, mock); }
      this.audioClipsMock = mock;
    }
    this.networkUploads = new MockNetworkUploads((code, message) => new MockHostError(message, code), options.networkUploadNow);
    this.uiLocale = options.locale ?? "zh";
    this.voiceInputStatus = options.voiceInputStatus ?? {
      phase: "idle",
      source: "system",
      modelId: "sensevoice-small-int8",
      sourceReady: true,
    };
    this.rememberVoiceInputTerminal(this.voiceInputStatus);
  }

  /** Change UI language for all mounted surfaces, including hidden ones. */
  setLocale(locale: import("@reai/app-sdk/v1").UiLocale): void {
    if (locale !== "zh" && locale !== "en") throw new MockHostError("Invalid UI locale");
    if (locale === this.uiLocale) return;
    this.uiLocale = locale;
    this.localeRevision++;
    this.dispatch({ type: "locale.changed", runtimeSessionId: this.runtimeSessionId,
      locale: { locale, revision: this.localeRevision } });
  }

  /** 场景测试可切换 Host 的权威 Voice 状态，不接触真实设备。 */
  setVoiceInputStatus(status: import("@reai/app-sdk/v1").VoiceInputStatus): void {
    this.voiceInputStatus = status;
    this.rememberVoiceInputTerminal(status);
  }

  private rememberVoiceInputTerminal(
    status: import("@reai/app-sdk/v1").VoiceInputStatus,
  ): void {
    if (status.phase === "idle" && status.sessionId && status.stopReason) {
      this.voiceInputTerminalStatuses.set(status.sessionId, status);
    }
  }

  /** 下一次及后续本地 command 识别的确定性文本；空串用于没有听清的合同测试。 */
  setNextVoiceCommandTranscript(transcript: string): void {
    this.nextVoiceCommandTranscriptValue = transcript;
  }

  /** 场景内切换 `dsh.status` 的返回（引擎拔掉 / 登出），优先于构造选项。 */
  setDshStatus(status: import("@reai/app-sdk/v1").DshStatus): void {
    this.dshStatusOverride = status;
  }

  /** 场景内切换通用 Agent 目录里的 Dsh backend 可用性。 */
  setAgentDshStatus(status: Omit<import("@reai/app-sdk/v1").AgentBackendStatus, "backend">): void {
    this.agentDshStatusOverride = { backend: "dsh", ...status };
  }

  /** 场景内切换通用 Agent 目录里的 Pi backend 可用性。 */
  setAgentPiStatus(status: Omit<import("@reai/app-sdk/v1").AgentBackendStatus, "backend">): void {
    this.agentPiStatusOverride = { backend: "pi", ...status };
  }

  /** 场景内切换通用 Agent 目录里的 Codex backend 可用性（默认未授权保守值）。 */
  setAgentCodexStatus(status: Omit<import("@reai/app-sdk/v1").AgentBackendStatus, "backend">): void {
    this.agentCodexStatusOverride = { backend: "codex", ...status };
  }

  /** 注入 Pi 管理页的权威只读快照；不会创建任何真实 Agent 进程。 */
  setPiManagementSnapshot(snapshot: import("@reai/app-sdk/v1").PiManagementSnapshot): void {
    this.piManagementSnapshot = structuredClone(snapshot);
  }

  /** 注入可选模型档位，供管理插件测试通用选择器，不访问真实 ai-api。 */
  setPiManagementModels(models: import("@reai/app-sdk/v1").PiManagementModel[]): void {
    this.piManagementModels = structuredClone(models);
  }

  /** 注入 DSH 透明度插件的权威只读数据；不会读取真实用户会话。 */
  setDshObserverSnapshot(snapshot: import("@reai/app-sdk/v1").DshObserverSnapshot): void {
    this.dshObserverSnapshot = structuredClone(snapshot);
  }

  setDshObserverSessionDetail(
    detail: import("@reai/app-sdk/v1").DshObserverSessionDetail,
  ): void {
    this.dshObserverDetails.set(detail.sessionId, structuredClone(detail));
  }

  setDshObserverHistoryPage(
    page: import("@reai/app-sdk/v1").DshObserverHistoryPage,
  ): void {
    this.dshObserverHistory.set(page.sessionId, structuredClone(page));
  }

  setDshObserverSettings(settings: import("@reai/app-sdk/v1").DshObserverSettings): void {
    this.dshObserverSettings = structuredClone(settings);
  }

  /** 注入持久录音段（替换整份列表），供段详情 / 总结类场景使用。 */
  setVoiceRecordings(items: import("@reai/app-sdk/v1").VoiceRecordingSegment[]): void {
    this.voiceRecordings = items.map((item) => ({ ...item }));
  }

  /** 当前 Mock 里的持久录音（含插件经 `set-summary` 写回的总结）。 */
  getVoiceRecordings(): import("@reai/app-sdk/v1").VoiceRecordingSegment[] {
    return this.voiceRecordings.map((item) => ({ ...item }));
  }

  /** 注入 Esc/中断后已保存的录音，供恢复列表与重新转写场景使用。 */
  setRecoverableVoiceInputSessions(
    items: import("@reai/app-sdk/v1").RecoverableVoiceInputSession[],
  ): void {
    this.recoverableVoiceInputSessions = items.map((item) => ({ ...item }));
  }

  /** 当前 Mock 中的 Voice Input 会话状态，便于断言重转写只更新原记录。 */
  getRecoverableVoiceInputSessions(): import("@reai/app-sdk/v1").RecoverableVoiceInputSession[] {
    return this.recoverableVoiceInputSessions.map((item) => ({ ...item }));
  }

  /** 之后本地补转写成功时返回这段文字。 */
  setNextVoiceInputSessionTranscript(text: string): void {
    this.nextVoiceInputSessionTranscriptValue = text;
  }

  rejectNextSystemTaskOpen(message: string): void {
    this.nextSystemTaskOpenError = message;
  }

  /**
   * 让下一次语音命令工作流失败。
   *
   * 有它才测得了三种命令**各自不同的失败语义**——转文本要回退原文、翻译与
   * Agent 提问必须如实报错。只靠成功路径的话，「把原文伪装成译文」这种最要命的
   * 实现照样能通过全部用例。
   */
  rejectNextVoiceCommandRun(message: string): void {
    this.nextVoiceCommandRunError = message;
  }

  /** 让下一次 `dsh.session.send` 以指定终局失败（引擎失败/超时/被取消各测各的）。 */
  rejectNextDshSend(failure: import("@reai/app-sdk/v1").DshTurnFailure): void {
    this.nextDshSendFailure = failure;
  }

  /** 让下一次 `agent.session.send` 以指定终局失败。 */
  rejectNextAgentSend(failure: NonNullable<import("@reai/app-sdk/v1").AgentSendResult["failure"]>): void {
    this.nextAgentSendFailure = failure;
  }

  setNextAgentSendText(text: string): void {
    this.nextAgentSendTextValue = text;
  }

  /** 供 SDK 使用的 Bridge 实现。 */
  readonly bridge: HostBridge = {
    request: async <T,>(
      method: string,
      params: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> => {
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const work = this.handleRequest(method, params).then((value) => value as T);
      if (!options?.signal) return await work;
      return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        options.signal?.addEventListener("abort", abort, { once: true });
        work.then(resolve, reject).finally(() => options.signal?.removeEventListener("abort", abort));
      });
    },
    notify: (method: string, params: unknown) => {
      this.handleNotify(method, params);
    },
    subscribe: (handler: (message: HostMessage) => void) => {
      this.handlers.add(handler);
      return () => this.handlers.delete(handler);
    },
  };

  /** 安装并启用：加载入口、触发 activate、等注册上报。 */
  async installAndEnable(): Promise<void> {
    const module = await this.options.loadApp();
    const definition = module.default;
    if (!definition || typeof definition !== "object") {
      throw new MockHostError("App 入口必须 export default defineApp({...})");
    }

    const { runApp } = await import("@reai/app-sdk/v1");
    this.running = runApp(definition as never, this.bridge);

    this.runtimeSessionId = nextId("runtime");
    this.dispatch({ type: "activate", runtimeSessionId: this.runtimeSessionId,
      locale: { locale: this.uiLocale, revision: this.localeRevision } });
    await flush();

    if (this.activateFailure) {
      throw new MockHostError(
        `activate 失败：${this.activateFailure.code} ${this.activateFailure.userMessage}`,
      );
    }
    if (!this.registration) {
      throw new MockHostError("activate 完成后没有上报注册项；Host 无法与 Manifest 比对");
    }
  }

  /** 订阅 surface.nav 上报（面包屑合同，审计 B2-3）。返回退订函数。 */
  onSurfaceNav(listener: (nav: { key: string; label: string } | null) => void): () => void {
    this.navListeners.add(listener);
    return () => this.navListeners.delete(listener);
  }

  /** 打开一个 Surface。返回本次 mount 的观察句柄。 */
  async openSurface(surfaceId: string, initialIntent?: unknown): Promise<SurfaceObservation> {
    const surfaceMountId = nextId("mount");
    const root = this.options.createRoot?.();
    const observation: SurfaceObservation = {
      surfaceId,
      surfaceMountId,
      root,
      readyCount: 0,
      failCount: 0,
      intents: initialIntent === undefined ? [] : [initialIntent],
      errors: [],
      navReports: [],
      unmounted: false,
    };
    this.mounts.set(surfaceMountId, observation);

    if (this.options.ownedConversationOpen) this.dispatchPresentation(surfaceMountId);

    this.dispatch({
      type: "surface.mount",
      surfaceMountId,
      surfaceId,
      root: root ?? missingDomProxy(surfaceId),
      ...(initialIntent === undefined ? {} : { initialIntent }),
    });
    await flush();
    return observation;
  }

  /** 取某个 Surface 最近一次 mount 的观察结果。 */
  surface(surfaceId: string): SurfaceObservation | undefined {
    let latest: SurfaceObservation | undefined;
    for (const observation of this.mounts.values()) {
      if (observation.surfaceId === surfaceId) latest = observation;
    }
    return latest;
  }

  /** 为存活挂载派发新的 Host 呈现绑定，不模拟物理屏幕可见性或授权。 */
  async presentSurface(surfaceMountId: string): Promise<void> {
    const observation = this.mounts.get(surfaceMountId);
    if (!observation || observation.unmounted) throw new MockHostError(`mount ${surfaceMountId} 不存活`);
    this.dispatchPresentation(surfaceMountId);
    await flush();
  }

  private dispatchPresentation(surfaceMountId: string): void {
    const presentationToken = nextId("presentation");
    this.presentationTokens.set(surfaceMountId, presentationToken);
    this.dispatch({ type: "surface.presentation", runtimeSessionId: this.runtimeSessionId,
      surfaceMountId, presentationToken });
  }

  /** 向已挂载的 Surface 投递后续意图。 */
  async sendIntent(surfaceMountId: string, intent: unknown): Promise<void> {
    const observation = this.mounts.get(surfaceMountId);
    if (!observation) throw new MockHostError(`mount ${surfaceMountId} 不存在`);
    observation.intents.push(intent);
    this.dispatch({ type: "surface.intent", surfaceMountId, intent });
    await flush();
  }

  async unmountSurface(surfaceMountId: string): Promise<void> {
    const observation = this.mounts.get(surfaceMountId);
    if (!observation) return;
    if (this.audioClipsMock && !observation.unmounted) this.audioClipsMock.retire(this.audioOwner(surfaceMountId));
    observation.unmounted = true;
    this.presentationTokens.delete(surfaceMountId);
    this.dispatch({ type: "surface.unmount", surfaceMountId });
    await flush();
  }

  /** 调用一个 Command，等它终局。 */
  async invokeCommand(commandId: string, input: unknown = {}): Promise<CommandSettlement> {
    const correlationId = nextId("call");
    const declared = this.options.manifest.contributes?.commands?.find((c) => c.id === commandId);
    this.dispatch({
      type: "command.invoke",
      correlationId,
      commandId,
      input,
      timeoutMs: declared?.timeoutMs ?? 5000,
    });
    await flush();

    const settlement = this.settlements.get(correlationId);
    if (!settlement) {
      throw new MockHostError(
        `Command ${commandId} 没有给出终局；合同要求每次调用恰好一个结果（成功或失败）`,
      );
    }
    return settlement;
  }

  async invokeService(serviceId: string, method: string, input: unknown, caller?: import("@reai/app-sdk/v1").ServiceCaller) {
    const correlationId = nextId("service");
    this.dispatch({ type: "service.invoke", correlationId, serviceId, method, input, ...(caller ? { caller } : {}) });
    const deadline = Date.now() + 3000;
    while (!this.serviceSettlements.has(correlationId) && Date.now() < deadline) await flush();
    const result = this.serviceSettlements.get(correlationId);
    if (!result) throw new MockHostError("Service did not settle");
    this.serviceSettlements.delete(correlationId); return result;
  }

  /** 取消一次在途调用。 */
  cancel(correlationId: string): void {
    this.dispatch({ type: "command.cancel", correlationId });
  }

  /** 停用：触发 deactivate 并跑完清理。 */
  async disable(): Promise<void> {
    for (const mount of this.mounts.values()) {
      if (this.audioClipsMock && !mount.unmounted) this.audioClipsMock.retire(this.audioOwner(mount.surfaceMountId));
      mount.unmounted = true;
    }
    this.presentationTokens.clear();
    this.networkUploads.dispose();
    this.dispatch({ type: "deactivate" });
    await flush();
    await this.running?.dispose();
  }

  /** 存储里当前的键（全限定 `appId/storeId/key`）。 */
  storageKeys(): string[] {
    return [...this.storage.keys()].sort();
  }

  private dispatch(message: HostMessage): void {
    for (const handler of [...this.handlers]) handler(message);
  }

  private checkUploadScope(method: string, request: Record<string, unknown>): void {
    if (!this.options.manifest.permissions?.some(permission => permission.id === "http.fetch@1")) {
      this.rejections.push({ method, reason: "Manifest 未声明 http.fetch@1" });
      throw new MockHostError("Manifest 未声明 http.fetch@1", "NETWORK_PERMISSION_REQUIRED");
    }
    if (!matchesNetworkEndpoint(this.options.manifest, request)) {
      this.rejections.push({ method, reason: "请求未命中 Manifest network endpoint" });
      throw new MockHostError("请求未命中 Manifest network endpoint", "NETWORK_ENDPOINT_NOT_DECLARED");
    }
  }

  private async mockNetworkResponse(input: Parameters<MockNetworkHandler>[0]): Promise<MockNetworkResponse> {
    const response = this.options.networkHandler ? await this.options.networkHandler(input) : this.options.networkResponse;
    return {
      status: response?.status ?? 200,
      statusText: response?.statusText ?? "OK",
      headers: structuredClone(response?.headers ?? { "content-type": "text/plain" }),
      bodyBase64: response?.bodyBase64 ?? "",
      url: response?.url ?? String(input.request["url"]),
    };
  }

  private audioOwner(mountId?: string): MockAudioOwner {
    const mounts = [...this.mounts.values()].filter(m => !m.unmounted);
    const mount = mountId ? mounts.find(m => m.surfaceMountId === mountId) : mounts.length === 1 ? mounts[0] : undefined;
    if (!this.runtimeSessionId || !mount) mockAudioFail("AUDIO_CONSUMER_STALE");
    const runtime = this.runtimeSessionId;
    const generation = this.options.audioClipsAccountGeneration ?? "mock-account";
    const appId = this.options.manifest.appId;
    return { appId, generation, key: JSON.stringify([appId, generation, runtime, mount.surfaceMountId]),
      live: () => this.runtimeSessionId === runtime && this.mounts.get(mount.surfaceMountId) === mount && !mount.unmounted
        && this.options.manifest.appId === appId && (this.options.audioClipsAccountGeneration ?? "mock-account") === generation
        && ["audio.capture@1", "audio.clips@1"].every(capability => this.options.manifest.requires?.hostCapabilities?.includes(capability)
          && this.options.manifest.permissions?.some(p => p.id === capability)) };
  }
  /** Synthetic source fault injection, not a Bridge operation or a grant. */
  setAudioClipSource(consumerId: string, source: MockAudioClipSource): void {
    if (!this.audioClipsMock) mockAudioFail("HOST_CAPABILITY_NOT_AVAILABLE");
    this.audioClipsMock.setSource(this.audioOwner(), consumerId, source);
  }
  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    if (audioClipsRequestMethod(method)) {
      if (!this.audioClipsMock) mockAudioFail("HOST_CAPABILITY_NOT_AVAILABLE");
      const owner = this.audioOwner();
      for (const capability of ["audio.capture@1", "audio.clips@1"]) {
        if (!this.options.manifest.requires?.hostCapabilities?.includes(capability)) mockAudioFail("AUDIO_NOT_GRANTED");
        if (!this.options.manifest.permissions?.some(p => p.id === capability)) mockAudioFail("AUDIO_PERMISSION_REQUIRED");
      }
      return this.audioClipsMock.request(owner, method, params);
    }
    if (MockPlatformServices.handles(method) && method !== RequestMethod.TasksConversationOpened) {
      if (!this.platformServices) throw new MockHostError("HOST_CAPABILITY_NOT_AVAILABLE", "HOST_CAPABILITY_NOT_AVAILABLE");
      return this.platformServices.request(method, params);
    }
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case RequestMethod.LocaleGet:
        return { runtimeSessionId: this.runtimeSessionId, locale: this.uiLocale, revision: this.localeRevision };
      case RequestMethod.EnvironmentGet:
        return { developerMode: false, ...(this.options.ownedConversationOpen ? { ownedConversationOpen: {
          version: 1, available: true, runtimeSessionId: this.runtimeSessionId,
          surfaceMountId: [...this.mounts.values()].filter(m => !m.unmounted).length === 1 ? [...this.mounts.values()].find(m => !m.unmounted)?.surfaceMountId : undefined,
          presentationToken: this.presentationTokens.get([...this.mounts.values()].find(m => !m.unmounted)?.surfaceMountId ?? ""),
        }, ...(this.options.manifest.requires?.hostCapabilities?.includes("tasks.present@1") ? { taskPresentation: {
          runtimeSessionId: this.runtimeSessionId,
          surfaceMountId: [...this.mounts.values()].find(m => !m.unmounted)?.surfaceMountId,
          platformCapabilities: { version: 1, capabilities: { "tasks.present@1": {
            version: 1, available: true, methods: [RequestMethod.TasksConversationOpened],
          } } },
        } } : {}) } : {}), ...(this.audioClipsMock ? { audioClips: {
          runtimeSessionId: this.runtimeSessionId, surfaceMountId: [...this.mounts.values()].find(m => !m.unmounted)?.surfaceMountId,
          platformCapabilities: { version: 1, capabilities: { "audio.clips@1": { version: 1, available: true, methods: [RequestMethod.AudioRangesStart, RequestMethod.AudioRangesFinish, RequestMethod.AudioRangesCancel, RequestMethod.AudioClipsRead, RequestMethod.AudioClipsRelease, RequestMethod.AudioClipsTranscribe, RequestMethod.AudioClipsTranscriptionStatus] } } },
        } } : {}), ...(this.platformServices?.descriptors({ runtimeSessionId: this.runtimeSessionId,
          surfaceMountId: [...this.mounts.values()].find(m => !m.unmounted)?.surfaceMountId }) ?? {}) };
      case RequestMethod.ClipboardWriteText:
        return { written: true };
      case RequestMethod.TasksConversationOpened:
        if (!this.options.ownedConversationOpen) throw new MockHostError("HOST_CAPABILITY_NOT_AVAILABLE", "HOST_CAPABILITY_NOT_AVAILABLE");
        if (!this.options.manifest.requires?.hostCapabilities?.includes("tasks.present@1")) throw new MockHostError("TASK_NOT_GRANTED", "TASK_NOT_GRANTED");
        if (Object.keys(p).some(k => !["requestId", "entityId", "openToken"].includes(k))
          || typeof p.requestId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(p.requestId)
          || typeof p.entityId !== "string") throw new MockHostError("TASK_INVALID_REQUEST", "TASK_INVALID_REQUEST");
        if (typeof p.openToken !== "string" || !this.ownedOpenOperations.get(p.openToken)?.hostDelivered) throw new MockHostError("TASK_SOURCE_STALE", "TASK_SOURCE_STALE");
        return this.ownedOpenRequest({ sessionId: p.entityId, phase: "commit", openToken: p.openToken });
      case RequestMethod.ServicesCall:
        if (!this.options.manifest.requires?.services?.some(s => s.id === p.serviceId) || !this.serviceHandler)
          throw new MockHostError("SERVICE_PROVIDER_UNAVAILABLE");
        return this.serviceHandler({ serviceId: String(p.serviceId), method: String(p.method), input: p.input });
      case RequestMethod.GatewayList: return structuredClone([...this.gatewayHandles.values()]);
      case RequestMethod.GatewayIssue: {
        if (!this.options.manifest.requires?.hostCapabilities?.includes("apps.gateway@1") || !this.options.manifest.permissions?.some(x => x.id === "apps.gateway@1") || !this.gatewayIssueHandler)
          throw new MockHostError("GATEWAY_DENIED");
        const service = this.options.manifest.contributes?.services?.find(s => s.id === p.serviceId);
        if (!service || !Array.isArray(p.methods) || !p.methods.length || !p.methods.every(m => service.methods.some(x => x.id === m))) throw new MockHostError("GATEWAY_DENIED");
        const connection = this.gatewayIssueHandler(p);
        this.gatewayHandles.set(connection.id, { id: connection.id, serviceId: String(p.serviceId), principal: structuredClone(p.principal as Record<string, unknown>) });
        return connection;
      }
      case RequestMethod.GatewayRevoke: this.gatewayHandles.delete(String(p.id)); return undefined;
      case RequestMethod.StorageGet:
        return this.storage.has(this.storageKey(p))
          ? { found: true, value: this.storage.get(this.storageKey(p)) }
          : { found: false };
      case RequestMethod.StorageSet:
        this.storage.set(this.storageKey(p), p["value"]);
        return undefined;
      case RequestMethod.StorageCompareAndSet: {
        const key = this.storageKey(p);
        const expected = p["expected"] as { found: boolean; value?: unknown };
        const exchanged = this.storage.has(key) === expected.found &&
          (!expected.found || equalJson(this.storage.get(key), expected.value));
        if (exchanged) this.storage.set(key, structuredClone(p["value"]));
        return { exchanged };
      }
      case RequestMethod.StorageDelete:
        this.storage.delete(this.storageKey(p));
        return undefined;
      case RequestMethod.StorageKeys: {
        const prefix = `${this.options.manifest.appId}/${this.requireStore(p)}/`;
        return [...this.storage.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length));
      }
      case RequestMethod.SurfaceOpen:
        this.surfaceOpenRequests.push({
          surfaceId: String(p["surfaceId"]),
          intent: p["intent"],
        });
        return undefined;
      case RequestMethod.AppsOpen:
        this.appsOpenRequests.push({
          appId: String(p["appId"]),
          intent: String(p["intent"]),
          input: p["input"],
        });
        return undefined;
      case RequestMethod.AppsStatus: {
        const appId = String(p["appId"] ?? "");
        this.appsStatusRequests.push({ appId });
        const status = this.options.appsStatus ?? { installed: true, enabled: true };
        return { appId, installed: status.installed, enabled: status.enabled };
      }
      case RequestMethod.AccountStatus:
        return this.options.accountStatus ?? { enabled: true, loggedIn: true };
      case RequestMethod.DeveloperPlatformContextGet: {
        this.requireDeveloperPlatformCapability(method);
        const request = validateDeveloperPlatformRequest(method, params);
        this.developerPlatformRequests.push(request);
        if (this.options.developerPlatformHandler) {
          return await this.options.developerPlatformHandler(request);
        }
        return {
          account: this.options.accountStatus ?? { enabled: true, loggedIn: true },
          backend: {
            available: false,
            errorCode: "BACKEND_CAPABILITY_UNAVAILABLE",
          },
        };
      }
      case RequestMethod.DeveloperPlatformWorkflow:
      case RequestMethod.DeveloperPlatformProjectsList:
      case RequestMethod.DeveloperPlatformScopesList:
      case RequestMethod.DeveloperPlatformProductsList:
      case RequestMethod.DeveloperPlatformProductsCreate:
      case RequestMethod.DeveloperPlatformClientsGet:
      case RequestMethod.DeveloperPlatformTestersList:
      case RequestMethod.DeveloperPlatformTestersAdd:
      case RequestMethod.DeveloperPlatformTestersRemove: {
        this.requireDeveloperPlatformCapability(method);
        const request = validateDeveloperPlatformRequest(method, params);
        this.developerPlatformRequests.push(request);
        if (!this.options.developerPlatformHandler) {
          throw new MockHostError(
            "开放平台管理后端能力尚不可用",
            "BACKEND_CAPABILITY_UNAVAILABLE",
          );
        }
        return await this.options.developerPlatformHandler(request);
      }
      case RequestMethod.TerminalSessionCreate: {
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        const id = nextId("terminal");
        const session = { id, sequence: this.terminalSessions.size + 1, cwd: "/mock/home" };
        this.terminalSessions.set(id, session);
        return session;
      }
      case RequestMethod.TerminalSessionList:
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        return [...this.terminalSessions.values()];
      case RequestMethod.TerminalSessionAttach: {
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        const sessionId = String(p["sessionId"] ?? "");
        if (!this.terminalSessions.has(sessionId)) throw new MockHostError("TERMINAL_SESSION_NOT_FOUND");
        return { token: nextId("attachment"), replayBase64: "", truncated: false, sequence: 0 };
      }
      case RequestMethod.TerminalSessionDetach:
      case RequestMethod.TerminalSessionWrite:
      case RequestMethod.TerminalSessionResize:
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        return undefined;
      case RequestMethod.TerminalSessionRestart: {
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        const sessionId = String(p["sessionId"] ?? "");
        const session = this.terminalSessions.get(sessionId);
        if (!session) throw new MockHostError("TERMINAL_SESSION_NOT_FOUND");
        return session;
      }
      case RequestMethod.TerminalSessionClose:
        this.requireTerminalCapability(method);
        this.terminalRequests.push({ method, params });
        this.terminalSessions.delete(String(p["sessionId"] ?? ""));
        return undefined;
      case RequestMethod.NotificationsPost: {
        const declared = this.options.manifest.permissions?.some(
          (permission) => permission.id === "os.notification.post@1",
        );
        if (!declared) {
          this.rejections.push({
            method: RequestMethod.NotificationsPost,
            reason: "Manifest 未声明 os.notification.post@1",
          });
          throw new MockHostError("Manifest 未声明 os.notification.post@1");
        }
        const { title, body } = validateNotificationParams(params);
        this.notificationRequests.push({ title, body });
        return { queued: true };
      }
      case RequestMethod.HttpFetch: {
        const declared = this.options.manifest.permissions?.some(
          (permission) => permission.id === "http.fetch@1",
        );
        if (!declared) {
          this.rejections.push({ method, reason: "Manifest 未声明 http.fetch@1" });
          throw new MockHostError("Manifest 未声明 http.fetch@1");
        }
        if (!matchesNetworkEndpoint(this.options.manifest, p)) {
          this.rejections.push({ method, reason: "请求未命中 Manifest network endpoint" });
          throw new MockHostError("请求未命中 Manifest network endpoint");
        }
        this.networkRequests.push({ ...p });
        const body = this.options.networkHandler && typeof p["bodyBase64"] === "string"
          ? new Blob([Buffer.from(p["bodyBase64"], "base64")]) : new Blob();
        return this.mockNetworkResponse({ request: structuredClone(p), body, signal: new AbortController().signal });
      }
      case RequestMethod.HttpUploadStart: {
        const opened = this.networkUploads.start(params, request => this.checkUploadScope(method, request));
        this.networkRequests.push({ ...opened.request, bodyBytes: opened.bodyBytes, uploadId: opened.uploadId });
        return { uploadId: opened.uploadId };
      }
      case RequestMethod.HttpUploadChunk:
        return this.networkUploads.chunk(params, request => this.checkUploadScope(method, request));
      case RequestMethod.HttpUploadFinish:
        return this.networkUploads.finish(params, request => this.checkUploadScope(method, request), input => this.mockNetworkResponse(input));
      case RequestMethod.HttpCancel:
        return this.networkUploads.cancel(params);
      case RequestMethod.VoicePreparing:
        this.voiceInputRequests.push({ method, params });
        return undefined;
      case RequestMethod.VoiceStatus:
        this.voiceInputRequests.push({ method, params });
        if (
          p["sessionId"] !== undefined
          && (typeof p["sessionId"] !== "string" || p["sessionId"].length === 0)
        ) {
          throw new MockHostError("sessionId 必须是非空字符串");
        }
        if (typeof p["sessionId"] === "string") {
          const terminal = this.voiceInputTerminalStatuses.get(p["sessionId"]);
          if (terminal) return terminal;
        }
        const { sessionId: _sessionId, stopReason: _stopReason, ...status } = this.voiceInputStatus;
        return this.voiceListening
          ? {
              ...status,
              phase: "listening",
              mode: this.voiceMode,
              sessionId: this.voiceSessionId,
            }
          : status;
      case RequestMethod.VoiceConfigure:
        this.voiceInputRequests.push({ method, params });
        if (this.voiceListening) {
          throw new MockHostError("录音进行中不能切换 Voice 设置");
        }
        return undefined;
      case RequestMethod.VoiceToggle: {
        this.voiceInputRequests.push({ method, params });
        const mode = p["mode"] === "command" ? "command" : "input";
        if (!this.voiceListening) {
          // 与生产 Host 的 next_overlay_token 一致：新会话推进代次后，上一轮尚未
          // 确认的结果已经失效，迟到确认不能再返回 true。
          this.voicePendingResultSessionId = undefined;
          this.voiceListening = true;
          this.voiceMode = mode;
          this.voiceInsertText = p["insertText"] !== false;
          this.voiceRetainAudio = p["retainAudio"] === true;
          this.voiceHoldOverlayUntilAck = p["holdOverlayUntilAck"] === true;
          this.voiceSessionId = nextId("voice-session");
          this.voiceDeliveryTargetId = nextId("delivery-target");
          return {
            phase: "listening",
            mode,
            sessionId: this.voiceSessionId,
            deliveryTarget: {
              id: this.voiceDeliveryTargetId,
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          };
        }
        this.voiceListening = false;
        const completedMode = this.voiceMode;
        const noSpeechReason = this.nextVoiceNoSpeechReason;
        this.nextVoiceNoSpeechReason = undefined;
        // 与生产 Host 一致：判定没有内容时不入音频槽，云端路径也拿不到 audio。
        const retained = this.voiceRetainAudio && noSpeechReason === undefined;
        // 与生产 Host 同口径：command 会话识别结束都留待确认记录，本地识别与云端识别
        // （retainAudio）一样，按原 sessionId 确认即收起中央胶囊。
        const consumedByTabLayer = !retained && completedMode === "input"
          && this.nextVoiceResultConsumedByTabLayer && noSpeechReason === undefined;
        this.nextVoiceResultConsumedByTabLayer = false;
        if (consumedByTabLayer) this.revokedVoiceDeliveryTargets.add(this.voiceDeliveryTargetId);
        const inserted = !retained && completedMode === "input" && this.voiceInsertText
          && !consumedByTabLayer && noSpeechReason === undefined;
        // Host API 1.22（2026-09-28 并入）：声明 holdOverlayUntilAck 的输入会话还要等调用方写回，同样留待确认
        // 记录；Tab 层已消费或 Host 已直写时没有写回可等，不留。
        const inputAwaitsWrite = completedMode === "input" && this.voiceHoldOverlayUntilAck
          && !consumedByTabLayer && !inserted;
        // Host 判定没有内容：提示归 Host 计时，不留待确认记录。
        this.voicePendingResultSessionId = noSpeechReason === undefined
          && (completedMode === "command" || inputAwaitsWrite)
          ? this.voiceSessionId
          : undefined;
        this.voicePendingStageRank = 0;
        this.voiceHoldOverlayUntilAck = false;
        this.voiceInsertText = true;
        this.voiceRetainAudio = false;
        // Host API 1.22：输入法与语音命令（翻译 / Agent）都落回听片段。
        const replayClip = {
          id: `mock-replay-${this.voiceSessionId}`,
          wallStartMs: 1_700_000_000_000,
          durationMs: 800,
        };
        this.voiceReplayCache = {
          ...this.voiceReplayCache,
          clipCount: this.voiceReplayCache.clipCount + 1,
          usedBytes: this.voiceReplayCache.usedBytes + replayClip.durationMs * 32,
          retainedSinceMs: Math.min(
            this.voiceReplayCache.retainedSinceMs ?? replayClip.wallStartMs,
            replayClip.wallStartMs,
          ),
        };
        // 留音频给云端转写时不跑本地识别，所以 transcript 是 null 而不是空串——
        // 空串会让上层以为「识别过但没听清」。
        return {
          phase: "idle",
          sessionId: this.voiceSessionId,
          transcript: noSpeechReason !== undefined
            ? ""
            : retained
              ? null
              : completedMode === "command"
                ? this.nextVoiceCommandTranscriptValue
                : "测试语音输入",
          ...(retained
            ? {
                audio: {
                  id: this.voiceSessionId,
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  durationMs: 800,
                  format: "wav",
                },
              }
            : {}),
          // 每次录音都会顺手落一段回听片段（输入法与语音命令都落），返回体带上
          // 引用——MockHost 是 Host 合同的可执行文档，少了这个字段，插件侧那条
          // 「落盘后追一次权威缓存状态」的链路在任何测试里都执行不到。
          replayClip,
          replayClipStatus: "saved",
          language: "zh-CN",
          inserted,
          source: "system",
          durationMs: 800,
          mode: completedMode,
          ...(!retained ? { outcome: "recognized" } : {}),
          ...(consumedByTabLayer ? { consumedBy: "tab_layer" } : {}),
          ...(noSpeechReason !== undefined
            ? { noSpeechReason, warningCode: "no_speech" }
            : {}),
        };
      }
      case RequestMethod.VoiceReportStage: {
        this.voiceInputRequests.push({ method, params });
        if (typeof p["sessionId"] !== "string" || p["sessionId"].length === 0) {
          throw new MockHostError("sessionId 必须是非空字符串");
        }
        if (typeof p["stage"] !== "string") throw new MockHostError("stage 必须是字符串");
        const rank = ({ transcribing: 0, transcribed: 1, polishing: 2, translating: 2, insert_failed: 3 } as Record<string, number>)[p["stage"]];
        // 插件对单个上报只等有限时长，Host 受理顺序可能与发出顺序相反：迟到的旧阶段不受理。
        const accepted = rank !== undefined && p["sessionId"] === this.voicePendingResultSessionId
          && rank >= this.voicePendingStageRank;
        if (accepted) this.voicePendingStageRank = rank;
        // 与生产 Host 一致：写入失败把胶囊切到失败句后结算待确认记录，迟到确认返回 false。
        if (accepted && p["stage"] === "insert_failed") this.voicePendingResultSessionId = undefined;
        return { accepted };
      }
      case RequestMethod.VoiceAcknowledgeResult: {
        this.voiceInputRequests.push({ method, params });
        if (typeof p["sessionId"] !== "string" || p["sessionId"].length === 0) {
          throw new MockHostError("sessionId 必须是非空字符串");
        }
        const sessionId = p["sessionId"];
        const pendingAcknowledged = sessionId === this.voicePendingResultSessionId;
        const terminalSessionId = this.voiceInputTerminalStatuses.has(sessionId)
          ? sessionId
          : undefined;
        const acknowledged = pendingAcknowledged || terminalSessionId !== undefined;
        if (pendingAcknowledged) this.voicePendingResultSessionId = undefined;
        if (terminalSessionId) this.voiceInputTerminalStatuses.delete(terminalSessionId);
        if (
          acknowledged
          && sessionId === this.voiceInputStatus.sessionId
          && this.voiceInputStatus.stopReason !== undefined
        ) {
          const { sessionId: _sessionId, stopReason: _stopReason, ...status } = this.voiceInputStatus;
          this.voiceInputStatus = status;
        }
        return { acknowledged };
      }
      case RequestMethod.VoiceCancel:
        this.voiceInputRequests.push({ method, params });
        if (
          Object.prototype.hasOwnProperty.call(p, "sessionId")
          && (typeof p["sessionId"] !== "string" || p["sessionId"].length === 0)
        ) {
          throw new MockHostError("sessionId 必须是非空字符串");
        }
        if (typeof p["sessionId"] === "string") {
          this.voiceInputTerminalStatuses.delete(p["sessionId"]);
          if (p["sessionId"] === this.voicePendingResultSessionId) {
            this.voicePendingResultSessionId = undefined;
          }
          if (p["sessionId"] === this.voiceSessionId) {
            this.voiceListening = false;
            this.voiceInsertText = true;
          }
        } else {
          // 与 Host 同口径：不带 sessionId 的插件级取消在没有进行中的录音时，按 owner 丢弃
          // 这个插件的待确认胶囊与保留回执（Host `cancel_for_app` 的 discard_voice_results_for_owner）。
          if (!this.voiceListening) {
            this.voicePendingResultSessionId = undefined;
            this.voiceInputTerminalStatuses.clear();
          }
          this.voiceListening = false;
          this.voiceInsertText = true;
        }
        return undefined;
      case RequestMethod.VoiceModelsList:
        this.voiceInputRequests.push({ method, params });
        return {
          models: [
            {
              id: "sensevoice-small-int8",
              name: "SenseVoice Small",
              description: "测试模型",
              sizeBytes: 1,
              state: "active",
              active: true,
            },
          ],
        };
      case RequestMethod.VoiceModelDownload:
        this.voiceInputRequests.push({ method, params });
        return {
          id: String(p["modelId"]),
          name: "SenseVoice Small",
          description: "测试模型",
          sizeBytes: 1,
          state: "ready",
          active: false,
        };
      case RequestMethod.VoiceModelCancelDownload:
      case RequestMethod.VoiceModelDelete:
        this.voiceInputRequests.push({ method, params });
        return undefined;
      case RequestMethod.VoicePermissionsCheck:
        this.voiceInputRequests.push({ method, params });
        return { microphone: "granted", accessibility: "granted", microphoneRequired: false };
      case RequestMethod.VoicePermissionRequest:
        this.voiceInputRequests.push({ method, params });
        return { state: "granted" };
      case RequestMethod.VoiceTimelineStatus:
        this.voiceInputRequests.push({ method, params });
        return (
          this.voiceInputStatus.timeline ?? {
            state: "running",
            route: "usb_vendor_hid",
            hotRingDurationMs: 10_000,
            cacheDurationMs: 60_000,
            cacheHealth: "healthy",
            continuousRecordingEnabled: false,
            recordingState: "disabled",
            sttBacklog: 0,
            hostLocalDropFrames: 0,
          }
        );
      case RequestMethod.VoiceTimelineSetPaused:
        this.voiceInputRequests.push({ method, params });
        return {
          ...(this.voiceInputStatus.timeline ?? {
            route: "usb_vendor_hid",
            hotRingDurationMs: 0,
            cacheDurationMs: 0,
            cacheHealth: "healthy",
            continuousRecordingEnabled: false,
            recordingState: "disabled",
            sttBacklog: 0,
            hostLocalDropFrames: 0,
          }),
          state: p["paused"] === true ? "paused_by_user" : "running",
        };
      case RequestMethod.VoiceTimelineClear:
        this.voiceInputRequests.push({ method, params });
        return {
          ...(this.voiceInputStatus.timeline ?? {
            state: "running",
            route: "usb_vendor_hid",
            cacheHealth: "healthy",
            continuousRecordingEnabled: false,
            recordingState: "disabled",
            sttBacklog: 0,
            hostLocalDropFrames: 0,
          }),
          hotRingDurationMs: 0,
          cacheDurationMs: 0,
        };
      case RequestMethod.VoiceTimelineSetRecording:
        this.voiceInputRequests.push({ method, params });
        return {
          ...(this.voiceInputStatus.timeline ?? {
            state: "running",
            route: "usb_vendor_hid",
            hotRingDurationMs: 10_000,
            cacheDurationMs: 60_000,
            cacheHealth: "healthy",
            recordingState: "disabled",
            sttBacklog: 0,
            hostLocalDropFrames: 0,
          }),
          continuousRecordingEnabled: p["enabled"] === true,
          recordingState: p["enabled"] === true ? "running" : "disabled",
        };
      case RequestMethod.VoiceSystemInputsList:
        this.voiceInputRequests.push({ method, params });
        return {
          endpoints: [{ id: "mock-input-uid", name: "Mock microphone", isDefault: true }],
        };
      case RequestMethod.VoiceRecordingsList: {
        this.voiceInputRequests.push({ method, params });
        const page = Number(p["page"] ?? 0);
        const perPage = Number(p["perPage"] ?? 20);
        const sorted = [...this.voiceRecordings].sort((a, b) => b.wallStartMs - a.wallStartMs);
        return {
          items: sorted.slice(page * perPage, (page + 1) * perPage).map((item) => ({ ...item })),
          total: sorted.length,
          page,
          perPage,
        };
      }
      case RequestMethod.VoiceRecordingSetSummary: {
        this.voiceInputRequests.push({ method, params });
        if (typeof p["recordingId"] !== "string" || !p["recordingId"]) {
          throw new Error("INVALID_PARAMS: 缺少 recordingId");
        }
        const rawPoints = p["points"];
        if (!Array.isArray(rawPoints) || rawPoints.some((point) => typeof point !== "string")) {
          throw new Error("INVALID_PARAMS: points 必须是字符串数组");
        }
        // 与真实 Host 同一口径：去空白、丢空条后至少一条、最多 8 条。
        const points = (rawPoints as string[]).map((point) => point.trim()).filter(Boolean);
        if (points.length === 0 || points.length > 8) {
          throw new Error("INVALID_PARAMS: points 过滤空白后须为 1–8 条");
        }
        const target = this.voiceRecordings.find((item) => item.id === p["recordingId"]);
        // 段不在了不是错误：真实 Host 返回 segment: null，插件据此静默收尾。
        if (!target) return { segment: null };
        if (
          Object.hasOwn(p, "basedOnTranscribedAtMs")
          && (target.transcribedAtMs ?? null) !== p["basedOnTranscribedAtMs"]
        ) {
          return { segment: null };
        }
        target.summary = {
          points,
          generatedAtMs: typeof p["generatedAtMs"] === "number" ? p["generatedAtMs"] : Date.now(),
          dshSessionId: typeof p["dshSessionId"] === "string" && p["dshSessionId"]
            ? p["dshSessionId"]
            : null,
        };
        return { segment: { ...target } };
      }
      case RequestMethod.VoiceRecordingPlaybackAuthorize:
        this.voiceInputRequests.push({ method, params });
        return { pickupToken: `mock-recording:${String(p["recordingId"])}`, mimeType: "audio/wav", sizeBytes: 44 };
      case RequestMethod.VoiceRecordingDelete:
        this.voiceInputRequests.push({ method, params });
        {
          const index = this.voiceRecordings.findIndex((item) => item.id === p["recordingId"]);
          if (index < 0) return { deleted: false };
          this.voiceRecordings.splice(index, 1);
          return { deleted: true };
        }
      case RequestMethod.VoiceRecordingRetranscribeSegment:
        this.voiceInputRequests.push({ method, params });
        {
          // 与真实 Host 同一口径：段不存在是错误而不是 requeued: 0；命中则清掉
          // 旧转写、把段标记回「待转写」，测试据此断言 UI 的等待态与刷新。
          const target = this.voiceRecordings.find((item) => item.id === p["recordingId"]);
          if (!target) throw new MockHostError("VOICE_RECORDING_NOT_FOUND");
          target.transcriptText = null;
          target.transcribedAtMs = null;
          target.sentences = null;
          return { requeued: 1 };
        }
      case RequestMethod.VoiceRecoverableInputSessionsList: {
        this.voiceInputRequests.push({ method, params });
        const page = Number(p["page"] ?? 0);
        const perPage = Number(p["perPage"] ?? 50);
        // 与真实 Host 同一口径：语音命令的录音按 id 可取，但不进可恢复列表。
        const recoverable = this.recoverableVoiceInputSessions.filter((item) =>
          item.mode === "input" && (
            item.transcriptionStatus === "not_requested" || item.transcriptionStatus === "failed" || (p["includeSettledRetries"] === true && !!item.attempt)
          )
        );
        return {
          items: recoverable
            .slice(page * perPage, (page + 1) * perPage)
            .map((item) => ({ ...item })),
          total: recoverable.length,
          page,
          perPage,
        };
      }
      case RequestMethod.VoiceInputSessionGet: {
        this.voiceInputRequests.push({ method, params });
        const session = this.recoverableVoiceInputSessions.find(item => item.recordingId === p["recordingId"]);
        return session ? structuredClone({ revision: 0, ...session }) : null;
      }
      case RequestMethod.VoiceSavedInputCancel: {
        this.voiceInputRequests.push({ method, params });
        const key = `${p["recordingId"]}:${p["attemptId"]}`;
        this.savedInputCancellations.add(key);
        const entry = this.savedInputAttempts.get(key);
        const session = this.recoverableVoiceInputSessions.find(item => item.recordingId === p["recordingId"]);
        if (session && entry?.receipt.state === "pending") {
          entry.receipt = { ...entry.receipt, state: "cancelled", errorCode: "VOICE_CANCELLED", revision: entry.receipt.revision + 1, finishedAtMs: Date.now() };
          session.revision = entry.receipt.revision; session.attempt = entry.receipt; session.transcriptionStatus = "failed";
        }
        return { receipt: entry?.receipt ?? null, upstreamStopped: false };
      }
      case RequestMethod.VoiceSavedInputTranscribe: {
        this.voiceInputRequests.push({ method, params });
        const request = p as unknown as import("@reai/app-sdk/v1").SavedInputRequest;
        if (request.selection.engine === "cloud") this.requireCloudCapability(method, "cloud.model.invoke@1");
        const session = this.recoverableVoiceInputSessions.find(item => item.recordingId === request.recordingId);
        if (!session) throw new MockHostError("VOICE_SAVED_INPUT_NOT_FOUND", "VOICE_SAVED_INPUT_NOT_FOUND");
        const key = `${request.recordingId}:${request.attemptId}`;
        const previous = this.savedInputAttempts.get(key);
        if (previous) {
          if (previous.request !== JSON.stringify(request)) throw new MockHostError("VOICE_SAVED_INPUT_CONFLICT", "VOICE_SAVED_INPUT_CONFLICT");
          return structuredClone(previous.receipt);
        }
        if (this.savedInputCancellations.has(key)) throw new MockHostError("VOICE_CANCELLED", "VOICE_CANCELLED");
        if (request.expectedRevision !== (session.revision ?? 0) || !["failed", "not_requested"].includes(session.transcriptionStatus)) {
          throw new MockHostError("VOICE_SAVED_INPUT_CONFLICT", "VOICE_SAVED_INPUT_CONFLICT");
        }
        const errorCode = request.selection.engine === "cloud" ? this.failNextAiAudioTranscribeCode : undefined;
        if (request.selection.engine === "cloud") this.failNextAiAudioTranscribeCode = undefined;
        const transcript = request.selection.engine === "cloud" ? this.nextAiAudioTranscribeTextValue : this.nextVoiceInputSessionTranscriptValue;
        const receipt: import("@reai/app-sdk/v1").SavedInputReceipt = {
          recordingId: request.recordingId, attemptId: request.attemptId, revision: request.expectedRevision + 2,
          selection: structuredClone(request.selection), state: errorCode ? "failed" : transcript.trim() ? "complete" : "no_speech",
          startedAtMs: Date.now(), finishedAtMs: Date.now(), ...(errorCode ? { errorCode } : { transcript: transcript.trim() }),
        };
        this.savedInputAttempts.set(key, { request: JSON.stringify(request), receipt });
        session.revision = receipt.revision; session.attempt = receipt;
        session.transcriptionStatus = receipt.state === "complete" ? "complete" : "failed";
        if (receipt.state === "complete") session.transcript = receipt.transcript ?? null;
        return structuredClone(receipt);
      }
      case RequestMethod.VoiceInputSessionTranscribe: {
        this.voiceInputRequests.push({ method, params });
        const recordingId = typeof p["recordingId"] === "string" ? p["recordingId"] : "";
        const session = this.recoverableVoiceInputSessions.find((item) =>
          item.recordingId === recordingId
        );
        if (!session) throw new MockHostError("VOICE_RECORDING_NOT_FOUND: 录音不存在");
        if (session.attempt || session.transcriptionStatus === "pending") {
          throw new MockHostError("VOICE_BUSY: 这段录音正在转写");
        }
        session.transcriptionStatus = "complete";
        session.transcript = this.nextVoiceInputSessionTranscriptValue;
        return { transcript: this.nextVoiceInputSessionTranscriptValue };
      }
      case RequestMethod.VoiceInputSessionSetTranscription: {
        this.voiceInputRequests.push({ method, params });
        const recordingId = typeof p["recordingId"] === "string" ? p["recordingId"] : "";
        const status = p["status"];
        const session = this.recoverableVoiceInputSessions.find((item) =>
          item.recordingId === recordingId
        );
        if (!session) throw new MockHostError("VOICE_RECORDING_NOT_FOUND: 录音不存在");
        if (session.attempt) throw new MockHostError("VOICE_SAVED_INPUT_CONFLICT", "VOICE_SAVED_INPUT_CONFLICT");
        if (status !== "complete" && status !== "failed") {
          throw new MockHostError("INVALID_PARAMS: status 必须是 complete 或 failed");
        }
        session.transcriptionStatus = status;
        session.transcript = status === "complete" && typeof p["transcript"] === "string"
          ? p["transcript"]
          : null;
        return undefined;
      }
      case RequestMethod.VoiceReplayCacheStatus:
        this.voiceInputRequests.push({ method, params });
        return this.voiceReplayCache;
      case RequestMethod.VoiceReplaySetRetention:
        this.voiceInputRequests.push({ method, params });
        this.voiceReplayCache = {
          ...this.voiceReplayCache,
          retention: p["retention"] as import("@reai/app-sdk/v1").VoiceReplayRetention,
        };
        return this.voiceReplayCache;
      case RequestMethod.VoiceReplayCacheClear:
        this.voiceInputRequests.push({ method, params });
        this.voiceReplayCache = {
          ...this.voiceReplayCache,
          clipCount: 0,
          usedBytes: 0,
          retainedSinceMs: null,
        };
        return this.voiceReplayCache;
      case RequestMethod.EvidenceFetch:
        return { dataBase64: "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=" };
      case RequestMethod.VoiceCommandStatus:
        this.voiceCommandRequests.push({ method, params });
        return this.options.voiceCommandStatus ?? { configured: true, loggedIn: true };
      case RequestMethod.VoiceCommandConfigure:
        this.voiceCommandRequests.push({ method, params });
        return {
          configured: typeof p["workflowUrl"] === "string" && p["workflowUrl"].trim().length > 0,
          loggedIn: this.options.voiceCommandStatus?.loggedIn ?? true,
        };
      case RequestMethod.VoiceCommandRun:
        this.voiceCommandRequests.push({ method, params });
        if (this.nextVoiceCommandRunError) {
          const message = this.nextVoiceCommandRunError;
          this.nextVoiceCommandRunError = undefined;
          throw new MockHostError(message);
        }
        return this.options.voiceCommandResult ?? {
          runId: "mock-run-1",
          status: "completed",
          reply: "这是测试工作流回复",
          durationMs: 42,
        };
      case RequestMethod.VoiceCommandCancel:
        this.voiceCommandRequests.push({ method, params });
        return undefined;
      // 呈现口：mock 只记账不渲染。缺这些分支时插件侧的 presentTask 会抛
      // 「未知方法」再被 .catch 吞掉——合同套件就永远断言不到任务卡的诚实呈现。
      case RequestMethod.VoiceCommandPresentTask:
      case RequestMethod.VoiceCommandDismissTask:
      case RequestMethod.VoiceCommandPresentPlan:
      case RequestMethod.VoiceCommandPresentAnswer:
        if (method === RequestMethod.VoiceCommandPresentAnswer) {
          this.requireVoiceDiagnostics(method, params, "BRIDGE_BAD_PARAMS");
        }
        this.voiceCommandRequests.push({ method, params });
        return undefined;
      // agent.dsh@1 窄口：Mock 只回确定性终局，不孵化引擎进程。真实 Host 的
      // 会话归属边车、串行锁与只读工具门禁由 Rust 侧单测与探针覆盖，这里测的
      // 是插件把 dsh 合同用对（先 status 门禁、create 后 send、终局如实上呈）。
      case RequestMethod.DshStatus:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return this.dshStatusOverride ?? this.options.dshStatus ?? {
          available: true,
          detail: "",
          loggedIn: true,
          modelAccess: true,
        };
      case RequestMethod.DshSessionCreate:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return { sessionId: "mock-dsh-session-1" };
      case RequestMethod.DshSessionSend: {
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        const turnId = typeof p["turnId"] === "string" && p["turnId"] ? p["turnId"] : "mock-dsh-turn";
        if (this.nextDshSendFailure) {
          const failure = this.nextDshSendFailure;
          this.nextDshSendFailure = undefined;
          return { turnId, text: null, failure };
        }
        return { turnId, text: "这是测试工作流回复", failure: null };
      }
      case RequestMethod.DshSessionCancel:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return { cancelled: true };
      case RequestMethod.DshSessionHistory:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return { items: [] };
      case RequestMethod.DshSessionList:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return { sessions: [] };
      case RequestMethod.DshSessionDelete:
        this.requireDshCapability(method);
        this.dshRequests.push({ method, params });
        return { deleted: true };
      // agent.session@1：统一模拟 Pi/DSH/Codex 三个 backend（条目顺序与真实
      // Host 的 backends() 一致：pi、dsh、codex）。Pi/DSH 默认可用；Codex 默认
      // 「未授权/未安装」——真实 Host 只对走完自身同意流程建立引用边的插件报
      // 可用（其他插件装过组件不能代替本插件授权），mock 以保守值为基线，
      // 测 Codex 流程的场景用 setAgentCodexStatus 显式放开。测试在这里验证
      // 插件只使用通用会话合同，不再根据 backend 绕回 agent.dsh@1 私有接口。
      case RequestMethod.AgentV2Backends:
      case RequestMethod.AgentBackendsList:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return {
          backends: [
            this.agentPiStatusOverride ?? {
              backend: "pi",
              available: true,
              detail: "",
              channel: "external-brain",
              capabilities: {
                hostTools: true,
                fileTools: false,
                turnModes: [],
                modelSelection: "host-settings",
                // 1.21：MockHost 默认宣传范围执行；显式 override 的旧状态不补这两个字段。
                scopedExecutionVersion: 1,
                commandExecution: true,
                // 1.23：mock 按新版 Host 宣传 featureRef 支持（configuration 只放这一项，
                // 真实 Host 的完整 configuration 块见 driver-v2 describe()）。
                configuration: { featureRef: true },
              },
            },
            this.agentDshStatusOverride ?? {
              backend: "dsh",
              available: true,
              detail: "",
              channel: "external-brain",
              capabilities: {
                hostTools: true,
                fileTools: false,
                turnModes: [],
                modelSelection: "host-settings",
                // 1.21：MockHost 默认宣传范围执行；显式 override 的旧状态不补这两个字段。
                scopedExecutionVersion: 1,
                commandExecution: true,
                // 1.23：mock 按新版 Host 宣传 featureRef 支持（configuration 只放这一项，
                // 真实 Host 的完整 configuration 块见 driver-v2 describe()）。
                configuration: { featureRef: true },
              },
            },
            this.agentCodexStatusOverride ?? {
              backend: "codex",
              available: false,
              detail: "请安装兼容的 Codex 组件并授权此插件",
              channel: "external-brain",
              downloadRequired: true,
              capabilities: {
                hostTools: true,
                fileTools: false,
                turnModes: [],
                modelSelection: "host-settings",
                // 1.21：MockHost 默认宣传范围执行；显式 override 的旧状态不补这两个字段。
                scopedExecutionVersion: 1,
                commandExecution: true,
                // 1.23：与 pi/dsh 默认状态同口径宣传 featureRef 支持。
                configuration: { featureRef: true },
              },
            },
          ],
        };
      case RequestMethod.AgentV2Create: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const config = p["config"] as import("@reai/app-sdk/v1").AgentConfig;
        if (config?.schemaVersion !== 2 || ![undefined, "auto", "pi", "dsh", "codex"].includes(config.runtime)) {
          throw new MockHostError("Invalid Agent v2 config", "AGENT_INVALID_CONFIG");
        }
        // 1.23 与真实 Host 同口径：featureRef 只做格式检查
        // （^[a-z][a-z0-9-]*$、≤64 字节）；「是否由调用方 manifest 声明」真实 Host
        // 按 Bridge mount 身份校验，mock 不模拟。
        if (
          config.featureRef !== undefined
          && (!/^[a-z][a-z0-9-]*$/.test(config.featureRef)
            || Buffer.byteLength(config.featureRef, "utf8") > 64)
        ) {
          throw new MockHostError("Invalid Agent v2 featureRef", "AGENT_INVALID_CONFIG");
        }
        const runtime = config.runtime === "dsh" || config.runtime === "codex" ? config.runtime : "pi";
        const sessionId = `agent2-mock-${++this.agentV2Sequence}`;
        this.agentV2Sessions.set(sessionId, { runtime, memory: config.memory, createdAt: Date.now() });
        // 1.21：申请文件 / 命令工具的 direct / app-private 会话回真实工作根与范围版本；mounted 保持旧形状。
        const scopedTools = (config.tools ?? []).some(tool => ["read", "write", "edit", "list", "glob", "grep", "command"].includes(tool.ref));
        const workspace = config.workspace;
        const scoped = workspace && workspace.kind !== "mounted" && scopedTools ? {
          workspace,
          workspaceRoot: workspace.kind === "direct" ? workspace.path : `/mock/agent-workspaces/${sessionId}`,
          scopeVersion: 1 as const,
        } : {};
        return { schemaVersion: 2, sessionId, backend: runtime, runtime, channel: "external-brain", model: { tier: "text-default" }, selectionSource: config.runtime && config.runtime !== "auto" ? "request" : "default", ...scoped };
      }
      case RequestMethod.AgentV2ApprovalsList:
      case RequestMethod.AgentSessionApprovalsList: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        // 只读：MockHost 没有批准入口，与真实 Host 一致。
        return { approvals: [] };
      }
      case RequestMethod.AgentV2StartTurn: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const sessionId = String(p["sessionId"] ?? "");
        const session = this.agentV2Sessions.get(sessionId);
        const idempotencyKey = String(p["idempotencyKey"] ?? "");
        if (!session) throw new MockHostError("Agent session not found", "AGENT_SESSION_NOT_FOUND");
        if (!idempotencyKey || typeof p["text"] !== "string") throw new MockHostError("Invalid turn", "AGENT_INVALID_REQUEST");
        const key = JSON.stringify([sessionId, idempotencyKey]);
        const request = JSON.stringify([p["text"], p["taskPresentation"] ?? "host"]);
        const existing = this.agentV2Keys.get(key);
        if (existing) {
          if (existing.request !== request) throw new MockHostError("Idempotency key conflict", "AGENT_IDEMPOTENCY_CONFLICT");
          return structuredClone(this.agentV2Turns.get(existing.turnId));
        }
        const turnId = `turn-mock-${++this.agentV2Sequence}`;
        const failure = this.nextAgentSendFailure ?? null;
        this.nextAgentSendFailure = undefined;
        const text = failure ? null : this.nextAgentSendTextValue;
        const status = failure?.kind === "killed" ? "cancelled" : failure ? "failed" : "completed";
        const snapshot: import("@reai/app-sdk/v1").AgentTurnSnapshot = {
          schemaVersion: 2, sessionId, turnId, runtime: session.runtime, status, expired: false,
          createdAt: Date.now(), updatedAt: Date.now(),
          result: { schemaVersion: 2, sessionId, turnId, runtime: session.runtime, channel: "external-brain", status, text, failure, content: text ? [{ type: "text", text }] : [], usage: null, toolAttempts: [] },
        };
        this.agentV2Keys.set(key, { request, turnId });
        this.agentV2Turns.set(turnId, snapshot);
        return structuredClone(snapshot);
      }
      case RequestMethod.AgentV2GetTurn:
      case RequestMethod.AgentV2Events:
      case RequestMethod.AgentV2Cancel: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const snapshot = this.agentV2Turns.get(String(p["turnId"] ?? ""));
        if (!snapshot || snapshot.sessionId !== p["sessionId"]) throw new MockHostError("Agent turn not found", "AGENT_TURN_NOT_FOUND");
        // The deterministic mock completes immediately. Late cancellation cannot replace the result.
        if (method === RequestMethod.AgentV2Cancel) return { cancelled: false };
        if (method === RequestMethod.AgentV2Events) return { ...structuredClone(snapshot), events: [], gap: false, nextSequence: 0 };
        return structuredClone(snapshot);
      }
      case RequestMethod.AgentV2List:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return { sessions: [...this.agentV2Sessions].map(([sessionId, s]) => ({ sessionId, backend: s.runtime, memory: s.memory, createdMs: s.createdAt, updatedMs: s.createdAt, stale: false })) };
      case RequestMethod.AgentV2History:
      case RequestMethod.AgentV2ConversationOpened:
      case RequestMethod.AgentV2Delete: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const sessionId = String(p["sessionId"] ?? "");
        if (method === RequestMethod.AgentV2ConversationOpened && p.phase !== undefined) return this.ownedOpenRequest(p);
        if (method === RequestMethod.AgentV2ConversationOpened && this.isOwnedConversationSession(sessionId)) throw new MockHostError("TASK_SOURCE_STALE", "TASK_SOURCE_STALE");
        if (!this.agentV2Sessions.has(sessionId)) throw new MockHostError("Agent session not found", "AGENT_SESSION_NOT_FOUND");
        if (method === RequestMethod.AgentV2Delete) return { deleted: this.agentV2Sessions.delete(sessionId) };
        return method === RequestMethod.AgentV2History ? { items: [] } : null;
      }
      case RequestMethod.AgentV2ToolDependencyRequire:
      case RequestMethod.AgentToolDependencyRequire:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return null;
      case RequestMethod.AgentSessionCreate: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const spec = p["spec"] as { backend?: "auto" | "pi" | "dsh" | "codex"; workspace?: { kind: string; path?: string }; tools?: string[] } | undefined;
        const backend = spec?.backend;
        const scopedTools = (spec?.tools ?? []).some(tool => ["read", "write", "edit", "list", "glob", "grep", "command"].includes(tool));
        const workspace = spec?.workspace;
        return {
          sessionId: "mock-agent-session-1",
          backend: backend === "dsh" || backend === "codex" ? backend : "pi",
          // 1.21：direct / app-private 且申请文件或命令工具时回真实工作根；mounted 保持旧形状。
          ...(workspace && workspace.kind !== "mounted" && scopedTools ? {
            workspace,
            workspaceRoot: workspace.kind === "direct" ? workspace.path : "/mock/agent-workspaces/mock-agent-session-1",
            scopeVersion: 1,
          } : {}),
        };
      }
      case RequestMethod.AgentSessionSend: {
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        const turnId = typeof p["turnId"] === "string" && p["turnId"] ? p["turnId"] : "mock-agent-turn";
        if (this.nextAgentSendFailure) {
          const failure = this.nextAgentSendFailure;
          this.nextAgentSendFailure = undefined;
          return { schemaVersion: 1, turnId, text: null, failure };
        }
        return { schemaVersion: 1, turnId, text: this.nextAgentSendTextValue, failure: null };
      }
      case RequestMethod.AgentSessionCancel:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return { cancelled: true };
      case RequestMethod.AgentSessionHistory:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return { items: [] };
      case RequestMethod.AgentSessionList:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return { sessions: [] };
      case RequestMethod.AgentSessionDelete:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        return { deleted: true };
      case RequestMethod.AgentSessionConversationOpened:
        this.requireAgentSessionCapability(method);
        this.agentRequests.push({ method, params });
        if (p.phase !== undefined) return this.ownedOpenRequest(p);
        if (this.isOwnedConversationSession(String(p.sessionId))) throw new MockHostError("TASK_SOURCE_STALE", "TASK_SOURCE_STALE");
        return null;
      case RequestMethod.PiManagementSnapshot:
        this.requirePiManagementCapability(method);
        this.piManagementRequests.push({ method, params });
        return structuredClone(this.piManagementSnapshot);
      case RequestMethod.PiManagementSessionGet: {
        this.requirePiManagementCapability(method);
        this.piManagementRequests.push({ method, params });
        const sessionId = (params as { sessionId?: string }).sessionId;
        const session = this.piManagementSnapshot.sessions.find((item) => item.sessionId === sessionId);
        if (!session) throw new MockHostError("Pi 会话不存在");
        return {
          sessionId: session.sessionId,
          systemPrompt: session.systemPrompt ?? "",
          skills: structuredClone(session.skills ?? []),
          tools: structuredClone(session.tools ?? []),
          mcp: structuredClone(session.mcp ?? []),
        };
      }
      case RequestMethod.PiManagementModels:
        this.requirePiManagementCapability(method);
        this.piManagementRequests.push({ method, params });
        return {
          loggedIn: this.options.accountStatus?.loggedIn ?? true,
          models: structuredClone(this.piManagementModels),
          settings: structuredClone(this.piManagementSnapshot.settings),
        };
      case RequestMethod.PiManagementSettingsUpdate: {
        this.requirePiManagementCapability(method);
        this.piManagementRequests.push({ method, params });
        const settings = structuredClone(params) as import("@reai/app-sdk/v1").PiManagementSettings;
        this.piManagementSnapshot.settings = settings;
        return structuredClone(settings);
      }
      case RequestMethod.DshObserverSnapshot:
        this.requireDshObserverCapability(method);
        this.dshObserverRequests.push({ method, params });
        return structuredClone(this.dshObserverSnapshot);
      case RequestMethod.DshObserverSessionDetail: {
        this.requireDshObserverCapability(method);
        this.dshObserverRequests.push({ method, params });
        const sessionId = String((params as { sessionId?: string }).sessionId ?? "");
        const detail = this.dshObserverDetails.get(sessionId);
        if (!detail) throw new MockHostError("DSH 会话详情不存在");
        return structuredClone(detail);
      }
      case RequestMethod.DshObserverHistoryPage: {
        this.requireDshObserverCapability(method);
        this.dshObserverRequests.push({ method, params });
        const sessionId = String((params as { sessionId?: string }).sessionId ?? "");
        const page = this.dshObserverHistory.get(sessionId);
        if (!page) throw new MockHostError("DSH 会话历史不存在");
        return structuredClone(page);
      }
      case RequestMethod.DshObserverSettings:
        this.requireDshObserverCapability(method);
        this.dshObserverRequests.push({ method, params });
        return structuredClone(this.dshObserverSettings);
      case RequestMethod.DshObserverSettingsUpdate: {
        this.requireDshObserverCapability(method);
        this.dshObserverRequests.push({ method, params });
        const modelAlias = String((params as { modelAlias?: string }).modelAlias ?? "");
        const option = this.dshObserverSettings.options.find((item) => item.id === modelAlias);
        if (!option || option.availability !== "available") {
          throw new MockHostError("DSH 模型档位不可用");
        }
        this.dshObserverSettings.selectedModel = modelAlias;
        return structuredClone(this.dshObserverSettings);
      }
      case RequestMethod.AiModelsList:
        this.requireCloudCapability(method, "cloud.model.invoke@1");
        this.cloudRequests.push({ method, params });
        return {
          models: structuredClone(this.cloudModels),
        };
      case RequestMethod.AiTextGenerate: {
        this.requireCloudCapability(method, "cloud.model.invoke@1");
        this.cloudRequests.push({ method, params });
        if (this.failNextAiTextGenerateCode) {
          const code = this.failNextAiTextGenerateCode;
          this.failNextAiTextGenerateCode = undefined;
          this.rejections.push({ method, reason: `文本生成失败（测试注入）：${code}` });
          throw new MockHostError(`${code}: 文本生成失败（测试注入）`, code);
        }
        const invocationId = String(p["invocationId"] ?? "");
        if (this.holdNextAiTextGenerateValue) {
          // 永不 resolve：调用方必须自己有超时兜底，否则用户的输入就永远挂在这里。
          this.holdNextAiTextGenerateValue = false;
          return await new Promise<never>(() => {});
        }
        if (p["stream"] === true) {
          // 增量走推送通道；`done` 带完整文本供对账。
          queueMicrotask(() => {
            this.dispatchCloudEvent({
              type: "ai.stream.delta",
              invocationId,
              sequence: 1,
              text: "测试",
            });
            const sendDone = () =>
              this.dispatchCloudEvent({
                type: "ai.stream.done",
                invocationId,
                sequence: 2,
                text: "测试生成结果",
              });
            if (this.holdStreamTerminal) this.heldStreamTerminals.push(sendDone);
            else sendDone();
          });
          return { invocationId, stream: true };
        }
        return { invocationId, stream: false, text: this.nextAiTextGenerateTextValue };
      }
      case RequestMethod.VoiceContextCapture:
        this.requireCloudCapability(method, "voice.context@1");
        this.voiceInputRequests.push({ method, params });
        return {
          ...(this.voiceContextCaptureValue ?? {
            windowTextStatus: "not_requested",
            screenRecording: "denied",
          }),
          // Host 从不越过插件的意愿去读：没要窗口文字就一定不带回文字。
          // 复刻这条，插件那边「关掉就不采」的行为才测得出来。
          ...(p["includeWindowText"] === true
            ? {}
            : { windowText: undefined, windowTextStatus: "not_requested" }),
        };
      case RequestMethod.AiAudioTranscribe:
        this.requireCloudCapability(method, "cloud.model.invoke@1");
        this.cloudRequests.push({ method, params });
        if (String(p["sessionId"] ?? "") !== this.voiceSessionId) {
          this.rejections.push({ method, reason: "sessionId 不属于本次录音会话" });
          throw new MockHostError("sessionId 不属于本次录音会话");
        }
        // Host accepts only currently listed concrete options, never the legacy alias.
        const modelId = p["model"] == null
          ? this.cloudModels.find(model => model.kind === "transcribe")?.id ?? ""
          : String(p["model"]);
        if (modelId.length > 64 || modelId === "transcribe-default"
          || !/^transcribe-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modelId)) {
          this.rejections.push({ method, reason: "无效的云端转写选项" });
          throw new MockHostError("AI_INVALID_REQUEST: 请选择有效的云端转写选项", "AI_INVALID_REQUEST");
        }
        if (!this.cloudModels.some(model => model.kind === "transcribe" && model.id === modelId)) {
          this.rejections.push({ method, reason: "已移除的云端转写选项" });
          throw new MockHostError("AI_INVALID_REQUEST: 已选云端转写选项不可用，请重新选择云端模型", "AI_INVALID_REQUEST");
        }
        if (this.failNextAiAudioTranscribeCode) {
          const code = this.failNextAiAudioTranscribeCode;
          this.failNextAiAudioTranscribeCode = undefined;
          this.rejections.push({ method, reason: `转写失败（测试注入）：${code}` });
          throw new MockHostError(`${code}: 转写失败（测试注入）`, code);
        }
        {
          const suppressedReason = this.nextAiAudioTranscribeSuppressedReason;
          this.nextAiAudioTranscribeSuppressedReason = undefined;
          return {
            invocationId: String(p["invocationId"] ?? ""),
            text: suppressedReason === undefined ? this.nextAiAudioTranscribeTextValue : "",
            ...(suppressedReason === undefined ? {} : { suppressedReason }),
          };
        }
      case RequestMethod.AiCancel:
        this.requireCloudCapability(method, "cloud.model.invoke@1");
        this.cloudRequests.push({ method, params });
        if (this.failNextAiCancel) {
          this.failNextAiCancel = false;
          this.rejections.push({ method, reason: "取消请求失败（测试注入）" });
          throw new MockHostError("AI_UNAVAILABLE: 取消请求失败（测试注入）");
        }
        return { cancelled: true, upstreamStopped: true };
      case RequestMethod.FlowInvoke:
        this.requireCloudCapability(method, "cloud.workflow.invoke@1");
        this.cloudRequests.push({ method, params });
        // 今天 Driver 的登录授权里没有工作流档位；Mock 复刻这条 fail-closed，
        // 免得插件在测试里以为它可用。
        this.rejections.push({ method, reason: "云端工作流暂未开通" });
        throw new MockHostError("FLOW_SCOPE_UNAVAILABLE: 云端工作流暂未开通");
      case RequestMethod.FlowCancel:
        this.requireCloudCapability(method, "cloud.workflow.invoke@1");
        this.cloudRequests.push({ method, params });
        return { cancelled: true, upstreamStopped: false };
      case RequestMethod.VoiceDeliverCommit: {
        this.requireCloudCapability(method, "voice.deliver@1");
        this.cloudRequests.push({ method, params });
        if (this.failNextVoiceDeliverCommitCode) {
          const code = this.failNextVoiceDeliverCommitCode;
          this.failNextVoiceDeliverCommitCode = undefined;
          this.rejections.push({ method, reason: `写回失败（测试注入）：${code}` });
          throw new MockHostError(`${code}: 写回失败（测试注入）`, code);
        }
        if (this.nextVoiceDeliverCommitReason) {
          const reason = this.nextVoiceDeliverCommitReason;
          this.nextVoiceDeliverCommitReason = undefined;
          return { committed: false, reason };
        }
        if (this.revokedVoiceDeliveryTargets.has(String(p["targetId"] ?? ""))) {
          return { committed: false, reason: "expired" };
        }
        if (String(p["targetId"] ?? "") !== this.voiceDeliveryTargetId) {
          return { committed: false, reason: "denied" };
        }
        return { committed: true };
      }
      case RequestMethod.VoiceDeliverPresentTakeback: {
        this.requireCloudCapability(method, "voice.deliver@1");
        this.requireVoiceDiagnostics(method, params, "VOICE_DELIVER_INVALID_REQUEST");
        this.cloudRequests.push({ method, params });
        return { presented: true };
      }
      case RequestMethod.SystemTasksVersionStatus:
        this.requireSystemTasksCapability(method);
        this.systemTaskRequests.push({ method, params });
        return this.options.systemTaskVersionStatus ?? {
          firmware: {
            currentVersion: null,
            latestVersion: null,
            updateAvailable: false,
            connected: false,
            connectionType: null,
          },
          app: {
            currentVersion: "0.1.0",
            latestVersion: null,
            updateAvailable: false,
            installable: false,
            blockedReason: "development-build",
          },
          checkedAt: null,
          source: "unavailable",
        };
      case RequestMethod.SystemTasksOpen:
        this.requireSystemTasksCapability(method);
        this.systemTaskRequests.push({ method, params });
        if (this.nextSystemTaskOpenError) {
          const message = this.nextSystemTaskOpenError;
          this.nextSystemTaskOpenError = undefined;
          throw new MockHostError(message);
        }
        return { taskId: nextId("system-task"), accepted: true };
      // C-3b Action 层挂载：Host 只存「哪些被挂了」。形状必须与真实 Host 一致——
      // 快照里条目 id 的字段名是 `itemId`（Host `ActionMount.item_id`），**不是**
      // 请求负载里的 `id`。桩和真身形状不一致，字段名写错就永远测不出来。
      case RequestMethod.ActionItemsMount: {
        const kind = String(p["kind"] ?? "");
        const id = String(p["id"] ?? "");
        if (kind !== "command" && kind !== "item") {
          throw new MockHostError("kind 必须是 command 或 item");
        }
        if (!id) throw new MockHostError("id 不能为空");
        const { id: _requestId, ...rest } = p;
        this.actionMounts.set(`${kind}/${id}`, {
          ...rest,
          appId: this.options.manifest.appId,
          kind,
          itemId: id,
          mountedAt: Date.now(),
        });
        return null;
      }
      case RequestMethod.ActionItemsUnmount:
        return {
          removed: this.actionMounts.delete(
            `${String(p["kind"] ?? "")}/${String(p["id"] ?? "")}`,
          ),
        };
      case RequestMethod.ActionItemsList:
        return { mounts: [...this.actionMounts.values()] };
      default:
        throw new MockHostError(`未知的 Bridge 请求方法：${method}`);
    }
  }

  private handleNotify(method: string, params: unknown): void {
    switch (method) {
      case NotifyMethod.Registered:
        this.registration = params as RegistrationReport;
        return;
      case NotifyMethod.ActivateFailed:
        this.activateFailure = params as WireError;
        return;
      case NotifyMethod.ServiceSettled: {
        const settlement = params as { correlationId: string; ok: boolean; output?: unknown; error?: WireError };
        if (this.serviceSettlements.has(settlement.correlationId)) throw new MockHostError("Service settled twice");
        this.serviceSettlements.set(settlement.correlationId, settlement); return;
      }
      case NotifyMethod.CommandSettled: {
        const settlement = params as CommandSettlement;
        if (this.settlements.has(settlement.correlationId)) {
          throw new MockHostError(
            `Command ${settlement.correlationId} 给出了第二个终局；合同要求恰好一个`,
          );
        }
        this.settlements.set(settlement.correlationId, settlement);
        return;
      }
      case NotifyMethod.SurfaceReady: {
        const { surfaceMountId } = params as { surfaceMountId: string };
        const observation = this.mounts.get(surfaceMountId);
        if (observation) observation.readyCount += 1;
        return;
      }
      case NotifyMethod.SurfaceFailed: {
        const { surfaceMountId, error } = params as {
          surfaceMountId: string;
          error: WireError;
        };
        const observation = this.mounts.get(surfaceMountId);
        if (observation) {
          observation.failCount += 1;
          observation.failure = error;
        }
        return;
      }
      case NotifyMethod.SurfaceError: {
        const { surfaceMountId, error } = params as {
          surfaceMountId: string;
          error: WireError;
        };
        this.mounts.get(surfaceMountId)?.errors.push(error);
        return;
      }
      case NotifyMethod.SurfaceNav: {
        const { surfaceMountId, nav } = params as {
          surfaceMountId: string;
          nav: { key: string; label: string } | null;
        };
        const observation = this.mounts.get(surfaceMountId);
        if (observation) {
          observation.navReports.push(nav);
          this.lastNav = nav;
          this.navListeners.forEach((listener) => listener(nav));
        }
        return;
      }
      default:
        throw new MockHostError(`未知的 Bridge 通知方法：${method}`);
    }
  }

  private requireStore(params: Record<string, unknown>): string {
    const storeId = String(params["storeId"] ?? "");
    const declared = this.options.manifest.data?.privateStores?.some((s) => s.id === storeId);
    if (!declared) {
      this.rejections.push({
        method: "storage",
        reason: `store ${storeId || "(空)"} 未在 Manifest 的 data.privateStores 声明`,
      });
      throw new MockHostError(`store ${storeId || "(空)"} 未声明，Host 会拒绝这次访问`);
    }
    return storeId;
  }

  private requireSystemTasksCapability(method: string): void {
    if (this.options.manifest.requires?.hostCapabilities?.includes("system.tasks@1")) return;
    this.rejections.push({ method, reason: "Manifest 未声明 system.tasks@1" });
    throw new MockHostError("Manifest 未声明 system.tasks@1");
  }

  private requireTerminalCapability(method: string): void {
    const capability = "terminal.session@1";
    const declaredCapability =
      this.options.manifest.requires?.hostCapabilities?.includes(capability) ?? false;
    const declaredPermission =
      this.options.manifest.permissions?.some((permission) => permission.id === capability) ?? false;
    if (declaredCapability && declaredPermission) return;
    this.rejections.push({ method, reason: "Manifest 未声明 terminal.session@1 双层权限" });
    throw new MockHostError("Manifest 未声明 terminal.session@1 双层权限");
  }

  private requireDeveloperPlatformCapability(method: string): void {
    const exactApp = this.options.manifest.appId === "com.reai.developer-center";
    const declared = this.options.manifest.requires?.hostCapabilities?.includes(
      "developer.platform@1",
    ) ?? false;
    if (exactApp && declared) return;
    this.rejections.push({ method, reason: "developer.platform@1 只允许开放平台系统插件" });
    throw new MockHostError(
      "developer.platform@1 未授予当前插件",
      "DEVELOPER_PLATFORM_NOT_GRANTED",
    );
  }

  /**
   * agent.dsh@1 的**平台单层**声明检查。
   *
   * 与云端通道的双层门不同：dsh 的用户同意层落在 `cloud.model.invoke@1`（Host 以
   * `dsh.status.modelAccess` 汇报两层是否齐备），所以这里只查平台能力声明。
   */
  private requireDshCapability(method: string): void {
    if (this.options.manifest.requires?.hostCapabilities?.includes("agent.dsh@1")) return;
    this.rejections.push({ method, reason: "Manifest 未声明 agent.dsh@1" });
    throw new MockHostError("Manifest 未声明 agent.dsh@1");
  }

  private requireAgentSessionCapability(method: string): void {
    const capability = method.startsWith("agent.v2.") ? "agent.session@2" : "agent.session@1";
    if (this.options.manifest.requires?.hostCapabilities?.includes(capability)) return;
    this.rejections.push({ method, reason: `Manifest 未声明 ${capability}` });
    throw new MockHostError(`Manifest 未声明 ${capability}`);
  }

  private requirePiManagementCapability(method: string): void {
    if (
      this.options.manifest.appId === "com.reai.pi-agent" &&
      this.options.manifest.requires?.hostCapabilities?.includes("agent.pi-management@1")
    ) return;
    this.rejections.push({ method, reason: "Manifest 未声明 agent.pi-management@1" });
    throw new MockHostError("Manifest 未声明 agent.pi-management@1");
  }

  private requireDshObserverCapability(method: string): void {
    const capability = "agent.dsh-observe@1";
    const official = this.options.manifest.appId === "com.reai.dsh-agent";
    const declaredCapability =
      this.options.manifest.requires?.hostCapabilities?.includes(capability) ?? false;
    const declaredPermission =
      this.options.manifest.permissions?.some((permission) => permission.id === capability) ?? false;
    if (official && declaredCapability && declaredPermission) return;
    this.rejections.push({ method, reason: "DSH 透明度能力未获双层授权" });
    throw new MockHostError("DSH 透明度能力未获双层授权");
  }

  /**
   * 云端通道与写回能力的**双层**声明检查。
   *
   * 真实 Host 的两道门是「平台放行 + 用户同意」；Mock 拿不到运行期授予数据，
   * 但能把「Manifest 两层都要声明」这条查了——只声明一半的插件在真实 Host 上
   * 装得上、运行时才炸，那种失败在测试里必须提前暴露。
   */
  /**
   * Host API 1.22 可选诊断字段（取回卡与结果面板同一规则，与 Host 的 Rust 校验一致）：
   * `errorCode` 是码的形状：可选的小写反向域名命名空间加 `/`，再接字母开头、只含字母数字下划线的标识
   * （≤ 64），总长 ≤ 100（同 Host `takeback::valid_error_code`）；`detail` 为 ≤ 500 字的字符串。
   * 给了才校验，不给与旧行为完全一致。
   */
  private requireVoiceDiagnostics(method: string, params: unknown, invalidCode: string): void {
    const p = (params ?? {}) as Record<string, unknown>;
    const code = p["errorCode"];
    const detail = p["detail"];
    let reason: string | undefined;
    if (code !== undefined && code !== null
      && (typeof code !== "string" || code.length > 100
        || !/^(?:[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\/)?[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code))) {
      reason = "errorCode 须为码的形状：可选 com.example.app/ 命名空间 + 字母开头的字母数字下划线标识，总长 ≤ 100";
    } else if (detail !== undefined && detail !== null
      && (typeof detail !== "string" || [...detail].length > 500)) {
      reason = typeof detail === "string" ? "detail 超过长度上限 500" : "detail 须为字符串";
    }
    if (reason === undefined) return;
    this.rejections.push({ method, reason });
    throw new MockHostError(`${invalidCode}: ${reason}`, invalidCode);
  }

  private requireCloudCapability(method: string, capability: string): void {
    const declaredCapability =
      this.options.manifest.requires?.hostCapabilities?.includes(capability) ?? false;
    const declaredPermission =
      this.options.manifest.permissions?.some((permission) => permission.id === capability) ??
      false;
    if (declaredCapability && declaredPermission) return;
    const missing = declaredCapability ? "用户权限" : "平台能力";
    this.rejections.push({ method, reason: `Manifest 未声明 ${capability} 的${missing}` });
    throw new MockHostError(`Manifest 未声明 ${capability} 的${missing}`);
  }

  /**
   * 手工投一条云端事件，用来验插件的归属过滤。
   *
   * 串台事件（别人的 invocationId）必须被丢掉——这条只能靠真投一条进去看有没有
   * 反应，读源码找 `if (...) return` 那种断言会随写法一变就失效，而行为没变。
   */
  emitCloudEvent(event: unknown): void {
    this.dispatchCloudEvent(event);
  }

  private dispatchCloudEvent(event: unknown): void {
    // 投给当前仍挂着的那个 mount。没有 mount 时不投——真实 Host 的推送通道
    // 也是投给具体 WebView 的，没有界面就没有收件人。
    let surfaceMountId: string | undefined;
    for (const [id, observation] of this.mounts) {
      if (!observation.unmounted) surfaceMountId = id;
    }
    if (!surfaceMountId) return;
    this.dispatch({
      type: "cloud.event",
      surfaceMountId,
      runtimeSessionId: this.runtimeSessionId,
      event,
    });
  }

  private storageKey(params: Record<string, unknown>): string {
    const storeId = this.requireStore(params);
    const key = String(params["key"] ?? "");
    return `${this.options.manifest.appId}/${storeId}/${key}`;
  }
}

/** 等微任务队列排空，让 App 里的 `await` 链跑完。 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 没有 DOM 环境时给出的 root 替身。
 *
 * 不返回 `undefined` 也不返回空对象：那样 App 会在某个属性访问上抛出
 * `Cannot read property of undefined`，开发者只会以为是自己的 bug。
 */
function missingDomProxy(surfaceId: string): unknown {
  const explain = () => {
    throw new MockHostError(
      `Surface ${surfaceId} 用到了 DOM，但当前测试环境没有 document。` +
        `请在合同测试里提供 DOM（例如注册 happy-dom），或只跑协议级断言。`,
    );
  };
  return new Proxy(
    {},
    {
      get: explain,
      set: explain,
      has: explain,
    },
  );
}

// JSON object member order is irrelevant, matching serde_json::Value equality in the Host.
function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && equalJson(x[k], y[k]));
}
