import { EmployeeController } from "./controller";
import { formatMoney, parseMoney, type EmployeeSnapshot, type EmployeeRecord, type EmployeeField, type EmployeeReport, type EmployeePageProposal } from "./domain";
import { renderEmployeePage } from "./page-renderer";
import type { VoicePort } from "./voice";

export interface EmployeeAgentPort {
  modeLabel: string;
  available: boolean;
  status: string;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; sourceIds: string[]; reportIds?: string[]; pageId?: string; pageProposal?: EmployeePageProposal }>;
  busy: boolean;
  subscribe(fn: () => void): () => void;
  send(text: string, options?: { purpose: "page" }): Promise<void>;
  confirmPage(messageId: string): Promise<{ id: string }>;
  cancel(): Promise<void>;
  saveLatestReport(): Promise<void>;
}
export interface EmployeeViewOptions {
  controller: EmployeeController;
  agent: EmployeeAgentPort;
  version: string;
  appId: string;
  changelogText?: string;
  voice?: VoicePort;
  onNavigate?(nav: { key: string; label: string } | null): void;
  openLink?(url: string): Promise<void> | void;
}
type Detail = { kind: "source"; id: string; source?: Awaited<ReturnType<EmployeeController["getSource"]>> } | { kind: "record"; id?: string; history?: EmployeeRecord[] } | { kind: "report"; id: string } | { kind: "changelog" } | { kind: "about" };
export const ADD_PAGE_DRAFT = "我想要查看侧边栏增加一个……，我的要求是：";
const esc = (value: unknown) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const PATHS: Record<string, string> = {
  board: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18M3 15h18"/>',
  report: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 17v-4M12 17v-6M16 17v-2"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3 .5-1h5l.5 1 1 2 2 .5 2-.5 2 4-1 2v2l1 2-2 4-2-.5-2 .5-1 2-.5 1h-5l-.5-1-1-2-2-.5-2 .5-2-4 1-2v-2l-1-2 2-4 2 .5L8 5Z"/>',
  agent: '<rect x="4" y="6" width="16" height="14" rx="3"/><path d="M12 2v4M8 12h.01M16 12h.01M8 16h8M2 10v6M22 10v6"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="m18 6-12 12M6 6l12 12"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4"/>',
  link: '<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  spinner: '<path d="M20 12a8 8 0 1 1-5-7"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  back: '<path d="m12 5-7 7 7 7M5 12h14"/>',
  triangle: '<path d="m12 3 9 17H3Z"/><path d="m12 10 5 10M12 10 7 20"/>',
};
const icon = (name: string, extra = "") => `<svg class="ae-icon ${extra}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? PATHS.file}</svg>`;
const button = (text: string, action: string, extra = "", glyph?: string) => `<button type="button" class="ae-btn ${extra}" data-action="${action}">${glyph ? icon(glyph) : ""}${esc(text)}</button>`;
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.valueOf()) ? value : d.toLocaleString("zh-CN", { hour12: false }); };
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function mountEmployee(root: HTMLElement, options: EmployeeViewOptions) {
  const { controller, agent, voice } = options;
  let state = controller.snapshot(), page = "overview", detail: Detail | null = null;
  let agentOpen = false, chatDraft = "", pagePurpose = false, agentError = "";
  let textDraft = { name: "", text: "", format: "csv" }, filter = "";
  let feedback = "", feedbackError = false, working = "", stopped = false;
  let detailRequest = 0, voiceEpoch = 0, pageCleanup: (() => void) | undefined;
  const frame = document.createElement("div"); frame.className = "ae-frame";
  const workspace = document.createElement("div"); workspace.className = "ae-workspace";
  const sidebar = document.createElement("aside"); sidebar.className = "ae-sidebar";
  const body = document.createElement("main"); body.className = "ae-main-body";
  const content = document.createElement("section"); content.className = "ae-content";
  const agentPanel = document.createElement("aside"); agentPanel.className = "ae-agent-panel";
  agentPanel.id = "ae-agent-panel"; agentPanel.setAttribute("role", "region"); agentPanel.setAttribute("aria-labelledby", "ae-agent-title"); agentPanel.hidden = true;
  body.append(content); workspace.append(sidebar, body, agentPanel); frame.append(workspace); root.replaceChildren(frame);

  const fields = () => state.profile.fields;
  const selectedId = () => detail && "id" in detail ? detail.id : undefined;
  const recordById = (id?: string) => state.records.find(r => r.id === id);
  const reportById = (id: string) => state.reports.find(r => r.id === id);
  const value = (record: EmployeeRecord, field: EmployeeField) => field.type === "money" && typeof record.values[field.key] === "number" ? formatMoney(record.values[field.key] as number, state.company.currency) : field.type === "boolean" ? record.values[field.key] === true ? "是" : "否" : String(record.values[field.key] ?? "—");
  const sourceLink = (id?: string) => id ? `<button type="button" class="ae-chat-source" data-source="${esc(id)}">${icon("link")} ${esc(state.sources.find(s => s.id === id)?.name ?? "查看来源")}</button>` : '<span class="ae-note">手工添加</span>';
  const empty = (title: string, description = "", glyph = "file") => `<div class="ae-empty">${icon(glyph, "ae-icon--lg")}<h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ""}</div>`;
  const intro = (title: string, description = "", actions = "") => `<div class="ae-section-intro"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ""}</div><div class="ae-actions">${actions}</div></div>`;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
  const showError = (error: unknown) => { feedback = errorMessage(error); feedbackError = true; render(); };
  const voiceActive = () => !!voice && ["preparing", "waiting_permission", "listening", "processing", "cancelling"].includes(voice.phase);
  const voiceText = () => !voice?.available ? "语音需要在应用中连接 Voice" : ({ idle: "语音输入", preparing: "正在准备语音", waiting_permission: "等待麦克风许可", listening: "正在录音", processing: "正在识别", cancelling: "正在取消", completed: "语音已转为文字", cancelled: "录音已取消", failed: "语音失败", timed_out: "语音超时" } as Record<string, string>)[voice.phase];

  function table(rows: EmployeeRecord[], columnKeys?: string[]) {
    const columns = columnKeys?.length ? columnKeys.map(key => fields().find(f => f.key === key)).filter((f): f is EmployeeField => !!f) : fields();
    const list = rows.filter(r => !filter || Object.values(r.values).some(v => String(v ?? "").toLowerCase().includes(filter.toLowerCase())));
    return `<section class="ae-panel"><div class="ae-toolbar"><label>搜索记录<input data-filter type="search" value="${esc(filter)}" placeholder="搜索记录" aria-label="搜索标准记录" /></label><span class="ae-note">${list.length} 条</span>${button("添加记录", "add-record", "", "plus")}</div>${list.length ? `<div class="ae-table-scroll" tabindex="0" aria-label="记录表，可横向滚动"><table class="ae-table"><caption>${esc(state.profile.name)}记录</caption><thead><tr>${columns.map(f => `<th scope="col">${esc(f.label)}</th>`).join("")}<th scope="col">来源</th><th scope="col">操作</th></tr></thead><tbody>${list.map(r => `<tr>${columns.map((f, i) => `<td class="${i === 0 ? "ae-cell-title" : ""} ${f.type === "money" || f.type === "number" ? "ae-number" : ""}">${esc(value(r, f))}</td>`).join("")}<td>${sourceLink(r.sourceId)}<small class="ae-note"> v${r.revision}</small></td><td><div class="ae-cell-actions">${button("编辑", `edit:${r.id}`, "ae-btn--compact")}${button(r.archived ? "恢复" : "归档", `${r.archived ? "restore" : "archive"}:${r.id}`, "ae-btn--compact")}</div></td></tr>`).join("")}</tbody></table></div>` : empty("暂无记录", "请从左下方上传资料，或添加一条记录。", "table")}</section>`;
  }
  function reportCard(r: EmployeeReport) {
    return `<article class="ae-report-card"><span class="ae-chip ${r.kind === "demo" ? "ae-chip--neutral" : ""}">${r.kind === "demo" ? "演示分析" : r.kind === "agent" ? "Agent 分析" : "手工报表"}</span><h3>${esc(r.title)}</h3><p>${esc(date(r.createdAt))}<br />${r.recordIds.length} 条记录 · 数据版本 ${r.dataRevision}</p><div class="ae-actions">${button("查看报表", `report:${r.id}`)}${button("下载", `download-report:${r.id}`, "", "download")}</div></article>`;
  }
  function sources() {
    return `${intro("资料上传", "支持 CSV、JSON、文本，以及需要保留原件的 PDF、图片和办公文档。每份资料最多 128 KiB。", button("导入文件", "choose-file", "ae-btn--primary", "upload"))}<div class="ae-import-grid"><section class="ae-import-card"><h3>${icon("upload")}上传文件</h3><label>选择文件<input type="file" data-file aria-label="选择原始资料文件" /></label><p class="ae-note">已使用 ${bytes(state.storage.usedBytes)} / ${bytes(state.storage.budgetBytes)}</p><div class="ae-form-actions">${button("下载 CSV 字段模板", "download-csv-template", "", "download")}</div></section><section class="ae-import-card"><h3>${icon("file")}粘贴资料</h3><form data-form="text" class="ae-inline-form"><label>资料名称<input name="name" placeholder="填写资料名称" value="${esc(textDraft.name)}" required maxlength="160" /></label><label>资料格式<span class="ae-select-wrap"><select name="format" aria-label="文本资料格式"><option value="csv" ${textDraft.format === "csv" ? "selected" : ""}>CSV 表格</option><option value="json" ${textDraft.format === "json" ? "selected" : ""}>JSON 记录</option><option value="txt" ${textDraft.format === "txt" ? "selected" : ""}>纯文本（暂不结构化）</option></select>${icon("chevron")}</span></label><label>原始内容<textarea name="text" placeholder="粘贴与所选格式一致的内容" required>${esc(textDraft.text)}</textarea></label><div class="ae-actions">${button("保存文本资料", "append-text")}</div></form></section></div><section class="ae-panel"><div class="ae-panel-head"><div><h3>已上传资料</h3><p>${state.sources.length} 份</p></div>${button("整理待处理资料", "process-all", "", "table")}</div>${state.sources.length ? `<div class="ae-table-scroll"><table class="ae-table"><caption>已上传资料</caption><thead><tr><th scope="col">名称</th><th scope="col">导入时间</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>${state.sources.slice().reverse().map(s => `<tr><td class="ae-cell-title"><strong>${esc(s.name)}</strong><small>${esc(s.mimeType)} · ${bytes(s.byteLength)}</small></td><td>${esc(date(s.importedAt))}</td><td><span class="ae-chip ${s.status === "processed" ? "ae-chip--success" : "ae-chip--warning"}">${s.status === "processed" ? "已整理" : "待整理"}</span></td><td><div class="ae-cell-actions">${button("查看原件", `source:${s.id}`, "ae-btn--compact")}${s.status === "pending" ? button("整理", `process:${s.id}`, "ae-btn--compact") : ""}</div></td></tr>`).join("")}</tbody></table></div>` : empty("尚未上传资料")}</section>`;
  }
  function setting(title: string, description: string, control: string, feedbackText?: string) {
    return `<div class="ae-setting"><div class="ae-setting-line"><div class="ae-setting-copy"><span class="ae-setting-title">${esc(title)}</span><span class="ae-setting-description">${esc(description)}</span></div><div class="ae-setting-control">${control}</div></div>${feedbackText ? `<div class="ae-setting-feedback">${esc(feedbackText)}</div>` : ""}</div>`;
  }
  function companyInput(name: keyof EmployeeSnapshot["company"], label: string) { return `<input name="${name}" value="${esc(state.company[name])}" aria-label="${esc(label)}" ${name === "goals" || name === "policies" ? "" : "required"} />`; }
  function settings() {
    const company = [["name", "公司名称", "用于报告抬头。"], ["jurisdiction", "适用地区", "公司经营地区。"], ["currency", "展示币种", "例如 CNY 或 USD。"], ["reportingPeriod", "报告周期", "当前报告覆盖的时间范围。"], ["goals", "公司目标", "Agent 分析需要考虑的目标。"], ["policies", "公司规则", "审批要求与内部制度。"]] as const;
    return `${intro("设置", "", button("保存公司设置", "save-company", "ae-btn--primary"))}<div class="ae-settings"><section class="ae-settings-section"><h3>公司与工作要求</h3><form class="ae-panel" data-form="company">${company.map(([key, label, description]) => setting(label, description, companyInput(key, label))).join("")}</form></section><section class="ae-settings-section"><h3>运行方式</h3><div class="ae-panel">${setting("资料保存", "保留原件与记录修订。", '<span class="ae-chip ae-chip--neutral">本地数据</span>', `已使用 ${bytes(state.storage.usedBytes)} / ${bytes(state.storage.budgetBytes)}。`)}${setting("自动获取资料", "邮箱与定时采集需要连接相应服务。", '<span class="ae-chip ae-chip--neutral">尚未连接</span>')}${setting("Agent", "", `<span class="ae-chip">${esc(agent.modeLabel)}</span>`)}${setting("语音", "由 Voice 服务提供录音与识别。", `<span class="ae-chip ae-chip--neutral">${voice?.available ? "可调用 Voice" : "仅应用可用"}</span>`, voice?.error)}</div></section><section class="ae-settings-section"><h3>开发模式</h3><div class="ae-panel"><div class="ae-setting"><div class="ae-setting-line"><div class="ae-setting-copy"><span class="ae-setting-title">${state.developerUnlocked ? "开发模式已解锁" : "岗位配置"}</span><span class="ae-setting-description">提示词、Skill、SOP 和页面默认配置。开发密码不替代平台权限。</span></div>${state.developerUnlocked ? button("锁定", "lock", "", "lock") : '<span class="ae-chip ae-chip--neutral">已锁定</span>'}</div>${state.developerUnlocked ? `<div class="ae-developer-unlocked"><label>岗位<span class="ae-select-wrap"><select data-role aria-label="选择岗位">${state.availableProfiles.map(p => `<option value="${esc(p.id)}" ${state.profile.id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>${icon("chevron")}</span></label><details class="ae-developer-details" open><summary>岗位配置 JSON</summary><label>岗位配置<textarea data-profile-json class="ae-developer-json" spellcheck="false" aria-label="岗位配置 JSON">${esc(controller.exportProfile())}</textarea></label><div class="ae-actions">${button("应用配置", "save-profile")}${button("下载配置", "export-profile", "", "download")}</div></details></div>` : `<form data-form="password" class="ae-developer-unlocked"><label>${state.passwordConfigured ? "开发者密码" : "设置开发者密码"}<input name="password" type="password" autocomplete="${state.passwordConfigured ? "current-password" : "new-password"}" minlength="8" required aria-describedby="ae-password-help" /></label>${!state.passwordConfigured ? '<label>确认开发者密码<input name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></label>' : ""}<p id="ae-password-help" class="ae-note">${state.passwordConfigured ? "输入密码以解锁。" : "至少 8 位字符。密码不以明文保存。"}</p><div class="ae-actions">${button(state.passwordConfigured ? "解锁开发模式" : "设置密码并解锁", "unlock", "", "lock")}</div></form>`}</div></div></section><section class="ae-settings-section"><h3>操作记录</h3><div class="ae-panel"><div class="ae-setting"><p class="ae-note">${state.audit.length} 条操作 · 数据版本 ${state.revision}</p><details class="ae-developer-details"><summary>最近操作</summary><div class="ae-list">${state.audit.slice(-10).reverse().map(a => `<div class="ae-list-item"><div><strong>${esc(a.action)}</strong><p>${esc(a.detail)}</p></div>${recordById(a.entityId) ? button("查看记录", `edit:${a.entityId}`, "ae-btn--compact") : `<small>v${a.revision}</small>`}</div>`).join("") || '<p class="ae-note">暂无操作。</p>'}</div></details></div></div></section><footer class="ae-settings-footer"><button type="button" data-action="version" aria-label="查看版本 ${esc(options.version)} 的更新日志">版本 ${esc(options.version)}</button><button type="button" data-action="about" aria-label="关于 ${esc(state.profile.name)}">关于插件</button></footer></div>`;
  }
  function fieldInput(field: EmployeeField, record?: EmployeeRecord) {
    const v = record?.values[field.key], required = field.required ? "required" : "", name = `field:${field.key}`;
    if (field.type === "boolean") return `<label><span>${esc(field.label)}</span><input type="checkbox" name="${esc(name)}" ${v === true ? "checked" : ""} /></label>`;
    if (field.type === "select") return `<label>${esc(field.label)}${field.required ? " *" : ""}<span class="ae-select-wrap"><select name="${esc(name)}" ${required}><option value="">请选择</option>${(field.options ?? []).map(o => `<option value="${esc(o)}" ${v === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>${icon("chevron")}</span></label>`;
    return `<label>${esc(field.label)}${field.type === "money" ? `（${esc(state.company.currency)}）` : ""}${field.required ? " *" : ""}<input name="${esc(name)}" type="${field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}" ${field.type === "money" ? 'inputmode="decimal"' : field.type === "number" ? 'step="any"' : ""} value="${esc(field.type === "money" && typeof v === "number" ? (v / 100).toFixed(2) : v ?? "")}" ${required} /></label>`;
  }
  function detailMarkup() {
    if (!detail) return "";
    const back = button("返回", "back", "", "back");
    if (detail.kind === "source") {
      const s = detail.source;
      return `${intro("原始资料", "", back)}${s ? `<section class="ae-panel ae-detail-panel"><dl class="ae-source-meta"><div><dt>名称</dt><dd>${esc(s.name)}</dd></div><div><dt>类型与大小</dt><dd>${esc(s.mimeType)} · ${bytes(s.byteLength)}</dd></div><div><dt>导入时间</dt><dd>${esc(date(s.importedAt))}</dd></div><div><dt>SHA-256</dt><dd>${esc(s.sha256)}</dd></div></dl><h3>原始内容</h3><pre class="ae-source-content">${esc(s.text || "此文件为二进制原件。可下载原件检查内容；Demo 暂不执行 OCR。")}</pre><div class="ae-form-actions">${button("下载原件", "download-source", "", "download")}${s.status === "pending" ? button("整理为标准记录", `process:${s.id}`) : ""}</div><h3 class="ae-detail-subtitle">关联记录</h3><div class="ae-list">${state.records.filter(r => r.sourceId === s.id).map(r => `<div class="ae-list-item"><div><strong>${esc(fields().map(f => value(r, f)).slice(0, 3).join(" · "))}</strong><p>修订 v${r.revision} · ${r.archived ? "已归档" : "可用"}</p></div>${button("查看记录", `edit:${r.id}`, "ae-btn--compact")}</div>`).join("") || '<p class="ae-note">尚无关联记录。</p>'}</div></section>` : '<div class="ae-feedback" role="status">正在读取原件…</div>'}`;
    }
    if (detail.kind === "record") {
      const r = recordById(detail.id);
      return `${intro(r ? "编辑记录" : "添加记录", "", back)}<section class="ae-panel ae-detail-panel"><form data-form="record"><div class="ae-form-grid">${fields().map(f => fieldInput(f, r)).join("")}</div>${r ? `<div class="ae-form-actions">${sourceLink(r.sourceId)}<span class="ae-note">修订 v${r.revision}${r.archived ? " · 已归档" : ""}</span></div>` : ""}<div class="ae-form-actions">${button("保存记录", "save-record", "ae-btn--primary")}${r ? button(r.archived ? "恢复记录" : "归档记录", `${r.archived ? "restore" : "archive"}:${r.id}`) : ""}</div></form>${detail.history?.length ? `<details class="ae-developer-details"><summary>修订记录</summary><div class="ae-list">${detail.history.slice().reverse().map(h => `<div class="ae-list-item"><div><strong>v${h.revision} · ${h.archived ? "已归档" : "可用"}</strong><p>${esc(date(h.updatedAt))}</p></div></div>`).join("")}</div></details>` : ""}</section>`;
    }
    if (detail.kind === "report") {
      const r = reportById(detail.id);
      return `${intro(r?.title ?? "报表详情", "", back)}${r ? `<section class="ae-panel ae-detail-panel"><span class="ae-chip">${r.kind === "demo" ? "演示分析" : "分析产出"}</span><p class="ae-note">${esc(date(r.createdAt))} · 数据版本 ${r.dataRevision}</p><pre class="ae-source-content">${esc(r.body)}</pre><div class="ae-chat-sources">${r.sourceIds.map(sourceLink).join("")}</div><div class="ae-form-actions">${button("下载报表", `download-report:${r.id}`, "", "download")}</div></section>` : empty("报表不存在")}`;
    }
    if (detail.kind === "changelog") return `${intro(`版本 ${options.version} 更新日志`, "", back)}<section class="ae-panel ae-detail-panel"><pre class="ae-source-content">${esc(options.changelogText ?? `当前版本 ${options.version}，更新日志尚未提供。`)}</pre><p class="ae-note">本地 Demo 候选，尚未公开发布。</p></section>`;
    return `${intro("关于插件", "", back)}<section class="ae-panel ae-detail-panel"><dl class="ae-source-meta"><div><dt>插件</dt><dd>${esc(state.profile.name)}</dd></div><div><dt>版本</dt><dd>${esc(options.version)} · 本地 Demo 候选</dd></div><div><dt>应用标识</dt><dd>${esc(options.appId)}</dd></div></dl><label>公开应用详情地址<input readonly value="${esc(`https://open.reai.com/apps/${encodeURIComponent(options.appId)}`)}" aria-label="公开应用详情地址" /></label><p class="ae-note">本候选尚未公开发布。</p></section>`;
  }
  function render() {
    if (stopped) return;
    pageCleanup?.(); pageCleanup = undefined;
    if (!["overview", "settings", "sources"].includes(page) && !state.pages.some(p => p.id === page)) { page = "overview"; detail = null; }
    sidebar.innerHTML = `<div class="ae-brand"><span class="ae-brand-mark ae-brand-logo" title="${esc(state.profile.ui.logoText)}">${esc(state.profile.ui.logoText)}</span><strong>${esc(state.profile.name)}</strong></div><nav class="ae-navigation" aria-label="工作看板"><button type="button" data-page="overview" ${page === "overview" ? 'aria-current="page"' : ""}>${icon("board")}总体看板</button><div class="ae-nav-divider"></div>${state.pages.map(p => `<button type="button" data-page="${esc(p.id)}" ${page === p.id ? 'aria-current="page"' : ""}>${icon("table")}${esc(p.title)}</button>`).join("")}<button type="button" data-action="add-page" class="ae-add-page" aria-label="添加工作看板">${icon("plus")}</button></nav><nav class="ae-navigation ae-navigation-foot" aria-label="插件工具"><button type="button" data-action="agent" aria-controls="ae-agent-panel" aria-expanded="${agentOpen}">${icon("agent")}Agent</button><button type="button" data-page="settings" ${page === "settings" ? 'aria-current="page"' : ""}>${icon("settings")}设置</button><button type="button" data-page="sources" ${page === "sources" ? 'aria-current="page"' : ""}>${icon("upload")}资料上传</button></nav>`;
    const htmlPage = page === "overview" ? state.dashboard : state.pages.find(p => p.id === page);
    content.innerHTML = `${feedback || working ? `<div id="ae-form-feedback" class="ae-feedback ${feedbackError ? "ae-feedback--error" : working ? "" : "ae-feedback--success"}" role="${feedbackError ? "alert" : "status"}" aria-live="polite">${icon(working ? "spinner" : feedbackError ? "file" : "check", working ? "ae-spinner" : "")}<span>${esc(working || feedback)}</span></div>` : ""}${detail ? detailMarkup() : page === "settings" ? settings() : page === "sources" ? sources() : `<div class="ae-board-surface" data-html-page></div>`}`;
    const target = content.querySelector<HTMLElement>("[data-html-page]");
    if (target && htmlPage) { try { pageCleanup = renderEmployeePage(target, htmlPage, state, { records(container, rows, columns) { container.innerHTML = table(rows, columns); }, reports(container, reports) { container.innerHTML = reports.length ? `<div class="ae-report-grid">${reports.slice().reverse().map(reportCard).join("")}</div>` : empty("暂无报表", "向 Agent 安排任务，然后保存分析。", "report"); } }); } catch (e) { target.textContent = errorMessage(e); } }
    if (working) content.querySelectorAll<HTMLButtonElement>("[data-action]").forEach(b => { b.disabled = !["back", "agent"].includes(b.dataset.action ?? ""); });
    content.setAttribute("aria-label", detail ? "资料详情" : page === "overview" ? "总体看板" : page === "sources" ? "资料上传" : page === "settings" ? "设置" : htmlPage?.title ?? "工作看板");
    options.onNavigate?.(page === "overview" && !detail ? null : { key: detail ? `${detail.kind}:${selectedId() ?? ""}` : page, label: detail ? detail.kind === "source" ? "原始资料" : detail.kind === "record" ? "记录" : detail.kind === "report" ? "报表" : detail.kind === "about" ? "关于插件" : "更新日志" : page === "sources" ? "资料上传" : page === "settings" ? "设置" : htmlPage?.title ?? "工作看板" });
    renderAgent();
  }
  function preserveDraft() { const input = agentPanel.querySelector<HTMLTextAreaElement>("[data-chat-input]"); if (input) chatDraft = input.value; }
  function renderAgent() {
    if (stopped) return;
    frame.classList.toggle("ae-agent-open", agentOpen); agentPanel.hidden = !agentOpen;
    if (!agentOpen) return;
    const focused = agentPanel.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedName = focused?.getAttribute("name");
    const voiceError = voice?.available ? voice.error : undefined;
    agentPanel.innerHTML = `<header class="ae-agent-head"><span class="ae-brand-mark">${icon("agent")}</span><div><h2 id="ae-agent-title">${esc(state.profile.jobTitle)}</h2><p>${esc(agent.modeLabel)}</p></div><button type="button" class="ae-icon-button" data-action="close-agent" aria-label="关闭 Agent">${icon("x")}</button></header><div class="ae-chat"><div class="ae-chat-messages" data-messages>${agent.messages.map(m => `<article class="ae-chat-message ${m.role === "user" ? "ae-chat-message--user" : ""}"><strong>${m.role === "user" ? "你" : "Agent"}</strong><div class="ae-chat-text" data-message-id="${esc(m.id)}"></div>${m.sourceIds.length ? `<div class="ae-chat-cards">${m.sourceIds.map(id => `<button type="button" class="ae-chat-card" data-source="${esc(id)}">${icon("file")}<span><strong>${esc(state.sources.find(s => s.id === id)?.name ?? "原始资料")}</strong><small>查看原件</small></span></button>`).join("")}</div>` : ""}${m.reportIds?.length ? `<div class="ae-chat-cards">${m.reportIds.map(id => `<button type="button" class="ae-chat-card" data-action="report:${esc(id)}">${icon("report")}<span><strong>${esc(reportById(id)?.title ?? "分析报表")}</strong><small>查看报表</small></span></button>`).join("")}</div>` : ""}${m.pageProposal && !m.pageId ? `<div class="ae-page-proposal"><strong>${esc(m.pageProposal.definition.title)}</strong><p class="ae-note">${esc(agent.modeLabel)}</p>${button("添加到侧边栏", `confirm-page:${m.id}`)}</div>` : ""}${m.pageId ? `<button type="button" class="ae-chat-card" data-action="open-page:${esc(m.pageId)}">${icon("board")}<span><strong>${esc(state.pages.find(p => p.id === m.pageId)?.title ?? "工作看板")}</strong><small>打开看板</small></span></button>` : ""}</article>`).join("")}${agent.busy ? `<p class="ae-chat-status" role="status">${icon("spinner", "ae-spinner")}正在处理…</p>` : ""}</div>${agent.status !== "报表已保存" && !agent.busy && agent.messages.some(m => m.role === "assistant" && !m.pageProposal) ? button("保存最新分析为报表", "save-analysis", "ae-chat-save", "report") : ""}<p class="ae-chat-status" role="status">${esc(voiceActive() ? voiceText() : agent.status)}</p>${agentError || voiceError ? `<p class="ae-dialog-error" role="alert">${esc(agentError || voiceError)}</p>` : ""}<form data-form="chat" class="ae-chat-compose"><label>向 Agent 提问<textarea data-chat-input name="chat" placeholder="提问或安排工作" ${!agent.available || agent.busy ? "disabled" : ""} required></textarea></label><div class="ae-actions">${voiceActive() ? `<div class="ae-actions">${voice?.phase === "listening" ? button("结束录音", "finish-voice") : ""}${button("取消录音", "cancel-voice")}</div>` : `<button type="button" class="ae-icon-button" data-action="start-voice" aria-label="语音输入" title="${esc(voiceText())}" ${!voice?.available || agent.busy ? "disabled" : ""}>${icon("mic")}</button>`}${agent.busy ? button("停止", "cancel-agent") : button("发送", "send-agent", "ae-btn--primary")}</div></form></div>`;
    for (const m of agent.messages) { const node = Array.from(agentPanel.querySelectorAll<HTMLElement>("[data-message-id]")).find(n => n.dataset.messageId === m.id); if (node) node.textContent = m.text; }
    const textarea = agentPanel.querySelector<HTMLTextAreaElement>("[data-chat-input]"); if (textarea) textarea.value = chatDraft;
    agentPanel.querySelector<HTMLButtonElement>('[data-action="send-agent"]')?.toggleAttribute("disabled", !agent.available || voiceActive());
    agentPanel.querySelector<HTMLButtonElement>('[data-action="cancel-voice"]')?.toggleAttribute("disabled", voice?.phase === "cancelling");
    agentPanel.querySelectorAll<HTMLButtonElement>('[data-action^="confirm-page:"]').forEach(b => { b.disabled = !!working; });
    const messages = agentPanel.querySelector<HTMLElement>("[data-messages]"); if (messages) messages.scrollTop = messages.scrollHeight;
    if (focusedName === "chat") textarea?.focus();
  }
  function openAgent(prefill?: string) { if (prefill !== undefined) { chatDraft = prefill; pagePurpose = true; } agentOpen = true; renderAgent(); sidebar.querySelector('[data-action="agent"]')?.setAttribute("aria-expanded", "true"); agentPanel.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus(); }
  function closeAgent() { preserveDraft(); agentOpen = false; ++voiceEpoch; if (voiceActive()) void voice?.cancel().catch(e => { if (!stopped) { agentError = errorMessage(e); renderAgent(); } }); renderAgent(); sidebar.querySelector('[data-action="agent"]')?.setAttribute("aria-expanded", "false"); sidebar.querySelector<HTMLButtonElement>('[data-action="agent"]')?.focus(); }
  function navigate(next: string) { detail = null; ++detailRequest; page = next; filter = ""; feedback = ""; feedbackError = false; render(); body.scrollTop = 0; }
  function showDetail(next: Detail) { detail = next; ++detailRequest; feedback = ""; feedbackError = false; render(); body.scrollTop = 0; }
  async function openSource(id: string) { showDetail({ kind: "source", id }); const request = detailRequest; try { const source = await controller.getSource(id); if (request === detailRequest && detail?.kind === "source" && detail.id === id) { detail.source = source; render(); } } catch (e) { if (request === detailRequest) showError(e); } }
  async function openRecord(id?: string) { showDetail({ kind: "record", id }); const request = detailRequest; if (id) { try { const history = await controller.getRecordHistory(id); if (request === detailRequest && detail?.kind === "record" && detail.id === id) { detail.history = history; render(); } } catch (e) { if (request === detailRequest) showError(e); } } }
  async function perform(label: string, action: () => Promise<unknown>, success: string, closeDetail = false) {
    if (working) return;
    working = label; feedback = ""; feedbackError = false; render();
    try { await action(); working = ""; feedback = success; if (closeDetail) detail = null; state = controller.snapshot(); render(); }
    catch (e) { working = ""; feedback = errorMessage(e); feedbackError = true; render(); }
  }
  function download(name: string, value: string | Uint8Array, mimeType = "text/plain;charset=utf-8") { let part: string | ArrayBuffer = typeof value === "string" ? value : new ArrayBuffer(value.byteLength); if (value instanceof Uint8Array) new Uint8Array(part as ArrayBuffer).set(value); const url = URL.createObjectURL(new Blob([part], { type: mimeType })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  async function startVoice() { openAgent(); agentError = ""; if (!voice?.available) { agentError = voice?.error || "语音需要在应用中连接 Voice"; renderAgent(); return; } if (voiceActive()) return; const epoch = ++voiceEpoch; try { const result = await voice.start(); if (stopped || epoch !== voiceEpoch || !agentOpen) return; chatDraft = result.text; renderAgent(); agentPanel.querySelector<HTMLTextAreaElement>("[data-chat-input]")?.focus(); } catch (e) { if (!stopped && epoch === voiceEpoch) { agentError = errorMessage(e); renderAgent(); } } }
  async function act(action: string) {
    if (action === "agent") { openAgent(); return; }
    if (action === "add-page") { openAgent(ADD_PAGE_DRAFT); return; }
    if (action === "close-agent") { closeAgent(); return; }
    if (action === "back" || action === "close") { detail = null; ++detailRequest; render(); return; }
    if (action.startsWith("open-page:")) { navigate(action.slice(10)); return; }
    if (action.startsWith("confirm-page:")) { await perform("正在添加看板…", async () => { const saved = await agent.confirmPage(action.slice(13)); page = saved.id; detail = null; }, "看板已添加。"); return; }
    if (action === "choose-file") { content.querySelector<HTMLInputElement>("[data-file]")?.click(); return; }
    if (action === "download-csv-template") { download(`${state.profile.id}-fields.csv`, fields().map(f => `"${f.label.replaceAll('"', '""')}"`).join(",") + "\n", "text/csv;charset=utf-8"); return; }
    if (action.startsWith("source:")) { await openSource(action.slice(7)); return; }
    if (action.startsWith("report:")) { showDetail({ kind: "report", id: action.slice(7) }); return; }
    if (action === "add-record" || action.startsWith("edit:")) { await openRecord(action.startsWith("edit:") ? action.slice(5) : undefined); return; }
    if (action.startsWith("process:")) { const id = action.slice(8); await perform("正在整理资料…", async () => { const result = await controller.processSource(id); if (result.issues.length) throw new Error(`资料未生成标准记录。\n${result.issues.map(i => `第 ${i.row} 行 ${i.field}：${i.message}`).join("\n")}`); }, "整理完成。标准记录已关联原始资料。", true); return; }
    if (action === "process-all") { await perform("正在整理资料…", async () => { const pending = state.sources.filter(s => s.status === "pending"); if (!pending.length) throw new Error("没有待整理资料。"); let n = 0; for (const s of pending) { working = `正在整理 ${s.name}（${++n} / ${pending.length}）`; render(); const result = await controller.processSource(s.id); if (result.issues.length) throw new Error(`${s.name} 未整理成功。\n${result.issues.map(i => `第 ${i.row} 行 ${i.field}：${i.message}`).join("\n")}`); } }, "资料整理完成。"); return; }
    if (action.startsWith("archive:") || action.startsWith("restore:")) { const id = action.split(":")[1], r = recordById(id); if (r) { detail = { kind: "record", id }; await perform("正在保存记录状态…", () => action.startsWith("archive:") ? controller.archiveRecord(id, r.revision) : controller.restoreRecord(id, r.revision), action.startsWith("archive:") ? "记录已归档，原始资料继续保留。" : "记录已恢复。"); } return; }
    if (action === "append-text") { const form = content.querySelector<HTMLFormElement>('[data-form="text"]')!; if (!form.reportValidity()) return; const data = new FormData(form), rawName = String(data.get("name")).trim(), format = String(data.get("format")), text = String(data.get("text")); textDraft = { name: rawName, format, text }; const extension = /\.([a-z0-9]+)$/i.exec(rawName)?.[1]?.toLowerCase(); if (extension && extension !== format) throw new Error("资料名称的扩展名与所选格式不一致，请修改名称或资料格式。"); const name = extension ? rawName : `${rawName}.${format}`; await perform("正在保存文本…", async () => { await controller.appendText({ name, text }); textDraft = { name: "", text: "", format }; }, format === "txt" ? "纯文本资料已保存。当前 Demo 不自动结构化纯文本。" : "文本资料已保存，可以开始整理。"); return; }
    if (action === "save-company") { const form = content.querySelector<HTMLFormElement>('[data-form="company"]')!; if (!form.reportValidity()) return; const data = new FormData(form), patch = Object.fromEntries(Object.keys(state.company).map(key => [key, String(data.get(key) ?? "")])) as unknown as EmployeeSnapshot["company"]; await perform("正在保存设置…", () => controller.setCompanySettings(patch), "公司设置已保存。"); return; }
    if (action === "unlock") { const form = content.querySelector<HTMLFormElement>('[data-form="password"]')!; if (!form.reportValidity()) return; const data = new FormData(form), password = String(data.get("password")); if (!state.passwordConfigured && password !== String(data.get("confirmPassword"))) throw new Error("两次输入的开发者密码不一致，请重新输入。"); await perform("正在验证开发者密码…", async () => { if (!state.passwordConfigured) await controller.setupPassword(password); if (!await controller.unlock(password)) throw new Error("开发者密码不正确，请重新输入。"); }, "开发模式已解锁。"); return; }
    if (action === "lock") { controller.lock(); feedback = "开发模式已锁定。"; render(); return; }
    if (action === "save-profile") { const json = content.querySelector<HTMLTextAreaElement>("[data-profile-json]")?.value ?? ""; await perform("正在保存岗位配置…", () => controller.importProfile(json), "岗位配置已保存。"); return; }
    if (action === "export-profile") { download(`${state.profile.id}-profile.json`, controller.exportProfile(), "application/json"); return; }
    if (action === "save-record") { const form = content.querySelector<HTMLFormElement>('[data-form="record"]')!; if (!form.reportValidity()) return; const data = new FormData(form), values: EmployeeRecord["values"] = {}; for (const f of fields()) { const raw = String(data.get(`field:${f.key}`) ?? ""); values[f.key] = f.type === "boolean" ? data.has(`field:${f.key}`) : !raw ? null : f.type === "money" ? parseMoney(raw) : f.type === "number" ? Number(raw) : raw; } const r = recordById(selectedId()); await perform("正在保存记录…", () => r ? controller.editRecord(r.id, values, r.revision) : controller.addRecord(values), "标准记录已保存，来源保持不变。", true); return; }
    if (action === "send-agent") { preserveDraft(); const text = chatDraft.trim(); if (!text || !agent.available || agent.busy || voiceActive()) return; const purpose = pagePurpose; chatDraft = ""; pagePurpose = false; agentError = ""; renderAgent(); try { await agent.send(text, purpose ? { purpose: "page" } : undefined); } catch (e) { agentError = errorMessage(e); renderAgent(); } return; }
    if (action === "cancel-agent") { await agent.cancel(); return; }
    if (action === "save-analysis") { await perform("正在保存报表…", () => agent.saveLatestReport(), "分析已保存。"); return; }
    if (action === "start-voice") { await startVoice(); return; }
    if (action === "finish-voice") { try { await voice?.finish(); } catch (e) { agentError = errorMessage(e); renderAgent(); } return; }
    if (action === "cancel-voice") { ++voiceEpoch; try { await voice?.cancel(); } catch (e) { agentError = errorMessage(e); renderAgent(); } return; }
    if (action.startsWith("download-report:")) { const r = reportById(action.slice(16)); if (r) download(`${r.title}.txt`, `${r.title}\n生成时间：${date(r.createdAt)}\n数据版本：${r.dataRevision}\n\n${r.body}`); return; }
    if (action === "download-source" && detail?.kind === "source" && detail.source) { const s = detail.source; download(s.name, s.bytesBase64 ? Uint8Array.from(atob(s.bytesBase64), c => c.charCodeAt(0)) : s.text, s.mimeType); return; }
    if (action === "version" || action === "about") showDetail({ kind: action === "version" ? "changelog" : "about" });
  }
  const click = (event: MouseEvent) => { const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null; if (!target || target.disabled) return; if (target.dataset.page) { navigate(target.dataset.page); return; } if (target.dataset.source) { void openSource(target.dataset.source); return; } if (target.dataset.action) void act(target.dataset.action).catch(showError); };
  const change = (event: Event) => { const target = event.target; if (target instanceof HTMLSelectElement && target.name === "format") textDraft.format = target.value; else if (target instanceof HTMLInputElement && target.hasAttribute("data-file") && target.files?.[0]) { const file = target.files[0]; void perform(`正在导入 ${file.name}…`, () => controller.importFile(file), "原始文件已保存，可以开始整理。"); } else if (target instanceof HTMLSelectElement && target.hasAttribute("data-role")) { const id = target.value; page = "settings"; detail = null; void perform("正在切换岗位…", () => controller.switchProfile(id), "岗位已切换。"); } };
  const input = (event: Event) => { const target = event.target; if (target instanceof HTMLTextAreaElement && target.hasAttribute("data-chat-input")) { chatDraft = target.value; return; } if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.closest('[data-form="text"]')) { if (target.name === "name") textDraft.name = target.value; if (target.name === "text") textDraft.text = target.value; } if (target instanceof HTMLInputElement && target.hasAttribute("data-filter")) { const pos = target.selectionStart; filter = target.value; render(); const replacement = content.querySelector<HTMLInputElement>("[data-filter]"); replacement?.focus(); replacement?.setSelectionRange(pos, pos); } };
  const submit = (event: Event) => { const form = event.target instanceof HTMLFormElement ? event.target : null; if (!form?.dataset.form) return; event.preventDefault(); const action = ({ text: "append-text", company: "save-company", password: "unlock", record: "save-record", chat: "send-agent" } as Record<string, string>)[form.dataset.form]; if (action) void act(action).catch(showError); };
  const keydown = (event: KeyboardEvent) => { if (event.key === "Escape" && agentOpen && agentPanel.contains(event.target as Node)) { event.preventDefault(); closeAgent(); } };
  frame.addEventListener("click", click); frame.addEventListener("change", change); frame.addEventListener("input", input); frame.addEventListener("submit", submit); frame.addEventListener("keydown", keydown);
  const unsubscribe = controller.subscribe(next => { state = next; render(); });
  const unsubscribeAgent = agent.subscribe(renderAgent);
  const unsubscribeVoice = voice?.subscribe(renderAgent);
  render();
  return { showSettings() { navigate(page === "settings" ? "overview" : "settings"); }, backToRoot() { navigate("overview"); }, startVoice, dispose() { stopped = true; ++voiceEpoch; if (voiceActive()) void voice?.cancel().catch(() => undefined); pageCleanup?.(); unsubscribe(); unsubscribeAgent(); unsubscribeVoice?.(); frame.removeEventListener("click", click); frame.removeEventListener("change", change); frame.removeEventListener("input", input); frame.removeEventListener("submit", submit); frame.removeEventListener("keydown", keydown); root.replaceChildren(); } };
}
