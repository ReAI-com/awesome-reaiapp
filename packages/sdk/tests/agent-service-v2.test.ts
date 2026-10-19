import { expect, test } from "bun:test";
import { defineApp, runApp, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";
import matrix from "../../contract/host-support-matrix.json";

const reference = { sessionId: "agent2-fixture", turnId: "turn-fixture" };
const snapshot = (status: string, result: unknown = null) => ({
  schemaVersion: 2, ...reference, runtime: "pi", status, expired: false,
  result, createdAt: 1, updatedAt: 2,
});
const terminal = (status = "completed") => ({
  schemaVersion: 2, ...reference, runtime: "pi" as const, channel: "external-brain" as const, status,
  content: status === "completed" ? [{ type: "text" as const, text: "Fixture answer" }] : [],
  usage: null, toolAttempts: [],
  text: status === "completed" ? "Fixture answer" : null,
  failure: status === "completed" ? null : { code: "AGENT_CANCELLED", kind: "killed" },
});

test("attachment uploads use owned-session typed lease methods and send keeps the exact input identity", async () => {
  const part = { kind: "image" as const, name: "synthetic.png", mimeType: "image/png" as const, leaseId: "c".repeat(64), sha256: "d".repeat(64), byteLength: 3 };
  const admission = { schemaVersion: 1 as const, opaqueBinding: "a".repeat(64), revision: 1, modes: ["image" as const] };
  const f = await fixture(method => method.endsWith(".upload.start") ? { schemaVersion: 1, leaseId: part.leaseId, chunkBytes: 262144 }
    : method.endsWith(".upload.finish") ? { schemaVersion: 1, part }
    : method === "agent.v2.turn.start" ? snapshot("completed", terminal()) : { schemaVersion: 1, ok: true });
  try {
    const uploads = f.ctx.agent.attachmentUploads;
    expect(uploads).toBeDefined();
    if (!uploads) throw new Error("missing typed attachment uploads");
    const owned = { schemaVersion: 1 as const, sessionId: reference.sessionId, admission };
    await uploads.start({ ...owned, name: part.name, mimeType: part.mimeType, byteLength: 3, sha256: part.sha256 });
    await uploads.chunk({ ...owned, leaseId: part.leaseId, index: 0, base64: "YWJj" });
    expect((await uploads.finish({ ...owned, leaseId: part.leaseId })).part).toEqual(part);
    const input = { schemaVersion: 1 as const, admission, parts: [part] };
    await f.ctx.agent.send({ sessionId: reference.sessionId, turnId: "same-attachment-key", text: "synthetic question", taskPresentation: "host", attachmentInput: input });
    await uploads.cancel({ ...owned, leaseId: part.leaseId });
    expect(f.calls.map(call => call.method)).toEqual(["agent.v2.attachment.upload.start", "agent.v2.attachment.upload.chunk", "agent.v2.attachment.upload.finish", "agent.v2.turn.start", "agent.v2.attachment.upload.cancel"]);
    expect(f.calls[3]?.params).toEqual({ sessionId: reference.sessionId, idempotencyKey: "same-attachment-key", text: "synthetic question", taskPresentation: "host", attachmentInput: input });
  } finally { await f.dispose(); }
});

/** Only the methods granted by agent.session@2 exist in this fixture. */
async function fixture(reply: (method: string, params: any) => unknown = () => ({})) {
  let ctx!: AppContext;
  let receive!: (message: HostMessage) => void;
  const calls: Array<{ method: string; params: any }> = [];
  const allowed = new Set(matrix.pluginPermissions.supported["agent.session@2"].bridgeMethods);
  const bridge: HostBridge = {
    request: async (method, params) => {
      if (method.startsWith("agent.")) {
        if (!allowed.has(method)) throw new Error(`v1 capability is not granted: ${method}`);
        calls.push({ method, params });
      }
      return await reply(method, params) as never;
    },
    notify() {}, subscribe(listener) { receive = listener; return () => {}; },
  };
  const app = runApp(defineApp({ activate(context) { ctx = context; } }), bridge);
  receive({ type: "activate", runtimeSessionId: "agent-v2-fixture" });
  await new Promise(resolve => setTimeout(resolve, 0));
  return { ctx, calls, dispose: () => app.dispose() };
}

test("startTurn is a short submission and retries preserve the same idempotency key", async () => {
  const f = await fixture(() => snapshot("queued"));
  try {
    const request = { sessionId: reference.sessionId, idempotencyKey: "request-1", text: "Fixture question" };
    const first = await f.ctx.agent.startTurn(request);
    const retry = await f.ctx.agent.startTurn(request);
    expect(first.status).toBe("queued");
    expect(retry.turnId).toBe(first.turnId);
    expect(f.calls).toEqual([
      { method: "agent.v2.turn.start", params: request },
      { method: "agent.v2.turn.start", params: request },
    ]);
  } finally { await f.dispose(); }
});

test("v2 lifecycle methods work with only cap2, including list/opened and dependency control", async () => {
  const f = await fixture();
  try {
    await f.ctx.agent.backends({ schemaVersion: 2 });
    await f.ctx.agent.listSessions({ schemaVersion: 2 });
    await f.ctx.agent.getTurn(reference);
    await f.ctx.agent.events({ ...reference, afterSequence: 9 });
    await f.ctx.agent.cancel(reference);
    await f.ctx.agent.history({ sessionId: reference.sessionId });
    await f.ctx.agent.reportConversationOpened({ sessionId: reference.sessionId });
    await f.ctx.agent.requireToolDependency({ tool: "web_search", schemaVersion: 2 });
    await f.ctx.agent.deleteSession({ sessionId: reference.sessionId });
    expect(f.calls).toEqual([
      { method: "agent.v2.backends.list", params: {} },
      { method: "agent.v2.session.list", params: {} },
      { method: "agent.v2.turn.get", params: reference },
      { method: "agent.v2.turn.events", params: { ...reference, afterSequence: 9 } },
      { method: "agent.v2.turn.cancel", params: reference },
      { method: "agent.v2.session.history", params: { sessionId: reference.sessionId } },
      { method: "agent.v2.session.conversation-opened", params: { sessionId: reference.sessionId } },
      { method: "agent.v2.tool-dependency.require", params: { tool: "web_search" } },
      { method: "agent.v2.session.delete", params: { sessionId: reference.sessionId } },
    ]);
  } finally { await f.dispose(); }
});

test("send waits for the terminal snapshot and never returns an admission as an answer", async () => {
  let reads = 0;
  const f = await fixture(method => method === "agent.v2.turn.start" ? snapshot("queued")
    : ++reads === 1 ? snapshot("running") : snapshot("completed", terminal()));
  try {
    let finished = false;
    const result = f.ctx.agent.send({ sessionId: reference.sessionId, turnId: "stable-request", text: "Fixture" }).then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    const answer = await result;
    expect(answer).toEqual(terminal());
    expect(answer.turnId).toBe(reference.turnId);
    expect(answer.turnId).not.toBe("stable-request");
    expect(f.calls.filter(c => c.method === "agent.v2.turn.start")).toHaveLength(1);
    expect(f.calls[0]?.params.idempotencyKey).toBe("stable-request");
    expect(f.calls.slice(1)).toEqual([
      { method: "agent.v2.turn.get", params: reference },
      { method: "agent.v2.turn.get", params: reference },
    ]);
  } finally { await f.dispose(); }
});

test("cancelled and failed snapshots remain terminal; expired results never restart a turn", async () => {
  for (const status of ["cancelled", "failed"]) {
    const result = terminal(status);
    const f = await fixture(() => snapshot(status, result));
    try {
      expect(await f.ctx.agent.send({ sessionId: reference.sessionId, text: "Fixture" })).toEqual(result);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.params.idempotencyKey).toBeString();
    } finally { await f.dispose(); }
  }
  const f = await fixture(() => ({ ...snapshot("completed"), expired: true }));
  try {
    await expect(f.ctx.agent.send({ sessionId: reference.sessionId, text: "Fixture" })).rejects.toMatchObject({ code: "AGENT_RESULT_EXPIRED" });
    expect(f.calls).toHaveLength(1);
  } finally { await f.dispose(); }
});


