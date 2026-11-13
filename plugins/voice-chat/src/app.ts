import {
  AppError,
  defineApp,
  type HostTitlebarActionIntent,
} from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { createVoiceChatMessages } from "./i18n";
import { VoiceChatPreferencesStore } from "./preferences-store";
import { CHANGELOG_TEXT } from "./release-notes";
import { mountVoiceChatSettingsView, type VoiceChatSettingsView } from "./settings-view";
import { mountNavigation } from "./surface-navigation";
import "./voice-chat.css";
import { mountVoiceStageView, type VoiceStageView } from "./voice-stage-view";

interface VoiceChatActiveController {
  openSettings(): void;
  navigateRoot(): void;
  toggleCall(): void;
}

export default defineApp({
  async activate(ctx) {
    const messages = createVoiceChatMessages(ctx.locale);
    const preferences = new VoiceChatPreferencesStore(ctx.storage.private("voice-chat-settings"));
    await preferences.load().catch(() => undefined);

    let activeController: VoiceChatActiveController | undefined;
    let mountGeneration = 0;

    ctx.commands.register("com.reai.voice-chat.back-to-root", async () => {
      if (!activeController) {
        throw new AppError({
          code: "com.reai.voice-chat/NO_ACTIVE_VIEW",
          userMessage: messages.t("nav.noView"),
          retryable: true,
        });
      }
      activeController.navigateRoot();
      return {};
    });

    ctx.commands.register("com.reai.voice-chat.open-settings", async () => {
      if (!activeController) {
        throw new AppError({
          code: "com.reai.voice-chat/NO_ACTIVE_VIEW",
          userMessage: messages.t("nav.noView"),
          retryable: true,
        });
      }
      activeController.openSettings();
      return {};
    });

    ctx.commands.register("com.reai.voice-chat.toggle-call", async () => {
      if (!activeController) {
        throw new AppError({
          code: "com.reai.voice-chat/NO_ACTIVE_VIEW",
          userMessage: messages.t("nav.noView"),
          retryable: true,
        });
      }
      activeController.toggleCall();
      return { ok: true };
    });

    ctx.surfaces.register("main", async (surface) => {
      const generation = ++mountGeneration;
      let stageView: VoiceStageView | undefined;
      let settingsView: VoiceChatSettingsView | undefined;
      let page: "root" | "settings" = "root";

      const navigation = mountNavigation(surface, {
        rootLabel: () => messages.t("metadata.name"),
        backLabel: () => messages.t("nav.back"),
        rootCommand: "com.reai.voice-chat.back-to-root",
        menu: () => [
          {
            key: "settings",
            label: messages.t("nav.settings"),
            command: { commandId: "com.reai.voice-chat.open-settings" },
          },
        ],
        onBack: () => controller.navigateRoot(),
      });

      const controller: VoiceChatActiveController = {
        openSettings() {
          page = "settings";
          rootHost.hidden = true;
          settingsHost.hidden = false;
          navigation.publish({ key: "settings", label: messages.t("nav.settings") });
        },
        navigateRoot() {
          page = "root";
          settingsHost.hidden = true;
          rootHost.hidden = false;
          navigation.publish(null);
          stageView?.refresh();
        },
        toggleCall() {
          if (page === "settings") {
            controller.navigateRoot();
          }
          stageView?.toggleOrBargeIn();
        },
      };

      navigation.content.innerHTML =
        '<div class="vc-view-host" data-vc-page="root"></div><div class="vc-view-host" data-vc-page="settings" hidden></div>';
      const rootHost = navigation.content.querySelector<HTMLElement>('[data-vc-page="root"]')!;
      const settingsHost = navigation.content.querySelector<HTMLElement>('[data-vc-page="settings"]')!;

      try {
        stageView = mountVoiceStageView(rootHost, preferences, messages);
        settingsView = mountVoiceChatSettingsView(settingsHost, preferences, messages, {
          appId: manifest.appId,
          version: manifest.version,
          changelogText: CHANGELOG_TEXT,
        });

        if (generation !== mountGeneration) {
          stageView.dispose();
          settingsView.dispose();
          navigation.dispose();
          return;
        }

        activeController = controller;
        navigation.publish(null);

        const applyTitlebarIntent = (raw: unknown) => {
          const intent = raw as Partial<HostTitlebarActionIntent<{ type?: unknown }>> | null;
          if (intent?.source !== "host.titlebarAction") return;
          if (intent.actionId === "new-session" && intent.payload?.type === "new-session") {
            if (page === "settings") controller.navigateRoot();
            stageView?.resetSession();
          } else if (intent.actionId === "settings" && intent.payload?.type === "open-settings") {
            if (page === "settings") controller.navigateRoot();
            else controller.openSettings();
          }
        };

        applyTitlebarIntent(surface.initialIntent);
        const stopIntent = surface.onIntent(applyTitlebarIntent);
        const stopLocale = messages.subscribe(() => {
          navigation.publish(
            page === "settings" ? { key: "settings", label: messages.t("nav.settings") } : null,
          );
        });

        navigation.ready();
        surface.ready();

        return async () => {
          stopIntent();
          stopLocale();
          if (activeController === controller) activeController = undefined;
          settingsView?.dispose();
          stageView?.dispose();
          navigation.dispose();
        };
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.voice-chat/MOUNT_FAILED",
            userMessage: messages.t("nav.mountFailed"),
            retryable: true,
            cause,
          }),
        );
        settingsView?.dispose();
        stageView?.dispose();
        navigation.fail(messages.t("nav.mountFailed"));
        return () => navigation.dispose();
      }
    });
  },
});
