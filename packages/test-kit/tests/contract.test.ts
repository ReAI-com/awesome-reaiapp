/**
 * Mock Host 与合同套件自身的测试。
 *
 * 重点是**它能不能抓到该抓的错**：一个测试工具最危险的失败模式不是报错，是永远说
 * 「通过」。所以每条断言都成对出现——好 App 必须过，对应的坏 App 必须挂。
 */

import { describe, expect, test } from "bun:test";
import { defineApp, RequestMethod } from "@reai/app-sdk/v1";
import { MockHost, defineContractSuite, type AppManifestLike } from "../src/v1/index";

const manifest: AppManifestLike = {
  appId: "com.example.todo",
  contributes: {
    surfaces: [{ id: "main" }],
    commands: [{ id: "com.example.todo.new", timeoutMs: 5000 }],
    intents: [{ id: "new-task" }],
  },
  data: { privateStores: [{ id: "tasks" }] },
};

/** 一个「行为正确」的样例 App。 */
const goodApp = defineApp({
  async activate(ctx) {
    const tasks = ctx.storage.private("tasks");

    ctx.commands.register("com.example.todo.new", async ({ signal }) => {
      await ctx.surfaces.open("main", { intent: { type: "new-task" } }, { signal });
      return { status: "ok" };
    });

    ctx.surfaces.register("main", async (surface) => {
      await tasks.set("items", []);
      surface.ready();
      return () => undefined;
    });
  },
});

const hostFor = (app: unknown) =>
  new MockHost({ manifest, loadApp: async () => ({ default: app }) });

