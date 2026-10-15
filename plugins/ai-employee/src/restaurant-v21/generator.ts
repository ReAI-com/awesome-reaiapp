import { RESTAURANT_ROLES, THEME_GROUPS, COVERAGE } from './catalog';
import restaurantRuntime from './runtime.js' with { type: 'text' };
import { restaurantStyles } from './runtime-extension';
import manifest from '../../app.manifest.json';

// The original v2 page is the source. This generator only writes a separate page.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function replaceOnce(source: string, anchor: string | RegExp, value: string): string {
  const count = typeof anchor === 'string' ? source.split(anchor).length - 1 : [...source.matchAll(new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g'))].length;
  if (count !== 1) throw new Error(`v2 source changed: expected one anchor, found ${count}: ${String(anchor).slice(0, 120)}`);
  return source.replace(anchor, () => value);
}

export function generateRestaurantV21(baseHtml: string): string {
  let html = baseHtml;
  const departments = [...new Set(RESTAURANT_ROLES.map(r => r.department))].map((name, i) => ({
    id: `restaurant-dept-${i}`, name,
    lead: RESTAURANT_ROLES.find(r => r.department === name)!.id,
    roles: RESTAURANT_ROLES.filter(r => r.department === name).map(r => r.id),
  }));
  const edges = [
    ['training', 'examiner', 'c2a', '拟议：培训材料交给收卷复核'],
    ['examiner', 'operations', 'c2a', '拟议：训练问题交给运营复盘'],
    ['operations', 'training', 'reply', '拟议：问题回到培训需求'],
    ['vi', 'space', 'c2a', '拟议：品牌规范作为空间讨论输入'],
    ['space', 'cost', 'c2a', '拟议：确认范围交给成本复核'],
    ['cost', 'space', 'reply', '拟议：预算问题回到空间讨论'],
    ['supply', 'dispatch', 'c2a', '拟议：采购与库存约束交给调度'],
    ['dispatch', 'supply', 'reply', '拟议：到货与在途回传'],
    ['organization', 'performance', 'c2a', '拟议：有效岗位说明书版本作为模块/KPI核对输入'],
    ['recruitment', 'hr', 'c2a', '拟议：经人工确认的入职资料'],
    ['hr', 'organization', 'c2a', '拟议：人员变化供组织复核'],
    ['legal', 'vi', 'reply', '拟议：物料条款问题反馈'],
  ];
  const ipo = {
    entries: [{ id: 'in-upload', name: '资料（演示）', x: 20, y: 60 }],
    nodes: RESTAURANT_ROLES.map((r, i) => ({ id: r.id, x: 210 + (i % 3) * 270, y: 20 + Math.floor(i / 3) * 94, st: 'waiting', backlog: 0, ...(r.scopeUncertain ? { name: `${r.name} · 待确认` } : {}) })),
    edges, dir: [],
  };
  html = replaceOnce(html, /^const ROLES = \[[\s\S]*?^\];/m, `const ROLES = ${json(RESTAURANT_ROLES)};\nconst RESTAURANT_THEMES = ${json(THEME_GROUPS)};\nconst RESTAURANT_COVERAGE = ${json(COVERAGE)};`);
  html = replaceOnce(html, /^const IPO = \{[\s\S]*?^\};/m, `const IPO = ${json(ipo)};`);
  html = replaceOnce(html, /^const DEPTS = \[[\s\S]*?^\];/m, `const DEPTS = ${json(departments)};`);
  html = replaceOnce(html, /^const PUBLIC_DOCS = \[[\s\S]*?^\];/m, `const PUBLIC_DOCS = ${json([
    { id: 'restaurant-public-scope', cat: '演示说明', name: '餐饮员工场景与演示边界.md', dept: '演示资料', at: '2026-10-15', preview: '本页是基于客户需求整理的 UI/UX 原型，记录、候选、检查结论全部是虚构样例。\n未连接业务系统、真实模型、CAD、OCR、音视频分析或云流程。签字仅生成内存中的演示回执；不发送通知、不下单、不调整薪资。刷新后重置。' },
    { id: 'restaurant-public-flow', cat: '讨论稿', name: '岗位交接假设.md', dept: '演示资料', at: '2026-10-15', preview: '培训→阅卷→运营→培训；供应链↔调度；招聘→人事→组织→绩效。以上仅用于讨论界面与交接对象，尚未确认实际职责、授权或系统接口。四位高层不预设分工。' },
  ])};`);
  html = replaceOnce(html, "const PLUGIN = { version: '0.2.0-design', hostVersion: '演示：未读取', company: 'XX 科技有限公司', appPrefix: 'xx.ai-employee' };", `const PLUGIN = { version: ${json(manifest.version)}, hostVersion: '演示：未读取', company: '巴奴 · 虚构演示', appPrefix: 'restaurant.ai-employee' };`);
  html = replaceOnce(html, "roleId: 'finance', theme:", "roleId: 'training', theme:");
  html = replaceOnce(html, 'function nowStr() { const d = new Date(); return `2026-10-14 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }', 'function nowStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }');
  html = replaceOnce(html, "route: { page: 'dashboard' }, agentOpen: true", "route: { page: 'restaurant-home' }, agentOpen: false");
  html = replaceOnce(html, '<title>AI 员工范式 v2 · 交互设计稿</title>', '<title>巴奴 · 餐饮 AI 员工 v2.1</title>');
  html = replaceOnce(html, /<meta name="description" content="[^"]*">/, '<meta name="description" content="餐饮 AI 员工 v2.1 独立 UI/UX 原型：17 岗位、58 主题，资料复核、候选签字和冻结检查。全部虚构、仅内存、刷新重置。">');
  html = replaceOnce(html, '</style>', `${restaurantStyles}\n</style>`);
  html = replaceOnce(html, '<span>AI 员工范式 v2<span class="full"> · 交互设计稿</span></span><span class="badge b-mute">演示外壳</span>', '<span class="restaurant-brand-mark">${ic(\'sparkles\',20)}</span><span class="restaurant-brand-name">巴奴<small>AI 员工工作台</small></span><span class="badge b-warn">v2.1 · 演示</span><button type="button" class="btn-2 btn-sm" data-act="restaurant-gap">需求与缺口</button>');
  html = replaceOnce(html, "const PAGE_NAME = { dashboard:", "const PAGE_NAME = { 'restaurant-home': 'AI 员工首页', dashboard:");
  html = replaceOnce(html, "['1280', '桌面 1280']", "['1280', '跟随窗口']");
  html = replaceOnce(html, "${navItem('dashboard', 'grid', '工作台')}", "${navItem('restaurant-home', 'grid', 'AI 员工首页')}\n    ${navItem('dashboard', 'grid', '岗位工作台')}");
  html = replaceOnce(html, "const html = p === 'dashboard' ? pageDashboard()", "const html = p === 'restaurant-home' ? restaurantHome() : p === 'dashboard' ? pageDashboard()");
  html = replaceOnce(html, 'function bView(b, o = {}) {\n  const r = role();', 'function bView(b, o = {}) {\n  if (b.sections) return restaurantSectionViews(b, o);\n  const r = role();');
  html = replaceOnce(html, 'metricsHtml(b0, applyF(recs, b0.filter))', 'metricsHtml(b0, restaurantThemeRecords(b0, recs))');
  html = replaceOnce(html, 'return boardHead(b) + offBanner() + noticeHtml() + body;', "return boardHead(b) + restaurantScopeNote() + offBanner() + noticeHtml() + body + (b.type !== 'B' && b.sections ? '<details class=\"restaurant-evidence section\"><summary>查看业务依据与原看板记录</summary>' + restaurantSectionViews(b) + '</details>' : '');");
  html = replaceOnce(html, "if (rec.origin === 'i') { rec.src = done.id; rec.rule = `${r.rule}@${r.ruleVer}`; done.refs.push(rec.id); }", "if (rec.origin === 'i') { const source = rs.sources[r.rowsSourceIndices[i]] || done; rec.src = source.id; rec.rule = `${r.rule}@${r.ruleVer}`; source.refs.push(rec.id); }");
  // Persist actual field values with every revision, including the seed v1.
  html = html.replace(/rec\.history\.push\(\{ v: /g, 'rec.history.push({ values: structuredClone(rec.values), v: ');
  html = replaceOnce(html, "history: [{ v: 1, at: nowStr(), by: '整理规则'", "history: [{ values: structuredClone(values), v: 1, at: nowStr(), by: '整理规则'");
  html = replaceOnce(html, 'return { ruleVers: { ...d.ruleVer }, whole, members, order, vers:', 'return { values: deepFreeze(Object.fromEntries(rs.records.map(x => [x.id, structuredClone(x.values)]))), ruleVers: { ...d.ruleVer }, whole, members, order, vers:');
  html = replaceOnce(html, 'const read = { whole: fz.whole, members: fz.members, ext: fz.ext };', 'const read = deepFreeze({ whole: fz.whole, members: { ...fz.members }, ext: [...fz.ext], values: structuredClone(fz.values) });');
  html = replaceOnce(html, 'return x && String(x.v) !== v;', 'return !x || String(x.v) !== v;');
  html = replaceOnce(html, "if (!cur || cur.ref !== req.ref) return { ok: false, code: 'VERSION_CONFLICT' };", "if (!cur || cur.ref !== req.ref) return { ok: false, code: 'VERSION_CONFLICT' };\n  if (req.gen !== st.gen || st.sel !== req.ref || JSON.stringify(cur.inputs) !== JSON.stringify(req.inputs) || req.inputs.some(ref => { const [id,v] = ref.split('@v'); const row = recById(id, rs); return !row || String(row.v) !== v; })) return { ok: false, code: 'INPUT_CHANGED' };");
  html = replaceOnce(html, 'body: c.body, gen: st.gen, inputs: st.genInputs', 'body: restaurantCandidateBody(f.task, c, rs), gen: st.gen, inputs: st.genInputs');
  html = replaceOnce(html, 'const s = { id: `A-${r.id}-D${rs.sources.filter', 'const s = { bytes: bytes.slice(), text: snap, id: `A-${r.id}-D${rs.sources.filter');
  html = replaceOnce(html, 'kv(r.fields.map((f) => [f[1], esc(fmtVal(f[0], rec.values[f[0]]))]))', "kv(r.fields.filter(f => rec.values[f[0]] !== '' && rec.values[f[0]] != null).map((f) => [f[1], esc(fmtVal(f[0], rec.values[f[0]]))]))");
  // Keep the original trusted action / proposal / Interaction implementation.
  html = html.replaceAll('负责人会收到通知', '已登记演示升级，未发送通知').replaceAll('已按最新数据重新生成候选。', '已更新预置草案和当前输入摘要（未调用模型或求解器）。').replaceAll('本地规则；外脑回执版本：未开通', '内置演示映射；未调用真实整理器');
  const uploadCopy: [string, string][] = [
    ['还没有资料，上传后会自动整理，需要你确认的会出现在这里。', '还没有资料。可保存原件供界面讨论；内置虚构样例可体验复核。'],
    ['上传银行流水、导出表，或粘贴一段文本。上传后会自动整理。', '选择文件或粘贴文本，仅保存在本页内存；未接入通用整理器。'],
    ['资料只增不改，不能删除或修改。上传后会自动整理，需要你确认的会显示「去确认」。PDF、图片、音视频只保存原件。', '真实上传仅保留本页内存原件，未提供通用整理器。带「内置虚构整理样例」的资料可体验确认入库。刷新后全部重置。'],
    ['512 KiB 以内的 CSV / TXT / MD 可自动整理；其他格式与超限文本只保存原件。按原始字节计算指纹，同一内容重复上传（含粘贴）去重。', '单文件最多读取 8 MiB；文本最多预览解码 512 KiB。实际上传不生成业务记录，仅保留内存原件；更大文件仅登记信息。'],
    ['表格和文本上传后自动整理；同一内容不会重复保存。', '仅保留内存原件，未接通整理器。最多 8 MiB；超限只登记信息。刷新清空。'],
    ['升级只通知负责人，不改变检查结论', '仅登记演示处理人，未发送通知，不改变检查结论'],
    ['按本岗整理规则从原件整理而来', '按内置虚构样例映射，非真实文件解析'],
  ];
  uploadCopy.forEach(([from,to]) => { html = html.replaceAll(from,to); });
  html = replaceOnce(html, "s.st === 'unsup' ? ['仅保存原件', 'b-mute']", "s.st === 'unsup' ? [s.fpBasis === 'meta' ? '仅登记信息' : '内存原件', 'b-mute']");
  html = replaceOnce(html, '/* ── 启动 ── */', `${restaurantRuntime}\n/* ── 启动 ── */`);
  return '<!-- Generated restaurant v2.1 scenario from design/paradigm-v2.html; regenerate with bun scripts/build-restaurant-v21.ts. Existing pages are never written. -->\n' + html;
}
