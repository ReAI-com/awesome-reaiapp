import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type PublishCleaningInput } from '../server/store.ts';
import type { AgentConfig, AgentRun, CleaningSpec, JsonSchema, SourceFile } from '../shared/types.ts';

const schema: JsonSchema = { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name', 'amount'], additionalProperties: false };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'employee-store-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const workspace = store.createWorkspace({ name: '财务工作区', role: '财务' });
  const spec = store.list<CleaningSpec>('specs', workspace.id)[0];
  function job(fileId: string = randomUUID(), generation = 1): PublishCleaningInput {
    const existing = store.get<SourceFile>('files', fileId, workspace.id);
    const revisionId = randomUUID(); const runId = randomUUID(); const timestamp = new Date().toISOString();
    store.put('files', { ...existing, id: fileId, workspaceId: workspace.id, name: '账单.csv', revisionId, hash: revisionId, size: 12, state: existing?.cleanedRevisionId ? '更新中' : '清洗中', generation, updatedAt: timestamp } satisfies SourceFile);
    store.put('revisions', { id: revisionId, workspaceId: workspace.id, fileId, hash: revisionId, path: join(dir, revisionId), size: 12, createdAt: timestamp });
    store.put('runs', { id: runId, workspaceId: workspace.id, agentId: 'agent-001', kind: 'clean', status: 'running', fileId, inputRevisionId: revisionId, generation, specVersion: spec.version, configVersion: 1, events: [], createdAt: timestamp, updatedAt: timestamp } satisfies AgentRun);
    return { workspaceId: workspace.id, fileId, revisionId, generation, runId, specId: spec.id, specVersion: spec.version, datasetName: '收支', schema, records: [{ name: '销售', amount: 100 }] };
  }
  return { store, workspace, spec, job };
}
const status = (expected: number) => (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === expected;

test('工作区独立初始化，不伪造业务记录，Agent 密钥不进入全量状态', t => {
  const { store, workspace } = fixture(t);
  const second = store.createWorkspace({ name: '人事工作区', role: '人事' });
  const config = store.get<AgentConfig>('agents', 'agent-001', workspace.id)!;
  store.put('agents', { ...config, apiKey: 'test-secret', model: 'my-model' });
  assert.equal(store.state(workspace.id).records.length, 0);
  assert.equal(store.state(workspace.id).agents.length, 3);
  assert.equal(store.state(workspace.id).agents[0].hasApiKey, true);
  assert.equal('apiKey' in store.state(workspace.id).agents[0], false);
  assert.equal(store.get<AgentConfig>('agents', 'agent-001', second.id)?.model, '');
  assert.equal(store.state(second.id).agents[0].hasApiKey, false);
});

test('清洗全批发布到真实 SQLite typed 表，重复请求幂等', t => {
  const { store, workspace, job } = fixture(t);
  const input = job(); const result = store.publishCleaning(input);
  assert.equal(result.file.state, '清洗完成');
  assert.equal(result.file.cleanedRevisionId, input.revisionId);
  assert.equal(store.get<AgentRun>('runs', input.runId, workspace.id)?.status, 'succeeded');
  const table = store.datasetTable(workspace.id, result.dataset.id);
  const row = store.db.prepare(`SELECT field_amount, typeof(field_amount) AS storage_type FROM "${table.name}" WHERE __current=1`).get()!;
  assert.equal(row.field_amount, 100);
  assert.equal(row.storage_type, 'real');
  assert.deepEqual(store.publishCleaning(input), result);
  assert.equal(store.state(workspace.id).records.length, 1);
  assert.throws(() => store.publishCleaning({ ...input, records: [{ name: '重复任务的不同结果', amount: 2 }] }), status(409));
});

test('任一记录 Schema 无效时整批不发布，也不生成数据表', t => {
  const { store, workspace, job } = fixture(t);
  const input = job(); input.records.push({ name: '坏数据', amount: '不是数字' });
  assert.throws(() => store.publishCleaning(input), status(400));
  assert.equal(store.state(workspace.id).records.length, 0);
  assert.equal(store.state(workspace.id).datasets.length, 0);
  assert.equal(store.get<SourceFile>('files', input.fileId, workspace.id)?.state, '清洗中');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM dataset_tables').get()?.count, 0);
});

test('更新期间旧 B 可用，只替换对应文件，旧版本保留', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const initial = store.publishCleaning(first);
  const otherFile = store.publishCleaning(job());
  const update = job(first.fileId, 2); update.records = [{ name: '已更新', amount: 200 }];
  assert.equal(store.state(workspace.id).records.length, 2);
  assert.equal(store.get<{ data: { amount: number } }>('records', initial.records[0].id, workspace.id)?.data.amount, 100);
  const updated = store.publishCleaning(update);
  assert.equal(updated.file.state, '更新完成');
  assert.equal(store.state(workspace.id).records.length, 2);
  assert.ok(store.get('records', otherFile.records[0].id, workspace.id));
  assert.equal(store.get('records', initial.records[0].id, workspace.id), undefined);
  assert.equal(store.history(initial.records[0].id, workspace.id)[0].data.amount, 100);
  const table = store.datasetTable(workspace.id, initial.dataset.id);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}" WHERE __current=1`).get()?.count, 2);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get()?.count, 3);
});

