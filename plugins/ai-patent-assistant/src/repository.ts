import { clone, jsonBytes, LIMITS, reject, type StorageStats } from "./domain";
export interface StoreLike { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>; keys(): Promise<string[]> }
export interface RepositoryIndex { formatVersion: 1; revision: number; activeProfileId: string; profiles: Record<string, string>; companyKey: string; guardKey?: string; sources: string[]; records: Record<string, { key: string; revision: number; profileId: string }>; reports: string[]; pages?: string[]; audits: string[]; processed: Record<string, string[]> }
export interface ImmutableObject { key: string; value: unknown }
export const INDEX_KEY = "index-v1";
function emptyIndex(): RepositoryIndex { return { formatVersion: 1, revision: 0, activeProfileId: "", profiles: {}, companyKey: "", sources: [], records: {}, reports: [], audits: [], processed: {} }; }
function validIndex(input: unknown): RepositoryIndex {
  if (!input || typeof input !== "object" || (input as RepositoryIndex).formatVersion !== 1 || !Number.isSafeInteger((input as RepositoryIndex).revision)) reject("STORE_CORRUPT", "数据索引无效，请保留原数据并联系开发者");
  const value = input as RepositoryIndex;
  if (!value.profiles || !value.records || !value.processed || !Array.isArray(value.sources) || !Array.isArray(value.reports) || !Array.isArray(value.audits) || typeof value.companyKey !== "string") reject("STORE_CORRUPT", "数据索引缺少必要字段");
  if (value.pages !== undefined && (!Array.isArray(value.pages) || value.pages.some(key => typeof key !== "string" || !/^page\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(key) || key.includes("..")) || new Set(value.pages).size !== value.pages.length)) reject("STORE_CORRUPT", "页面索引无效");
  return clone(value);
}
export class EmployeeRepository {
  private cached = new Map<string, unknown>();
  private sizes = new Map<string, number>();
  private initialized = false;
  private index = emptyIndex();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: StoreLike) {}
  private remember(key: string, value: unknown) { this.cached.set(key, clone(value)); this.sizes.set(key, jsonBytes(value) + new TextEncoder().encode(key).length); }
  private async discover() {
    const keys = await this.store.keys();
    const missing = keys.filter(key => !this.sizes.has(key));
    for (let offset = 0; offset < missing.length; offset += 8) await Promise.all(missing.slice(offset, offset + 8).map(async key => { const value = await this.store.get(key); if (value === undefined) reject("STORE_CORRUPT", "存储清单引用了不存在的对象"); this.remember(key, value); }));
    for (const key of this.sizes.keys()) if (!keys.includes(key)) { this.sizes.delete(key); this.cached.delete(key); }
  }
  async initialize(): Promise<RepositoryIndex> {
    if (this.initialized) return this.loadIndex();
    await this.discover(); const existing = await this.store.get(INDEX_KEY);
    if (existing === undefined) {
      if (this.cached.size) reject("STORE_CORRUPT", "存在数据但缺少索引，不能按首次安装覆盖");
      const fresh = emptyIndex(); const saved = await this.store.compareAndSet(INDEX_KEY, undefined, fresh);
      const current = saved ? fresh : await this.store.get(INDEX_KEY); this.index = validIndex(current); this.remember(INDEX_KEY, current);
    } else { this.index = validIndex(existing); this.remember(INDEX_KEY, existing); }
    this.initialized = true; return clone(this.index);
  }
  async loadIndex(): Promise<RepositoryIndex> {
    if (!this.initialized) return this.initialize(); const current = await this.store.get(INDEX_KEY); this.index = validIndex(current); this.remember(INDEX_KEY, current); return clone(this.index);
  }
  async readObject<T>(key: string): Promise<T> {
    if (!this.initialized) await this.initialize();
    if (!this.cached.has(key)) { const value = await this.store.get<T>(key); if (value === undefined) reject("STORE_CORRUPT", `索引引用的对象不存在：${key}`); this.remember(key, value); }
    return clone(this.cached.get(key)) as T;
  }
  private reachable(): Set<string> {
    const active = new Set<string>([INDEX_KEY, this.index.companyKey, ...Object.values(this.index.profiles), ...this.index.sources.map(id => `raw/${id}`), ...this.index.reports, ...(this.index.pages ?? []), ...this.index.audits, ...Object.values(this.index.records).map(ref => ref.key)]);
    if (this.index.guardKey) active.add(this.index.guardKey);
    // Version objects retain their prior versions through previousKey.
    const pending = [...active]; while (pending.length) { const value = this.cached.get(pending.pop()!); if (value && typeof value === "object") { const previous = (value as { previousKey?: unknown }).previousKey; if (typeof previous === "string" && !active.has(previous)) { active.add(previous); pending.push(previous); } } }
    active.delete(""); return active;
  }
  async storageStats(): Promise<StorageStats> {
    if (!this.initialized) await this.initialize(); await this.discover(); const active = this.reachable(); let usedBytes = 0; let orphanBytes = 0; let orphanCount = 0;
    for (const [key, size] of this.sizes) { usedBytes += size; if (!active.has(key)) { orphanCount++; orphanBytes += size; } }
    return { usedBytes, budgetBytes: LIMITS.storageBytes, orphanCount, orphanBytes };
  }
  commit(mutate: (index: RepositoryIndex) => { index: RepositoryIndex; objects: ImmutableObject[] }): Promise<RepositoryIndex> {
    const operation = this.tail.then(async () => {
      const expected = await this.loadIndex(); await this.discover(); const transaction = mutate(clone(expected)); const next = validIndex({ ...transaction.index, revision: expected.revision + 1 });
      if (next.sources.length > LIMITS.sources || Object.keys(next.records).length > LIMITS.records || next.reports.length > LIMITS.reports || (next.pages?.length ?? 0) > LIMITS.customPages) reject("DATA_LIMIT", "资料、记录、报表或页面数量达到Demo上限");
      if (jsonBytes(next) > LIMITS.valueBytes) reject("VALUE_LIMIT", "数据索引超出256 KiB，请生成独立岗位插件");
      const newObjects = new Map<string, unknown>();
      for (const object of transaction.objects) {
        if (!/^[a-z0-9/._-]{1,200}$/i.test(object.key) || object.key === INDEX_KEY || object.key.includes("..")) reject("INVALID_OBJECT_KEY", "对象键无效");
        if (jsonBytes(object.value) > LIMITS.valueBytes) reject("VALUE_LIMIT", "存储对象超出256 KiB");
        if (newObjects.has(object.key) && JSON.stringify(newObjects.get(object.key)) !== JSON.stringify(object.value)) reject("IMMUTABLE_CONFLICT", "同一对象键包含不同内容");
        if (this.cached.has(object.key)) { if (JSON.stringify(this.cached.get(object.key)) !== JSON.stringify(object.value)) reject("IMMUTABLE_CONFLICT", "不可覆盖既有事实或版本"); } else newObjects.set(object.key, object.value);
      }
      const physical = [...this.sizes.values()].reduce((sum, size) => sum + size, 0); const addition = [...newObjects.entries()].reduce<number>((sum, [key, value]) => sum + jsonBytes(value) + new TextEncoder().encode(key).length, 0);
      if (physical + addition + Math.max(0, jsonBytes(next) - (this.sizes.get(INDEX_KEY) ?? 0)) > LIMITS.storageBytes) reject("STORAGE_BUDGET", "本地24 MiB预算已满，未删除任何资料");
      for (const [key, value] of newObjects) {
        const created = await this.store.compareAndSet(key, undefined, value);
        if (!created) { const existing = await this.store.get(key); if (existing !== undefined) this.remember(key, existing); if (JSON.stringify(existing) !== JSON.stringify(value)) reject("IMMUTABLE_CONFLICT", "另一个页面已写入不同对象"); }
        else this.remember(key, value);
      }
      const committed = await this.store.compareAndSet(INDEX_KEY, expected, next);
      if (!committed) { await this.loadIndex(); reject("INDEX_CONFLICT", "数据已由另一个页面更新。本次版本未发布，请刷新后重试"); }
      this.index = next; this.remember(INDEX_KEY, next); return clone(next);
    }); this.tail = operation.catch(() => undefined); return operation;
  }
}