test("waitForTurn only polls a saved receipt and returns the real turn ID", async () => {
  let reads = 0;
  const f = await fixture(() => ++reads === 1 ? snapshot("running") : snapshot("completed", terminal()));
  try {
    const result = await f.ctx.agent.waitForTurn(reference);
    expect(result.turnId).toBe(reference.turnId);
    expect(f.calls).toEqual([
      { method: "agent.v2.turn.get", params: reference },
      { method: "agent.v2.turn.get", params: reference },
    ]);
  } finally { await f.dispose(); }
});

test("waitForTurn 在任务等用户拍板时不计等待截止；不等用户时照常到点", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  const waiting = { kind: "waiting_user", waitId: "wait-1", reason: "browser_plugin_required", label: "启用浏览器插件以联网", action: { type: "tool-dependency", toolName: "web_search", appId: "com.reai.browser" }, startedAt: 1 };
  Date.now = () => now;
  try {
    // 每次轮询过去 400 秒：等用户的 5 次合计 2000 秒，远超 610 秒截止，仍拿到终局。
    let reads = 0;
    const f = await fixture(() => { now += 400_000; return ++reads <= 5 ? { ...snapshot("running"), waiting } : snapshot("completed", terminal()); });
    try {
      expect((await f.ctx.agent.waitForTurn(reference)).turnId).toBe(reference.turnId);
    } finally { await f.dispose(); }
    const g = await fixture(() => { now += 400_000; return snapshot("running"); });
    try {
      await expect(g.ctx.agent.waitForTurn(reference)).rejects.toMatchObject({ code: "AGENT_WAIT_TIMEOUT" });
    } finally { await g.dispose(); }
  } finally { Date.now = originalNow; }
});

