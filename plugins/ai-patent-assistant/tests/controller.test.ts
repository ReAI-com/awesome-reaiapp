import { describe, expect, test } from "bun:test";
import { EmployeeController } from "../src/controller";
import { EmployeeRepository } from "../src/repository";
import { FINANCE_PROFILE, HR_PROFILE } from "../src/profiles";
import { MemoryStore } from "./repository.test";
import { createPageProposal } from "../src/domain";
import { INDEX_KEY } from "../src/repository";

const csv = "日期,收支,对方,金额,说明\n2026-10-08,收入,演示客户,100.25,服务费\n2026-10-08,支出,演示供应商,20.10,办公用品\n";
async function fixture(store = new MemoryStore()) { const controller = new EmployeeController(new EmployeeRepository(store), { defaultProfile: FINANCE_PROFILE }); await controller.init(); return { controller, store }; }

describe("three-stage employee workflow", () => {
  test("a generated role keeps both built-in roles available without unused bootstrap objects", async () => {
    const custom = { ...FINANCE_PROFILE, id: "support", name: "客服工作台", jobTitle: "AI 客服专员" };
    const controller = new EmployeeController(new EmployeeRepository(new MemoryStore()), { defaultProfile: custom }); await controller.init();
    expect(controller.snapshot().profile.id).toBe("support");
    expect(controller.snapshot().availableProfiles.map(profile => profile.id).sort()).toEqual(["finance", "hr", "support"]);
    expect(controller.snapshot().storage.orphanCount).toBe(0);
    await controller.setupPassword("example-password-42"); await controller.switchProfile("finance");
    expect(controller.snapshot().profile.id).toBe("finance");
    await controller.switchProfile("hr"); expect(controller.snapshot().profile.id).toBe("hr");
    await controller.switchProfile("support"); expect(controller.snapshot().profile.id).toBe("support");
  });
  test("stores 128 KiB once and preserves binary originals without claiming extraction", async () => {
    const { controller, store } = await fixture();
    const source = await controller.importBytes({ name: "invoice.pdf", bytes: new Uint8Array(131072).fill(255), mimeType: "application/pdf" });
    const persisted = store.values.get(`raw/${source.id}`) as Record<string, unknown>;
    expect(persisted.text).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(persisted)).length).toBeLessThan(262144);
    expect((await controller.getSource(source.id)).byteLength).toBe(131072);
    expect((await controller.processSource(source.id)).issues.length).toBe(1);
    expect(controller.snapshot().sources[0]?.status).toBe("pending");
  });
  test("imports, cleans, revises, archives and reloads without changing original bytes", async () => {
    const { controller, store } = await fixture();
    const source = await controller.appendText({ name: "ledger.csv", text: csv });
    expect((await controller.processSource(source.id)).createdCount).toBe(2);
    const original = await controller.getSource(source.id); const row = controller.snapshot().records[0]!;
    await controller.editRecord(row.id, { amount: 10100 }, row.revision);
    await controller.archiveRecord(row.id, 2);
    expect(controller.snapshot().records.find(item => item.id === row.id)?.revision).toBe(3);
    expect((await controller.getSource(source.id)).bytesBase64).toBe(original.bytesBase64);
    expect((await controller.getRecordHistory(row.id)).map(item => item.revision)).toEqual([1, 2, 3]);
    const reopened = (await fixture(store)).controller;
    expect(reopened.snapshot().records.length).toBe(2);
    expect(reopened.snapshot().sources[0]?.status).toBe("processed");
    expect(reopened.snapshot().audit.length).toBeGreaterThanOrEqual(3);
  });
  test("same SHA imports once and same-source processing does not duplicate rows", async () => {
    const { controller } = await fixture();
    const source = await controller.appendText({ name: "one.csv", text: csv });
    await controller.appendText({ name: "two.csv", text: csv });
    await controller.processSource(source.id); await controller.processSource(source.id);
    expect(controller.snapshot().sources.length).toBe(1);
    expect(controller.snapshot().records.length).toBe(2);
  });
  test("invalid rows publish no partial standard records", async () => {
    const { controller } = await fixture();
    const source = await controller.appendText({ name: "bad.csv", text: csv + "2026-10-08,收入,甲,bad,x\n" });
    const result = await controller.processSource(source.id);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(controller.snapshot().records).toEqual([]);
    expect(controller.snapshot().sources[0]?.status).toBe("pending");
  });
  test("developer password unlock stays in memory and export contains only role configuration", async () => {
    const { controller, store } = await fixture();
    await expect(controller.saveProfile(FINANCE_PROFILE)).rejects.toThrow();
    await controller.setupPassword("example-password-42"); controller.lock();
    expect(await controller.unlock("wrong-password")).toBe(false);
    expect(await controller.unlock("example-password-42")).toBe(true);
    await controller.switchProfile(HR_PROFILE.id);
    const exported = controller.exportProfile();
    expect(JSON.parse(exported).id).toBe("hr");
    expect(exported).not.toContain("example-password-42");
    expect(exported).not.toContain("sources");
    expect((await fixture(store)).controller.snapshot().developerUnlocked).toBe(false);
  });
  test("a schema change cannot reinterpret existing records", async () => {
    const { controller } = await fixture(); await controller.setupPassword("example-password-42");
    const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    await expect(controller.saveProfile({ ...FINANCE_PROFILE, fields: FINANCE_PROFILE.fields.slice(1) })).rejects.toThrow();
  });
  test("stale record edits fail and reports remain separate derived objects", async () => {
    const { controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    const record = controller.snapshot().records[0]!; await controller.editRecord(record.id, { amount: 1234 }, 1);
    await expect(controller.editRecord(record.id, { amount: 9999 }, 1)).rejects.toThrow();
    const report = await controller.saveReport({ title: "现金流", body: "仅基于示例数据", kind: "demo", sourceIds: [source.id], recordIds: [record.id] });
    expect(controller.snapshot().reports[0]?.id).toBe(report.id);
    expect(controller.snapshot().records.find(item => item.id === record.id)?.values.amount).toBe(1234);
  });
  test("report references preserve prior revisions and reject nonexistent ones", async () => {
    const { controller } = await fixture(); const source = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(source.id);
    const record = controller.snapshot().records[0]!; await controller.editRecord(record.id, { amount: 10000 }, 1);
    const report = await controller.saveReport({ title: "原版本分析", text: "复核原始整理结果", mode: "演示分析·非大模型", sourceIds: [source.id], recordRefs: [{ id: record.id, revision: 1 }] });
    expect(report.recordRefs).toEqual([{ id: record.id, revision: 1 }]);
    await expect(controller.saveReport({ title: "错误引用", body: "错误", recordRefs: [{ id: record.id, revision: 999 }] })).rejects.toThrow();
  });
  test("a queued company change invalidates a report even when its caller observes the prior revision", async () => {
    const { controller } = await fixture();
    const basedOnRevision = controller.snapshot().revision;
    const queuedChange = controller.setCompanySettings({ name: "更新后的示例公司" });
    // The caller can still see the old snapshot while a prior action is queued.
    expect(controller.snapshot().revision).toBe(basedOnRevision);
    const queuedReport = controller.saveReport({ title: "旧配置分析", text: "基于之前的公司要求", basedOnRevision });
    const rejected = expect(queuedReport).rejects.toThrow("重新分析");
    await queuedChange;
    await rejected;
    expect(controller.snapshot().company.name).toBe("更新后的示例公司");
    expect(controller.snapshot().reports).toEqual([]);
    expect(controller.snapshot().storage.orphanCount).toBe(0);
    const latestRevision = controller.snapshot().revision;
    const current = await controller.saveReport({ title: "新配置分析", text: "基于当前公司要求", basedOnRevision: latestRevision });
    expect(current.dataRevision).toBe(latestRevision);
  });
});

