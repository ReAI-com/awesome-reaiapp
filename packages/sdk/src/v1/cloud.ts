/**
 * 两条底层云端 AI 通道的 App 侧类型。
 *
 * - `aiApi`（`cloud.model.invoke@1`）—— 中转各家大模型服务商的既有 API。
 * - `flowApi`（`cloud.workflow.invoke@1`）—— 调用已编排好、导出成 API 的工作流。
 *
 * 两条**并列，不互相包装**。这里没有润色、翻译、命令化、Agent 编排——
 * 那些是插件或工作流的事，底层只提供管道。
 *
 * ## 你给不了的东西
 *
 * endpoint / URL / path / header / 原始 body / 凭据 / provider / 模型真实 id /
 * 超时 / 重定向策略 / 并发数。传了会被 Host 在参数解析阶段直接拒绝。
 */

/** 模型档位。真实模型 id 归 Host，网关换代时插件零改动。 */
export interface CloudModelOption {
  /** 传给 `generateText` / `transcribe` 的稳定标识，如 `text-default`。 */
  id: string;
  kind: "text" | "transcribe";
  /** 可直接展示给用户的名字。 */
  label: string;
  /** Current platform default; account-scoped defaults may be free or metered. */
  isDefault?: boolean;
  /** Absent means unknown, never infer free from label or list order. */
  billingPolicy?: "free" | "metered";
  /** Authenticated current-account pricing, absent on older Hosts. */
  pricingContext?: "current-account";
  /** Decimal strings preserve exact prices, including tiny positive amounts. */
  effectivePrice?: CloudTranscriptionEffectivePrice;
}

export interface CloudTranscriptionEffectivePrice {
  unit: "second";
  unitPriceCents: string;
  baseUnitPriceCents: string;
  reason: "subscription_privilege" | "subscription_price" | "published_price";
  ruleRevision: string;
  policyRevision: string | null;
  subscriptionRevision: string | null;
  evaluatedAt: string;
  validUntil: string | null;
}

/**
 * 多模态生成的受控内容部件。
 *
 * 图片只能以内联 base64 交给 Host；不能给 URL 或本地路径。Host 会校验 MIME、
 * 魔数、解码尺寸与字节上限，再转换成上游协议。`detail` 当前只开放低细节档，
 * 避免一次润色把整张高分辨率窗口按原尺寸送上去。
 */
export type CloudGenerateContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mime: "image/jpeg" | "image/png";
      dataBase64: string;
      detail?: "low";
    };

export interface CloudGenerateMessage {
  role: "system" | "user" | "assistant";
  /** 旧插件的字符串合同保持不变；结构化部件只允许在 user 消息中出现。 */
  content: string | CloudGenerateContentPart[];
}

export interface CloudGenerateOptions {
  /** 本次调用的标识，由插件生成。取消要用它，所以必须先于结果拿到。 */
  invocationId: string;
  model: string;
  messages: CloudGenerateMessage[];
  /** true = 增量走推送通道（`onCloudEvent`），本方法立刻返回。 */
  stream?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
}

export type CloudGenerateResult =
  | { invocationId: string; stream: false; text: string }
  | { invocationId: string; stream: true };

export interface CloudTranscribeOptions {
  invocationId: string;
  /** `voiceInput.toggle({ retainAudio: true })` 拿到的录音会话 id。 */
  sessionId: string;
  /** 使用 ai.models.list 返回的转写选项 ID；省略时使用当前账号报价的后台默认项（可能按量计费）。已保存 ID 失效须由用户重新选择。 */
  model?: string;
  /** Preserve an explicit or previously saved free-only constraint. Ordinary account defaults omit it and may be metered. */
  billingPolicy?: "free-only";
  language?: string;
}

