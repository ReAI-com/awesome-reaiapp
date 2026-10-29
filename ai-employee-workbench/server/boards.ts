import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Board, BoardRevision, Dataset } from '../shared/types.ts';
import { Store, storeError } from './store.ts';

const now = () => new Date().toISOString();
export const boardVersion = (board: Board) => board.version ?? 1;
export function validateBoardHtml(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/<html[\s>]/i.test(value) || !/<\/html\s*>/i.test(value) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 800_000) {
    throw storeError(400, '看板必须是完整 HTML，且不能超过 800 KB');
  }
}
const title = (value: unknown, fallback: string) => {
  const name = value === undefined ? fallback : value;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw storeError(400, '看板名称必须为 1–100 个字符');
  return name.trim();
};
const description = (value: unknown, fallback: string) => {
  const text = value === undefined ? fallback : value;
  if (typeof text !== 'string' || text.length > 500) throw storeError(400, '看板说明不能超过 500 个字符');
  return text;
};

/** Immutable artifacts plus a transactional current-version pointer. No caller-selected paths. */
export class BoardService {
  constructor(private store: Store, private dataDir: string) {}
  require(workspaceId: string, boardId: string) { return this.store.require<Board>('boards', boardId, workspaceId); }
  assertVersion(board: Board, expected: unknown) {
    if (!Number.isSafeInteger(expected) || Number(expected) < 1) throw storeError(400, '请提供有效的看板版本');
    if (boardVersion(board) !== expected) throw storeError(409, '看板已更新，请刷新后再保存；本次内容没有覆盖新版');
  }
  private checkedPath(workspaceId: string, boardId: string, filename: string) {
    const root = path.resolve(this.dataDir, 'boards', workspaceId, boardId), candidate = path.resolve(filename);
    const relative = path.relative(root, candidate);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw storeError(400, '看板产物路径无效');
    return candidate;
  }
  async html(board: Board | BoardRevision) { return readFile(this.checkedPath(board.workspaceId, 'boardId' in board ? board.boardId : board.id, board.htmlPath), 'utf8'); }
  async source(workspaceId: string, boardId: string) {
    const board = this.require(workspaceId, boardId);
    return { html: await this.html(board), name: board.name, description: board.description, datasetIds: board.datasetIds, version: boardVersion(board) };
  }
  private datasets(workspaceId: string, ids: unknown): string[] {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw storeError(400, '看板必须绑定有效数据表');
    for (const id of ids) this.store.require<Dataset>('datasets', id, workspaceId);
    return [...new Set(ids)];
  }
  private async artifact(workspaceId: string, boardId: string, version: number, html: string) {
    const directory = path.resolve(this.dataDir, 'boards', workspaceId, boardId, 'versions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, `v${version}-${randomUUID()}.html`);
    await writeFile(filename, html, { flag: 'wx', mode: 0o400 });
    return filename;
  }
  private revision(board: Board, htmlPath: string, source: BoardRevision['source'], options: { runId?: string; restoredFrom?: number } = {}): BoardRevision {
    return { id: `${board.id}:v${boardVersion(board)}`, workspaceId: board.workspaceId, boardId: board.id, version: boardVersion(board), name: board.name, description: board.description, prompt: board.prompt, htmlPath, datasetIds: [...board.datasetIds], createdAt: board.updatedAt || board.createdAt, source, ...options };
  }
  private transaction<T>(action: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.store.db.exec('COMMIT'); return result; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  async create(workspaceId: string, input: { name?: unknown; description?: unknown; prompt: string; html: unknown; datasetIds: unknown; runId?: string }, beforePublish?: () => void) {
    this.store.getWorkspace(workspaceId); validateBoardHtml(input.html);
    const datasetIds = this.datasets(workspaceId, input.datasetIds), name = title(input.name, '新看板'), desc = description(input.description, ''), id = randomUUID(), timestamp = now();
    const htmlPath = await this.artifact(workspaceId, id, 1, input.html);
    const board: Board = { id, workspaceId, name, description: desc, prompt: input.prompt, status: 'draft', htmlPath, token: randomUUID() + randomUUID(), datasetIds, createdAt: timestamp, updatedAt: timestamp, version: 1 };
    try {
      return this.transaction(() => { beforePublish?.(); this.store.put('boards', board); this.store.put('boardVersions', this.revision(board, htmlPath, 'generated', { runId: input.runId })); return board; });
    } catch (error) { await rm(htmlPath, { force: true }); throw error; }
  }
  versions(workspaceId: string, boardId: string) {
    const board = this.require(workspaceId, boardId);
    const versions = this.store.list<BoardRevision>('boardVersions', workspaceId).filter(item => item.boardId === boardId);
    if (!versions.some(item => item.version === boardVersion(board))) versions.push(this.revision(board, board.htmlPath, 'legacy'));
    return versions.sort((a, b) => b.version - a.version).map(({ version, name, description, createdAt, source, runId, restoredFrom }) => ({ version, name, description, createdAt, source, ...(runId ? { runId } : {}), ...(restoredFrom ? { restoredFrom } : {}) }));
  }
  async save(workspaceId: string, boardId: string, input: { version: unknown; html: unknown; name?: unknown; description?: unknown; datasetIds?: unknown; prompt?: string; source?: BoardRevision['source']; runId?: string; restoredFrom?: number }, beforePublish?: () => void) {
    const original = this.require(workspaceId, boardId); this.assertVersion(original, input.version); validateBoardHtml(input.html);
    const name = title(input.name, original.name), desc = description(input.description, original.description);
    const datasetIds = this.datasets(workspaceId, input.datasetIds ?? original.datasetIds);
    const version = boardVersion(original) + 1;
    const pending: string[] = [];
    try {
      let legacy: BoardRevision | undefined;
      if (!this.store.get('boardVersions', `${boardId}:v${boardVersion(original)}`, workspaceId)) {
        const oldPath = await this.artifact(workspaceId, boardId, boardVersion(original), await this.html(original)); pending.push(oldPath);
        legacy = this.revision(original, oldPath, 'legacy');
      }
      const htmlPath = await this.artifact(workspaceId, boardId, version, input.html); pending.push(htmlPath);
      return this.transaction(() => {
        const current = this.require(workspaceId, boardId); this.assertVersion(current, input.version); beforePublish?.();
        const next: Board = { ...current, name, description: desc, datasetIds, prompt: input.prompt ?? current.prompt, htmlPath, version, updatedAt: now() };
        if (legacy) this.store.put('boardVersions', legacy);
        this.store.put('boardVersions', this.revision(next, htmlPath, input.source || 'manual', { runId: input.runId, restoredFrom: input.restoredFrom }));
        this.store.put('boards', next);
        return next;
      });
    } catch (error) { await Promise.allSettled(pending.map(filename => rm(filename, { force: true }))); throw error; }
  }
  async restore(workspaceId: string, boardId: string, expectedVersion: unknown, targetVersion: unknown) {
    const board = this.require(workspaceId, boardId); this.assertVersion(board, expectedVersion);
    if (!Number.isSafeInteger(targetVersion) || Number(targetVersion) < 1) throw storeError(400, '请提供有效的历史版本');
    const target = this.store.get<BoardRevision>('boardVersions', `${boardId}:v${targetVersion}`, workspaceId)
      ?? (targetVersion === boardVersion(board) ? this.revision(board, board.htmlPath, 'legacy') : undefined);
    if (!target || target.boardId !== boardId) throw storeError(404, '历史版本不存在');
    return this.save(workspaceId, boardId, { version: expectedVersion, html: await this.html(target), name: target.name, description: target.description, datasetIds: target.datasetIds, prompt: target.prompt, source: 'restore', restoredFrom: Number(targetVersion) });
  }
}

export function publicBoard(board: Board) { const { token: _token, htmlPath: _path, ...result } = board; return { ...result, version: boardVersion(board) }; }
