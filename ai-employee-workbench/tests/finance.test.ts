import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { buildFinanceLedger, FINANCE_KINDS, FINANCE_STANDARD_SPECS, financeKindFromSpecId, financeSpecId, getFinanceStandardSpecs, validateFinanceRows, type FinanceLedgerInput, type FinanceLedgerRecord } from '../server/finance.ts';

function fixture(): FinanceLedgerInput {
  const records: FinanceLedgerRecord[] = [];
  const add = (kind: FinanceLedgerRecord['kind'], id: string, data: Record<string, unknown>) => records.push({ id, workspaceId: 'company-a', version: 1, kind, data: { source_row: records.length + 2, ...data } });
  const codes: [string, string, number, number][] = [['1002', '银行存款', 100000, 0], ['3001', '实收资本', 0, 100000], ['5001', '主营业务收入', 0, 0], ['5602', '管理费用', 0, 0]];
  for (const [code, name, debit, credit] of codes) {
    add('chart_of_accounts', `chart-${code}`, { account_code: code, account_name: name, is_leaf: true, category: code === '1002' ? 'asset' : code === '3001' ? 'equity' : code === '5001' ? 'income' : 'expense' });
    add('opening_balances', `opening-${code}`, { balance_date: '2026-10-01', account_code: code, debit_fen: debit, credit_fen: credit, currency: 'CNY', posting_status: 'unconfirmed' });
  }
  add('journal_entries', 'sale-bank', { voucher_id: '记-001', line_no: 1, entry_date: '2026-10-05', account_code: '1002', debit_fen: 12000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed', description: '已确认服务收入收款' });
  add('journal_entries', 'sale-income', { voucher_id: '记-001', line_no: 2, entry_date: '2026-10-05', account_code: '5001', debit_fen: 0, credit_fen: 12000, currency: 'CNY', posting_status: 'unconfirmed' });
  add('journal_entries', 'cost-expense', { voucher_id: '记-002', line_no: 1, entry_date: '2026-10-06', account_code: '5602', debit_fen: 2000, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed' });
  add('journal_entries', 'cost-bank', { voucher_id: '记-002', line_no: 2, entry_date: '2026-10-06', account_code: '1002', debit_fen: 0, credit_fen: 2000, currency: 'CNY', posting_status: 'unconfirmed' });
  return { workspaceId: 'company-a', from: '2026-10-01', to: '2026-10-31', currency: 'CNY', accountingBasis: 'small_enterprise', openingBalancesComplete: true, records, confirmedRecordVersions: records.map(r => ({ id: r.id, version: r.version })) };
}

test('14 financial standards have stable workspace-scoped keys, independent schemas and safe import instructions', () => {
  assert.equal(FINANCE_STANDARD_SPECS.length, 14);
  const ajv = new Ajv({ strict: false });
  for (const spec of FINANCE_STANDARD_SPECS) {
    assert(FINANCE_KINDS.includes(spec.key)); assert.equal(spec.schema.additionalProperties, false); assert(spec.schema.required?.includes('source_row')); ajv.compile(spec.schema);
    assert.equal(financeKindFromSpecId(financeSpecId('company-a', spec.key)), spec.key);
    assert.notEqual(financeSpecId('company-a', spec.key), financeSpecId('company-b', spec.key));
    assert(Object.values(spec.schema.properties).every(p => typeof p.type === 'string'));
  }
  assert.equal(financeKindFromSpecId('unrelated:bank_transactions'), undefined);
  const copy = getFinanceStandardSpecs(); copy[0].name = 'changed'; assert.notEqual(FINANCE_STANDARD_SPECS[0].name, 'changed');
});

test('financial import validation preserves missing/invalid facts as review issues, never invents cents or dates', () => {
  const valid = { transaction_id: 'B1', transaction_date: '2026-10-01', direction: 'payment', amount_fen: 12345, currency: 'CNY', source_row: 2, invoice_id: '' };
  assert.deepEqual(validateFinanceRows('bank_transactions', [valid]), []);
  assert(validateFinanceRows('bank_transactions', [{ ...valid, amount_fen: 12.345 }]).length);
  assert(validateFinanceRows('bank_transactions', [{ ...valid, amount_fen: Number.MAX_SAFE_INTEGER + 1 }]).length);
  assert(validateFinanceRows('bank_transactions', [{ ...valid, transaction_date: '2026-99-99' }]).some(s => s.includes('日期')));
  assert(validateFinanceRows('bank_transactions', [{ ...valid, transaction_id: '' }]).some(s => s.includes('关键字段')));
  assert(validateFinanceRows('bank_transactions', [valid, valid]).some(s => s.includes('重复')));
  assert(validateFinanceRows('sales_invoices', [{ invoice_id: 'I1', invoice_date: '2026-10-01', amount_fen: 100, net_amount_fen: 90, tax_amount_fen: 20, currency: 'CNY', source_row: 2 }]).some(s => s.includes('价税')));
  assert(validateFinanceRows('company_profile', [{ company_name: 'A', source_row: 2 }, { company_name: 'B', source_row: 3 }]).some(s => s.includes('一个客户')));
});

test('receivable and payable business identities reject repeated or conflicting document facts', () => {
  const row = { document_id: 'DOC-001', counterparty: '合成往来甲', currency: 'CNY', amount_fen: 10000, balance_fen: 8000, source_row: 2 };
  for (const kind of ['receivables', 'payables'] as const) {
    assert.deepEqual(validateFinanceRows(kind, [row]), []);
    assert(validateFinanceRows(kind, [row, row]).some(issue => issue.includes('重复')));
    assert(validateFinanceRows(kind, [row, { ...row, balance_fen: 6000, source_row: 3 }]).some(issue => issue.includes('重复')));
    assert.deepEqual(validateFinanceRows(kind, [row, { ...row, counterparty: '合成往来乙', source_row: 3 }, { ...row, currency: 'USD', source_row: 4 }]), []);
  }
});

test('confirmed balanced entries produce exact ledgers and trial balance, without fabricating formal statements', () => {
  const result = buildFinanceLedger(fixture());
  assert.equal(result.status, 'ready'); assert.equal(result.detailLedger.length, 4); assert.equal(result.generalLedger.length, 4);
  assert.deepEqual(result.trialBalance, { balanced: true, openingDebitFen: 100000, openingCreditFen: 100000, debitFen: 14000, creditFen: 14000, closingDebitFen: 112000, closingCreditFen: 112000 });
  const bank = result.generalLedger.find(r => r.accountCode === '1002')!;
  assert.equal(bank.closingDebitFen, 110000); assert.equal(bank.debitFen, 12000); assert.equal(bank.creditFen, 2000);
  assert.equal(result.detailLedger.find(r => r.recordId === 'cost-bank')?.balanceFen, 110000);
  assert(Object.values(result.financialStatements).every(s => s.status === 'insufficient_evidence'));
});

test('missing opening evidence and stale or absent manual confirmation block ledger publication', () => {
  const input = fixture(); input.openingBalancesComplete = false;
  assert.equal(buildFinanceLedger(input).status, 'insufficient_evidence');
  input.openingBalancesComplete = true; input.confirmedRecordVersions = [];
  assert.equal(buildFinanceLedger(input).status, 'needs_review');
  const stale = fixture(); stale.records.find(r => r.id === 'sale-bank')!.version = 2;
  assert(buildFinanceLedger(stale).issues.some(s => s.includes('v2')));
  const spoof = fixture(); spoof.records.find(r => r.id === 'sale-bank')!.data.posting_status = 'confirmed';
  assert(buildFinanceLedger(spoof).issues.some(s => s.includes('不能由模型')));
});

test('used chart versions require independent confirmation and remain in ledger evidence', () => {
  const input = reporting(fixture());
  const unconfirmed = structuredClone(input);
  unconfirmed.confirmedRecordVersions = unconfirmed.confirmedRecordVersions.filter(ref => ref.id !== 'chart-5001');
  const missing = buildFinanceLedger(unconfirmed);
  assert.equal(missing.status, 'needs_review');
  assert(missing.issues.some(issue => issue.includes('chart-5001 v1') && issue.includes('人工确认')));
  assert.equal(missing.trialBalance, null);
  assert(Object.values(missing.financialStatements).every(statement => statement.status === 'insufficient_evidence'));

  const revised = input.records.find(record => record.id === 'chart-5001')!;
  revised.version = 2; revised.data.account_name = '修订后的营业收入';
  const stale = buildFinanceLedger(input);
  assert.equal(stale.status, 'needs_review');
  assert(stale.issues.some(issue => issue.includes('chart-5001 v2')));
  input.confirmedRecordVersions.push({ id: revised.id, version: revised.version });
  const renewed = buildFinanceLedger(input);
  assert.equal(renewed.status, 'ready');
  assert.deepEqual(renewed.evidence.filter(ref => ref.id.startsWith('chart-')), [
    { id: 'chart-1002', version: 1 }, { id: 'chart-3001', version: 1 },
    { id: 'chart-5001', version: 2 }, { id: 'chart-5602', version: 1 },
  ]);
  assert.equal(renewed.generalLedger.find(row => row.accountCode === '5001')?.accountName, '修订后的营业收入');
  assert.equal(renewed.financialStatements.incomeStatement.status, 'draft');

  input.records.push({ id: 'unused-account', workspaceId: 'company-a', version: 1, kind: 'chart_of_accounts', data: { account_code: 'UNUSED', account_name: '无余额且无业务的科目', category: 'asset', source_row: 100 } });
  const unused = buildFinanceLedger(input);
  assert.equal(unused.status, 'ready');
  assert(!unused.evidence.some(ref => ref.id === 'unused-account'));
});

test('unbalanced voucher, missing account opening and duplicate account or voucher lines are not silently summarized', () => {
  const unbalanced = fixture(); unbalanced.records.find(r => r.id === 'sale-income')!.data.credit_fen = 11999;
  assert(buildFinanceLedger(unbalanced).issues.some(s => s.includes('借贷不平衡')));
  const missing = fixture(); missing.records = missing.records.filter(r => r.id !== 'opening-5602');
  assert(buildFinanceLedger(missing).issues.some(s => s.includes('明确期初')));
  const duplicate = fixture(); duplicate.records.push({ ...duplicate.records.find(r => r.id === 'sale-bank')!, id: 'duplicate' }); duplicate.confirmedRecordVersions.push({ id: 'duplicate', version: 1 });
  assert(buildFinanceLedger(duplicate).issues.some(s => s.includes('重复')));
  const mismatchedDate = fixture(); mismatchedDate.records.find(r => r.id === 'sale-income')!.data.entry_date = '2026-10-07';
  assert(buildFinanceLedger(mismatchedDate).issues.some(s => s.includes('多个日期')));
});

test('customer and currency boundaries are explicit; missing dates cannot disappear in period filtering', () => {
  const cross = fixture(); cross.records[0].workspaceId = 'company-b';
  assert(buildFinanceLedger(cross).issues.some(s => s.includes('其他客户')));
  const usd = fixture(); usd.currency = 'USD';
  assert.equal(buildFinanceLedger(usd).status, 'insufficient_evidence');
  const badDate = fixture(); badDate.records.find(r => r.id === 'sale-bank')!.data.entry_date = '';
  assert(buildFinanceLedger(badDate).issues.some(s => s.includes('无法按账期')));
  const unknown = fixture(); unknown.accountingBasis = 'unselected';
  assert.equal(buildFinanceLedger(unknown).status, 'ready'); assert(buildFinanceLedger(unknown).issues.some(s => s.includes('制度待选择')));
});

test('integer overflow prevents apparently balanced financial totals', () => {
  const input = fixture();
  input.records.find(r => r.id === 'opening-1002')!.data.debit_fen = Number.MAX_SAFE_INTEGER;
  input.records.find(r => r.id === 'opening-3001')!.data.credit_fen = Number.MAX_SAFE_INTEGER;
  const result = buildFinanceLedger(input);
  assert.equal(result.status, 'needs_review'); assert(result.issues.some(s => s.includes('安全范围'))); assert.equal(result.trialBalance, null);
});

function reporting(input: FinanceLedgerInput) {
  input.reporting = {
    periodAdjustmentsConfirmed: true,
    balanceSheetLines: [
      { code: 'cash', label: '货币资金', section: 'assets', accountCodes: ['1002'], sign: 1 },
      { code: 'capital', label: '实收资本及未结转损益', section: 'equity', accountCodes: ['3001', '5001', '5602'], sign: -1 },
    ],
    incomeStatementLines: [
      { code: 'revenue', label: '营业收入', section: 'income', accountCodes: ['5001'], sign: -1 },
      { code: 'costs', label: '期间费用', section: 'expense', accountCodes: ['5602'], sign: 1 },
    ],
    closingEntriesReviewed: true,
    closingEntryRecordVersions: [],
    cashAccountCodes: ['1002'],
    cashFlowClassifications: [{ recordId: 'sale-bank', version: 1, category: 'operating' }, { recordId: 'cost-bank', version: 1, category: 'operating' }],
  };
  return input;
}

test('explicit human mappings and complete classifications produce reconciled management statement drafts', () => {
  const result = buildFinanceLedger(reporting(fixture()));
  assert.equal(result.status, 'ready');
  assert.equal(result.financialStatements.balanceSheet.status, 'draft');
  assert.deepEqual(result.financialStatements.balanceSheet.totals, { assetsFen: 110000, liabilitiesFen: 0, equityFen: 110000, balanced: true });
  assert.deepEqual(result.financialStatements.incomeStatement.totals, { incomeFen: 12000, expenseFen: 2000, profitFen: 10000 });
  assert.deepEqual(result.financialStatements.cashFlowStatement.totals, { openingCashFen: 100000, netCashFlowFen: 10000, closingCashFen: 110000, reconciled: true });
  assert(result.financialStatements.balanceSheet.notice?.includes('草稿'));
});

test('missing mappings, duplicate coverage, unreviewed closing and stale cash classifications do not become zero reports', () => {
  const missing = reporting(fixture()); missing.reporting!.balanceSheetLines![1].accountCodes = ['3001'];
  assert.equal(buildFinanceLedger(missing).financialStatements.balanceSheet.status, 'needs_review');
  const duplicate = reporting(fixture()); duplicate.reporting!.balanceSheetLines!.push({ code: 'again', label: '重复', section: 'assets', accountCodes: ['1002'], sign: 1 });
  assert(buildFinanceLedger(duplicate).financialStatements.balanceSheet.reason?.includes('重复'));
  const unreviewed = reporting(fixture()); unreviewed.reporting!.closingEntriesReviewed = false;
  assert.equal(buildFinanceLedger(unreviewed).financialStatements.incomeStatement.status, 'insufficient_evidence');
  const stale = reporting(fixture()); stale.reporting!.cashFlowClassifications![0].version = 2;
  assert.equal(buildFinanceLedger(stale).financialStatements.cashFlowStatement.status, 'needs_review');
  const incomplete = reporting(fixture()); incomplete.reporting!.cashFlowClassifications!.pop();
  assert(buildFinanceLedger(incomplete).financialStatements.cashFlowStatement.reason?.includes('未全部人工分类'));
  const noPolicy = reporting(fixture()); noPolicy.accountingBasis = 'unselected';
  assert(Object.values(buildFinanceLedger(noPolicy).financialStatements).every(s => s.status === 'insufficient_evidence'));
  const invalidPolicy = reporting(fixture()); invalidPolicy.accountingBasis = 'unsupported' as FinanceLedgerInput['accountingBasis'];
  assert.equal(buildFinanceLedger(invalidPolicy).status, 'needs_review');
  const invalidCash = reporting(fixture()); invalidCash.reporting!.cashAccountCodes = '1002' as unknown as string[];
  assert.equal(buildFinanceLedger(invalidCash).financialStatements.cashFlowStatement.status, 'needs_review');
});

test('confirmed closing vouchers stay in the ledger but are explicitly excluded from profit movements', () => {
  const input = reporting(fixture());
  const additions: FinanceLedgerRecord[] = [
    { id: 'chart-profit', workspaceId: 'company-a', version: 1, kind: 'chart_of_accounts', data: { account_code: 'PROFIT', account_name: '本年利润', category: 'equity', source_row: 20 } },
    { id: 'opening-profit', workspaceId: 'company-a', version: 1, kind: 'opening_balances', data: { account_code: 'PROFIT', balance_date: '2026-10-01', debit_fen: 0, credit_fen: 0, currency: 'CNY', posting_status: 'unconfirmed', source_row: 21 } },
  ];
  const rows = [ ['5001', 12000, 0], ['PROFIT', 0, 12000], ['PROFIT', 2000, 0], ['5602', 0, 2000] ] as const;
  rows.forEach(([account_code, debit_fen, credit_fen], i) => additions.push({ id: `closing-${i}`, workspaceId: 'company-a', version: 1, kind: 'journal_entries', data: { voucher_id: '结转-001', entry_date: '2026-10-31', line_no: i + 1, account_code, debit_fen, credit_fen, currency: 'CNY', posting_status: 'unconfirmed', source_row: i + 22 } }));
  input.records.push(...additions); input.confirmedRecordVersions.push(...additions.map(r => ({ id: r.id, version: r.version })));
  input.reporting!.balanceSheetLines![1].accountCodes.push('PROFIT');
  input.reporting!.closingEntryRecordVersions = additions.filter(r => r.kind === 'journal_entries').map(r => ({ id: r.id, version: r.version }));
  const result = buildFinanceLedger(input);
  assert.equal(result.status, 'ready'); assert.equal(result.generalLedger.find(r => r.accountCode === '5001')?.closingCreditFen, 0);
  assert.equal(result.financialStatements.incomeStatement.totals?.profitFen, 10000);
  input.reporting!.closingEntryRecordVersions.pop();
  assert(buildFinanceLedger(input).financialStatements.incomeStatement.reason?.includes('完整凭证'));
});
