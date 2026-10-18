import { describe, expect, test } from "bun:test";
import { EmployeeRepository, INDEX_KEY, type StoreLike } from "../src/repository";

export class MemoryStore implements StoreLike {
  values = new Map<string, unknown>();
  reads = new Map<string, number>();
  failIndex = false;
  async get<T>(key: string): Promise<T | undefined> { this.reads.set(key, (this.reads.get(key) ?? 0) + 1); return structuredClone(this.values.get(key)) as T | undefined; }
  async set(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async compareAndSet(key: string, expected: unknown, value: unknown) {
    if (this.failIndex && key === INDEX_KEY) return false;
    if (JSON.stringify(this.values.get(key)) !== JSON.stringify(expected)) return false;
    this.values.set(key, structuredClone(value)); return true;
  }
  async keys() { return [...this.values.keys()]; }
}

describe("CAS publication and physical storage budget", () => {
  test("a failed index CAS leaves a counted orphan and never publishes the object", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    store.failIndex = true;
    await expect(repo.commit(index => ({ index: { ...index, sources: ["sample"] }, objects: [{ key: "raw/sample", value: { text: "retained" } }] }))).rejects.toThrow();
    expect((await repo.loadIndex()).sources).toEqual([]);
    expect((await repo.storageStats()).orphanCount).toBe(1);
    expect((await repo.storageStats()).usedBytes).toBeGreaterThan(0);
  });
  test("immutable keys cannot overwrite different content", async () => {
    const repo = new EmployeeRepository(new MemoryStore()); await repo.initialize();
    await repo.commit(index => ({ index, objects: [{ key: "raw/sample", value: { text: "first" } }] }));
    await expect(repo.commit(index => ({ index, objects: [{ key: "raw/sample", value: { text: "second" } }] }))).rejects.toThrow();
  });
  test("budget refresh reads unknown keys without rescanning existing values", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    const reads = store.reads.get("raw/external") ?? 0;
    await store.set("raw/external", { text: "external" });
    await repo.storageStats(); await repo.storageStats();
    expect(store.reads.get("raw/external")).toBe(reads + 1);
  });
  test("rejects values above the Host limit before writing", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    await expect(repo.commit(index => ({ index, objects: [{ key: "raw/large", value: "a".repeat(262144) }] }))).rejects.toThrow();
    expect(store.values.has("raw/large")).toBe(false);
  });
  test("counts physical residual data against the 24 MiB budget", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    for (let index = 0; index < 128; index++) await store.set(`raw/residual-${index}`, "x".repeat(200000));
    await expect(repo.commit(index => ({ index, objects: [{ key: "raw/new", value: "new" }] }))).rejects.toThrow();
    const stats = await repo.storageStats();
    expect(stats.usedBytes).toBeGreaterThan(stats.budgetBytes);
    expect(stats.orphanCount).toBe(128);
    expect(store.values.has("raw/new")).toBe(false);
  });
  test("corrupt data never becomes a first-install empty index", async () => {
    const store = new MemoryStore(); await store.set(INDEX_KEY, { formatVersion: 99 });
    await expect(new EmployeeRepository(store).initialize()).rejects.toThrow();
    expect(store.values.get(INDEX_KEY)).toEqual({ formatVersion: 99 });
  });
  test("optional pages preserve legacy CAS shape and make retained pages reachable", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    expect((await repo.loadIndex()).pages).toBeUndefined();
    await repo.commit(index => ({ index: { ...index, pages: ["page/example"] }, objects: [{ key: "page/example", value: { definition: { id: "example" } } }] }));
    expect((await repo.loadIndex()).pages).toEqual(["page/example"]);
    expect((await repo.storageStats()).orphanCount).toBe(0);
  });
  test("the global page limit rejects before immutable writes", async () => {
    const store = new MemoryStore(); const repo = new EmployeeRepository(store); await repo.initialize();
    await expect(repo.commit(index => ({ index: { ...index, pages: Array.from({ length: 101 }, (_, i) => `page/${i}`) }, objects: [{ key: "page/excess", value: "never saved" }] }))).rejects.toThrow();
    expect(store.values.has("page/excess")).toBe(false);
  });
});
