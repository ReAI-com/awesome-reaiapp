import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { releaseLocaleBindings, setVoiceLocale, t } from "../src/voice-i18n";
import type { KeyValueStore, VoiceReplayCacheStatus, VoiceReplayRetention } from "@reai/app-sdk/v1";
import {
  createDefaultVoiceViewState,
  DEFAULT_SETTINGS,
  isReplayAvailable,
  replayCacheWithClip,
  replayPresentationRange,
  VoiceStateRepository,
  type VoiceHistoryItem,
  type VoiceViewState,
} from "../src/data";
import {
  mountVoiceView,
  waveformHeightsFromWav,
  type VoiceViewActions,
} from "../src/voice-view";

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
afterEach(() => { releaseLocaleBindings(document.body); setVoiceLocale("zh"); });

function historyItem(overrides: Partial<VoiceHistoryItem> = {}): VoiceHistoryItem {
  return {
    id: "2026-08-17T02:00:00.000Z-item",
    transcript: "把这段话写进当前应用",
    language: "auto",
    source: "board",
    inserted: true,
    durationMs: 4_200,
    createdAt: "2026-08-17T02:00:00.000Z",
    recordingId: "voice-input-abc",
    recordingWallStartMs: 5_000,
    ...overrides,
  };
}

function replayCache(overrides: Partial<VoiceReplayCacheStatus> = {}): VoiceReplayCacheStatus {
  return {
    retention: "24h",
    clipCount: 3,
    usedBytes: 12 * 1024 * 1024,
    retainedSinceMs: 1_000,
    ...overrides,
  };
}

interface Harness {
  root: HTMLElement;
  openSettings(): void;
  navigateRoot(): void;
  update(state: VoiceViewState): void;
  dispose(): void;
  loaded: string[];
  retentions: VoiceReplayRetention[];
  retried: Array<{ historyId: string; recordingId: string }>;
  cleared: number;
  state: VoiceViewState;
}

function mount(overrides: Partial<VoiceViewState> = {}): Harness {
  const root = document.createElement("div");
  document.body.append(root);
  const loaded: string[] = [];
  const retentions: VoiceReplayRetention[] = [];
  const harness: Harness = {
    root,
    openSettings: () => undefined,
    navigateRoot: () => undefined,
    update: () => undefined,
    dispose: () => undefined,
    loaded,
    retentions,
    retried: [],
    cleared: 0,
    state: createDefaultVoiceViewState(overrides),
  };
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onRefresh: async () => undefined,
    onSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onDeleteRecording: async () => undefined,
    onRetryInputTranscription: async (historyId: string, recordingId: string) => {
      harness.retried.push({ historyId, recordingId });
    },
    onSendContextToAgent: async () => undefined,
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
    onLoadReplayAudio: async (recordingId: string) => {
      loaded.push(recordingId);
      return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
    },
    onReplayRetentionChanged: async (retention: VoiceReplayRetention) => {
      retentions.push(retention);
    },
    onClearReplayCache: async () => {
      harness.cleared += 1;
    },
  } as unknown as VoiceViewActions;
  const view = mountVoiceView(root, harness.state, actions);
  harness.openSettings = () => view.openSettings();
  harness.navigateRoot = () => view.navigateRoot();
  harness.update = (next) => view.update(next);
  harness.dispose = () => view.dispose();
  return harness;
}

function openDetail(harness: Harness): void {
  const row = harness.root.querySelector(".task-item") as HTMLButtonElement;
  row.click();
}

