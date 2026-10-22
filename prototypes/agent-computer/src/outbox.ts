/**
 * 文件出口：Agent 写进隔离暂存区的文件，只有用户批准的那一版内容才进入用户目录。
 *
 * - 只列普通文件；拒绝符号链接、设备文件与越出暂存区的真实路径。
 * - 批准绑定候选 ID + SHA-256：复制到宿主临时文件后重新计算摘要，一致才原子改名
 *   落到目标目录；客体在批准后改了文件则拒绝。
 * - 目标目录必须在允许列表内；默认不覆盖同名文件；单文件大小有上限。
 * - 已知残留风险：Node 没有 openat 一类按目录句柄的相对打开，父目录在检查与打开
 *   之间仍可能被客体替换，导致读取到暂存区外的宿主文件。读到的内容只会在用户批准后
 *   进入用户自己的目录、不会回到客体；列表只对用户开放，Agent 拿不到宿主文件的摘要。
 *   正式版应改用原生辅助程序逐级 openat(O_NOFOLLOW)。
 * - 暂存区由客体控制，客体可以在检查与操作之间替换路径：导出用 O_NOFOLLOW 打开
 *   后只经文件句柄读取并边读边算摘要；拒绝只在服务内标记、不删除宿主路径上的文件，
 *   避免目录被换成链接后误删暂存区外的文件。暂存区的清理由客体自己负责。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { ComputerError } from "./agent-computer";

export interface OutboxCandidate {
  id: string;
  path: string;
  size: number;
  sha256: string;
}

export interface OutboxOptions {
  root: string;
  allowedTargets: string[];
  maxFileBytes?: number;
  /** 一次列表最多扫描的条目数（含目录与被拒绝的文件）。 */
  maxFiles?: number;
  /** 一次列表最多为新文件计算摘要的总字节数，超出的文件留到下次列表。 */
  maxHashBytesPerList?: number;
}

export class Outbox {
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  /** 用户拒绝过的「候选 + 内容摘要」，列表里不再出现；内容变了会作为新候选重新出现。 */
  private readonly rejected = new Set<string>();
  /** 摘要缓存：文件身份与修改时间不变就不重复读取；批准时仍会重新校验内容。 */
  private readonly hashCache = new Map<string, { key: string; sha256: string }>();
  private readonly maxHashBytes: number;

  constructor(private readonly options: OutboxOptions) {
    this.maxFileBytes = options.maxFileBytes ?? 200 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 2000;
    this.maxHashBytes = options.maxHashBytesPerList ?? 2 * 1024 * 1024 * 1024;
  }

