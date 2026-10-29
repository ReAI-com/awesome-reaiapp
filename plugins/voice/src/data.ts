import type { SavedInputExecution, SavedInputRetryPlan, SavedInputRetryPhase } from "./saved-input-retry";
import { translationTarget, type TranslationTarget } from "./voice-translation";
import { t } from "./voice-i18n";
import { interruptedLabel } from "./voice-stop-copy";
import { structuredCode, type VoiceErrorSource } from "./voice-error-fields";
import { agentFailureFields, type AgentFailureFields } from "./agent-failure-stage";
import { sanitizeAgentUsage } from "./agent-metadata";
import type {
  KeyValueStore,
  VoiceInputSettings,
  VoiceInputStatus,
  VoiceInputSource,
  AudioTimelineStatus,
  VoiceModelInfo,
  VoicePermissionInfo,
  VoiceSourceIssue,
  SystemInputEndpoint,
  VoiceRecordingSegment,
  VoiceReplayCacheStatus,
  VoiceReplayClipRef,
  VoiceInputResult,
  CloudModelOption,
  AgentTokenUsage,
  AgentBackendStatus,
  AgentApprovalSummary,
} from "@reai/app-sdk/v1";
import { isAudioSourceMode } from "./voice-audio-source";
import type { VoiceDayDigest } from "./voice-digest";
import { conversationKey, type VoiceConversationOptions } from "./agent-conversation";

export type { VoiceDayDigest };

/** 一条等用户拍板的回合等待：`taskId` 是命令运行的 UI 任务 id，`label` 是 Host 给的说明。 */
export interface VoiceAgentUserWait {
  taskId: string;
  waitId: string;
  reason: string;
  label: string;
  startedAt: number;
}

export const MAX_HISTORY_ITEMS = 200;
// Host 对单个 KV value 的硬上限是 256 KiB；留 1 KiB 给序列化边界余量。
export const MAX_HISTORY_STORE_BYTES = 255 * 1024;
export const COMMAND_HISTORY_KEY = "command-history";
export const COMMAND_AGENT_SESSION_LEDGER_KEY = "command-agent-session-ledger-v1";
/** 按天存的当日总结（R18）：dayKey → 一份。 */
export const DAY_DIGESTS_KEY = "day-digests";
/** 自动当日总结最近一次未成功完成的尝试时间：dayKey → attemptedAtMs。 */
export const DAY_DIGEST_ATTEMPTS_KEY = "day-digest-attempts-v1";
/** 与总结的 14 天保留期对齐，另留一格覆盖时区/午夜边界。 */
export const MAX_DAY_DIGEST_ATTEMPTS = 16;
const DAY_DIGEST_ATTEMPT_RETENTION_DAYS = 14;
export const SOURCE_MIGRATION_KEY = "source-migration-v1";
/** 2 = 用户已在新版规则下确认过音源，或旧未确认 system 已完成 Board-first 迁移。 */
export const SOURCE_SELECTION_KEY = "source-selection-v2";
const SOURCE_SELECTION_VERSION = 2;
/** 多键 KV 提交中的可恢复 journal；存在时下次激活必须继续完成 Board 迁移。 */
const SOURCE_SELECTION_PENDING_KEY = "source-selection-v2-pending";
export const SOURCE_MIGRATION_NOTICE_KEY = "source-selection-v2-notice";
export const SOURCE_MIGRATION_NOTICE =
  "录音来源已恢复为键盘麦克风，可在设置 › 录音来源改回电脑麦克风";
/**
 * 润色默认档迁移标记（2026-09-27）：1 = 已把存量 `polish:"raw"` 一次性迁到轻度。
 *
 * 旧版出厂默认是原样，而那份默认会随任何一次设置保存落盘，分不出「用户选的原样」与
 * 「旧默认」；1.0 尚未正式发布、存量均为内测用户，所以按定稿一次性全部迁移。标记在
 * settings 写入之后才落，任一步失败下次激活重试；标记落下后用户再选原样不再被改。
 */
export const POLISH_LIGHT_DEFAULT_MIGRATION_KEY = "polish-light-default-v1";
export const DEFAULT_MODEL_ID = "sensevoice-small-int8";
export const VOICE_FEATURE_SETTINGS_KEY = "voice-feature-settings-v1";

export interface VoiceFeatureSettings {
  translationTarget: TranslationTarget;
  /** 云端转写模型档位；真实 provider/model id 仍只在 Host。 */
  cloudModelId: string;
  cloudModelBillingPolicy?: "free-only";
  /** 每日总结总开关。默认关闭；关闭时不允许手动或自动生成。 */
  summaryEnabled: boolean;
  summaryMode: "manual" | "auto";
  /** 用户已明确接受过每日批量转写上传的用量与隐私提示。 */
  summaryConsent: boolean;
}

export const DEFAULT_VOICE_FEATURE_SETTINGS: VoiceFeatureSettings = {
  translationTarget: "en-US",
  cloudModelId: "",
  summaryEnabled: false,
  summaryMode: "manual",
  summaryConsent: false,
};
export interface CommandAgentSessionLedgerItem {
  sessionId: string;
  createdMs: number;
}

export function planCommandAgentSessionReconciliation(options: {
  ledger: readonly CommandAgentSessionLedgerItem[];
  hostSessions: readonly CommandAgentSessionLedgerItem[];
  visibleSessionIds: ReadonlySet<string>;
  activeSessionIds: ReadonlySet<string>;
  processStartedAt: number;
}): { forgetSessionIds: string[]; deleteSessionIds: string[] } {
  const hostById = new Map(options.hostSessions.map((session) => [session.sessionId, session]));
  const forgetSessionIds: string[] = [];
  const deleteSessionIds: string[] = [];
  // 只遍历 Voice 自己的正向台账。Host 返回的其他插件会话或用户主动创建的
  // 会话永远不会进入删除候选，避免用“看起来像 Voice”之类的猜测误删数据。
  for (const ledgerItem of options.ledger) {
    const host = hostById.get(ledgerItem.sessionId);
    if (!host) {
      forgetSessionIds.push(ledgerItem.sessionId);
      continue;
    }
    if (
      options.visibleSessionIds.has(ledgerItem.sessionId)
      || options.activeSessionIds.has(ledgerItem.sessionId)
      || host.createdMs >= options.processStartedAt
    ) {
      continue;
    }
    deleteSessionIds.push(ledgerItem.sessionId);
  }
  return { forgetSessionIds, deleteSessionIds };
}
/** 已有 Agent 对话的显式来源；追问不能靠 sessionId 前缀或当前实验开关猜路由。 */
export type VoiceAgentConversationRef =
  | { agentSessionId: string; dshSessionId?: never; conversationId?: string }
  | { agentSessionId?: never; dshSessionId: string; conversationId?: string }
  | { agentSessionId?: never; dshSessionId?: never; conversationId: string };

// 这里限制的是 JSON string 的序列化体积，而不是原始 UTF-8。换行、引号、反斜杠等字符
// 会在 JSON 中转义膨胀，必须按 Host 最终收到的 value 口径计算。
const MAX_INPUT_TRANSCRIPT_JSON_BYTES = 128 * 1024;
const MAX_COMMAND_TRANSCRIPT_JSON_BYTES = 32 * 1024;
const MAX_COMMAND_REPLY_JSON_BYTES = 128 * 1024;

export interface VoiceHistoryItem {
  id: string;
  transcript: string;
  language: string;
  source: VoiceInputSource;
  inserted: boolean;
  durationMs: number;
  createdAt: string;
  warningCode?: string;
  /** Esc/中断保存但尚未成功转写时存在；成功重试后移除。 */
  transcriptionStatus?: "not_requested" | "pending" | "failed";
  /** Recording-start selection; absent on older records or if its journal was not saved. */
  originalSelection?: import("@reai/app-sdk/v1").SavedInputSelection;
  retryPlan?: SavedInputRetryPlan;
  savedInput?: SavedInputExecution;
  stopReason?: "user_cancel" | "capture_limit" | "source_unavailable";
  /**
   * 这一条实际走过的识别路径快照。
   *
   * 详情页只能读这里，不能拿设置页的当前 engine 反推历史：用户可能在录音之后
   * 切换设置，旧记录也早于这个字段。缺席时如实显示“未记录”。
   */
  recognitionEngine?: VoiceInputSettings["engine"];
  /** Capture-time intent from Host; it does not mean transcription succeeded. */
  requestedEngine?: VoiceInputSettings["engine"];
  /**
   * 润色**真的改动了**原文时，这里存改动前的识别原文。
   *
   * 没改动就不存：详情页拿它画前后对照，两边一模一样的对照是在假装做了工作。
   * 润色失败回退时同样不存——那一条 `transcript` 本来就是原文。
   */
  originalTranscript?: string;
  /**
   * 这一条实际跑的润色档位。
   *
   * 与 `originalTranscript` 是两件事：「润色跑了但原文已经很通顺」和「压根没跑润色」
   * 都不会留下对照，只有这个字段能把它们分开。缺席 = 这条历史早于润色功能。
   */
  polish?: VoiceInputSettings["polish"];
  /**
   * 这一条的润色真的跑失败了（已回退成原话）。
   *
   * 必须与 `warningCode` 分开存：写回失败会把 warningCode 占掉（而「润色超时 4 秒
   * → 用户等不及切走窗口 → 写回被拒」正是最常见的一条），那时润色失败就再没有别的
   * 地方留痕，详情页会把它显示成「无需修改」——那正是「把失败伪装成成功」。
   */
  polishFailed?: boolean;
  /**
   * 这条历史对应的回听片段。文字是永久的，声音受设置 › 录音缓存的保留时长约束——
   * 所以这两个字段可能指向一段已经被清掉的录音，判断还在不在见 `isReplayAvailable`。
   */
  recordingId?: string;
  recordingWallStartMs?: number;
  /**
   * 回听片段本身的时长。与 `durationMs` 不是一回事：后者是采集时长（含按下键到
   * 开口那段静音），片段是裁剪之后的，播放条要读这一个才不会跟真声音对不上。
   */
  recordingDurationMs?: number;
  /**
   * 这一条润色 / 写回两个阶段各自的真实失败（§6.0：只存码与结构化字段，原文不落盘）。
   * `warningCode` 仍决定既有文案；这两个字段只供诊断，分阶段存，互不覆盖。
   */
  polishFailure?: VoiceStageFailure;
  deliveryFailure?: VoiceStageFailure;
}

/**
 * 某个阶段的真实失败（持久化形态，白名单）：码、来源类别、HTTP 状态码、原文字符数、发生时间。
 * 上游原文不落盘（可能回显用户内容）；本次运行里的原文另存内存，只供界面主动展开。
 */
export interface VoiceStageFailure {
  code: string;
  at: string;
  source?: VoiceErrorSource;
  httpStatus?: number;
  rawLength?: number;
  /** 链上没登记的码的个数（只存个数，码本身不落盘）。 */
  omittedCodes?: number;
}

/**
 * 界面上一次失败的诊断（设计规范 §6.0）：`step` 是 `diagnostics.step.*` 的键，其余是结构化字段。
 * 只活在界面状态里，不落盘。
 */
export interface VoiceErrorDetail {
  step: string;
  code?: string;
  upstreamCodes?: string[];
  source?: VoiceErrorSource;
  httpStatus?: number;
  at: string;
  /** 这一步开始的时刻（ms）：有它就显示冻结的「用时」。 */
  sinceMs?: number;
  /** 原文字符数（复制文本只写这个）。 */
  rawLength?: number;
  /** 原始技术原文，未改动：只在内存，不复制、不进浮层；用户在插件界面主动展开才显示。 */
  raw?: string;
  /** 链上没登记的码的个数（码本身只在原文里）。 */
  omittedCodes?: number;
  /** Agent 引擎失败的 Host 阶段、退出码、方括号上游码（结构化，逐值校验后才显示 / 复制）。 */
  agentFailure?: AgentFailureFields;
  /** 插件固定说明的 i18n 键（例如「App 返回的列表为空」）：由产生失败的一方明确给出，视图不反推。 */
  noteKey?: string;
}

