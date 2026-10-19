import { cleanSource, clone, createRawSource, jsonBytes, LIMITS, reject, validateCompany, validateHtmlPage, validatePageProposal, validateProfile, validateRecordValues, type AuditEvent, type CompanySettings, type EmployeePageProposal, type EmployeeSavedPage, type EmployeeProfile, type EmployeeRecord, type EmployeeReport, type EmployeeSnapshot, type RawSource, type RecordValue, type SourceSummary } from "./domain";
import { EmployeeRepository, type ImmutableObject, type RepositoryIndex } from "./repository";
import { DEFAULT_COMPANY, DEFAULT_PROFILE, FINANCE_PROFILE, getDefaultPages, HR_PROFILE } from "./profiles";
import { validateScopedCss } from "./template";
interface ProfileVersion { profile: EmployeeProfile; previousKey?: string }
interface CompanyVersion { company: CompanySettings; previousKey?: string }
interface RecordVersion { record: EmployeeRecord; previousKey?: string }
interface PasswordGuard { version: 1; algorithm: "PBKDF2-SHA256"; iterations: number; salt: string; digest: string; previousKey?: string }
type StoredSource = Omit<RawSource, "text">;
export interface ControllerOptions { now?: () => string; id?: () => string; defaultProfile?: EmployeeProfile }
export interface SaveReportInput { title: string; body?: string; text?: string; kind?: EmployeeReport["kind"]; mode?: string; sourceIds?: string[]; recordIds?: string[]; recordRefs?: { id: string; revision: number }[]; basedOnRevision?: number }
const hex = (bytes: Uint8Array) => [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
function decodeHex(text: string): Uint8Array { if (!/^(?:[a-f0-9]{2})+$/.test(text)) reject("GUARD_CORRUPT", "开发者密码配置损坏"); return Uint8Array.from(text.match(/.{2}/g)!.map(part => Number.parseInt(part, 16))); }
async function passwordDigest(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const passwordBytes = new TextEncoder().encode(password); const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const buffer = new ArrayBuffer(salt.length); new Uint8Array(buffer).set(salt); return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buffer, iterations }, key, 256)));
}
function checkPassword(password: string) { if (typeof password !== "string" || password.length < 8 || password.length > 128) reject("PASSWORD_INVALID", "开发者密码须为8至128个字符"); }
function schemaIdentity(profile: EmployeeProfile) { return JSON.stringify(profile.fields.map(({ key, type, required, options }) => ({ key, type, required, options }))); }
export class EmployeeController {
  private state!: EmployeeSnapshot;
  private index!: RepositoryIndex;
  private unlockedGuardKey: string | undefined;
  private listeners = new Set<(state: EmployeeSnapshot) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private now: () => string;
  private id: () => string;
  constructor(private readonly repository: EmployeeRepository, private readonly options: ControllerOptions = {}) { this.now = options.now ?? (() => new Date().toISOString()); this.id = options.id ?? (() => crypto.randomUUID()); }
  async init(): Promise<void> {
    const index = await this.repository.initialize();
    if (!index.activeProfileId) {
      const profile = validateProfile(this.options.defaultProfile ?? DEFAULT_PROFILE); const company = validateCompany(DEFAULT_COMPANY);
      const roles = new Map([FINANCE_PROFILE, HR_PROFILE, profile].map(role => [role.id, validateProfile(role)]));
      const entries = [...roles.values()].map(role => ({ id: role.id, key: `profile/${role.id}/${this.id()}`, profile: role })); const companyKey = `company/${this.id()}`;
      await this.repository.commit(current => {
        if (current.activeProfileId) reject("INDEX_CONFLICT", "另一个页面已经初始化，请重新打开");
        return { index: { ...current, activeProfileId: profile.id, profiles: Object.fromEntries(entries.map(entry => [entry.id, entry.key])), companyKey }, objects: [...entries.map(entry => ({ key: entry.key, value: { profile: entry.profile } })), { key: companyKey, value: { company } }] };
      });
    }
    await this.refresh();
  }
  snapshot(): EmployeeSnapshot { if (!this.state) reject("NOT_READY", "工作台尚未初始化"); return clone(this.state); }
  subscribe(listener: (state: EmployeeSnapshot) => void): () => void { this.listeners.add(listener); if (this.state) listener(this.snapshot()); return () => this.listeners.delete(listener); }
  private emit() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* A view error must not change persisted data. */ } } }
  private async savedPages(): Promise<EmployeeSavedPage[]> {
    const pages: EmployeeSavedPage[] = [];
    for (const key of this.index.pages ?? []) {
      const saved = await this.repository.readObject<EmployeeSavedPage>(key);
      if (!saved || typeof saved !== "object" || Array.isArray(saved) || Object.keys(saved).some(key => !["proposalId", "profileId", "profileVersion", "definition", "createdAt"].includes(key)) || typeof saved.createdAt !== "string" || !Number.isFinite(Date.parse(saved.createdAt))) reject("STORE_CORRUPT", "已保存页面的来源记录无效");
      const { createdAt, ...input } = saved; const proposal = validatePageProposal(input);
      if (key !== `page/${proposal.proposalId}` || !this.index.profiles[proposal.profileId]) reject("STORE_CORRUPT", "已保存页面的岗位或提案索引无效");
      pages.push({ ...proposal, createdAt });
    }
    return pages;
  }
  async refresh(): Promise<void> {
    this.index = await this.repository.loadIndex(); const profileKey = this.index.profiles[this.index.activeProfileId]; if (!profileKey || !this.index.companyKey) reject("STORE_CORRUPT", "工作台配置索引缺失");
    const profile = validateProfile((await this.repository.readObject<ProfileVersion>(profileKey)).profile); const company = validateCompany((await this.repository.readObject<CompanyVersion>(this.index.companyKey)).company);
    if (this.unlockedGuardKey !== this.index.guardKey) this.unlockedGuardKey = undefined;
    const sources: SourceSummary[] = []; const records: EmployeeRecord[] = []; const reports: EmployeeReport[] = []; const audit: AuditEvent[] = []; const availableProfiles: { id: string; name: string }[] = [];
    for (const [id, key] of Object.entries(this.index.profiles)) { const role = validateProfile((await this.repository.readObject<ProfileVersion>(key)).profile); availableProfiles.push({ id, name: role.name }); }
    for (const id of this.index.sources) { const raw = await this.repository.readObject<StoredSource>(`raw/${id}`); const { bytesBase64: _bytes, ...summary } = raw; sources.push({ ...summary, status: this.index.processed[profile.id]?.includes(id) ? "processed" : "pending" }); }
    for (const reference of Object.values(this.index.records)) if (reference.profileId === profile.id) records.push((await this.repository.readObject<RecordVersion>(reference.key)).record);
    for (const key of this.index.reports) { const report = await this.repository.readObject<EmployeeReport>(key); if (report.profileId === profile.id) reports.push(report); }
    for (const key of this.index.audits) audit.push(await this.repository.readObject<AuditEvent>(key));
    const defaults = getDefaultPages(profile);
    const customPages = (await this.savedPages()).filter(page => page.profileId === profile.id).map(page => validateHtmlPage(page.definition, profile));
    this.state = { revision: this.index.revision, profile, profileVersion: profileKey, dashboard: defaults.dashboard, pages: [...defaults.pages, ...customPages], availableProfiles, company, sources, records, reports, audit, passwordConfigured: !!this.index.guardKey, developerUnlocked: !!this.unlockedGuardKey, storage: await this.repository.storageStats() }; this.emit();
  }
  private action<T>(perform: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { await this.refresh(); try { const value = await perform(); await this.refresh(); return value; } catch (error) { await this.refresh(); throw error; } }); this.tail = result.catch(() => undefined); return result;
  }
  private publish(objects: ImmutableObject[], change: (index: RepositoryIndex) => RepositoryIndex, action: string, entityId: string, detail: string): Promise<RepositoryIndex> {
    const revision = this.index.revision; const audit: AuditEvent & { previousKey?: string } = { id: this.id(), action, entityId, revision: revision + 1, at: this.now(), detail, ...(this.index.audits.at(-1) ? { previousKey: this.index.audits.at(-1) } : {}) }; const key = `audit/${audit.id}`;
    return this.repository.commit(current => { if (current.revision !== revision) reject("INDEX_CONFLICT", "数据已更新，请刷新后重试"); const next = change(current); return { index: { ...next, audits: [...next.audits, key].slice(-1000) }, objects: [...objects, { key, value: audit }] }; });
  }
  async getSource(id: string): Promise<RawSource> {
    if (!this.index.sources.includes(id)) reject("SOURCE_NOT_FOUND", "未找到原件"); const stored = await this.repository.readObject<StoredSource>(`raw/${id}`);
    let bytes: Uint8Array; try { bytes = Uint8Array.from(atob(stored.bytesBase64), char => char.charCodeAt(0)); } catch { reject("SOURCE_CORRUPT", "原件内容损坏"); }
    const verified = await createRawSource({ name: stored.name, bytes, mimeType: stored.mimeType }, stored.importedAt);
    if (verified.sha256 !== stored.sha256 || verified.id !== id || verified.byteLength !== stored.byteLength) reject("SOURCE_CORRUPT", "原件摘要与内容不一致"); return { ...verified, status: this.index.processed[this.index.activeProfileId]?.includes(id) ? "processed" : "pending" };
  }
  async importFile(file: File): Promise<SourceSummary> { if (file.size > LIMITS.sourceBytes) reject("SOURCE_TOO_LARGE", "每份原件不能超过128 KiB"); return this.importBytes({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type }); }
  appendText(input: { name: string; text: string }): Promise<SourceSummary> { return this.importText(input.name, input.text); }
  importText(name: string, text: string, mimeType = "text/plain"): Promise<SourceSummary> { const filename = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.txt`; return this.importBytes({ name: filename, bytes: new TextEncoder().encode(text), mimeType }); }
  importBytes(input: { name: string; bytes: Uint8Array; mimeType?: string }): Promise<SourceSummary> {
    return this.action(async () => {
      const raw = await createRawSource(input, this.now()); const existing = this.state.sources.find(item => item.id === raw.id); if (existing) return existing;
      if (this.index.sources.length >= LIMITS.sources) reject("SOURCE_LIMIT", "最多保存200份原件"); const { text: _text, ...stored } = raw;
      await this.publish([{ key: `raw/${raw.id}`, value: stored }], index => ({ ...index, sources: [...index.sources, raw.id] }), "source.import", raw.id, `保存${raw.name}，SHA-256 ${raw.sha256}`);
      const { bytesBase64: _bytes, text: _rawText, ...summary } = raw; return summary;
    });
  }
  processSource(id: string): Promise<{ createdCount: number; issues: import("./domain").CleaningIssue[] }> {
    return this.action(async () => {
      if (this.index.processed[this.state.profile.id]?.includes(id)) return { createdCount: 0, issues: [] };
      const raw = await this.getSource(id); const result = cleanSource(raw.text, raw.name, this.state.profile); if (result.issues.length) return { createdCount: 0, issues: result.issues };
      if (Object.keys(this.index.records).length + result.rows.length > LIMITS.records) reject("RECORD_LIMIT", "最多保存1000条标准记录");
      const at = this.now(); const rows: EmployeeRecord[] = result.rows.map(row => ({ id: this.id(), profileId: this.state.profile.id, values: row.values, sourceId: id, sourceRow: row.row, revision: 1, archived: false, createdAt: at, updatedAt: at }));
      const objects = rows.map(record => ({ key: `record/${record.id}/1`, value: { record } }));
      await this.publish(objects, index => { const records = { ...index.records }; for (const record of rows) records[record.id] = { key: `record/${record.id}/1`, revision: 1, profileId: record.profileId }; return { ...index, records, processed: { ...index.processed, [this.state.profile.id]: [...(index.processed[this.state.profile.id] ?? []), id] } }; }, "source.process", id, `按${this.state.profile.name}整理${rows.length}条记录`);
      return { createdCount: rows.length, issues: [] };
    });
  }
  addRecord(values: Record<string, RecordValue>): Promise<EmployeeRecord> {
    return this.action(async () => { const at = this.now(); const record: EmployeeRecord = { id: this.id(), profileId: this.state.profile.id, values: validateRecordValues(values, this.state.profile), revision: 1, archived: false, createdAt: at, updatedAt: at }; const key = `record/${record.id}/1`;
      await this.publish([{ key, value: { record } }], index => ({ ...index, records: { ...index.records, [record.id]: { key, revision: 1, profileId: record.profileId } } }), "record.create", record.id, "人工新增标准记录"); return record; });
  }
  private reviseRecord(id: string, patch: Record<string, RecordValue> | undefined, archived: boolean | undefined, expectedRevision?: number): Promise<EmployeeRecord> {
    return this.action(async () => { const reference = this.index.records[id]; if (!reference || reference.profileId !== this.state.profile.id) reject("RECORD_NOT_FOUND", "未找到当前岗位记录"); const prior = (await this.repository.readObject<RecordVersion>(reference.key)).record;
      if (expectedRevision !== undefined && prior.revision !== expectedRevision) reject("RECORD_CONFLICT", "该记录已变更，请刷新后重试");
      const record: EmployeeRecord = { ...prior, revision: prior.revision + 1, updatedAt: this.now(), values: patch ? validateRecordValues({ ...prior.values, ...patch }, this.state.profile) : prior.values, archived: archived ?? prior.archived }; const key = `record/${id}/${record.revision}`;
      await this.publish([{ key, value: { record, previousKey: reference.key } }], index => ({ ...index, records: { ...index.records, [id]: { key, revision: record.revision, profileId: record.profileId } } }), archived === undefined ? "record.edit" : archived ? "record.archive" : "record.restore", id, `记录版本${prior.revision}→${record.revision}，原件保持不变`); return record; });
  }
  editRecord(id: string, patch: Record<string, RecordValue>, expectedRevision?: number) { return this.reviseRecord(id, patch, undefined, expectedRevision); }
  archiveRecord(id: string, expectedRevision?: number) { return this.reviseRecord(id, undefined, true, expectedRevision); }
  restoreRecord(id: string, expectedRevision?: number) { return this.reviseRecord(id, undefined, false, expectedRevision); }
  async getRecordHistory(id: string): Promise<EmployeeRecord[]> { const reference = this.index.records[id]; if (!reference) reject("RECORD_NOT_FOUND", "未找到记录"); let key: string | undefined = reference.key; const history: EmployeeRecord[] = []; const seen = new Set<string>(); while (key) { if (seen.has(key) || history.length > 10000) reject("STORE_CORRUPT", "记录历史链接无效"); seen.add(key); const version: RecordVersion = await this.repository.readObject(key); history.push(version.record); key = version.previousKey; } return history.reverse(); }
  setCompanySettings(patch: Partial<CompanySettings>): Promise<void> { return this.action(async () => { const company = validateCompany({ ...this.state.company, ...patch }); const key = `company/${this.id()}`; await this.publish([{ key, value: { company, previousKey: this.index.companyKey } }], index => ({ ...index, companyKey: key }), "company.edit", "company", "更新公司要求"); }); }
  private requireUnlocked(index = this.index) { if (!this.unlockedGuardKey || this.unlockedGuardKey !== index.guardKey) reject("DEVELOPER_LOCKED", "请先输入开发者密码"); }
  setupPassword(password: string): Promise<void> { return this.action(async () => { checkPassword(password); if (this.index.guardKey) this.requireUnlocked(); const salt = crypto.getRandomValues(new Uint8Array(16)); const guard: PasswordGuard = { version: 1, algorithm: "PBKDF2-SHA256", iterations: 210000, salt: hex(salt), digest: await passwordDigest(password, salt, 210000), ...(this.index.guardKey ? { previousKey: this.index.guardKey } : {}) }; const key = `guard/${this.id()}`; await this.publish([{ key, value: guard }], index => ({ ...index, guardKey: key }), "developer.password", "guard", "设置开发者配置访问密码"); this.unlockedGuardKey = key; }); }
  async unlock(password: string): Promise<boolean> { await this.refresh(); checkPassword(password); if (!this.index.guardKey) reject("PASSWORD_NOT_CONFIGURED", "请先设置开发者密码"); const key = this.index.guardKey; const guard = await this.repository.readObject<PasswordGuard>(key); if (guard.version !== 1 || guard.algorithm !== "PBKDF2-SHA256" || guard.iterations !== 210000 || !/^[a-f0-9]{64}$/.test(guard.digest)) reject("GUARD_CORRUPT", "开发者密码配置损坏"); const digest = await passwordDigest(password, decodeHex(guard.salt), guard.iterations); let difference = 0; for (let i = 0; i < digest.length; i++) difference |= digest.charCodeAt(i) ^ guard.digest.charCodeAt(i); if (difference) return false; if ((await this.repository.loadIndex()).guardKey !== key) reject("INDEX_CONFLICT", "密码配置已更新，请重试"); this.unlockedGuardKey = key; await this.refresh(); return true; }
  lock(): void { this.unlockedGuardKey = undefined; if (this.state) { this.state.developerUnlocked = false; this.emit(); } }
  saveProfile(input: EmployeeProfile): Promise<void> { return this.action(async () => { this.requireUnlocked(); const profile = validateProfile(input); validateScopedCss(profile.ui.css);
    const previousKey = this.index.profiles[profile.id]; if (previousKey) { const previous = (await this.repository.readObject<ProfileVersion>(previousKey)).profile; if (schemaIdentity(previous) !== schemaIdentity(profile) && Object.values(this.index.records).some(record => record.profileId === profile.id)) reject("SCHEMA_IN_USE", "已有记录的岗位不能更改字段结构，请使用新的岗位ID"); }
    const defaults = getDefaultPages(profile); const ids = new Set(defaults.pages.map(page => page.id)); const titles = new Set([defaults.dashboard.title.trim(), ...defaults.pages.map(page => page.title.trim())]);
    for (const saved of await this.savedPages()) if (saved.profileId === profile.id) { const page = validateHtmlPage(saved.definition, profile); if (ids.has(page.id) || titles.has(page.title.trim())) reject("PAGE_COLLISION", "岗位配置与已保存页面的ID或名称冲突"); ids.add(page.id); titles.add(page.title.trim()); }
    const key = `profile/${profile.id}/${this.id()}`; await this.publish([{ key, value: { profile, ...(previousKey ? { previousKey } : {}) } }], index => { this.requireUnlocked(index); return { ...index, activeProfileId: profile.id, profiles: { ...index.profiles, [profile.id]: key } }; }, "profile.edit", profile.id, "保存岗位配置；新Agent会话采用新配置"); }); }
  switchProfile(id: string): Promise<void> { return this.action(async () => { this.requireUnlocked(); if (!this.index.profiles[id]) reject("PROFILE_NOT_FOUND", "未找到已保存的岗位配置"); await this.publish([], index => { this.requireUnlocked(index); return { ...index, activeProfileId: id }; }, "profile.switch", id, "切换岗位，保留既有原件和记录"); }); }
  importProfile(json: string): Promise<void> { if (new TextEncoder().encode(json).length > LIMITS.profileBytes) return Promise.reject(new Error("岗位配置文件超出64 KiB")); let value: unknown; try { value = JSON.parse(json); } catch { return Promise.reject(new Error("岗位配置文件不是有效JSON")); } return this.saveProfile(validateProfile(value)); }
  exportProfile(): string { this.requireUnlocked(); return JSON.stringify(validateProfile(this.state.profile), null, 2); }
  confirmPageProposal(input: EmployeePageProposal): Promise<EmployeeSavedPage> { return this.action(async () => {
    const proposal = validatePageProposal(input); const pages = await this.savedPages(); const existing = pages.find(page => page.proposalId === proposal.proposalId);
    if (existing) {
      const { createdAt: _at, ...savedProposal } = existing;
      if (JSON.stringify(savedProposal) !== JSON.stringify(proposal)) reject("PAGE_PROPOSAL_CONFLICT", "同一提案ID不能替换已保存的页面");
      return existing;
    }
    if (proposal.profileId !== this.state.profile.id || proposal.profileVersion !== this.state.profileVersion) reject("PAGE_PROPOSAL_STALE", "岗位配置已变更，请重新生成页面提案");
    const definition = validateHtmlPage(proposal.definition, this.state.profile);
    if (this.state.pages.some(page => page.id === definition.id || page.title.trim() === definition.title.trim()) || definition.title.trim() === this.state.dashboard.title.trim()) reject("PAGE_COLLISION", "页面ID或名称已存在，请使用新名称");
    if (pages.length >= LIMITS.customPages || pages.filter(page => page.profileId === proposal.profileId).length >= LIMITS.customPagesPerProfile) reject("PAGE_LIMIT", "每个岗位最多20个自定义页面，全库最多100个");
    const saved: EmployeeSavedPage = { ...proposal, definition, createdAt: this.now() }; const key = `page/${proposal.proposalId}`;
    await this.publish([{ key, value: saved }], index => {
      if (index.activeProfileId !== proposal.profileId || index.profiles[proposal.profileId] !== proposal.profileVersion) reject("PAGE_PROPOSAL_STALE", "岗位配置已变更，请重新生成页面提案");
      return { ...index, pages: [...(index.pages ?? []), key] };
    }, "page.create", definition.id, `确认新增页面${definition.title}；保留提案${proposal.proposalId}与岗位配置来源`);
    return saved;
  }); }
  saveReport(input: SaveReportInput): Promise<EmployeeReport> { return this.action(async () => {
    if (input.basedOnRevision !== undefined) {
      if (!Number.isSafeInteger(input.basedOnRevision) || input.basedOnRevision < 0) reject("REPORT_INVALID", "报表依据版本无效");
      if (input.basedOnRevision !== this.index.revision) reject("REPORT_CONFLICT", "资料或配置已发生变化，请重新分析后保存报表");
    }
    const body = input.body ?? input.text; if (!input.title?.trim() || input.title.length > 200 || typeof body !== "string" || !body.trim() || new TextEncoder().encode(body).length > 65536) reject("REPORT_INVALID", "报表标题或正文无效，正文最多64 KiB");
    const sourceIds = [...new Set(input.sourceIds ?? [])]; if (sourceIds.some(id => !this.index.sources.includes(id))) reject("REPORT_SOURCE_INVALID", "报表引用了不存在的原件");
    const recordRefs = input.recordRefs ?? (input.recordIds ?? []).map(id => ({ id, revision: this.index.records[id]?.revision ?? 0 }));
    if (recordRefs.length > LIMITS.records || new Set(recordRefs.map(reference => reference.id)).size !== recordRefs.length) reject("REPORT_RECORD_INVALID", "报表记录引用超限或重复");
    for (const reference of recordRefs) { const record = this.index.records[reference.id]; if (!record || record.profileId !== this.state.profile.id || !(await this.getRecordHistory(reference.id)).some(item => item.revision === reference.revision)) reject("REPORT_RECORD_INVALID", "报表引用了不存在的记录版本"); }
    const kind = input.kind ?? (input.mode?.includes("真实") ? "agent" : "demo"); if (!["demo", "agent", "manual"].includes(kind)) reject("REPORT_INVALID", "报表来源类型无效");
    const report: EmployeeReport = { id: this.id(), title: input.title, body, text: body, kind, mode: input.mode ?? (kind === "agent" ? "平台Agent·真实模型" : kind === "demo" ? "演示分析·非大模型" : "人工报表"), profileId: this.state.profile.id, sourceIds, recordIds: recordRefs.map(reference => reference.id), recordRefs: clone(recordRefs), dataRevision: input.basedOnRevision ?? this.index.revision, createdAt: this.now() };
    if (!Number.isSafeInteger(report.dataRevision) || report.dataRevision > this.index.revision || report.dataRevision < 0) reject("REPORT_INVALID", "报表依据版本无效"); const key = `report/${report.id}`;
    await this.publish([{ key, value: report }], index => ({ ...index, reports: [...index.reports, key] }), "report.create", report.id, "保存独立报表草稿，不更改标准记录"); return report;
  }); }
}
