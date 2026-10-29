import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AudioTimelineStatus,
  VoiceModelInfo,
  VoiceRecordingSegment,
} from "@reai/app-sdk/v1";
import {
  DEFAULT_SETTINGS,
  createDefaultVoiceViewState,
  type VoiceCommandHistoryItem,
  type VoiceDayDigest,
  type VoiceHistoryItem,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { dayKeyOf } from "../src/voice-digest";
import { BUILTIN_VOICE_COMMANDS } from "../src/voice-ai-contract";
import { setVoiceLocale } from "../src/voice-i18n";

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

function model(state: VoiceModelInfo["state"], downloadedBytes?: number): VoiceModelInfo {
  return {
    id: "sensevoice-small-int8",
    name: "SenseVoice Small",
    description: "中英粤日韩本地识别",
    sizeBytes: 228 * 1024 * 1024,
    state,
    downloadedBytes,
    active: state === "active",
    updateAvailable: false,
    ...(state === "active" ? { installedVersion: "2026.08.10", latestVersion: "2026.08.10" } : {}),
  };
}

/** 稿 V1.7.3：润色 / 润色上下文两段只在云端引擎时渲染，相关用例统一用这份设置挂载。 */
const CLOUD_SETTINGS = { ...DEFAULT_SETTINGS, engine: "cloud" as const };

function state(models: VoiceModelInfo[]): VoiceViewState {
  return createDefaultVoiceViewState({
    models,
  });
}

function mount(models: VoiceModelInfo[], overrides: Partial<VoiceViewState> = {}, extraActions: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  let workflowValue: string | null | undefined;
  let workflowSettingsOpens = 0;
  const settingsPatches: Array<Partial<VoiceViewState["settings"]>> = [];
  const contextSends: string[] = [];
  const timelinePauseCalls: boolean[] = [];
  const digestCalls = { regenerate: [] as string[], send: [] as string[] };
  const deletes: string[] = [];
  const summarizes: string[] = [];
  const copiedTexts: string[] = [];
  const actions = {
    onCopyText: async (text: string) => {
      copiedTexts.push(text);
    },
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onNavigated: () => undefined,
    onSettingsChanged: async (patch: Partial<VoiceViewState["settings"]>) => {
      settingsPatches.push(patch);
    },
    onFeatureSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onTimelinePaused: async (paused: boolean) => {
      timelinePauseCalls.push(paused);
    },
    onDeleteRecording: async (recordingId: string) => {
      deletes.push(recordingId);
    },
    onRetryInputTranscription: async () => undefined,
    onSendContextToAgent: async (recordingId: string) => {
      contextSends.push(recordingId);
    },
    onRegenerateDayDigest: async (dayKey: string) => {
      digestCalls.regenerate.push(dayKey);
    },
    onSendDayDigestToAgent: async (dayKey: string) => {
      digestCalls.send.push(dayKey);
    },
    onSummarizeSegment: async (recordingId: string) => {
      summarizes.push(recordingId);
    },
    onMarkCommandRead: async () => undefined,
    onConfigureWorkflow: async (value: string | null) => {
      workflowValue = value;
      return { configured: value !== null, loggedIn: true };
    },
    onOpenVoiceCommandSettings: async () => {
      workflowSettingsOpens += 1;
    },
    ...extraActions,
  } as unknown as VoiceViewActions;
  const view = mountVoiceView(root, { ...state(models), ...overrides }, actions);
  return {
    root,
    timelinePauseCalls,
    view,
    workflowValue: () => workflowValue,
    workflowSettingsOpens: () => workflowSettingsOpens,
    settingsPatches,
    contextSends,
    digestCalls,
    deletes,
    summarizes,
    copiedTexts,
  };
}

function capsuleText(root: HTMLElement): string {
  return (root.querySelector(".voice-cap") as HTMLElement).textContent ?? "";
}

function warnRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".voice-warn"));
}

function recording(overrides: Partial<VoiceRecordingSegment> = {}): VoiceRecordingSegment {
  return {
    id: "rec-1",
    wallStartMs: Date.UTC(2026, 7, 17, 12, 0, 0),
    durationMs: 4_000,
    transport: "usb_vendor_hid",
    transcriptText: "把发布节奏整理一下",
    ...overrides,
  } as VoiceRecordingSegment;
}

/**
 * 把语义上属于「今天」的测试时间钳在本地当天内。`bun test` 会在 UTC 时区运行，
 * 刚过午夜时直接使用 `Date.now() - N 分钟` 会落到昨天，让按天分组用例假红。
 */
function todayMs(minutesAgo: number): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.max(Date.now() - minutesAgo * 60_000, midnight.getTime() + 60_000);
}

function segButtons(root: HTMLElement, groupLabel: string): HTMLButtonElement[] {
  const seg = root.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${groupLabel}"]`);
  return seg ? Array.from(seg.querySelectorAll("button")) : [];
}

