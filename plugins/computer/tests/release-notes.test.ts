import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import manifest from "../app.manifest.json";
import { CHANGELOG_TEXT } from "../src/release-notes";
import { changelogSection } from "../src/computer-view";

describe("版本与更新日志", () => {
  // 测试不先生成：改了 CHANGELOG.md 却忘记 bun run sync:notes 时这里会失败。
  test("打包内的日志与 CHANGELOG.md 一致", () => {
    const source = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(CHANGELOG_TEXT).toBe(source);
  });

  test("当前安装版本有非空日志条目", () => {
    const section = changelogSection(CHANGELOG_TEXT, manifest.version);
    expect(section.startsWith(`## ${manifest.version}`)).toBe(true);
    expect(section.split("\n").length).toBeGreaterThan(3);
  });

  test("只取当前版本那一节，不混入其他版本", () => {
    const text = "# 日志\n\n## 0.2.0 · x\n\n- 新\n\n## 0.1.0 · y\n\n- 旧\n";
    expect(changelogSection(text, "0.1.0")).toBe("## 0.1.0 · y\n\n- 旧");
    expect(changelogSection(text, "0.2.0")).toBe("## 0.2.0 · x\n\n- 新");
  });

  test("找不到版本时明确说明，不拿别的版本冒充", () => {
    expect(changelogSection("## 0.1.0\n- 旧", "9.9.9")).toBe("此版本（9.9.9）的更新日志尚未发布。");
  });
});
