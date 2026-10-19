import { describe, expect, test } from "bun:test";
import type { KeyValueStore } from "@reai/app-sdk/v1";
import {
  DAY_DIGEST_ATTEMPTS_KEY,
  MAX_DAY_DIGEST_ATTEMPTS,
  MAX_COMMAND_MESSAGES_JSON_BYTES,
  MAX_HISTORY_STORE_BYTES,
  DEFAULT_MODEL_ID,
  DEFAULT_SETTINGS,
  POLISH_LIGHT_DEFAULT_MIGRATION_KEY,
  SOURCE_MIGRATION_KEY,
  SOURCE_MIGRATION_NOTICE,
  SOURCE_MIGRATION_NOTICE_KEY,
  SOURCE_SELECTION_KEY,
  createDefaultVoiceViewState,
  migrateAgentExperimentSettings,
  VoiceStateRepository,
  planCommandAgentSessionReconciliation,
  reconcileAuthoritativeVoiceStatus,
  shouldPollVoiceStatus,
  voiceSourceStatusPatch,
  type VoiceCommandHistoryItem,
  type VoiceHistoryItem,
} from "../src/data";

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function storeWith(values: Record<string, unknown>): KeyValueStore {
  const data = new Map(Object.entries(values));
  return {
    async compareAndSet(key, expected, value) {
      if (data.has(key) !== (expected !== undefined)
        || (data.has(key) && JSON.stringify(data.get(key)) !== JSON.stringify(expected))) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async keys() {
      return [...data.keys()];
    },
  };
}

describe("Voice 插件私有数据归一化", () => {
  test("音源档位只保留公开的五个严格 kind；不从最终音源猜偏好", async () => {
    for (const [preference, expected] of [
      [{ kind: "auto" }, { kind: "auto" }],
      [{ kind: "prefer_board" }, { kind: "prefer_board" }],
      [{ kind: "prefer_computer" }, { kind: "prefer_computer" }],
      [{ kind: "board_only" }, { kind: "board_only" }],
      [{ kind: "computer_only" }, { kind: "computer_only" }],
      [{ kind: "legacy_board_uac" }, undefined],
      [{ kind: "system" }, undefined], [{ kind: "prefer_board", extra: true }, undefined], [null, undefined],
      [Object.assign([], { kind: "prefer_board" }), undefined],
      [Object.create({ kind: "prefer_board" }, { extra: { value: true, enumerable: true } }), undefined],
    ]) {
      const repository = new VoiceStateRepository(storeWith({ [SOURCE_MIGRATION_KEY]: 1, [SOURCE_SELECTION_KEY]: 2 }));
      await repository.saveSettings({ ...DEFAULT_SETTINGS, audioSourcePreference: preference } as never);
      const settings = (await repository.load()).settings!;
      expect(settings.audioSourcePreference as unknown).toEqual(expected);
    }
  });

  test("显式选档终结 v1/v2 迁移：下次激活不再剥掉档位或重放旧迁移", async () => {
    const store = storeWith({ settings: { ...DEFAULT_SETTINGS, source: "board", audioSourcePreference: { kind: "board_only" } } });
    const repository = new VoiceStateRepository(store);
    await repository.confirmAudioSourceMode();
    const loaded = await repository.load();
    expect(loaded.settings?.audioSourcePreference).toEqual({ kind: "board_only" });
    expect(loaded.legacySourceMigration).toBe(false);
    expect(loaded.boardSourceMigrationPending).toBe(false);
  });

  test("v1/v2 迁移移除残留自动偏好，完成后也不再回放 prefer_computer", async () => {
    for (const source of ["board", "system"] as const) {
      const store = storeWith({ settings: { ...DEFAULT_SETTINGS, source, audioSourcePreference: { kind: "prefer_computer" } } });
      const repository = new VoiceStateRepository(store);
      const initial = await repository.load();
      expect(initial.settings?.audioSourcePreference).toBeUndefined();
      if (source === "system") await repository.completeBoardSourceMigration(initial.settings!);
      else await repository.completeSourceMigration(initial.settings!);
      expect((await repository.load()).settings?.audioSourcePreference).toBeUndefined();
      expect((await store.get<any>("settings")).audioSourcePreference).toBeUndefined();
    }
  });
  test("切换 Agent 后保留同一可见对话以及每条历史原来的运行归属", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    await repository.appendCommandHistory({ id: "a", conversationId: "conversation-a", agentSessionId: "pi-a", transcript: "first", reply: "answer", status: "completed", createdAt: "2026-09-20T09:00:00.000Z" });
    await repository.appendCommandHistory({ id: "b", conversationId: "conversation-a", agentSessionId: "agent2-b", transcript: "next", reply: "second", status: "completed", createdAt: "2026-09-20T09:00:01.000Z" });
    await repository.saveConversationOptions("conversation-a", { backend: "dsh", workspace: { kind: "direct", path: "/workspace/project" }, sessionId: "agent2-b", workspaceRoot: "/workspace/project", continuationPending: true });
    const stored = await repository.load();
    expect(stored.commandHistory?.map((entry) => [entry.conversationId, entry.agentSessionId])).toEqual([["conversation-a", "agent2-b"], ["conversation-a", "pi-a"]]);
    expect(stored.conversationOptions["conversation-a"]).toMatchObject({ backend: "dsh", sessionId: "agent2-b", continuationPending: true });
    expect(stored.agentExperiment?.backend).toBe("auto");
  });
  test("待送达的续接标记只跟着具体会话存在；没有会话的选择不保留它", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const saved = await repository.saveConversationOptions("c", { backend: "pi", continuationPending: true });
    expect(saved.c).toEqual({ backend: "pi" });
  });
  test("恢复或重试的结算保留原对话身份，不把条目拆到新会话名下", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    await repository.beginCommandHistory({ id: "t", conversationId: "visible-conversation", agentSessionId: "agent2-new", transcript: "q", status: "running", createdAt: "2026-09-20T09:00:00.000Z" });
    // 恢复路径的结算条目只带会话与回合，不带 conversationId。
    const settled = await repository.settleCommandHistory({ id: "t", agentSessionId: "agent2-new", runId: "native", transcript: "q", reply: "a", status: "completed", createdAt: "2026-09-20T09:00:00.000Z" });
    expect(settled.applied).toBeTrue();
    expect((await repository.load()).commandHistory?.find((entry) => entry.id === "t")).toMatchObject({ conversationId: "visible-conversation", agentSessionId: "agent2-new", runId: "native" });
  });
  test("每轮真实元数据重启后保持独立，旧历史不补造用量", async () => {
    const store = storeWith({});
    const repository = new VoiceStateRepository(store);
    const at = "2026-08-22T06:10:00.000Z";
    await repository.appendCommandHistory({ id: "metadata", transcript: "question", status: "completed", createdAt: at,
      messages: [
        { from: "ai", text: "first", at, runtime: "dsh", channel: "external-brain", usage: { complete: true, inputTokens: 30, outputTokens: 12, totalTokens: 42 } },
        { from: "ai", text: "second", at, runtime: "pi", usage: { complete: false, inputTokens: 2, totalTokens: 2 } },
        { from: "ai", text: "legacy", at, totalTokens: 100 },
        { from: "user", text: "user", at, runtime: "codex", channel: "external-brain", usage: { complete: true, inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        { from: "ai", text: "bad", at, usage: { complete: true, inputTokens: -1, outputTokens: 2, totalTokens: 1 } },
      ],
    });
    const messages = (await new VoiceStateRepository(store).load()).commandHistory![0]!.messages!;
    expect(messages[0]).toMatchObject({ runtime: "dsh", channel: "external-brain", usage: { complete: true, inputTokens: 30, outputTokens: 12, totalTokens: 42 } });
    expect(messages[1]!.usage).toEqual({ complete: false, inputTokens: 2 });
    expect(messages[2]!.usage).toBeUndefined();
    expect(messages[2]!.runtime).toBeUndefined();
    expect(messages[3]!.runtime).toBeUndefined();
    expect(messages[3]!.channel).toBeUndefined();
    expect(messages[3]!.usage).toBeUndefined();
    expect(messages[4]!.usage).toEqual({ complete: false, outputTokens: 2 });
  });
  test("Agent 后端默认 auto，旧 pi 一次性迁移且用户之后仍可固定选择 pi", async () => {
    expect(createDefaultVoiceViewState().agentExperiment.backend).toBe("auto");
    expect(migrateAgentExperimentSettings({ backend: "pi" })).toEqual({ backend: "auto" });
    expect(migrateAgentExperimentSettings({ backend: "pi", selectionVersion: 1 })).toEqual({ backend: "pi" });
    expect(migrateAgentExperimentSettings({ backend: "dsh" })).toEqual({ backend: "dsh" });

    const store = storeWith({ "agent-experiment-v0": { backend: "pi" } });
    const repository = new VoiceStateRepository(store);
    expect((await repository.load()).agentExperiment?.backend).toBe("auto");
    await repository.saveAgentExperiment({ backend: "pi" });
    expect((await repository.load()).agentExperiment?.backend).toBe("pi");
  });

  test("旧 system 设置没有 v2 确认时迁回 Board-first，并清掉旧 endpoint", async () => {
    const repository = new VoiceStateRepository(storeWith({
      settings: {
        ...createDefaultVoiceViewState().settings,
        source: "system",
        systemEndpointId: "BlackHole2ch_UID",
      },
      [SOURCE_MIGRATION_KEY]: 1,
    }));

    const stored = await repository.load();
    expect(stored.settings?.source).toBe("board");
    expect(stored.settings?.systemEndpointId).toBeUndefined();
    expect(stored.boardSourceMigrationPending).toBeTrue();
    expect(stored.legacySourceMigration).toBeFalse();
  });

  test("v2 后明确选择的 system 继续保留真实 endpoint", async () => {
    const repository = new VoiceStateRepository(storeWith({
      settings: {
        ...createDefaultVoiceViewState().settings,
        source: "system",
        systemEndpointId: "builtin-mic",
      },
      [SOURCE_MIGRATION_KEY]: 1,
      [SOURCE_SELECTION_KEY]: 2,
    }));

    const stored = await repository.load();
    expect(stored.settings?.source).toBe("system");
    expect(stored.settings?.systemEndpointId).toBe("builtin-mic");
    expect(stored.boardSourceMigrationPending).toBeFalse();
  });

  test("Board v2 迁移只有全部写入成功后才完成，并留下待展示的中性提示", async () => {
    const store = storeWith({
      settings: {
        ...createDefaultVoiceViewState().settings,
        source: "system",
        systemEndpointId: "stale-mic",
      },
    });
    const repository = new VoiceStateRepository(store);
    const boardSettings = { ...createDefaultVoiceViewState().settings, source: "board" as const };

    await repository.beginBoardSourceMigration();
    await repository.completeBoardSourceMigration(boardSettings);

    expect(await store.get<unknown>("settings")).toEqual(boardSettings);
    expect(await store.get<unknown>(SOURCE_MIGRATION_KEY)).toBe(1);
    expect(await store.get<unknown>(SOURCE_SELECTION_KEY)).toBe(2);
    expect(await store.get<unknown>(SOURCE_MIGRATION_NOTICE_KEY)).toBe(SOURCE_MIGRATION_NOTICE);
    const stored = await repository.load();
    expect(stored.boardSourceMigrationPending).toBeFalse();
    expect(stored.sourceMigrationNotice).toBe(SOURCE_MIGRATION_NOTICE);
  });

  test("Board v2 多键提交中断时 journal 保持 pending，下次激活继续而不误判完成", async () => {
    const values = new Map<string, unknown>([
      ["settings", {
        ...createDefaultVoiceViewState().settings,
        source: "system",
        systemEndpointId: "stale-mic",
      }],
    ]);
    let failNoticeOnce = true;
    const store: KeyValueStore = {
      compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
      async get<T>(key: string) {
        return values.get(key) as T | undefined;
      },
      async set(key, value) {
        if (key === SOURCE_MIGRATION_NOTICE_KEY && failNoticeOnce) {
          failNoticeOnce = false;
          throw new Error("simulated KV failure");
        }
        values.set(key, value);
      },
      async delete(key) {
        values.delete(key);
      },
      async keys() {
        return [...values.keys()];
      },
    };
    const repository = new VoiceStateRepository(store);
    await repository.beginBoardSourceMigration();
    await expect(
      repository.completeBoardSourceMigration(createDefaultVoiceViewState().settings),
    ).rejects.toThrow("simulated KV failure");

    const interrupted = await repository.load();
    expect(interrupted.settings?.source).toBe("board");
    expect(interrupted.boardSourceMigrationPending).toBeTrue();
    expect(await store.get<unknown>(SOURCE_SELECTION_KEY)).toBeUndefined();

    await repository.completeBoardSourceMigration(interrupted.settings!);
    expect((await repository.load()).boardSourceMigrationPending).toBeFalse();
  });

  test("迁移 journal 残留时，用户后来的明确 system 选择优先且不会再被打回 Board", async () => {
    const store = storeWith({ settings: createDefaultVoiceViewState().settings });
    const repository = new VoiceStateRepository(store);
    const systemSettings = {
      ...createDefaultVoiceViewState().settings,
      source: "system" as const,
      systemEndpointId: "current-system-input",
    };

    await repository.beginBoardSourceMigration();
    await repository.confirmSourceSelection();
    await repository.saveSettings(systemSettings);

    const loaded = await repository.load();
    expect(loaded.boardSourceMigrationPending).toBeFalse();
    expect(loaded.settings).toMatchObject(systemSettings);
  });

  test("明确选择方法写入 v2 选择 marker", async () => {
    const store = storeWith({});
    const repository = new VoiceStateRepository(store);

    await repository.confirmSourceSelection();
    expect(await store.get<unknown>(SOURCE_SELECTION_KEY)).toBe(2);
  });

  test("命令 Agent 台账只清理自己确认归属的孤儿，不碰其他会话", async () => {
    const repository = new VoiceStateRepository(storeWith({
      "command-history": [
        {
          id: "visible-command",
          transcript: "保留我",
          status: "completed",
          createdAt: "2026-08-23T12:00:00.000Z",
          agentSessionId: "voice-visible",
        },
      ],
      "command-agent-session-ledger-v1": [
        { sessionId: "voice-orphan", createdMs: 100 },
        { sessionId: "voice-missing", createdMs: 100 },
        { sessionId: "voice-active", createdMs: 100 },
        { sessionId: "voice-active-2", createdMs: 100 },
        { sessionId: "voice-current-process", createdMs: 2_100 },
      ],
    }));
    const stored = await repository.load();
    const plan = planCommandAgentSessionReconciliation({
      ledger: stored.commandAgentSessionLedger,
      hostSessions: [
        { sessionId: "voice-orphan", createdMs: 100 },
        { sessionId: "voice-visible", createdMs: 100 },
        { sessionId: "voice-active", createdMs: 100 },
        { sessionId: "voice-active-2", createdMs: 100 },
        { sessionId: "voice-current-process", createdMs: 2_100 },
        // 没在 Voice 正向台账里的会话，即使很旧也绝不能成为删除候选。
        { sessionId: "user-or-other-plugin", createdMs: 1 },
      ],
      visibleSessionIds: new Set(["voice-visible"]),
      activeSessionIds: new Set(["voice-active", "voice-active-2"]),
      processStartedAt: 2_000,
    });
    expect(plan).toEqual({
      forgetSessionIds: ["voice-missing"],
      deleteSessionIds: ["voice-orphan"],
    });
  });

  test("命令 Agent 台账去重并限制为 256 条，历史回填也不能突破上限", async () => {
    const repository = new VoiceStateRepository(storeWith({
      "command-history": [
        {
          id: "old-command",
          transcript: "旧命令",
          status: "completed",
          createdAt: "2026-08-23T10:00:00.000Z",
          agentSessionId: "from-history",
        },
      ],
      "command-agent-session-ledger-v1": [
        { sessionId: "duplicate", createdMs: 1 },
        { sessionId: "duplicate", createdMs: 2 },
        ...Array.from({ length: 300 }, (_, index) => ({
          sessionId: `session-${index}`,
          createdMs: index,
        })),
      ],
    }));
    const stored = await repository.load();
    expect(stored.commandAgentSessionLedger).toHaveLength(256);
    expect(stored.commandAgentSessionLedger.filter((item) => item.sessionId === "duplicate"))
      .toHaveLength(1);
    // 上限已满时优先保留既有正向台账；历史回填不会突破 Host 的会话上限。
    expect(stored.commandAgentSessionLedger.some((item) => item.sessionId === "from-history"))
      .toBeFalse();
  });

  test("按天总结跨重启保留 Dsh 会话游标，并清洗非法游标", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    await repository.saveDayDigests({
      "2026-08-22": {
        dayKey: "2026-08-22",
        points: ["发布节奏已确认"],
        segs: 2,
        chars: 18,
        fromMs: 1,
        toMs: 2,
        createdAt: "2026-08-22T08:00:00.000Z",
        final: false,
        sourceKey: "a@1|b@2",
        backend: "dsh",
        dsh: {
          sessionId: "dsh-day-1",
          sentSegmentIds: ["a", "b"],
          sentSegmentKeys: ["a@1", "b@2"],
        },
      },
      "2026-08-21": {
        dayKey: "2026-08-21",
        points: ["游标过长"],
        segs: 2_049,
        chars: 2_049,
        fromMs: 1,
        toMs: 2,
        createdAt: "2026-08-22T08:00:00.000Z",
        final: true,
        sourceKey: "oversized",
        backend: "dsh",
        dsh: {
          sessionId: "dsh-too-large",
          sentSegmentIds: Array.from({ length: 2_049 }, (_, index) => `seg-${index}`),
          sentSegmentKeys: Array.from({ length: 2_049 }, (_, index) => `seg-${index}@1`),
        },
      },
    });

    expect((await repository.load()).dayDigests["2026-08-22"]).toMatchObject({
      backend: "dsh",
      dsh: {
        sessionId: "dsh-day-1",
        sentSegmentIds: ["a", "b"],
        sentSegmentKeys: ["a@1", "b@2"],
      },
    });
    expect((await repository.load()).dayDigests["2026-08-21"]?.dsh).toBeUndefined();
  });

  test("自动总结失败时间跨 repository 重建保留，并清洗坏值与过旧记录", async () => {
    const now = Date.now();
    const today = localDayKey(new Date(now));
    const yesterdayDate = new Date(now);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = localDayKey(yesterdayDate);
    const twoDaysAgoDate = new Date(now);
    twoDaysAgoDate.setDate(twoDaysAgoDate.getDate() - 2);
    const twoDaysAgo = localDayKey(twoDaysAgoDate);
    const store = storeWith({
      [DAY_DIGEST_ATTEMPTS_KEY]: {
        [today]: now - 1_000,
        [yesterday]: now + 60_000,
        [twoDaysAgo]: -1,
        "not-a-day": now,
        "2000-01-01": now - 1_000,
      },
    });

    const first = new VoiceStateRepository(store);
    expect((await first.load()).dayDigestAttempts).toEqual({ [today]: now - 1_000 });

    await first.saveDayDigestAttempts({ [today]: now, [yesterday]: now - 2_000 });
    const restarted = new VoiceStateRepository(store);
    expect((await restarted.load()).dayDigestAttempts).toEqual({
      [today]: now,
      [yesterday]: now - 2_000,
    });
  });

  test("自动总结失败时间整表写入有硬上限", async () => {
    const now = Date.now();
    const attempts: Record<string, number> = {};
    for (let index = 0; index < 40; index += 1) {
      const date = new Date(now);
      date.setDate(date.getDate() - index);
      attempts[localDayKey(date)] = now - index;
    }
    const repository = new VoiceStateRepository(storeWith({}));
    await repository.saveDayDigestAttempts(attempts);
    expect(Object.keys((await repository.load()).dayDigestAttempts).length)
      .toBeLessThanOrEqual(MAX_DAY_DIGEST_ATTEMPTS);
  });

  test("音源未就绪时持续轮询，并把固件门槛状态同步到页面", () => {
    const current = createDefaultVoiceViewState({
      settings: {
        source: "board" as const,
        modelId: DEFAULT_MODEL_ID,
        language: "auto",
        vadEnabled: true,
        punctEnabled: true,
        engine: "local" as const,
        polish: "raw" as const,
        polishContext: { window: false, recentVoice: true, recentVoiceRangeMinutes: 5 },
      },
      permissions: { microphone: "granted" as const, accessibility: "granted" as const },
      sourceReady: false,
    });
    expect(shouldPollVoiceStatus(current)).toBeTrue();
    expect(
      voiceSourceStatusPatch({
        phase: "idle",
        source: "board",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: false,
        sourceIssue: "firmware_too_old",
        boardFirmwareVersion: "1.49",
        minimumBoardFirmwareVersion: "1.50",
      }),
    ).toEqual({
      sourceReady: false,
      sourceIssue: "firmware_too_old",
      boardFirmwareVersion: "1.49",
      minimumBoardFirmwareVersion: "1.50",
    });
    expect(shouldPollVoiceStatus({ ...current, sourceReady: true })).toBeTrue();
  });

  test("Host 因录音上限回到 idle 时覆盖插件残留的 listening 状态", () => {
    const current = createDefaultVoiceViewState({
      phase: "listening" as const,
      sessionId: "session-b",
      settings: {
        source: "system" as const,
        modelId: DEFAULT_MODEL_ID,
        language: "auto",
        vadEnabled: true,
        punctEnabled: true,
        engine: "local" as const,
        polish: "raw" as const,
        polishContext: { window: false, recentVoice: true, recentVoiceRangeMinutes: 5 },
      },
      permissions: { microphone: "granted" as const, accessibility: "granted" as const },
      activeMode: "command" as const,
      commandPhase: "listening" as const,
    });
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "idle",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: true,
        sessionId: "session-b",
        stopReason: "capture_limit",
      }, "session-b"),
    ).toEqual({
      statusLoad: "loaded",
      phase: "idle",
      commandPhase: "idle",
      // 定向听写（R8）同样由 Host 的 idle 收场：三条听的路一起归位。
      dictationPhase: "idle",
      activeMode: undefined,
      sessionId: undefined,
      error: "单次录音最长 120 秒，已自动停止，请重新开始",
    });
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "idle",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: false,
        sessionId: "session-b",
        stopReason: "source_unavailable",
      }, "session-b"),
    ).toEqual({
      statusLoad: "loaded",
      phase: "idle",
      commandPhase: "idle",
      // 定向听写（R8）同样由 Host 的 idle 收场：三条听的路一起归位。
      dictationPhase: "idle",
      activeMode: undefined,
      sessionId: undefined,
      error: "系统麦克风已中断，请检查设备后重新开始",
    });
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "idle",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: true,
        sessionId: "session-b",
        stopReason: "user_cancel",
      }, "session-b"),
    ).toEqual({
      statusLoad: "loaded",
      phase: "idle",
      commandPhase: "idle",
      dictationPhase: "idle",
      activeMode: undefined,
      sessionId: undefined,
      error: undefined,
    });
    // Host 没给出已知原因时仍保留兜底，不能把真实的异常静默掉。
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "idle",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: true,
        sessionId: "session-b",
      }, "session-b"),
    ).toEqual({
      statusLoad: "loaded",
      phase: "idle",
      commandPhase: "idle",
      dictationPhase: "idle",
      activeMode: undefined,
      sessionId: undefined,
      error: "录音已由系统停止，请重新开始",
    });
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "listening",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: true,
      }, "session-b"),
    ).toBeUndefined();
    expect(
      reconcileAuthoritativeVoiceStatus(
        current,
        {
          phase: "idle",
          source: "system",
          modelId: DEFAULT_MODEL_ID,
          sourceReady: true,
          sessionId: "session-b",
          stopReason: "capture_limit",
        },
        "stale-session-a",
      ),
    ).toBeUndefined();
    expect(
      reconcileAuthoritativeVoiceStatus(current, {
        phase: "idle",
        source: "system",
        modelId: DEFAULT_MODEL_ID,
        sourceReady: true,
        sessionId: "another-session",
        stopReason: "capture_limit",
      }, "session-b"),
    ).toBeUndefined();
  });

  test("旧设置中的未知模型和语言回落到当前受支持值", async () => {
    const repository = new VoiceStateRepository(
      storeWith({
        // 已完成润色默认档迁移的 profile：这里只验证归一化本身。
        [POLISH_LIGHT_DEFAULT_MIGRATION_KEY]: 1,
        settings: {
          source: "future-source",
          modelId: "removed-model",
          language: "xx-INVALID",
          vadEnabled: false,
          punctEnabled: true,
          engine: "quantum",
          polish: "aggressive",
          polishContext: { window: "yes", recentVoice: false, recentVoiceRangeMinutes: 42 },
        },
      }),
    );

    expect((await repository.load()).settings).toEqual({
      source: "board",
      modelId: DEFAULT_MODEL_ID,
      language: "auto",
      vadEnabled: false,
      punctEnabled: true,
      engine: "local",
      // 认不出的润色档位回落到「原样注入」：不认识就别替用户改他说的话。
      polish: "raw",
      // 窗口上下文要读别的应用里的文字，非布尔真值一律当成没开。
      polishContext: { window: false, recentVoice: false, recentVoiceRangeMinutes: 5 },
    });
  });

  // 2026-09-27 Voice 链路解耦定稿（取代 DEV-16「默认原样」）：润色默认开启轻度，只作用于
  // 语音输入法；存量 raw 一次性迁到轻度，迁移之后用户再选原样照常保留。
  test("全新 profile 没写过设置时润色档读到「轻度」，并落迁移标记", async () => {
    const store = storeWith({});
    const settings = (await new VoiceStateRepository(store).load()).settings;
    expect(settings?.polish).toBe("light");
    expect(settings?.polishContext).toEqual({
      window: false,
      recentVoice: true,
      recentVoiceRangeMinutes: 5,
    });
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBe(1);
    // 新用户没有存量设置可迁：不凭空写一份 settings。
    expect(await store.get("settings")).toBeUndefined();
  });

  test("存量缺润色字段读默认「轻度」", async () => {
    const repository = new VoiceStateRepository(
      storeWith({
        settings: {
          source: "board",
          modelId: DEFAULT_MODEL_ID,
          language: "auto",
          vadEnabled: true,
          punctEnabled: true,
          engine: "local",
        },
      }),
    );
    expect((await repository.load()).settings?.polish).toBe("light");
  });

  test("存量 raw 一次性迁到「轻度」并持久化；之后显式选择的原样不再被改", async () => {
    const legacy = {
      source: "system",
      systemEndpointId: "usb-mic",
      modelId: DEFAULT_MODEL_ID,
      language: "zh-CN",
      vadEnabled: true,
      punctEnabled: true,
      engine: "cloud",
      polish: "raw",
      polishContext: { window: true, recentVoice: true, recentVoiceRangeMinutes: 5 },
    };
    const store = storeWith({ settings: legacy });
    const repository = new VoiceStateRepository(store);
    expect((await repository.load()).settings?.polish).toBe("light");
    // 只改润色档，其余字段（含音源与 endpoint）原样保留在存量设置里。
    expect(await store.get<Record<string, unknown>>("settings")).toEqual({ ...legacy, polish: "light" });
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBe(1);
    // 只迁一次：迁移之后三档显式落盘的选择都原样保留。
    for (const level of ["raw", "light", "formal"] as const) {
      const settings = (await repository.load()).settings!;
      await repository.saveSettings({ ...settings, polish: level });
      expect((await repository.load()).settings?.polish).toBe(level);
    }
  });

  test("迁移标记没落成时用户显式选回原样：保存时补落标记，下次激活不再改回轻度", async () => {
    const store = storeWith({ settings: { source: "board", modelId: DEFAULT_MODEL_ID, language: "auto",
      vadEnabled: true, punctEnabled: true, engine: "local", polish: "raw" } });
    const set = store.set.bind(store);
    let failMarker = true;
    store.set = async (key, value) => {
      if (key === POLISH_LIGHT_DEFAULT_MIGRATION_KEY && failMarker) { failMarker = false; throw new Error("kv write failed"); }
      await set(key, value);
    };
    const repository = new VoiceStateRepository(store);
    const settings = (await repository.load()).settings!;
    expect(settings.polish).toBe("light");
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBeUndefined();
    await repository.saveSettings({ ...settings, polish: "raw" });
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBe(1);
    expect((await new VoiceStateRepository(store).load()).settings?.polish).toBe("raw");
  });

  test("迁移写 settings 失败不拦激活、不落标记，下次激活继续迁", async () => {
    const store = storeWith({ settings: { source: "board", modelId: DEFAULT_MODEL_ID, language: "auto",
      vadEnabled: true, punctEnabled: true, engine: "local", polish: "raw" } });
    const set = store.set.bind(store);
    let failSettings = true;
    store.set = async (key, value) => {
      if (key === "settings" && failSettings) { failSettings = false; throw new Error("kv write failed"); }
      await set(key, value);
    };
    // 本次按轻度运行，但存量与标记都没变。
    expect((await new VoiceStateRepository(store).load()).settings?.polish).toBe("light");
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBeUndefined();
    expect((await store.get<{ polish: string }>("settings"))?.polish).toBe("raw");
    expect((await new VoiceStateRepository(store).load()).settings?.polish).toBe("light");
    expect((await store.get<{ polish: string }>("settings"))?.polish).toBe("light");
    expect(await store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY)).toBe(1);
  });

  test("不完整历史不会把未定义字段带进详情页", async () => {
    const repository = new VoiceStateRepository(
      storeWith({
        history: [
          {
            id: "old-item",
            transcript: "旧版历史",
            language: "unknown",
            recognitionEngine: "quantum",
            createdAt: "2026-08-09T00:00:00.000Z",
            durationMs: Number.POSITIVE_INFINITY,
          },
          { id: "broken", transcript: "坏日期", createdAt: "not-a-date" },
        ],
      }),
    );

    expect((await repository.load()).history).toEqual([
      {
        id: "old-item",
        transcript: "旧版历史",
        language: "auto",
        source: "board",
        inserted: false,
        durationMs: 0,
        createdAt: "2026-08-09T00:00:00.000Z",
      },
    ]);
  });

  test("历史只保留已确认的本地或云端识别方式，旧记录维持未知", async () => {
    const repository = new VoiceStateRepository(
      storeWith({
        history: [
          {
            id: "cloud-item",
            transcript: "云端结果",
            language: "zh-CN",
            source: "board",
            inserted: true,
            durationMs: 800,
            createdAt: "2026-08-21T08:00:00.000Z",
            recognitionEngine: "cloud",
          },
          {
            id: "local-item",
            transcript: "本地结果",
            language: "zh-CN",
            source: "board",
            inserted: true,
            durationMs: 800,
            createdAt: "2026-08-21T07:59:00.000Z",
            recognitionEngine: "local",
          },
          {
            id: "legacy-item",
            transcript: "旧记录",
            language: "zh-CN",
            source: "board",
            inserted: true,
            durationMs: 800,
            createdAt: "2026-08-21T07:58:00.000Z",
          },
        ],
      }),
    );

    const history = (await repository.load()).history ?? [];
    expect(history.map((item) => item.recognitionEngine)).toEqual(["cloud", "local", undefined]);
  });

  test("普通输入与命令历史始终裁剪到 Host 单值上限内", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    let inputHistory: VoiceHistoryItem[] = [];
    let commandHistory: VoiceCommandHistoryItem[] = [];

    for (let index = 0; index < 12; index += 1) {
      inputHistory = await repository.appendHistory({
        id: `input-${index}`,
        transcript: "中".repeat(30_000),
        language: "zh-CN",
        source: "board",
        inserted: true,
        durationMs: 120_000,
        createdAt: new Date(2026, 7, 9, 0, index).toISOString(),
      });
      commandHistory = await repository.appendCommandHistory({
        id: `command-${index}`,
        transcript: "命令".repeat(10_000),
        reply: "回复".repeat(40_000),
        status: "completed",
        createdAt: new Date(2026, 7, 9, 1, index).toISOString(),
      });
    }

    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(bytes(inputHistory)).toBeLessThanOrEqual(MAX_HISTORY_STORE_BYTES);
    expect(bytes(commandHistory)).toBeLessThanOrEqual(MAX_HISTORY_STORE_BYTES);
    expect(inputHistory[0]?.id).toBe("input-11");
    expect(commandHistory[0]?.id).toBe("command-11");
  });

  test("UTF-8 裁剪不会把 emoji 的 surrogate pair 切成半个", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const history = await repository.appendHistory({
      id: "emoji",
      transcript: "😀".repeat(40_000),
      language: "auto",
      source: "system",
      inserted: true,
      durationMs: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
    });

    const transcript = history[0]?.transcript ?? "";
    expect(transcript).toMatch(/^(?:😀)*$/u);
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength).toBeLessThanOrEqual(
      MAX_HISTORY_STORE_BYTES,
    );
  });

  test("JSON 转义膨胀时仍保留最新输入与命令历史", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const escaped = '\n"\\'.repeat(80_000);

    const inputHistory = await repository.appendHistory({
      id: "escaped-input",
      transcript: escaped,
      language: "auto",
      source: "board",
      inserted: true,
      durationMs: 1,
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    const commandHistory = await repository.appendCommandHistory({
      id: "escaped-command",
      transcript: escaped,
      reply: escaped,
      status: "completed",
      createdAt: "2026-08-09T00:00:00.000Z",
    });

    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(inputHistory[0]?.id).toBe("escaped-input");
    expect(inputHistory[0]?.transcript.length).toBeGreaterThan(0);
    expect(commandHistory[0]?.id).toBe("escaped-command");
    expect(commandHistory[0]?.transcript.length).toBeGreaterThan(0);
    expect(commandHistory[0]?.reply?.length).toBeGreaterThan(0);
    expect(bytes(inputHistory)).toBeLessThanOrEqual(MAX_HISTORY_STORE_BYTES);
    expect(bytes(commandHistory)).toBeLessThanOrEqual(MAX_HISTORY_STORE_BYTES);
  });

  test("标记旧命令已读与追加新命令并发时串行写入，不覆盖彼此", async () => {
    const values = new Map<string, unknown>([
      [
        "command-history",
        [
          {
            id: "old-command",
            transcript: "旧命令",
            status: "completed",
            createdAt: "2026-08-22T08:00:00.000Z",
            unread: true,
          },
        ],
      ],
    ]);
    let commandReads = 0;
    let releaseFirstRead!: () => void;
    const firstReadBlocked = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const store: KeyValueStore = {
      async compareAndSet(key, expected, value) {
        if (values.has(key) !== (expected !== undefined)
          || (values.has(key) && JSON.stringify(values.get(key)) !== JSON.stringify(expected))) return false;
        values.set(key, structuredClone(value));
        return true;
      },
      async get<T>(key: string) {
        const snapshot = structuredClone(values.get(key)) as T | undefined;
        if (key === "command-history") {
          commandReads += 1;
          if (commandReads === 1) await firstReadBlocked;
        }
        return snapshot;
      },
      async set(key, value) {
        values.set(key, structuredClone(value));
      },
      async delete(key) {
        values.delete(key);
      },
      async keys() {
        return [...values.keys()];
      },
    };
    const repository = new VoiceStateRepository(store);

    const markRead = repository.markCommandRead("old-command");
    const append = repository.appendCommandHistory({
      id: "new-command",
      transcript: "新命令",
      status: "completed",
      createdAt: "2026-08-22T09:00:00.000Z",
    });
    await Promise.resolve();
    await Promise.resolve();

    // 第一笔读被刻意卡住时，第二个写操作不应已经读到同一份旧快照。
    expect(commandReads).toBe(1);
    releaseFirstRead();
    await Promise.all([markRead, append]);

    const history = (await repository.load()).commandHistory ?? [];
    expect(history.map((item) => item.id)).toEqual(["new-command", "old-command"]);
    expect(history.find((item) => item.id === "new-command")?.unread).toBeTrue();
    expect(history.find((item) => item.id === "old-command")?.unread).toBeUndefined();
  });

  test("命令条目的 Agent Session id、命令类型、页头身份与消息流落盘后还在", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const saved = await repository.appendCommandHistory({
      id: "cmd-session",
      transcript: "帮我写一封邮件",
      reply: "Hi team,",
      status: "completed",
      createdAt: "2026-08-22T06:10:00.000Z",
      agentSessionId: "agent-session-abc",
      commandId: "voice.command.agent",
      identity: { avatar: "✉️", title: "Email — Q3 timeline update", role: "Writing assistant" },
      messages: [
        { from: "user", text: "帮我写一封邮件", at: "2026-08-22T06:10:00.000Z" },
        {
          from: "ai",
          text: "",
          at: "2026-08-22T06:12:00.000Z",
          attachments: [
            { kind: "file", icon: "📄", name: "Q3_update_email.txt", meta: "Plain text · 0.3 KB" },
            { kind: "image", alt: "Comparison chart screenshot" },
            { kind: "audio", durationMs: 42_000, waveform: [5, 9, 40, -3] },
          ],
        },
      ],
    });
    const reloaded = (await repository.load()).commandHistory ?? [];
    expect(reloaded[0]?.agentSessionId).toBe("agent-session-abc");
    expect(reloaded[0]?.commandId).toBe("voice.command.agent");
    expect(reloaded[0]?.identity).toEqual({
      avatar: "✉️",
      title: "Email — Q3 timeline update",
      role: "Writing assistant",
    });
    expect(reloaded[0]?.messages).toHaveLength(2);
    expect(reloaded[0]?.messages?.[1]?.attachments).toEqual([
      { kind: "file", icon: "📄", name: "Q3_update_email.txt", meta: "Plain text · 0.3 KB" },
      { kind: "image", alt: "Comparison chart screenshot" },
      // 波形高度夹到 1–20px 内：越界值是坏数据，不是更高的条子。
      { kind: "audio", durationMs: 42_000, waveform: [5, 9, 20, 1] },
    ]);
    expect(saved).toEqual(reloaded);
    // 认不出的附件类型 / 残缺身份整个丢掉，不半吊子落盘。
    const odd = await repository.appendCommandHistory({
      id: "cmd-odd",
      transcript: "x",
      status: "completed",
      createdAt: "2026-08-22T06:20:00.000Z",
      identity: { avatar: "🌐", title: "t" } as VoiceCommandHistoryItem["identity"],
      messages: [
        { from: "ai", text: "a", at: "2026-08-22T06:20:00.000Z", attachments: [{ kind: "video" } as never] },
      ],
    });
    expect(odd[0]?.identity).toBeUndefined();
    expect(odd[0]?.messages?.[0]?.attachments).toBeUndefined();
  });

  test("消息流撑到预算上限的最新条目经裁剪后仍然保留，不会把整份历史吞成空数组", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const big = "回复".repeat(40_000);
    const messages = Array.from({ length: 50 }, (_, index) => ({
      from: index % 2 === 0 ? ("user" as const) : ("ai" as const),
      text: big,
      at: new Date(2026, 7, 22, 6, index).toISOString(),
      attachments: [{ kind: "audio" as const, durationMs: 1_000, waveform: Array(48).fill(9) }],
    }));
    const commandHistory = await repository.appendCommandHistory({
      id: "cmd-huge",
      transcript: "命令".repeat(10_000),
      reply: big,
      status: "completed",
      createdAt: "2026-08-22T06:59:00.000Z",
      messages,
    });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(commandHistory[0]?.id).toBe("cmd-huge");
    expect(bytes(commandHistory[0]?.messages)).toBeLessThanOrEqual(MAX_COMMAND_MESSAGES_JSON_BYTES);
    expect(bytes(commandHistory)).toBeLessThanOrEqual(MAX_HISTORY_STORE_BYTES);
  });

  test("联网状态卡按白名单持久化，伪造卡片被丢弃", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const commandHistory = await repository.appendCommandHistory({
      id: "cmd-web-card",
      transcript: "查天气",
      status: "failed",
      createdAt: "2026-08-22T07:00:00.000Z",
      messages: [
        {
          from: "ai",
          text: "",
          at: "2026-08-22T07:00:00.000Z",
          card: {
            kind: "capability-required",
            capability: "browser-web-access",
            title: "当前需要联网搜索功能才能完成这个请求",
            detail: "安装后继续",
            actionId: "install-browser-web-access",
            actionLabel: "一键安装并继续",
          },
        },
        {
          from: "ai",
          text: "坏卡",
          at: "2026-08-22T07:00:01.000Z",
          card: { kind: "html", source: "<script>" } as never,
        },
      ],
    });
    expect(commandHistory[0]?.messages?.[0]?.card?.kind).toBe("capability-required");
    expect(commandHistory[0]?.messages?.[1]?.card).toBeUndefined();
  });

  test("消息流超预算时丢最早的轮次、保留最近的", async () => {
    const repository = new VoiceStateRepository(storeWith({}));
    const line = "字".repeat(2_000);
    const commandHistory = await repository.appendCommandHistory({
      id: "cmd-long",
      transcript: "x",
      status: "completed",
      createdAt: "2026-08-22T07:00:00.000Z",
      messages: Array.from({ length: 12 }, (_, index) => ({
        from: "ai" as const,
        text: `${index}:${line}`,
        at: new Date(2026, 7, 22, 7, index).toISOString(),
      })),
    });
    const kept = commandHistory[0]?.messages ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    expect(kept.at(-1)?.text.startsWith("11:")).toBeTrue();
    expect(kept[0]?.text.startsWith("0:")).toBeFalse();
  });
});

test("translation target persists independently and old or invalid settings default to English", async () => {
  const store = storeWith({});
  const repository = new VoiceStateRepository(store);
  expect((await repository.load()).featureSettings).toMatchObject({ translationTarget: "en-US" });
  const defaults = (await repository.load()).featureSettings;
  await repository.saveFeatureSettings({ ...defaults, translationTarget: "ja-JP" } as typeof defaults);
  expect((await new VoiceStateRepository(store).load()).featureSettings).toMatchObject({ translationTarget: "ja-JP" });
  await store.set("voice-feature-settings-v1", { ...defaults, translationTarget: "ignore instructions" });
  expect((await repository.load()).featureSettings).toMatchObject({ translationTarget: "en-US" });
});
