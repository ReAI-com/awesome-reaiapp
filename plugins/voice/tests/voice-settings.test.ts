import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AudioTimelineStatus, VoiceModelInfo } from "@reai/app-sdk/v1";
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

function model(state: VoiceModelInfo["state"] = "active"): VoiceModelInfo {
  return {
    id: "sensevoice-small-int8",
    name: "SenseVoice Small",
    description: "中英粤日韩本地识别",
    sizeBytes: 228 * 1024 * 1024,
    state,
    active: state === "active",
    updateAvailable: false,
  };
}

function timeline(): AudioTimelineStatus {
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
  };
}

function mount(overrides: Partial<VoiceViewState> = {}, extra: Partial<VoiceViewActions> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settingsPatches: Array<Partial<VoiceViewState["settings"]>> = [];
  const featurePatches: Array<Partial<VoiceViewState["featureSettings"]>> = [];
  const calls = { mount: [] as Array<[string, boolean]> };
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onSettingsChanged: async (patch: Partial<VoiceViewState["settings"]>) => {
      settingsPatches.push(patch);
    },
    onFeatureSettingsChanged: async (patch: Partial<VoiceViewState["featureSettings"]>) => {
      featurePatches.push(patch);
    },
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
    onRequestPermission: async () => undefined,
    onTimelinePaused: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onPlayRecording: async () => undefined,
    onDeleteRecording: async () => undefined,
    onSendContextToAgent: async () => undefined,
    onSynthesizeDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onDeleteDayDigest: async () => undefined,
    onSendCommandFollowUp: async () => "task-follow-up",
    onLoadReplayAudio: async () => new Blob([], { type: "audio/wav" }),
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async (commandId: string, mounted: boolean) => {
      calls.mount.push([commandId, mounted]);
    },
    onOpenKeymap: async () => undefined,
    onNavigated: () => undefined,
    ...extra,
  } as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({
    models: [model()],
    timeline: timeline(),
    replayCache: { retention: "24h", clipCount: 2, usedBytes: 12_000, retainedSinceMs: 1 },
    ...overrides,
  });
  const view = mountVoiceView(root, state, actions);
  return { root, view, state, settingsPatches, featurePatches, calls };
}

function sectionTitles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".settings-section")).map(
    (section) => section.querySelector(".settings-section-title")?.textContent ?? "",
  );
}

function rowTitles(section: Element | null): string[] {
  return Array.from(section?.querySelectorAll(".settings-row-title") ?? []).map(
    (node) => node.textContent ?? "",
  );
}

describe("Voice 设置主页面", () => {
  test("本地引擎按频次排序，主页面没有测试、Agent、增益或模型说明", () => {
    const harness = mount({ commandLoggedIn: false });
    harness.view.openSettings();
    expect(sectionTitles(harness.root)).toEqual([
      "录音与识别",
      "润色",
      "语音命令",
      "记录保留",
      "每日总结",
      "系统",
      "Agent 配置",
    ]);
    const engine = harness.root.querySelector('[data-settings-target="engine"]');
    expect(rowTitles(engine)).toEqual(["引擎", "本地模型", "录音来源", "识别语言"]);
    expect(harness.root.textContent).not.toContain("测试语音识别");
    expect(harness.root.textContent).not.toContain("Agent 底层");
    expect(harness.root.textContent).not.toContain("麦克风增益");
    harness.view.dispose();
  });

  test("云端未登录：可以切到云端，第二行引导登录；润色配置保持可见", () => {
    const harness = mount({ commandLoggedIn: false, settings: { ...DEFAULT_SETTINGS, engine: "cloud" } });
    harness.view.openSettings();
    const engine = harness.root.querySelector('[data-settings-target="engine"]');
    expect(rowTitles(engine)).toEqual(["引擎", "云端状态", "录音来源", "识别语言"]);
    const cloud = Array.from(engine?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])
      .find((button) => button.textContent === "云端引擎");
    expect(cloud?.disabled).toBeFalse();
    expect(sectionTitles(harness.root)).toContain("润色");
    harness.view.dispose();
  });

  test("云端已登录：未保存时不冒充默认模型已选中，润色紧跟录音与识别", () => {
    const harness = mount({
      commandLoggedIn: true,
      settings: { ...DEFAULT_SETTINGS, engine: "cloud" },
      cloudModels: [
        { id: "transcribe-free", kind: "transcribe", label: "通用语音模型" },
        { id: "transcribe-accurate", kind: "transcribe", label: "高精度语音模型" },
      ],
    });
    harness.view.openSettings();
    expect(sectionTitles(harness.root)).toEqual([
      "录音与识别",
      "润色",
      "语音命令",
      "记录保留",
      "每日总结",
      "系统",
      "Agent 配置",
    ]);
    const select = harness.root.querySelector<HTMLSelectElement>('[aria-label="选择云端模型"]')!;
    expect(select.value).toBe("cloud-unavailable");
    expect(Array.from(select.options).some(option => option.value === "")).toBeFalse();
    select.value = "transcribe-accurate";
    select.dispatchEvent(new Event("change"));
    expect(harness.featurePatches).toContainEqual({ cloudModelId: "transcribe-accurate" });
    harness.view.dispose();
  });

  test("识别语言打开当前模型支持列表，不再点击轮换", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>("[data-language-row]")!.click();
    const dialog = harness.root.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("当前模型：SenseVoice Small");
    expect(Array.from(dialog?.querySelectorAll('[role="radio"]') ?? []).map((node) => node.textContent))
      .toEqual(["自动检测✓", "简体中文", "English"]);
    dialog?.querySelector<HTMLButtonElement>('[data-language-value="zh-CN"]')?.click();
    expect(harness.settingsPatches).toEqual([{ language: "zh-CN" }]);
    harness.view.dispose();
  });

  test("本地模型进入二级页面，说明默认折叠", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>('[data-settings-target="model"]')!.click();
    expect(harness.root.textContent).toContain("模型与识别");
    const details = harness.root.querySelector<HTMLDetailsElement>(".settings-model-details")!;
    expect(details.open).toBeFalse();
    expect(details.querySelector("summary")?.textContent).toBe("查看模型说明");
    harness.view.dispose();
  });
});

