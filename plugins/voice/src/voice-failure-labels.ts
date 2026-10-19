import { t } from "./voice-i18n";
import { voiceCloudFailureMessage, voiceRequestFailureReason } from "./voice-user-errors";
import { DELIVERY_REASON_CODES, structuredCode } from "./voice-error-fields";
import { agentCodeLabel, hostAgentCodeOf } from "./agent-failure-codes";
import { agentFailureStageOf } from "./agent-failure-stage";

/**
 * 插件自己写死的失败短句（按错误码 / 类别码查表）。浮层（桌面任务胶囊、取回卡、结果面板）
 * 与复制诊断里的「原因」只能用这里的文案：上游 userMessage / message 可能回显用户说的话，
 * 一律不透传（§6.0 #waiting-failure-minimum）。
 */

/**
 * 写回失败原因的人话版本。
 *
 * 与 [`taskFailureLabel`] 并列：那条管「命令整体失败」，这条管「命令成功了但没写进去」。
 * 两者都只输出我们自己写的短句——胶囊常驻桌面，不该出现 `focus_changed` 这种裸枚举。
 * 详情页那边早有 `warningMessage()` 在把同一组枚举翻成人话，这里是同一件事的胶囊版。
 */
export function deliverReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case "accessibility_permission_required":
      return t("app.textInsertionPermissionIsMissing");
    case "voice_deliver_permission_required":
      return t("app.voiceDeliveryPermissionRequired");
    case "voice_deliver_unavailable":
      return t("app.voiceDeliveryUnavailable");
    case "expired":
      return t("app.theInsertionWindowExpired");
    case "focus_changed":
      return t("app.theInputFocusMoved");
    case "own_overlay_focused":
      return t("app.theFocusIsOnOurOwnInterface");
    case "no_input_target":
      return t("app.noWritableInputWasFound");
    // Host API 1.22：事前判断确定光标不在可输入位置（未粘贴）/ 粘贴后约 1 秒无人取件。
    case "not_editable":
      return t("app.theCursorIsNotInATextInput");
    case "not_received":
      return t("app.theTargetAppDidNotTakeTheText");
    case "unknown_target":
      return t("app.theInsertionTargetIsNoLongerValid");
    // Legacy Host denied is also used for owner rejection and generic native
    // failures; it cannot establish that a system permission is missing.
    case "denied":
    case "insert_failed":
      return t("app.textInsertionFailed");
    default:
      return t("app.unknownReason");
  }
}

/** 认得出的失败类别 → 固定短句；认不出返回 undefined（调用方决定兜底）。 */
export function knownFailureLabel(cause: unknown): string | undefined {
  // Host 给的具体 Agent 失败码（预算、运行组件…）优先：它比按类别推断的短句更准；其次是阶段前缀方括号里的 Agent 码。
  const agent = agentCodeLabel(hostAgentCodeOf(cause) ?? agentFailureStageOf(cause)?.upstreamCode);
  if (agent) return agent;
  const cloud = voiceCloudFailureMessage(cause);
  if (cloud) return cloud;
  switch (voiceRequestFailureReason(cause)) {
    case "login":
      return t("app.signInFirst");
    case "runtime":
      return t("app.installTheRuntimeFirst");
    case "permission":
      return t("app.enablePermissionFirst");
    case "disabled":
      return t("app.agentServiceUnavailable");
    case "scope":
      return t("app.serviceNotEnabled");
    case "rate":
      return t("app.tooManyRequests");
    case "payment":
      return t("app.insufficientQuota");
    case "timeout":
      return t("app.timedOut");
    case "cancelled":
      return t("app.cancelled");
    case "stale":
      return t("app.sessionExpired");
    case "unknown":
      break;
  }
  const raw = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  const code = typeof raw === "string" ? raw.slice(0, 100) : "";
  if (code.includes("NOT_LOGGED_IN") || code.includes("LOGIN")) return t("app.signInFirst");
  if (code.includes("PERMISSION") || code.includes("NOT_GRANTED")) return t("app.enablePermissionFirst");
  if (code.includes("BACKEND_UNAVAILABLE") || code.includes("NOT_CONFIGURED")) return t("app.agentServiceUnavailable");
  return undefined;
}

/**
 * 桌面任务卡上的失败标签。
 *
 * 只输出**白名单里的固定短句**，不透传上游错误文案：那块胶囊常驻桌面角落、
 * 旁人和屏幕共享都看得见，而上游网关的错误串里经常带着请求内容回显。
 * 完整原文只在用户自己的界面里、主动展开时可见。
 */
export function taskFailureLabel(cause: unknown): string {
  return knownFailureLabel(cause) ?? t("app.incompleteOpenForDetails");
}

/** 只凭错误码查表得到的插件固定文案（复制诊断的「原因（按错误码）」）；查不到返回 undefined。 */
export function constantReasonForCode(code: string | undefined): string | undefined {
  const safe = structuredCode(code);
  if (!safe) return undefined;
  if (DELIVERY_REASON_CODES.has(safe)) return deliverReasonLabel(safe);
  return knownFailureLabel({ code: safe });
}

/**
 * 交给 Host 取回卡 / 结果面板的结构化 `errorCode`（Host API 1.22，#953 同版本并入的可选字段）：登记过的码，
 * 且符合 Host 的码形状（可选小写反向域名命名空间 + `/`，字母开头、只含字母数字下划线，≤ 64，总长 ≤ 100）——
 * 不合形状整次请求会被 Host 拒绝，所以宁可不带。原始原因（`detail`）一律不传：原文不离开插件。
 */
const HOST_CODE_SHAPE = /^(?:[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+\/)?[A-Za-z][A-Za-z0-9_]{0,63}$/;
export function hostErrorCode(code: string | undefined): { errorCode?: string } {
  const safe = structuredCode(code);
  return safe && safe.length <= 100 && HOST_CODE_SHAPE.test(safe) ? { errorCode: safe } : {};
}

/** 固定短句后缀真实错误码（码按结构化文法接收，不合文法就不带）。 */
export function withCode(text: string, code: string | undefined): string {
  const safe = structuredCode(code);
  return safe ? t("diagnostics.withCode", { text, code: safe }) : text;
}
