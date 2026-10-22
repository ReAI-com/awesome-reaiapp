import type { AppContext, AudioClipRef } from "@reai/app-sdk/v1";

/**
 * Voice 消费 Host 共享音频片段（audio.clips@1）的路径。
 *
 * 现状：Voice 已有的录音→转写→写回流程不改走这里（Host 自有 Voice 会话与 3 秒前后台闸
 * 保持原样）。本模块只在 Host 本轮描述符确认 audio.clips@1 可用、且 Voice 获批该能力时
 * 才工作；任何「不可用」都返回 `unavailable`，调用方继续用原流程，不做降级猜测。
 *
 * 时间语义（Host 统一时钟域的 Unix 毫秒）：
 * - `leadMs`：键盘持续收音时可向前补开始前的话；Host 只允许回读已授权窗口，
 *   越界时自动退回按下时刻重试一次（电脑麦克风按开始才开录，通常没有前置音频）。
 * - `tailMs`：结束后顺延 0–2 秒（默认 1.5 秒），等真实音频到达后再 finish。
 * - 气口复用由 Host 在授权窗口内向外扩展，插件不自行裁剪。
 */
export const VOICE_CLIP_DEFAULT_TAIL_MS = 1_500;
export const VOICE_CLIP_MAX_TAIL_MS = 2_000;
export const VOICE_CLIP_MAX_RANGE_MS = 600_000;
const READ_CHUNK_BYTES = 262_144;
const STATUS_POLL_MS = 100;
const STATUS_TIMEOUT_MS = 150_000;

export type VoiceClipResult =
  | { kind: "transcript"; text: string; clip: AudioClipRef }
  | { kind: "unavailable"; code: string }
  | { kind: "failed"; code: string };

export interface VoiceClipRequest {
  /** Host 签发的消费者身份（audioCapture.acquire 的回执）。 */
  consumerId: string;
  /** 用户按下 / 松开的时刻（Unix 毫秒）。 */
  pressedAtMs: number;
  releasedAtMs: number;
  leadMs?: number;
  tailMs?: number;
  /** 同一次录音重试时保持不变，Host 用它返回稳定 jobId。 */
  idempotencyKey: string;
  signal?: AbortSignal;
  /** 范围开启后回报 rangeId：调用方超时放弃时可主动取消，不必等 Host 的 finish 返回。 */
  onRange?: (rangeId: string) => void;
  /** 片段签发后回报 clipId：调用方超时放弃时主动释放（也会取消同片段仍在跑的转写）。 */
  onClip?: (clipId: string) => void;
}

export interface VoiceClipPorts {
  now(): number;
  sleep(ms: number): Promise<void>;
  requestId(): string;
}

const defaultPorts: VoiceClipPorts = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  requestId: () => `voice-clip-${crypto.randomUUID()}`,
};

const UNAVAILABLE = new Set([
  "HOST_CAPABILITY_NOT_AVAILABLE",
  "AUDIO_NOT_GRANTED",
  "AUDIO_PERMISSION_REQUIRED",
  "AUDIO_PERMISSION_DENIED",
  "AUDIO_SOURCE_UNAVAILABLE",
]);

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "AUDIO_SOURCE_UNAVAILABLE";
}

function settle(error: unknown): VoiceClipResult {
  const code = errorCode(error);
  return UNAVAILABLE.has(code) ? { kind: "unavailable", code } : { kind: "failed", code };
}

/** 计算本次请求的时间范围；不合法时返回 null（不发请求）。 */
export function planVoiceClipRange(request: Pick<VoiceClipRequest, "pressedAtMs" | "releasedAtMs" | "leadMs" | "tailMs">) {
  const { pressedAtMs, releasedAtMs } = request;
  if (!Number.isSafeInteger(pressedAtMs) || !Number.isSafeInteger(releasedAtMs) || pressedAtMs < 0 || releasedAtMs <= pressedAtMs) return null;
  const lead = Math.max(0, Math.min(Number.isFinite(request.leadMs) ? Math.trunc(request.leadMs!) : 0, 5_000));
  const tail = Math.max(0, Math.min(Number.isFinite(request.tailMs) ? Math.trunc(request.tailMs!) : VOICE_CLIP_DEFAULT_TAIL_MS, VOICE_CLIP_MAX_TAIL_MS));
  // 范围上限先压前补、再压后补，按下到松开的实录必须完整在内；实录本身超过上限就不增强
  // （返回 null，调用方退回 Host 会话自己的识别结果），免得片段截掉末尾的话。
  if (releasedAtMs - pressedAtMs > VOICE_CLIP_MAX_RANGE_MS) return null;
  const startMs = Math.min(pressedAtMs, Math.max(0, pressedAtMs - lead, releasedAtMs + tail - VOICE_CLIP_MAX_RANGE_MS));
  const endMs = Math.min(releasedAtMs + tail, startMs + VOICE_CLIP_MAX_RANGE_MS);
  if (endMs <= startMs) return null;
  return { startMs, fallbackStartMs: pressedAtMs, endMs };
}

