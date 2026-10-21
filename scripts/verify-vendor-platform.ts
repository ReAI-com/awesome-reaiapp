#!/usr/bin/env bun
/**
 * 平台包 vendor 校验（插件仓 CI 用）。
 *
 * 平台包以主项目为正本，插件仓只消费 `vendor/platform/<目录>/` 下的 tarball，不能修改内容：
 * - `vendor/platform/pins.json` 按摘要钉住每个 lock；lock 再按摘要钉住来源回执 `toolchain.json`；
 * - 每个 tarball 的大小与 sha256 必须同时与 lock、来源回执一致，packs/ 下不允许多出或缺少文件；
 * - tarball 内不允许出现 Host 专用合同；
 * - 插件与样例的 `file:` / `link:` 依赖只能指向自身目录内，或已钉住的 vendor tarball，且包名一致。
 *
 * 只依赖 `node:` 内置模块与系统 tar。用法：bun scripts/verify-vendor-platform.ts [--root <dir>]
 * 退出码：0 通过，1 校验失败，2 用法错误。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const VENDOR = "vendor/platform";
const HOST_ONLY = ["official-host-dependencies.json"];
const CONSUMER_ROOTS = ["plugins", "examples"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];

interface Pin { dir: string; sourceHead: string; lockSha256: string }
interface LockPackage { name: string; version: string; file: string; bytes: number; sha256: string }
interface Artifact { name: string; version: string; file: string; bytes: number; sha256: string }

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const posix = (path: string) => path.split(sep).join("/");

/** 返回 tarball 成员列表；失败返回 null。 */
export type ListTarball = (path: string) => string[] | null;
const listWithTar: ListTarball = path => {
  const result = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : null;
};

function verifyPin(root: string, pin: Pin, errors: string[], listTarball: ListTarball): Map<string, string> {
  const files = new Map<string, string>(); // vendor 相对路径 → 包名
  const base = join(root, VENDOR, pin.dir);
  const at = `${VENDOR}/${pin.dir}`;
  if (!pin.sourceHead?.startsWith(pin.dir)) errors.push(`${at}: 目录名必须是 sourceHead 前缀`);
  const lockPath = join(base, "platform-packages.lock.json");
  if (!existsSync(lockPath)) { errors.push(`${at}: 缺少 platform-packages.lock.json`); return files; }
  const lockBytes = readFileSync(lockPath);
  if (sha256(lockBytes) !== pin.lockSha256) { errors.push(`${at}: lock 摘要与 pins.json 不一致`); return files; }
  const lock = JSON.parse(lockBytes.toString("utf8"));
  if (lock.kind !== "reai-platform-packages" || lock.sourceHead !== pin.sourceHead) errors.push(`${at}: lock 类型或 sourceHead 不符`);

  const receiptFile = lock.toolchainReceipt?.file;
  const receiptPath = typeof receiptFile === "string" ? resolve(base, receiptFile) : "";
  if (!receiptPath || dirname(receiptPath) !== base || !existsSync(receiptPath)) { errors.push(`${at}: 缺少来源回执`); return files; }
  const receiptBytes = readFileSync(receiptPath);
  if (sha256(receiptBytes) !== lock.toolchainReceipt.sha256) { errors.push(`${at}: 来源回执摘要与 lock 不一致`); return files; }
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (receipt.sourceHead !== pin.sourceHead || receipt.sourceDirty !== false) errors.push(`${at}: 来源回执的提交不符或来源工作树不干净`);
  const artifacts: Artifact[] = [...(receipt.artifacts ?? []), ...(receipt.companionArtifacts ?? [])];

  const packages: LockPackage[] = lock.packages ?? [];
  const listed = new Set<string>();
  for (const pkg of packages) {
    const file = posix(pkg.file ?? "");
    if (!/^packs\/[A-Za-z0-9._-]+\.tgz$/.test(file)) { errors.push(`${at}: 非法包路径 ${pkg.file}`); continue; }
    listed.add(file);
    const path = join(base, file);
    if (!existsSync(path)) { errors.push(`${at}/${file}: 缺少 tarball`); continue; }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== pkg.bytes || sha256(bytes) !== pkg.sha256) { errors.push(`${at}/${file}: 大小或摘要与 lock 不一致`); continue; }
    const artifact = artifacts.find(item => item.name === pkg.name);
    if (!artifact || artifact.version !== pkg.version || posix(artifact.file) !== file || artifact.bytes !== pkg.bytes || artifact.sha256 !== pkg.sha256) {
      errors.push(`${at}/${file}: 与来源回执不一致`);
    }
    if (lock.overrides?.[pkg.name] !== file) errors.push(`${at}: lock overrides 未指向 ${file}`);
    const members = listTarball(path);
    if (!members) errors.push(`${at}/${file}: 无法读取 tarball`);
    else if (members.some(member => HOST_ONLY.some(name => member === name || member.endsWith(`/${name}`)))) errors.push(`${at}/${file}: 含 Host 专用合同`);
    files.set(`${at}/${file}`, pkg.name);
  }
  const packsDir = join(base, "packs");
  for (const name of existsSync(packsDir) ? readdirSync(packsDir) : []) {
    if (!listed.has(`packs/${name}`)) errors.push(`${at}/packs/${name}: lock 未登记的文件`);
  }
  return files;
}

