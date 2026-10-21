import { describe, expect, test } from "bun:test";
import { BAD_SPECS, DEMO_SPEC, LIMITS, parsePageSpec } from "../src/page-spec";
import { safeProbes } from "../src/probes";

const runnable = new Set(safeProbes().map((probe) => probe.id));
const parse = (spec: unknown) => parsePageSpec(JSON.stringify(spec), runnable);

describe("声明式页面 PageSpec v0", () => {
  test("示例页面通过检查", () => {
    const result = parse(DEMO_SPEC);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.components).toHaveLength(DEMO_SPEC.components.length);
  });

  test("四个反例都被拒，并说出原因", () => {
    const reasons = BAD_SPECS.map((bad) => {
      const result = parse(bad.spec);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.problems.map((problem) => `${problem.path} ${problem.reason}`).join("\n");
    });
    expect(reasons[0]).toContain("onClick");
    expect(reasons[1]).toContain("shell.exec");
    expect(reasons[2]).toContain("要连上外脑");
    expect(reasons[3]).toContain("page.");
  });

  test("不是 JSON、太大、组件太多都被拒", () => {
    expect(parsePageSpec("{", runnable).ok).toBe(false);
    expect(parsePageSpec(" ".repeat(LIMITS.jsonBytes + 1), runnable).ok).toBe(false);
    const many = { schemaVersion: 0, title: "多", components: Array.from({ length: LIMITS.components + 1 }, (_, index) => ({ id: `t${index}`, kind: "text", text: "x" })) };
    expect(parse(many).ok).toBe(false);
  });

  test("表单的 fromField 必须指向同一个表单的输入框", () => {
    const spec = { schemaVersion: 0, title: "表单", components: [{ id: "f", kind: "form", label: "表单", submitLabel: "保存", fields: [{ id: "name", label: "名字" }], action: { type: "kv.set", key: "page.x", fromField: "other" } }] };
    const result = parse(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]?.path).toContain("fromField");
  });

  test("只能触发安全探针，不能触发会跳页面或弹通知的探针", () => {
    const button = (probeId: string) => ({ schemaVersion: 0, title: "按钮", components: [{ id: "b", kind: "button", label: "测", action: { type: "probe.run", probeId } }] });
    expect(parse(button("kv-roundtrip")).ok).toBe(true);
    expect(parse(button("system-task-open")).ok).toBe(false);
    expect(parse(button("notify")).ok).toBe(false);
    expect(parse(button("cloud-model")).ok).toBe(false);
  });

  test("id 重复、组件类型不认识都被拒", () => {
    const duplicate = { schemaVersion: 0, title: "重复", components: [{ id: "a", kind: "text", text: "1" }, { id: "a", kind: "text", text: "2" }] };
    expect(parse(duplicate).ok).toBe(false);
    const unknown = { schemaVersion: 0, title: "未知", components: [{ id: "a", kind: "html", html: "<b>x</b>" }] };
    expect(parse(unknown).ok).toBe(false);
  });
});
