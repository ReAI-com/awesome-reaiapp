import { t, setLocale } from "./i18n";
import { defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { mountDshObserverView, type DshObserverView } from "./dsh-observer-view";
import "./dsh-observer.css";
import "./folder-task.css";
import { mountNavigation } from "./surface-navigation";
import { createFolderPage, type FolderPage } from "./folder-page";

type RefreshIntent = HostTitlebarActionIntent<{ type: "refresh" }>;
type SettingsIntent = HostTitlebarActionIntent<{ type: "open-settings" }>;
const isRefreshIntent = (value: unknown): value is RefreshIntent => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" && intent.actionId === "refresh" &&
    intent.payload?.type === "refresh";
};

const isSettingsIntent = (value: unknown): value is SettingsIntent => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" && intent.actionId === "settings" &&
    intent.payload?.type === "open-settings";
};

export default defineApp({
  async activate(ctx) {
    setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    let activeView: DshObserverView | undefined;
    let activeFolder: FolderPage | undefined;
    let mountGeneration = 0;
    ctx.commands.register("com.reai.dsh-agent.back-to-root", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      activeView.navigateRoot();
      return {};
    });

    ctx.commands.register("com.reai.dsh-agent.open-settings", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      await activeView.showSettings();
      return {};
    });

    ctx.commands.register("com.reai.dsh-agent.open-folder-task", async () => {
      if (!activeView || !activeFolder) throw new Error(t("ui.m002"));
      if (!activeFolder.show()) throw new Error(t("folder.unavailable"));
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      const generation = ++mountGeneration;
      let view: DshObserverView | undefined;
      let folder: FolderPage | undefined;
      const navigation = mountNavigation(surface, {
        rootLabel: () => t("metadata.name"), backLabel: () => t("metadata.commands.item0"),
        rootCommand: "com.reai.dsh-agent.back-to-root",
        menu: () => [
          { key: "settings", label: t("common.settings"), command: { commandId: "com.reai.dsh-agent.open-settings" } },
          // 能力检测通过（Host 开放 + 已获批）才出现；否则保持旧菜单。
          ...(folder?.available() ? [{ key: "folder", label: t("folder.menu"), command: { commandId: "com.reai.dsh-agent.open-folder-task" } }] : []),
        ],
        onBack: () => view?.navigateRoot(),
      });
      let stopped = false;
      let refreshGeneration = 0;
      let currentPage: "main" | "settings" | "folder" = "main";
      const pageNav = () => currentPage === "settings" ? { key: "settings", label: t("common.settings") }
        : currentPage === "folder" ? { key: "folder", label: t("folder.title") } : null;
      let saveChain: Promise<unknown> = Promise.resolve();

      const refreshSnapshot = async (): Promise<void> => {
        const generation = ++refreshGeneration;
        const snapshot = await ctx.dshObserver.snapshot();
        if (!stopped && generation === refreshGeneration) view?.update(snapshot);
      };

      const refresh = async (): Promise<void> => {
        if (currentPage === "settings") {
          await Promise.all([refreshSnapshot(), view?.refreshSettings()]);
          return;
        }
        await refreshSnapshot();
      };

      const updateSettings = (modelAlias: string) => {
        const pending = saveChain.then(() => ctx.dshObserver.updateSettings(modelAlias));
        saveChain = pending.catch(() => undefined);
        return pending;
      };

      navigation.publish(null);
      try {
        const snapshot = await ctx.dshObserver.snapshot();
        if (stopped || generation !== mountGeneration) { navigation.dispose(); return; }
        setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        folder = createFolderPage(navigation.content, {
          backend: "dsh",
          agentName: "DSH",
          files: ctx.resourceFiles,
          agent: ctx.agent,
          systemTasks: ctx.systemTasks,
          // 插件 WebView 不持久：对话与在跑回合的引用存 Host 私有 KV，重开本页可恢复「停止」。
          storage: (() => { try { return ctx.storage.private("folder-task"); } catch { return undefined; } })(),
          onShow: () => { currentPage = "folder"; navigation.publish(pageNav()); },
          onAvailabilityChange: () => { if (currentPage === "main") navigation.publish(null); },
        });
        view = mountDshObserverView(folder.mainHost, snapshot, {
          refresh,
          sessionDetail: (sessionId) => ctx.dshObserver.sessionDetail(sessionId),
          historyPage: (sessionId, cursor, limit) =>
            ctx.dshObserver.historyPage(sessionId, cursor, limit),
          settings: () => ctx.dshObserver.settings(),
          updateSettings,
          onNavigate: (page) => {
            folder?.hide();
            currentPage = page;
            navigation.publish(pageNav());
          },
        });
        activeView = view;
        activeFolder = folder;
        navigation.publish(null);
        if (isSettingsIntent(surface.initialIntent)) {
          void view.showSettings().catch((error) => view?.showError(error));
        }
        navigation.ready();
        surface.ready();
        // 探测放在 ready 之后：不拖慢首屏，失败只意味着入口不出现。
        void folder.probe();
      } catch (error) {
        surface.fail(error);
        navigation.fail(t("ui.m002"));
        return () => { folder?.destroy(); view?.destroy(); navigation.dispose(); };
      }

      if (isRefreshIntent(surface.initialIntent)) {
        void refresh().catch((error) => view?.showError(error));
      }
      const stopLocale = ctx.locale?.onChange(({ locale }) => {
        if (!setLocale(locale)) return;
        view?.refreshLocale();
        folder?.refreshLocale();
        navigation.publish(pageNav());
      });

      const stopIntent = surface.onIntent((intent) => {
        if (isRefreshIntent(intent)) void refresh().catch((error) => view?.showError(error));
        if (isSettingsIntent(intent)) { if (currentPage === "settings") view?.navigateRoot(); else void view?.showSettings().catch((error) => view?.showError(error)); }
      });

      let poll: number | undefined;
      const syncPolling = (): void => {
        if (poll !== undefined) window.clearInterval(poll);
        poll = undefined;
        if (document.visibilityState !== "visible") return;
        poll = window.setInterval(() => {
          if (currentPage === "main") void refreshSnapshot().catch((error) => view?.showError(error));
        }, 2_000);
      };
      document.addEventListener("visibilitychange", syncPolling);
      syncPolling();

      return () => {
        stopped = true;
        ++refreshGeneration;
        if (poll !== undefined) window.clearInterval(poll);
        document.removeEventListener("visibilitychange", syncPolling);
        stopLocale?.();
        stopIntent();
        if (activeView === view) activeView = undefined;
        if (activeFolder === folder) activeFolder = undefined;
        folder?.destroy();
        view?.destroy();
        navigation.dispose();
      };
    });
  },
});
