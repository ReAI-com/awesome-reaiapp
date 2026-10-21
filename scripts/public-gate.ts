#!/usr/bin/env bun
/**
 * 公开通用泄露闸门（插件仓 CI 用）。
 *
 * 只依赖 `node:` 内置模块，不含任何私有值：按路径 / 文件名、身份模板字段、通用密钥形态、
 * 个人绝对路径与真实邮箱形态扫描「完整文件内容」，并对 .tgz / .reaiapp 安全解包后递归扫描。
 * 输出只含结论、路径与规则名，绝不输出命中内容。
 *
 * 用法：
 *   bun scripts/public-gate.ts [--root <dir>]              # 遍历目录（默认 cwd）
 *   bun scripts/public-gate.ts --files <list> [--root <dir>]  # 逐行相对路径
 *   bun scripts/public-gate.ts --git-diff <base> [--root <dir>] # base...HEAD 的新增 / 修改文件
 *   [--allow <json>]...  精确豁免（可重复）：[{ "path": "...", "rule": "...", "sha256": "<文件摘要>" }]
 *                        导出物自带 scripts/public-gate.allow.json；插件仓自有的豁免放在另一个文件里一起传入。
 * 退出码：0 通过，1 命中，2 用法或输入错误。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { constants as zlibConstants, gunzipSync, inflateRawSync } from "node:zlib";

/** `oversize` 表示文件超过读取上限，未读入内容（bytes 为空），扫描时直接判失败。 */
export interface GateFile { path: string; bytes: Uint8Array; oversize?: boolean }
export interface GateFinding { path: string; rule: string }
/** 一次扫描全局共享的解包预算：多个压缩包、多层嵌套共用同一份累计额度。 */
export interface ArchiveLimits { maxInputBytes: number; maxMemberBytes: number; maxTotalBytes: number; maxMembers: number; maxDepth: number }
export const DEFAULT_LIMITS: ArchiveLimits = { maxInputBytes: 256 * 1024 * 1024, maxMemberBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxMembers: 50000, maxDepth: 2 };

/** 可变的累计计数；由 expandArchives 创建，传给 readTarGz / readZip。 */
export class ArchiveBudget {
  bytes = 0;
  members = 0;
  constructor(readonly limits: ArchiveLimits = DEFAULT_LIMITS) {}
  take(bytes: number): void {
    this.members += 1;
    this.bytes += bytes;
    if (bytes > this.limits.maxMemberBytes) throw new ArchiveError("成员超出大小上限");
    if (this.members > this.limits.maxMembers) throw new ArchiveError("累计成员数超出上限");
    if (this.bytes > this.limits.maxTotalBytes) throw new ArchiveError("累计解包量超出上限");
  }
  remaining(): number { return Math.max(0, this.limits.maxTotalBytes - this.bytes); }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class ArchiveError extends Error {}
/** 用法或输入错误：消息只用本文件的固定措辞（带错误码前缀），可以安全输出。 */
export class GateInputError extends Error {}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// ---------------------------------------------------------------------------
// 安全解包
// ---------------------------------------------------------------------------

/** 归档成员路径：相对、无 `..` / `.` / 空段 / 反斜杠 / NUL / 盘符。 */
export function safeMemberPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) return false;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

