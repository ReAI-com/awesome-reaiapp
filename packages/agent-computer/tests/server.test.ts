import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentComputer } from "../src/agent-computer";
import { Outbox } from "../src/outbox";
import { STANDARD_MODIFIERS } from "../src/keys";
import { RfbDisplayInput } from "../src/rfb-display";
import { handleRequest, serve, type ServerDeps } from "../src/server";
import type { VmProvider } from "../src/types";
import { FakeRfbServer } from "./fake-rfb-server";

let fake: FakeRfbServer;
let base: string;
let deps: ServerDeps;
let stopped = 0;

beforeEach(async () => {
  fake = await FakeRfbServer.start({ width: 100, height: 80 });
  base = await mkdtemp(join(tmpdir(), "agent-server-"));
  await mkdir(join(base, "inbox"));
  await mkdir(join(base, "outbox"));
  await mkdir(join(base, "target"));
  const port = fake.port;
  stopped = 0;
  const provider: VmProvider = {
    platform: "macos",
    shares: { inbox: join(base, "inbox"), outbox: join(base, "outbox") },
    status: async () => ({ name: "agent-1", exists: true, running: true, owned: true }),
    start: async () => ({ host: "127.0.0.1", port }),
    stop: async () => {
      stopped += 1;
      return { forced: false };
    },
  };
  deps = {
    computer: new AgentComputer({
      connectDisplay: async () => RfbDisplayInput.connect(await provider.start(), { unicodeText: true, physicalKeys: false, loginScreen: true }, STANDARD_MODIFIERS),
      minEventIntervalMs: 0,
    }),
    provider,
    outbox: new Outbox({ root: join(base, "outbox"), allowedTargets: [join(base, "target")] }),
    agentToken: "agent-token-1234",
    userToken: "user-token-5678",
  };
});
afterEach(async () => {
  deps.computer.close();
  await fake.stop();
  await rm(base, { recursive: true, force: true });
});

