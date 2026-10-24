import { setVoiceLocale } from "../src/voice-i18n";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createDefaultVoiceViewState,
  type VoiceCommandHistoryItem,
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
beforeEach(() => {
  document.body.replaceChildren();
  setVoiceLocale("zh");
});

const SOURCE = "请确认下周二的会议时间。";
const RESULT = "Please confirm the meeting time for next Tuesday.";

function translationItem(overrides: Partial<VoiceCommandHistoryItem> = {}): VoiceCommandHistoryItem {
  return {
    id: "translate-1",
    transcript: SOURCE,
    status: "completed",
    createdAt: "2026-09-29T03:00:00.000Z",
    reply: RESULT,
    commandId: "voice.command.translate",
    translationTarget: "en-US",
    messages: [
      { from: "user", text: SOURCE, at: "2026-09-29T03:00:00.000Z" },
      { from: "ai", text: RESULT, at: "2026-09-29T03:00:03.000Z", runtime: "dsh" },
    ],
    ...overrides,
  };
}

function mount(overrides: Partial<VoiceViewState> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const navs: Array<string | null> = [];
  const copied: string[] = [];
  const actions = new Proxy({
    onNavigated: (page: string | null) => navs.push(page),
    onCopyText: async (text: string) => { copied.push(text); },
  }, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : async () => undefined,
  }) as unknown as VoiceViewActions;
  const view = mountVoiceView(root, createDefaultVoiceViewState({ statusLoad: "loaded", ...overrides }), actions);
  return { root, view, navs, copied };
}

