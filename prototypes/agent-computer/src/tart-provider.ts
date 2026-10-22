/**
 * macOS 客体的 VmProvider（原型用 tart 2.37.0）。
 *
 * - 启动合同：CI=1 防止 tart 在宿主打开「屏幕共享」；--no-graphics 不开窗口；
 *   --no-clipboard 不与宿主共用剪贴板；--vnc-experimental 走 Virtualization.framework
 *   内置 VNC（私有接口，固定验证过的 tart 与宿主版本）。
 * - VNC 地址与密码从 tart 输出解析；日志文件权限 600，内容不进 API 与错误。
 * - 所有权：只操作 ownership 记录里登记过的虚拟机。
 * - tart 为 FSL 许可，仅用于原型；接口隔离，替换时上层不动。
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ComputerError } from "./agent-computer";
import type { DisplayEndpoint, GuestPower, SharedFolders, VmProvider, VmStatus } from "./types";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[], env?: Record<string, string>, timeoutMs?: number) => Promise<CommandResult>;

/** tart 命令的默认执行时限；克隆可能拷贝几十 GB，单独放宽。卡住的命令不能拖住生命周期队列。 */
const COMMAND_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 30 * 60_000;
export type Launcher = (args: string[], env: Record<string, string>, logPath: string) => Promise<void>;

export interface TartProviderOptions {
  name: string;
  baseImage: string;
  stateDir: string;
  shares: SharedFolders;
  tartPath?: string;
  /** 本机同时运行的 macOS 客体上限（Virtualization.framework 限制为 2）。 */
  maxRunningMacVms?: number;
  readyTimeoutMs?: number;
  run?: CommandRunner;
  launch?: Launcher;
  sleep?: (ms: number) => Promise<void>;
}

const VNC_URL = /vnc:\/\/(?::([^@\s]*)@)?(127\.0\.0\.1|localhost|\[::1\]):(\d+)/;

export function parseVncUrl(text: string): DisplayEndpoint | null {
  const matches = [...text.matchAll(new RegExp(VNC_URL, "g"))];
  const last = matches.at(-1);
  if (!last) return null;
  const host = last[2] === "localhost" ? "127.0.0.1" : last[2]!.replace(/^\[|\]$/g, "");
  const endpoint: DisplayEndpoint = { host, port: Number(last[3]) };
  if (last[1]) endpoint.password = decodeURIComponent(last[1]);
  return endpoint;
}

export class TartProvider implements VmProvider {
  readonly platform = "macos" as const;
  readonly shares: SharedFolders;
  private readonly tart: string;
  private readonly run: CommandRunner;
  private readonly launch: Launcher;
  private readonly sleep: (ms: number) => Promise<void>;
  private starting: Promise<DisplayEndpoint> | null = null;
  /** 启动、接管与关机共用一条串行生命周期队列：关机会等进行中的启动结算后再执行。 */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** 客体内正常关机的通道；没有时只能强制停止。 */
  guestPower: GuestPower | null = null;

  constructor(private readonly options: TartProviderOptions) {
    this.shares = options.shares;
    this.tart = options.tartPath ?? "/opt/homebrew/bin/tart";
    this.run = options.run ?? defaultRunner(this.tart);
    this.launch = options.launch ?? defaultLauncher(this.tart);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get logPath() {
    return join(this.options.stateDir, "vm.log");
  }

  private get ownershipPath() {
    return join(this.options.stateDir, "vm-owner.json");
  }

  async status(): Promise<VmStatus> {
    const info = await this.vmInfo(this.options.name);
    return { name: this.options.name, exists: info !== null, running: info?.running ?? false, owned: await this.owned() };
  }

  start(): Promise<DisplayEndpoint> {
    if (!this.starting) {
      this.starting = this.enqueue(() => this.doStart()).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  stop(timeoutMs = 60_000): Promise<{ forced: boolean }> {
    return this.enqueue(() => this.doStop(timeoutMs));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(work);
    this.lifecycle = task.catch(() => undefined);
    return task;
  }

  private async doStop(timeoutMs: number): Promise<{ forced: boolean }> {
    await this.assertOwned();
    if (!(await this.vmInfo(this.options.name))?.running) return { forced: false };

    // 先让客体自己关机：tart stop 是「拔电源」式停止，刚写入的数据会丢。
    if (this.guestPower) {
      const requested = await this.guestPower.shutdown().then(
        () => true,
        () => false,
      );
      if (requested && (await this.waitStopped(timeoutMs))) return { forced: false };
    }

    const result = await this.run(["stop", this.options.name, "--timeout", "5"]);
    if (result.code !== 0) throw new ComputerError("INTERNAL", `强制停止失败：${result.stderr.trim() || result.code}`);
    if (!(await this.waitStopped(30_000))) throw new ComputerError("INTERNAL", "强制停止后虚拟机仍在运行");
    return { forced: true };
  }

  private async waitStopped(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.vmInfo(this.options.name))?.running) return true;
      if (Date.now() > deadline) return false;
      await this.sleep(1000);
    }
  }

  /** 客体的内网地址（供文字输入辅助使用）。 */
  async ip(): Promise<string> {
    const result = await this.run(["ip", this.options.name, "--wait", "30"]);
    const ip = result.stdout.trim();
    if (result.code !== 0 || !/^[\d.]+$/.test(ip)) throw new ComputerError("DISPLAY_UNAVAILABLE", "拿不到客体的网络地址");
    return ip;
  }

