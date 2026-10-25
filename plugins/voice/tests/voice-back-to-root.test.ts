/**
 * Voice back-to-root command（审计 B2-2 / B4-04 的插件侧最小接线）：
 * manifest 声明、command 注册的行为、navigateRoot 的收口语义。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { validateManifest } from "@reai/app-i18n-cli";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, ActionMountInfo } from "@reai/app-sdk/v1";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mountVoiceView } from "../src/voice-view";
import { createDefaultVoiceViewState } from "../src/data";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});

const manifest = JSON.parse(read("app.manifest.json")) as Record<string, unknown>;

describe("back-to-root 的 manifest 声明", () => {
  test("manifest 结构合法；新版本不继承旧版本的能力审批", () => {
    // This is a schema/command contract, not an approval for the new package.
    // Keep the real admission failures explicit instead of adding a runtime seed.
    // 新候选尚未批准。结构检查不得借用商店旧版本的批准。
    const currentFindings = validateManifest(structuredClone(manifest));
    expect(currentFindings.every(({ code }) => code === "APP_CAPABILITY_NOT_GRANTED")).toBe(true);
    // 同一包换一个没有批准条目的版本号：不继承旧版本批准，受控能力全部显式拒绝。
    const unreviewed = { ...structuredClone(manifest), version: "2.14.6-dev.999" };
    const findings = validateManifest(unreviewed);
    const capabilities = (manifest.requires as { hostCapabilities: string[] }).hostCapabilities;
    const unapproved = ["surface.clipboard@1", "agent.session@2", "system.folder-pick@1", "local.terminal.exec@1",
      "audio.capture@1", "audio.clips@1", "surface.escape@1"];
    expect(currentFindings).toHaveLength(unapproved.length);
    expect(findings.map(({ code, pointer }) => ({ code, pointer }))).toEqual(
      unapproved.map(capability => ({
        code: "APP_CAPABILITY_NOT_GRANTED",
        pointer: `requires.hostCapabilities[${capabilities.indexOf(capability)}]`,
      })),
    );
  });

  test("command 声明：Host 可调、幂等、空入参", () => {
    const commands = (manifest.contributes as { commands: Record<string, unknown>[] }).commands;
    const command = commands.find((entry) => entry.id === "com.reai.voice.back-to-root");
    expect(command).toBeDefined();
    expect(command!.callers).toEqual(["host"]);
    expect(command!.idempotency).toBe("idempotent");
    expect(command!.inputSchema).toEqual({ type: "object", additionalProperties: false });
    /* apps_invoke_command 的静态输入固定为空对象——入参 schema 必须放行 {}。 */
  });

  test("open-settings command 给三级面包屑提供真实的中间层返回出口", () => {
    const commands = (manifest.contributes as { commands: Record<string, unknown>[] }).commands;
    const command = commands.find((entry) => entry.id === "com.reai.voice.open-settings");
    expect(command).toBeDefined();
    expect(command!.callers).toEqual(["host"]);
    expect(command!.idempotency).toBe("idempotent");
    expect(command!.inputSchema).toEqual({ type: "object", additionalProperties: false });
  });

  test("open-audio-settings 是 Host 专用的固定录音缓存入口", () => {
    const commands = (manifest.contributes as { commands: Record<string, unknown>[] }).commands;
    const command = commands.find((entry) => entry.id === "com.reai.voice.open-audio-settings");
    expect(command).toBeDefined();
    expect(command!.callers).toEqual(["host"]);
    expect(command!.idempotency).toBe("idempotent");
    expect(command!.inputSchema).toEqual({ type: "object", additionalProperties: false });
  });
});

