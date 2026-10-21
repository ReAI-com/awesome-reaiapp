/**
 * 插件单层 Host Title Bar 合同的样例部分（自主项目 tests/plugin-contracts/plugin-main-body-contract.plugin.test.ts 迁入）。
 *
 * 只读样例源码：根安全区、首屏不重复页头、正文首容器留白、标题栏动作 manifest、合同命令的 Host API 版本。
 * Host 注入的安全区变量名经合同包 `@reai/app-contract/host-commitments-v1.json` 的 titlebarSafeArea 取得。
 * 官方插件部分在官方插件迁入本仓前仍由主项目守。
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import hostCommitments from "@reai/app-contract/host-commitments-v1.json";
import { discoverExamples, exampleFile, exampleJson, readExample } from "./support/paths";

const safeArea = { token: hostCommitments.titlebarSafeArea.cssVariable, fallback: hostCommitments.titlebarSafeArea.macos };
const SAFE_TOKEN = safeArea.token;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pluginSurfaces = [
  { name: "Todo", slug: "todo-app", view: "src/todo-view.ts", style: "src/todo.css" },
  { name: "Titlebar Actions Demo", slug: "titlebar-actions-app", view: "src/app.ts", style: "src/app.css" },
];

/** 首屏禁止自画的页头文案：面包屑已经显示 App 名，插件再画一遍就是「标题出现两次」。 */
const forbiddenFirstScreenTitles: Array<[name: string, slug: string, view: string, titles: string[]]> = [
  ["Todo", "todo-app", "src/todo-view.ts", ["日程", "先把今天过好"]],
  ["Titlebar Actions Demo", "titlebar-actions-app", "src/app.ts", ["Titlebar Actions Demo"]],
];

/**
 * 四种「元素文本」写法：`<h1>文案</h1>`、标题类块级元素 `>文案</h2|p|div|span|strong|header>`、
 * `textContent = "文案"`、`element(/el)(…, "文案")`。尽力而为的守卫，不是硬保证。
 */
const titleElementForms = (title: string) => {
  const text = escapeRegExp(title);
  return [
    new RegExp(`<h1[^>]*>\\s*${text}\\s*</h1>`),
    new RegExp(`>\\s*${text}\\s*</(?:h[1-6]|p|div|span|strong|header)>`),
    new RegExp(`textContent\\s*=\\s*["'\`]${text}["'\`]`),
    new RegExp(`\\b(?:element|el)\\([^)\\n]*,\\s*["'\`]${text}["'\`]\\s*\\)`),
  ];
};

/** 正文首容器顶部留白上限：规范 §4.6 紧凑档 12px，放宽到 16px 留余量。 */
const MAX_FIRST_CONTAINER_TOP_PADDING_PX = 16;

