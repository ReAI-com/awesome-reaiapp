import { registeredErrorCode } from "./voice-error-codes";
import { t } from "./voice-i18n";

/**
 * Host 给的 Agent 失败码 → 插件固定人话（2.14.2；V1.0 真机回归 00:40:06Z：`AGENT_MODEL_BUDGET_EXCEEDED`
 * 被包成 `AGENT_ENGINE`，用户只看到兜底「暂时无法生成回复」，违反 §6.0「不许把真实错误改写成更模糊的状态」）。
 *
 * 码按**值**查表：Host 源码（Rust 端 `agents/**`）里的每个 `AGENT_*` 失败码都已登记进错误码登记表
 * （仓库合同 `voice-agent-failure-codes` 对照 Host 源码），并在这里归到一类固定文案。插件自己已有专门处理的码
 * （会话权限 / 失效、结果回执、取消 / 超时等）不在表里，沿用原来的文案。
 */
export type AgentCodeCategory =
  | "modelBudget" | "toolBudget" | "busy" | "tooLarge" | "invalid" | "session" | "runtime"
  | "workerOwnerStale" | "workerUnavailable" | "config" | "tool" | "exec" | "approval" | "workspace" | "storage";

const CATEGORY_CODES: Readonly<Record<AgentCodeCategory, readonly string[]>> = {
  modelBudget: ["AGENT_MODEL_BUDGET_EXCEEDED"],
  toolBudget: ["AGENT_TOOL_BUDGET_EXCEEDED"],
  busy: ["AGENT_QUEUE_FULL", "AGENT_IDEMPOTENCY_CONFLICT", "AGENT_TURN_SETTLED", "AGENT_RESOURCE_NATIVE_BUSY"],
  tooLarge: ["AGENT_INPUT_TOO_LARGE", "AGENT_CONFIG_TOO_LARGE", "AGENT_EVENT_TOO_LARGE", "AGENT_RESULT_TOO_LARGE"],
  invalid: ["AGENT_IDEMPOTENCY_INVALID", "AGENT_MODEL_INPUT_INVALID", "AGENT_RESULT_INVALID", "AGENT_TURN_NOT_FOUND",
    "AGENT_CAPABILITY_INVALID"],
  session: ["AGENT_SESSION_CLOSED", "AGENT_SESSION_STALE", "AGENT_SCOPE_CLOSED", "AGENT_SCOPE_STALE", "AGENT_INTERRUPTED", "AGENT_RESOURCE_NATIVE_STALE"],
  runtime: [
    "AGENT_RUNTIME_ACTIVE_MISSING", "AGENT_RUNTIME_ADAPTER_UNSUPPORTED", "AGENT_RUNTIME_BINDING_CHANGED",
    "AGENT_RUNTIME_BINDING_INVALID", "AGENT_RUNTIME_BINDING_MISMATCH", "AGENT_RUNTIME_BINDING_REQUIRED",
    "AGENT_RUNTIME_BINDING_UNAVAILABLE", "AGENT_RUNTIME_CAPABILITY_INVALID", "AGENT_RUNTIME_DOWNLOAD_REQUIRED",
    "AGENT_RUNTIME_FAILED", "AGENT_RUNTIME_GENERATION_MISMATCH", "AGENT_RUNTIME_LEASE_OVERFLOW", "AGENT_RUNTIME_NOT_AUTHORIZED",
    "AGENT_RUNTIME_OWNER_DIGEST_MISSING", "AGENT_RUNTIME_OWNER_UNAVAILABLE", "AGENT_RUNTIME_PACKAGE_IN_USE",
    "AGENT_RUNTIME_PACKAGE_MISSING", "AGENT_RUNTIME_PACKAGE_MISSING_OR_AMBIGUOUS", "AGENT_RUNTIME_PACKAGE_PATH_INVALID",
    "AGENT_RUNTIME_PACKAGE_UNTRUSTED", "AGENT_RUNTIME_PERMISSION_DENIED", "AGENT_RUNTIME_REFERENCE_MISSING_OR_AMBIGUOUS",
    "AGENT_RUNTIME_REFERENCE_STALE", "AGENT_RUNTIME_REGISTRY_UNAVAILABLE", "AGENT_RUNTIME_REQUIREMENT_MISSING_OR_AMBIGUOUS",
    "AGENT_RUNTIME_REQUIREMENT_OR_TRUST_MISMATCH", "AGENT_RUNTIME_SELECTION_RECEIPT_CONFLICT",
    "AGENT_RUNTIME_SELECTION_RECEIPT_INVALID", "AGENT_RUNTIME_SELECTION_RECEIPT_MISMATCH",
    "AGENT_RUNTIME_SELECTION_RECEIPT_MISSING", "AGENT_RUNTIME_SELECTION_RECEIPT_UNREADABLE", "AGENT_RUNTIME_SHARED_UNTRUSTED",
    "AGENT_RUNTIME_TARGET_UNSUPPORTED",
  ],
  workerOwnerStale: ["AGENT_WORKER_OWNER_STALE"],
  workerUnavailable: ["AGENT_WORKER_UNAVAILABLE"],
  config: [
    "AGENT_BACKEND_COLD_SWITCH_REQUIRED", "AGENT_CONFIG_UNSUPPORTED", "AGENT_CONFIG_VERSION", "AGENT_DEFAULT_BINDINGS_INVALID",
    "AGENT_DEFAULT_BINDINGS_UNREADABLE", "AGENT_DEFAULT_BINDING_CHANGED", "AGENT_DEFAULT_BINDING_REQUIRED",
    "AGENT_DEFAULT_RESOURCE_CHANGED", "AGENT_INITIAL_PREFERENCE_INVALID", "AGENT_INITIAL_PREFERENCE_UNREADABLE",
    "AGENT_PREFERENCE_INVALID", "AGENT_PREFERENCE_UNREADABLE", "AGENT_PREFERENCE_WRITE_FAILED", "AGENT_SCOPE_LIMIT",
    "AGENT_SCOPE_PLATFORM_UNSUPPORTED",
  ],
  tool: [
    "AGENT_PERMISSION_REVOKED", "AGENT_TOOL_ARGUMENTS_INVALID", "AGENT_TOOL_AUTHORIZATION_UNAVAILABLE", "AGENT_TOOL_CALL_CONFLICT",
    "AGENT_TOOL_CALL_ID_INVALID", "AGENT_TOOL_CALL_ID_REQUIRED", "AGENT_TOOL_CAPABILITY_INVALID", "AGENT_TOOL_CATALOG_INVALID",
    "AGENT_TOOL_CONFIG_INVALID", "AGENT_TOOL_DUPLICATE", "AGENT_TOOL_GENERATION_CHANGED", "AGENT_TOOL_NOT_GRANTED",
    "AGENT_TOOL_OUTCOME_UNKNOWN", "AGENT_TOOL_OUTPUT_INVALID", "AGENT_TOOL_PERMISSION_DENIED", "AGENT_TOOL_PROVIDER_INVALID",
    "AGENT_TOOL_SCOPE_REQUIRED", "AGENT_TOOL_UNSUPPORTED",
  ],
  exec: [
    "AGENT_EXEC_ARGUMENTS_INVALID", "AGENT_EXEC_CANCELLED", "AGENT_EXEC_FAILED", "AGENT_EXEC_IO_FAILED",
    "AGENT_EXEC_LEASE_UNAVAILABLE", "AGENT_EXEC_OUTPUT_LIMIT", "AGENT_EXEC_PATH_INVALID", "AGENT_EXEC_PROGRAM_UNSUPPORTED",
    "AGENT_EXEC_SANDBOX_UNAVAILABLE", "AGENT_EXEC_SCOPE_REQUIRED", "AGENT_EXEC_TIMEOUT", "AGENT_EXEC_UNSUPPORTED",
    "AGENT_EXEC_YOLO_REQUIRED",
  ],
  approval: ["AGENT_APPROVAL_DENIED", "AGENT_APPROVAL_EXPIRED", "AGENT_APPROVAL_LIMIT", "AGENT_APPROVAL_NOT_FOUND",
    "AGENT_APPROVAL_STALE"],
  workspace: ["AGENT_WORKSPACE_INVALID_REQUEST", "AGENT_WORKSPACE_IO_FAILED", "AGENT_WORKSPACE_NOT_AUTHORIZED",
    "AGENT_MIRROR_FAILED", "AGENT_MIRROR_GIT_UNAVAILABLE", "AGENT_MIRROR_SYNC_CONFLICT"],
  storage: ["AGENT_STORAGE_FAILED", "AGENT_STORAGE_FULL"],
};

