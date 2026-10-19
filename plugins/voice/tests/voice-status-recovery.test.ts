import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AudioTimelineStatus, VoiceModelInfo, VoiceRecordingSegment } from "@reai/app-sdk/v1";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  createDefaultVoiceViewState,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
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

function model(state: VoiceModelInfo["state"]): VoiceModelInfo {
  return {
    id: "sensevoice-small-int8",
    name: "SenseVoice Small",
    description: "中英粤日韩本地识别",
    sizeBytes: 228 * 1024 * 1024,
    state,
    active: state === "active",
    updateAvailable: false,
    ...(state === "failed" ? { error: "网络中断" } : {}),
  };
}

function timeline(overrides: Partial<AudioTimelineStatus> = {}): AudioTimelineStatus {
  return {
    state: "running",
    route: "usb_vendor_hid",
    hotRingDurationMs: 10_000,
    cacheDurationMs: 60_000,
    cacheHealth: "healthy",
    continuousRecordingEnabled: true,
    recordingState: "running",
    sttBacklog: 0,
    hostLocalDropFrames: 0,
    ...overrides,
  };
}

const READY_PERMISSIONS = { microphone: "granted", accessibility: "granted" } as const;

function mount(overrides: Record<string, unknown> = {}, extraActions: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const calls = {
    refresh: mock(async () => undefined),
    account: mock(async () => undefined),
    permissions: mock(async () => undefined),
    appPermissions: mock(async () => undefined),
    firmware: mock(async () => undefined),
  };
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: calls.firmware,
    onRefresh: calls.refresh,
    onSettingsChanged: async () => undefined,
    onAgentExperimentChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onTimelinePaused: async () => undefined,
    onDeleteRecording: async () => undefined,
    onSendContextToAgent: async () => undefined,
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onSendCommandFollowUp: async () => undefined,
    onDictateDraft: async () => ({ phase: "idle" as const, transcript: "" }),
    onDictationResultConsumed: async () => undefined,
    onDictateCancel: async () => undefined,
    onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
    onRetryInputTranscription: async () => undefined,
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async () => undefined,
    onOpenKeymap: async () => undefined,
    onOpenAccountLogin: calls.account,
    onOpenPermissionSettings: calls.permissions,
    onOpenAppPermissions: calls.appPermissions,
    onNavigated: () => undefined,
    ...extraActions,
  } as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({
    developerMode: true,
    models: [model("active")],
    permissions: READY_PERMISSIONS,
    sourceReady: true,
    timeline: timeline(),
    ...(overrides as Partial<VoiceViewState>),
  });
  const view = mountVoiceView(root, state, actions);
  return { root, view, calls, state };
}

function capsule(root: HTMLElement): HTMLElement {
  return root.querySelector(".voice-cap") as HTMLElement;
}

function segment(root: HTMLElement, id: "mic" | "ctx" | "kb" | "status"): HTMLElement {
  return root.querySelector(`[data-cap-seg="${id}"]`) as HTMLElement;
}

