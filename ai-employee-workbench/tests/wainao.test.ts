import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatewayBase, resolveWainaoConfig, wainaoModels } from '../server/wainao.ts';
import { Store } from '../server/store.ts';
import { Sources } from '../server/sources.ts';
import { Pipeline } from '../server/pipeline.ts';
import type { AgentConfig, AgentRun } from '../shared/types.ts';

test('Wainao gateway rejects insecure or ambiguous origins and resolves OAuth only into invocation copies', async () => {
  assert.equal(gatewayBase(), 'https://block2-api.wainao.chat/api/model-gateway/v1');
  for (const value of ['http://oauth.example', 'https://user:password@oauth.example', 'https://oauth.example/path', 'https://oauth.example?token=x', 'https://oauth.example#fragment']) assert.throws(() => gatewayBase(value));
  const input: AgentConfig = { workspaceId: 'workspace', agentId: 'agent-001', version: 1, harness: 'pi', provider: 'wainao', model: 'test-model', protocol: 'anthropic-messages', baseUrl: 'https://attacker.example', apiKey: 'obsolete-key', oauthSubject: 'confirmed-subject', parameters: {}, prompt: '测试', tools: [], mcp: {}, skills: [] };
  const original = structuredClone(input);
  const requested: string[] = [];
  const output = await resolveWainaoConfig(input, { async tokenForSubject(subject) { requested.push(subject); return 'wno-in-memory-secret'; } });
  assert.deepEqual(input, original); assert.notEqual(output, input);
  assert.equal(output.baseUrl, gatewayBase()); assert.equal(output.protocol, 'openai-completions'); assert.equal(output.apiKey, 'wno-in-memory-secret');
  assert.deepEqual(requested, ['confirmed-subject']);
  await assert.rejects(resolveWainaoConfig(input), /登录外脑/);
  await assert.rejects(resolveWainaoConfig({ ...input, oauthSubject: undefined }, { async tokenForSubject() { throw new Error('must not execute'); } }), /登录外脑/);
  const local = { ...input, provider: 'custom' };
  assert.equal(await resolveWainaoConfig(local, { async tokenForSubject() { throw new Error('must not execute'); } }), local);
});

test('catalog returns only currently available chat operations and never follows credential redirects', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const auth = { async tokenForSubject(sub: string) { assert.equal(sub, 'owner'); return 'wno-test-secret'; } };
  const request: typeof fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: [
      { id: 'chat', name: '聊天', operations: [{ id: 'chat', availability: { available: true } }] },
      { id: 'blocked', operations: [{ id: 'chat', availability: { available: false } }] },
      { id: 'image', operations: [{ id: 'image', availability: { available: true } }] },
      { id: 'incomplete', operations: [{ id: 'chat' }] },
      { id: 'truthy', operations: [{ id: 'chat', availability: { available: 'true' } }] },
      { id: 123, operations: [{ id: 'chat', availability: { available: true } }] },
    ] });
  };
  assert.deepEqual(await wainaoModels(auth, 'owner', undefined, request), { data: [{ id: 'chat', name: '聊天' }] });
  assert.equal(calls[0].url, `${gatewayBase()}/models?task=all`); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer wno-test-secret');
  await assert.rejects(wainaoModels(auth, 'owner', undefined, async () => Response.json({ error: 'wno-test-secret' }, { status: 403 })), error => error instanceof Error && /权限/.test(error.message) && !error.message.includes('wno-test-secret'));
  await assert.rejects(wainaoModels(auth, 'owner', undefined, async () => Response.json({ data: 'invalid' })), /格式无效/);
});

test('Pipeline keeps OAuth tokens out of persistent Agent configs, snapshots, runs and events', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'maoding-wainao-pipeline-'));
  const store = new Store(root); const sources = new Sources(store);
  const workspace = store.createWorkspace({ name: '授权任务', role: '验证内存凭据' });
  const config = store.require<AgentConfig>('agents', 'agent-003', workspace.id);
  store.put('agents', { ...config, provider: 'wainao', model: 'chat', oauthSubject: 'owner', baseUrl: 'https://attacker.example', protocol: 'anthropic-messages' });
  let called = false;
  const pipeline = new Pipeline(store, sources, root, async input => {
    called = true;
    assert.equal(input.config.apiKey, 'wno-ephemeral-test-secret');
    assert.equal(input.config.baseUrl, gatewayBase());
    assert.equal(input.config.protocol, 'openai-completions');
    return '已基于当前岗位完成验证。';
  }, candidate => resolveWainaoConfig(candidate, { async tokenForSubject(subject) { assert.equal(subject, 'owner'); return 'wno-ephemeral-test-secret'; } }));
  t.after(async () => { await pipeline.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const run = pipeline.chat(workspace.id, '验证授权'); await pipeline.idle();
  assert.ok(called); assert.equal(store.require<AgentRun>('runs', run.id, workspace.id).status, 'succeeded');
  assert.equal(store.require<AgentConfig>('agents', 'agent-003', workspace.id).apiKey, undefined);
  const stored = JSON.stringify(store.db.prepare('SELECT payload FROM entities').all());
  assert.doesNotMatch(stored, /wno-ephemeral-test-secret/);
  assert.equal(store.list<any>('routingSnapshots', workspace.id)[0].configuration.apiKey, undefined);
});