/** gzip + tar（USTAR / GNU）。只接受普通文件与目录；链接、设备、PAX/GNU 长名等扩展头一律拒绝。 */
export function readTarGz(compressed: Uint8Array, budget: ArchiveBudget = new ArchiveBudget(), headers?: Buffer[]): GateFile[] {
  if (compressed.byteLength > budget.limits.maxInputBytes) throw new ArchiveError("压缩输入超出大小上限");
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: Math.max(1024, budget.remaining() + 1024 * 1024) }); } catch { throw new ArchiveError("gzip 无效或超出解包上限"); }
  const text = (header: Buffer, start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  const octal = (value: string) => {
    if (!/^[0-7]+\s*$/.test(value)) throw new ArchiveError("tar 数字字段无效");
    return parseInt(value.trim(), 8);
  };
  const members: GateFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw new ArchiveError("tar 结束区之后仍有数据");
      return members;
    }
    headers?.push(Buffer.from(header)); // 头字段（uname / gname / linkname 等）也要过扫描
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(text(header, 148, 8))) throw new ArchiveError("tar 校验和不符");
    const prefix = text(header, 345, 155), name = text(header, 0, 100);
    const path = prefix ? `${prefix}/${name}` : name;
    const type = header[156]!;
    const size = octal(text(header, 124, 12));
    if (!safeMemberPath(path)) throw new ArchiveError("tar 成员路径不安全");
    if (type === 53) { // 目录：同样计入预算、查重，并作为空条目参与路径规则扫描
      if (size !== 0) throw new ArchiveError("tar 目录成员带数据");
      const directory = path.endsWith("/") ? path : `${path}/`;
      if (seen.has(directory)) throw new ArchiveError("tar 成员重复");
      budget.take(0);
      seen.add(directory);
      members.push({ path: directory, bytes: new Uint8Array(0) });
      offset += 512;
      continue;
    }
    if (type !== 0 && type !== 48) throw new ArchiveError("tar 含不支持的成员类型（链接 / 设备 / 扩展头）");
    if (seen.has(path)) throw new ArchiveError("tar 成员重复");
    if (offset + 512 + size > tar.length) throw new ArchiveError("tar 成员被截断");
    budget.take(size);
    seen.add(path);
    members.push({ path, bytes: tar.subarray(offset + 512, offset + 512 + size) });
    const paddedEnd = offset + 512 + Math.ceil(size / 512) * 512;
    if (paddedEnd > tar.length || tar.subarray(offset + 512 + size, paddedEnd).some(byte => byte !== 0)) throw new ArchiveError("tar 对齐填充区非零");
    offset = paddedEnd;
  }
  throw new ArchiveError("tar 缺少结束块");
}

