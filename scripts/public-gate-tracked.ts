#!/usr/bin/env bun
/**
 * 公开闸门的「Git 跟踪文件」入口（插件仓 CI 用）。
 *
 * `scripts/public-gate.ts` 是主项目导出物，插件仓不改。它的目录遍历会跳过 node_modules，
 * 文本清单又按行去空白、不解码 Git 的路径转义；这里改用 `git ls-files -z --stage` 的 NUL 分隔清单，
 * 原样复用导出闸门的扫描、豁免与输出规则，保证中文、引号、首尾空白等文件名也被完整扫描。
 * 被跟踪的符号链接与子模块直接判为命中，不跟随。
 *
 * 用法：bun scripts/public-gate-tracked.ts [--root <dir>] [--allow <json>]...
 * 退出码：0 通过，1 命中，2 用法或输入错误。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAllow, collectList, dedupe, displayPath, GateInputError, maskPath, parseAllow, scanPublic, type GateFinding } from "./public-gate";

/** 解析 `git ls-files -z --stage`：每条为 `<mode> <object> <stage>\t<path>`，以 NUL 结尾。 */
export function parseTrackedListing(listing: string): { regular: string[]; special: GateFinding[] } {
  const regular: string[] = [];
  const special: GateFinding[] = [];
  for (const record of listing.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new GateInputError("INPUT_INVALID: git ls-files 输出格式不符");
    const mode = record.slice(0, record.indexOf(" "));
    const path = record.slice(tab + 1);
    if (mode === "120000") special.push({ path, rule: "symlink" });
    else if (mode === "160000") special.push({ path, rule: "submodule" });
    else regular.push(path);
  }
  return { regular, special };
}

export function runTrackedGate(args: string[], write: (line: string) => void = line => console.log(line)): number {
  try {
    let root = process.cwd();
    const allowFiles: string[] = [];
    for (let index = 0; index < args.length; index += 2) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new GateInputError(`USAGE: ${args[index]} 缺少参数`);
      if (args[index] === "--root") root = resolve(value);
      else if (args[index] === "--allow") allowFiles.push(value);
      else throw new GateInputError(`USAGE: 未知参数 ${args[index]}`);
    }
    const git = spawnSync("git", ["ls-files", "-z", "--stage"], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (git.status !== 0) throw new GateInputError("INPUT_INVALID: 无法读取 Git 跟踪清单");
    const { regular, special } = parseTrackedListing(git.stdout);
    const files = collectList(root, regular, { trim: false });
    const allow = allowFiles.flatMap(file => parseAllow(readFileSync(file, "utf8")));
    const findings = applyAllow(dedupe([...scanPublic(files), ...special]), files, allow);
    if (findings.length === 0) {
      write(`PASS public-gate: ${files.length} 个跟踪文件，0 命中`);
      return 0;
    }
    for (const finding of findings) write(`FAIL ${displayPath(finding.path)} [${finding.rule}]`);
    write(`FAIL public-gate: ${findings.length} 处命中`);
    return 1;
  } catch (error) {
    write(`ERROR public-gate: ${error instanceof GateInputError ? maskPath(error.message) : "INTERNAL: 读取或解析输入失败"}`);
    return 2;
  }
}

if (import.meta.main) process.exit(runTrackedGate(process.argv.slice(2)));
