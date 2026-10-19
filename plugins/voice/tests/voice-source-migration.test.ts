import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, SurfaceMountHandler } from "@reai/app-sdk/v1";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  SOURCE_MIGRATION_KEY,
  SOURCE_MIGRATION_NOTICE,
  SOURCE_MIGRATION_NOTICE_KEY,
  SOURCE_SELECTION_KEY,
} from "../src/data";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "app.manifest.json"), "utf8"),
) as Record<string, unknown>;

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
beforeEach(() => document.body.replaceChildren());

type UnsafeMockHost = { storage: Map<string, unknown> };
const storageKey = (key: string) => `com.reai.voice/voice-state/${key}`;
const seed = (host: MockHost, key: string, value: unknown) => {
  (host as unknown as UnsafeMockHost).storage.set(storageKey(key), structuredClone(value));
};
const stored = (host: MockHost, key: string) =>
  (host as unknown as UnsafeMockHost).storage.get(storageKey(key));
/** 录音来源行打开五档对话框，再点选目标档位。 */
const chooseSource = (root: ParentNode | null | undefined, mode: string) => {
  root?.querySelector<HTMLButtonElement>('[data-settings-target="source"]')?.click();
  root?.querySelector<HTMLButtonElement>(`.voice-source-option[data-audio-source-mode="${mode}"]`)?.click();
};

function createHost(ownedSession?: string): MockHost {
  let host: MockHost;
  host = new MockHost({
    ...(ownedSession ? { ownedConversationOpen: {
      accountGeneration: "synthetic-source-migration", packageDigest: "b".repeat(64),
      admitted: true, decision: "granted" as const, userCeiling: "system" as const,
      sessionIds: [ownedSession],
    } } : {}),
    loadApp: async () => {
      const module = await import("../src/app");
      if (!ownedSession) return module;
      const app = module.default;
      return { default: { ...app, async activate(ctx: AppContext) {
        const register = ctx.surfaces.register.bind(ctx.surfaces);
        ctx.surfaces.register = <TIntent>(surfaceId: string, handler: SurfaceMountHandler<TIntent>) => register<TIntent>(surfaceId,
          surfaceId !== "main" ? handler : async surface => {
            // Real mount/presentation exist before the App's first render.
            const receipt = await host.deliverOwnedConversationOpen(ownedSession);
            const initialIntent = {
              source: "host.taskConversation", actionId: "open-conversation",
              payload: { entityId: ownedSession, openToken: receipt.openToken },
            };
            return handler({ ...surface, initialIntent: initialIntent as TIntent });
          });
        return app.activate(ctx);
      } } };
    },
    manifest: structuredClone(manifest) as never,
    voiceInputStatus: {
      phase: "idle",
      source: "board",
      modelId: DEFAULT_SETTINGS.modelId,
      sourceReady: true,
    },
    createRoot: () => {
      const element = document.createElement("div");
      document.body.append(element);
      return element;
    },
  });
  return host;
}