/** zip（.reaiapp）。按中央目录读取；只支持 stored / deflate；拒绝加密、符号链接、ZIP64、重复与超限。 */
export function readZip(bytes: Uint8Array, budget: ArchiveBudget = new ArchiveBudget()): GateFile[] {
  if (bytes.byteLength > budget.limits.maxInputBytes) throw new ArchiveError("压缩输入超出大小上限");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (buffer.length < minEocd) throw new ArchiveError("zip 过短");
  let eocd = -1;
  for (let index = buffer.length - minEocd; index >= Math.max(0, buffer.length - minEocd - 0xffff); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new ArchiveError("zip 缺少结束目录");
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ArchiveError("zip 不支持 ZIP64");
  if (directoryOffset + directorySize > eocd) throw new ArchiveError("zip 中央目录越界");
  if (count === 0 && directorySize !== 0) throw new ArchiveError("zip 中央目录大小与成员数不符");
  const members: GateFile[] = [];
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new ArchiveError("zip 中央目录损坏");
    const madeBy = buffer.readUInt16LE(cursor + 4) >> 8;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const path = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!safeMemberPath(path)) throw new ArchiveError("zip 成员路径不安全");
    if (flags & 0x1) throw new ArchiveError("zip 成员加密");
    const unixMode = madeBy === 3 ? externalAttributes >>> 16 : 0;
    const fileType = unixMode & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) throw new ArchiveError("zip 含符号链接或特殊文件");
    const isDirectory = path.endsWith("/");
    if (isDirectory && (size !== 0 || compressedSize !== 0)) throw new ArchiveError("zip 目录成员带数据");
    if (!isDirectory && fileType === 0o040000) throw new ArchiveError("zip 目录成员命名不规范");
    if (seen.has(path)) throw new ArchiveError("zip 成员重复");
    budget.take(size);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new ArchiveError("zip 本地头损坏");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    if (localName !== path || buffer.readUInt16LE(localOffset + 8) !== method || (localFlags & 0x1) !== 0) throw new ArchiveError("zip 本地头与中央目录不一致");
    if ((localFlags & 0x8) === 0 && (buffer.readUInt32LE(localOffset + 18) !== compressedSize || buffer.readUInt32LE(localOffset + 22) !== size || buffer.readUInt32LE(localOffset + 14) !== crc)) {
      throw new ArchiveError("zip 本地头与中央目录不一致");
    }
    const dataStart = localOffset + 30 + localNameLength + buffer.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > directoryOffset) throw new ArchiveError("zip 成员被截断或越入中央目录");
    let dataEnd = dataStart + compressedSize;
    if (localFlags & 0x8) { // 数据描述符：可选签名 + crc + 两个 32 位大小
      const withSignature = dataEnd + 16 <= directoryOffset && buffer.readUInt32LE(dataEnd) === 0x08074b50;
      const descriptor = withSignature ? dataEnd + 4 : dataEnd;
      if (descriptor + 12 > directoryOffset || buffer.readUInt32LE(descriptor) !== crc || buffer.readUInt32LE(descriptor + 4) !== compressedSize || buffer.readUInt32LE(descriptor + 8) !== size) {
        throw new ArchiveError("zip 数据描述符与中央目录不一致");
      }
      dataEnd = descriptor + 12;
    }
    ranges.push([localOffset, dataEnd]);
    if (isDirectory) {
      seen.add(path);
      members.push({ path, bytes: new Uint8Array(0) });
      continue;
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) data = raw;
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); } catch { throw new ArchiveError("zip deflate 数据无效或超限"); }
    } else throw new ArchiveError("zip 压缩方式不受支持");
    if (data.length !== size) throw new ArchiveError("zip 成员长度与目录不符");
    if (crc32(data) !== crc) throw new ArchiveError("zip 成员 CRC 不符");
    seen.add(path);
    members.push({ path, bytes: data });
  }
  // 中央目录必须被恰好读完；本地记录必须首尾相接地铺满 [0, 中央目录)，不允许藏在目录之外的成员或数据。
  if (cursor !== directoryOffset + directorySize) throw new ArchiveError("zip 中央目录大小与成员数不符");
  ranges.sort((a, b) => a[0] - b[0]);
  let expected = 0;
  for (const [start, end] of ranges) {
    if (start !== expected) throw new ArchiveError("zip 存在中央目录未登记的数据");
    expected = end;
  }
  if (expected !== directoryOffset) throw new ArchiveError("zip 存在中央目录未登记的数据");
  if (eocd + 22 + buffer.readUInt16LE(eocd + 20) !== buffer.length) throw new ArchiveError("zip 结束目录之后仍有数据");
  return members;
}

const isTarGz = (path: string) => /\.(tgz|tar\.gz)$/i.test(path);
const isZip = (path: string) => /\.(reaiapp|zip)$/i.test(path) || /\.reaiapp[^/]*$/i.test(path);
const ZIP_LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP_SIGNATURE = Buffer.from([0x1f, 0x8b, 0x08]);
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** 文件任意位置出现 zip 本地头签名即按 zip 处理（带前缀的包、自解压包等）。 */
const hasZipMagic = (bytes: Uint8Array) => asBuffer(bytes).indexOf(ZIP_LOCAL_SIGNATURE) >= 0;
const hasGzipMagic = (bytes: Uint8Array) => bytes.length >= 3 && asBuffer(bytes).subarray(0, 3).equals(GZIP_SIGNATURE);
/** 文件中间藏着的 gzip 流：最多尝试 64 处签名，能解开的当作成员扫描。 */
function salvageEmbeddedGzip(bytes: Uint8Array, budget: ArchiveBudget, from = 1): GateFile[] {
  const buffer = asBuffer(bytes);
  const members: GateFile[] = [];
  for (let index = buffer.indexOf(GZIP_SIGNATURE, from); index >= 0; index = buffer.indexOf(GZIP_SIGNATURE, index + 3)) {
    // 每处签名计入成员预算；超出即整体判失败（由预算抛错），不会静默停止。
    budget.take(0);
    let raw: Buffer;
    try { raw = gunzipSync(buffer.subarray(index), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1024, budget.remaining()) }); } catch { continue; }
    if (raw.byteLength === 0) continue;
    budget.take(raw.byteLength);
    members.push({ path: `<gzip@${index}>`, bytes: raw });
  }
  return members;
}

