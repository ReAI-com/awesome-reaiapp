import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TartProvider, parseVncUrl, type CommandResult } from "../src/tart-provider";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tart-provider-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeTart(state: { vms: Record<string, boolean> }) {
  const calls: string[][] = [];
  const launches: Array<{ args: string[]; env: Record<string, string> }> = [];
  const run = async (args: string[]): Promise<CommandResult> => {
    calls.push(args);
    const [cmd, name] = args;
    if (cmd === "get") {
      if (!(name! in state.vms)) return { code: 1, stdout: "", stderr: `the specified VM "${name}" does not exist` };
      return { code: 0, stdout: JSON.stringify({ Running: state.vms[name!] }), stderr: "" };
    }
    if (cmd === "list") {
      return { code: 0, stdout: JSON.stringify(Object.values(state.vms).map((r) => ({ Running: r }))), stderr: "" };
    }
    if (cmd === "clone") {
      state.vms[args[2]!] = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "stop") {
      state.vms[name!] = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unknown" };
  };
  const launch = async (args: string[], env: Record<string, string>, logPath: string) => {
    launches.push({ args, env });
    state.vms[args.at(-1)!] = true;
    await writeFile(logPath, "Opening vnc://:p%40ss@127.0.0.1:5901...\n");
  };
  return { run, launch, calls, launches };
}

const shares = { inbox: "/tmp/in", outbox: "/tmp/out" };

describe("parseVncUrl", () => {
  test("解析密码与端口", () => {
    expect(parseVncUrl("Opening vnc://:abc@127.0.0.1:55001...")).toEqual({ host: "127.0.0.1", port: 55001, password: "abc" });
    expect(parseVncUrl("vnc://127.0.0.1:5900")).toEqual({ host: "127.0.0.1", port: 5900 });
    expect(parseVncUrl("no url here")).toBeNull();
  });

  test("不接受非回环地址", () => {
    expect(parseVncUrl("vnc://:x@192.168.64.2:5900")).toBeNull();
  });
});

describe("TartProvider", () => {
  test("状态查询失败不当成已停止：关机报错而不是返回成功", async () => {
    const tart = fakeTart({ vms: {} });
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    await provider.start();
    const broken = new TartProvider({
      name: "agent-1", baseImage: "base", stateDir: dir, shares, launch: tart.launch,
      run: async (args) => (args[0] === "get" ? { code: 1, stdout: "", stderr: "tart: internal error" } : tart.run(args)),
    });
    await expect(broken.stop()).rejects.toMatchObject({ code: "INTERNAL" });
  });

  test("启动进行中发起关机：等启动结算后再关，关机后不会再被旧启动拉起", async () => {
    const state = { vms: {} as Record<string, boolean> };
    const tart = fakeTart(state);
    let releaseLaunch!: () => void;
    const provider = new TartProvider({
      name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, sleep: async () => undefined,
      launch: async (args, env, logPath) => {
        await new Promise<void>((resolve) => (releaseLaunch = resolve));
        await tart.launch(args, env, logPath);
      },
    });
    const starting = provider.start();
    const deadline = Date.now() + 2000;
    while (!releaseLaunch && Date.now() < deadline) await Bun.sleep(2);
    const stopping = provider.stop();
    releaseLaunch();
    await starting;
    expect(await stopping).toEqual({ forced: true });
    await Bun.sleep(10);
    expect(state.vms["agent-1"]).toBe(false);
  });

  test("首次启动：克隆、登记所有权、按启动合同后台运行", async () => {
    const tart = fakeTart({ vms: {} });
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    const endpoint = await provider.start();
    expect(endpoint).toEqual({ host: "127.0.0.1", port: 5901, password: "p@ss" });
    expect(tart.calls.some((c) => c[0] === "clone")).toBe(true);
    expect(tart.launches[0]!.args).toEqual([
      "run", "--no-graphics", "--vnc-experimental", "--no-audio", "--no-clipboard",
      "--dir", "inbox:/tmp/in:ro", "--dir", "outbox:/tmp/out", "agent-1",
    ]);
    expect(tart.launches[0]!.env).toEqual({ CI: "1", TART_NO_AUTO_PRUNE: "1" });
    expect((await stat(join(dir, "vm.log"))).mode & 0o777).toBe(0o600);
    expect(await provider.status()).toEqual({ name: "agent-1", exists: true, running: true, owned: true });
  });

  test("已在运行：接管显示端点，不重启", async () => {
    const tart = fakeTart({ vms: {} });
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    await provider.start();
    const again = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    expect((await again.start()).port).toBe(5901);
    expect(tart.launches).toHaveLength(1);
  });

  test("不属于本服务的虚拟机：拒绝启动与关机", async () => {
    const tart = fakeTart({ vms: { "someone-else": false } });
    const provider = new TartProvider({ name: "someone-else", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch });
    await expect(provider.start()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(provider.stop()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tart.launches).toHaveLength(0);
  });

  test("槽位已满：不启动", async () => {
    const tart = fakeTart({ vms: { ci2: true, ci3: true } });
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch });
    await expect(provider.start()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tart.launches).toHaveLength(0);
  });

  test("关机：客体正常关机成功时不强制停止", async () => {
    const state = { vms: {} as Record<string, boolean> };
    const tart = fakeTart(state);
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    await provider.start();
    provider.guestPower = { shutdown: async () => void (state.vms["agent-1"] = false) };
    expect(await provider.stop(5_000)).toEqual({ forced: false });
    expect(tart.calls.some((c) => c[0] === "stop")).toBe(false);
  });

  test("关机：客体不响应时超时后强制停止并如实报告", async () => {
    const tart = fakeTart({ vms: {} });
    let now = 0;
    const provider = new TartProvider({
      name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch,
      sleep: async () => void (now += 1000),
    });
    await provider.start();
    provider.guestPower = { shutdown: async () => undefined };
    const realNow = Date.now;
    Date.now = () => realNow() + now;
    try {
      expect(await provider.stop(3_000)).toEqual({ forced: true });
    } finally {
      Date.now = realNow;
    }
    expect(tart.calls.find((c) => c[0] === "stop")).toEqual(["stop", "agent-1", "--timeout", "5"]);
  });

  test("关机：没有客体通道时直接强制停止", async () => {
    const tart = fakeTart({ vms: {} });
    const provider = new TartProvider({ name: "agent-1", baseImage: "base", stateDir: dir, shares, run: tart.run, launch: tart.launch, sleep: async () => undefined });
    await provider.start();
    expect(await provider.stop()).toEqual({ forced: true });
    expect((await provider.status()).running).toBe(false);
  });
});
