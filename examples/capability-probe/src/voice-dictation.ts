/**
 * 「调用 Voice 插件的服务」卡片里的手动流程：真的发起一次听写，跟踪它的状态，拿到识别出的文字。
 *
 * Voice 文字服务（com.reai.voice/request-text@1）的四个方法：
 * - request-text：开始一次听写；这次调用一直挂着，直到拿到最终文字或失败；
 * - status：查这次听写现在到哪一步（不含文字和音频）；
 * - finish：说完了，结束录音开始识别（只回「收到」，文字由 request-text 返回）；
 * - cancel：取消。
 *
 * 会真的打开麦克风，识别走云端、可能消耗账户额度；所以只在你点按钮时发起，不进「跑完全部」。
 * 识别出的文字只显示在卡片里，不保存、不写进报告。
 */
import { describeError, scrub } from "./errors";
import type { ProbePort } from "./port";
import { VOICE_SERVICE_ID, voiceRequestId } from "./probes";

/** 听写最长等多久（毫秒）；Voice 允许 1 秒到 5 分钟。 */
export const DICTATION_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

export type DictationPhase =
  | "idle"
  | "starting"
  | "preparing"
  | "waiting_permission"
  | "listening"
  | "processing"
  | "completed"
  | "cancelled"
  | "failed"
  | "timed_out";

export const DICTATION_PHASE_LABELS: Record<DictationPhase, string> = {
  idle: "还没开始",
  starting: "正在发起",
  preparing: "准备中",
  waiting_permission: "等待麦克风授权",
  listening: "听写中，请说话",
  processing: "识别中",
  completed: "完成",
  cancelled: "已取消",
  failed: "失败",
  timed_out: "超时",
};

const TERMINAL = new Set<DictationPhase>(["idle", "completed", "cancelled", "failed", "timed_out"]);
const KNOWN = new Set<string>(Object.keys(DICTATION_PHASE_LABELS));

export interface DictationState {
  phase: DictationPhase;
  requestId?: string;
  /** Voice 状态的版本号，每变一次加一。 */
  revision?: number;
  captureStarted?: boolean;
  pcmReceived?: boolean | "unknown";
  /** 最终文字与类型：processed = 润色后，raw = 原文，raw_fallback = 润色失败退回原文。 */
  text?: string;
  kind?: string;
  /** 失败原因（人话）与错误码。 */
  message?: string;
  code?: string;
  /** 「说完了」「取消」的回执：Voice 收没收到。 */
  lastControl?: { action: "finish" | "cancel"; accepted: boolean };
}

export function isActive(state: DictationState): boolean {
  return !TERMINAL.has(state.phase);
}