describe("记录、每日总结与权限", () => {
  test("记录保留：全天存档一颗开关 + 保留时长、占用和清空；开关只有标签，没有说明", () => {
    const harness = mount();
    harness.view.openSettings();
    const section = harness.root.querySelector('[data-settings-target="replay-cache"]');
    expect(rowTitles(section)).toEqual(["全天存档", "保留多久", "已占用", "立刻清空语音记录"]);
    const switches = Array.from(section?.querySelectorAll('[role="switch"]') ?? []);
    expect(switches).toHaveLength(1);
    const archive = switches[0] as HTMLButtonElement;
    expect(archive.getAttribute("aria-label")).toBe("全天存档");
    expect(archive.getAttribute("aria-checked")).toBe("true");
    expect(archive.disabled).toBeFalse();
    // 用户拍板：开关旁不放解释性说明（行里只有标题，没有副文案）。
    expect(archive.closest(".settings-row")?.querySelector(".settings-row-sub")).toBeNull();
    expect(section?.textContent).toContain("只保存有有效文字的语音记录");
    harness.view.dispose();
  });

  test("全天存档开关读 Host 时间线真值，点击只发一次目标值", async () => {
    const calls: boolean[] = [];
    const onContinuousRecording = async (enabled: boolean) => { calls.push(enabled); };
    const on = mount({}, { onContinuousRecording });
    on.view.openSettings();
    const onSwitch = on.root.querySelector<HTMLButtonElement>('[data-settings-target="replay-cache"] [role="switch"]')!;
    onSwitch.click();
    await Promise.resolve();
    expect(calls).toEqual([false]);
    on.view.dispose();

    document.body.replaceChildren();
    const off = mount({ timeline: { ...timeline(), continuousRecordingEnabled: false, recordingState: "disabled" } }, { onContinuousRecording });
    off.view.openSettings();
    const offSwitch = off.root.querySelector<HTMLButtonElement>('[data-settings-target="replay-cache"] [role="switch"]')!;
    expect(offSwitch.getAttribute("aria-checked")).toBe("false");
    offSwitch.click();
    await Promise.resolve();
    expect(calls).toEqual([false, true]);
    off.view.dispose();
  });

  test("读不到时间线（未加载 / 旧 Host）：全天存档开关禁用，不猜状态", () => {
    const harness = mount({ timeline: undefined });
    harness.view.openSettings();
    const archive = harness.root.querySelector<HTMLButtonElement>('[data-settings-target="replay-cache"] [role="switch"]')!;
    expect(archive.disabled).toBeTrue();
    expect(archive.getAttribute("aria-checked")).toBe("false");
    harness.view.dispose();
  });

  test("全天存档开关英文标签", () => {
    setVoiceLocale("en");
    try {
      const harness = mount();
      harness.view.openSettings();
      const section = harness.root.querySelector('[data-settings-target="replay-cache"]');
      expect(rowTitles(section)[0]).toBe("All-day archive");
      expect(section?.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("All-day archive");
      harness.view.dispose();
    } finally { setVoiceLocale("zh"); }
  });

  test("每日总结先开云端生成；首次开启必须同时接受用量与隐私风险", () => {
    const harness = mount({ commandLoggedIn: true, featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS } });
    harness.view.openSettings();
    expect(harness.root.textContent).not.toContain("生成方式");
    harness.root.querySelector<HTMLButtonElement>('[data-action="summary-enabled"]')!.click();
    const dialog = harness.root.querySelector('[role="dialog"]')!;
    const checks = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认并开启")!;
    expect(confirm.disabled).toBeTrue();
    checks[0]!.click();
    expect(confirm.disabled).toBeTrue();
    checks[1]!.click();
    expect(confirm.disabled).toBeFalse();
    confirm.click();
    expect(harness.featurePatches).toContainEqual({ summaryConsent: true, summaryEnabled: true });
    harness.view.dispose();
  });

  test("每日总结已开启后才出现手动/自动；权限行只用外链图标", () => {
    const openPermissions = mock(async () => undefined);
    const harness = mount({
      commandLoggedIn: true,
      featureSettings: {
        ...DEFAULT_VOICE_FEATURE_SETTINGS,
        summaryConsent: true,
        summaryEnabled: true,
      },
    }, { onOpenPermissionSettings: openPermissions });
    harness.view.openSettings();
    expect(harness.root.textContent).toContain("生成方式");
    const permissions = harness.root.querySelector<HTMLButtonElement>('[data-action="open-permission-settings"]')!;
    expect(permissions.textContent).toContain("权限与隐私");
    expect(permissions.textContent).not.toContain("权限设置");
    expect(permissions.querySelector(".settings-external-link svg")).not.toBeNull();
    permissions.click();
    expect(openPermissions).toHaveBeenCalledTimes(1);
    harness.view.dispose();
  });
});

