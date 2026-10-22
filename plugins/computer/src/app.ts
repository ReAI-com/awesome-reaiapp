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
import { DEFAULT_VLM_CONFIG, describeError, runComputerTask, type VlmConfig } from "./agent-loop";
import { CHANGELOG_TEXT } from "./release-notes";
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
      try {
        root.innerHTML = "";
        const store = ctx.storage.private("state");
        let vlm = await loadVlmConfig(store);
        // 状态查询的序号：只采纳最新一次请求的结果，迟到的旧响应不覆盖新状态。
        let permissionsSeq = 0;
        let engineStateSeq = 0;

        const home: ComputerHome = mountComputerHome(root, {
          onStop: () => {
            // 与宿主命令同一语义：停引擎并中止所有页面的任务循环，
            // 避免引擎恢复后旧循环接着跑。
            abortAllTasks();
            void refreshAfterAction("computer.stop", {});
          },
          onResume: () => void refreshAfterAction("computer.resume", {}),
          onRequestAccessibility: () =>
            void refreshAfterAction("computer.permissions.request_accessibility", {}),
          onOpenScreenSettings: () =>
            void computerCall("computer.permissions.open_screen_settings", {}).catch(
              (cause) => home.setNotice(`打开系统设置失败：${String(cause)}`),
            ),
          onRefreshPermissions: () => void refreshPermissions(),
          onStartTask: (task) => void startTask(task),
          onAbortTask: requestAbort,
          onSaveVlm: (modelAlias) => {
            vlm = { modelAlias };
            void store
              .set(VLM_CONFIG_KEY, { modelAlias } satisfies StoredVlmConfig)
              .then(() => home.setNotice("模型档位已保存"))
              .catch((cause) => home.setNotice(`保存失败：${describeError(cause)}`));
          },
          onRefreshTrace: () => void refreshEngineState(),
        }, {
          appId: manifest.appId,
          name: manifest.name,
          version: manifest.version,
          changelogText: CHANGELOG_TEXT,
        });
        home.setVlmDraft(vlm.modelAlias);

        async function refreshPermissions() {
          const seq = ++permissionsSeq;
          try {
            const status = await computerCall<PermissionsStatus>(
              "computer.permissions.status",
              {},
            );
            if (seq === permissionsSeq) home.setPermissions(status);
          } catch (cause) {
            if (seq === permissionsSeq) home.setPermissions(null, describeError(cause));
          }
        }

        async function refreshEngineState() {
          const seq = ++engineStateSeq;
          try {
            const state = await computerCall<ComputerState>("computer.state", {});
            if (seq === engineStateSeq) home.setEngineState(state);
          } catch (cause) {
            if (seq === engineStateSeq) home.setEngineState(null, describeError(cause));
          }
        }

        async function refreshAfterAction(
          method: Parameters<typeof computerCall>[0],
          params: unknown,
        ) {
          try {
            await computerCall(method, params);
          } catch (cause) {
            home.setNotice(describeError(cause));
          }
          await Promise.all([refreshPermissions(), refreshEngineState()]);
        }

        async function startTask(task: string) {
          abortRequested = false;
          home.clearSteps();
          home.setTaskRunning(true);
          home.setNotice("");
          try {
            const result = await runComputerTask(vlm, task, {
              shouldAbort: () => abortRequested,
              onStep: (report) =>
                home.appendStep({
                  step: report.step,
                  thought: report.thought,
                  action: report.action as unknown as {
                    action: string;
                    x?: number;
                    y?: number;
                    text?: string;
                    key?: string;
                    dy?: number;
                    detail?: string;
                  },
                  ok: report.ok,
                  error: report.error,
                }),
            });
            const okText =
              result.status === "done"
                ? `✅ 任务完成（${result.steps} 步）：${result.detail ?? ""}`
                : result.status === "aborted"
                  ? "⏹ 任务已手动中止"
                  : result.status === "fail"
                    ? `⚠️ 模型报告无法完成：${result.detail ?? ""}`
                    : `❌ 任务出错：${result.detail ?? ""}`;
            home.setTaskResult(okText, result.status === "done");
          } catch (cause) {
            home.setTaskResult(`❌ 任务异常终止：${describeError(cause)}`, false);
          } finally {
            home.setTaskRunning(false);
            void refreshEngineState();
          }
        }

        await Promise.all([refreshPermissions(), refreshEngineState()]);
        surface.ready();
        return () => {
          // 卸载时只请求中止本插件发起的任务循环（下一步生效）。**不动引擎停止位**，
          // 停止和恢复都不调用
          // （PR 审查 P1：切换插件页面即触发本 cleanup，无条件 stop 会让 Agent
          // 工具桥的 computer_* 「用一次就卡死」——pi/DSH 没有 resume 工具，停止位
          // 是用户主权语义，只能由用户在插件页或 com.reai.computer.stop 命令触发）。
          requestAbort();
          abortHooks.delete(requestAbort);
          root.replaceChildren();
        };
      } catch (cause) {
        surface.fail(
          new AppError({
            code: "com.reai.computer/HOME_MOUNT_FAILED",
            userMessage: "电脑操控主页初始化失败",
            retryable: true,
            cause,
          }),
        );
        // fail 之后 cleanup 仍要返回，保证 unmount 不留残余。
        abortHooks.delete(requestAbort);
        return () => root.replaceChildren();
      }
    });
  },
});
