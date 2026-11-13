import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import type { LocaleClient, LocaleSnapshot } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import enLocale from "../assets/locales/en.json";
import zhLocale from "../assets/locales/zh.json";
import pkg from "../package.json";
import { createVoiceChatMessages } from "../src/i18n";
import { VoiceChatPreferencesStore } from "../src/preferences-store";
import { CHANGELOG_TEXT } from "../src/release-notes";
import { extractChangelogSection, mountVoiceChatSettingsView } from "../src/settings-view";
import { mountVoiceStageView } from "../src/voice-stage-view";

beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

function createTestLocale(initial = "zh") {
  let current = initial;
  const listeners = new Set<(snap: LocaleSnapshot) => void>();
  const snapshot = () => ({ locale: current, fallbackLocale: "en", revision: 1 }) as unknown as LocaleSnapshot;
  return {
    client: {
      getSnapshot: snapshot,
      onChange(fn: (snap: LocaleSnapshot) => void) {
        listeners.add(fn);
        fn(snapshot());
        return () => listeners.delete(fn);
      },
    } as LocaleClient,
    set(next: string) {
      current = next;
      for (const fn of listeners) fn(snapshot());
    },
  };
}

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      keys.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

test("中英文语言包键树与占位符完全对齐，Manifest 与 package.json 版本一致", () => {
  expect(pkg.version).toBe(manifest.version);
  expect(flattenKeys(zhLocale)).toEqual(flattenKeys(enLocale));
  expect(CHANGELOG_TEXT).toBe(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
  expect(extractChangelogSection(CHANGELOG_TEXT, manifest.version)).toContain(`## ${manifest.version}`);
});

test("OS1 主界面保持极简并支持唤醒、状态推进、随时打断与设置联动", async () => {
  const root = document.createElement("div");
  document.body.append(root);

  const memory = new Map<string, unknown>();
  const store = new VoiceChatPreferencesStore({
    get: async <T>(k: string) => memory.get(k) as T | undefined,
    set: async (k: string, v: unknown) => {
      memory.set(k, v);
    },
  });
  const locale = createTestLocale("zh");
  const messages = createVoiceChatMessages(locale.client);
  const stage = mountVoiceStageView(root, store, messages);

  const shell = root.querySelector<HTMLElement>("[data-vc-stage]")!;
  const stateLabel = root.querySelector<HTMLElement>("[data-state-label]")!;
  const orbBtn = root.querySelector<HTMLButtonElement>("[data-orb-trigger]")!;
  const ctaBtn = root.querySelector<HTMLButtonElement>("[data-call-cta]")!;
  const subtitle = root.querySelector<HTMLElement>("[data-subtitle]")!;
  const brainPill = root.querySelector<HTMLElement>("[data-brain-pill]")!;

  expect(shell.dataset.mood).toBe("os1-auto");
  expect(shell.dataset.orbState).toBe("idle");
  expect(stateLabel.textContent).toBe("轻触圆环 · 开启对话");
  expect(brainPill.textContent).toBe("Agent · Auto (Pi)");
  expect(subtitle.dataset.visible).toBe("false");

  // 点击圆环进入唤醒态
  orbBtn.click();
  expect(shell.dataset.orbState).toBe("connecting");
  expect(ctaBtn.dataset.active).toBe("true");

  // 修改设置：开启字幕、切换 OS1 经典暖绯红、切为 DSH 引擎
  await store.save({
    ...store.value,
    brain: { ...store.value.brain, agentRuntime: "dsh" },
    experience: { ...store.value.experience, mood: "os1-crimson", showSubtitles: true },
  });
  expect(shell.dataset.mood).toBe("os1-crimson");
  expect(brainPill.textContent).toBe("Agent · DSH");
  expect(subtitle.dataset.visible).toBe("true");

  // 实时切换英文不卸载 DOM
  locale.set("en");
  expect(stateLabel.textContent).toBe("Awakening voice space…");

  // 点击主按钮结束对话回到待机
  ctaBtn.click();
  expect(shell.dataset.orbState).toBe("idle");

  stage.dispose();
});

test("设置页支持四层解耦动态切换，且底部版本与关于插件严格符合规范", async () => {
  const root = document.createElement("div");
  document.body.append(root);

  const memory = new Map<string, unknown>();
  const store = new VoiceChatPreferencesStore({
    get: async <T>(k: string) => memory.get(k) as T | undefined,
    set: async (k: string, v: unknown) => {
      memory.set(k, v);
    },
  });
  const locale = createTestLocale("zh");
  const messages = createVoiceChatMessages(locale.client);
  const view = mountVoiceChatSettingsView(root, store, messages, {
    appId: manifest.appId,
    version: manifest.version,
    changelogText: CHANGELOG_TEXT,
  });

  // 默认展示 Agent 服务分组，隐藏自定义接口分组
  const customRows = [...root.querySelectorAll<HTMLElement>("[data-group-custom]")];
  expect(customRows.every((el) => el.hidden)).toBe(true);

  const brainSelect = root.querySelector<HTMLSelectElement>("[data-brain-mode]")!;
  brainSelect.value = "custom-openai";
  brainSelect.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(store.value.brain.mode).toBe("custom-openai");
  expect(customRows.every((el) => !el.hidden)).toBe(true);

  // 切换 TTS 为外脑语音网关时显示 CosyVoice2 等选项
  const ttsSelect = root.querySelector<HTMLSelectElement>("[data-tts-provider]")!;
  ttsSelect.value = "wainao-gateway";
  ttsSelect.dispatchEvent(new Event("change"));
  await Promise.resolve();
  expect(store.value.tts.provider).toBe("wainao-gateway");
  const wainaoRows = [...root.querySelectorAll<HTMLElement>("[data-group-tts-wainao]")];
  expect(wainaoRows.every((el) => !el.hidden)).toBe(true);

  // 底部合规按钮顺序：版本在前，关于插件在后
  const footerBtns = [...root.querySelectorAll<HTMLButtonElement>("[data-plugin-info] button")];
  expect(footerBtns.map((b) => b.textContent)).toEqual([`版本 ${manifest.version}`, "关于插件"]);
  expect(footerBtns[0]!.getAttribute("aria-label")).toBe(`查看版本 ${manifest.version} 的更新日志`);
  expect(footerBtns[1]!.getAttribute("aria-label")).toBe("关于 语音对话");

  footerBtns[0]!.click();
  expect(root.querySelector(".vc-changelog-pre")?.textContent).toContain("## 0.1.0");

  footerBtns[1]!.click();
  expect(root.querySelector(".vc-about-dl")?.textContent).toContain(
    "https://open.reai.com/apps/com.reai.voice-chat",
  );

  locale.set("en");
  expect(footerBtns[0]!.textContent).toBe(`Version ${manifest.version}`);
  expect(root.querySelector("[data-info-title]")?.textContent).toBe("About Voice Chat");

  view.dispose();
});
