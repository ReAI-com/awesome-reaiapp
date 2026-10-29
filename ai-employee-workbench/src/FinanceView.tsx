import { useEffect, useState } from 'react';
import { CheckCheck, Database, FileSpreadsheet, RefreshCw } from 'lucide-react';
import type { DataRecord, JsonSchema } from '../shared/types';
import { request, valueText } from './api';
import { Field, InlineError, SectionHead, Spinner } from './components';
import { useWorkbench } from './context';
import './finance-view.css';

interface Standard { key: string; name: string; description: string; specId: string; schema: JsonSchema; recordCount: number }
interface FinanceState { enabled: boolean; settings: { accountingBasis: string; currency: string; openingBalancesComplete?: boolean }; standards: Standard[]; confirmations: { recordId: string; recordVersion: number }[]; reporting: { version: number; configuration: Record<string, unknown> } | null }
const totalLabels: Record<string, string> = { assetsFen: '资产合计', liabilitiesFen: '负债合计', equityFen: '权益合计', balanced: '勾稽平衡', incomeFen: '收入合计', expenseFen: '费用合计', profitFen: '利润', openingCashFen: '期初现金', netCashFlowFen: '现金净增加额', closingCashFen: '期末现金', reconciled: '现金勾稽通过' };
const money = (value: number) => (value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dates = () => { const now = new Date(); const year = now.getFullYear(), month = String(now.getMonth() + 1).padStart(2, '0'), day = String(now.getDate()).padStart(2, '0'); return { from: `${year}-${month}-01`, to: `${year}-${month}-${day}` }; };

export function FinanceView() {
  const { state, base, mutate, notify, navigate, canAdmin } = useWorkbench();
  const [finance, setFinance] = useState<FinanceState | null>(null);
  const [selected, setSelected] = useState('bank_transactions');
  const [chosen, setChosen] = useState<Record<string, number>>({});
  const [basis, setBasis] = useState(state.workspace.finance?.accountingBasis || 'unselected');
  const [currency, setCurrency] = useState(state.workspace.finance?.currency || 'CNY');
  const [openingComplete, setOpeningComplete] = useState(!!state.workspace.finance?.openingBalancesComplete);
  const [period, setPeriod] = useState(dates);
  const [report, setReport] = useState<any>(null);
  const [mapping, setMapping] = useState('');
  const [mappingVersion, setMappingVersion] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const recordSignature = state.records.map(r => `${r.id}:${r.version}`).join('|');
  useEffect(() => { setReport(null); setChosen({}); }, [base, recordSignature, period.from, period.to, currency, state.workspace.finance?.accountingBasis, state.workspace.finance?.openingBalancesComplete]);
  async function load() { setFinance(await request<FinanceState>(`${base}/finance`)); }
  useEffect(() => { let current = true; request<FinanceState>(`${base}/finance`).then(value => { if (current) setFinance(value); }).catch(err => { if (current) setError(err.message); }); return () => { current = false; }; }, [base, recordSignature, state.workspace.finance?.enabled]);
  async function setup() {
    setBusy(true); setError('');
    try { await mutate('/finance/setup', { accountingBasis: basis, currency, openingBalancesComplete: openingComplete }); await load(); notify('财务账套设置已保存'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError('');
    try { await mutate('/finance/confirm', { records: Object.entries(chosen).map(([id, version]) => ({ id, version })) }); setChosen({}); await load(); setReport(null); notify('已确认所选版本；后续修订将需要重新复核'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function reports() {
    setBusy(true); setError('');
    try { setReport(await request(`${base}/finance/reports?${new URLSearchParams({ ...period, currency })}`)); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function saveMapping() {
    setBusy(true); setError('');
    try { const configuration = JSON.parse(mapping); await mutate('/finance/reporting', { version: mappingVersion, configuration }); await load(); setMappingVersion(mappingVersion + 1); notify('报表映射已保存，重新生成账簿与报表可应用'); setReport(null); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const standard = finance?.standards.find(s => s.key === selected);
  const datasetIds = state.datasets.filter(d => d.specId === standard?.specId).map(d => d.id);
  const rows = state.records.filter(r => datasetIds.includes(r.datasetId));
  const confirmable = ['journal_entries', 'opening_balances', 'chart_of_accounts'].includes(selected);
  const isConfirmed = (row: DataRecord) => finance?.confirmations.some(c => c.recordId === row.id && c.recordVersion === row.version);
  const fields = Object.keys(standard?.schema.properties || {});
  return <div className="view-page finance-page">
    <SectionHead title="财务账套" subtitle="一个客户，一个账套。原始资料、结构化事实与已确认账目分别留痕。" action={<button className="button subtle" onClick={() => navigate('files')}><Database size={16} />上传与自动归集</button>} />
    <div className="finance-settings panel">
      <Field label="会计制度"><select disabled={!canAdmin} value={basis} onChange={e => setBasis(e.target.value as typeof basis)}><option value="unselected">待确认制度</option><option value="small_enterprise">小企业会计准则</option><option value="enterprise">企业会计准则</option></select></Field>
      <Field label="记账本位币"><input readOnly={!canAdmin} maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field>
      {canAdmin && <button className="button primary" disabled={busy} onClick={() => void setup()}>{busy ? <Spinner /> : <CheckCheck size={16} />}{finance?.enabled ? '保存账套设置' : '启用标准财务库'}</button>}
      <p className="finance-settings-note">覆盖科目、凭证、流水、进销项、应收应付、费用、工资、资产、税费、期初和存货。未知字段映射到统一规范，疑义进入复核。</p>
    </div>
    <InlineError>{error}</InlineError>
    {finance?.enabled && <>
      <div className="finance-standard-grid">{finance.standards.map(item => <button className={`finance-standard ${selected === item.key ? 'selected' : ''}`} key={item.key} onClick={() => { setSelected(item.key); setChosen({}); }}><span>{item.name}</span><strong>{item.recordCount}</strong></button>)}</div>
      <section className="panel finance-record-panel">
        <SectionHead title={standard?.name || '账目资料'} subtitle={standard?.description} action={canAdmin && <button className="button subtle small" onClick={() => navigate('data')}>管理结构化数据</button>} />
        {confirmable && canAdmin && <div className="finance-confirm"><label><input type="checkbox" checked={!!rows.length && rows.every(r => chosen[r.id] === r.version)} onChange={e => setChosen(e.target.checked ? Object.fromEntries(rows.map(r => [r.id, r.version])) : {})} />选择当前表记录</label><span>自动清洗不等于确认入账；同一凭证须完整选择并借贷平衡。</span><button className="button primary small" disabled={busy || !Object.keys(chosen).length} onClick={() => void confirm()}>确认所选记录</button></div>}
        {rows.length ? <div className="table-wrap"><table><thead><tr>{confirmable && <th>复核</th>}{fields.map(field => <th key={field}>{standard?.schema.properties[field].title || field}</th>)}<th>版本</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>{confirmable && <td><label><input disabled={!canAdmin} aria-label={`选择记录 ${row.id}`} type="checkbox" checked={chosen[row.id] === row.version} onChange={e => setChosen(current => { const next = { ...current }; if (e.target.checked) next[row.id] = row.version; else delete next[row.id]; return next; })} />{isConfirmed(row) ? '已确认' : '待复核'}</label></td>}{fields.map(field => <td key={field}>{valueText(row.data[field])}</td>)}<td>v{row.version}</td></tr>)}</tbody></table></div> : <div className="finance-empty"><FileSpreadsheet size={25} /><p>还没有这类资料。上传文件后会按标准规范自动归集；不会用样例填充你的账套。</p></div>}
      </section>
      <section className="panel finance-report-panel">
        <SectionHead title="账簿与报表" subtitle="以已确认的记录版本计算。缺少期初、科目或映射时，明确列出所缺依据。" />
        <div className="finance-report-controls"><Field label="账期开始"><input type="date" value={period.from} onChange={e => setPeriod({ ...period, from: e.target.value })} /></Field><Field label="账期结束"><input type="date" value={period.to} onChange={e => setPeriod({ ...period, to: e.target.value })} /></Field><button className="button primary" disabled={busy} onClick={() => void reports()}>{busy ? <Spinner /> : <RefreshCw size={15} />}生成账簿与报表</button></div>
        <label className="finance-opening"><input disabled={!canAdmin} type="checkbox" checked={openingComplete} onChange={e => setOpeningComplete(e.target.checked)} />已核对本期期初余额齐全（包括零余额科目；勾选后需保存账套设置）</label>
        {report && <>
          {!!report.issues?.length && <div className="finance-issues"><b>{report.status === 'ready' ? '计算范围说明' : '待补充或复核'}</b><ul>{report.issues.map((issue: string, index: number) => <li key={index}>{issue}</li>)}</ul></div>}
          {report.trialBalance && <div className="finance-trial"><strong>{report.trialBalance.balanced ? '试算平衡通过' : '试算不平衡'}</strong><span>本期借方 {money(report.trialBalance.debitFen)} {currency}</span><span>本期贷方 {money(report.trialBalance.creditFen)} {currency}</span></div>}
          {!!report.generalLedger?.length && <><h3>科目余额与总账</h3><div className="table-wrap"><table><thead><tr>{['科目','名称','期初借方','期初贷方','本期借方','本期贷方','期末借方','期末贷方'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{report.generalLedger.map((row: any) => <tr key={row.accountCode}><td>{row.accountCode}</td><td>{row.accountName}</td>{['openingDebitFen','openingCreditFen','debitFen','creditFen','closingDebitFen','closingCreditFen'].map(key => <td key={key}>{money(row[key])}</td>)}</tr>)}</tbody></table></div></>}
          {!!report.detailLedger?.length && <details><summary>查看凭证明细账（{report.detailLedger.length} 条）</summary><div className="table-wrap"><table><thead><tr>{['日期','凭证','科目','摘要','借方','贷方','余额方向','余额'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{report.detailLedger.map((row: any) => <tr key={row.recordId}><td>{row.entryDate}</td><td>{row.voucherId}</td><td>{row.accountCode} {row.accountName}</td><td>{row.description}</td><td>{money(row.debitFen)}</td><td>{money(row.creditFen)}</td><td>{row.balanceSide === 'debit' ? '借' : row.balanceSide === 'credit' ? '贷' : '平'}</td><td>{money(row.balanceFen)}</td></tr>)}</tbody></table></div></details>}
          <div className="finance-statements">{Object.entries(report.financialStatements || {}).map(([key, value]) => { const item = value as any; return <article key={key}><h3>{({ balanceSheet:'资产负债表',incomeStatement:'利润表',cashFlowStatement:'现金流量表' } as Record<string,string>)[key] || key}</h3><p>{item.reason || item.label || (item.status === 'draft' ? '管理报表草稿 · 待复核' : item.status)}</p>{item.lines && <table><tbody>{item.lines.map((line: any) => <tr key={line.code}><td>{line.label}</td><td>{money(line.amountFen)}</td></tr>)}</tbody></table>}{item.totals && <dl>{Object.entries(item.totals).map(([label,val]) => <div key={label}><dt>{totalLabels[label] || label}</dt><dd>{typeof val === 'number' ? money(val) : val === true ? '是' : '否'}</dd></div>)}</dl>}{item.notice && <small>{item.notice}</small>}</article>; })}</div>
        </>}
        {canAdmin && <details className="finance-mapping"><summary>报表科目映射与结转确认（高级设置）</summary><p>使用本客户经核对的科目与现金流分类；这里的确认不会由模型代填。示例与字段见项目财务标准说明。</p><button className="button subtle small" onClick={() => { setMapping(JSON.stringify(finance.reporting?.configuration || { periodAdjustmentsConfirmed: false, balanceSheetLines: [], incomeStatementLines: [] }, null, 2)); setMappingVersion(finance.reporting?.version || 0); }}>载入已保存配置（版本 {finance.reporting?.version || 0}）</button><textarea rows={10} aria-label="报表映射配置" value={mapping} onChange={e => setMapping(e.target.value)} placeholder={'{\n  "periodAdjustmentsConfirmed": false,\n  "balanceSheetLines": [],\n  "incomeStatementLines": []\n}'} /><button className="button subtle" disabled={busy || !mapping.trim()} onClick={() => void saveMapping()}>保存报表映射</button></details>}
      </section>
    </>}
  </div>;
}
