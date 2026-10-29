import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.ts';
import { Sources } from '../server/sources.ts';
import { Pipeline } from '../server/pipeline.ts';
import { financeSpecId, getFinanceStandardSpecs, type FinanceKind } from '../server/finance.ts';
import type { DataRecord, Dataset } from '../shared/types.ts';

type ReturnedRecord = DataRecord & { accountingConfirmation?: { status: 'confirmed' | 'unconfirmed'; recordVersion: number; confirmedAt?: string } };
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-finance-tools-'));
  const store = new Store(root), sources = new Sources(store);
  const workspace = store.createWorkspace({ name: '当前账套', role: '财务岗位' });
  const other = store.createWorkspace({ name: '其他账套', role: '财务岗位' });
  let query: { datasetId?: string; offset?: number; limit?: number } = {}, returned: { total: number; offset: number; records: ReturnedRecord[] }, description = '';
  // Invoke the actual tool through Pipeline's runner boundary, without a model/network call.
  const pipeline = new Pipeline(store, sources, root, async input => {
    const tool = input.tools!.find(tool => tool.name === 'query_records')!;
    description = tool.description;
    returned = await tool.execute(query) as typeof returned;
    return '已读取当前记录的账务确认依据。';
  });
  t.after(async () => { await pipeline.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const add = (kind: FinanceKind, data: Record<string, unknown>) => {
    const template = getFinanceStandardSpecs().find(item => item.key === kind)!;
    const id = financeSpecId(workspace.id, kind);
    store.put('specs', { ...template, id, workspaceId: workspace.id, version: 1, createdAt: new Date().toISOString() });
    const dataset = store.put('datasets', { id: randomUUID(), workspaceId: workspace.id, specId: id, name: template.name, schema: template.schema, version: 1, createdAt: new Date().toISOString() } satisfies Dataset);
    return store.createRecord(workspace.id, dataset.id, { source_row: 2, ...data });
  };
  const chart = add('chart_of_accounts', { account_code: '1002', account_name: '银行存款' });
  const opening = add('opening_balances', { balance_date: '2026-10-01', account_code: '1002', debit_fen: 100000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed' });
  const journal = add('journal_entries', { voucher_id: '记-001', line_no: 1, entry_date: '2026-10-05', account_code: '1002', debit_fen: 12000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed', source_posting_status: '已审核' });
  const bank = add('bank_transactions', { transaction_id: 'B1', transaction_date: '2026-10-05', direction: 'receipt', amount_fen: 12000, currency: 'CNY' });
  async function read(args: typeof query = {}) {
    query = args; const run = pipeline.chat(workspace.id, '哪些记录已经人工确认？');
    await pipeline.idle();
    assert.equal(store.require<{ status: string }>('runs', run.id, workspace.id).status, 'succeeded');
    return returned!;
  }
  function confirm(record: DataRecord, wid = workspace.id) {
    return store.put('financeConfirmations', { id: randomUUID(), workspaceId: wid, recordId: record.id, recordVersion: record.version, confirmedAt: '2026-10-28T03:00:00.000Z' });
  }
  return { store, workspace, other, chart, opening, journal, bank, read, confirm, description: () => description };
}

test('query_records exposes manual confirmations per record version without rewriting imported accounting facts', async t => {
  const f = await fixture(t);
  const before = await f.read();
  assert.equal(before.total, 4);
  for (const record of [f.chart, f.opening, f.journal]) assert.deepEqual(before.records.find(row => row.id === record.id)?.accountingConfirmation, { status: 'unconfirmed', recordVersion: 1 });
  assert.equal(before.records.find(row => row.id === f.bank.id)?.accountingConfirmation, undefined);
  for (const record of [f.chart, f.opening, f.journal]) f.confirm(record);
  const after = await f.read();
  for (const record of [f.chart, f.opening, f.journal]) {
    const result = after.records.find(row => row.id === record.id)!;
    assert.deepEqual(result.accountingConfirmation, { status: 'confirmed', recordVersion: 1, confirmedAt: '2026-10-28T03:00:00.000Z' });
    assert.deepEqual(result.data, record.data);
    assert.deepEqual(f.store.require<DataRecord>('records', record.id, f.workspace.id), record);
  }
  assert.equal(after.records.find(row => row.id === f.journal.id)?.data.posting_status, 'unconfirmed');
  assert.match(f.description(), /posting_status.*不是当前人工确认依据/);
  assert.match(f.description(), /accountingConfirmation.status=confirmed/);
  const page = await f.read({ offset: 1, limit: 1 });
  assert.equal(page.total, 4); assert.equal(page.records.length, 1); assert.equal(page.records[0].accountingConfirmation?.status, 'confirmed');
});

test('foreign workspace confirmations and confirmations of older revisions never confirm the returned version', async t => {
  const f = await fixture(t);
  f.confirm(f.journal, f.other.id);
  const unrelated = { ...f.journal, id: randomUUID() }; f.confirm(unrelated);
  let result = await f.read({ datasetId: f.journal.datasetId });
  assert.equal(result.total, 1);
  assert.deepEqual(result.records[0].accountingConfirmation, { status: 'unconfirmed', recordVersion: 1 });
  f.confirm(f.journal);
  assert.equal((await f.read({ datasetId: f.journal.datasetId })).records[0].accountingConfirmation?.status, 'confirmed');
  const revised = f.store.reviseRecord(f.workspace.id, f.journal.id, 1, { ...f.journal.data, description: '修订后必须重新确认' });
  result = await f.read({ datasetId: revised.datasetId });
  assert.deepEqual(result.records[0].accountingConfirmation, { status: 'unconfirmed', recordVersion: 2 });
  assert.equal(result.records[0].data.posting_status, 'unconfirmed');
  f.confirm(revised, f.other.id);
  assert.deepEqual((await f.read({ datasetId: revised.datasetId })).records[0].accountingConfirmation, { status: 'unconfirmed', recordVersion: 2 });
  f.confirm(revised);
  assert.deepEqual((await f.read({ datasetId: revised.datasetId })).records[0].accountingConfirmation, { status: 'confirmed', recordVersion: 2, confirmedAt: '2026-10-28T03:00:00.000Z' });
});
