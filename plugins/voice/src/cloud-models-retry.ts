/**
 * 云端识别选项后台读取的退避节奏（#1.0.5 重新登录后自恢复）。
 *
 * 有上限：一轮最多 `delaysMs.length` 次自动重试，用完就停，等界面重新可见或用户点「重试」再开下一轮。
 * 导出为可变对象只为测试注入短间隔；生产代码不改它。
 */
export const cloudModelsRetryTiming = {
  delaysMs: [1000, 3000, 8000, 20000, 45000] as readonly number[],
  /** 界面重新可见触发重读的最小间隔，避免来回切页面时连发。 */
  minVisibleIntervalMs: 2000,
};

/** 第 `attempt` 次后台读取失败后的等待时长；超出预算返回 undefined（停止自动重试）。 */
export function cloudModelsRetryDelay(attempt: number): number | undefined {
  return Number.isInteger(attempt) && attempt >= 0 ? cloudModelsRetryTiming.delaysMs[attempt] : undefined;
}

/**
 * 可恢复的读取失败：网络、超时、服务暂不可用，以及重新登录后插件授权尚未恢复。
 * 登录缺失、权限未开、能力被关等需要用户动作的，不自动重试。
 */
const RECOVERABLE_CODES = new Set(["PLUGIN_OAUTH_REAUTH_REQUIRED", "OAUTH_SESSION_CHANGED"]);
const BLOCKING_CODES = new Set(["AI_NOT_GRANTED", "AI_PERMISSION_REQUIRED", "AI_PERMISSION_DENIED", "AI_DISABLED", "AI_INVALID_REQUEST"]);
export function cloudModelsFailureRetryable(code: string, reason: string): boolean {
  if (RECOVERABLE_CODES.has(code)) return true;
  if (BLOCKING_CODES.has(code)) return false;
  return ["unknown", "network", "timeout", "service", "subscriptionUnavailable"].includes(reason);
}
export const CLOUD_MODELS_REAUTH_CODE = "PLUGIN_OAUTH_REAUTH_REQUIRED";
