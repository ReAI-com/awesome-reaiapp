/**
 * 设计规范与送审一致性的静态检查（docs/plugin-design-system-v1.md、plugin-i18n-v1.md）：
 * - 样式表只用 Host 主题 Token，兜底值等于浅色 Token 值，不写死十六进制颜色；
 * - 界面文案不用字符当图标；
 * - 源码（除给模型的提示词）没有硬编码的中文界面文案；
 * - Manifest、test:contract 与合同套件的 Host API 一致。
 * tests/fixtures/theme-tokens.json 为主项目主题 Token 快照（与各样例 tests/fixtures 下的快照相同）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../app.manifest.json";
import pkg from "../package.json";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import tokens from "./fixtures/theme-tokens.json";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const css = read("src/computer.css");

describe("主题 Token", () => {
  const light = tokens.light as Record<string, string>;
  const uses = [...css.matchAll(/var\(--([a-z0-9-]+)(?:,\s*((?:[^()]|\([^)]*\))*))?\)/g)];

  test("用到的每个变量都是 Host Token（标题栏安全线除外）", () => {
    const unknown = uses.map((m) => m[1]!).filter((name) => name !== "reai-plugin-titlebar-safe-top" && !(name in light));
    expect([...new Set(unknown)]).toEqual([]);
  });

  test("兜底值与浅色 Token 一致，不用兜底掩盖拼写错误", () => {
    const mismatched = uses
      .filter((m) => m[2] && m[1]! in light)
      .filter((m) => m[2]!.trim().replace(/\s+/g, "") !== light[m[1]!]!.replace(/\s+/g, ""))
      .map((m) => `${m[1]}=${m[2]}`);
    expect(mismatched).toEqual([]);
  });

  test("var() 之外没有写死的十六进制颜色", () => {
    const outside = css.replace(/var\((?:[^()]|\([^)]*\))*\)/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(outside.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  test("没有自定义变量与 Token 撞名、没有 prefers-color-scheme", () => {
    const declared = [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!.slice(2));
    expect(declared.filter((name) => name in light)).toEqual([]);
    expect(css).not.toContain("prefers-color-scheme");
  });

  test("全局按钮基线保留 focus-visible", () => {
    expect(css).toMatch(/button:focus-visible\s*\{[^}]*outline/);
  });
});

describe("文案", () => {
  const leaves = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(leaves) : [];
  const ICON_CHARS = /[■□●○✓✔✕✖✗×↻→←↑↓⏹⏸▶✅❌⚠️⚠]/u;

  test("语言资源不用字符当图标", () => {
    expect([...leaves(zh), ...leaves(en)].filter((text) => ICON_CHARS.test(text))).toEqual([]);
  });

  test("视图与入口源码没有硬编码中文文案（注释除外）", () => {
    for (const file of ["src/app.ts", "src/computer-view.ts", "src/computer-bridge.ts", "src/computer-i18n.ts"]) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect({ file, cjk: code.match(/[一-鿿]+/g) ?? [] }).toEqual({ file, cjk: [] });
    }
  });
});

describe("送审一致性", () => {
  test("Host API：Manifest、test:contract、合同套件一致", () => {
    expect(manifest.hostApi.range).toBe(">=1.25.0 <2.0.0");
    expect(pkg.scripts["test:contract"]).toContain("--host-api 1.25");
    expect(read("tests/contract.suite.ts")).toContain('hostApi: "1.25.0"');
  });

  test("声明 metadata.i18n@1（线上送审基线），不声明 v2", () => {
    expect(manifest.requires.hostCapabilities).toContain("metadata.i18n@1");
    expect(manifest.requires.hostCapabilities).not.toContain("metadata.i18n@2");
  });

  test("版本：Manifest、package.json、送审身份示例与打包文件名一致", () => {
    expect(pkg.version).toBe(manifest.version);
    expect(JSON.parse(read("submission.identity.example.json")).version).toBe(manifest.version);
    expect(pkg.scripts.pack).toContain(`computer-${manifest.version}.reaiapp`);
    expect(pkg.scripts["pack:submission"]).toContain(`computer-${manifest.version}-submission.reaiapp`);
  });

  test("构建、打包与送审打包前都先同步更新日志；test 不预先同步", () => {
    for (const name of ["build", "pack", "pack:submission"] as const) {
      expect(pkg.scripts[name].startsWith("bun scripts/sync-release-notes.ts && ")).toBe(true);
    }
    expect(pkg.scripts.test).not.toContain("sync-release-notes");
  });
});