/**
 * 解析失败的 zip（只按文件头识别、无法按中央目录读）兜底：按本地头签名逐个尝试解出数据，
 * 让藏在损坏结构里的成员仍被扫描。结果只用于扫描，不代表归档合法。
 */
export function salvageZip(bytes: Uint8Array, budget: ArchiveBudget): GateFile[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const members: GateFile[] = [];
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  for (let index = buffer.indexOf(signature), count = 0; index >= 0 && index + 30 <= buffer.length; index = buffer.indexOf(signature, index + 4), count++) {
    // 每次尝试都计入成员预算（失败也算），防止大量伪签名放大 CPU。
    budget.take(0);
    const method = buffer.readUInt16LE(index + 8);
    const compressedSize = buffer.readUInt32LE(index + 18);
    const nameLength = buffer.readUInt16LE(index + 26), extraLength = buffer.readUInt16LE(index + 28);
    const dataStart = index + 30 + nameLength + extraLength;
    if ((method !== 0 && method !== 8) || dataStart > buffer.length) continue;
    const name = encodeURIComponent(buffer.subarray(index + 30, index + 30 + nameLength).toString("utf8"));
    const dataEnd = compressedSize > 0 ? Math.min(buffer.length, dataStart + compressedSize) : buffer.length;
    let data: Buffer | null = null;
    try {
      if (method === 0) data = buffer.subarray(dataStart, compressedSize > 0 ? dataEnd : dataStart);
      else if (method === 8) data = inflateRawSync(buffer.subarray(dataStart, dataEnd), { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, budget.remaining()) });
    } catch { data = null; }
    if (data === null) continue;
    budget.take(data.byteLength);
    members.push({ path: `<salvage-${count}>/${name}`, bytes: data });
  }
  return members;
}

/**
 * 把文件集合展开成「待扫描条目」：普通文件原样保留；压缩包本身保留（文件名规则仍要检查），
 * 其成员以 `<包路径>!/<成员>` 追加，最多 maxDepth 层。解包失败返回 `archive-unsafe`。
 */
export function expandArchives(files: readonly GateFile[], limits: ArchiveLimits = DEFAULT_LIMITS): { entries: GateFile[]; unsafe: GateFinding[] } {
  const entries: GateFile[] = [];
  const unsafe: GateFinding[] = [];
  const budget = new ArchiveBudget(limits);
  const fail = (path: string) => unsafe.push({ path, rule: "archive-unsafe" });
  const visit = (file: GateFile, depth: number) => {
    entries.push(file);
    // 按扩展名声明的压缩包必须能安全解开，否则判失败。
    // 只按文件头识别的（.xlsx、改了扩展名的包等）：zip 解不开时按本地头兜底解出数据扫描（夹具里有故意损坏的样本），
    // gzip 解不开判失败；超过嵌套深度一律判失败。
    const declared = isTarGz(file.path) ? "tar" : isZip(file.path) ? "zip" : null;
    const kind = declared ?? (hasGzipMagic(file.bytes) ? "gzip" : hasZipMagic(file.bytes) ? "zip" : null);
    // 任何文件（含 zip）中间夹带的 gzip 流都解出检查；超过嵌套深度时只要存在可解的夹带流即判失败。
    let embedded: GateFile[] = [];
    try { embedded = salvageEmbeddedGzip(file.bytes, budget, kind === "gzip" || kind === "tar" ? 3 : 1); } catch { fail(file.path); return; }
    if (embedded.length > 0) {
      if (depth >= limits.maxDepth) { fail(file.path); return; }
      for (const member of embedded) visit({ path: `${file.path}!/${member.path}`, bytes: member.bytes }, depth + 1);
    }
    if (!kind) return;
    if (depth >= limits.maxDepth) { fail(file.path); return; }
    let members: GateFile[];
    try {
      if (kind === "zip") {
        try { members = readZip(file.bytes, budget); } catch (error) {
          if (declared || error instanceof ArchiveError && /超出|上限/.test(error.message)) throw error;
          members = salvageZip(file.bytes, budget);
        }
      } else {
        const headers: Buffer[] = [];
        try { members = readTarGz(file.bytes, budget, headers); } catch (error) {
          if (kind === "tar") throw error;
          // 普通 gzip（非 tar）：解压字节当作单个成员。
          const raw = gunzipSync(file.bytes, { maxOutputLength: Math.max(1024, budget.remaining()) });
          budget.take(raw.byteLength);
          headers.length = 0;
          members = [{ path: "<gunzip>", bytes: raw }];
        }
        if (headers.length > 0) entries.push({ path: `${file.path}!/<tar-headers>`, bytes: Buffer.concat(headers) });
      }
    } catch {
      fail(file.path);
      return;
    }
    for (const member of members) visit({ path: `${file.path}!/${member.path}`, bytes: member.bytes }, depth + 1);
  };
  for (const file of files) visit(file, 0);
  return { entries, unsafe };
}