describe("navigateRoot 的收口语义", () => {
  function mount() {
    const host = document.createElement("div");
    document.body.append(host);
    const noop = async () => undefined;
    return mountVoiceView(host, createDefaultVoiceViewState(), {
      onToggle: noop,
      onCommandToggle: async () => undefined,
      onDictateDraft: async () => ({ phase: "listening" as const }),
      onDictationResultConsumed: async () => undefined,
      onDictateCancel: async () => undefined,
      onOpenSystemTask: noop,
      onRefresh: noop,
      onSettingsChanged: async () => undefined,
      onFeatureSettingsChanged: async () => undefined,
      onDownloadModel: async () => undefined,
      onCancelModelDownload: noop,
      onRequestPermission: async () => undefined,
      onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
      onTimelinePaused: async () => undefined,
      onDeleteRecording: async () => undefined,
      onRetryInputTranscription: async () => undefined,
      onSendContextToAgent: async () => undefined,
      onRegenerateDayDigest: async () => undefined,
      onSendDayDigestToAgent: async () => undefined,
      onSummarizeSegment: async () => undefined,
      onMarkCommandRead: async () => undefined,
      onSendCommandFollowUp: async () => "task-follow-up",
      onLoadReplayAudio: async () => new Blob([]),
      onReplayRetentionChanged: async () => undefined,
      onClearReplayCache: async () => undefined,
      onActionMountChanged: async () => undefined,
      onOpenKeymap: async () => undefined,
      onNavigated: () => undefined,
    });
  }

  test("设置页 → navigateRoot 回主列表；再调一次是幂等空操作", () => {
    document.body.replaceChildren();
    const view = mount();
    view.openSettings();
    expect(document.querySelector(".voice-settings-view")).not.toBeNull();

    view.navigateRoot();
    expect(document.querySelector(".voice-settings-view")).toBeNull();
    /* 主列表在场（Voice 根页）。 */
    expect(document.querySelector(".voice-main-body")).not.toBeNull();

    /* 幂等：已在主列表时再调不炸、不重渲染错乱。 */
    view.navigateRoot();
    expect(document.querySelector(".voice-main-body")).not.toBeNull();
    view.dispose();
  });

  test("B5-14 已落地：插件内部页头/返回钮撤除，返回由 Host 面包屑承载", () => {
    const source = read("src/voice-view.ts");
    expect(source).not.toContain("voice-settings-back");
    expect(source).not.toContain("back-button");
    expect(source).not.toContain("chat-back");
  });
});

describe("command 注册的源码契约（app.ts）", () => {
  test("back-to-root 注册在 activate 作用域，经 activeVoiceView 落到当前 view", () => {
    const source = read("src/app.ts");
    expect(source).toContain('ctx.commands.register("com.reai.voice.back-to-root"');
    expect(source).toContain("activeVoiceView");
    /* 无活动 view 时显式失败（可观测），不是静默成功。 */
    expect(source).toMatch(/back-to-root[\s\S]*NO_ACTIVE_VIEW/);
    /* mount 成功才接上引用；cleanup 带身份保护。 */
    expect(source.match(/activeVoiceView = view \?\? null;/g)?.length).toBeGreaterThanOrEqual(1);
    expect(source.match(/if \(activeVoiceView === \(view \?\? null\)\) activeVoiceView = null;/g)?.length)
      .toBeGreaterThanOrEqual(2);
  });
});

