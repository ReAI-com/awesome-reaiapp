import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import {
  createDefaultVoiceViewState,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";

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

/** 段起始时刻用本地时区的一个固定日期；期望值在测试里用同一套读法现算。 */
const SEGMENT_START = new Date(2026, 7, 18, 14, 3, 0);
const SEGMENT_END_OFFSET_MS = 38 * 60_000;

function recording(overrides: Partial<VoiceRecordingSegment> = {}): VoiceRecordingSegment {
  return {
    id: "rec-1",
    wallStartMs: SEGMENT_START.getTime(),
    durationMs: SEGMENT_END_OFFSET_MS,
    transport: "usb_vendor_hid",
    transcriptText:
      "我们先把发布节奏定下来，固件和 App 要不要一起出。\n那就一起。发布说明写一份，固件那条单独列一节。\n行，那就这样。",
    transcribedAtMs: null,
    ...overrides,
  } as VoiceRecordingSegment;
}

interface Harness {
  root: HTMLElement;
  update(state: VoiceViewState): void;
  navigateRoot(): void;
  dispose(): void;
  /** 播放条取件（onLoadReplayAudio）收到的录音 id，按点击 / 预取顺序。 */
  loaded: string[];
  /** 确认删除后交出的段 id。 */
  deletes: string[];
  /** 「生成 / 重新总结」交出的段 id。 */
  summarizes: string[];
  sends: string[];
}

function mount(overrides: Partial<VoiceViewState> = {}): Harness {
  const root = document.createElement("div");
  document.body.append(root);
  const harness: Harness = {
    root,
    update: () => undefined,
    navigateRoot: () => undefined,
    dispose: () => undefined,
    loaded: [],
    deletes: [],
    summarizes: [],
    sends: [],
  };
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onNavigated: () => undefined,
    onSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
          onScreenshotConsentConfirm: async () => undefined,
          onScreenshotConsentRevoked: async () => undefined,
    onDeleteRecording: async (recordingId: string) => {
      harness.deletes.push(recordingId);
    },
    onSendContextToAgent: async (id: string) => { harness.sends.push(id); },
    onSendCommandFollowUp: async () => "task-follow-up",
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async (recordingId: string) => {
      harness.summarizes.push(recordingId);
    },
    onMarkCommandRead: async () => undefined,
    onLoadReplayAudio: async (recordingId: string) => {
      harness.loaded.push(recordingId);
      return new Blob([new Uint8Array([1])], { type: "audio/wav" });
    },
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onActionMountChanged: async () => undefined,
    onOpenKeymap: async () => undefined,
  } as unknown as VoiceViewActions;
  const view = mountVoiceView(root, createDefaultVoiceViewState(overrides), actions);
  harness.update = (next) => view.update(next);
  harness.navigateRoot = () => view.navigateRoot();
  harness.dispose = () => view.dispose();
  return harness;
}