async function call(token: string | null, method: string, params: unknown = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await handleRequest(
    new Request("http://127.0.0.1/rpc", { method: "POST", headers, body: JSON.stringify({ method, params }) }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as { ok: boolean; result?: any; error?: { code: string } } };
}

describe("鉴权与分权", () => {
  test("没有令牌或令牌错误：401", async () => {
    expect((await call(null, "computer.state")).status).toBe(401);
    expect((await call("nope", "computer.state")).status).toBe(401);
  });

  test("Agent 不能恢复、不能批准导出、不能关机", async () => {
    for (const method of ["computer.resume", "files.outbox.list", "files.outbox.approve", "files.outbox.reject", "vm.stop"]) {
      const { status, body } = await call(deps.agentToken, method);
      expect([method, status, body.error?.code]).toEqual([method, 403, "FORBIDDEN"]);
    }
    expect(stopped).toBe(0);
    expect(deps.computer.stopped).toBe(true);
  });

  test("Agent 可以紧急停止；用户恢复后 Agent 才能点击", async () => {
    expect((await call(deps.agentToken, "computer.mouse.click", { x: 1, y: 1 })).body.error?.code).toBe("STOPPED");
    expect((await call(deps.userToken, "computer.resume")).body.result.stopped).toBe(false);
    expect((await call(deps.agentToken, "computer.mouse.click", { x: 1, y: 1 })).body.ok).toBe(true);
    expect((await call(deps.agentToken, "computer.stop")).body.result.stopped).toBe(true);
  });

  test("审计记录调用来源", async () => {
    await call(deps.userToken, "computer.resume");
    const trace = (await call(deps.agentToken, "computer.state")).body.result.trace;
    expect(trace[0]).toMatchObject({ action: "resume", source: "user" });
  });
});

describe("方法", () => {
  test("截图返回完整字段", async () => {
    const { body } = await call(deps.agentToken, "computer.screenshot", { maxEdge: 50 });
    expect(body.result).toMatchObject({ mime: "image/png", width: 50, height: 40, sourceWidth: 100, sourceHeight: 80 });
  });

  test("权限状态说明是虚拟机范围，不引导授权宿主", async () => {
    expect((await call(deps.agentToken, "computer.permissions.status")).body.result).toEqual({
      accessibility: true,
      screenRecording: true,
      scope: "vm",
    });
  });

  test("不支持的方法返回稳定的 UNSUPPORTED_ON_VM", async () => {
    for (const method of ["computer.windows.list", "computer.frontmost", "computer.permissions.request_accessibility"]) {
      const { status, body } = await call(deps.agentToken, method);
      expect([status, body.error?.code]).toEqual([501, "UNSUPPORTED_ON_VM"]);
    }
  });

  test("请求体是 null、数组或 params 不是对象：400", async () => {
    for (const raw of ["null", "[]", '{"method":"computer.state","params":[1]}', "not json"]) {
      const response = await handleRequest(
        new Request("http://127.0.0.1/rpc", { method: "POST", headers: { authorization: `Bearer ${deps.agentToken}` }, body: raw }),
        deps,
      );
      expect([raw, response.status]).toEqual([raw, 400]);
    }
  });

  test("未知方法 404", async () => {
    expect((await call(deps.agentToken, "computer.reboot")).status).toBe(404);
  });

  test("显示器列表", async () => {
    expect((await call(deps.agentToken, "computer.displays.list")).body.result).toEqual([
      { id: "main", width: 100, height: 80, originX: 0, originY: 0, primary: true },
    ]);
  });

  test("文件出口：列表只对用户开放，用户批准后进入目标目录", async () => {
    await writeFile(join(base, "outbox", "a.txt"), "hi");
    expect((await call(deps.agentToken, "files.outbox.list")).body.error?.code).toBe("FORBIDDEN");
    const list = (await call(deps.userToken, "files.outbox.list")).body.result;
    expect(list).toHaveLength(1);
    const approved = await call(deps.userToken, "files.outbox.approve", {
      candidateId: list[0].id,
      sha256: list[0].sha256,
      targetDir: join(base, "target"),
    });
    expect(approved.body.ok).toBe(true);
  });

  test("用户关机：先紧急停止再关机", async () => {
    await call(deps.userToken, "computer.resume");
    await call(deps.userToken, "vm.stop");
    expect(stopped).toBe(1);
    expect(deps.computer.stopped).toBe(true);
  });
});

test("服务只监听权限 600 的 Unix socket", async () => {
  const socketPath = join(base, "agent.sock");
  const server = await serve(deps, socketPath);
  try {
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    expect(server.server.port).toBeUndefined();
    // 用 node:http：同进程的其他测试可能用 happy-dom 替换全局 fetch。
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { socketPath, path: "/rpc", method: "POST", headers: { authorization: `Bearer ${deps.agentToken}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ method: "computer.state" }));
    });
    expect(status).toBe(200);
  } finally {
    server.stop();
  }
});

test("已有服务在运行时再次启动：拒绝，且不摘掉原服务的入口", async () => {
  const socketPath = join(base, "single.sock");
  const first = await serve(deps, socketPath);
  try {
    await expect(serve(deps, socketPath)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await stat(socketPath)).isSocket()).toBe(true);
  } finally {
    first.stop();
  }
  // 释放后可以再次启动
  const again = await serve(deps, socketPath);
  again.stop();
});

test("旧实例重复 stop 不会释放新实例的锁", async () => {
  const socketPath = join(base, "restart.sock");
  const first = await serve(deps, socketPath);
  first.stop();
  const second = await serve(deps, socketPath);
  try {
    first.stop();
    await expect(serve(deps, socketPath)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    second.stop();
  }
});

test("反复获取与释放不泄漏文件描述符", async () => {
  const lockPath = join(base, "fd.lock");
  const { acquireInstanceLock } = await import("../src/instance-lock");
  const countFds = () => readdirSync("/dev/fd").length;
  const before = countFds();
  for (let i = 0; i < 20; i += 1) acquireInstanceLock(lockPath)();
  const held = acquireInstanceLock(lockPath);
  for (let i = 0; i < 20; i += 1) expect(() => acquireInstanceLock(lockPath)).toThrow();
  held();
  expect(countFds()).toBeLessThanOrEqual(before);
});

test("另一个进程持有锁：拒绝启动", async () => {
  const socketPath = join(base, "other.sock");
  const holder = Bun.spawn(
    ["bun", "-e", `import { acquireInstanceLock } from "${join(import.meta.dir, "../src/instance-lock.ts")}"; acquireInstanceLock("${socketPath}.lock"); console.log("locked"); await Bun.sleep(5000);`],
    { stdout: "pipe" },
  );
  const reader = holder.stdout.getReader();
  await reader.read();
  try {
    await expect(serve(deps, socketPath)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    holder.kill();
    await holder.exited;
  }
  // 持有者退出后内核释放锁
  const server = await serve(deps, socketPath);
  server.stop();
});

test("遗留的锁文件与 socket 文件不影响启动", async () => {
  const socketPath = join(base, "stale.sock");
  await writeFile(`${socketPath}.lock`, "999999");
  const server = await serve(deps, socketPath);
  server.stop();
});

test("socket 路径被别的文件占用时拒绝启动", async () => {
  const socketPath = join(base, "occupied");
  await writeFile(socketPath, "not a socket");
  await expect(serve(deps, socketPath)).rejects.toMatchObject({ code: "FORBIDDEN" });
});