// ---------------------------------------------------------------------------
// 公开规则
// ---------------------------------------------------------------------------

/** 占位用户名：示例、测试与 CI 中常见、不指向真人的名字。 */
export const PLACEHOLDER_USERS = new Set([
  "example", "examples", "alice", "bob", "carol", "me", "user", "username", "you", "your-name", "yourname", "name",
  "runner", "test", "tester", "demo", "foo", "bar", "someone", "shared", "Shared", "admin", "dev", "developer", "x",
  "<user>", "<name>", "<you>", "$USER", "${USER}", "...", "…",
]);
const EXAMPLE_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;
/** 真实邮箱只认常见真实顶级域，避免把压缩代码里的随机串当邮箱。 */
const REAL_TLDS = new Set(["com", "net", "org", "io", "ai", "dev", "app", "co", "cn", "me", "edu", "gov", "info", "biz", "xyz", "tech", "cloud", "us", "uk", "de", "jp", "fr", "hk", "tw", "sg", "ca", "au", "in", "ru", "kr", "email", "mail"]);

const TEXT_LIMIT = 64 * 1024 * 1024;
function asText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > TEXT_LIMIT) return null;
  // 二进制文件（含 NUL）仍按 latin1 扫描密钥形态，确保嵌在二进制里的 token 不被跳过。
  return Buffer.from(bytes).toString(bytes.includes(0) ? "latin1" : "utf8");
}

const PLACEHOLDER_VALUE = /^(?:REPLACE[A-Z0-9_]*|<[^>]*>|\$\{[^}]*\}|x+|\*+|changeme|your[-_a-z]*|example[-_a-z]*|placeholder|redacted|dummy|test[-_a-z]*|fake[-_a-z]*)$/i;

export const PUBLIC_RULES = [
  "forbidden-identity-file", "forbidden-submission-receipt", "forbidden-key-file", "identity-placeholder",
  "private-key-block", "client-secret-assignment", "token-prefix", "personal-abs-path", "real-email", "archive-unsafe", "oversize-file", "symlink",
] as const;

function pathRules(path: string): string[] {
  const leaf = basename(path.split("!/").pop()!);
  const hits: string[] = [];
  if (leaf === "submission.identity.json") hits.push("forbidden-identity-file");
  if (/\.submission\.json$/i.test(leaf) || /-submission\.reaiapp/i.test(leaf)) hits.push("forbidden-submission-receipt");
  if (/\.(pem|key|p12|pfx)$/i.test(leaf) || (/^\.env(\..+)?$/.test(leaf) && leaf !== ".env.example")) hits.push("forbidden-key-file");
  return hits;
}

function identityPlaceholderRule(path: string, text: string): boolean {
  const leaf = basename(path.split("!/").pop()!);
  if (!/^submission\.identity.*\.json$/.test(leaf) && leaf !== "app.manifest.json") return false;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return leaf !== "app.manifest.json"; } // 身份模板必须是合法 JSON
  const found: unknown[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) { if (key === "productId") found.push(child); walk(child); }
  };
  walk(value);
  return found.some(item => typeof item !== "string" || !/^REPLACE[A-Z0-9_]*$/.test(item));
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const CLIENT_SECRET = /client[_-]?secret["']?\s*[:=]\s*(?:(["'`])([^"'`\r\n]*)\1|([^\s"'`,;)}\]]+)(?=$|[\s,;)}\]]))/gim;
const TOKEN_PATTERNS = [
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{60,}/,
  /(?<![A-Za-z0-9_-])sk-(?:proj-|ant-(?:api\d\d-)?)?(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9]{32,}/,
  /(?<![A-Za-z0-9])xox[abprs]-[0-9]{6,}-[A-Za-z0-9-]{10,}/,
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/,
  /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/,
];
const PERSONAL_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^/\\\s"'`<>()[\]{},;:*?|]+)[/\\]/g;
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

