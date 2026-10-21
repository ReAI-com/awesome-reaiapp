import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyVendor } from "./verify-vendor-platform";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const DIR = HEAD.slice(0, 12);
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** 合成一个最小插件仓：一个平台包、一个消费插件。tarball 内容不解析，成员列表由注入函数给出。 */
function fixture(options: { members?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vendor-verify-"));
  roots.push(root);
  const base = join(root, "vendor/platform", DIR);
  mkdirSync(join(base, "packs"), { recursive: true });
  const tgz = new TextEncoder().encode("synthetic-tarball");
  writeFileSync(join(base, "packs/app-sdk.tgz"), tgz);
  const artifact = { name: "@reai/app-sdk", version: "1.0.0-t.1", file: "packs/app-sdk.tgz", bytes: tgz.byteLength, sha256: sha256(tgz) };
  const receipt = `${JSON.stringify({ sourceHead: HEAD, sourceDirty: false, artifacts: [artifact], companionArtifacts: [] })}\n`;
  writeFileSync(join(base, "toolchain.json"), receipt);
  const lock = `${JSON.stringify({ kind: "reai-platform-packages", sourceHead: HEAD, packages: [artifact], overrides: { "@reai/app-sdk": "packs/app-sdk.tgz" }, toolchainReceipt: { file: "toolchain.json", sha256: sha256(receipt) } })}\n`;
  writeFileSync(join(base, "platform-packages.lock.json"), lock);
  writeFileSync(join(root, "vendor/platform/pins.json"), JSON.stringify({ schemaVersion: 1, pins: [{ dir: DIR, sourceHead: HEAD, lockSha256: sha256(lock) }] }));
  mkdirSync(join(root, "plugins/demo"), { recursive: true });
  writeFileSync(join(root, "plugins/demo/package.json"), JSON.stringify({ devDependencies: { "@reai/app-sdk": `file:../../vendor/platform/${DIR}/packs/app-sdk.tgz` } }));
  const list = () => options.members ?? ["package/package.json"];
  return { root, base, verify: () => verifyVendor(root, list) };
}

describe("verify-vendor-platform", () => {
  test("合规的 vendor 与消费者通过", () => {
    expect(fixture().verify()).toEqual([]);
  });

  test("tarball 被改动时拒绝", () => {
    const { base, verify } = fixture();
    writeFileSync(join(base, "packs/app-sdk.tgz"), "tampered-tarball!");
    expect(verify().join("\n")).toContain("大小或摘要与 lock 不一致");
  });

  test("lock 被改动时拒绝（pins.json 钉住摘要）", () => {
    const { base, verify } = fixture();
    writeFileSync(join(base, "platform-packages.lock.json"), "{}\n");
    expect(verify().join("\n")).toContain("lock 摘要与 pins.json 不一致");
  });

  test("来源回执被改动时拒绝", () => {
    const { base, verify } = fixture();
    writeFileSync(join(base, "toolchain.json"), "{}\n");
    expect(verify().join("\n")).toContain("来源回执摘要与 lock 不一致");
  });

  test("packs/ 下多出未登记的文件时拒绝", () => {
    const { base, verify } = fixture();
    writeFileSync(join(base, "packs/extra.tgz"), "x");
    expect(verify().join("\n")).toContain("lock 未登记的文件");
  });

  test("tarball 含 Host 专用合同时拒绝", () => {
    const { verify } = fixture({ members: ["package/official-host-dependencies.json"] });
    expect(verify().join("\n")).toContain("含 Host 专用合同");
  });

  test("未登记的 vendor 目录与遗留 packages/ 拒绝", () => {
    const { root, base, verify } = fixture();
    cpSync(base, join(root, "vendor/platform/000000000000"), { recursive: true });
    mkdirSync(join(root, "packages"));
    const errors = verify().join("\n");
    expect(errors).toContain("000000000000: 未在 pins.json 登记");
    expect(errors).toContain("packages/: 平台包源码拷贝不得放进插件仓");
  });

  test("插件依赖指向未钉住的路径或错配包名时拒绝", () => {
    const { root, verify } = fixture();
    writeFileSync(join(root, "plugins/demo/package.json"), JSON.stringify({
      devDependencies: { "@reai/app-cli": `file:../../vendor/platform/${DIR}/packs/app-sdk.tgz` },
      overrides: { "@reai/app-test": "file:../../packages/test-kit" },
    }));
    const errors = verify().join("\n");
    expect(errors).toContain("@reai/app-cli 指向的是 @reai/app-sdk 的 tarball");
    expect(errors).toContain("@reai/app-test 指向未钉住的本地路径");
  });

  test("插件自身目录内的本地包放行", () => {
    const { root, verify } = fixture();
    mkdirSync(join(root, "plugins/demo/packages/chat-ui"), { recursive: true });
    writeFileSync(join(root, "plugins/demo/package.json"), JSON.stringify({ dependencies: { "@reai/chat-ui": "file:./packages/chat-ui" } }));
    expect(verify()).toEqual([]);
  });
});