/** 把片段转成本地文字：start → finish（等 Host 真正签发）→ transcribe → 查询 → release。 */
export async function transcribeVoiceClip(ctx: Pick<AppContext, "audioClips">, request: VoiceClipRequest, ports: VoiceClipPorts = defaultPorts): Promise<VoiceClipResult> {
  const plan = planVoiceClipRange(request);
  if (!plan) return { kind: "failed", code: "AUDIO_RANGE_INVALID" };
  const clips = ctx.audioClips;
  if (!clips) return { kind: "unavailable", code: "HOST_CAPABILITY_NOT_AVAILABLE" };
  const aborted = () => request.signal?.aborted === true;
  const cancelled: VoiceClipResult = { kind: "failed", code: "AUDIO_CANCELLED" };
  let rangeId: string | undefined;
  let clip: AudioClipRef | undefined;
  const result = await (async (): Promise<VoiceClipResult> => {
    try {
      try {
        rangeId = (await clips.start({ requestId: ports.requestId(), consumerId: request.consumerId, startMs: plan.startMs })).rangeId;
      } catch (error) {
        // 前置音频超出授权窗口（例如电脑麦克风刚开始录）：退回按下时刻再试一次。
        if (errorCode(error) !== "AUDIO_RANGE_UNAVAILABLE" || plan.startMs === plan.fallbackStartMs) throw error;
        rangeId = (await clips.start({ requestId: ports.requestId(), consumerId: request.consumerId, startMs: plan.fallbackStartMs })).rangeId;
      }
      request.onRange?.(rangeId);
      // 结束顺延：等真实音频到达后再 finish，Host 不接受未来时间。
      const wait = plan.endMs - ports.now();
      if (wait > 0) await ports.sleep(wait);
      if (aborted()) return cancelled;
      clip = await clips.finish({ requestId: ports.requestId(), rangeId, endMs: plan.endMs });
      request.onClip?.(clip.clipId);
      if (aborted()) return cancelled;
      let job = await clips.transcribe({ requestId: ports.requestId(), clipId: clip.clipId, idempotencyKey: request.idempotencyKey });
      const deadline = ports.now() + STATUS_TIMEOUT_MS;
      while (job.state === "queued" || job.state === "running") {
        if (aborted()) return cancelled;
        if (ports.now() >= deadline) return { kind: "failed", code: "AUDIO_QUEUE_FULL" };
        await ports.sleep(STATUS_POLL_MS);
        job = await clips.transcriptionStatus({ requestId: ports.requestId(), jobId: job.jobId });
      }
      // 用户已取消就不再交付结果，哪怕识别恰好完成。
      if (aborted()) return cancelled;
      if (job.state !== "complete") return { kind: "failed", code: job.errorCode ?? "AUDIO_CANCELLED" };
      return { kind: "transcript", text: job.transcript ?? "", clip };
    } catch (error) {
      return settle(error);
    } finally {
      if (clip) {
        // 片段只在本次转写期间持有；release 即退还预算（也会取消同片段仍在跑的转写）。
        await clips.release({ requestId: ports.requestId(), clipId: clip.clipId }).catch(() => undefined);
      } else if (rangeId) {
        // 没拿到片段就放弃（取消、finish 被拒或等待超时）：取消范围，免得占着本插件的范围名额。
        await clips.cancel({ requestId: ports.requestId(), rangeId }).catch(() => undefined);
      }
    }
  })();
  // 清理（release / cancel）期间用户取消：同样不再交付文字。
  return result.kind === "transcript" && aborted() ? cancelled : result;
}