/**
 * 刚落盘的片段就地并进「录音缓存」状态。
 *
 * 不这么做的话，缓存原本为空时（首次使用或刚清空）`retainedSinceMs`
 * 还是 null，刚录完那条会被判成「录音已过期」——录音其实好好躺在盘上。刚写进去的片段
 * 按定义就在保留窗口内，这个结论不需要再问一次 Host。占用按 Host 同一套换算（每毫秒
 * 32 字节 = PCM16 单声道 16 kHz）跟着走，下一次刷新会拿到权威值。
 */
export function replayCacheWithClip(
  cache: VoiceReplayCacheStatus | undefined,
  clip: VoiceReplayClipRef | null | undefined,
): VoiceReplayCacheStatus | undefined {
  if (!cache || !clip) return cache;
  return {
    ...cache,
    clipCount: cache.clipCount + 1,
    usedBytes: cache.usedBytes + Math.round(clip.durationMs * 32),
    retainedSinceMs: Math.min(cache.retainedSinceMs ?? clip.wallStartMs, clip.wallStartMs),
  };
}

/** 历史与播放条展示 Host 实际授权回放的气口区间，而不是磁盘上的 raw 包络。 */
export function replayPresentationRange(
  clip: VoiceReplayClipRef,
): { wallStartMs: number; durationMs: number } {
  const start = clip.effectiveStartMs;
  const end = clip.effectiveEndMs;
  if (
    typeof start === "number" &&
    Number.isFinite(start) &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    end >= start
  ) {
    return { wallStartMs: start, durationMs: end - start };
  }
  return { wallStartMs: clip.wallStartMs, durationMs: clip.durationMs };
}

/**
 * 这条历史现在还能不能回听。
 *
 * 判据只有一条：片段起点不早于「录音缓存」当前的保留下沿。过期清理与空间不够的
 * 淘汰都从最旧的开始，所以留下的永远是一段连续的近期区间——比下沿更早的都没了。
 * 这样一次状态查询就够全列表用，不需要为每条历史单独问一次 Host。
 */
export function isReplayAvailable(
  item: VoiceRecordingRef,
  replayCache: VoiceReplayCacheStatus | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!item.recordingId || typeof item.recordingWallStartMs !== "number") return false;
  if (!replayCache) return false;
  if (replayCache.retainedSinceMs === null) return false;
  // 起点跑到「现在」之后只可能是时钟前跳留下的坏数据，Host 会把它清掉——
  // 判据要跟着 Host 走，否则会出现「播放条在、点了取不到件」。
  if (item.recordingWallStartMs > nowMs) return false;
  return item.recordingWallStartMs >= replayCache.retainedSinceMs;
}

/**
 * 命令详情页一条消息（R8：命令详情按 Agent 对话界面做）。字段与 `@reai/chat-ui`
 * 的 `ChatMessage` 对齐，这里自己声明一份是为了让历史数据形态不绑定 UI 包的类型。
 */
export interface VoiceChatAttachment {
  kind: "file" | "image" | "audio";
  /** file：卡左侧的 emoji 图标。 */
  icon?: string;
  /** file：文件名。 */
  name?: string;
  /** file：「Plain text · 0.3 KB」一类的说明。 */
  meta?: string;
  /** image：占位说明。 */
  alt?: string;
  /** audio：时长。 */
  durationMs?: number;
  /** audio：波形条高度（px）。 */
  waveform?: number[];
}

export interface VoiceChatMessage {
  from: "user" | "ai";
  text: string;
  /** ISO 时间。 */
  at: string;
  attachments?: VoiceChatAttachment[];
  card?: VoiceChatCard;
  runtime?: "dsh" | "pi" | "codex";
  channel?: "external-brain";
  usage?: AgentTokenUsage;
  /** Legacy storage only; never treated as complete usage. */
  totalTokens?: number;
}

/** 工具名是 Host 工具目录里的标识符；不合文法的名字不进历史，也不上界面。 */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
export function isToolName(value: unknown): value is string {
  return typeof value === "string" && TOOL_NAME.test(value);
}

/**
 * 一次工具调用的明细（tool-group 卡展开后逐行显示，失败尝试保留）。同一回合的全部工具
 * （联网、网页、浏览器、文件、命令……）进同一张卡；2.14.2 及以前只记联网两工具。
 */
export interface VoiceToolCallEntry {
  callId?: string;
  tool: string;
  status: "running" | "completed" | "failed" | "unknown";
  at: string;
  durationMs?: number;
  errorLabel?: string;
  /** 这次调用的真实错误码（诊断用；errorLabel 是映射后的人话）。 */
  errorCode?: string;
}

export type VoiceChatCard =
  | {
      kind: "tool";
      tool: "web_search" | "web_fetch";
      status: "running" | "completed" | "failed";
      label: string;
    }
  | {
      /** 每任务一张聚合卡：折叠显示次数+状态，点开逐次调用明细（含失败重试）。 */
      kind: "tool-group";
      status: "running" | "completed" | "failed" | "unknown";
      label: string;
      calls: VoiceToolCallEntry[];
      /** Legacy cards lacked counters; new writes populate all three. */
      totalCalls?: number;
      failedCalls?: number;
      omittedCalls?: number;
    }
  | {
      kind: "capability-required";
      capability: "browser-web-access";
      title: string;
      detail: string;
      actionId: "install-browser-web-access";
      actionLabel: string;
    }
  | { kind: "auth-required"; title: string; detail: string };

/** 命令详情页头身份（稿 `chatAva / chatName / chatRole`）。 */
export interface VoiceCommandIdentity {
  /** emoji 头像。 */
  avatar: string;
  title: string;
  role: string;
}

export interface VoiceCommandHistoryItem {
  id: string;
  transcript: string;
  /** 任务开始前持久化 running；重新激活时把失去 owner 的任务恢复成已中断。 */
  status: "running" | "completed" | "failed";
  createdAt: string;
  reply?: string;
  runId?: string;
  /** Private admission journal key; never used as a native turn ID. */
  agentRequestKey?: string;
  /** 旧版 Dsh 会话 id；只用于兼容迁移前的历史。 */
  dshSessionId?: string;
  /** 通用 Agent Session；详情追问复用它，同会话条目在详情页拼成一条流。 */
  agentSessionId?: string;
  /** F04：可见对话的稳定身份；切换引擎 / 会话后仍是同一段对话。 */
  conversationId?: string;
  /** 这条跑的是哪类命令（转文本 / 翻译 / Agent 提问）；缺席 = 早于该字段的旧条目。 */
  commandId?: string;
  translationTarget?: TranslationTarget;
  durationMs?: number;
  errorCode?: string;
  userMessage?: string;
  /** 失败原文的字符数（原文本身不落盘）；旧条目缺席时诊断写「未记录」。 */
  errorRawLength?: number;
  /** 失败来源类别（按码命名空间 / 失败合同判定，判不出不写）。 */
  errorSource?: VoiceErrorSource;
  /** 失败时结构化的 HTTP 状态码。 */
  errorHttpStatus?: number;
  /** 失败链上没登记的码的个数（只存个数，码本身不落盘）。 */
  errorOmittedCodes?: number;
  /** Agent 引擎失败的 Host 阶段码（登记表内才落盘）、退出码（i32 整数）、方括号上游码（登记过才落盘）。 */
  errorAgentStage?: string;
  errorExitCode?: number;
  errorUpstreamCode?: string;
  /** 真实失败时刻（ISO）。 */
  failedAt?: string;
  /** 中断恢复时才发现的时刻（ISO）：不冒充失败时刻。 */
  failureDetectedAt?: string;
  /** 页头身份覆盖；缺席时由 commandId / transcript 推出。 */
  identity?: VoiceCommandIdentity;
  /**
   * 完整消息流（含附件）。有它就按它渲染，没有就从 transcript / reply / userMessage
   * 推出两三条。这是命令改由 Agent Session 承载后「会话投影」的落点；现阶段没有真实
   * 附件产物，只有审计夹具在用。
   */
  messages?: VoiceChatMessage[];
  /** 结果还没被打开过；进过一次命令详情就清掉。 */
  unread?: boolean;
  /**
   * 这条命令的录音片段（2026-09-27 定稿：输入法、翻译、Agent 三个方向都存切片原始
   * 音频，保证以后可回看 / 重转）。Host 在 command 结果里带 `replayClip` 时才有；
   * 旧 Host 不返回就三项都缺席，含义与输入历史的同名字段一致。
   */
  recordingId?: string;
  recordingWallStartMs?: number;
  recordingDurationMs?: number;
}

/**
 * `messages`（含附件）序列化后的总预算。**按整体而不是逐字段放行**：裁剪函数
 * `trimHistoryToStoreLimit` 遇到第一条就超 255 KiB 会把整份历史写成空数组，所以一条
 * 命令条目最坏要装得下：transcript 32 KiB + reply 128 KiB + messages 24 KiB ≈ 184 KiB。
 */
export const MAX_COMMAND_MESSAGES_JSON_BYTES = 24 * 1024;
const MAX_COMMAND_MESSAGES = 50;
const MAX_COMMAND_ATTACHMENTS = 10;
const MAX_ATTACHMENT_WAVEFORM_BARS = 48;
const MAX_IDENTITY_FIELD_JSON_BYTES = 200;
/** tool-group 卡的调用明细上限：超出保留最近 N 条，防止长回合撑爆历史存储。 */
export const MAX_TOOL_CALL_ENTRIES_PER_CARD = 20;

