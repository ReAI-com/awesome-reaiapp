import { expect, test } from "bun:test";
import { MockHost } from "../src/v1/mock-host";

function fixture(capabilities = ["agent.session@2"]) {
  return new MockHost({ manifest: { appId: "com.example.agent", requires: { hostCapabilities: capabilities } }, loadApp: async () => ({ default: {} }) });
}
test("mock durable turns use server identities and reject conflicting retries and cross-session reads", async () => {
  const host = fixture();
  const config = { schemaVersion: 2, runtime: "dsh", systemPrompt: "fixture", workspace: { kind: "app-private" }, memory: "session" };
  const created = await host.bridge.request<any>("agent.v2.session.create", { config });
  expect(created.runtime).toBe("dsh");
  const request = { sessionId: created.sessionId, idempotencyKey: "client-key", text: "hello" };
  const first = await host.bridge.request<any>("agent.v2.turn.start", request);
  expect(first.turnId).not.toBe(request.idempotencyKey);
  expect(await host.bridge.request("agent.v2.turn.start", request)).toEqual(first);
  await expect(host.bridge.request("agent.v2.turn.start", { ...request, text: "different" })).rejects.toMatchObject({ code: "AGENT_IDEMPOTENCY_CONFLICT" });
  await expect(host.bridge.request("agent.v2.turn.get", { sessionId: "another", turnId: first.turnId })).rejects.toMatchObject({ code: "AGENT_TURN_NOT_FOUND" });
  expect(first.result).toMatchObject({ schemaVersion: 2, runtime: "dsh", channel: "external-brain", usage: null, toolAttempts: [] });
  expect(await host.bridge.request<{ cancelled: boolean }>("agent.v2.turn.cancel", { sessionId: created.sessionId, turnId: first.turnId })).toEqual({ cancelled: false });
  expect(await host.bridge.request("agent.v2.turn.get", { sessionId: created.sessionId, turnId: first.turnId })).toEqual(first);
});
test("v1 capability cannot accidentally grant v2 and v2 cannot grant v1", async () => {
  for (const [caps, method] of [[["agent.session@1"], "agent.v2.backends.list"], [["agent.session@2"], "agent.backends.list"]] as const) {
    await expect(fixture([...caps]).bridge.request(method, {})).rejects.toThrow("Manifest 未声明");
  }
});

async function ownedFixture(enabled = true, override: Record<string, unknown> = {}) {
  let context: import('@reai/app-sdk/v1').AppContext | undefined;
  const host = new MockHost({
    manifest: { appId: 'com.example.agent', requires: { hostCapabilities: ['agent.session@1','agent.session@2'] },
      contributes: { surfaces: [{ id: 'main' }], notificationScenes: [{ key: 'task.lifecycle', maxLevel: 'system' }] } } as never,
    ...(enabled ? { ownedConversationOpen: { accountGeneration: 'synthetic-account', packageDigest: 'a'.repeat(64),
      admitted: true, decision: 'granted', userCeiling: 'in_app', sessionIds: ['agent2-fixture','agent-fixture'], ...override } } : {}),
    loadApp: async () => ({ default: { activate(ctx: import('@reai/app-sdk/v1').AppContext) {
      context = ctx; ctx.surfaces.register('main', surface => { surface.ready(); return () => {}; });
    } } }),
  } as never);
  await host.installAndEnable(); const surface = await host.openSurface('main');
  return { host, ctx: context!, surface };
}

test('owned-open fixture is explicit; default strict phases are unavailable and legacy stays unchanged', async () => {
  const f = await ownedFixture(false);
  try {
    expect(await f.host.bridge.request<any>('environment.get', {})).not.toHaveProperty('ownedConversationOpen');
    await expect(f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    const created = await f.host.bridge.request<any>('agent.v2.session.create', { config: { schemaVersion: 2, runtime: 'dsh', memory: 'session' } });
    expect(await f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: created.sessionId })).toBeNull();
    await expect(f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: created.sessionId, phase: 'prepare' })).rejects.toMatchObject({ code: 'HOST_CAPABILITY_NOT_AVAILABLE' });
  } finally { await f.host.disable(); }
});

test('explicit synthetic owned-open phases bind session and cannot downgrade to legacy', async () => {
  const f = await ownedFixture();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent-fixture', receipt })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture' })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    await f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt });
    await f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt });
    expect((f.host as any).ownedConversationCommits).toHaveLength(1);
  } finally { await f.host.disable(); }
});