test("waitForTurn 按累计等待时长顺延：同意后第一张快照已不在等，也不误判超时", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  const waiting = { kind: "waiting_user", waitId: "wait-1", reason: "browser_plugin_required", label: "启用浏览器插件以联网", action: { type: "tool-dependency", toolName: "web_search", appId: "com.reai.browser" }, startedAt: 1 };
  Date.now = () => now;
  try {
    // 第 1 次：正在等用户。下一次轮询隔了 700 秒（例如页面被挂起），期间用户等了 650 秒后同意，
    // 回合已恢复运行、不再带 waiting；Host 侧只计了 50 秒，远没到上限。
    const script = [
      () => ({ ...snapshot("running"), waiting, waitedMs: 1 }),
      () => { now += 700_000; return { ...snapshot("running"), waitedMs: 650_000 }; },
      () => snapshot("completed", terminal()),
    ];
    let reads = 0;
    const f = await fixture(() => script[Math.min(reads++, script.length - 1)]!());
    try {
      expect((await f.ctx.agent.waitForTurn(reference)).turnId).toBe(reference.turnId);
    } finally { await f.dispose(); }
  } finally { Date.now = originalNow; }
});

test("budget failures retain their actionable reason and never automatically resubmit", async () => {
  const failure = { kind: "engine", code: "AGENT_MODEL_BUDGET_EXCEEDED", message: "这次任务已达到模型调用次数上限，尚未完成。请缩小问题后再试。", retry: "same-session" };
  const result = { ...terminal("failed"), failure };
  const f = await fixture(() => snapshot("failed", result));
  try {
    const answer = await f.ctx.agent.send({ sessionId: reference.sessionId, turnId: "bounded-request", text: "Fixture" });
    expect(answer.failure).toEqual(failure);
    expect(answer.text).toBeNull();
    expect(f.calls).toEqual([{ method: "agent.v2.turn.start", params: { sessionId: reference.sessionId, idempotencyKey: "bounded-request", text: "Fixture" } }]);
  } finally { await f.dispose(); }
});

test('real SDK neutral opened injects only the Host-delivered token into explicit MockHost fixture', async () => {
  const { MockHost } = await import('../../test-kit/src/v1/mock-host');
  let context: AppContext | undefined;
  const host = new MockHost({ manifest: { appId: 'com.example.opened',
    contributes: { surfaces: [{ id: 'main' }], notificationScenes: [{ key: 'task.lifecycle', maxLevel: 'system' }] },
    requires: { hostCapabilities: ['agent.session@2','tasks.present@1'] } },
    ownedConversationOpen: { accountGeneration: 'synthetic-account', packageDigest: 'b'.repeat(64),
      admitted: true, decision: 'granted', userCeiling: 'in_app', sessionIds: ['agent2-owned'] },
    loadApp: async () => ({ default: defineApp({ activate(ctx) { context = ctx;
      ctx.surfaces.register('main', surface => { surface.ready(); }); } }) }),
  });
  await host.installAndEnable(); await host.openSurface('main');
  try {
    await expect(context!.tasks.conversationOpened({ requestId: 'before-delivery', entityId: 'agent2-owned' })).rejects.toMatchObject({ code: 'HOST_CAPABILITY_NOT_AVAILABLE' });
    await expect(context!.tasks.dismiss({ requestId: 'sibling-denied', taskId: 'synthetic-task' })).rejects.toMatchObject({ code: 'HOST_CAPABILITY_NOT_AVAILABLE' });
    const receipt = await host.deliverOwnedConversationOpen('agent2-owned');
    const input = { requestId: 'opened-after-delivery', entityId: 'agent2-owned' };
    expect(await context!.tasks.conversationOpened(input)).toMatchObject({ acknowledged: true });
    expect(input).toEqual({ requestId: 'opened-after-delivery', entityId: 'agent2-owned' });
    expect(host.ownedConversationCommits).toEqual([{ sessionId: 'agent2-owned', openToken: receipt.openToken, revision: 0 }]);
    expect(host.notificationRequests).toHaveLength(0);
  } finally { await host.disable(); }
});