/** 按 256 KiB 分块读出整段 f32le PCM（16 kHz 单声道）。读取不延长片段 TTL。 */
export async function readVoiceClipPcm(ctx: Pick<AppContext, "audioClips">, clip: AudioClipRef, ports: Pick<VoiceClipPorts, "requestId"> = defaultPorts): Promise<Float32Array> {
  const bytes = new Uint8Array(clip.sizeBytes);
  let offset = 0;
  for (;;) {
    const chunk = await ctx.audioClips.read({ requestId: ports.requestId(), clipId: clip.clipId, offset, maxBytes: READ_CHUNK_BYTES });
    const body = Uint8Array.from(atob(chunk.bodyBase64), (c) => c.charCodeAt(0));
    if (chunk.offset !== offset || body.length !== chunk.bytes || offset + body.length > bytes.length) throw Object.assign(new Error("音频片段分块不连续"), { code: "AUDIO_RANGE_UNAVAILABLE" });
    bytes.set(body, offset);
    offset += body.length;
    if (chunk.eof) break;
    if (body.length === 0) throw Object.assign(new Error("音频片段读取未前进"), { code: "AUDIO_RANGE_UNAVAILABLE" });
  }
  if (offset !== clip.sizeBytes) throw Object.assign(new Error("音频片段长度不符"), { code: "AUDIO_RANGE_UNAVAILABLE" });
  return new Float32Array(bytes.buffer, 0, offset / 4);
}

/** 键盘路由可前补的时长（Host 只放行已授权窗口，越界自动退回按下时刻）。 */
export const VOICE_CLIP_BOARD_LEAD_MS = 3_000;
/** 片段增强整体预算：超时就用 Host 会话自己的识别结果，并主动取消在途范围。 */
export const VOICE_CLIP_ENHANCE_BUDGET_MS = 5_000;
const CLIP_CONSUMER_PURPOSE = "voice-input-lead-tail";
const CLIP_PROBE_JOB_ID = "voice-capability-probe";
/** 持有期间核对消费者实际来源的间隔：Host 一旦把它回退到电脑麦就立即交还。 */
export const VOICE_CLIP_ROUTE_CHECK_MS = 2_000;
const BOARD_SOURCES = new Set(["board-usb-hid", "board-ble"]);
/** 这些失败说明当前消费者已作废（切源、断流、撤权、界面换代）：交还并按当前状态重新申请一次。 */
const CONSUMER_RETIRED = new Set(["AUDIO_CONSUMER_STALE", "AUDIO_RANGE_UNAVAILABLE", ...UNAVAILABLE]);

export interface VoiceClipCaptureDeps {
  ctx: Pick<AppContext, "audioClips"> & { audioCapture?: Pick<AppContext["audioCapture"], "acquire" | "release"> & Partial<Pick<AppContext["audioCapture"], "status">> };
  ports?: VoiceClipPorts;
  /** 片段增强整体预算（测试可调小）。 */
  budgetMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 来源核对间隔（测试可调小）。 */
  routeCheckMs?: number;
}

/** 按下那一刻冻结的消费者身份；松开时消费者已换代就不增强。 */
export interface VoiceClipPressToken { consumerId: string; pressedAtMs: number }

/**
 * Voice 输入法的片段增强协调器（audio.capture@1 + audio.clips@1）。
 *
 * 只在「Voice 界面已挂载 + 调用方给出想要的键盘持续收音状态（`setWanted(key)`）+ Host 同时
 * 开放并批准两项能力」时持有一个采集消费者；任何一项不满足都不持有，调用方继续用 Host
 * 会话自己的识别结果（与旧版完全一致）。只给键盘连续源用：电脑麦按会话开录，不常驻消费者。
 * consumer 由 Host 按界面挂载绑定，界面卸载即失效。
 */