function openFirstCommand(root: HTMLElement): void {
  (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
  (root.querySelector(".command-history-item") as HTMLButtonElement).click();
}

describe("翻译详情：一次性的「原文 → 译文」，不借用 Agent 对话页", () => {
  test("成功的翻译只有原文与译文，没有对话输入框和工作目录", () => {
    const { root, navs } = mount({ commandHistory: [translationItem()] });
    openFirstCommand(root);
    expect(root.querySelector(".translation-detail")).not.toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector(".chat-bubble")).toBeNull();
    expect(root.textContent).not.toContain("工作目录");
    expect(root.querySelector(".chat-who-ava")?.textContent).toBe("🌐");
    expect(root.querySelector(".chat-who-name")?.textContent).toBe("翻译");
    expect(root.querySelector(".translation-source")?.textContent).toBe(SOURCE);
    expect(root.querySelector(".translation-result")?.textContent).toBe(RESULT);
    expect(root.querySelector(".input-detail-trans .input-detail-label span")?.textContent).toBe("译文 · 英语");
    expect(navs.at(-1)).toBe("translation");
  });

  test("复制按钮各复制各的：原文按钮给原文，译文按钮给译文", async () => {
    const { root, copied } = mount({ commandHistory: [translationItem()] });
    openFirstCommand(root);
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".translation-detail .task-copy"));
    expect(buttons.map((button) => button.textContent)).toEqual(["复制原文", "复制译文"]);
    buttons[0]!.click();
    buttons[1]!.click();
    await Promise.resolve();
    expect(copied).toEqual([SOURCE, RESULT]);
  });

  test("译文下不再标注引擎：用户视角只有一个 Agent，不显示内核名", () => {
    const withKernel = mount({ commandHistory: [translationItem()] });
    openFirstCommand(withKernel.root);
    expect(withKernel.root.querySelector(".translation-detail")).not.toBeNull();
    expect(withKernel.root.querySelector(".input-detail-chips")).toBeNull();
    expect(withKernel.root.textContent).not.toMatch(/Agent 内核|\bDSH\b|\bCodex\b/);
    document.body.replaceChildren();

    const withoutKernel = mount({ commandHistory: [translationItem({ messages: undefined })] });
    openFirstCommand(withoutKernel.root);
    expect(withoutKernel.root.querySelector(".translation-detail")).not.toBeNull();
    expect(withoutKernel.root.querySelector(".input-detail-chips")).toBeNull();
  });

  test("字数与语言标签：原文字数 → 译文字数，目标语言", () => {
    const { root } = mount({ commandHistory: [translationItem()] });
    openFirstCommand(root);
    const tags = Array.from(root.querySelectorAll(".translation-detail .input-detail-tag")).map((node) => node.textContent);
    expect(tags).toEqual([`${Array.from(SOURCE).length} → ${Array.from(RESULT).length} 字`, "en-US"]);
  });

  test("翻译失败 / 还在跑仍走对话页：那里有进度、错误诊断与重试", () => {
    const failed = mount({
      commandHistory: [translationItem({ status: "failed", reply: undefined, userMessage: "翻译失败", messages: undefined })],
    });
    openFirstCommand(failed.root);
    expect(failed.root.querySelector(".translation-detail")).toBeNull();
    expect(failed.navs.at(-1)).toBe("chat");
    document.body.replaceChildren();

    const running = mount({ commandHistory: [translationItem({ status: "running", reply: undefined, messages: undefined })] });
    openFirstCommand(running.root);
    expect(running.root.querySelector(".translation-detail")).toBeNull();
    expect(running.navs.at(-1)).toBe("chat");
  });

  test("从胶囊 / 通知按会话身份打开成功的翻译，也落到翻译详情", () => {
    const { root, view, navs } = mount({ commandHistory: [translationItem({ runId: "run-1" })] });
    expect(view.openConversation("run-1")).toBe(true);
    expect(root.querySelector(".translation-detail")).not.toBeNull();
    expect(navs.at(-1)).toBe("translation");
  });

  test("Agent 提问与翻译的列表头像不混用：翻译 🌐，Agent ✨，失败 ⚠️", () => {
    const { root } = mount({
      commandHistory: [
        translationItem(),
        translationItem({ id: "agent-1", commandId: "voice.command.agent", translationTarget: undefined, createdAt: "2026-09-29T02:00:00.000Z" }),
        translationItem({ id: "bad-1", status: "failed", reply: undefined, userMessage: "x", createdAt: "2026-09-29T01:00:00.000Z" }),
      ],
    });
    (root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    const avatars = Array.from(root.querySelectorAll(".command-history-item .task-ava")).map((node) => node.textContent);
    expect(avatars).toEqual(["🌐", "✨", "⚠️"]);
  });

  test("录音已过期时给中性说明；没有录音的老翻译不画回听区", () => {
    const expired = mount({
      commandHistory: [translationItem({ recordingId: "rec-1", recordingWallStartMs: 1_000, recordingDurationMs: 2_000 })],
    });
    openFirstCommand(expired.root);
    expect(expired.root.querySelector(".replay-gone")).not.toBeNull();
    document.body.replaceChildren();

    const legacy = mount({ commandHistory: [translationItem()] });
    openFirstCommand(legacy.root);
    expect(legacy.root.querySelector(".replay-gone")).toBeNull();
    expect(legacy.root.querySelector(".replay-bar")).toBeNull();
  });

  test("先打开还在跑的翻译，随后成功落地：自动换成翻译详情，不留对话输入框", () => {
    const running = translationItem({ status: "running", reply: undefined, messages: undefined });
    const { root, view, navs } = mount({ commandHistory: [running] });
    openFirstCommand(root);
    expect(root.querySelector(".translation-detail")).toBeNull();
    view.update(createDefaultVoiceViewState({ statusLoad: "loaded", commandHistory: [translationItem()] }));
    expect(root.querySelector(".translation-detail")).not.toBeNull();
    expect(root.querySelector(".chat-input")).toBeNull();
    expect(navs.at(-1)).toBe("translation");
  });

  test("回听取件失败后，重渲染不再自动重试（避免失败→重绘→再取的空转）", async () => {
    let loads = 0;
    const root = document.createElement("div");
    document.body.append(root);
    const actions = new Proxy({
      onNavigated: () => undefined,
      onLoadReplayAudio: async () => { loads += 1; throw new Error("file gone"); },
    }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : async () => undefined,
    }) as unknown as VoiceViewActions;
    const item = translationItem({ recordingId: "rec-1", recordingWallStartMs: Date.now() - 5_000, recordingDurationMs: 2_000 });
    const build = () => createDefaultVoiceViewState({
      statusLoad: "loaded",
      commandHistory: [item],
      replayCache: { retention: "24h", clipCount: 1, usedBytes: 1024, retainedSinceMs: 1_000 },
    });
    const view = mountVoiceView(root, build(), actions);
    openFirstCommand(root);
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let i = 0; i < 5; i += 1) {
      view.update(build());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(loads).toBe(1);
  });

  test("拖动回听进度条时轮询不替换滑块；但条目已不再是成功翻译就立刻退出，不被拖动拖住", async () => {
    const originalAudio = globalThis.Audio;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    class SeekAudio extends EventTarget {
      paused = true;
      currentTime = 0;
      duration = Number.NaN;
      preload = "";
      error = null;
      play() { this.paused = false; return Promise.resolve(); }
      pause() { this.paused = true; }
    }
    globalThis.Audio = SeekAudio as unknown as typeof Audio;
    URL.createObjectURL = () => "blob:t";
    URL.revokeObjectURL = () => undefined;
    try {
      const root = document.createElement("div");
      document.body.append(root);
      const actions = new Proxy({
        onNavigated: () => undefined,
        onLoadReplayAudio: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }),
      }, {
        get: (target, key) => key in target ? target[key as keyof typeof target] : async () => undefined,
      }) as unknown as VoiceViewActions;
      const item = translationItem({ recordingId: "rec-1", recordingWallStartMs: Date.now() - 5_000, recordingDurationMs: 2_000 });
      const build = (commandHistory: VoiceCommandHistoryItem[]) => createDefaultVoiceViewState({
        statusLoad: "loaded",
        commandHistory,
        replayCache: { retention: "24h", clipCount: 1, usedBytes: 1024, retainedSinceMs: 1_000 },
      });
      const view = mountVoiceView(root, build([item]), actions);
      openFirstCommand(root);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
      const seek = root.querySelector(".replay-seek") as HTMLInputElement;
      expect(seek).not.toBeNull();
      // 让滑块可用：模拟媒体元数据就绪。
      seek.disabled = false;
      seek.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0, bubbles: true }));
      view.update(build([item]));
      expect(root.querySelector(".replay-seek")).toBe(seek);
      view.update(build([translationItem({ recordingId: "rec-1", recordingWallStartMs: item.recordingWallStartMs, recordingDurationMs: 2_000, status: "failed", reply: undefined, userMessage: "x", messages: undefined })]));
      expect(root.querySelector(".translation-detail")).toBeNull();
      expect(root.querySelector(".replay-seek")).toBeNull();
      document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    } finally {
      globalThis.Audio = originalAudio;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test("详情打开时这条被挤出历史：退回列表，不留空页", () => {
    const { root, view } = mount({ commandHistory: [translationItem()] });
    openFirstCommand(root);
    view.update(createDefaultVoiceViewState({ statusLoad: "loaded", commandHistory: [] }));
    expect(root.querySelector(".translation-detail")).toBeNull();
    expect(root.querySelector('[data-voice-tab="command"]')).not.toBeNull();
  });
});