describe("触发事件管理", () => {
  test("三条入口使用统一开关语义，文本入口走 canonical toggle-input", () => {
    const harness = mount({ mountedActionCommandIds: ["com.reai.voice.command.agent"] });
    harness.view.openSettings("commands");
    const rows = Array.from(harness.root.querySelectorAll<HTMLElement>("[data-command-event]"));
    expect(rows.map((row) => row.dataset.commandEvent)).toEqual([
      "com.reai.voice.toggle-input",
      "com.reai.voice.command.translate",
      "com.reai.voice.command.agent",
    ]);
    expect(rows.map((row) => row.querySelector(".command-event-title")?.textContent)).toEqual([
      "语音输入",
      "语音翻译",
      "语音 Agent 任务",
    ]);
    harness.root.querySelector<HTMLButtonElement>(".settings-hint-trigger")!.click();
    expect(document.body.textContent).toContain("录音中触发任意一个，都结束当前录音");
    rows[0]!.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    expect(harness.calls.mount).toEqual([["com.reai.voice.toggle-input", true]]);
    harness.view.dispose();
  });
});

test('download progress is shared between homepage and model page; installed models have no extra row', () => {
 const m={...model('downloading'), downloadedBytes:40, sizeBytes:100};
 const h=mount({models:[m]}); h.view.openSettings();
 expect(h.root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
 h.root.querySelector<HTMLButtonElement>('[data-settings-target="model"]')!.click();
 expect(h.root.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
 h.view.update({...h.state,models:[model('active')]});
 expect(h.root.querySelector('.local-model-status')).toBeNull(); h.view.dispose();
});

test('retained download offers resume and preparing offers cancel', async () => {
 let resumed=0,cancelled=0;
 const m={...model('missing'),resumeAvailable:true,downloadedBytes:40,sizeBytes:100};
 const h=mount({models:[m]}, {onDownloadModel:async()=>{resumed++;},onCancelModelDownload:async()=>{cancelled++;}});
 h.view.openSettings(); h.root.querySelector<HTMLButtonElement>('.local-model-status button')!.click();
 expect(resumed).toBe(1);
 h.view.update({...h.state,models:[m],localDownloads:{[m.id]:{phase:'preparing'}}});
 h.root.querySelector<HTMLButtonElement>('.local-model-status button')!.click(); expect(cancelled).toBe(1); h.view.dispose();
});

test("cloud model settings list names only and never show account prices", () => {
  const accountModel = { id: "transcribe-account", kind: "transcribe" as const, label: "Current default", isDefault: true,
    pricingContext: "current-account" as const, billingPolicy: "free" as const,
    effectivePrice: { unit: "second" as const, unitPriceCents: "0", baseUnitPriceCents: "0.1", reason: "subscription_price" as const,
      ruleRevision: "rule-1", policyRevision: "policy-1", subscriptionRevision: "sub-1", evaluatedAt: "2026-10-02T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" } };
  const h = mount({ commandLoggedIn: true, settings: { ...DEFAULT_SETTINGS, engine: "cloud" },
    featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS, cloudModelId: accountModel.id }, cloudModels: [accountModel] });
  try {
    h.view.openSettings();
    const options = Array.from(h.root.querySelectorAll<HTMLOptionElement>(".settings-cloud-model option"), o => o.textContent);
    expect(options).toEqual(["Current default"]);
    expect(h.root.textContent).not.toContain("美分/秒");
    expect(h.root.textContent).not.toContain("当前订阅价格");
    expect(h.root.textContent).toContain("已保存此选项");
    expect(h.root.textContent).not.toContain("永久免费");
  } finally { h.view.dispose(); }
});

describe("录音来源五档", () => {
  const sources = (patch: Partial<NonNullable<VoiceViewState["permissions"]["audioSources"]>> = {}) => ({
    microphone: "granted" as const,
    accessibility: "granted" as const,
    microphoneRequired: false,
    audioSources: { mode: "auto" as const, hardware: "available" as const, computer: "available" as const, resolved: "board" as const, ...patch },
  });
  const openDialog = (root: HTMLElement) => {
    root.querySelector<HTMLButtonElement>('[data-settings-target="source"]')?.click();
    return Array.from(root.querySelectorAll<HTMLButtonElement>(".voice-source-option"));
  };

  test("来源行点开五档单选，当前档打勾；选另一档只发一次显式补丁", async () => {
    const harness = mount({ permissions: sources({ mode: "prefer_computer", resolved: "system" }) });
    harness.view.openSettings();
    const row = harness.root.querySelector('[data-settings-target="source"]');
    expect(row?.textContent).toContain("电脑优先");
    expect(row?.textContent).toContain("电脑自带麦克风");
    const options = openDialog(harness.root);
    expect(options.map(option => option.dataset.audioSourceMode)).toEqual(["auto", "prefer_board", "prefer_computer", "board_only", "computer_only"]);
    expect(options.map(option => option.querySelector(".voice-source-option-label")?.textContent)).toEqual(["自动（推荐）", "硬件优先", "电脑优先", "只用硬件麦克风", "只用电脑麦克风"]);
    expect(options.filter(option => option.getAttribute("aria-checked") === "true").map(option => option.dataset.audioSourceMode)).toEqual(["prefer_computer"]);
    expect(options.every(option => !option.disabled)).toBe(true);
    options.find(option => option.dataset.audioSourceMode === "board_only")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.settingsPatches).toEqual([{ audioSourcePreference: { kind: "board_only" }, source: "board" }]);
    expect(harness.root.querySelector(".voice-source-dialog")).toBeNull();
    harness.view.dispose();
  });

  test("没接键盘：只用硬件麦 disabled 并写明原因；点了也不保存", async () => {
    const harness = mount({ permissions: sources({ hardware: "disconnected", resolved: "system" }) });
    harness.view.openSettings();
    const options = openDialog(harness.root);
    const boardOnly = options.find(option => option.dataset.audioSourceMode === "board_only")!;
    expect(boardOnly.disabled).toBe(true);
    expect(boardOnly.dataset.disabledReason).toBe("no_hardware");
    expect(boardOnly.textContent).toContain("未检测到键盘麦克风");
    expect(options.filter(option => option.disabled).map(option => option.dataset.audioSourceMode)).toEqual(["board_only"]);
    boardOnly.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.settingsPatches).toEqual([]);
    harness.view.dispose();
  });

  test("电脑没有输入设备：只用电脑麦 disabled", () => {
    const harness = mount({ permissions: sources({ computer: "missing" }) });
    harness.view.openSettings();
    const computerOnly = openDialog(harness.root).find(option => option.dataset.audioSourceMode === "computer_only")!;
    expect(computerOnly.disabled).toBe(true);
    expect(computerOnly.textContent).toContain("这台电脑没有可用的输入设备");
    harness.view.dispose();
  });

  test("两类麦都没有：五档全部 disabled，来源行下明确写语音不可用", () => {
    const harness = mount({ permissions: sources({ hardware: "disconnected", computer: "missing", resolved: "unavailable" }) });
    harness.view.openSettings();
    expect(harness.root.querySelector('[data-audio-source-notice="no-microphone"]')?.textContent).toContain("语音输入暂不可用");
    expect(harness.root.querySelector('[data-settings-target="source"]')?.textContent).toContain("暂不可用");
    const options = openDialog(harness.root);
    expect(options.every(option => option.disabled && option.dataset.disabledReason === "no_microphone")).toBe(true);
    harness.view.dispose();
  });

  test("电脑麦未授权：电脑优先给授权按钮，点了才请求；系统已拒绝时改为去系统设置的说明", async () => {
    const requested: string[] = [];
    const harness = mount(
      { permissions: { ...sources({ mode: "prefer_computer", computer: "permission_required" }), microphone: "not_determined" } },
      { onRequestPermission: async (kind: string) => { requested.push(kind); } } as never,
    );
    harness.view.openSettings();
    const notice = harness.root.querySelector('[data-audio-source-notice="grant-computer-microphone"]');
    expect(notice?.textContent).toContain("录音时也不会弹出授权");
    expect(requested).toEqual([]);
    notice?.querySelector<HTMLButtonElement>("[data-grant-computer-microphone]")?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested).toEqual(["microphone"]);
    harness.view.dispose();

    const denied = mount({ permissions: { ...sources({ mode: "computer_only", computer: "permission_required" }), microphone: "denied" } });
    denied.view.openSettings();
    const deniedNotice = denied.root.querySelector('[data-audio-source-notice="grant-computer-microphone"]');
    expect(deniedNotice?.textContent).toContain("系统设置");
    expect(deniedNotice?.querySelector("[data-grant-computer-microphone]")).toBeNull();
    denied.view.dispose();
  });

  test("自动档键盘可用时不打扰：没有授权引导", () => {
    const harness = mount({ permissions: { ...sources({ computer: "permission_required" }), microphone: "not_determined" } });
    harness.view.openSettings();
    expect(harness.root.querySelector("[data-audio-source-notice]")).toBeNull();
    harness.view.dispose();
  });

  test("英文文案", () => {
    setVoiceLocale("en");
    try {
      const harness = mount({ permissions: sources({ hardware: "disconnected" }) });
      harness.view.openSettings();
      const options = openDialog(harness.root);
      expect(options.map(option => option.querySelector(".voice-source-option-label")?.textContent)).toEqual([
        "Automatic (recommended)", "Hardware first", "Computer first", "Hardware microphone only", "Computer microphone only",
      ]);
      expect(options.find(option => option.dataset.audioSourceMode === "board_only")?.textContent).toContain("No keyboard microphone detected");
      harness.view.dispose();
    } finally {
      setVoiceLocale("zh");
    }
  });
});