export class VoiceClipCapture {
  private mounted = false;
  private wantKey: string | undefined;
  private consumerId: string | undefined;
  /** 来源核对通过前为 false：消费者已登记（可被交还），但还不能用于增强。 */
  private ready = false;
  /** 每次状态翻转递增：迟到的 acquire 回执发现代次变了就立即交还。 */
  private generation = 0;
  /** 正在为哪一代申请（按代管理：旧代的挂起申请/探测不阻挡新代）。 */
  private acquiringGeneration: number | undefined;
  /** 本代 acquire/探测已被拒（未开放/未授权）：不重复请求，等真实状态变化再试。 */
  private refused = false;
  private disposed = false;
  private routeTimer: unknown;
  private readonly ports: VoiceClipPorts;

  constructor(private readonly deps: VoiceClipCaptureDeps) {
    this.ports = deps.ports ?? defaultPorts;
  }

  /** 当前是否持有可用于前补的采集消费者。 */
  get active(): boolean {
    return this.consumerId !== undefined && this.ready;
  }

  setMounted(mounted: boolean): void {
    if (this.disposed || mounted === this.mounted) return;
    this.mounted = mounted;
    this.restart();
  }

  /** undefined = 不需要；任意字符串 = 需要，字符串变化（切源、收音状态变化）视为新的一代。 */
  setWanted(key: string | undefined): void {
    if (this.disposed || key === this.wantKey) return;
    this.wantKey = key;
    this.restart();
  }

  private restart(): void {
    this.generation += 1;
    this.refused = false;
    this.releaseHeld();
    this.reconcile();
  }

  private releaseHeld(): void {
    const consumerId = this.consumerId;
    this.consumerId = undefined;
    this.ready = false;
    this.stopRouteCheck();
    if (!consumerId) return;
    void this.deps.ctx.audioCapture?.release({ requestId: this.ports.requestId(), consumerId }).catch(() => undefined);
  }

  /** 两项能力都要可用：acquire 只验 audio.capture，再用一次无副作用的状态查询验 audio.clips（有截止，超时按不可用）。 */
  private async clipsUsable(): Promise<boolean> {
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let handle: unknown;
    const deadline = new Promise<boolean>((resolve) => { handle = setTimer(() => resolve(false), this.deps.routeCheckMs ?? VOICE_CLIP_ROUTE_CHECK_MS); });
    const probe = this.deps.ctx.audioClips.transcriptionStatus({ requestId: this.ports.requestId(), jobId: CLIP_PROBE_JOB_ID })
      .then(() => true, (error: unknown) => !UNAVAILABLE.has(errorCode(error)));
    try {
      return await Promise.race([probe, deadline]);
    } finally {
      clearTimer(handle);
    }
  }

  private reconcile(): void {
    const capture = this.deps.ctx.audioCapture;
    if (this.disposed || !this.mounted || this.wantKey === undefined || this.consumerId
      || this.acquiringGeneration === this.generation || this.refused || !capture) return;
    const generation = this.generation;
    this.acquiringGeneration = generation;
    void (async () => {
      try {
        // 先做无副作用的 audio.clips 可用性探测，确认两项能力都在才申请采集消费者（申请即会参与采音）。
        const usable = await this.clipsUsable();
        if (this.disposed || generation !== this.generation) return;
        if (!usable) {
          this.refused = true;
          return;
        }
        const acquired = await capture.acquire({ requestId: this.ports.requestId(), purpose: CLIP_CONSUMER_PURPOSE });
        if (this.disposed || generation !== this.generation) {
          void capture.release({ requestId: this.ports.requestId(), consumerId: acquired.consumerId }).catch(() => undefined);
          return;
        }
        this.consumerId = acquired.consumerId;
        // 只做键盘连续源：Host 已把它解析到电脑麦（键盘断开后的回退）就不持有。
        if (!BOARD_SOURCES.has(acquired.route?.source ?? "")) {
          this.releaseHeld();
          this.refused = true;
          return;
        }
        this.ready = true;
        this.startRouteCheck(acquired.consumerId);
      } catch {
        if (generation === this.generation) this.refused = true;
      } finally {
        if (this.acquiringGeneration === generation) this.acquiringGeneration = undefined;
        // 等待期间状态翻转过：按新状态再对齐一次。
        if (generation !== this.generation) this.reconcile();
      }
    })();
  }

  private stopRouteCheck(): void {
    if (this.routeTimer === undefined) return;
    (this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.routeTimer);
    this.routeTimer = undefined;
  }

