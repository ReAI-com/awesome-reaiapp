import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, join } from 'node:path';
import Ajv from 'ajv';
import type { AgentConfig, AgentId, AgentRun, CleaningSpec, DataRecord, Dataset, JsonSchema, SourceFile, SourceRevision, Workspace, WorkspaceState } from '../shared/types.ts';

type Entity = Record<string, unknown>;
type Row = { payload: string };
const KINDS = new Set(['files', 'fileEvents', 'revisions', 'specs', 'specVersions', 'routingSnapshots', 'datasets', 'records', 'runs', 'agents', 'boards', 'boardVersions', 'messages', 'deliverables', 'checks', 'checkRules', 'financeConfirmations', 'financeReporting']);
const IMMUTABLE_KINDS = new Set(['revisions', 'specVersions', 'routingSnapshots', 'boardVersions', 'financeConfirmations', 'financeReporting']);
const now = () => new Date().toISOString();
const id = () => randomUUID();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
// Resolve existing symlink ancestors even when the selected child directory does not exist yet.
const realDirectory = (directory: string): string => {
  let ancestor = resolve(directory);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw storeError(400, '工作目录路径无效');
    missing.unshift(basename(ancestor)); ancestor = parent;
  }
  if (!statSync(ancestor).isDirectory()) throw storeError(400, '工作目录必须是目录');
  return join(realpathSync(ancestor), ...missing);
};
const containsDirectory = (root: string, candidate: string) => {
  const part = relative(root, candidate);
  return part === '' || (part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part));
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};
export function storeError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export interface PublishCleaningInput {
  workspaceId: string; fileId: string; revisionId: string; generation: number; runId: string;
  specId: string; specVersion: number; datasetName: string; schema: JsonSchema;
  records: Record<string, unknown>[];
  expectedRecordVersions?: Record<string, number> | { id: string; version: number }[];
  replaceManual?: boolean;
}
export interface PublishCleaningResult { dataset: Dataset; records: DataRecord[]; file: SourceFile; batchId: string }

