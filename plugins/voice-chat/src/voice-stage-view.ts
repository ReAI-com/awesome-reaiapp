import type { VoiceChatMessages } from "./i18n";
import { mountOs1OrbCanvas } from "./os1-orb-canvas";
import type { VoiceChatPreferencesStore } from "./preferences-store";
import type { OrbState, VoiceChatSettings } from "./types";

export interface VoiceStageView {
  toggleOrBargeIn(): void;
  resetSession(): void;
  refresh(): void;
  dispose(): void;
}

const MIC_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';

const STOP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>';

export function mountVoiceStageView(
  root: HTMLElement,
  preferences: VoiceChatPreferencesStore,
  messages: VoiceChatMessages,
): VoiceStageView {
  root.innerHTML = `
    <section class="vc-stage-shell" data-vc-stage data-mood="os1-auto">
      <div class="vc-stage-card">
        <div class="vc-stage-top">
          <div class="vc-stage-badges">
            <span class="vc-live-pill" data-live-pill hidden>
              <i class="vc-live-dot" aria-hidden="true"></i>
              <span data-i18n="stage.micActiveBadge"></span>
            </span>
            <span class="vc-brain-pill" data-brain-pill></span>
          </div>
          <p class="vc-state-whisper" data-state-label role="status" aria-live="polite"></p>
        </div>

        <div class="vc-orb-zone">
          <button class="vc-orb-trigger" type="button" data-orb-trigger data-i18n-aria-label="stage.orbAria" aria-label="">
            <canvas class="vc-orb-canvas" data-orb-canvas width="320" height="320"></canvas>
          </button>
          <p class="vc-subtitle" data-subtitle aria-live="polite"></p>
        </div>

        <div class="vc-stage-bottom">
          <button class="vc-call-cta" type="button" data-call-cta>
            <span class="vc-call-cta-icon" data-call-icon>${MIC_ICON}</span>
            <span data-call-label></span>
          </button>
        </div>
      </div>
    </section>
  `;

  const shell = root.querySelector<HTMLElement>("[data-vc-stage]")!;
  const livePill = root.querySelector<HTMLElement>("[data-live-pill]")!;
  const brainPill = root.querySelector<HTMLElement>("[data-brain-pill]")!;
  const stateLabel = root.querySelector<HTMLElement>("[data-state-label]")!;
  const orbTrigger = root.querySelector<HTMLButtonElement>("[data-orb-trigger]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-orb-canvas]")!;
  const subtitle = root.querySelector<HTMLElement>("[data-subtitle]")!;
  const callCta = root.querySelector<HTMLButtonElement>("[data-call-cta]")!;
  const callIcon = root.querySelector<HTMLElement>("[data-call-icon]")!;
  const callLabel = root.querySelector<HTMLElement>("[data-call-label]")!;

  const orb = mountOs1OrbCanvas(canvas, shell);

  let state: OrbState = "idle";
  let transientToast: (() => string) | null = null;
  let stageTimer: ReturnType<typeof setTimeout> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearStageTimer = () => {
    if (stageTimer !== null) {
      clearTimeout(stageTimer);
      stageTimer = null;
    }
  };

  const clearToastTimer = () => {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  };

  const formatBrainBadge = (settings: VoiceChatSettings): string => {
    const { brain } = settings;
    if (brain.mode === "agent-service") {
      const runtimeLabel =
        brain.agentRuntime === "auto" ? "Auto (Pi)" : brain.agentRuntime.toUpperCase();
      return messages.t("stage.brainBadgeAgent", { runtime: runtimeLabel });
    }
    if (brain.mode === "external-brain") {
      return messages.t("stage.brainBadgeExternal");
    }
    return messages.t("stage.brainBadgeCustom");
  };

  const stateWhisperText = (s: OrbState): string => {
    switch (s) {
      case "connecting":
        return messages.t("stage.stateConnecting");
      case "listening":
        return messages.t("stage.stateListening");
      case "thinking":
        return messages.t("stage.stateThinking");
      case "speaking":
        return messages.t("stage.stateSpeaking");
      default:
        return messages.t("stage.stateIdle");
    }
  };

  const previewSubtitleText = (s: OrbState): string => {
    switch (s) {
      case "connecting":
        return messages.t("stage.previewSubConnecting");
      case "listening":
        return messages.t("stage.previewSubListening");
      case "thinking":
        return messages.t("stage.previewSubThinking");
      case "speaking":
        return messages.t("stage.previewSubSpeaking");
      default:
        return "";
    }
  };

  const syncView = () => {
    if (disposed) return;
    const settings = preferences.value;
    shell.dataset.mood = settings.experience.mood;
    shell.dataset.orbState = state;
    orb.refreshPalette();
    orb.setState(state);

    const active = state !== "idle";
    livePill.hidden = !active;
    brainPill.textContent = formatBrainBadge(settings);
    stateLabel.textContent = transientToast ? transientToast() : stateWhisperText(state);

    const subText = previewSubtitleText(state);
    const shouldShowSubtitle = settings.experience.showSubtitles && active && subText.length > 0;
    subtitle.textContent = subText;
    subtitle.dataset.visible = shouldShowSubtitle ? "true" : "false";

    callCta.dataset.active = active ? "true" : "false";
    callIcon.innerHTML = active ? STOP_ICON : MIC_ICON;
    callLabel.textContent = active ? messages.t("stage.endCall") : messages.t("stage.startCall");
  };

  const transitionTo = (next: OrbState) => {
    if (disposed) return;
    clearStageTimer();
    transientToast = null;
    state = next;
    syncView();

    if (next === "connecting") {
      stageTimer = setTimeout(() => {
        if (!disposed && state === "connecting") {
          transitionTo("listening");
        }
      }, 1350);
    } else if (next === "thinking") {
      stageTimer = setTimeout(() => {
        if (!disposed && state === "thinking") {
          transitionTo("speaking");
        }
      }, 1450);
    } else if (next === "speaking") {
      stageTimer = setTimeout(() => {
        if (!disposed && state === "speaking") {
          transitionTo(preferences.value.experience.autoContinueListening ? "listening" : "idle");
        }
      }, 5200);
    }
  };

  const handleOrbAction = () => {
    if (state === "idle") {
      transitionTo("connecting");
      return;
    }
    if (state === "connecting") {
      transitionTo("idle");
      return;
    }
    if (state === "listening") {
      transitionTo("thinking");
      return;
    }
    if (state === "thinking") {
      transitionTo("listening");
      return;
    }
    if (state === "speaking") {
      if (preferences.value.experience.bargeInEnabled) {
        transitionTo("listening");
      }
    }
  };

  const handleCallCta = () => {
    if (state === "idle") {
      transitionTo("connecting");
    } else {
      transitionTo("idle");
    }
  };

  orbTrigger.onclick = handleOrbAction;
  callCta.onclick = handleCallCta;

  const stopPrefs = preferences.subscribe(() => {
    syncView();
  });

  const stopLocale = messages.subscribe(() => {
    messages.update(root);
    syncView();
  });

  syncView();

  return {
    toggleOrBargeIn() {
      handleOrbAction();
    },
    resetSession() {
      clearStageTimer();
      clearToastTimer();
      state = "idle";
      transientToast = () => messages.t("stage.sessionResetToast");
      syncView();
      toastTimer = setTimeout(() => {
        if (!disposed) {
          transientToast = null;
          syncView();
        }
      }, 1800);
    },
    refresh() {
      orb.refreshPalette();
      syncView();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearStageTimer();
      clearToastTimer();
      stopPrefs();
      stopLocale();
      orb.dispose();
      orbTrigger.onclick = null;
      callCta.onclick = null;
      root.replaceChildren();
    },
  };
}
