import { expect, test } from "bun:test";
import { t } from "../src/voice-i18n";
import * as viewModule from "../src/voice-view";
import type { AgentConversationOpenReceipt } from "@reai/app-sdk/v1";

type Item = { id: string; agentSessionId?: string };
type Ports = {
  load(entityId: string, current: () => boolean): Promise<Item | undefined>;
  prepare(item: Item): Promise<AgentConversationOpenReceipt | undefined>;
  land(item: Item, current: () => boolean): Promise<boolean>;
  commit(item: Item, receipt: AgentConversationOpenReceipt | undefined): Promise<void>;
  cancel(sessionId: string, receipt: AgentConversationOpenReceipt): Promise<void>;
  completed(item: Item): Promise<void>;
  failed(error: unknown): void;
};
type Controller = {
  open(entityId: string, receipt?: AgentConversationOpenReceipt): Promise<boolean>;
  retire(): void;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(override: Partial<Ports> = {}) {
  const calls: string[] = [];
  const failures: unknown[] = [];
  const create = (viewModule as unknown as {
    createOwnedConversationOpenController(ports: Ports): Controller;
  }).createOwnedConversationOpenController;
  expect(typeof create).toBe("function");
  const ports: Ports = {
    async load(entityId) { calls.push(`load:${entityId}`); return { id: `row:${entityId}`, agentSessionId: entityId }; },
    async prepare(item) { calls.push(`prepare:${item.agentSessionId}`); return { openToken: `token:${item.agentSessionId}` }; },
    async land(item, current) { calls.push(`land:${item.id}`); return current(); },
    async commit(item, receipt) { calls.push(`commit:${item.id}:${receipt?.openToken}`); },
    async cancel(sessionId, receipt) { calls.push(`cancel:${sessionId}:${receipt.openToken}`); },
    async completed(item) { calls.push(`local-read:${item.id}`); },
    failed(error) { failures.push(error); },
    ...override,
  };
  return { controller: create(ports), calls, failures };
}

test("direct history prepares before actual landing and commits before local unread cleanup", async () => {
  const f = fixture();
  expect(await f.controller.open("agent2-one")).toBe(true);
  expect(f.calls).toEqual([
    "load:agent2-one", "prepare:agent2-one", "land:row:agent2-one",
    "commit:row:agent2-one:token:agent2-one", "local-read:row:agent2-one",
  ]);
});

test("Host-delivered operation uses its captured exact receipt without preparing a second operation", async () => {
  const f = fixture();
  expect(await f.controller.open("agent2-one", { openToken: "host-original" })).toBe(true);
  expect(f.calls).toEqual([
    "load:agent2-one", "land:row:agent2-one",
    "commit:row:agent2-one:host-original", "local-read:row:agent2-one",
  ]);
});

test("a missing cold history row never reports opened or dismisses another task", async () => {
  const f = fixture({ load: async () => undefined });
  expect(await f.controller.open("agent2-missing", { openToken: "host-original" })).toBe(false);
  expect(f.calls).toEqual(["cancel:agent2-missing:host-original"]);
  expect(f.failures).toHaveLength(1);
});

test("Host receipt cannot be attached to a different resolved session", async () => {
  const f = fixture({ load: async () => ({ id: "other", agentSessionId: "agent2-other" }) });
  expect(await f.controller.open("agent2-one", { openToken: "host-original" })).toBe(false);
  expect(f.calls).toEqual(["cancel:agent2-one:host-original"]);
});

test("retirement during hydration cancels the exact Host operation and prevents DOM landing", async () => {
  const loading = deferred<Item | undefined>();
  const f = fixture({ load: () => loading.promise });
  const opening = f.controller.open("agent2-one", { openToken: "host-original" });
  f.controller.retire();
  loading.resolve({ id: "row", agentSessionId: "agent2-one" });
  expect(await opening).toBe(false);
  expect(f.calls).toEqual(["cancel:agent2-one:host-original"]);
  expect(f.failures).toEqual([]);
});

test("navigation after prepare prevents commit and cancels its exact token", async () => {
  const landing = deferred<boolean>();
  const f = fixture({ land: () => landing.promise });
  const opening = f.controller.open("agent2-one");
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  f.controller.retire();
  landing.resolve(true);
  expect(await opening).toBe(false);
  expect(f.calls).toEqual(["load:agent2-one", "prepare:agent2-one", "cancel:agent2-one:token:agent2-one"]);
});

test("durable commit failure keeps its receipt for same-selection retry without legacy downgrade", async () => {
  let commits = 0;
  const tokens: Array<string | undefined> = [];
  const f = fixture({ commit: async (_item, receipt) => {
    tokens.push(receipt?.openToken);
    if (++commits === 1) throw { code: "TASK_HISTORY_UNAVAILABLE" };
  } });
  expect(await f.controller.open("agent2-one")).toBe(false);
  expect(f.calls).not.toContain("local-read:row:agent2-one");
  expect(await f.controller.open("agent2-one")).toBe(true);
  expect(tokens).toEqual(["token:agent2-one", "token:agent2-one"]);
  expect(f.calls.filter(c => c.startsWith("prepare:"))).toHaveLength(1);
  expect(f.calls.filter(c => c.startsWith("local-read:"))).toHaveLength(1);
});

test("a late prepare reply after newer selection is cancelled and cannot replace its receipt", async () => {
  const pending = deferred<AgentConversationOpenReceipt>();
  const f = fixture({ prepare: item => item.agentSessionId === "agent2-old"
    ? pending.promise : Promise.resolve({ openToken: "new-token" }) });
  const old = f.controller.open("agent2-old");
  await Promise.resolve(); await Promise.resolve();
  expect(await f.controller.open("agent2-new")).toBe(true);
  pending.resolve({ openToken: "old-token" });
  expect(await old).toBe(false);
  expect(f.calls).toContain("cancel:agent2-old:old-token");
  expect(f.calls.some(c => c.startsWith("commit:row:agent2-old"))).toBe(false);
});

test("duplicate exact Host intent joins one pending render/commit", async () => {
  const landing = deferred<boolean>();
  let commits = 0;
  const f = fixture({ land: () => landing.promise, commit: async () => { commits++; } });
  const first = f.controller.open("agent2-one", { openToken: "host-original" });
  const second = f.controller.open("agent2-one", { openToken: "host-original" });
  landing.resolve(true);
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(commits).toBe(1);
});

import { beforeAll, afterAll } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { MockHost } from '@reai/app-test/v1';
import manifest from '../app.manifest.json';
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, SOURCE_MIGRATION_KEY, SOURCE_SELECTION_KEY, type VoiceCommandHistoryItem } from '../src/data';
let ownsDom = false;
beforeAll(() => { if (typeof document === 'undefined') { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const row: VoiceCommandHistoryItem = { id: 'synthetic-row', agentSessionId: 'agent2-fixture',
  transcript: 'Synthetic question', reply: 'Synthetic answer', status: 'completed',
  commandId: 'voice.command.agent', createdAt: new Date(0).toISOString(), unread: true };
async function until(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  expect(check()).toBeTrue();
}
async function voiceFixture() {
  const fixtureManifest = structuredClone(manifest) as any;
  fixtureManifest.contributes.notificationScenes = [{ key: 'task.lifecycle', maxLevel: 'system' }];
  const host = new MockHost({ manifest: fixtureManifest,
    ownedConversationOpen: { accountGeneration: 'synthetic-account', packageDigest: 'a'.repeat(64),
      admitted: true, decision: 'granted', userCeiling: 'in_app', sessionIds: ['agent2-fixture'] },
    loadApp: () => import('../src/app'), createRoot: () => { const root = document.createElement('div'); document.body.append(root); return root; } });
  const storage = (host as unknown as { storage: Map<string, unknown> }).storage;
  for (const [key, value] of Object.entries({ settings: DEFAULT_SETTINGS, 'recognition-engine-choice-v1': 'local',
    [SOURCE_MIGRATION_KEY]: 1, [SOURCE_SELECTION_KEY]: 2 })) storage.set(`com.reai.voice/voice-state/${key}`, structuredClone(value));
  await host.installAndEnable(); const surface = await host.openSurface('main');
  expect(surface.readyCount).toBe(1);
  const key = `com.reai.voice/voice-state/${COMMAND_HISTORY_KEY}`;
  return { host, storage, surface, key, dispose: async () => { await host.unmountSurface(surface.surfaceMountId); await host.disable(); surface.root?.remove(); } };
}

test('actual cold Voice Host intent rehydrates the persisted row, paints then commits captured token without dismissTask', async () => {
  const f = await voiceFixture();
  try {
    f.storage.set(f.key, [structuredClone(row)]);
    let paintedAtCommit = false;
    const original = f.host.bridge.request;
    f.host.bridge.request = async (method, params, options) => {
      if ((params as any)?.phase === 'commit') paintedAtCommit = !!f.surface.root?.textContent?.includes('Synthetic answer');
      return original(method, params, options);
    };
    const receipt = await f.host.deliverOwnedConversationOpen('agent2-fixture');
    await until(() => f.host.ownedConversationCommits.length === 1);
    await until(() => (f.storage.get(f.key) as VoiceCommandHistoryItem[])[0]?.unread !== true);
    expect(paintedAtCommit).toBeTrue();
    expect(f.host.ownedConversationCommits[0]!.openToken).toBe(receipt.openToken);
    expect(f.host.agentRequests.filter(r => (r.params as any)?.phase === 'prepare')).toHaveLength(0);
    expect(f.host.voiceCommandRequests.filter(r => r.method === 'voice.command.dismiss-task')).toHaveLength(0);
  } finally { await f.dispose(); }
});

test('actual Voice failed durable Host commit leaves unread and retries same receipt', async () => {
  const f = await voiceFixture();
  try {
    f.storage.set(f.key, [structuredClone(row)]);
    f.host.failNextConversationOpenCommit();
    const receipt = await f.host.deliverOwnedConversationOpen('agent2-fixture');
    await until(() => f.host.agentRequests.some(r => (r.params as any)?.phase === 'commit'));
    await new Promise(r => setTimeout(r, 30));
    expect(f.host.ownedConversationCommits).toHaveLength(0);
    expect((f.storage.get(f.key) as VoiceCommandHistoryItem[])[0]!.unread).toBeTrue();
    expect(f.surface.root!.querySelector('.voice-conversation-open-error')).not.toBeNull();
    expect(f.surface.root!.querySelector('.voice-conversation-open-error .inline-error')?.textContent).toBe(t('errors.conversationOpen.commitFailed'));
    expect(f.surface.root!.querySelector('.voice-conversation-open-error')?.textContent).not.toContain('TASK_NAVIGATION_FAILED');
    f.surface.root!.querySelector<HTMLButtonElement>('.voice-conversation-open-error button')!.click();
    await until(() => f.host.ownedConversationCommits.length === 1);
    expect(f.host.ownedConversationCommits[0]!.openToken).toBe(receipt.openToken);
  } finally { await f.dispose(); }
});

test('actual Voice direct history prepares a fresh frontier after reopening', async () => {
  const f = await voiceFixture();
  try {
    f.storage.set(f.key, [structuredClone(row)]);
    await f.host.deliverOwnedConversationOpen('agent2-fixture');
    await until(() => f.host.ownedConversationCommits.length === 1);
    f.host.advanceOwnedConversationNotice('agent2-fixture');
    await f.host.invokeCommand('com.reai.voice.back-to-root');
    f.surface.root!.querySelector<HTMLElement>('.command-history-item')!.click();
    await until(() => f.host.ownedConversationCommits.length === 2);
    expect(f.host.agentRequests.some(r => (r.params as any)?.phase === 'prepare')).toBeTrue();
  } finally { await f.dispose(); }
});

test('actual Voice unmount while cold hydration is pending never paints, commits or clears unread', async () => {
  const f = await voiceFixture();
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let blocked = false;
  const original = f.host.bridge.request;
  f.storage.set(f.key, [structuredClone(row)]);
  f.host.bridge.request = async (method, params, options) => {
    if (method === 'storage.get' && (params as any)?.key === COMMAND_HISTORY_KEY && !blocked) {
      blocked = true; await pending;
    }
    return original(method, params, options);
  };
  try {
    await f.host.deliverOwnedConversationOpen('agent2-fixture');
    await until(() => blocked);
    await f.host.unmountSurface(f.surface.surfaceMountId);
    release(); await new Promise(done => setTimeout(done, 40));
    expect(f.host.ownedConversationCommits).toHaveLength(0);
    expect((f.storage.get(f.key) as VoiceCommandHistoryItem[])[0]!.unread).toBeTrue();
    expect(f.host.agentRequests.filter(r => (r.params as any)?.phase === 'commit')).toHaveLength(0);
  } finally { release(); await f.dispose(); }
});

test('actual Voice direct-open retry preserves the prepared receipt across row/session aliases', async () => {
  const f = await voiceFixture();
  try {
    f.storage.set(f.key, [structuredClone(row)]);
    await f.host.deliverOwnedConversationOpen('agent2-fixture');
    await until(() => f.host.ownedConversationCommits.length === 1);
    await until(() => (f.storage.get(f.key) as VoiceCommandHistoryItem[])[0]?.unread !== true);
    f.host.advanceOwnedConversationNotice('agent2-fixture');
    f.storage.set(f.key, [structuredClone(row)]);
    await f.host.invokeCommand('com.reai.voice.back-to-root');
    f.host.failNextConversationOpenCommit();
    f.surface.root!.querySelector<HTMLButtonElement>('.command-history-item')!.click();
    await until(() => !!f.surface.root!.querySelector('.voice-conversation-open-error button'));
    const attempts = () => f.host.agentRequests.filter(r => (r.params as any)?.phase === 'commit');
    const failedToken = (attempts().at(-1)!.params as any).openToken;
    const prepares = f.host.agentRequests.filter(r => (r.params as any)?.phase === 'prepare').length;
    f.surface.root!.querySelector<HTMLButtonElement>('.voice-conversation-open-error button')!.click();
    await until(() => f.host.ownedConversationCommits.length === 2);
    expect((attempts().at(-1)!.params as any).openToken).toBe(failedToken);
    expect(f.host.agentRequests.filter(r => (r.params as any)?.phase === 'prepare')).toHaveLength(prepares);
  } finally { await f.dispose(); }
});
