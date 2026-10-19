import { describe, expect, test } from "bun:test";
import { HOST_API_VERSION } from "@reai/app-sdk/v1";
import { loadSchema, loadSupportMatrix } from "../src/assets";
import { validateAgainstSchema } from "../src/json-schema";
import { satisfiesHostApiRange } from "../src/validate";

describe("最小 JSON Schema 校验器", () => {
  test("未知字段被点名", () => {
    const violations = validateAgainstSchema(
      { a: 1, b: 2 },
      { type: "object", additionalProperties: false, properties: { a: { type: "integer" } } },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.pointer).toBe("b");
  });

  test("必填字段缺失被点名", () => {
    const violations = validateAgainstSchema(
      {},
      { type: "object", required: ["a"], properties: { a: { type: "string" } } },
    );
    expect(violations[0]?.pointer).toBe("a");
  });

  test("数组下标出现在位置里", () => {
    const violations = validateAgainstSchema(
      { xs: [1, "bad"] },
      { type: "object", properties: { xs: { type: "array", items: { type: "integer" } } } },
    );
    expect(violations[0]?.pointer).toBe("xs[1]");
  });

  test("数组上限与去重约束真实执行", () => {
    const violations = validateAgainstSchema(
      { xs: ["a", "a", "b"] },
      { type: "object", properties: { xs: { type: "array", maxItems: 2, uniqueItems: true } } },
    );
    expect(violations.map((item) => item.message)).toEqual(
      expect.arrayContaining(["最多只能有 2 项", "数组项不能重复"]),
    );
  });

  test("数值上下界真实执行", () => {
    const schema = { type: "integer", minimum: 0, maximum: 10 };
    expect(validateAgainstSchema(-1, schema)[0]?.message).toContain("大于或等于 0");
    expect(validateAgainstSchema(11, schema)[0]?.message).toContain("小于或等于 10");
    expect(validateAgainstSchema(10, schema)).toEqual([]);
  });

  test("不支持的关键字直接报错，而不是当没看见", () => {
    const violations = validateAgainstSchema(
      { a: 5 },
      { type: "object", properties: { a: { type: "integer", multipleOf: 3 } } },
    );
    expect(violations.some((v) => v.message.includes("multipleOf"))).toBe(true);
  });
});

describe("契约资源", () => {
  test("Manifest schema 本身只用支持的关键字", () => {
    // 拿一份必然合法的空对象去跑：任何「关键字不支持」的抱怨都来自 schema 自身。
    const violations = validateAgainstSchema({}, loadSchema());
    expect(violations.filter((v) => v.message.includes("不支持的关键字"))).toEqual([]);
  });

  test("支持矩阵是官方插件档位", () => {
    const matrix = loadSupportMatrix();
    expect(matrix.profile).toBe("official-only");
    // 1.3.0：新增两条云端通道与结果写回。minor bump 是向后兼容的功能新增，
    // 声明 `>=1.1.0 <2.0.0` 的老插件不受影响；而不 bump 的话，新插件没办法用
    // range 表达「我需要带这两条通道的 Host」，装到旧 Host 上只能运行时报未知能力。
    // 1.4.0：新增 system.folder-pick@1，同样是向后兼容的功能新增。
    // 1.5.0：新增 browser.engine@1（内置浏览器引擎窄口），同样向后兼容。
    // 1.6.0：新增 agent.session@1（Pi/DSH 的统一插件会话窄口）。
    // 1.10.0：voice.input@1 新增结果消费确认，同时增加官方 Pi 管理、Codex 与本地文件窄口；
    // Voice 2.12.13 和三个新插件都必须能拒绝旧 Host。
    // 1.12.0：DSH 透明度插件增加只影响新会话的默认模型设置。
    // 1.13.0：新增开发者内置 Audio8 本地 TTS 窄口。
    // 1.14.0：新增有返回值、可取消的 App Service Provider/Consumer 最小子集。
    // 1.23.0：新增 contributes.agentFeatures 与 AgentConfig.featureRef（插件 Agent 配置）。
    expect(matrix.hostApi).toBe(HOST_API_VERSION);
  });
});

describe("Host API SemVer range", () => {
  test("1.2 capability 不会被 1.1 Host 误接纳", () => {
    expect(satisfiesHostApiRange("1.1.0", ">=1.2.0 <2.0.0")).toBeFalse();
    expect(satisfiesHostApiRange("1.2.0", ">=1.2.0 <2.0.0")).toBeTrue();
    expect(satisfiesHostApiRange("1.2.0", ">=1.1.0 <2.0.0")).toBeTrue();
    expect(satisfiesHostApiRange("1.2.0", "1.2.0")).toBeTrue();
    expect(satisfiesHostApiRange("1.2.1", "1.2.0")).toBeFalse();
    expect(satisfiesHostApiRange("1.2.0", "^1.1.0")).toBeTrue();
    expect(satisfiesHostApiRange("1.2.9", "~1.2.0")).toBeTrue();
    expect(satisfiesHostApiRange("1.3.0", "~1.2.0")).toBeFalse();
    expect(satisfiesHostApiRange("0.3.0", "^0.2.0")).toBeFalse();
    expect(satisfiesHostApiRange("1.2.0", ">=1.2")).toBeFalse();
    expect(satisfiesHostApiRange("1.2.0", ">=1.02.0")).toBeFalse();
  });
});
