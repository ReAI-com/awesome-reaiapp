import { describe, expect, test } from "bun:test";
import { AppError } from "@reai/app-sdk/v1";
import { createHostVoiceAdapter, createUnavailableVoiceAdapter, VOICE_SERVICE_ID } from "../src/voice";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Call = { serviceId: string; method: string; input: Record<string, unknown>; signal?: AbortSignal };
function fixture() {
  const calls: Call[] = []; const result = deferred<unknown>();
  const fake = {
    phase: "listening", revision: 1,
    status: async (id: unknown): Promise<unknown> => ({ requestId: id, phase: fake.phase, revision: fake.revision, captureStarted: fake.phase === "listening", pcmReceived: "unknown" }),
    control: async (): Promise<unknown> => ({ accepted: true }),
    async call<T>(serviceId: string, method: string, input: unknown, options?: { signal?: AbortSignal }): Promise<T> {
      const value = input as Record<string, unknown>; calls.push({ serviceId, method, input: value, signal: options?.signal });
      if (method === "request-text") return result.promise as Promise<T>;
      if (method === "status") return fake.status(value.requestId) as Promise<T>;
      return fake.control() as Promise<T>;
    },
  };
  const voice = createHostVoiceAdapter(fake, { pollIntervalMs: 5 });
  const startId = () => String(calls.find(call => call.method === "request-text")!.input.requestId);
  return { voice, fake, calls, result, startId };
}
async function until(check: () => boolean) { const end = Date.now() + 1000; while (!check()) { if (Date.now() > end) throw new Error("Voice state did not change"); await new Promise(resolve => setTimeout(resolve, 2)); } }

