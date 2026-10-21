import { AppError, defineApp, type HostTitlebarActionIntent } from "@reai/app-sdk/v1";
import { describeError } from "./errors";
import { createHostPort } from "./port";
import { PING_KEY } from "./probes";
import { mountProbeView } from "./view";
import "./styles.css";

type TitlebarPayload = { type: "run-safe" } | { type: "open-settings" };

function titlebarPayload(value: unknown): TitlebarPayload | undefined {
  const intent = value as HostTitlebarActionIntent<TitlebarPayload> | null | undefined;
  if (intent?.source !== "host.titlebarAction") return undefined;
  const type = intent.payload?.type;
  return type === "run-safe" || type === "open-settings" ? intent.payload : undefined;
}

export default defineApp({
  async activate(ctx) {
    const port = createHostPort(ctx);

    // 键盘按键 / 定时任务触发时只记一笔，「键盘按键触发命令」探针读这条记录。
    ctx.commands.register("com.example.capability-probe.ping", async () => {
      const previous = (await port.kv.get(PING_KEY)) as { count?: number } | undefined;
      await port.kv.set(PING_KEY, { at: new Date().toISOString(), count: (previous?.count ?? 0) + 1 });
      return { status: "ok" };
    });

    ctx.surfaces.register("main", async (surface) => {
      try {
        // 插件版本来自 Manifest；Driver 版本在挂载时读一次，读不到就把错误码写进说明。
        const hostVersion = ctx.systemTasks
          .getVersionStatus()
          .then((status) => status.app.currentVersion)
          .catch((error: unknown) => `读取失败（${describeError(error).code}）`);
        const view = mountProbeView(surface.root, {
          port,
          hostVersion,
          ...(typeof surface.reportNav === "function" ? { reportNav: (nav) => surface.reportNav?.(nav) } : {}),
        });
        const apply = (intent: unknown) => {
          const payload = titlebarPayload(intent);
          if (payload?.type === "run-safe") void view.runSafe();
          if (payload?.type === "open-settings") view.toggleSettings();
        };
        apply(surface.initialIntent);
        const offIntent = surface.onIntent(apply);
        surface.ready();
        return () => {
          offIntent();
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
