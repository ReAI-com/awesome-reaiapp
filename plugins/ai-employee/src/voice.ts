import type { AppServicesClient } from "@reai/app-sdk/v1";

export const VOICE_SERVICE_ID = "com.reai.voice/request-text@1";
export type VoicePhase = "idle" | "preparing" | "waiting_permission" | "listening" | "processing" | "cancelling" | "completed" | "cancelled" | "failed" | "timed_out";
export interface VoiceResult { requestId: string; text: string; kind: "processed" | "raw" | "raw_fallback" }
export interface VoicePort {
  readonly available: boolean;
  readonly phase: VoicePhase;
  readonly error?: string;
  subscribe(listener: () => void): () => void;
  start(): Promise<VoiceResult>;
  finish(): Promise<void>;
  cancel(): Promise<void>;
  dispose(): void;
}
export interface VoiceAdapterOptions { pollIntervalMs?: number }
type ServicePort = Pick<AppServicesClient, "call">;
interface Operation {
  id: string;
  controller: AbortController;
  progressController: AbortController;
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  finishing: boolean;
  cancelPromise?: Promise<void>;
}
const phases = new Set(["not_found", "preparing", "waiting_permission", "listening", "processing", "completed", "cancelled", "failed", "timed_out"]);
const rank: Partial<Record<VoicePhase, number>> = { preparing: 0, waiting_permission: 1, listening: 2, processing: 3 };
function message(error: unknown): string {
  if (error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string") return error.userMessage;
  return error instanceof Error ? error.message : "语音服务请求失败";
}
function code(error: unknown): string | undefined { return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function acknowledged(value: unknown): boolean { return !!value && typeof value === "object" && "accepted" in value && value.accepted === true; }

/** Consume the existing Voice service. Host and Voice own capture and permission. */
export function createHostVoiceAdapter(services: ServicePort, options: VoiceAdapterOptions = {}): VoicePort {
  let phase: VoicePhase = "idle"; let error: string | undefined; let active: Operation | undefined; let disposed = false;
  const listeners = new Set<() => void>();
  const interval = Math.max(1, options.pollIntervalMs ?? 1000);
  const emit = () => { if (!disposed) for (const listener of listeners) { try { listener(); } catch { /* A view failure cannot change service ownership. */ } } };
  const live = (op: Operation) => !disposed && active === op && !op.cancelled;
  const stopProgress = (op: Operation) => { if (op.timer !== undefined) clearTimeout(op.timer); op.timer = undefined; op.progressController.abort(); };
  const schedule = (op: Operation) => {
    if (!live(op)) return;
    op.timer = setTimeout(() => { op.timer = undefined; void poll(op); }, interval);
  };
  const poll = async (op: Operation): Promise<void> => {
    try {
      const raw = await services.call<unknown>(VOICE_SERVICE_ID, "status", { requestId: op.id }, { signal: op.progressController.signal });
      if (!live(op)) return;
      const status = raw as { requestId?: unknown; phase?: unknown; revision?: unknown; captureStarted?: unknown; pcmReceived?: unknown; errorCode?: unknown } | null;
      if (!status || status.requestId !== op.id || typeof status.phase !== "string" || !phases.has(status.phase) || !Number.isSafeInteger(status.revision) || Number(status.revision) < 0 || typeof status.captureStarted !== "boolean" || ![true, false, "unknown"].includes(status.pcmReceived as boolean | string)) throw new Error("语音状态结果无效；仍等待原请求结果");
      if (Number(status.revision) <= op.revision || status.phase === "not_found") return;
      op.revision = Number(status.revision);
      if (["preparing", "waiting_permission", "listening", "processing"].includes(status.phase)) {
        const next = status.phase as VoicePhase;
        if ((rank[next] ?? 0) >= (rank[phase] ?? 0)) phase = next;
      } else {
        // A status terminal phase carries no text. The original call remains authoritative.
        phase = "processing";
      }
      error = typeof status.errorCode === "string" ? `语音服务状态：${status.errorCode}；等待原请求结果` : undefined;
      emit();
    } catch (failure) { if (live(op)) { error = message(failure); emit(); } }
    finally { schedule(op); }
  };
  const port: VoicePort = {
    get available() { return !disposed; },
    get phase() { return phase; },
    get error() { return error; },
    subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
    async start() {
      if (disposed) throw new Error("语音入口已关闭");
      if (active) throw new Error("语音请求正在进行，请先结束或取消");
      const op: Operation = { id: `${Date.now()}:${crypto.randomUUID()}`, controller: new AbortController(), progressController: new AbortController(), revision: -1, cancelled: false, finishing: false };
      active = op; phase = "preparing"; error = undefined; emit();
      let rejectAbort!: (reason: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new Error("语音请求已取消"));
      op.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (op.controller.signal.aborted) onAbort();
      try {
        const original = services.call<unknown>(VOICE_SERVICE_ID, "request-text", { requestId: op.id, timeoutMs: 180000 }, { signal: op.controller.signal });
        schedule(op);
        const value = await Promise.race([original, aborted]);
        if (!live(op)) throw new Error("语音请求已取消");
        const result = value as Partial<VoiceResult> | null;
        if (!result || result.requestId !== op.id || typeof result.text !== "string" || !result.text.trim() || !["processed", "raw", "raw_fallback"].includes(String(result.kind))) throw new Error("语音服务结果无效，请重新开始");
        phase = "completed"; error = undefined; emit();
        return { requestId: op.id, text: result.text, kind: result.kind as VoiceResult["kind"] };
      } catch (failure) {
        if (active === op && !op.cancelled) { phase = code(failure) === "SERVICE_TIMEOUT" ? "timed_out" : code(failure) === "SERVICE_CANCELLED" ? "cancelled" : "failed"; error = message(failure); emit(); }
        throw failure instanceof Error ? failure : new Error(message(failure));
      } finally {
        op.controller.signal.removeEventListener("abort", onAbort); stopProgress(op);
        if (active === op && !op.cancelled) active = undefined;
      }
    },
    async finish() {
      const op = active;
      if (!op || op.cancelled || phase !== "listening") throw new Error("录音尚未开始，不能结束录音");
      if (op.finishing) return;
      op.finishing = true;
      try {
        const ack = await services.call<unknown>(VOICE_SERVICE_ID, "finish", { requestId: op.id });
        if (!live(op)) return;
        if (!acknowledged(ack)) throw new Error("结束录音未获确认，请查看语音状态");
        phase = "processing"; error = undefined; emit();
      } catch (failure) { if (live(op)) { error = message(failure); emit(); } throw failure; }
      finally { op.finishing = false; }
    },
    async cancel() {
      const op = active; if (!op) return;
      if (op.cancelPromise) return op.cancelPromise;
      op.cancelled = true; phase = "cancelling"; error = undefined; stopProgress(op); op.controller.abort(); emit();
      op.cancelPromise = (async () => {
        try {
          const ack = await services.call<unknown>(VOICE_SERVICE_ID, "cancel", { requestId: op.id });
          if (!acknowledged(ack)) throw new Error("取消语音未获确认，请检查 Voice 状态");
          phase = "cancelled"; error = undefined;
        } catch (failure) { phase = "failed"; error = message(failure); throw failure; }
        finally { if (active === op) active = undefined; emit(); }
      })();
      return op.cancelPromise;
    },
    dispose() { if (disposed) return; disposed = true; listeners.clear(); void port.cancel().catch(() => undefined); },
  };
  return port;
}

export function createUnavailableVoiceAdapter(reason = "语音需要在 ReAI App 中调用已安装的 Voice；浏览器预览无法录音"): VoicePort {
  return { available: false, phase: "idle", error: reason, subscribe(listener) { listener(); return () => undefined; }, async start() { throw new Error(reason); }, async finish() { throw new Error(reason); }, async cancel() {}, dispose() {} };
}