test('synthetic durable failure retains the exact operation for retry; new notice rejects old read frontier', async () => {
  const f = await ownedFixture();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    (f.host as any).failNextConversationOpenCommit();
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt })).rejects.toMatchObject({ code: 'TASK_NAVIGATION_FAILED' });
    expect((f.host as any).ownedConversationCommits).toHaveLength(0);
    await f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt });
    (f.host as any).advanceOwnedConversationNotice('agent2-fixture');
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
  } finally { await f.host.disable(); }
});

test('current admission and mount retirement reject owned acknowledgement without any real effect', async () => {
  for (const override of [{ admitted: false }, { decision: 'pending' }, { decision: 'denied' }, { userCeiling: undefined }]) {
    const f = await ownedFixture(true, override);
    try { await expect(f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' })).rejects.toThrow();
      expect((f.host as any).ownedConversationCommits).toHaveLength(0);
    } finally { await f.host.disable(); }
  }
  const f = await ownedFixture();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await f.host.unmountSurface(f.surface.surfaceMountId);
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    expect((f.host as any).ownedConversationCommits).toHaveLength(0);
    expect(f.host.notificationRequests).toHaveLength(0);
  } finally { await f.host.disable(); }
});

test('neutral commit requires a Host-delivered receipt; a direct prepared token grants no neutral authority', async () => {
  const f = await ownedFixture();
  (f.host as any).options.manifest.requires.hostCapabilities.push('tasks.present@1');
  try {
    const direct = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await expect(f.host.bridge.request('tasks.conversationOpened', { requestId: 'synthetic-neutral', entityId: 'agent2-fixture', openToken: direct.openToken })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    expect(f.host.ownedConversationCommits).toHaveLength(0);
    const delivered = await f.host.deliverOwnedConversationOpen('agent2-fixture');
    expect(await f.host.bridge.request('tasks.conversationOpened', { requestId: 'synthetic-neutral', entityId: 'agent2-fixture', openToken: delivered.openToken })).toMatchObject({ acknowledged: true });
  } finally { await f.host.disable(); }
});

test('synthetic receipts expire, cancel exactly and reject an account or package replacement', async () => {
  let now = 1000;
  const f = await ownedFixture(true, { now: () => now });
  try {
    const expired = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    now += 15000;
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt: expired })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    const cancelled = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await f.ctx.agent.cancelConversationOpen({ sessionId: 'agent2-fixture', receipt: cancelled });
    await expect(f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: 'agent2-fixture', phase: 'commit', openToken: cancelled.openToken })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    for (const field of ['accountGeneration','packageDigest'] as const) {
      const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
      (f.host as any).options.ownedConversationOpen[field] = field === 'accountGeneration' ? 'next-synthetic-account' : 'b'.repeat(64);
      await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    }
    expect(f.host.ownedConversationCommits).toHaveLength(0);
  } finally { await f.host.disable(); }
});

test('newly created owned sessions cannot use unphased legacy acknowledgement and pending operations are bounded', async () => {
  const f = await ownedFixture();
  try {
    const created = await f.host.bridge.request<{ sessionId: string }>('agent.v2.session.create', { config: { schemaVersion: 2, runtime: 'dsh', memory: 'session' } });
    await f.ctx.agent.prepareConversationOpen({ sessionId: created.sessionId });
    await expect(f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: created.sessionId })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    for (let i = 0; i < 15; i++) await f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: 'agent2-fixture', phase: 'prepare' });
    await expect(f.host.bridge.request('agent.v2.session.conversation-opened', { sessionId: 'agent2-fixture', phase: 'prepare' })).rejects.toMatchObject({ code: 'TASK_LIMIT_EXCEEDED' });
    expect(f.host.ownedConversationCommits).toHaveLength(0);
  } finally { await f.host.disable(); }
});


test('new presentation updates the descriptor and retires the old SDK receipt', async () => {
  const f = await ownedFixture();
  try {
    const descriptor = () => f.host.bridge.request<{ ownedConversationOpen?: { presentationToken?: string } }>('environment.get', {});
    const before = await descriptor();
    const old = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await f.host.presentSurface(f.surface.surfaceMountId);
    const after = await descriptor();
    expect(after.ownedConversationOpen?.presentationToken).not.toBe(before.ownedConversationOpen?.presentationToken);
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt: old })).rejects.toMatchObject({ code: 'TASK_SOURCE_STALE' });
    const current = await f.ctx.agent.prepareConversationOpen({ sessionId: 'agent2-fixture' });
    await f.ctx.agent.reportConversationOpened({ sessionId: 'agent2-fixture', receipt: current });
    expect(f.host.ownedConversationCommits).toHaveLength(1);
  } finally { await f.host.disable(); }
  await expect(f.host.presentSurface(f.surface.surfaceMountId)).rejects.toThrow();
});