describe("existing Voice text service consumer", () => {
  test("returns the original request result with a fresh ID and preserves raw fallback", async () => {
    const { voice, calls, result, startId } = fixture(); const phases: string[] = []; const stop = voice.subscribe(() => phases.push(voice.phase));
    const pending = voice.start(); const id = startId();
    expect(id).toMatch(/^\d+:\w{8}-\w{4}-4\w{3}-[89ab]\w{3}-\w{12}$/);
    expect(calls[0]).toMatchObject({ serviceId: VOICE_SERVICE_ID, method: "request-text", input: { requestId: id, timeoutMs: 180000 } });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    result.resolve({ requestId: id, text: "请核对这份资料", kind: "raw_fallback" });
    expect(await pending).toEqual({ requestId: id, text: "请核对这份资料", kind: "raw_fallback" });
    expect(phases).toEqual(["idle", "preparing", "completed"]); expect(voice.phase).toBe("completed"); stop(); voice.dispose();
  });
  test("finish acknowledges capture but cannot supply the recognized text", async () => {
    const { voice, calls, result, startId } = fixture(); const pending = voice.start(); let settled = false; void pending.then(() => { settled = true; });
    await until(() => voice.phase === "listening"); await voice.finish();
    expect(calls.find(call => call.method === "finish")?.input).toEqual({ requestId: startId() });
    expect(settled).toBe(false); expect(voice.phase).toBe("processing");
    result.resolve({ requestId: startId(), text: "最终文字", kind: "processed" }); expect((await pending).text).toBe("最终文字"); voice.dispose();
  });
  test("permission wait is distinct and cannot be finished as if recording had started", async () => {
    const { voice, fake, calls, result, startId } = fixture(); fake.phase = "waiting_permission"; const pending = voice.start();
    await until(() => voice.phase === "waiting_permission"); await expect(voice.finish()).rejects.toThrow("尚未开始");
    expect(calls.filter(call => call.method === "finish")).toHaveLength(0);
    result.resolve({ requestId: startId(), text: "随后完成", kind: "raw" }); await pending; voice.dispose();
  });
  test("one recording and one status request can run at a time", async () => {
    const { voice, fake, calls, result, startId } = fixture(); const status = deferred<unknown>(); fake.status = () => status.promise;
    const pending = voice.start(); await expect(voice.start()).rejects.toThrow("正在进行");
    await until(() => calls.some(call => call.method === "status")); await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls.filter(call => call.method === "status")).toHaveLength(1);
    result.resolve({ requestId: startId(), text: "完成", kind: "raw" }); await pending;
    status.resolve({ requestId: startId(), phase: "listening", revision: 1, captureStarted: true, pcmReceived: false });
    await Promise.resolve(); expect(voice.phase).toBe("completed"); voice.dispose();
  });
  test("cancel uses the exact business ID, aborts the request and suppresses late text", async () => {
    const { voice, calls, result, startId } = fixture(); const pending = voice.start(); const rejected = pending.then(() => { throw new Error("Unexpected success after cancellation"); }, error => error as Error);
    await voice.cancel(); expect((await rejected).message).toContain("取消");
    expect(calls.find(call => call.method === "cancel")?.input).toEqual({ requestId: startId() });
    expect(calls[0]!.signal!.aborted).toBe(true); expect(voice.phase).toBe("cancelled");
    result.resolve({ requestId: startId(), text: "迟到的内容", kind: "raw" }); await Promise.resolve(); expect(voice.phase).toBe("cancelled"); voice.dispose();
  });
  test("cancel acknowledgement failure remains visible and cannot become successful text", async () => {
    const { voice, fake, result, startId } = fixture(); fake.control = async () => ({ accepted: false });
    const pending = voice.start(); const rejected = pending.then(() => { throw new Error("Unexpected success after cancellation"); }, error => error as Error);
    await expect(voice.cancel()).rejects.toThrow("未获确认"); expect((await rejected).message).toContain("取消");
    expect(voice.phase).toBe("failed"); expect(voice.error).toContain("未获确认");
    result.resolve({ requestId: startId(), text: "迟到", kind: "processed" }); await Promise.resolve(); expect(voice.phase).toBe("failed"); voice.dispose();
  });
  test("provider errors retain the real user message and do not retry", async () => {
    const { voice, calls, result } = fixture(); const pending = voice.start();
    result.reject(new AppError({ code: "VOICE_REQUEST_SESSION_CHANGED", userMessage: "登录会话已变更，请重新开始", retryable: false }));
    await expect(pending).rejects.toThrow("登录会话已变更"); expect(voice.error).toBe("登录会话已变更，请重新开始");
    expect(voice.phase).toBe("failed"); expect(calls.filter(call => call.method === "request-text")).toHaveLength(1); voice.dispose();
  });
  test("status failures are visible while the original promise remains authoritative", async () => {
    const { voice, fake, result, startId } = fixture(); fake.status = async () => { throw new AppError({ code: "SERVICE_PROVIDER_UNAVAILABLE", userMessage: "状态服务暂不可用", retryable: false }); };
    const pending = voice.start(); await until(() => !!voice.error); expect(voice.error).toContain("状态服务暂不可用"); expect(voice.phase).toBe("preparing");
    result.resolve({ requestId: startId(), text: "原请求的最终结果", kind: "raw" }); expect((await pending).text).toContain("最终结果"); expect(voice.error).toBeUndefined(); voice.dispose();
  });
  test("a status completed phase is not a substitute for the final request result", async () => {
    const { voice, fake, result, startId } = fixture(); fake.phase = "completed"; let settled = false;
    const pending = voice.start(); void pending.then(() => { settled = true; }); await until(() => voice.phase === "processing");
    expect(settled).toBe(false); result.resolve({ requestId: startId(), text: "原请求结果", kind: "raw" }); await pending; voice.dispose();
  });
  test("malformed or wrong-owner results fail without inventing text", async () => {
    for (const wrong of [{ requestId: "other", text: "wrong", kind: "raw" }, { text: "wrong", kind: "unknown" }, { text: "", kind: "raw" }]) {
      const { voice, result, startId } = fixture(); const pending = voice.start(); result.resolve({ requestId: startId(), ...wrong });
      await expect(pending).rejects.toThrow("结果"); expect(voice.phase).toBe("failed"); voice.dispose();
    }
  });
  test("dispose cancels owned work and removes listeners", async () => {
    const { voice, calls, result, startId } = fixture(); let notifications = 0; voice.subscribe(() => { notifications++; });
    const pending = voice.start(); const rejected = pending.then(() => { throw new Error("Unexpected success after cancellation"); }, error => error as Error); voice.dispose(); expect((await rejected).message).toContain("取消");
    const before = notifications; result.resolve({ requestId: startId(), text: "迟到结果", kind: "raw" }); await Promise.resolve();
    expect(notifications).toBe(before); expect(calls.some(call => call.method === "cancel")).toBe(true); await expect(voice.start()).rejects.toThrow("关闭");
  });
  test("browser preview explicitly has no Voice instead of simulating capture", async () => {
    const voice = createUnavailableVoiceAdapter(); expect(voice.available).toBe(false); expect(voice.phase).toBe("idle");
    await expect(voice.start()).rejects.toThrow("ReAI"); expect(voice.phase).toBe("idle"); voice.dispose();
  });
  test("a close during the first preparing notification cancels before a late provider can return", async () => {
    const { voice, calls, result, startId } = fixture(); let cancellation: Promise<void> | undefined;
    voice.subscribe(() => { if (voice.phase === "preparing") cancellation = voice.cancel(); });
    const rejected = voice.start().then(() => { throw new Error("Unexpected success after cancellation"); }, error => error as Error);
    await cancellation;
    expect((await rejected).message).toContain("取消");
    expect(calls.find(call => call.method === "request-text")?.signal?.aborted).toBe(true);
    result.resolve({ requestId: startId(), text: "迟到结果", kind: "raw" }); voice.dispose();
  });
  test("a cancellation acknowledgement keeps the port busy until it settles", async () => {
    const { voice, fake, calls } = fixture(); const ack = deferred<unknown>(); fake.control = () => ack.promise;
    const pending = voice.start().catch(() => undefined); const cancelling = voice.cancel();
    expect(voice.phase).toBe("cancelling"); await expect(voice.start()).rejects.toThrow("正在进行");
    expect(calls.filter(call => call.method === "request-text")).toHaveLength(1);
    ack.resolve({ accepted: true }); await cancelling; await pending; voice.dispose();
  });
  test("provider timeout stays a terminal error without raw fallback", async () => {
    const { voice, result, calls } = fixture(); const pending = voice.start();
    result.reject(new AppError({ code: "SERVICE_TIMEOUT", userMessage: "语音请求超时", retryable: false }));
    await expect(pending).rejects.toThrow("超时"); expect(voice.phase).toBe("timed_out");
    expect(calls.filter(call => call.method === "request-text")).toHaveLength(1); voice.dispose();
  });
});