test('更新失败不改变已发布 B，数据库写入异常也整批回滚', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const initial = store.publishCleaning(first);
  const update = job(first.fileId, 2); update.records = [{ name: '首行合法', amount: 20 }, { name: '触发写入失败', amount: 13 }];
  const table = store.datasetTable(workspace.id, initial.dataset.id);
  store.db.exec(`CREATE TRIGGER reject_test_record BEFORE INSERT ON "${table.name}" WHEN NEW.field_amount=13 BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
  assert.throws(() => store.publishCleaning(update), /test write failure/);
  assert.deepEqual(store.state(workspace.id).records, initial.records);
  assert.equal(store.get<SourceFile>('files', first.fileId, workspace.id)?.state, '更新中');
  assert.equal(store.history(initial.records[0].id, workspace.id).length, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM "${table.name}" WHERE __current=1`).get()?.count, 1);
});

test('过期文件 generation、规范与已取消任务均不能发布迟到结果', t => {
  const { store, workspace, spec, job } = fixture(t);
  const stale = job(); job(stale.fileId, 2);
  assert.throws(() => store.publishCleaning(stale), status(409));
  const changedSpec = job(); store.put('specs', { ...spec, version: 2 });
  assert.throws(() => store.publishCleaning(changedSpec), status(409));
  store.put('specs', spec);
  const cancelled = job(); const run = store.get<AgentRun>('runs', cancelled.runId, workspace.id)!;
  store.put('runs', { ...run, status: 'cancelled' });
  assert.throws(() => store.publishCleaning(cancelled), status(409));
  assert.equal(store.state(workspace.id).records.length, 0);
});

test('人工更正校验版本和 Schema，并阻止清洗静默覆盖', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const initial = store.publishCleaning(first); const record = initial.records[0];
  assert.throws(() => store.reviseRecord(workspace.id, record.id, 1, { name: '错值', amount: 'x' }), status(400));
  const revised = store.reviseRecord(workspace.id, record.id, 1, { name: '人工更正', amount: 105 });
  assert.equal(revised.version, 2); assert.equal(revised.manual, true);
  assert.throws(() => store.reviseRecord(workspace.id, record.id, 1, { name: '过期更正', amount: 110 }), status(409));
  assert.equal(store.history(record.id, workspace.id).length, 2);
  assert.equal(store.history(record.id, workspace.id)[0].data.amount, 100);
  assert.throws(() => store.publishCleaning(job(first.fileId, 2)), status(409));
  assert.equal(store.state(workspace.id).records[0].data.amount, 105);
});

test('Schema 变化生成新数据集版本与新表，旧结构和历史不被破坏', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const initial = store.publishCleaning(first);
  const update = job(first.fileId, 2);
  update.schema = { type: 'object', properties: { title: { type: 'string' }, count: { type: 'integer' } }, required: ['title', 'count'], additionalProperties: false };
  update.records = [{ title: '新版字段', count: 3 }];
  const updated = store.publishCleaning(update);
  assert.notEqual(initial.dataset.id, updated.dataset.id);
  assert.equal(updated.dataset.version, 2);
  assert.equal(store.state(workspace.id).datasets.length, 2);
  const oldTable = store.datasetTable(workspace.id, initial.dataset.id);
  const newTable = store.datasetTable(workspace.id, updated.dataset.id);
  assert.notEqual(oldTable.name, newTable.name);
  assert.equal(store.db.prepare(`SELECT field_amount FROM "${oldTable.name}"`).get()?.field_amount, 100);
  assert.equal(store.db.prepare(`SELECT field_count FROM "${newTable.name}" WHERE __current=1`).get()?.field_count, 3);
});

