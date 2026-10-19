import { AppError } from "@reai/app-sdk/v1";
import { collectErrorFields, isCollectedFields, structuredCode, type VoiceErrorFields } from "./voice-error-fields";
import { taskFailureLabel } from "./voice-failure-labels";

/** 主句是插件固定文案的错误（按出身登记：只有构造时明确声明的实例才在表里）。 */
const CONSTANT_MESSAGE = new WeakSet<object>();

/** Keep explicitly authored error text reactive without translating provider messages. */
export class VoiceAppError extends AppError {
  /**
   * 已采集的诊断字段（含内存原文）：只给本插件界面的诊断用。不可枚举、也不经 `cause`——
   * SDK 把 `cause` 序列化成 wire `diagnostic` 交给 Host，原文不能这样离开插件。
   */
  declare readonly diagnosticFields?: VoiceErrorFields;

  /**
   * `constantMessage`：主句只由插件 i18n 文案与插件自己的枚举参数组成（不插任何上游文字）。
   * 只有声明了它，主句才能交回 SDK / 上浮层；默认不信任，改按错误码查表。
   */
  constructor(
    input: ConstructorParameters<typeof AppError>[0],
    diagnosticFields?: VoiceErrorFields,
    options: { constantMessage?: true; composedMessage?: true } = {},
  ) {
    super(input);
    const message = Object.getOwnPropertyDescriptor(input, "userMessage");
    if (message?.get) Object.defineProperty(this, "userMessage", message);
    if (diagnosticFields) Object.defineProperty(this, "diagnosticFields", { value: diagnosticFields, enumerable: false });
    if (options.constantMessage) CONSTANT_MESSAGE.add(this);
    if (options.composedMessage) COMPOSED_MESSAGE.add(this);
  }
}

/**
 * 组合主句：插件 i18n 模板 + 递归的 `readableError()` / 固定短句。插件界面可以显示（每次求值都按当前
 * 模式过滤），但不能交回 SDK 或上浮层——开发者模式下嵌入的原因可能是上游原文。
 */
const COMPOSED_MESSAGE = new WeakSet<object>();
export function composedUserMessage(cause: unknown): string | undefined {
  return cause instanceof VoiceAppError && COMPOSED_MESSAGE.has(cause) ? cause.userMessage : undefined;
}

/** 可以离开插件界面（交回 SDK、上浮层）的主句：只有登记为固定文案的插件错误才有；其余返回 undefined。 */
export function constantUserMessage(cause: unknown): string | undefined {
  return cause instanceof VoiceAppError && CONSTANT_MESSAGE.has(cause) ? cause.userMessage : undefined;
}

/** 插件错误上挂的已采集字段：只认诊断模块自己构造的（按出身），外部同形对象不算。 */
export function trustedDiagnosticFields(cause: unknown): VoiceErrorFields | undefined {
  const fields = cause instanceof VoiceAppError ? cause.diagnosticFields : undefined;
  return isCollectedFields(fields) ? fields : undefined;
}

/**
 * 命令失败交回 SDK 的安全错误。SDK 按形状序列化 `code` / `userMessage`，并把 `cause` 转成 wire
 * `diagnostic` 交给 Host（会进 Host 日志）：这里只给登记过的码、插件固定文案与 retryable，不带 cause。
 * 插件自己的页面照旧用原异常（主句与「展开原始信息」）。
 */
export function commandWireError(cause: unknown): AppError {
  const fields = trustedDiagnosticFields(cause) ?? collectErrorFields(cause);
  const code = structuredCode(fields.code) ?? "com.reai.voice/VOICE_COMMAND_FAILED";
  const retryable = !!cause && typeof cause === "object" && (cause as { retryable?: unknown }).retryable === true;
  return new VoiceAppError({
    code,
    get userMessage() { return constantUserMessage(cause) ?? taskFailureLabel({ code }); },
    retryable,
  });
}
