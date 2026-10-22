#!/usr/bin/env bun
/**
 * agent-computer 命令行。
 *
 *   agent-computer serve            启动本地服务（首次会生成令牌，令牌只写文件不打印）
 *   agent-computer adopt            把已存在的同名虚拟机登记为本服务所有（用户显式操作）
 *   agent-computer provision        一次性准备客体：装入专用 SSH 公钥、关闭休眠
 *   agent-computer status|resume|stop|vm-start|vm-stop
 *   agent-computer shot <文件> [最长边]
 *   agent-computer outbox | approve <候选ID> <sha256> <目标目录> | reject <候选ID> <sha256>
 *   agent-computer call <方法> [JSON 参数]
 *
 * 除 serve / adopt 外都以「用户」身份调用服务，用户令牌只在本机文件里。
 * 配置走环境变量：AGENT_COMPUTER_HOME、AGENT_COMPUTER_VM、AGENT_COMPUTER_BASE、
 * AGENT_COMPUTER_ALLOW（用冒号分隔的导出目标目录）。服务只监听 $AGENT_COMPUTER_HOME/agent-computer.sock。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentComputer } from "./agent-computer";
import { Outbox } from "./outbox";
import { spawnSync } from "node:child_process";
import { VZ_MACOS_MODIFIERS } from "./keys";
import { RfbDisplayInput } from "./rfb-display";
import { serve } from "./server";
import { SshGuest } from "./ssh-guest";
import { TartProvider } from "./tart-provider";

const home = process.env.AGENT_COMPUTER_HOME ?? join(homedir(), ".local/share/agent-computer-proto");
const vmName = process.env.AGENT_COMPUTER_VM ?? "agent-computer-proto";
const baseImage = process.env.AGENT_COMPUTER_BASE ?? "ghcr.io/cirruslabs/macos-tahoe-base:latest";
const socketPath = join(home, "agent-computer.sock");
const allowed = (process.env.AGENT_COMPUTER_ALLOW ?? join(home, "approved")).split(":").filter(Boolean);
const shares = { inbox: join(home, "inbox"), outbox: join(home, "outbox") };
const guestUser = process.env.AGENT_COMPUTER_GUEST_USER ?? "admin";
const sshKey = join(home, "ssh", "id_ed25519");
const knownHosts = join(home, "ssh", "known_hosts");

/** 私有目录必须属于当前用户且权限不宽于 700，否则令牌与 socket 都不可信。 */
async function assertPrivateHome() {
  const info = await lstat(home);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`${home} 必须是当前用户的私有目录（权限 700）`);
  }
}

