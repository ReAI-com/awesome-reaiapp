/** Browser 只消费 Host 托管的引擎；Surface 请求随卸载取消。 */
import { AppError, defineApp } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { browserCall } from "./browser-bridge";
import { setBrowserLocale, t } from "./browser-i18n";
import {
  applyBrowserHomeLocale, mountBrowserHome, refreshBrowserHome,
  setBrowserHomeActivity, setBrowserHomeDeveloperMode,
  type BrowserActivity, type BrowserStateSummary,
} from "./browser-view";
import "./browser.css";

export default defineApp({
  async activate(ctx) {
    ctx.commands.register("com.reai.browser.open", async ({ signal }) => {
      await browserCall("browser.panel.open", {}, { signal });
      return { status: "ok" as const };
    });
    ctx.surfaces.register("main", (surface) => {
      const root = surface.root;
      const lifetime = new AbortController();
      let alive = true;
      let busy = false;
      let refreshPending = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const subscriptions: Array<() => void> = [];
      const cleanup = () => {
        if (!alive) return;
        alive = false;
        lifetime.abort();
        clearInterval(timer);
        for (const stop of subscriptions) stop();
        root.replaceChildren();
      };
      try {
        setBrowserLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        root.replaceChildren();
        const home = mountBrowserHome(root, {
          onOpenDrawer: () => void run({ phase: "open" }, () => call("browser.panel.open")),
          onNewTab: (url) => void run({ phase: "new", url }, () => call("browser.tab.new", url ? { url } : {})),
          onRefresh: () => void run({ phase: "refresh" }),
          onSelectTab: (tabId) => void run({ phase: "select", tabId }, async () => {
            await call("browser.tab.select", { tabId });
            await call("browser.panel.open");
          }),
          onCloseTab: (tabId) => void run({ phase: "close", tabId }, () => call("browser.tab.close", { tabId })),
        });
        home.pluginVersion = manifest.version;
        const call = (method: Parameters<typeof browserCall>[0], params: unknown = {}) => browserCall(method, params, { signal: lifetime.signal });
        async function run(activity: BrowserActivity, action?: () => Promise<unknown>) {
          if (!alive || busy) return;
          busy = true;
          const started = Date.now();
          setBrowserHomeActivity(home, activity, 0);
          timer = setInterval(() => {
            if (alive) setBrowserHomeActivity(home, activity, Date.now() - started);
          }, 200);
          let succeeded = false;
          try {
            await action?.();
            activity.stage = "refresh";
            if (alive) setBrowserHomeActivity(home, activity, Date.now() - started);
            const state = await call("browser.state") as BrowserStateSummary | null;
            if (!alive) return;
            refreshBrowserHome(home, state ?? null);
            succeeded = true;
          } catch (cause) {
            if (!alive) return;
            // 失败保持在页面上；不再用后续刷新覆盖失败终态。
            refreshBrowserHome(home, home.state, cause, activity.stage ?? activity.phase);
          } finally {
            clearInterval(timer);
            busy = false;
            if (alive) {
              setBrowserHomeActivity(home, undefined, 0);
              if (refreshPending && succeeded) {
                refreshPending = false;
                void run({ phase: "refresh" });
              } else refreshPending = false;
            }
          }
        }
        subscriptions.push(surface.onIntent((raw) => {
          if (!raw || typeof raw !== "object") return;
          const intent = raw as { source?: unknown; type?: unknown };
          if (intent.source === "host.browser" && intent.type === "state-changed") {
            if (busy) refreshPending = true;
            else void run({ phase: "refresh" });
          }
        }));
        subscriptions.push(ctx.locale?.onChange(({ locale }) => {
          if (!alive) return;
          setBrowserLocale(locale);
          applyBrowserHomeLocale(home);
        }) ?? (() => undefined));
        let environmentRevision = 0;
        let versionRequested = false;
        const setEnvironment = ({ developerMode }: { developerMode: boolean }) => {
          if (!alive) return;
          setBrowserHomeDeveloperMode(home, developerMode);
          if (developerMode && !versionRequested) {
            versionRequested = true;
            void ctx.systemTasks.getVersionStatus().then(status => {
              if (alive) { home.hostVersion = status.app.currentVersion; applyBrowserHomeLocale(home); }
            }).catch(cause => {
              if (alive) { home.hostVersion = undefined; home.hostVersionError = cause; applyBrowserHomeLocale(home); }
            });
          }
        };
        subscriptions.push(ctx.environment.onChange(value => { environmentRevision++; setEnvironment(value); }));
        const revision = environmentRevision;
        void ctx.environment.get().then(value => {
          if (revision === environmentRevision) setEnvironment(value);
        }).catch(() => { /* 无法确认明确开关时保持普通模式。 */ });
        // 首屏含真实加载态，立即可用；cleanup 不等待引擎启动。
        surface.ready();
        void run({ phase: "refresh" });
        return cleanup;
      } catch (cause) {
        surface.fail(new AppError({ code: "com.reai.browser/HOME_MOUNT_FAILED", userMessage: t("errors.homeMountFailed"), retryable: true, cause }));
        return cleanup;
      }
    });
  },
});