  async list(): Promise<OutboxCandidate[]> {
    const root = await realpath(this.options.root);
    const out: OutboxCandidate[] = [];
    let scanned = 0;
    let hashBudget = this.maxHashBytes;
    const seen = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      // 逐条枚举，到达条目上限立即停止，不先把整个目录读进内存。
      const handle = await opendir(dir).catch(() => null);
      if (!handle) return;
      for await (const entry of handle) {
        if (++scanned > this.maxFiles) return;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await lstat(full).catch(() => null);
        if (!info?.isFile() || info.size > this.maxFileBytes) continue;
        const rel = relative(root, full);
        const id = candidateId(rel);
        seen.add(id);
        const cacheKey = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
        let sha256 = this.hashCache.get(id)?.key === cacheKey ? this.hashCache.get(id)!.sha256 : null;
        if (!sha256) {
          // 按实际读取的字节扣预算：客体在检查后把文件变大也读不出预算之外的字节。
          // 读取中途出错也要把已读字节计入预算。
          const limit = Math.min(this.maxFileBytes, hashBudget);
          const hashed = await sha256Bounded(full, limit, (bytes) => {
            hashBudget -= bytes;
          }).catch(() => null);
          if (!hashed) continue;
          sha256 = hashed;
          this.hashCache.set(id, { key: cacheKey, sha256 });
        }
        if (this.rejected.has(`${id}:${sha256}`)) continue;
        out.push({ id, path: rel, size: info.size, sha256 });
      }
    };
    await walk(root);
    for (const id of this.hashCache.keys()) if (!seen.has(id)) this.hashCache.delete(id);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** 用户批准：把 candidateId 对应、且内容摘要仍为 sha256 的文件复制到目标目录。 */
  async approve(params: { candidateId?: unknown; sha256?: unknown; targetDir?: unknown }): Promise<{ path: string }> {
    const candidateIdValue = requireString(params.candidateId, "candidateId");
    const expected = requireString(params.sha256, "sha256").toLowerCase();
    const targetDir = await this.resolveTarget(requireString(params.targetDir, "targetDir"));
    const source = await this.resolveCandidate(candidateIdValue);

    const target = join(targetDir, basename(source.rel));
    if (await exists(target)) throw new ComputerError("CONFLICT", `目标位置已有同名文件：${basename(source.rel)}`);

    const temp = join(targetDir, `.agent-computer-${randomUUID()}.partial`);
    let committed = false;
    try {
      // 只经文件句柄读取：O_NOFOLLOW 拒绝最后一级是链接，fstat 确认是普通文件；
      // 边复制边算摘要并限制字节数，超限立即中止。
      const actual = await copyBounded(source.full, temp, this.maxFileBytes);
      if (actual !== expected) {
        throw new ComputerError("CONFLICT", "文件在批准后被修改，已拒绝导出，请重新查看后再批准");
      }
      // link 在目标已存在时失败，保证不覆盖。
      await link(temp, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") throw new ComputerError("CONFLICT", `目标位置已有同名文件：${basename(source.rel)}`);
        throw error;
      });
      committed = true;
      return { path: target };
    } finally {
      // 提交之后的清理失败不影响已完成的导出。
      await rm(temp, { force: true }).catch((error) => {
        if (!committed) throw error;
      });
    }
  }

  /** 用户拒绝：不再列出该候选的这一版内容；不删除宿主路径上的文件。 */
  async reject(params: { candidateId?: unknown; sha256?: unknown }): Promise<{ rejected: string }> {
    const id = requireString(params.candidateId, "candidateId");
    const sha256 = requireString(params.sha256, "sha256").toLowerCase();
    const source = await this.resolveCandidate(id);
    this.rejected.add(`${id}:${sha256}`);
    return { rejected: source.rel };
  }

  private async resolveCandidate(id: string): Promise<{ full: string; rel: string }> {
    let rel: string;
    try {
      rel = Buffer.from(id, "base64url").toString("utf8");
    } catch {
      throw new ComputerError("NOT_FOUND", "候选不存在");
    }
    if (!rel || rel.startsWith(sep) || rel.split(/[\\/]/).includes("..") || candidateId(rel) !== id) {
      throw new ComputerError("NOT_FOUND", "候选不存在");
    }
    const root = await realpath(this.options.root);
    const full = join(root, rel);
    // 整条路径的每一级都不能是符号链接，真实路径必须仍在暂存区内。
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const info = await lstat(current).catch(() => null);
      if (!info) throw new ComputerError("NOT_FOUND", "候选不存在");
      if (info.isSymbolicLink()) throw new ComputerError("FORBIDDEN", "拒绝导出符号链接");
    }
    const real = await realpath(full);
    if (real !== full || !real.startsWith(root + sep)) throw new ComputerError("FORBIDDEN", "路径越出暂存区");
    if (!(await lstat(real)).isFile()) throw new ComputerError("FORBIDDEN", "只能导出普通文件");
    return { full: real, rel };
  }

  private async resolveTarget(dir: string): Promise<string> {
    const real = await realpath(dir).catch(() => {
      throw new ComputerError("NOT_FOUND", "目标目录不存在");
    });
    let inAllowList = false;
    for (const allowed of this.options.allowedTargets) {
      const allowedReal = await realpath(allowed).catch(() => null);
      if (allowedReal && (real === allowedReal || real.startsWith(allowedReal + sep))) inAllowList = true;
    }
    if (!inAllowList) throw new ComputerError("FORBIDDEN", "目标目录不在允许列表内");
    // 目标目录必须属于当前用户且他人不可写，否则临时文件与最终落盘之间可能被替换。
    const info = await lstat(real);
    const uid = process.getuid?.();
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
      throw new ComputerError("FORBIDDEN", "目标目录必须属于当前用户且他人不可写");
    }
    return real;
  }
}

export async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
}

function candidateId(rel: string): string {
  return Buffer.from(rel, "utf8").toString("base64url");
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ComputerError("INVALID_ARGUMENT", `${name} 必须是非空字符串`);
  return value;
}

async function exists(path: string) {
  return (await lstat(path).catch(() => null)) !== null;
}

/** 经 O_NOFOLLOW 句柄复制到 dest（排他创建），限制字节数，返回内容摘要。 */
async function copyBounded(source: string, dest: string, maxBytes: number): Promise<string> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOOP") throw new ComputerError("FORBIDDEN", "拒绝导出符号链接");
    throw error;
  });
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new ComputerError("FORBIDDEN", "只能导出普通文件");
    if (info.size > maxBytes) throw new ComputerError("INVALID_ARGUMENT", "文件超过大小上限");
    // 校验通过前只有本人可读，避免未校验的内容被他人看到。
    const output = await open(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) throw new ComputerError("INVALID_ARGUMENT", "文件超过大小上限");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        // write 可能只写入一部分：按实际写入字节数补写，零进展视为失败。
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new ComputerError("INTERNAL", "写入导出文件失败");
          offset += bytesWritten;
        }
      }
      await output.sync();
      return hash.digest("hex");
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/**
 * 经 O_NOFOLLOW 句柄计算摘要，最多读取 limit 字节；超出或不是普通文件时返回 null。
 * 每次读取后经 onRead 报告实际读取量，读取中途出错时已读字节同样已报告。
 */
async function sha256Bounded(path: string, limit: number, onRead: (bytes: number) => void): Promise<string | null> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await input.stat()).isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.max(1, Math.min(1024 * 1024, limit + 1)));
    let total = 0;
    for (;;) {
      const want = Math.min(buffer.length, limit + 1 - total);
      if (want <= 0) return null;
      const { bytesRead } = await input.read(buffer, 0, want, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      onRead(bytesRead);
      if (total > limit) return null;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await input.close();
  }
}