/**
 * 只对「像密钥值」的赋值判命中：引号内字面量 ≥8 字符且非占位；不带引号的值（env / YAML 风格）
 * 还必须同时含字母与数字，以排除变量名、正则与类型标注。
 */
function clientSecretHit(text: string): boolean {
  for (const match of text.matchAll(CLIENT_SECRET)) {
    const quoted = match[2] !== undefined;
    const value = (quoted ? match[2] : match[3]) ?? "";
    if (value.length < 8 || PLACEHOLDER_VALUE.test(value)) continue;
    if (/^(process\.env|import\.meta\.env|env\.|Deno\.env|\$\{|<)/.test(value)) continue;
    if (!quoted && !(/\d/.test(value) && /[A-Za-z]/.test(value) && /^[A-Za-z0-9._~+/=-]+$/.test(value))) continue;
    return true;
  }
  return false;
}

export function scanPublic(files: readonly GateFile[], limits: ArchiveLimits = DEFAULT_LIMITS): GateFinding[] {
  const { entries, unsafe } = expandArchives(files, limits);
  const findings: GateFinding[] = [...unsafe];
  for (const entry of entries) {
    for (const rule of pathRules(entry.path)) findings.push({ path: entry.path, rule });
    const add = (rule: string) => findings.push({ path: entry.path, rule });
    // 文件名 / 成员路径本身也过通用密钥、个人路径与邮箱规则。
    for (const rule of sensitivePathRules(entry.path)) add(rule);
    // 压缩包自身的原始字节也扫描：zip 的注释、扩展字段、文件名都是明文。
    const text = entry.oversize ? null : asText(entry.bytes);
    if (text === null) { add("oversize-file"); continue; }
    if (identityPlaceholderRule(entry.path, text)) add("identity-placeholder");
    if (PRIVATE_KEY_BLOCK.test(text)) add("private-key-block");
    if (clientSecretHit(text)) add("client-secret-assignment");
    if (TOKEN_PATTERNS.some(pattern => pattern.test(text))) add("token-prefix");
    for (const match of text.matchAll(PERSONAL_PATH)) {
      if (!PLACEHOLDER_USERS.has(match[1]!) && !/^[<$%{]/.test(match[1]!)) { add("personal-abs-path"); break; }
    }
    for (const match of text.matchAll(EMAIL)) {
      const domain = match[1]!.toLowerCase();
      const tld = domain.split(".").pop()!;
      if (!EXAMPLE_EMAIL_DOMAIN.test(domain) && REAL_TLDS.has(tld)) { add("real-email"); break; }
    }
  }
  return dedupe(findings);
}

/** 路径本身命中的通用敏感规则（token、私钥块、个人路径、真实邮箱）。 */
export function sensitivePathRules(path: string): string[] {
  const rules: string[] = [];
  if (TOKEN_PATTERNS.some(pattern => pattern.test(path))) rules.push("token-prefix");
  if (PRIVATE_KEY_BLOCK.test(path)) rules.push("private-key-block");
  for (const match of `/${path}`.matchAll(PERSONAL_PATH)) {
    if (!PLACEHOLDER_USERS.has(match[1]!) && !/^[<$%{]/.test(match[1]!)) { rules.push("personal-abs-path"); break; }
  }
  // 文件名里的邮箱后面常跟扩展名（a@b.com.txt）：逐级去掉末段再判断。
  for (const match of path.matchAll(EMAIL)) {
    const labels = match[1]!.toLowerCase().split(".");
    for (let end = labels.length; end >= 2; end--) {
      const domain = labels.slice(0, end).join(".");
      if (!EXAMPLE_EMAIL_DOMAIN.test(domain) && REAL_TLDS.has(labels[end - 1]!)) { rules.push("real-email"); break; }
    }
    if (rules.includes("real-email")) break;
  }
  return rules;
}

/** 日志里的路径：路径本身命中敏感规则时整体隐藏，否则做长串掩码。 */
export function displayPath(path: string): string {
  return sensitivePathRules(path).length > 0 ? "[REDACTED-PATH]" : maskPath(path);
}

/** 打印前的路径脱敏：路径段中的 UUID 形串与 ≥20 位字母数字串一律替换为 [ID]。 */
export function maskPath(path: string): string {
  return path
    .replace(/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, "[ID]")
    .replace(/[A-Za-z0-9]{20,}/g, "[ID]");
}

export function dedupe(findings: readonly GateFinding[]): GateFinding[] {
  const map = new Map(findings.map(item => [`${item.path}\0${item.rule}`, item]));
  return [...map.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
}

export interface AllowEntry { path: string; rule: string; sha256: string }
/** 豁免文件结构校验：每项必须有普通相对路径、已知规则名与 64 位十六进制摘要；不可豁免符号链接与解包失败。 */
export function parseAllow(text: string): AllowEntry[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GateInputError("INPUT_INVALID: 豁免文件不是合法 JSON"); }
  if (!Array.isArray(value)) throw new GateInputError("INPUT_INVALID: 豁免文件必须是数组");
  return value.map(item => {
    const entry = item as Partial<AllowEntry>;
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("!/") || entry.path.startsWith("/") || entry.path.split("/").includes("..")
      || typeof entry.rule !== "string" || !(PUBLIC_RULES as readonly string[]).includes(entry.rule) || ["symlink", "archive-unsafe", "forbidden-identity-file", "forbidden-submission-receipt"].includes(entry.rule)
      || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new GateInputError("INPUT_INVALID: 豁免项结构不合法");
    }
    return { path: entry.path, rule: entry.rule, sha256: entry.sha256 };
  });
}

/** 豁免只按 (外层文件路径, 规则, 外层文件摘要) 精确匹配；文件一改即失效。 */
export function applyAllow(findings: readonly GateFinding[], files: readonly GateFile[], allow: readonly AllowEntry[]): GateFinding[] {
  // 未读入内容的超限文件没有真实摘要，不能被豁免。
  const digests = new Map(files.filter(file => !file.oversize).map(file => [file.path, sha256(file.bytes)]));
  return findings.filter(finding => {
    const outer = finding.path.split("!/")[0]!;
    const digest = digests.get(outer);
    return digest === undefined || !allow.some(entry => entry.path === outer && entry.rule === finding.rule && entry.sha256 === digest);
  });
}

// ---------------------------------------------------------------------------
// 文件收集
// ---------------------------------------------------------------------------

const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/** 单文件读取上限与一次收集的总量上限：超限文件不读入，只标记 oversize；总量超限按输入错误中止。 */
export const COLLECT_LIMITS = { maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 };
function readBounded(absolute: string, path: string, size: number, counter: { bytes: number }): GateFile {
  if (size > COLLECT_LIMITS.maxFileBytes) return { path, bytes: new Uint8Array(0), oversize: true };
  counter.bytes += size;
  if (counter.bytes > COLLECT_LIMITS.maxTotalBytes) throw new GateInputError("INPUT_INVALID: 待扫描文件总量超出上限");
  return { path, bytes: readFileSync(absolute) };
}

/**
 * 遍历目录下全部普通文件（不跟随符号链接）。默认跳过 `.git`、`node_modules`；
 * `strict` 时不跳过任何目录，并把符号链接与特殊文件分别报告。
 */
export function collectDirectory(root: string, { strict = false }: { strict?: boolean } = {}): { files: GateFile[]; symlinks: string[]; special: string[] } {
  const files: GateFile[] = [];
  const symlinks: string[] = [];
  const special: string[] = [];
  const counter = { bytes: 0 };
  const visit = (relativePath: string) => {
    const absolute = relativePath ? join(root, relativePath) : root;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) { symlinks.push(relativePath); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!strict && SKIP_DIRECTORIES.has(name)) continue;
        visit(relativePath ? `${relativePath}/${name}` : name);
      }
    } else if (stat.isFile()) files.push(readBounded(absolute, relativePath, stat.size, counter));
    else special.push(relativePath);
  };
  visit("");
  return { files, symlinks, special };
}