function reasonOf(code: string): string {
  const bare = code.replace(/^com\.reai\.voice\//, "");
  if (bare === "VOICE_MIC_PERMISSION_REQUIRED") return "麦克风还没授权：到 Voice 设置里授权麦克风后再试";
  if (bare === "SERVICE_BUSY") return "Voice 正在录别的，等它结束再试";
  if (bare === "SERVICE_TIMEOUT") return "等太久了，这次听写超时结束";
  if (bare === "SERVICE_CANCELLED") return "这次听写被取消了";
  if (bare === "VOICE_REQUEST_SESSION_CHANGED") return "登录账号变了，这次听写作废";
  if (bare === "VOICE_ACCOUNT_UNAVAILABLE") return "读不到账号状态，没法听写";
  if (bare === "SERVICE_PROVIDER_UNAVAILABLE") return "Voice 服务现在调不了：可能没装、没启用，或你还没同意这个依赖";
  return "听写出错";
}

/**
 * 一次手动听写的控制器。同一时间只允许一次听写；界面每次重绘读 state，状态有变化时调用 onChange。
 */
export class VoiceDictation {
  state: DictationState = { phase: "idle" };
  private abort: AbortController | null = null;
  private poller: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly port: ProbePort, private readonly onChange: () => void, private readonly pollMs = POLL_MS) {}

  private set(patch: Partial<DictationState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.onChange();
  }

  /** 开始一次听写。已经有一次在进行就什么都不做。 */
  start(): void {
    if (this.disposed || isActive(this.state)) return;
    const requestId = voiceRequestId();
    const abort = new AbortController();
    this.abort = abort;
    this.state = { phase: "starting", requestId };
    this.onChange();
    void this.port
      .callService(VOICE_SERVICE_ID, "request-text", { requestId, timeoutMs: DICTATION_TIMEOUT_MS }, abort.signal)
      .then((output) => {
        if (this.abort !== abort) return;
        const value = output as { requestId?: unknown; text?: unknown; kind?: unknown } | null;
        if (value?.requestId !== requestId || typeof value.text !== "string") {
          this.finishWith({ phase: "failed", message: "Voice 返回的结果格式不对" });
          return;
        }
        this.finishWith({ phase: "completed", text: value.text, kind: typeof value.kind === "string" ? value.kind : undefined });
      })
      .catch((error: unknown) => {
        if (this.abort !== abort) return;
        const { code, message } = describeError(error);
        const bare = code.replace(/^com\.reai\.voice\//, "");
        const phase: DictationPhase = bare === "SERVICE_CANCELLED" ? "cancelled" : bare === "SERVICE_TIMEOUT" ? "timed_out" : "failed";
        this.finishWith({ phase, code, message: `${reasonOf(code)}${message ? `（${scrub(message, 160)}）` : ""}` });
      });
    this.schedulePoll(requestId);
  }

  /** 说完了：请 Voice 结束录音、开始识别。 */
  async finish(): Promise<void> {
    await this.control("finish");
  }

  async cancel(): Promise<void> {
    await this.control("cancel");
  }

  private async control(action: "finish" | "cancel"): Promise<void> {
    const requestId = this.state.requestId;
    if (!requestId || !isActive(this.state)) return;
    try {
      const reply = (await this.port.callService(VOICE_SERVICE_ID, action, { requestId })) as { accepted?: unknown } | null;
      if (this.state.requestId === requestId) this.set({ lastControl: { action, accepted: reply?.accepted === true } });
    } catch (error) {
      const { code } = describeError(error);
      if (this.state.requestId === requestId) this.set({ lastControl: { action, accepted: false }, code });
    }
  }

  /** 轮询 status，把 Voice 那边的阶段同步到卡片上；听写结束就停。 */
  private schedulePoll(requestId: string): void {
    this.clearPoll();
    if (this.disposed) return;
    this.poller = setTimeout(() => void this.poll(requestId), this.pollMs);
  }

  private async poll(requestId: string): Promise<void> {
    if (this.disposed || this.state.requestId !== requestId || !isActive(this.state)) return;
    try {
      const snapshot = (await this.port.callService(VOICE_SERVICE_ID, "status", { requestId })) as {
        phase?: unknown; revision?: unknown; captureStarted?: unknown; pcmReceived?: unknown; errorCode?: unknown;
      } | null;
      if (this.disposed || this.state.requestId !== requestId || !isActive(this.state)) return;
      const phase = typeof snapshot?.phase === "string" ? snapshot.phase : "";
      // 终态以 request-text 的返回为准；status 只更新进行中的阶段，not_found（刚发起还没登记）不覆盖。
      if (KNOWN.has(phase) && !TERMINAL.has(phase as DictationPhase)) {
        this.set({
          phase: phase as DictationPhase,
          ...(typeof snapshot?.revision === "number" ? { revision: snapshot.revision } : {}),
          ...(typeof snapshot?.captureStarted === "boolean" ? { captureStarted: snapshot.captureStarted } : {}),
          ...(typeof snapshot?.pcmReceived === "boolean" || snapshot?.pcmReceived === "unknown" ? { pcmReceived: snapshot.pcmReceived as boolean | "unknown" } : {}),
        });
      }
    } catch {
      // 偶尔查不到状态不影响听写本身，下一轮再查。
    }
    if (this.state.requestId === requestId && isActive(this.state)) this.schedulePoll(requestId);
  }

  private finishWith(patch: Partial<DictationState>): void {
    this.clearPoll();
    this.abort = null;
    this.set(patch);
  }

  private clearPoll(): void {
    if (this.poller !== null) clearTimeout(this.poller);
    this.poller = null;
  }

  /** 界面关掉：还在听写就请 Voice 取消，停止轮询。 */
  dispose(): void {
    if (this.disposed) return;
    const requestId = this.state.requestId;
    const active = isActive(this.state);
    this.disposed = true;
    this.clearPoll();
    if (active && requestId) void this.port.callService(VOICE_SERVICE_ID, "cancel", { requestId }).catch(() => undefined);
    this.abort?.abort();
    this.abort = null;
  }
}
