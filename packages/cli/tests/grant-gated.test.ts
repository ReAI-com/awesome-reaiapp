/**
 * grantGated 能力分档（C1-1）的 CLI 侧覆盖。
 *
 * C2 生产矩阵已有真实的特权能力；这里既覆盖第三方拒绝，也锁住官方 seed
 * 只能放行明确列出的能力，不能因为 appId 命中就拿到未来所有 grantGated 能力。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { validateManifest } from "../src/validate";
import { loadSupportMatrix } from "../src/assets";

const minimalTodo = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(
        fileURLToPath(new URL("../../contract/manifest-fixtures/valid", import.meta.url)),
        "minimal-todo.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("grantGated 能力（C1-1）", () => {
  test("controlled run needs an independent platform grant and matching user declaration", () => {
    const id = "local.terminal.exec@1";
    const matrix = loadSupportMatrix();
    expect(matrix.hostCapabilities.grantGated).toContain(id);
    expect(Object.keys(matrix.pluginPermissions.supported)).toContain(id);
    const manifest = minimalTodo();
    (manifest["requires"] as {hostCapabilities:string[]}).hostCapabilities.push(id);
    manifest["permissions"] = [{id, purpose:"在已授权镜像中运行受控文件处理程序", required:true}];
    const findings = validateManifest(manifest);
    expect(findings.map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
    manifest["permissions"] = [];
    expect(validateManifest(manifest).map(f => f.code)).toContain("MANIFEST_REFERENCE_INVALID");
  });

  test("v1.0.5 平台服务：第三方未审核按未授予拒绝，且平台能力与同名 permission 必须成对", () => {
    const matrix = loadSupportMatrix();
    for (const id of ["audio.capture@1", "tasks.present@1", "notifications.publish@1"]) {
      expect(matrix.hostCapabilities.grantGated).toContain(id);
      expect(matrix.hostCapabilities.withheld).not.toHaveProperty([id]);
      expect(Object.keys(matrix.pluginPermissions.supported)).toContain(id);
      expect(Object.keys(matrix.pluginPermissions.withheld)).not.toContain(id);
      const manifest = minimalTodo();
      manifest["hostApi"] = { ...(manifest["hostApi"] as object), range: ">=1.25.0 <2.0.0" };
      (manifest["requires"] as { hostCapabilities: string[] }).hostCapabilities.push(id);
      manifest["permissions"] = [{ id, purpose: "验证 v1.0.5 平台服务", required: false }];
      expect(validateManifest(manifest).map(f => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
      manifest["permissions"] = [];
      expect(validateManifest(manifest).map(f => f.code)).toContain("MANIFEST_REFERENCE_INVALID");
      const permissionOnly = minimalTodo();
      permissionOnly["permissions"] = [{ id, purpose: "验证 v1.0.5 平台服务", required: false }];
      expect(validateManifest(permissionOnly).map(f => f.code)).toContain("MANIFEST_REFERENCE_INVALID");
    }
  });

  const matrixWithGated = () => {
    // loadSupportMatrix 有模块级缓存——注入用深拷贝，别污染共享单例。
    const matrix = structuredClone(loadSupportMatrix());
    matrix.hostCapabilities.grantGated.push("events.subscribe@1");
    return matrix;
  };

  const manifestRequiringGated = (capability = "events.subscribe@1", appId = "com.example.todo") => {
    const m = minimalTodo();
    m["appId"] = appId;
    if (appId.startsWith("com.reai.")) m["publisherId"] = "reai";
    const requires = m["requires"] as Record<string, unknown>;
    (requires["hostCapabilities"] as string[]).push(capability);
    return m;
  };

  test("第三方 App 对 grantGated 能力按未授予拒绝", () => {
    const findings = validateManifest(manifestRequiringGated(), matrixWithGated());
    expect(findings.map((f) => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);
  });


  test("生产矩阵列出真实特权能力，未知能力仍走 HOST_CAPABILITY_NOT_AVAILABLE", () => {
    const findings = validateManifest(manifestRequiringGated());
    expect(findings.map((f) => f.code)).toEqual(["HOST_CAPABILITY_NOT_AVAILABLE"]);
    expect(loadSupportMatrix().hostCapabilities.grantGated).toEqual([
      "agent.codex@1",
      "agent.codex.tasks@1",
      "agent.local@1",
      // DSH 基础底座服务：按请求孵化一次性引擎进程 + session 续跑（多消费者，
      // 归属由 Host 边车强制）。
      "agent.dsh@1",
      // Pi/DSH 的统一 Agent Session facade；仍需同名用户权限与模型权限。
      "agent.session@1",
      // 官方 Pi 管理插件只读跨 App 快照，并只允许修改新会话模型设置。
      "agent.pi-management@1",
      // 官方 DSH 透明度插件：只读全部来源 App 的脱敏会话，仍需同名用户 permission。
      "agent.dsh-observe@1",
      "activation.startup@1",
      "voice.input@1",
      "voice.command@1",
      "voice.recordings@1",
      "voice.deliver@1",
      "voice.context@1",
      "cloud.model.invoke@1",
      "cloud.workflow.invoke@1",
      // 选文件夹：只回一个用户亲手挑的绝对路径，不含任何文件读写；只授予 codex-link。
      "system.folder-pick@1",
      "local.files@1",
      // 浏览器引擎窄口：远程内容 child WebView 只有 Host 能建；只授予 com.reai.browser。
      "browser.engine@1",
      // 电脑操控引擎窄口：截屏与鼠标/键盘注入只有 Host 能做；只授予 com.reai.computer。
      "computer.engine@1",
      // Audio8 本地 TTS 只授予开发者内置插件，不附带通用 Voice 能力。
      "tts.local@1",
      // 开放平台管理窄口只授予精确系统插件，并继续受开发者模式与审核 policy 限制。
      "developer.platform@1",
      // 交互式终端由 Host 持有 PTY；插件仅在审核和用户同意后获得会话窄口。
      "terminal.session@1",
      // 只写纯文本剪贴板窄口；不开放读取、富文本、图片或文件。
      "surface.clipboard@1",
      "agent.session@2",
      "local.terminal.exec@1",
      // 共享录音片段：只对审核策略按版本批准、且同时获准 audio.capture@1 的插件开放。
      "audio.clips@1",
      // v1.0.5：任务胶囊、统一通知与共享采音只对审核批准 + 用户同意的插件开放。
      "audio.capture@1",
      "tasks.present@1",
      "notifications.publish@1",
      // 单次 Esc 仲裁：Host 发起握手，插件只能回执 consumed/pass/input-owned（T05）。
      "surface.escape@1",
      "resources.files@1",
    ]);
    expect(loadSupportMatrix().hostCapabilities.granted).toContain("titlebar.action@1");
    expect(loadSupportMatrix().hostCapabilities.withheld).not.toHaveProperty("titlebar.action@1");
  });

  test("agent.local@1 只授予官方诊断插件，第三方声明按未授予拒绝", () => {
    // 第三方 appId 声明 → 拒绝
    const thirdParty = validateManifest(
      manifestRequiringGated("agent.local@1", "com.somebody.doctor"),
    );
    expect(thirdParty.map((f) => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);

    // 官方 seed（com.reai.device-doctor）声明 → 放行
    const official = validateManifest(
      manifestRequiringGated("agent.local@1", "com.reai.device-doctor"),
    );
    expect(official).toEqual([]);
  });

  test("两条云端通道在能力侧与权限侧同名各出现一次", () => {
    // 同名双层不是笔误：两者是独立命名空间，校验器分查两张表。同名让交叉校验
    // 规则读起来就是一句话——「这两个 id，能力侧和权限侧必须同时声明」。
    const matrix = loadSupportMatrix();
    for (const id of ["cloud.model.invoke@1", "cloud.workflow.invoke@1"]) {
      // 用 Object.keys 而不是 toHaveProperty：能力 id 里的点会被当成属性路径分隔符。
      expect(matrix.hostCapabilities.grantGated).toContain(id);
      expect(Object.keys(matrix.pluginPermissions.supported)).toContain(id);
      expect(Object.keys(matrix.pluginPermissions.withheld)).not.toContain(id);
    }
  });

  test("DSH 透明度插件必须同时声明只读 capability 与同名 permission", () => {
    const withBoth = manifestRequiringGated("agent.dsh-observe@1", "com.reai.dsh-agent");
    (withBoth["permissions"] as unknown[]).push({
      id: "agent.dsh-observe@1",
      purpose: "展示所有来源 App 的脱敏 DSH 记录",
      required: true,
    });
    expect(validateManifest(withBoth)).toEqual([]);

    const onlyCapability = structuredClone(withBoth);
    onlyCapability["permissions"] = [];
    expect(validateManifest(onlyCapability).map((finding) => finding.code)).toEqual([
      "MANIFEST_REFERENCE_INVALID",
    ]);

    const onlyPermission = structuredClone(withBoth);
    const requires = onlyPermission["requires"] as Record<string, unknown>;
    requires["hostCapabilities"] = (requires["hostCapabilities"] as string[]).filter(
      (id) => id !== "agent.dsh-observe@1",
    );
    expect(validateManifest(onlyPermission).map((finding) => finding.code)).toEqual([
      "MANIFEST_REFERENCE_INVALID",
    ]);
  });

  test("第三方声明云端能力被拒——这是预期的 fail-closed，不是 bug", () => {
    // 要开放第三方，前提是先有「用户可达的能力授予入口」，那是独立一块。
    // 这条断言把边界钉住，防止以后有人「顺手放开」。
    for (const capability of ["cloud.model.invoke@1", "cloud.workflow.invoke@1"]) {
      const manifest = manifestRequiringGated(capability, "com.example.todo");
      (manifest["permissions"] as unknown[]).push({
        id: capability,
        purpose: "第三方尝试调用云端",
        required: false,
      });
      expect(validateManifest(manifest).map((f) => f.code)).toEqual([
        "APP_CAPABILITY_NOT_GRANTED",
      ]);
    }
  });

  test("验收插件同时声明两层才通过，少一层报 MANIFEST_REFERENCE_INVALID", () => {
    const withBoth = () => {
      const m = minimalTodo();
      m["appId"] = "com.reai.cloud-ai-probe";
      m["publisherId"] = "reai";
      const requires = m["requires"] as Record<string, unknown>;
      (requires["hostCapabilities"] as string[]).push("cloud.model.invoke@1");
      (m["permissions"] as unknown[]).push({
        id: "cloud.model.invoke@1",
        purpose: "调用云端模型",
        required: false,
      });
      return m;
    };
    expect(validateManifest(withBoth())).toEqual([]);

    const onlyCapability = withBoth();
    onlyCapability["permissions"] = [];
    expect(validateManifest(onlyCapability).map((f) => f.code)).toEqual([
      "MANIFEST_REFERENCE_INVALID",
    ]);

    const onlyPermission = withBoth();
    const requires = onlyPermission["requires"] as Record<string, unknown>;
    requires["hostCapabilities"] = (requires["hostCapabilities"] as string[]).filter(
      (id) => id !== "cloud.model.invoke@1",
    );
    expect(validateManifest(onlyPermission).map((f) => f.code)).toEqual([
      "MANIFEST_REFERENCE_INVALID",
    ]);
  });

  test("官方插件只放行明确 seed 的能力，不因 appId 命中而拿到未来全部特权", () => {
    const official = validateManifest(
      manifestRequiringGated("agent.codex@1", "com.reai.codex-link"),
    );
    expect(official).toEqual([]);

    const matrix = structuredClone(loadSupportMatrix());
    matrix.hostCapabilities.grantGated.push("future.admin@1");
    const overreach = validateManifest(
      manifestRequiringGated("future.admin@1", "com.reai.codex-link"),
      matrix,
    );
    expect(overreach.map((f) => f.code)).toEqual(["APP_CAPABILITY_NOT_GRANTED"]);

    const voice = minimalTodo();
    voice["appId"] = "com.reai.voice";
    voice["publisherId"] = "reai";
    const requires = voice["requires"] as Record<string, unknown>;
    (requires["hostCapabilities"] as string[]).push("voice.input@1");
    expect(validateManifest(voice)).toEqual([]);

    // 本 CLI 按 appId 只继承 policy 里该 App 的最后一条批准。Voice 的最后一条是当前内置锁
    // 对应的开放平台批准包（2.14.3，能力集与 2.14.2 相同）：其受控声明（含剪贴板）放行；旧候选记录里有、批准包
    // 未声明的 agent.dsh@1 与从未批准的 agent.codex@1 都不放行。
    (requires["hostCapabilities"] as string[]).push("surface.clipboard@1");
    expect(validateManifest(voice)).toEqual([]);

    for (const capability of ["agent.dsh@1", "agent.codex@1"]) {
      const widened = structuredClone(voice);
      ((widened["requires"] as Record<string, unknown>)["hostCapabilities"] as string[]).push(capability);
      expect(validateManifest(widened).map((f) => f.code)).toEqual([
        "APP_CAPABILITY_NOT_GRANTED",
      ]);
    }
  });
});