const customPage = (id = "invoice-check") => ({ id, title: `核对${id}`, html: '<h2>{{company}}</h2><p>{{missing}}</p><div data-binding="rows"></div>', css: "", bindings: [
  { id: "missing" as const, kind: "count" as const, filters: [{ field: "invoice", operator: "empty" as const }] },
  { id: "rows" as const, kind: "records" as const, columns: ["date", "counterparty", "invoice"], filters: [{ field: "invoice", operator: "empty" as const }] },
] });
describe("confirmed role-isolated HTML pages", () => {
  test("confirmation persists full immutable definition and provenance without developer unlock", async () => {
    const { controller, store } = await fixture(); const before = controller.snapshot();
    const proposal = createPageProposal(customPage(), before, "page-proposal-one");
    const saved = await controller.confirmPageProposal(proposal);
    expect(saved).toMatchObject({ proposalId: "page-proposal-one", profileId: "finance", profileVersion: before.profileVersion, definition: customPage() });
    expect(saved.createdAt).toMatch(/^\d{4}-/);
    expect(controller.snapshot().pages.find(page => page.id === "invoice-check")).toEqual(customPage());
    expect(controller.snapshot().storage.orphanCount).toBe(0);
    expect(store.values.get("page/page-proposal-one")).toEqual(saved);
    const reopened = (await fixture(store)).controller;
    expect(reopened.snapshot().pages.find(page => page.id === "invoice-check")).toEqual(customPage());
    expect(reopened.snapshot().profileVersion).toBe(before.profileVersion);
  });
  test("record and report changes preserve a proposal; profile saves invalidate it", async () => {
    const { controller } = await fixture(); const proposal = createPageProposal(customPage(), controller.snapshot(), "live-data-proposal");
    const raw = await controller.appendText({ name: "ledger.csv", text: csv }); await controller.processSource(raw.id);
    const record = controller.snapshot().records[0]!; await controller.editRecord(record.id, { amount: 12345 }, record.revision);
    await controller.saveReport({ title: "当前数据", body: "保存分析" });
    await expect(controller.confirmPageProposal(proposal)).resolves.toMatchObject({ proposalId: proposal.proposalId });
    const stale = createPageProposal(customPage("stale"), controller.snapshot(), "stale-proposal");
    await controller.setupPassword("example-password-42"); await controller.saveProfile({ ...FINANCE_PROFILE, name: "更新财务示例" });
    await expect(controller.confirmPageProposal(stale)).rejects.toThrow("岗位配置");
    expect(controller.snapshot().pages.some(page => page.id === "stale")).toBe(false);
  });
  test("confirmed proposal is idempotent before stale checks but cannot change its payload", async () => {
    const { controller } = await fixture(); const proposal = createPageProposal(customPage(), controller.snapshot(), "repeated-proposal");
    const saved = await controller.confirmPageProposal(proposal); const revision = controller.snapshot().revision;
    expect(await controller.confirmPageProposal(proposal)).toEqual(saved);
    expect(controller.snapshot().revision).toBe(revision);
    await controller.setupPassword("example-password-42"); await controller.switchProfile("hr");
    expect(await controller.confirmPageProposal(proposal)).toEqual(saved);
    await expect(controller.confirmPageProposal({ ...proposal, definition: { ...proposal.definition, title: "替换" } })).rejects.toThrow();
    expect(controller.snapshot().pages.some(page => page.id === "invoice-check")).toBe(false);
    await controller.switchProfile("finance"); expect(controller.snapshot().pages.some(page => page.id === "invoice-check")).toBe(true);
  });
  test("role changes, name collisions and field-invalid profiles fail before writing", async () => {
    const { controller } = await fixture(); const stale = createPageProposal(customPage(), controller.snapshot(), "switched-proposal");
    await controller.setupPassword("example-password-42"); await controller.switchProfile("hr");
    await expect(controller.confirmPageProposal(stale)).rejects.toThrow(); await controller.switchProfile("finance");
    await controller.confirmPageProposal(createPageProposal(customPage(), controller.snapshot(), "first-collision"));
    await expect(controller.confirmPageProposal(createPageProposal(customPage(), controller.snapshot(), "second-collision"))).rejects.toThrow();
    const withoutInvoice = { ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, dashboard: undefined, pages: undefined }, fields: FINANCE_PROFILE.fields.filter(field => field.key !== "invoice") };
    await expect(controller.saveProfile(withoutInvoice)).rejects.toThrow();
    expect(controller.snapshot().storage.orphanCount).toBe(0);
  });
  test("legacy indexes retain missing pages in CAS and static exports omit user pages", async () => {
    const { controller, store } = await fixture(); const oldIndex = structuredClone(store.values.get(INDEX_KEY)) as Record<string, unknown>; delete oldIndex.pages; await store.set(INDEX_KEY, oldIndex);
    const reopened = (await fixture(store)).controller; expect((store.values.get(INDEX_KEY) as Record<string, unknown>).pages).toBeUndefined();
    await reopened.confirmPageProposal(createPageProposal(customPage(), reopened.snapshot(), "legacy-cas"));
    expect((store.values.get(INDEX_KEY) as Record<string, unknown>).pages).toEqual(["page/legacy-cas"]);
    await reopened.setupPassword("example-password-42");
    expect(reopened.exportProfile()).not.toContain("legacy-cas"); expect(reopened.exportProfile()).not.toContain("invoice-check");
    expect(reopened.snapshot().storage.orphanCount).toBe(0); expect(controller.snapshot().profile.id).toBe("finance");
  });
  test("legacy builtin pages use public examples read-only and custom fields get generic fallback", async () => {
    const { controller, store } = await fixture(); const profileKey = controller.snapshot().profileVersion;
    const version = structuredClone(store.values.get(profileKey)) as { profile: typeof FINANCE_PROFILE }; delete version.profile.ui.dashboard; delete version.profile.ui.pages;
    await store.set(profileKey, version); const rawIndex = JSON.stringify(store.values.get(INDEX_KEY));
    const reopened = (await fixture(store)).controller;
    expect(reopened.snapshot().dashboard.html).toBe(version.profile.ui.html);
    expect(reopened.snapshot().dashboard.bindings.some(binding => binding.kind === "difference")).toBe(true);
    expect(reopened.snapshot().pages.length).toBeGreaterThan(0);
    expect(JSON.stringify(store.values.get(INDEX_KEY))).toBe(rawIndex);
    expect((store.values.get(profileKey) as typeof version).profile.ui.pages).toBeUndefined();
    const custom = { ...FINANCE_PROFILE, id: "support", ui: { ...FINANCE_PROFILE.ui, html: "<p>{{unknownOld}}</p>", dashboard: undefined, pages: undefined }, fields: [{ key: "ticket", label: "工单", type: "text" as const, required: true, aliases: [] }] };
    const generic = new EmployeeController(new EmployeeRepository(new MemoryStore()), { defaultProfile: custom }); await generic.init();
    expect(generic.snapshot().dashboard.html).not.toContain("unknownOld");
    expect(generic.snapshot().dashboard.bindings.some(binding => binding.kind === "records" && binding.columns?.includes("ticket"))).toBe(true);
    expect(generic.snapshot().profile.ui.html).toBe("<p>{{unknownOld}}</p>");
  });
  test("custom-page count has a per-role limit and rejects excess without orphan objects", async () => {
    const { controller } = await fixture();
    for (let i = 0; i < 20; i++) await controller.confirmPageProposal(createPageProposal(customPage(`check-${i}`), controller.snapshot(), `proposal-${i}`));
    await expect(controller.confirmPageProposal(createPageProposal(customPage("excess"), controller.snapshot(), "proposal-excess"))).rejects.toThrow();
    expect(controller.snapshot().pages.filter(page => page.id.startsWith("check-")).length).toBe(20);
    expect(controller.snapshot().storage.orphanCount).toBe(0);
  });
  test("failed index publication cannot expose a page and preserves its residual objects", async () => {
    const { controller, store } = await fixture(); const proposal = createPageProposal(customPage("cas-page"), controller.snapshot(), "page-cas-failed");
    const before = controller.snapshot().revision; store.failIndex = true;
    await expect(controller.confirmPageProposal(proposal)).rejects.toThrow("数据已由另一个页面更新");
    expect(controller.snapshot().revision).toBe(before);
    expect(controller.snapshot().pages.some(page => page.id === "cas-page")).toBe(false);
    expect(store.values.has("page/page-cas-failed")).toBe(true);
    expect(controller.snapshot().storage.orphanCount).toBe(2);
    store.failIndex = false; const reopened = (await fixture(store)).controller;
    expect(reopened.snapshot().pages.some(page => page.id === "cas-page")).toBe(false);
  });
  test("changing default pages cannot collide with a saved page or erase its bindings", async () => {
    const { controller } = await fixture();
    await controller.confirmPageProposal(createPageProposal(customPage(), controller.snapshot(), "preserved-custom-page"));
    await controller.setupPassword("example-password-42"); const before = controller.snapshot().profileVersion;
    await expect(controller.saveProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, pages: [...FINANCE_PROFILE.ui.pages!, customPage()] } })).rejects.toThrow("冲突");
    expect(controller.snapshot().profileVersion).toBe(before);
    expect(controller.snapshot().pages.find(page => page.id === "invoice-check")).toEqual(customPage());
    expect(controller.snapshot().storage.orphanCount).toBe(0);
  });
  test("mixed money and count differences fail before creating a page or audit", async () => {
    const { controller, store } = await fixture(); const before = controller.snapshot(); const keys = [...store.values.keys()];
    const definition = { id: "invalid-unit", title: "错误差额", html: "<p>{{net}}</p>", css: "", bindings: [
      { id: "total", kind: "sum" as const, field: "amount" }, { id: "counted", kind: "count" as const }, { id: "net", kind: "difference" as const, left: "total", right: "counted" },
    ] };
    await expect(controller.confirmPageProposal({ proposalId: "invalid-unit-proposal", profileId: before.profile.id, profileVersion: before.profileVersion, definition })).rejects.toThrow("单位");
    expect(controller.snapshot().revision).toBe(before.revision);
    expect([...store.values.keys()]).toEqual(keys);
    expect(controller.snapshot().pages.some(page => page.id === definition.id)).toBe(false);
  });
});