export interface CloudTranscribeResult {
  invocationId: string;
  text: string;
  /**
   * Host 把转写文本置空的原因（2026-10-16，#1291）：`punctuation_only` = 只有标点 / 空白；
   * `hallucination_phrase` = 录音没有可靠语音证据，且整句等于公认的静音幻觉
   * （如「字幕由 Amara.org 社区提供」）；`silence` = 整段静音、未上传。出现时 `text` 为 `""`，
   * 按「没听清」处理。常见真实短词（「嗯」「好」「Thank you」等）从不置空。旧 Host 不返回。
   */
  suppressedReason?: "punctuation_only" | "hallucination_phrase" | "silence";
}

/**
 * 取消的诚实边界。
 *
 * `upstreamStopped: false` 表示「已放弃结果，但上游可能仍在跑、仍在计费」——
 * 转写就是这种（上游完全不接 signal）。不要把它显示成「已停止」。
 */
export interface CloudCancelResult {
  cancelled: boolean;
  upstreamStopped: boolean;
}

/** 流式增量。`sequence` 在一次调用内严格递增，可用来发现空洞。 */
export type CloudStreamEvent =
  | {
      type: "ai.stream.delta";
      invocationId: string;
      sequence: number;
      /** Host 已按固定窗口合并过，不是逐 token。 */
      text: string;
    }
  | {
      type: "ai.stream.done";
      invocationId: string;
      sequence: number;
      /** 完整最终文本。**据此对账**，不要依赖增量拼接正确。 */
      text: string;
    }
  | {
      type: "ai.stream.error";
      invocationId: string;
      sequence: number;
      /** `AI_STREAM_LOST` = 增量在推送途中丢了，拿到的是残文，应当重试。 */
      code: string;
      message: string;
    }
  | {
      /** 工作流事件的**原样有序透传**（脱敏 + 有界 + 加序号），Host 不翻译成业务阶段。 */
      type: "flow.event";
      invocationId: string;
      sequence: number;
      event: unknown;
    };

export interface CloudAiClient {
  /** Runtime guarantees it serializes free-only billing intent. Absent on older injected SDKs;
   * callers must fail closed before automatic free transcription, regardless of model metadata. */
  readonly freeOnlyTranscriptionSupported?: true;
  /** 列出可用档位；转写选项可含当前账号有效报价。均不含 provider 或真实模型 id。 */
  listModels(): Promise<CloudModelOption[]>;
  generateText(options: CloudGenerateOptions): Promise<CloudGenerateResult>;
  /** 转写 Host 托管的那段录音。插件全程碰不到音频字节。 */
  transcribe(options: CloudTranscribeOptions): Promise<CloudTranscribeResult>;
  cancel(invocationId: string): Promise<CloudCancelResult>;
}

export interface CloudFlowInvokeOptions {
  invocationId: string;
  /** Host 侧登记的**逻辑工作流名**。真实地址由 Host 持有。 */
  workflow: string;
  input?: unknown;
}

export interface CloudFlowResult {
  invocationId: string;
  result: unknown;
}

export interface CloudFlowClient {
  /**
   * 发起一次工作流。
   *
   * ⚠️ v1 = 发起 + 订阅 + 取消，**不支持回填输入**：后端 `POST /runs` 的创建与
   * resume 仅限 JWT，OAuth 够不到。收到 `wait_for_input` 时 Host 原样透传，
   * 但应答不了 —— 该类工作流本轮不可用。
   *
   * 今天 Driver 的登录授权里没有工作流档位，所以这条会稳定返回
   * `FLOW_SCOPE_UNAVAILABLE`（文案：云端工作流暂未开通）。这是**明确的未开通**，
   * 不是网络错误，也不要回退到别的通道。后端开通后无需改插件代码。
   */
  invoke(options: CloudFlowInvokeOptions): Promise<CloudFlowResult>;
  cancel(invocationId: string): Promise<CloudCancelResult>;
}

/** 结果写回目标应用（`voice.deliver@1`）。 */
export type CloudDeliveryResult =
  | { committed: true }
  // denied includes older Hosts with no precise cause; do not infer a missing permission.
  // not_editable / not_received since Host API 1.22; focus_changed is kept for older Hosts.
  | {
      committed: false;
      reason:
        | "expired"
        | "focus_changed"
        | "not_editable"
        | "not_received"
        | "denied"
        | "insert_failed"
        | "accessibility_permission_required";
    };