describe("回听片段与历史条目的关联", () => {
  test("新的重试面板原地切换语言，保留原始方案、转写语言和未提交操作", () => {
    const item = historyItem({ transcript: "", transcriptionStatus: "failed", requestedEngine: "cloud",
      originalSelection: { engine: "cloud", modelId: "original-cloud", modelName: "原始模型", language: "zh-CN", punctEnabled: true },
      savedInput: { attemptId: "retry", revision: 1, state: "no_speech", selection: { engine: "local", modelId: "local-model", modelName: "本次模型", language: "en-US", punctEnabled: true }, startedAtMs: 1 },
    });
    const original = structuredClone(item);
    const harness = mount({ history: [item], replayCache: replayCache(), settings: { ...DEFAULT_SETTINGS, language: "ja", engine: "cloud" } });
    openDetail(harness);
    try {
      const panel = harness.root.querySelector(".voice-retry-panel")!;
      const button = panel.querySelector<HTMLButtonElement>(".voice-retry-button")!;
      button.focus();
      for (const locale of ["en", "zh"] as const) {
        setVoiceLocale(locale);
        expect(harness.root.querySelector(".voice-retry-panel")).toBe(panel);
        expect(panel.querySelector("[role=status]")?.textContent).toBe(t("view.noClearSpeechWasDetectedTryAgain"));
        expect(button.textContent).toBe(t("view.transcribeAgainCloud"));
        expect(document.activeElement).toBe(button);
        expect(harness.root.textContent).toContain("原始模型");
        expect(harness.root.textContent).toContain("本次模型");
        expect(harness.root.textContent).toContain("zh-CN");
        expect(harness.state.settings.language).toBe("ja");
        expect(item).toEqual(original);
        expect(harness.retried).toEqual([]);
      }
    } finally { harness.dispose(); }
  });
  test("同一录音完成后替换恢复占位，迟到的恢复轮询不能覆盖正文", async () => {
    const values = new Map<string, unknown>();
    const store: KeyValueStore = {
      compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
      get: async <T>(key: string) => values.get(key) as T | undefined,
      set: async (key, value) => { values.set(key, value); },
      delete: async key => { values.delete(key); },
      keys: async () => [...values.keys()],
    };
    const repository = new VoiceStateRepository(store);
    const failed = historyItem({ id: "recovered", transcript: "", inserted: false, transcriptionStatus: "failed" });
    await repository.appendHistory(failed);
    await repository.appendHistory(historyItem({ id: "successful", recognitionEngine: "cloud" }));
    expect((await repository.load()).history).toHaveLength(1);
    await repository.restoreHistoryItem(failed, repository.historyGeneration);
    const history = (await repository.load()).history!;
    expect(history).toHaveLength(1);
    expect(history[0]?.id).toBe("successful");
    expect(history[0]?.transcriptionStatus).toBeUndefined();
    expect(history[0]?.transcript).toBe("把这段话写进当前应用");
  });
  test("失败状态与转写正文分开，旧失败记录不能沿用误存的本地来源", () => {
    const harness = mount({ history: [historyItem({
      transcript: "", inserted: false, transcriptionStatus: "failed", recognitionEngine: "local",
    })], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.querySelector(".input-detail-text")).toBeNull();
    expect(harness.root.querySelector(".input-detail-meta")).toBeNull();
    expect(harness.root.querySelector(".input-detail-facts")).toBeNull();
    expect(harness.root.querySelector(".voice-retry-panel [role=status]")?.textContent).toContain("未生成文本");
    expect(harness.root.querySelector(".voice-retry-panel")?.textContent).toContain("未记录");
    expect(harness.root.textContent).not.toContain("仅在这台电脑上完成转写");
    harness.dispose();
  });
  test("云端失败保留尝试方式，重试按钮明确使用当前云端选择", () => {
    const harness = mount({ settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, history: [historyItem({
      transcript: "", inserted: false, transcriptionStatus: "failed", requestedEngine: "cloud",
    })], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.querySelector(".voice-retry-source")?.textContent).toContain("云端识别");
    expect(harness.root.querySelector(".detail-primary-action")?.textContent).toBe("使用云端重新转写");
    expect(harness.root.querySelector(".input-detail-text")).toBeNull();
    harness.dispose();
  });
  test("进行中的保存录音尝试使用状态面板，原始方案与本次尝试不混淆", () => {
    const harness = mount({ history: [historyItem({ transcript: "", transcriptionStatus: "pending", requestedEngine: "cloud",
      originalSelection: { engine: "cloud", modelId: "transcribe-free", modelName: "录音时的云模型", language: "auto", punctEnabled: true },
      savedInput: { attemptId: "retry", revision: 1, state: "pending", selection: { engine: "local", modelId: "local-model", modelName: "本次的本地模型", language: "auto", punctEnabled: true }, startedAtMs: 1 },
    })], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.querySelector(".input-detail-selection")?.textContent).toContain("录音时的云模型");
    expect(harness.root.querySelector(".voice-retry-source")?.textContent).toContain("本地识别");
    expect(harness.root.querySelector(".voice-retry-panel [role=status]")?.textContent).toContain("正在转写");
    expect(harness.root.querySelector(".input-detail-text")).toBeNull();
    expect(harness.root.querySelector(".detail-primary-action")?.textContent).toBe("取消");
    harness.dispose();
  });
  test("历史时长与实际回放的气口区间一致，旧 Host 回退 raw 边界", () => {
    expect(
      replayPresentationRange({
        id: "voice-input-effective",
        wallStartMs: 10_000,
        durationMs: 8_000,
        effectiveStartMs: 12_000,
        effectiveEndMs: 15_000,
      }),
    ).toEqual({ wallStartMs: 12_000, durationMs: 3_000 });
    expect(
      replayPresentationRange({
        id: "voice-input-legacy",
        wallStartMs: 10_000,
        durationMs: 8_000,
      }),
    ).toEqual({ wallStartMs: 10_000, durationMs: 8_000 });
  });

  test("按 Esc 保存但未转写的录音在原历史详情里提供重新转写", async () => {
    const item = historyItem({
      transcript: "",
      inserted: false,
      transcriptionStatus: "not_requested",
      stopReason: "user_cancel",
    });
    const harness = mount({
      history: [item],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(harness);
    expect(harness.root.textContent).toContain("已取消转写，录音仍然保留");
    const retry = harness.root.querySelector(".detail-primary-action") as HTMLButtonElement;
    expect(retry.textContent).toBe("使用本地重新转写");
    retry.click();
    await Promise.resolve();
    expect(harness.retried).toEqual([{ historyId: item.id, recordingId: "voice-input-abc" }]);
    harness.dispose();
  });

  test("片段起点不早于保留下沿就还能听，早于就只剩文字", () => {
    const cache = replayCache({ retainedSinceMs: 5_000 });
    expect(isReplayAvailable(historyItem({ recordingWallStartMs: 5_000 }), cache)).toBeTrue();
    expect(isReplayAvailable(historyItem({ recordingWallStartMs: 4_999 }), cache)).toBeFalse();
  });

  test("没有片段引用、缓存已空或状态未加载，都算听不到", () => {
    expect(
      isReplayAvailable(
        historyItem({ recordingId: undefined, recordingWallStartMs: undefined }),
        replayCache(),
      ),
    ).toBeFalse();
    expect(isReplayAvailable(historyItem(), replayCache({ retainedSinceMs: null }))).toBeFalse();
    // 还没读到「录音缓存」状态之前不假装能播——按下去只会得到一次失败。
    expect(isReplayAvailable(historyItem(), undefined)).toBeFalse();
    // 起点跑到「现在」之后是时钟前跳留下的坏数据，Host 会清掉，判据要跟着走。
    expect(
      isReplayAvailable(
        historyItem({ recordingWallStartMs: 9_000 }),
        replayCache({ retainedSinceMs: 1_000 }),
        8_000,
      ),
    ).toBeFalse();
    expect(
      isReplayAvailable(
        historyItem({ recordingWallStartMs: 9_000 }),
        replayCache({ retainedSinceMs: 1_000 }),
        10_000,
      ),
    ).toBeTrue();
  });

  test("历史落盘会把片段引用一起留下，缺了起点就整对丢弃", async () => {
    const data = new Map<string, unknown>();
    const store: KeyValueStore = {
      compareAndSet: async () => { throw new Error("CAS is not expected in this Voice test"); },
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
    const repository = new VoiceStateRepository(store);
    await repository.appendHistory(historyItem());
    const [kept] = await repository.appendHistory(
      historyItem({ id: "second", recordingWallStartMs: undefined }),
    );
    expect(kept?.recordingId).toBeUndefined();
    const reloaded = (await repository.load()).history ?? [];
    const withClip = reloaded.find((item) => item.id !== "second");
    expect(withClip?.recordingId).toBe("voice-input-abc");
    expect(withClip?.recordingWallStartMs).toBe(5_000);
  });
});

describe("Voice Input 详情页的播放条", () => {
  test("详情结构逐项对齐设计稿，不再沿用旧的大卡片与五行元数据", () => {
    const harness = mount({
      history: [historyItem({ transcript: "下周的设计评审会议改到周四下午三点", language: "zh-CN" })],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(harness);

    expect(harness.root.querySelector(".input-detail-header")).not.toBeNull();
    expect(harness.root.querySelector(".input-detail-avatar")?.textContent).toBe("🎙️");
    expect(harness.root.querySelector(".input-detail-avatar")?.getAttribute("aria-hidden")).toBe("true");
    const transcript = harness.root.querySelector(".input-detail-text");
    expect(transcript?.textContent).toBe("下周的设计评审会议改到周四下午三点");
    expect(transcript?.classList.contains("detail-transcript")).toBeFalse();
    expect(harness.root.querySelector(".metadata-grid")).toBeNull();
    expect(
      Array.from(harness.root.querySelectorAll(".input-detail-tag")).map((node) => node.textContent),
    ).toEqual(["17 字", "zh-CN"]);
    expect(harness.root.querySelector(".input-detail-engine-icon svg")).not.toBeNull();
    harness.dispose();
  });

  test("能听时是播放条，点一下就去取件", () => {
    const createObjectURL = mock(() => "blob:replay");
    const revokeObjectURL = mock(() => undefined);
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

    const harness = mount({
      history: [historyItem()],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(harness);

    const bar = harness.root.querySelector(".replay-bar");
    expect(bar).not.toBeNull();
    // 播放条排在转写文本之前：先是那段声音，底下才是它变成的文字。
    expect(bar?.nextElementSibling?.classList.contains("input-detail-text")).toBeTrue();
    // 波形按录音 id 生成定值，同一条每次打开都一样。
    const bars = harness.root.querySelectorAll(".replay-wave i");
    expect(bars.length).toBe(58);
    const firstHeights = Array.from(bars).map((node) => (node as HTMLElement).style.height);
    expect(harness.root.querySelector(".replay-time")?.textContent).toBe("加载音频…");

    const play = harness.root.querySelector(".replay-play") as HTMLButtonElement;
    expect(play.getAttribute("aria-label")).toBe("回听这段录音");
    play.click();
    expect(harness.loaded).toEqual(["voice-input-abc"]);

    harness.dispose();
    const second = mount({
      history: [historyItem()],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(second);
    const secondHeights = Array.from(second.root.querySelectorAll(".replay-wave i")).map(
      (node) => (node as HTMLElement).style.height,
    );
    expect(secondHeights).toEqual(firstHeights);
    second.dispose();
  });

  test("打开详情就预取本地音频，让真正的点击只负责同步播放", async () => {
    const originalAudio = globalThis.Audio;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    class AudioStub extends EventTarget {
      paused = true;
      currentTime = 0;
      preload = "";
      constructor(_url: string) {
        super();
      }
      async play() {
        this.paused = false;
        this.dispatchEvent(new Event("play"));
      }
      pause() {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      }
    }
    let harness: Harness | undefined;
    try {
      globalThis.Audio = AudioStub as unknown as typeof Audio;
      URL.createObjectURL = () => "blob:prefetched";
      URL.revokeObjectURL = () => undefined;
      harness = mount({
        history: [historyItem()],
        replayCache: replayCache({ retainedSinceMs: 1_000 }),
      });
      openDetail(harness);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.loaded).toEqual(["voice-input-abc"]);
      expect((harness.root.querySelector(".replay-play") as HTMLButtonElement).disabled).toBeFalse();
      expect((harness.root.querySelector(".replay-error") as HTMLElement).hidden).toBeTrue();
    } finally {
      harness?.dispose();
      globalThis.Audio = originalAudio;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("波形高度来自 WAV 样本，不再只按录音 id 画装饰条", () => {
    const samples = new Int16Array([0, 200, -400, 800, -1_600, 3_200, -6_400, 12_800]);
    const wav = new Uint8Array(44 + samples.byteLength);
    const view = new DataView(wav.buffer);
    wav.set(new TextEncoder().encode("RIFF"), 0);
    wav.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16_000, true);
    view.setUint16(34, 16, true);
    wav.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, samples.byteLength, true);
    new Int16Array(wav.buffer, 44).set(samples);

    const heights = waveformHeightsFromWav(wav.buffer as ArrayBuffer, 4);
    expect(heights).toHaveLength(4);
    expect(heights[3]).toBeGreaterThan(heights[0] ?? 0);
    expect(new Set(heights).size).toBeGreaterThan(1);
  });

  test("过期只留一句说明，不留点不动的播放键；文字照常在", () => {
    const harness = mount({
      history: [historyItem({ recordingWallStartMs: 10 })],
      replayCache: replayCache({ retainedSinceMs: 5_000 }),
    });
    openDetail(harness);

    expect(harness.root.querySelector(".replay-bar")).toBeNull();
    const gone = harness.root.querySelector(".replay-gone");
    expect(gone?.textContent).toContain("录音已过期");
    expect(gone?.textContent).toContain("设置 › 录音缓存");
    expect(harness.root.textContent).toContain("把这段话写进当前应用");
    harness.dispose();
  });
});

describe("播放键的状态不依赖那一颗按钮活着", () => {
  test("取件期间发生重渲染，新按钮接得上加载态，落地后自己恢复可点", async () => {
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:replay";
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => undefined;

    let release: ((blob: Blob) => void) | undefined;
    const root = document.createElement("div");
    document.body.append(root);
    const base = createDefaultVoiceViewState({
      history: [historyItem()],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    const view = mountVoiceView(root, base, {
      onToggle: async () => undefined,
      onCommandToggle: async () => undefined,
      onOpenSystemTask: async () => undefined,
      onRefresh: async () => undefined,
      onSettingsChanged: async () => undefined,
      onDownloadModel: async () => undefined,
      onCancelModelDownload: async () => undefined,
      onRequestPermission: async () => undefined,
      onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
      onDeleteRecording: async () => undefined,
      onSendContextToAgent: async () => undefined,
      onRegenerateDayDigest: async () => undefined,
      onSendDayDigestToAgent: async () => undefined,
      onSummarizeSegment: async () => undefined,
      onMarkCommandRead: async () => undefined,
      onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
      onLoadReplayAudio: async () =>
        await new Promise<Blob>((resolve) => {
          release = resolve;
        }),
      onReplayRetentionChanged: async () => undefined,
      onClearReplayCache: async () => undefined,
    } as unknown as VoiceViewActions);

    (root.querySelector(".task-item") as HTMLButtonElement).click();
    (root.querySelector(".replay-play") as HTMLButtonElement).click();
    expect((root.querySelector(".replay-play") as HTMLButtonElement).disabled).toBeTrue();

    // 取件还在飞的时候来一次外部状态更新（真实链路里由 1 秒轮询/其它 publish 触发）。
    view.update({ ...base });
    const rerendered = root.querySelector(".replay-play") as HTMLButtonElement;
    expect(rerendered.disabled).toBeTrue();

    release?.(new Blob([new Uint8Array([1])], { type: "audio/wav" }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 收尾逻辑必须够得着页面上现在那颗按钮，否则用户只能点一次就再也点不动。
    expect((root.querySelector(".replay-play") as HTMLButtonElement).disabled).toBeFalse();
    view.dispose();
  });
});

describe("离开这一条就把声音收掉", () => {
  test("返回列表、去设置页、卸载，三条路都会收掉正在放的录音", async () => {
    const revoked: string[] = [];
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => "blob:replay";
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = (url: string) => {
      revoked.push(url);
    };

    const paths: Array<(h: Harness) => void> = [
      /* B5-14：页内返回钮撤除，「返回列表」由 Host 面包屑（navigateRoot）承载。 */
      (h) => h.navigateRoot(),
      (h) => h.openSettings(),
      (h) => h.dispose(),
    ];
    for (const leave of paths) {
      revoked.length = 0;
      const harness = mount({
        history: [historyItem()],
        replayCache: replayCache({ retainedSinceMs: 1_000 }),
      });
      openDetail(harness);
      (harness.root.querySelector(".replay-play") as HTMLButtonElement).click();
      // 等取件落地，音频与 blob URL 真的建起来之后再走开。
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      leave(harness);
      // 走开就必须收掉 blob，否则用户会在别的页面听见一段找不到来源的录音。
      expect(revoked).toEqual(["blob:replay"]);
    }
  });
});

describe("播放器按真实媒体时间定位", () => {
  function seekAudioClass() { return class SeekAudio extends EventTarget {
    paused = true;
    currentTime = 0;
    duration = Number.NaN;
    preload = "";
    error: { code: number; message: string } | null = null;
    playCalls = 0;
    rejectPlay?: (reason: unknown) => void;
    deferPlay = false;
    constructor(_url: string) { super(); audios.push(this); }
    play() {
      this.playCalls++;
      this.paused = false;
      this.dispatchEvent(new Event("play"));
      return this.deferPlay
        ? new Promise<void>((_resolve, reject) => { this.rejectPlay = reject; })
        : Promise.resolve();
    }
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); }
    metadata(duration: number) { this.duration = duration; this.dispatchEvent(new Event("loadedmetadata")); }
  }; }
  let audios: Array<InstanceType<ReturnType<typeof seekAudioClass>>>;
  let harness: Harness;
  let originalAudio: typeof Audio;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const slider = () => harness.root.querySelector<HTMLInputElement>(".replay-seek")!;
  beforeEach(async () => {
    audios = [];
    originalAudio = globalThis.Audio;
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    globalThis.Audio = seekAudioClass() as unknown as typeof Audio;
    URL.createObjectURL = () => `blob:seek-${audios.length}`;
    URL.revokeObjectURL = () => undefined;
    harness = mount({ history: [historyItem()], replayCache: replayCache() });
    openDetail(harness);
    await flush();
  });
  afterEach(() => {
    harness.dispose();
    globalThis.Audio = originalAudio;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  test("metadata 决定真实总时长，未就绪不能定位；timeupdate 同步时间和已播波形", () => {
    expect(slider()).not.toBeNull();
    expect(slider().disabled).toBeTrue();
    audios[0].metadata(768);
    expect(slider().disabled).toBeFalse();
    expect(slider().max).toBe("768");
    audios[0].currentTime = 388.7;
    audios[0].dispatchEvent(new Event("timeupdate"));
    expect(harness.root.querySelector(".replay-time")?.textContent).toBe("6:28 / 12:48");
    expect(Number(slider().value)).toBeCloseTo(388.7);
    expect(harness.root.querySelectorAll(".replay-wave i.played").length).toBe(30);
    audios[0].metadata(Number.POSITIVE_INFINITY);
    expect(slider().disabled).toBeTrue();
  });

  test("语言切换保留正在播放的 Audio、游标、节点、焦点和原始转写", () => {
    const audio = audios[0];
    audio.metadata(100);
    const button = harness.root.querySelector<HTMLButtonElement>(".replay-play")!;
    button.click();
    audio.currentTime = 42;
    audio.dispatchEvent(new Event("timeupdate"));
    const seek = slider();
    seek.focus();
    const body = harness.root.querySelector<HTMLElement>(".main-body")!;
    body.scrollTop = 113;
    for (const locale of ["en", "zh"] as const) {
      setVoiceLocale(locale);
      expect(button.getAttribute("aria-label")).toBe(t("view.pausePlayback"));
      expect(harness.root.querySelector(".replay-play")).toBe(button);
      expect(slider()).toBe(seek);
      expect(document.activeElement).toBe(seek);
      expect(body.scrollTop).toBe(113);
      expect(harness.root.querySelector(".input-detail-text")?.textContent).toBe(historyItem().transcript);
      expect(audio.currentTime).toBe(42);
      expect(audio.paused).toBeFalse();
      expect(audio.playCalls).toBe(1);
      expect(audios).toEqual([audio]);
      expect(harness.loaded).toEqual(["voice-input-abc"]);
    }
  });

  test("解码失败在已有节点中使用当前语言并保留原始媒体诊断", () => {
    const audio = audios[0];
    audio.error = { code: 3, message: "raw decoder diagnostic {language}" };
    const originalConsoleError = console.error;
    const reported: unknown[][] = [];
    console.error = (...args: unknown[]) => { reported.push(args); };
    try {
      audio.dispatchEvent(new Event("error"));
      const error = harness.root.querySelector<HTMLElement>(".replay-error")!;
      for (const locale of ["zh", "en", "zh"] as const) {
        setVoiceLocale(locale);
        expect(error.textContent).toBe(t("view.audioCouldNotBeDecodedReopenThis"));
        expect(harness.root.querySelector(".replay-error")).toBe(error);
        expect(error.hidden).toBeFalse();
        expect(error.textContent).not.toContain(audio.error.message);
      }
      // Host 日志只收结构化投影（登记过的码、原文字符数），原始媒体诊断文字留在内存供页面展开。
      const logged = JSON.stringify(reported);
      expect(logged).toContain("MediaError code 3");
      expect(logged).not.toContain(audio.error.message);
      expect(audios).toEqual([audio]);
      expect(audio.playCalls).toBe(0);
      expect(harness.loaded).toEqual(["voice-input-abc"]);
    } finally { console.error = originalConsoleError; }
  });

  test("普通模式隐藏第三方播放错误原文，失败提示随界面语言更新", async () => {
    const audio = audios[0];
    audio.deferPlay = true;
    harness.root.querySelector<HTMLButtonElement>(".replay-play")!.click();
    const original = "provider 原始提示 {locale} <b>detail</b>";
    audio.rejectPlay?.({ userMessage: original });
    await flush();
    const error = harness.root.querySelector(".replay-error")!;
    setVoiceLocale("en");
    expect(error.textContent).toBe("Audio could not play. Reopen this recording and try again.");
    expect(error.textContent).not.toContain(original);
    expect(error.querySelector("b")).toBeNull();
    expect(audio.playCalls).toBe(1);
  });

  test("暂停定位保持暂停；播放定位继续播放；重渲染保留同一个 Audio 和游标", () => {
    audios[0].metadata(100);
    slider().value = "42";
    slider().dispatchEvent(new Event("input", { bubbles: true }));
    expect(audios[0].currentTime).toBe(42);
    expect(audios[0].paused).toBeTrue();
    slider().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(audios[0].currentTime).toBe(43);
    (harness.root.querySelector(".replay-play") as HTMLButtonElement).click();
    slider().value = "75";
    slider().dispatchEvent(new Event("input", { bubbles: true }));
    expect(audios[0].currentTime).toBe(75);
    expect(audios[0].paused).toBeFalse();
    slider().focus();
    harness.update({ ...harness.state });
    expect(audios.length).toBe(1);
    expect(Number(slider().value)).toBe(75);
    expect(document.activeElement === slider()).toBeTrue();
    expect(harness.loaded).toEqual(["voice-input-abc"]);
  });

  test("结束停在末端，下一次播放从头开始", () => {
    audios[0].metadata(8);
    audios[0].currentTime = 8;
    audios[0].dispatchEvent(new Event("ended"));
    expect(audios[0].currentTime).toBe(8);
    expect(Number(slider().value)).toBe(8);
    (harness.root.querySelector(".replay-play") as HTMLButtonElement).click();
    expect(audios[0].currentTime).toBe(0);
    expect(audios[0].paused).toBeFalse();
  });

  test("拖动期间轮询不替换 range；松开补绘；过期立即中断拖动并释放录音", () => {
    audios[0].metadata(100);
    const active = slider();
    active.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, bubbles: true }));
    harness.update({ ...harness.state });
    expect(slider() === active).toBeTrue();
    active.value = "61";
    active.dispatchEvent(new Event("input", { bubbles: true }));
    audios[0].currentTime = 62;
    audios[0].dispatchEvent(new Event("timeupdate"));
    expect(Number(active.value)).toBe(61);
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(slider() === active).toBeFalse();
    expect(Number(slider().value)).toBe(62);
    slider().dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, button: 0, bubbles: true }));
    harness.update({ ...harness.state, replayCache: replayCache({ retainedSinceMs: 6_000 }) });
    expect(harness.root.querySelector(".replay-seek")).toBeNull();
    expect(harness.root.querySelector(".replay-gone")?.textContent).toContain("录音已过期");
    expect(audios[0].paused).toBeTrue();
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
    expect(harness.root.querySelector(".replay-seek")).toBeNull();
  });

  test("离页后同一录音重开，旧 play 拒绝和媒体事件不能污染新播放器", async () => {
    const old = audios[0];
    old.metadata(90);
    old.deferPlay = true;
    (harness.root.querySelector(".replay-play") as HTMLButtonElement).click();
    harness.navigateRoot();
    openDetail(harness);
    await flush();
    audios[1].metadata(90);
    audios[1].currentTime = 12;
    audios[1].dispatchEvent(new Event("timeupdate"));
    old.rejectPlay?.(new Error("old playback failure"));
    old.dispatchEvent(new Event("error"));
    old.dispatchEvent(new Event("ended"));
    await flush();
    expect(old.paused).toBeTrue();
    expect(Number(slider().value)).toBe(12);
    expect((harness.root.querySelector(".replay-error") as HTMLElement).hidden).toBeTrue();
  });
});

describe("刚录完那条", () => {
  test("缓存原本为空时也判定为能听，不说「已过期」", () => {
    const clip = { id: "voice-input-new", wallStartMs: 9_000, durationMs: 3_000 };
    const empty = replayCache({ clipCount: 0, usedBytes: 0, retainedSinceMs: null });
    const merged = replayCacheWithClip(empty, clip);
    expect(merged?.retainedSinceMs).toBe(9_000);
    expect(merged?.clipCount).toBe(1);
    expect(merged?.usedBytes).toBe(3_000 * 32);
    expect(
      isReplayAvailable(
        historyItem({ recordingId: clip.id, recordingWallStartMs: clip.wallStartMs }),
        merged,
      ),
    ).toBeTrue();

    // 没落下片段就别动缓存状态；缓存还没读到时也不凭空造一个。
    expect(replayCacheWithClip(empty, null)).toBe(empty);
    expect(replayCacheWithClip(undefined, clip)).toBeUndefined();
  });

  test("预取失败会显示原因；重试时一次点击就取件并开始播放", async () => {
    const originalAudio = globalThis.Audio;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const play = mock(async function (this: { paused: boolean; dispatchEvent(event: Event): boolean }) {
      this.paused = false;
      this.dispatchEvent(new Event("play"));
    });
    class AudioStub extends EventTarget {
      paused = true;
      currentTime = 0;
      preload = "";
      constructor(_url: string) {
        super();
      }
      play = play;
      pause() {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      }
    }
    let loadCount = 0;
    const root = document.createElement("div");
    document.body.append(root);
    let mountedView: ReturnType<typeof mountVoiceView> | undefined;
    try {
      globalThis.Audio = AudioStub as unknown as typeof Audio;
      URL.createObjectURL = () => "blob:retry";
      URL.revokeObjectURL = () => undefined;
      mountedView = mountVoiceView(
        root,
        createDefaultVoiceViewState({
          history: [historyItem()],
          replayCache: replayCache({ retainedSinceMs: 1_000 }),
        }),
        {
          onToggle: async () => undefined,
          onCommandToggle: async () => undefined,
          onOpenSystemTask: async () => undefined,
          onRefresh: async () => undefined,
          onSettingsChanged: async () => undefined,
          onDownloadModel: async () => undefined,
          onCancelModelDownload: async () => undefined,
          onRequestPermission: async () => undefined,
          onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
          onDeleteRecording: async () => undefined,
          onSendContextToAgent: async () => undefined,
          onRegenerateDayDigest: async () => undefined,
          onSendDayDigestToAgent: async () => undefined,
          onSummarizeSegment: async () => undefined,
          onMarkCommandRead: async () => undefined,
          onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
          onLoadReplayAudio: async () => {
            loadCount += 1;
            if (loadCount === 1) throw new Error("录音暂时读不到");
            return new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" });
          },
          onReplayRetentionChanged: async () => undefined,
          onClearReplayCache: async () => undefined,
        } as unknown as VoiceViewActions,
      );
      (root.querySelector(".task-item") as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      let button = root.querySelector(".replay-play") as HTMLButtonElement;
      expect(button.disabled).toBeFalse();
      expect(button.getAttribute("aria-label")).toBe("回听这段录音");
      expect(root.querySelector(".replay-error")?.textContent).toBe("音频无法播放，请重新打开这条记录后再试");
      expect(root.querySelector(".replay-time")?.textContent).toBe("音频不可用");

      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      button = root.querySelector(".replay-play") as HTMLButtonElement;
      expect(loadCount).toBe(2);
      expect(play).toHaveBeenCalledTimes(1);
      expect(button.getAttribute("aria-label")).toBe("暂停回听");
      expect((root.querySelector(".replay-error") as HTMLElement).hidden).toBeTrue();
    } finally {
      mountedView?.dispose();
      globalThis.Audio = originalAudio;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test("媒体未就绪时不把片段或采集时长当作播放时钟", () => {
    const harness = mount({
      history: [historyItem({ durationMs: 6_000, recordingDurationMs: 4_000 })],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(harness);
    // 未获得媒体 metadata 时不能拿历史/片段时长冒充真实播放时钟。
    expect(harness.root.querySelector(".replay-time")?.textContent).toBe("加载音频…");
    harness.dispose();
  });

  test("从来没录上和录过但过期了，说的是两句话", () => {
    const never = mount({
      history: [historyItem({ recordingId: undefined, recordingWallStartMs: undefined })],
      replayCache: replayCache({ retention: "4h", clipCount: 0, retainedSinceMs: null }),
    });
    openDetail(never);
    expect(never.root.querySelector(".replay-gone")?.textContent).toContain("这条没有留下录音");
    expect(never.root.querySelector(".replay-gone")?.textContent).not.toContain("录音已过期");
    never.dispose();
  });
});

describe("设置里的「录音缓存」", () => {
  test("只有四档保留时长 + 占用 + 清空，没有别的回听开关", () => {
    const harness = mount({ replayCache: replayCache() });
    const view = mountedSettings(harness);

    const labels = Array.from(view.querySelectorAll("[data-replay-retention]")).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["4 小时", "24 小时", "7 天", "30 天"]);
    expect(view.textContent).toContain("已占用");
    expect(view.textContent).toContain("最近一天的录音 · 超过保留时长的会自动清掉");
    expect(view.textContent).toContain("立刻清空语音记录");
    // 回听不是开关：整页不该出现任何以「回听」命名的功能开关。
    expect(harness.root.textContent).not.toContain("输入时回听");
    harness.dispose();
  });

  test("选一档就落到 Host，清空是单独一条", () => {
    const harness = mount({ replayCache: replayCache() });
    const view = mountedSettings(harness);
    (view.querySelector('[data-replay-retention="7d"]') as HTMLButtonElement).click();
    expect(harness.retentions).toEqual(["7d"]);
    const clear = view.querySelector(".settings-row-danger") as HTMLButtonElement;
    expect(clear.disabled).toBeFalse();
    clear.click();
    expect(harness.cleared).toBe(1);
    harness.dispose();
  });

  test("最短档是 4 小时，并说明超时自动清理", () => {
    const harness = mount({
      replayCache: replayCache({ retention: "4h", clipCount: 0, usedBytes: 0 }),
    });
    const view = mountedSettings(harness);
    expect(view.textContent).toContain("最近四小时的录音 · 超过保留时长的会自动清掉");
    expect(view.textContent).toContain("0 KB");
    expect(view.textContent).not.toContain("不保留");
    harness.dispose();
  });

  test("说明收在标题旁的问号里，默认收起", () => {
    const harness = mount({ replayCache: replayCache() });
    const view = mountedSettings(harness);
    // 浮层默认不进正文；点击后 Teleport 到 body，不改变设置卡几何。
    const hint = view.querySelector<HTMLButtonElement>(
      ".settings-section-heading .settings-hint-trigger",
    );
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    hint?.click();
    const body = document.body.querySelector('[role="tooltip"]');
    expect(hint?.querySelector("svg")).not.toBeNull();
    expect(body?.textContent).toContain("它管的是声音，不是文字");
    expect(body?.textContent).toContain("录音只存在这台电脑上，不上传。");
    harness.dispose();
  });
});

describe("详情页页头", () => {
  test("B5-14：页内返回钮已撤除，页头只剩身份区（返回走 Host 面包屑）", () => {
    const harness = mount({
      history: [historyItem()],
      replayCache: replayCache({ retainedSinceMs: 1_000 }),
    });
    openDetail(harness);
    const header = harness.root.querySelector(".detail-header") as HTMLElement;
    expect(harness.root.querySelector(".back-button")).toBeNull();
    expect(header.firstElementChild?.classList.contains("detail-identity")).toBeTrue();
    harness.dispose();
  });
});

describe("详情页开着时的自动转移也要收掉回听", () => {
  /** 带 AudioStub / blob URL 记录的播放中 harness：返回后记得还原全局。 */
  function playingHarness(
    state: Partial<VoiceViewState>,
    revoked: string[],
  ): { harness: Harness; audio: () => { paused: boolean } | undefined; restore: () => void } {
    const originalAudio = globalThis.Audio;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let playing: { paused: boolean } | undefined;
    class AudioStub extends EventTarget {
      paused = true;
      currentTime = 0;
      preload = "";
      constructor(_url: string) {
        super();
        playing = this;
      }
      async play() {
        this.paused = false;
        this.dispatchEvent(new Event("play"));
      }
      pause() {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      }
    }
    globalThis.Audio = AudioStub as unknown as typeof Audio;
    URL.createObjectURL = () => "blob:auto-transition";
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    const harness = mount(state);
    return {
      harness,
      audio: () => playing,
      restore: () => {
        harness.dispose();
        globalThis.Audio = originalAudio;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
      },
    };
  }

  async function startPlayback(harness: Harness): Promise<void> {
    openDetail(harness);
    // 先等预取落地（加载期间播放键是禁用的，禁用键收不到 click），再按播放。
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    (harness.root.querySelector(".replay-play") as HTMLButtonElement).click();
    // play() 的许可与状态同步逐级落在微任务里。
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }

  test("录音在播放中到期：停声、回收 blob URL，播放条换成过期说明", async () => {
    const revoked: string[] = [];
    const { harness, audio, restore } = playingHarness(
      { history: [historyItem()], replayCache: replayCache({ retainedSinceMs: 1_000 }) },
      revoked,
    );
    try {
      await startPlayback(harness);
      expect(audio()?.paused).toBeFalse();
      // 保留时长推进或配额淘汰：这条的起点掉出保留下沿，update 触发详情页重渲染。
      harness.update(
        createDefaultVoiceViewState({
          history: [historyItem()],
          replayCache: replayCache({ retainedSinceMs: 6_000 }),
        }),
      );
      expect(audio()?.paused).toBeTrue();
      expect(revoked).toEqual(["blob:auto-transition"]);
      expect(harness.root.querySelector(".replay-bar")).toBeNull();
      expect(harness.root.querySelector(".replay-gone")?.textContent).toContain("录音已过期");
    } finally {
      restore();
    }
  });

  test("这条被新记录挤出历史上限：自动退回列表，不留没有控件的后台声音", async () => {
    const revoked: string[] = [];
    const { harness, audio, restore } = playingHarness(
      { history: [historyItem()], replayCache: replayCache({ retainedSinceMs: 1_000 }) },
      revoked,
    );
    try {
      await startPlayback(harness);
      expect(audio()?.paused).toBeFalse();
      // 200 条上限裁掉当前这条：详情页的 item 消失，update 自动落回历史列表。
      harness.update(
        createDefaultVoiceViewState({
          history: [],
          replayCache: replayCache({ retainedSinceMs: 1_000 }),
        }),
      );
      expect(audio()?.paused).toBeTrue();
      expect(revoked).toEqual(["blob:auto-transition"]);
      expect(harness.root.querySelector(".input-detail")).toBeNull();
      expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    } finally {
      restore();
    }
  });
});

/** 打开设置页并返回「录音缓存」那一区。 */
function mountedSettings(harness: Harness): HTMLElement {
  harness.openSettings();
  return harness.root.querySelector(
    '[data-settings-target="replay-cache"]',
  ) as HTMLElement;
}

describe("保存录音重试的真实来源与写回状态", () => {
  test("成功回退附注明确区分原方案和实际模型，中英文仅解释一次 ASR-only", () => {
    const cloud = { engine: "cloud", modelId: "cloud-a", modelName: "云方案 A", language: "auto", punctEnabled: true } as const;
    const local = { engine: "local", modelId: "local-b", modelName: "本地方案 B", language: "auto", punctEnabled: true } as const;
    try {
      for (const locale of ["zh", "en"]) {
        setVoiceLocale(locale);
        const harness = mount({ history: [historyItem({ originalSelection: cloud,
          retryPlan: { primary: cloud, fallback: local },
          savedInput: { attemptId: "fallback", revision: 2, state: "complete", selection: local, startedAtMs: 1 },
        })], replayCache: replayCache() });
        openDetail(harness);
        expect(harness.root.querySelector(".input-detail-selection")?.textContent).toContain("云方案 A");
        const actual = harness.root.querySelector(".input-detail-recognition");
        expect(actual?.getAttribute("data-saved-input-source")).toBe("local");
        expect(actual?.textContent).toContain("本地方案 B");
        expect(actual?.textContent).toContain(t("retry.fallbackUsed"));
        expect(actual?.textContent).not.toContain("云方案 A");
        expect(harness.root.textContent?.split(t("retry.asrOnly")).length).toBe(2);
        expect(harness.root.querySelectorAll(".input-detail-meta")).toHaveLength(1);
        expect(harness.root.querySelector(".voice-retry-panel")).toBeNull();
        harness.dispose();
      }
    } finally {
      setVoiceLocale("zh");
    }
  });

  test("成功只显示正文和冻结来源，不借旧润色或插入状态冒充本次执行", () => {
    const harness = mount({ history: [historyItem({ transcript: "新识别正文", inserted: true, polish: "formal", originalTranscript: "旧原文",
      savedInput: { attemptId: "saved", revision: 2, state: "complete", selection: { engine: "cloud", modelId: "transcribe-free", modelName: "当时的云方案", language: "en-US", punctEnabled: true }, startedAtMs: 1 },
    })], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.textContent).toContain("新识别正文");
    expect(harness.root.textContent).toContain("当时的云方案");
    expect(harness.root.textContent).toContain("未执行润色、翻译或文字写入");
    expect(harness.root.textContent?.split("本次仅重新识别，未执行润色、翻译或文字写入。").length).toBe(2);
    expect(harness.root.querySelectorAll(".input-detail-meta")).toHaveLength(1);
    expect(harness.root.querySelector(".input-detail-recognition")?.textContent).toContain("当时的云方案");
    expect(harness.root.querySelector(".input-detail-selection")?.textContent).toContain("未记录");
    expect(harness.root.querySelector(".input-detail-engine")).toBeNull();
    expect(harness.root.querySelector(".detail-polish-compare")).toBeNull();
    expect(harness.root.querySelector(".detail-primary-action")).toBeNull();
    expect(harness.root.querySelector(".input-detail-facts")?.textContent).toContain("未写入");
    harness.dispose();
  });
  test("失败保留原文，进行中只给精确取消，过期不允许重新识别", () => {
    const item = historyItem({ transcriptionStatus: "failed", transcript: "必须保留的原文" });
    const harness = mount({ history: [item], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.textContent).toContain("必须保留的原文");
    harness.update({ ...harness.state, inputRetries: { "voice-input-abc": "cloud" } });
    expect(harness.root.querySelector(".detail-primary-action")?.textContent).toBe("取消");
    harness.update({ ...harness.state, replayCache: replayCache({ clipCount: 0, retainedSinceMs: null }) });
    expect((harness.root.querySelector(".detail-primary-action") as HTMLButtonElement).disabled).toBe(true);
    harness.dispose();
  });
});

for (const [errorCode, expected] of [["AI_PAYMENT_REQUIRED", "额度"], ["AI_NETWORK_ERROR", "网络"], ["AI_SUBSCRIPTION_REQUIRED", "订阅"], ["AI_SUBSCRIPTION_UNAVAILABLE", "订阅"], ["AI_UNAVAILABLE", "服务"]] as const) {
  test(`saved cloud failure ${errorCode} displays its fixed classification`, () => {
    const harness = mount({ history: [historyItem({ transcript: "", inserted: false, transcriptionStatus: "failed", requestedEngine: "cloud",
      savedInput: { attemptId: "classified", revision: 2, state: "failed", errorCode, selection: { engine: "cloud", modelId: "fixture", modelName: "Fixture", language: "auto", punctEnabled: true }, startedAtMs: 1 },
    })], replayCache: replayCache() });
    openDetail(harness);
    expect(harness.root.querySelector(".voice-retry-panel [role=status]")?.textContent).toContain(expected);
    harness.dispose();
  });
}