export interface VoiceViewState {
  /** Host 的真实开发者模式；关闭时调试元信息完全不渲染。 */
  developerMode: boolean;
  /** 截图同意（§5D）：独立于窗口文字，默认关闭；enabled 只反映本次登录会话的
   *  同意状态，来源是 VoiceScreenshotConsent，不在 settings 里双写。 */
  screenshotConsent: { enabled: boolean; unavailable?: boolean };
  recognitionSetupRequired?: boolean;
  recognitionSetupBusy?: boolean;
  recognitionSetupError?: string;
  recognitionSetupErrorDetail?: VoiceErrorDetail;
  /** Host（App）版本读取状态（§6.0 ⑨）；只在 Voice 页可见时读。 */
  hostVersion?: import("./voice-diagnostics").VoiceHostVersion;
  /**
   * 首次 Host 状态读取阶段。loading 只画中性的「检查中」；failed 只画一次真实失败，
   * 不能把空模型/音源占位值提前解释成两个橙色故障。
   */
  statusLoad: "loading" | "loaded" | "failed";
  statusLoadError?: string;
  statusLoadErrorDetail?: VoiceErrorDetail;
  /**
   * Host 回带的单次录音上限（秒）。缺席 = 旧 Host（固定 120 秒）：设置页「单次录音最长时间」
   * 置灰并提示更新。
   */
  captureLimitSeconds?: number;
  /**
   * Host 按键会话切片口径（`voice.status` 的 `captureModel`）。`"span-markers-v1"` 时片段增强停用；
   * 旧 Host 不返回，保持缺席。
   */
  captureModel?: string;
  /**
   * 已结束录音、还在后台收尾（识别 / 润色 / 写回）的 `asyncFinish` 段数（胶囊叠放）。
   * 旧 Host 不会出现收尾段，恒为缺席。
   */
  finalizingCount?: number;
  phase: "idle" | "listening" | "recognizing";
  sessionId?: string;
  settings: VoiceInputSettings;
  featureSettings: VoiceFeatureSettings;
  cloudModels: CloudModelOption[];
  cloudModelsLoading?: boolean;
  /** 已有列表时的后台重读：只在列表旁转圈，不禁用、不换占位。 */
  cloudModelsRefreshing?: boolean;
  cloudModelsUnavailable?: boolean;
  /** 本轮自动重试已用完（停止自动重读，等可见或手动重试）。 */
  cloudModelsRetryExhausted?: boolean;
  /** 最近一次读取失败的稳定码（只用于选人话文案与恢复动作，不上屏）。 */
  cloudModelsFailureCode?: string;
  cloudModelsErrorDetail?: VoiceErrorDetail;
  /** F02/F04：按对话保存的 Agent / 工作目录选择（不改全局默认）。 */
  conversationOptions?: Record<string, VoiceConversationOptions>;
  /** F03：本插件会话的越界审批状态；批准入口在 Host 主窗口，这里只显示等待。 */
  agentApprovals?: AgentApprovalSummary[];
  /** 进行中的命令回合正在等你拍板的事（Host `wait.started` / `wait.ended`）；回合结束即清掉。 */
  agentWaits?: VoiceAgentUserWait[];
  history: VoiceHistoryItem[];
  inputRetries?: Record<string, SavedInputRetryPhase>;
  /**
   * 重新转写的尝试身份与起点（方案 2.3）：attemptId 由重试控制器传入，准备阶段没有
   * attemptId 时用操作序号；计时只认身份匹配的回执时间。
   */
  inputRetryAttempts?: Record<string, { phase: SavedInputRetryPhase; attemptId?: string; opSeq: number; sinceMs: number }>;
  models: VoiceModelInfo[];
  localDownloads?: Record<string, import("./local-model-download").LocalDownloadState>;
  permissions: VoicePermissionInfo;
  activeMode: "input" | "command" | undefined;
  commandPhase: "idle" | "preparing" | "listening" | "recognizing" | "processing";
  /**
   * 命令详情页输入坞的定向听写（R8：麦克风 = 本插件语音输入，结果只落当前输入框）。
   * **专属字段、不复用 `commandPhase`**：硬件语音键入口拿 `commandPhase === "listening"`
   * 判「这次按键是来收工的」，听写若借用那个字段就会被硬件键当命令收走。
   */
  dictationPhase: "idle" | "listening" | "recognizing";
  commandConfigured: boolean;
  commandLoggedIn: boolean;
  commandHistory: VoiceCommandHistoryItem[];
  sourceReady?: boolean;
  sourceIssue?: VoiceSourceIssue | null;
  boardFirmwareVersion?: string | null;
  minimumBoardFirmwareVersion?: string;
  timeline?: AudioTimelineStatus;
  /** 全天存档开关已点下、Host 还没确认的目标值；设置页按它显示开关，确认或失败后清掉。 */
  continuousRecordingPending?: boolean;
  systemInputs: SystemInputEndpoint[];
  recordings: VoiceRecordingSegment[];
  recordingsTotal: number;
  /** Context 档「加载更早的记录」进行中；只管按钮的忙态。 */
  recordingsLoadingMore?: boolean;
  /**
   * 润色上下文的宿主事实快照。
   *
   * 设置页的徽标只画**查得到的真事**：`undefined` 表示还没探到，界面就什么都不说，
   * 而不是先画一个「已授权」的绿色再等它被打脸（口径与「状态」行一致）。
   */
  contextProbe?: VoiceContextProbe;
  /**
   * 写回权限被拒过，润色已让位给「原样注入」。
   *
   * 润色档下由插件负责把文字写进目标应用，而 `voice.deliver@1` 是用户可以拒的可选
   * 权限。拒过之后如果还按润色档走，就是每说一句丢一句——所以退回原样注入，并把
   * 原因摆到设置页上，而不是让用户自己去猜为什么润色不生效了。
   */
  deliveryPermissionBlocked?: boolean;
  /**
  /**
   * 缺陷3：正在重新入队 / 已重新排队本地转写的 Context 分片 id。
   * `running` = 请求在途（按钮防连点）；`queued` = Host 已受理，本地引擎
   * 后台消化中（空态里给一句说明）。分片拿到转写文本后空态自然消失。
   */
  retranscribingSegments?: Record<string, "running" | "queued">;
  /** 「录音缓存」现状：保留时长四档 + 占用 + 保留下沿。未读到之前为 undefined。 */
  replayCache?: VoiceReplayCacheStatus;
  /**
   * C-3b：三条命令事件里，哪几条被用户挂到了 Action 层（commandId 列表）。
   *
   * 真源在 Host（挂载清单是持久化的），这里只是渲染勾选态用的镜像。
   */
  mountedActionCommandIds: string[];
  /**
   * 触发事件管理页每行「当前绑着它的键：chips」的数据（commandId → 绑定源标签列表，
   * 如「语音」「CHAT + 语音」「长按 语音」）。
   *
   * 真源在 Host 的键位绑定表，而插件桥**还没有**读它的方法（稿回稿 ①），所以现在
   * 没人填它：undefined = 整行不画，不编一个「还没有键绑它」骗人。Host 补出桥方法后
   * 在 refresh 里填上即可，视图不用动。空数组 = 真的没键绑它。
   */
  commandKeyBindings?: Record<string, string[]>;
  /**
   * R18：按天存的总结，dayKey → 一份。自动生成（见 voice-digest-scheduler.ts），
   * 持久化在私有 KV；Context 档按天分组时把对应那天的一份渲染成分组里普通一行。
   */
  dayDigests: Record<string, VoiceDayDigest>;
  /** 正在合成哪一天的总结（dayKey）。真实的云端往返，期间「重新总结」要如实禁用。 */
  dayDigestGenerating?: string;
  /** 这一轮当日总结开始合成的时刻（ms）：等待态的「已用时间」从这里算。 */
  dayDigestGeneratingSinceMs?: number;
  /** 当日总结每一天最近一次失败（含自动刷新），按 dayKey 分开存；那天成功后清掉那一天。 */
  dayDigestFailures?: Record<string, VoiceErrorDetail>;
  /**
   * R11：正在生成总结的那一段的录音 id。一次只跑一段（同会话串行由 Host 保证，
   * 插件侧不给第二个入口）；界面据此把「生成 / 重新总结」按钮换成「总结中…」。
   */
  segmentSummarizing?: string;
  /**
   * A3-24 门控数据：Agents·IM（ni.chat）装没装。true = 装了且启用，页头才渲染
   * 「发给 agent」；false / undefined（还没探到）都不渲染——稿子的口径是「没装
   * 就该不存在，而不是灰着让人点」。真源是 Host 注册表（`apps.status`），在
   * refresh 时点采样；Host 没有插件可订阅的装卸事件，采样间隔是诚实边界。
   */
  agentsImAvailable?: boolean;
  /** 独立的中性迁移提示；不能借用红色 error 通道。 */
  notice?: string;
  error?: string;
  /** `error` 对应的诊断；publish 给了 error 却没给 errorDetail 时自动清空，防旧诊断挂到新错误上。 */
  errorDetail?: VoiceErrorDetail;
  /**
   * 本次运行里历史条目的失败原文（`command:<id>` / `polish:<id>` / `deliver:<id>`），有上限。
   * 只在内存：不落盘、不复制、不进浮层，只供插件界面里用户主动展开（§6.0 白名单）。
   */
  failureRaw?: Readonly<Record<string, string>>;
}

export interface VoiceContextProbe {
  /** 用户是否已在权限页授予 `voice.context@1`。未授予时窗口上下文这一档采不到东西。 */
  granted: boolean;
  /** 宿主屏幕录制权限的只读状态。 */
  screenRecording: "granted" | "denied";
}

/** Host 回带的单次上限（秒）；缺席或非法 = 旧 Host，不支持调整。 */
export function validCaptureLimitSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function voiceSourceStatusPatch(
  status: VoiceInputStatus,
): Pick<
  VoiceViewState,
  "sourceReady" | "sourceIssue" | "boardFirmwareVersion" | "minimumBoardFirmwareVersion"
  | "timeline" | "captureLimitSeconds" | "captureModel"
> {
  return {
    // 只认 Host 明确回带的值：带 sessionId 的状态读数缺这一项时不把已知口径清掉。
    ...(typeof status.captureModel === "string" ? { captureModel: status.captureModel } : {}),
    sourceReady: status.sourceReady,
    sourceIssue: status.sourceIssue,
    boardFirmwareVersion: status.boardFirmwareVersion,
    minimumBoardFirmwareVersion: status.minimumBoardFirmwareVersion,
    timeline: status.timeline,
    captureLimitSeconds: validCaptureLimitSeconds(status.captureLimitSeconds),
  };
}

function locallyListening(state: VoiceViewState): boolean {
  return (
    state.phase === "listening" ||
    state.commandPhase === "listening" ||
    state.dictationPhase === "listening"
  );
}

export function shouldPollVoiceStatus(state: VoiceViewState): boolean {
  // Device readiness does not imply an active timeline lease. Keep reconciling
  // Board status while idle too: startup, unplug and lease loss are independent
  // of an explicit Voice capture and do not emit a plugin status event.
  return locallyListening(state) || state.settings.source === "board";
}

/** Avoid rebuilding a focused editor once a second merely because buffer time grows. */
export function voiceAvailabilityChanged(state: VoiceViewState, status: VoiceInputStatus): boolean {
  const key = (value: Pick<VoiceViewState, "sourceReady" | "sourceIssue" | "boardFirmwareVersion" | "minimumBoardFirmwareVersion" | "timeline">) => {
    const timeline = value.timeline;
    return JSON.stringify([value.sourceReady, value.sourceIssue, value.boardFirmwareVersion,
      value.minimumBoardFirmwareVersion, timeline?.state, timeline?.unavailableReason,
      timeline?.route, timeline?.cacheHealth, timeline?.continuousRecordingEnabled, timeline?.recordingState]);
  };
  return key(state) !== key(voiceSourceStatusPatch(status));
}

export function reconcileAuthoritativeVoiceStatus(
  current: VoiceViewState,
  status: VoiceInputStatus,
  expectedSessionId: string | undefined,
): Partial<VoiceViewState> | undefined {
  if (
    !locallyListening(current) ||
    status.phase !== "idle" ||
    current.sessionId !== expectedSessionId ||
    status.sessionId !== expectedSessionId
  ) {
    return undefined;
  }
  return {
    statusLoad: "loaded",
    phase: "idle",
    commandPhase: "idle",
    dictationPhase: "idle",
    activeMode: undefined,
    sessionId: undefined,
    get error() { return status.stopReason === "capture_limit"
        ? t("data.message1")
        : status.stopReason === "source_unavailable"
          ? t("data.message2")
          : status.stopReason === "user_cancel"
            ? undefined
            : t("data.message3"); },
  };
}

/** 近期语音上下文允许的时间范围（分钟）。与设计稿的三档一一对应。 */
export const CONTEXT_RANGE_MINUTES = [1, 5, 10] as const;
export const DEFAULT_CONTEXT_RANGE_MINUTES = 5;

/** 单次录音最长时间（分钟）。Host 1.0.6 起可调，旧 Host 固定 120 秒。 */
export const MIN_RECORDING_MINUTES = 1;
export const MAX_RECORDING_MINUTES = 10;
/** 旧 Host 不回 `captureLimitSeconds` 时的固定上限（秒）。 */
export const LEGACY_CAPTURE_LIMIT_SECONDS = 120;

export function sanitizeMaxRecordingMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAX_RECORDING_MINUTES;
  return Math.max(MIN_RECORDING_MINUTES, Math.min(MAX_RECORDING_MINUTES, Math.round(value)));
}

export const DEFAULT_SETTINGS: VoiceInputSettings = {
  source: "board",
  modelId: DEFAULT_MODEL_ID,
  language: "auto",
  vadEnabled: true,
  maxRecordingMinutes: MAX_RECORDING_MINUTES,
  punctEnabled: true,
  engine: "local",
  // 2026-09-27 Voice 链路解耦定稿（取代 DEV-16 的「默认原样」）：润色默认开启轻度，
  // 只作用于语音输入法（含「转文本」命令），翻译与 Agent 不润色。存量 `raw` 由
  // `POLISH_LIGHT_DEFAULT_MIGRATION_KEY` 一次性迁到轻度；迁移之后用户再选原样照常保留。
  polish: "light",
  polishContext: {
    window: false,
    recentVoice: true,
    recentVoiceRangeMinutes: DEFAULT_CONTEXT_RANGE_MINUTES,
  },
};

