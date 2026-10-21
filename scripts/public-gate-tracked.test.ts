import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTrackedListing, runTrackedGate } from "./public-gate-tracked";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "gate-tracked-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A", "-f");
  return root;
}

function run(root: string) {
  const lines: string[] = [];
  return { status: runTrackedGate(["--root", root], line => lines.push(line)), output: lines.join("\n") };
}

describe("public-gate-tracked", () => {
  test("中文、引号与首尾空白的文件名都被完整扫描", () => {
    const root = repo({ "文档/说明.md": "ok", 'a "q".txt': "ok", " lead.txt": "ok", "node_modules/x/index.js": "ok" });
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.output).toContain("4 个跟踪文件");
  });

  test("被跟踪的 node_modules 中的提交身份也会命中", () => {
    const root = repo({ "node_modules/x/submission.identity.json": '{"productId":"synthetic"}' });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("[forbidden-identity-file]");
  });

  test("被跟踪的符号链接判为命中", () => {
    const root = repo({ "a.txt": "ok" });
    symlinkSync("a.txt", join(root, "link.txt"));
    spawnSync("git", ["add", "link.txt"], { cwd: root });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("link.txt [symlink]");
  });

  test("非 Git 目录按输入错误退出 2", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-tracked-nogit-"));
    roots.push(root);
    expect(run(root).status).toBe(2);
  });

  test("解析 ls-files --stage 记录", () => {
    const listing = "100644 aaaa 0\tdocs/a b.md\u0000120000 bbbb 0\tlink\u0000160000 cccc 0\tsub\0";
    expect(parseTrackedListing(listing)).toEqual({ regular: ["docs/a b.md"], special: [{ path: "link", rule: "symlink" }, { path: "sub", rule: "submodule" }] });
  });
});
