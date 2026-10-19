import { t, setLocale } from "./i18n";
import {
  defineApp,
  type HostTitlebarActionIntent,
  type PiManagementSettings,
  type PiManagementSnapshot,
} from "@reai/app-sdk/v1";

import { mountPiAgentView, type PiAgentView } from "./pi-agent-view";
import "./pi-agent.css";
import "./folder-task.css";
import { mountNavigation } from "./surface-navigation";
import { createFolderPage, type FolderPage } from "./folder-page";

const isSettingsIntent = (value: unknown): value is HostTitlebarActionIntent<{ type: "open-settings" }> => {
  if (!value || typeof value !== "object") return false;
  const intent = value as { source?: unknown; actionId?: unknown; payload?: { type?: unknown } };
  return intent.source === "host.titlebarAction" &&
    intent.actionId === "settings" && intent.payload?.type === "open-settings";
};

export default defineApp({
  async activate(ctx) {
    setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    let activeView: PiAgentView | undefined;
    let activeFolder: FolderPage | undefined;
    let mountGeneration = 0;
    ctx.commands.register("com.reai.pi-agent.back-to-root", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      activeView.navigateRoot();
      return {};
    });

    ctx.commands.register("com.reai.pi-agent.open-folder-task", async () => {
      if (!activeView || !activeFolder) throw new Error(t("ui.m002"));
      if (!activeFolder.show()) throw new Error(t("folder.unavailable"));
      return {};
    });

    ctx.commands.register("com.reai.pi-agent.open-settings", async () => {
      if (!activeView) throw new Error(t("ui.m002"));
      activeView.showSettings();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      const generation = ++mountGeneration;
      let view: PiAgentView | undefined;
      let folder: FolderPage | undefined;
      const navigation = mountNavigation(surface, {
        rootLabel: () => t("metadata.name"), backLabel: () => t("metadata.commands.item0"),
        rootCommand: "com.reai.pi-agent.back-to-root",
        menu: () => [
          { key: "settings", label: t("common.settings"), command: { commandId: "com.reai.pi-agent.open-settings" } },
          // 能力检测通过（Host 开放 + 已获批）才出现；否则保持旧菜单。
          ...(folder?.available() ? [{ key: "folder", label: t("folder.menu"), command: { commandId: "com.reai.pi-agent.open-folder-task" } }] : []),
        ],
        onBack: () => view?.navigateRoot(),
      });
      let stopped = false;
      let currentPage: "main" | "settings" | "folder" = "main";
      const pageNav = () => currentPage === "settings" ? { key: "settings", label: t("common.settings") }
        : currentPage === "folder" ? { key: "folder", label: t("folder.title") } : null;
      let saveChain = Promise.resolve();
      let refreshVersion = 0;

      const load = async (): Promise<void> => {
        const version = ++refreshVersion;
        const [snapshot, models] = await Promise.all([
          ctx.piManagement.snapshot(),
          ctx.piManagement.models(),
        ]);
        if (!stopped && version === refreshVersion) view?.update(snapshot, models);
      };

      const save = async (settings: PiManagementSettings): Promise<void> => {
        const pending = saveChain.then(async () => {
          ++refreshVersion;
          await ctx.piManagement.updateSettings(settings);
          await load();
        });
        saveChain = pending.catch(() => undefined);
        await pending;
      };

      navigation.publish(null);
      try {
        const [snapshot, models] = await Promise.all([
          ctx.piManagement.snapshot(),
          ctx.piManagement.models(),
        ]);
        if (snapshot.sessions[0]) {
          try {
            Object.assign(snapshot.sessions[0], await ctx.piManagement.session(snapshot.sessions[0].sessionId));
          } catch {
            // 摘要返回后会话可能恰好被 one-shot 清理；列表仍应能打开，下一次刷新会收敛。
          }
        }
        setLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        if (generation !== mountGeneration) { navigation.dispose(); return; }
        folder = createFolderPage(navigation.content, {
          backend: "pi",
          agentName: "Pi",
          files: ctx.resourceFiles,
          agent: ctx.agent,
          systemTasks: ctx.systemTasks,
          // 插件 WebView 不持久：对话与在跑回合的引用存 Host 私有 KV，重开本页可恢复「停止」。
          storage: (() => { try { return ctx.storage.private("folder-task"); } catch { return undefined; } })(),
          onShow: () => { currentPage = "folder"; navigation.publish(pageNav()); },
          onAvailabilityChange: () => { if (currentPage === "main") navigation.publish(null); },
        });
        view = mountPiAgentView(folder.mainHost, snapshot, models, {
          onRefresh: load,
          onSelect: (sessionId) => ctx.piManagement.session(sessionId),
          onSaveSettings: save,
          onNavigate: (page) => {
            folder?.hide();
            currentPage = page;
            navigation.publish(pageNav());
          },
        });
        activeView = view;
        activeFolder = folder;
        if (isSettingsIntent(surface.initialIntent)) view.showSettings();
        else navigation.publish(null);
        navigation.ready();
        surface.ready();
        // 探测放在 ready 之后：不拖慢首屏，失败只意味着入口不出现。
        void folder.probe();
      } catch (error) {
        surface.fail(error);
        navigation.fail(t("ui.m002"));
        return () => { folder?.destroy(); view?.destroy(); navigation.dispose(); };
      }

      const stopLocale = ctx.locale?.onChange(({ locale }) => {
        if (!setLocale(locale)) return;
        view?.refreshLocale();
        folder?.refreshLocale();
        navigation.publish(pageNav());
      });

      const stopIntent = surface.onIntent((intent) => {
        if (isSettingsIntent(intent)) { if (currentPage === "settings") view?.navigateRoot(); else view?.showSettings(); }
      });
      let poll: number | undefined;
      const syncPolling = (): void => {
        if (poll !== undefined) window.clearInterval(poll);
        poll = undefined;
        if (document.visibilityState !== "visible") return;
        poll = window.setInterval(() => {
          // 设置页也轮询：登录状态/模型档位在页面打开期间会变化（登录、登出、
          // 档位目录刷新），不能等导航回来才更新 chip 与禁用门禁。
          if (currentPage === "main" || currentPage === "settings") {
            void load().catch((error) => view?.showError(error));
          }
        }, 2_000);
      };
      document.addEventListener("visibilitychange", syncPolling);
      syncPolling();

      return () => {
        stopped = true;
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