describe("首次读取与正常状态", () => {
  test("cloud dictation remains ready while all-day records explain their local model requirement", () => {
    const h = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, commandLoggedIn: true, models: [model("missing")],
      featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: "transcribe-free" },
      cloudModels: [{ id: "transcribe-free", kind: "transcribe", label: "Cloud" }],
    });
    expect(segment(h.root, "mic").textContent).toBe("云端就绪");
    expect(segment(h.root, "ctx").textContent).toBe("在听");
    const warning = h.root.querySelector('[data-warn="timeline-model"]');
    expect(warning?.textContent).toContain("全天录音需要本地模型");
    warning!.querySelector<HTMLButtonElement>("button")!.click();
    expect(h.root.querySelector(".voice-models-view")).not.toBeNull();
    h.view.dispose();
    const ready = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, commandLoggedIn: true });
    expect(ready.root.querySelector('[data-warn="timeline-model"]')).toBeNull();
    ready.view.dispose();
  });
  test("new Voice installation offers local/background download or cloud settings", () => {
    const choose = mock(async (_engine: "local" | "cloud") => undefined);
    const h = mount({ recognitionSetupRequired: true }, { onChooseRecognitionEngine: choose });
    expect(h.root.textContent).toContain("Voice 已安装，选择识别方式");
    const buttons = Array.from(h.root.querySelectorAll<HTMLButtonElement>(".voice-recognition-choice button"));
    expect(buttons.map(button => button.textContent)).toEqual(["下载本地模型", "使用云端模型"]);
    buttons[0]!.click(); expect(choose).toHaveBeenCalledWith("local");
    h.view.update({ ...h.state, recognitionSetupRequired: true, recognitionSetupBusy: true });
    // 保存期间两颗选择按钮都禁用；诊断区的「查看诊断」照常可点（§6.0：等待时也能看诊断）。
    expect(Array.from(h.root.querySelectorAll<HTMLButtonElement>(".voice-recognition-choice button")).every(button => button.disabled)).toBeTrue();
    expect(h.root.querySelector(".voice-diag[data-diag-state='waiting'] .voice-diag-step")?.textContent).toBe("保存识别方式");
    h.view.update({ ...h.state, recognitionSetupRequired: false });
    expect(h.root.querySelector(".voice-recognition-setup")).toBeNull();
    h.view.dispose();
  });

  test("explicit route reconciliation is neutral briefly, recovers without navigation, and cannot hide a stuck route", () => {
    let now = 1000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const pending = timeline({ state: "unavailable", unavailableReason: "route_reconciling" });
    const h = mount({ timeline: pending });
    try {
      expect(segment(h.root, "ctx").textContent).toBe("正在连接音频");
      now += 16000;
      h.view.update({ ...h.state, timeline: pending });
      expect(segment(h.root, "ctx").textContent).toBe("时间线不可用");
      h.view.update({ ...h.state, timeline: timeline() });
      expect(segment(h.root, "ctx").textContent).toBe("在听");
    } finally { h.view.dispose(); clock.mockRestore(); }
  });
  test("首次加载只显示中性的检查中，不渲染橙色误报或可点击按钮", () => {
    const harness = mount({ statusLoad: "loading", models: [], sourceReady: false, timeline: undefined });
    expect(capsule(harness.root).textContent).toBe("检查中");
    expect(capsule(harness.root).querySelector("button")).toBeNull();
    expect(harness.root.querySelectorAll(".voice-warn")).toHaveLength(0);
    harness.view.dispose();
  });

  test("正常与过渡状态只显示，不影响交互", () => {
    const states: Array<[string, Record<string, unknown>]> = [
      ["本地就绪", {}],
      ["录音中", { phase: "listening" }],
      ["识别中", { phase: "recognizing" }],
      ["模型下载中", { models: [model("downloading")] }],
      ["检查固件", { sourceReady: false, sourceIssue: "firmware_unknown" }],
    ];
    for (const [label, overrides] of states) {
      const harness = mount(overrides);
      expect(segment(harness.root, "mic").textContent).toBe(label);
      expect(segment(harness.root, "mic").tagName).toBe("SPAN");
      harness.view.dispose();
    }

    const listening = mount();
    expect(segment(listening.root, "ctx").textContent).toBe("在听");
    // H02:C04：在听段是暂停入口（button），不再是纯展示 SPAN。
    expect(segment(listening.root, "ctx").tagName).toBe("BUTTON");
    listening.view.dispose();
  });
});

