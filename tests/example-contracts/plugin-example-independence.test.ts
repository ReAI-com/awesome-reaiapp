/**
 * 样例插件独立性（自主项目 tests/plugin-contracts/plugin-example-independence.plugin.test.ts 迁入）。
 *
 * 每个样例拥有自己的 package、冻结 lockfile 与完整验证脚本，Todo 的本地测试跟着插件走。
 * 样例清单按 examples/ 下带 app.manifest.json 的目录自动发现，新增样例无需改本文件；
 * 同时保留原合同点名的四个样例，防止它们被误删。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { discoverExamples, exampleFile, exampleJson, exampleRoot } from "./support/paths";

const required = ["todo-app", "titlebar-actions-app", "skins/codex", "skins/claude"];

const examples = discoverExamples();

describe("插件样例独立于 Driver", () => {
  test("原合同点名的样例都在", () => {
    for (const slug of required) expect(examples, slug).toContain(slug);
  });

  test("每个样例拥有自己的 package、冻结 lockfile 与完整验证脚本", () => {
    for (const slug of examples) {
      expect(existsSync(exampleRoot(slug)), slug).toBeTrue();
      expect(existsSync(exampleFile(slug, "bun.lock")), slug).toBeTrue();

      const pkg = exampleJson<{ private?: boolean; scripts?: Record<string, string> }>(slug, "package.json");
      expect(pkg.private, slug).toBeTrue();
      for (const script of ["test", "typecheck", "validate", "build", "test:contract", "pack"]) {
        expect(pkg.scripts?.[script], `${slug} ${script}`).toBeString();
      }
    }
  });

  test("每个样例都登记在插件工具链 CI 的样例矩阵里", () => {
    const workflow = readFileSync(resolve(import.meta.dir, "../../.github/workflows/plugin-toolchain.yml"), "utf8");
    const matrix = workflow.match(/^\s*example:\s*\[([^\]]*)\]/m)?.[1];
    expect(matrix).toBeDefined();
    const listed = matrix!.split(",").map(item => item.trim()).filter(Boolean).sort();
    expect(listed).toEqual(examples);
  });

  test("Todo 的插件本地测试跟着插件走", () => {
    expect(existsSync(exampleFile("todo-app", "tests/todo-agent-model.test.ts"))).toBeTrue();
    expect(existsSync(exampleFile("todo-app", "tests/todo-agent-ui.test.ts"))).toBeTrue();
  });
});
