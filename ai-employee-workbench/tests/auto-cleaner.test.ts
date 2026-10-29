import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { Sources } from '../server/sources.ts';
import { Pipeline } from '../server/pipeline.ts';
import { AutoCleaner } from '../server/auto-cleaner.ts';
import type { AgentConfig, AgentRun, DataRecord, SourceFile } from '../shared/types.ts';

async function fixture(t: TestContext, runner: ConstructorParameters<typeof Pipeline>[3]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'employee-auto-'));
  const store = new Store(directory); const sources = new Sources(store);
  const workspace = store.createWorkspace({ name: 'Auto test', role: 'Synthetic test' });
  const config = store.list<AgentConfig>('agents', workspace.id)[0];
  store.put('agents', { ...config, provider: 'fixture', model: 'fixture' });
  const pipeline = new Pipeline(store, sources, directory, runner); const auto = new AutoCleaner(store, pipeline);
  t.after(async () => { auto.stop(); await pipeline.close(); await auto.idle(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, sources, workspace, pipeline, auto };
}
const output = JSON.stringify({ name: 'Facts', schema: { type: 'object', properties: { value: { type: 'integer' } }, additionalProperties: false }, records: [{ value: 1 }], issues: [] });

test('automatic ingestion is opt-in and serializes files while preserving originals and published provenance', async t => {
  let calls = 0, active = 0, maximum = 0;
  const f = await fixture(t, async () => { calls++; active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 8)); active--; return output; });
  await f.sources.upload(f.workspace.id, 'first.txt', Buffer.from('First synthetic source'));
  await f.sources.upload(f.workspace.id, 'second.txt', Buffer.from('Second synthetic source'));
  assert.equal(f.auto.enqueue(f.workspace.id), 0);
  f.store.updateWorkspace(f.workspace.id, { autoClean: true });
  assert.equal(f.auto.enqueue(f.workspace.id), 2);
  f.auto.enqueue(f.workspace.id);
  await f.auto.idle();
  assert.equal(calls, 2); assert.equal(maximum, 1);
  assert(f.store.list<SourceFile>('files', f.workspace.id).every(file => file.state === '清洗完成' && file.cleanedRevisionId === file.revisionId));
  assert(f.store.list<DataRecord>('records', f.workspace.id).every(row => row.sourceRevisionId && row.runId && !row.manual));
  assert.equal(f.auto.enqueue(f.workspace.id), 0);
});

test('automatic failure is visible and does not repeatedly spend model calls on the same source', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; throw new Error('Unknown financial document; review required'); });
  const file = await f.sources.upload(f.workspace.id, 'unknown.txt', Buffer.from('Unclassified data'));
  f.store.updateWorkspace(f.workspace.id, { autoClean: true });
  f.auto.enqueue(f.workspace.id); await f.auto.idle();
  assert.match(f.store.require<SourceFile>('files', file.id, f.workspace.id).error!, /review required/);
  assert.equal(f.store.list<AgentRun>('runs', f.workspace.id)[0].status, 'failed');
  assert.equal(f.store.list('records', f.workspace.id).length, 0);
  assert.equal(f.auto.enqueue(f.workspace.id), 0); assert.equal(calls, 1);
});

test('disabling automatic ingestion leaves queued files untouched after an in-flight clean', async t => {
  let release!: () => void;
  const f = await fixture(t, async () => { await new Promise<void>(resolve => { release = resolve; }); return output; });
  await f.sources.upload(f.workspace.id, 'first.txt', Buffer.from('one'));
  await f.sources.upload(f.workspace.id, 'second.txt', Buffer.from('two'));
  f.store.updateWorkspace(f.workspace.id, { autoClean: true });
  f.auto.enqueue(f.workspace.id);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  f.store.updateWorkspace(f.workspace.id, { autoClean: false }); release(); await f.auto.idle();
  assert.equal(f.store.list<AgentRun>('runs', f.workspace.id).length, 1);
  assert.equal(f.store.list<SourceFile>('files', f.workspace.id).filter(file => file.state === '上传完成').length, 1);
});
