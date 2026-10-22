/**
 * 电脑操控插件 —— `computer.engine@1` 的授权消费者。
 *
 * 分工（与 browser 插件同一条边界）：截图 / 鼠标键盘注入 / 安全线全在 Host
 * 引擎（src/computer），插件 Surface 只是产品脸面：权限引导、紧急停止、
 * 任务控制台（内置演示 Agent 循环，视觉决策走 Host 云通道 ai.text.generate，
 * 凭据归登录账号、插件不接触 API key）与操作审计。pi/DSH 工具桥与这里共用
 * Host 引擎的同一套操作。
 */
import { AppError, defineApp } from "@reai/app-sdk/v1";
import { computerCall } from "./computer-bridge";
import type { ComputerState, PermissionsStatus } from "./computer-bridge";
import { mountComputerHome, type ComputerHome } from "./computer-view";
import { DEFAULT_VLM_CONFIG, causeMessage, describeError, runComputerTask, type VlmConfig } from "./agent-loop";
import { setComputerLocale, t } from "./computer-i18n";
import { CHANGELOG_TEXT } from "./release-notes";
import type { StepLike } from "./types";
import manifest from "../app.manifest.json";
import "./computer.css";

const VLM_CONFIG_KEY = "vlm-config";

interface StoredVlmConfig {
  /** 旧版直连端点的字段（baseUrl/model/apiKey）已废弃，读取时忽略。 */
  modelAlias?: string;
}

async function loadVlmConfig(store: {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}): Promise<VlmConfig> {
  try {
    const raw = (await store.get(VLM_CONFIG_KEY)) as StoredVlmConfig | null;
    return {
      modelAlias: raw?.modelAlias?.trim() || DEFAULT_VLM_CONFIG.modelAlias,
    };
  } catch {
    return { ...DEFAULT_VLM_CONFIG };
  }
}