export const EMPTY_PERMISSIONS: VoicePermissionInfo = {
  microphone: "not_determined",
  accessibility: "not_determined",
};

export function createDefaultVoiceViewState(
  overrides: Partial<VoiceViewState> = {},
): VoiceViewState {
  return {
    developerMode: false,
    statusLoad: "loaded",
    phase: "idle",
    settings: { ...DEFAULT_SETTINGS },
    featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS },
    cloudModels: [],
    history: [],
    models: [],
    // 这个 helper 只给测试/演示 fixture 用：默认是一条可用链路。真正的 App 首帧
    // 仍从 EMPTY_PERMISSIONS + statusLoad=loading 起步，等 Host 回报后再展示权限结论。
    permissions: { microphone: "granted", accessibility: "granted" },
    activeMode: undefined,
    commandPhase: "idle",
    dictationPhase: "idle",
    commandConfigured: true,
    commandLoggedIn: true,
    commandHistory: [],
    systemInputs: [],
    recordings: [],
    recordingsTotal: 0,
    mountedActionCommandIds: [],
    screenshotConsent: { enabled: false },
    dayDigests: {},
    ...overrides,
  };
}

interface StoredVoiceState {
  recognitionSetupPending: boolean;
  recognitionEngineChoice?: "local" | "cloud";
  settings?: VoiceInputSettings;
  featureSettings: VoiceFeatureSettings;
  history?: VoiceHistoryItem[];
  commandHistory?: VoiceCommandHistoryItem[];
  dayDigests: Record<string, VoiceDayDigest>;
  dayDigestAttempts: Record<string, number>;
  conversationOptions: Record<string, VoiceConversationOptions>;
  commandAgentSessionLedger: CommandAgentSessionLedgerItem[];
  legacySourceMigration: boolean;
  boardSourceMigrationPending: boolean;
  sourceMigrationNotice?: string;
}

export class VoiceStateRepository {
  /** Clearing invalidates in-flight recovery pages before they can restore rows. */
  private inputHistoryEpoch = 0;
  get historyGeneration(): number { return this.inputHistoryEpoch; }
  private inputHistoryWriteQueue: Promise<void> = Promise.resolve();
  private commandHistoryWriteQueue: Promise<void> = Promise.resolve();
  /** A terminal CAS can complete after deactivate claims interruption. Only that stale write may be replaced. */
  private readonly terminalWritesAfterAbort = new Set<string>();
  private commandAgentLedgerWriteQueue: Promise<void> = Promise.resolve();
  private dayDigestAttemptsWriteQueue: Promise<void> = Promise.resolve();
  private conversationOptionsWriteQueue: Promise<void> = Promise.resolve();
  /** 润色默认档迁移标记已落（见 `POLISH_LIGHT_DEFAULT_MIGRATION_KEY`）。 */
  private polishDefaultMarked = false;

  constructor(private readonly store: KeyValueStore) {}

  private withCommandHistoryWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.commandHistoryWriteQueue.then(write, write);
    this.commandHistoryWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Multiple Surface owners can write the same KV key. Retry against the complete raw value. */
  private editCommandHistory<T>(
    edit: (current: VoiceCommandHistoryItem[]) => {
      next?: VoiceCommandHistoryItem[];
      result: T;
      afterCommit?: () => T;
    },
  ): Promise<T> {
    return this.withCommandHistoryWrite(async () => {
      for (let attempt = 0; attempt < 32; attempt++) {
        const raw = await this.store.get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
        const change = edit(sanitizeCommandHistory(raw));
        if (!change.next) return change.result;
        if (await this.store.compareAndSet(COMMAND_HISTORY_KEY, raw, change.next)) {
          return change.afterCommit?.() ?? change.result;
        }
      }
      throw new Error("command history concurrent update limit");
    });
  }

