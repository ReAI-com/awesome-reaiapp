import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.ts';
import { Sources, sourceCoverageIssues } from '../server/sources.ts';
import { Pipeline } from '../server/pipeline.ts';
import { AutoCleaner } from '../server/auto-cleaner.ts';
import { financeSpecId, getFinanceStandardSpecs } from '../server/finance.ts';
import type { AgentConfig, AgentRun, CleaningSpec, SourceFile } from '../shared/types.ts';

async function fixture(t: TestContext, output: Record<string, unknown>[] = [], runner?: ConstructorParameters<typeof Pipeline>[3]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'employee-coverage-'));
  const store = new Store(directory), sources = new Sources(store);
  const workspace = store.createWorkspace({ name: '覆盖核验', role: '合成财务测试' });
  const wid = workspace.id;
  store.updateWorkspace(wid, { autoClean: true, finance: { enabled: true, accountingBasis: 'unselected', currency: 'CNY' } });
  const agent = store.list<AgentConfig>('agents', wid)[0];
  store.put('agents', { ...agent, provider: 'fixture', model: 'fixture' });
  const standard = getFinanceStandardSpecs().find(spec => spec.key === 'bank_transactions')!;
  store.put('specs', { ...standard, id: financeSpecId(wid, standard.key), workspaceId: wid, version: 1, createdAt: new Date().toISOString() } satisfies CleaningSpec);
  let prompt = '';
  const pipeline = new Pipeline(store, sources, directory, async input => {
    prompt = input.prompt;
    if (runner) return runner(input);
    return JSON.stringify({ name: '银行流水', schema: standard.schema, records: output, issues: [] });
  });
  const auto = new AutoCleaner(store, pipeline);
  t.after(async () => { auto.stop(); await pipeline.close(); await auto.idle(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, sources, pipeline, auto, wid, lastPrompt: () => prompt };
}
const transaction = (id: string, row: number, sheet?: string) => ({ transaction_id: id, transaction_date: '2026-10-01', direction: 'receipt', amount_fen: 10000, currency: 'CNY', source_row: row, ...(sheet ? { source_sheet: sheet } : {}) });
const csv = Buffer.from('流水号,日期,方向,金额,币种\nT1,2026-10-01,收入,100,CNY\nT2,2026-10-01,收入,100,CNY\n');

test('CSV coverage keeps actual physical row anchors across blank lines, Unicode and quoted CRLF cells', async t => {
  const f = await fixture(t);
  const file = await f.sources.upload(f.wid, 'physical.csv', Buffer.from('\uFEFF\r\n流水,备注\r\n\r\nT1,"甲\r\n乙"\r\n\r\nT2,尾'));
  const extracted = await f.sources.extractWithCoverage(f.wid, file.id, file.revisionId);
  assert.deepEqual(extracted.table?.headers.map(row => row.source_row), [2]);
  assert.deepEqual(extracted.table?.rows.map(row => row.source_row), [4, 7]);
  assert.deepEqual(JSON.parse(extracted.text), [{ 流水: 'T1', 备注: '甲\r\n乙' }, { 流水: 'T2', 备注: '尾' }]);
  assert.deepEqual(sourceCoverageIssues(extracted, [transaction('T1', 4), transaction('T2', 7)]), []);
});

test('XLSX coverage preserves sparse row numbers and distinguishes identical row numbers on separate sheets', async t => {
  const f = await fixture(t);
  const book = new ExcelJS.Workbook();
  for (const name of ['账户甲', '账户乙']) {
    const sheet = book.addWorksheet(name); sheet.getRow(2).values = ['流水号', '金额']; sheet.getRow(5).values = [`${name}-1`, 100];
  }
  const file = await f.sources.upload(f.wid, 'sheets.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  const extracted = await f.sources.extractWithCoverage(f.wid, file.id, file.revisionId);
  assert.deepEqual(extracted.table?.rows.map(({ source_sheet, source_row }) => ({ source_sheet, source_row })), [{ source_sheet: '账户甲', source_row: 5 }, { source_sheet: '账户乙', source_row: 5 }]);
  assert(sourceCoverageIssues(extracted, [transaction('T1', 5)]).some(issue => issue.includes('无法在原件')));
  assert(sourceCoverageIssues(extracted, [transaction('T1', 5, '账户甲')]).some(issue => issue.includes('「账户乙」第5行')));
  assert.deepEqual(sourceCoverageIssues(extracted, [transaction('T1', 5, '账户甲'), transaction('T2', 5, '账户乙')]), []);
});

test('automatic financial cleaning cannot publish a nonempty but partial model result; explicit human review remains possible', async t => {
  const partial = [transaction('T1', 2)]; const f = await fixture(t, partial);
  const file = await f.sources.upload(f.wid, 'two-rows.csv', csv);
  f.auto.enqueue(f.wid); await f.auto.idle();
  const run = f.store.list<AgentRun>('runs', f.wid)[0];
  assert.equal(run.status, 'waiting_review');
  assert.equal(f.store.list('records', f.wid).length, 0);
  assert.notEqual(f.store.require<SourceFile>('files', file.id, f.wid).state, '清洗完成');
  assert((run.result as { issues: string[] }).issues.some(issue => issue.includes('第3行')));
  assert.match(f.lastPrompt(), /"source_row":3/);
  assert.equal(f.auto.enqueue(f.wid), 0);
  f.pipeline.review(f.wid, run.id, partial, false);
  assert.equal(f.store.require<AgentRun>('runs', run.id, f.wid).status, 'succeeded');
  assert.equal(f.store.list('records', f.wid).length, 1);
});

test('complete financial table coverage publishes automatically while invented source anchors require review', async t => {
  const f = await fixture(t, [transaction('T1', 2), transaction('T2', 3)]);
  const file = await f.sources.upload(f.wid, 'complete.csv', csv);
  f.auto.enqueue(f.wid); await f.auto.idle();
  assert.equal(f.store.require<SourceFile>('files', file.id, f.wid).state, '清洗完成');
  assert.equal(f.store.list('records', f.wid).length, 2);
  const extracted = await f.sources.extractWithCoverage(f.wid, file.id, file.revisionId);
  assert(sourceCoverageIssues(extracted, [transaction('T1', 2), transaction('T2', 99)]).some(issue => issue.includes('无法在原件')));
  assert(sourceCoverageIssues(extracted, [transaction('T1', 2), transaction('T2', 2)]).some(issue => issue.includes('第3行')));
});

test('non-tabular financial evidence is retained for human completeness review, not rejected or silently certified', async t => {
  const rows = [transaction('T1', 1)]; const f = await fixture(t, rows);
  await f.sources.upload(f.wid, 'statement.txt', Buffer.from('合成资料：T1 于 2026-10-01 收入 CNY 100。'));
  f.auto.enqueue(f.wid); await f.auto.idle();
  const run = f.store.list<AgentRun>('runs', f.wid)[0];
  assert.equal(run.status, 'waiting_review');
  assert((run.result as { issues: string[] }).issues.some(issue => issue.includes('无法建立可靠')));
  f.pipeline.review(f.wid, run.id, rows, false);
  assert.equal(f.store.list('records', f.wid).length, 1);
});

test('a refused financial route preserves a bounded explanation and publishes no data', async t => {
  const f = await fixture(t, [], async () => JSON.stringify({ specId: '', reason: `包含多个客户，需拆分账套。${'说明'.repeat(400)}` }));
  const spec = getFinanceStandardSpecs().find(item => item.key === 'company_profile')!;
  f.store.put('specs', { ...spec, id: financeSpecId(f.wid, spec.key), workspaceId: f.wid, version: 1, createdAt: new Date().toISOString() } satisfies CleaningSpec);
  const file = await f.sources.upload(f.wid, 'mixed.csv', csv);
  f.auto.enqueue(f.wid); await f.auto.idle();
  const run = f.store.list<AgentRun>('runs', f.wid)[0];
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /包含多个客户，需拆分账套/);
  assert(run.error!.length < 600);
  assert(f.store.require<SourceFile>('files', file.id, f.wid).revisionId);
  assert.equal(f.store.list('records', f.wid).length, 0);
});
