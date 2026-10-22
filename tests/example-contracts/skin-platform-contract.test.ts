/**
 * Skin v1 开发期校验的插件半（原 tests/repo-contracts/skin-platform-contract.test.ts 拆分）。
 *
 * 原合同用平台 CLI 的 validateSkinDefinition 校验两套外部 demo。插件半不 import CLI 源码，改为：
 * 用 @reai/app-contract 的 skin-v1.schema.json 做结构校验（下面的小型校验器只覆盖该 schema 用到的关键字），
 * 再按 CLI 同口径核对 light / dark 两套 token 完整且只覆盖公开 token（清单经 合同包 host-commitments-v1.json 的 themeTokens 镜像，
 * Host 半断言 CLI SKIN_TOKEN_NAMES 与同一清单一致，需要以后进合同包），并逐值拒绝不安全样式。
 * 「CLI 会拒绝缺 token / 危险 url / 未知字段 / 扩张数据边界的 manifest」是 CLI 行为，归 Host 半。
 */
import { describe, expect, test } from "bun:test";
import skinSchema from "@reai/app-contract/schemas/skin-v1.schema.json";

import hostCommitments from "@reai/app-contract/host-commitments-v1.json";

const theme = hostCommitments.themeTokens;
import { exampleJson, exampleManifest } from "./support/paths";

type Schema = Record<string, any>;

/** 只实现 skin-v1.schema.json 用到的关键字；遇到未知关键字直接报错，避免 schema 演进后静默放行。 */
const SUPPORTED = new Set([
  "$schema", "$id", "title", "type", "additionalProperties", "required", "properties", "const", "enum",
  "minLength", "maxLength", "minimum", "maximum", "items", "minItems", "maxItems", "uniqueItems",
]);

function schemaViolations(value: unknown, schema: Schema, pointer = ""): string[] {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`schema 关键字未被插件半校验器支持：${key}`);
  }
  const out: string[] = [];
  const at = pointer || "<root>";
  const type = schema.type;
  if (type !== undefined && !["object", "array", "string", "integer"].includes(type)) {
    throw new Error(`schema 类型未被插件半校验器支持：${JSON.stringify(type)}`);
  }
  if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at}: 应为 object`];
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) out.push(`${at}: 缺少 ${key}`);
    for (const [key, child] of Object.entries(record)) {
      const next = pointer ? `${pointer}.${key}` : key;
      if (schema.properties?.[key]) out.push(...schemaViolations(child, schema.properties[key], next));
      else if (schema.additionalProperties === false) out.push(`${next}: 未知字段`);
    }
    return out;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: 应为 array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: 少于 ${schema.minItems} 项`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: 多于 ${schema.maxItems} 项`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) out.push(`${at}: 有重复项`);
    if (schema.items) value.forEach((item, index) => out.push(...schemaViolations(item, schema.items, `${at}[${index}]`)));
    return out;
  }
  if (type === "string" && typeof value !== "string") return [`${at}: 应为 string`];
  if (type === "integer" && !Number.isInteger(value)) return [`${at}: 应为 integer`];
  if (schema.const !== undefined && value !== schema.const) out.push(`${at}: 应为 ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: 不在枚举内`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: 过短`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${at}: 过长`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: 小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: 大于 ${schema.maximum}`);
  }
  return out;
}

/** 与 CLI validateSkinDefinition 同口径：两套 token 完整且只覆盖公开清单，值安全。 */
function tokenViolations(skin: any): string[] {
  const out: string[] = [];
  const expected = [...theme.auraTokens].sort();
  for (const mode of ["light", "dark"] as const) {
    const values = skin.tokens?.[mode] ?? {};
    if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expected)) {
      out.push(`tokens.${mode}`);
      continue;
    }
    for (const [name, raw] of Object.entries(values)) {
      const token = typeof raw === "string" ? raw : "";
      const lower = token.toLowerCase();
      if (
        token.length === 0 || token.length > 160 || lower.includes("url(") ||
        lower.includes("@import") || lower.includes("expression(") || /[;{}\u0000-\u001f\u007f]/.test(token)
      ) out.push(`tokens.${mode}.${name}`);
    }
  }
  return out;
}

const demo = (name: string) => exampleJson(`skins/${name}`, "skin/skin.json");

describe("Skin v1 开发期校验（插件半）", () => {
  test("两套外部 demo 都满足 Skin v1 schema 与公开 token 合同", () => {
    for (const name of ["codex", "claude"]) {
      expect(schemaViolations(demo(name), skinSchema as Schema), name).toEqual([]);
      expect(tokenViolations(demo(name)), name).toEqual([]);
    }
  });

  test("校验器自身能抓住缺 token、危险 url、控制字符与未知字段（防空跑）", () => {
    const missing = demo("codex");
    delete missing.tokens.light.bg;
    expect(tokenViolations(missing)).toContain("tokens.light");
    const dangerous = demo("codex");
    dangerous.tokens.dark.bg = "url(https://tracker.example/image.png)";
    expect(tokenViolations(dangerous)).toContain("tokens.dark.bg");
    const controlCharacter = demo("codex");
    controlCharacter.tokens.light.bg = "red\nblue";
    expect(tokenViolations(controlCharacter)).toContain("tokens.light.bg");
    const unknown = demo("codex");
    unknown.shell.injectCss = "body{}";
    expect(schemaViolations(unknown, skinSchema as Schema)).toContain("shell.injectCss: 未知字段");
  });

  test("skin manifest 不借计费或导入导出声明扩张数据边界", () => {
    for (const name of ["codex", "claude"]) {
      const manifest = exampleManifest<any>(`skins/${name}`);
      expect(manifest.packageType).toBe("skin");
      expect(manifest.skin?.entry).toBe("skin/skin.json");
      expect(manifest.billing?.mode).toBe("none");
      expect(manifest.data?.imports ?? []).toEqual([]);
      expect(manifest.data?.exports ?? []).toEqual([]);
    }
  });
});