export default defineApp({
  async activate(ctx) {
    // 各挂载页面的「中止任务循环」钩子。宿主命令与页面按钮走同一语义：
    // 停引擎的同时中止本插件的循环，否则停止后再恢复，旧循环会接着发动作。
    // 可能存在多个挂载页面，逐个登记，停止时全部中止。
    const abortHooks = new Set<() => void>();

    // 紧急停止做成 Command（host/user 可调）：任务跑飞时用户可以不进插件页面，
    // 从宿主命令层一刀切断；引擎会强制抬起按住的鼠标按钮。
    const abortAllTasks = () => {
      for (const abort of abortHooks) abort();
    };
    ctx.commands.register("com.reai.computer.stop", async () => {
      abortAllTasks();
      await computerCall("computer.stop", {});
      return { status: "stopped" as const };
    });

    ctx.surfaces.register("main", async (surface) => {
      const root = surface.root;
      let abortRequested = false;
      const requestAbort = () => {
        abortRequested = true;
      };
      abortHooks.add(requestAbort);
      const subscriptions: Array<() => void> = [];
      let home: ComputerHome | null = null;
      try {
        root.innerHTML = "";
        // 先按当前语言设置翻译，再渲染首屏（英文冷启动直接英文，不闪换）。
        setComputerLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        const store = ctx.storage.private("state");
        // 首屏同步挂载：配置读取与状态查询都在后台进行，卸载时立即释放，迟到结果一律丢弃。
        let vlm: VlmConfig = { ...DEFAULT_VLM_CONFIG };
        let configReady = false;
        let disposed = false;
        // 状态查询的序号：只采纳最新一次请求的结果，迟到的旧响应不覆盖新状态。
        let permissionsSeq = 0;
        let engineStateSeq = 0;

        // 通知归属：只有产生当前通知的那个操作成功后才清除它，无关操作不清掉较新的失败。
        let noticeOwner: string | null = null;
        const notifyFailure = (owner: string, key: string, cause: unknown) => {
          noticeOwner = owner;
          home?.setNotice({ level: "error", message: { key, raw: describeError(cause) } });
        };
        const clearNotice = (owner: string) => {
          if (noticeOwner !== owner) return;
          noticeOwner = null;
          home?.setNotice(null);
        };

        const view: ComputerHome = mountComputerHome(
          root,
          {
            onStop: async () => {
              // 与宿主命令同一语义：停引擎并中止所有页面的任务循环，
              // 避免引擎恢复后旧循环接着跑。
              abortAllTasks();
              await refreshAfterAction("computer.stop");
            },
            onResume: () => refreshAfterAction("computer.resume"),
            onRequestAccessibility: () => refreshAfterAction("computer.permissions.request_accessibility"),
            onOpenScreenSettings: async () => {
              try {
                await computerCall("computer.permissions.open_screen_settings", {});
                clearNotice("computer.permissions.open_screen_settings");
              } catch (cause) {
                notifyFailure("computer.permissions.open_screen_settings", "notice.openSettingsFailed", cause);
              }
            },
            onRefreshPermissions: () => refreshPermissions(),
            onStartTask: (task) => void startTask(task),
            onAbortTask: requestAbort,
            onSaveVlm: async (modelAlias) => {
              // 先写存储，成功后才切换运行配置；失败时运行配置保持旧值，视图负责回滚显示。
              await store.set(VLM_CONFIG_KEY, { modelAlias } satisfies StoredVlmConfig);
              vlm = { modelAlias };
            },
            onRefreshTrace: () => refreshEngineState(),
          },
          { appId: manifest.appId, version: manifest.version, changelogText: CHANGELOG_TEXT },
        );
        home = view;

        async function refreshPermissions() {
          const seq = ++permissionsSeq;
          try {
            const status = await computerCall<PermissionsStatus>("computer.permissions.status", {});
            if (!disposed && seq === permissionsSeq) view.setPermissions(status);
          } catch (cause) {
            if (!disposed && seq === permissionsSeq) view.setPermissions(null, describeError(cause));
          }
        }

        async function refreshEngineState() {
          const seq = ++engineStateSeq;
          try {
            const state = await computerCall<ComputerState>("computer.state", {});
            if (!disposed && seq === engineStateSeq) view.setEngineState(state);
          } catch (cause) {
            if (!disposed && seq === engineStateSeq) view.setEngineState(null, describeError(cause));
          }
        }

        async function refreshAfterAction(method: Parameters<typeof computerCall>[0]) {
          try {
            await computerCall(method, {});
            clearNotice(method);
          } catch (cause) {
            notifyFailure(method, causeMessage(cause, "computer").key, cause);
          }
          await Promise.all([refreshPermissions(), refreshEngineState()]);
        }

        async function startTask(task: string) {
          if (!configReady) return; // 视图已禁用按钮，这里再守一道
          abortRequested = false;
          view.clearSteps();
          view.setTaskRunning(true);
          try {
            const result = await runComputerTask(vlm, task, {
              shouldAbort: () => abortRequested,
              onStep: (report) => {
                view.setTaskProgress(report.step);
                view.appendStep({
                  step: report.step,
                  ...(report.thought ? { thought: report.thought } : {}),
                  action: report.action as unknown as StepLike["action"],
                  ok: report.ok,
                  ...(report.error ? { error: report.error } : {}),
                });
              },
            });
            view.setTaskResult(result.message, result.status === "done");
          } catch (cause) {
            view.setTaskResult({ key: "result.crashed", raw: describeError(cause) }, false);
          } finally {
            view.setTaskRunning(false);
            void refreshEngineState();
          }
        }

        // 语言切换：原位更新文字，不重建 Surface、不重复任何业务调用。
        const stopLocale = ctx.locale?.onChange(({ locale }) => {
          setComputerLocale(locale);
          view.applyLocale();
        });
        if (stopLocale) subscriptions.push(stopLocale);
        // 开发者模式：只在开启时展示脱敏后的原始错误，关闭立即清空。
        let environmentRevision = 0;
        subscriptions.push(
          ctx.environment.onChange((value) => {
            environmentRevision += 1;
            view.setDeveloperMode(value.developerMode);
          }),
        );
        const revision = environmentRevision;
        // 迟到的查询结果（成功或失败）都不能覆盖之后的 onChange，也不触达已卸载页面。
        void ctx.environment
          .get()
          .then((value) => {
            if (!disposed && revision === environmentRevision) view.setDeveloperMode(value.developerMode);
          })
          .catch(() => {
            if (!disposed && revision === environmentRevision) view.setDeveloperMode(false);
          });

        // 后台读取已保存的模型档位；读回前下拉禁用，因此不会与用户保存竞态。
        void loadVlmConfig(store).then((stored) => {
          if (disposed) return;
          vlm = stored;
          configReady = true;
          view.setVlmReady(stored.modelAlias);
        });
        // 首次状态查询在后台进行，期间权限显示「检测中」。
        void refreshPermissions();
        void refreshEngineState();
        surface.ready();
        return () => {
          // 卸载时只请求中止本插件发起的任务循环（下一步生效）。**不动引擎停止位**，
          // 停止和恢复都不调用（PR 审查 P1：切换插件页面即触发本 cleanup，无条件 stop
          // 会让 Agent 工具桥的 computer_* 「用一次就卡死」——pi/DSH 没有 resume 工具，
          // 停止位是用户主权语义，只能由用户在插件页或 com.reai.computer.stop 命令触发）。
          disposed = true;
          requestAbort();
          abortHooks.delete(requestAbort);
          for (const stop of subscriptions.splice(0)) stop();
          view.dispose();
          root.replaceChildren();
        };
      } catch (cause) {
        // 错误出口按最新语言生成消息（初始化期间可能已切换语言）。
        setComputerLocale(ctx.locale?.getSnapshot().locale ?? "zh");
        surface.fail(
          new AppError({
            code: "com.reai.computer/HOME_MOUNT_FAILED",
            userMessage: t("errors.homeMountFailed"),
            retryable: true,
            cause,
          }),
        );
        // fail 之后 cleanup 仍要返回，保证 unmount 不留残余。
        abortHooks.delete(requestAbort);
        for (const stop of subscriptions.splice(0)) stop();
        home?.dispose();
        return () => root.replaceChildren();
      }
    });
  },
});