  private withCommandAgentLedgerWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.commandAgentLedgerWriteQueue.then(write, write);
    this.commandAgentLedgerWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private withDayDigestAttemptsWrite<T>(write: () => Promise<T>): Promise<T> {
    const result = this.dayDigestAttemptsWriteQueue.then(write, write);
    this.dayDigestAttemptsWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async load(): Promise<StoredVoiceState> {
    const recognitionChoice = await this.store.get<string>("recognition-engine-choice-v1");
    const settings = await this.store.get<VoiceInputSettings>("settings");
    // Persist the pending choice before migrations or another setting can write
    // defaults. A restart or failed save must not silently skip first setup.
    const recognitionSetupPending = recognitionChoice === "pending"
      || (recognitionChoice === undefined && settings === undefined);
    if (recognitionSetupPending && recognitionChoice !== "pending") {
      await this.store.set("recognition-engine-choice-v1", "pending");
    }
    const featureSettings = await this.store.get<VoiceFeatureSettings>(VOICE_FEATURE_SETTINGS_KEY);
    const history = await this.store.get<VoiceHistoryItem[]>("history");
    const commandHistory = await this.store.get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    const sourceMigrationVersion = await this.store.get<number>(SOURCE_MIGRATION_KEY);
    const sourceSelectionVersion = await this.store.get<number>(SOURCE_SELECTION_KEY);
    const sourceSelectionPending = await this.store.get<number>(SOURCE_SELECTION_PENDING_KEY);
    const sourceMigrationNotice = await this.store.get<string>(SOURCE_MIGRATION_NOTICE_KEY);
    const dayDigests = await this.store.get<Record<string, VoiceDayDigest>>(DAY_DIGESTS_KEY);
    const dayDigestAttempts = await this.store.get<Record<string, number>>(DAY_DIGEST_ATTEMPTS_KEY);
    const storedLedger = sanitizeCommandAgentSessionLedger(
      await this.store.get<CommandAgentSessionLedgerItem[]>(COMMAND_AGENT_SESSION_LEDGER_KEY),
    );
    const ledgerById = new Map(storedLedger.map((item) => [item.sessionId, item]));
    for (const item of sanitizeCommandHistory(commandHistory)) {
      if (!item.agentSessionId || ledgerById.has(item.agentSessionId)) continue;
      ledgerById.set(item.agentSessionId, {
        sessionId: item.agentSessionId,
        createdMs: new Date(item.createdAt).getTime(),
      });
    }
    const commandAgentSessionLedger = sanitizeCommandAgentSessionLedger([...ledgerById.values()]);
    if (JSON.stringify(commandAgentSessionLedger) !== JSON.stringify(storedLedger)) {
      await this.store.set(COMMAND_AGENT_SESSION_LEDGER_KEY, commandAgentSessionLedger);
    }
    let sanitizedSettings = sanitizeSettings(settings);
    this.polishDefaultMarked = await this.store.get<number>(POLISH_LIGHT_DEFAULT_MIGRATION_KEY) === 1;
    if (!this.polishDefaultMarked) {
      // 润色默认档一次性迁移：先写 settings、最后落标记。尽力而为——写失败不拦激活，
      // 本次按轻度运行，标记没落下次激活继续迁。没存过设置的新用户直接落标记
      // （默认已是轻度），之后显式选原样不再被改。
      const migrate = settings !== undefined && sanitizedSettings.polish === "raw";
      if (migrate) sanitizedSettings = { ...sanitizedSettings, polish: "light" };
      try {
        if (migrate) await this.store.set("settings", sanitizedSettings);
        await this.store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        this.polishDefaultMarked = true;
      } catch {
        // 下次激活重试；期间用户显式保存设置时由 saveSettings 补落标记。
      }
    }
    const boardSourceMigrationPending = settings !== undefined
      && sourceSelectionVersion !== SOURCE_SELECTION_VERSION
      && (sourceSelectionPending === 1 || sanitizedSettings.source === "system");
    const legacySourceMigration = settings !== undefined && sourceMigrationVersion !== 1 && !boardSourceMigrationPending;
    const { audioSourcePreference: _legacyPreference, ...legacySettings } = sanitizedSettings;
    const effectiveSettings = boardSourceMigrationPending
      ? boardSettingsWithoutSystemEndpoint(sanitizedSettings)
      : legacySourceMigration ? legacySettings : sanitizedSettings;
    return {
      recognitionEngineChoice: recognitionChoice === "local" || recognitionChoice === "cloud" ? recognitionChoice : undefined,
      recognitionSetupPending,
      settings: effectiveSettings,
      featureSettings: sanitizeVoiceFeatureSettings(featureSettings),
      history: sanitizeHistory(history),
      commandHistory: sanitizeCommandHistory(commandHistory),
      dayDigests: sanitizeDayDigests(dayDigests),
      dayDigestAttempts: sanitizeDayDigestAttempts(dayDigestAttempts),
      conversationOptions: sanitizeConversationOptions(await this.store.get(CONVERSATION_OPTIONS_KEY)),
      commandAgentSessionLedger,
      // v2 的产品裁定优先；同一轮绝不能再让 v1 legacy hint 保留旧 SystemDevice。
      legacySourceMigration,
      boardSourceMigrationPending,
      ...(sourceMigrationNotice === SOURCE_MIGRATION_NOTICE
        ? { sourceMigrationNotice }
        : {}),
    };
  }

  /** 对话级选择串行写：迟到的保存不能覆盖别的对话。返回整表。 */
  async saveConversationOptions(key: string, options: VoiceConversationOptions): Promise<Record<string, VoiceConversationOptions>> {
    const operation = this.conversationOptionsWriteQueue.then(async () => {
      const current = sanitizeConversationOptions(await this.store.get(CONVERSATION_OPTIONS_KEY));
      const next = sanitizeConversationOptions({ [key]: options, ...Object.fromEntries(Object.entries(current).filter(([id]) => id !== key)) });
      await this.store.set(CONVERSATION_OPTIONS_KEY, next);
      return next;
    });
    this.conversationOptionsWriteQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** 整表覆盖写（一天一份、最多十几天，体积远在 KV 上限之下）。 */
  async saveDayDigests(digests: Record<string, VoiceDayDigest>): Promise<void> {
    await this.store.set(DAY_DIGESTS_KEY, sanitizeDayDigests(digests));
  }

  /** 自动失败退避整表串行写，避免并发成功/失败用旧快照互相覆盖。 */
  async saveDayDigestAttempts(attempts: Record<string, number>): Promise<void> {
    await this.withDayDigestAttemptsWrite(async () => {
      await this.store.set(
        DAY_DIGEST_ATTEMPTS_KEY,
        sanitizeDayDigestAttempts(attempts),
      );
    });
  }

  /** 用户主动清空语音记录：输入历史与基于全天记录生成的总结一起失效。 */
  async clearVoiceRecords(): Promise<void> {
    this.inputHistoryEpoch++;
    await this.writeInputHistory(() => []);
    await this.store.set(DAY_DIGESTS_KEY, {});
    await this.store.set(DAY_DIGEST_ATTEMPTS_KEY, {});
  }

  /** 命令详情展示整段对话：一并清掉其未读点；找不到入口条目就原样返回。 */
  async markCommandRead(id: string): Promise<VoiceCommandHistoryItem[]> {
    return this.editCommandHistory((current) => {
      const opened = current.find((entry) => entry.id === id);
      if (!opened) return { result: current };
      const key = conversationKey(opened);
      if (!current.some((entry) => conversationKey(entry) === key && entry.unread === true)) return { result: current };
      const next = current.map((entry) => {
        if (conversationKey(entry) !== key) return entry;
        const { unread: _unread, ...rest } = entry;
        return rest;
      });
      return { next, result: next };
    });
  }

  async completeSourceMigration(settings?: VoiceInputSettings): Promise<void> {
    if (settings) {
      const { audioSourcePreference: _legacyPreference, ...legacySettings } = settings;
      await this.saveSettings(legacySettings);
    }
    await this.store.set(SOURCE_MIGRATION_KEY, 1);
  }

  /** 先落 journal，再配置 Host；中途任一步失败都能在下一次激活继续。 */
  async beginBoardSourceMigration(): Promise<void> {
    await this.store.set(SOURCE_SELECTION_PENDING_KEY, 1);
  }

  /**
   * Board-first v2 迁移的提交尾声。
   *
   * 完成 marker 最后写；它之前的 settings、v1 marker 与提示任一步失败时，pending
   * journal 都还在，下次启动会继续以 Board 配置 Host，不会把半提交当成功。
   */
  async completeBoardSourceMigration(settings: VoiceInputSettings): Promise<void> {
    const boardSettings = boardSettingsWithoutSystemEndpoint(settings);
    // 走 saveSettings：settings 的每个写者都顺带终结润色默认档迁移的歧义（见 saveSettings）。
    await this.saveSettings(boardSettings);
    await this.store.set(SOURCE_MIGRATION_KEY, 1);
    await this.store.set(SOURCE_MIGRATION_NOTICE_KEY, SOURCE_MIGRATION_NOTICE);
    await this.store.set(SOURCE_SELECTION_KEY, SOURCE_SELECTION_VERSION);
    await this.store.delete(SOURCE_SELECTION_PENDING_KEY);
  }

  /**
   * Host 已接受一次用户在五档里的显式选择：v1 / v2 两代旧来源迁移都不再适用，
   * 以后激活不能再剥掉档位或重放旧迁移把它 pin 回别处。journal 先删，marker 后写。
   */
  async confirmAudioSourceMode(): Promise<void> {
    await this.store.delete(SOURCE_SELECTION_PENDING_KEY);
    await this.store.set(SOURCE_MIGRATION_KEY, 1);
    await this.store.set(SOURCE_SELECTION_KEY, SOURCE_SELECTION_VERSION);
  }

  /** Host 已成功接受一次用户主动的 source 变化后，记录“以后尊重此选择”。 */
  async confirmSourceSelection(): Promise<void> {
    // 明确选择是 journal 的人工出口：旧迁移若中断过，不能让残留 pending 在下次
    // 启动重新压过用户刚选的 system endpoint。先删 journal，marker 最后提交。
    await this.store.delete(SOURCE_SELECTION_PENDING_KEY);
    await this.store.set(SOURCE_SELECTION_KEY, SOURCE_SELECTION_VERSION);
  }

  async acknowledgeSourceMigrationNotice(): Promise<void> {
    await this.store.delete(SOURCE_MIGRATION_NOTICE_KEY);
  }

  async appendCommandHistory(item: VoiceCommandHistoryItem): Promise<VoiceCommandHistoryItem[]> {
    return this.editCommandHistory((current) => {
      // 刚落下的结果没人看过：未读点亮着，进一次命令详情才清（markCommandRead）。
      const next = trimHistoryToStoreLimit(
        sanitizeCommandHistory([
          { ...item, unread: true },
          ...current.filter((entry) => entry.id !== item.id),
        ]),
      );
      return { next, result: next };
    });
  }

  /** Agent 请求之前先落 running。写失败时调用方不得启动请求。 */
  async beginCommandHistory(item: VoiceCommandHistoryItem): Promise<VoiceCommandHistoryItem[]> {
    if (item.status !== "running") throw new Error("command journal requires running status");
    return this.editCommandHistory((current) => {
      if (current.some((entry) => entry.id === item.id)) throw new Error("command taskId already exists");
      const next = trimHistoryToStoreLimit(sanitizeCommandHistory([
        item, ...current,
      ]));
      if (!next.some((entry) => entry.id === item.id && entry.status === "running")) {
        throw new Error("command journal exceeds history storage limit");
      }
      if (current.some((entry) => entry.status === "running" && !next.some((kept) => kept.id === entry.id))) {
        throw new Error("command journal would evict a running task");
      }
      return { next, result: next };
    });
  }

  async markUnconfirmedAgentAdmissions(keys: string[]): Promise<void> {
    const pending = new Set(keys);
    await this.editCommandHistory((current) => ({ next: current.map(item =>
      pending.has(item.agentRequestKey ?? item.id) && item.status === "failed"
        ? { ...item, errorCode: "AGENT_RECEIPT_UNKNOWN", agentRequestKey: item.agentRequestKey ?? item.id }
        : item), result: undefined }));
  }

  /** 新建会话的引用必须先落盘，再把该会话发给 Host 执行回合。 */
  async attachCommandAgentSession(taskId: string, sessionId: string): Promise<VoiceCommandHistoryItem[]> {
    return this.editCommandHistory((current) => {
      const target = current.find((entry) => entry.id === taskId);
      if (!target || target.status !== "running") throw new Error("command task is no longer running");
      const next = current.map((entry) => entry.id === taskId
        ? { ...entry, agentSessionId: sessionId }
        : entry);
      return { next, result: next };
    });
  }

  /** An accepted durable turn outlives its Surface; save its actual Host identity. */
  async attachCommandAgentTurn(taskId: string, sessionId: string, turnId: string): Promise<void> {
    await this.editCommandHistory((current) => {
      const target = current.find(entry => entry.id === taskId);
      if (!target || target.status !== "running" || target.agentSessionId !== sessionId) {
        throw new Error("accepted turn no longer belongs to a running command");
      }
      if (target.runId && target.runId !== turnId) throw new Error("accepted turn identity changed");
      return { next: current.map(entry => entry.id === taskId ? { ...entry, runId: turnId } : entry), result: undefined };
    });
  }

  /** 同一个 taskId 只能从 running 进入一个终态；晚到回调不能覆盖先落下的终态。 */
  async settleCommandHistory(
    item: VoiceCommandHistoryItem,
    maySettle: () => boolean = () => true,
  ): Promise<{
    history: VoiceCommandHistoryItem[];
    applied: boolean;
  }> {
    if (item.status === "running") throw new Error("command settlement requires terminal status");
    return this.editCommandHistory<{ history: VoiceCommandHistoryItem[]; applied: boolean }>((current) => {
      const target = current.find((entry) => entry.id === item.id);
      // The old owner may finish a CAS after deactivate claimed interruption.
      // Let only that identified late write be replaced by the queued interruption.
      const replaceLateWrite = item.errorCode === "VOICE_COMMAND_INTERRUPTED"
        && this.terminalWritesAfterAbort.has(item.id);
      if (!target || (target.status !== "running" && !replaceLateWrite)) {
        return { result: { history: current, applied: false } };
      }
      const next = trimHistoryToStoreLimit(sanitizeCommandHistory([
        // 录音片段在 running 落账时就已登记；终态结算（成功 / 失败 / 中断）沿用它。
        { ...sanitizeRecordingRef(target), ...item,
          agentSessionId: item.agentSessionId ?? target.agentSessionId, runId: item.runId ?? target.runId,
          // F04：可见对话身份跟着条目走；恢复 / 重试的结算不能把它拆出原对话。
          ...(item.conversationId ?? target.conversationId ? { conversationId: item.conversationId ?? target.conversationId } : {}),
          unread: true },
        ...current.filter((entry) => entry.id !== item.id),
      ]));
      if (current.some((entry) => entry.id !== item.id && entry.status === "running"
        && !next.some((kept) => kept.id === entry.id))) {
        throw new Error("command settlement would evict a running task");
      }
      // 等待 KV 读取期间可能已发生外部中止；写入前重新核对内存终态认领。
      if (!maySettle()) return { result: { history: current, applied: false } };
      return {
        next,
        result: { history: next, applied: true },
        afterCommit: () => {
          if (replaceLateWrite) this.terminalWritesAfterAbort.delete(item.id);
          // CAS 是异步的；中止可能发生在上面的检查之后、真正提交之前。
          // 此时不向 UI 发布过期成功，并让同 owner 排队的中断结算替换这次晚写。
          if (!maySettle()) {
            this.terminalWritesAfterAbort.add(item.id);
            return { history: next, applied: false };
          }
          return { history: next, applied: true };
        },
      };
    });
  }

  /** A successful owner listing no longer grants access to these task results. */
  async recoverUnavailableAgentResults(taskIds: ReadonlySet<string>): Promise<void> {
    if (!taskIds.size) return;
    await this.editCommandHistory(current => {
      const next = current.map(entry => {
        if (entry.status !== "running" || !taskIds.has(entry.id)) return entry;
        const { messages: _messages, ...saved } = entry;
        return { ...saved, status: "failed" as const, errorCode: "AGENT_RESULT_UNAVAILABLE",
          userMessage: t("chat.taskResultUnavailable"), unread: true };
      });
      return { next: trimHistoryToStoreLimit(sanitizeCommandHistory(next)), result: undefined };
    });
  }

  /** 只在新 owner 激活时调用：生产 Surface 关闭不保证 deactivate。 */
  async recoverInterruptedCommandHistory(
    liveTaskIds: ReadonlySet<string> = new Set(),
  ): Promise<VoiceCommandHistoryItem[]> {
    return this.editCommandHistory((current) => {
      if (!current.some((entry) => entry.status === "running" && !liveTaskIds.has(entry.id))) {
        return { result: current };
      }
      // 恢复只能改状态、不能为了放下诊断字段而删掉任何一条记录（按 KV 整表预算裁剪时会从尾部删）。
      // 依次尝试：完整（中断文案 + 发现时刻）→ 只留码与未读 → 只改状态；取第一个能全部保留的。
      const recover = (level: 0 | 1 | 2) => current.map((entry) => {
        if (entry.status !== "running" || liveTaskIds.has(entry.id)) return entry;
        // 详情页能从 transcript / userMessage 重建两条消息。不要在恢复时再复制一份 transcript。
        const { messages: _messages, ...withoutMessages } = entry;
        if (level === 2) return { ...withoutMessages, status: "failed" as const };
        return {
          ...withoutMessages,
          status: "failed" as const,
          errorCode: "VOICE_COMMAND_INTERRUPTED",
          unread: true,
          ...(level === 0 ? {
            userMessage: interruptedLabel(entry.commandId),
            // 重新激活时才发现：不知道真实失败时刻，只记发现时刻（诊断标「发现中断时间」）。
            failureDetectedAt: new Date().toISOString(),
          } : {}),
        };
      });
      const baseline = trimHistoryToStoreLimit(sanitizeCommandHistory(current)).length;
      let bounded: VoiceCommandHistoryItem[] = [];
      for (const level of [0, 1, 2] as const) {
        bounded = trimHistoryToStoreLimit(sanitizeCommandHistory(recover(level)));
        if (bounded.length >= baseline) break;
      }
      return { next: bounded, result: bounded };
    });
  }

  async registerCommandAgentSession(
    sessionId: string,
    createdMs = Date.now(),
  ): Promise<CommandAgentSessionLedgerItem[]> {
    return this.withCommandAgentLedgerWrite(async () => {
      const current = sanitizeCommandAgentSessionLedger(
        await this.store.get<CommandAgentSessionLedgerItem[]>(COMMAND_AGENT_SESSION_LEDGER_KEY),
      );
      const next = sanitizeCommandAgentSessionLedger([
        { sessionId, createdMs },
        ...current.filter((item) => item.sessionId !== sessionId),
      ]);
      await this.store.set(COMMAND_AGENT_SESSION_LEDGER_KEY, next);
      return next;
    });
  }

  async removeCommandAgentSession(
    sessionId: string,
  ): Promise<CommandAgentSessionLedgerItem[]> {
    return this.withCommandAgentLedgerWrite(async () => {
      const current = sanitizeCommandAgentSessionLedger(
        await this.store.get<CommandAgentSessionLedgerItem[]>(COMMAND_AGENT_SESSION_LEDGER_KEY),
      );
      const next = current.filter((item) => item.sessionId !== sessionId);
      if (next.length !== current.length) {
        await this.store.set(COMMAND_AGENT_SESSION_LEDGER_KEY, next);
      }
      return next;
    });
  }

  async saveSettings(settings: VoiceInputSettings): Promise<void> {
    await this.store.set("settings", sanitizeSettings(settings));
    // 用户显式保存过的档位（含选回「原样」）一律不再迁：迁移标记若因写失败没落，
    // 这里补落，免得下次激活把刚选的原样又改回轻度。补落失败不影响本次保存。
    if (!this.polishDefaultMarked) {
      try {
        await this.store.set(POLISH_LIGHT_DEFAULT_MIGRATION_KEY, 1);
        this.polishDefaultMarked = true;
      } catch {
        // 下次保存或激活再试。
      }
    }
  }

  async confirmRecognitionEngine(engine: "local" | "cloud"): Promise<void> {
    await this.store.set("recognition-engine-choice-v1", engine);
  }

  async saveFeatureSettings(settings: VoiceFeatureSettings): Promise<void> {
    await this.store.set(VOICE_FEATURE_SETTINGS_KEY, sanitizeVoiceFeatureSettings(settings));
  }


  private writeInputHistory(change: (items: VoiceHistoryItem[]) => VoiceHistoryItem[]): Promise<VoiceHistoryItem[]> {
    const write = async () => {
      const current = sanitizeHistory(await this.store.get<VoiceHistoryItem[]>("history"));
      const next = sanitizeHistory(change(current));
      await this.store.set("history", next);
      return next;
    };
    const result = this.inputHistoryWriteQueue.then(write, write);
    this.inputHistoryWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async appendHistory(item: VoiceHistoryItem): Promise<VoiceHistoryItem[]> {
    const incoming = sanitizeHistory([item])[0];
    return this.writeInputHistory(current => !incoming ? current : [incoming, ...current.filter(entry => entry.id !== incoming.id
      && (!incoming.recordingId || entry.recordingId !== incoming.recordingId))]);
  }

  async restoreHistoryItem(item: VoiceHistoryItem, generation: number): Promise<VoiceHistoryItem[]> {
    return this.writeInputHistory(current => generation !== this.inputHistoryEpoch
      || current.some(entry => entry.recordingId === item.recordingId)
      ? current : [item, ...current]);
  }

  /** A late retry may update an existing row only; clearing history cannot resurrect it. */
  async updateHistoryItem(id: string, change: (item: VoiceHistoryItem) => VoiceHistoryItem): Promise<VoiceHistoryItem[]> {
    return this.writeInputHistory(current => current.map(item => item.id === id ? change(item) : item));
  }

}

export const CONVERSATION_OPTIONS_KEY = "command-conversation-options-v1";

function sanitizeConversationOptions(value: unknown): Record<string, VoiceConversationOptions> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, VoiceConversationOptions> = Object.create(null);
  let bytes = 2;
  for (const [key, raw] of Object.entries(value).slice(0, MAX_HISTORY_ITEMS)) {
    if (!key || key.length > 200 || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const source = raw as Partial<VoiceConversationOptions>;
    const workspace = source.workspace?.kind === "app-private" ? { kind: "app-private" as const }
      : source.workspace?.kind === "direct" && typeof source.workspace.path === "string" && source.workspace.path.length > 0 && source.workspace.path.length <= 4096
        ? { kind: "direct" as const, path: source.workspace.path } : undefined;
    const entry: VoiceConversationOptions = {
      ...(workspace ? { workspace } : {}),
      ...(typeof source.sessionId === "string" && source.sessionId.length > 0 && source.sessionId.length <= 200 ? { sessionId: source.sessionId } : {}),
      ...(typeof source.workspaceRoot === "string" && source.workspaceRoot.length <= 4096 ? { workspaceRoot: source.workspaceRoot } : {}),
      ...(source.scopeVersion === 1 ? { scopeVersion: 1 as const } : {}),
      ...(source.resolvedBackend === "pi" || source.resolvedBackend === "dsh" || source.resolvedBackend === "codex" ? { resolvedBackend: source.resolvedBackend } : {}),
      ...(source.continuationPending === true && typeof source.sessionId === "string" ? { continuationPending: true as const } : {}),
    };
    bytes += new TextEncoder().encode(JSON.stringify({ [key]: entry })).length;
    if (bytes > MAX_HISTORY_STORE_BYTES) break;
    result[key] = entry;
  }
  return result;
}

function sanitizeCommandAgentSessionLedger(
  value: CommandAgentSessionLedgerItem[] | undefined,
): CommandAgentSessionLedgerItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .filter((item) => item && typeof item.sessionId === "string")
    .map((item) => ({
      sessionId: truncateJsonString(item.sessionId, 200),
      createdMs: Number.isFinite(item.createdMs) ? Math.max(0, Math.round(item.createdMs)) : 0,
    }))
    .filter((item) => {
      if (item.sessionId.length === 0 || seen.has(item.sessionId)) return false;
      seen.add(item.sessionId);
      return true;
    })
    .slice(0, 256);
}

function sanitizeCommandHistory(
  value: VoiceCommandHistoryItem[] | undefined,
): VoiceCommandHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return trimHistoryToStoreLimit(value
    .filter((item) => item && typeof item.id === "string" && typeof item.transcript === "string")
    .map((item) => ({
      id: truncateJsonString(item.id, 200),
      transcript: truncateJsonString(item.transcript, MAX_COMMAND_TRANSCRIPT_JSON_BYTES),
      status: item.status === "running" ? "running" as const
        : item.status === "completed" ? "completed" as const : "failed" as const,
      createdAt: normalizeCreatedAt(item.createdAt),
      ...(typeof item.reply === "string"
        ? { reply: truncateJsonString(item.reply, MAX_COMMAND_REPLY_JSON_BYTES) }
        : {}),
      ...(typeof item.runId === "string" ? { runId: truncateJsonString(item.runId, 200) } : {}),
      ...(typeof item.agentRequestKey === "string" ? { agentRequestKey: truncateJsonString(item.agentRequestKey, 128) } : {}),
      ...(typeof item.dshSessionId === "string" && item.dshSessionId.length > 0
        ? { dshSessionId: truncateJsonString(item.dshSessionId, 200) }
        : {}),
      ...(typeof item.agentSessionId === "string" && item.agentSessionId.length > 0
        ? { agentSessionId: truncateJsonString(item.agentSessionId, 200) }
        : {}),
      ...(typeof item.conversationId === "string" && item.conversationId.length > 0 && item.conversationId.length <= 200
        ? { conversationId: item.conversationId } : {}),
      ...(typeof item.commandId === "string" && item.commandId.length > 0
        ? { commandId: truncateJsonString(item.commandId, 200) }
        : {}),
      ...(item.translationTarget !== undefined ? { translationTarget: translationTarget(item.translationTarget) } : {}),
      ...(typeof item.durationMs === "number" ? { durationMs: Math.max(0, item.durationMs) } : {}),
      // 码按结构化文法接收：不合文法（句子、键值、凭据形态）的不落盘。
      ...(structuredCode(item.errorCode) ? { errorCode: structuredCode(item.errorCode)! } : {}),
      ...(typeof item.userMessage === "string"
        ? { userMessage: truncateJsonString(item.userMessage, 500) }
        : {}),
      ...structuredFailureFields(item.errorRawLength, item.errorSource, item.errorHttpStatus, "error", item.errorOmittedCodes),
      ...persistedAgentFailure(item),
      ...optionalIsoTime("failedAt", item.failedAt),
      ...optionalIsoTime("failureDetectedAt", item.failureDetectedAt),
      ...(item.unread === true ? { unread: true } : {}),
      ...sanitizeIdentity(item.identity),
      ...sanitizeMessages(item.messages),
      ...sanitizeRecordingRef(item),
    }))
    .slice(0, MAX_HISTORY_ITEMS));
}

/** 历史条目上的回听片段引用（输入与命令历史同一形态）。 */
export type VoiceRecordingRef = Pick<VoiceHistoryItem, "recordingId" | "recordingWallStartMs" | "recordingDurationMs">;

/** 回听片段引用：两者缺一不可——只有 id 没有起点就判不出「还在不在」，宁可当作没录音。 */
function sanitizeRecordingRef(item: VoiceRecordingRef): VoiceRecordingRef {
  if (
    typeof item.recordingId !== "string"
    || item.recordingId.length === 0
    || typeof item.recordingWallStartMs !== "number"
    || !Number.isFinite(item.recordingWallStartMs)
  ) {
    return {};
  }
  return {
    recordingId: truncateJsonString(item.recordingId, 200),
    recordingWallStartMs: Math.max(0, Math.round(item.recordingWallStartMs)),
    ...(typeof item.recordingDurationMs === "number" && Number.isFinite(item.recordingDurationMs)
      ? { recordingDurationMs: Math.max(0, Math.round(item.recordingDurationMs)) }
      : {}),
  };
}

/**
 * Host 实际留下的回听片段。`replayClipStatus` 是 `not_retained`（按授权 / 保留设置不留）
 * 或 `failed`（落盘失败）时这条只有文字：不给回听入口，也没有录音可回写转写状态。
 * 旧 Host 不带状态字段，按 `replayClip` 本身判断。
 */
export function savedReplayClip(
  result: Pick<VoiceInputResult, "replayClip" | "replayClipStatus">,
): VoiceReplayClipRef | undefined {
  if (result.replayClipStatus !== undefined && result.replayClipStatus !== "saved") return undefined;
  return result.replayClip ?? undefined;
}

/** Host 的 `replayClip` → 历史里的回听引用（展示 Host 实际授权回放的气口区间）。 */
export function recordingRefFromClip(clip: VoiceReplayClipRef | null | undefined): VoiceRecordingRef {
  if (!clip || typeof clip.id !== "string" || clip.id.length === 0) return {};
  const range = replayPresentationRange(clip);
  return sanitizeRecordingRef({
    recordingId: clip.id,
    recordingWallStartMs: range.wallStartMs,
    recordingDurationMs: range.durationMs,
  });
}

/** 按天总结的落盘形态校验：坏一天丢一天，不让一条坏数据拖垮整表。 */
function sanitizeDayDigests(
  value: Record<string, VoiceDayDigest> | undefined,
): Record<string, VoiceDayDigest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, VoiceDayDigest> = {};
  for (const [dayKey, raw] of Object.entries(value)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !raw || typeof raw !== "object") continue;
    const digest = raw as Partial<VoiceDayDigest>;
    if (!Array.isArray(digest.points) || digest.points.length === 0) continue;
    const points = digest.points
      .filter((point): point is string => typeof point === "string" && point.trim().length > 0)
      .map((point) => truncateJsonString(point, 400))
      .slice(0, 12);
    if (points.length === 0) continue;
    if (typeof digest.fromMs !== "number" || typeof digest.toMs !== "number") continue;
    const backend = digest.backend === "dsh" || digest.backend === "cloud"
      ? digest.backend
      : undefined;
    const rawDsh = digest.dsh;
    // 游标不能靠截断“修好”：少掉任意一段都会让下次刷新把旧素材再追加一次。
    // 超限或含脏项就整份丢掉，生成器下次以当前完整素材重建会话。
    // `fitDigestSegments` 的 12k 字符预算在极端“每段只有一字”时仍可能容纳约千段；
    // 2048 高于合法素材上界，同时继续挡住恶意 KV 膨胀。
    const validSegmentIds = rawDsh !== undefined
      && Array.isArray(rawDsh.sentSegmentIds)
      && rawDsh.sentSegmentIds.length <= 2_048
      && rawDsh.sentSegmentIds.every((id) => typeof id === "string" && id.trim().length > 0);
    const validSegmentKeys = rawDsh?.sentSegmentKeys === undefined
      || (Array.isArray(rawDsh.sentSegmentKeys)
        && rawDsh.sentSegmentKeys.length <= 2_048
        && rawDsh.sentSegmentKeys.every((key) => typeof key === "string" && key.trim().length > 0));
    const dsh = rawDsh
      && typeof rawDsh.sessionId === "string"
      && rawDsh.sessionId.trim().length > 0
      && validSegmentIds
      && validSegmentKeys
      ? {
          sessionId: truncateJsonString(rawDsh.sessionId.trim(), 512),
          sentSegmentIds: rawDsh.sentSegmentIds
            .map((id) => truncateJsonString(id.trim(), 512))
            .slice(),
          ...(Array.isArray(rawDsh.sentSegmentKeys)
            ? {
                sentSegmentKeys: rawDsh.sentSegmentKeys
                  .map((key) => truncateJsonString(key.trim(), 1_024))
                  .slice(),
              }
            : {}),
        }
      : undefined;
    out[dayKey] = {
      dayKey,
      points,
      segs: typeof digest.segs === "number" ? Math.max(0, Math.round(digest.segs)) : 0,
      chars: typeof digest.chars === "number" ? Math.max(0, Math.round(digest.chars)) : 0,
      fromMs: Math.max(0, Math.round(digest.fromMs)),
      toMs: Math.max(0, Math.round(digest.toMs)),
      createdAt: normalizeCreatedAt(digest.createdAt),
      final: digest.final === true,
      sourceKey: typeof digest.sourceKey === "string" ? truncateJsonString(digest.sourceKey, 8_000) : "",
      ...(backend ? { backend } : {}),
      ...(backend === "dsh" && dsh ? { dsh } : {}),
    };
  }
  return out;
}