describe("Voice 模型 readiness 与设置", () => {
  test("R2：未安装模型是缺配置——档内一行琥珀提醒 + 去路进模型设置，胶囊不冒充就绪", () => {
    const harness = mount([model("missing")]);
    const warn = warnRows(harness.root).find((row) => row.dataset.warn === "model") as HTMLElement;
    expect(warn).toBeInstanceOf(HTMLElement);
    expect(warn.textContent).toContain("语音输入还差一步配置");
    expect(warn.textContent).toContain("本地语音模型还没下载");
    // R1：状态卡已撤——没有「语音输入已就绪」「测试语音识别」；胶囊用人话指出缺项。
    expect(harness.root.querySelector(".voice-status")).toBeNull();
    expect(harness.root.textContent).not.toContain("语音输入已就绪");
    expect(harness.root.textContent).not.toContain("测试语音识别");
    expect(capsuleText(harness.root)).toContain("模型未设置");

    const download = warn.querySelector(".voice-warn-go") as HTMLButtonElement;
    expect(download?.textContent).toBe("去设置 ›");
    download.click();

    const focused = harness.root.querySelector('[data-settings-target="model"]');
    expect(focused?.classList.contains("settings-target-flash")).toBeTrue();
    // 模型列表已收进低频二级页，跳转后应明确聚焦「本地模型」。
    expect(focused?.querySelector(".settings-section-title")?.textContent).toBe("本地模型");
    harness.view.dispose();
  });

  test("Command 不再依赖工作流配置，账户可用时没有旧配置警告", () => {
    const harness = mount([model("active")], { commandConfigured: false, commandLoggedIn: true });
    const commandTab = harness.root.querySelector(
      '[data-voice-tab="command"]',
    ) as HTMLButtonElement;
    commandTab.click();
    expect(warnRows(harness.root).find((row) => row.dataset.warn === "command")).toBeUndefined();
    expect(harness.root.textContent).not.toContain("工作流");
    harness.view.dispose();
  });

  test("下载中显示可访问进度条，安装后没有删除入口", () => {
    const harness = mount([model("downloading", 114 * 1024 * 1024)]);
    harness.view.openSettings("model");
    const progress = harness.root.querySelector('[role="progressbar"]');
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("aria-valuenow")).toBe("50");
    expect(harness.root.textContent).not.toContain("删除");

    harness.view.update(state([model("active")]));
    expect(harness.root.textContent).toContain("设置后不可删除");
    expect(harness.root.textContent).not.toContain("删除 SenseVoice");
    harness.view.dispose();
  });

  test("R1 / R14：已安装模型 → 胶囊「本地就绪 | …」；胶囊是全局状态，四档恒为两段、不随 tab 变", () => {
    const harness = mount([model("active")], {
      timeline: {
        state: "running",
        route: "usb_vendor_hid",
        hotRingDurationMs: 2_000,
        cacheDurationMs: 30_000,
        cacheHealth: "healthy",
        continuousRecordingEnabled: true,
        recordingState: "running",
        sttBacklog: 0,
        hostLocalDropFrames: 0,
      },
    });
    // 页头行：标题块 + 胶囊同处一行（稿 .voice-overview-row）。麦克风段纯展示；
    // Context 段自 H02:C04 起是暂停入口（button），不再全静态。
    const row = harness.root.querySelector(".voice-overview-row") as HTMLElement;
    expect(row.querySelector(".voice-overview-title")?.textContent).toBe("语音记录");
    const cap = row.querySelector(".voice-cap") as HTMLElement;
    expect(cap.querySelectorAll("button.voice-cap-action")).toHaveLength(1);
    expect(Array.from(cap.querySelectorAll<HTMLElement>(".voice-cap-seg")).map((seg) => seg.tagName))
      .toEqual(["SPAN", "BUTTON"]);
    expect(warnRows(harness.root)).toHaveLength(0);
    for (const tab of ["all", "input", "command", "context"]) {
      (harness.root.querySelector(`[data-voice-tab="${tab}"]`) as HTMLButtonElement).click();
      const segs = Array.from(harness.root.querySelectorAll<HTMLElement>(".voice-cap-seg"));
      expect(segs.map((seg) => seg.dataset.capSeg)).toEqual(["mic", "ctx"]);
      expect(segs[0]?.textContent).toBe("本地就绪");
      expect(segs[1]?.textContent).toBe("在听");
      expect(segs[1]?.querySelector(".sb-listen .sb-listen-bar")).not.toBeNull();
      expect(harness.root.querySelector(".voice-cap-sep")).not.toBeNull();
    }
    harness.view.dispose();
  });

  test("状态胶囊只让异常态跳转：正常麦克风不响应，Context 未开启进录音缓存", () => {
    const timeline = {
      state: "running" as const,
      route: "usb_vendor_hid" as const,
      hotRingDurationMs: 2_000,
      cacheDurationMs: 30_000,
      cacheHealth: "healthy" as const,
      continuousRecordingEnabled: true,
      recordingState: "running" as const,
      sttBacklog: 0,
      hostLocalDropFrames: 0,
    };
    const ready = mount([model("active")], { timeline });
    const readyMic = ready.root.querySelector('[data-cap-seg="mic"]') as HTMLElement;
    expect(readyMic.tagName).toBe("SPAN");
    expect(ready.root.querySelector('[data-settings-target="engine"]')).toBeNull();
    ready.view.dispose();

    const off = mount([model("active")], {
      timeline: { ...timeline, continuousRecordingEnabled: false },
    });
    const context = off.root.querySelector('[data-cap-seg="ctx"]') as HTMLButtonElement;
    expect(context.getAttribute("aria-label")).toBe("全天存档未开启，打开录音缓存设置");
    context.click();
    expect(off.root.querySelector('[data-settings-target="replay-cache"]')?.classList
      .contains("settings-target-flash")).toBeTrue();
    off.view.dispose();
  });

  test("R14：胶囊的麦克风段随真实状态换字——录音中（红点）/ 识别中；在听段随全天存档开关", () => {
    const timeline = {
      state: "running" as const,
      route: "usb_vendor_hid" as const,
      hotRingDurationMs: 2_000,
      cacheDurationMs: 30_000,
      cacheHealth: "healthy" as const,
      continuousRecordingEnabled: true,
      recordingState: "running" as const,
      sttBacklog: 0,
      hostLocalDropFrames: 0,
    };
    const listening = mount([model("active")], { phase: "listening", timeline });
    const rec = listening.root.querySelector('.voice-cap-seg[data-cap-seg="mic"]') as HTMLElement;
    expect(rec.textContent).toBe("录音中");
    expect(rec.classList.contains("rec")).toBeTrue();
    expect(rec.querySelector(".voice-cap-dot")).not.toBeNull();
    listening.view.dispose();

    const recognizing = mount([model("active")], { commandPhase: "recognizing", timeline });
    expect(recognizing.root.querySelector('.voice-cap-seg[data-cap-seg="mic"]')?.textContent)
      .toBe("识别中");
    recognizing.view.dispose();

    // 全天存档关着：在听段写「未开启」（灰），Context 档多一行去设置的提醒。
    const off = mount([model("active")], {
      timeline: { ...timeline, continuousRecordingEnabled: false },
    });
    const ctx = off.root.querySelector('.voice-cap-seg[data-cap-seg="ctx"]') as HTMLElement;
    expect(ctx.textContent).toBe("未开启");
    expect(ctx.classList.contains("off")).toBeTrue();
    (off.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    expect(warnRows(off.root).find((row) => row.dataset.warn === "context")?.textContent)
      .toContain("全天存档没有开");
    off.view.dispose();

    // 时间线因安全开关停用时，直接说明原因。
    const paused = mount([model("active")], {
      timeline: { ...timeline, state: "disabled_by_safety_switch" },
    });
    expect(paused.root.querySelector('.voice-cap-seg[data-cap-seg="ctx"]')?.textContent)
      .toBe("安全停用");
    paused.view.dispose();

    // 键盘断线：两段收成一段「键盘未连接」。
    const disconnected = mount([model("active")], {
      sourceReady: false,
      sourceIssue: "disconnected",
      timeline: { ...timeline, state: "unavailable" },
    });
    const segs = Array.from(disconnected.root.querySelectorAll<HTMLElement>(".voice-cap-seg"));
    expect(segs).toHaveLength(1);
    expect(segs[0]?.textContent).toBe("键盘未连接");
    expect(disconnected.root.querySelector(".voice-cap button")).not.toBeNull();
    expect(disconnected.root.querySelector(".voice-cap-sep")).toBeNull();
    disconnected.view.dispose();
  });

  test("无版本模型收到Host内容更新标记时允许更新，不展示缺失版本", () => {
    const active = {
      ...model("active"),
      description: "中英粤日韩本地识别 · 2024-07-17",
      installedVersion: undefined,
      latestVersion: "2024-07-17",
      updateAvailable: true,
    };
    const harness = mount([active]);
    harness.view.openSettings("model");

    const action = harness.root.querySelector(
      '[aria-label="SenseVoice Small：更新"]',
    ) as HTMLButtonElement;
    expect(action).toBeInstanceOf(HTMLButtonElement);
    expect(action.disabled).toBeFalse();
    expect(action.textContent).toBe("更新");
    expect(harness.root.textContent).toContain("模型内容有更新");
    expect(harness.root.textContent).not.toContain("undefined");
    expect(harness.root.textContent).not.toContain("可从 旧版 更新到");
    harness.view.dispose();
  });

  test("Host同版本内容更新与不同版本更新都可操作，文案分别表达", () => {
    const current = {
      ...model("active"),
      installedVersion: "2024-07-17",
      latestVersion: "2024-07-17",
      updateAvailable: true,
    };
    const harness = mount([current]);
    harness.view.openSettings("model");
    let action = harness.root.querySelector(
      '[aria-label="SenseVoice Small：更新"]',
    ) as HTMLButtonElement;
    expect(action).toBeInstanceOf(HTMLButtonElement);
    expect(action.disabled).toBeFalse();
    expect(harness.root.textContent).toContain("模型内容有更新");
    expect(harness.root.textContent).not.toContain("更新到 2024-07-17");

    harness.view.update(state([{
      ...current,
      installedVersion: "2024-07-17",
      latestVersion: "2026-08-13",
    }]));
    action = harness.root.querySelector(
      '[aria-label="SenseVoice Small：更新"]',
    ) as HTMLButtonElement;
    expect(action).toBeInstanceOf(HTMLButtonElement);
    expect(action.disabled).toBeFalse();
    expect(harness.root.textContent).toContain("可从 2024-07-17 更新到 2026-08-13");
    harness.view.dispose();
  });

  test("Voice 设置彻底移除工作流与 Agent 后端入口", () => {
    const harness = mount([model("active")]);
    harness.view.openSettings();
    expect(harness.root.querySelector('[aria-label="Workflow Release URL"]')).toBeNull();
    expect(harness.root.querySelector('[data-action="open-voice-command-settings"]')).toBeNull();
    expect(harness.root.querySelector('[data-settings-target="agent"]')).toBeNull();
    expect(harness.root.textContent).not.toContain("Pi Agent");
    expect(harness.root.textContent).not.toContain("DSH Harness");
    expect(harness.root.querySelector('[data-settings-target="summary"]')?.textContent)
      .toContain("云端生成");
    harness.view.dispose();
  });

  test("旧固件功能仍阻断，但升级 CTA 可点击且只发起 Host 系统任务", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const oldFirmwareState = {
      ...state([model("active")]),
      sourceReady: false,
      sourceIssue: "firmware_too_old" as const,
      boardFirmwareVersion: "1.49",
      minimumBoardFirmwareVersion: "1.50",
    };
    const toggle = mock(async () => undefined);
    const openSystemTask = mock(async () => undefined);
    const view = mountVoiceView(root, oldFirmwareState, {
      onToggle: toggle,
      onCommandToggle: async () => undefined,
      onDictateDraft: async () => ({ phase: "listening" as const }),
      onDictationResultConsumed: async () => undefined,
      onDictateCancel: async () => undefined,
      onOpenSystemTask: openSystemTask,
      onRefresh: async () => undefined,
      onSettingsChanged: async () => undefined,
      onFeatureSettingsChanged: async () => undefined,
      onDownloadModel: async () => undefined,
      onCancelModelDownload: async () => undefined,
      onRequestPermission: async () => undefined,
      onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
      onTimelinePaused: async () => undefined,
      onDeleteRecording: async () => undefined,
      onRetryInputTranscription: async () => undefined,
      onSendContextToAgent: async () => undefined,
      onSendCommandFollowUp: async () => "task-follow-up",
      onRegenerateDayDigest: async () => undefined,
      onSendDayDigestToAgent: async () => undefined,
      onSummarizeSegment: async () => undefined,
      onMarkCommandRead: async () => undefined,
      onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
      onReplayRetentionChanged: async () => undefined,
      onClearReplayCache: async () => undefined,
      onActionMountChanged: async () => undefined,
      onOpenKeymap: async () => undefined,
    onNavigated: () => undefined,
    });

    // R2：固件太旧是缺配置——档内提醒 + 「去升级 ›」只发起 Host 系统任务；胶囊说清原因。
    const warn = root.querySelector('.voice-warn[data-warn="firmware"]') as HTMLElement;
    expect(warn.textContent).toContain("AI Board 固件需要升级");
    expect(warn.textContent).toContain("当前 1.49");
    expect(warn.textContent).toContain("最低 1.50");
    expect(root.textContent).not.toContain("语音输入已就绪");
    expect(root.querySelector(".voice-cap")?.textContent).toContain("固件需升级");
    const go = warn.querySelector(".voice-warn-go") as HTMLButtonElement;
    expect(go.textContent).toBe("去升级 ›");
    go.click();
    await Promise.resolve();
    expect(openSystemTask).toHaveBeenCalledTimes(1);
    expect(toggle).not.toHaveBeenCalled();
    view.dispose();
  });

  test("系统麦克风中断后给的是档内提醒 + 去路，不是一颗禁用的按钮", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const unavailableSystemState = {
      ...state([model("active")]),
      settings: { ...DEFAULT_SETTINGS, source: "system" as const },
      sourceReady: false,
      sourceIssue: "source_unavailable" as const,
    };
    const view = mountVoiceView(root, unavailableSystemState, {
      onToggle: async () => undefined,
      onCommandToggle: async () => undefined,
      onDictateDraft: async () => ({ phase: "listening" as const }),
      onDictationResultConsumed: async () => undefined,
      onDictateCancel: async () => undefined,
      onOpenSystemTask: async () => undefined,
      onNavigated: () => undefined,
      onRefresh: async () => undefined,
      onSettingsChanged: async () => undefined,
      onFeatureSettingsChanged: async () => undefined,
      onDownloadModel: async () => undefined,
      onCancelModelDownload: async () => undefined,
      onRequestPermission: async () => undefined,
      onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
      onTimelinePaused: async () => undefined,
      onDeleteRecording: async () => undefined,
      onRetryInputTranscription: async () => undefined,
      onSendContextToAgent: async () => undefined,
      onSendCommandFollowUp: async () => "task-follow-up",
      onRegenerateDayDigest: async () => undefined,
      onSendDayDigestToAgent: async () => undefined,
      onSummarizeSegment: async () => undefined,
      onMarkCommandRead: async () => undefined,
      onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
      onReplayRetentionChanged: async () => undefined,
      onClearReplayCache: async () => undefined,
      onActionMountChanged: async () => undefined,
      onOpenKeymap: async () => undefined,
    });

    // R2：音源不可用是缺配置——提醒行说原因、给去路（换输入设备）；胶囊也说人话。
    const warn = root.querySelector('.voice-warn[data-warn="source"]') as HTMLElement;
    expect(warn.textContent).toContain("系统麦克风不可用");
    expect(warn.querySelector(".voice-warn-go")?.textContent).toBe("去设置 ›");
    expect(root.querySelector(".voice-cap")?.textContent).toContain("麦克风不可用");
    view.dispose();
  });

  test("语音命令区只管理触发事件，不夹带任何运行后端配置", () => {
    const harness = mount([model("active")]);
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="commands"]') as HTMLElement;
    expect(section.textContent).toContain("触发事件管理");
    expect(section.textContent).not.toContain("工作流");
    expect(section.textContent).not.toContain("Pi Agent");
    expect(harness.root.querySelector('[data-settings-target="workflow"]')).toBeNull();
    harness.view.dispose();
  });

  test("设置保存触发整页更新时保持滚动位置与当前焦点", () => {
    const harness = mount([model("active")]);
    harness.view.openSettings();
    const scroller = harness.root.querySelector(".main-body") as HTMLElement;
    scroller.scrollTop = 640;
    const retention = harness.root.querySelector(
      '[data-replay-retention="7d"]',
    ) as HTMLButtonElement;
    retention.focus();

    harness.view.update({
      ...state([model("active")]),
      replayCache: { retention: "7d", clipCount: 0, usedBytes: 0, retainedSinceMs: null },
    });

    const nextScroller = harness.root.querySelector(".main-body") as HTMLElement;
    expect(nextScroller.scrollTop).toBe(640);
    expect((document.activeElement as HTMLElement)?.textContent).toContain("7 天");
    harness.view.dispose();
  });

  test("Host 任务 intent 能按 entityId 精确打开对应 Agent 会话", () => {
    const harness = mount([model("active")], {
      commandHistory: [{
        id: "task-voice-1",
        transcript: "帮我总结今天的会议",
        reply: "这是会议总结",
        status: "completed",
        createdAt: new Date().toISOString(),
        agentSessionId: "pi-session-1",
      }],
    });
    harness.view.openConversation("task-voice-1");
    expect(harness.root.textContent).toContain("帮我总结今天的会议");
    expect(harness.root.textContent).toContain("这是会议总结");
    harness.view.dispose();
  });

  test("用户点「继续」「打开会话」打开对话页时，光标直接落在输入框；普通打开不抢焦点", () => {
    const history = {
      commandHistory: [{
        id: "task-voice-1",
        transcript: "帮我总结今天的会议",
        reply: "这是会议总结",
        status: "completed" as const,
        createdAt: new Date().toISOString(),
        agentSessionId: "pi-session-1",
      }],
    };
    const composerFocused = (root: HTMLElement) => {
      const active = document.activeElement as HTMLElement | null;
      return Boolean(
        active
          && root.contains(active)
          && (active.tagName === "TEXTAREA" || active.tagName === "INPUT"),
      );
    };

    const plain = mount([model("active")], history);
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(plain.view.openConversation("task-voice-1")).toBeTrue();
    expect(composerFocused(plain.root)).toBeFalse();
    plain.view.dispose();

    const focused = mount([model("active")], history);
    expect(focused.view.openConversation("task-voice-1", { focusComposer: true })).toBeTrue();
    expect(composerFocused(focused.root)).toBeTrue();
    focused.view.dispose();
  });

  test("已在对话页且焦点停在别的按钮上，再从「继续」打开另一条会话，光标仍落进输入框", () => {
    const at = new Date().toISOString();
    const history = {
      commandHistory: [
        { id: "task-a", transcript: "第一条", reply: "回复一", status: "completed" as const, createdAt: at, agentSessionId: "pi-a" },
        { id: "task-b", transcript: "第二条", reply: "回复二", status: "completed" as const, createdAt: at, agentSessionId: "pi-b" },
      ],
    };
    // 麦克风在新旧会话里处在同一 DOM 位置，旧焦点恢复不能盖掉 Host 要求的输入框聚焦。
    const harness = mount([model("active")], history);
    expect(harness.view.openConversation("task-a")).toBeTrue();
    const mic = harness.root.querySelector<HTMLButtonElement>(".chat-mic")!;
    mic.focus();
    expect(document.activeElement).toBe(mic);

    expect(harness.view.openConversation("task-b", { focusComposer: true })).toBeTrue();
    const active = document.activeElement as HTMLElement | null;
    expect(active?.className).toContain("chat-input");
    expect(active && harness.root.contains(active)).toBeTrue();
    harness.view.dispose();
  });

  test("润色三档保留分段按钮，新用户默认「轻度」", () => {
    const harness = mount([model("active")]);
    harness.view.openSettings();

    const section = harness.root.querySelector('[data-settings-target="polish"]') as HTMLElement;
    expect(section.querySelector(".settings-section-title")?.textContent).toBe("润色");
    const buttons = segButtons(section, "注入前的处理");
    // 设计稿画的是分段按钮，不是原生 select——控件形态本身是验收口径的一部分。
    expect(section.querySelector("select")).toBeNull();
    // 稿 V1.7.3 `VS_POLISH`：原样 / 轻度 / 规整。
    expect(buttons.map((button) => button.textContent)).toEqual(["原样", "轻度", "规整"]);
    // 2026-09-27 Voice 链路解耦定稿（取代 DEV-16「默认原样」）：出厂默认选中「轻度」，
    // 只作用于语音输入法；原样 / 规整仍是可选档位。
    expect(buttons.map((button) => button.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(section.querySelector(".settings-desc")?.textContent).toBe(
      "去口头禅、理顺语序，不动原意。",
    );
    harness.view.dispose();
  });

  test("切到轻度润色会保存档位，并说明失败时按原话注入", () => {
    const harness = mount([model("active")], { settings: { ...CLOUD_SETTINGS, polish: "raw" } });
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="polish"]') as HTMLElement;
    segButtons(section, "注入前的处理")[1]?.click();
    expect(harness.settingsPatches).toEqual([{ polish: "light" }]);

    harness.view.update({
      ...state([model("active")]),
      settings: { ...CLOUD_SETTINGS, polish: "light" },
    });
    harness.view.openSettings();
    const updated = harness.root.querySelector('[data-settings-target="polish"]') as HTMLElement;
    expect(updated.querySelector(".settings-desc")?.textContent).toBe(
      "去口头禅、理顺语序，不动原意。",
    );
    // 「失败会怎样」必须写在用户看得到的地方，不能只活在代码注释里。
    expect(updated.querySelector(".settings-note")?.textContent).toContain("按你说的原话注入");
    harness.view.dispose();
  });

  test("写回权限被拒时说明润色已暂停，而不是让用户面对一个「选了却不生效」的档位", () => {
    const harness = mount([model("active")], {
      settings: { ...CLOUD_SETTINGS, polish: "light" },
      deliveryPermissionBlocked: true,
    });
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="polish"]') as HTMLElement;
    expect(section.textContent).toContain("润色已暂停");
    expect(section.querySelector(".settings-chip.warn")?.textContent).toBe("录音前拦截");
    expect(section.textContent).toContain("新的录音会在开始前拦住");
    harness.view.dispose();
  });

  test("旧焦点失败记录保留结果，不推断焦点变化发生时间", () => {
    const harness = mount([model("active")], {
      history: [
        {
          id: "h1",
          transcript: "润色稿",
          language: "zh-CN",
          source: "board",
          inserted: false,
          durationMs: 1_000,
          createdAt: new Date().toISOString(),
          polish: "light",
          warningCode: "focus_changed_after_polish",
        },
      ],
    });
    (harness.root.querySelector(".task-item") as HTMLButtonElement).click();
    expect(harness.root.querySelector(".inline-warning")?.textContent).toContain(
      "未能写入录音对应的输入位置",
    );
    harness.view.dispose();
  });

  test("原样注入档不谈失败回退（那一档根本不发请求）", () => {
    const harness = mount([model("active")], { settings: { ...CLOUD_SETTINGS, polish: "raw" } });
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="polish"]') as HTMLElement;
    expect(section.querySelector(".settings-note")).toBeNull();
    harness.view.dispose();
  });

  test("默认设置不展示开发者级润色上下文", () => {
    const harness = mount([model("active")], { settings: CLOUD_SETTINGS });
    harness.view.openSettings();
    expect(harness.root.querySelector('[data-settings-target="polish-context"]')).toBeNull();
    expect(harness.root.textContent).not.toContain("带上当前窗口上下文");
    expect(harness.root.textContent).not.toContain("带上近期语音上下文");
    harness.view.dispose();
  });

  test("A3-24 / R7「发给 agent」在段详情总结栏脚部：装了 Agents·IM 才渲染，列表行内不再有", () => {
    const harness = mount([model("active")], {
      recordings: [recording(), recording({ id: "rec-2", transcriptText: "" })],
      recordingsTotal: 2,
      agentsImAvailable: true,
    });
    const contextTab = harness.root.querySelector(
      '[data-voice-tab="context"]',
    ) as HTMLButtonElement;
    contextTab.click();
    // 位置对稿（R7）：按钮住在段详情总结栏脚部，列表行内与页头都不再出现。
    expect(
      harness.root.querySelectorAll('.ctx-seg [data-action="send-context-to-agent"]'),
    ).toHaveLength(0);

    const copies = harness.root.querySelectorAll<HTMLButtonElement>(".recording-copy");
    copies[0]?.click();
    expect(harness.root.querySelector(".ctx-view .detail-header [data-action='send-context-to-agent']")).toBeNull();
    const send = harness.root.querySelector<HTMLButtonElement>(
      ".ctx-view .ctx-sum-ft [data-action='send-context-to-agent']",
    );
    expect(send).toBeInstanceOf(HTMLButtonElement);
    expect(send?.textContent).toBe("发给 agent");
    expect(send?.disabled).toBeFalse();
    send?.click();
    expect(harness.contextSends).toEqual(["rec-1"]);
    harness.view.dispose();
  });

  test("A3-24 门控：没装不渲染 / 还没探到不渲染 / 空转录不进记录列表", () => {
    // 没装（false）：跨扩展入口在对方没装时就该不存在，而不是灰着让人点（稿 :3408）。
    const notInstalled = mount([model("active")], {
      recordings: [recording()],
      recordingsTotal: 1,
      agentsImAvailable: false,
    });
    (notInstalled.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    (notInstalled.root.querySelector(".recording-copy") as HTMLButtonElement).click();
    expect(
      notInstalled.root.querySelector('[data-action="send-context-to-agent"]'),
    ).toBeNull();
    notInstalled.view.dispose();

    // 还没探到（undefined）：Host 采样没回来之前同样不渲染，不画假门。
    const unknown = mount([model("active")], {
      recordings: [recording()],
      recordingsTotal: 1,
    });
    (unknown.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    (unknown.root.querySelector(".recording-copy") as HTMLButtonElement).click();
    expect(unknown.root.querySelector('[data-action="send-context-to-agent"]')).toBeNull();
    unknown.view.dispose();

    // 空内容不再生成一条可见记录，更不会给出一个无意义的禁用发送按钮。
    const noTranscript = mount([model("active")], {
      recordings: [recording({ transcriptText: "" })],
      recordingsTotal: 1,
      agentsImAvailable: true,
    });
    (noTranscript.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    expect(noTranscript.root.querySelector(".recording-copy")).toBeNull();
    expect(noTranscript.root.querySelector('[data-action="send-context-to-agent"]')).toBeNull();
    noTranscript.view.dispose();
  });

  test("A3-24 去路与命令运行时解耦：语音命令进行中按钮仍可用", () => {
    // 新去路是 IM 附件引用（apps.open intent），不是一次云端问答——命令工作流
    // 的并发保护（commandPhase 锁）不再管辖这个入口。
    const harness = mount([model("active")], {
      recordings: [recording()],
      recordingsTotal: 1,
      agentsImAvailable: true,
      commandPhase: "processing",
    });
    (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    (harness.root.querySelector(".recording-copy") as HTMLButtonElement).click();
    const button = harness.root.querySelector<HTMLButtonElement>(
      '[data-action="send-context-to-agent"]',
    );
    expect(button?.disabled).toBeFalse();
    harness.view.dispose();
  });

  test("详情页把「注入前处理」的四种情况分开说", () => {
    const base = {
      id: "h1",
      language: "zh-CN",
      source: "board" as const,
      inserted: true,
      durationMs: 1_000,
      createdAt: new Date().toISOString(),
    };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ polish: "raw" }, "原样注入"],
      [{ polish: "light", warningCode: "polish_failed" }, "轻度润色未完成 · 原样注入"],
      [{ polish: "light", originalTranscript: "嗯那个" }, "轻度润色 · 已改写"],
      [{ polish: "formal" }, "规整润色 · 无需修改"],
      // 最常见的组合：润色超时 → 用户等不及切走窗口 → 写回也失败。
      // 写回的原因占掉了 warningCode，润色失败只剩自己那个标记还记着——
      // 只认 warningCode 的话这条会被说成「无需修改」。
      [
        { polish: "light", polishFailed: true, warningCode: "focus_changed_after_polish" },
        "轻度润色未完成 · 原样注入",
      ],
    ];
    for (const [extra, expected] of cases) {
      const harness = mount([model("active")], {
        history: [{ ...base, transcript: "整理后的文本", ...extra } as never],
      });
      (harness.root.querySelector(".task-item") as HTMLButtonElement).click();
      expect(
        (harness.root.querySelector(".input-detail-meta[data-polish-summary]") as HTMLElement | null)?.dataset
          .polishSummary,
      ).toBe(expected);
      harness.view.dispose();
    }
  });

  test("详情页按历史快照区分云端、本地与旧记录，不读取当前设置反推", () => {
    const cases: Array<{
      recognitionEngine?: "local" | "cloud";
      currentEngine: "local" | "cloud";
      expectedValue: string;
      expectedNote: string;
      expectedClass: string;
    }> = [
      {
        recognitionEngine: "cloud",
        currentEngine: "local",
        expectedValue: "云端识别",
        expectedNote: "此条音频已发送到云端完成转写",
        expectedClass: "cloud",
      },
      {
        recognitionEngine: "local",
        currentEngine: "cloud",
        expectedValue: "本地识别",
        expectedNote: "此条音频仅在这台电脑上完成转写",
        expectedClass: "local",
      },
      {
        currentEngine: "cloud",
        expectedValue: "未记录",
        expectedNote: "旧记录没有保存识别方式",
        expectedClass: "unknown",
      },
    ];

    for (const entry of cases) {
      const history = {
        id: "engine-history",
        transcript: "一段输入",
        language: "zh-CN",
        source: "board" as const,
        inserted: true,
        durationMs: 800,
        createdAt: new Date().toISOString(),
        recognitionEngine: entry.recognitionEngine,
      };
      const harness = mount([model("active")], {
        settings: { ...createDefaultVoiceViewState().settings, engine: entry.currentEngine },
        history: [history as VoiceHistoryItem],
      });
      (harness.root.querySelector(".task-item") as HTMLButtonElement).click();
      const card = harness.root.querySelector(".detail-engine");
      expect(card?.classList.contains(entry.expectedClass)).toBeTrue();
      expect(card?.querySelector(".detail-engine-value")?.textContent).toBe(entry.expectedValue);
      expect(card?.querySelector(".detail-engine-note")?.textContent).toBe(entry.expectedNote);
      expect(card?.textContent).not.toContain("SenseVoice");
      harness.view.dispose();
    }
  });

  test("润色改过原文时详情页给出前后对照；没改过就不画对照", () => {
    const base = {
      id: "h1",
      transcript: "我认为应该先完成界面。",
      language: "zh-CN",
      source: "board" as const,
      inserted: true,
      durationMs: 1_000,
      createdAt: new Date().toISOString(),
      polish: "light" as const,
    };
    const changed = mount([model("active")], {
      history: [{ ...base, originalTranscript: "嗯我觉得就是说先把界面做出来" }],
    });
    (changed.root.querySelector(".task-item") as HTMLButtonElement).click();
    expect(changed.root.querySelector(".detail-original-transcript")?.textContent).toBe(
      "嗯我觉得就是说先把界面做出来",
    );
    changed.view.dispose();

    const unchanged = mount([model("active")], { history: [base] });
    (unchanged.root.querySelector(".task-item") as HTMLButtonElement).click();
    // 两边一模一样的对照是在假装做了工作。
    expect(unchanged.root.querySelector(".detail-polish-compare")).toBeNull();
    unchanged.view.dispose();
  });

  test("润色失败的历史条目给的是「已按原话写入」，不是笼统的写入失败", () => {
    const harness = mount([model("active")], {
      history: [
        {
          id: "h1",
          transcript: "原话",
          language: "zh-CN",
          source: "board",
          inserted: true,
          durationMs: 1_000,
          createdAt: new Date().toISOString(),
          polish: "light",
          warningCode: "polish_failed",
        },
      ],
    });
    (harness.root.querySelector(".task-item") as HTMLButtonElement).click();
    expect(harness.root.querySelector(".inline-warning")?.textContent).toBe(
      "润色没有完成，已按你说的原话写入；这一条不是润色稿。",
    );
    harness.view.dispose();
  });

  test("B5-14：设置入口由 Host 调用；页内返回钮已撤（返回走 Host 面包屑）", () => {
    const harness = mount([model("active")]);
    expect(harness.root.querySelector('[aria-label="Voice 设置"]')).toBeNull();
    harness.view.openSettings();
    expect(harness.root.querySelector('[aria-label="返回 Voice"]')).toBeNull();
    expect(harness.root.querySelector(".voice-settings-back")).toBeNull();
    harness.view.dispose();
  });
});