function packageJsons(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) packageJsons(path, out);
    else if (entry.name === "package.json") out.push(path);
  }
  return out;
}

function collectDeps(manifest: Record<string, unknown>): [string, string][] {
  const deps: [string, string][] = [];
  for (const field of DEP_FIELDS) {
    const value = manifest[field];
    if (!value || typeof value !== "object") continue;
    for (const [name, spec] of Object.entries(value)) if (typeof spec === "string") deps.push([name, spec]);
  }
  return deps;
}

export function verifyVendor(root: string, listTarball: ListTarball = listWithTar): string[] {
  const errors: string[] = [];
  for (const legacy of ["packages", "platform"]) {
    if (existsSync(join(root, legacy))) errors.push(`${legacy}/: 平台包源码拷贝不得放进插件仓，改用 ${VENDOR}`);
  }
  const pinsPath = join(root, VENDOR, "pins.json");
  if (!existsSync(pinsPath)) return [...errors, `${VENDOR}/pins.json: 缺少`];
  const pins: Pin[] = readJson(pinsPath).pins ?? [];
  const pinned = new Set(pins.map(pin => pin.dir));
  for (const name of readdirSync(join(root, VENDOR))) {
    if (name !== "pins.json" && !pinned.has(name)) errors.push(`${VENDOR}/${name}: 未在 pins.json 登记`);
  }
  const vendorFiles = new Map<string, string>();
  for (const pin of pins) {
    if (!existsSync(join(root, VENDOR, pin.dir))) { errors.push(`${VENDOR}/${pin.dir}: 目录不存在`); continue; }
    for (const [path, name] of verifyPin(root, pin, errors, listTarball)) vendorFiles.set(path, name);
  }

  for (const top of CONSUMER_ROOTS) {
    if (!existsSync(join(root, top))) continue;
    for (const manifestPath of packageJsons(join(root, top))) {
      const unit = dirname(manifestPath);
      const shown = posix(relative(root, manifestPath));
      for (const [name, spec] of collectDeps(readJson(manifestPath))) {
        const match = /^(?:file|link):(.+)$/.exec(spec);
        if (!match) continue;
        const target = resolve(unit, match[1]!);
        const inUnit = relative(unit, target);
        if (!inUnit.startsWith("..") && !inUnit.startsWith(sep) && inUnit !== "") continue;
        const fromRoot = posix(relative(root, target));
        const expected = vendorFiles.get(fromRoot);
        if (!expected) errors.push(`${shown}: ${name} 指向未钉住的本地路径 ${match[1]}`);
        else if (expected !== name) errors.push(`${shown}: ${name} 指向的是 ${expected} 的 tarball`);
        else if (!statSync(target).isFile()) errors.push(`${shown}: ${name} 指向的 tarball 不存在`);
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  if (args.length === 2 && args[0] === "--root") root = resolve(args[1]!);
  else if (args.length > 0) { console.error("用法: bun scripts/verify-vendor-platform.ts [--root <dir>]"); process.exit(2); }
  const errors = verifyVendor(root);
  for (const error of errors) console.error(`FAIL ${error}`);
  console.log(errors.length ? `FAIL vendor-platform: ${errors.length} 处问题` : "PASS vendor-platform");
  process.exitCode = errors.length ? 1 : 0;
}
