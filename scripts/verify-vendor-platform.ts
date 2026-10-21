#!/usr/bin/env bun
/**
 * 平台包 vendor 校验（插件仓 CI 用）。
 *
 * 平台包以主项目为正本，插件仓只消费 `vendor/platform/<目录>/` 下的 tarball，不能修改内容：
 * - `vendor/platform/pins.json` 按摘要钉住每个 lock；lock 再按摘要钉住来源回执 `toolchain.json`；
 * - 每个 tarball 的大小与 sha256 必须同时与 lock、来源回执一致，packs/ 下不允许多出或缺少文件；
 * - tarball 内不允许出现 Host 专用合同；
 * - 插件与样例的 `file:` / `link:` 依赖只能指向自身目录内，或已钉住的 vendor tarball，且包名一致；
 * - 平台包（按 lock 中的包名）在 package.json 里必须指向 vendor tarball，在 bun.lock 里必须解析到同一 tarball
 *   且完整性摘要与 tarball 实际字节一致。
 *
 * 只依赖 `node:` 内置模块与系统 tar。用法：bun scripts/verify-vendor-platform.ts [--root <dir>]
 * 退出码：0 通过，1 校验失败，2 用法错误。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const VENDOR = "vendor/platform";
const HOST_ONLY = ["official-host-dependencies.json"];
const CONSUMER_ROOTS = ["plugins", "examples"];
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides"];

interface Pin { dir: string; sourceHead: string; lockSha256: string }
interface LockPackage { name: string; version: string; file: string; bytes: number; sha256: string }
interface Artifact { name: string; version: string; file: string; bytes: number; sha256: string }

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha512Integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
class VendorError extends Error {}
/** 解析失败抛出带文件路径的 VendorError，由调用方记为一条校验失败。 */
const parseJson = (bytes: Uint8Array | string, shown: string): any => {
  try { return JSON.parse(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8")); }
  catch { throw new VendorError(`${shown}: 不是合法 JSON`); }
};
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isEntry = (value: unknown): value is Artifact => isRecord(value)
  && typeof value.name === "string" && typeof value.version === "string" && typeof value.file === "string"
  && Number.isSafeInteger(value.bytes) && typeof value.sha256 === "string";
const posix = (path: string) => path.split(sep).join("/");

/** 返回 tarball 成员列表；失败返回 null。 */
export type ListTarball = (path: string) => string[] | null;
const listWithTar: ListTarball = path => {
  const result = spawnSync("tar", ["-tzf", path], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : null;
};

interface VendorFile { name: string; integrity: string }

function verifyPin(root: string, pin: Pin, errors: string[], listTarball: ListTarball): Map<string, VendorFile> {
  const files = new Map<string, VendorFile>(); // vendor 相对路径 → 包名与 bun.lock 完整性摘要
  const base = join(root, VENDOR, pin.dir);
  const at = `${VENDOR}/${pin.dir}`;
  if (!pin.sourceHead?.startsWith(pin.dir)) errors.push(`${at}: 目录名必须是 sourceHead 前缀`);
  const lockPath = join(base, "platform-packages.lock.json");
  if (!existsSync(lockPath)) { errors.push(`${at}: 缺少 platform-packages.lock.json`); return files; }
  const lockBytes = readFileSync(lockPath);
  if (sha256(lockBytes) !== pin.lockSha256) { errors.push(`${at}: lock 摘要与 pins.json 不一致`); return files; }
  const lock = parseJson(lockBytes, `${at}/platform-packages.lock.json`);
  if (!isRecord(lock)) { errors.push(`${at}: lock 结构不合法`); return files; }
  if (lock.kind !== "reai-platform-packages" || lock.sourceHead !== pin.sourceHead) errors.push(`${at}: lock 类型或 sourceHead 不符`);

  const receiptRef = isRecord(lock.toolchainReceipt) ? lock.toolchainReceipt : {};
  const receiptFile = receiptRef.file;
  const receiptPath = typeof receiptFile === "string" ? resolve(base, receiptFile) : "";
  if (!receiptPath || dirname(receiptPath) !== base || !existsSync(receiptPath)) { errors.push(`${at}: 缺少来源回执`); return files; }
  const receiptBytes = readFileSync(receiptPath);
  if (sha256(receiptBytes) !== receiptRef.sha256) { errors.push(`${at}: 来源回执摘要与 lock 不一致`); return files; }
  const receipt = parseJson(receiptBytes, `${at}/${receiptFile}`);
  if (!isRecord(receipt)) { errors.push(`${at}: 来源回执结构不合法`); return files; }
  if (receipt.sourceHead !== pin.sourceHead || receipt.sourceDirty !== false) errors.push(`${at}: 来源回执的提交不符或来源工作树不干净`);
  const rawArtifacts = [receipt.artifacts ?? [], receipt.companionArtifacts ?? []];
  const rawPackages = lock.packages;
  if (!rawArtifacts.every(Array.isArray) || !Array.isArray(rawPackages)) { errors.push(`${at}: lock 或来源回执的包列表不是数组`); return files; }
  const artifacts = rawArtifacts.flat();
  if (!artifacts.every(isEntry) || !rawPackages.every(isEntry)) { errors.push(`${at}: lock 或来源回执含结构不合法的包条目`); return files; }
  // 同名条目只能出现一次，否则按顺序取首项会让冲突条目的结果取决于数组顺序。
  for (const [list, label] of [[artifacts, "来源回执"], [rawPackages, "lock"]] as const) {
    const names = list.map(item => item.name);
    const duplicated = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
    if (duplicated.length) { errors.push(`${at}: ${label}中重复登记 ${duplicated.join(", ")}`); return files; }
  }
  const packages: LockPackage[] = rawPackages;
  const overrides = isRecord(lock.overrides) ? lock.overrides : {};
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
    if (overrides[pkg.name] !== file) errors.push(`${at}: lock overrides 未指向 ${file}`);
    const members = listTarball(path);
    if (!members) errors.push(`${at}/${file}: 无法读取 tarball`);
    else if (members.some(member => HOST_ONLY.some(name => member === name || member.endsWith(`/${name}`)))) errors.push(`${at}/${file}: 含 Host 专用合同`);
    files.set(`${at}/${file}`, { name: pkg.name, integrity: sha512Integrity(bytes) });
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

/** 同一插件 / 样例里可能嵌套多个 package.json；以最外层（离仓库根最近）的那个目录作为单元边界。 */
function unitRoot(root: string, manifestPath: string): string {
  let unit = dirname(manifestPath);
  for (let dir = dirname(unit); relative(root, dir) && !relative(root, dir).startsWith(".."); dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) unit = dir;
  }
  return unit;
}

/** 目标是否在目录内：只把独立的 `..` 路径段视为越界，`..cache` 之类的目录名不算。 */
function inside(dir: string, target: string): boolean {
  const rel = relative(dir, target);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/** bun.lock 是 JSONC（允许注释与尾逗号）：在字符串之外去掉注释和收尾前的逗号，再按 JSON 解析。 */
export function stripJsonc(text: string): string {
  let out = "";
  let pendingComma = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\"") {
      out += pendingComma; pendingComma = "";
      let end = index + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end;
    } else if (char === "/" && text[index + 1] === "/") {
      // 行注释到 LF 或 CR 为止，换行本身保留。
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index++;
      index--;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else if (char === ",") {
      out += pendingComma; pendingComma = ",";
    } else if (char === "}" || char === "]") {
      pendingComma = ""; out += char;
    } else if (/\s/.test(char)) {
      if (pendingComma) pendingComma += char; else out += char;
    } else {
      out += pendingComma; pendingComma = ""; out += char;
    }
  }
  return out + pendingComma;
}

function parseBunLock(text: string, shown: string): any {
  return parseJson(stripJsonc(text.replace(/^\uFEFF/, "")), shown);
}

/** 核对 bun.lock 中每个平台包条目都解析到已钉住的 tarball，且完整性摘要与 tarball 字节一致。 */
function verifyBunLock(root: string, lockPath: string, vendorFiles: Map<string, VendorFile>, platformNames: Set<string>, errors: string[]): void {
  const shown = posix(relative(root, lockPath));
  const lock = parseBunLock(readFileSync(lockPath, "utf8"), shown);
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : null;
  if (!packages) { errors.push(`${shown}: 缺少 packages`); return; }
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const at = entry[0].lastIndexOf("@");
    const name = at > 0 ? entry[0].slice(0, at) : entry[0];
    if (!platformNames.has(name)) continue;
    const spec = entry[0].slice(at + 1).replace(/^(?:file|link):/, "");
    const fromRoot = posix(relative(root, resolve(dirname(lockPath), spec)));
    const vendored = vendorFiles.get(fromRoot);
    const integrity = entry.find((item: unknown) => typeof item === "string" && item.startsWith("sha512-"));
    if (!vendored || vendored.name !== name) errors.push(`${shown}: ${key} 未解析到已钉住的 ${name} tarball`);
    else if (integrity !== vendored.integrity) errors.push(`${shown}: ${key} 的完整性摘要与 vendor tarball 不一致`);
  }
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

export function verifyVendor(rootDir: string, listTarball: ListTarball = listWithTar): string[] {
  const root = resolve(rootDir);
  const errors: string[] = [];
  try {
    verifyInto(root, errors, listTarball);
  } catch (error) {
    if (!(error instanceof VendorError)) throw error;
    errors.push(error.message);
  }
  return errors;
}

function verifyInto(root: string, errors: string[], listTarball: ListTarball): void {
  for (const legacy of ["packages", "platform"]) {
    if (existsSync(join(root, legacy))) errors.push(`${legacy}/: 平台包源码拷贝不得放进插件仓，改用 ${VENDOR}`);
  }
  const pinsPath = join(root, VENDOR, "pins.json");
  if (!existsSync(pinsPath)) { errors.push(`${VENDOR}/pins.json: 缺少`); return; }
  const pinsJson = parseJson(readFileSync(pinsPath), `${VENDOR}/pins.json`);
  const rawPins = isRecord(pinsJson) ? pinsJson.pins : undefined;
  const validPin = (pin: unknown): pin is Pin => isRecord(pin) && typeof pin.dir === "string" && /^[0-9a-f]{12}$/.test(pin.dir)
    && typeof pin.sourceHead === "string" && typeof pin.lockSha256 === "string";
  if (!Array.isArray(rawPins) || !rawPins.every(validPin)) { errors.push(`${VENDOR}/pins.json: pins 必须是 { dir, sourceHead, lockSha256 } 数组`); return; }
  const pins: Pin[] = rawPins;
  if (new Set(pins.map(pin => pin.dir)).size !== pins.length) { errors.push(`${VENDOR}/pins.json: 重复登记同一目录`); return; }
  const pinned = new Set(pins.map(pin => pin.dir));
  for (const name of readdirSync(join(root, VENDOR))) {
    if (name !== "pins.json" && !pinned.has(name)) errors.push(`${VENDOR}/${name}: 未在 pins.json 登记`);
  }
  const vendorFiles = new Map<string, VendorFile>();
  for (const pin of pins) {
    if (!existsSync(join(root, VENDOR, pin.dir))) { errors.push(`${VENDOR}/${pin.dir}: 目录不存在`); continue; }
    for (const [path, name] of verifyPin(root, pin, errors, listTarball)) vendorFiles.set(path, name);
  }

  const platformNames = new Set([...vendorFiles.values()].map(file => file.name));
  for (const top of CONSUMER_ROOTS) {
    if (!existsSync(join(root, top))) continue;
    for (const manifestPath of packageJsons(join(root, top))) {
      const unit = unitRoot(join(root, top), manifestPath);
      const shown = posix(relative(root, manifestPath));
      const manifest = parseJson(readFileSync(manifestPath), shown);
      if (!isRecord(manifest)) { errors.push(`${shown}: 不是 JSON 对象`); continue; }
      for (const [name, spec] of collectDeps(manifest)) {
        const match = /^(?:file|link):(.+)$/.exec(spec);
        if (!match) {
          if (platformNames.has(name)) errors.push(`${shown}: 平台包 ${name} 必须指向 vendor tarball，不能用 ${spec}`);
          continue;
        }
        const target = resolve(dirname(manifestPath), match[1]!);
        if (inside(unit, target) && !platformNames.has(name)) continue;
        const fromRoot = posix(relative(root, target));
        const expected = vendorFiles.get(fromRoot);
        if (!expected) errors.push(`${shown}: ${name} 指向未钉住的本地路径 ${match[1]}`);
        else if (expected.name !== name) errors.push(`${shown}: ${name} 指向的是 ${expected.name} 的 tarball`);
        else if (!statSync(target).isFile()) errors.push(`${shown}: ${name} 指向的 tarball 不存在`);
      }
      const lockPath = join(dirname(manifestPath), "bun.lock");
      if (existsSync(lockPath)) verifyBunLock(root, lockPath, vendorFiles, platformNames, errors);
    }
  }
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
