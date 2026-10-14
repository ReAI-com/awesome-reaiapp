import { describe, expect, test } from "bun:test";
import { cleanSource, createRawSource, LIMITS, parseMoney, validateHtmlPage, validateProfile, validateRecordValues, type EmployeeHtmlPage } from "../src/domain";
import { FINANCE_PROFILE, HR_PROFILE } from "../src/profiles";

describe("immutable sources and role schemas", () => {
  test("hash identifies the original bytes independently of the filename", async () => {
    const bytes = new TextEncoder().encode("日期,金额\r\n2026-10-08,10.25\r\n");
    const first = await createRawSource({ name: "a.csv", bytes }, "2026-10-08T00:00:00Z");
    const second = await createRawSource({ name: "b.csv", bytes }, "2026-10-08T00:00:01Z");
    expect(first.id).toBe(second.id);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.text).toContain("\r\n");
    expect(first.byteLength).toBe(bytes.byteLength);
  });
  test("rejects originals above 128 KiB and invalid UTF-8", async () => {
    await expect(createRawSource({ name: "huge.csv", bytes: new Uint8Array(131073) }, "now")).rejects.toThrow();
    await expect(createRawSource({ name: "bad.csv", bytes: new Uint8Array([0xff]) }, "now")).rejects.toThrow();
  });
  test("CSV handles aliases, quoted commas and currency in integer cents", () => {
    const result = cleanSource('日期,收支,对方,金额,说明\r\n2026-10-08,支出,"甲,乙",12.30,"办公用品"\r\n', "a.csv", FINANCE_PROFILE);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]?.values).toMatchObject({ date: "2026-10-08", direction: "支出", counterparty: "甲,乙", amount: 1230 });
  });
  test("JSON uses the HR schema and rejects malformed dates", () => {
    const result = cleanSource(JSON.stringify([{ date: "2026-10-08", name: "示例员工", department: "产品", position: "经理", status: "在职", salary: "100.01" }]), "a.json", HR_PROFILE);
    expect(result.rows[0]?.values.salary).toBe(10001);
    expect(cleanSource('日期,收支,对方,金额\n2026-02-30,收入,甲,1\n', "bad.csv", FINANCE_PROFILE).issues.length).toBeGreaterThan(0);
  });
  test("rejects unknown data fields and keeps invalid rows visible as issues", () => {
    expect(cleanSource('日期,收支,对方,金额\n2026-10-08,收入,甲,NaN\n', "bad.csv", FINANCE_PROFILE).issues[0]?.field).toBe("amount");
    expect(() => validateRecordValues({ ...{ date: "2026-10-08", direction: "收入", counterparty: "甲", amount: 100 }, secret: "x" }, FINANCE_PROFILE)).toThrow();
  });
  test("money conversion does not round away hidden precision", () => {
    expect(parseMoney("0.29")).toBe(29);
    expect(parseMoney("1,234.56")).toBe(123456);
    expect(() => parseMoney("1.005")).toThrow();
    expect(() => parseMoney("-1")).toThrow();
    expect(() => parseMoney("1e5")).toThrow();
  });
  test("individual money amounts reserve safe precision for 1000-record aggregates", () => {
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / LIMITS.records);
    const values = { date: "2026-10-08", direction: "收入", counterparty: "甲", amount: maximum };
    expect(validateRecordValues(values, FINANCE_PROFILE).amount).toBe(maximum);
    expect(() => validateRecordValues({ ...values, amount: maximum + 1 }, FINANCE_PROFILE)).toThrow();
    expect(() => parseMoney(((maximum + 1) / 100).toFixed(2))).toThrow();
  });
  test("profile import rejects secrets, duplicate fields and active UI content", () => {
    expect(validateProfile(FINANCE_PROFILE).id).toBe("finance");
    expect(() => validateProfile({ ...FINANCE_PROFILE, password: "private" })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, fields: [...FINANCE_PROFILE.fields, FINANCE_PROFILE.fields[0]] })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, css: "@import 'https://example.com/x.css';" } })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, css: ".role-summary { position: fixed; }" } })).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, html: '<img src=x onerror="alert(1)">' } })).toThrow();
  });
  test("the read-only Demo rejects tool references that it cannot execute", () => {
    expect(() => validateProfile({ ...FINANCE_PROFILE, agent: { ...FINANCE_PROFILE.agent, tools: ["write"] } })).toThrow();
  });
  test("skill documents share the Host aggregate character budget", () => {
    const profile = { ...FINANCE_PROFILE, agent: { ...FINANCE_PROFILE.agent, skills: [
      { id: "first", title: "First", content: "a".repeat(16384) },
      { id: "second", title: "Second", content: "b".repeat(16384) },
    ] } };
    expect(validateProfile(profile).agent.skills.length).toBe(2);
    profile.agent.skills[1]!.content += "b";
    expect(() => validateProfile(profile)).toThrow("skill正文总量");
  });
});