describe("Mock Host", () => {
  test("cloud transcription rejects legacy, malformed and removed options like real Host", async () => {
    const host = new MockHost({ manifest: {
      ...manifest, requires: { hostCapabilities: ["cloud.model.invoke@1"] },
      permissions: [{ id: "cloud.model.invoke@1" }],
    }, loadApp: async () => ({ default: goodApp }) });
    const start = await host.bridge.request<{ sessionId: string }>(RequestMethod.VoiceToggle, { mode: "input", retainAudio: true });
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" });
    for (const model of ["transcribe-default", " transcribe-free ", "transcribe--free", "text-default"]) {
      await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId, model }))
        .rejects.toMatchObject({ code: "AI_INVALID_REQUEST" });
    }
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId, model: "transcribe-free" }))
      .resolves.toMatchObject({ text: "测试云端转写" });
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId }))
      .resolves.toMatchObject({ text: "测试云端转写" });
    // #1291：Host 把幻觉文本置空时带 suppressedReason，用完即复位。
    host.suppressNextAiAudioTranscribe("hallucination_phrase");
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId }))
      .resolves.toMatchObject({ text: "", suppressedReason: "hallucination_phrase" });
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId }))
      .resolves.not.toHaveProperty("suppressedReason");
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId, model: "transcribe-removed" }))
      .rejects.toMatchObject({ code: "AI_INVALID_REQUEST" });
    host.setCloudModels([{ id: "transcribe-paid", kind: "transcribe", label: "Paid" }]);
    await expect(host.bridge.request(RequestMethod.AiAudioTranscribe, { sessionId: start.sessionId, model: "transcribe-free" }))
      .rejects.toMatchObject({ code: "AI_INVALID_REQUEST" });
  });
  test("command 识别结果按 session 确认且重复确认幂等", async () => {
    const host = hostFor(goodApp);
    const listening = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "command" },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "command" });

    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {}))
      .rejects.toThrow("sessionId 必须是非空字符串");
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: "",
    })).rejects.toThrow("sessionId 必须是非空字符串");
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: 42,
    })).rejects.toThrow("sessionId 必须是非空字符串");
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: "not-current",
    })).resolves.toEqual({ acknowledged: false });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: listening.sessionId,
    })).resolves.toEqual({ acknowledged: true });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: listening.sessionId,
    })).resolves.toEqual({ acknowledged: false });
  });

  test("云端识别（retainAudio）的 command 结果同样按 session 确认", async () => {
    const host = hostFor(goodApp);
    const listening = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "command", retainAudio: true },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "command", retainAudio: true });

    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: listening.sessionId,
    })).resolves.toEqual({ acknowledged: true });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: listening.sessionId,
    })).resolves.toEqual({ acknowledged: false });
  });

  test("声明 holdOverlayUntilAck 的输入结果按 session 确认，阶段只认待确认会话", async () => {
    const host = hostFor(goodApp);
    const legacy = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "input", insertText: false },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    // 没声明的旧调用：输入结果不留待确认记录，阶段上报一律不受理。
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: legacy.sessionId, stage: "polishing",
    })).resolves.toEqual({ accepted: false });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: legacy.sessionId,
    })).resolves.toEqual({ acknowledged: false });

    const held = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "input", insertText: false, holdOverlayUntilAck: true },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, { sessionId: held.sessionId }))
      .rejects.toThrow("stage 必须是字符串");
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, { stage: "polishing" }))
      .rejects.toThrow("sessionId 必须是非空字符串");
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: held.sessionId, stage: "done",
    })).resolves.toEqual({ accepted: false });
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: held.sessionId, stage: "polishing",
    })).resolves.toEqual({ accepted: true });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: held.sessionId,
    })).resolves.toEqual({ acknowledged: true });
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: held.sessionId, stage: "polishing",
    })).resolves.toEqual({ accepted: false });

    // 写入失败：结算待确认记录，迟到确认返回 false。
    const failed = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "input", insertText: false, holdOverlayUntilAck: true },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: failed.sessionId, stage: "insert_failed",
    })).resolves.toEqual({ accepted: true });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: failed.sessionId,
    })).resolves.toEqual({ acknowledged: false });
  });

  test("不带 sessionId 的插件级取消丢弃空闲时的待确认胶囊", async () => {
    const host = hostFor(goodApp);
    const held = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "input", insertText: false, holdOverlayUntilAck: true },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    await host.bridge.request(RequestMethod.VoiceCancel, {});
    // 与 Host 的 cancel_for_app 同口径：待确认记录已丢弃，阶段上报与迟到确认都不再受理。
    await expect(host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: held.sessionId, stage: "polishing",
    })).resolves.toEqual({ accepted: false });
    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: held.sessionId,
    })).resolves.toEqual({ acknowledged: false });
  });

  test("同一次待确认里阶段只进不退：迟到的旧阶段不受理", async () => {
    const host = hostFor(goodApp);
    const held = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "input", insertText: false, holdOverlayUntilAck: true },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input", insertText: false });
    const report = (stage: string) => host.bridge.request(RequestMethod.VoiceReportStage, {
      sessionId: held.sessionId, stage,
    });
    await expect(report("polishing")).resolves.toEqual({ accepted: true });
    await expect(report("transcribed")).resolves.toEqual({ accepted: false });
    await expect(report("polishing")).resolves.toEqual({ accepted: true });
    await expect(report("insert_failed")).resolves.toEqual({ accepted: true });
    await expect(report("polishing")).resolves.toEqual({ accepted: false });
  });

  test("开始下一次语音会话会作废上一轮尚未确认的 command 结果", async () => {
    const host = hostFor(goodApp);
    const first = await host.bridge.request<{ sessionId: string }>(
      RequestMethod.VoiceToggle,
      { mode: "command" },
    );
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "command" });
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" });

    await expect(host.bridge.request(RequestMethod.VoiceAcknowledgeResult, {
      sessionId: first.sessionId,
    })).resolves.toEqual({ acknowledged: false });
  });

  test("异步停止终态按 session 保留，精确取消只消费目标且不误伤新会话", async () => {
    const host = hostFor(goodApp);
    host.setVoiceInputStatus({
      phase: "idle",
      source: "system",
      modelId: "sensevoice-small-int8",
      sourceReady: true,
      sessionId: "async-stop-a",
      mode: "command",
      stopReason: "capture_limit",
    });
    host.setVoiceInputStatus({
      phase: "idle",
      source: "board",
      modelId: "sensevoice-small-int8",
      sourceReady: true,
      sessionId: "async-stop-b",
      mode: "input",
      stopReason: "source_unavailable",
    });
    await host.bridge.request(RequestMethod.VoiceToggle, { mode: "input" });

    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "other-session",
    })).resolves.not.toHaveProperty("stopReason");
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "async-stop-a",
    })).resolves.toMatchObject({
      phase: "idle",
      sessionId: "async-stop-a",
      stopReason: "capture_limit",
    });
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "async-stop-b",
    })).resolves.toMatchObject({
      phase: "idle",
      sessionId: "async-stop-b",
      stopReason: "source_unavailable",
    });
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "",
    })).rejects.toThrow("sessionId 必须是非空字符串");
    await expect(host.bridge.request(RequestMethod.VoiceCancel, {
      sessionId: "async-stop-a",
    })).resolves.toBeUndefined();
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "async-stop-a",
    })).resolves.not.toHaveProperty("stopReason");
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {
      sessionId: "async-stop-b",
    })).resolves.toMatchObject({
      sessionId: "async-stop-b",
      stopReason: "source_unavailable",
    });
    await expect(host.bridge.request(RequestMethod.VoiceStatus, {})).resolves.toMatchObject({
      phase: "listening",
    });
    await expect(host.bridge.request(RequestMethod.VoiceCancel, {
      sessionId: "",
    })).rejects.toThrow("sessionId 必须是非空字符串");
  });

  test("Esc 保存的录音可列出并在原会话上完成重新转写", async () => {
    const host = hostFor(goodApp);
    host.setRecoverableVoiceInputSessions([{
      recordingId: "recording-esc-1",
      sessionId: "session-esc-1",
      mode: "input",
      source: "system",
      requestedStartMs: 1_000,
      requestedEndMs: 2_000,
      effectiveStartMs: 900,
      effectiveEndMs: 2_100,
      stopReason: "user_cancel",
      transcriptionStatus: "not_requested",
      transcript: null,
    }]);
    host.setNextVoiceInputSessionTranscript("补回的文字");

    const before = await host.bridge.request(
      RequestMethod.VoiceRecoverableInputSessionsList,
      { page: 0, perPage: 50 },
    );
    expect(before).toMatchObject({ total: 1 });

    await expect(host.bridge.request(RequestMethod.VoiceInputSessionTranscribe, {
      recordingId: "recording-esc-1",
    })).resolves.toEqual({ transcript: "补回的文字" });
    expect(host.getRecoverableVoiceInputSessions()).toEqual([
      expect.objectContaining({
        recordingId: "recording-esc-1",
        transcriptionStatus: "complete",
        transcript: "补回的文字",
      }),
    ]);

    const after = await host.bridge.request(
      RequestMethod.VoiceRecoverableInputSessionsList,
      { page: 0, perPage: 50 },
    );
    expect(after).toMatchObject({ total: 0, items: [] });
  });

  test("网络 Mock 与严格 Host 一样校验 endpoint origin/path/method", async () => {
    const host = new MockHost({
      manifest: {
        ...manifest,
        permissions: [{ id: "http.fetch@1" }],
        network: {
          endpoints: [{
            id: "api",
            origins: ["https://example.com"],
            pathPrefixes: ["/api"],
            methods: ["GET"],
          }],
        },
      },
      loadApp: async () => ({ default: goodApp }),
    });
    await expect(host.bridge.request(RequestMethod.HttpFetch, {
      requestId: "ok",
      endpointId: "api",
      url: "https://example.com/api/tasks",
      method: "GET",
    })).resolves.toMatchObject({ status: 200 });
    for (const request of [
      { url: "https://other.example/api/tasks", method: "GET" },
      { url: "https://example.com/private", method: "GET" },
      { url: "https://example.com/api/tasks", method: "POST" },
    ]) {
      await expect(host.bridge.request(RequestMethod.HttpFetch, {
        requestId: "denied",
        endpointId: "api",
        ...request,
      })).rejects.toThrow("请求未命中 Manifest network endpoint");
    }
  });

  test("系统通知只记录最小负载，不产生真实副作用", async () => {
    let result: unknown;
    const app = defineApp({
      async activate(ctx) {
        result = await ctx.notifications.post({ title: "完成", body: "导出完成" });
        ctx.surfaces.register("main", (surface) => surface.ready());
      },
    });
    const host = new MockHost({
      manifest: {
        ...manifest,
        permissions: [{ id: "os.notification.post@1" }],
      },
      loadApp: async () => ({ default: app }),
    });
    await host.installAndEnable();
    expect(host.notificationRequests).toEqual([{ title: "完成", body: "导出完成" }]);
    expect(result).toEqual({ queued: true });
  });

  test("系统通知 Mock 与生产端同样拒绝错误类型、额外字段和超限负载", async () => {
    for (const payload of [
      { title: 123, body: true },
      { title: "完成", body: "内容", sound: "default" },
      { title: "标".repeat(81), body: "内容" },
      { title: "完成", body: "\u0007" },
      { title: "ReAI\u202eBoard", body: "内容" },
    ]) {
      const app = defineApp({
        async activate(ctx) {
          await ctx.notifications.post(payload as never);
        },
      });
      const host = new MockHost({
        manifest: {
          ...manifest,
          permissions: [{ id: "os.notification.post@1" }],
        },
        loadApp: async () => ({ default: app }),
      });
      await expect(host.installAndEnable()).rejects.toThrow("activate 失败");
      expect(host.notificationRequests).toEqual([]);
      expect(host.activateFailure).toBeDefined();
    }
  });

  test("account.status 只返回最小布尔状态", async () => {
    let observed: unknown;
    const app = defineApp({
      async activate(ctx) {
        observed = await ctx.account.status();
        ctx.surfaces.register("main", (surface) => surface.ready());
      },
    });
    const host = new MockHost({
      manifest,
      loadApp: async () => ({ default: app }),
      accountStatus: { enabled: true, loggedIn: false },
    });
    await host.installAndEnable();
    expect(observed).toEqual({ enabled: true, loggedIn: false });
    expect(JSON.stringify(observed)).not.toMatch(/token|email|sub/i);
  });

  test("system.tasks 要求 Manifest capability，并返回与生产一致的 null 字段", async () => {
    let observed: unknown;
    const app = defineApp({
      async activate(ctx) {
        observed = await ctx.systemTasks.getVersionStatus();
        ctx.surfaces.register("main", (surface) => surface.ready());
      },
    });
    const denied = new MockHost({
      manifest,
      loadApp: async () => ({ default: app }),
    });
    await expect(denied.installAndEnable()).rejects.toThrow("activate 失败");
    expect(denied.rejections).toContainEqual({
      method: "system.tasks.version-status",
      reason: "Manifest 未声明 system.tasks@1",
    });

    const granted = new MockHost({
      manifest: {
        ...manifest,
        requires: { hostCapabilities: ["system.tasks@1"] },
      },
      loadApp: async () => ({ default: app }),
    });
    await granted.installAndEnable();
    expect(observed).toMatchObject({
      firmware: {
        currentVersion: null,
        latestVersion: null,
        connectionType: null,
      },
      app: { latestVersion: null },
      checkedAt: null,
      source: "unavailable",
    });
  });

  test("按 Manifest 强制存储命名空间", async () => {
    const host = hostFor(goodApp);
    await host.installAndEnable();
    await host.openSurface("main");

    expect(host.storageKeys()).toEqual(["com.example.todo/tasks/items"]);
    expect(host.rejections).toEqual([]);
  });

  test("KV 保留显式 null，并把不存在映射为 undefined", async () => {
    let observed: unknown[] = [];
    const app = defineApp({
      async activate(ctx) {
        const store = ctx.storage.private("tasks");
        await store.set("nullable", null);
        observed = [await store.get("nullable"), await store.get("missing")];
        ctx.surfaces.register("main", (surface) => surface.ready());
      },
    });
    const host = hostFor(app);
    await host.installAndEnable();
    expect(observed).toEqual([null, undefined]);
  });

  test("访问未声明的 store 会被拒并记下来", async () => {
    const sneaky = defineApp({
      async activate(ctx) {
        ctx.surfaces.register("main", async (surface) => {
          try {
            await ctx.storage.private("没声明过").set("k", 1);
          } catch {
            // Host 拒绝是预期结果；这里只关心它有没有被记录。
          }
          surface.ready();
        });
      },
    });

    const host = hostFor(sneaky);
    await host.installAndEnable();
    await host.openSurface("main");

    expect(host.rejections.length).toBeGreaterThan(0);
    expect(host.storageKeys()).toEqual([]);
  });

  test("Command 调用拿到终局", async () => {
    const host = hostFor(goodApp);
    await host.installAndEnable();

    const settlement = await host.invokeCommand("com.example.todo.new");
    expect(settlement.ok).toBe(true);
    expect(host.surfaceOpenRequests).toEqual([
      { surfaceId: "main", intent: { type: "new-task" } },
    ]);
  });

  test("apps.status（A3-24 门控数据源）：按选项如实回报并记录查询", async () => {
    let observed: Array<{ appId: string; installed: boolean; enabled: boolean }> = [];
    const app = defineApp({
      async activate(ctx) {
        ctx.surfaces.register("main", async (surface) => {
          observed = [
            await ctx.apps.status({ appId: "com.reai.agents-im" }),
          ];
          surface.ready();
        });
      },
    });
    const host = new MockHost({
      manifest,
      loadApp: async () => ({ default: app }),
      appsStatus: { installed: false, enabled: false },
    });
    await host.installAndEnable();
    await host.openSurface("main");
    // 目标没装是一次成功的查询（installed:false），不是错误——门控要的是事实。
    expect(observed).toEqual([{ appId: "com.reai.agents-im", installed: false, enabled: false }]);
    expect(host.appsStatusRequests).toEqual([{ appId: "com.reai.agents-im" }]);

    // 缺省按「已安装且启用」模拟：合同测试关注插件把状态用对，不是注册表本身。
    const defaulted = new MockHost({ manifest, loadApp: async () => ({ default: app }) });
    await defaulted.installAndEnable();
    await defaulted.openSurface("main");
    expect(observed).toEqual([{ appId: "com.reai.agents-im", installed: true, enabled: true }]);
  });
});