const CATEGORY_OF: ReadonlyMap<string, AgentCodeCategory> = new Map(
  (Object.entries(CATEGORY_CODES) as Array<[AgentCodeCategory, readonly string[]]>)
    .flatMap(([category, codes]) => codes.map((code) => [code, category] as const)),
);

/** 表里所有码（测试核对「Host 的每个 Agent 失败码都有一句人话」用）。 */
export const AGENT_CODES_WITH_REASON: readonly string[] = [...CATEGORY_OF.keys()];

/** 码按值查登记表与本表；不认得的返回 undefined。 */
export function agentCodeCategory(code: unknown): AgentCodeCategory | undefined {
  const registered = registeredErrorCode(code);
  return registered ? CATEGORY_OF.get(registered) : undefined;
}

const MAX_DEPTH = 4;
/** 失败链上第一个有固定人话的 Host Agent 码（只看结构化 `code` 字段，不从原文里抠）。 */
export function hostAgentCodeOf(cause: unknown): string | undefined {
  let current = cause;
  for (let depth = 0; depth <= MAX_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (agentCodeCategory(code)) return code as string;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 主句用的一句人话（含恢复动作）。 */
export function agentCodeReason(code: unknown): string | undefined {
  const category = agentCodeCategory(code);
  return category ? t(`errors.agentCode.${category}`) : undefined;
}

/** 胶囊 / 「原因（按错误码）」用的短句。 */
export function agentCodeLabel(code: unknown): string | undefined {
  const category = agentCodeCategory(code);
  return category ? t(`errors.agentCode.short.${category}`) : undefined;
}

/** Host `TurnFailure::stable_code`：只在 Host 没给 `code` 时按 kind 取 Host 自己的稳定码。 */
const KIND_CODES: Readonly<Record<string, string>> = { engine: "AGENT_ENGINE", timeout: "AGENT_TIMEOUT", killed: "AGENT_KILLED" };
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,99}$/;

/**
 * Agent 回合失败交给插件错误的码：**原样用 Host 给的 `failure.code`**，不再按 kind 重新包成 `AGENT_${kind}`。
 * 没登记的码照样原样保留（导出时由白名单省略、只计个数，原文在展开区）；只有 Host 没给码、或给的不是码的形态
 * 时，才按 kind 取 Host 自己的稳定码。
 */
export function agentTurnFailureCode(failure: { kind?: unknown; code?: unknown }): string {
  // 只收 Host 稳定码的形态（大写 + 下划线）：登记表里的小写交付枚举、浏览器异常名不是回合失败码，不能借登记表混进来。
  const code = typeof failure.code === "string" ? failure.code.trim() : "";
  if (CODE_SHAPE.test(code)) return code;
  return (typeof failure.kind === "string" ? KIND_CODES[failure.kind] : undefined) ?? "AGENT_ENGINE";
}

const SPECIFIC_REASON_CATEGORIES: ReadonlySet<AgentCodeCategory> = new Set(["tool", "exec", "approval", "workspace"]);
/** 工具 / 命令 / 确认 / 工作目录类码逐码的具体原因（「授权不可用」「执行超时」），大类短句会抹掉这层含义。 */
export const AGENT_CODES_WITH_TOOL_DETAIL: readonly string[] = AGENT_CODES_WITH_REASON
  .filter((code) => SPECIFIC_REASON_CATEGORIES.has(CATEGORY_OF.get(code) as AgentCodeCategory));

export function agentToolCodeDetail(code: unknown): string | undefined {
  const category = agentCodeCategory(code);
  return category && SPECIFIC_REASON_CATEGORIES.has(category) ? t(`chat.tools.codeReason.${code as string}`) : undefined;
}
