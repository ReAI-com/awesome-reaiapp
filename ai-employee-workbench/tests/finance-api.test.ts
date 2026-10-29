import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/api.ts';
import { financeSpecId, getFinanceStandardSpecs, type FinanceKind, type FinanceReportingConfig } from '../server/finance.ts';
import type { DataRecord, Dataset } from '../shared/types.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-finance-api-'));
  const app = createApp({ dataDir: root });
  const workspace = app.store.createWorkspace({ name: '甲公司账套', role: '财务代理记账' });
  const other = app.store.createWorkspace({ name: '乙公司账套', role: '财务代理记账' });
  const server = app.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  async function request(route: string, method = 'GET', body?: unknown, expected: number | number[] = 200) {
    const response = await fetch(origin + route, { method, headers: { 'X-Workbench-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json();
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
    return result;
  }
  const route = (wid = workspace.id) => `/api/workspaces/${wid}/finance`;
  const setup = (wid = workspace.id) => request(`${route(wid)}/setup`, 'POST', { accountingBasis: 'small_enterprise', openingBalancesComplete: true });
  const add = (kind: FinanceKind, data: Record<string, unknown>, wid = workspace.id) => {
    const spec = getFinanceStandardSpecs().find(item => item.key === kind)!;
    let dataset = app.store.list<Dataset>('datasets', wid).find(item => item.specId === financeSpecId(wid, kind));
    if (!dataset) dataset = app.store.put('datasets', { id: randomUUID(), workspaceId: wid, name: spec.name, specId: financeSpecId(wid, kind), schema: spec.schema, version: 1, createdAt: new Date().toISOString() } satisfies Dataset);
    return app.store.createRecord(wid, dataset.id, { source_row: 2, ...data });
  };
  function seed() {
    const accounts = [
      add('chart_of_accounts', { account_code: '1002', account_name: '银行存款', category: 'asset', is_leaf: true }),
      add('chart_of_accounts', { account_code: '3001', account_name: '实收资本', category: 'equity', is_leaf: true }),
    ];
    const opening = [
      add('opening_balances', { balance_date: '2026-10-01', account_code: '1002', debit_fen: 100000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed' }),
      add('opening_balances', { balance_date: '2026-10-01', account_code: '3001', debit_fen: 0, credit_fen: 100000, currency: 'CNY', posting_status: 'unconfirmed' }),
    ];
    const entries = [
      add('journal_entries', { voucher_id: '记-001', line_no: 1, entry_date: '2026-10-05', account_code: '1002', debit_fen: 12000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed' }),
      add('journal_entries', { voucher_id: '记-001', line_no: 2, entry_date: '2026-10-05', account_code: '3001', debit_fen: 0, credit_fen: 12000, currency: 'CNY', posting_status: 'unconfirmed' }),
    ];
    return { accounts, opening, entries, records: [...accounts, ...opening, ...entries] };
  }
  const references = (records: DataRecord[]) => records.map(row => ({ id: row.id, version: row.version }));
  const confirm = (records: DataRecord[], expected = 200, wid = workspace.id) => request(`${route(wid)}/confirm`, 'POST', { records: references(records) }, expected);
  const reports = (wid = workspace.id) => request(`${route(wid)}/reports?from=2026-10-01&to=2026-10-31`);
  return { ...app, request, route, setup, add, seed, references, confirm, reports, workspace, other };
}

function configuration(cashEntry: DataRecord): FinanceReportingConfig {
  return {
    periodAdjustmentsConfirmed: true,
    balanceSheetLines: [
      { code: 'cash', label: '货币资金', section: 'assets', accountCodes: ['1002'], sign: 1 },
      { code: 'capital', label: '实收资本', section: 'equity', accountCodes: ['3001'], sign: -1 },
    ],
    closingEntriesReviewed: true, closingEntryRecordVersions: [],
    cashAccountCodes: ['1002'], cashFlowClassifications: [{ recordId: cashEntry.id, version: cashEntry.version, category: 'financing' }],
  };
}

test('finance setup creates 14 workspace-scoped standards idempotently and preserves the chosen policy', async t => {
  const f = await fixture(t);
  const initial = await f.request(f.route());
  assert.equal(initial.enabled, false); assert.equal(initial.reporting, null);
  const configured = await f.setup();
  assert.equal(configured.workspace.finance.accountingBasis, 'small_enterprise');
  assert.equal(configured.workspace.finance.openingBalancesComplete, true);
  await f.request(`${f.route()}/setup`, 'POST', {});
  const state = await f.request(f.route());
  assert.equal(state.standards.length, 14); assert.equal(state.settings.accountingBasis, 'small_enterprise');
  for (const spec of getFinanceStandardSpecs()) {
    const persisted = f.store.require<{ schema: unknown }>('specs', financeSpecId(f.workspace.id, spec.key), f.workspace.id);
    assert.deepEqual(persisted.schema, spec.schema);
    assert.equal(state.standards.find((row: any) => row.key === spec.key).recordCount, 0);
  }
  assert.equal(f.store.list<{ id: string }>('specs', f.workspace.id).filter(spec => spec.id.includes(':finance:')).length, 14);
  assert.equal((await f.request(f.route(f.other.id))).enabled, false);
  await f.request(`${f.route()}/setup`, 'POST', { accountingBasis: 'guessed_policy' }, 400);
});

test('confirmation requires a complete balanced voucher and current record versions, isolated by workspace', async t => {
  const f = await fixture(t); await f.setup(); await f.setup(f.other.id);
  const data = f.seed();
  await f.confirm([data.entries[0]], 400);
  assert.equal((await f.request(f.route())).confirmations.length, 0);
  await f.confirm(data.entries, 409, f.other.id);
  assert.equal((await f.request(f.route(f.other.id))).confirmations.length, 0);
  const confirmed = await f.confirm(data.records);
  assert.equal(confirmed.confirmed.length, data.records.length);
  await f.confirm(data.records);
  assert.equal(f.store.list('financeConfirmations', f.workspace.id).length, data.records.length);
  const ledger = await f.reports();
  assert.equal(ledger.status, 'ready'); assert.equal(ledger.reportingVersion, 0);
  assert.equal(ledger.trialBalance.balanced, true); assert.equal(ledger.detailLedger.length, 2);
  assert.equal((await f.reports(f.other.id)).status, 'insufficient_evidence');
  const revised = f.store.reviseRecord(f.workspace.id, data.entries[0].id, 1, { ...data.entries[0].data, description: '复核后摘要' });
  await f.confirm(data.entries, 409);
  assert.equal((await f.reports()).status, 'needs_review');
  assert.equal((await f.request(f.route())).confirmations.length, data.records.length - 1);
  await f.confirm([revised, data.entries[1]]);
  assert.equal((await f.reports()).status, 'ready');
  const imbalance = f.store.reviseRecord(f.workspace.id, revised.id, 2, { ...revised.data, debit_fen: 11999 });
  await f.confirm([imbalance, data.entries[1]], 400);
  assert.equal((await f.reports()).status, 'needs_review');
});

test('reporting configuration appends immutable revisions, detects concurrent/stale saves and drives statements', async t => {
  const f = await fixture(t); await f.setup(); await f.setup(f.other.id);
  const data = f.seed(); await f.confirm(data.records);
  const config = configuration(data.entries[0]);
  const saved = await f.request(`${f.route()}/reporting`, 'POST', { version: 0, configuration: config });
  assert.deepEqual(saved.reporting, { version: 1, configuration: config });
  assert.deepEqual((await f.request(f.route())).reporting, saved.reporting);
  const reports = await f.reports();
  assert.equal(reports.reportingVersion, 1);
  assert.equal(reports.financialStatements.balanceSheet.status, 'draft');
  assert.equal(reports.financialStatements.balanceSheet.totals.assetsFen, 112000);
  assert.equal(reports.financialStatements.cashFlowStatement.totals.netCashFlowFen, 12000);
  const competing = await Promise.all([
    f.request(`${f.route()}/reporting`, 'POST', { version: 1, configuration: { periodAdjustmentsConfirmed: false } }, [200, 409]),
    f.request(`${f.route()}/reporting`, 'POST', { version: 1, configuration: { periodAdjustmentsConfirmed: true } }, [200, 409]),
  ]);
  assert.equal(competing.filter(row => row.reporting?.version === 2).length, 1);
  assert.equal(competing.filter(row => typeof row.error === 'string').length, 1);
  await f.request(`${f.route()}/reporting`, 'POST', { version: 0, configuration: config }, 409);
  const history = f.store.list<{ id: string; workspaceId: string; version: number; configuration: FinanceReportingConfig }>('financeReporting', f.workspace.id);
  assert.deepEqual(history.map(row => row.version), [1, 2]); assert.deepEqual(history[0].configuration, config);
  assert.throws(() => f.store.put('financeReporting', { ...history[0], configuration: { periodAdjustmentsConfirmed: false } }), /只增不改/);
  assert.equal((await f.reports()).reportingVersion, 2);
  assert.equal((await f.request(f.route(f.other.id))).reporting, null);
  await f.request(`${f.route(f.other.id)}/reporting`, 'POST', { version: 0, configuration: { periodAdjustmentsConfirmed: false } });
  assert.equal((await f.request(f.route(f.other.id))).reporting.version, 1);
  assert.equal((await f.request(f.route())).reporting.version, 2);
  assert.doesNotMatch(JSON.stringify((await f.request(f.route(f.other.id))).reporting), new RegExp(data.entries[0].id));
});

test('reporting rejects malformed shapes, enums, reference versions, unknown fields and excessive lengths without writes', async t => {
  const f = await fixture(t);
  await f.request(`${f.route()}/reporting`, 'POST', { version: 0, configuration: { periodAdjustmentsConfirmed: true } }, 400);
  await f.setup();
  const line = { code: 'cash', label: '货币资金', section: 'assets', accountCodes: ['1002'], sign: 1 };
  const invalid: unknown[] = [
    null, [], {}, { periodAdjustmentsConfirmed: 'true' }, { periodAdjustmentsConfirmed: true, unknown: true },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: [{ ...line, section: 'income' }] },
    { periodAdjustmentsConfirmed: true, incomeStatementLines: [line] },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: [{ ...line, sign: 0 }] },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: [{ ...line, accountCodes: [] }] },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: [{ ...line, label: ' '.repeat(10) }] },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: [{ ...line, label: '字'.repeat(201) }] },
    { periodAdjustmentsConfirmed: true, balanceSheetLines: Array.from({ length: 501 }, () => line) },
    { periodAdjustmentsConfirmed: true, cashAccountCodes: '1002' },
    { periodAdjustmentsConfirmed: true, cashAccountCodes: ['1002', '1002'] },
    { periodAdjustmentsConfirmed: true, closingEntriesReviewed: 1 },
    { periodAdjustmentsConfirmed: true, closingEntryRecordVersions: [{ id: 'record', version: 0 }] },
    { periodAdjustmentsConfirmed: true, closingEntryRecordVersions: [{ id: '', version: 1 }] },
    { periodAdjustmentsConfirmed: true, closingEntryRecordVersions: [{ id: 'record', version: 1, workspaceId: f.other.id }] },
    { periodAdjustmentsConfirmed: true, cashFlowClassifications: [{ recordId: 'record', version: 1, category: 'guessed' }] },
    { periodAdjustmentsConfirmed: true, cashFlowClassifications: [{ recordId: 'record', version: Number.MAX_SAFE_INTEGER + 1, category: 'operating' }] },
  ];
  for (const config of invalid) await f.request(`${f.route()}/reporting`, 'POST', { version: 0, configuration: config }, 400);
  for (const version of [-1, '0', 0.5, null, Number.MAX_SAFE_INTEGER]) await f.request(`${f.route()}/reporting`, 'POST', { version, configuration: { periodAdjustmentsConfirmed: true } }, 400);
  assert.equal(f.store.list('financeReporting', f.workspace.id).length, 0);
  assert.equal((await f.request(f.route())).reporting, null);
});