describe("异常状态的最短恢复入口", () => {
  test("键盘未连接进入录音来源，高亮保留到用户下一次动作", async () => {
    const harness = mount({ sourceReady: false, sourceIssue: "disconnected" });
    const button = segment(harness.root, "kb") as HTMLButtonElement;
    expect(button.textContent).toBe("键盘未连接");
    expect(button.tagName).toBe("BUTTON");
    button.click();
    const source = harness.root.querySelector('[data-settings-target="source"]');
    expect(source?.classList.contains("settings-target-flash")).toBeTrue();
    expect(
      source?.closest('[data-settings-target="engine"]')?.classList.contains("settings-target-flash"),
    ).toBeFalse();

    // openSettings 会立即刷新一次状态；重渲染不能把用户还没来得及看见的高亮吃掉。
    harness.view.update({ ...harness.state, sourceReady: false, sourceIssue: "disconnected" });
    expect(
      harness.root.querySelector('[data-settings-target="source"]')?.classList.contains("settings-target-flash"),
    ).toBeTrue();

    // DOM 重建产生的 mouseover 不是用户动作，不能再把高亮一闪而过地清掉。
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    document.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(
      harness.root.querySelector('[data-settings-target="source"]')?.classList.contains("settings-target-flash"),
    ).toBeTrue();

    const css = readFileSync(
      resolve(import.meta.dir, "../src/voice.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.settings-row\.settings-target-flash\s*\{[^}]*animation:\s*settings-row-target-flash 5s/s,
    );
    const viewSource = readFileSync(
      resolve(import.meta.dir, "../src/voice-view.ts"),
      "utf8",
    );
    expect(viewSource).toContain("}, 5_000);");
    expect(viewSource).not.toContain('"mouseover",');
    const actionRule = css.match(/\.settings-row-action\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(actionRule).not.toMatch(/\bborder\s*:\s*0\s*;/);
    expect(actionRule).toContain("border-top: 0");
    expect(actionRule).toContain("border-right: 0");
    expect(actionRule).toContain("border-left: 0");
    harness.view.dispose();
  });

  test("系统麦克风和辅助功能未授权都进入权限与隐私", async () => {
    const microphone = mount({
      settings: { ...DEFAULT_SETTINGS, source: "system", systemEndpointId: "mic-1" },
      permissions: { microphone: "denied", accessibility: "granted" },
    });
    expect(segment(microphone.root, "mic").textContent).toBe("麦克风未授权");
    segment(microphone.root, "mic").click();
    await Promise.resolve();
    expect(microphone.calls.permissions).toHaveBeenCalledTimes(1);
    microphone.view.dispose();

    const accessibility = mount({
      permissions: { microphone: "granted", accessibility: "not_determined" },
    });
    expect(segment(accessibility.root, "mic").textContent).toBe("权限不全");
    segment(accessibility.root, "mic").click();
    await Promise.resolve();
    expect(accessibility.calls.permissions).toHaveBeenCalledTimes(1);
    accessibility.view.dispose();
  });

  test("模型、登录和 Voice 写入权限分别去到真实解决位置", async () => {
    const missing = mount({ models: [model("missing")] });
    expect(segment(missing.root, "mic").textContent).toBe("模型未设置");
    segment(missing.root, "mic").click();
    expect(
      missing.root.querySelector('[data-settings-target="model"]')?.classList.contains("settings-target-flash"),
    ).toBeTrue();
    missing.view.dispose();

    const login = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, commandLoggedIn: false });
    expect(segment(login.root, "mic").textContent).toBe("需要登录");
    segment(login.root, "mic").click();
    await Promise.resolve();
    expect(login.calls.account).toHaveBeenCalledTimes(1);
    login.view.dispose();

    const delivery = mount({ deliveryPermissionBlocked: true });
    expect(segment(delivery.root, "mic").textContent).toBe("Voice 写入权限未开");
    segment(delivery.root, "mic").click();
    await Promise.resolve();
    expect(delivery.calls.appPermissions).toHaveBeenCalledTimes(1);
    expect(delivery.root.textContent).not.toContain("voice.deliver@1");
    delivery.view.dispose();
  });

  test("全天存档关闭、暂停、安全停用和存储异常各去对应位置", async () => {
    const off = mount({ timeline: timeline({ continuousRecordingEnabled: false, recordingState: "disabled" }) });
    expect(segment(off.root, "ctx").textContent).toBe("未开启");
    segment(off.root, "ctx").click();
    expect(
      off.root.querySelector('[data-settings-target="replay-cache"]')?.classList.contains("settings-target-flash"),
    ).toBeTrue();
    off.view.dispose();

    // H02:C04：已暂停段的点击语义改为「继续全天记录」，不再跳设置。
    const paused = mount({ timeline: timeline({ state: "paused_by_user" }) });
    expect(segment(paused.root, "ctx").textContent).toBe("已暂停");
    segment(paused.root, "ctx").click();
    expect(
      paused.root.querySelector('[data-settings-target="replay-cache"]'),
    ).toBeNull();
    paused.view.dispose();

    for (const [label, state] of [
      ["安全停用", "disabled_by_safety_switch"],
      ["时间线不可用", "unavailable"],
    ] as const) {
      const harness = mount({ timeline: timeline({ state }) });
      expect(segment(harness.root, "ctx").textContent).toBe(label);
      segment(harness.root, "ctx").click();
      expect(
        harness.root.querySelector('[data-settings-target="replay-cache"]')?.classList.contains("settings-target-flash"),
      ).toBeTrue();
      harness.view.dispose();
    }

    const degraded = mount({ timeline: timeline({ cacheHealth: "degraded", recordingState: "degraded" }) });
    expect(segment(degraded.root, "ctx").textContent).toBe("存档异常");
    segment(degraded.root, "ctx").click();
    expect(
      degraded.root.querySelector('[data-settings-target="replay-cache"]')?.classList.contains("settings-target-flash"),
    ).toBeTrue();
    degraded.view.dispose();
  });

  test("读取失败只显示一个真实错误并支持原地重试", async () => {
    const harness = mount({ statusLoad: "failed", statusLoadError: "Host 暂时无响应" });
    expect(capsule(harness.root).textContent).toBe("状态读取失败");
    expect(harness.root.querySelectorAll(".voice-warn")).toHaveLength(1);
    expect(harness.root.textContent).toContain("Host 暂时无响应");
    segment(harness.root, "status").click();
    await Promise.resolve();
    expect(harness.calls.refresh).toHaveBeenCalledTimes(1);
    harness.view.dispose();
  });
});

