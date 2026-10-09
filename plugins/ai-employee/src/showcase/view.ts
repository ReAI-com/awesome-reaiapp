import type { Board, Role, ChatLink } from './types';
import { MockStore } from './state';
import { PUBLIC_SOURCES } from './catalog';
import { renderVisual } from './visuals';
import manifest from '../../app.manifest.json';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const icon = (name = 'grid') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>', arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>', back: '<path d="m14 6-6 6 6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', chat: '<path d="M21 11a8 8 0 0 1-8 8H6l-4 3V10a8 8 0 0 1 8-8h3a8 8 0 0 1 8 9Z"/><path d="M7 8h9M7 12h6"/>', file: '<path d="M14 2H5v20h14V7l-5-5Z"/><path d="M14 2v6h5M8 12h8M8 16h6"/>', check: '<path d="m5 12 4 4L19 6"/>', upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>', settings: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>', search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 6"/>', shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-6"/>', spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/>' } as Record<string, string>)[name] ?? '<path d="M4 5h16v14H4zM8 9h8M8 13h5"/>'}</svg>`;
const shortTime = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const money = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const isBudget = (b: Board) => b.columns.join('|') === '项目|数量|单位|单价（元）|小计（元）|状态';
const isStock = (b: Board) => b.columns.join('|') === '物料|现存（kg）|日均（kg）|在途（kg）|可用天数|状态';
const numeric = (cells: string[], indices: number[]) => indices.every(i => cells[i].trim() !== '' && Number.isFinite(Number(cells[i])) && Number(cells[i]) >= 0 && Number(cells[i]) <= 100000000);
const stockText = (cells: string[]) => numeric(cells, [1, 2, 3]) && Number(cells[2]) > 0 ? `现存 ${money(Number(cells[1]) / Number(cells[2]))} 天 · 含在途 ${money((Number(cells[1]) + Number(cells[3])) / Number(cells[2]))} 天` : '无法估算：请填写有效数量，日均需大于 0';
function deriveCells(b: Board, cells: string[]) {
  if (isBudget(b)) cells[4] = numeric(cells, [1, 3]) ? String(Number(cells[1]) * Number(cells[3])) : '无法计算';
  if (isStock(b)) cells[4] = numeric(cells, [1, 2, 3]) && Number(cells[2]) > 0 ? (Number(cells[1]) / Number(cells[2])).toFixed(1) : '无法估算';
}
function projectBoard(board: Board): Board {
  const b = structuredClone(board);
  if (isBudget(b)) {
    b.rows.forEach(r => deriveCells(b, r.cells));
    const valid = b.rows.every(r => numeric(r.cells, [1, 3]));
    b.metrics[0] = { ...b.metrics[0], value: valid ? money(b.rows.reduce((sum, r) => sum + Number(r.cells[4]), 0)) : '待核对', hint: '根据当前标准记录重算' };
    b.chart = valid ? { labels: b.rows.map(r => r.cells[0]), values: b.rows.map(r => Number(r.cells[4])) } : undefined;
    b.notices = ['清单合计按当前数量与单价重算。税费、设计费及预备费未纳入，不能当作完整项目总价。'];
  } else if (isStock(b)) {
    b.rows.forEach(r => deriveCells(b, r.cells));
    const valid = b.rows.every(r => numeric(r.cells, [1, 2, 3]) && Number(r.cells[2]) > 0);
    b.metrics[1] = { ...b.metrics[1], value: valid ? String(b.rows.filter(r => Number(r.cells[1]) / Number(r.cells[2]) < 4).length) : '待核对' };
    b.metrics[2] = { ...b.metrics[2], value: b.rows.map(r => numeric(r.cells, [1, 2, 3]) && Number(r.cells[2]) > 0 ? money((Number(r.cells[1]) + Number(r.cells[3])) / Number(r.cells[2])) : '缺数据').join(' / ') };
    b.chart = valid ? { labels: b.rows.map(r => r.cells[0]), values: b.rows.map(r => Number(r.cells[1]) / Number(r.cells[2])), secondary: b.rows.map(r => (Number(r.cells[1]) + Number(r.cells[3])) / Number(r.cells[2])) } : undefined;
  }
  return b;
}

export class Showcase {
  private role: Role | null = null;
  private page = '';
  private selectedRow = '';
  private selectedSource = '';
  private search = '';
  private department = '全部';
  private priority = '全部';
  private flash = '';
  constructor(private root: HTMLElement, private roles: Role[], private store: MockStore) {}
  mount() {
    this.root.addEventListener('click', event => this.click(event));
    this.root.addEventListener('input', event => this.input(event));
    this.root.addEventListener('keydown', event => { const row = (event.target as HTMLElement).closest<HTMLElement>('tr[data-record]'); if (row && event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.go('detail', row.dataset.record!); } });
    this.root.addEventListener('change', event => this.change(event));
    this.root.addEventListener('submit', event => { event.preventDefault(); this.submit(event); });
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }
  private route() {
    const parts = location.hash.slice(1).split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return ''; } });
    this.role = parts[0] === 'role' ? this.roles.find(r => r.id === parts[1]) ?? null : null;
    this.page = this.role ? parts[2] ?? this.role.boards[0].id : '';
    this.selectedRow = parts[3] ?? ''; this.selectedSource = parts[3] ?? '';
    if (this.role && !['sources', 'records', 'tasks', 'reports', 'settings', 'upload', 'about', 'proposal', 'detail'].includes(this.page) && !this.boards().some(b => b.id === this.page)) this.page = this.role.boards[0].id;
    this.render(); window.scrollTo(0, 0);
  }
  private go(page: string, extra = '') { if (this.role) location.hash = `/role/${this.role.id}/${page}${extra ? `/${encodeURIComponent(extra)}` : ''}`; }
  private boards(): Board[] { return this.store.getBoards(this.role!.id).map(projectBoard); }
  private currentBoard(): Board { const boards = this.boards(); const id = this.page === 'detail' ? this.selectedRow.split('~')[0] : this.page; return boards.find(b => b.id === id) ?? boards[0]; }
  private render() {
    this.root.innerHTML = this.role ? this.workspace() : this.home();
    const list = this.root.querySelector('.chat-history'); if (list) list.scrollTop = list.scrollHeight;
    document.title = this.role ? `${this.role.job} · 巴奴 AI 员工` : '巴奴 · AI 员工工作台';
  }
  private brand() { return `<span class="brand-symbol">${icon('spark')}</span><span>巴奴<span class="brand-sub">AI 员工工作台</span></span>`; }
  private home() {
    const depts = [...new Set(this.roles.map(r => r.department.split('/')[0]))];
    const filtered = this.roles.filter(r => (this.department === '全部' || r.department.split('/')[0] === this.department) && (this.priority === '全部' || (r.priorities ?? [r.priority]).includes(this.priority as Role['priority'])) && `${r.name}${r.job}${r.department}${r.summary}${r.tasks.join('')}`.toLowerCase().includes(this.search.toLowerCase()));
    const boards = this.roles.reduce((n, r) => n + this.store.getBoards(r.id).length, 0);
    return `<div class="home-shell"><header class="home-top"><a class="brand" href="#/">${this.brand()}</a><div class="top-status"><span class="green-dot"></span>本地演示空间<span class="small-avatar">演</span></div></header><main class="home-main"><div class="eyebrow">BANU · EMPLOYEE WORKSPACE</div><section class="welcome"><div><h1>让每一个岗位，<br>都有自己的 AI 工作台。</h1><p>从日常待办开始，在看板里核对资料、讨论方案、确认下一步。</p><div class="welcome-notice"><span class="demo-tag">演示数据</span>菜名与门店语境来自公开资料，业务记录均为虚构样例。</div></div><div class="welcome-summary"><div class="summary-top">工作空间概览 <span>2026 / 10 / 09</span></div><div class="summary-numbers"><div><strong>${this.roles.length}</strong><span>岗位员工</span></div><div><strong>18</strong><span>原始需求</span></div><div><strong>${boards}</strong><span>范式看板</span></div></div><div class="summary-bottom">${icon('shield')}12 个业务岗位 · 1 个 CAD 概念 · 4 个数字分身</div></div></section><section class="today-strip"><div class="today-intro">${icon('clock')}<div><strong>今日工作示例</strong><small>点击进入对应岗位</small></div></div>${[['training', '课程资源冲突', '训练计划'], ['supply', '在途到货待核对', '供应计划'], ['legal', '营销证据待更新', '法务审查']].map(([id, title, label]) => `<a href="#/role/${id}" class="today-item"><span class="today-dot"></span><div><strong>${title}</strong><small>${label} · 虚构待办</small></div>${icon('arrow')}</a>`).join('')}</section><section class="employees"><div class="section-heading"><div><h2>我的 AI 员工 <span>${filtered.length}</span></h2><p>选择一个岗位，查看它的工作方式与数据。</p></div><label class="search-box">${icon('search')}<input id="home-search" placeholder="搜索岗位、任务或部门" value="${esc(this.search)}" aria-label="搜索岗位"></label></div><div class="filter-row"><div class="department-tabs">${['全部', ...depts].map(d => `<button class="filter-chip ${d === this.department ? 'active' : ''}" data-dept="${esc(d)}">${esc(d)}</button>`).join('')}</div><select id="priority-filter" aria-label="需求优先级">${['全部', 'P0', 'P1', 'P2', 'P3'].map(p => `<option ${p === this.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div><div class="employee-grid">${filtered.map(r => this.card(r)).join('') || '<div class="empty">没有匹配的岗位。试试其他关键词或筛选条件。</div>'}</div></section><footer class="home-footer"><span>公开资料只提供品牌背景 · 所有业务指标、人员、金额与案件为模拟</span><a href="#/role/training/about">资料来源与关于 ${icon('arrow')}</a></footer></main></div>`;
  }
  private card(r: Role) {
    return `<a class="employee-card" href="#/role/${r.id}" style="--role-accent:${esc(r.accent)}"><div class="card-head"><span class="role-icon">${icon(['training', 'examiner'].includes(r.id) ? 'file' : ['legal', 'organization'].includes(r.id) ? 'shield' : ['hr', 'recruitment', 'performance'].includes(r.id) ? 'people' : 'grid')}</span><span class="priority-tag">${(r.priorities ?? [r.priority]).join(' / ')}</span></div><h3>${esc(r.job)}</h3><div class="role-department">${esc(r.department)}</div><p>${esc(r.summary)}</p><div class="mini-preview kind-${r.boards[0].kind}"><span>${esc(r.boards[0].title)}</span><div class="mini-bars">${[67, 42, 85, 56].map(w => `<i style="width:${w}%"></i>`).join('')}</div><div class="mini-preview-meta">${r.boards[0].rows.length} 条样例 · ${this.store.getBoards(r.id).length} 个看板</div></div><div class="card-foot"><span>${['space', 'chairman', 'ceo', 'vp1', 'vp2'].includes(r.id) ? '概念方案 · 范围待确认' : `${r.tasks.length} 项岗位任务`}</span><strong>进入工作台 ${icon('arrow')}</strong></div></a>`;
  }
  private workspace() {
    const r = this.role!, s = this.store.session(r.id), boards = this.boards();
    const fixed = [['upload', 'upload', '上传资料'], ['sources', 'file', '原始资料'], ['records', 'grid', '标准数据'], ['tasks', 'check', '岗位任务'], ['reports', 'file', '工作报告'], ['settings', 'settings', '岗位设置']];
    return `<div class="workspace ${s.agentOpen ? 'with-agent' : ''}"><aside class="sidebar"><a href="#/" class="brand workspace-brand">${this.brand()}</a><a href="#/" class="back-home">${icon('back')}全部 AI 员工</a><div class="sidebar-role" style="--role-accent:${esc(r.accent)}"><span class="role-icon">${icon('people')}</span><strong>${esc(r.job)}</strong><small>${esc(r.department)}</small></div><div class="nav-label">工作看板<button data-action="add-board" aria-label="新增看板" title="通过 Agent 新增看板">${icon('plus')}</button></div><nav class="board-nav">${boards.map(b => `<button class="nav-item ${this.page === b.id ? 'active' : ''}" data-page="${b.id}">${icon('grid')}<span>${esc(b.title)}</span>${b.priority ? `<small>${b.priority}</small>` : ''}</button>`).join('')}${s.proposal ? `<button class="nav-item proposal-nav ${this.page === 'proposal' ? 'active' : ''}" data-page="proposal">${icon('spark')}<span>待确认提案</span><i></i></button>` : ''}</nav><div class="nav-label utility-label">岗位资料</div><nav>${fixed.map(([page, ic, label]) => `<button class="nav-item ${this.page === page ? 'active' : ''}" data-page="${page}">${icon(ic)}<span>${label}</span></button>`).join('')}</nav><div class="sidebar-bottom"><button class="agent-toggle" data-action="toggle-agent">${icon('chat')}岗位 Agent<span>${s.agentOpen ? '展开中' : '打开'}</span></button><button class="version-link" data-page="about">v${manifest.version} · 关于插件</button></div></aside><div class="workspace-body"><header class="workspace-top"><div class="breadcrumb"><span>${esc(r.department.split('/')[0])}</span>${icon('arrow')}<strong>${esc(r.job)}</strong></div><div class="workspace-tools"><span class="demo-tag">MOCK 演示</span><select id="role-switch" aria-label="切换岗位">${this.roles.map(x => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${esc(x.job)}</option>`).join('')}</select>${!s.agentOpen ? `<button class="icon-button" data-action="toggle-agent" aria-label="打开岗位 Agent">${icon('chat')}</button>` : ''}</div></header><main class="work-content">${this.store.warning ? `<div class="warning">${esc(this.store.warning)}</div>` : ''}${this.flash ? `<div class="notice flash">${esc(this.flash)}</div>` : ''}${r.scopeNote ? `<div class="scope-notice">${icon('file')}<span>${esc(r.scopeNote)}</span></div>` : ''}${this.content()}</main></div>${s.agentOpen ? this.agent() : ''}</div>`;
  }
  private heading(title: string, subtitle: string, action = '') { return `<div class="page-heading"><div><div class="eyebrow">${esc(this.role!.name)}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${action}</div>`; }
  private content(): string {
    const r = this.role!, s = this.store.session(r.id);
    if (this.page === 'sources') {
      const sources = this.store.getSources(r.id), selected = sources.find(x => x.id === this.selectedSource);
      return this.heading('原始资料', '内置样例保留只读原文；上传文件仅保存元信息。', '<button class="primary-button" data-page="upload">上传资料</button>') + `<div class="source-layout"><div class="source-list">${sources.map(x => `<button data-source="${x.id}" class="source-card ${selected?.id === x.id ? 'selected' : ''}">${icon('file')}<div><strong>${esc(x.name)}</strong><small>${esc(x.type)} · ${esc(x.collectedAt)}</small><span>${esc(x.origin)}</span></div>${icon('arrow')}</button>`).join('')}</div><div class="source-reader">${selected ? `<span class="demo-tag">只读原始样例</span><h2>${esc(selected.name)}</h2><pre>${esc(selected.content)}</pre>` : '<div class="empty">选择左侧资料，查看只读原始内容。</div>'}</div></div>`;
    }
    if (this.page === 'upload') return this.heading('上传岗位资料', '为界面讨论补充一个文件示例。') + `<section class="upload-zone">${icon('upload')}<h2>选择文件，登记资料信息</h2><p>支持 PDF、Excel、Word、CSV、TXT、图片与视频，单文件不超过 50 MB。</p><label class="primary-button file-picker">选择文件<input id="upload-file" type="file" accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.png,.jpg,.jpeg,.webp,.mp4,.mov"></label><p class="upload-limit">当前浏览器仅保留文件名、大小和类型；不会读取或保存文件原件，也不会解析内容。</p></section><div class="notice">内置虚构资料的完整文字样例可在「原始资料」查看。</div>`;
    if (this.page === 'tasks') return this.heading('岗位任务与需求', '每项任务都能进入对应范式看板，讨论字段、步骤和人工确认点。') + `<div class="task-list">${r.tasks.map((task, i) => `<button data-page="${r.taskBoardIds?.[i] ?? r.boards[i % r.boards.length].id}" class="task-row"><span class="task-index">${String(i + 1).padStart(2, '0')}</span><div><strong>${esc(task)}</strong><small>原需求关联：${(r.boards.find(b => b.id === r.taskBoardIds?.[i])?.requirementIds ?? r.requirementIds).map(n => `#${n}`).join('、')} · ${esc(r.boards.find(b => b.id === r.taskBoardIds?.[i])?.title ?? '岗位看板')}</small></div>${icon('arrow')}</button>`).join('')}</div><div class="notice">优先级 ${(r.priorities ?? [r.priority]).join(' / ')} 来自需求清单，表示需求顺序；看板中的业务记录均为 mock。</div>`;
    if (this.page === 'settings') return this.heading('岗位设置', '配置当前演示岗位的工作范围和表达方式。') + `<form id="settings-form" class="settings-panel"><label>服务企业<input name="company" maxlength="200" value="${esc(s.settings.company)}"></label><label>岗位工作范围<textarea name="scope" maxlength="2000">${esc(s.settings.scope)}</textarea></label><label>表达方式<select name="tone">${['专业简洁', '解释详细', '行动清单'].map(t => `<option ${t === s.settings.tone ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label>岗位规则与人工确认点<textarea name="ruleNotes" maxlength="10000" rows="7">${esc(s.settings.ruleNotes)}</textarea></label><label class="checkbox-label"><input type="checkbox" name="developerMode" ${s.settings.developerMode ? 'checked' : ''}> 显示演示数据结构</label><button class="primary-button" type="submit">保存演示设置</button></form><div class="settings-footer"><button class="text-button" data-page="about">版本 ${manifest.version} · 关于插件</button></div>`;
    if (this.page === 'reports') return this.heading('工作报告', '从 Agent 讨论中保存报告，回到看板继续核对。') + `<div class="reports">${s.reports.length ? s.reports.map(x => `<article class="report"><div><span class="demo-tag">演示草案</span><small>${esc(shortTime(x.at))}</small></div><h2>${esc(x.title)}</h2><pre>${esc(x.body)}</pre><button class="secondary-button" data-page="${x.boardId}">返回关联看板 ${icon('arrow')}</button></article>`).join('') : '<div class="empty">还没有报告。与右侧 Agent 讨论后，点击「保存为报告」。</div>'}</div>`;
    if (this.page === 'about') return this.heading('关于 AI 员工工作台', '本地 UI/UX 讨论演示。') + `<section class="about-panel"><span class="brand-symbol">${icon('spark')}</span><h2>${esc(manifest.name)} <small>v${manifest.version}</small></h2><p>18 条原始需求合并为 17 位岗位员工。首页与岗位工作台用于核对任务、资料、数据结构和交互。</p><p>所有业务记录、人员、库存、路线、金额、考核、合同与案件都是虚构样例。真实模型、视频识别、CAD、消息发送、外部系统与正式审批尚未接入。</p><h3>公开背景资料</h3>${PUBLIC_SOURCES.map(x => `<a class="public-source" href="${x.url}" target="_blank" rel="noreferrer">${esc(x.title)} ${icon('arrow')}<small>${esc(x.note)}</small></a>`).join('')}<h3>本次演示新增内容</h3><p>独立岗位首页、专属看板、多轮演示 Agent、可确认提案、资料引用、记录修订和浏览器保存。原插件版本与 Host 工作流保持独立。</p></section>`;
    if (this.page === 'proposal') return this.proposal();
    if (this.page === 'detail') return this.detail();
    if (this.page === 'records') return this.heading('标准数据', '整理后的演示记录可逐条修订，原始资料始终保留。') + this.boards().map(b => `<section class="record-section"><h2>${esc(b.title)}</h2>${this.table(b)}</section>`).join('');
    return this.board(this.currentBoard());
  }
  private board(b: Board) {
    const r = this.role!, s = this.store.session(r.id);
    return this.heading(b.title, b.subtitle, `<button class="secondary-button" data-prompt="请分析${esc(b.title)}并引用相关记录">${icon('spark')}与 Agent 讨论</button>`) + `<div class="board-meta"><span class="demo-tag">虚构业务样例</span><span>${b.rows.length} 条记录</span>${b.priority ? `<span>需求优先级 ${b.priority}</span>` : ''}<span>资料依据 ${new Set(b.rows.map(x => x.sourceId)).size} 份</span></div><div class="metrics">${b.metrics.map(m => `<div class="metric"><label>${esc(m.label)}</label><div><strong>${esc(m.value)}</strong><span>${esc(m.unit)}</span></div><small>${esc(m.hint)}</small></div>`).join('')}</div>${!isBudget(b) && !isStock(b) ? '<div class="metric-note">汇总指标为初始演示快照；记录修订会保留在工作记录中。</div>' : ''}${b.steps ? `<div class="workflow">${b.steps.map((st, i) => `<span><i>${i + 1}</i>${esc(st)}</span>`).join('')}</div>` : ''}${renderVisual(b)}${isBudget(b) ? this.costCalculator(b) : ''}${b.kind === 'inventory' && b.columns.includes('现存（kg）') ? this.inventoryCalculator(b) : ''}${b.notices?.length ? `<div class="board-notices">${b.notices.map(n => `<div>${icon('file')}<span>${esc(n)}</span></div>`).join('')}</div>` : ''}<section class="data-panel"><div class="panel-heading"><h2>工作记录</h2><span>点击记录查看依据与修订</span></div>${this.table(b)}</section><div class="board-actions">${b.actions.map(a => `<button class="secondary-button" data-prompt="${esc(a)}">${esc(a)} ${icon('arrow')}</button>`).join('')}</div>${s.settings.developerMode ? `<details class="developer-data"><summary>当前演示数据结构</summary><pre>${esc(JSON.stringify(b, null, 2))}</pre></details>` : ''}<div class="board-footnote">本页数据用于界面讨论；按钮在当前演示内形成讨论草案，外部动作需另行实现。</div>`;
  }
  private table(b: Board, editable = true) { return `<div class="table-scroll"><table><thead><tr>${b.columns.map(x => `<th>${esc(x)}</th>`).join('')}<th class="row-open"></th></tr></thead><tbody>${b.rows.map(row => `<tr ${editable ? `data-record="${b.id}~${row.id}" tabindex="0" aria-label="查看${esc(row.cells[0])}"` : ""}>${row.cells.map((c, i) => `<td>${i === b.columns.length - 1 ? `<span class="status-pill ${/已|完成|归档/.test(c) ? 'done' : /缺|异常|逾期|不|冲突|过期/.test(c) ? 'attention' : ''}">${esc(c)}</span>` : esc(c)}</td>`).join('')}<td>${editable ? `<button class="row-open" data-record="${b.id}~${row.id}" aria-label="查看记录">${icon('arrow')}</button>` : ""}</td></tr>`).join('')}</tbody></table></div>`; }
  private detail() {
    const [boardId, rowId] = this.selectedRow.split('~'), b = this.boards().find(x => x.id === boardId);
    if (!b || !b.rows.some(x => x.id === rowId)) return '<div class="empty">这条记录不存在。请选择左侧看板。</div>';
    const row = this.store.getRow(this.role!.id, boardId, rowId); row.cells = b.rows.find(x => x.id === rowId)!.cells;
    return this.heading(row.cells[0], `标准记录 · ${b.title} · 修订 V${row.revision}`, `<button class="secondary-button" data-page="${b.id}">${icon('back')}返回看板</button>`) + `<div class="detail-layout"><section class="detail-panel"><h2>记录内容</h2><p><span class="demo-tag">初始采集说明</span> ${esc(row.detail)}</p><form id="record-form" data-board="${b.id}" data-row="${row.id}"><div class="record-fields">${b.columns.map((label, i) => `<label>${esc(label)}<input name="cell-${i}" value="${esc(row.cells[i])}" maxlength="1000" ${(isBudget(b) || isStock(b)) && i === 4 ? 'readonly aria-label="根据当前字段自动计算"' : 'required'}></label>`).join('')}</div><label>本次修订原因<textarea name="reason" required maxlength="2000" placeholder="例如：核对原始资料后调整样例状态"></textarea></label><button class="primary-button" type="submit">保存修订</button></form></section><aside class="evidence-panel"><h2>原始依据</h2><button class="source-link" data-source="${row.sourceId}">${icon('file')}${esc(this.store.getSources(this.role!.id).find(x => x.id === row.sourceId)?.name)}${icon('arrow')}</button><h2>修订历史</h2>${row.history.slice().reverse().map(x => `<div class="revision"><strong>V${x.revision}</strong><small>${esc(shortTime(x.at))}</small><p>${esc(x.reason)}</p><div>${esc(x.cells.join(' · '))}</div></div>`).join('')}<button class="secondary-button" data-prompt="请核对${esc(row.cells[0])}并引用原始资料">${icon('chat')}与 Agent 核对</button></aside></div>`;
  }
  private proposal() {
    const p = this.store.session(this.role!.id).proposal;
    if (!p) return '<div class="empty">暂无提案。点击左侧 +，向 Agent 描述想要的看板。</div>';
    return this.heading(p.title, '这是待确认的演示提案。确认后才更新当前岗位。') + `<section class="proposal-panel"><span class="demo-tag">待人工确认</span><p>${esc(p.description)}</p>${p.board ? `${renderVisual(p.board)}${this.table(p.board, false)}` : `<div class="notice">演示操作只把选中记录状态修订为「已确认（演示）」。不会发送通知、排班、下单或执行正式审批。</div>`}<button class="primary-button" data-action="confirm-proposal">${icon('check')}确认演示提案</button></section>`;
  }
  private agent() {
    const r = this.role!, s = this.store.session(r.id), b = this.currentBoard();
    return `<aside class="agent-panel"><header class="agent-head"><div><span class="agent-avatar">${icon('spark')}</span><strong>岗位 Agent<small>规则演示 · 当前岗位独立会话</small></strong></div><button class="icon-button" data-action="toggle-agent" aria-label="关闭 Agent">${icon('close')}</button></header><div class="agent-context">${icon('grid')}<span>当前：${esc(b.title)}</span><span class="green-dot"></span></div><div class="chat-history" aria-live="polite">${s.messages.length ? s.messages.map(m => `<div class="chat-message ${m.who}"><div class="message-label">${m.who === 'agent' ? '岗位 Agent' : '你'}<small>${shortTime(m.at)}</small></div><div class="message-text">${esc(m.text)}</div>${m.links?.length ? `<div class="message-links">${m.links.map(l => `<button data-chat-board="${l.boardId}" ${l.rowId ? `data-chat-row="${l.rowId}"` : ''} ${l.sourceId ? `data-chat-source="${l.sourceId}"` : ''}>${icon(l.sourceId ? 'file' : 'grid')}${esc(l.label ?? '查看依据')}</button>`).join('')}</div>` : ''}</div>`).join('') : `<div class="agent-welcome"><span class="large-spark">${icon('spark')}</span><h2>一起推进岗位工作</h2><p>${esc(r.summary)}</p><small>我能用样例记录讨论方案、引用资料，或提出新看板。每个岗位都有自己的会话。新看板保存当前记录的独立快照。</small><div class="prompt-list">${r.prompts.map(p => `<button data-prompt="${esc(p)}">${esc(p)}${icon('arrow')}</button>`).join('')}</div></div>`}${s.proposal ? `<button class="chat-proposal" data-page="proposal">${icon('spark')}查看待确认提案 ${icon('arrow')}</button>` : ''}</div>${s.messages.some(m => m.who === 'agent') ? `<button class="save-report" data-action="save-report">${icon('file')}保存最新讨论为报告</button>` : ''}<form id="chat-form" class="chat-composer"><textarea id="agent-draft" aria-label="向岗位 Agent 提问" rows="3" maxlength="20000" placeholder="描述需求，或让 Agent 核对当前看板…">${esc(s.draft)}</textarea><div><span>演示回复 · 不调用模型</span><button type="submit" class="send-button" aria-label="发送消息">${icon('arrow')}</button></div></form></aside>`;
  }
  private costCalculator(b: Board) { return `<section class="calculator"><div class="panel-heading"><h2>预算试算</h2><span>数量 × 单价 · 单位来自演示记录</span></div>${b.rows.map((row, i) => `<div class="calc-line"><strong>${esc(row.cells[0])}</strong><label>数量<input type="number" min="0" max="100000000" step="any" data-calc="qty" data-index="${i}" value="${esc(row.cells[1])}"></label><span>${esc(row.cells[2])}</span><label>单价（元）<input type="number" min="0" max="100000000" step="any" data-calc="price" data-index="${i}" value="${esc(row.cells[3])}"></label><output data-subtotal="${i}">${numeric(row.cells, [1, 3]) ? money(Number(row.cells[1]) * Number(row.cells[3])) + " 元" : "无法计算"}</output></div>`).join('')}<div class="calc-total">预算合计 <strong id="cost-total">${b.rows.every(r => numeric(r.cells, [1, 3])) ? money(b.rows.reduce((n, x) => n + Number(x.cells[1]) * Number(x.cells[3]), 0)) + " 元" : "无法合计，请检查输入"}</strong></div><small>临时试算不改标准记录。正式调整请进入记录并填写修订原因。</small></section>`; }
  private inventoryCalculator(b: Board) { return `<section class="calculator inventory-calculator"><div class="panel-heading"><h2>库存覆盖天数试算</h2><span>现存与在途分开看</span></div><div class="inventory-lines">${b.rows.map((row, i) => `<div class="stock-line"><strong>${esc(row.cells[0])}</strong><div><label>现存 kg<input type="number" min="0" step="any" data-stock="current" data-index="${i}" value="${esc(row.cells[1])}"></label><label>日均 kg<input type="number" min="0" step="any" data-stock="daily" data-index="${i}" value="${esc(row.cells[2])}"></label><label>在途 kg<input type="number" min="0" step="any" data-stock="inflight" data-index="${i}" value="${esc(row.cells[3])}"></label></div><output data-stock-output="${i}">${stockText(row.cells)}</output></div>`).join('')}</div><small>日均为 0 时无法估算。批次到货与适用阈值需人工核验，天数不是自动采购结论。</small></section>`; }
  private click(event: Event) {
    const target = (event.target as Element).closest<HTMLElement>('button,a,tr[data-record]'); if (!target) return;
    try {
      if (target.dataset.dept) { this.department = target.dataset.dept; this.render(); }
      else if (target.dataset.page) { this.flash = ''; this.go(target.dataset.page); }
      else if (target.dataset.source) this.go('sources', target.dataset.source);
      else if (target.dataset.record) this.go('detail', target.dataset.record);
      else if (target.dataset.prompt) this.prefill(target.dataset.prompt);
      else if (target.dataset.chatBoard) { const l = target.dataset; if (l.chatSource) this.go('sources', l.chatSource); else if (l.chatRow) this.go('detail', `${l.chatBoard}~${l.chatRow}`); else this.go(l.chatBoard!); }
      else if (target.dataset.action && this.role) {
        const action = target.dataset.action, r = this.role;
        if (action === 'toggle-agent') { this.store.setAgentOpen(r.id, !this.store.session(r.id).agentOpen); this.render(); }
        if (action === 'add-board') this.prefill(`请为${r.job}新增一个看板，用来跟进当前待办`);
        if (action === 'save-report') { const last = this.store.session(r.id).messages.filter(m => m.who === 'agent').at(-1)!; const linked = this.boards().find(b => b.id === last.links?.[0]?.boardId) ?? this.currentBoard(); this.store.saveReport(r.id, `${linked.title} · 讨论草案`, last.text, linked.id); this.go('reports'); }
        if (action === 'confirm-proposal') { const p = this.store.confirmProposal(r.id); if (p.type === 'operation' && p.rowId) { const row = this.store.getRow(r.id, p.boardId, p.rowId); const cells = [...row.cells]; cells[cells.length - 1] = '已确认（演示）'; this.store.updateRow(r.id, p.boardId, p.rowId, cells, p.title); } this.store.addMessage(r.id, 'agent', p.type === 'board' ? `「${p.title}」已加入左侧看板。可继续查看资料和修订演示记录。` : '已保存演示修订记录；此确认只改变本地样例状态。', [{ boardId: p.boardId, label: '查看确认结果' }]); this.go(p.boardId); }
      }
    } catch (err) { this.flash = `操作未保存：${err instanceof Error ? err.message : '请检查输入'}`; this.render(); }
  }
  private prefill(text: string) { this.store.setAgentOpen(this.role!.id, true); this.store.setDraft(this.role!.id, text); this.render(); const draft = this.root.querySelector<HTMLTextAreaElement>('#agent-draft'); draft?.focus(); draft?.setSelectionRange(text.length, text.length); }
  private input(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.id === 'home-search') { this.search = input.value; const start = input.selectionStart; this.render(); const next = this.root.querySelector<HTMLInputElement>('#home-search')!; next.focus(); next.setSelectionRange(start, start); }
    if (input.id === 'agent-draft' && this.role) { try { this.store.setDraft(this.role.id, input.value); } catch (err) { this.flash = String(err); } }
    if (input.dataset.calc) this.recalculateCost();
    if (input.dataset.stock) this.recalculateStock();
  }
  private change(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.id === 'priority-filter') { this.priority = input.value; this.render(); }
    if (input.id === 'role-switch') location.hash = `/role/${input.value}`;
    if (input.id === 'upload-file' && this.role) {
      const file = input.files?.[0]; if (!file) return;
      if (file.size > 50 * 1024 * 1024 || !/\.(pdf|xlsx?|docx?|csv|txt|png|jpe?g|webp|mp4|mov)$/i.test(file.name)) { this.flash = '请选择支持的文件类型，且大小不超过 50 MB。'; this.render(); return; }
      const id = `upload-${Date.now().toString(36)}`;
      try { this.store.appendSource(this.role.id, { id, name: file.name.slice(0, 200), type: '上传元信息 · 未解析', collectedAt: new Date().toLocaleString('zh-CN'), origin: '当前浏览器 · 文件原件未保存', content: `文件名：${file.name.slice(0, 200)}\n大小：${money(file.size / 1024)} KB\n类型：${file.type || '未声明'}\n仅保留以上文件信息；文件原件与正文没有读取、保存或上传。正式资料采集需要另行实现。` }); this.flash = '已登记文件信息。文件原件未保存，内容未解析。'; this.go('sources', id); } catch (err) { this.flash = String(err); this.render(); }
    }
  }
  private submit(event: Event) {
    const form = event.target as HTMLFormElement; if (!this.role) return;
    try {
      if (form.id === 'chat-form') this.send();
      if (form.id === 'record-form') { const b = this.boards().find(x => x.id === form.dataset.board)!; const data = new FormData(form); const cells = b.columns.map((_, i) => String(data.get(`cell-${i}`) ?? '')); deriveCells(b, cells); this.store.updateRow(this.role.id, b.id, form.dataset.row!, cells, String(data.get('reason') ?? '').trim()); this.flash = '修订已保存，原始资料和历史版本仍保留。'; this.render(); }
      if (form.id === 'settings-form') { const data = new FormData(form); this.store.updateSettings(this.role.id, { company: String(data.get('company')), scope: String(data.get('scope')), tone: String(data.get('tone')), ruleNotes: String(data.get('ruleNotes')), developerMode: data.has('developerMode') }); this.flash = '岗位演示设置已保存。'; this.render(); }
    } catch (err) { this.flash = `未保存：${err instanceof Error ? err.message : '请检查输入'}`; this.render(); }
  }
  private send() {
    const r = this.role!, s = this.store.session(r.id), text = s.draft.trim(); if (!text) return;
    const b = this.currentBoard(), row = b.rows[0];
    if (s.messages.length > 198) throw new Error('当前岗位会话已达到演示保存上限，可切换其他岗位继续讨论。');
    this.store.addMessage(r.id, 'user', text); this.store.setDraft(r.id, '');
    const links: ChatLink[] = [{ boardId: b.id, label: b.title }]; if (row) links.push({ boardId: b.id, rowId: row.id, label: row.cells[0] }, { boardId: b.id, sourceId: row.sourceId, label: '查看原始依据' });
    let reply = `已结合「${b.title}」的 ${b.rows.length} 条演示记录整理。\n\n${b.rows.slice(0, 3).map((x, i) => `${i + 1}. ${x.cells[0]}：${x.cells.at(-1)}。当前字段：${x.cells.slice(1, -1).join(" / ")}`).join('\n\n')}\n\n下一步：${b.actions[0] ?? '核对原始资料'}，并由岗位负责人确认。\n岗位规则：${s.settings.ruleNotes.split('\n')[0]}\n以上是基于 mock 数据的规则演示回复。`;
    if (/新增|新建|增加/.test(text) && /看板|页面/.test(text)) {
      const id = `extra-${Date.now().toString(36)}`, title = /[「“](.+?)[」”]/.exec(text)?.[1]?.slice(0, 80) ?? `${b.title} · 跟进看板`;
      const board: Board = { ...structuredClone(b), id, title, subtitle: '基于当前岗位记录的独立演示快照，确认后加入左侧；后续修订在此看板单独保存。', rows: b.rows.map(x => ({ ...x, cells: [...x.cells] })) };
      this.store.propose(r.id, { type: 'board', title, description: `按「${b.title}」的字段和资料引用准备了 ${board.rows.length} 条样例。新增范围仅限当前岗位，确认后才能显示在工作看板列表。`, boardId: id, board });
      reply = `已准备「${title}」的演示提案。\n\n包含 ${board.rows.length} 条样例、${board.columns.length} 个字段，保留原始资料引用，记录为独立快照。请在左侧「待确认提案」预览内容，再确认新增。\n看板尚未加入；可以继续描述调整需求。`;
    } else if (/确认|执行|排班|下单|发送|生成.*草案/.test(text) && row) {
      this.store.propose(r.id, { type: 'operation', title: `${b.title} · 演示确认`, description: `拟把「${row.cells[0]}」的本地样例状态修订为「已确认（演示）」，并保留修订历史。`, boardId: b.id, rowId: row.id });
      reply += '\n\n已准备一个演示确认提案，点击「查看待确认提案」核对后再确认。';
    }
    this.store.addMessage(r.id, 'agent', reply, links); this.render();
  }
  private recalculateCost() {
    let total = 0, valid = true;
    this.root.querySelectorAll<HTMLInputElement>('[data-calc="qty"]').forEach(q => { const p = this.root.querySelector<HTMLInputElement>(`[data-calc="price"][data-index="${q.dataset.index}"]`)!; const qty = Number(q.value), price = Number(p.value), ok = q.value !== '' && p.value !== '' && Number.isFinite(qty) && Number.isFinite(price) && qty >= 0 && price >= 0 && qty <= 100000000 && price <= 100000000; const sum = qty * price; valid &&= ok; total += ok ? sum : 0; this.root.querySelector(`[data-subtotal="${q.dataset.index}"]`)!.textContent = ok ? `${money(sum)} 元` : '请填有效非负数'; });
    this.root.querySelector('#cost-total')!.textContent = valid ? `${money(total)} 元` : '无法合计，请检查输入';
  }
  private recalculateStock() {
    this.root.querySelectorAll<HTMLInputElement>('[data-stock="current"]').forEach(c => { const d = this.root.querySelector<HTMLInputElement>(`[data-stock="daily"][data-index="${c.dataset.index}"]`)!, f = this.root.querySelector<HTMLInputElement>(`[data-stock="inflight"][data-index="${c.dataset.index}"]`)!; const values = [c, d, f].map(x => Number(x.value)); const [current, daily, inflight] = values; const ok = [c, d, f].every(x => x.value !== '') && values.every(x => Number.isFinite(x) && x >= 0 && x <= 100000000) && daily > 0; this.root.querySelector(`[data-stock-output="${c.dataset.index}"]`)!.textContent = ok ? `现存 ${money(current / daily)} 天 · 含在途 ${money((current + inflight) / daily)} 天` : '无法估算：请填写有效数量，日均需大于 0'; });
  }
}