/** 自动失败退避只保留近期合法日期与有限时间戳，避免坏 KV 把某天永久锁死。 */
function sanitizeDayDigestAttempts(
  value: Record<string, number> | undefined,
  nowMs = Date.now(),
): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const today = new Date(nowMs);
  const floor = new Date(nowMs);
  floor.setDate(floor.getDate() - DAY_DIGEST_ATTEMPT_RETENTION_DAYS);
  const keyOf = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const floorKey = keyOf(floor);
  const todayKey = keyOf(today);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([dayKey, attemptedAt]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(dayKey)
        && dayKey >= floorKey
        && dayKey <= todayKey
        && typeof attemptedAt === "number"
        && Number.isFinite(attemptedAt)
        && attemptedAt > 0
        && attemptedAt <= nowMs)
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_DAY_DIGEST_ATTEMPTS),
  );
}

function sanitizeIdentity(value: unknown): { identity?: VoiceCommandIdentity } {
  if (!value || typeof value !== "object") return {};
  const raw = value as Partial<VoiceCommandIdentity>;
  if (typeof raw.avatar !== "string" || typeof raw.title !== "string" || typeof raw.role !== "string") {
    return {};
  }
  return {
    identity: {
      avatar: truncateJsonString(raw.avatar, MAX_IDENTITY_FIELD_JSON_BYTES),
      title: truncateJsonString(raw.title, MAX_IDENTITY_FIELD_JSON_BYTES),
      role: truncateJsonString(raw.role, MAX_IDENTITY_FIELD_JSON_BYTES),
    },
  };
}