export interface CloudDeliveryClient {
  /**
   * 把最终文本写入交付那一刻光标所在的输入框（光标处插入 / 有选区时替换选区），
   * 一条会话凭证最多提交一次。
   *
   * macOS Host（Host API 1.22 起）先用辅助功能做事前判断：光标确定不在可输入位置
   * （按钮、静态文本、密码框等）返回 `not_editable`，不粘贴；网页 / Electron、看不到
   * 焦点元素等拿不准的照常粘贴。成败只看目标应用是否来取剪贴板（取件回执），不回读
   * 输入框：约 1 秒无人取件返回 `not_received`。Input 会话失败时 Host 弹取回卡。
   * Host API 1.22 起 Command 会话（翻译 / 转文本）同样可 commit：Host 的插入不认业务
   * 分支，「Agent 结果永不插入」由调用方保证；Command 会话失败 Host 不自动弹卡，由调用方
   * 自己呈现。识别结果带 `consumedBy` 时（如被 Tab 层搜索消费）该会话凭证已撤销，
   * commit 只会返回 `expired`，不要再提交。`focus_changed` 保留给旧 Host，新 Host 的
   * 当前输入框写回不再产出。
   */
  commit(options: {
    /** `voiceInput.toggle()` 返回的 `deliveryTarget.id`。 */
    targetId: string;
    text: string;
    /** 有选区时 `insert` 与 `replace_selection` 都是替换选区。 */
    behavior?: "insert" | "replace_selection";
  }): Promise<CloudDeliveryResult>;
  /**
   * 写回失败时请求 Host 弹「取回文字」系统级卡片（Voice 胶囊正上方）：
   * 识别全文 + 一键复制，用户复制或关闭后消失。
   *
   * 语义归插件：何时弹、标题/原因文案都由插件按自己的 i18n 给出；
   * Host 只负责显示在哪。呈现是尽力而为 —— 不支持该方法的旧 Host 以稳定的
   * `HOST_CAPABILITY_NOT_AVAILABLE` 拒绝（参数越界才是
   * `VOICE_DELIVER_INVALID_REQUEST`），调用方应把两种拒绝都吞掉。
   */
  presentTakeback(options: {
    /** 已本地化的标题（如「文字没有写入成功」）。 */
    title: string;
    /** 已本地化的原因一句。 */
    reason: string;
    /** 完整识别文本。 */
    text: string;
    /**
     * Host API 1.22（同版本并入）：失败的结构化错误码，卡片显示并随「复制诊断」复制。
     * 码的形状：可选的小写反向域名命名空间加 `/`，再接字母开头、只含字母数字下划线的标识（≤ 64），
     * 总长 ≤ 100（如 `com.example.app/STORAGE_READ_FAILED`、`AI_TIMEOUT`、`not_received`）；
     * 不合规整次请求以 `VOICE_DELIVER_INVALID_REQUEST` 拒绝。
     * 旧 Host 忽略本字段。
     */
    errorCode?: string;
    /**
     * Host API 1.22（同版本并入）：诊断用的原始原因（≤ 500 字）。Host 把它当作不可信的自由文本：
     * 原文不显示、不复制、不转交浮层，只保留字数（卡片写「原始信息可能含用户内容，已省略（N 字符）」）。
     * 需要让用户看到的原因请放进已本地化的 `reason`，可诊断的信息请用结构化的 `errorCode`。旧 Host 忽略本字段。
     */
    detail?: string;
  }): Promise<void>;
}

/**
 * 稳定错误码 → 上层小写码的**纯查表**。
 *
 * 刻意做在 SDK 侧而不是改 `BridgeError` 信封：那个信封（`{code, message}`）是
 * 所有能力共用的，为一条通道加字段会波及全部既有能力。
 */
