import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { DEFAULT_SETTINGS, createDefaultVoiceViewState } from "../src/data";
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
beforeEach(() => { setVoiceLocale("zh"); document.body.replaceChildren(); });
afterEach(() => setVoiceLocale("zh"));

const BASE_ACTIONS: VoiceViewActions = {
  onToggle: async () => undefined,
  onCommandToggle: async () => undefined,
  onOpenSystemTask: async () => undefined,
  onRefresh: async () => undefined,
  onSettingsChanged: async () => undefined,
  onFeatureSettingsChanged: async () => undefined,
  onDownloadModel: async () => undefined,
  onCancelModelDownload: async () => undefined,
  onRequestPermission: async () => undefined,
  onContinuousRecording: async () => undefined,
  onTimelinePaused: async () => undefined,
  onSendContextToAgent: async () => undefined,
  onDictateDraft: async () => ({ phase: "listening" }) as never,
  onDictationResultConsumed: async () => undefined,
  onOpenAccountLogin: async () => undefined,
  onOpenKeymap: async () => undefined,
  onClearRecordings: async () => undefined,
  onReplayRetentionChanged: async () => undefined,
  onNavigated: () => undefined,
  onScreenshotConsentConfirm: async () => undefined,
  onScreenshotConsentRevoked: async () => undefined,
} as unknown as VoiceViewActions;

function mountConsent(enabled: boolean, actions: Partial<VoiceViewActions>) {
  const root = document.createElement("div");
  document.body.append(root);
  const state = createDefaultVoiceViewState({
    settings: { ...DEFAULT_SETTINGS, polish: "light" },
    screenshotConsent: { enabled },
  });
  const view = mountVoiceView(root, state, { ...BASE_ACTIONS, ...actions } as VoiceViewActions);
  view.openSettings();
  return { root, view };
}

describe("截图同意设置 UI（§5D）", () => {
  test("原样档不显示截图开关；云端档显示且默认关", () => {
    const off = mountConsent(false, {});
    const control = off.root.querySelector<HTMLButtonElement>('[aria-label="当前窗口截图辅助"]');
    expect(control).not.toBeNull();
    expect(control?.getAttribute("aria-checked")).toBe("false");

    // raw 档：不渲染截图开关（原样档什么都不发，截图无从谈起）。
    const rawRoot = document.createElement("div");
    document.body.append(rawRoot);
    mountVoiceView(rawRoot, createDefaultVoiceViewState({ settings: { ...DEFAULT_SETTINGS, polish: "raw" } }), BASE_ACTIONS);
    expect(rawRoot.querySelector('[aria-label="当前窗口截图辅助"]')).toBeNull();
  });

  test("打开开关先弹同意框，勾选+确认才调用 onScreenshotConsentConfirm", () => {
    let confirmed = 0;
    const h = mountConsent(false, { onScreenshotConsentConfirm: async () => { confirmed += 1; } });
    h.root.querySelector<HTMLButtonElement>('[aria-label="当前窗口截图辅助"]')?.click();
    const dialog = h.root.querySelector(".voice-consent-dialog") as HTMLElement | null;
    expect(dialog).not.toBeNull();
    // 未勾选时确认不可点。
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent === "确认并开启");
    expect(confirm?.disabled).toBe(true);
    const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(confirm?.disabled).toBe(false);
    confirm?.click();
    expect(confirmed).toBe(1);
    // 取消路径不确认。
    h.root.querySelector<HTMLButtonElement>('[aria-label="当前窗口截图辅助"]')?.click();
    const cancel = Array.from(h.root.querySelectorAll<HTMLButtonElement>(".voice-consent-dialog button"))
      .find((button) => button.textContent === "取消");
    cancel?.click();
    expect(confirmed).toBe(1);
  });

  test("已开启时再点开关直接撤销，调用 onScreenshotConsentRevoked", () => {
    let revoked = 0;
    const h = mountConsent(true, { onScreenshotConsentRevoked: async () => { revoked += 1; } });
    const control = h.root.querySelector<HTMLButtonElement>('[aria-label="当前窗口截图辅助"]');
    expect(control?.getAttribute("aria-checked")).toBe("true");
    control?.click();
    expect(revoked).toBe(1);
    expect(h.root.querySelector(".voice-consent-dialog")).toBeNull();
  });
});

describe("截图同意 UI 双语（§5E）", () => {
  test("locale=en 时行与对话框按英文资源渲染（显式节点绑定，非 DOM 遍历替换）", () => {
    const root = document.createElement("div");
    document.body.append(root);
    setVoiceLocale("en");
    mountVoiceView(root, createDefaultVoiceViewState({
      settings: { ...DEFAULT_SETTINGS, polish: "light" },
    }), BASE_ACTIONS).openSettings();
    const control = root.querySelector<HTMLButtonElement>('[aria-label="Current window screenshot assist"]');
    expect(control).not.toBeNull();
    expect(root.textContent).toContain("Current window screenshot");
    control?.click();
    const dialog = root.querySelector(".voice-consent-dialog");
    expect(dialog?.textContent).toContain("Screenshots are sent to the cloud");
    expect(dialog?.textContent).toContain("Confirm and enable");
  });
});

describe("主界面文案双语（§5E B 档）", () => {
  test("locale=en 时设置分区标题与记录 tab 为英文", () => {
    const root = document.createElement("div");
    document.body.append(root);
    setVoiceLocale("en");
    mountVoiceView(root, createDefaultVoiceViewState({
      settings: { ...DEFAULT_SETTINGS, polish: "light" },
    }), BASE_ACTIONS).openSettings();
    for (const title of ["Recording & recognition", "Polish", "Voice commands", "System"]) {
      expect(root.textContent).toContain(title);
    }
  });
});

test("translation control saves an explicit target and preserves selection on interface language change", () => {
  let selected: string | undefined;
  const h = mountConsent(false, { onFeatureSettingsChanged: async (patch) => { selected = patch.translationTarget; } });
  try {
    const control = h.root.querySelector<HTMLSelectElement>("[data-translation-target]")!;
    expect(control.value).toBe("en-US");
    control.value = "ja-JP";
    control.dispatchEvent(new Event("change", { bubbles: true }));
    expect(selected).toBe("ja-JP");
    setVoiceLocale("en");
    expect(h.root.querySelector("[data-translation-target]")).toBe(control);
    expect(control.value).toBe("ja-JP");
    expect(control.selectedOptions[0]?.textContent).toBe("Japanese");
    expect(control.getAttribute("aria-label")).toBe("Translation target");
  } finally { h.view.dispose(); }
});