function sanitizeAttachment(value: unknown): VoiceChatAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<VoiceChatAttachment>;
  if (raw.kind === "file") {
    if (typeof raw.name !== "string") return undefined;
    return {
      kind: "file",
      name: truncateJsonString(raw.name, MAX_IDENTITY_FIELD_JSON_BYTES),
      ...(typeof raw.icon === "string" ? { icon: truncateJsonString(raw.icon, 16) } : {}),
      ...(typeof raw.meta === "string" ? { meta: truncateJsonString(raw.meta, MAX_IDENTITY_FIELD_JSON_BYTES) } : {}),
    };
  }
  if (raw.kind === "image") {
    if (typeof raw.alt !== "string") return undefined;
    return { kind: "image", alt: truncateJsonString(raw.alt, MAX_IDENTITY_FIELD_JSON_BYTES) };
  }
  if (raw.kind === "audio") {
    if (typeof raw.durationMs !== "number" || !Number.isFinite(raw.durationMs)) return undefined;
    const waveform = Array.isArray(raw.waveform)
      ? raw.waveform
          .filter((bar): bar is number => typeof bar === "number" && Number.isFinite(bar))
          .slice(0, MAX_ATTACHMENT_WAVEFORM_BARS)
          .map((bar) => Math.round(Math.max(1, Math.min(20, bar))))
      : [];
    return {
      kind: "audio",
      durationMs: Math.max(0, Math.round(raw.durationMs)),
      ...(waveform.length > 0 ? { waveform } : {}),
    };
  }
  return undefined;
}

function sanitizeChatCard(value: unknown): VoiceChatCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<VoiceChatCard> & Record<string, unknown>;
  if (
    raw.kind === "tool"
    && (raw.tool === "web_search" || raw.tool === "web_fetch")
    && (raw.status === "running" || raw.status === "completed" || raw.status === "failed")
    && typeof raw.label === "string"
  ) {
    return {
      kind: "tool",
      tool: raw.tool,
      status: raw.status,
      label: truncateJsonString(raw.label, MAX_IDENTITY_FIELD_JSON_BYTES),
    };
  }
  if (
    raw.kind === "tool-group"
    && (raw.status === "running" || raw.status === "completed" || raw.status === "failed" || raw.status === "unknown")
    && typeof raw.label === "string"
    && Array.isArray(raw.calls)
  ) {
    // 明细有界：超出上限保留最近的调用，同时保留完整总数和省略数。
    const calls = raw.calls
      .filter((call): call is VoiceToolCallEntry =>
        !!call && typeof call === "object"
        && isToolName(call.tool)
        && (call.status === "running" || call.status === "completed" || call.status === "failed" || call.status === "unknown"))
      .slice(-MAX_TOOL_CALL_ENTRIES_PER_CARD)
      .map((call) => ({
        ...(typeof call.callId === "string" && call.callId ? { callId: call.callId } : {}),
        tool: call.tool,
        status: call.status,
        at: typeof call.at === "string" ? call.at : "",
        ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0
          ? { durationMs: Math.round(call.durationMs) }
          : {}),
        // 错误码也是诊断输出通道：只收合结构化文法的码（§6.0）。
        ...(structuredCode(call.errorCode) ? { errorCode: structuredCode(call.errorCode)! } : {}),
        ...(typeof call.errorLabel === "string" && call.errorLabel
          ? { errorLabel: truncateJsonString(call.errorLabel, MAX_IDENTITY_FIELD_JSON_BYTES) }
          : {}),
      }));
    const totalCalls = typeof raw.totalCalls === "number" && Number.isSafeInteger(raw.totalCalls)
      && raw.totalCalls >= raw.calls.length ? raw.totalCalls : raw.calls.length;
    const failedCalls = typeof raw.failedCalls === "number" && Number.isSafeInteger(raw.failedCalls)
      && raw.failedCalls >= 0 ? raw.failedCalls
        : raw.calls.filter((call: VoiceToolCallEntry) => call?.status === "failed").length;
    return {
      kind: "tool-group",
      status: raw.status,
      label: truncateJsonString(raw.label, MAX_IDENTITY_FIELD_JSON_BYTES),
      calls,
      totalCalls,
      failedCalls: Math.min(totalCalls, failedCalls),
      omittedCalls: totalCalls - calls.length,
    };
  }
  if (
    raw.kind === "capability-required"
    && raw.capability === "browser-web-access"
    && raw.actionId === "install-browser-web-access"
    && typeof raw.title === "string"
    && typeof raw.detail === "string"
    && typeof raw.actionLabel === "string"
  ) {
    return {
      kind: "capability-required",
      capability: "browser-web-access",
      title: truncateJsonString(raw.title, MAX_IDENTITY_FIELD_JSON_BYTES),
      detail: truncateJsonString(raw.detail, MAX_IDENTITY_FIELD_JSON_BYTES * 2),
      actionId: "install-browser-web-access",
      actionLabel: truncateJsonString(raw.actionLabel, MAX_IDENTITY_FIELD_JSON_BYTES),
    };
  }
  if (
    raw.kind === "auth-required"
    && typeof raw.title === "string"
    && typeof raw.detail === "string"
  ) {
    return {
      kind: "auth-required",
      title: truncateJsonString(raw.title, MAX_IDENTITY_FIELD_JSON_BYTES),
      detail: truncateJsonString(raw.detail, MAX_IDENTITY_FIELD_JSON_BYTES * 2),
    };
  }
  return undefined;
}

/**
 * 消息流按**整体预算**裁剪：逐条（从最早的轮次起）丢，直到序列化总量落进
 * `MAX_COMMAND_MESSAGES_JSON_BYTES`。保留的是最近的——对话里最有价值的是最后说的。
 */
function sanitizeMessages(value: unknown): { messages?: VoiceChatMessage[] } {
  if (!Array.isArray(value)) return {};
  const cleaned: VoiceChatMessage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<VoiceChatMessage>;
    if ((raw.from !== "user" && raw.from !== "ai") || typeof raw.text !== "string") continue;
    const attachments = Array.isArray(raw.attachments)
      ? raw.attachments
          .map(sanitizeAttachment)
          .filter((att): att is VoiceChatAttachment => att !== undefined)
          .slice(0, MAX_COMMAND_ATTACHMENTS)
      : [];
    const card = sanitizeChatCard(raw.card);
    const usage = raw.from === "ai" ? sanitizeAgentUsage(raw.usage) : undefined;
    cleaned.push({
      from: raw.from,
      text: truncateJsonString(raw.text, MAX_COMMAND_REPLY_JSON_BYTES),
      at: normalizeCreatedAt(raw.at),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(card ? { card } : {}),
      ...(raw.from === "ai" && (raw.runtime === "dsh" || raw.runtime === "pi" || raw.runtime === "codex")
        ? { runtime: raw.runtime } : {}),
      ...(raw.from === "ai" && raw.channel === "external-brain" ? { channel: raw.channel } : {}),
      ...(usage ? { usage } : {}),
      ...(raw.from === "ai" && typeof raw.totalTokens === "number" && Number.isSafeInteger(raw.totalTokens) && raw.totalTokens >= 0
        ? { totalTokens: raw.totalTokens } : {}),
    });
  }
  let kept = cleaned.slice(-MAX_COMMAND_MESSAGES);
  while (kept.length > 0 && serializedBytes(kept) > MAX_COMMAND_MESSAGES_JSON_BYTES) {
    kept = kept.slice(1);
  }
  return kept.length > 0 ? { messages: kept } : {};
}

function sanitizeSettings(value: VoiceInputSettings | undefined): VoiceInputSettings {
  if (!value) return { ...DEFAULT_SETTINGS };
  return {
    source: value.source === "system" ? "system" : "board",
    ...(value.audioSourcePreference && typeof value.audioSourcePreference === "object"
      && !Array.isArray(value.audioSourcePreference) && Object.hasOwn(value.audioSourcePreference, "kind")
      && Object.keys(value.audioSourcePreference).length === 1
      && isAudioSourceMode(value.audioSourcePreference.kind)
      ? { audioSourcePreference: { kind: value.audioSourcePreference.kind } } : {}),
    ...(typeof value.systemEndpointId === "string" && value.systemEndpointId.length > 0
      ? { systemEndpointId: value.systemEndpointId }
      : {}),
    modelId: value.modelId === DEFAULT_MODEL_ID ? value.modelId : DEFAULT_MODEL_ID,
    language: ["auto", "zh-CN", "en-US"].includes(value.language) ? value.language : "auto",
    vadEnabled: value.vadEnabled !== false,
    maxRecordingMinutes: sanitizeMaxRecordingMinutes(value.maxRecordingMinutes),
    punctEnabled: value.punctEnabled !== false,
    engine: value.engine === "cloud" ? "cloud" : "local",
    polish: sanitizePolish(value.polish),
    polishContext: sanitizePolishContext(value.polishContext),
  };
}

