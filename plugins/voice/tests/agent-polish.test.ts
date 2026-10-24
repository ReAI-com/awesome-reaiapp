import { expect, test } from "bun:test";

import { polishTranscriptWithAgent, wrapTranscript } from "../src/voice-polish";

test("Agent 润色创建 one-shot 无工具会话并返回有效短文本", async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const result = await polishTranscriptWithAgent(
    {
      backend: "dsh",
      newId: () => "turn-1",
      agent: {
        async createSession(spec) {
          calls.push({ method: "create", value: spec });
          return { sessionId: "agent2-one", backend: "dsh" };
        },
        async send() { throw new Error("v2 must not use legacy send"); },
        async startTurn(options) {
          calls.push({ method: "start", value: options });
          return { schemaVersion: 2 as const, sessionId: "agent2-one", turnId: "native-one", runtime: "dsh" as const, status: "running" as const, expired: false, result: null, createdAt: 0, updatedAt: 0 };
        },
        async events(options) { return { schemaVersion: 2 as const, ...options, runtime: "dsh" as const, status: "running" as const, expired: false, result: null, createdAt: 0, updatedAt: 0, events: [], gap: false, nextSequence: 0 }; },
        async waitForTurn() {
          calls.push({ method: "wait", value: {} });
          return { schemaVersion: 2, sessionId: "agent2-one", turnId: "native-one", status: "completed", runtime: "dsh", channel: "external-brain", content: [{ type: "text", text: "你好世界，我们开始吧。" }], usage: null, toolAttempts: [], text: "你好世界，我们开始吧。", failure: null };
        },
        async cancel(options) {
          calls.push({ method: "cancel", value: options });
          return { cancelled: true };
        },
        async deleteSession(options) {
          calls.push({ method: "delete", value: options });
          return { deleted: true };
        },
      },
    },
    { level: "light", transcript: "你好世界我们开始吧" },
  );

  expect(result).toEqual({ text: "你好世界，我们开始吧。", applied: true, changed: true });
  // 转写套在围栏里交给 Agent，避免被当成在跟它对话。
  expect(calls.find((call) => call.method === "start")?.value).toMatchObject({
    text: wrapTranscript("你好世界我们开始吧", "turn1"),
  });
  expect(calls[0]?.value).toMatchObject({
    schemaVersion: 2,
    runtime: "dsh",
    tools: [],
    workspace: { kind: "app-private" },
    memory: "one-shot",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls.map((call) => call.method)).toEqual(["create", "start", "wait", "delete"]);
});

test("Agent 润色的 4 秒预算覆盖 create/send，超时精确取消并回原文", async () => {
  let fireTimeout: (() => void) | undefined;
  const cancelled: unknown[] = [];
  const deleted: unknown[] = [];
  const pending = polishTranscriptWithAgent(
    {
      backend: "pi",
      newId: () => "turn-timeout",
      setTimeout(handler) {
        fireTimeout = handler;
        return 1;
      },
      clearTimeout() {},
      agent: {
        async createSession() {
          return { sessionId: "agent2-timeout", backend: "pi" };
        },
        async send() { throw new Error("v2 must not use legacy send"); },
        async startTurn() { return { schemaVersion: 2 as const, sessionId: "agent2-timeout", turnId: "native-timeout", runtime: "pi" as const, status: "running" as const, expired: false, result: null, createdAt: 0, updatedAt: 0 }; },
        async events(options) { return { schemaVersion: 2 as const, ...options, runtime: "pi" as const, status: "running" as const, expired: false, result: null, createdAt: 0, updatedAt: 0, events: [], gap: false, nextSequence: 0 }; },
        async waitForTurn() { return await new Promise(() => undefined); },
        async cancel(options) {
          cancelled.push(options);
          return { cancelled: true };
        },
        async deleteSession(options) {
          deleted.push(options);
          return { deleted: true };
        },
      },
    },
    { level: "formal", transcript: "这是我刚才说的原话" },
  );
  await new Promise(resolve => setTimeout(resolve, 0));
  fireTimeout?.();
  const result = await pending;
  await Promise.resolve();

  expect(result.text).toBe("这是我刚才说的原话");
  expect(result.failure?.code).toBe("POLISH_TIMEOUT");
  expect(cancelled).toEqual([{ sessionId: "agent2-timeout", turnId: "native-timeout" }]);
  expect(deleted).toEqual([{ sessionId: "agent2-timeout" }]);
});

test("create completing after the polish budget is cleaned up without starting a model request", async () => {
  let fireTimeout!: () => void;
  let finishCreate!: (value: { sessionId: string; backend: "pi" }) => void;
  let starts = 0;
  const deleted: string[] = [];
  const pending = polishTranscriptWithAgent({
    backend: "pi", newId: () => "late-create-key",
    setTimeout(callback) { fireTimeout = callback; return 1; }, clearTimeout() {},
    agent: {
      createSession: () => new Promise(resolve => { finishCreate = resolve; }),
      async startTurn() { starts++; throw new Error("must not start after timeout"); },
      async waitForTurn() { throw new Error("must not poll after timeout"); },
      async send() { throw new Error("must not use legacy send"); },
      async events() { throw new Error("must not query after timeout"); },
      async cancel() { throw new Error("no native turn was accepted"); },
      async deleteSession({ sessionId }) { deleted.push(sessionId); return { deleted: true }; },
    },
  }, { level: "light", transcript: "这是我刚才说的原话" });
  await Promise.resolve();
  fireTimeout();
  expect((await pending).failure?.code).toBe("POLISH_TIMEOUT");
  finishCreate({ sessionId: "agent2-late", backend: "pi" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(starts).toBe(0);
  expect(deleted).toEqual(["agent2-late"]);
});