test('跨岗位对象引用不可用于发布、修改或读取历史', t => {
  const { store, workspace, job } = fixture(t);
  const input = job(); const initial = store.publishCleaning(input);
  const second = store.createWorkspace({ name: '另一岗位', role: '销售' });
  assert.equal(store.get('files', input.fileId, second.id), undefined);
  assert.equal(store.history(initial.records[0].id, second.id).length, 0);
  assert.throws(() => store.reviseRecord(second.id, initial.records[0].id, 1, { name: '越界', amount: 1 }), status(404));
  assert.throws(() => store.publishCleaning({ ...input, workspaceId: second.id }), status(404));
  assert.throws(() => store.put('revisions', { id: randomUUID(), workspaceId: second.id, fileId: input.fileId }), status(404));
  assert.equal(store.state(workspace.id).records.length, 1);
});

test('原件版本只增不改，记录版本集合改变会阻止发布', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const initial = store.publishCleaning(first);
  const revision = store.get<Record<string, unknown>>('revisions', first.revisionId, workspace.id)!;
  assert.throws(() => store.put('revisions', { ...revision, hash: 'changed' }), status(409));
  assert.throws(() => store.remove('revisions', first.revisionId, workspace.id), status(409));
  const update = job(first.fileId, 2); update.expectedRecordVersions = [{ id: initial.records[0].id, version: 99 }];
  assert.throws(() => store.publishCleaning(update), status(409));
  assert.equal(store.state(workspace.id).records[0].data.amount, 100);
});

test('REST 人工新增保留来源区分，生成 typed 数据并纳入修订历史', t => {
  const { store, workspace, job } = fixture(t);
  const input = job(); const initial = store.publishCleaning(input);
  assert.throws(() => store.createRecord(workspace.id, initial.dataset.id, { name: '无金额' }), status(400));
  const manual = store.createRecord(workspace.id, initial.dataset.id, { name: '人工补录', amount: 50 });
  assert.equal(manual.manual, true); assert.equal(manual.sourceFileId, undefined);
  assert.equal(store.history(manual.id, workspace.id).length, 1);
  const revised = store.reviseRecord(workspace.id, manual.id, 1, { name: '人工补录', amount: 55 });
  assert.equal(revised.version, 2); assert.equal(store.history(manual.id, workspace.id).length, 2);
  store.publishCleaning(job(input.fileId, 2));
  assert.equal(store.get<{ data: { amount: number } }>('records', manual.id, workspace.id)?.data.amount, 55);
  const table = store.datasetTable(workspace.id, initial.dataset.id);
  assert.equal(store.db.prepare(`SELECT field_amount FROM "${table.name}" WHERE __id=? AND __current=1`).get(manual.id)?.field_amount, 55);
});

test('Schema 字段安全引用为 SQL 标识符，非法数字和大小写冲突拒绝发布', t => {
  const { store, workspace, job } = fixture(t);
  const key = 'x"); DROP TABLE workspaces; --';
  const input = job();
  input.schema = { type: 'object', properties: { [key]: { type: 'string' } }, required: [key], additionalProperties: false };
  input.records = [{ [key]: '正常内容' }];
  const result = store.publishCleaning(input);
  assert.equal(store.listWorkspaces().length, 1);
  assert.equal(store.datasetTable(workspace.id, result.dataset.id).columns[0].field, key);
  const invalid = job(); invalid.records = [{ name: '非有限数', amount: Infinity }];
  assert.throws(() => store.publishCleaning(invalid), status(400));
  const collision = job();
  collision.schema = { type: 'object', properties: { Name: { type: 'string' }, name: { type: 'string' } } };
  collision.records = [];
  assert.throws(() => store.publishCleaning(collision), status(400));
});

test('通用持久化拒绝缺少归属和跨岗位引用，require 始终为范围内查询', t => {
  const { store, workspace, job } = fixture(t);
  const input = job(); const initial = store.publishCleaning(input);
  const second = store.createWorkspace({ name: '第二岗位', role: '采购' });
  assert.throws(() => store.put('messages', { id: randomUUID(), content: '没有归属' }), status(400));
  assert.throws(() => store.put('fileEvents', { id: randomUUID(), workspaceId: second.id, fileId: input.fileId }), status(404));
  assert.throws(() => store.put('boards', { id: randomUUID(), workspaceId: second.id, datasetIds: [initial.dataset.id] }), status(404));
  assert.throws(() => store.require('records', initial.records[0].id, second.id), status(404));
  assert.equal(store.require<{ id: string }>('records', initial.records[0].id, workspace.id).id, initial.records[0].id);
});

