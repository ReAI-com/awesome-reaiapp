#!/usr/bin/env node
// Read-only acceptance checks for the six synthetic fixtures. Never calls a model or writes data.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';

const workspaceId = process.argv[2];
if (!workspaceId || process.argv.length !== 3) {
  console.error('用法：node examples/finance/standard/verify.mjs <workspaceId>');
  process.exit(1);
}
const origin = 'http://127.0.0.1:4317';
const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;
const expected = JSON.parse(await readFile(new URL('./expected.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(await readFile(new URL('./ledger-fixture.json', import.meta.url), 'utf8'));
const names = Object.keys(expected).filter(name => name.endsWith('.csv'));
const kinds = ['company_profile', 'chart_of_accounts', 'journal_entries', 'bank_transactions', 'sales_invoices', 'purchase_invoices', 'receivables', 'payables', 'expense_claims', 'payroll', 'fixed_assets', 'tax_records', 'opening_balances', 'inventory_movements'];
const checks = [], reviewedFiles = new Set(), publishedFiles = new Set();
const add = (status, name, detail) => checks.push({ status, name, ...(detail ? { detail } : {}) });
const check = (condition, name, detail) => add(condition ? 'passed' : 'failed', name, detail);
const validId = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const limited = run => /429|1302|rate.?limit|quota|限流|频率|并发|额度|用量上限|too many requests/i.test(run?.error || '');
const subset = (actual, wanted) => !!actual && Object.entries(wanted).every(([key, value]) => isDeepStrictEqual(actual[key], value));

async function get(route) {
  const response = await fetch(origin + route, { method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`只读请求 ${route} 返回 HTTP ${response.status}`);
  return response.json();
}

function pendingFile(name, run) {
  if (!run || ['queued', 'running', 'waiting_review', 'cancelled', 'interrupted', 'superseded'].includes(run.status) || limited(run)) {
    add('pending', `${name} 清洗发布`, limited(run) ? '模型限流，等待重试；当前没有已发布记录。' : `当前任务 ${run?.status || '尚未开始'}，尚未完成发布。`);
  } else add('failed', `${name} 清洗发布`, `当前任务 ${run.status}，预期记录尚未发布。`);
}

try {
  const [state, finance, reports] = await Promise.all([
    get(`${base}/state`), get(`${base}/finance`),
    get(`${base}/finance/reports?from=${ledger.input.from}&to=${ledger.input.to}&currency=CNY`),
  ]);
  check(state.workspace?.id === workspaceId, '工作区归属');
  check(finance.enabled === true, '标准财务账套已启用');
  const records = state.records || [], datasets = new Map((state.datasets || []).map(item => [item.id, item]));
  const specs = new Map((state.specs || []).map(item => [item.id, item]));
  const runs = new Map((state.runs || []).map(item => [item.id, item]));
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, strictNumbers: true });
  const validations = new Map();
  for (const kind of kinds) {
    const id = `${workspaceId}:finance:v1:${kind}`, spec = specs.get(id);
    const schema = spec?.schema;
    const valid = spec?.workspaceId === workspaceId && schema?.type === 'object' && schema.additionalProperties === false && schema.required?.includes('source_row') && schema.properties?.source_row?.type === 'integer';
    check(valid, `标准 Schema ${kind}`);
    if (valid) {
      try { validations.set(id, ajv.compile(schema)); }
      catch { add('failed', `标准 Schema ${kind} 可编译`); }
    }
  }
  check((finance.standards || []).length === 14 && new Set(finance.standards.map(item => item.key)).size === 14, '14 类标准财务库');
  const sourceFiles = (state.files || []).filter(file => names.includes(file.name));
  const histories = new Map(await Promise.all(sourceFiles.map(async file => [file.id, await get(`${base}/files/${encodeURIComponent(file.id)}/history`)])));

  for (const name of names) {
    const files = sourceFiles.filter(file => file.name === name);
    if (files.length === 0) { add('pending', `${name} 原件`, '尚未上传本合成原件。'); continue; }
    if (files.length !== 1) { add('failed', `${name} 原件唯一性`, '同名原件不唯一，无法无歧义验收。'); continue; }
    const file = files[0], history = histories.get(file.id), target = expected[name];
    const raw = await readFile(new URL(`./input/${name}`, import.meta.url));
    const hash = createHash('sha256').update(raw).digest('hex');
    const revision = history.revisions?.find(item => item.id === file.revisionId);
    check(file.workspaceId === workspaceId && validId(file.id) && validId(file.revisionId) && file.hash === hash && file.size === raw.length, `${name} 原件指纹与归属`);
    check(revision?.fileId === file.id && revision.hash === hash && revision.size === raw.length && validTime(revision.createdAt), `${name} 不可变版本元数据`);
    const fileRuns = [...runs.values()].filter(run => run.fileId === file.id && run.inputRevisionId === file.revisionId && run.kind === 'clean').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = fileRuns[0];
    const rows = records.filter(row => row.sourceFileId === file.id);

    if (target.must_not_publish_partial_success) {
      check(rows.length === 0 && !file.cleanedRevisionId, `${name} 异常文件未部分发布`);
      const rejectedRoute = latest?.status === 'failed' && /没有匹配的清洗规范/.test(latest.error || '');
      const review = latest?.status === 'waiting_review' && Array.isArray(latest.result?.issues) && latest.result.issues.length > 0;
      if (rejectedRoute || review) add('passed', `${name} 业务异常阻断`, rejectedRoute ? '路由拒绝，未发布。' : '带复核问题暂存，未发布。');
      else pendingFile(name, latest);
      continue;
    }

    if (rows.length === 0) { pendingFile(name, latest); continue; }
    const count = target.rows?.length || target.count;
    check(rows.length === count, `${name} 完整业务行`, `预期 ${count} 条，实际 ${rows.length} 条。`);
    check(['清洗完成', '更新完成'].includes(file.state) && file.cleanedRevisionId === file.revisionId, `${name} 当前原件已发布`);
    const wantedSpecId = `${workspaceId}:finance:v1:${target.kind}`;
    const goodMetadata = rows.every(row => {
      const dataset = datasets.get(row.datasetId), run = runs.get(row.runId), validate = validations.get(wantedSpecId);
      return row.workspaceId === workspaceId && validId(row.id) && Number.isSafeInteger(row.version) && row.version > 0
        && row.sourceRevisionId === revision?.id && row.sourceRevisionId === file.cleanedRevisionId
        && validTime(row.createdAt) && validTime(row.updatedAt) && row.manual === false
        && dataset?.workspaceId === workspaceId && dataset.specId === wantedSpecId
        && isDeepStrictEqual(dataset.schema, specs.get(wantedSpecId)?.schema) && validate?.(row.data)
        && run?.workspaceId === workspaceId && run.fileId === file.id && run.inputRevisionId === revision?.id
        && run.generation === file.generation && run.agentId === 'agent-001' && run.kind === 'clean' && run.status === 'succeeded';
    });
    check(goodMetadata, `${name} 标准表、Schema 与 A→B 来源链`);
    check(new Set(rows.map(row => row.data.source_row)).size === count, `${name} 来源行不重复`);
    let wantedRows = target.rows;
    if (!wantedRows) wantedRows = ledger.input.records.filter(row => row.kind === target.kind).map(row => {
      const data = { ...row.data };
      // The source has separate 凭证字/号数; punctuation in the composed identifier is not prescribed.
      if (target.kind === 'journal_entries') delete data.voucher_id;
      return data;
    });
    for (const wanted of wantedRows) {
      const actual = rows.find(row => row.data.source_row === wanted.source_row)?.data;
      const required = { ...wanted };
      if (target.kind === 'bank_transactions' && wanted.invoice_id) {
        delete required.invoice_id;
        check(actual?.invoice_id === wanted.invoice_id || actual?.document_ref === wanted.invoice_id, `${name} 第 ${wanted.source_row} 行票据关联保留`);
      }
      check(subset(actual, required), `${name} 第 ${wanted.source_row} 行金额、日期与必需值`);
    }
    if (target.kind === 'bank_transactions') check(rows.every(row => !Object.hasOwn(row.data, 'balance_fen')), `${name} 未编造原件没有的余额`);
    if (target.posting_status) check(rows.every(row => row.data.posting_status === target.posting_status), `${name} 原件已审核不冒充本系统确认`);
    for (const side of ['debit', 'credit']) if (target[`total_${side}_fen`] !== undefined) {
      check(rows.every(row => Number.isSafeInteger(row.data[`${side}_fen`])) && rows.reduce((sum, row) => sum + row.data[`${side}_fen`], 0) === target[`total_${side}_fen`], `${name} ${side} 整数分合计`);
    }
    if (target.kind === 'journal_entries') {
      const ordered = [...rows].sort((a, b) => a.data.source_row - b.data.source_row);
      check(ordered.length === 4 && ordered.every(row => validId(row.data.voucher_id)) && ordered[0].data.voucher_id === ordered[1].data.voucher_id && ordered[2].data.voucher_id === ordered[3].data.voucher_id && ordered[0].data.voucher_id !== ordered[2].data.voucher_id, `${name} 两张完整凭证的分录归组`);
    }
    if (target.account_codes) check(isDeepStrictEqual(rows.map(row => row.data.account_code).sort(), [...target.account_codes].sort()), `${name} 科目编码`);
    publishedFiles.add(name);
    if (rows.some(row => runs.get(row.runId)?.events?.some(event => event.phase === 'review'))) reviewedFiles.add(name);
  }

  const expectedCount = names.reduce((sum, name) => sum + (expected[name].rows?.length || expected[name].count || 0), 0);
  const ownRows = records.filter(row => sourceFiles.some(file => file.id === row.sourceFileId));
  if (publishedFiles.size === 5) check(records.length === expectedCount && ownRows.length === expectedCount, '最终完整 B 记录数', `预期 16 条，实际 ${records.length} 条。`);
  else add('pending', '最终完整 B 记录数', `当前 ${ownRows.length}/${expectedCount} 条；未发布文件不会计作成功。`);
  check(records.every(row => sourceFiles.some(file => file.id === row.sourceFileId)), '本合成账套无混入或无来源记录');

  const ledgerRows = records.filter(row => ['chart_of_accounts', 'opening_balances', 'journal_entries'].some(kind => datasets.get(row.datasetId)?.specId === `${workspaceId}:finance:v1:${kind}`));
  const manuallyConfirmed = ledgerRows.length === 12 && ledgerRows.every(row => finance.confirmations?.some(ref => ref.recordId === row.id && ref.recordVersion === row.version));
  if (!manuallyConfirmed || finance.settings?.openingBalancesComplete !== true) {
    add('pending', '账簿人工确认', '需要当前 12 条科目/期初/凭证的人工版本确认和期初完整性确认。');
    check(reports.status !== 'ready', '缺人工依据时不宣布账簿就绪');
  } else {
    check(reports.status === ledger.expected.status, '已确认账簿就绪');
    check(subset(reports.trialBalance, ledger.expected.trialBalance), '试算平衡：发生额借贷各 14000 分');
    const bank = reports.generalLedger?.find(row => row.accountCode === '1002');
    check(subset(bank, { openingDebitFen: 100000, debitFen: 12000, creditFen: 2000, closingDebitFen: 110000, closingCreditFen: 0 }), '银行期末余额 110000 分');
    check(reports.detailLedger?.length === 4, '凭证明细账 4 行');
    check(ledgerRows.every(row => reports.evidence?.some(ref => ref.id === row.id && ref.version === row.version)), '账簿证据包含当前科目、期初及凭证版本');
    for (const kind of ['balanceSheet', 'incomeStatement', 'cashFlowStatement']) {
      const statement = reports.financialStatements?.[kind];
      if (statement?.status === 'insufficient_evidence') add('pending', `${kind} 管理报表草稿`, '人工映射或确认尚未齐备。');
      else check(statement?.status === 'draft' && subset(statement.totals, ledger.expected[kind]), `${kind} 管理报表草稿与勾稽金额`);
    }
    if (finance.reporting) check(reports.reportingVersion === finance.reporting.version, '报表使用当前配置版本');
  }
} catch (error) {
  add('failed', '只读验收执行', error.message);
}

const status = checks.some(item => item.status === 'failed') ? 'failed' : checks.some(item => item.status === 'pending') ? 'pending' : 'passed';
console.log(JSON.stringify({
  status, synthetic: true, notUserBlindAcceptance: true,
  note: '只读核对当前 REST 数据及来源链；不证明历史模型供应商，也不代表用户真实盲盒或法定报表验收。人工复核发布不计作全自动。',
  publishedSourceFiles: publishedFiles.size, manuallyReviewedPublishedFiles: reviewedFiles.size, manuallyReviewedFileNames: [...reviewedFiles],
  summary: Object.fromEntries(['passed', 'pending', 'failed'].map(value => [value, checks.filter(item => item.status === value).length])), checks,
}, null, 2));
process.exitCode = status === 'passed' ? 0 : status === 'pending' ? 2 : 1;
