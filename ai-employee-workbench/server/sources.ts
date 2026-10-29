import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { SourceFile, SourceRevision, Workspace } from '../shared/types.ts';
import type { Store } from './store.ts';

export const MAX_FILE_SIZE = 30 * 1024 * 1024;
const MAX_TEXT = 160_000;
const skipped = new Set(['.ai-employee', '.git', 'node_modules', '.data', 'dist', '.DS_Store']);
export interface SourceTableRow { source_row: number; source_sheet?: string; values: unknown[] }
export interface ExtractedSource {
  text: string;
  table?: { format: 'csv' | 'tsv' | 'xlsx'; headers: SourceTableRow[]; rows: SourceTableRow[] };
}
const nonemptyCell = (value: unknown) => value != null && (typeof value !== 'string' || !!value.trim());
const lineBreaks = (value: string) => (value.match(/\r\n|\n|\r/g) || []).length;

/** Coverage is deliberately separate from value validation: human review may explain excluded totals. */
export function sourceCoverageIssues(extracted: ExtractedSource, records: Record<string, unknown>[]): string[] {
  if (!extracted.table) return ['此原件无法建立可靠的表格逐行覆盖清单；请核对全文及提取结果后人工确认，不能自动认定完整清洗。'];
  const { rows } = extracted.table;
  if (!rows.length) return ['原件没有可逐行核验的非空数据行，请核对表头与提取结果后人工确认。'];
  const sheets = new Set(rows.map(row => row.source_sheet || ''));
  const onlySheet = sheets.size === 1 ? [...sheets][0] : undefined;
  const anchor = (row: number, sheet: string) => JSON.stringify([sheet, row]);
  const expected = new Map(rows.map(row => [anchor(row.source_row, row.source_sheet || ''), row]));
  const covered = new Set<string>(), issues: string[] = [];
  records.forEach((record, index) => {
    const sheet = typeof record?.source_sheet === 'string' ? record.source_sheet : onlySheet;
    const key = anchor(Number(record?.source_row), sheet || '');
    if (!Number.isSafeInteger(record?.source_row) || sheet === undefined || !expected.has(key)) issues.push(`第${index + 1}条记录引用的来源行/工作表无法在原件数据行中核验`);
    else covered.add(key);
  });
  const missing = [...expected].filter(([key]) => !covered.has(key)).map(([, row]) => `${row.source_sheet ? `「${row.source_sheet}」` : ''}第${row.source_row}行`);
  if (missing.length) issues.push(`原件有${missing.length}个非空数据行未被清洗结果覆盖：${missing.slice(0, 20).join('、')}${missing.length > 20 ? '等' : ''}。汇总、备注或不适用行也需人工核对排除依据，不能自动忽略。`);
  return issues;
}
export function failure(message: string, status = 400): Error & { status: number } { return Object.assign(new Error(message), { status }); }
export function safeName(name: string) {
  const value = path.basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f<>:"|?*]/g, '_').trim();
  if (!value || value === '.' || value === '..') throw failure('文件名无效');
  return value.slice(0, 180);
}
export function inside(root: string, candidate: string) { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }

export class Sources {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private store: Store) {}
  private async serial<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workspaceId) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(workspaceId, next);
    try { return await next; } finally { if (this.locks.get(workspaceId) === next) this.locks.delete(workspaceId); }
  }
  event(file: SourceFile) {
    this.store.put('fileEvents', { id: randomUUID(), workspaceId: file.workspaceId, fileId: file.id, revisionId: file.revisionId, state: file.state, time: new Date().toISOString() });
  }
  setState(file: SourceFile, state: SourceFile['state']) {
    const updated = { ...file, state, updatedAt: new Date().toISOString() };
    this.store.put('files', updated); this.event(updated); return updated;
  }
  async upload(workspaceId: string, name: string, bytes: Buffer) {
    return this.serial(workspaceId, async () => {
      if (bytes.length > MAX_FILE_SIZE) throw failure('单个文件最大 30 MB', 413);
      const workspace = this.store.getWorkspace(workspaceId);
      const id = randomUUID(); const filename = safeName(name);
      const uploadRoot = await this.privateDirectory(workspace, path.join('uploads', id));
      const sourcePath = path.join(uploadRoot, filename);
      const file: SourceFile = { id, workspaceId, name: filename, sourcePath, revisionId: '', hash: '', size: 0, state: '上传', generation: 0, updatedAt: new Date().toISOString() };
      this.store.put('files', file); this.event(file);
      this.setState(file, '上传中');
      try {
        await fs.writeFile(sourcePath, bytes, { flag: 'wx', mode: 0o600 });
        return await this.capture(workspace, sourcePath, bytes, file);
      } catch (error) {
        this.store.put('files', { ...file, state: '上传中', error: `上传失败：${(error as Error).message}`, updatedAt: new Date().toISOString() });
        throw error;
      }
    });
  }
  private async privateDirectory(workspace: Workspace, relative: string) {
    const root = await fs.realpath(workspace.directory);
    const target = path.resolve(root, relative);
    if (!inside(root, target)) throw failure('工作目录路径越界');
    // Check each existing component before mkdir/write: never follow an application-directory symlink.
    let current = root;
    for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try { const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('工作目录中存在不安全的文件或符号链接'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await fs.mkdir(current, { mode: 0o700 }); }
    }
    return target;
  }
  private async capture(workspace: Workspace, sourcePath: string, bytes: Buffer, existing?: SourceFile) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (existing?.hash === hash) return existing;
    const id = existing?.id || randomUUID(); const revisionId = randomUUID();
    const directory = await this.privateDirectory(workspace, path.join('.ai-employee', 'originals', id));
    const originalPath = path.join(directory, revisionId + path.extname(sourcePath).toLowerCase());
    await fs.writeFile(originalPath, bytes, { flag: 'wx', mode: 0o400 });
    const revision: SourceRevision & { workspaceId: string } = { id: revisionId, workspaceId: workspace.id, fileId: id, hash, path: originalPath, size: bytes.length, createdAt: new Date().toISOString() };
    if (!existing) this.store.put('files', { id, workspaceId: workspace.id, name: path.basename(sourcePath), sourcePath, revisionId: '', hash: '', size: 0, state: '上传中', generation: 0, updatedAt: new Date().toISOString() } satisfies SourceFile);
    this.store.put('revisions', revision);
    const latest = this.store.get<SourceFile>('files', id, workspace.id) || existing;
    const file: SourceFile = { id, workspaceId: workspace.id, name: path.basename(sourcePath), sourcePath, revisionId, hash, size: bytes.length, state: latest?.cleanedRevisionId ? '有更新' : '上传完成', generation: (latest?.generation || 0) + 1, cleanedRevisionId: latest?.cleanedRevisionId, updatedAt: new Date().toISOString() };
    this.store.put('files', file); this.event(file); return file;
  }
  async scan(workspaceId: string) {
    return this.serial(workspaceId, async () => {
      const workspace = this.store.getWorkspace(workspaceId); const root = await fs.realpath(workspace.directory);
      const existing = this.store.list<SourceFile>('files', workspaceId);
      const lookup = new Map(existing.filter(f => f.sourcePath).map(f => [f.sourcePath!, f]));
      const imported: SourceFile[] = []; const skippedFiles: { name: string; reason: string }[] = []; let count = 0;
      const walk = async (directory: string, depth: number) => {
        if (depth > 12) return;
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (skipped.has(entry.name) || entry.name.startsWith('.')) continue;
          if (++count > 4000) throw failure('本次扫描最多检查 4,000 个目录项，请选择更具体的工作目录');
          const candidate = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) { skippedFiles.push({ name: entry.name, reason: '不跟随符号链接' }); continue; }
          if (entry.isDirectory()) { await walk(candidate, depth + 1); continue; }
          if (!entry.isFile()) continue;
          try {
            const real = await fs.realpath(candidate); if (!inside(root, real)) throw failure('文件超出工作目录');
            const stat = await fs.stat(real); if (stat.size > MAX_FILE_SIZE) { skippedFiles.push({ name: entry.name, reason: '超过 30 MB' }); continue; }
            const bytes = await fs.readFile(real);
            if (bytes.length > MAX_FILE_SIZE) throw failure('文件超过 30 MB');
            const old = lookup.get(real); const fresh = await this.capture(workspace, real, bytes, old);
            if (fresh.revisionId !== old?.revisionId) imported.push(fresh);
          } catch (error) { skippedFiles.push({ name: entry.name, reason: (error as Error).message }); }
        }
      };
      await walk(root, 0);
      for (const file of existing) {
        if (!file.sourcePath) continue;
        try { await fs.access(file.sourcePath); }
        catch { const current = this.store.require<SourceFile>('files', file.id, workspaceId); this.store.put('files', { ...current, error: '来源文件不存在；已保存的原件与结构化数据仍保留。' }); }
      }
      return { imported, skipped: skippedFiles };
    });
  }
  async extract(workspaceId: string, fileId: string, revisionId: string): Promise<string> {
    return (await this.extractWithCoverage(workspaceId, fileId, revisionId)).text;
  }
  async extractWithCoverage(workspaceId: string, fileId: string, revisionId: string): Promise<ExtractedSource> {
    const file = this.store.require<SourceFile>('files', fileId, workspaceId);
    const revision = this.store.require<SourceRevision>('revisions', revisionId, workspaceId);
    if (revision.fileId !== file.id) throw failure('原件版本与文件不匹配');
    const bytes = await fs.readFile(revision.path);
    if (createHash('sha256').update(bytes).digest('hex') !== revision.hash) throw failure('原件指纹校验失败，请重新导入');
    let text = ''; let table: ExtractedSource['table']; const extension = path.extname(file.name).toLowerCase();
    if (['.csv', '.tsv'].includes(extension)) {
      const parsed = parse(bytes, { bom: true, skip_empty_lines: true, info: true, delimiter: extension === '.tsv' ? '\t' : ',' }) as unknown as { record: string[]; info: { bytes: number } }[];
      let consumedBytes = 0, nextLine = 1;
      const indexed = parsed.map(item => {
        // Parser byte positions retain blank lines, Unicode and quoted multiline cells exactly.
        const chunk = bytes.subarray(consumedBytes, item.info.bytes).toString('utf8');
        const leading = chunk.match(/^(?:\uFEFF)?(?:\r\n|\n|\r)*/)?.[0] || '';
        const row = { source_row: nextLine + lineBreaks(leading), values: item.record };
        nextLine += lineBreaks(chunk); consumedBytes = item.info.bytes;
        return row;
      });
      const header = indexed[0]; const names = (header?.values || []).map(name => String(name).trim());
      if (names.some(name => !name) || new Set(names).size !== names.length) throw failure('CSV/TSV 表头为空或存在重名字段；为避免丢失内容，请修正表头后重新导入。');
      text = JSON.stringify(indexed.slice(1).map(row => Object.fromEntries(names.map((name, index) => [name, row.values[index]]))));
      table = { format: extension === '.tsv' ? 'tsv' : 'csv', headers: header ? [header] : [], rows: indexed.slice(1).filter(row => row.values.some(nonemptyCell)) };
    }
    else if (extension === '.xlsx') {
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes as never);
      const sheets: Record<string, unknown[][]> = Object.create(null);
      table = { format: 'xlsx', headers: [], rows: [] };
      for (const sheet of workbook.worksheets) {
        const rows: unknown[][] = [];
        const indexed: SourceTableRow[] = [];
        sheet.eachRow(row => {
          const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cell => cell && typeof cell === 'object' && 'result' in cell && cell.result !== undefined ? cell.result : cell);
          rows.push(values);
          if (values.some(nonemptyCell)) indexed.push({ source_sheet: sheet.name, source_row: row.number, values });
        });
        if (indexed.length) { table.headers.push(indexed[0]); table.rows.push(...indexed.slice(1)); }
        sheets[sheet.name] = rows;
      }
      text = JSON.stringify(sheets);
    } else if (extension === '.docx') text = (await mammoth.extractRawText({ buffer: bytes })).value;
    else if (extension === '.pdf') {
      const parser = new PDFParse({ data: bytes });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (['.txt', '.md', '.json', '.jsonl', '.html', '.htm', '.xml', '.yaml', '.yml', '.log'].includes(extension)) text = bytes.toString('utf8');
    else throw failure('原件已保存。当前自动清洗支持 CSV、TSV、JSON、文本、XLSX、DOCX 和有文本的 PDF；图片和扫描件需要先提供 OCR 文本。');
    if (!text.trim() || text.includes('\u0000')) throw failure('未提取到可用文本；扫描件请先提供 OCR 文本。');
    if (text.length > MAX_TEXT) throw failure('提取内容超过 160,000 字符，请按业务批次拆分后清洗；未截断或发布部分数据。');
    return { text, table };
  }
}