/** 取某选择器所有规则块的 padding-top 像素值；没有声明当 0，非 px 字面量记 NaN。 */
function topPaddingsOf(style: string, selector: string): number[] {
  const blocks = [...style.matchAll(new RegExp(`(?:^|[\\s{},])${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "g"))];
  if (blocks.length === 0) throw new Error(`${selector}: 没有找到规则块`);
  return blocks.map(([, body]) => {
    const declarations = body.split(";").map((item) => item.trim()).filter(Boolean);
    let top = 0;
    for (const declaration of declarations) {
      const [property, ...rest] = declaration.split(":");
      const value = rest.join(":").trim();
      const name = property.trim();
      if (name === "padding" || name === "padding-block") {
        const first = value.split(/\s+/)[0];
        top = /^(\d+(?:\.\d+)?)px$/.test(first) || first === "0" ? Number.parseFloat(first) : Number.NaN;
      } else if (name === "padding-top" || name === "padding-block-start") {
        top = /^(\d+(?:\.\d+)?)px$/.test(value) || value === "0" ? Number.parseFloat(value) : Number.NaN;
      }
    }
    return top;
  });
}

const contractApps = discoverExamples().filter((slug) => existsSync(exampleFile(slug, "tests/contract.suite.ts")));

describe("插件单层 Host Title Bar 合同（样例）", () => {
  for (const { name, slug, view: viewPath, style: stylePath } of pluginSurfaces) {
    test(`${name} 只有一个根安全区，DOM 从 main-body 开始`, () => {
      const view = readExample(slug, viewPath);
      const style = readExample(slug, stylePath);
      expect(view).toContain("plugin-main-frame");
      expect(view).toContain("main-body");
      const count = (className: string) =>
        view.match(
          new RegExp(`(?:class(?:Name)?\\s*=|(?:element|el)\\([^,\\n]+,)\\s*["'\`][^"'\`]*\\b${className}\\b`, "g"),
        )?.length ?? 0;
      expect(count("main-body")).toBe(1);
      expect(style).toContain(SAFE_TOKEN);
      expect(style).toMatch(new RegExp(
        `\\.plugin-main-frame\\s*\\{[^}]*padding-top\\s*:\\s*var\\(${escapeRegExp(SAFE_TOKEN)},\\s*${escapeRegExp(safeArea.fallback)}\\)`,
        "s",
      ));
      expect(style).not.toContain("--reai-plugin-safe-top");
      expect(style).not.toMatch(/position:\s*fixed/);
    });
  }

  for (const [name, slug, viewPath, titles] of forbiddenFirstScreenTitles) {
    test(`${name} 首屏不自画与 App 名重复的页头`, () => {
      const view = readExample(slug, viewPath);
      for (const title of titles) {
        for (const form of titleElementForms(title)) {
          expect(view.match(form)?.[0]).toBeUndefined();
        }
      }
    });
  }

  test(`Todo 正文首容器顶部留白不超过 ${MAX_FIRST_CONTAINER_TOP_PADDING_PX}px`, () => {
    for (const top of topPaddingsOf(readExample("todo-app", "src/todo.css"), ".todo-topbar")) {
      expect(top).toBeLessThanOrEqual(MAX_FIRST_CONTAINER_TOP_PADDING_PX);
    }
  });

  test("标题栏动作示例正文首容器顶部留白不超过 16px", () => {
    const source = readExample("titlebar-actions-app", "src/app.ts");
    const padding = source.match(/"padding:(\d+)px[^"]*"/)?.[1];
    expect(padding).toBeDefined();
    expect(Number(padding)).toBeLessThanOrEqual(MAX_FIRST_CONTAINER_TOP_PADDING_PX);
  });

  test("Todo 的页面级动作由 Host 托管并复用现有业务 intent", () => {
    const manifest = exampleJson<{
      hostApi: { range: string };
      requires: { hostCapabilities: string[] };
      contributes: { titlebarActions?: Array<{ id: string; intent: { type: string } }> };
    }>("todo-app", "app.manifest.json");
    expect(manifest.hostApi.range).toBe(">=1.2.0 <2.0.0");
    expect(manifest.requires.hostCapabilities).toContain("titlebar.action@1");
    expect(manifest.contributes.titlebarActions?.map((action) => [action.id, action.intent.type]))
      .toEqual([["new-task", "new-task"], ["assistant", "open-assistant"]]);
    expect(readExample("todo-app", "src/app.ts")).toContain("host.titlebarAction");
    expect(readExample("todo-app", "package.json")).toContain("reai-app contract-test . --host-api 1.2");
  });

  test("标题栏动作示例文档使用套件声明的 Host API 版本", () => {
    const suite = readExample("titlebar-actions-app", "tests/contract.suite.ts");
    const suiteHostApi = suite.match(/\bhostApi:\s*"(\d+\.\d+)\.\d+"/)?.[1];
    expect(suiteHostApi).toBeDefined();
    const packageJson = exampleJson<{ scripts: Record<string, string> }>("titlebar-actions-app", "package.json");
    expect(packageJson.scripts["test:contract"]).toMatch(new RegExp(`--host-api ${escapeRegExp(suiteHostApi!)}(?:\\s|$)`));
    expect(readExample("titlebar-actions-app", "README.md")).toContain("bun run test:contract");
  });

  test("所有样例的合同命令使用套件声明的 Host API 版本", () => {
    expect(contractApps.length).toBeGreaterThan(0);
    for (const slug of contractApps) {
      const suite = readExample(slug, "tests/contract.suite.ts");
      const suiteVersion = suite.match(/\bhostApi:\s*"((\d+\.\d+)\.\d+)"/);
      const suiteHostApi = suiteVersion?.[2];
      if (!suiteHostApi) throw new Error(`${slug}: contract suite 缺少 x.y.z 格式的 hostApi`);
      const packageJson = exampleJson<{ scripts: Record<string, string> }>(slug, "package.json");
      const commandVersion = packageJson.scripts["test:contract"]?.match(/--host-api\s+((\d+\.\d+)(?:\.\d+)?)(?:\s|$)/);
      if (!commandVersion) throw new Error(`${slug}: test:contract 缺少 --host-api x.y 或 x.y.z`);
      expect(commandVersion[2]).toBe(suiteHostApi);
      // CLI 接受按版本段匹配的 x.y 前缀，也接受精确 x.y.z；精确值必须匹配套件。
      if (commandVersion[1] !== commandVersion[2]) expect(commandVersion[1]).toBe(suiteVersion![1]);
    }
  });
});
