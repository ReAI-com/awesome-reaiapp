import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import type { CleaningSpec, DataRecord, Dataset } from '../shared/types.ts';
import type { Store } from './store.ts';
import { failure } from './sources.ts';
import { buildFinanceLedger, financeKindFromSpecId, financeSpecId, getFinanceStandardSpecs, validateFinanceRows, type FinanceKind, type FinanceReportingConfig } from './finance.ts';

type Confirmation = { id: string; workspaceId: string; recordId: string; recordVersion: number; confirmedAt: string };
type ReportingRevision = { id: string; workspaceId: string; version: number; configuration: FinanceReportingConfig; createdAt: string };
const textField = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const recordVersion = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const accountCodes = { type: 'array', maxItems: 1000, uniqueItems: true, items: textField };
const reportLines = (sections: string[]) => ({
  type: 'array', maxItems: 500,
  items: { type: 'object', additionalProperties: false, required: ['code', 'label', 'section', 'accountCodes', 'sign'], properties: {
    code: textField, label: textField, section: { type: 'string', enum: sections },
    accountCodes: { ...accountCodes, minItems: 1 }, sign: { type: 'integer', enum: [1, -1] },
  } },
});
const reportingAjv = new Ajv({ strict: true, allErrors: true, coerceTypes: false });
const validateReporting = reportingAjv.compile({
  type: 'object', additionalProperties: false, required: ['periodAdjustmentsConfirmed'], properties: {
    periodAdjustmentsConfirmed: { type: 'boolean' }, closingEntriesReviewed: { type: 'boolean' },
    balanceSheetLines: reportLines(['assets', 'liabilities', 'equity']), incomeStatementLines: reportLines(['income', 'expense']),
    closingEntryRecordVersions: { type: 'array', maxItems: 5000, uniqueItems: true, items: {
      type: 'object', additionalProperties: false, required: ['id', 'version'], properties: { id: textField, version: recordVersion },
    } },
    cashAccountCodes: accountCodes,
    cashFlowClassifications: { type: 'array', maxItems: 5000, uniqueItems: true, items: {
      type: 'object', additionalProperties: false, required: ['recordId', 'version', 'category'], properties: {
        recordId: textField, version: recordVersion, category: { type: 'string', enum: ['operating', 'investing', 'financing', 'internal_transfer'] },
      },
    } },
  },
});
function latestReporting(store: Store, workspaceId: string) {
  const latest = store.list<ReportingRevision>('financeReporting', workspaceId).sort((a, b) => b.version - a.version)[0];
  return latest ? { version: latest.version, configuration: latest.configuration } : null;
}
export function financeRecords(store: Store, workspaceId: string) {
  const datasets = new Map(store.list<Dataset>('datasets', workspaceId).map(d => [d.id, d]));
  return store.list<DataRecord>('records', workspaceId).flatMap(row => {
    const spec = datasets.get(row.datasetId)?.specId;
    const kind = spec && financeKindFromSpecId(spec);
    return kind ? [{ ...row, kind }] : [];
  });
}
export function registerFinanceApi(app: Express, store: Store) {
  app.get('/api/workspaces/:wid/finance', (req, res) => {
    const wid = String(req.params.wid), workspace = store.getWorkspace(wid);
    const records = financeRecords(store, wid);
    const confirmations = store.list<Confirmation>('financeConfirmations', wid);
    res.json({ enabled: !!workspace.finance?.enabled, settings: workspace.finance || { accountingBasis: 'unselected', currency: 'CNY', openingBalancesComplete: false }, standards: getFinanceStandardSpecs().map(spec => ({ ...spec, specId: financeSpecId(wid, spec.key), recordCount: records.filter(row => row.kind === spec.key).length })), confirmations: confirmations.filter(item => records.some(row => row.id === item.recordId && row.version === item.recordVersion)), reporting: latestReporting(store, wid) });
  });
  app.post('/api/workspaces/:wid/finance/setup', (req, res) => {
    const wid = String(req.params.wid); const workspace = store.getWorkspace(wid);
    const accountingBasis = req.body.accountingBasis ?? workspace.finance?.accountingBasis ?? 'unselected';
    if (!['unselected', 'small_enterprise', 'enterprise'].includes(accountingBasis)) throw failure('请选择有效的会计制度');
    const currency = String(req.body.currency ?? workspace.finance?.currency ?? 'CNY').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw failure('币种应为CNY等三位代码');
    for (const spec of getFinanceStandardSpecs()) {
      const id = financeSpecId(wid, spec.key);
      if (!store.get('specs', id, wid)) store.put('specs', { id, workspaceId: wid, name: spec.name, description: spec.description, match: spec.match, prompt: spec.prompt, schema: spec.schema, version: 1, createdAt: new Date().toISOString() } satisfies CleaningSpec);
    }
    res.json({ workspace: store.updateWorkspace(wid, { finance: { enabled: true, accountingBasis, currency, openingBalancesComplete: typeof req.body.openingBalancesComplete === 'boolean' ? req.body.openingBalancesComplete : workspace.finance?.openingBalancesComplete || false } }) });
  });
  app.post('/api/workspaces/:wid/finance/confirm', (req, res) => {
    const wid = String(req.params.wid); const workspace = store.getWorkspace(wid);
    if (!workspace.finance?.enabled) throw failure('请先启用财务账套');
    const requested = req.body.records as { id: string; version: number }[];
    if (!Array.isArray(requested) || !requested.length || requested.length > 500 || requested.some(row => !row || typeof row.id !== 'string' || !Number.isSafeInteger(row.version))) throw failure('确认需包含1–500条记录及其版本');
    if (new Set(requested.map(row => row.id)).size !== requested.length) throw failure('确认列表包含重复记录');
    const current = financeRecords(store, wid); const chosen = requested.map(ref => {
      const record = current.find(r => r.id === ref.id);
      if (!record || record.version !== ref.version) throw failure('数据已变化，请刷新并按新版本重新复核', 409);
      if (!['journal_entries', 'opening_balances', 'chart_of_accounts'].includes(record.kind)) throw failure('仅科目表、期初余额和凭证分录需要账务确认');
      return record;
    });
    for (const kind of ['journal_entries', 'opening_balances', 'chart_of_accounts'] as FinanceKind[]) {
      const rows = chosen.filter(r => r.kind === kind);
      if (rows.length) { const issues = validateFinanceRows(kind, rows.map(r => r.data)); if (issues.length) throw failure(issues.join('；')); }
    }
    const vouchers = new Map<string, typeof chosen>();
    for (const row of chosen.filter(r => r.kind === 'journal_entries')) {
      const key = `${row.data.entry_date}/${row.data.voucher_id}/${row.data.currency}`;
      const all = current.filter(r => r.kind === 'journal_entries' && `${r.data.entry_date}/${r.data.voucher_id}/${r.data.currency}` === key);
      if (all.some(r => !chosen.some(c => c.id === r.id))) throw failure('请同时选择同一凭证的全部分录，不能确认半张凭证');
      vouchers.set(key, all);
    }
    for (const [key, rows] of vouchers) {
      const debit = rows.reduce((sum, row) => sum + Number(row.data.debit_fen), 0), credit = rows.reduce((sum, row) => sum + Number(row.data.credit_fen), 0);
      if (rows.length < 2 || !Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit !== credit) throw failure(`凭证 ${key} 借贷不平衡，不能确认入账`);
    }
    const existing = store.list<Confirmation>('financeConfirmations', wid);
    const confirmed = chosen.map(row => existing.find(x => x.recordId === row.id && x.recordVersion === row.version) || store.put('financeConfirmations', { id: randomUUID(), workspaceId: wid, recordId: row.id, recordVersion: row.version, confirmedAt: new Date().toISOString() } satisfies Confirmation));
    res.json({ confirmed });
  });
  app.get('/api/workspaces/:wid/finance/reports', (req, res) => {
    const wid = String(req.params.wid), workspace = store.getWorkspace(wid);
    if (!workspace.finance?.enabled) throw failure('请先启用财务账套');
    const confirmations = store.list<Confirmation>('financeConfirmations', wid);
    const reporting = latestReporting(store, wid);
    res.json({ ...buildFinanceLedger({ workspaceId: wid, from: String(req.query.from || ''), to: String(req.query.to || ''), currency: String(req.query.currency || workspace.finance.currency), accountingBasis: workspace.finance.accountingBasis, openingBalancesComplete: workspace.finance.openingBalancesComplete, records: financeRecords(store, wid), confirmedRecordVersions: confirmations.map(item => ({ id: item.recordId, version: item.recordVersion })), reporting: reporting?.configuration }), reportingVersion: reporting?.version || 0 });
  });
  app.post('/api/workspaces/:wid/finance/reporting', (req, res) => {
    const wid = String(req.params.wid), workspace = store.getWorkspace(wid);
    if (!workspace.finance?.enabled) throw failure('请先启用财务账套');
    const expectedVersion = req.body?.version, configuration = req.body?.configuration;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER) throw failure('报表配置需包含有效的非负整数版本，首次保存使用0');
    if (!validateReporting(configuration)) throw failure(`报表配置格式错误：${reportingAjv.errorsText(validateReporting.errors)}`);
    // The compare and append share one SQLite write lock, including across app instances.
    store.db.exec('BEGIN IMMEDIATE');
    let revision: ReportingRevision;
    try {
      const previous = latestReporting(store, wid);
      if ((previous?.version || 0) !== expectedVersion) throw failure('报表配置已更新，请刷新后基于新版本保存', 409);
      revision = store.put('financeReporting', { id: randomUUID(), workspaceId: wid, version: expectedVersion + 1, configuration: configuration as FinanceReportingConfig, createdAt: new Date().toISOString() } satisfies ReportingRevision);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    res.json({ reporting: { version: revision.version, configuration: revision.configuration } });
  });
}