describe("设置弹层的 Esc（surface.escape@1）", () => {
  const esc = (target: EventTarget) => {
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  test("录音来源与识别语言弹层：Esc 只关本层并声明已消费，焦点在弹层外也一样", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>('[data-settings-target="source"]')?.click();
    expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();
    const cancelButton = Array.from(harness.root.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).at(-1)!;
    cancelButton.focus();
    expect(esc(cancelButton).defaultPrevented).toBe(true);
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    // 关掉后再按 Esc：不再被 Voice 消费（交给 Host 做返回）。
    expect(esc(document.body).defaultPrevented).toBe(false);
    harness.root.querySelector<HTMLButtonElement>("[data-language-row]")!.click();
    expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();
    expect(esc(document.body).defaultPrevented).toBe(true);
    expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
    expect(harness.settingsPatches).toEqual([]);
    harness.view.dispose();
  });

  test("叠了两层弹层：Esc 只关最上面那层", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>("[data-language-row]")!.click();
    harness.root.querySelector<HTMLButtonElement>('[data-settings-target="source"]')?.click();
    const before = Array.from(document.querySelectorAll(".voice-dialog-layer"));
    expect(before.length).toBe(2);
    const topText = before.at(-1)!.textContent;
    const bottomText = before[0]!.textContent;
    expect(esc(document.body).defaultPrevented).toBe(true);
    const after = Array.from(document.querySelectorAll(".voice-dialog-layer"));
    expect(after.length).toBe(1);
    expect(after[0]!.textContent).toBe(bottomText);
    expect(after[0]!.textContent).not.toBe(topText);
    expect(esc(document.body).defaultPrevented).toBe(true);
    expect(document.querySelectorAll(".voice-dialog-layer").length).toBe(0);
    harness.view.dispose();
  });

  test("输入法组字中的 Esc 原样放行，不关弹层", () => {
    const harness = mount();
    harness.view.openSettings();
    harness.root.querySelector<HTMLButtonElement>("[data-language-row]")!.click();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();
    harness.view.dispose();
  });
});