/** 切到 Context 档并点第一段，进入段详情页（默认落在总结栏，R7）。 */
function openContextDetail(harness: Harness, index = 0): void {
  (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
  const copies = harness.root.querySelectorAll<HTMLButtonElement>(".recording-copy");
  copies[index]?.click();
}

function switchPane(harness: Harness, pane: "raw" | "sum"): void {
  (harness.root.querySelector(`.ctx-tab[data-ctx-pane="${pane}"]`) as HTMLButtonElement).click();
}

function clockTimeOf(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatChars(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}


describe("Context 段详情（A3-22）：逐句时间线", () => {
  test("段行可点进只读详情页；页头身份在左（白底 + 底边线，R16），返回后仍停 Context 档", () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    const copy = harness.root.querySelector(".recording-copy") as HTMLButtonElement;
    expect(copy.tagName).toBe("BUTTON");
    expect(copy.classList.contains("ctx-seg")).toBeTrue();
    copy.click();

    const view = harness.root.querySelector(".ctx-view");
    expect(view).not.toBeNull();

    // 页头：与输入详情同一套 .detail-header（稿 .input-detail-header：白底 + 底边线），
    // 身份在左（稿 ctxTitle 的时间区间形态 + ctxMeta 的「现场记录 · 今天 · 时长 · 字数」）。
    const header = harness.root.querySelector(".ctx-view .detail-header") as HTMLElement;
    expect(header).toBeInstanceOf(HTMLElement);
    expect(header.classList.contains("input-detail-header")).toBeTrue();
    expect(harness.root.querySelector(".chat-who-ava svg")).not.toBeNull();
    expect(harness.root.querySelector(".chat-who-ava")?.getAttribute("aria-hidden")).toBe("true");
    expect(harness.root.querySelector(".chat-who-name")?.textContent)
      .toBe(`${clockTimeOf(item.wallStartMs)} – ${clockTimeOf(item.wallStartMs + item.durationMs)}`);
    expect(harness.root.querySelector(".chat-who-role")?.textContent)
      .toMatch(/^现场记录 · (今天|昨天|\d+ 月 \d+ 日 周.|\d+ 年 \d+ 月 \d+ 日 周.) · 38 分钟 · 1?,?\d+ 字$/u);
    /* B5-14：页内返回钮已撤，返回走 Host 面包屑（navigateRoot 同款收口）。 */
    expect(harness.root.querySelector(".chat-back")).toBeNull();
    // R7：页头不再有「发给 agent」。
    expect(harness.root.querySelector(".detail-header [data-action='send-context-to-agent']")).toBeNull();

    harness.navigateRoot();
    expect(harness.root.querySelector(".ctx-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    // 回去还是 Context 档：段列表还在，All 档的现场入口条不在。
    expect(harness.root.querySelector(".ctx-seg")).not.toBeNull();
    expect(harness.root.querySelector(".ctx-entry")).toBeNull();
    expect(
      harness.root.querySelector('[data-voice-tab="context"]')?.classList.contains("active"),
    ).toBeTrue();
    harness.dispose();
  });

  test("原文栏（R12）：Host 给了句级时间戳就逐句标真实时刻，脚注不再出现", () => {
    const item = recording({
      sentences: [
        { text: "我们先把发布节奏定下来，固件和 App 要不要一起出。", startMs: 0, endMs: 4_200 },
        { text: "那就一起。", startMs: 2 * 60_000 + 5_000, endMs: 2 * 60_000 + 6_100 },
        // 跨段边界的分片起点为负：真实时间照常折算，不裁剪。
        { text: "行，那就这样。", startMs: -30_000, endMs: -28_000 },
      ],
    });
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    switchPane(harness, "raw");
    const texts = Array.from(harness.root.querySelectorAll(".ctx-utterance-line .ctx-line-tx"))
      .map((node) => node.textContent);
    expect(texts).toEqual([
      "我们先把发布节奏定下来，固件和 App 要不要一起出。",
      "那就一起。",
      "行，那就这样。",
    ]);
    const stamps = Array.from(harness.root.querySelectorAll(".ctx-utterance-line .ctx-line-ts"))
      .map((node) => node.textContent);
    expect(stamps).toEqual([
      "14:03:00",
      "14:05:05",
      "14:02:30",
    ]);
    // 有真实数据时不再需要「句子之间没有各自的时间戳」那行脚注。
    expect(harness.root.querySelector(".ctx-lines-note")).toBeNull();
    harness.dispose();
  });

  test("原文栏：旧数据没有句级时间戳时按已有切分逐句排列；只有首句标真实起始时刻，其余不编时间戳", () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    switchPane(harness, "raw");

    // 播放条与输入详情共用；媒体元数据到达前不把历史段时长冒充音频时长。
    // 波形 58 根、高度走 CSSOM（R10）。
    const play = harness.root.querySelector(".ctx-body .replay-play") as HTMLButtonElement;
    expect(play).not.toBeNull();
    expect(play.dataset.replayId).toBe(item.id);
    expect(harness.root.querySelector(".replay-time")?.textContent).toBe("加载音频…");
    const bars = harness.root.querySelectorAll<HTMLElement>(".replay-wave i");
    expect(bars.length).toBe(58);
    expect(Array.from(bars).every((bar) => bar.getAttribute("style") === null || bar.style.height !== "")).toBeTrue();
    expect(Array.from(bars).some((bar) => bar.style.height === "0%")).toBeTrue();
    // 点播放走取件（onLoadReplayAudio），不再是另一条一次性 play() 链路。
    play.click();
    expect(harness.loaded).toContain(item.id);

    // 旧记录按原始换行保留发言边界，行内句子不再拆成独立记录。
    const texts = Array.from(harness.root.querySelectorAll(".ctx-utterance-line .ctx-line-tx"))
      .map((node) => node.textContent);
    expect(texts).toEqual([
      "我们先把发布节奏定下来，固件和 App 要不要一起出。",
      "那就一起。发布说明写一份，固件那条单独列一节。",
      "行，那就这样。",
    ]);

    // 时间列：第一句是段起始的真实时刻，其余句子留空——句级时间戳不存在，不内插编造。
    const stamps = Array.from(harness.root.querySelectorAll(".ctx-utterance-line .ctx-line-ts"))
      .map((node) => node.textContent);
    expect(stamps[0]).toBe("14:03:00");
    expect(stamps.slice(1)).toEqual(["", ""]);

    // 数据边界在界面上有说明：空着的时间列读得出「没有」，不是排版坏了。
    expect(harness.root.querySelector(".ctx-lines-note")?.textContent)
      .toContain("句子之间没有各自的时间戳");
    harness.dispose();
  });

  test("还没转写完的段不进入记录列表，也不能打开空详情", () => {
    const harness = mount({
      recordings: [recording({ transcriptText: null })],
      recordingsTotal: 1,
    });
    (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    expect(harness.root.querySelector(".recording-copy")).toBeNull();
    expect(harness.root.querySelector(".ctx-view")).toBeNull();
    harness.dispose();
  });

  test("段已不在（被删 / 列表刷新）时返回列表，不留在空详情页", () => {
    const harness = mount({ recordings: [recording()], recordingsTotal: 1 });
    openContextDetail(harness);
    harness.update(createDefaultVoiceViewState({ recordings: [], recordingsTotal: 0 }));
    expect(harness.root.querySelector(".ctx-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    harness.dispose();
  });

  test("R6：列表行是轻行——没有播放 / 删除 / 发给 agent，那些都在详情页", () => {
    const harness = mount({ recordings: [recording()], recordingsTotal: 1, agentsImAvailable: true });
    (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    const row = harness.root.querySelector(".ctx-seg") as HTMLElement;
    expect(row.querySelector("button")).toBeNull();
    expect(row.textContent).not.toContain("播放");
    expect(row.textContent).not.toContain("删除");
    expect(row.querySelector('[data-action="send-context-to-agent"]')).toBeNull();
    expect(row.querySelector(".ctx-seg-t")?.textContent).toBe("14:03 – 14:41");
    expect(row.querySelector(".ctx-seg-p")?.textContent).toBe("我们先把发布节奏定下来，固件和 App 要不要一起出。");
    expect(row.querySelector(".ctx-seg-m")?.textContent).toBe("38 分钟48 字");
    harness.dispose();
  });

  test("A3-24 / R7「发给 agent」：装了 Agents·IM 才渲染，住在总结栏脚部（两种总结态都有）", () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1, agentsImAvailable: true });
    openContextDetail(harness);
    const send = harness.root.querySelector<HTMLButtonElement>(
      ".ctx-view .ctx-sum-ft [data-action='send-context-to-agent']",
    );
    expect(send).toBeInstanceOf(HTMLButtonElement);
    expect(send?.textContent).toBe("发给 agent");
    expect(send?.getAttribute("aria-label"))
      .toBe(`把 ${new Date(item.wallStartMs).toLocaleString()} 这一段发给 agent`);
    harness.dispose();
  });

  test("A3-24 失败反馈留在详情页：error 就地渲染（按钮在本页，报错不能退回列表才看见）", () => {
    const harness = mount({
      recordings: [recording()],
      recordingsTotal: 1,
      agentsImAvailable: true,
      error: "ni.chat 暂时打不开，稍后再试",
    });
    openContextDetail(harness);
    const error = harness.root.querySelector(".ctx-view .inline-error");
    expect(error?.textContent).toBe("ni.chat 暂时打不开，稍后再试");
    // 成功路径（app 层 publish({ error: undefined })）后视图不再渲染错误。
    harness.update(createDefaultVoiceViewState({
      recordings: [recording()],
      recordingsTotal: 1,
      agentsImAvailable: true,
    }));
    expect(harness.root.querySelector(".ctx-view .inline-error")).toBeNull();
    harness.dispose();
  });

  test("A3-24 门控：没装 Agents·IM（false / 还没探到）时不渲染入口，返回仍走面包屑", () => {
    for (const agentsImAvailable of [false, undefined]) {
      const harness = mount({
        recordings: [recording()],
        recordingsTotal: 1,
        ...(agentsImAvailable === undefined ? {} : { agentsImAvailable }),
      });
      openContextDetail(harness);
      // 稿 :3408：跨扩展入口在对方没装时就该不存在，而不是灰着让人点。
      expect(harness.root.querySelector('[data-action="send-context-to-agent"]')).toBeNull();
      expect(harness.root.querySelector(".ctx-acts")).toBeNull();
      // B5-14 后页头不再有返回钮——门控只摘跨扩展入口，导航整体由 Host 面包屑承载。
      expect(harness.root.querySelector(".chat-back")).toBeNull();
      harness.dispose();
    }
  });
});

describe("原文·总结两栏（A3-23 / R7）", () => {
  test("两枚页签「原文 / 总结」，默认落在总结栏（稿）", () => {
    const harness = mount({ recordings: [recording()], recordingsTotal: 1 });
    openContextDetail(harness);
    const tabs = Array.from(harness.root.querySelectorAll(".ctx-tab"));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["原文", "总结"]);
    expect(tabs[1]?.classList.contains("active")).toBeTrue();
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(harness.root.querySelector(".ctx-line")).toBeNull();
    harness.dispose();
  });

  test("切到原文栏再切回总结栏，两栏互斥切换", () => {
    const harness = mount({ recordings: [recording()], recordingsTotal: 1 });
    openContextDetail(harness);
    const tabs = Array.from(harness.root.querySelectorAll<HTMLButtonElement>(".ctx-tab"));
    tabs[0]?.click();
    expect(harness.root.querySelector(".ctx-line")).not.toBeNull();
    expect(harness.root.querySelector(".ctx-empty")).toBeNull();
    tabs[1]?.click();
    expect(harness.root.querySelector(".ctx-empty")?.textContent)
      .toContain("这一段还没有总结");
    expect(harness.root.querySelector(".ctx-line")).toBeNull();
    harness.dispose();
  });

  test("没有总结：空态 + 「生成总结」（接可替换的 action），脚部只有删除；空转录不进列表", () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    const empty = harness.root.querySelector(".ctx-empty") as HTMLElement;
    expect(empty.textContent).toContain("这一段还没有总结。");
    expect(empty.textContent).not.toContain("总结功能还没就绪");
    const generate = empty.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
    expect(generate?.textContent).toBe("生成总结");
    expect(generate?.disabled).toBeFalse();
    generate?.click();
    expect(harness.summarizes).toEqual([item.id]);
    expect(harness.root.querySelector(".ctx-sum-h")).toBeNull();
    // 脚部：只有删除（靠右红字），没有重新总结 / 发给 agent。
    const foot = harness.root.querySelector(".ctx-sum-ft") as HTMLElement;
    expect(Array.from(foot.querySelectorAll("button")).map((button) => button.textContent))
      .toEqual(["删掉这段记录"]);
    expect(foot.querySelector('[data-action="delete-recording"]')?.classList.contains("danger")).toBeTrue();
    harness.dispose();

    const untranscribed = mount({ recordings: [recording({ transcriptText: null })], recordingsTotal: 1 });
    (untranscribed.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    expect(untranscribed.root.querySelector(".recording-copy")).toBeNull();
    expect(untranscribed.root.querySelector('[data-action="summarize-segment"]')).toBeNull();
    untranscribed.dispose();
  });

  test("有总结：「AI 总结」标签 + 溯源 + 要点；脚部「重新总结 · 发给 agent … 删掉这段记录」", () => {
    const item = recording({
      summary: {
        points: ["这版固件和 App 一起发", "下周三备好安装包和说明"],
        generatedAtMs: SEGMENT_START.getTime() + 60 * 60_000,
        dshSessionId: "dsh-seg-a",
      },
    });
    const harness = mount({
      recordings: [item],
      recordingsTotal: 1,
      agentsImAvailable: true,
    });
    openContextDetail(harness);
    expect(harness.root.querySelector(".ctx-sum-lb")?.textContent).toBe("AI 总结");
    expect(harness.root.querySelector(".ctx-sum-src")?.textContent)
      .toBe(`出自 14:03–14:41 这一段 · ${"48"} 字`);
    expect(Array.from(harness.root.querySelectorAll(".ctx-sum-i")).map((node) => node.textContent))
      .toEqual(["这版固件和 App 一起发", "下周三备好安装包和说明"]);
    const foot = harness.root.querySelector(".ctx-sum-ft") as HTMLElement;
    expect(Array.from(foot.querySelectorAll("button")).map((button) => button.textContent))
      .toEqual(["重新总结", "发给 agent", "删掉这段记录"]);
    expect(harness.root.querySelector(".ctx-empty")).toBeNull();
    harness.dispose();

    // 总结进行中：按钮如实禁用、写「总结中…」。
    const busy = mount({
      recordings: [item],
      recordingsTotal: 1,
      segmentSummarizing: item.id,
    });
    openContextDetail(busy);
    const generating = busy.root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
    expect(generating?.textContent).toBe("总结中…");
    expect(generating?.disabled).toBeTrue();
    busy.dispose();

    // 全局一次只跑一段：切到另一段时也必须禁用，不能留一颗点了必报错的按钮。
    const anotherBusy = mount({
      recordings: [item],
      recordingsTotal: 1,
      segmentSummarizing: "another-segment",
    });
    openContextDetail(anotherBusy);
    const blocked = anotherBusy.root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
    expect(blocked?.textContent).toBe("另一段总结中…");
    expect(blocked?.disabled).toBeTrue();
    anotherBusy.dispose();
  });
});

describe("R17 删掉这段记录：先问一次", () => {
  test("点删除弹确认层：文案照稿、默认焦点在取消；取消 / Esc / 点遮罩都不删", async () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    (harness.root.querySelector('[data-action="delete-recording"]') as HTMLButtonElement).click();

    const layer = harness.root.querySelector(".voice-ask") as HTMLElement;
    expect(layer).toBeInstanceOf(HTMLElement);
    expect(layer.querySelector(".voice-ask-h")?.textContent).toBe("删掉这段记录？");
    expect(layer.querySelector(".voice-ask-p")?.textContent).toBe(
      "删掉就找不回来了：14:03–14:41 这一段的录音和文字一起没，那天的总结也会少这一段。",
    );
    const cancel = layer.querySelector('[data-ask="no"]') as HTMLButtonElement;
    const confirm = layer.querySelector('[data-ask="yes"]') as HTMLButtonElement;
    expect(cancel.textContent).toBe("取消");
    expect(confirm.textContent).toBe("删除");
    expect(confirm.classList.contains("danger")).toBeTrue();
    await Promise.resolve();
    expect(document.activeElement).toBe(cancel);

    cancel.click();
    expect(harness.root.querySelector(".voice-ask")).toBeNull();
    expect(harness.root.querySelector(".ctx-view")).not.toBeNull();
    expect(harness.deletes).toEqual([]);

    (harness.root.querySelector('[data-action="delete-recording"]') as HTMLButtonElement).click();
    (harness.root.querySelector(".voice-ask") as HTMLElement)
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(harness.root.querySelector(".voice-ask")).toBeNull();
    expect(harness.deletes).toEqual([]);

    (harness.root.querySelector('[data-action="delete-recording"]') as HTMLButtonElement).click();
    (harness.root.querySelector(".voice-ask") as HTMLElement).click();
    expect(harness.root.querySelector(".voice-ask")).toBeNull();
    expect(harness.deletes).toEqual([]);
    harness.dispose();
  });

  test("确认删除：交出删除动作并回到列表（Context 档）", () => {
    const item = recording();
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    (harness.root.querySelector('[data-action="delete-recording"]') as HTMLButtonElement).click();
    (harness.root.querySelector('[data-ask="yes"]') as HTMLButtonElement).click();
    expect(harness.deletes).toEqual([item.id]);
    expect(harness.root.querySelector(".voice-ask")).toBeNull();
    expect(harness.root.querySelector(".ctx-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    expect(
      harness.root.querySelector('[data-voice-tab="context"]')?.classList.contains("active"),
    ).toBeTrue();
    harness.dispose();
  });

  test("今天的段：确认文案写「今天的总结」", () => {
    const start = new Date();
    start.setHours(9, 48, 0, 0);
    const harness = mount({
      recordings: [recording({ wallStartMs: start.getTime(), durationMs: 7 * 60_000 })],
      recordingsTotal: 1,
    });
    openContextDetail(harness);
    (harness.root.querySelector('[data-action="delete-recording"]') as HTMLButtonElement).click();
    expect(harness.root.querySelector(".voice-ask-p")?.textContent)
      .toBe("删掉就找不回来了：09:48–09:55 这一段的录音和文字一起没，今天的总结也会少这一段。");
    harness.dispose();
  });

  test("总结栏生成中：按钮变「总结中…」并禁用；还没转写的段入口禁用", () => {
    const item = recording();
    const harness = mount({
      recordings: [item],
      recordingsTotal: 1,
      segmentSummarizing: item.id,
    });
    openContextDetail(harness);
    (harness.root.querySelectorAll<HTMLButtonElement>(".ctx-tab")[1] as HTMLButtonElement).click();
    const busy = harness.root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]');
    expect(busy?.textContent).toBe("总结中…");
    expect(busy?.disabled).toBeTrue();

    harness.update(createDefaultVoiceViewState({
      recordings: [recording({ transcriptText: null })],
      recordingsTotal: 1,
    }));
    (harness.root.querySelectorAll<HTMLButtonElement>(".ctx-tab")[1] as HTMLButtonElement)?.click();
    expect(
      harness.root.querySelector<HTMLButtonElement>('[data-action="summarize-segment"]')?.disabled,
    ).toBeTrue();
    expect(harness.root.querySelector(".ctx-empty")?.textContent).toContain("这一段还没转写完成");
    harness.dispose();
  });

  test("总结栏有总结（R11）：AI 总结标签 + 溯源行 + 要点 + 脚部「重新总结」；云端回退要说明来路", () => {
    const item = recording({
      summary: {
        points: ["发布节奏定为固件与 App 一起出", "Windows 拨杆不写进亮点"],
        generatedAtMs: SEGMENT_START.getTime() + 60 * 60_000,
        dshSessionId: "dsh-seg-1",
      },
    });
    const harness = mount({ recordings: [item], recordingsTotal: 1 });
    openContextDetail(harness);
    (harness.root.querySelectorAll<HTMLButtonElement>(".ctx-tab")[1] as HTMLButtonElement).click();
    expect(harness.root.querySelector(".ctx-sum-lb")?.textContent).toBe("AI 总结");
    expect(harness.root.querySelector(".ctx-sum-src")?.textContent).toBe(
      `出自 ${clockTimeOf(item.wallStartMs)}–${clockTimeOf(item.wallStartMs + item.durationMs)} 这一段`
        + ` · ${"48"} 字`,
    );
    expect(
      Array.from(harness.root.querySelectorAll(".ctx-sum-i")).map((node) => node.textContent),
    ).toEqual(["发布节奏定为固件与 App 一起出", "Windows 拨杆不写进亮点"]);
    expect(harness.root.querySelector(".ctx-empty")).toBeNull();
    const regen = harness.root.querySelector<HTMLButtonElement>(
      '.ctx-sum-ft [data-action="summarize-segment"]',
    );
    expect(regen?.textContent).toBe("重新总结");
    regen?.click();
    expect(harness.summarizes).toEqual([item.id]);

    // 走了云端回退（没有 Dsh 会话）的总结：溯源行如实说明，不冒充 agent 会话。
    harness.update(createDefaultVoiceViewState({
      recordings: [recording({
        summary: { points: ["只有一条"], generatedAtMs: 1, dshSessionId: null },
      })],
      recordingsTotal: 1,
    }));
    (harness.root.querySelectorAll<HTMLButtonElement>(".ctx-tab")[1] as HTMLButtonElement)?.click();
    expect(harness.root.querySelector(".ctx-sum-src")?.textContent)
      .toContain("Agent 暂不可用，由云端模型直接生成");
    harness.dispose();
  });
});

describe("Context 空内容折叠", () => {
  test("compact empty rows open raw, expand survives refresh, original audio remains available", async () => {
    const item=recording({transcriptText:" . \n。",sentences:[{text:" . ",startMs:0,endMs:1000},{text:"。",startMs:1000,endMs:2000}]});
    const before=JSON.stringify(item);
    const harness=mount({recordings:[item]});
    openContextDetail(harness);
    expect(harness.root.querySelector('[data-ctx-pane="raw"]')?.getAttribute("aria-selected")).toBe("true");
    const fold=harness.root.querySelector<HTMLDetailsElement>('details[data-context-key*="empty:"]')!;
    expect(fold.querySelector("summary")?.textContent).toBe("[14:03:00～14:03:02] 无内容");
    expect(fold.open).toBeFalse();fold.open=true;
    harness.update(createDefaultVoiceViewState({recordings:[item]}));
    expect(harness.root.querySelector<HTMLDetailsElement>('details[data-context-key*="empty:"]')?.open).toBeTrue();
    expect(harness.root.querySelector(".ctx-original-text")?.textContent).toBe(item.transcriptText!);
    expect(harness.root.querySelector(".replay-bar")).not.toBeNull();
    await Promise.resolve();expect(harness.loaded).toContain(item.id);
    expect(harness.summarizes).toEqual([]);expect(harness.sends).toEqual([]);expect(harness.deletes).toEqual([]);expect(JSON.stringify(item)).toBe(before);
    harness.navigateRoot();
    const row=harness.root.querySelector(".ctx-seg-empty")!;
    expect(row.textContent).toContain("暂无有效文字");expect(row.querySelector(".ctx-seg-m")).toBeNull();expect(row.querySelector(".ctx-seg-i")).toBeNull();
    harness.dispose();
  });
  test("mixed preview selects speech, legacy empty has no invented range", () => {
    const harness=mount({recordings:[recording({transcriptText:".\n下午三点开会。"})]});
    (harness.root.querySelector('[data-voice-tab="context"]') as HTMLButtonElement).click();
    expect(harness.root.querySelector(".ctx-seg-p")?.textContent).toBe("下午三点开会。");
    expect(harness.root.querySelector(".ctx-seg-m")?.textContent).toBe("38 分钟6 字");
    harness.update(createDefaultVoiceViewState({recordings:[recording({transcriptText:".\n。"})]}));
    (harness.root.querySelector(".recording-copy") as HTMLButtonElement).click();
    expect(harness.root.querySelector('[data-context-key="rec-1:legacy-empty"] summary')?.textContent).toBe("无内容");
    expect(harness.root.querySelector(".ctx-lines-note")).not.toBeNull();
    harness.dispose();
  });
  test("scattered empty blocks fold into one entry around real speech", () => {
    const item=recording({transcriptText:"。……不用贴。。",sentences:[
      {text:"。",startMs:0,endMs:900},
      {text:"……",startMs:900,endMs:1000},
      {text:"不用贴。",startMs:1000,endMs:2000},
      {text:"。",startMs:2500,endMs:3000},
      {text:"。",startMs:NaN,endMs:NaN},
    ]});
    const harness=mount({recordings:[item]});
    openContextDetail(harness);
    switchPane(harness,"raw");
    const folds=harness.root.querySelectorAll<HTMLDetailsElement>('details[data-context-key*="empty:"]');
    expect(folds).toHaveLength(1);
    const merged=folds[0]!;
    expect(merged.dataset.contextKey).toBe("rec-1:empty:merged");
    expect(merged.querySelector("summary")?.textContent).toBe("无内容");
    merged.open=true;
    expect(Array.from(merged.querySelectorAll(".ctx-line-tx")).map((node)=>node.textContent))
      .toEqual(["。","……","。","。"]);
    const spoken=harness.root.querySelector(".ctx-lines > .ctx-line")!;
    expect(spoken.querySelector(".ctx-line-tx")?.textContent).toBe("不用贴。");
    expect(spoken.querySelector(".ctx-line-ts")?.textContent).toBe("14:03:01");
    const ordered=Array.from(harness.root.querySelectorAll(".ctx-lines > *"));
    expect(ordered[0]).toBe(merged);expect(ordered[1]).toBe(spoken);
    harness.update(createDefaultVoiceViewState({recordings:[item]}));
    expect(harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:empty:merged"]')?.open).toBeTrue();
    harness.dispose();
  });
  test("all-empty multi-gap recording has one outer disclosure", () => {
    const sentences=Array.from({length:75},(_,i)=>({text:".",startMs:i*3000,endMs:i*3000+1000}));
    const harness=mount({recordings:[recording({transcriptText:sentences.map(s=>s.text).join("\n"),sentences})]});
    openContextDetail(harness);
    const outer=harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:all-empty"]')!;
    expect(outer.open).toBeFalse();expect(outer.querySelector("summary")?.textContent).toBe("暂无有效文字 · 展开 75 条原始转写");
    expect(outer.querySelectorAll(".ctx-empty-fold")).toHaveLength(1);
    expect(outer.querySelector(".ctx-empty-fold")?.querySelectorAll(".ctx-line")).toHaveLength(75);outer.open=true;
    harness.update(createDefaultVoiceViewState({recordings:[recording({transcriptText:".",sentences})]}));
    expect(harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:all-empty"]')?.open).toBeTrue();harness.dispose();
  });
});


test("现场连续发言合并、语气词折叠、短确认保留，原片可回查且刷新保留展开", async () => {
  const item = recording({ transcriptStatus: "complete", transcriptText: "我们先\n把发布节奏\n定下来。\n嗯\n呃\n嗯", sentences: [
    { text: "我们先", startMs: 0, endMs: 600 },
    { text: "把发布节奏", startMs: 650, endMs: 1100 },
    { text: "定下来。", startMs: 1200, endMs: 1900 },
    { text: "嗯", startMs: 4000, endMs: 4400 },
    { text: "呃", startMs: 4500, endMs: 4900 },
    { text: "嗯", startMs: 8000, endMs: 8500 },
  ] });
  const before = JSON.stringify(item);
  const harness = mount({ recordings: [item] });
  try {
    openContextDetail(harness); switchPane(harness, "raw");
    const rows = Array.from(harness.root.querySelectorAll(".ctx-utterance-line"));
    expect(rows.map(n => n.querySelector(".ctx-line-tx")?.textContent)).toEqual(["我们先把发布节奏定下来。", "嗯"]);
    expect(rows.map(n => n.querySelector(".ctx-line-ts")?.textContent)).toEqual(["14:03:00", "14:03:08"]);
    const filler = harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:filler:3,4"]')!;
    expect(filler.open).toBeFalse();
    expect(filler.querySelector("summary")?.textContent).toBe("14:03:04 语气词片段 · 2 条原始片段");
    const originals = harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:fragments:0,1,2"]')!;
    originals.open = true;
    expect(Array.from(originals.querySelectorAll(".ctx-line-tx")).map(n => n.textContent)).toEqual(["我们先", "把发布节奏", "定下来。"]);
    expect(originals.querySelector(".ctx-line-ts")?.textContent).toBe("14:03:00.000～14:03:00.600");
    harness.update(createDefaultVoiceViewState({ recordings: [item] }));
    expect(harness.root.querySelector<HTMLDetailsElement>('[data-context-key="rec-1:fragments:0,1,2"]')?.open).toBeTrue();
    expect(harness.root.querySelector(".ctx-original-text")?.textContent).toBe(item.transcriptText);
    expect(JSON.stringify(item)).toBe(before);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally { harness.dispose(); }
});


test("旧记录忽略展示空行，首条发言仍标起始时间，整段空白原文保留", async () => {
  const item = recording({ transcriptText: "\n \n第一句。第二句。\n\n另一段。\n" });
  const harness = mount({ recordings: [item] });
  try {
    openContextDetail(harness); switchPane(harness, "raw");
    const rows = Array.from(harness.root.querySelectorAll(".ctx-utterance-line"));
    expect(rows.map(n => n.querySelector(".ctx-line-tx")?.textContent)).toEqual(["第一句。第二句。", "另一段。"]);
    expect(rows.map(n => n.querySelector(".ctx-line-ts")?.textContent)).toEqual(["14:03:00", ""]);
    expect(harness.root.querySelectorAll('[data-context-key*="legacy:"]')).toHaveLength(0);
    expect(harness.root.querySelector(".ctx-original-text")?.textContent).toBe(item.transcriptText);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally { harness.dispose(); }
});
