/**
 * 浏览器引擎 bridge 客户端 —— 走宿主窄口 `browser.engine@1`。
 *
 * `browser.*` 方法不在 SDK 的 RequestMethod 字面量集合里（那是平台基础能力
 * 清单），与 codex-link 同款处理：取 Host bootstrap 注入的 Bridge 句柄，把
 * method 串按需 cast。Host 侧 `bridge.rs` 在分发前已校验 `browser.engine@1`
 * 的声明、安装、启用与授予。
 */
import { AppError, BRIDGE_GLOBAL_KEY, type HostBridge, type RequestMethod } from "@reai/app-sdk/v1";
import { t } from "./browser-i18n";

type AnyBridge = {
  request<T = unknown>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<T>;
};

export type BrowserMethod =
  | "browser.panel.open"
  | "browser.panel.close"
  | "browser.state"
  | "browser.navigate"
  | "browser.tab.new"
  | "browser.tab.select"
  | "browser.tab.close";

function bridge(): HostBridge | undefined {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const key = BRIDGE_GLOBAL_KEY as unknown as symbol;
  return g[key] as HostBridge | undefined;
}

export async function browserCall<T = unknown>(
  method: BrowserMethod,
  params: unknown = {},
  options?: { signal?: AbortSignal },
): Promise<T> {
  options?.signal?.throwIfAborted();
  const b = bridge();
  if (!b) {
    // 受控错误：文案走语言包，随 Host 语言切换。
    throw new AppError({ code: "com.reai.browser/BRIDGE_UNAVAILABLE", userMessage: t("errors.bridgeMissing"), retryable: true });
  }
  return (b as unknown as AnyBridge).request<T>(method as RequestMethod, params, options);
}
