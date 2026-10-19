import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateManifest, validateManifestFile, buildApp, packApp, packedFiles } from "../src/index";
import { sourceApprovalFindings } from "../src/source-approval";
import { validateManifest as frozenValidate, loadSupportMatrix } from "@reai/app-cli";

const TEAM = "4d8a4ddb-2293-4b11-9ef4-3f24f117998c";
const readPolicy = () => JSON.parse(readFileSync(join(import.meta.dir, "../../contract/capability-review-policy.seed.json"), "utf8"));
const lockedVoice = () => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/approved-voice.json"), "utf8"));

test("frozen CLI inherits only the locked platform-approved Voice package, never a source-review candidate", () => {
  const voice = readPolicy().approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice[0].reviewId).toBe("legacy-voice");
  // 冻结 CLI 按 appId 只取最后一条批准（天生不看版本）。最后一条必须是当前夹具锁对应的
  // 开放平台批准包（团队 publisher + 精确版本 + 精确摘要），不能是只有源码审核的候选记录。
  const locked = lockedVoice();
  const approved = voice.at(-1);
  expect(approved).toMatchObject({ reviewId: "voice-2.14.6-26798cc3", publisherId: TEAM,
    version: locked.version, packageSha256: locked.packageSha256 });
  // 历次开放平台批准包都保留（存量商店安装仍按它复验），只有最后一条是当前夹具锁。
  const platformApproved = voice.filter((a: any) => a.packageSha256 !== null);
  expect(platformApproved.map((a: any) => [a.version, a.packageSha256.slice(0, 8)])).toEqual([["2.14.1", "286a07e5"], ["2.14.2", "3cff1076"], ["2.14.3", "f285ee53"], ["2.14.6", "26798cc3"]]);
  expect(platformApproved.at(-1)).toBe(approved);
  const candidates = voice.filter((a: any) => ["2.12.39-rc.1", "2.12.39-rc.2", "2.12.39-rc.3", "2.13.0-rc.1", "2.13.1-rc.1", "2.14.0-rc.1", "2.14.1-rc.1", "2.14.1", "2.14.2-dev.1", "2.14.2-rc.1", "2.14.2", "2.14.3-dev.1", "2.14.3-rc.1", "2.14.3-rc.2", "2.14.3-rc.3", "2.14.3-rc.6", "2.14.3-rc.7", "2.14.3-rc.8", "2.14.3-rc.9", "2.14.3-rc.10", "2.14.3-rc.11", "2.14.3", "2.14.4-dev.1", "2.14.4-rc.1", "2.14.4-rc.2", "2.14.6-dev.6", "2.14.6-dev.7", "2.14.6", "2.14.7"].includes(a.version)
    && a.packageSha256 === null);
  expect(candidates).toHaveLength(29);
  expect(voice.filter((a: any) => a.approvedHostCapabilities.includes("surface.clipboard@1"))).toEqual([...candidates, ...platformApproved]);
  // 候选记录里有、批准包没有的 agent.dsh@1，以及从未批准的 agent.codex@1，冻结 CLI 一律不放行。
  expect(approved.approvedHostCapabilities).not.toContain("agent.dsh@1");
  expect(candidates.some((a: any) => a.approvedHostCapabilities.includes("agent.dsh@1"))).toBeTrue();
  for (const capability of ["agent.dsh@1", "agent.codex@1"]) {
    for (const changes of [{ publisherId: TEAM, version: approved.version }, { publisherId: "untrusted", version: "9.9.9" }]) {
      const manifest = { ...manifestRequiringGated(capability, "com.reai.voice"), ...changes };
      expect(frozenValidate(manifest).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
    }
  }
});