const page = (): EmployeeHtmlPage => ({ id: "invoice-check", title: "发票核对", html: '<section><h2>{{company}}</h2><p>{{missing}}</p><div data-binding="rows"></div></section>', css: "", bindings: [
  { id: "missing", kind: "count", filters: [{ field: "invoice", operator: "empty" }] },
  { id: "rows", kind: "records", columns: ["counterparty", "invoice"], filters: [{ field: "invoice", operator: "empty" }] },
] });
describe("declarative employee HTML pages", () => {
  test("validates typed bindings and optional static profile pages", () => {
    expect(validateHtmlPage(page(), FINANCE_PROFILE)).toEqual(page());
    const profile = { ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, dashboard: { ...page(), id: "dashboard", title: "Dashboard" }, pages: [page()] } };
    expect(validateProfile(profile).ui.pages?.[0]?.id).toBe("invoice-check");
    expect(() => validateProfile({ ...profile, ui: { ...profile.ui, dashboard: { ...profile.ui.dashboard, id: "custom-dashboard" } } })).toThrow("dashboard");
  });
  test("rejects reserved IDs, unknown fields, untyped filters and unknown configuration", () => {
    for (const id of ["dashboard", "overview", "sources", "records", "reports", "settings"]) expect(() => validateHtmlPage({ ...page(), id }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), bindings: [{ id: "missing", kind: "sum", field: "secret" }] }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), bindings: [{ id: "missing", kind: "count", filters: [{ field: "amount", operator: "gte", value: "12" }] }] }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), private: "secret" }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), bindings: [{ id: "rows", kind: "reports", filters: [] }] }, FINANCE_PROFILE)).toThrow();
  });
  test("rejects undeclared placeholders, attribute interpolation and occupied list slots", () => {
    for (const html of ['<p>{{unknown}}</p>', '<p title="{{company}}">x</p>', '<div data-binding="rows">untrusted child</div>', '<div data-binding="missing"></div>']) expect(() => validateHtmlPage({ ...page(), html }, FINANCE_PROFILE)).toThrow();
  });
  test("difference refers to base scalar bindings only", () => {
    const value = { id: "cash", title: "收支", html: '<p>{{net}}</p>', css: "", bindings: [{ id: "income", kind: "sum", field: "amount" }, { id: "expense", kind: "sum", field: "amount" }, { id: "net", kind: "difference", left: "income", right: "expense" }] };
    expect(validateHtmlPage(value, FINANCE_PROFILE).bindings[2]?.kind).toBe("difference");
    expect(() => validateHtmlPage({ ...value, bindings: [...value.bindings, { id: "cycle", kind: "difference", left: "net", right: "income" }] }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...value, bindings: [value.bindings[0], value.bindings[1], { ...value.bindings[2], field: "amount" }] }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...value, bindings: [value.bindings[0], { id: "expense", kind: "count" }, value.bindings[2]] }, FINANCE_PROFILE)).toThrow("单位");
  });
  test("bounds page definitions and profile page counts before storage", () => {
    expect(() => validateHtmlPage({ ...page(), html: '<p>' + "x".repeat(16385) + '</p>' }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), bindings: Array.from({ length: 17 }, (_, i) => ({ id: `metric_${i}`, kind: "count" })) }, FINANCE_PROFILE)).toThrow();
    expect(() => validateHtmlPage({ ...page(), bindings: [{ id: "missing", kind: "count", filters: Array.from({ length: 9 }, () => ({ field: "invoice", operator: "empty" })) }] }, FINANCE_PROFILE)).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, pages: Array.from({ length: 13 }, (_, i) => ({ ...page(), id: `page-${i}`, title: `页面${i}` })) } })).toThrow();
  });
  test("the page title cannot impersonate a fixed navigation entry", () => {
    for (const title of ["Dashboard", "设置", "上传资料", "总体看板", "资料上传"]) expect(() => validateHtmlPage({ ...page(), title }, FINANCE_PROFILE)).toThrow();
    expect(() => validateProfile({ ...FINANCE_PROFILE, ui: { ...FINANCE_PROFILE.ui, pages: [{ ...page(), title: "Dashboard" }] } })).toThrow();
  });
  test("typed comparisons reject invalid dates, numeric contains, null ranges and difference chains", () => {
    const binding = (field: string, operator: string, value?: unknown) => ({ id: "missing", kind: "count", filters: [{ field, operator, value }] });
    for (const item of [binding("date", "gte", "2026-02-30"), binding("amount", "contains", "12"), binding("amount", "gte", null), binding("direction", "eq", "未知"), binding("amount", "eq", NaN)]) expect(() => validateHtmlPage({ ...page(), html: "<p>{{missing}}</p>", bindings: [item] }, FINANCE_PROFILE)).toThrow();
    expect(validateHtmlPage({ ...page(), html: "<p>{{missing}}</p>", bindings: [binding("date", "gte", "2026-10-08")] }, FINANCE_PROFILE).bindings[0]?.filters?.[0]?.value).toBe("2026-10-08");
  });
});
