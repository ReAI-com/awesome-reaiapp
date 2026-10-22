import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshGuest } from "../src/ssh-guest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ssh-guest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 假 ssh：记录参数与标准输入；带 slow 时先睡再写完成标记。 */
async function fakeSsh(script: string) {
  const path = join(dir, "ssh");
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  return path;
}

const options = (sshPath: string) => ({
  host: async () => "192.168.64.2",
  user: "admin",
  keyPath: "/k",
  knownHostsPath: "/kh",
  sshPath,
});

describe("SshGuest", () => {
  test("文字经标准输入传给固定命令，不拼进命令行", async () => {
    const sshPath = await fakeSsh(`printf '%s\\n' "$@" > "${dir}/args"; cat > "${dir}/stdin"`);
    await new SshGuest(options(sshPath)).setClipboard("你好'; rm -rf / #", new AbortController().signal);
    const args = await Bun.file(join(dir, "args")).text();
    expect(args.trim().split("\n").at(-1)).toBe("LANG=en_US.UTF-8 pbcopy");
    expect(args).not.toContain("rm -rf");
    expect(await Bun.file(join(dir, "stdin")).text()).toBe("你好'; rm -rf / #");
  });

  test("取消后等进程真正退出才结算", async () => {
    const sshPath = await fakeSsh(`trap '' TERM; sleep 2; touch "${dir}/finished"`);
    const controller = new AbortController();
    const pending = new SshGuest(options(sshPath)).setClipboard("x", controller.signal);
    await Bun.sleep(100);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    await Bun.sleep(50);
    expect(existsSync(join(dir, "finished"))).toBe(false);
  });

  test("已取消时不启动 ssh", async () => {
    const sshPath = await fakeSsh(`touch "${dir}/ran"`);
    const controller = new AbortController();
    controller.abort();
    await expect(new SshGuest(options(sshPath)).setClipboard("x", controller.signal)).rejects.toBeDefined();
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });

  test("失败只报退出码，不回显客体输出", async () => {
    const sshPath = await fakeSsh(`echo "secret-from-guest" >&2; exit 3`);
    const error = await new SshGuest(options(sshPath)).setClipboard("x", new AbortController().signal).catch((e) => e);
    expect(error.message).toContain("退出码 3");
    expect(error.message).not.toContain("secret-from-guest");
  });
});