export interface CloudErrorInfo {
  code:
    | "not_logged_in"
    | "permission_denied"
    | "invalid_request"
    | "unavailable"
    | "timeout"
    | "rate_limited"
    | "cancelled"
    | "unknown";
  retryable: boolean;
}

const CLOUD_ERROR_TABLE: Readonly<Record<string, CloudErrorInfo>> = {
  AI_NOT_LOGGED_IN: { code: "not_logged_in", retryable: false },
  AI_NOT_GRANTED: { code: "permission_denied", retryable: false },
  AI_PERMISSION_REQUIRED: { code: "permission_denied", retryable: false },
  AI_PERMISSION_DENIED: { code: "permission_denied", retryable: false },
  AI_INVALID_REQUEST: { code: "invalid_request", retryable: false },
  AI_UNAVAILABLE: { code: "unavailable", retryable: true },
  AI_NETWORK_ERROR: { code: "unavailable", retryable: true },
  AI_SUBSCRIPTION_REQUIRED: { code: "unavailable", retryable: false },
  AI_SUBSCRIPTION_UNAVAILABLE: { code: "unavailable", retryable: true },
  AI_TIMEOUT: { code: "timeout", retryable: true },
  AI_RATE_LIMITED: { code: "rate_limited", retryable: true },
  // 上层合同里没有「余额不足」这一档，落到 unavailable；retryable=false，
  // 因为重试解决不了余额问题，只会白白再失败一次。
  AI_PAYMENT_REQUIRED: { code: "unavailable", retryable: false },
  AI_CANCELLED: { code: "cancelled", retryable: false },
  AI_SCOPE_UNAVAILABLE: { code: "permission_denied", retryable: false },
  AI_STREAM_LOST: { code: "unavailable", retryable: true },
  AI_DISABLED: { code: "unavailable", retryable: false },
  AI_UNKNOWN: { code: "unknown", retryable: false },

  FLOW_NOT_LOGGED_IN: { code: "not_logged_in", retryable: false },
  FLOW_NOT_GRANTED: { code: "permission_denied", retryable: false },
  FLOW_PERMISSION_REQUIRED: { code: "permission_denied", retryable: false },
  FLOW_PERMISSION_DENIED: { code: "permission_denied", retryable: false },
  FLOW_INVALID_REQUEST: { code: "invalid_request", retryable: false },
  FLOW_UNAVAILABLE: { code: "unavailable", retryable: true },
  FLOW_NETWORK_ERROR: { code: "unavailable", retryable: true },
  FLOW_TIMEOUT: { code: "timeout", retryable: true },
  FLOW_RATE_LIMITED: { code: "rate_limited", retryable: true },
  FLOW_PAYMENT_REQUIRED: { code: "unavailable", retryable: false },
  FLOW_CANCELLED: { code: "cancelled", retryable: false },
  FLOW_SCOPE_UNAVAILABLE: { code: "permission_denied", retryable: false },
  FLOW_STREAM_LOST: { code: "unavailable", retryable: true },
  FLOW_DISABLED: { code: "unavailable", retryable: false },
  FLOW_INPUT_UNSUPPORTED: { code: "invalid_request", retryable: false },
  FLOW_UNKNOWN: { code: "unknown", retryable: false },

  VOICE_DELIVER_NOT_GRANTED: { code: "permission_denied", retryable: false },
  VOICE_DELIVER_PERMISSION_REQUIRED: { code: "permission_denied", retryable: false },
  VOICE_DELIVER_PERMISSION_DENIED: { code: "permission_denied", retryable: false },
  VOICE_DELIVER_INVALID_REQUEST: { code: "invalid_request", retryable: false },
  VOICE_AUDIO_UNAVAILABLE: { code: "invalid_request", retryable: false },
};

/** 认不出的码一律 `unknown` + 不可重试：宁可少重试，也不要在未知失败上打转。 */
export function describeCloudError(code: string): CloudErrorInfo {
  return CLOUD_ERROR_TABLE[code] ?? { code: "unknown", retryable: false };
}