describe("录音来源和全天存档说明", () => {
  test("系统麦克风展示带默认标记的真实输入设备下拉", () => {
    const harness = mount({
      settings: { ...DEFAULT_SETTINGS, source: "system", systemEndpointId: "airpods" },
      systemInputs: [
        { id: "built-in", name: "电脑内建麦克风", isDefault: false },
        { id: "airpods", name: "亢的 AirPods Max", isDefault: true },
      ],
    });
    harness.view.openSettings("source");
    const select = harness.root.querySelector<HTMLSelectElement>(".settings-select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe("airpods");
    expect(Array.from(select?.options ?? []).map((option) => option.textContent)).toContain(
      "亢的 AirPods Max（默认）",
    );
    expect(select?.closest(".settings-select-shell")).not.toBeNull();
    harness.view.dispose();
  });

  test("「未开启」胶囊直达的记录保留里有全天存档开关（显示关着），另有时长与清空", () => {
    const harness = mount({ timeline: timeline({ continuousRecordingEnabled: false, recordingState: "disabled" }) });
    harness.view.openSettings("replay-cache");
    const section = harness.root.querySelector('[data-settings-target="replay-cache"]');
    expect(section?.textContent).toContain("4 小时");
    expect(section?.textContent).toContain("30 天");
    expect(section?.textContent).toContain("立刻清空语音记录");
    const switches = Array.from(section?.querySelectorAll(".settings-switch") ?? []);
    // 只断言数量与状态，不把 DOM 节点交给 expect（失败时 bun 会把整棵树打印出来）。
    expect(switches.length).toBe(1);
    expect(switches[0]?.getAttribute("aria-label")).toBe("全天存档");
    expect(switches[0]?.getAttribute("aria-checked")).toBe("false");
    harness.view.dispose();
  });
});

/**
 * 2.14.3：本地引擎 + 本地模型没就绪时，Context 档说清「全天记录为什么没转写」（§6.0）。
 * 复用首页那一行 `timeline-model`（同判定、同组件、同去路）；本地引擎只在 Context 档出。
 */
describe("Context 档：本地模型没就绪时说清全天记录为什么没转写", () => {
  afterAll(() => setVoiceLocale("zh"));
  beforeEach(() => setVoiceLocale("zh"));

  function pendingSegment(id: string, durationMs: number): VoiceRecordingSegment {
    return { id, wallStartMs: Date.now() - 60_000, durationMs, transport: "usb_vendor_hid", transcriptText: null, transcriptStatus: "pending" };
  }
  const PENDING = { recordings: [pendingSegment("a", 90_000), pendingSegment("b", 90_000)], recordingsTotal: 2 };
  const openTab = (root: HTMLElement, tab: string) =>
    root.querySelector<HTMLButtonElement>(`[data-voice-tab="${tab}"]`)!.click();
  const hint = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-warn="timeline-model"]');
  /** 「去设置」落到哪：页面 + 被高亮的设置目标。 */
  const landing = (root: HTMLElement) => ({
    modelsPage: root.querySelector(".voice-models-view") !== null,
    target: root.querySelector(".settings-target-flash")?.getAttribute("data-settings-target") ?? null,
  });

  test("本地引擎 + 模型未下载：Context 档给对象状态、待转写段数与时长、真实原因与去设置", () => {
    const h = mount({ models: [model("missing")], ...PENDING });
    // All 档已有语音输入那一行「本地语音模型还没下载」，这里不再重复出全天记录那一行。
    expect(h.root.querySelector('[data-warn="model"]')).not.toBeNull();
    expect(hint(h.root)).toBeNull();
    openTab(h.root, "context");
    const row = hint(h.root)!;
    expect(row.textContent).toBe("全天记录使用本地模型 — 全天录音照常保存，但暂时转不成文字（2 段等待转写 · 3 分 0 秒）：本地模型还没下载。下载后会接着转写。去设置 ›");
    // 缺模型不是失败：不挂失败诊断。
    expect(row.querySelector(".voice-diag")).toBeNull();
    row.querySelector<HTMLButtonElement>(".voice-warn-go")!.click();
    const fromContext = landing(h.root);
    expect(fromContext).toEqual({ modelsPage: true, target: "model" });
    h.view.dispose();

    // 与首页横幅（云端引擎的同一行）以及 All 档语音输入那一行落在同一处。
    const home = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, models: [model("missing")] });
    hint(home.root)!.querySelector<HTMLButtonElement>(".voice-warn-go")!.click();
    expect(landing(home.root)).toEqual(fromContext);
    home.view.dispose();
    const input = mount({ models: [model("missing")] });
    input.root.querySelector<HTMLElement>('[data-warn="model"] .voice-warn-go')!.click();
    expect(landing(input.root)).toEqual(fromContext);
    input.view.dispose();
  });

  test("段数只数已加载的列表：没拿全只说「至少」，没有待转写就不给段数", () => {
    const partial = mount({ models: [model("missing")], ...PENDING, recordingsTotal: 60 });
    openTab(partial.root, "context");
    expect(hint(partial.root)?.textContent).toContain("全天录音照常保存，但暂时转不成文字（至少 2 段等待转写）：本地模型还没下载。");
    partial.view.dispose();
    const none = mount({ models: [model("missing")] });
    openTab(none.root, "context");
    expect(hint(none.root)?.textContent).toContain("全天录音照常保存，但暂时转不成文字：本地模型还没下载。");
    none.view.dispose();
    // 全天积压常以小时计：满 1 小时写时分，不写成「485 分钟」；时长全为 0 时只给段数。
    const long = mount({ models: [model("missing")], recordings: [pendingSegment("a", 2 * 3_600_000), pendingSegment("b", 5 * 60_000)], recordingsTotal: 2 });
    openTab(long.root, "context");
    expect(hint(long.root)?.textContent).toContain("（2 段等待转写 · 2 小时 5 分）");
    long.view.dispose();
    const zero = mount({ models: [model("missing")], recordings: [pendingSegment("a", 0), pendingSegment("b", Number.NaN)], recordingsTotal: 2 });
    openTab(zero.root, "context");
    expect(hint(zero.root)?.textContent).toContain("暂时转不成文字（2 段等待转写）：");
    zero.view.dispose();
    // 模型列表里根本没有这个本地模型：按「还没下载」说；「至少」与下载中组合同样成立。
    const noModel = mount({ models: [], ...PENDING });
    openTab(noModel.root, "context");
    expect(hint(noModel.root)?.textContent).toContain("（2 段等待转写 · 3 分 0 秒）：本地模型还没下载。");
    noModel.view.dispose();
    const partialDownloading = mount({ models: [model("downloading")], ...PENDING, recordingsTotal: 60 });
    openTab(partialDownloading.root, "context");
    expect(hint(partialDownloading.root)?.textContent).toContain("（至少 2 段等待转写）：本地模型正在下载，下载完成后会接着转写。");
    partialDownloading.view.dispose();
  });

  test("同一视图里模型状态迁移：缺失 → 下载中 → 失败 → 就绪，文案与诊断随之切换", () => {
    const h = mount({ models: [model("missing")], ...PENDING });
    openTab(h.root, "context");
    expect(hint(h.root)?.textContent).toContain("本地模型还没下载");
    h.view.update({ ...h.state, ...PENDING, models: [model("downloading")] });
    expect(hint(h.root)?.textContent).toContain("本地模型正在下载");
    expect(hint(h.root)?.querySelector(".voice-diag")).toBeNull();
    h.view.update({ ...h.state, ...PENDING, models: [model("failed")] });
    expect(hint(h.root)?.textContent).toContain("本地模型下载失败");
    expect(hint(h.root)?.querySelector(".voice-diag")).not.toBeNull();
    h.view.update({ ...h.state, ...PENDING, models: [model("active")] });
    expect(hint(h.root)).toBeNull();
    h.view.dispose();
  });

  test("下载中与下载失败说真实状态；失败挂同一套模型下载诊断", () => {
    const downloading = mount({ models: [model("downloading")], ...PENDING });
    openTab(downloading.root, "context");
    expect(hint(downloading.root)?.textContent).toContain("：本地模型正在下载，下载完成后会接着转写。");
    expect(hint(downloading.root)?.querySelector(".voice-diag")).toBeNull();
    downloading.view.dispose();
    const failed = mount({ models: [model("failed")], ...PENDING });
    openTab(failed.root, "context");
    const row = hint(failed.root)!;
    expect(row.textContent).toContain("：本地模型下载失败。重新下载后会接着转写。");
    expect(row.querySelector<HTMLElement>(".voice-diag[data-diag-state='failed']")?.dataset.diagKey)
      .toBe("warn:timeline-model:sensevoice-small-int8");
    failed.view.dispose();
  });

  test("模型已就绪、全天存档关着或选云端时不出本地这一行", () => {
    const ready = mount({ models: [model("active")], ...PENDING });
    openTab(ready.root, "context");
    expect(hint(ready.root)).toBeNull();
    ready.view.dispose();
    const off = mount({ models: [model("missing")], ...PENDING, timeline: timeline({ continuousRecordingEnabled: false }) });
    openTab(off.root, "context");
    expect(hint(off.root)).toBeNull();
    expect(off.root.querySelector('[data-warn="context"]')).not.toBeNull();
    off.view.dispose();
    // 读不到时间线（旧 Host / 还没读到）：不凭空断言全天存档开着，两行都不出。
    const noTimeline = mount({ models: [model("missing")], ...PENDING, timeline: undefined });
    openTab(noTimeline.root, "context");
    expect(hint(noTimeline.root)).toBeNull();
    expect(noTimeline.root.querySelector('[data-warn="context"]')).toBeNull();
    noTimeline.view.dispose();
    // 选云端：沿用云端那句（云端语音输入可直接使用），不出本地引擎的原因说明；模型就绪则都不出。
    const cloud = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, models: [model("missing")], ...PENDING });
    openTab(cloud.root, "context");
    expect(hint(cloud.root)?.textContent).toContain("全天录音需要本地模型");
    expect(hint(cloud.root)?.textContent).not.toContain("本地模型还没下载");
    cloud.view.dispose();
    const cloudReady = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, models: [model("active")], ...PENDING });
    openTab(cloudReady.root, "context");
    expect(hint(cloudReady.root)).toBeNull();
    cloudReady.view.dispose();
  });

  test("英文界面同样说清，并随语言切换即时更新", () => {
    const h = mount({ models: [model("missing")], ...PENDING });
    openTab(h.root, "context");
    setVoiceLocale("en");
    expect(hint(h.root)?.textContent).toBe("All-day records use a local model — All-day recordings are still being saved but can't be transcribed yet (recordings waiting: 2 · 3m 0s): the local model isn't downloaded. Transcription resumes after you download it.Open settings ›");
    h.view.dispose();
  });
});
