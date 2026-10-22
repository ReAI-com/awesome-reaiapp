/**
 * 单实例锁：用操作系统的 flock(LOCK_EX | LOCK_NB) 锁住一个文件。
 *
 * 锁由内核持有，进程退出（含崩溃）时自动释放，不需要「读 PID、按路径删除」的接管逻辑，
 * 并发启动时只有一个能拿到锁。Node 没有 flock，这里经 bun:ffi 调用 libc。
 * Windows 版本后续改用 LockFileEx。
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { ComputerError } from "./agent-computer";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function libcPath(): string {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new ComputerError("INTERNAL", `当前平台暂不支持单实例锁：${process.platform}`);
}

let flock: ((fd: number, operation: number) => number) | null = null;

function loadFlock() {
  if (!flock) {
    const lib = dlopen(libcPath(), { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    flock = (fd, operation) => lib.symbols.flock(fd, operation);
  }
  return flock;
}

/** 本进程已持有的锁：路径 → 文件描述符（用于拒绝同进程内的第二个实例）。 */
const held = new Map<string, number>();

/**
 * 获取锁，返回绑定到这把锁的释放函数（幂等，只释放自己持有的那一把）。
 * 已被其他进程或本进程的另一实例持有时抛 CONFLICT。
 */
export function acquireInstanceLock(lockPath: string): () => void {
  if (held.has(lockPath)) throw new ComputerError("CONFLICT", "已有服务在运行");
  const fd = openSync(lockPath, "a", 0o600);
  try {
    if (loadFlock()(fd, LOCK_EX | LOCK_NB) !== 0) throw new ComputerError("CONFLICT", "已有服务在运行");
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  held.set(lockPath, fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      loadFlock()(fd, LOCK_UN);
    } finally {
      closeSync(fd);
      if (held.get(lockPath) === fd) held.delete(lockPath);
    }
  };
}