test("frozen CLI grants the approved Voice capabilities by appId only; other apps stay denied", () => {
  const permissions = [{ id: "agent.session@2", purpose: "Fixture checks source approval isolation", required: true }];
  const version = lockedVoice().version;
  const voice = { ...manifestRequiringGated("agent.session@2", "com.reai.voice"), publisherId: TEAM, version, permissions };
  expect(frozenValidate(voice).map(f => f.code)).toEqual([]);
  for (const appId of ["com.reai.browser", "com.example.voice-clone"]) {
    const other = { ...manifestRequiringGated("agent.session@2", appId), publisherId: TEAM, version, permissions };
    expect(frozenValidate(other).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  }
});

test("scoped Voice folder picker and command approvals are source-only and exact-identity", () => {
  const policy = readPolicy();
  const approval = policy.approvals.find((a: any) => a.reviewId === "voice-2.13.1-rc.1-scoped-execution-source-review");
  expect(approval.packageSha256).toBeNull();
  const legacy = policy.approvals.find((a: any) => a.reviewId === "legacy-voice").approvedHostCapabilities;
  for (const capability of ["system.folder-pick@1", "local.terminal.exec@1"]) {
    expect(approval.approvedHostCapabilities).toContain(capability);
    expect(legacy).not.toContain(capability);
    const manifest = { ...manifestRequiringGated(capability, "com.reai.voice"),
      publisherId: TEAM, version: "2.13.1-rc.1",
      permissions: capability === "local.terminal.exec@1"
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.13.0-rc.1" }, { publisherId: "reai" }, { appId: "com.example.other" }]) {
      expect(validateManifest({ ...manifest, ...change }).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
    }
  }
});

test("Voice 2.14.1 submission source review mirrors 2.14.1-rc.1 without widening any identity", () => {
  // 送审定版 2.14.1 与 2.14.1-rc.1 源码一致：只把同一份源码审核延伸到正式版本号，
  // 能力集零扩张，仍只认团队 publisher + 精确版本，不带包摘要（Catalog 仍须平台签名批准）。
  const policy = readPolicy();
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.1-rc.1-diagnostics-source-review");
  const formal = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.1-submission-source-review");
  expect(formal).toMatchObject({ appId: "com.reai.voice", publisherId: rc.publisherId, version: "2.14.1", packageSha256: null });
  expect(formal.approvedHostCapabilities).toEqual(rc.approvedHostCapabilities);
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: rc.publisherId, version: "2.14.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.4" }, { version: "2.14.1-rc.2" }, { publisherId: "reai" }])
      expect(validateManifest({ ...manifest, ...change }).map(f => f.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  }
});