describe("Voice 旧系统音源的一次性 v2 迁移", () => {
  test("键盘来源打开 Voice surface 不枚举系统输入", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      host.voiceInputRequests.filter(
        (request) => request.method === "voice.system-inputs.list",
      ),
    ).toHaveLength(0);

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("Board 慢刷新不能清空切到系统来源后刚加载的输入列表", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let intercepted = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.status" && !intercepted) {
        intercepted = true;
        await refreshGate;
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    expect(intercepted).toBeTrue();
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "stale-board-refresh-test",
      payload: { type: "open-settings" },
    });
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const endpointBeforeOldRefresh = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpointBeforeOldRefresh?.disabled).toBeFalse();
    expect(endpointBeforeOldRefresh?.textContent).toContain("Mock microphone");

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const endpointAfterOldRefresh = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpointAfterOldRefresh?.disabled).toBeFalse();
    expect(endpointAfterOldRefresh?.textContent).toContain("Mock microphone");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("非来源设置变化不能丢弃慢刷新返回的整页数据", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let intercepted = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.models.list") {
        intercepted = true;
        await refreshGate;
        return {
          models: [{
            id: "slow-refresh-model",
            name: "慢刷新模型",
            description: "只由被阻塞的整页刷新返回",
            sizeBytes: 1,
            state: "active",
            active: true,
          }],
        };
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    expect(intercepted).toBeTrue();
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "unrelated-settings-refresh-test",
      payload: { type: "open-settings" },
    });
    expect(surface.root?.textContent).not.toContain("慢刷新模型");
    surface.root?.querySelector<HTMLButtonElement>("[data-language-row]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("慢刷新模型");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("云端设置不再暴露窗口上下文开关", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      engine: "cloud",
      polishContext: { ...DEFAULT_SETTINGS.polishContext, window: true },
    });

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "hidden-context-setting-test",
      payload: { type: "open-settings" },
    });
    expect(surface.root?.querySelector('[data-settings-target="polish-context"]')).toBeNull();
    expect(surface.root?.textContent).not.toContain("窗口上下文");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("system 来源 ABA 后旧刷新不能覆盖最新设备列表", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-mic",
    });
    seed(host, SOURCE_MIGRATION_KEY, 1);
    seed(host, SOURCE_SELECTION_KEY, 2);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let systemInputRequestCount = 0;
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.models.list") await refreshGate;
      if (method === "voice.system-inputs.list") {
        systemInputRequestCount += 1;
        return {
          endpoints: systemInputRequestCount <= 2
            ? [{ id: "old-mic", name: "旧麦克风", isDefault: true }]
            : [{ id: "latest-mic", name: "最新麦克风", isDefault: true }],
        };
      }
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "source-aba-test",
      payload: { type: "open-settings" },
    });
    chooseSource(surface.root, "auto");
    await new Promise((resolve) => setTimeout(resolve, 20));
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("最新麦克风");

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.textContent).toContain("最新麦克风");
    expect(surface.root?.textContent).not.toContain("旧麦克风");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("system 内切换 endpoint 后旧刷新不能恢复旧设备状态", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-mic",
    });
    seed(host, SOURCE_MIGRATION_KEY, 1);
    seed(host, SOURCE_SELECTION_KEY, 2);
    const anyHost = host as unknown as {
      handleRequest(method: string, params: unknown): Promise<unknown>;
    };
    const original = anyHost.handleRequest.bind(host);
    let gateEnabled = false;
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let gatedStatusCount = 0;
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.system-inputs.list") {
        return {
          endpoints: [
            { id: "old-mic", name: "旧设备", isDefault: true },
            { id: "latest-mic", name: "新设备", isDefault: false },
          ],
        };
      }
      if (gateEnabled && method === "voice.status") {
        gatedStatusCount += 1;
        return {
          phase: "idle",
          source: "system",
          modelId: DEFAULT_SETTINGS.modelId,
          sourceReady: gatedStatusCount > 1,
          ...(gatedStatusCount > 1 ? {} : { sourceIssue: "endpoint_unavailable" }),
        };
      }
      if (gateEnabled && method === "voice.models.list") await refreshGate;
      return original(method, params);
    };

    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "endpoint-refresh-setup",
      payload: { type: "open-settings" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gateEnabled = true;
    await host.sendIntent(surface.surfaceMountId, {
      type: "system-task.return",
      taskId: "endpoint-refresh",
      target: "permission-settings",
      outcome: "succeeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const endpoint = surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    );
    expect(endpoint).not.toBeNull();
    if (endpoint) {
      endpoint.value = "latest-mic";
      endpoint.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatedStatusCount).toBe(2);
    expect(surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    )?.value).toBe("latest-mic");
    expect(surface.root?.querySelector('[data-action="recognition-test"]')).toBeNull();

    releaseRefresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.querySelector<HTMLSelectElement>(
      'select[aria-label="系统输入设备"]',
    )?.value).toBe("latest-mic");
    expect(surface.root?.textContent).not.toContain("麦克风不可用");

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("后台激活切回 Board，不携带 legacy 标志，并同时完成 v1/v2 marker", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "BlackHole2ch_UID",
    });

    await host.installAndEnable();

    const configure = host.voiceInputRequests.filter((request) => request.method === "voice.configure");
    expect(configure).toHaveLength(1);
    expect(configure[0]?.params).toMatchObject({ source: "board" });
    expect(configure[0]?.params).not.toHaveProperty("systemEndpointId");
    expect(configure[0]?.params).not.toHaveProperty("legacySourceMigration");
    expect(stored(host, "settings")).toMatchObject({ source: "board" });
    expect(stored(host, "settings")).not.toHaveProperty("systemEndpointId");
    expect(stored(host, SOURCE_MIGRATION_KEY)).toBe(1);
    expect(stored(host, SOURCE_SELECTION_KEY)).toBe(2);
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);

    await host.disable();
  });

  test("无 surface 激活不丢提示；第一次打开显示并清除，第二次不再显示", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "old-test-device",
    });

    await host.installAndEnable();
    expect(document.querySelector(".voice-source-migration-notice")).toBeNull();
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);

    const first = await host.openSurface("main");
    expect(first.root?.querySelector(".voice-source-migration-notice")?.textContent)
      .toContain("录音来源已恢复为键盘麦克风");
    expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBeUndefined();
    await host.unmountSurface(first.surfaceMountId);

    const second = await host.openSurface("main");
    expect(second.root?.querySelector(".voice-source-migration-notice")).toBeNull();
    await host.unmountSurface(second.surfaceMountId);
    await host.disable();
  });

  test("任务深链立刻进入对话时不把未显示的提示吃掉，回到列表后才确认", async () => {
    const host = createHost("task-deep-link");
    let surfaceMountId: string | undefined;
    try {
      seed(host, "settings", {
        ...DEFAULT_SETTINGS,
        source: "system",
        systemEndpointId: "old-test-device",
      });
      seed(host, "command-history", [{
        id: "task-deep-link",
        transcript: "检查录音来源",
        reply: "已经处理",
        status: "completed",
        createdAt: "2026-08-24T00:00:00.000Z",
        agentSessionId: "task-deep-link",
        unread: true,
      }]);

      await host.installAndEnable();
      const surface = await host.openSurface("main");
      surfaceMountId = surface.surfaceMountId;
      const landingDeadline = Date.now() + 2500;
      while (!surface.root?.querySelector(".chat-view") && Date.now() < landingDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(surface.root?.querySelector(".chat-view")).not.toBeNull();
      expect(surface.root?.querySelector(".voice-source-migration-notice")).toBeNull();
      expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);
      while (host.ownedConversationCommits.length !== 1 && Date.now() < landingDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      const delivered = surface.intents.find(intent => (intent as { actionId?: string }).actionId === "open-conversation") as
        { payload: { entityId: string; openToken: string } } | undefined;
      if (!delivered) throw new Error("真实 Host 初始会话 receipt 没有投递记录");
      expect(surface.readyCount).toBe(1);
      expect(surface.failCount).toBe(0);
      expect(surface.root?.isConnected).toBeTrue();
      expect(delivered.payload.entityId).toBe("task-deep-link");
      expect(host.ownedConversationCommits).toEqual([{ sessionId: "task-deep-link", openToken: delivered.payload.openToken, revision: 0 }]);
      expect(host.voiceCommandRequests.some(request => request.method === "voice.command.dismiss-task")).toBeFalse();
      while ((stored(host, "command-history") as { unread?: boolean }[])[0]?.unread === true && Date.now() < landingDeadline) await new Promise(resolve => setTimeout(resolve, 5));
      const savedCommand = (stored(host, "command-history") as { id: string; unread?: boolean }[]).find(row => row.id === "task-deep-link");
      expect(savedCommand?.id).toBe("task-deep-link");
      expect(savedCommand?.unread).not.toBeTrue();

      const back = await host.invokeCommand("com.reai.voice.back-to-root", {});
      expect(back.ok).toBeTrue();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(surface.root?.querySelector(".voice-source-migration-notice")?.textContent)
        .toContain("录音来源已恢复为键盘麦克风");
      expect(stored(host, SOURCE_MIGRATION_NOTICE_KEY)).toBeUndefined();
    } finally {
      try { if (surfaceMountId) await host.unmountSurface(surfaceMountId); }
      finally { await host.disable(); }
    }
  });

  test("普通设置不冒充音源确认；用户切到电脑麦克风后才落 marker 和当前默认 endpoint", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    seed(host, SOURCE_MIGRATION_KEY, 1);
    await host.installAndEnable();

    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "source-selection-test",
      payload: { type: "open-settings" },
    });

    const language = surface.root?.querySelector<HTMLButtonElement>("[data-language-row]");
    expect(language).not.toBeNull();
    language?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(host, SOURCE_SELECTION_KEY)).toBeUndefined();

    const source = surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    );
    expect(source).not.toBeNull();
    const systemInputRequestsBeforeSourceChange = host.voiceInputRequests.filter(
      (request) => request.method === "voice.system-inputs.list",
    ).length;
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      host.voiceInputRequests.filter(
        (request) => request.method === "voice.system-inputs.list",
      ),
    ).toHaveLength(systemInputRequestsBeforeSourceChange + 1);
    expect(stored(host, SOURCE_SELECTION_KEY)).toBe(2);
    expect(stored(host, "settings")).toMatchObject({
      source: "system",
      systemEndpointId: "mock-input-uid",
    });

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });

  test("迁移清掉旧 BlackHole 后再选电脑麦克风，只使用当前默认 endpoint", async () => {
    const host = createHost();
    seed(host, "settings", {
      ...DEFAULT_SETTINGS,
      source: "system",
      systemEndpointId: "BlackHole2ch_UID",
    });
    await host.installAndEnable();
    expect(stored(host, "settings")).toMatchObject({ source: "board" });
    expect(stored(host, "settings")).not.toHaveProperty("systemEndpointId");

    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction",
      actionId: "settings",
      deliveryId: "blackhole-endpoint-test",
      payload: { type: "open-settings" },
    });
    const source = surface.root?.querySelector<HTMLButtonElement>(
      '[data-settings-target="source"]',
    );
    expect(source).not.toBeNull();
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(host, "settings")).toMatchObject({
      source: "system",
      systemEndpointId: "mock-input-uid",
    });

    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });
});