  private async doStart(): Promise<DisplayEndpoint> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    let info = await this.vmInfo(this.options.name);
    if (!info) {
      await this.cloneBase();
      info = await this.vmInfo(this.options.name);
      if (!info) throw new ComputerError("INTERNAL", "克隆后找不到虚拟机");
    } else {
      await this.assertOwned();
    }

    if (info.running) {
      // 服务重启接管：沿用正在运行的虚拟机与它的显示端点，不重启它。
      const endpoint = await this.readEndpoint();
      if (endpoint) return endpoint;
      throw new ComputerError("DISPLAY_UNAVAILABLE", "虚拟机正在运行，但找不到它的显示端点（不是由本服务以 VNC 模式启动）");
    }

    const running = await this.runningMacVmCount();
    if (running >= (this.options.maxRunningMacVms ?? 2)) {
      throw new ComputerError("CONFLICT", "本机运行中的 macOS 虚拟机已达上限，请先腾出槽位");
    }

    await writeFile(this.logPath, "", { mode: 0o600 });
    await chmod(this.logPath, 0o600);
    await this.launch(
      [
        "run",
        "--no-graphics",
        "--vnc-experimental",
        "--no-audio",
        "--no-clipboard",
        "--dir",
        `inbox:${this.shares.inbox}:ro`,
        "--dir",
        `outbox:${this.shares.outbox}`,
        this.options.name,
      ],
      { CI: "1", TART_NO_AUTO_PRUNE: "1" },
      this.logPath,
    );

    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 180_000);
    for (;;) {
      const endpoint = await this.readEndpoint();
      if (endpoint) return endpoint;
      if (Date.now() > deadline) throw new ComputerError("DISPLAY_UNAVAILABLE", "等待虚拟机显示端点超时");
      await this.sleep(1000);
    }
  }

  private async cloneBase() {
    const result = await this.run(["clone", this.options.baseImage, this.options.name], { TART_NO_AUTO_PRUNE: "1" }, CLONE_TIMEOUT_MS);
    if (result.code !== 0) throw new ComputerError("INTERNAL", `克隆基础镜像失败：${result.stderr.trim() || result.code}`);
    await this.writeOwnership();
  }

  /** 把已存在的虚拟机登记为本服务所有（仅供用户在 CLI 显式接管）。 */
  async writeOwnership() {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      this.ownershipPath,
      JSON.stringify({ name: this.options.name, baseImage: this.options.baseImage, owner: "agent-computer" }, null, 2),
      { mode: 0o600 },
    );
  }

  private async owned(): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(this.ownershipPath, "utf8")) as { name?: string; owner?: string };
      return record.name === this.options.name && record.owner === "agent-computer";
    } catch {
      return false;
    }
  }

  private async assertOwned() {
    if (!(await this.owned())) {
      throw new ComputerError("FORBIDDEN", `虚拟机 ${this.options.name} 不属于本服务，拒绝操作`);
    }
  }

  private async readEndpoint(): Promise<DisplayEndpoint | null> {
    const text = await readFile(this.logPath, "utf8").catch(() => "");
    return parseVncUrl(text);
  }

  /**
   * 查询虚拟机状态：明确不存在返回 null；查询失败或输出无法识别时报错，
   * 不能把「未知」当成「不存在 / 已停止」（否则关机可能未经确认就返回成功）。
   */
  private async vmInfo(name: string): Promise<{ running: boolean } | null> {
    const result = await this.run(["get", name, "--format", "json"]);
    if (result.code !== 0) {
      if (/does not exist|not found|no such/i.test(result.stderr)) return null;
      throw new ComputerError("INTERNAL", `无法查询虚拟机状态：${result.stderr.trim().slice(0, 200) || result.code}`);
    }
    let parsed: { Running?: unknown; State?: unknown };
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new ComputerError("INTERNAL", "无法识别虚拟机状态输出");
    }
    if (typeof parsed.Running === "boolean") return { running: parsed.Running };
    if (parsed.State === "running" || parsed.State === "stopped" || parsed.State === "suspended") {
      return { running: parsed.State === "running" };
    }
    throw new ComputerError("INTERNAL", "虚拟机状态输出缺少运行状态");
  }

  private async runningMacVmCount(): Promise<number> {
    const result = await this.run(["list", "--source", "local", "--format", "json"]);
    if (result.code !== 0) return Number.POSITIVE_INFINITY;
    try {
      const list = JSON.parse(result.stdout) as Array<{ Running?: boolean; State?: string }>;
      return list.filter((vm) => vm.Running === true || vm.State === "running").length;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
}

function defaultRunner(tart: string): CommandRunner {
  return (args, env, timeoutMs = COMMAND_TIMEOUT_MS) =>
    new Promise((resolve) => {
      const child = spawn(tart, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 1_000_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_000) stderr += chunk;
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: error.message });
      });
      // 等子进程真正退出再结算；超时以 -1 返回，由调用方按「状态未知」处理。
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(timedOut ? { code: -1, stdout, stderr: `tart ${args[0]} 超时` } : { code: code ?? -1, stdout, stderr });
      });
    });
}

function defaultLauncher(tart: string): Launcher {
  return async (args, env, logPath) => {
    const log = await open(logPath, "a", 0o600);
    // 脱离本服务进程运行：服务重启不影响虚拟机，重启后从日志接管显示端点。
    const child = spawn(tart, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", log.fd, log.fd],
      detached: true,
    });
    child.unref();
    await log.close();
  };
}