test("Voice 2.14.1 platform approval pins the package and does not replace per-version source review", () => {
  const policy = readPolicy();
  const formal = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.1-submission-source-review");
  const approved = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.1-286a07e5");
  const dev = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.2-dev.1-post-roll-source-review");
  expect(approved).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.1",
    packageSha256: "286a07e5551a0ef6d6ef00d61beffd71054328a1c1dddf3d0a98000ff07af335" });
  expect(approved.approvedHostCapabilities).toHaveLength(12);
  // 批准包是源码审核的子集，只少了 Manifest 从未声明的 agent.dsh@1：零扩权。
  expect(formal.approvedHostCapabilities.filter((c: string) => !approved.approvedHostCapabilities.includes(c))).toEqual(["agent.dsh@1"]);
  expect(approved.approvedHostCapabilities.filter((c: string) => !formal.approvedHostCapabilities.includes(c))).toEqual([]);
  // 滚锁后源码进位的开发预发布有自己的精确版本记录，能力集与批准包逐项一致。
  expect(dev).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.2-dev.1", packageSha256: null });
  expect(dev.approvedHostCapabilities).toEqual(approved.approvedHostCapabilities);
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.2-dev.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    // Voice 按版本逐条做源码审核：带摘要的平台批准只覆盖 2.14.1 本身，不能替没有审核记录的
    // 相邻或后续版本放行（包括从未进锁的 2.14.0 与没有审核记录的开发号）。
    for (const change of [{ version: "2.14.0" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { version: "9.9.9" },
      { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.2-rc.1 source review mirrors 2.14.2-dev.1 without widening any identity", () => {
  // 2.14.2-rc.1 只在插件侧细化 Agent 失败的阶段诊断，能力集与 2.14.2-dev.1（即 2.14.1 批准包）逐项相同；
  // 仍只认团队 publisher + 精确版本，不带包摘要（Catalog 仍须平台签名批准），排在带摘要的批准包之前。
  const policy = readPolicy();
  const dev = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.2-dev.1-post-roll-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.2-rc.1-agent-stage-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.2-rc.1", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(dev.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(dev) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.2-rc.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.2-rc.2" }, { version: "2.14.4" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.2 submission source review mirrors 2.14.2-rc.1 without widening any identity", () => {
  // 送审定版 2.14.2 与 2.14.2-rc.1 源码一致：只把同一份源码审核延伸到正式版本号，
  // 能力集零扩张，仍只认团队 publisher + 精确版本，不带包摘要（Catalog 仍须平台签名批准），
  // 排在 rc.1 之后、带摘要的批准包之前（冻结 CLI 只继承最后一条）。
  const policy = readPolicy();
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.2-rc.1-agent-stage-source-review");
  const formal = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.2-submission-source-review");
  expect(formal).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.2", packageSha256: null });
  expect(formal.approvedHostCapabilities).toEqual(rc.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(formal)).toBe(voice.indexOf(rc) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.2",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.4" }, { version: "2.14.2-rc.2" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.2 platform approval pins the package with exactly the 2.14.1 capabilities; post-roll dev source keeps per-version review", () => {
  const policy = readPolicy();
  const find = (reviewId: string) => policy.approvals.find((a: any) => a.reviewId === reviewId);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  const formal = find("voice-2.14.2-submission-source-review");
  const previous = find("voice-2.14.1-286a07e5");
  const approved = find("voice-2.14.2-3cff1076");
  const dev = find("voice-2.14.3-dev.1-post-roll-source-review");
  expect(approved).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.2",
    packageSha256: "3cff1076a97611461994cd1a84bfd57ebe43eeddc5a2fdfc2481a1687bcef3f6" });
  // 12 项受控能力，与 2.14.1 批准包、2.14.2 送审源码审核逐项相同：零扩权。
  expect(approved.approvedHostCapabilities).toHaveLength(12);
  expect(approved.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  expect([...approved.approvedHostCapabilities].sort()).toEqual([...formal.approvedHostCapabilities].sort());
  // 2.14.1 批准保留在前，新批准追加在最后（冻结 CLI 只继承最后一条）。
  expect(voice.indexOf(previous)).toBeLessThan(voice.indexOf(approved));
  expect(voice.indexOf(approved)).toBeLessThan(voice.indexOf(find("voice-2.14.3-f285ee53")));
  // 滚锁后源码进位的开发预发布有自己的精确版本记录，紧跟 2.14.2 送审记录，能力集与批准包逐项一致。
  expect(dev).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-dev.1", packageSha256: null });
  expect(dev.approvedHostCapabilities).toEqual(approved.approvedHostCapabilities);
  expect(voice.indexOf(dev)).toBe(voice.indexOf(formal) + 1);
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-dev.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    // 带摘要的 2.14.2 批准只覆盖它自己：没有审核记录的后续版本与冒名 publisher 一律拒绝。
    for (const change of [{ version: "2.14.4" }, { version: "2.14.3-dev.2" }, { version: "2.14.4-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.1 source review mirrors 2.14.3-dev.1 without widening any identity", () => {
  // 2.14.3-rc.1 只在插件侧给 Context 档补「本地模型没就绪、全天记录没转写」的原因与去设置，
  // 能力集与 2.14.3-dev.1（即 2.14.2 批准包）逐项相同；仍只认团队 publisher + 精确版本、不带包摘要，
  // 紧跟 2.14.3-dev.1 记录、排在带摘要的批准包之前。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-dev.1-post-roll-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.1-context-model-hint-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.1", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.2 source review mirrors 2.14.3-rc.1 without widening any identity", () => {
  // 2.14.3-rc.2 只在插件侧把诊断里的模型名改成白名单（登记的内置 / 云端 ID 原样，其余写「自定义模型」），
  // 能力集与 2.14.3-rc.1 逐项相同；仍只认团队 publisher + 精确版本、不带包摘要，
  // 紧跟 2.14.3-rc.1 记录、排在带摘要的批准包之前。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.1-context-model-hint-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.2-model-name-privacy-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.2", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.2",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.3 source review mirrors 2.14.3-rc.2 without widening any identity", () => {
  // 2.14.3-rc.3 只在插件侧改对话页：工具进度合并、Markdown 渲染与地球仪图标，能力集与 2.14.3-rc.2 逐项相同；
  // 仍只认团队 publisher + 精确版本、不带包摘要，紧跟 2.14.3-rc.2 记录、排在带摘要的批准包之前。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.2-model-name-privacy-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.3-chat-tools-markdown-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.3", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.3",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.6 source review mirrors 2.14.3-rc.3 without widening any identity", () => {
  // 2.14.3-rc.6 只在插件侧收紧翻译呈现：写进去不弹窗，没写进去弹取回卡（标明卡里是译文、带真实错误码），
  // 取回卡被 Host 拒绝时翻译改弹失败结果面板；能力集与 2.14.3-rc.3 逐项相同，记录紧跟 rc.3 之后。
  // rc.4–rc.5 由在途 PR 占用。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.3-chat-tools-markdown-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.6-translation-writeback-panel-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.6", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.6",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.7 source review mirrors 2.14.3-rc.6 without widening any identity", () => {
  // 2.14.3-rc.7（接在 rc.6 之后）只在插件侧用 Host API 1.22 同版本并入的
  // holdOverlayUntilAck / voice.report-stage 让中央胶囊停到写入那一刻，能力集与 2.14.3-rc.6 逐项相同；
  // 仍只认团队 publisher + 精确版本、不带包摘要，紧跟 2.14.3-rc.6 记录、排在带摘要的批准包之前。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.6-translation-writeback-panel-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.7-capsule-stage-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.7", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.7",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.8 source review mirrors 2.14.3-rc.7 without widening any identity", () => {
  // 2.14.3-rc.8 只在插件侧补呈现：取回卡被 Host 拒绝时，转文本与输入法也改弹失败结果面板（与翻译同一做法）；
  // 能力集与 2.14.3-rc.7 逐项相同（仍只用已批准的 voice.command@1 结果面板），记录紧跟 rc.7 之后。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.7-capsule-stage-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.8-transcribe-input-denied-panel-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.8", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.8",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.9 source review mirrors 2.14.3-rc.8 without widening any identity", () => {
  // 2.14.3-rc.9 只在插件侧呈现「等你拍板」：胶囊等人旗、对话页等待提示与诊断，能力集与 2.14.3-rc.8 逐项相同；
  // 仍只认团队 publisher + 精确版本、不带包摘要，紧跟 2.14.3-rc.8 记录。版本号待合并时顺延。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.8-transcribe-input-denied-panel-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.9-agent-user-wait-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.9", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.9",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.10 source review mirrors 2.14.3-rc.9 without widening any identity", () => {
  // 2.14.3-rc.10 只在插件侧改翻译：请求改成明确的「只输出译文」指令 + 随机标记包住原文，结果明显不是译文
  // （以 AI 助手身份聊天 / 整段不是目标语言）按翻译失败处理、不写入。能力集与 2.14.3-rc.9 逐项相同，
  // 记录紧跟 rc.9 之后。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.9-agent-user-wait-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.10-translation-output-guard-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.10", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.10",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3-rc.11 source review mirrors 2.14.3-rc.10 without widening any identity", () => {
  // 2.14.3-rc.11 只在插件侧改一处交互：Host 的 host.taskConversation intent（用户点「继续」「打开会话」）
  // 打开对话页后把光标放进输入框。能力集与 2.14.3-rc.10 逐项相同，记录紧跟 rc.10 之后。
  const policy = readPolicy();
  const previous = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.10-translation-output-guard-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.11-open-conversation-focus-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3-rc.11", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(previous) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3-rc.11",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.3-rc.12" }, { version: "2.14.3-rc.4" }, { version: "2.14.4" }, { version: "2.14.3-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3 submission source review mirrors 2.14.3-rc.11 without widening any identity", () => {
  // 送审定版 2.14.3 与 2.14.3-rc.11 源码一致：只把同一份源码审核延伸到正式版本号，
  // 能力集零扩张，仍只认团队 publisher + 精确版本，不带包摘要（Catalog 仍须平台签名批准），
  // 排在 rc.11 之后、带摘要的批准包之前（冻结 CLI 只继承最后一条）。
  const policy = readPolicy();
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-rc.11-open-conversation-focus-source-review");
  const formal = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.3-submission-source-review");
  expect(formal).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3", packageSha256: null });
  expect(formal.approvedHostCapabilities).toEqual(rc.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(formal)).toBe(voice.indexOf(rc) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.3",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.4" }, { version: "2.14.3-rc.12" }, { version: "2.14.4-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.3 platform approval pins the package with exactly the 2.14.2 capabilities; post-roll dev source keeps per-version review", () => {
  const policy = readPolicy();
  const find = (reviewId: string) => policy.approvals.find((a: any) => a.reviewId === reviewId);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  const formal = find("voice-2.14.3-submission-source-review");
  const previous = find("voice-2.14.2-3cff1076");
  const approved = find("voice-2.14.3-f285ee53");
  const dev = find("voice-2.14.4-dev.1-post-roll-source-review");
  expect(approved).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.3",
    packageSha256: "f285ee539333b3a9d954c8849b10900fb09f39d6b269af6cc8de7b86ec16d232" });
  // 12 项受控能力，与 2.14.2 批准包、2.14.3 送审源码审核逐项相同：零扩权。
  expect(approved.approvedHostCapabilities).toHaveLength(12);
  expect(approved.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  expect([...approved.approvedHostCapabilities].sort()).toEqual([...formal.approvedHostCapabilities].sort());
  // 2.14.2 批准保留在前；2.14.6 滚锁后新批准追加在其后（冻结 CLI 只继承最后一条）。
  expect(voice.indexOf(previous)).toBeLessThan(voice.indexOf(approved));
  expect(voice.indexOf(approved)).toBeLessThan(voice.indexOf(find("voice-2.14.6-26798cc3")));
  // 滚锁后源码进位的开发预发布有自己的精确版本记录，紧跟 2.14.3 送审记录，能力集与批准包逐项一致。
  expect(dev).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.4-dev.1", packageSha256: null });
  expect(dev.approvedHostCapabilities).toEqual(approved.approvedHostCapabilities);
  expect(voice.indexOf(dev)).toBe(voice.indexOf(formal) + 1);
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.4-dev.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    // 带摘要的 2.14.3 批准只覆盖它自己：没有审核记录的后续版本与冒名 publisher 一律拒绝。
    for (const change of [{ version: "2.14.4" }, { version: "2.14.4-dev.2" }, { version: "2.14.5-dev.1" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.4-rc.1 source review mirrors 2.14.4-dev.1 without widening any identity", () => {
  // 2.14.4-rc.1（Agent / 翻译空话不发请求）只改插件内部判定，能力集零扩张：同一份团队 publisher +
  // 精确版本的源码审核延伸到 rc.1，不带包摘要，紧跟 dev.1、排在带摘要的批准包之前。
  const policy = readPolicy();
  const dev = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.4-dev.1-post-roll-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.4-rc.1-empty-utterance-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.4-rc.1", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(dev.approvedHostCapabilities);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(dev) + 1);
  expect(voice.at(-1).packageSha256).not.toBeNull();
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.4-rc.1",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.4" }, { version: "2.14.4-rc.3" }, { version: "2.14.4-dev.2" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice rc.2 has exact source-only approval without extending future versions or platform authority", () => {
  const policy = readPolicy();
  const before = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.4-rc.1-empty-utterance-source-review");
  const rc = policy.approvals.find((a: any) => a.reviewId === "voice-2.14.4-rc.2-delivery-visible-source-review");
  expect(rc).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.4-rc.2", packageSha256: null });
  expect(rc.approvedHostCapabilities).toEqual(before.approvedHostCapabilities);
  expect(rc.approvedHostCapabilities).toHaveLength(12);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  expect(voice.indexOf(rc)).toBe(voice.indexOf(before) + 1);
  expect(voice.at(-1).packageSha256).toBe(lockedVoice().packageSha256);
  for (const capability of ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.4-rc.2",
      permissions: ["agent.session@2", "local.terminal.exec@1"].includes(capability)
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.4" }, { version: "2.14.4-rc.3" }, { version: "2.14.4-dev.2" }, { publisherId: "untrusted" }, { appId: "com.example.voice-clone" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Terminal 进入逐版本源码审核后，包批准不再覆盖后续源码版本", () => {
  // v1.0.5 起 Terminal 有了精确版本的源码审核记录（无摘要），与 Voice 同一纪律：带摘要的平台包批准
  // 只覆盖它自己的版本，每个新源码版本都要有自己的审核记录；换 publisher 仍拒绝。
  const policy = readPolicy();
  const terminal = policy.approvals.filter((a: any) => a.appId === "com.reai.terminal");
  expect(terminal.some((a: any) => typeof a.packageSha256 === "string")).toBeTrue();
  const reviewed = terminal.filter((a: any) => a.packageSha256 === null);
  expect(reviewed.map((a: any) => a.version)).toEqual(["1.0.5-dev.2"]);
  expect(terminal.every((a: any) => a.publisherId === "reai")).toBeTrue();
  const manifest: any = { ...manifestRequiringGated("terminal.session@1", "com.reai.terminal"), version: "1.0.5-dev.2" };
  expect(sourceApprovalFindings(manifest, [])).toEqual([]);
  expect(sourceApprovalFindings({ ...manifest, version: "9.9.9" }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
  expect(sourceApprovalFindings({ ...manifest, publisherId: "untrusted" }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
});

const manifestRequiringGated = (capability: string, appId: string): Record<string, any> => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../contract/manifest-fixtures/valid/minimal-todo.json"), "utf8"));
  manifest.appId = appId;
  manifest.publisherId = "reai";
  manifest.requires.hostCapabilities.push(capability);
  return manifest;
};

test("modern source checks recompute activation successes and preserve unrelated findings", () => {
  const manifest = { appId: "com.example.untrusted", publisherId: "untrusted", version: "1.0.0",
    runtime: { components: [{ activation: "startup" }] } };
  const unrelated = { code: "HOST_CAPABILITY_NOT_AVAILABLE" as const, pointer: "requires.hostCapabilities[0]", detail: "unknown" };
  expect(sourceApprovalFindings(manifest, [unrelated])).toEqual([unrelated, {
    code: "APP_CAPABILITY_NOT_GRANTED", pointer: "runtime.components[0].activation",
    detail: "activation.startup@1 requires an applicable source review approval",
  }]);
});

test("real modern build and pack accept exact candidate without frozen validator authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "reai-source-approval-"));
  try {
    const manifest = manifestRequiringGated("surface.clipboard@1", "com.reai.voice");
    manifest.publisherId = "4d8a4ddb-2293-4b11-9ef4-3f24f117998c";
    manifest.version = "2.12.39-rc.1";
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/app.ts"), "export default { activate() {} };");
    const path = join(root, "app.manifest.json"), output = join(root, "out.reaiapp");
    writeFileSync(path, JSON.stringify(manifest));
    expect(validateManifestFile(path, false)).toEqual([]);
    await buildApp(root, false);
    await packApp(root, output, false);
    const approvedBytes = readFileSync(output);
    expect(JSON.parse(new TextDecoder().decode(packedFiles(approvedBytes).get("app.manifest.json"))).version).toBe(manifest.version);
    for (const changes of [{ version: "2.12.38" }, { publisherId: "untrusted-publisher" },
      { version: "9.9.9", packageSha256: "a".repeat(64) }]) {
      writeFileSync(path, JSON.stringify({ ...manifest, ...changes }));
      expect(validateManifestFile(path, false).map(f => f.code)).toContain(
        "packageSha256" in changes ? "MANIFEST_SCHEMA_INVALID" : "APP_CAPABILITY_NOT_GRANTED");
      await expect(buildApp(root, false)).rejects.toThrow();
      await expect(packApp(root, output, false)).rejects.toThrow();
      expect(readFileSync(output)).toEqual(approvedBytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("modern approval/activation results are independent of legacy policy-order findings", () => {
  const official = join(import.meta.dir, "../../../plugins");
  let checked = 0;
  for (const slug of readdirSync(official)) {
    const path = join(official, slug, "app.manifest.json");
    if (!existsSync(path)) continue;
    const original = JSON.parse(readFileSync(path, "utf8"));
    for (const change of [{}, { version: "9.9.9" }, { publisherId: "untrusted" }]) {
      const manifest = { ...original, ...change };
      const granted = sourceApprovalFindings(manifest, []);
      const priorDenied = [
        ...(manifest.requires?.hostCapabilities ?? []).flatMap((cap: string, i: number) =>
          loadSupportMatrix().hostCapabilities.grantGated.includes(cap) ? [{
            code: "APP_CAPABILITY_NOT_GRANTED" as const, pointer: `requires.hostCapabilities[${i}]`, detail: "old order",
          }] : []),
        ...(manifest.runtime?.components ?? []).flatMap((c: any, i: number) => c.activation === "startup" ? [{
          code: "APP_CAPABILITY_NOT_GRANTED" as const, pointer: `runtime.components[${i}].activation`, detail: "old order",
        }] : []),
      ];
      expect(sourceApprovalFindings(manifest, priorDenied)).toEqual(granted);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(15);
  const terminal = JSON.parse(readFileSync(join(official, "terminal/app.manifest.json"), "utf8"));
  expect(terminal.version).toBe("1.0.5-dev.2");
  expect(sourceApprovalFindings(terminal, [])).toEqual([]); // Existing source-only exception, NOT Host artifact approval.
});

  test.each(["2.12.39-rc.1", "2.12.39-rc.2", "2.12.39-rc.3", "2.13.0-rc.1"])("Voice 剪贴板批准同时绑定 publisher 与 %s 版本", (version) => {
    const approved = manifestRequiringGated("surface.clipboard@1", "com.reai.voice");
    approved["publisherId"] = "4d8a4ddb-2293-4b11-9ef4-3f24f117998c";
    approved["version"] = version;
    expect(validateManifest(approved).map((finding) => finding.code)).toEqual([]);

    const previous = structuredClone(approved);
    previous["version"] = "2.12.38";
    expect(validateManifest(previous).map((finding) => finding.code)).toContain("APP_CAPABILITY_NOT_GRANTED");

    const future = { ...approved, version: "2.12.39-rc.4" };
    expect(validateManifest(future).map((finding) => finding.code)).toContain("APP_CAPABILITY_NOT_GRANTED");

    const impostor = structuredClone(approved);
    impostor["publisherId"] = "untrusted-publisher";
    expect(validateManifest(impostor).map((finding) => finding.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  });

  test("旧通配源码校验兼容 publisher 迁移，但不授予新剪贴板能力", () => {
    const browser = manifestRequiringGated("browser.engine@1", "com.reai.browser");
    browser["publisherId"] = "4d8a4ddb-2293-4b11-9ef4-3f24f117998c";
    browser["version"] = "1.0.3-p02.1";
    expect(validateManifest(browser).map((finding) => finding.code)).toEqual([]);
    const oldVoice = manifestRequiringGated("surface.clipboard@1", "com.reai.voice");
    oldVoice["version"] = "2.12.38";
    expect(validateManifest(oldVoice).map((finding) => finding.code)).toContain("APP_CAPABILITY_NOT_GRANTED");
  });

test("Voice 2.14.7 source review grants exactly the 2.14.6 capabilities to its exact version only", () => {
  // 2.14.7 送审定版（#1312 PDF 解码超预算快速失败）另做独立 SOURCE 审查：能力集与 2.14.6 源码审核记录逐项相同，零扩权。
  const policy = readPolicy();
  const find = (reviewId: string) => policy.approvals.find((a: any) => a.reviewId === reviewId);
  const next = find("voice-2.14.7-pdf-budget-fast-fail-source-review");
  const previous = find("voice-2.14.6-archive-switch-source-review");
  expect(next).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.7", packageSha256: null });
  expect(next.approvedHostCapabilities).toEqual(previous.approvedHostCapabilities);
  for (const capability of ["audio.capture@1", "audio.clips@1", "surface.escape@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.7",
      permissions: capability.startsWith("audio.")
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.7-dev.1" }, { version: "2.14.8" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});

test("Voice 2.14.6 platform approval pins the released package with exactly the 2.14.6 source-review capabilities", () => {
  // 开放平台签名批准：精确团队 publisher + 版本 + 包摘要，
  // 能力集与 2.14.6 送审源码审核记录（同 dev.7）逐项相同：零扩权。追加在最后，冻结 CLI 只继承它。
  const policy = readPolicy();
  const find = (reviewId: string) => policy.approvals.find((a: any) => a.reviewId === reviewId);
  const voice = policy.approvals.filter((a: any) => a.appId === "com.reai.voice");
  const source = find("voice-2.14.6-archive-switch-source-review");
  const dev7 = find("voice-2.14.6-dev.7-presentation-source-review");
  const approved = find("voice-2.14.6-26798cc3");
  expect(approved).toMatchObject({ appId: "com.reai.voice", publisherId: TEAM, version: "2.14.6",
    packageSha256: "26798cc3873a26ef3a160e04f6d1b5d18e078a4315a6075c49199561c237af41" });
  expect(approved.approvedHostCapabilities).toHaveLength(15);
  expect(approved.approvedHostCapabilities).toEqual(source.approvedHostCapabilities);
  expect(source.approvedHostCapabilities).toEqual(dev7.approvedHostCapabilities);
  expect(source).toMatchObject({ publisherId: TEAM, version: "2.14.6", packageSha256: null });
  expect(voice.at(-1)).toBe(approved);
  expect(lockedVoice()).toMatchObject({ version: "2.14.6", packageSha256: approved.packageSha256 });
  for (const capability of ["audio.capture@1", "audio.clips@1", "surface.escape@1"]) {
    const manifest: any = { ...manifestRequiringGated(capability, "com.reai.voice"), publisherId: TEAM, version: "2.14.6",
      permissions: capability.startsWith("audio.")
        ? [{ id: capability, purpose: "Fixture checks source approval isolation", required: false }] : [] };
    expect(validateManifest(manifest).map(f => f.code)).toEqual([]);
    for (const change of [{ version: "2.14.8" }, { version: "2.14.8-dev.1" }, { publisherId: "untrusted" }]) {
      expect(sourceApprovalFindings({ ...manifest, ...change }, []).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    }
  }
});
