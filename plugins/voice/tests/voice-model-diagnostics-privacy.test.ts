/**
 * 2.14.3-rc.2 隐私小修（§6.0 #waiting-failure-minimum）：Voice 页上所有带模型的诊断——模型下载失败 /
 * 下载中的 warn 行与活动行、设置页模型行、重新转写——复制全文只写登记的模型 ID，自定义模型的名字与
 * 路径一律换成「自定义模型」。设置页等用户自己看的位置照常显示真实名字。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { VoiceModelInfo } from "@reai/app-sdk/v1";
import { createDefaultVoiceViewState, type VoiceHistoryItem, type VoiceViewState } from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { setVoiceLocale } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
beforeEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); });

const CUSTOM_ID = "alice-private-asr";
const CUSTOM_NAME = "/Users/alice/Models/私人模型.onnx";
/** 复制全文里一个都不许出现的片段（名字、路径、用户名）。 */
const PRIVATE = [CUSTOM_ID, CUSTOM_NAME, "alice", "/Users", "私人模型", ".onnx"];

function model(overrides: Partial<VoiceModelInfo>): VoiceModelInfo {
  return {
    id: CUSTOM_ID, name: CUSTOM_NAME, description: "", sizeBytes: 1000, state: "failed",
    active: false, updateAvailable: false, error: "download failed", ...overrides,
  };
}

function mount(overrides: Partial<VoiceViewState>) {
  const root = document.createElement("div");
  document.body.append(root);
  const copies: string[] = [];
  const actions = new Proxy({ onCopyText: async (text: string) => { copies.push(text); } } as Record<string, unknown>, {
    get: (target, key) => target[key as string] ?? (async () => undefined),
  }) as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({ developerMode: true, hostVersion: { state: "ready", version: "1.0.0-rc.1" }, statusLoad: "loaded", ...overrides });
  const view = mountVoiceView(root, state, actions);
  return { root, copies, view };
}

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 5)); };
const click = (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  (element as HTMLElement).click();
};

/** 展开某个诊断块并点「复制诊断信息」，返回复制出去的全文。 */
async function copyOf(h: ReturnType<typeof mount>, selector: string): Promise<string> {
  click(h.root.querySelector(`${selector} .voice-diag-toggle`));
  click(h.root.querySelector(`${selector} .voice-diag-copy`));
  await settle();
  expect(h.copies.length).toBeGreaterThan(0);
  return h.copies.at(-1)!;
}

function expectPrivate(text: string) {
  for (const piece of PRIVATE) if (text.includes(piece)) throw new Error(`复制全文泄露「${piece}」：\n${text}`);
}

test("自定义本地模型下载失败：warn 行复制全文只写「自定义模型」，名字与路径不出现", async () => {
  const h = mount({ models: [model({})] });
  const text = await copyOf(h, ".voice-diag[data-diag-key='warn:model:alice-private-asr']");
  expect(text).toContain("当前步骤: 下载本地语音模型 自定义模型");
  expect(text).toContain("  - 模型: 自定义模型 (local) · failed");
  expectPrivate(text);
});

test("自定义本地模型下载中：页头活动行的步骤与复制全文同样不带名字", async () => {
  const h = mount({ models: [model({ state: "downloading", downloadedBytes: 10 })] });
  const row = h.root.querySelector<HTMLElement>(".voice-activity")!;
  expect(row.querySelector(".voice-diag-step")?.textContent).toBe("下载本地语音模型 自定义模型");
  const text = await copyOf(h, ".voice-activity");
  expect(text).toContain("当前步骤: 下载本地语音模型 自定义模型");
  expectPrivate(text);
});

test("登记的内置模型照常原样：步骤写登记名，对象状态写模型 ID", async () => {
  const h = mount({ models: [model({ id: "sensevoice-small-int8", name: "SenseVoice Small" })] });
  const text = await copyOf(h, ".voice-diag[data-diag-key='warn:model:sensevoice-small-int8']");
  expect(text).toContain("当前步骤: 下载本地语音模型 SenseVoice Small");
  expect(text).toContain("  - 模型: sensevoice-small-int8 · failed");
});

test("设置页模型行：用户看到真实名字，下载中 / 失败的诊断复制全文只写「自定义模型」", async () => {
  for (const state of ["downloading", "failed"] as const) {
    document.body.replaceChildren();
    const h = mount({ models: [model({ state, downloadedBytes: 10 })] });
    h.view.openSettings();
    const card = h.root.querySelector<HTMLElement>('[data-settings-target="model"]')!.parentElement!;
    // 用户自己看的设置行不经过白名单：照常显示真实名字。
    expect(card.textContent).toContain(CUSTOM_NAME);
    expect(card.querySelector(".voice-diag[data-diag-key^='model:alice-private-asr:']")).not.toBeNull();
    const text = await copyOf(h, ".voice-diag[data-diag-key^='model:alice-private-asr:']");
    expect(text).toContain("  - 模型: 自定义模型 (local) · " + state);
    expectPrivate(text);
    h.view.dispose();
  }
});

function retryItem(selection: { engine: "local" | "cloud"; modelId: string; modelName: string }): VoiceHistoryItem {
  return {
    id: "input-1", transcript: "", language: "zh-CN", source: "board", inserted: false, durationMs: 2000,
    createdAt: "2026-09-27T08:00:00.000Z", recordingId: "rec-1", recordingWallStartMs: Date.now() - 1000,
    transcriptionStatus: "failed",
    savedInput: {
      attemptId: "attempt-1", revision: 1, state: "failed", startedAtMs: 1_000, finishedAtMs: 3_000, errorCode: "AI_UNAVAILABLE",
      selection: { ...selection, language: "zh-CN", punctEnabled: true },
    },
  } as VoiceHistoryItem;
}

test("重新转写失败：回执里的自定义模型只写「自定义模型 (来源)」；诊断区显示值（只在界面）不受影响", async () => {
  const h = mount({ history: [retryItem({ engine: "local", modelId: "Users.alice.private-asr", modelName: CUSTOM_NAME })] });
  click(h.root.querySelector(".task-item"));
  const text = await copyOf(h, ".voice-retry-panel .voice-diag");
  expect(text).toContain("  - 模型: 自定义模型 (local)");
  expectPrivate(text);
  expect(h.root.querySelector(".voice-retry-panel .voice-diag-panel")?.textContent).toContain(CUSTOM_NAME);
});

test("重新转写失败：登记的云端选项 ID 原样进复制全文", async () => {
  const h = mount({ history: [retryItem({ engine: "cloud", modelId: "transcribe-free", modelName: "免费云转写" })] });
  click(h.root.querySelector(".task-item"));
  const text = await copyOf(h, ".voice-retry-panel .voice-diag");
  expect(text).toContain("  - 模型: transcribe-free");
});