/* ═══ A3-10 当日总结卡（结构/文案逐字对稿 design/VoiceType_UI_Designs.html 的
   ctxDigestHTML / syncCtxBar；合成行为是真实 AI 请求，链路在 voice-digest.test.ts） ═══ */

describe("R18 按天分组与当日总结行", () => {
  /** 「今天」的段：todayMs 保证跨午夜运行时也仍归今天。 */
  function todayRecording(
    minutesAgo: number,
    overrides: Partial<VoiceRecordingSegment> = {},
  ): VoiceRecordingSegment {
    return recording({
      id: `rec-today-${minutesAgo}`,
      wallStartMs: todayMs(minutesAgo),
      transcriptText: "今天的一段话",
      ...overrides,
    });
  }

  function openContextTab(root: HTMLElement) {
    (root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
  }

  function digest(dayKey: string, overrides: Partial<VoiceDayDigest> = {}): VoiceDayDigest {
    return {
      dayKey,
      points: ["固件和 App 一起发", "yolo 开关默认 false"],
      segs: 2,
      chars: 1234,
      fromMs: Date.now() - 120 * 60_000,
      toMs: Date.now() - 10 * 60_000,
      createdAt: new Date().toISOString(),
      final: false,
      sourceKey: "",
      ...overrides,
    };
  }

  /** 以「今天 N 点」为锚的本地时间（午夜附近的用例要能跨到昨天）。 */
  function atLocal(dayOffset: number, hour: number, minute = 0): number {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  }

  test("Context 档：最新的一天在上，每天一个吸顶标题「今天 · N 段 · X 字 / 昨天」；段归属按开始时间", () => {
    const harness = mount([model("active")], {
      recordings: [
        recording({ id: "t1", wallStartMs: atLocal(0, 1, 10), transcriptText: "一二三" }),
        // 23:40 开始、跨到今天 00:25 结束：归昨天（R18 归属按开始时间）。
        recording({ id: "y1", wallStartMs: atLocal(-1, 23, 40), durationMs: 45 * 60_000, transcriptText: "四五六七" }),
        recording({ id: "y2", wallStartMs: atLocal(-1, 10, 30), transcriptText: null }),
      ],
      recordingsTotal: 3,
    });
    openContextTab(harness.root);
    // R4：控制条 / 技术诊断 / 隐私说明 / 「持久录音 N 段」全部不在。
    expect(harness.root.querySelector(".context-bar")).toBeNull();
    expect(harness.root.textContent).not.toContain("暂停");
    expect(harness.root.textContent).not.toContain("立即清空缓存");
    expect(harness.root.textContent).not.toContain("持久录音");
    expect(harness.root.textContent).not.toContain("合成一份总结");
    expect(harness.root.textContent).not.toContain("Host 丢帧");

    const heads = Array.from(harness.root.querySelectorAll<HTMLElement>(".day-hd"));
    expect(heads.map((head) => head.textContent)).toEqual([
      "今天· 1 段 · 3 字",
      "昨天· 1 段 · 4 字",
    ]);
    // 段行是轻行：时段 + 首句 + 右侧时长 / 字数；没有播放 / 删除按钮。
    const rows = Array.from(harness.root.querySelectorAll<HTMLElement>(".ctx-seg"));
    expect(rows).toHaveLength(2);
    expect(rows[1]?.querySelector(".ctx-seg-t")?.textContent).toBe("23:40 – 00:25");
    expect(rows[1]?.querySelector(".ctx-seg-p")?.textContent).toBe("四五六七");
    expect(rows[1]?.querySelector(".ctx-seg-m")?.textContent).toBe("45 分钟4 字");
    expect(rows[0]?.querySelector("button")).toBeNull();
    expect(harness.root.textContent).not.toContain("播放");
    expect(harness.root.textContent).not.toContain("删除");
    // 昨天的组排在今天之后：DOM 顺序 = 今天标题 → 今天的段 → 昨天标题 → 昨天的段。
    expect(heads[1]!.compareDocumentPosition(rows[0]!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    harness.view.dispose();
  });

  test("Context 档空态：没有现场记录时只有一句话，没有任何控件", () => {
    const harness = mount([model("active")], { recordings: [], recordingsTotal: 0 });
    openContextTab(harness.root);
    expect(harness.root.querySelector(".ctx-empty")?.textContent)
      .toBe("还没有现场记录。键盘在听的时候，说过的话会自动收在这里。");
    expect(harness.root.querySelector(".day-hd")).toBeNull();
    expect(harness.root.querySelector(".task-list button")).toBeNull();
    harness.view.dispose();
  });

  test("当日总结是分组里普通的一行：排在该天最新的位置、默认收起、点开展开要点与脚部动作", () => {
    const todayKey = dayKeyOf(new Date());
    const from = new Date();
    from.setHours(9, 48, 0, 0);
    const to = new Date();
    to.setHours(14, 41, 0, 0);
    const harness = mount([model("active")], {
      recordings: [todayRecording(30)],
      recordingsTotal: 1,
      dayDigests: { [todayKey]: digest(todayKey, { fromMs: from.getTime(), toMs: to.getTime() }) },
      agentsImAvailable: true,
    });
    openContextTab(harness.root);

    const box = harness.root.querySelector(".ctx-dg") as HTMLElement;
    expect(box).toBeInstanceOf(HTMLElement);
    // 排在标题正下方、段行之前（这一天最新的一条），不置顶整页。
    const head = harness.root.querySelector(".day-hd") as HTMLElement;
    const seg = harness.root.querySelector(".ctx-seg") as HTMLElement;
    expect(head.nextElementSibling).toBe(box);
    expect(box.nextElementSibling).toBe(seg);
    expect(box.classList.contains("open")).toBeFalse();

    const row = box.querySelector(".ctx-dg-row") as HTMLButtonElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector(".ctx-seg-t")?.textContent).toBe("截至 14:41 的总结");
    expect(row.querySelector(".ctx-seg-p")?.textContent)
      .toBe("AI 写的，不是原话 · 由 2 段合成 · 09:48–14:41 · 1,234 个原始字符（含标点） · 2 条要点");
    // 收着的时候要点不可见（display:none 由 CSS 管，这里验 DOM 与 aria）。
    expect(harness.root.querySelector(".ctx-dg.open")).toBeNull();

    row.click();
    const opened = harness.root.querySelector(".ctx-dg") as HTMLElement;
    expect(opened.classList.contains("open")).toBeTrue();
    expect(opened.querySelector(".ctx-dg-row")?.getAttribute("aria-expanded")).toBe("true");
    expect(
      Array.from(opened.querySelectorAll(".ctx-sum-i")).map((node) => node.textContent),
    ).toEqual(["固件和 App 一起发", "yolo 开关默认 false"]);
    // 脚部：重新总结 + 发给 agent；没有删除叉（自动生成的产物，删了也会再长出来）。
    const regen = opened.querySelector<HTMLButtonElement>('[data-action="regenerate-day-digest"]');
    expect(regen?.textContent).toBe("重新总结");
    regen?.click();
    expect(harness.digestCalls.regenerate).toEqual([todayKey]);
    const send = opened.querySelector<HTMLButtonElement>('[data-action="send-day-digest-to-agent"]');
    expect(send?.textContent).toBe("发给 agent");
    send?.click();
    expect(harness.digestCalls.send).toEqual([todayKey]);
    expect(opened.querySelector('[data-action="delete-day-digest"]')).toBeNull();

    // 同一次停留里 state 刷新不把它合上（段列表 5 秒一拍）；再点一次才收起。
    harness.view.update({
      ...createDefaultVoiceViewState({
        models: [model("active")],
        recordings: [todayRecording(30)],
        recordingsTotal: 1,
        dayDigests: { [todayKey]: digest(todayKey, { fromMs: from.getTime(), toMs: to.getTime() }) },
        agentsImAvailable: true,
      }),
    });
    expect(harness.root.querySelector(".ctx-dg.open")).not.toBeNull();
    (harness.root.querySelector(".ctx-dg-row") as HTMLButtonElement).click();
    expect(harness.root.querySelector(".ctx-dg.open")).toBeNull();
    harness.view.dispose();
  });

  test("展开态不记住：切档 / 离开列表再回来都是收着", () => {
    const todayKey = dayKeyOf(new Date());
    const harness = mount([model("active")], {
      recordings: [todayRecording(30)],
      recordingsTotal: 1,
      dayDigests: { [todayKey]: digest(todayKey) },
    });
    openContextTab(harness.root);
    (harness.root.querySelector(".ctx-dg-row") as HTMLButtonElement).click();
    expect(harness.root.querySelector(".ctx-dg.open")).not.toBeNull();
    (harness.root.querySelector('[data-voice-tab="all"]') as HTMLButtonElement).click();
    openContextTab(harness.root);
    expect(harness.root.querySelector(".ctx-dg.open")).toBeNull();

    (harness.root.querySelector(".ctx-dg-row") as HTMLButtonElement).click();
    harness.view.openSettings();
    harness.view.navigateRoot();
    expect(harness.root.querySelector(".ctx-dg.open")).toBeNull();
    harness.view.dispose();
  });

  test("过了午夜定稿：昨天的总结标题是「M 月 D 日的总结」；总结进行中「重新总结」禁用", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = dayKeyOf(yesterday);
    const harness = mount([model("active")], {
      recordings: [
        recording({ id: "y1", wallStartMs: atLocal(-1, 16, 5), transcriptText: "昨天的话" }),
      ],
      recordingsTotal: 1,
      dayDigests: { [yesterdayKey]: digest(yesterdayKey, { final: true }) },
      dayDigestGenerating: yesterdayKey,
    });
    openContextTab(harness.root);
    expect(harness.root.querySelector(".ctx-dg .ctx-seg-t")?.textContent)
      .toBe(`${yesterday.getMonth() + 1} 月 ${yesterday.getDate()} 日的总结`);
    (harness.root.querySelector(".ctx-dg-row") as HTMLButtonElement).click();
    const regen = harness.root.querySelector<HTMLButtonElement>('[data-action="regenerate-day-digest"]');
    expect(regen?.textContent).toBe("总结中…");
    expect(regen?.disabled).toBeTrue();
    // 没装 Agents·IM：脚部没有「发给 agent」（不画灰门）。
    expect(harness.root.querySelector('[data-action="send-day-digest-to-agent"]')).toBeNull();
    harness.view.dispose();
  });

  test("总结溯源的段一条不剩就不画那一行；All 档不放总结行", () => {
    const todayKey = dayKeyOf(new Date());
    const onlyUntranscribed = mount([model("active")], {
      recordings: [todayRecording(5, { transcriptText: null })],
      recordingsTotal: 1,
      dayDigests: { [todayKey]: digest(todayKey) },
    });
    openContextTab(onlyUntranscribed.root);
    expect(onlyUntranscribed.root.querySelector(".ctx-dg")).toBeNull();
    onlyUntranscribed.view.dispose();

    const all = mount([model("active")], {
      recordings: [todayRecording(30)],
      recordingsTotal: 1,
      dayDigests: { [todayKey]: digest(todayKey) },
    });
    expect(all.root.querySelector(".ctx-dg")).toBeNull();
    all.view.dispose();
  });

  test("动作失败在列表页原地可见，不再是「点了一下没反应」", () => {
    const harness = mount([model("active")], {
      recordings: [todayRecording(30)],
      recordingsTotal: 1,
      error: "还没有在「已安装扩展 → 语音输入法 → 权限」里开启云端 AI 权限，无法合成总结",
    });
    openContextTab(harness.root);
    const error = harness.root.querySelector(".voice-list-view .inline-error");
    expect(error?.textContent).toContain("云端 AI 权限");
    harness.view.dispose();
  });
});

describe("存档对稿（A3-9 / A3-11 / A3-12 / R9）", () => {
  const css = readFileSync(resolve(import.meta.dir, "../src/voice.css"), "utf8");
  const appSource = readFileSync(resolve(import.meta.dir, "../src/app.ts"), "utf8");

  function timelineState(state: AudioTimelineStatus["state"]): AudioTimelineStatus {
    return {
      state,
      route: "usb_vendor_hid",
      hotRingDurationMs: 2_000,
      cacheDurationMs: 30_000,
      cacheHealth: "healthy",
      continuousRecordingEnabled: true,
      recordingState: "running",
      sttBacklog: 0,
      hostLocalDropFrames: 0,
    };
  }

  function historyItem(overrides: Partial<VoiceHistoryItem> = {}): VoiceHistoryItem {
    return {
      id: "input-1",
      transcript: "一段输入",
      language: "zh-CN",
      source: "board",
      inserted: true,
      durationMs: 4_000,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      ...overrides,
    };
  }

  function commandItem(overrides: Partial<VoiceCommandHistoryItem> = {}): VoiceCommandHistoryItem {
    return {
      id: "cmd-1",
      transcript: "一条命令",
      status: "completed",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      reply: "命令的回复",
      ...overrides,
    };
  }

  function openTab(root: HTMLElement, tab: string) {
    (root.querySelector(`[data-voice-tab="${tab}"]`) as HTMLButtonElement).click();
  }

  test("A3-9 / R14：在听的动效只随在听出现——胶囊里三根跳动条，时间线停了就没有", () => {
    const running = mount([model("active")], { timeline: timelineState("running") });
    const cap = running.root.querySelector(".voice-cap") as HTMLElement;
    expect(cap.querySelectorAll(".sb-listen .sb-listen-bar")).toHaveLength(3);
    expect(cap.textContent).toContain("在听");
    running.view.dispose();

    const paused = mount([model("active")], { timeline: timelineState("paused_by_user") });
    expect(paused.root.querySelector(".sb-listen")).toBeNull();
    expect(paused.root.querySelector(".voice-cap")?.textContent).toContain("已暂停");
    paused.view.dispose();
  });

  test("H02:C04：在听段点击暂停全天时间线；已暂停段点击恢复", () => {
    const running = mount([model("active")], { timeline: timelineState("running") });
    const pauseBtn = running.root.querySelector('[data-cap-seg="ctx"]') as HTMLButtonElement;
    expect(pauseBtn.tagName).toBe("BUTTON");
    expect(pauseBtn.getAttribute("aria-label")).toBe("暂停全天记录");
    expect(pauseBtn.title).toBe("暂停全天记录");
    pauseBtn.click();
    expect(running.timelinePauseCalls).toEqual([true]);
    running.view.dispose();

    const paused = mount([model("active")], { timeline: timelineState("paused_by_user") });
    const resumeBtn = paused.root.querySelector('[data-cap-seg="ctx"]') as HTMLButtonElement;
    expect(resumeBtn.tagName).toBe("BUTTON");
    expect(resumeBtn.getAttribute("aria-label")).toBe("继续全天记录");
    expect(paused.root.querySelector(".sb-listen")).toBeNull();
    resumeBtn.click();
    expect(paused.timelinePauseCalls).toEqual([false]);
    paused.view.dispose();
  });

  test("A3-9：动效有 prefers-reduced-motion 降级（动画关掉、指示元素保留）", () => {
    // 稿 .sb-listen / lsnBar 同名同值的动画。
    expect(css).toContain("@keyframes lsnBar");
    expect(css).toContain("animation: lsnBar 1s ease-in-out infinite");
    // 降级（VoiceInputOverlay 红点呼吸的同一条先例）：关的是动画，不是指示本身。
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".sb-listen .sb-listen-bar");
    expect(reduced).toContain("animation: none");
    // 音频设置归位后，暂停只由 Voice 的“后台听音”开关接入；运行期清空仍不另设同义入口。
    expect(appSource).toContain("setTimelinePaused");
    expect(appSource).not.toContain("clearTimelineCache");
  });

  test("A3-9：收听期间段列表跟着长——状态轮询里定期刷段列表，并顺手跑一轮总结调度", () => {
    expect(appSource).toContain("recordingsPollAt");
    expect(appSource).toMatch(/voiceRecordings\s*\n?\s*\.list\(\{ page: 0, perPage: 50 \}\)/);
    expect(appSource).toContain("publish({ recordings: recordings.items, recordingsTotal: recordings.total });");
    expect(appSource).toContain("scheduleDigestCheck();");
  });

  test("A3-11 / R9：All 档入口条是单行虚线框，「N 段」加粗，文案逐字对稿；点击进 Context 档", () => {
    const harness = mount([model("active")], {
      recordings: [
        recording({
          wallStartMs: todayMs(40),
          transcriptText: "一二三四五六七八",
        }),
        recording({
          id: "rec-today-2",
          wallStartMs: todayMs(10),
          transcriptText: "九十一",
        }),
      ],
      recordingsTotal: 2,
      timeline: timelineState("running"),
    });
    const entry = harness.root.querySelector(".ctx-entry") as HTMLButtonElement;
    expect(entry.textContent).toBe(
      "今天还有 2 段现场记录（11 字），单独放在 Context 档。",
    );
    expect(entry.textContent).toContain("2 段");
    expect(entry.querySelector(".ctx-entry-icon svg")).not.toBeNull();
    expect(css).toMatch(/\.ctx-entry\s*\{[^}]*border:\s*1px dashed/s);
    entry.click();
    expect(harness.root.querySelector(".ctx-timeline")).not.toBeNull();
    expect(harness.root.querySelector('[data-voice-tab="context"]')?.classList.contains("active")).toBeTrue();
    harness.view.dispose();
  });

  test("A3-11：今天一段都没有（只剩昨天的 / 等待转录的）时入口条整条不渲染", () => {
    const harness = mount([model("active")], {
      recordings: [
        recording({
          wallStartMs: Date.now() - 26 * 60 * 60_000,
          transcriptText: "昨天的话",
        }),
        recording({
          wallStartMs: todayMs(5),
          transcriptText: null,
        }),
      ],
      recordingsTotal: 2,
      timeline: timelineState("running"),
    });
    expect(harness.root.querySelector(".ctx-entry")).toBeNull();
    harness.view.dispose();
  });

  test("A3-12 / R18：All 档 command 与 input 同列混排、按天分组、新到旧", () => {
    const now = Date.now();
    const harness = mount([model("active")], {
      history: [
        historyItem({
          id: "in-old",
          transcript: "较早的输入",
          createdAt: new Date(now - 26 * 60 * 60_000).toISOString(),
        }),
        historyItem({
          id: "in-new",
          transcript: "最新的输入",
          createdAt: new Date(todayMs(5)).toISOString(),
        }),
      ],
      commandHistory: [
        commandItem({
          id: "cmd-mid",
          transcript: "中间的命令",
          createdAt: new Date(todayMs(20)).toISOString(),
        }),
      ],
    });
    const rows = Array.from(harness.root.querySelectorAll(".task-list .task-item"));
    expect(rows.map((row) => row.querySelector(".task-name")?.textContent)).toEqual([
      "“最新的输入”",
      "“中间的命令”",
      "“较早的输入”",
    ]);
    // 行形态沿用两档各自的 task-item：命令行带 command-history-item，输入行不带。
    expect(rows[1]?.classList.contains("command-history-item")).toBeTrue();
    expect(rows[0]?.classList.contains("command-history-item")).toBeFalse();
    // 按天分组：今天 2 条、昨天 1 条（26 小时前的那条可能落在前天——按本地日算）。
    const heads = Array.from(harness.root.querySelectorAll<HTMLElement>(".task-list .day-hd"));
    expect(heads).toHaveLength(2);
    expect(heads[0]?.textContent).toBe("今天· 2 条");
    expect(heads[1]?.textContent).toMatch(/^(昨天|\d+ 月 \d+ 日 周.)· 1 条$/u);
    // All 档没有总结行。
    expect(harness.root.querySelector(".ctx-dg")).toBeNull();
    harness.view.dispose();
  });

  test("R3 / R9：行头像是 emoji、副行「Voice input · N chars」、类型徽章回 command、未读点", () => {
    const now = Date.now();
    const harness = mount([model("active")], {
      history: [historyItem({ transcript: "下周的设计评审会议改到周四下午三点" })],
      commandHistory: [
        commandItem({ id: "cmd-unread", unread: true, createdAt: new Date(now).toISOString() }),
        commandItem({
          id: "cmd-failed",
          status: "failed",
          reply: undefined,
          userMessage: "没听清",
          createdAt: new Date(now - 1_000).toISOString(),
        }),
      ],
    });
    const input = harness.root.querySelector(".task-item:not(.command-history-item)") as HTMLElement;
    expect(input.querySelector(".task-ava")?.textContent).toBe("🎙️");
    expect(input.querySelector(".task-preview")?.textContent).toBe("语音输入 · 17 字");
    expect(input.querySelector(".task-type")?.textContent).toBe("听写");
    expect(input.querySelector(".task-dot")).toBeNull();

    const commands = Array.from(harness.root.querySelectorAll<HTMLElement>(".command-history-item"));
    expect(commands[0]?.querySelector(".task-ava")?.textContent).toBe("✨");
    expect(commands[0]?.querySelector(".task-type")?.textContent).toBe("命令");
    expect(commands[0]?.querySelector(".task-dot")).not.toBeNull();
    expect(commands[1]?.querySelector(".task-ava")?.textContent).toBe("⚠️");
    expect(commands[1]?.querySelector(".task-type")?.textContent).toBe("命令");
    expect(commands[1]?.querySelector(".task-dot")).toBeNull();
    // 圆钮居中规范（R3）：line-height:1 + text-indent:.25em；徽章 56px 定宽不缩、时间不折行。
    expect(css).toMatch(/\.task-ava,\s*\.detail-avatar\s*\{[^}]*line-height:\s*1;[^}]*text-indent:\s*\.25em/s);
    expect(css).toMatch(/\.task-type\s*\{[^}]*min-width:\s*56px;[^}]*flex-shrink:\s*0/s);
    expect(css).toMatch(/\.task-time\s*\{[^}]*white-space:\s*nowrap/s);
    harness.view.dispose();
  });

  test("V1.8.7：成功条目按内容类型显示明确复制动作，点击不打开详情", () => {
    const now = Date.now();
    const harness = mount([model("active")], {
      history: [historyItem({ transcript: "听写正文" })],
      commandHistory: [
        commandItem({
          id: "command",
          createdAt: new Date(now - 1).toISOString(),
          transcript: "普通问题",
          reply: "普通答案",
          messages: [
            { from: "user", text: "普通问题", at: new Date().toISOString() },
            { from: "ai", text: "普通答案", at: new Date().toISOString() },
          ],
        }),
        commandItem({
          id: "translation",
          createdAt: new Date(now).toISOString(),
          // 历史里真实落的是内置命令 ID，不是 Host 事件 ID com.reai.voice.command.translate。
          commandId: BUILTIN_VOICE_COMMANDS.translate,
          transcript: "翻译原文",
          reply: "Translated text",
        }),
      ],
    });

    const input = harness.root.querySelector(".task-item:not(.command-history-item)") as HTMLElement;
    expect(input.querySelector(".task-copy")?.textContent).toBe("复制文本");
    (input.querySelector(".task-copy") as HTMLButtonElement).click();
    expect(harness.copiedTexts).toEqual(["听写正文"]);
    expect(harness.root.querySelector(".input-detail")).toBeNull();

    const commands = Array.from(harness.root.querySelectorAll<HTMLElement>(".command-history-item"));
    // 翻译更新，实际排在前面；复制动作按业务条目验证，不依赖 fixture 数组顺序。
    const command = commands.find((row) => row.querySelector(".task-name")?.textContent === "“普通问题”");
    const translation = commands.find((row) => row.querySelector(".task-name")?.textContent === "“翻译原文”");
    expect(command).toBeDefined();
    expect(translation).toBeDefined();
    expect(Array.from(command?.querySelectorAll(".task-copy") ?? []).map((node) => node.textContent)).toEqual([
      "复制问题",
      "复制答案",
    ]);
    expect(Array.from(translation?.querySelectorAll(".task-copy") ?? []).map((node) => node.textContent)).toEqual([
      "复制原文",
      "复制译文",
    ]);
    (command?.querySelectorAll(".task-copy")[1] as HTMLButtonElement).click();
    expect(harness.copiedTexts).toEqual(["听写正文", "普通答案"]);
    expect(harness.root.querySelector(".chat-view")).toBeNull();
    harness.view.dispose();
  });

  test("翻译条目复制按钮是「原文 / 译文」，Agent 条目仍是「问题 / 答案」，中英文一致", () => {
    // 两条都按运行时真实落历史的内置命令 ID 构造（见 app.ts 的 settleCommandHistory）。
    const harness = mount([model("active")], {
      commandHistory: [
        commandItem({
          id: "agent",
          commandId: BUILTIN_VOICE_COMMANDS.agent,
          transcript: "明天天气怎么样",
          reply: "明天晴",
        }),
        commandItem({
          id: "translation",
          commandId: BUILTIN_VOICE_COMMANDS.translate,
          translationTarget: "en-US",
          transcript: "你好世界",
          reply: "Hello world",
          messages: [
            { from: "user", text: "你好世界", at: new Date().toISOString() },
            { from: "ai", text: "Hello world", at: new Date().toISOString() },
          ],
        }),
      ],
    });
    const rowOf = (transcript: string) => Array.from(harness.root.querySelectorAll<HTMLElement>(".command-history-item"))
      .find((row) => row.querySelector(".task-name")?.textContent === `“${transcript}”`);
    const labels = (transcript: string) => Array.from(rowOf(transcript)?.querySelectorAll(".task-copy") ?? [])
      .map((node) => node.textContent);
    try {
      expect(labels("你好世界")).toEqual(["复制原文", "复制译文"]);
      expect(labels("明天天气怎么样")).toEqual(["复制问题", "复制答案"]);

      const [original, translation] = Array.from(rowOf("你好世界")?.querySelectorAll<HTMLButtonElement>(".task-copy") ?? []);
      original?.click();
      translation?.click();
      expect(harness.copiedTexts).toEqual(["你好世界", "Hello world"]);
      expect(harness.root.querySelector(".chat-view")).toBeNull();

      setVoiceLocale("en");
      expect(labels("你好世界")).toEqual(["Copy original", "Copy translation"]);
      expect(labels("明天天气怎么样")).toEqual(["Copy question", "Copy answer"]);
    } finally {
      setVoiceLocale("zh");
      harness.view.dispose();
    }
  });

  for (const key of ["Enter", " "]) {
    for (const kind of ["input", "command"] as const) {
      test(`V1.8.7：${kind} 复制按钮的 ${JSON.stringify(key)} 不被列表行拦截，行自身仍可打开`, () => {
        const harness = mount([model("active")], {
          history: [historyItem({ transcript: "听写正文" })],
          commandHistory: [commandItem({ transcript: "普通问题", reply: "普通答案" })],
        });
        const selector = kind === "input"
          ? ".task-item:not(.command-history-item)"
          : ".command-history-item";
        const row = harness.root.querySelector(selector) as HTMLElement;
        const button = row.querySelector(".task-copy") as HTMLButtonElement;
        button.focus();
        const buttonKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        button.dispatchEvent(buttonKey);
        expect(buttonKey.defaultPrevented).toBeFalse();
        expect(harness.root.querySelector(selector)).toBe(row);
        // Happy DOM 不合成浏览器原生键盘 click；验证未取消默认动作后模拟该 click。
        button.click();
        expect(harness.copiedTexts).toEqual([kind === "input" ? "听写正文" : "普通问题"]);
        expect(harness.root.querySelector(selector)).toBe(row);

        row.focus();
        const rowKey = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        row.dispatchEvent(rowKey);
        expect(rowKey.defaultPrevented).toBeTrue();
        expect(harness.root.querySelector(selector)).toBeNull();
        harness.view.dispose();
      });
    }
  }

  test("V1.8.7：转写失败条目灰化并显示感叹号徽标，且完全不渲染复制入口", () => {
    const harness = mount([model("active")], {
      history: [historyItem({ transcript: "", transcriptionStatus: "failed" })],
    });
    const row = harness.root.querySelector(".task-item:not(.command-history-item)") as HTMLElement;
    expect(row.classList.contains("is-failed")).toBeTrue();
    expect(row.querySelector(".task-ava-fail")?.textContent).toBe("!");
    expect(row.querySelector(".task-copy")).toBeNull();
    expect(css).toMatch(/\.task-item\.is-failed \.task-ava-mic,\s*\.task-item\.is-failed \.task-name\s*\{[^}]*filter:\s*grayscale\(1\);[^}]*opacity:\s*\.48/s);
    harness.view.dispose();
  });

  test("ESC 取消只标记当前未转写记录：标题置灰且叠加禁止徽章，其他未转写和成功记录不误标", () => {
    const now = Date.now();
    const harness = mount([model("active")], {
      history: [
        historyItem({
          id: "cancelled",
          transcript: "",
          transcriptionStatus: "not_requested",
          stopReason: "user_cancel",
          createdAt: new Date(now - 60_000).toISOString(),
        }),
        historyItem({
          id: "limited",
          transcript: "",
          transcriptionStatus: "not_requested",
          stopReason: "capture_limit",
          createdAt: new Date(now - 2 * 60_000).toISOString(),
        }),
        historyItem({
          id: "success",
          transcript: "正常转写",
          createdAt: new Date(now - 3 * 60_000).toISOString(),
        }),
      ],
    });
    const rows = Array.from(
      harness.root.querySelectorAll<HTMLElement>(".task-list .task-item:not(.command-history-item)"),
    );
    const [cancelled, limited, success] = rows;

    expect(cancelled?.classList.contains("is-pending")).toBeTrue();
    expect(cancelled?.classList.contains("is-cancelled")).toBeTrue();
    const cancelledAvatar = cancelled?.querySelector(".task-ava");
    expect(cancelledAvatar?.getAttribute("role")).toBe("img");
    expect(cancelledAvatar?.getAttribute("aria-label")).toBe("已取消录音");
    expect(cancelledAvatar?.querySelector(".task-ava-mic")?.textContent).toBe("🎙️");
    expect(cancelledAvatar?.querySelector(".task-ava-ban")?.textContent).toBe("🚫");
    expect(cancelledAvatar?.querySelector(".task-ava-ban")?.getAttribute("aria-hidden")).toBe("true");

    expect(limited?.classList.contains("is-pending")).toBeTrue();
    expect(limited?.classList.contains("is-cancelled")).toBeFalse();
    expect(limited?.querySelector(".task-ava-ban")).toBeNull();
    expect(success?.classList.contains("is-pending")).toBeFalse();
    expect(success?.classList.contains("is-cancelled")).toBeFalse();

    expect(css).toMatch(/\.task-item\.is-pending \.task-name\s*\{[^}]*color:\s*var\(--text-tertiary,\s*#a5a5b8\)/s);
    expect(css).toMatch(/\.task-item\.is-cancelled \.task-ava\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.task-ava-ban\s*\{[^}]*position:\s*absolute/s);
    harness.view.dispose();
  });

  test("A3-12：混排不改变点击去向——命令行进 Chat detail，输入行进 Input detail", () => {
    const now = Date.now();
    const harness = mount([model("active")], {
      history: [historyItem({ id: "in-1", transcript: "一段输入", createdAt: new Date(now - 5 * 60_000).toISOString() })],
      commandHistory: [commandItem({ id: "cmd-1", transcript: "一条命令", createdAt: new Date(now - 60 * 60_000).toISOString() })],
    });
    const commandRow = harness.root.querySelector(
      ".task-item.command-history-item",
    ) as HTMLButtonElement;
    commandRow.click();
    expect(harness.root.querySelector(".chat-view")).not.toBeNull();
    expect(harness.root.querySelector(".input-detail")).toBeNull();
    harness.view.navigateRoot();

    const inputRow = harness.root.querySelector(
      ".task-list .task-item:not(.command-history-item)",
    ) as HTMLButtonElement;
    inputRow.click();
    expect(harness.root.querySelector(".input-detail")).not.toBeNull();
    expect(harness.root.querySelector(".chat-view")).toBeNull();
    harness.view.dispose();
  });

  test("A3-12：Input / Command 档不混排——各自的清单里只留自己那类", () => {
    const harness = mount([model("active")], {
      history: [historyItem()],
      commandHistory: [commandItem()],
    });
    openTab(harness.root, "input");
    expect(harness.root.querySelectorAll(".task-list .task-item")).toHaveLength(1);
    expect(harness.root.querySelector(".task-item.command-history-item")).toBeNull();
    openTab(harness.root, "command");
    expect(harness.root.querySelectorAll(".task-list .task-item")).toHaveLength(1);
    expect(harness.root.querySelector(".task-item.command-history-item")).not.toBeNull();
    harness.view.dispose();
  });

  test("R9 未读点：命令详情一打开就回调清未读，已读的不再回调", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const marked: string[] = [];
    const view = mountVoiceView(
      root,
      createDefaultVoiceViewState({
        models: [model("active")],
        commandHistory: [
          commandItem({
            id: "cmd-unread",
            transcript: "未读命令",
            createdAt: "2026-08-31T12:00:00.000Z",
            unread: true,
          }),
          commandItem({
            id: "cmd-read",
            transcript: "已读命令",
            createdAt: "2026-08-31T12:01:00.000Z",
          }),
        ],
      }),
      {
        onToggle: async () => undefined,
        onCommandToggle: async () => undefined,
        onDictateDraft: async () => ({ phase: "listening" as const }),
        onDictationResultConsumed: async () => undefined,
        onDictateCancel: async () => undefined,
        onOpenSystemTask: async () => undefined,
        onNavigated: () => undefined,
        onRefresh: async () => undefined,
        onSettingsChanged: async () => undefined,
        onFeatureSettingsChanged: async () => undefined,
        onDownloadModel: async () => undefined,
        onCancelModelDownload: async () => undefined,
        onRequestPermission: async () => undefined,
        onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
        onTimelinePaused: async () => undefined,
        onDeleteRecording: async () => undefined,
        onRetryInputTranscription: async () => undefined,
        onSendContextToAgent: async () => undefined,
        onSendCommandFollowUp: async () => "task-follow-up",
        onRegenerateDayDigest: async () => undefined,
        onSendDayDigestToAgent: async () => undefined,
        onSummarizeSegment: async () => undefined,
        onMarkCommandRead: async (id) => {
          marked.push(id);
        },
        onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
        onReplayRetentionChanged: async () => undefined,
        onClearReplayCache: async () => undefined,
        onActionMountChanged: async () => undefined,
        onOpenKeymap: async () => undefined,
      },
    );
    const readRow = root.querySelector<HTMLElement>(
      '[aria-label="打开命令任务详情：已读命令"]',
    );
    expect(readRow).toBeInstanceOf(HTMLElement);
    expect(readRow?.getAttribute("role")).toBe("button");
    readRow?.click();
    expect(marked).toEqual([]);
    view.navigateRoot();
    const unreadRow = root.querySelector<HTMLElement>(
      '[aria-label="打开命令任务详情：未读命令"]',
    );
    expect(unreadRow).toBeInstanceOf(HTMLElement);
    expect(unreadRow?.getAttribute("role")).toBe("button");
    unreadRow?.click();
    expect(marked).toEqual(["cmd-unread"]);
    view.dispose();
  });
});
