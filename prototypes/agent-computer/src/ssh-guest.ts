/**
 * macOS 客体的内部辅助通道（经 SSH，本服务专用密钥）。
 *
 * 只执行两条固定命令，不对外提供任何通用命令执行能力：
 * - 写客体剪贴板：`LANG=en_US.UTF-8 pbcopy`，文字走标准输入、不拼进命令行。
 *   必须设置 UTF-8，否则 pbcopy 按旧编码解读，中文变乱码（2026-10-21 实测）。
 * - 正常关机：让客体系统自己关机，数据落盘。tart stop 是「拔电源」式停止，
 *   实测刚写入的文件会丢（2026-10-21）。
 */
import { spawn } from "node:child_process";
import { ComputerError } from "./agent-computer";
import type { GuestPower, GuestTextHelper } from "./types";

export interface SshGuestOptions {
  host: () => Promise<string>;
  user: string;
  keyPath: string;
  knownHostsPath: string;
  timeoutMs?: number;
  sshPath?: string;
}

const PASTEBOARD_COMMAND = "LANG=en_US.UTF-8 pbcopy";
const SHUTDOWN_COMMAND = `osascript -e 'tell application "System Events" to shut down' || sudo -n /sbin/shutdown -h now`;

export class SshGuest implements GuestTextHelper, GuestPower {
  constructor(private readonly options: SshGuestOptions) {}

  setClipboard(text: string, signal: AbortSignal): Promise<void> {
    return this.exec(PASTEBOARD_COMMAND, text, "写入客体剪贴板", signal);
  }

  shutdown(): Promise<void> {
    return this.exec(SHUTDOWN_COMMAND, "", "请求客体关机");
  }

  private async exec(command: string, input: string, label: string, signal?: AbortSignal): Promise<void> {
    const aborted = () => new ComputerError("DISPLAY_UNAVAILABLE", `${label}已取消`);
    if (signal?.aborted) throw aborted();
    const host = await this.options.host();
    // 查询地址期间可能已被取消：取消后绝不再启动 SSH。
    if (signal?.aborted) throw aborted();
    const args = [
      "-i", this.options.keyPath,
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", `UserKnownHostsFile=${this.options.knownHostsPath}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=5",
      `${this.options.user}@${host}`,
      command,
    ];
    await new Promise<void>((resolve, reject) => {
      // 客体回显不可信：不读取 stdout / stderr，错误只报退出码，不进入 API 与审计。
      const child = spawn(this.options.sshPath ?? "/usr/bin/ssh", args, { stdio: ["pipe", "ignore", "ignore"] });
      // 取消或超时只记录原因并杀进程，等子进程真正退出（close）后才结算，
      // 确保上层放行队列时本地 ssh 已经结束、不会再写入。
      let cancelled: ComputerError | null = null;
      const cancel = (error: ComputerError) => {
        if (cancelled) return;
        cancelled = error;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => cancel(new ComputerError("DISPLAY_UNAVAILABLE", `${label}超时`)), this.options.timeoutMs ?? 10_000);
      const onAbort = () => cancel(aborted());
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (!cancelled) cancelled = new ComputerError("DISPLAY_UNAVAILABLE", `无法连接客体：${error.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (cancelled) reject(cancelled);
        else if (code === 0) resolve();
        else reject(new ComputerError("DISPLAY_UNAVAILABLE", `${label}失败（退出码 ${code}）`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input, "utf8");
    });
  }
}
