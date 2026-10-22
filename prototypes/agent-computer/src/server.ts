/**
 * 本地 API：POST /rpc {method, params}，只监听私有目录里的 Unix socket（权限 600）。
 * 不用 TCP 端口：回环端口任何本机进程都能抢先监听，CLI 会把用户令牌发给冒充者。
 *
 * 分权：Agent 令牌只能截图、输入、紧急停止、查看文件；恢复、批准导出、关机只接受
 * 用户令牌。方法名沿用 computer.*，让宿主日后可以把 computer.engine@1 转发过来。
 */
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, readdir, stat, unlink } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { AgentComputer, ComputerError, toComputerError, type Source } from "./agent-computer";
import { acquireInstanceLock } from "./instance-lock";
import type { Outbox } from "./outbox";
import type { VmProvider } from "./types";

export interface ServerDeps {
  computer: AgentComputer;
  provider: VmProvider;
  outbox: Outbox;
  agentToken: string;
  userToken: string;
}

type Params = Record<string, unknown>;
type Handler = (params: Params, source: Source) => unknown;

/** 只有用户能调用的方法。 */
const USER_ONLY = new Set([
  "computer.resume",
  "vm.stop",
  "files.outbox.list",
  "files.outbox.approve",
  "files.outbox.reject",
]);

const UNSUPPORTED = new Set([
  "computer.permissions.request_accessibility",
  "computer.permissions.open_screen_settings",
  "computer.windows.list",
  "computer.frontmost",
]);

export function createHandlers(deps: ServerDeps): Record<string, Handler> {
  const { computer, provider, outbox } = deps;
  return {
    "computer.state": () => computer.state(),
    "computer.stop": async (_p, source) => {
      await computer.stop(source);
      return computer.state();
    },
    "computer.resume": (_p, source) => {
      computer.resume(source);
      return computer.state();
    },
    "computer.screenshot": (p, source) => computer.screenshot(p, source),
    "computer.mouse.move": (p, source) => computer.move(p, source),
    "computer.mouse.click": (p, source) => computer.click(p, source),
    "computer.mouse.drag": (p, source) => computer.drag(p, source),
    "computer.mouse.scroll": (p, source) => computer.scroll(p, source),
    "computer.mouse.down": (p, source) => computer.mouseDown(p, source),
    "computer.mouse.up": (p, source) => computer.mouseUp(p, source),
    "computer.key.press": (p, source) => computer.keyPress(p, source),
    "computer.text.type": (p, source) => computer.typeText(p, source),
    "computer.displays.list": async () => {
      const size = await computer.displaySize();
      return [{ id: "main", ...size, originX: 0, originY: 0, primary: true }];
    },
    // 输入从虚拟机层注入，客体内不需要任何权限；不引导用户去授权宿主。
    "computer.permissions.status": () => ({ accessibility: true, screenRecording: true, scope: "vm" }),
    "vm.status": () => provider.status(),
    "vm.start": async () => {
      await provider.start();
      return provider.status();
    },
    "vm.stop": async (_p, source) => {
      await computer.stop(source);
      computer.close();
      const { forced } = await provider.stop();
      return { ...(await provider.status()), forced };
    },
    "files.inbox.list": () => listFiles(provider.shares.inbox),
    "files.outbox.list": () => outbox.list(),
    "files.outbox.approve": (p) => outbox.approve(p),
    "files.outbox.reject": (p) => outbox.reject(p),
  };
}

const STATUS: Record<string, number> = {
  STOPPED: 409,
  CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  UNSUPPORTED_ON_VM: 501,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  DISPLAY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export async function handleRequest(request: Request, deps: ServerDeps, handlers = createHandlers(deps)): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/rpc") return errorResponse(new ComputerError("NOT_FOUND", "只支持 POST /rpc"));
  const source = authenticate(request.headers.get("authorization"), deps);
  if (!source) return json({ ok: false, error: { code: "UNAUTHORIZED", message: "令牌无效" } }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new ComputerError("INVALID_ARGUMENT", "请求体必须是 JSON"));
  }
  if (!isPlainObject(body)) return errorResponse(new ComputerError("INVALID_ARGUMENT", "请求体必须是 JSON 对象"));
  const method = typeof body.method === "string" ? body.method : "";
  if (body.params !== undefined && !isPlainObject(body.params)) {
    return errorResponse(new ComputerError("INVALID_ARGUMENT", "params 必须是对象"));
  }
  const params = (body.params ?? {}) as Params;

  if (UNSUPPORTED.has(method)) return errorResponse(new ComputerError("UNSUPPORTED_ON_VM", `${method} 在 Agent 电脑上不可用`));
  const handler = handlers[method];
  if (!handler) return errorResponse(new ComputerError("NOT_FOUND", `未知方法：${method || "(空)"}`));
  if (USER_ONLY.has(method) && source !== "user") {
    return errorResponse(new ComputerError("FORBIDDEN", `${method} 只能由用户操作`));
  }
  try {
    return json({ ok: true, result: await handler(params, source) });
  } catch (error) {
    return errorResponse(toComputerError(error));
  }
}

export async function serve(deps: ServerDeps, socketPath: string) {
  const handlers = createHandlers(deps);
  const release = acquireInstanceLock(`${socketPath}.lock`);
  try {
    const existing = await lstat(socketPath).catch(() => null);
    if (existing) {
      const uid = process.getuid?.();
      if (!existing.isSocket() || (uid !== undefined && existing.uid !== uid)) {
        throw new ComputerError("FORBIDDEN", `${socketPath} 已存在且不是本用户的 socket`);
      }
      // 持有内核锁说明没有其他实例存活；再确认无人监听后清理遗留 socket。
      if (await socketAlive(socketPath)) throw new ComputerError("CONFLICT", "已有服务在运行");
      await unlink(socketPath);
    }
    const server = Bun.serve({ unix: socketPath, fetch: (request) => handleRequest(request, deps, handlers) });
    await chmod(socketPath, 0o600);
    return {
      server,
      /** 幂等：重复调用不影响之后在同一路径启动的新实例。 */
      stop() {
        server.stop(true);
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ path: socketPath });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function authenticate(header: string | null, deps: ServerDeps): Source | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  if (safeEqual(token, deps.userToken)) return "user";
  if (safeEqual(token, deps.agentToken)) return "agent";
  return null;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function errorResponse(error: ComputerError) {
  return json({ ok: false, error: { code: error.code, message: error.message } }, STATUS[error.code] ?? 500);
}

async function listFiles(root: string) {
  const out: Array<{ path: string; size: number }> = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.isFile()) out.push({ path: rel, size: (await stat(join(dir, entry.name))).size });
    }
  };
  await walk(root, "");
  return out;
}