test('岗位不能绑定相同、嵌套或符号链接指向的重叠目录', t => {
  const { store, workspace } = fixture(t);
  assert.throws(() => store.createWorkspace({ name: '重复', role: '销售', directory: workspace.directory }), status(409));
  assert.throws(() => store.createWorkspace({ name: '子目录', role: '销售', directory: join(workspace.directory, 'nested') }), status(409));
  assert.equal(existsSync(join(workspace.directory, 'nested')), false);
  assert.throws(() => store.createWorkspace({ name: '父目录', role: '销售', directory: join(workspace.directory, '..') }), status(409));
  const alias = join(store.dataDir, 'alias'); symlinkSync(workspace.directory, alias, 'dir');
  assert.throws(() => store.createWorkspace({ name: '别名', role: '销售', directory: alias }), status(409));
  assert.throws(() => store.createWorkspace({ name: '别名子目录', role: '销售', directory: join(alias, 'new-child') }), status(409));
  assert.equal(store.listWorkspaces().length, 1);
});

test('私有数据目录和 SQLite 文件权限收紧，已有用户目录权限不变', t => {
  const { store, workspace } = fixture(t);
  assert.equal(statSync(store.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(workspace.directory).mode & 0o777, 0o700);
  for (const file of [store.dbPath, `${store.dbPath}-wal`, `${store.dbPath}-shm`]) if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600);
  const userFolder = join(store.dataDir, 'user-existing'); mkdirSync(userFolder); chmodSync(userFolder, 0o755);
  store.createWorkspace({ name: '已有目录', role: '销售', directory: userFolder });
  assert.equal(statSync(userFolder).mode & 0o777, 0o755);
});

test('清洗规范与路由快照只能追加，规则定义按岗位持久化', t => {
  const { store, workspace, spec } = fixture(t);
  const snapshot = { ...spec, id: `${spec.id}:v${spec.version}` };
  store.put('specVersions', snapshot); store.put('specVersions', snapshot);
  assert.throws(() => store.put('specVersions', { ...snapshot, prompt: '覆写旧规范' }), status(409));
  assert.throws(() => store.remove('specVersions', snapshot.id, workspace.id), status(409));
  const routing = { id: randomUUID(), workspaceId: workspace.id, specs: [snapshot], createdAt: new Date().toISOString() };
  store.put('routingSnapshots', routing);
  assert.throws(() => store.put('routingSnapshots', { ...routing, specs: [] }), status(409));
  store.put('checkRules', { id: 'rule-1', workspaceId: workspace.id, name: '金额检查', version: 1, rule: '金额非负' });
  assert.equal(store.list('checkRules', workspace.id).length, 1);
  assert.equal(store.list('specVersions', workspace.id).length, 1);
});

test('模型改变表名不会分裂同一规范的数据集，Schema 版本按规范递增', t => {
  const { store, workspace, job } = fixture(t);
  const initial = store.publishCleaning(job());
  const second = job(); second.datasetName = '模型临时改名';
  const unchanged = store.publishCleaning(second);
  assert.equal(unchanged.dataset.id, initial.dataset.id);
  assert.equal(unchanged.dataset.name, '收支');
  assert.equal(store.state(workspace.id).datasets.length, 1);
  const third = job(); third.datasetName = '另一个模型表名';
  third.schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
  third.records = [{ title: '新Schema' }];
  const changed = store.publishCleaning(third);
  assert.equal(changed.dataset.version, 2);
  assert.equal(changed.dataset.name, '收支');
  assert.equal(store.state(workspace.id).datasets.length, 2);
});

test('复核确认可替换人工修订，必须匹配复核版本并完整保留历史', t => {
  const { store, workspace, job } = fixture(t);
  const first = job(); const original = store.publishCleaning(first).records[0];
  const revised = store.reviseRecord(workspace.id, original.id, 1, { name: '人工校正', amount: 105 });
  const update = job(first.fileId, 2); update.records = [{ name: '复核后的新结果', amount: 120 }];
  update.expectedRecordVersions = [{ id: revised.id, version: revised.version }];
  assert.throws(() => store.publishCleaning(update), status(409));
  assert.throws(() => store.publishCleaning({ ...update, replaceManual: true, expectedRecordVersions: undefined }), status(409));
  const latest = store.reviseRecord(workspace.id, original.id, 2, { name: '复核期间再次校正', amount: 110 });
  assert.throws(() => store.publishCleaning({ ...update, replaceManual: true }), status(409));
  const result = store.publishCleaning({ ...update, replaceManual: true, expectedRecordVersions: [{ id: latest.id, version: latest.version }] });
  assert.equal(result.file.state, '更新完成');
  assert.equal(result.records[0].data.amount, 120);
  assert.equal(store.get('records', original.id, workspace.id), undefined);
  const history = store.history(original.id, workspace.id);
  assert.deepEqual(history.map(record => record.data.amount), [100, 105, 110]);
  assert.equal(history[2].historyReason, 'reviewed_cleaning_replaced');
});
