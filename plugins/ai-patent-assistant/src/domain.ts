import { validatePageMarkup, validateScopedCss } from "./template";
export const LIMITS = Object.freeze({ sourceBytes: 128 * 1024, valueBytes: 256 * 1024, storageBytes: 24 * 1024 * 1024, sources: 200, records: 1000, reports: 100, profileBytes: 64 * 1024, skills: 8, skillCharacters: 32768, pageBytes: 32 * 1024, pageBindings: 16, bindingFilters: 8, profilePages: 12, customPagesPerProfile: 20, customPages: 100 });
export const MAX_MONEY_CENTS = Math.floor(Number.MAX_SAFE_INTEGER / LIMITS.records);
export type RecordValue = string | number | boolean | null;
export interface EmployeeField { key: string; label: string; type: "text" | "number" | "money" | "date" | "select" | "boolean"; required: boolean; aliases: string[]; options?: string[] }
export interface EmployeePageFilter { field: string; operator: "eq" | "contains" | "empty" | "gte" | "lte"; value?: RecordValue }
export interface EmployeePageBinding { id: string; kind: "count" | "sum" | "distinct" | "difference" | "records" | "reports"; field?: string; columns?: string[]; filters?: EmployeePageFilter[]; left?: string; right?: string }
export interface EmployeeHtmlPage { id: string; title: string; html: string; css: string; bindings: EmployeePageBinding[] }
export interface EmployeePageProposal { proposalId: string; profileId: string; profileVersion: string; definition: EmployeeHtmlPage }
export interface EmployeeSavedPage extends EmployeePageProposal { createdAt: string }
export type SavedPage = EmployeeSavedPage;
export interface EmployeeProfile { schemaVersion: 1; id: string; name: string; jobTitle: string; description: string; fields: EmployeeField[]; agent: { prompt: string; skills: { id: string; title: string; content: string }[]; sop: string; tools: string[] }; ui: { accentColor: string; logoText: string; css: string; html: string; dashboard?: EmployeeHtmlPage; pages?: EmployeeHtmlPage[] } }
export interface CompanySettings { name: string; jurisdiction: string; currency: string; goals: string; policies: string; reportingPeriod: string }
export interface SourceSummary { id: string; name: string; mimeType: string; byteLength: number; sha256: string; importedAt: string; status: "pending" | "processed" }
export interface RawSource extends SourceSummary { text: string; bytesBase64: string }
export interface EmployeeRecord { id: string; profileId: string; values: Record<string, RecordValue>; sourceId?: string; sourceRow?: number; revision: number; archived: boolean; createdAt: string; updatedAt: string }
export interface EmployeeReport { id: string; title: string; body: string; text: string; kind: "demo" | "agent" | "manual"; mode: string; profileId: string; sourceIds: string[]; recordIds: string[]; recordRefs: { id: string; revision: number }[]; dataRevision: number; createdAt: string }
export interface AuditEvent { id: string; action: string; entityId: string; revision: number; at: string; detail: string }
export interface CleaningIssue { row: number; field: string; message: string }
export interface StorageStats { usedBytes: number; budgetBytes: number; orphanCount: number; orphanBytes: number }
export interface EmployeeSnapshot { revision: number; profile: EmployeeProfile; profileVersion: string; dashboard: EmployeeHtmlPage; pages: EmployeeHtmlPage[]; availableProfiles: { id: string; name: string }[]; company: CompanySettings; sources: SourceSummary[]; records: EmployeeRecord[]; reports: EmployeeReport[]; audit: AuditEvent[]; passwordConfigured: boolean; developerUnlocked: boolean; storage: StorageStats }
export class EmployeeError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = "EmployeeError"; } }
export function reject(code: string, message: string): never { throw new EmployeeError(code, message); }
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const clone = <T>(value: T): T => structuredClone(value);
function object(input: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) reject("INVALID_CONFIGURATION", `${context}必须是普通对象`);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key))) reject("UNKNOWN_CONFIGURATION_FIELD", `${context}包含未声明字段`);
  return value;
}
function string(input: unknown, max: number, context: string, empty = false): string {
  if (typeof input !== "string" || input.length > max || (!empty && !input.trim()) || input.includes("\0")) reject("INVALID_CONFIGURATION", `${context}无效或超出长度限制`);
  return input;
}
const headerKey = (input: string) => input.replace(/^\uFEFF/, "").trim().toLowerCase();
export function validateProfile(input: unknown): EmployeeProfile {
  const value = object(input, ["schemaVersion", "id", "name", "jobTitle", "description", "fields", "agent", "ui"], "岗位配置");
  if (value.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/.test(string(value.id, 64, "岗位ID"))) reject("INVALID_PROFILE", "岗位配置版本或ID无效");
  string(value.name, 80, "岗位名称"); string(value.jobTitle, 80, "职位名称"); string(value.description, 2000, "岗位说明", true);
  if (!Array.isArray(value.fields) || value.fields.length < 1 || value.fields.length > 24) reject("INVALID_PROFILE", "标准字段数量须为1至24");
  const fieldKeys = new Set<string>(); const aliases = new Map<string, string>();
  for (const inputField of value.fields) {
    const field = object(inputField, ["key", "label", "type", "required", "aliases", "options"], "标准字段");
    const key = string(field.key, 32, "字段ID"); if (!/^[a-z][a-z0-9_]*$/.test(key) || fieldKeys.has(key)) reject("INVALID_PROFILE", "字段ID无效或重复"); fieldKeys.add(key);
    const label = string(field.label, 80, "字段名称");
    if (!["text", "number", "money", "date", "select", "boolean"].includes(String(field.type)) || typeof field.required !== "boolean") reject("INVALID_PROFILE", "字段类型或必填设置无效");
    if (!Array.isArray(field.aliases) || field.aliases.length > 12) reject("INVALID_PROFILE", "字段别名无效");
    for (const alias of [key, label, ...field.aliases]) { const normalized = headerKey(string(alias, 80, "字段别名")); const previous = aliases.get(normalized); if (previous && previous !== key) reject("INVALID_PROFILE", "不同字段不能使用相同别名"); aliases.set(normalized, key); }
    if (field.type === "select") {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 32 || new Set(field.options).size !== field.options.length) reject("INVALID_PROFILE", "选项字段需要不重复的选项");
      field.options.forEach(option => string(option, 80, "字段选项"));
    } else if (field.options !== undefined) reject("INVALID_PROFILE", "只有选项字段可以声明options");
  }
  const agent = object(value.agent, ["prompt", "skills", "sop", "tools"], "Agent配置");
  const prompt = string(agent.prompt, 16384, "提示词"); if (new TextEncoder().encode(prompt).length > 16384) reject("INVALID_PROFILE", "提示词超出16 KiB");
  string(agent.sop, 16000, "SOP", true);
  if (!Array.isArray(agent.skills) || agent.skills.length > LIMITS.skills) reject("INVALID_PROFILE", "最多配置8份skill");
  const skillIds = new Set<string>(); let skillCharacters = 0;
  for (const inputSkill of agent.skills) { const skill = object(inputSkill, ["id", "title", "content"], "skill"); const id = string(skill.id, 64, "skill ID"); if (!/^[a-z][a-z0-9-]*$/.test(id) || skillIds.has(id)) reject("INVALID_PROFILE", "skill ID无效或重复"); skillIds.add(id); string(skill.title, 80, "skill标题"); skillCharacters += string(skill.content, LIMITS.skillCharacters, "skill正文").length; }
  if (skillCharacters > LIMITS.skillCharacters) reject("INVALID_PROFILE", "skill正文总量不能超过32K字符");
  if (!Array.isArray(agent.tools) || agent.tools.length > 32 || new Set(agent.tools).size !== agent.tools.length) reject("INVALID_PROFILE", "工具集合无效");
  agent.tools.forEach(tool => { if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(string(tool, 64, "工具引用"))) reject("INVALID_PROFILE", "工具引用格式无效"); });
  if (agent.tools.length) reject("TOOLS_NOT_APPROVED", "此Demo只读，工具扩展需平台批准");
  const ui = object(value.ui, ["accentColor", "logoText", "css", "html", "dashboard", "pages"], "界面配置");
  if (!/^#[a-f0-9]{6}$/i.test(string(ui.accentColor, 7, "主题颜色"))) reject("INVALID_PROFILE", "主题颜色须为六位HEX颜色");
  string(ui.logoText, 12, "Logo文字"); const css = string(ui.css, 8192, "CSS", true); const html = string(ui.html, 16384, "HTML", true);
  if (/url\s*\(|@import|expression\s*\(|javascript:|<|>|\\/i.test(css)) reject("UNSAFE_PRESENTATION", "CSS不能包含外部资源或可执行内容");
  validateScopedCss(css);
  if (/<\s*\/?\s*(script|iframe|object|embed|link|meta|form|input|button|select|textarea|video|audio|svg|img|style|base)\b|\bon[a-z]+\s*=|\b(src|href|srcdoc|action|style)\s*=|javascript:|data:|https?:|\\/i.test(html)) reject("UNSAFE_PRESENTATION", "HTML模板只能包含静态展示元素");
  const profile = value as unknown as EmployeeProfile;
  if (ui.dashboard !== undefined) validateHtmlPage(ui.dashboard, profile, { dashboard: true });
  if (ui.pages !== undefined) {
    if (!Array.isArray(ui.pages) || ui.pages.length > LIMITS.profilePages) reject("INVALID_PAGE", "岗位默认页面最多12个");
    const ids = new Set<string>(); const titles = new Set<string>([ui.dashboard ? String((ui.dashboard as EmployeeHtmlPage).title).trim() : "Dashboard"]);
    for (const inputPage of ui.pages) { const page = validateHtmlPage(inputPage, profile); if (ids.has(page.id) || titles.has(page.title.trim())) reject("PAGE_COLLISION", "岗位默认页面ID或名称重复"); ids.add(page.id); titles.add(page.title.trim()); }
  }
  if (jsonBytes(value) > LIMITS.profileBytes || jsonBytes(agent) > LIMITS.profileBytes) reject("PROFILE_TOO_LARGE", "岗位配置总量超出64 KiB");
  return clone(value as unknown as EmployeeProfile);
}
export const PAGE_GLOBALS = Object.freeze(["company", "role", "jobTitle", "recordCount", "sourceCount", "reportCount", "updatedAt"]);
const RESERVED_PAGE_IDS = new Set(["dashboard", "overview", "settings", "sources", "records", "reports"]);
const DASHBOARD_TITLES = new Set(["dashboard", "总体看板", "总览"]);
const RESERVED_PAGE_TITLES = new Set([...DASHBOARD_TITLES, "设置", "上传资料", "资料上传"]);
function pageField(input: unknown, profile: EmployeeProfile): EmployeeField { const key = string(input, 32, "页面字段"); const field = profile.fields.find(field => field.key === key); if (!field) reject("INVALID_PAGE_FIELD", "页面引用了岗位未声明的字段"); return field; }
function filterValue(value: unknown, field: EmployeeField): void {
  if (value === null) return;
  const expected = field.type === "boolean" ? "boolean" : ["number", "money"].includes(field.type) ? "number" : "string";
  if (typeof value !== expected || value === "") reject("INVALID_PAGE_FILTER", "筛选值必须符合岗位字段类型");
  normalizeValue(value, { ...field, required: false }, false);
}
export function validateHtmlPage(input: unknown, profile: EmployeeProfile, options: { dashboard?: boolean } = {}): EmployeeHtmlPage {
  const page = object(input, ["id", "title", "html", "css", "bindings"], "HTML页面");
  const id = string(page.id, 64, "页面ID"); if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || (RESERVED_PAGE_IDS.has(id) && !(options.dashboard && id === "dashboard"))) reject("INVALID_PAGE_ID", "页面ID无效或与固定入口冲突");
  if (options.dashboard && id !== "dashboard") reject("INVALID_PAGE_ID", "Dashboard定义的ID必须为dashboard");
  const title = string(page.title, 80, "页面名称").trim().toLowerCase(); if (RESERVED_PAGE_TITLES.has(title) && !(options.dashboard && DASHBOARD_TITLES.has(title))) reject("PAGE_COLLISION", "页面名称与固定入口冲突");
  const html = string(page.html, 16384, "页面HTML", true); const css = string(page.css, 8192, "页面CSS", true);
  if (new TextEncoder().encode(html).length > 16384 || new TextEncoder().encode(css).length > 8192 || jsonBytes(page) > LIMITS.pageBytes) reject("PAGE_TOO_LARGE", "页面须满足HTML 16 KiB、CSS 8 KiB、总量32 KiB限制");
  validateScopedCss(css);
  if (!Array.isArray(page.bindings) || page.bindings.length > LIMITS.pageBindings) reject("INVALID_PAGE_BINDING", "每页最多16个数据绑定");
  const ids = new Set<string>(); const scalars: string[] = []; const lists: string[] = []; const bindings: EmployeePageBinding[] = [];
  for (const inputBinding of page.bindings) {
    const binding = object(inputBinding, ["id", "kind", "field", "columns", "filters", "left", "right"], "页面绑定");
    const bindingId = string(binding.id, 64, "绑定ID"); if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(bindingId) || ids.has(bindingId) || PAGE_GLOBALS.includes(bindingId)) reject("INVALID_PAGE_BINDING", "绑定ID无效、重复或覆盖通用变量"); ids.add(bindingId);
    const kind = string(binding.kind, 16, "绑定类型"); if (!["count", "sum", "distinct", "difference", "records", "reports"].includes(kind)) reject("INVALID_PAGE_BINDING", "绑定类型无效");
    if (kind === "difference") {
      if (binding.field !== undefined || binding.columns !== undefined || binding.filters !== undefined) reject("INVALID_PAGE_BINDING", "差额绑定只能引用两个基础指标");
      string(binding.left, 64, "左指标"); string(binding.right, 64, "右指标");
    } else {
      if (binding.left !== undefined || binding.right !== undefined) reject("INVALID_PAGE_BINDING", "只有差额绑定可以引用左右指标");
      if (["sum", "distinct"].includes(kind)) { const field = pageField(binding.field, profile); if (kind === "sum" && !["number", "money"].includes(field.type)) reject("INVALID_PAGE_BINDING", "求和只支持数值或金额字段"); }
      else if (binding.field !== undefined) reject("INVALID_PAGE_BINDING", "此绑定不接受field");
      if (binding.columns !== undefined) {
        if (kind !== "records" || !Array.isArray(binding.columns) || !binding.columns.length || binding.columns.length > profile.fields.length || new Set(binding.columns).size !== binding.columns.length) reject("INVALID_PAGE_BINDING", "列表列须为不重复的岗位字段");
        binding.columns.forEach(column => pageField(column, profile));
      }
      if (binding.filters !== undefined) {
        if (kind === "reports" || !Array.isArray(binding.filters) || binding.filters.length > LIMITS.bindingFilters) reject("INVALID_PAGE_FILTER", "每个记录绑定最多8个筛选，报告绑定不能筛选");
        for (const inputFilter of binding.filters) {
          const filter = object(inputFilter, ["field", "operator", "value"], "页面筛选"); const field = pageField(filter.field, profile);
          if (!["eq", "contains", "empty", "gte", "lte"].includes(String(filter.operator))) reject("INVALID_PAGE_FILTER", "筛选操作无效");
          if (filter.operator === "empty") { if (filter.value !== undefined) reject("INVALID_PAGE_FILTER", "空值筛选不能设置value"); }
          else if (filter.operator === "contains") { if (!["text", "select", "date"].includes(field.type)) reject("INVALID_PAGE_FILTER", "包含筛选只支持文本字段"); string(filter.value, 2000, "包含筛选值"); }
          else { if (["gte", "lte"].includes(String(filter.operator)) && (!["number", "money", "date"].includes(field.type) || filter.value === null)) reject("INVALID_PAGE_FILTER", "范围筛选只支持数值、金额或日期"); filterValue(filter.value, field); }
        }
      }
    }
    if (["records", "reports"].includes(kind)) lists.push(bindingId); else scalars.push(bindingId);
    bindings.push(binding as unknown as EmployeePageBinding);
  }
  for (const binding of bindings) if (binding.kind === "difference") {
    for (const reference of [binding.left, binding.right]) if (!bindings.some(candidate => candidate.id === reference && ["count", "sum", "distinct"].includes(candidate.kind))) reject("INVALID_PAGE_BINDING", "差额只能引用本页已声明的基础指标，不能形成循环");
    const moneyUnit = (id: string | undefined) => { const base = bindings.find(candidate => candidate.id === id)!; return base.kind === "sum" && profile.fields.find(field => field.key === base.field)?.type === "money"; };
    if (moneyUnit(binding.left) !== moneyUnit(binding.right)) reject("INVALID_PAGE_BINDING", "差额绑定的两个基础指标必须使用相同单位");
  }
  validatePageMarkup(html, { scalarIds: [...PAGE_GLOBALS, ...scalars], listIds: lists });
  return clone(page as unknown as EmployeeHtmlPage);
}
export function validatePageProposal(input: unknown): EmployeePageProposal {
  const proposal = object(input, ["proposalId", "profileId", "profileVersion", "definition"], "页面提案");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(string(proposal.proposalId, 96, "提案ID")) || String(proposal.proposalId).includes("..")) reject("INVALID_PAGE_PROPOSAL", "提案ID无效");
  const profileId = string(proposal.profileId, 64, "提案岗位"); if (!/^[a-z][a-z0-9-]{0,63}$/.test(profileId)) reject("INVALID_PAGE_PROPOSAL", "提案岗位无效");
  const profileVersion = string(proposal.profileVersion, 200, "提案配置版本"); if (!profileVersion.startsWith(`profile/${profileId}/`) || !/^[a-zA-Z0-9/._-]+$/.test(profileVersion) || profileVersion.includes("..")) reject("INVALID_PAGE_PROPOSAL", "提案配置版本无效");
  object(proposal.definition, ["id", "title", "html", "css", "bindings"], "提案页面");
  return clone(proposal as unknown as EmployeePageProposal);
}
export function createPageProposal(definition: EmployeeHtmlPage, snapshot: EmployeeSnapshot, proposalId: string = crypto.randomUUID()): EmployeePageProposal {
  return validatePageProposal({ proposalId, profileId: snapshot.profile.id, profileVersion: snapshot.profileVersion, definition: validateHtmlPage(definition, snapshot.profile) });
}
export function validateCompany(input: unknown): CompanySettings {
  const value = object(input, ["name", "jurisdiction", "currency", "goals", "policies", "reportingPeriod"], "公司配置");
  for (const key of ["name", "jurisdiction", "currency", "goals", "policies", "reportingPeriod"]) string(value[key], key === "policies" ? 8192 : 2000, key, key === "goals" || key === "policies");
  if (!/^[A-Z]{3}$/.test(String(value.currency))) reject("INVALID_COMPANY", "货币代码须为三个大写字母");
  if (jsonBytes(value) > 16384) reject("INVALID_COMPANY", "公司配置超出16 KiB"); return clone(value as unknown as CompanySettings);
}
export function parseMoney(input: string | number): number {
  const text = String(input).trim().replace(/[¥￥$€£]/g, "");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) reject("INVALID_MONEY", "金额须为非负数，最多两位小数");
  const [whole = "", fraction = ""] = text.replace(/,/g, "").split("."); const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > MAX_MONEY_CENTS) reject("INVALID_MONEY", "金额超出Demo安全汇总范围"); return amount;
}
export function formatMoney(cents: number, currency = "CNY"): string { return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: 2 }).format(cents / 100); }
function validDate(text: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const date = new Date(`${text}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text; }
function normalizeValue(input: unknown, field: EmployeeField, imported: boolean): RecordValue {
  if (input === undefined || input === null || input === "") { if (field.required) reject("REQUIRED_FIELD", `${field.label}不能为空`); return null; }
  if (!["string", "number", "boolean"].includes(typeof input)) reject("INVALID_RECORD", `${field.label}须为单值`);
  if (field.type === "money") { if (imported) return parseMoney(input as string | number); if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > MAX_MONEY_CENTS) reject("INVALID_RECORD", `${field.label}须为Demo安全范围内的整数分`); return input; }
  if (field.type === "number") { const text = String(input).trim(); if (!/^-?\d+(?:\.\d+)?$/.test(text)) reject("INVALID_RECORD", `${field.label}须为有限数值`); const number = Number(text); if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) reject("INVALID_RECORD", `${field.label}超出安全范围`); return number; }
  if (field.type === "boolean") { if (typeof input === "boolean") return input; if (["true", "是", "1"].includes(String(input))) return true; if (["false", "否", "0"].includes(String(input))) return false; reject("INVALID_RECORD", `${field.label}须为是或否`); }
  const text = String(input).trim(); if (text.length > 2000 || text.includes("\0")) reject("INVALID_RECORD", `${field.label}超出长度限制`);
  if (field.type === "date" && !validDate(text)) reject("INVALID_RECORD", `${field.label}须为有效的YYYY-MM-DD日期`);
  if (field.type === "select" && !field.options?.includes(text)) reject("INVALID_RECORD", `${field.label}不属于可用选项`);
  return text;
}
export function validateRecordValues(input: unknown, profile: EmployeeProfile, imported = false): Record<string, RecordValue> {
  const value = object(input, profile.fields.map(field => field.key), "标准记录"); const values: Record<string, RecordValue> = {};
  for (const field of profile.fields) values[field.key] = normalizeValue(value[field.key], field, imported);
  return values;
}
export async function createRawSource(input: { name: string; bytes: Uint8Array; mimeType?: string }, importedAt: string): Promise<RawSource> {
  string(input.name, 200, "文件名称"); if (!/\.(csv|json|txt|md|pdf|png|jpe?g|xlsx?|docx)$/i.test(input.name)) reject("SOURCE_TYPE_UNSUPPORTED", "Demo支持文本、PDF、图片和办公文档原件");
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > LIMITS.sourceBytes) reject("SOURCE_TOO_LARGE", "原件须为1字节至128 KiB");
  let text = ""; if (/\.(csv|json|txt|md)$/i.test(input.name)) { try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); } catch { reject("SOURCE_ENCODING_INVALID", "文本原件必须是UTF-8文本"); } }
  if (text.includes("\0")) reject("SOURCE_ENCODING_INVALID", "原件不能包含空字节");
  const buffer = new ArrayBuffer(input.bytes.length); new Uint8Array(buffer).set(input.bytes); const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); let binary = ""; for (const byte of input.bytes) binary += String.fromCharCode(byte);
  return { id: sha256, name: input.name, mimeType: input.mimeType || (/\.json$/i.test(input.name) ? "application/json" : /\.csv$/i.test(input.name) ? "text/csv" : "text/plain"), byteLength: input.bytes.length, sha256, importedAt, status: "pending", text, bytesBase64: btoa(binary) };
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let endedQuote = false;
  for (let i = 0; i < text.length; i++) { const char = text[i]!;
    if (quoted) { if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (char === '"') { quoted = false; endedQuote = true; } else cell += char; continue; }
    if (char === '"') { if (cell || endedQuote) reject("CSV_INVALID", "CSV引号位置无效"); quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; endedQuote = false; continue; }
    if (char === "\n" || char === "\r") { if (char === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = ""; endedQuote = false; continue; }
    if (endedQuote && char !== " " && char !== "\t") reject("CSV_INVALID", "CSV闭合引号之后只能是分隔符"); if (!endedQuote) cell += char;
  }
  if (quoted) reject("CSV_INVALID", "CSV存在未闭合引号"); row.push(cell); if (row.some(value => value.trim())) rows.push(row); return rows;
}
export function cleanSource(text: string, name: string, profile: EmployeeProfile): { rows: { row: number; values: Record<string, RecordValue> }[]; issues: CleaningIssue[] } {
  let entries: Record<string, unknown>[] = []; const rows: { row: number; values: Record<string, RecordValue> }[] = []; const issues: CleaningIssue[] = [];
  try {
    if (/\.json$/i.test(name)) { const parsed: unknown = JSON.parse(text); if (!Array.isArray(parsed)) reject("JSON_INVALID", "JSON原件须为对象数组"); entries = parsed; }
    else if (/\.csv$/i.test(name)) { const csv = parseCsv(text); if (csv.length < 2) reject("CSV_INVALID", "CSV至少需要表头和一行数据"); const headers = csv.shift()!; if (new Set(headers.map(headerKey)).size !== headers.length) reject("CSV_INVALID", "CSV表头不能重复"); entries = csv.map(row => { if (row.length !== headers.length) reject("CSV_INVALID", "CSV数据列数与表头不一致"); return Object.fromEntries(headers.map((header, index) => [header, row[index]])); }); }
    else reject("SOURCE_NOT_STRUCTURED", "该原件已保存。自动整理请使用岗位CSV或JSON模板");
    if (!entries.length || entries.length > LIMITS.records) reject("RECORD_LIMIT", "每份原件须包含1至1000行");
  } catch (error) { return { rows, issues: [{ row: 0, field: "source", message: error instanceof Error ? error.message : "原件解析失败" }] }; }
  const mapping = new Map<string, string>(); for (const field of profile.fields) for (const alias of [field.key, field.label, ...field.aliases]) mapping.set(headerKey(alias), field.key);
  entries.forEach((entry, index) => {
    const line = index + (/\.csv$/i.test(name) ? 2 : 1); const values: Record<string, unknown> = {}; const output: Record<string, RecordValue> = {}; const start = issues.length;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { issues.push({ row: line, field: "source", message: "每行须为对象" }); return; }
    for (const [header, value] of Object.entries(entry)) { const key = mapping.get(headerKey(header)); if (!key) { issues.push({ row: line, field: header, message: "表头未匹配岗位字段" }); continue; } if (Object.hasOwn(values, key)) { issues.push({ row: line, field: key, message: "同一字段出现多个表头" }); continue; } values[key] = value; }
    for (const field of profile.fields) { try { output[field.key] = normalizeValue(values[field.key], field, true); } catch (error) { issues.push({ row: line, field: field.key, message: error instanceof Error ? error.message : "字段无效" }); } }
    if (issues.length === start) rows.push({ row: line, values: output });
  }); return { rows, issues };
}
