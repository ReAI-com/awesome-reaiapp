import { describe, expect, test } from "bun:test";
import { AppError } from "@reai/app-sdk/v1";
import type { AppServicesClient, ServiceCaller, ServiceHandler, UiLocale, VoiceInputResult } from "@reai/app-sdk/v1";
import { prepareVoiceRequest } from "../src/voice-request-permission";
import { DEFAULT_SETTINGS } from "../src/data";
import { VoiceRequestAdmission } from "../src/voice-request-admission";
import { VoiceRequestTextProvider, type VoiceRequestTextPorts } from "../src/voice-request-text";
import { registerVoiceRequestTextService, VOICE_REQUEST_TEXT_SERVICE_ID } from "../src/voice-service-registration";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const caller = { appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime", accountGeneration: "epoch" };
const input = () => ({ requestId: `${Date.now()}:${crypto.randomUUID()}` });

async function harness(pollMs = 100_000, cleanupRetryMs?: number) {
  const capture = deferred<VoiceInputResult>();
  const finish = deferred<VoiceInputResult>();
  const polish = deferred<{ text: string; kind: "processed" }>();
  const actions: string[] = [];
  let busy = false;
  let current = true;
  let waiting!: () => void;
  const ports: VoiceRequestTextPorts = {
    reserve() { if (busy) return; busy = true; return () => { busy = false; }; },
    async prepare(_signal, report) { waiting = report; },
    async isAccountCurrent() { return current; },
    async start(options) { actions.push(`start:${options.insertText}:${options.captureDeliveryTarget}`); return capture.promise; },
    async finish(sessionId) { actions.push(`finish:${sessionId}`); return finish.promise; },
    async cancelPendingStart() { actions.push("cancel-pending"); },
    async cancel(sessionId) { actions.push(`cancel:${sessionId}`); },
    async acknowledge(sessionId) { actions.push(`ack:${sessionId}`); },
    async readStatus() { return { phase: "listening" }; },
    async process() { actions.push("process"); return polish.promise; },
  };
  const admission = await VoiceRequestAdmission.open({ read: async () => undefined, write: async () => undefined });
  const provider = new VoiceRequestTextProvider(admission, ports, { pollMs, ...(cleanupRetryMs === undefined ? {} : { cleanupRetryMs }) });
  return { provider, ports, actions, capture, finish, polish, busy: () => busy, setCurrent: (value: boolean) => { current = value; }, waiting: () => waiting() };
}

describe("Voice request-text 原Promise", () => {
  for (const targetLocale of ["zh", "en"] as const) {
    for (const scenario of [
      { code: "CLOUD_MODEL_SELECTION_REQUIRED", wireCode: "CLOUD_MODEL_SELECTION_REQUIRED", resource: "cloud" },
      { code: "com.other/CLOUD_MODEL_SELECTION_REQUIRED", wireCode: "SERVICE_PROVIDER_FAILED", resource: "generic" },
      { code: "com.reai.voice/UNREGISTERED_CLOUD_SELECTION", wireCode: "SERVICE_PROVIDER_FAILED", resource: "generic" },
      { code: "SERVICE_CANCELLED", wireCode: "SERVICE_CANCELLED", resource: "cancelled" },
    ] as const) {
      test(`cloud selection service mapping control keeps current locale and code gate: ${scenario.code}/${targetLocale}`, async () => {
        const h = await harness();
        let locale: UiLocale = targetLocale === "zh" ? "en" : "zh";
        const handlers = new Map<string, ServiceHandler>();
        const services: AppServicesClient = {
          provide(_serviceId, method, handler) { handlers.set(method, handler as ServiceHandler); },
          async call<T>() { throw new Error("unused"); },
        };
        registerVoiceRequestTextService(services, h.provider, () => locale);
        h.ports.prepare = async () => {
          locale = targetLocale;
          throw { code: scenario.code, userMessage: "private provider detail" };
        };
        const resources = targetLocale === "zh" ? zh : en;
        const expected = scenario.resource === "cloud" ? resources.view.cloudModelsUnavailable
          : scenario.resource === "cancelled" ? resources.service.cancelled : resources.service.providerFailed;
        try {
          const error = await Promise.resolve(handlers.get("request-text")!({ caller, input: input(), signal: new AbortController().signal })).catch(error => error);
          if (!(error instanceof AppError)) throw new Error("Expected a structured service AppError");
          expect(error.toWire()).toMatchObject({ code: scenario.wireCode, userMessage: expected, retryable: false });
          expect(JSON.stringify(error.toWire())).not.toContain("private provider detail");
          expect(h.actions).toEqual([]);
          expect(h.busy()).toBeFalse();
        } finally { h.provider.dispose(); }
      });
    }
  }

  for (const stopReason of [undefined, "capture_limit"]) {
    test(`异步结束保留识别错误，立即清理而非等待超时：${stopReason ?? "overlay-finish"}`, async () => {
      const h = await harness(1);
      const req = input();
      h.ports.readStatus = async () => ({
        phase: "idle", sessionId: "s1", stopReason,
        resultError: { code: "VOICE_EMPTY_TRANSCRIPT", message: "no speech" },
      });
      const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
      const rejected = result.catch((error) => error);
      try {
        h.capture.resolve({ phase: "listening", sessionId: "s1" });
        for (let i = 0; i < 50 && h.provider.status(caller, req).phase !== "failed"; i++) await tick();
        expect(h.provider.status(caller, req)).toMatchObject({ phase: "failed", errorCode: "VOICE_EMPTY_TRANSCRIPT" });
        expect(await rejected).toMatchObject({ code: "VOICE_EMPTY_TRANSCRIPT" });
        await tick();
        expect(h.actions).not.toContain("process");
        expect(h.actions).toContain("ack:s1");
        expect(h.busy()).toBe(false);
      } finally { h.provider.dispose(); await rejected; }
    });
  }
  test("等待和真实listening分开；二触finish只让原请求一次返文", async () => {
    const h = await harness();
    const req = input();
    let returns = 0;
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal }).then((value) => { returns++; return value; });
    await tick();
    expect(h.provider.status(caller, req).phase).toBe("preparing");
    expect(returns).toBe(0);
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    expect(h.provider.status(caller, req)).toMatchObject({ phase: "listening", captureStarted: true, pcmReceived: "unknown" });
    expect(h.provider.finish(caller, req).accepted).toBe(true);
    expect(h.provider.finish(caller, req).accepted).toBe(true);
    expect(returns).toBe(0);
    h.finish.resolve({ phase: "idle", sessionId: "s1", outcome: "recognized", transcript: "raw" });
    await tick();
    expect(h.provider.status(caller, req).phase).toBe("processing");
    h.polish.resolve({ text: "final", kind: "processed" });
    expect(await result).toEqual({ requestId: req.requestId, text: "final", kind: "processed" });
    await tick();
    expect(returns).toBe(1);
    expect(h.actions.filter((action) => action === "finish:s1")).toHaveLength(1);
    expect(h.actions).toContain("start:false:false");
    expect(JSON.stringify(h.provider.status(caller, req))).not.toContain("final");
    expect(h.busy()).toBe(false);
  });

  test("缺代际请求直接 fail-closed（台账必做项：1.0 合同必填）", async () => {
    const h = await harness();
    const legacyCaller: ServiceCaller = { appId: "consumer", surfaceMountId: "mount", runtimeSessionId: "runtime" };
    // Host 代际不可读时信封省略字段：ownerKey 直接拒绝，不占用采集槽。
    await expect(h.provider.request({ caller: legacyCaller, input: input(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "VOICE_REQUEST_IDENTITY_REQUIRED" });
    expect(h.busy()).toBe(false);
    // 带代际的正常请求照常受理并能在取消后释放槽位。
    const req = input();
    const op = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = op.then(() => undefined, (error) => error);
    await tick();
    expect(h.provider.status(caller, req).phase).toBe("preparing");
    h.provider.cancel(caller, req);
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    // 迟到启动回执只做精确清理，之后才释放槽。
    h.capture.resolve({ phase: "listening", sessionId: "late-legacy" });
    await tick();
    await tick();
    expect(h.busy()).toBe(false);
  });

  test("代际A→B：A的旧op失效；再回A时B的旧op同样失效", async () => {
    const h = await harness();
    const callerA: ServiceCaller = { ...caller, accountGeneration: "gen-a" };
    const callerB: ServiceCaller = { ...caller, accountGeneration: "gen-b" };
    const first = input();
    const opA = h.provider.request({ caller: callerA, input: first, signal: new AbortController().signal });
    const rejectedA = opA.then(() => undefined, (error) => error);
    await tick();
    expect(h.provider.status(callerA, first).phase).toBe("preparing");
    await expect(h.provider.request({ caller: callerB, input: input(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    expect(await rejectedA).toMatchObject({ code: "VOICE_REQUEST_SESSION_CHANGED" });
    h.capture.resolve({ phase: "listening", sessionId: "late-a" });
    await tick();
    await tick();
    expect(h.busy()).toBe(false);

    const second = input();
    const opB = h.provider.request({ caller: callerB, input: second, signal: new AbortController().signal });
    const rejectedB = opB.then(() => undefined, (error) => error);
    await tick();
    await tick();
    // capture 已在上段 resolve，opB 直接进入真实 listening。
    expect(h.provider.status(callerB, second)).toMatchObject({ phase: "listening", captureStarted: true });
    // 代际回到 A：B 的旧 op 失效；回到 A 的新请求同样只拿到 busy。
    await expect(h.provider.request({ caller: callerA, input: input(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    expect(await rejectedB).toMatchObject({ code: "VOICE_REQUEST_SESSION_CHANGED" });
    await tick();
    await tick();
    expect(h.busy()).toBe(false);
  });

  test("start返回前取消立即拒绝；晚到session精确清理前保留busy", async () => {
    const h = await harness();
    const controller = new AbortController();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: controller.signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    controller.abort();
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    expect(h.busy()).toBe(true);
    await expect(h.provider.request({ caller, input: input(), signal: new AbortController().signal })).rejects.toMatchObject({ code: "SERVICE_BUSY" });
    h.capture.resolve({ phase: "listening", sessionId: "late-s1" });
    await tick();
    expect(h.actions).toContain("cancel:late-s1");
    expect(h.actions).not.toContain("process");
    expect(h.busy()).toBe(false);
  });

  test("其他caller不能status/finish/cancel原请求，已有录音返回busy", async () => {
    const h = await harness();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    const other = { ...caller, runtimeSessionId: "other" };
    expect(h.provider.status(other, req).phase).toBe("not_found");
    expect(h.provider.finish(other, req).accepted).toBe(false);
    await h.provider.cancel(other, req);
    expect(h.provider.status(caller, req).phase).toBe("preparing");
    await h.provider.cancel(caller, req);
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
  });

  test("润色晚到时已换账号，原请求失败且不回退成功", async () => {
    const h = await harness();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    h.provider.finish(caller, req);
    h.finish.resolve({ phase: "idle", sessionId: "s1", transcript: "old account" });
    await tick();
    h.setCurrent(false);
    h.polish.resolve({ text: "late old account", kind: "processed" });
    expect(await rejected).toMatchObject({ code: "VOICE_REQUEST_SESSION_CHANGED" });
    await tick();
    expect(h.provider.status(caller, req).phase).toBe("failed");
  });

  test("cancel先于原服务请求，迟到请求不启动采集", async () => {
    const h = await harness();
    const req = input();
    expect(await h.provider.cancel(caller, req)).toEqual({ accepted: true });
    await expect(h.provider.request({ caller, input: req, signal: new AbortController().signal })).rejects.toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(h.actions).toEqual([]);
    expect(h.busy()).toBe(false);
  });

  test("真实权限等待回执后才报waiting_permission，期间取消没有start", async () => {
    const h = await harness();
    const permission = deferred<void>();
    h.ports.prepare = async (_signal, report) => { report(); await permission.promise; };
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    expect(h.provider.status(caller, req)).toMatchObject({ phase: "waiting_permission", captureStarted: false });
    await h.provider.cancel(caller, req);
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    expect(h.actions).toEqual([]);
    permission.resolve();
    await tick();
    expect(h.actions).toEqual([]);
    expect(h.busy()).toBe(false);
  });

  test("R1：入口重试自愈——清理传输失败后新请求不再永久 busy", async () => {
    const h = await harness();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejectedFirst = result.then(() => undefined, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    let acknowledgeAttempts = 0;
    h.ports.acknowledge = async () => {
      acknowledgeAttempts += 1;
      if (acknowledgeAttempts <= 1) throw new Error("ack unavailable");
    };
    await h.provider.cancel(caller, req);
    expect(await rejectedFirst).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(h.busy()).toBe(true);
    expect(h.provider.status(caller, req).errorCode).toBe("VOICE_CAPTURE_CLEANUP_REQUIRED");
    // 不再手动 retryCleanup：新请求入口自带重试，清理成功后本次请求照常受理。
    const secondReq = input();
    const second = h.provider.request({ caller, input: secondReq, signal: new AbortController().signal });
    const rejectedSecond = second.then(() => undefined, (error) => error);
    await tick();
    await tick();
    // 第二个请求未被 SERVICE_BUSY 拒绝：清理已自愈、槽位已接给新请求。
    expect(acknowledgeAttempts).toBeGreaterThanOrEqual(2);
    expect(h.busy()).toBe(true);
    h.provider.cancel(caller, secondReq);
    expect(await rejectedSecond).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    await tick();
    expect(h.busy()).toBe(false);
  });

  test("R1：周期重试自愈——无新请求时槽位与界面也能恢复", async () => {
    const h = await harness(100_000, 5);
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    let acknowledged = 0;
    h.ports.acknowledge = async () => {
      acknowledged += 1;
      if (acknowledged <= 1) throw new Error("ack unavailable");
    };
    await h.provider.cancel(caller, req);
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(h.busy()).toBe(true);
    // 不发起新请求、不手动 retryCleanup：等待周期重试（5ms 间隔）自愈。
    const deadline = Date.now() + 2_000;
    while (h.busy() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(h.busy()).toBe(false);
    expect(acknowledged).toBeGreaterThanOrEqual(2);
    expect(h.provider.status(caller, req).errorCode).toBe("SERVICE_CANCELLED");
  });

  test("清理失败保留busy，精确清理重试完成才释放", async () => {
    const h = await harness();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    h.ports.acknowledge = async () => { throw new Error("ack unavailable"); };
    await h.provider.cancel(caller, req);
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(h.busy()).toBe(true);
    expect(h.provider.status(caller, req).errorCode).toBe("VOICE_CAPTURE_CLEANUP_REQUIRED");
    h.ports.acknowledge = async () => undefined;
    h.provider.retryCleanup();
    await tick();
    expect(h.busy()).toBe(false);
    expect(h.provider.status(caller, req).errorCode).toBe("SERVICE_CANCELLED");
  });

  test("R2：processing 窗口的 finish 幂等 accepted，不误报失败也不重复发 IPC", async () => {
    const h = await harness(1);
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    // 轮询先观测到 recognizing：phase=processing，但 receive 尚未把 op.processing 置位。
    h.ports.readStatus = async () => ({ phase: "recognizing", sessionId: "s1" });
    const deadline = Date.now() + 2_000;
    while (h.provider.status(caller, req).phase !== "processing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(h.provider.status(caller, req).phase).toBe("processing");
    // 窗口内的重复 finish：幂等 accepted，不再发第二次结束 IPC。
    expect(h.provider.finish(caller, req)).toEqual({ accepted: true });
    expect(h.actions.filter((action) => action.startsWith("finish:"))).toHaveLength(0);
    // 请求仍沿轮询正常完成，不需要 consumer 再做任何事。
    h.ports.readStatus = async () => ({ phase: "idle", sessionId: "s1", result: { phase: "idle", sessionId: "s1", outcome: "recognized", transcript: "raw" } });
    h.polish.resolve({ text: "done", kind: "processed" });
    expect(await result).toMatchObject({ text: "done" });
    await tick();
  });

  test("硬件或上限的异步终态沿轮询回原请求，不要求consumer再录一次", async () => {
    const h = await harness(1);
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    await tick();
    h.ports.readStatus = async () => ({ phase: "idle", sessionId: "s1", pcmReceived: true, result: { phase: "idle", sessionId: "s1", outcome: "recognized", transcript: "raw" } });
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.provider.status(caller, req)).toMatchObject({ phase: "processing", pcmReceived: true });
    expect(h.provider.finish(caller, req).accepted).toBe(true);
    h.polish.resolve({ text: "automatic", kind: "processed" });
    expect(await result).toMatchObject({ text: "automatic" });
    await tick();
    expect(h.actions.filter((action) => action === "process")).toHaveLength(1);
    expect(h.actions.some((action) => action.startsWith("finish:"))).toBe(false);
    expect(h.actions.filter((action) => action.startsWith("start:"))).toHaveLength(1);
  });

  test("总deadline在start返回前到期仍立即拒绝，晚到session不复活", async () => {
    const h = await harness();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal, deadlineUnixMs: Date.now() + 15 });
    const rejected = result.then(() => undefined, (error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await rejected).toMatchObject({ code: "SERVICE_TIMEOUT" });
    expect(h.provider.status(caller, req)).toMatchObject({ phase: "timed_out", captureStarted: false });
    expect(h.busy()).toBe(true);
    h.capture.resolve({ phase: "listening", sessionId: "timed-out-session" });
    await tick();
    expect(h.actions).toContain("cancel:timed-out-session");
    expect(h.busy()).toBe(false);
  });

  test("start IPC失败但无session时，精确handle取消尚未回执不能释放busy", async () => {
    const h = await harness();
    const cancel = deferred<void>();
    h.ports.cancelPendingStart = async () => cancel.promise;
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    h.capture.reject(new Error("IPC disconnected"));
    expect(await rejected).toMatchObject({ code: "SERVICE_PROVIDER_FAILED" });
    expect(h.busy()).toBe(true);
    cancel.resolve();
    await tick();
    expect(h.busy()).toBe(false);
  });

  test("身份检查已返回、start调用恢复前的取消微任务仍阻止采集", async () => {
    const h = await harness();
    const barrier = deferred<boolean>();
    let checks = 0;
    h.ports.isAccountCurrent = () => ++checks === 2 ? barrier.promise : Promise.resolve(true);
    const controller = new AbortController();
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: controller.signal });
    const rejected = result.then(() => undefined, (error) => error);
    await tick();
    expect(checks).toBe(2);
    barrier.resolve(true);
    queueMicrotask(() => controller.abort());
    expect(await rejected).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(h.actions).toEqual([]);
    expect(h.busy()).toBe(false);
  });

  test("轮询已接纳真实终态后，finish IPC迟到错误不反杀同一处理", async () => {
    const h = await harness(1);
    const req = input();
    const result = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    h.provider.finish(caller, req);
    h.ports.readStatus = async () => ({ phase: "idle", sessionId: "s1", result: { phase: "idle", sessionId: "s1", outcome: "recognized", transcript: "raw" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.provider.status(caller, req).phase).toBe("processing");
    h.finish.reject(new Error("late IPC error"));
    await tick();
    h.polish.resolve({ text: "kept", kind: "processed" });
    expect(await result).toMatchObject({ text: "kept" });
    await tick();
    expect(h.actions.filter((action) => action === "process")).toHaveLength(1);
    expect(h.busy()).toBe(false);
  });

  for (const locale of ["zh", "en"] as const) {
    for (const missing of [true, false]) {
      test(`real preparation errors retain specific consumer guidance: ${locale}/${missing ? "upgrade" : "microphone"}`, async () => {
        const h = await harness();
        h.ports.prepare = (signal, report) => prepareVoiceRequest({
          async configure() {},
          async checkPermissions() { return { microphone: "denied", accessibility: "granted", ...(missing ? {} : { microphoneRequired: true }) }; },
        }, DEFAULT_SETTINGS, signal, report, { cancelled: "cancelled", upgrade: "private helper detail", microphone: "private helper detail" });
        const handlers = new Map<string, ServiceHandler>();
        const services: AppServicesClient = {
          provide(_serviceId, method, handler) { handlers.set(method, handler as ServiceHandler); },
          async call<T>() { throw new Error("unused"); },
        };
        registerVoiceRequestTextService(services, h.provider, () => locale);
        try {
          const error = await Promise.resolve(handlers.get("request-text")!({ caller, input: input(), signal: new AbortController().signal })).catch((error) => error);
          expect(error).toMatchObject({ code: missing ? "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED" : "com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED" });
          expect(error).toMatchObject({ userMessage: expect.stringContaining(missing ? (locale === "zh" ? "升级 ReAI Board" : "Update ReAI Board") : (locale === "zh" ? "授权电脑麦克风" : "Allow the computer microphone")) });
          expect(JSON.stringify(error)).not.toContain("private helper detail");
          expect(h.actions).not.toContain("start:false:false");
          expect(h.busy()).toBe(false);
        } finally { h.provider.dispose(); }
      });
    }
  }

  for (const code of ["com.reai.voice/VOICE_EMPTY_TRANSCRIPT", "VOICE_EMPTY_TRANSCRIPT"]) {
    for (const targetLocale of ["en", "zh"] as const) {
      test(`空转写服务返回时使用当前语言并保留错误码：${code}/${targetLocale}`, async () => {
        const h = await harness();
        let locale: UiLocale = targetLocale === "en" ? "zh" : "en";
        const handlers = new Map<string, ServiceHandler>();
        const services: AppServicesClient = {
          provide(_serviceId, method, handler) { handlers.set(method, handler as ServiceHandler); },
          async call<T>() { throw new Error("unused"); },
        };
        registerVoiceRequestTextService(services, h.provider, () => locale);
        h.ports.process = async () => { throw { code, userMessage: "private original diagnostic" }; };
        const req = input();
        const invocation = { caller, input: req, signal: new AbortController().signal };
        const rejected = Promise.resolve(handlers.get("request-text")!(invocation)).catch(error => error);
        try {
          await tick();
          h.capture.resolve({ phase: "listening", sessionId: "s1" });
          await tick();
          locale = targetLocale;
          await handlers.get("finish")!(invocation);
          h.finish.resolve({ phase: "idle", sessionId: "s1", transcript: "" });
          const error = await rejected;
          if (!(error instanceof AppError)) throw new Error("Expected a structured service AppError");
          expect(error).toMatchObject({ code, userMessage: targetLocale === "en"
            ? "Nothing was heard. Please say it again." : "没有听清，请再说一次" });
          expect(JSON.stringify(error.toWire())).not.toContain("private original diagnostic");
          expect(h.provider.status(caller, req)).toMatchObject({ phase: "failed", errorCode: code });
          expect(h.busy()).toBeFalse();
        } finally { h.provider.dispose(); await rejected; }
      });
    }
  }

  test("注册层消费当前locale且不把处理异常的私有诊断发给consumer", async () => {
    const h = await harness();
    const handlers = new Map<string, ServiceHandler>();
    const services: AppServicesClient = {
      provide(serviceId, method, handler) { handlers.set(`${serviceId}#${method}`, handler as ServiceHandler); },
      async call<T>(serviceId: string, method: string, input: unknown, options?: { signal?: AbortSignal }): Promise<T> {
        return await handlers.get(`${serviceId}#${method}`)!({ caller, input, signal: options?.signal ?? new AbortController().signal }) as T;
      },
    };
    let locale: UiLocale = "en";
    registerVoiceRequestTextService(services, h.provider, () => locale);
    const req = input();
    const pending = services.call(VOICE_REQUEST_TEXT_SERVICE_ID, "request-text", req);
    const rejected = pending.then(() => undefined, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    h.ports.process = async () => { throw new Error("private diagnostic fixture"); };
    await services.call(VOICE_REQUEST_TEXT_SERVICE_ID, "finish", req);
    h.finish.resolve({ phase: "idle", sessionId: "s1", transcript: "raw" });
    const error = await rejected;
    expect(error).toMatchObject({ code: "SERVICE_PROVIDER_FAILED", userMessage: "Dictation could not finish. Try again later." });
    expect(JSON.stringify(error.toWire())).not.toContain("private diagnostic fixture");
    locale = "zh";
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(services.call(VOICE_REQUEST_TEXT_SERVICE_ID, "request-text", input(), { signal: cancelled.signal })).rejects.toMatchObject({ userMessage: "听写已取消" });
    await expect(services.call(VOICE_REQUEST_TEXT_SERVICE_ID, "status", { ...req, audio: "not allowed" })).rejects.toMatchObject({ code: "VOICE_REQUEST_INVALID" });
    await tick();
    expect(h.busy()).toBe(false);
  });

  test("最终身份检查返回到resolve前的取消微任务不能交付晚到文字", async () => {
    const h = await harness();
    const barrier = deferred<boolean>();
    let checks = 0;
    h.ports.isAccountCurrent = () => ++checks === 6 ? barrier.promise : Promise.resolve(true);
    const controller = new AbortController();
    const req = input();
    let deliveries = 0;
    const pending = h.provider.request({ caller, input: req, signal: controller.signal });
    const outcome = pending.then(() => { deliveries++; return undefined; }, (error) => error);
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await tick();
    h.provider.finish(caller, req);
    h.finish.resolve({ phase: "idle", sessionId: "s1", transcript: "raw" });
    await tick();
    h.polish.resolve({ text: "late", kind: "processed" });
    await tick();
    expect(checks).toBe(6);
    barrier.resolve(true);
    queueMicrotask(() => controller.abort());
    expect(await outcome).toMatchObject({ code: "SERVICE_CANCELLED" });
    await tick();
    expect(deliveries).toBe(0);
    expect(h.busy()).toBe(false);
  });

  test("finish已开始处理后，旧poll读取失败不反杀结果", async () => {
    const h = await harness(1);
    const read = deferred<Awaited<ReturnType<VoiceRequestTextPorts["readStatus"]>>>();
    h.ports.readStatus = () => read.promise;
    const req = input();
    const pending = h.provider.request({ caller, input: req, signal: new AbortController().signal });
    await tick();
    h.capture.resolve({ phase: "listening", sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.provider.finish(caller, req);
    h.finish.resolve({ phase: "idle", sessionId: "s1", transcript: "raw" });
    await tick();
    read.reject(new Error("stale status read failure"));
    await tick();
    h.polish.resolve({ text: "final", kind: "processed" });
    expect(await pending).toMatchObject({ text: "final" });
    await tick();
    expect(h.actions.filter((action) => action === "process")).toHaveLength(1);
    expect(h.busy()).toBe(false);
  });
});

test("account replacement aborts suspended AI processing without a new request or AI reply", async () => {
  const h = await harness(1);
  const req = input();
  let processSignal: AbortSignal | undefined;
  h.ports.process = async (_result, signal) => { processSignal = signal; return h.polish.promise; };
  const outcome = h.provider.request({ caller, input: req, signal: new AbortController().signal })
    .then(() => "unexpected-success", (error) => error.code);
  try {
    h.capture.resolve({ phase: "listening", sessionId: "epoch-ai" });
    await tick();
    h.provider.finish(caller, req);
    h.finish.resolve({ phase: "idle", sessionId: "epoch-ai", outcome: "recognized", transcript: "raw" });
    await tick();
    expect(processSignal).toBeDefined();
    h.setCurrent(false);
    const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still-running"), 40))]);
    expect(result).toBe("VOICE_REQUEST_SESSION_CHANGED");
    expect(processSignal?.aborted).toBe(true);
    expect(h.busy()).toBe(true);
  } finally {
    h.provider.dispose();
    h.polish.resolve({ text: "late", kind: "processed" });
    await outcome;
    await tick();
  }
  expect(h.busy()).toBe(false);
});

test("account replacement cancels while permission is pending, without starting audio", async () => {
  const h = await harness(1);
  const permission = deferred<void>();
  h.ports.prepare = async (_signal, report) => { report(); await permission.promise; };
  const outcome = h.provider.request({ caller, input: input(), signal: new AbortController().signal })
    .then(() => "unexpected-success", (error) => error.code);
  try {
    await tick();
    h.setCurrent(false);
    const result = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still-running"), 40))]);
    expect(result).toBe("VOICE_REQUEST_SESSION_CHANGED");
    expect(h.actions.some((action) => action.startsWith("start:"))).toBe(false);
  } finally {
    h.provider.dispose();
    permission.resolve();
    await outcome;
    await tick();
  }
  expect(h.busy()).toBe(false);
});