/** 读取令牌；create 为 true 时（仅 serve）不存在则排他创建。存量文件校验类型、所有者与权限。 */
async function token(name: "agent-token" | "user-token", create = false): Promise<string> {
  await assertPrivateHome();
  const path = join(home, name);
  if (!existsSync(path)) {
    if (!create) throw new Error(`找不到 ${name}，请先运行 serve`);
    await writeFile(path, randomBytes(24).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new Error(`${path} 必须是当前用户、权限 600 的普通文件`);
  }
  return (await readFile(path, "utf8")).trim();
}

function provider() {
  return new TartProvider({ name: vmName, baseImage, stateDir: home, shares });
}

async function call(method: string, params: unknown = {}) {
  const response = await fetch("http://localhost/rpc", {
    unix: socketPath,
    method: "POST",
    headers: { authorization: `Bearer ${await token("user-token")}`, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const body = (await response.json()) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!body.ok) {
    console.error(`失败（${body.error?.code}）：${body.error?.message}`);
    process.exit(1);
  }
  return body.result;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  // 只有 serve / provision 需要准备目录；stop、status 等不依赖导出目录，避免目录问题挡住紧急停止。
  const prepare = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    for (const dir of [shares.inbox, shares.outbox, ...allowed]) await mkdir(dir, { recursive: true });
  };

  switch (command) {
    case "serve": {
      await prepare();
      const vm = provider();
      const guest = existsSync(sshKey)
        ? new SshGuest({ host: () => vm.ip(), user: guestUser, keyPath: sshKey, knownHostsPath: knownHosts })
        : null;
      vm.guestPower = guest;
      const computer = new AgentComputer({
        // macOS 客体（Virtualization.framework VNC）：物理键语义、键盘打不出中文，修饰键映射特殊。
        connectDisplay: async () =>
          RfbDisplayInput.connect(
            await vm.start(),
            { unicodeText: false, physicalKeys: true, loginScreen: true },
            VZ_MACOS_MODIFIERS,
          ),
        textHelper: guest ?? undefined,
      });
      if (!guest) console.log("提示：尚未执行 provision，中文等非 ASCII 文字暂不能输入，关机只能强制停止");
      await assertPrivateHome();
      await serve(
        {
          computer,
          provider: vm,
          outbox: new Outbox({ root: shares.outbox, allowedTargets: allowed }),
          agentToken: await token("agent-token", true),
          userToken: await token("user-token", true),
        },
        socketPath,
      );
      console.log(`Agent 电脑服务已启动：${socketPath}（默认处于紧急停止状态，需用户 resume）`);
      console.log(`Agent 令牌文件：${join(home, "agent-token")}；用户令牌文件：${join(home, "user-token")}`);
      return;
    }
    case "provision": {
      await prepare();
      // 一次性准备 Agent 电脑：用客体初始密码装入本服务专用的 SSH 公钥（只用于写剪贴板与正常关机），
      // 并关闭客体的显示器与系统休眠——休眠时 VNC 不回画面（2026-10-21 实测）。
      const vm = provider();
      const ip = await vm.ip();
      await mkdir(join(home, "ssh"), { recursive: true, mode: 0o700 });
      if (!existsSync(sshKey)) {
        spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", sshKey, "-C", "agent-computer"], { stdio: "inherit" });
      }
      const askpass = join(home, "ssh", `askpass-${process.pid}`);
      await writeFile(askpass, `#!/bin/sh\nprintf '%s\\n' "$AGENT_COMPUTER_GUEST_PASSWORD"\n`, { mode: 0o700 });
      try {
        const result = spawnSync(
          "/usr/bin/ssh",
          ["-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "PubkeyAuthentication=no",
            `${guestUser}@${ip}`,
            "mkdir -p ~/.ssh && chmod 700 ~/.ssh && k=$(cat) && touch ~/.ssh/authorized_keys" +
              " && (grep -qxF \"$k\" ~/.ssh/authorized_keys || printf '%s\\n' \"$k\" >> ~/.ssh/authorized_keys)" +
              " && chmod 600 ~/.ssh/authorized_keys" +
              " && (sudo -n pmset -a displaysleep 0 sleep 0 || echo '警告：未能关闭客体休眠' >&2)"],
          {
            input: await readFile(`${sshKey}.pub`),
            env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "none",
              AGENT_COMPUTER_GUEST_PASSWORD: process.env.AGENT_COMPUTER_GUEST_PASSWORD ?? "admin" },
            stdio: ["pipe", "inherit", "inherit"],
          },
        );
        if (result.status !== 0) throw new Error("装入 SSH 公钥失败");
      } finally {
        spawnSync("/bin/rm", ["-f", askpass]);
      }
      console.log("Agent 电脑已准备好（SSH 公钥、关闭休眠），重启 serve 后生效");
      return;
    }
    case "adopt":
      await prepare();
      await provider().writeOwnership();
      console.log(`已登记 ${vmName} 为本服务所有`);
      return;
    case "status":
      console.log(JSON.stringify({ vm: await call("vm.status"), computer: await call("computer.state") }, null, 2));
      return;
    case "resume":
    case "stop":
      console.log(JSON.stringify(await call(`computer.${command}`), null, 2));
      return;
    case "vm-start":
    case "vm-stop":
      console.log(JSON.stringify(await call(command === "vm-start" ? "vm.start" : "vm.stop"), null, 2));
      return;
    case "shot": {
      const [file, maxEdge] = args;
      if (!file) throw new Error("用法：shot <文件> [最长边]");
      const shot = (await call("computer.screenshot", maxEdge ? { maxEdge: Number(maxEdge) } : {})) as {
        dataBase64: string;
        width: number;
        height: number;
      };
      await writeFile(file, Buffer.from(shot.dataBase64, "base64"));
      console.log(`已保存 ${file}（${shot.width}×${shot.height}）`);
      return;
    }
    case "outbox":
      console.log(JSON.stringify(await call("files.outbox.list"), null, 2));
      return;
    case "approve": {
      const [candidateId, sha256, targetDir] = args;
      console.log(JSON.stringify(await call("files.outbox.approve", { candidateId, sha256, targetDir }), null, 2));
      return;
    }
    case "reject":
      console.log(JSON.stringify(await call("files.outbox.reject", { candidateId: args[0], sha256: args[1] }), null, 2));
      return;
    case "call": {
      const [method, params] = args;
      if (!method) throw new Error("用法：call <方法> [JSON 参数]");
      console.log(JSON.stringify(await call(method, params ? JSON.parse(params) : {}), null, 2));
      return;
    }
    default:
      console.log("用法：agent-computer serve | adopt | provision | status | resume | stop | vm-start | vm-stop | shot <文件> | outbox | approve | reject | call");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