/** 按清单读取文件；清单路径必须落在 root 内，缺失文件按输入错误处理。 */
export function collectList(root: string, paths: readonly string[], { trim = true }: { trim?: boolean } = {}): GateFile[] {
  const realRoot = realpathSync(resolve(root));
  const counter = { bytes: 0 };
  // 文本清单按行去掉首尾空白；git 给出的 NUL 分隔路径原样使用（文件名可以合法地带空格）。
  return paths.map(item => trim ? item.trim() : item).filter(item => item.length > 0).map(item => {
    const absolute = resolve(realRoot, item);
    if (absolute !== realRoot && !absolute.startsWith(realRoot + sep)) throw new GateInputError("INPUT_INVALID: 清单路径越出根目录");
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) throw new GateInputError("INPUT_INVALID: 清单中的文件不存在或不是普通文件");
    // 祖先目录里的符号链接同样不得把读取带出根目录。
    const real = realpathSync(absolute);
    if (real !== absolute) throw new GateInputError("INPUT_INVALID: 清单路径经过符号链接");
    return readBounded(absolute, relative(realRoot, absolute).split(sep).join("/"), lstatSync(absolute).size, counter);
  });
}

/** `git diff --name-only --diff-filter=ACMR <base>...HEAD`，读工作树完整内容；不执行任何仓内代码。 */
export function gitDiffPaths(root: string, base: string): string[] {
  if (!/^[\w./@^~-]+$/.test(base) || base.startsWith("-")) throw new GateInputError("USAGE: base 引用格式无效");
  const result = spawnSync("git", ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=ACMR", `${base}...HEAD`, "--"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new GateInputError("GIT_FAILED: git diff 失败");
  return result.stdout.split("\0").filter(Boolean);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new GateInputError(`USAGE: ${name} 缺少参数`);
  return value;
}

export function runPublicGateCli(args: string[], write: (line: string) => void = line => console.log(line)): number {
  try {
    const root = resolve(argument(args, "--root") ?? process.cwd());
    const listFile = argument(args, "--files");
    const base = argument(args, "--git-diff");
    const allowFiles = args.flatMap((arg, index) => {
      if (arg !== "--allow") return [];
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new GateInputError("USAGE: --allow 缺少参数");
      return [value];
    });
    if (listFile && base) throw new GateInputError("USAGE: --files 与 --git-diff 只能二选一");
    let files: GateFile[];
    let symlinks: string[] = [];
    if (listFile) files = collectList(root, readFileSync(listFile, "utf8").split(/\r?\n/));
    else if (base) files = collectList(root, gitDiffPaths(root, base), { trim: false });
    else {
      const collected = collectDirectory(root);
      files = collected.files;
      symlinks = [...collected.symlinks, ...collected.special];
    }
    const allow = allowFiles.flatMap(file => parseAllow(readFileSync(file, "utf8")));
    const findings = applyAllow(dedupe([...scanPublic(files), ...symlinks.map(path => ({ path, rule: "symlink" }))]), files, allow);
    if (findings.length === 0) {
      write(`PASS public-gate: ${files.length} 个文件，0 命中`);
      return 0;
    }
    for (const finding of findings) write(`FAIL ${displayPath(finding.path)} [${finding.rule}]`);
    write(`FAIL public-gate: ${findings.length} 处命中`);
    return 1;
  } catch (error) {
    // 只输出本文件固定措辞的错误；其他异常（文件系统等）只给类别，避免把路径或内容带进日志。
    write(`ERROR public-gate: ${error instanceof GateInputError ? maskPath(error.message) : "INTERNAL: 读取或解析输入失败"}`);
    return 2;
  }
}

if (import.meta.main) process.exit(runPublicGateCli(process.argv.slice(2)));