export function sanitizeVoiceFeatureSettings(value: unknown): VoiceFeatureSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_VOICE_FEATURE_SETTINGS };
  const raw = value as Partial<VoiceFeatureSettings>;
  const summaryConsent = raw.summaryConsent === true;
  return {
    translationTarget: translationTarget(raw.translationTarget),
    cloudModelId:
      typeof raw.cloudModelId === "string"
        ? raw.cloudModelId
        : DEFAULT_VOICE_FEATURE_SETTINGS.cloudModelId,
    ...(raw.cloudModelBillingPolicy === "free-only" ? { cloudModelBillingPolicy: "free-only" as const } : {}),
    summaryEnabled: summaryConsent && raw.summaryEnabled === true,
    summaryMode: raw.summaryMode === "auto" ? "auto" : "manual",
    summaryConsent,
  };
}

function boardSettingsWithoutSystemEndpoint(settings: VoiceInputSettings): VoiceInputSettings {
  const { systemEndpointId: _systemEndpointId, audioSourcePreference: _audioSourcePreference, ...rest } = sanitizeSettings(settings);
  return { ...rest, source: "board" };
}

/** 认不出的档位一律回到 `raw`：不认识就别替用户改他说的话。 */
function sanitizePolish(value: unknown): VoiceInputSettings["polish"] {
  if (value === undefined) return DEFAULT_SETTINGS.polish;
  return value === "light" || value === "formal" ? value : "raw";
}

function sanitizePolishContext(value: unknown): VoiceInputSettings["polishContext"] {
  const fallback = DEFAULT_SETTINGS.polishContext;
  if (!value || typeof value !== "object") return { ...fallback };
  const raw = value as Partial<VoiceInputSettings["polishContext"]>;
  const range = raw.recentVoiceRangeMinutes;
  return {
    // 窗口上下文要读别的应用里的文字，缺省一律关：没存过就是没开过。
    window: raw.window === true,
    recentVoice: raw.recentVoice !== false,
    recentVoiceRangeMinutes: CONTEXT_RANGE_MINUTES.includes(
      range as (typeof CONTEXT_RANGE_MINUTES)[number],
    )
      ? (range as number)
      : DEFAULT_CONTEXT_RANGE_MINUTES,
  };
}

function sanitizeSelection(value: unknown): import("@reai/app-sdk/v1").SavedInputSelection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as import("@reai/app-sdk/v1").SavedInputSelection;
  if ((v.engine !== "local" && v.engine !== "cloud") || typeof v.modelId !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(v.modelId)
    || typeof v.language !== "string" || !/^[A-Za-z0-9-]{1,35}$/.test(v.language) || typeof v.punctEnabled !== "boolean") return undefined;
  return { engine: v.engine, modelId: v.modelId, language: v.language, punctEnabled: v.punctEnabled,
    ...((v as typeof v & { billingPolicy?: string }).billingPolicy === "free-only" ? { billingPolicy: "free-only" as const } : {}),
    ...(typeof v.modelName === "string" ? { modelName: truncateJsonString(v.modelName, 512) } : {}) };
}
function sanitizeRetryPlan(value: unknown): SavedInputRetryPlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as SavedInputRetryPlan; const primary = sanitizeSelection(v.primary); const fallback = sanitizeSelection(v.fallback);
  return primary ? { primary, ...(primary.engine === "cloud" && fallback?.engine === "local" ? { fallback } : {}) } : undefined;
}
/** 有限数值不等于有效日期（1e20 能过 isFinite，却让 toISOString 抛错）：按 Date 的有效范围校验。 */
export function isValidTimeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
}

function sanitizeSavedInput(value: unknown): SavedInputExecution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as SavedInputExecution; const selection = sanitizeSelection(v.selection);
  if (!selection || typeof v.attemptId !== "string" || v.attemptId.length > 100 || !Number.isSafeInteger(v.revision) || v.revision < 0
    || !["pending", "complete", "failed", "cancelled", "no_speech"].includes(v.state) || !isValidTimeMs(v.startedAtMs)) return undefined;
  return { attemptId: v.attemptId, revision: v.revision, state: v.state, selection, startedAtMs: v.startedAtMs,
    ...(isValidTimeMs(v.finishedAtMs) ? { finishedAtMs: v.finishedAtMs } : {}),
    ...(structuredCode(v.errorCode) ? { errorCode: structuredCode(v.errorCode)! } : {}) };
}

function sanitizeHistory(value: VoiceHistoryItem[] | undefined): VoiceHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return trimHistoryToStoreLimit(value
    .filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.transcript === "string" &&
        typeof item.createdAt === "string" &&
        Number.isFinite(new Date(item.createdAt).getTime()),
    )
    .map((item): VoiceHistoryItem => ({
      id: truncateJsonString(item.id, 200),
      transcript: truncateJsonString(item.transcript, MAX_INPUT_TRANSCRIPT_JSON_BYTES),
      language: ["auto", "zh-CN", "en-US"].includes(item.language) ? item.language : "auto",
      source: item.source === "system" ? "system" : "board",
      inserted: item.inserted === true,
      durationMs:
        typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
          ? Math.max(0, Math.min(item.durationMs, MAX_RECORDING_MINUTES * 60_000))
          : 0,
      createdAt: normalizeCreatedAt(item.createdAt),
      ...(typeof item.warningCode === "string"
        ? { warningCode: truncateJsonString(item.warningCode, 100) }
        : {}),
      ...(item.transcriptionStatus === "not_requested" || item.transcriptionStatus === "pending" || item.transcriptionStatus === "failed"
        ? { transcriptionStatus: item.transcriptionStatus }
        : {}),
      ...(item.stopReason === "user_cancel"
        || item.stopReason === "capture_limit"
        || item.stopReason === "source_unavailable"
        ? { stopReason: item.stopReason }
        : {}),
      ...(sanitizeRetryPlan(item.retryPlan) ? { retryPlan: sanitizeRetryPlan(item.retryPlan) } : {}),
      ...(sanitizeSelection(item.originalSelection) ? { originalSelection: sanitizeSelection(item.originalSelection) } : {}),
      ...(sanitizeSavedInput(item.savedInput) ? { savedInput: sanitizeSavedInput(item.savedInput) } : {}),
      ...(!item.transcriptionStatus && (item.recognitionEngine === "local" || item.recognitionEngine === "cloud")
        ? { recognitionEngine: item.recognitionEngine }
        : {}),
      ...(item.requestedEngine === "local" || item.requestedEngine === "cloud"
        ? { requestedEngine: item.requestedEngine }
        : {}),
      ...(typeof item.originalTranscript === "string" && item.originalTranscript.length > 0
        ? {
            // 上限只给 transcript 的一半：两项都按 128 KiB 放行的话，**单条**就能
            // 顶破整表 255 KiB 的预算，而裁剪函数遇到第一条就超预算时会直接停手、
            // 把整份历史写成空数组——一条坏数据清空全部历史。
            originalTranscript: truncateJsonString(
              item.originalTranscript,
              MAX_INPUT_TRANSCRIPT_JSON_BYTES / 2,
            ),
          }
        : {}),
      ...(item.polish === "light" || item.polish === "formal" || item.polish === "raw"
        ? { polish: item.polish }
        : {}),
      ...(item.polishFailed === true ? { polishFailed: true } : {}),
      ...sanitizeStageFailure("polishFailure", item.polishFailure),
      ...sanitizeStageFailure("deliveryFailure", item.deliveryFailure),
      ...sanitizeRecordingRef(item),
    }))
    .slice(0, MAX_HISTORY_ITEMS));
}

/** 诊断原文的持久上限：600 字在 JSON 里最坏按 3 字节 / 字计，另留转义余量。 */

/** 非法或缺席的时间一律丢弃：诊断宁可写「未记录」，也不编一个时间。 */
function optionalIsoTime<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  if (typeof value !== "string") return {};
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? { [key]: parsed.toISOString() } as Record<K, string> : {};
}

function sanitizeStageFailure<K extends "polishFailure" | "deliveryFailure">(
  key: K,
  value: unknown,
): Partial<Record<K, VoiceStageFailure>> {
  if (!value || typeof value !== "object") return {};
  const failure = value as Partial<VoiceStageFailure>;
  // 码只收结构化文法；不合文法的记录整条不收（视图按 warningCode 如实写「未记录」）。
  const code = structuredCode(failure.code);
  if (!code) return {};
  const at = optionalIsoTime("at", failure.at).at;
  if (!at) return {};
  return {
    [key]: {
      code,
      at,
      ...structuredFailureFields(failure.rawLength, failure.source, failure.httpStatus, undefined, failure.omittedCodes),
    },
  } as Partial<Record<K, VoiceStageFailure>>;
}

/** 命令失败的 Agent 阶段字段落盘：阶段码不在登记表就整组不收，退出码越界 / 上游码没登记就只丢那一项。 */
export function persistedAgentFailure(
  item: { errorAgentStage?: unknown; errorExitCode?: unknown; errorUpstreamCode?: unknown },
): Pick<VoiceCommandHistoryItem, "errorAgentStage" | "errorExitCode" | "errorUpstreamCode"> {
  const fields = agentFailureFields({ agentStage: item.errorAgentStage, exitCode: item.errorExitCode, upstreamCode: item.errorUpstreamCode });
  if (!fields) return {};
  return {
    errorAgentStage: fields.agentStage,
    ...(fields.exitCode !== undefined ? { errorExitCode: fields.exitCode } : {}),
    ...(fields.upstreamCode ? { errorUpstreamCode: fields.upstreamCode } : {}),
  };
}

const ERROR_SOURCES: ReadonlySet<string> = new Set(["host", "cloud", "agent", "local"]);

/** 落盘失败的结构化字段：原文字符数、来源类别、HTTP 状态码、未登记码个数；其余一律不收。 */
function structuredFailureFields(rawLength: unknown, source: unknown, httpStatus: unknown, prefix: undefined, omittedCodes: unknown): {
  rawLength?: number; source?: VoiceErrorSource; httpStatus?: number; omittedCodes?: number;
};
function structuredFailureFields(rawLength: unknown, source: unknown, httpStatus: unknown, prefix: "error", omittedCodes: unknown): {
  errorRawLength?: number; errorSource?: VoiceErrorSource; errorHttpStatus?: number; errorOmittedCodes?: number;
};
function structuredFailureFields(
  rawLength: unknown, source: unknown, httpStatus: unknown, prefix: "error" | undefined, omittedCodes: unknown,
): Record<string, unknown> {
  const key = (name: string) => prefix ? `${prefix}${name[0]!.toUpperCase()}${name.slice(1)}` : name;
  return {
    ...(typeof omittedCodes === "number" && Number.isSafeInteger(omittedCodes) && omittedCodes > 0 && omittedCodes <= 100
      ? { [key("omittedCodes")]: omittedCodes } : {}),
    ...(typeof rawLength === "number" && Number.isInteger(rawLength) && rawLength > 0 && rawLength <= 10_000_000
      ? { [key("rawLength")]: rawLength } : {}),
    ...(typeof source === "string" && ERROR_SOURCES.has(source) ? { [key("source")]: source } : {}),
    ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? { [key("httpStatus")]: httpStatus } : {}),
  };
}

function trimHistoryToStoreLimit<T>(items: T[]): T[] {
  const kept: T[] = [];
  for (const item of items.slice(0, MAX_HISTORY_ITEMS)) {
    const candidate = [...kept, item];
    if (serializedBytes(candidate) > MAX_HISTORY_STORE_BYTES) break;
    kept.push(item);
  }
  return kept;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function truncateJsonString(value: string, maxBytes: number): string {
  if (serializedBytes(value) <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // 不把 UTF-16 surrogate pair 从中间切开。
  const last = value.charCodeAt(low - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? low - 1 : low;
  return value.slice(0, end);
}

function normalizeCreatedAt(value: unknown): string {
  const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

/** Translate the notice for display; keep the persisted migration marker stable. */
export function sourceMigrationNoticeText(): string {
  return t("data.message4");
}