describe("合同套件", () => {
  const runtime = (app: unknown) => ({
    manifest,
    hasDom: false,
    createHost: () => hostFor(app),
  });

  const expectations = {
    surfaces: ["main"],
    commands: ["com.example.todo.new"],
    intents: ["new-task"],
    readySurfaces: ["main"],
    forbiddenNetworkRequests: "all" as const,
    storageNamespace: "com.example.todo",
    noResourcesAfterUnmount: true,
  };

  test("行为正确的 App 全绿", async () => {
    const suite = defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
    });

    const result = await suite.run(runtime(goodApp));
    const failed = result.checks.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.name}: ${c.detail}`)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  test("声明了却没注册的 Command 会被抓出来", async () => {
    const lazy = defineApp({
      activate(ctx) {
        ctx.surfaces.register("main", (surface) => surface.ready());
      },
    });

    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
    }).run(runtime(lazy));

    expect(result.passed).toBe(false);
    expect(
      result.checks.some((c) => !c.ok && c.detail?.includes("com.example.todo.new")),
    ).toBe(true);
  });

  test("注册了却没声明的 Surface 同样被抓出来", async () => {
    const extra = defineApp({
      activate(ctx) {
        ctx.surfaces.register("main", (surface) => surface.ready());
        ctx.surfaces.register("偷偷加的", (surface) => surface.ready());
        ctx.commands.register("com.example.todo.new", async () => ({ status: "ok" }));
      },
    });

    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
    }).run(runtime(extra));

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => !c.ok && c.detail?.includes("偷偷加的"))).toBe(true);
  });

  test("Surface 起不来会被抓出来", async () => {
    const broken = defineApp({
      activate(ctx) {
        ctx.commands.register("com.example.todo.new", async () => ({ status: "ok" }));
        ctx.surfaces.register("main", (surface) => {
          surface.fail(new Error("起不来"));
        });
      },
    });

    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
    }).run(runtime(broken));

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => !c.ok && c.name.includes("恰好就绪一次"))).toBe(true);
  });

  test("偷偷联网会被抓出来", async () => {
    const online = defineApp({
      activate(ctx) {
        ctx.commands.register("com.example.todo.new", async () => ({ status: "ok" }));
        ctx.surfaces.register("main", (surface) => {
          try {
            void fetch("https://example.com");
          } catch {
            // 被封堵是预期结果，App 照常起来，好让「有没有尝试」这条断言说话。
          }
          surface.ready();
        });
      },
    });

    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
    }).run(runtime(online));

    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => !c.ok && c.name.includes("不发起网络请求"))).toBe(true);
  });

  test("场景断言能验证意图投递", async () => {
    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
      scenarios: [
        {
          name: "New Command 打开 main 并投递新建意图",
          async run({ host, expect: expectSurface }) {
            await host.invokeCommand("com.example.todo.new");
            const opened = host.surfaceOpenRequests.at(-1);
            const surface = await host.openSurface("main", opened?.intent);
            expectSurface(surface).toBeOpen();
            expectSurface(surface).toHaveReceivedIntent({ type: "new-task" });
          },
        },
      ],
    }).run(runtime(goodApp));

    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
  });

  test("没有 DOM 时 toHaveFocus 说清原因，而不是悄悄通过", async () => {
    const result = await defineContractSuite({
      appDirectory: ".",
      hostApi: "1.1.0",
      expect: expectations,
      scenarios: [
        {
          name: "焦点断言",
          async run({ host, expect: expectSurface }) {
            const surface = await host.openSurface("main");
            expectSurface(surface).toHaveFocus("新待办内容");
          },
        },
      ],
    }).run(runtime(goodApp));

    const scenario = result.checks.find((c) => c.name.includes("焦点断言"));
    expect(scenario?.ok).toBe(false);
    expect(scenario?.detail).toContain("DOM");
  });
});
