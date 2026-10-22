import { AppError, defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { describeError } from "./errors";
import { createHostPort } from "./port";
import { PING_KEY } from "./probes";
import { readHostVersion } from "./host-version";
import { mountProbeView, type HostVersion } from "./view";
import "./styles.css";

type TitlebarPayload = { type: "run-safe" } | { type: "open-settings" };

/** 只认 Manifest 里声明的两个标题栏动作：来源、动作 id 和负载三者都要对得上。 */
function titlebarPayload(value: unknown): TitlebarPayload | undefined {
  const intent = value as HostTitlebarActionIntent<TitlebarPayload> | null | undefined;
  if (intent?.source !== "host.titlebarAction") return undefined;
  const type = intent.payload?.type;
  if (intent.actionId === "run-safe" && type === "run-safe") return intent.payload;
  if (intent.actionId === "settings" && type === "open-settings") return intent.payload;
  return undefined;
}

export default defineApp({
  async activate(ctx) {
    const port = createHostPort(ctx);
    /** 当前挂载的界面；Host 面包屑点祖先时由 back-to-root 命令把它带回根页。 */
    let activeView: ReturnType<typeof mountProbeView> | undefined;

    // 键盘按键 / 定时任务触发时只记一笔，「键盘按键触发命令」探针读这条记录。
    ctx.commands.register("com.example.capability-probe.ping", async () => {
      const previous = (await port.kv.get(PING_KEY)) as { count?: number } | undefined;
      await port.kv.set(PING_KEY, { at: new Date().toISOString(), count: (previous?.count ?? 0) + 1 });
      return { status: "ok" };
    });

    ctx.commands.register("com.example.capability-probe.back-to-root", async () => {
      activeView?.backToRoot();
      return {};
    });

    ctx.commands.register("com.example.capability-probe.open-settings", async () => {
      activeView?.openSettings();
      return {};
    });

    ctx.surfaces.register("main", async (surface) => {
      try {
        // 插件版本来自 Manifest；Driver 版本要等界面真正可见后才能读，所以在 surface.ready() 之后读，
        // 读不到就保留错误码给开发者模式看。
        let resolveVersion: (value: HostVersion) => void = () => undefined;
        const hostVersion = new Promise<HostVersion>((resolve) => { resolveVersion = resolve; });
        const view = mountProbeView(surface.root, {
          port,
          hostVersion,
          ...(typeof surface.reportNav === "function" ? { reportNav: (nav) => surface.reportNav?.(nav) } : {}),
        });
        activeView = view;
        const offIntent = surface.onIntent((intent) => {
          // 从权限页点「返回」时 Driver 投递 system-task.return，作为「跳到 Driver 设置页」的确认。
          if (view.handleIntent(intent)) return;
          const payload = titlebarPayload(intent);
          if (payload?.type === "run-safe") void view.runSafe();
          if (payload?.type === "open-settings") view.openSettings();
        });
        surface.ready();
        const versionAbort = new AbortController();
        void readHostVersion(() => ctx.systemTasks.getVersionStatus(), 1000, versionAbort.signal).then(resolveVersion);
        return () => {
          versionAbort.abort();
          offIntent();
          if (activeView === view) activeView = undefined;
          view.dispose();
        };
      } catch (cause) {
        surface.fail(new AppError({
          code: "com.example.capability-probe/SURFACE_INIT_FAILED",
          userMessage: "无法打开能力探针",
          retryable: true,
          cause,
        }));
        return;
      }
    });
  },

  async deactivate() {
    // SDK 撤销注册；界面的清理函数负责释放计时器和监听器。
  },
});
