/**
 * 普通模式（未开开发者模式）只给人话：不出现错误码、枚举、内部模型编号、上游原文与
 * 「已等待至少 N 秒（自打开页面起）」。开发者模式下同一场景仍保留诊断。
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createDefaultVoiceViewState, DEFAULT_SETTINGS, type VoiceViewState } from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { setVoiceDeveloperMode } from "../src/voice-presentation-mode";
import { toolProgressText } from "../src/voice-agent-presentation";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
afterEach(() => { document.body.replaceChildren(); setVoiceLocale("zh"); setVoiceDeveloperMode(false); });

const RAW = "UPSTREAM_RAW_MARKER boom";
function mount(developerMode: boolean, overrides: Partial<VoiceViewState>, actions: Partial<VoiceViewActions> = {}) {
  setVoiceDeveloperMode(developerMode);
  const root = document.createElement("div");
  document.body.append(root);
  const base = {
    onCopyText: async () => undefined, onToggle: async () => undefined, onCommandToggle: async () => undefined,
    onOpenSystemTask: async () => undefined, onRefresh: async () => undefined, onSettingsChanged: async () => undefined,
    onFeatureSettingsChanged: async () => undefined, onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined, onMarkCommandRead: async () => undefined,
    onSendCommandFollowUp: async () => "task", onDictateDraft: async () => ({ phase: "listening" }),
    onDictationResultConsumed: async () => undefined, onDictateCancel: async () => undefined,
    onRetryInputTranscription: async () => undefined, onOpenAppPermissions: async () => undefined,
    onLoadReplayAudio: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }),
    ...actions,
  } as unknown as VoiceViewActions;
  const state = createDefaultVoiceViewState({ developerMode, statusLoad: "loaded", commandLoggedIn: true, ...overrides });
  const view = mountVoiceView(root, state, base);
  return { root, view, state };
}
const text = (root: HTMLElement) => root.textContent ?? "";

for (const locale of ["zh", "en"] as const) {
  test(`plain mode source warnings speak plainly (${locale})`, () => {
    setVoiceLocale(locale);
    const keyboard = mount(false, { settings: { ...DEFAULT_SETTINGS, source: "board" }, sourceIssue: "disconnected", sourceReady: false });
    expect(text(keyboard.root)).toContain(t("view.keyboardDisconnectedHint"));
    // The raw enum may coincide with ordinary English words; assert the diagnostic sentence is absent.
    expect(text(keyboard.root)).not.toMatch(/App 报告|App reports/);
    const board = mount(false, { settings: { ...DEFAULT_SETTINGS, source: "board" }, sourceIssue: "source_unavailable", sourceReady: false });
    expect(text(board.root)).toContain(t("view.aiBoardUnavailableHint"));
    expect(text(board.root)).not.toContain("source_unavailable");
    expect(text(board.root)).not.toMatch(/App 报告|App reports/);
  });

  test(`plain mode cloud settings never show internal IDs, codes or observed waits (${locale})`, () => {
    setVoiceLocale(locale);
    const loading = mount(false, { settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, cloudModels: [], cloudModelsLoading: true,
      featureSettings: { ...createDefaultVoiceViewState().featureSettings, cloudModelId: "transcribe-old-choice" } });
    loading.view.toggleSettings();
    expect(text(loading.root)).not.toContain("transcribe-old-choice");
    expect(text(loading.root)).not.toContain(t("diagnostics.elapsedObserved", { duration: "" }).trim().slice(0, 4));
    const failed = mount(false, { settings: { ...DEFAULT_SETTINGS, engine: "cloud" }, cloudModels: [], cloudModelsUnavailable: true,
      cloudModelsRetryExhausted: true, cloudModelsFailureCode: "AI_UNAVAILABLE",
      cloudModelsErrorDetail: { step: "cloudModels", at: new Date().toISOString(), code: "AI_UNAVAILABLE" } as never,
      featureSettings: { ...createDefaultVoiceViewState().featureSettings, cloudModelId: "transcribe-old-choice" } });
    expect(text(failed.root)).toContain(t("view.cloudRetryStoppedHint"));
    expect(text(failed.root)).not.toContain(t("diagnostics.cloudModelsReason"));
    failed.view.toggleSettings();
    expect(text(failed.root)).toContain(t("view.previousCloudChoiceUnavailable"));
    for (const leak of ["transcribe-old-choice", "AI_UNAVAILABLE"]) expect(text(failed.root)).not.toContain(leak);
  });

  test(`plain mode local model download failure hides Host text (${locale})`, () => {
    setVoiceLocale(locale);
    const model = { id: "sense", name: "Sense", description: "", sizeBytes: 10, state: "failed" as const, active: true, updateAvailable: false, error: RAW };
    const h = mount(false, { settings: { ...DEFAULT_SETTINGS, engine: "local", modelId: "sense" }, models: [model] });
    expect(text(h.root)).not.toContain(RAW);
    h.view.toggleSettings();
    expect(text(h.root)).not.toContain(RAW);
  });
}

test("developer mode keeps the real source state and internal option ID", () => {
  const h = mount(true, { settings: { ...DEFAULT_SETTINGS, source: "board", engine: "cloud" }, sourceIssue: "disconnected", sourceReady: false,
    cloudModels: [], cloudModelsUnavailable: true,
    featureSettings: { ...createDefaultVoiceViewState().featureSettings, cloudModelId: "transcribe-old-choice" } });
  expect(text(h.root)).toMatch(/App 报告：disconnected/);
  h.view.toggleSettings();
  expect(text(h.root)).toContain("transcribe-old-choice");
});

test("tool progress text that leaves the detail page carries no error code", () => {
  const line = toolProgressText({ status: "failed", calls: [{ tool: "web_search", status: "failed", errorCode: "browser_plugin_declined", errorLabel: RAW }] } as never);
  expect(line).not.toContain("browser_plugin_declined");
  expect(line).not.toContain(RAW);
});