describe("录音来源五档（新 Host）", () => {
  /** 模拟认识五档的 Host：记住被写入的档位，并在 permissions 里如实回报。 */
  function fiveModeHost(initialMode: string, options: { failStatusOnce?: boolean; failPermissionsAfterSave?: boolean; gate?: Promise<void> } = {}) {
    const host = createHost();
    const anyHost = host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
    const original = anyHost.handleRequest.bind(host);
    let mode = initialMode;
    let saved = false;
    let failStatus = false;
    const configures: any[] = [];
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.configure") {
        const p = params as any;
        configures.push(structuredClone(p));
        if (p.audioSourcePreference) {
          mode = p.audioSourcePreference.kind;
          saved = true;
          if (options.failStatusOnce) { failStatus = true; options.failStatusOnce = false; }
        }
      }
      if (method === "voice.status" && failStatus) {
        failStatus = false;
        throw new Error("synthetic status failure");
      }
      if (method === "voice.permissions.check") {
        if (saved && options.failPermissionsAfterSave) throw new Error("synthetic permissions failure");
        const reported = mode;
        if (options.gate && !saved) await options.gate;
        return { microphone: "granted", accessibility: "granted", microphoneRequired: false,
          audioSources: { mode: reported, hardware: "available", computer: "available", resolved: "board" } };
      }
      return original(method, params);
    };
    return { host, configures, mode: () => mode };
  }
  async function openSettings(host: MockHost) {
    await host.installAndEnable();
    const surface = await host.openSurface("main");
    await host.sendIntent(surface.surfaceMountId, {
      source: "host.titlebarAction", actionId: "settings", deliveryId: `five-${Math.random()}`, payload: { type: "open-settings" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return surface;
  }

  test("激活准备不写档位；显式选档写入并终结旧迁移 marker", async () => {
    const h = fiveModeHost("prefer_computer");
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    const surface = await openSettings(h.host);
    // Host 真值优先显示，激活期间的 configure 从不带档位。
    expect(surface.root?.querySelector('[data-settings-target="source"]')?.getAttribute("data-audio-source-mode")).toBe("prefer_computer");
    expect(h.configures.every(c => c.audioSourcePreference === undefined)).toBe(true);
    chooseSource(surface.root, "board_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.configures.at(-1)).toMatchObject({ audioSourcePreference: { kind: "board_only" }, source: "board" });
    expect(h.mode()).toBe("board_only");
    expect(stored(h.host, "settings")).toMatchObject({ audioSourcePreference: { kind: "board_only" } });
    expect(surface.root?.querySelector('[data-settings-target="source"]')?.getAttribute("data-audio-source-mode")).toBe("board_only");
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });

  test("Host 已接受选档后本地后续步骤失败：不回滚 Host（猜不出 UAC / 指定设备），界面跟随已写入档位", async () => {
    const h = fiveModeHost("legacy_board_uac", { failStatusOnce: true });
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    const surface = await openSettings(h.host);
    const before = h.configures.length;
    chooseSource(surface.root, "board_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 只发过这一次显式选档，没有用本地旧设置去「回滚」Host。
    expect(h.configures.slice(before)).toHaveLength(1);
    expect(h.configures.at(-1)).toMatchObject({ audioSourcePreference: { kind: "board_only" } });
    expect(h.mode()).toBe("board_only");
    expect(surface.root?.querySelector('[data-settings-target="source"]')?.getAttribute("data-audio-source-mode")).toBe("board_only");
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });

  test("选档后回读失败：界面认已写入的档位，之后还能切回原档", async () => {
    const h = fiveModeHost("auto", { failPermissionsAfterSave: true });
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    const surface = await openSettings(h.host);
    chooseSource(surface.root, "board_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(surface.root?.querySelector('[data-settings-target="source"]')?.getAttribute("data-audio-source-mode")).toBe("board_only");
    chooseSource(surface.root, "auto");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.configures.at(-1)).toMatchObject({ audioSourcePreference: { kind: "auto" } });
    expect(h.mode()).toBe("auto");
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });

  test("显式选档后，晚到的旧刷新（仍带 UAC 兼容态读数）不能把页面盖回去", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = fiveModeHost("legacy_board_uac", { gate });
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    // 首轮刷新卡在 permissions 读数上（读到的是兼容态）。
    const surface = await openSettings(h.host);
    chooseSource(surface.root, "prefer_board");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.mode()).toBe("prefer_board");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const row = surface.root?.querySelector('[data-settings-target="source"]');
    expect(row?.getAttribute("data-audio-source-mode")).toBe("prefer_board");
    expect(row?.textContent).not.toContain("USB 音频兼容模式");
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });
  test("选档 marker 写不进去时整笔不动 Host（不会留下下次激活被旧迁移覆盖的半提交）", async () => {
    const h = fiveModeHost("auto");
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    const surface = await openSettings(h.host);
    const anyHost = h.host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
    const inner = anyHost.handleRequest.bind(h.host);
    anyHost.handleRequest = async (method, params) => {
      if (method === "storage.set" && JSON.stringify(params).includes("source-selection-v2")) throw new Error("synthetic KV failure");
      return inner(method, params);
    };
    const before = h.configures.length;
    chooseSource(surface.root, "board_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.configures.slice(before).some(c => c.audioSourcePreference)).toBe(false);
    expect(h.mode()).toBe("auto");
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });

  test("旧 Host 上选「只用电脑麦」：Host 接受后回读失败也不被当成普通保存回滚", async () => {
    const host = createHost();
    seed(host, "settings", DEFAULT_SETTINGS);
    seed(host, SOURCE_MIGRATION_KEY, 1);
    seed(host, SOURCE_SELECTION_KEY, 2);
    const anyHost = host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
    const original = anyHost.handleRequest.bind(host);
    const configures: any[] = [];
    let failStatus = false;
    anyHost.handleRequest = async (method, params) => {
      if (method === "voice.configure") {
        configures.push(structuredClone(params));
        if ((params as any).source === "system") failStatus = true;
      }
      if (method === "voice.status" && failStatus) { failStatus = false; throw new Error("synthetic status failure"); }
      return original(method, params);
    };
    const surface = await openSettings(host);
    const before = configures.length;
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sent = configures.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: "system" });
    expect(sent[0].audioSourcePreference).toBeUndefined();
    await host.unmountSurface(surface.surfaceMountId);
    await host.disable();
  });
  test("选档先落盘再交 Host：本地设置写不进去就不动 Host；Host 拒绝时本地写回原样", async () => {
    const h = fiveModeHost("auto");
    seed(h.host, "settings", DEFAULT_SETTINGS);
    seed(h.host, SOURCE_MIGRATION_KEY, 1);
    seed(h.host, SOURCE_SELECTION_KEY, 2);
    const surface = await openSettings(h.host);
    const anyHost = h.host as unknown as { handleRequest(method: string, params: unknown): Promise<unknown> };
    const inner = anyHost.handleRequest.bind(h.host);
    let failSettingsWrite = true;
    let rejectConfigure = false;
    anyHost.handleRequest = async (method, params) => {
      if (method === "storage.set" && failSettingsWrite && (params as any).key === "settings") {
        failSettingsWrite = false;
        throw new Error("synthetic KV failure");
      }
      if (method === "voice.configure" && rejectConfigure && (params as any).audioSourcePreference) {
        rejectConfigure = false;
        throw new Error("synthetic configure failure");
      }
      return inner(method, params);
    };
    const before = h.configures.length;
    chooseSource(surface.root, "computer_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.configures.slice(before).some(c => c.audioSourcePreference)).toBe(false);
    expect(h.mode()).toBe("auto");
    rejectConfigure = true;
    chooseSource(surface.root, "board_only");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.mode()).toBe("auto");
    expect((stored(h.host, "settings") as any)?.audioSourcePreference).toBeUndefined();
    await h.host.unmountSurface(surface.surfaceMountId);
    await h.host.disable();
  });
});