  /**
   * 持有期间定期复核：实际来源仍是键盘（Host 回退到电脑麦就交还，避免电脑麦在空闲时常驻），
   * 且 audio.clips@1 仍可用（单独撤回片段权限时同样交还采集消费者）。查询有截止，超时视同不可信。
   */
  private startRouteCheck(consumerId: string): void {
    const capture = this.deps.ctx.audioCapture;
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const interval = this.deps.routeCheckMs ?? VOICE_CLIP_ROUTE_CHECK_MS;
    const routeStillBoard = async (): Promise<boolean> => {
      if (!capture?.status) return true;
      let handle: unknown;
      const deadline = new Promise<boolean>((resolve) => { handle = setTimer(() => resolve(false), interval); });
      const check = capture.status({ requestId: this.ports.requestId(), consumerId })
        .then((receipt) => BOARD_SOURCES.has(receipt.route?.source ?? ""), () => false);
      try {
        return await Promise.race([check, deadline]);
      } finally {
        clearTimer(handle);
      }
    };
    const tick = () => {
      this.routeTimer = setTimer(() => {
        this.routeTimer = undefined;
        if (this.disposed || this.consumerId !== consumerId) return;
        void Promise.all([routeStillBoard(), this.clipsUsable()]).then(([board, clips]) => {
          if (this.consumerId !== consumerId) return;
          if (board && clips) tick();
          else { this.releaseHeld(); this.refused = true; }
        });
      }, interval);
    };
    tick();
  }

  /** 按下那一刻调用：持有消费者才返回凭据，否则 undefined（本次走原流程）。 */
  press(pressedAtMs: number): VoiceClipPressToken | undefined {
    return this.consumerId && this.ready && !this.disposed ? { consumerId: this.consumerId, pressedAtMs } : undefined;
  }

  /**
   * 用片段转写替换本次输入法的识别结果。返回非空文本才替换；undefined = 用 Host 原结果。
   */
  async enhance(input: { token: VoiceClipPressToken; releasedAtMs: number; boardRoute: boolean }): Promise<string | undefined> {
    const consumerId = this.consumerId;
    if (this.disposed || !consumerId || !this.ready || consumerId !== input.token.consumerId) return undefined;
    const clips = this.deps.ctx.audioClips;
    const controller = new AbortController();
    let rangeId: string | undefined;
    let clipId: string | undefined;
    const work = transcribeVoiceClip(this.deps.ctx, {
      consumerId,
      pressedAtMs: input.token.pressedAtMs,
      releasedAtMs: input.releasedAtMs,
      leadMs: input.boardRoute ? VOICE_CLIP_BOARD_LEAD_MS : 0,
      tailMs: VOICE_CLIP_DEFAULT_TAIL_MS,
      idempotencyKey: this.ports.requestId(),
      signal: controller.signal,
      onRange: (id) => { rangeId = id; },
      onClip: (id) => { clipId = id; },
    }, this.ports).catch((): VoiceClipResult => ({ kind: "failed", code: "AUDIO_CANCELLED" }));
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer = this.deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let timer: unknown;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimer(() => {
        controller.abort();
        // 不等慢调用返回：片段已签发就主动释放（连带取消其转写），尚未签发就取消在途范围。
        if (clipId) void clips.release({ requestId: this.ports.requestId(), clipId }).catch(() => undefined);
        else if (rangeId) void clips.cancel({ requestId: this.ports.requestId(), rangeId }).catch(() => undefined);
        resolve(undefined);
      }, this.deps.budgetMs ?? VOICE_CLIP_ENHANCE_BUDGET_MS);
    });
    try {
      const result = await Promise.race([work, timeout]);
      if (!result) return undefined;
      if (result.kind !== "transcript") {
        // 消费者已作废：交还，并按当前状态重新申请一次（被拒就停在不可用，等状态变化）。
        if (CONSUMER_RETIRED.has(result.code) && this.consumerId === consumerId) {
          if (UNAVAILABLE.has(result.code)) {
            this.releaseHeld();
            this.refused = true;
          } else {
            this.restart();
          }
        }
        return undefined;
      }
      const text = result.text.trim();
      return text || undefined;
    } finally {
      clearTimer(timer);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.releaseHeld();
    this.disposed = true;
  }
}
