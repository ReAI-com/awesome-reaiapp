/**
 * 单层 Host Title Bar 的样例部分（自主项目 tests/plugin-contracts/titlebar-surface-buffering.plugin.test.ts 迁入）。
 *
 * 样例正文只消费 Host 注入的 `--reai-plugin-titlebar-safe-top`，不自建第二层页头，
 * 也不读已废弃的 `--reai-plugin-safe-top`。Host 注入与 SDK 兜底归 Host 半。
 */
import { describe, expect, test } from "bun:test";

import { readExample } from "./support/paths";

describe("样例只保留一层 Host Title Bar", () => {
  test("todo 样例主框架从 Host 安全区下方开始", () => {
    const css = readExample("todo-app", "src/todo.css");
    expect(css).toMatch(/\.plugin-main-frame\s*\{[^}]*padding-top:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/);
    expect(css).not.toContain("--reai-plugin-safe-top");
  });
});