/** Local persistence. All entity access includes a workspace; generic writes are internal APIs. */
export class Store {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly dataDir: string;
  private readonly ajv = new Ajv({ allErrors: true, strict: false, strictNumbers: true, coerceTypes: false });

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    chmodSync(this.dataDir, 0o700);
    this.dbPath = join(this.dataDir, 'workbench.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), entity_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, workspace_id, entity_id));
      CREATE INDEX IF NOT EXISTS entities_by_id ON entities(kind, entity_id);
      CREATE TABLE IF NOT EXISTS record_history (workspace_id TEXT NOT NULL REFERENCES workspaces(id), record_id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL, archived_at TEXT NOT NULL, PRIMARY KEY(workspace_id, record_id, version));
      CREATE TABLE IF NOT EXISTS publication_batches (workspace_id TEXT NOT NULL REFERENCES workspaces(id), run_id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, run_id));
      CREATE TABLE IF NOT EXISTS dataset_tables (workspace_id TEXT NOT NULL REFERENCES workspaces(id), dataset_id TEXT NOT NULL, table_name TEXT NOT NULL UNIQUE, schema_json TEXT NOT NULL, PRIMARY KEY(workspace_id, dataset_id));`);
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }

  close() { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private kind(kind: string) {
    if (!KINDS.has(kind)) throw storeError(400, `未知数据类型：${kind}`);
  }

  createWorkspace(input: { name: string; role: string; directory?: string }): Workspace {
    if (!input.name?.trim() || !input.role?.trim()) throw storeError(400, '工作区名称和岗位不能为空');
    const workspaceId = id();
    const directory = realDirectory(input.directory || join(this.dataDir, 'workspaces', workspaceId));
    return this.transaction(() => {
      for (const existing of this.listWorkspaces()) {
        const other = realDirectory(existing.directory);
        if (containsDirectory(other, directory) || containsDirectory(directory, other)) throw storeError(409, '工作目录与已有岗位相同或相互嵌套，请选择独立目录');
      }
      // mkdir's mode applies only to newly created folders; existing user folders keep their permissions.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const workspace: Workspace = { id: workspaceId, name: input.name.trim(), role: input.role.trim(), directory: realpathSync(directory), createdAt: now() };
      this.db.prepare('INSERT INTO workspaces(id,payload) VALUES (?,?)').run(workspace.id, JSON.stringify(workspace));
      this.put('specs', { id: id(), workspaceId, name: '通用结构化', description: '根据岗位与文件内容自动确定字段，保留事实与来源。', match: '*', prompt: '将原始资料整理为适合当前岗位的结构化记录。只提取有依据的事实；缺失内容留空，不编造。根据资料自动定义 JSON Schema，并逐行校验。', version: 1, createdAt: now() } satisfies CleaningSpec);
      const prompts: Record<AgentId, string> = {
        'agent-001': '你是数据清洗员。按规范路由并提取事实，输出符合 JSON Schema 的结构化记录；保留来源，不推测缺失值。',
        'agent-002': '你是岗位看板开发者。基于当前工作区的数据库结构与 REST API 创建独立看板；仅使用明确授权的数据和操作。',
        'agent-003': '你是当前岗位的专家。基于工作区已发布的结构化数据回答问题，区分事实与判断，引用记录，资料不足时明确说明。',
      };
      for (const agentId of ['agent-001', 'agent-002', 'agent-003'] as const) this.put('agents', {
        agentId, workspaceId, version: 1, harness: 'pi', provider: '', model: '', protocol: 'openai-completions', baseUrl: '', parameters: {}, prompt: prompts[agentId], tools: agentId === 'agent-001' ? ['read_schema', 'query_records', 'inspect_source'] : ['read_schema', 'query_records'], mcp: {}, skills: [],
      } satisfies AgentConfig);
      return workspace;
    });
  }

  listWorkspaces(): Workspace[] {
    return (this.db.prepare('SELECT payload FROM workspaces ORDER BY rowid').all() as Row[]).map(row => JSON.parse(row.payload));
  }

  updateWorkspace(workspaceId: string, changes: Pick<Partial<Workspace>, 'autoClean' | 'finance'>): Workspace {
    const current = this.getWorkspace(workspaceId);
    const workspace = { ...current, ...changes };
    this.db.prepare('UPDATE workspaces SET payload=? WHERE id=?').run(JSON.stringify(workspace), workspaceId);
    return workspace;
  }

  getWorkspace(workspaceId: string): Workspace {
    if (typeof workspaceId !== 'string' || !workspaceId) throw storeError(400, '缺少有效工作区归属');
    const row = this.db.prepare('SELECT payload FROM workspaces WHERE id=?').get(workspaceId) as Row | undefined;
    if (!row) throw storeError(404, '工作区不存在');
    return JSON.parse(row.payload);
  }

  list<T>(kind: string, workspaceId: string): T[] {
    this.kind(kind); this.getWorkspace(workspaceId);
    return (this.db.prepare('SELECT payload FROM entities WHERE kind=? AND workspace_id=? ORDER BY rowid').all(kind, workspaceId) as Row[]).map(row => JSON.parse(row.payload));
  }

  get<T>(kind: string, entityId: string, workspaceId: string): T | undefined {
    this.kind(kind); this.getWorkspace(workspaceId);
    const row = this.db.prepare('SELECT payload FROM entities WHERE kind=? AND workspace_id=? AND entity_id=?').get(kind, workspaceId, entityId) as Row | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }

  require<T>(kind: string, entityId: string, workspaceId: string): T {
    const entity = this.get<T>(kind, entityId, workspaceId);
    if (!entity) throw storeError(404, '对象不存在');
    return entity;
  }

  put<T extends object>(kind: string, value: T): T {
    this.kind(kind);
    const entity = { ...value } as Entity;
    let workspaceId = entity.workspaceId as string | undefined;
    if (!workspaceId && kind === 'revisions' && typeof entity.fileId === 'string') {
      const rows = this.db.prepare("SELECT workspace_id FROM entities WHERE kind='files' AND entity_id=?").all(entity.fileId) as { workspace_id: string }[];
      if (rows.length !== 1) throw storeError(400, '原件版本必须指定有效工作区');
      workspaceId = rows[0].workspace_id;
      entity.workspaceId = workspaceId;
    }
    if (!workspaceId || typeof workspaceId !== 'string') throw storeError(400, '缺少有效工作区归属');
    this.getWorkspace(workspaceId);
    const entityId = (kind === 'agents' ? entity.agentId : entity.id) as string | undefined;
    if (!entityId || typeof entityId !== 'string') throw storeError(400, '缺少对象标识');
    if (kind === 'agents' && !['agent-001', 'agent-002', 'agent-003'].includes(entityId)) throw storeError(400, '未知 Agent');
    const checkReference = (targetKind: string, reference: unknown) => {
      if (reference != null && (typeof reference !== 'string' || !this.get(targetKind, reference, workspaceId))) throw storeError(404, '关联对象不存在于当前工作区');
    };
    if (kind === 'fileEvents') checkReference('files', entity.fileId);
    if (kind === 'datasets') checkReference('specs', entity.specId);
    if (kind === 'runs') { checkReference('files', entity.fileId); checkReference('revisions', entity.inputRevisionId); }
    if (kind === 'boards') {
      if (!Array.isArray(entity.datasetIds)) throw storeError(400, '看板必须声明数据集范围');
      for (const datasetId of entity.datasetIds) checkReference('datasets', datasetId);
    }
    if (kind === 'revisions') {
      if (!this.get('files', String(entity.fileId), workspaceId)) throw storeError(404, '原件所属文件不存在');
    }
    if (IMMUTABLE_KINDS.has(kind)) {
      const previous = this.get<Entity>(kind, entityId, workspaceId);
      if (previous && canonical(previous) !== canonical(entity)) throw storeError(409, '原件、规范版本与路由快照只增不改');
    }
    if (kind === 'records') {
      if (!this.get('datasets', String(entity.datasetId), workspaceId)) throw storeError(404, '记录所属数据集不存在');
      checkReference('files', entity.sourceFileId); checkReference('revisions', entity.sourceRevisionId); checkReference('runs', entity.runId);
    }
    this.db.prepare('INSERT INTO entities(kind,workspace_id,entity_id,payload) VALUES (?,?,?,?) ON CONFLICT(kind,workspace_id,entity_id) DO UPDATE SET payload=excluded.payload').run(kind, workspaceId, entityId, JSON.stringify(entity));
    return entity as T;
  }

  /** Internal archival helper. No HTTP deletion endpoint should expose this. */
  remove(kind: string, entityId: string, workspaceId: string) {
    this.kind(kind); this.getWorkspace(workspaceId);
    if (IMMUTABLE_KINDS.has(kind)) throw storeError(409, '原件、规范版本与路由快照不可删除');
    this.db.prepare('DELETE FROM entities WHERE kind=? AND workspace_id=? AND entity_id=?').run(kind, workspaceId, entityId);
  }

  state(workspaceId: string): WorkspaceState {
    const agents = this.list<AgentConfig>('agents', workspaceId).map(({ apiKey, ...config }) => ({ ...config, hasApiKey: !!apiKey }));
    return { workspace: this.getWorkspace(workspaceId), files: this.list('files', workspaceId), specs: this.list('specs', workspaceId), datasets: this.list('datasets', workspaceId), records: this.list('records', workspaceId), runs: this.list('runs', workspaceId), agents, boards: this.list('boards', workspaceId), messages: this.list('messages', workspaceId), deliverables: this.list('deliverables', workspaceId), checks: this.list('checks', workspaceId), checkRules: this.list('checkRules', workspaceId) };
  }

  addEvent(runId: string, workspaceId: string, phase: string, message: string): AgentRun {
    const run = this.get<AgentRun>('runs', runId, workspaceId);
    if (!run) throw storeError(404, '运行记录不存在');
    return this.put('runs', { ...run, events: [...(run.events || []), { time: now(), phase, message }], updatedAt: now() });
  }

  private validator(schema: JsonSchema) {
    if (!schema || schema.type !== 'object' || !schema.properties || !Object.keys(schema.properties).length) throw storeError(400, 'Schema 必须包含至少一个字段');
    if (Object.keys(schema.properties).length > 200) throw storeError(400, 'Schema 字段不能超过 200 个');
    for (const key of Object.keys(schema.properties)) if (!key || key.includes('\0')) throw storeError(400, 'Schema 字段名称无效');
    const folded = Object.keys(schema.properties).map(key => key.toLowerCase());
    if (new Set(folded).size !== folded.length) throw storeError(400, 'Schema 字段不能仅以字母大小写区分');
    try { return this.ajv.compile(schema); }
    catch (error) { throw storeError(400, `Schema 无效：${error instanceof Error ? error.message : String(error)}`); }
  }

  private ensureTable(dataset: Dataset): string {
    const tableName = `b_${createHash('sha256').update(`${dataset.workspaceId}/${dataset.id}`).digest('hex').slice(0, 20)}_v${dataset.version}`;
    const sqlType = (type: string) => type === 'integer' || type === 'boolean' ? 'INTEGER' : type === 'number' ? 'REAL' : 'TEXT';
    const columns = Object.entries(dataset.schema.properties).map(([key, field]) => `${quote(`field_${key}`)} ${sqlType(field.type)}`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${quote(tableName)} (__id TEXT NOT NULL, __version INTEGER NOT NULL, __current INTEGER NOT NULL, __source_file_id TEXT, __source_revision_id TEXT, __run_id TEXT, __manual INTEGER NOT NULL, __created_at TEXT NOT NULL, __updated_at TEXT NOT NULL, ${columns.join(',')}, PRIMARY KEY(__id,__version))`);
    this.db.prepare('INSERT OR IGNORE INTO dataset_tables(workspace_id,dataset_id,table_name,schema_json) VALUES (?,?,?,?)').run(dataset.workspaceId, dataset.id, tableName, JSON.stringify(dataset.schema));
    return tableName;
  }

  /** Physical SQL schema is available to admin inspection; values never form identifiers. */
  datasetTable(workspaceId: string, datasetId: string): { name: string; columns: { field: string; column: string; type: string }[] } {
    const dataset = this.get<Dataset>('datasets', datasetId, workspaceId);
    if (!dataset) throw storeError(404, '数据集不存在');
    const row = this.db.prepare('SELECT table_name FROM dataset_tables WHERE workspace_id=? AND dataset_id=?').get(workspaceId, datasetId) as { table_name: string } | undefined;
    if (!row) throw storeError(404, '数据集结构尚未创建');
    return { name: row.table_name, columns: Object.entries(dataset.schema.properties).map(([field, spec]) => ({ field, column: `field_${field}`, type: spec.type })) };
  }

  private writeTyped(record: DataRecord, dataset: Dataset) {
    const tableName = this.ensureTable(dataset);
    const fields = Object.keys(dataset.schema.properties);
    const values = fields.map(key => {
      const value = record.data[key];
      return value == null ? null : typeof value === 'boolean' ? Number(value) : typeof value === 'object' ? JSON.stringify(value) : value as string | number;
    });
    const columns = ['__id', '__version', '__current', '__source_file_id', '__source_revision_id', '__run_id', '__manual', '__created_at', '__updated_at', ...fields.map(key => `field_${key}`)];
    this.db.prepare(`INSERT INTO ${quote(tableName)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(record.id, record.version, 1, record.sourceFileId || null, record.sourceRevisionId || null, record.runId || null, Number(record.manual), record.createdAt, record.updatedAt, ...values);
  }

  private archive(record: DataRecord, reason: string) {
    this.db.prepare('INSERT OR IGNORE INTO record_history(workspace_id,record_id,version,payload,reason,archived_at) VALUES (?,?,?,?,?,?)').run(record.workspaceId, record.id, record.version, JSON.stringify(record), reason, now());
    const row = this.db.prepare('SELECT table_name FROM dataset_tables WHERE workspace_id=? AND dataset_id=?').get(record.workspaceId, record.datasetId) as { table_name: string } | undefined;
    if (row) this.db.prepare(`UPDATE ${quote(row.table_name)} SET __current=0 WHERE __id=? AND __version=?`).run(record.id, record.version);
  }

  publishCleaning(input: PublishCleaningInput): PublishCleaningResult {
    this.getWorkspace(input.workspaceId);
    if (!Array.isArray(input.records) || input.records.length > 100_000) throw storeError(400, '清洗结果必须为记录数组，最多 100000 条');
    const requestHash = createHash('sha256').update(canonical(input)).digest('hex');
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT request_hash,result FROM publication_batches WHERE workspace_id=? AND run_id=?').get(input.workspaceId, input.runId) as { request_hash: string; result: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) throw storeError(409, '同一任务不能发布不同结果');
        return JSON.parse(previous.result);
      }
      const file = this.get<SourceFile>('files', input.fileId, input.workspaceId);
      const revision = this.get<SourceRevision>('revisions', input.revisionId, input.workspaceId);
      const spec = this.get<CleaningSpec>('specs', input.specId, input.workspaceId);
      const run = this.get<AgentRun>('runs', input.runId, input.workspaceId);
      if (!file || !revision || !spec || !run || revision.fileId !== file.id) throw storeError(404, '文件、原件、规范或任务不存在');
      if (file.revisionId !== input.revisionId || file.generation !== input.generation) throw storeError(409, '原件已有更新，旧任务结果不能发布');
      if (spec.version !== input.specVersion) throw storeError(409, '清洗规范已有更新，请重新清洗');
      if (!['queued', 'running', 'waiting_review'].includes(run.status)) throw storeError(409, '任务已停止或结束，不能发布');
      if (run.fileId !== input.fileId || run.inputRevisionId !== input.revisionId || run.generation !== input.generation || (run.specVersion != null && run.specVersion !== input.specVersion)) throw storeError(409, '任务输入与发布内容不一致');
      if (spec.schema && Object.keys(spec.schema.properties).length && canonical(spec.schema) !== canonical(input.schema)) throw storeError(409, '结果 Schema 与生效清洗规范不一致');
      const validate = this.validator(input.schema);
      for (let index = 0; index < input.records.length; index++) {
        if (!validate(input.records[index])) throw storeError(400, `第 ${index + 1} 条记录不符合 Schema：${this.ajv.errorsText(validate.errors, { separator: '；' })}`);
      }
      const oldRecords = this.list<DataRecord>('records', input.workspaceId).filter(record => record.sourceFileId === file.id);
      if (oldRecords.some(record => record.manual)) {
        if (input.replaceManual !== true) throw storeError(409, '此文件的记录已被人工修订，请复核并明确确认后更新，不能自动覆盖');
        if (!input.expectedRecordVersions) throw storeError(409, '覆盖人工修订必须提供复核时的记录版本，请刷新后重新确认');
      }
      if (input.expectedRecordVersions) {
        const expected = Array.isArray(input.expectedRecordVersions) ? Object.fromEntries(input.expectedRecordVersions.map(record => [record.id, record.version])) : input.expectedRecordVersions;
        if (oldRecords.length !== Object.keys(expected).length || oldRecords.some(record => expected[record.id] !== record.version)) throw storeError(409, '记录版本已变化，请重新清洗');
      }
      const datasets = this.list<Dataset>('datasets', input.workspaceId).filter(dataset => dataset.specId === spec.id);
      const datasetName = datasets[0]?.name || input.datasetName?.trim() || spec.name;
      let dataset = datasets.find(candidate => canonical(candidate.schema) === canonical(input.schema));
      if (!dataset) {
        dataset = { id: id(), workspaceId: input.workspaceId, specId: spec.id, name: datasetName, schema: input.schema, version: Math.max(0, ...datasets.map(candidate => candidate.version)) + 1, createdAt: now() };
        this.put('datasets', dataset);
        this.ensureTable(dataset);
      }
      const timestamp = now();
      for (const oldRecord of oldRecords) { this.archive(oldRecord, input.replaceManual === true ? 'reviewed_cleaning_replaced' : 'cleaning_replaced'); this.remove('records', oldRecord.id, input.workspaceId); }
      const records = input.records.map(data => {
        const record: DataRecord = { id: id(), workspaceId: input.workspaceId, datasetId: dataset.id, data, version: 1, sourceFileId: file.id, sourceRevisionId: revision.id, runId: run.id, manual: false, createdAt: timestamp, updatedAt: timestamp };
        this.put('records', record); this.writeTyped(record, dataset); return record;
      });
      const completedFile: SourceFile = { ...file, cleanedRevisionId: revision.id, state: file.cleanedRevisionId ? '更新完成' : '清洗完成', updatedAt: timestamp };
      delete completedFile.error;
      this.put('files', completedFile);
      this.put('fileEvents', { id: id(), workspaceId: input.workspaceId, fileId: file.id, state: completedFile.state, time: timestamp, revisionId: revision.id });
      const result: PublishCleaningResult = { dataset, records, file: completedFile, batchId: id() };
      this.put('runs', { ...run, status: 'succeeded', result: { datasetId: dataset.id, recordCount: records.length, batchId: result.batchId }, events: [...(run.events || []), { time: timestamp, phase: 'published', message: `已发布 ${records.length} 条记录` }], updatedAt: timestamp });
      this.db.prepare('INSERT INTO publication_batches(workspace_id,run_id,request_hash,result,created_at) VALUES (?,?,?,?,?)').run(input.workspaceId, input.runId, requestHash, JSON.stringify(result), timestamp);
      return result;
    });
  }

  createRecord(workspaceId: string, datasetId: string, data: Record<string, unknown>): DataRecord {
    return this.transaction(() => {
      const dataset = this.get<Dataset>('datasets', datasetId, workspaceId);
      if (!dataset) throw storeError(404, '数据集不存在');
      const validate = this.validator(dataset.schema);
      if (!validate(data)) throw storeError(400, `记录不符合 Schema：${this.ajv.errorsText(validate.errors)}`);
      const timestamp = now();
      const record: DataRecord = { id: id(), workspaceId, datasetId, data, version: 1, manual: true, createdAt: timestamp, updatedAt: timestamp };
      this.put('records', record); this.writeTyped(record, dataset); return record;
    });
  }

  reviseRecord(workspaceId: string, recordId: string, expectedVersion: number, data: Record<string, unknown>): DataRecord {
    return this.transaction(() => {
      const record = this.get<DataRecord>('records', recordId, workspaceId);
      if (!record) throw storeError(404, '记录不存在');
      if (record.version !== expectedVersion) throw storeError(409, '记录已被修改，请刷新后重试');
      const dataset = this.get<Dataset>('datasets', record.datasetId, workspaceId);
      if (!dataset) throw storeError(404, '数据集不存在');
      const validate = this.validator(dataset.schema);
      if (!validate(data)) throw storeError(400, `记录不符合 Schema：${this.ajv.errorsText(validate.errors)}`);
      this.archive(record, 'manual_revision');
      const next: DataRecord = { ...record, data, manual: true, version: record.version + 1, updatedAt: now() };
      this.put('records', next); this.writeTyped(next, dataset); return next;
    });
  }

  history(recordId: string, workspaceId: string): (DataRecord & { historyReason?: string })[] {
    this.getWorkspace(workspaceId);
    const rows = this.db.prepare('SELECT payload,reason FROM record_history WHERE workspace_id=? AND record_id=? ORDER BY version').all(workspaceId, recordId) as { payload: string; reason: string }[];
    const history = rows.map(row => ({ ...JSON.parse(row.payload), historyReason: row.reason }));
    const current = this.get<DataRecord>('records', recordId, workspaceId);
    if (current) history.push({ ...current, historyReason: 'current' });
    return history;
  }
}
