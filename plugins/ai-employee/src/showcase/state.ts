import type { Board, ChatLink, ChatMessage, DemoReport, Proposal, Role, RoleSession, RoleSettings, RowRevision, Source, StorageLike, StoreRow } from './types';

export const SHOWCASE_STORAGE_KEY = 'reai-employee-showcase:v1';
const LIMIT = { raw: 2_000_000, text: 20_000, cell: 2_000, boards: 48, rows: 300, columns: 24, sources: 64, messages: 200, history: 100, reports: 64 };
const KINDS = ['calendar', 'video', 'inspection', 'design', 'floorplan', 'cost', 'inventory', 'route', 'org', 'performance', 'people', 'recruitment', 'legal', 'executive', 'scope', 'bars'];
const RESERVED_BOARD_IDS = new Set(['sources', 'records', 'tasks', 'reports', 'settings', 'upload', 'about', 'proposal', 'detail']);
const clone = <T>(value: T): T => structuredClone(value);
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`演示数据无效：${message}`); }
function object(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), `${label}格式`);
  check(Object.keys(value).every(key => keys.includes(key)), `${label}含未知字段`);
}
function text(value: unknown, label: string, max = LIMIT.text, empty = true): asserts value is string {
  check(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0), `${label}必须是长度不超过 ${max} 的文本`);
}
function id(value: unknown, label: string): asserts value is string {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value), `${label}标识`);
}
function list(value: unknown, label: string, max: number): asserts value is unknown[] { check(Array.isArray(value) && value.length <= max, `${label}数量不超过 ${max}`); }
function texts(value: unknown, label: string, maxItems = 64, maxLength = LIMIT.cell): asserts value is string[] { list(value, label, maxItems); value.forEach(item => text(item, label, maxLength)); }
function uniqueIds(items: { id: string }[], label: string) { check(new Set(items.map(item => item.id)).size === items.length, `${label}标识重复`); }
function source(value: unknown): asserts value is Source {
  object(value, ['id', 'name', 'type', 'collectedAt', 'origin', 'content'], '资料摘要'); id(value.id, '资料');
  for (const field of ['name', 'type', 'collectedAt', 'origin']) text(value[field], `资料${field}`, 1_000, false);
  text(value.content, '资料摘要正文');
}
function board(value: unknown): asserts value is Board {
  object(value, ['id', 'title', 'subtitle', 'kind', 'metrics', 'columns', 'rows', 'actions', 'steps', 'chart', 'notices', 'priority', 'requirementIds'], '看板');
  id(value.id, '看板'); text(value.title, '看板标题', 256, false); text(value.subtitle, '看板副标题', 4_000);
  check(KINDS.includes(value.kind as string), '看板类型');
  list(value.metrics, '指标', 16);
  value.metrics.forEach(metric => { object(metric, ['label', 'value', 'unit', 'hint'], '指标'); text(metric.label, '指标标签', 256); text(metric.value, '指标值', 256); if (metric.unit !== undefined) text(metric.unit, '指标单位', 100); if (metric.hint !== undefined) text(metric.hint, '指标说明', 1_000); });
  texts(value.columns, '列名', LIMIT.columns, 100); const columns = value.columns; check(columns.length > 0, '看板需要列名');
  list(value.rows, '记录', LIMIT.rows);
  value.rows.forEach(row => { object(row, ['id', 'cells', 'detail', 'sourceId'], '记录'); id(row.id, '记录'); id(row.sourceId, '记录来源'); texts(row.cells, '单元格', LIMIT.columns); check(row.cells.length === columns.length, '记录列数'); text(row.detail, '记录详情', 8_000); });
  uniqueIds(value.rows as Board['rows'], '记录'); texts(value.actions, '操作', 32, 256);
  for (const key of ['steps', 'notices']) if (value[key] !== undefined) texts(value[key], key, 64, 4_000);
  if (value.priority !== undefined) check(['P0', 'P1', 'P2', 'P3'].includes(value.priority as string), '优先级');
  if (value.requirementIds !== undefined) { list(value.requirementIds, '需求编号', 32); check(value.requirementIds.every(item => Number.isInteger(item) && Number(item) > 0 && Number(item) <= 100), '需求编号'); }
  if (value.chart !== undefined) {
    object(value.chart, ['labels', 'values', 'secondary'], '图表'); texts(value.chart.labels, '图表标签', 64, 256);
    for (const key of ['values', 'secondary']) if (value.chart[key] !== undefined) { list(value.chart[key], '图表数值', 64); check(value.chart[key].length === value.chart.labels.length && value.chart[key].every(item => typeof item === 'number' && Number.isFinite(item)), '图表标签与有限数值需对应'); }
    check(Array.isArray(value.chart.values), '图表数值');
  }
}
function settings(value: unknown): asserts value is RoleSettings {
  object(value, ['company', 'scope', 'tone', 'ruleNotes', 'developerMode'], '设置');
  for (const key of ['company', 'scope', 'tone', 'ruleNotes']) text(value[key], `设置${key}`, key === 'ruleNotes' ? 12_000 : 4_000);
  check(typeof value.developerMode === 'boolean', '开发者模式');
}
function proposal(value: unknown): asserts value is Proposal {
  object(value, ['type', 'title', 'description', 'boardId', 'rowId', 'board'], '提案');
  check(value.type === 'board' || value.type === 'operation', '提案类型'); text(value.title, '提案标题', 256, false); text(value.description, '提案说明', 8_000); id(value.boardId, '提案看板');
  if (value.rowId !== undefined) id(value.rowId, '提案记录');
  if (value.type === 'board') { board(value.board); check(value.board.id === value.boardId && value.rowId === undefined, '新增看板提案目标'); }
  else check(value.board === undefined, '操作提案不可包含执行定义');
}
const initialHistory = (cells: string[]): RowRevision => ({ revision: 1, cells: clone(cells), reason: '演示初始记录', at: '2026-10-09T00:00:00.000Z' });
const now = () => new Date().toISOString();
let sequence = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++sequence).toString(36)}`;

/** Isolated UI discussion state; never stores upload bytes or executes arbitrary HTML. */
export class MockStore {
  warning: string | null = null;
  private readonly roles = new Map<string, Role>();
  private readonly sessions = new Map<string, RoleSession>();
  private storage?: StorageLike;

  constructor(roles: Role[], storage?: StorageLike) {
    check(roles.length > 0 && roles.length <= 64, '岗位数量');
    for (const role of roles) {
      id(role.id, '岗位'); check(!this.roles.has(role.id), '岗位标识重复');
      role.boards.forEach(item => { board(item); check(!RESERVED_BOARD_IDS.has(item.id), '看板标识被固定入口占用'); }); role.sources.forEach(source); uniqueIds(role.boards, '看板'); uniqueIds(role.sources, '资料');
      this.roles.set(role.id, clone(role)); this.sessions.set(role.id, this.defaults(role));
      this.validateSession(role.id, this.sessions.get(role.id));
    }
    try { this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined); }
    catch { this.warning = '浏览器存储不可用，当前演示仅保存在内存，刷新将丢失。'; }
    if (!this.storage) { this.warning ??= '浏览器存储不可用，当前演示仅保存在内存，刷新将丢失。'; return; }
    try {
      const raw = this.storage.getItem(SHOWCASE_STORAGE_KEY); if (raw === null) return;
      check(raw.length <= LIMIT.raw, '保存内容过大'); const value: unknown = JSON.parse(raw);
      object(value, ['version', 'roles'], '存储'); check(value.version === 1, '存储版本不兼容');
      object(value.roles, roles.map(item => item.id), '岗位存储');
      for (const [roleId, session] of Object.entries(value.roles)) this.validateSession(roleId, session);
      for (const [roleId, session] of Object.entries(value.roles)) this.sessions.set(roleId, clone(session as RoleSession));
    } catch {
      this.warning = '浏览器保存内容无法读取或格式不兼容，已恢复初始演示；当前操作仅保存在内存，原保存内容未覆盖。';
      // Do not silently replace a corrupt or unreadable saved session.
      this.storage = undefined;
    }
  }

  private defaults(role: Role): RoleSession { return { draft: '', agentOpen: true, messages: [], boards: [], sources: [], edits: {}, proposal: null, settings: { company: '巴奴毛肚火锅（演示）', scope: role.scopeNote ?? role.job, tone: '专业简洁', ruleNotes: role.rules.join('\n'), developerMode: false }, reports: [] }; }
  private current(roleId: string): RoleSession { const session = this.sessions.get(roleId); check(session, '岗位不存在'); return session; }
  private allBoards(roleId: string, session = this.current(roleId)): Board[] { const role = this.roles.get(roleId); check(role, '岗位不存在'); return [...role.boards, ...session.boards]; }
  private allSources(roleId: string, session = this.current(roleId)): Source[] { const role = this.roles.get(roleId); check(role, '岗位不存在'); return [...role.sources, ...session.sources]; }
  private findRow(roleId: string, boardId: string, rowId: string, session = this.current(roleId)) {
    const selected = this.allBoards(roleId, session).find(item => item.id === boardId); check(selected, '当前岗位看板不存在');
    const row = selected.rows.find(item => item.id === rowId); check(row, '当前看板记录不存在'); return { selected, row };
  }
  private validateLink(roleId: string, value: unknown, session: RoleSession): asserts value is ChatLink {
    object(value, ['boardId', 'rowId', 'sourceId', 'label'], '引用'); id(value.boardId, '引用看板');
    check(this.allBoards(roleId, session).some(item => item.id === value.boardId), '当前岗位引用看板不存在');
    if (value.rowId !== undefined) { id(value.rowId, '引用记录'); this.findRow(roleId, value.boardId, value.rowId, session); }
    if (value.sourceId !== undefined) { id(value.sourceId, '引用资料'); check(this.allSources(roleId, session).some(item => item.id === value.sourceId), '当前岗位引用资料不存在'); }
    if (value.label !== undefined) text(value.label, '引用标签', 256);
  }
  private validateProposal(roleId: string, value: unknown, session: RoleSession): asserts value is Proposal {
    proposal(value);
    if (value.type === 'board') {
      check(!this.allBoards(roleId, session).some(item => item.id === value.boardId), '看板标识已存在');
      check(!RESERVED_BOARD_IDS.has(value.boardId), '看板标识被固定入口占用');
      check(session.boards.length < LIMIT.boards, '新增看板数量达到上限');
      check(value.board!.rows.every(row => this.allSources(roleId, session).some(item => item.id === row.sourceId)), '新增看板资料引用不存在');
    } else {
      check(this.allBoards(roleId, session).some(item => item.id === value.boardId), '当前岗位操作看板不存在');
      if (value.rowId) this.findRow(roleId, value.boardId, value.rowId, session);
    }
  }
  private validateSession(roleId: string, value: unknown): asserts value is RoleSession {
    object(value, ['draft', 'agentOpen', 'messages', 'boards', 'sources', 'edits', 'proposal', 'settings', 'reports'], '岗位会话');
    text(value.draft, '草稿'); check(typeof value.agentOpen === 'boolean', 'Agent开关');
    list(value.boards, '新增看板', LIMIT.boards); value.boards.forEach(item => { board(item); check(!RESERVED_BOARD_IDS.has(item.id), '看板标识被固定入口占用'); });
    list(value.sources, '新增资料', LIMIT.sources); value.sources.forEach(source);
    const candidate = value as unknown as RoleSession;
    const boards = this.allBoards(roleId, candidate); const sources = this.allSources(roleId, candidate);
    uniqueIds(boards, '看板'); uniqueIds(sources, '资料');
    for (const item of boards) check(item.rows.every(row => sources.some(raw => raw.id === row.sourceId)), '记录资料引用不存在');
    object(value.edits, Object.keys(value.edits ?? {}), '修订');
    check(Object.keys(value.edits).length <= LIMIT.boards * LIMIT.rows, '修订记录数量');
    for (const [key, entry] of Object.entries(value.edits)) {
      const parts = key.split('/'); check(parts.length === 2, '修订目标'); id(parts[0], '修订看板'); id(parts[1], '修订记录');
      const { selected, row } = this.findRow(roleId, parts[0], parts[1], candidate);
      object(entry, ['cells', 'history'], '修订'); texts(entry.cells, '修订单元格', LIMIT.columns); check(entry.cells.length === selected.columns.length, '修订列数');
      list(entry.history, '修订历史', LIMIT.history); check(entry.history.length >= 2, '修订历史缺少原始记录');
      entry.history.forEach((history, i) => { object(history, ['revision', 'cells', 'reason', 'at'], '历史'); check(history.revision === i + 1, '历史版本顺序'); texts(history.cells, '历史单元格', LIMIT.columns); check(history.cells.length === selected.columns.length, '历史列数'); text(history.reason, '修订原因', 2_000, false); text(history.at, '修订时间', 100, false); });
      check(JSON.stringify((entry.history[0] as RowRevision).cells) === JSON.stringify(row.cells), '初始记录历史被改变');
      check(JSON.stringify((entry.history.at(-1) as RowRevision).cells) === JSON.stringify(entry.cells), '当前记录与历史不一致');
    }
    list(value.messages, '会话', LIMIT.messages); value.messages.forEach(message => {
      object(message, ['id', 'who', 'text', 'at', 'links'], '消息'); id(message.id, '消息'); check(message.who === 'user' || message.who === 'agent', '消息角色'); text(message.text, '消息正文', LIMIT.text, false); text(message.at, '消息时间', 100, false);
      if (message.links !== undefined) { list(message.links, '消息引用', 16); message.links.forEach(link => this.validateLink(roleId, link, candidate)); }
    }); uniqueIds(value.messages as ChatMessage[], '消息');
    if (value.proposal !== null) this.validateProposal(roleId, value.proposal, candidate);
    settings(value.settings);
    list(value.reports, '报告', LIMIT.reports); value.reports.forEach(report => { object(report, ['id', 'title', 'body', 'boardId', 'at'], '报告'); id(report.id, '报告'); text(report.title, '报告标题', 256, false); text(report.body, '报告正文'); id(report.boardId, '报告看板'); text(report.at, '报告时间', 100, false); check(boards.some(item => item.id === report.boardId), '报告看板不存在'); }); uniqueIds(value.reports as DemoReport[], '报告');
  }
  private mutate(roleId: string, change: (session: RoleSession) => void) {
    const next = clone(this.current(roleId)); change(next); this.validateSession(roleId, next);
    const envelope = { version: 1, roles: Object.fromEntries([...this.sessions.entries()].map(([id, session]) => [id, id === roleId ? next : session])) };
    const raw = JSON.stringify(envelope); check(raw.length <= LIMIT.raw, '演示存储总量超过上限，请缩短内容');
    this.sessions.set(roleId, next);
    if (!this.storage) { this.warning ??= '浏览器存储不可用，当前演示仅保存在内存，刷新将丢失。'; return; }
    try { this.storage.setItem(SHOWCASE_STORAGE_KEY, raw); this.warning = null; }
    catch { this.warning = '浏览器存储空间不足或拒绝保存，本次修改仅保存在内存，刷新将丢失。'; }
  }

  session(roleId: string): RoleSession { return clone(this.current(roleId)); }
  getBoards(roleId: string): Board[] {
    const session = this.current(roleId); return this.allBoards(roleId).map(item => ({ ...clone(item), rows: item.rows.map(row => ({ ...clone(row), cells: clone(session.edits[`${item.id}/${row.id}`]?.cells ?? row.cells) })) }));
  }
  getSources(roleId: string): Source[] { return clone(this.allSources(roleId)); }
  getRow(roleId: string, boardId: string, rowId: string): StoreRow {
    const { row } = this.findRow(roleId, boardId, rowId); const edit = this.current(roleId).edits[`${boardId}/${rowId}`];
    return { ...clone(row), cells: clone(edit?.cells ?? row.cells), revision: edit?.history.length ?? 1, history: clone(edit?.history ?? [initialHistory(row.cells)]) };
  }
  updateRow(roleId: string, boardId: string, rowId: string, cells: string[], reason: string): StoreRow {
    const existing = this.getRow(roleId, boardId, rowId); text(reason, '修订原因', 2_000, false); texts(cells, '修订单元格', LIMIT.columns);
    this.mutate(roleId, session => { session.edits[`${boardId}/${rowId}`] = { cells: clone(cells), history: [...existing.history, { revision: existing.revision + 1, cells: clone(cells), reason, at: now() }] }; });
    return this.getRow(roleId, boardId, rowId);
  }
  setDraft(roleId: string, draft: string) { text(draft, '草稿'); this.mutate(roleId, session => { session.draft = draft; }); }
  setAgentOpen(roleId: string, agentOpen: boolean) { check(typeof agentOpen === 'boolean', 'Agent开关'); this.mutate(roleId, session => { session.agentOpen = agentOpen; }); }
  addMessage(roleId: string, who: ChatMessage['who'], messageText: string, links?: ChatLink[]): ChatMessage {
    const message: ChatMessage = { id: newId('message'), who, text: messageText, at: now(), ...(links === undefined ? {} : { links: clone(links) }) };
    this.mutate(roleId, session => { session.messages.push(message); }); return clone(message);
  }
  propose(roleId: string, value: Proposal) { this.mutate(roleId, session => { session.proposal = clone(value); }); }
  confirmProposal(roleId: string): Proposal {
    const value = this.current(roleId).proposal; check(value, '没有待确认提案'); const confirmed = clone(value);
    this.mutate(roleId, session => { this.validateProposal(roleId, confirmed, session); if (confirmed.type === 'board') session.boards.push(clone(confirmed.board!)); session.proposal = null; }); return confirmed;
  }
  appendSource(roleId: string, value: Source): Source { this.mutate(roleId, session => { session.sources.push(clone(value)); }); return clone(value); }
  saveReport(roleId: string, title: string, body: string, boardId: string): DemoReport {
    const report: DemoReport = { id: newId('report'), title, body, boardId, at: now() }; this.mutate(roleId, session => { session.reports.push(report); }); return clone(report);
  }
  updateSettings(roleId: string, partial: Partial<RoleSettings>) {
    object(partial, ['company', 'scope', 'tone', 'ruleNotes', 'developerMode'], '设置更新'); this.mutate(roleId, session => { session.settings = { ...session.settings, ...clone(partial) }; });
  }
}
