import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LocaleClient, LocaleSnapshot } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { DataError, type DataClient, type DataPage, type ProjectRow } from "../src/data-client";
import { mountDataView } from "../src/data-view";
import { createDataFixture } from "./data-fixture";
import { fixtureDevice } from "./device";
GlobalRegistrator.register();
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); document.body.replaceChildren(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const root = () => { const node = document.createElement("div"); document.body.append(node); return node; };
const action = (node: HTMLElement, name: string) => node.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
async function choose(node: HTMLElement) {
  const project = node.querySelector<HTMLInputElement>('[data-field="project"]')!; project.value = "project-a"; project.dispatchEvent(new Event("input"));
  action(node, "load").click(); await tick(); const table = node.querySelector<HTMLSelectElement>('[data-field="collection"]')!;
  table.value = "table-a"; table.dispatchEvent(new Event("change"));
}
const row: ProjectRow = { id: "row-1", project_id: "project-a", collection_id: "table-a", team_id: "team-a", owner_user_id: "user-a", data: { title: "fixture", unchanged: 42 }, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z", deleted_at: null };
const page = (rows = [row]): DataPage => ({ data: rows, total: rows.length, page: 1, pageSize: 5, totalPages: rows.length ? 1 : 0 });
const client = (patch: Partial<DataClient> = {}): DataClient => ({
  collections: async () => [{ key: "table-a", label: "Fixture table", type: "table" }], schema: async () => ({ fields: [] }),
  list: async () => page(), trash: async () => [], count: async () => 1, read: async () => structuredClone(row),
  create: async () => structuredClone(row), update: async () => structuredClone(row), remove: async () => {}, restore: async () => structuredClone(row), ...patch,
});
describe("Surface-owned project data view", () => {
  test("actual default entry install/mount/locale/unmount performs no network and disables cloud actions", async () => {
    const host = new MockHost({ manifest, createRoot: root, loadApp: () => import("../src/app") }); stops.push(() => host.disable());
    await host.installAndEnable(); expect(host.networkRequests).toHaveLength(0);
    const surface = await host.openSurface("main"); const node = surface.root!;
    expect(action(node, "load").disabled).toBe(true); action(node, "load").click();
    host.setLocale("en"); expect(node.textContent).toContain("no OAuth application connected"); expect(host.networkRequests).toHaveLength(0);
    await host.disable(); expect(host.networkRequests).toHaveLength(0); expect(node.childElementCount).toBe(0);
  });
  test("two independent SDK contexts mount UI, share save/reload, delete/trash/restore", async () => {
    const f = createDataFixture(); const a = await fixtureDevice(f, undefined, root); const b = await fixtureDevice(f, undefined, root); stops.push(a.stop, b.stop);
    const an = (await a.host.openSurface("main")).root!; const bn = (await b.host.openSurface("main")).root!;
    await choose(an); await choose(bn);
    an.querySelector<HTMLTextAreaElement>("textarea")!.value = '{"title":"fixture-ui","untouched":42}'; action(an, "save").click(); await tick(); await tick();
    action(bn, "browse").click(); await tick(); expect(bn.textContent).toContain("fixture-ui");
    bn.querySelector<HTMLButtonElement>('[data-row-action="delete"]')!.click(); await tick(); await tick();
    action(an, "trash").click(); await tick(); expect(an.textContent).toContain("fixture-ui");
    an.querySelector<HTMLButtonElement>('[data-row-action="restore"]')!.click(); await tick(); await tick();
    action(bn, "browse").click(); await tick(); expect(bn.textContent).toContain("fixture-ui");
    expect(f.rows.size).toBe(1); expect([...f.rows.values()][0]!.deleted_at).toBeNull();
  });
  test("immediate busy blocks duplicate writes; uncertain outcome needs two reads and explicit acknowledgement", async () => {
    const node = root(); let calls = 0; let release: (row: ProjectRow) => void = () => {};
    stops.push(mountDataView(node, client({ create: async () => { calls++; if (calls === 1) throw new DataError("NETWORK_TIMEOUT", 0, true); return new Promise(resolve => { release = resolve; }); } }), undefined, true));
    await choose(node); action(node, "save").click(); expect(action(node, "save").disabled).toBe(true); action(node, "save").click(); await tick();
    expect(calls).toBe(1); expect(node.textContent).toContain("结果未知"); expect(action(node, "save").disabled).toBe(true);
    expect(action(node, "acknowledge").disabled).toBe(true); action(node, "verify").click(); await tick(); expect(action(node, "acknowledge").disabled).toBe(false);
    action(node, "acknowledge").click(); action(node, "save").click(); action(node, "save").click(); expect(calls).toBe(2); release(row); await tick();
    expect(node.textContent).toContain("已保存记录");
  });
  test("locale changes preserve editor/focus/scroll, empty state, selected collection and network count", async () => {
    const node = root(); let callback: (snapshot: LocaleSnapshot) => void = () => {}; let calls = 0;
    const locale: LocaleClient = { getSnapshot: () => ({ locale: "zh", revision: 0 }), onChange: handler => { callback = handler; return () => {}; } };
    stops.push(mountDataView(node, client({ list: async () => { calls++; return page([]); } }), locale, true)); await choose(node); action(node, "browse").click(); await tick();
    const editor = node.querySelector<HTMLTextAreaElement>("textarea")!; editor.value = '{"draft":"preserve"}'; editor.focus(); editor.setSelectionRange(4, 4);
    const body = node.querySelector<HTMLElement>(".main-body")!; body.scrollTop = 80; callback({ locale: "en", revision: 1 });
    expect(node.querySelector("textarea")).toBe(editor); expect(editor.value).toBe('{"draft":"preserve"}'); expect(document.activeElement).toBe(editor); expect(editor.selectionStart).toBe(4); expect(body.scrollTop).toBe(80);
    expect(node.textContent).toContain("This page has no records"); expect(node.textContent).not.toContain("此页没有记录"); expect(calls).toBe(1);
  });
  test("fresh full JSON edit, safe text rendering, and successful write + failed reload remain distinct", async () => {
    const node = root(); let reads = 0; let written: unknown;
    stops.push(mountDataView(node, client({ list: async () => { if (++reads > 1) throw new DataError("DATA_HTTP_500", 500); return page([{ ...row, data: { title: '<img src=x onerror="alert(1)">' } }]); }, update: async (_selection, _id, value) => { written = value; return { ...row, data: value }; } }), undefined, true));
    await choose(node); action(node, "browse").click(); await tick(); expect(node.querySelector("img")).toBeNull();
    node.querySelector<HTMLButtonElement>('[data-row-action="edit"]')!.click(); await tick();
    expect(JSON.parse(node.querySelector<HTMLTextAreaElement>("textarea")!.value)).toEqual(row.data);
    action(node, "save").click(); await tick(); expect(written).toEqual(row.data); expect(node.textContent).toContain("写入已成功，但重新读取失败");
    expect(action(node, "save").textContent).toContain("保存完整记录");
  });
  test("scope, ACL, KB exclusion and bridge permission failures are localized and never leak raw details", async () => {
    for (const [error, text] of [[new DataError("insufficient_scope", 403), "scope"], [new DataError("DATA_HTTP_404", 404), "无访问权限"], [new DataError("DATA_KB_TABLE_EXCLUDED"), "知识库"], [new DataError("PLUGIN_PERMISSION_DENIED"), "网络权限"]] as const) {
      const node = root(); stops.push(mountDataView(node, client({ list: async () => { throw error; } }), undefined, true)); await choose(node); action(node, "browse").click(); await tick(); expect(node.textContent).toContain(text);
    }
  });
  test("unmount aborts pending call, removes locale listener and ignores late save without follow-up HTTP", async () => {
    const node = root(); let release: (value: ProjectRow) => void = () => {}; let signal: AbortSignal | undefined; let listeners = 0; let reads = 0;
    const locale: LocaleClient = { getSnapshot: () => ({ locale: "en", revision: 0 }), onChange: cb => { listeners++; cb({ locale: "en", revision: 0 }); return () => { listeners--; }; } };
    const stop = mountDataView(node, client({ create: async (_s, _d, s) => { signal = s; return new Promise(resolve => { release = resolve; }); }, list: async () => { reads++; return page(); } }), locale, true);
    await choose(node); action(node, "save").click(); stop(); expect(signal?.aborted).toBe(true); expect(listeners).toBe(0); release(row); await tick(); expect(node.childElementCount).toBe(0); expect(reads).toBe(0);
  });
});
