import { createTerminalMessages } from "./terminal-i18n";
import {
  AppError,
  defineApp,
  type HostTitlebarActionIntent,
  type TerminalSessionEvent,
} from "@reai/app-sdk/v1";
import { mountTerminalWorkspace, type TerminalWorkspace } from "./terminal-workspace";
import { mountTerminalSettings, type TerminalSettingsView } from "./terminal-settings";
import { TerminalPreferencesStore } from "./terminal-preferences";
import "./terminal.css";
import "./terminal-settings.css";
import { mountNavigation } from "./surface-navigation";
import { CHANGELOG_TEXT } from "./release-notes";
import manifest from "../app.manifest.json";

interface TerminalAppView {
  openSettings(): void;
  navigateRoot(): void;
}

export default defineApp({
  async activate(ctx) {
    const messages = createTerminalMessages(ctx.locale);
    let workspace: TerminalWorkspace | undefined;
    let activeView: TerminalAppView | undefined;
    let mountGeneration = 0;
    const preferences = new TerminalPreferencesStore(ctx.storage.private("terminal-preferences"));
    await preferences.load().catch(() => undefined);
    ctx.terminal.onEvent((event: TerminalSessionEvent) => workspace?.accept(event));

    ctx.commands.register("com.reai.terminal.back-to-root", async () => {
      if (!activeView) throw new AppError({
        code: "com.reai.terminal/NO_ACTIVE_VIEW",
        userMessage: messages.t("noView"),
        retryable: true,
      });
      activeView.navigateRoot();
      return {};
    });

    ctx.commands.register("com.reai.terminal.open-settings", async () => {
      if (!activeView) throw new AppError({ code: "com.reai.terminal/NO_ACTIVE_VIEW", userMessage: messages.t("noView"), retryable: true });
      activeView.openSettings();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      const generation = ++mountGeneration;
      let settings: TerminalSettingsView | undefined;
      let localWorkspace: TerminalWorkspace | undefined;
      let view: TerminalAppView | undefined;
      let page: "root" | "settings" = "root";
      const navigation = mountNavigation(surface, {
        rootLabel: () => messages.t("metadataName"), backLabel: () => messages.t("metadataBack"),
        rootCommand: "com.reai.terminal.back-to-root",
        menu: () => [{ key: "settings", label: messages.t("common.settings"), command: { commandId: "com.reai.terminal.open-settings" } }],
        onBack: () => view?.navigateRoot(),
      });
      navigation.publish(null);
      try {
        navigation.content.innerHTML = '<div class="terminal-view-host" data-terminal-view="root"></div><div class="terminal-view-host" data-terminal-view="settings" hidden></div>';
        const rootView = navigation.content.querySelector<HTMLElement>('[data-terminal-view="root"]')!;
        const settingsView = navigation.content.querySelector<HTMLElement>('[data-terminal-view="settings"]')!;
        localWorkspace = await mountTerminalWorkspace(rootView, ctx.terminal, preferences, messages, navigation.footer);
        if (generation !== mountGeneration) { await localWorkspace.dispose(); navigation.dispose(); return; }
        workspace = localWorkspace;
        settings = mountTerminalSettings(settingsView, preferences, messages, { appId: manifest.appId, version: manifest.version, changelogText: CHANGELOG_TEXT });
        view = {
          openSettings() {
            page = "settings";
            rootView.hidden = true;
            settingsView.hidden = false;
            localWorkspace?.showFooter(false);
            navigation.publish({ key: "settings", label: messages.t("common.settings") });
          },
          navigateRoot() {
            page = "root";
            settingsView.hidden = true;
            rootView.hidden = false;
            localWorkspace?.showFooter(true);
            navigation.publish(null);
            localWorkspace?.refresh();
          },
        };
        activeView = view;
        const applyTitlebarIntent = (raw: unknown) => {
          const intent = raw as Partial<HostTitlebarActionIntent<{ type?: unknown }>> | null;
          if (intent?.source !== "host.titlebarAction") return;
          if (intent.actionId === "restart" && intent.payload?.type === "restart-active") {
            void localWorkspace?.restartActive();
          } else if (intent.actionId === "stop" && intent.payload?.type === "stop-active") {
            void localWorkspace?.stopActive();
          } else if (intent.actionId === "settings" && intent.payload?.type === "open-settings") {
            if (page === "settings") view?.navigateRoot(); else view?.openSettings();
          }
        };
        navigation.publish(null);
        applyTitlebarIntent(surface.initialIntent);
        const stopIntent = surface.onIntent(applyTitlebarIntent);
        const stopLocale = messages.subscribe(() => {
          navigation.publish(page === "settings" ? { key: "settings", label: messages.t("common.settings") } : null);
        });
        navigation.ready();
        surface.ready();
        return async () => {
          stopIntent();
          stopLocale();
          if (activeView === view) activeView = undefined;
          settings?.dispose();
          settings = undefined;
          if (workspace === localWorkspace) workspace = undefined;
          navigation.dispose();
          await localWorkspace?.dispose();
        };
      } catch (cause) {
        surface.fail(new AppError({
          code: "com.reai.terminal/MOUNT_FAILED",
          userMessage: messages.t("mountFailed"),
          retryable: true,
          cause,
        }));
        await localWorkspace?.dispose();
        navigation.fail(messages.t("mountFailed"));
        return () => navigation.dispose();
      }
    });
  },
});
