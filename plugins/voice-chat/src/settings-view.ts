import { createVoiceChatMessages, type VoiceChatMessages } from "./i18n";
import {
  DEFAULT_VOICE_SYSTEM_PROMPT,
  type VoiceChatPreferencesStore,
} from "./preferences-store";
import type {
  AgentMemoryMode,
  AgentRuntimeChoice,
  BrainMode,
  ExternalBrainTier,
  Os1Mood,
  SttLanguageChoice,
  SttProviderChoice,
  TtsProviderChoice,
  VoiceChatSettings,
  WainaoTtsModel,
} from "./types";

export interface VoiceChatPluginInfo {
  appId: string;
  version: string;
  changelogText: string;
}

export interface VoiceChatSettingsView {
  dispose(): void;
}

/** 从完整 CHANGELOG.md 精确提取当前安装版本段落，找不到时返回 null。 */
export function extractChangelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+(\S+)/.exec(line)?.[1] === version);
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start, next === -1 ? lines.length : next).join("\n").trim();
}

export function mountVoiceChatSettingsView(
  root: HTMLElement,
  store: VoiceChatPreferencesStore,
  messages: VoiceChatMessages = createVoiceChatMessages(),
  info?: VoiceChatPluginInfo,
): VoiceChatSettingsView {
  root.innerHTML = `
    <div class="vc-settings-scroll">
      <div class="vc-settings-container">
        <header class="vc-settings-header">
          <h1 data-i18n="settings.title"></h1>
          <p data-i18n="settings.subtitle"></p>
        </header>

        <!-- 1. 对话大脑（Agent 与推理层解耦） -->
        <section class="vc-section">
          <div class="vc-section-label" data-i18n="settings.brainSection"></div>
          <div class="vc-card">
            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.brainMode"></div>
                <div class="vc-row-hint" data-i18n="settings.brainModeHint"></div>
              </div>
              <select class="vc-select" data-brain-mode data-i18n-aria-label="settings.brainMode" aria-label="">
                <option value="agent-service" data-i18n="settings.brainModeAgent"></option>
                <option value="external-brain" data-i18n="settings.brainModeExternal"></option>
                <option value="custom-openai" data-i18n="settings.brainModeCustom"></option>
              </select>
            </label>

            <label class="vc-row" data-group-agent>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.agentRuntime"></div>
                <div class="vc-row-hint" data-i18n="settings.agentRuntimeHint"></div>
              </div>
              <select class="vc-select" data-agent-runtime data-i18n-aria-label="settings.agentRuntime" aria-label="">
                <option value="auto" data-i18n="settings.runtimeAuto"></option>
                <option value="pi" data-i18n="settings.runtimePi"></option>
                <option value="dsh" data-i18n="settings.runtimeDsh"></option>
                <option value="codex" data-i18n="settings.runtimeCodex"></option>
              </select>
            </label>

            <label class="vc-row" data-group-agent>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.agentMemory"></div>
                <div class="vc-row-hint" data-i18n="settings.agentMemoryHint"></div>
              </div>
              <select class="vc-select" data-agent-memory data-i18n-aria-label="settings.agentMemory" aria-label="">
                <option value="session" data-i18n="settings.memorySession"></option>
                <option value="one-shot" data-i18n="settings.memoryOneShot"></option>
              </select>
            </label>

            <div class="vc-row" data-group-agent>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.fillerOnTool"></div>
                <div class="vc-row-hint" data-i18n="settings.fillerOnToolHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-filler-toggle data-i18n-aria-label="settings.fillerOnTool" aria-label=""><i></i></button>
            </div>

            <label class="vc-row" data-group-external hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.externalTier"></div>
                <div class="vc-row-hint" data-i18n="settings.externalTierHint"></div>
              </div>
              <select class="vc-select" data-external-tier data-i18n-aria-label="settings.externalTier" aria-label="">
                <option value="text-default" data-i18n="settings.tierDefault"></option>
                <option value="text-quality" data-i18n="settings.tierQuality"></option>
              </select>
            </label>

            <label class="vc-row" data-group-custom hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.customBaseUrl"></div>
                <div class="vc-row-hint" data-i18n="settings.customBaseUrlHint"></div>
              </div>
              <input class="vc-input" type="url" data-custom-base-url spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row" data-group-custom hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.customModel"></div>
                <div class="vc-row-hint" data-i18n="settings.customModelHint"></div>
              </div>
              <input class="vc-input" type="text" data-custom-model spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row" data-group-custom hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.customApiKey"></div>
                <div class="vc-row-hint" data-i18n="settings.customApiKeyHint"></div>
              </div>
              <input class="vc-input" type="password" data-custom-api-key data-i18n-placeholder="settings.customApiKeyPlaceholder" autocomplete="off" />
            </label>

            <div class="vc-row" data-group-custom hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.disableThinking"></div>
                <div class="vc-row-hint" data-i18n="settings.disableThinkingHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-disable-thinking data-i18n-aria-label="settings.disableThinking" aria-label=""><i></i></button>
            </div>

            <div class="vc-row vc-row-stack">
              <div class="vc-stack-head">
                <div>
                  <div class="vc-row-title" data-i18n="settings.systemPrompt"></div>
                  <div class="vc-row-hint" data-i18n="settings.systemPromptHint"></div>
                </div>
                <button class="vc-ghost-btn" type="button" data-restore-prompt data-i18n="settings.restorePrompt"></button>
              </div>
              <textarea class="vc-textarea" rows="3" data-system-prompt data-i18n-aria-label="settings.systemPrompt" aria-label=""></textarea>
            </div>
          </div>
        </section>

        <!-- 2. 语音转文本（STT · 本地模型优先） -->
        <section class="vc-section">
          <div class="vc-section-label" data-i18n="settings.sttSection"></div>
          <div class="vc-card">
            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.sttProvider"></div>
                <div class="vc-row-hint" data-i18n="settings.sttProviderHint"></div>
              </div>
              <select class="vc-select" data-stt-provider data-i18n-aria-label="settings.sttProvider" aria-label="">
                <option value="voice-plugin" data-i18n="settings.sttVoicePlugin"></option>
                <option value="host-sensevoice" data-i18n="settings.sttHostClips"></option>
                <option value="local-bridge" data-i18n="settings.sttLocalBridge"></option>
              </select>
            </label>

            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.sttLanguage"></div>
                <div class="vc-row-hint" data-i18n="settings.sttLanguageHint"></div>
              </div>
              <select class="vc-select" data-stt-language data-i18n-aria-label="settings.sttLanguage" aria-label="">
                <option value="auto" data-i18n="settings.langAuto"></option>
                <option value="zh" data-i18n="settings.langZh"></option>
                <option value="en" data-i18n="settings.langEn"></option>
              </select>
            </label>

            <label class="vc-row" data-group-stt-bridge hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.localBridgeUrl"></div>
                <div class="vc-row-hint" data-i18n="settings.localBridgeUrlHint"></div>
              </div>
              <input class="vc-input" type="url" data-local-bridge-url spellcheck="false" autocomplete="off" />
            </label>

            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.localModelReuse"></div>
                <div class="vc-row-hint" data-i18n="settings.localModelReuseHint"></div>
              </div>
              <span class="vc-status-tag" data-i18n="settings.localModelBadge"></span>
            </div>
          </div>
        </section>

        <!-- 3. 文本转语音（TTS · 流式合成） -->
        <section class="vc-section">
          <div class="vc-section-label" data-i18n="settings.ttsSection"></div>
          <div class="vc-card">
            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsProvider"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsProviderHint"></div>
              </div>
              <select class="vc-select" data-tts-provider data-i18n-aria-label="settings.ttsProvider" aria-label="">
                <option value="system-speech" data-i18n="settings.ttsSystem"></option>
                <option value="wainao-gateway" data-i18n="settings.ttsWainao"></option>
                <option value="fish-audio" data-i18n="settings.ttsFish"></option>
                <option value="minimax" data-i18n="settings.ttsMinimax"></option>
                <option value="openai-compatible" data-i18n="settings.ttsOpenai"></option>
              </select>
            </label>

            <label class="vc-row" data-group-tts-wainao hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.wainaoTtsModel"></div>
                <div class="vc-row-hint" data-i18n="settings.wainaoTtsModelHint"></div>
              </div>
              <select class="vc-select" data-wainao-model data-i18n-aria-label="settings.wainaoTtsModel" aria-label="">
                <option value="CosyVoice2">CosyVoice2</option>
                <option value="qwen3-tts-flash">qwen3-tts-flash</option>
                <option value="step-tts-mini">step-tts-mini</option>
                <option value="qwen-audio-3.0-tts-flash">qwen-audio-3.0-tts-flash</option>
              </select>
            </label>

            <label class="vc-row" data-group-tts-wainao hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.wainaoProjectId"></div>
                <div class="vc-row-hint" data-i18n="settings.wainaoProjectIdHint"></div>
              </div>
              <input class="vc-input" type="text" data-wainao-project spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row" data-group-tts-endpoint hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsEndpoint"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsEndpointHint"></div>
              </div>
              <input class="vc-input" type="url" data-tts-endpoint spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row" data-group-tts-model hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsModel"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsModelHint"></div>
              </div>
              <input class="vc-input" type="text" data-tts-model spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsVoiceId"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsVoiceIdHint"></div>
              </div>
              <input class="vc-input" type="text" data-tts-voice data-i18n-placeholder="settings.ttsVoicePlaceholder" spellcheck="false" autocomplete="off" />
            </label>

            <label class="vc-row" data-group-tts-key hidden>
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsApiKey"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsApiKeyHint"></div>
              </div>
              <input class="vc-input" type="password" data-tts-key data-i18n-placeholder="settings.customApiKeyPlaceholder" autocomplete="off" />
            </label>

            <label class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.ttsSpeed"></div>
                <div class="vc-row-hint" data-i18n="settings.ttsSpeedHint"></div>
              </div>
              <select class="vc-select" data-tts-speed data-i18n-aria-label="settings.ttsSpeed" aria-label="">
                <option value="0.9">0.9x</option>
                <option value="1">1.0x</option>
                <option value="1.1">1.1x</option>
                <option value="1.2">1.2x</option>
              </select>
            </label>

            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.clauseStreaming"></div>
                <div class="vc-row-hint" data-i18n="settings.clauseStreamingHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-clause-streaming data-i18n-aria-label="settings.clauseStreaming" aria-label=""><i></i></button>
            </div>
          </div>
        </section>

        <!-- 4. 交互与视觉（OS1 体验） -->
        <section class="vc-section">
          <div class="vc-section-label" data-i18n="settings.expSection"></div>
          <div class="vc-card">
            <div class="vc-row vc-row-stack">
              <div class="vc-row-title" data-i18n="settings.moodLabel"></div>
              <div class="vc-mood-grid" role="radiogroup" data-i18n-aria-label="settings.moodLabel" aria-label="">
                <button class="vc-mood-card" type="button" role="radio" data-mood-choice="os1-auto">
                  <span class="vc-mood-swatch vc-swatch-auto" aria-hidden="true"></span>
                  <span data-i18n="settings.moodOs1Auto"></span>
                </button>
                <button class="vc-mood-card" type="button" role="radio" data-mood-choice="os1-crimson">
                  <span class="vc-mood-swatch vc-swatch-crimson" aria-hidden="true"></span>
                  <span data-i18n="settings.moodOs1Crimson"></span>
                </button>
                <button class="vc-mood-card" type="button" role="radio" data-mood-choice="host">
                  <span class="vc-mood-swatch vc-swatch-host" aria-hidden="true"></span>
                  <span data-i18n="settings.moodHost"></span>
                </button>
              </div>
            </div>

            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.autoContinue"></div>
                <div class="vc-row-hint" data-i18n="settings.autoContinueHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-auto-continue data-i18n-aria-label="settings.autoContinue" aria-label=""><i></i></button>
            </div>

            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.bargeIn"></div>
                <div class="vc-row-hint" data-i18n="settings.bargeInHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-barge-in data-i18n-aria-label="settings.bargeIn" aria-label=""><i></i></button>
            </div>

            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.subtitles"></div>
                <div class="vc-row-hint" data-i18n="settings.subtitlesHint"></div>
              </div>
              <button class="vc-toggle" type="button" role="switch" data-subtitles data-i18n-aria-label="settings.subtitles" aria-label=""><i></i></button>
            </div>
          </div>
        </section>

        <!-- 重置 -->
        <section class="vc-section">
          <div class="vc-section-label" data-i18n="settings.resetSection"></div>
          <div class="vc-card">
            <div class="vc-row">
              <div class="vc-row-copy">
                <div class="vc-row-title" data-i18n="settings.resetTitle"></div>
                <div class="vc-row-hint" data-i18n="settings.resetHint"></div>
              </div>
              <button class="vc-ghost-btn" type="button" data-reset-all data-i18n="settings.resetButton"></button>
            </div>
          </div>
        </section>

        <p class="vc-feedback" data-feedback role="status" hidden></p>

        <!-- 底部统一入口：版本 + 关于插件（docs/plugin-settings-and-release-notes-v1.md） -->
        <footer class="vc-settings-footer" data-plugin-info hidden>
          <button class="vc-footer-link" type="button" data-info="changelog" aria-expanded="false"></button>
          <button class="vc-footer-link" type="button" data-info="about" aria-expanded="false" data-i18n="footer.about"></button>
        </footer>

        <section class="vc-card vc-info-card" data-info-card hidden>
          <div class="vc-info-head">
            <h2 data-info-title></h2>
            <button class="vc-footer-link" type="button" data-info-close data-i18n="footer.collapse"></button>
          </div>
          <div class="vc-info-body" data-info-body></div>
        </section>
      </div>
    </div>
  `;

  const brainModeSelect = root.querySelector<HTMLSelectElement>("[data-brain-mode]")!;
  const agentRuntimeSelect = root.querySelector<HTMLSelectElement>("[data-agent-runtime]")!;
  const agentMemorySelect = root.querySelector<HTMLSelectElement>("[data-agent-memory]")!;
  const fillerToggle = root.querySelector<HTMLButtonElement>("[data-filler-toggle]")!;
  const externalTierSelect = root.querySelector<HTMLSelectElement>("[data-external-tier]")!;
  const customBaseUrlInput = root.querySelector<HTMLInputElement>("[data-custom-base-url]")!;
  const customModelInput = root.querySelector<HTMLInputElement>("[data-custom-model]")!;
  const customApiKeyInput = root.querySelector<HTMLInputElement>("[data-custom-api-key]")!;
  const disableThinkingToggle = root.querySelector<HTMLButtonElement>("[data-disable-thinking]")!;
  const systemPromptArea = root.querySelector<HTMLTextAreaElement>("[data-system-prompt]")!;
  const restorePromptBtn = root.querySelector<HTMLButtonElement>("[data-restore-prompt]")!;

  const sttProviderSelect = root.querySelector<HTMLSelectElement>("[data-stt-provider]")!;
  const sttLanguageSelect = root.querySelector<HTMLSelectElement>("[data-stt-language]")!;
  const localBridgeUrlInput = root.querySelector<HTMLInputElement>("[data-local-bridge-url]")!;

  const ttsProviderSelect = root.querySelector<HTMLSelectElement>("[data-tts-provider]")!;
  const wainaoModelSelect = root.querySelector<HTMLSelectElement>("[data-wainao-model]")!;
  const wainaoProjectInput = root.querySelector<HTMLInputElement>("[data-wainao-project]")!;
  const ttsEndpointInput = root.querySelector<HTMLInputElement>("[data-tts-endpoint]")!;
  const ttsModelInput = root.querySelector<HTMLInputElement>("[data-tts-model]")!;
  const ttsVoiceInput = root.querySelector<HTMLInputElement>("[data-tts-voice]")!;
  const ttsKeyInput = root.querySelector<HTMLInputElement>("[data-tts-key]")!;
  const ttsSpeedSelect = root.querySelector<HTMLSelectElement>("[data-tts-speed]")!;
  const clauseStreamingToggle = root.querySelector<HTMLButtonElement>("[data-clause-streaming]")!;

  const autoContinueToggle = root.querySelector<HTMLButtonElement>("[data-auto-continue]")!;
  const bargeInToggle = root.querySelector<HTMLButtonElement>("[data-barge-in]")!;
  const subtitlesToggle = root.querySelector<HTMLButtonElement>("[data-subtitles]")!;
  const resetAllBtn = root.querySelector<HTMLButtonElement>("[data-reset-all]")!;
  const feedback = root.querySelector<HTMLElement>("[data-feedback]")!;

  const footer = root.querySelector<HTMLElement>("[data-plugin-info]")!;
  const versionButton = root.querySelector<HTMLButtonElement>('[data-info="changelog"]')!;
  const aboutButton = root.querySelector<HTMLButtonElement>('[data-info="about"]')!;
  const infoCard = root.querySelector<HTMLElement>("[data-info-card]")!;
  const infoTitle = root.querySelector<HTMLElement>("[data-info-title]")!;
  const infoBody = root.querySelector<HTMLElement>("[data-info-body]")!;
  const infoClose = root.querySelector<HTMLButtonElement>("[data-info-close]")!;

  let disposed = false;
  let saveTicket = 0;
  let feedbackTextFn: (() => string) | undefined;
  let infoKind: "changelog" | "about" | null = null;

  const setToggleState = (btn: HTMLButtonElement, on: boolean) => {
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  };

  const showGroup = (selector: string, visible: boolean) => {
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.hidden = !visible;
    });
  };

  const notify = (fn: () => string, isError = false) => {
    feedbackTextFn = fn;
    feedback.textContent = fn();
    feedback.classList.toggle("error", isError);
    feedback.hidden = false;
  };

  const persist = async (next: VoiceChatSettings, msgFn?: () => string) => {
    const ticket = ++saveTicket;
    try {
      await store.save(next);
      if (!disposed && ticket === saveTicket) {
        notify(msgFn ?? (() => messages.t("settings.saved")));
      }
    } catch (cause) {
      if (!disposed && ticket === saveTicket) {
        notify(() => messages.t("settings.saveFailed", { error: String(cause) }), true);
      }
    }
  };

  const render = (s: VoiceChatSettings) => {
    if (disposed) return;

    brainModeSelect.value = s.brain.mode;
    showGroup("[data-group-agent]", s.brain.mode === "agent-service");
    showGroup("[data-group-external]", s.brain.mode === "external-brain");
    showGroup("[data-group-custom]", s.brain.mode === "custom-openai");

    agentRuntimeSelect.value = s.brain.agentRuntime;
    agentMemorySelect.value = s.brain.agentMemory;
    setToggleState(fillerToggle, s.brain.fillerOnToolCall);
    externalTierSelect.value = s.brain.externalBrainTier;

    if (root.ownerDocument.activeElement !== customBaseUrlInput) {
      customBaseUrlInput.value = s.brain.customBaseUrl;
    }
    if (root.ownerDocument.activeElement !== customModelInput) {
      customModelInput.value = s.brain.customModel;
    }
    if (root.ownerDocument.activeElement !== customApiKeyInput) {
      customApiKeyInput.value = s.brain.customApiKey;
    }
    setToggleState(disableThinkingToggle, s.brain.disableThinking);
    if (root.ownerDocument.activeElement !== systemPromptArea) {
      systemPromptArea.value = s.brain.systemPrompt;
    }

    sttProviderSelect.value = s.stt.provider;
    sttLanguageSelect.value = s.stt.language;
    showGroup("[data-group-stt-bridge]", s.stt.provider === "local-bridge");
    if (root.ownerDocument.activeElement !== localBridgeUrlInput) {
      localBridgeUrlInput.value = s.stt.localBridgeUrl;
    }

    ttsProviderSelect.value = s.tts.provider;
    const isWainao = s.tts.provider === "wainao-gateway";
    const isOpenaiCompat = s.tts.provider === "openai-compatible";
    const isCloudKeyTts =
      s.tts.provider === "wainao-gateway" ||
      s.tts.provider === "fish-audio" ||
      s.tts.provider === "minimax" ||
      s.tts.provider === "openai-compatible";
    const hasCustomModel =
      s.tts.provider === "fish-audio" ||
      s.tts.provider === "minimax" ||
      s.tts.provider === "openai-compatible";

    showGroup("[data-group-tts-wainao]", isWainao);
    showGroup("[data-group-tts-endpoint]", isOpenaiCompat);
    showGroup("[data-group-tts-model]", hasCustomModel);
    showGroup("[data-group-tts-key]", isCloudKeyTts);

    wainaoModelSelect.value = s.tts.wainaoModel;
    if (root.ownerDocument.activeElement !== wainaoProjectInput) {
      wainaoProjectInput.value = s.tts.wainaoProjectId;
    }
    if (root.ownerDocument.activeElement !== ttsEndpointInput) {
      ttsEndpointInput.value = s.tts.endpointUrl;
    }
    if (root.ownerDocument.activeElement !== ttsModelInput) {
      ttsModelInput.value = s.tts.modelId;
    }
    if (root.ownerDocument.activeElement !== ttsVoiceInput) {
      ttsVoiceInput.value = s.tts.voiceId;
    }
    if (root.ownerDocument.activeElement !== ttsKeyInput) {
      ttsKeyInput.value = s.tts.apiKey;
    }
    ttsSpeedSelect.value = String(s.tts.speed);
    setToggleState(clauseStreamingToggle, s.tts.clauseStreaming);

    root.querySelectorAll<HTMLButtonElement>("[data-mood-choice]").forEach((btn) => {
      const active = btn.dataset.moodChoice === s.experience.mood;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });

    setToggleState(autoContinueToggle, s.experience.autoContinueListening);
    setToggleState(bargeInToggle, s.experience.bargeInEnabled);
    setToggleState(subtitlesToggle, s.experience.showSubtitles);
  };

  // Brain handlers
  brainModeSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, brain: { ...cur.brain, mode: brainModeSelect.value as BrainMode } });
  };
  agentRuntimeSelect.onchange = () => {
    const cur = store.value;
    void persist({
      ...cur,
      brain: { ...cur.brain, agentRuntime: agentRuntimeSelect.value as AgentRuntimeChoice },
    });
  };
  agentMemorySelect.onchange = () => {
    const cur = store.value;
    void persist({
      ...cur,
      brain: { ...cur.brain, agentMemory: agentMemorySelect.value as AgentMemoryMode },
    });
  };
  fillerToggle.onclick = () => {
    const cur = store.value;
    void persist({
      ...cur,
      brain: { ...cur.brain, fillerOnToolCall: !cur.brain.fillerOnToolCall },
    });
  };
  externalTierSelect.onchange = () => {
    const cur = store.value;
    void persist({
      ...cur,
      brain: { ...cur.brain, externalBrainTier: externalTierSelect.value as ExternalBrainTier },
    });
  };
  customBaseUrlInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, brain: { ...cur.brain, customBaseUrl: customBaseUrlInput.value } });
  };
  customModelInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, brain: { ...cur.brain, customModel: customModelInput.value } });
  };
  customApiKeyInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, brain: { ...cur.brain, customApiKey: customApiKeyInput.value } });
  };
  disableThinkingToggle.onclick = () => {
    const cur = store.value;
    void persist({
      ...cur,
      brain: { ...cur.brain, disableThinking: !cur.brain.disableThinking },
    });
  };
  systemPromptArea.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, brain: { ...cur.brain, systemPrompt: systemPromptArea.value } });
  };
  restorePromptBtn.onclick = () => {
    const cur = store.value;
    systemPromptArea.value = DEFAULT_VOICE_SYSTEM_PROMPT;
    void persist(
      { ...cur, brain: { ...cur.brain, systemPrompt: DEFAULT_VOICE_SYSTEM_PROMPT } },
      () => messages.t("settings.promptResetDone"),
    );
  };

  // STT handlers
  sttProviderSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, stt: { ...cur.stt, provider: sttProviderSelect.value as SttProviderChoice } });
  };
  sttLanguageSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, stt: { ...cur.stt, language: sttLanguageSelect.value as SttLanguageChoice } });
  };
  localBridgeUrlInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, stt: { ...cur.stt, localBridgeUrl: localBridgeUrlInput.value } });
  };

  // TTS handlers
  ttsProviderSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, provider: ttsProviderSelect.value as TtsProviderChoice } });
  };
  wainaoModelSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, wainaoModel: wainaoModelSelect.value as WainaoTtsModel } });
  };
  wainaoProjectInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, wainaoProjectId: wainaoProjectInput.value } });
  };
  ttsEndpointInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, endpointUrl: ttsEndpointInput.value } });
  };
  ttsModelInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, modelId: ttsModelInput.value } });
  };
  ttsVoiceInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, voiceId: ttsVoiceInput.value } });
  };
  ttsKeyInput.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, apiKey: ttsKeyInput.value } });
  };
  ttsSpeedSelect.onchange = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, speed: Number(ttsSpeedSelect.value) } });
  };
  clauseStreamingToggle.onclick = () => {
    const cur = store.value;
    void persist({ ...cur, tts: { ...cur.tts, clauseStreaming: !cur.tts.clauseStreaming } });
  };

  // Experience handlers
  root.querySelectorAll<HTMLButtonElement>("[data-mood-choice]").forEach((btn) => {
    btn.onclick = () => {
      const cur = store.value;
      const mood = btn.dataset.moodChoice as Os1Mood;
      void persist({ ...cur, experience: { ...cur.experience, mood } });
    };
  });
  autoContinueToggle.onclick = () => {
    const cur = store.value;
    void persist({
      ...cur,
      experience: { ...cur.experience, autoContinueListening: !cur.experience.autoContinueListening },
    });
  };
  bargeInToggle.onclick = () => {
    const cur = store.value;
    void persist({
      ...cur,
      experience: { ...cur.experience, bargeInEnabled: !cur.experience.bargeInEnabled },
    });
  };
  subtitlesToggle.onclick = () => {
    const cur = store.value;
    void persist({
      ...cur,
      experience: { ...cur.experience, showSubtitles: !cur.experience.showSubtitles },
    });
  };

  resetAllBtn.onclick = () => {
    void store.reset().then(() => {
      if (!disposed) notify(() => messages.t("settings.resetDone"));
    });
  };

  // Bottom Version & About compliance
  const pluginName = () => messages.t("metadata.name");
  const renderInfo = () => {
    if (!info) return;
    footer.hidden = false;
    versionButton.textContent = messages.t("footer.version", { version: info.version });
    versionButton.setAttribute("aria-label", messages.t("footer.versionAria", { version: info.version }));
    aboutButton.setAttribute("aria-label", messages.t("footer.aboutAria", { name: pluginName() }));
    versionButton.setAttribute("aria-expanded", String(infoKind === "changelog"));
    aboutButton.setAttribute("aria-expanded", String(infoKind === "about"));
    infoCard.hidden = infoKind === null;
    if (!infoKind) {
      infoBody.replaceChildren();
      return;
    }

    const makeNote = (text: string) => {
      const p = root.ownerDocument.createElement("p");
      p.className = "vc-info-note";
      p.textContent = text;
      return p;
    };

    if (infoKind === "changelog") {
      infoTitle.textContent = messages.t("footer.changelogTitle", { version: info.version });
      const section = extractChangelogSection(info.changelogText, info.version);
      const pre = root.ownerDocument.createElement("pre");
      pre.className = "vc-changelog-pre";
      pre.textContent = section ?? messages.t("footer.changelogMissing", { version: info.version });
      if (section) pre.lang = "zh";
      infoBody.replaceChildren(pre, ...(section ? [makeNote(messages.t("footer.changelogLangNote"))] : []));
      return;
    }

    infoTitle.textContent = messages.t("footer.aboutTitle", { name: pluginName() });
    const dl = root.ownerDocument.createElement("dl");
    dl.className = "vc-about-dl";
    for (const [term, value] of [
      [messages.t("footer.aboutPlugin"), pluginName()],
      [messages.t("footer.aboutVersion"), info.version],
      [messages.t("footer.aboutAppId"), info.appId],
      [messages.t("footer.aboutUrl"), `https://open.reai.com/apps/${encodeURIComponent(info.appId)}`],
    ]) {
      const dt = root.ownerDocument.createElement("dt");
      dt.textContent = term;
      const dd = root.ownerDocument.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    infoBody.replaceChildren(dl, makeNote(messages.t("footer.aboutHint")));
  };

  const toggleInfo = (kind: "changelog" | "about") => {
    infoKind = infoKind === kind ? null : kind;
    renderInfo();
    if (infoKind) infoCard.scrollIntoView?.({ block: "nearest" });
  };

  versionButton.onclick = () => toggleInfo("changelog");
  aboutButton.onclick = () => toggleInfo("about");
  infoClose.onclick = () => {
    const opener = infoKind === "about" ? aboutButton : versionButton;
    infoKind = null;
    renderInfo();
    opener.focus();
  };

  const stopPrefs = store.subscribe(render);
  const stopLocale = messages.subscribe(() => {
    messages.update(root);
    render(store.value);
    renderInfo();
    if (feedbackTextFn) feedback.textContent = feedbackTextFn();
  });

  render(store.value);
  renderInfo();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPrefs();
      stopLocale();
      root.replaceChildren();
    },
  };
}