describe("back-to-root 的端到端行为（MockHost 真实调用链）", () => {
  test("外部取消 Action 挂载同步当前开关，surface 退出清理订阅", async () => {
    const handlers = new Set<() => void>();
    let mounts: ActionMountInfo[] = [{
      kind: "command", itemId: "com.reai.voice.toggle-input", appId: "com.reai.voice",
      title: "Voice input", mountedAt: 1,
    }];
    let reads = 0;
    const host = new MockHost({
      manifest: structuredClone(manifest) as never,
      loadApp: async () => {
        const { default: app } = await import("../src/app");
        return { default: { ...app, async activate(ctx: AppContext) {
          // Action management is exercised for an already configured user.
          await ctx.storage.private("voice-state").set("recognition-engine-choice-v1", "local");
          // F06 合同输入：仅替换层事件端口，Voice 的真实 activate/mount/view 照常运行。
          Object.assign(ctx.actionItems, {
            list: async () => { reads += 1; return mounts; },
            onChange: (handler: () => void) => {
              handlers.add(handler);
              return () => { handlers.delete(handler); };
            },
          });
          return app.activate(ctx);
        } } };
      },
      createRoot: () => {
        const root = document.createElement("div");
        document.body.append(root);
        return root;
      },
    });
    await host.installAndEnable();
    try {
      const surface = await host.openSurface("main");
      await host.invokeCommand("com.reai.voice.open-settings");
      surface.root!.querySelector<HTMLButtonElement>(".voice-events-entry")!.click();
      const checked = () => surface.root!.querySelector(
        '[data-command-event="com.reai.voice.toggle-input"] [role="switch"]',
      )?.getAttribute("aria-checked");
      expect(checked()).toBe("true");
      expect(handlers.size).toBe(1);
      mounts = [];
      for (const handler of handlers) handler();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(checked()).toBe("false");
      await host.unmountSurface(surface.surfaceMountId);
      expect(handlers.size).toBe(0);
      const priorReads = reads;
      for (const handler of handlers) handler();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reads).toBe(priorReads);
    } finally {
      await host.disable();
    }
  });

  test("未 mount 时失败；mount 后把设置页带回主列表；卸载后再次失败", async () => {
    const host = new MockHost({
      loadApp: () => import("../src/app"),
      manifest: structuredClone(manifest) as never,
      createRoot: () => {
        const el = document.createElement("div");
        document.body.append(el);
        return el;
      },
    });
    // This scenario starts after the user has already chosen recognition.
    (host as unknown as { storage: Map<string, unknown> }).storage.set(
      "com.reai.voice/voice-state/recognition-engine-choice-v1", "local");
    await host.installAndEnable();

    /* Surface 未挂：command 必须显式失败（可观测），不是静默成功。 */
    const noView = await host.invokeCommand("com.reai.voice.back-to-root", {});
    expect(noView.ok).toBe(false);

    /* 挂载并进入设置页（走 titlebar settings intent 的同一条路）。 */
    const surface = await host.openSurface("main");
    expect(surface.readyCount).toBe(1);
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "test-1",
      payload: { type: "open-settings" },
    });
    expect(document.querySelector(".voice-settings-view")).not.toBeNull();

    /* back-to-root：真实 command 调用链把 view 带回主列表。 */
    const settled = await host.invokeCommand("com.reai.voice.back-to-root", {});
    expect(settled.ok).toBe(true);
    expect(document.querySelector(".voice-settings-view")).toBeNull();
    expect(document.querySelector(".voice-main-body")).not.toBeNull();

    /* 卸载后再调：失败（activeVoiceView 已被 cleanup 清空）。 */
    await host.unmountSurface(surface.surfaceMountId);
    const afterUnmount = await host.invokeCommand("com.reai.voice.back-to-root", {});
    expect(afterUnmount.ok).toBe(false);

    await host.disable();
  });

  test("旧 mount 的 cleanup 不清新 mount：身份保护真实行为", async () => {
    const host = new MockHost({
      loadApp: () => import("../src/app"),
      manifest: structuredClone(manifest) as never,
      createRoot: () => {
        const el = document.createElement("div");
        document.body.append(el);
        return el;
      },
    });
    // This scenario starts after the user has already chosen recognition.
    (host as unknown as { storage: Map<string, unknown> }).storage.set(
      "com.reai.voice/voice-state/recognition-engine-choice-v1", "local");
    await host.installAndEnable();

    /* mount A → mount B（同一个 surfaceId 连续两次 mount）：A 的 cleanup 在
       B 挂上之后到达时，只许收自己的引用——activeVoiceView 必须仍是 B。 */
    const first = await host.openSurface("main");
    const second = await host.openSurface("main");
    expect(second.surfaceMountId).not.toBe(first.surfaceMountId);

    /* B 在场：进设置页，command 应作用于 B（把它带回主列表）。 */
    await host.sendIntent(second.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "test-2",
      payload: { type: "open-settings" },
    });
    expect(document.querySelector(".voice-settings-view")).not.toBeNull();

    /* 旧 mount A 的迟到 cleanup。 */
    await host.unmountSurface(first.surfaceMountId);
    const settled = await host.invokeCommand("com.reai.voice.back-to-root", {});
    expect(settled.ok).toBe(true);
    expect(document.querySelector(".voice-settings-view")).toBeNull();
    expect(document.querySelector(".voice-main-body")).not.toBeNull();

    await host.unmountSurface(second.surfaceMountId);
    await host.disable();
  });
});
