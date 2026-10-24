import { buildVoiceTypedAttachments, parseVoiceAttachmentTarget, uploadVoiceImage, type PreparedVoiceAttachment, type VoiceAttachmentTarget } from "./voice-attachment-input";
import { buildVoiceAttachmentTurn, VOICE_TEXT_ATTACHMENT_POLICY, VoiceAttachmentContentError } from "./voice-attachment-content";
import { confirmedVoiceAttachmentFormats, requireVoiceAttachmentAdmission } from "./voice-attachment-admission";
import { pendingVoiceRequestHasFileAttachments, requireVoiceTaskAttachmentScene } from "./voice-attachment-scene";
import { PendingAgentRequests, type PendingAgentRequest } from "./agent-pending";
import { createVoiceAgentTurns } from "./agent-turns";
import { VOICE_START_TIMEOUT_MS, awaitVoicePreparation, withVoiceStartDeadline } from "./voice-start-deadline";
import { VoiceCaptureOperations } from "./voice-capture-operations";
import { VOICE_REFRESH_TIMEOUT_MS, withVoiceRefreshDeadline } from "./voice-refresh-deadline";
import { SavedInputRetryController, projectSavedInputSession, type SavedInputRetryPlan } from "./saved-input-retry";
import { InputSelectionJournal } from "./input-selection-journal";
import { commandOverlayKind } from "./voice-overlay-kind";
import { createVoiceOverlayStages } from "./voice-overlay-stage";
import { VOICE_ANSWER_DEFER_REQUIRED, isFinalizingResult } from "./voice-sdk-compat";
import { readVoiceAccountEpoch, isVoiceAccountCurrent, isVoiceRequestInvalidated } from "./voice-account";
import { assessTranslationOutput, TRANSLATION_LANGUAGES, translationPrompt, translationTurnText } from "./voice-translation";
import { DEFAULT_MODEL_ID, sanitizeVoiceFeatureSettings } from "./data";
import { t, setVoiceLocale } from "./voice-i18n";
import { chooseRecognitionEngine, RecognitionSetupRollbackError } from "./recognition-setup";
import { assertFreeOnlyCloudExecution, preferredCloudOption, cloudSelectionBillingPolicy, selectedCloudOption, validCloudOptionId } from "./cloud-selection";
import { cloudModelsFailureRetryable, cloudModelsRetryDelay, cloudModelsRetryTiming } from "./cloud-models-retry";
import { agentReadiness } from "./agent-readiness";
import { availableConversationBackends, canChangeConversation, conversationKey, conversationMembers, continuationPrompt, createVoiceCommandSessionConfig, scopeUnavailableMessage, visibleConversationContext, type VoiceConversationOptions } from "./agent-conversation";
import { VOICE_SUMMARY_SYSTEM_PROMPT, noteHostAgentBackendStatuses, withVoiceFeatureRef } from "./agent-features";
import type { AgentBackend, AgentHistoryItem, AudioTimelineStatus, CloudModelOption, ResolvedAgentBackend, VoiceInputStatus } from "@reai/app-sdk/v1";
import { sanitizeAgentUsage } from "./agent-metadata";
import { LocalModelDownloads } from "./local-model-download";
import {
  AppError,
  type CommandHandler,
  defineApp,
  describeCloudError,
  isSystemTaskReturnIntent,
  type DshSendResult,
  type AgentTurnRef,
  type AgentToolAttempt,
  type AgentTurnResult,
  type VoiceDeliveryTargetRef,
  type VoiceInputResult,
  type VoiceInputSettings,
  type VoicePolishSetting,
  type VoiceReplayRetention,
  type VoiceReplayClipRef,
  type RecoverableVoiceInputSession,
  type SavedInputSelection,
} from "@reai/app-sdk/v1";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_FEATURE_SETTINGS,
  DEFAULT_AGENT_EXPERIMENT,
  COMMAND_HISTORY_KEY,
  EMPTY_PERMISSIONS,
  SOURCE_MIGRATION_NOTICE,
  VoiceStateRepository,
  MAX_TOOL_CALL_ENTRIES_PER_CARD,
  isToolName,
  persistedAgentFailure,
  planCommandAgentSessionReconciliation,
  reconcileAuthoritativeVoiceStatus,
  recordingRefFromClip,
  replayCacheWithClip,
  replayPresentationRange,
  savedReplayClip,
  shouldPollVoiceStatus,
  voiceAvailabilityChanged,
  voiceSourceStatusPatch,
  validCaptureLimitSeconds,
  type VoiceContextProbe,
  type VoiceHistoryItem,
  type VoiceStageFailure,
  type VoiceCommandHistoryItem,
  type VoiceChatCard,
  type VoiceChatMessage,
  type VoiceViewState,
  type VoiceAgentExperimentSettings,
  type VoiceAgentConversationRef,
  type VoiceFeatureSettings,
  type VoiceRecordingRef,
} from "./data";
import { COMMAND_EVENT_META, createOwnedConversationOpenController, mountVoiceView, type VoiceSettingsChangeOptions, type VoiceView } from "./voice-view";
import { plainReply, toolProgressText, trimToolCalls, unresolvedToolFailure, userWaitLabel } from "./voice-agent-presentation";
import {
  BUILTIN_VOICE_COMMANDS,
  VOICE_COMMAND_STAGE_LABELS,
  type VoiceCommandId,
  type VoiceContextEnvelope,
} from "./voice-ai-contract";
import { createDefaultContextRegistry } from "./voice-context";
import { VoiceScreenshotConsent, type VoiceScreenshotConsentRecord, type VoiceScreenshotGrant } from "./voice-screenshot-consent";
import { VoiceRequestAdmission } from "./voice-request-admission";
import { VoiceRequestTextProvider } from "./voice-request-text";
import { prepareVoiceRequest } from "./voice-request-permission";
import { createVoiceConfiguration, withExplicitVoiceSource } from "./voice-configuration";
import { createVoiceSurfaceNavigation } from "./voice-surface-navigation";
import { registerVoiceRequestTextService } from "./voice-service-registration";
import {
  describePolishFailure,
  isPolishUnavailable,
  polishTranscript,
  type VoicePolishOutcome,
} from "./voice-polish";
import { waitForPresentation } from "./voice-presentation-settlement";
import { createCommandPresentationGate } from "./voice-command-presentation";
import { voiceStatusPollMayAcknowledge } from "./voice-status-poll";
import {
  dayDateLabel,
  dayKeyOf,
  segmentDayKey,
  type VoiceDayDigest,
} from "./voice-digest";
import {
  discardDigestSession,
  prepareDigestRun,
  planDigestWork,
  pruneDigests,
  type DayDigestGenerator,
} from "./voice-digest-scheduler";
import {
  summarizeSegment,
  synthesizeDayDigestAuto,
  type VoiceSummaryDeps,
} from "./voice-summary-dsh";
import { initialSnapshot, isCommandGateFailureCode } from "./voice-command-runtime";
import {
  voiceAgentUnavailableMessage,
  voiceCloudFailureMessage,
  voiceHistorySaveFailureMessage,
  voiceRequestFailureMessage,
  voiceRequestFailureReason,
  type VoiceRequestPurpose,
} from "./voice-user-errors";
import { presentAgentToolError } from "./agent-error-presentation";
import { errorDetailFrom } from "./voice-diagnostics";
import {
  collectErrorFields,
  diagnosticLogFields,
  projectDiagnosticLogFields,
  structuredCode,
  withOuterCode,
  type VoiceErrorFields,
} from "./voice-error-fields";
import { deliverReasonLabel, hostErrorCode, knownFailureLabel, taskFailureLabel } from "./voice-failure-labels";
import { agentTurnFailureCode } from "./agent-failure-codes";
import { VoiceAppError, commandWireError, composedUserMessage, constantUserMessage, trustedDiagnosticFields } from "./voice-app-error";
import { inPlainMode, setVoiceDeveloperMode, voiceDeveloperMode } from "./voice-presentation-mode";
import { HostVersionReader } from "./voice-host-version";
import { commandStepKey, interruptedLabel, stoppedLabel } from "./voice-stop-copy";
import { classifyUtterance, shouldTranslateUtterance } from "./voice-utterance";
import { VoiceClipCapture, type VoiceClipPressToken } from "./voice-audio-clips";
// 共享对话组件的样式先于插件自己的：voice.css 只通过 --chat-dock-x 变量调它，不覆盖其类规则。
import "@reai/chat-ui/styles.css";
import { openVoiceSourceLink } from "./voice-source-links";
import "./voice.css";

/**
 * 三个**可被绑定的命令事件**：转文本 / 翻译 / Agent 提问。
 *
 * 插件只把事件交出来；哪颗键、哪个拨杆档触发哪一个，是 Host 键位设置的事
 * （插件与硬件解耦条款：插件不声明也不读取那层映射，更不假设某款硬件存在）。
 */
const VOICE_COMMAND_EVENTS = {
  "com.reai.voice.command.transcribe": BUILTIN_VOICE_COMMANDS.transcribe,
  "com.reai.voice.command.translate": BUILTIN_VOICE_COMMANDS.translate,
  "com.reai.voice.command.agent": BUILTIN_VOICE_COMMANDS.agent,
} as const satisfies Readonly<Record<string, VoiceCommandId>>;

/** 每种命令跑到「云端处理」那一步时，任务卡上显示什么。 */
const COMMAND_STAGE: Readonly<Record<VoiceCommandId, string>> = {
  get [BUILTIN_VOICE_COMMANDS.transcribe]() { return VOICE_COMMAND_STAGE_LABELS["text.polishing"]; },
  get [BUILTIN_VOICE_COMMANDS.translate]() { return VOICE_COMMAND_STAGE_LABELS["text.translating"]; },
  get [BUILTIN_VOICE_COMMANDS.agent]() { return VOICE_COMMAND_STAGE_LABELS["prompt.refining"]; },
};

/** 命令的短标签（历史与任务卡标题用）。 */
const COMMAND_LABEL: Readonly<Record<VoiceCommandId, string>> = {
  get [BUILTIN_VOICE_COMMANDS.transcribe]() { return t("app.transcribe"); },
  get [BUILTIN_VOICE_COMMANDS.translate]() { return t("app.translate"); },
  get [BUILTIN_VOICE_COMMANDS.agent]() { return t("app.askAgent"); },
};

/**
 * Agent / 翻译命令识别为空时，Host 中央胶囊显示「没有听清 / 请再说一次」并等插件确认。
 * 立刻确认会让这句提示一闪而过，用户以为按键没反应；停这么久再收（2.14.4-rc.1）。
 */
const EMPTY_UTTERANCE_HINT_MS = 1500;

/** A3-24「发给 agent」的去路与门控都指向它：Agents·IM（ni.chat）官方包。 */
const AGENTS_IM_APP_ID = "com.reai.agents-im";
/** ni.chat 声明的承接 intent（`attach-context@1.0`）：把一段外部内容放进输入侧。 */
const AGENTS_IM_ATTACH_CONTEXT_INTENT = "attach-context";

/** 是否把成功结果额外交付到录音开始时的目标；不参与呈现载体选择。 */
function shouldWriteBack(commandId: VoiceCommandId): boolean {
  return commandId !== BUILTIN_VOICE_COMMANDS.agent;
}

/**
 * 云端失败时能不能拿原文顶上。
 *
 * **只有转文本可以**：它要的本来就是这段话本身，润色只是锦上添花，失败了把本地识别
 * 原文写回去仍是用户要的结果。翻译与 Agent 提问有实质的后续步骤——用原文冒充译文
 * 或答案，是把失败包装成成功：用户说中文期望英文，拿到中文，系统还说「已写入」。
 */
function allowsRawFallback(commandId: VoiceCommandId): boolean {
  return commandId === BUILTIN_VOICE_COMMANDS.transcribe;
}

/**
 * 从按键绑定携带的静态入参里解析命令类型。
 *
 * 绑定表是本机文件，用户手改得进去，所以未知值一律回落到调用方给的默认——
 * 而不是把一个来路不明的字符串直接发去云端。
 */
function resolveCommandId(input: unknown, fallback: VoiceCommandId): VoiceCommandId {
  const raw = (input as { commandId?: unknown } | null | undefined)?.commandId;
  if (typeof raw !== "string") return fallback;
  const known = Object.values(BUILTIN_VOICE_COMMANDS) as string[];
  return known.includes(raw) ? (raw as VoiceCommandId) : fallback;
}

// Use Host event/ledger time only. Batched replay delivery has no timing value.
function hostToolTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15 ? value : undefined;
}
function hostToolElapsed(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}

let stopVoiceLocale: (() => void) | undefined;
let stopLocalDownloads: (() => void) | undefined;
let stopCloudModels: (() => void) | undefined;
const listeners = new Set<(state: VoiceViewState) => void>();
let cancelSavedInputRetries: (() => Promise<void>) | undefined;
let disposeHostVersion: (() => void) | undefined;
/** 停用时撤掉后台收尾段的等待者（Host 按 owner 清掉它们的终稿，不再呈现）。 */
let disposeAsyncSegments: (() => void) | undefined;
let cancelActiveVoiceInput: (() => Promise<void>) | undefined;
let requestTextProviderDeactivate: (() => void) | undefined;
/** 输入法片段增强（audio.capture@1 + audio.clips@1）；Host 未开放/未批准时恒为不可用。 */
let voiceClipCapture: VoiceClipCapture | undefined;
/** 当前 Voice 界面挂载数：SDK 只在恰有一个挂载时允许音频调用。 */
let voiceSurfaceMounts = 0;
interface ActiveCommandRun {
  controller: AbortController;
  finished?: Promise<void>;
  repository: VoiceStateRepository;
  agentSessionId?: string;
  /** F04：可见对话身份（切换引擎后仍是同一段对话）。 */
  conversationId?: string;
  /** Host 受理后的原生 turnId；F03 审批事件按它对齐正在运行的对话。 */
  runId?: string;
  durableAgent?: boolean;
  transcript: string;
  inputAttachments?: VoiceChatMessage["attachments"];
  commandId: VoiceCommandId;
  createdAt: string;
}
const activeCommandRuns = new Map<string, ActiveCommandRun>();
/** 一次命令运行的附加入参（`startCommandAgent` 与 `runCommandAgent` 共用）。 */
interface CommandRunOptions {
  /** Follow-up in a translation scene stays a tools-free translator, not a task. */
  readOnlyTranslation?: boolean;
  translationTarget?: VoiceFeatureSettings["translationTarget"];
  attachments?: readonly PreparedVoiceAttachment[];
  /** Already validated follow-up body; dispatch must use these exact bytes. */
  attachmentTurnText?: string;
  attachmentInput?: import("@reai/app-sdk/v1").AgentAttachmentTurnInput;
  inputAttachments?: VoiceChatMessage["attachments"];
  title?: string;
  dshSessionId?: string;
  agentSessionId?: string;
  conversationId?: string;
  conversationOptions?: VoiceConversationOptions;
  visibleContext?: AgentHistoryItem[];
  recovery?: PendingAgentRequest;
  resume?: AgentTurnRef;
  context?: Promise<VoiceContextEnvelope | undefined>;
  /** Host 录音会话 id：转文本 / 翻译交付完成（不弹结果框）时凭它收掉中央「处理中」胶囊。 */
  resultSessionId?: string;
  /**
   * 来自 `asyncFinish` 录音（胶囊叠放）时的同一会话 id：任务帧与前台结果带上它，Host 才认得栈里
   * 那一枚胶囊，并可要求前台结果转后台。同步收尾的录音不带，行为不变。
   */
  voiceSessionId?: string;
  /** 开录时冻结的润色档（胶囊叠放的后台收尾段）；不带时读当下设置。 */
  polish?: VoicePolishSetting;
  /** 这次命令录音的回听引用；Host 没带回 replayClip 时为空对象。 */
  recording?: VoiceRecordingRef;
}
const commandAgentCards = new Map<string, VoiceChatCard[]>();
/** 转文本 / 翻译没写进去时的取回卡内容（取回卡被拒时同一内容改走失败结果面板）。 */
interface CommandTakebackCard { title: string; reason: string; text: string; code?: string }
/** 每个命令运行登记的「等你拍板」回调：Host 的 wait.started / wait.ended 经它更新胶囊帧。 */
const commandProgressHandlers = new Map<string, (label: string) => void>();
const commandUserWaitHandlers = new Map<string, (type: "wait.started" | "wait.ended", waitId: string, reason: string, label: string) => void>();
/** 已结束的等待（回合 + 等待 id）：乱序晚到的 wait.started 不能让它复活。Host 每个回合都从 wait-1 编号。 */
const endedUserWaits = new Set<string>();
const userWaitKey = (taskId: string, waitId: string) => `${taskId}\u0000${waitId}`;
const forgetEndedUserWaits = (taskId: string) => {
  for (const key of endedUserWaits) if (key.startsWith(`${taskId}\u0000`)) endedUserWaits.delete(key);
};
type WebToolName = "web_search" | "web_fetch";
/** 联网访问两工具：安装浏览器插件提示、联网失败码归并只看它们；过程折叠收全部工具。 */
const isWebAccessTool = (name: unknown): name is WebToolName => name === "web_search" || name === "web_fetch";
interface WebToolFailure { code: string; tool: WebToolName; ordinal: number }
const commandAgentToolErrors = new Map<string, WebToolFailure[]>();
const pendingWebToolError = (taskId: string): string | undefined => commandAgentToolErrors.get(taskId)?.at(-1)?.code;
/** 已被外部中止认领终态的 taskId：晚到的成功/失败不得再覆盖「已中断」终局。 */
const abortedCommandClaims = new Set<string>();
let activeForegroundTaskId: string | undefined;
const processStartedAt = Date.now();

/** 命令生命周期脱敏轨迹（只记 taskId/事件/耗时，不记说话内容）——链②取证用。 */
function commandLifecycleTrace(event: string, taskId: string, extra?: Record<string, unknown>): void {
  console.info("[voice-cmd]", event, { taskId, ...extra });
}

/**
 * 外部中止（deactivate / Surface 回收）后的留痕结算：把 running 任务落成
 * 「已中断」失败历史。只写 KV——此刻 WebView 即将卸载，内存 publish 无意义；
 * 下次激活从 KV 读回，用户能看到这条中断记录而不是任务凭空消失。
 */
async function settleInterruptedCommand(taskId: string, run: ActiveCommandRun): Promise<void> {
  const at = new Date().toISOString();
  const item: VoiceCommandHistoryItem = {
    id: taskId,
    transcript: run.transcript,
    commandId: run.commandId,
    status: "failed",
    createdAt: run.createdAt,
    ...(run.agentSessionId ? { agentSessionId: run.agentSessionId } : {}),
    ...(run.conversationId ? { conversationId: run.conversationId } : {}),
    messages: [
      { from: "user", text: run.transcript, at: run.createdAt, attachments: run.inputAttachments },
      { from: "ai", text: interruptedLabel(run.commandId), at },
    ],
    errorCode: "VOICE_COMMAND_INTERRUPTED",
    failedAt: at,
    get userMessage() { return interruptedLabel(run.commandId); },
  };
  try {
    const result = await run.repository.settleCommandHistory(item);
    commandLifecycleTrace(result.applied ? "interrupted_persisted" : "interrupted_terminal_already_set", taskId, {
      commandId: run.commandId,
    });
  } catch {
    commandLifecycleTrace("interrupted_persist_failed", taskId, {
      commandId: run.commandId,
      code: "VOICE_COMMAND_HISTORY_SAVE_FAILED",
    });
  }
}
let voiceStatusPoll: number | undefined;
let state: VoiceViewState = {
  developerMode: false,
  statusLoad: "loading",
  phase: "idle",
  settings: { ...DEFAULT_SETTINGS },
  featureSettings: { ...DEFAULT_VOICE_FEATURE_SETTINGS },
  cloudModels: [],
  cloudModelsLoading: true,
  agentExperiment: { ...DEFAULT_AGENT_EXPERIMENT },
  history: [],
  models: [],
  permissions: { ...EMPTY_PERMISSIONS },
  activeMode: undefined,
  commandPhase: "idle",
  dictationPhase: "idle",
  commandConfigured: false,
  commandLoggedIn: false,
  commandHistory: [],
  sourceReady: undefined,
  systemInputs: [],
  recordings: [],
  recordingsTotal: 0,
  mountedActionCommandIds: [],
  dayDigests: {},
  screenshotConsent: { enabled: false },
};

/** Host 按键会话切片已与片段增强同一窗口（`voice.status.captureModel`）：不再做第二次识别。 */
const SPAN_MARKERS_CAPTURE_MODEL = "span-markers-v1";

/**
 * 片段增强只给键盘连续源（USB Vendor HID / BLE）用：电脑麦按会话开录，不常驻消费者。
 * 返回值变化（切源、时间线运行态变化）会让协调器换一代消费者。
 * 不看全天存档开关与存档状态（`continuousRecordingEnabled` / `recordingState`）：常驻收音是给
 * 按键前后补气口的工程冗余，开关只管要不要长期保存全天转写（2026-10-15 用户拍板），
 * 拨开关既不能关掉补气口，也不该让消费者换代、丢掉换代前的那段回看。
 */
function voiceClipWantKey(current: VoiceViewState): string | undefined {
  if (current.captureModel === SPAN_MARKERS_CAPTURE_MODEL) return undefined;
  const timeline = current.timeline;
  if (!timeline) return undefined;
  if (timeline.route !== "usb_vendor_hid" && timeline.route !== "ble_gatt") return undefined;
  // 带上时间线运行态：收音断开再恢复时换一代消费者，给上一代被拒的申请一次重来的机会。
  return `${timeline.route}:${timeline.state}`;
}

/** Host 片段转写固定用默认本地模型、自动语言、开标点；设置不同就保留 Host 会话结果。 */
function clipTranscriptionMatches(selection: SavedInputSelection): boolean {
  return selection.engine === "local" && selection.modelId === DEFAULT_MODEL_ID
    && selection.language === "auto" && selection.punctEnabled !== false;
}

export default defineApp({
  async activate(ctx) {
    const configuration = createVoiceConfiguration(settings => ctx.voiceInput.configure(settings));
    stopVoiceLocale?.();
    setVoiceLocale(ctx.locale?.getSnapshot().locale ?? "zh");
    stopVoiceLocale = ctx.locale?.onChange(({ locale }) => setVoiceLocale(locale));
    if (voiceStatusPoll !== undefined) window.clearInterval(voiceStatusPoll);
    voiceStatusPoll = undefined;
    cancelActiveVoiceInput = () => ctx.voiceInput.cancel(state.sessionId);
    voiceClipCapture?.dispose();
    voiceClipCapture = new VoiceClipCapture({ ctx });
    voiceClipCapture.setMounted(voiceSurfaceMounts === 1);
    voiceClipCapture.setWanted(voiceClipWantKey(state));
    const repository = new VoiceStateRepository(ctx.storage.private("voice-state"));
    const repositoryStore = ctx.storage.private("voice-state");
    const pendingAdmissions = new PendingAgentRequests(repositoryStore, async () => (await ctx.agent.listSessions({ schemaVersion: 2 })).sessions.map(session => session.sessionId));
    const inputSelections = new InputSelectionJournal(repositoryStore);
    let pendingInputSelection: SavedInputSelection | undefined;
    // 对话页定向听写（R8 输入坞）的引擎/云端模型快照：与 pendingInputSelection 同一
    // 规则——起跑那一刻定下，收工那次（哪怕设置已被改掉）沿用开始时的值。
    let pendingDictationSelection: SavedInputSelection | undefined;
    const savedCommands = await repositoryStore.get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [];
    const durableCommands = savedCommands.filter(item => item?.status === "running"
      && item.agentSessionId?.startsWith("agent2-") && typeof item.runId === "string" && item.runId.length > 0);
    // A transport failure is not proof of lost ownership. A successful listing
    // without the session is definitive for this account; never query that turn.
    const visibleAgentSessions = durableCommands.length ? await ctx.agent.listSessions({ schemaVersion: 2 }).then(
      result => new Set(result.sessions.map(session => session.sessionId)), () => null) : new Set<string>();
    const orphanIds = savedCommands
      .filter((item) => item?.status === "running" && typeof item.id === "string")
      .map((item) => item.id);
    await repository.recoverInterruptedCommandHistory(new Set([...activeCommandRuns.keys(), ...durableCommands.map(item => item.id)]));
    if (visibleAgentSessions) {
      await repository.recoverUnavailableAgentResults(new Set(durableCommands
        .filter(item => !visibleAgentSessions.has(item.agentSessionId!) && !activeCommandRuns.has(item.id))
        .map(item => item.id)));
    }
    for (const taskId of orphanIds) {
      if (!activeCommandRuns.has(taskId) && !durableCommands.some(item => item.id === taskId)) commandLifecycleTrace("orphan_recovered", taskId);
    }
    const pendingAgentAdmissions = await pendingAdmissions.list().catch(() => []);
    await repository.markUnconfirmedAgentAdmissions(pendingAgentAdmissions.map(item => item.taskId));
    const stored = await repository.load();
    let recognitionEngineChoice = stored.recognitionEngineChoice;
    const firstRecognitionSetup = stored.recognitionSetupPending;
    state = {
      ...state,
      developerMode: false,
      recognitionSetupRequired: firstRecognitionSetup && !recognitionEngineChoice,
      recognitionSetupBusy: false,
      recognitionSetupError: undefined,
      settings: stored.settings ?? { ...DEFAULT_SETTINGS },
      featureSettings: stored.featureSettings,
      agentExperiment: stored.agentExperiment ?? { ...DEFAULT_AGENT_EXPERIMENT },
      conversationOptions: stored.conversationOptions,
      history: stored.history ?? [],
      commandHistory: stored.commandHistory ?? [],
      agentWaits: [],
      dayDigests: stored.dayDigests,
      notice: stored.sourceMigrationNotice,
      ...(visibleAgentSessions === null ? { error: t("chat.taskListUnavailable") } : {}),
    };
    if (stored.boardSourceMigrationPending) {
      try {
        await repository.beginBoardSourceMigration();
        // v2 迁移故意不带 legacySourceMigration：Host v1 已完成时，那个 hint 会保留
        // 旧 SystemDevice，正好违背“默认走键盘私有协议”的产品裁定。
        await configuration.apply(state.settings);
        await repository.completeBoardSourceMigration(state.settings);
        state = { ...state, notice: SOURCE_MIGRATION_NOTICE };
      } catch {
        // journal 保留；下一次激活继续修复，不让半提交变成永久分裂。
      }
    } else if (stored.legacySourceMigration) {
      try {
        await configuration.apply({
          ...state.settings,
          legacySourceMigration: true,
        });
        await repository.completeSourceMigration(state.settings);
      } catch {
        // 迁移失败不阻断官方 Voice 激活；marker 保留，下一次激活继续尝试。
      }
    }

    const publish = (patch: Partial<VoiceViewState>) => {
      if (patch.timeline && (patch.timeline.state !== state.timeline?.state
        || patch.timeline.unavailableReason !== state.timeline?.unavailableReason)) {
        // State-only evidence for startup/lease recovery. Never log speech,
        // account identifiers, tokens or recording contents here.
        console.info("[Voice timeline]", JSON.stringify({ state: patch.timeline.state,
          reason: patch.timeline.unavailableReason ?? null, sourceReady: patch.sourceReady,
          route: patch.timeline.route, cacheHealth: patch.timeline.cacheHealth }));
      }
      // 失败主句按展示时的开发者模式求值：只保留我们显式写的 getter，不凭文字判断身份。
      const presented = (["error", "statusLoadError", "recognitionSetupError"] as const).map((field) => [field,
        Object.hasOwn(patch, field) ? Object.getOwnPropertyDescriptor(patch, field) : Object.getOwnPropertyDescriptor(state, field)] as const);
      state = { ...state, ...patch };
      for (const [field, descriptor] of presented) if (descriptor?.get) Object.defineProperty(state, field, { ...descriptor, enumerable: true, configurable: true });
      // §6.0：换了 error 却没带 errorDetail 的更新清掉旧诊断，不让它挂到另一条错误上。
      if (Object.hasOwn(patch, "error") && !Object.hasOwn(patch, "errorDetail")) delete state.errorDetail;
      if (Object.hasOwn(patch, "statusLoadError") && !Object.hasOwn(patch, "statusLoadErrorDetail")) delete state.statusLoadErrorDetail;
      if (Object.hasOwn(patch, "recognitionSetupError") && !Object.hasOwn(patch, "recognitionSetupErrorDetail")) delete state.recognitionSetupErrorDetail;
      // 键盘连续收音时持有采集消费者（片段前补），切到电脑麦或时间线不可读时立即交还；与全天存档开关无关。
      voiceClipCapture?.setWanted(voiceClipWantKey(state));
      for (const listener of listeners) listener(state);
    };

    /**
     * §6.0 失败出口：主句（本地化、随语言切换，只在插件自己的界面）+ 诊断（步骤键与结构化字段；
     * 原文只随界面状态留在内存）。用 Object.assign 追加其他字段，保住 error 的 getter。
     */
    const failurePatch = (step: string, cause: unknown, message?: () => string | undefined) => ({
      get error() { return message?.() ?? readableError(cause); },
      errorDetail: errorDetailFrom(step, cause,
        trustedDiagnosticFields(cause) ? { fields: trustedDiagnosticFields(cause)! } : {}),
    });

    /**
     * 全天存档写入代次：开始写、写完（成功或失败）各推进一次。状态读数发出后代次变了，
     * 或者写入还没确认，读回来的存档位可能是旧的——只沿用当前已确认的存档位，
     * 时间线其余字段照常采用新读数（旧读数不能把刚确认的开关盖回去）。
     */
    let archiveRevision = 0;
    let archiveDesired: boolean | undefined;
    let archiveWriting = false;
    /** 每份状态读数发出时的存档代次；发布前凭它再核一次（调用方读完后可能还要等别的请求）。 */
    const statusArchiveRevision = new WeakMap<VoiceInputStatus, number>();
    const withConfirmedArchive = (status: VoiceInputStatus): VoiceInputStatus => {
      const revision = statusArchiveRevision.get(status);
      if (revision === undefined || (revision === archiveRevision && !archiveWriting)
        || !status.timeline || !state.timeline) return status;
      const reconciled = {
        ...status,
        timeline: {
          ...status.timeline,
          continuousRecordingEnabled: state.timeline.continuousRecordingEnabled,
          recordingState: state.timeline.recordingState,
        },
      };
      statusArchiveRevision.set(reconciled, revision);
      return reconciled;
    };
    /** 开录回执回带的单次上限：与已知值不同才发布（旧 Host 不回，保留状态读数的结论）。 */
    const noteCaptureLimit = (result: VoiceInputResult) => {
      const seconds = validCaptureLimitSeconds(result.captureLimitSeconds);
      if (seconds !== undefined && seconds !== state.captureLimitSeconds) publish({ captureLimitSeconds: seconds });
    };
    /** 读 Host 语音状态：返回时先核一次存档代次；发布处用 `withConfirmedArchive` 再核一次。 */
    const readVoiceStatus = async (sessionId?: string): Promise<VoiceInputStatus> => {
      const revision = archiveRevision;
      const status = await ctx.voiceInput.getStatus(sessionId);
      // 切片口径只增不减：带 sessionId 的读数缺这一项时不清掉已知值。
      if (typeof status.captureModel === "string" && status.captureModel !== state.captureModel) {
        publish({ captureModel: status.captureModel });
      }
      statusArchiveRevision.set(status, revision);
      return withConfirmedArchive(status);
    };

    /**
     * 本次运行里历史条目的失败原文表（只在内存，最多 32 条）：给插件界面主动展开用，
     * 不落盘、不复制、不进浮层（§6.0 白名单）。返回合并后的新表，交给 publish。
     */
    const withFailureRaw = (entries: Record<string, string | undefined>): Readonly<Record<string, string>> => {
      const next: Record<string, string> = { ...(state.failureRaw ?? {}) };
      for (const [key, raw] of Object.entries(entries)) {
        if (!raw) continue;
        delete next[key];
        next[key] = raw;
      }
      const keys = Object.keys(next);
      for (const key of keys.slice(0, Math.max(0, keys.length - 32))) delete next[key];
      return next;
    };

    /**
     * 收尾段（或已离开录音槽的命令）的状态发布：不能动此刻正在录的那一段。
     *
     * 胶囊叠放（Host `asyncFinish`）下，上一段还在识别 / 写回时下一段可能已经开录；旧段收尾
     * 发出的「回到 idle」只能落在它自己的字段上：另一段占着录音槽（在准备、在录、或正等结束回执）
     * 时，它的 `phase` / `commandPhase` / `dictationPhase` 连同 `activeMode` / `sessionId` 留给它。
     * `owner` 是发布方自己占录音槽时的会话（同步收尾在结束回执那一刻记下 `state.sessionId`，Host
     * 没回 sessionId 时也认得）：录音槽此刻仍归它就原样放行，旧 Host 行为不变。保留 getter（本地化
     * 文案随语言切换）。
     */
    /** 发布方占录音槽时的会话身份（见 settledPatch）。 */
    type VoiceSlotOwner = { readonly sessionId: string | undefined };
    const settledPatch = <P extends Partial<VoiceViewState>>(patch: P, owner?: VoiceSlotOwner): P => {
      if (owner && state.sessionId === owner.sessionId) return patch;
      const inputLive = state.phase === "listening" || state.phase === "recognizing";
      const commandLive = state.commandPhase === "preparing" || state.commandPhase === "listening"
        || state.commandPhase === "recognizing";
      const dictationLive = state.dictationPhase !== "idle";
      if (!inputLive && !commandLive && !dictationLive) return patch;
      const next = Object.defineProperties({}, Object.getOwnPropertyDescriptors(patch)) as P;
      const drop = (key: keyof VoiceViewState) => { delete (next as Partial<VoiceViewState>)[key]; };
      if (inputLive) { drop("phase"); drop("activeMode"); drop("sessionId"); }
      if (commandLive) { drop("commandPhase"); drop("activeMode"); drop("sessionId"); }
      if (dictationLive) { drop("dictationPhase"); drop("sessionId"); }
      return next;
    };

    /** 上一次语音操作还没结束：插件自有码 + 说清是哪一种在途操作（不再只说「请稍等」）。 */
    const operationInProgressError = () => new VoiceAppError({
      code: "com.reai.voice/VOICE_OPERATION_IN_PROGRESS",
      get userMessage() { return t("app.thePreviousStepIsNotFinishedYet"); },
      retryable: true,
      cause: {
        diagnostic: toggleInFlight
          ? "voice toggle in flight (start / finish dictation)"
          : "voice service operation in flight (request-text)",
      },
    }, undefined, { constantMessage: true });

    /** 所有命令处理函数都包这一层：失败交回 SDK 时只给登记码与固定文案（见 commandWireError）。 */
    const guardCommand = <I = unknown, O = unknown>(handler: CommandHandler<I, O>): CommandHandler<I, O> =>
      async (invocation) => {
        try {
          return await handler(invocation);
        } catch (cause) {
          throw commandWireError(cause);
        }
      };

    // Host（App）版本：只在 Voice 页可见时读（§6.0 ⑨，system.tasks@1 已声明，不扩能力）。
    const hostVersionReader = new HostVersionReader({
      read: () => ctx.systemTasks.getVersionStatus(),
      publish: (hostVersion) => publish({ hostVersion }),
    });
    disposeHostVersion = () => hostVersionReader.dispose();

    // Subscribe only after publish is initialized. Events can arrive while the
    // initial snapshot is in flight; the SDK preserves the newest value.
    ctx.environment.onChange((environment) => {
      setVoiceDeveloperMode(environment.developerMode);
      publish({ developerMode: environment.developerMode });
    });
    // SDK environment.get() 按 revision 返回最新快照，迟到读取不会覆盖开关事件。
    const environment = await ctx.environment.get().catch(() => ({ developerMode: false }));
    setVoiceDeveloperMode(environment.developerMode);
    publish({ developerMode: environment.developerMode });


    const publishRunningAgentCards = (taskId: string) => {
      const run = activeCommandRuns.get(taskId);
      const cards = commandAgentCards.get(taskId) ?? [];
      if (!run) return;
      const item: VoiceCommandHistoryItem = {
        id: taskId,
        transcript: run.transcript,
        commandId: run.commandId,
        status: "running",
        createdAt: run.createdAt,
        ...(run.agentSessionId ? { agentSessionId: run.agentSessionId } : {}),
        ...(run.conversationId ? { conversationId: run.conversationId } : {}),
        ...(run.runId ? { runId: run.runId } : {}),
        messages: [
          { from: "user", text: run.transcript, at: run.createdAt, attachments: run.inputAttachments },
          ...cards.map((card) => ({ from: "ai" as const, text: "", at: new Date().toISOString(), card })),
        ],
      };
      publish({
        commandHistory: [item, ...state.commandHistory.filter((entry) => entry.id !== taskId)],
      });
    };

    const withOtherRunningCommands = (
      persisted: VoiceCommandHistoryItem[],
      settlingTaskId: string,
    ): VoiceCommandHistoryItem[] => {
      const live = state.commandHistory.filter((item) =>
        item.status === "running" && item.id !== settlingTaskId);
      const liveIds = new Set(live.map((item) => item.id));
      return [...live, ...persisted.filter((item) => !liveIds.has(item.id))];
    };

    // Agent Session 事件带精确 turnId；Pi 与 DSH 都走同一投影，不靠“当前最后一个任务”猜。
    // 工具卡按 callId 聚合进每任务一张“联网操作”卡（链④）：折叠=次数+状态摘要，
    // 展开=逐次调用明细（含失败重试），失败不再被后续成功覆盖抹除。
    type ToolGroupCard = Extract<VoiceChatCard, { kind: "tool-group" }>;
    const commandToolCallStarts = new Map<string, number>();
    const commandToolCallOrdinals = new Map<string, number>();
    const commandToolUnended = new Map<string, Set<number>>();
    const commandToolFailedCallIds = new Map<string, Set<string>>();
    const commandToolLatestSuccess = new Map<string, Partial<Record<WebToolName, number>>>();
    const countFailedToolCall = (taskId: string, callId: string | undefined, card: ToolGroupCard) => {
      if (!callId || !commandToolCallOrdinals.has(`${taskId}:${callId}`)) return;
      const counted = commandToolFailedCallIds.get(taskId) ?? new Set<string>();
      if (counted.has(callId)) return;
      counted.add(callId);
      commandToolFailedCallIds.set(taskId, counted);
      card.failedCalls = (card.failedCalls ?? 0) + 1;
    };
    const mutateToolGroupCard = (taskId: string, mutate: (card: ToolGroupCard) => void) => {
      const cards = commandAgentCards.get(taskId) ?? [];
      const existing = cards.find((card): card is ToolGroupCard => card.kind === "tool-group");
      if (existing) {
        mutate(existing);
        return;
      }
      const created: ToolGroupCard = {
        kind: "tool-group",
        status: "running",
        // 落盘与列表摘要用的一行纯文本；对话页按回合重新合成（含旧版卡、当前语言）。
        get label() { return toolProgressText(created); },
        calls: [],
        totalCalls: 0,
        failedCalls: 0,
        omittedCalls: 0,
      };
      mutate(created);
      commandAgentCards.set(taskId, [...cards.filter((card) => card.kind !== "tool"), created]);
    };
    const finalizeToolGroupCard = (taskId: string) => {
      const group = commandAgentCards.get(taskId)?.find((card): card is ToolGroupCard => card.kind === "tool-group");
      if (!group) return;
      for (const call of group.calls) {
        if (call.status === "running") {
          call.status = "unknown";
        }
      }
      // 工具组终态独立判断：联网失败账本之外，任一工具最后一次调用失败（没有成功重试）也判红；
      // 命令整体结果与联网专属失败记账不受影响。
      group.status = pendingWebToolError(taskId) || unresolvedToolFailure(group.calls) ? "failed"
        : (commandToolUnended.get(taskId)?.size ?? 0) > 0 ? "unknown" : "completed";
    };
    // A durable terminal summary can repair gaps in progress replay. Merge by
    // native call ID so reopening never invents another tool invocation.
    const capToolCalls = (card: ToolGroupCard) => {
      if (card.calls.length <= MAX_TOOL_CALL_ENTRIES_PER_CARD) return;
      const before = card.calls.length;
      card.calls = trimToolCalls(card.calls, MAX_TOOL_CALL_ENTRIES_PER_CARD);
      card.omittedCalls = (card.omittedCalls ?? 0) + before - card.calls.length;
    };
    // 已被明细上限裁掉的调用又收到结果时按序号补回原位置（结果不能因为展示裁剪丢失），调用方随后再裁。
    const toolCallRow = (taskId: string, card: ToolGroupCard, callId: string, tool: string, startedAt?: number) => {
      const existing = card.calls.find((entry) => entry.callId === callId);
      const ordinal = commandToolCallOrdinals.get(`${taskId}:${callId}`);
      if (existing || ordinal === undefined) return existing;
      const row: ToolGroupCard["calls"][number] = { callId, tool, status: "running", at: startedAt === undefined ? "" : new Date(startedAt).toISOString() };
      const after = card.calls.findIndex((entry) => (entry.callId
        ? commandToolCallOrdinals.get(`${taskId}:${entry.callId}`) ?? 0 : 0) > ordinal);
      card.calls.splice(after < 0 ? card.calls.length : after, 0, row);
      card.omittedCalls = Math.max(0, (card.omittedCalls ?? 0) - 1);
      return row;
    };
    const reconcileToolAttempts = (taskId: string, attempts: AgentToolAttempt[]) => {
      // Ledger summaries are keyed by call ID, not necessarily chronological.
      const ordered = [...attempts].sort((a, b) =>
        (hostToolTime(a.startedAt) ?? hostToolTime(a.finishedAt) ?? Number.MAX_SAFE_INTEGER)
        - (hostToolTime(b.startedAt) ?? hostToolTime(b.finishedAt) ?? Number.MAX_SAFE_INTEGER));
      for (const attempt of ordered) {
        if (!attempt.callId || !isToolName(attempt.toolName)) continue;
        const callId = attempt.callId, toolName = attempt.toolName;
        const webAccess = isWebAccessTool(toolName);
        const key = `${taskId}:${callId}`;
        const start = hostToolTime(attempt.startedAt);
        let ordinal = commandToolCallOrdinals.get(key);
        mutateToolGroupCard(taskId, card => {
          let call = card.calls.find(entry => entry.callId === callId);
          if (ordinal === undefined) {
            ordinal = (card.totalCalls ?? card.calls.length) + 1;
            commandToolCallOrdinals.set(key, ordinal);
            card.totalCalls = ordinal;
          }
          // 已记过但被明细上限裁掉的调用也补回来：终态结果不能因为展示裁剪丢失；收尾按时间排序后再裁。
          if (!call) {
            call = { callId, tool: toolName, status: "unknown", at: start === undefined ? "" : new Date(start).toISOString() };
            card.calls.push(call);
          }
          const unended = commandToolUnended.get(taskId) ?? new Set<number>();
          if (attempt.status === "unknown") unended.add(ordinal);
          else unended.delete(ordinal);
          commandToolUnended.set(taskId, unended);
          if (attempt.status === "failed") countFailedToolCall(taskId, callId, card);
          else if (attempt.status === "completed" && commandToolFailedCallIds.get(taskId)?.delete(callId)) {
            card.failedCalls = Math.max(0, (card.failedCalls ?? 0) - 1);
          }
          if (call) {
            call.status = attempt.status;
            if (start !== undefined) call.at = new Date(start).toISOString();
            const duration = hostToolTime(attempt.durationMs)
              ?? hostToolElapsed(start, hostToolTime(attempt.finishedAt));
            if (duration !== undefined) call.durationMs = duration;
            if (attempt.status === "completed") { delete call.errorLabel; delete call.errorCode; }
            else if (attempt.errorCode) {
              call.errorLabel = presentAgentToolError(attempt.errorCode, { code: attempt.errorCode, message: "" }).message;
              // 真实码随明细落盘：命令诊断的「对象状态」逐条列出失败 / 未结束的联网调用。
              call.errorCode = attempt.errorCode;
            }
          }
        });
        commandToolCallStarts.delete(key);
        if (!webAccess) continue;
        if (attempt.status === "completed") {
          const latest = commandToolLatestSuccess.get(taskId) ?? {};
          latest[toolName] = Math.max(latest[toolName] ?? 0, ordinal!);
          commandToolLatestSuccess.set(taskId, latest);
          // Terminal summaries are processed in Host time order. An earlier
          // missing call may have a newer UI ordinal, so ordinals cannot decide
          // which terminal attempt is the successful retry.
          const unresolved = (commandAgentToolErrors.get(taskId) ?? [])
            .filter(failure => failure.tool !== toolName);
          if (unresolved.length) commandAgentToolErrors.set(taskId, unresolved);
          else commandAgentToolErrors.delete(taskId);
        } else if (attempt.status === "failed" && attempt.errorCode) {
          commandAgentToolErrors.set(taskId, [
            ...(commandAgentToolErrors.get(taskId) ?? []).filter(failure => failure.tool !== toolName),
            { code: attempt.errorCode, tool: toolName, ordinal: ordinal! },
          ]);
        }
      }
      const group = commandAgentCards.get(taskId)?.find((card): card is ToolGroupCard => card.kind === "tool-group");
      if (group) {
        group.calls.sort((a, b) => (hostToolTime(Date.parse(a.at)) ?? Number.MAX_SAFE_INTEGER)
          - (hostToolTime(Date.parse(b.at)) ?? Number.MAX_SAFE_INTEGER));
        group.calls = trimToolCalls(group.calls, MAX_TOOL_CALL_ENTRIES_PER_CARD);
        group.omittedCalls = (group.totalCalls ?? group.calls.length) - group.calls.length;
      }
    };
    /** F02/F04：某段对话的选择正在保存；期间不起新回合、不再次改选。 */
    const conversationChanges = new Set<string>();
    let followUpAdmissionInFlight = false;
    const agentTurns = createVoiceAgentTurns(ctx.agent, (taskId, event) => {
      if (!taskId || !activeCommandRuns.has(taskId)) return;
      if (event.type === "approval.requested" || event.type === "approval.resolved") {
        // F03：只呈现「等待 Host 确认」状态；批准入口在 Host 主窗口，这里没有按钮。
        publish({ agentApprovals: [...(state.agentApprovals ?? []).filter((item) => item.id !== event.id), event] });
        return;
      }
      if (event.type === "wait.started" || event.type === "wait.ended") {
        // 回合在等你拍板（启用浏览器插件、越界确认……）：Host 期间不计超时。对话页显示在等什么、
        // 已等多久；胶囊由本插件自己呈现（caller），等人旗只能由这次运行的帧带上。
        if (typeof event.waitId !== "string" || !event.waitId) return;
        // 身份是「回合 + 等待 id」：两个回合各自的 wait-1 互不覆盖。
        const key = userWaitKey(taskId, event.waitId);
        if (event.type === "wait.started" && endedUserWaits.has(key)) return;
        if (event.type === "wait.ended") endedUserWaits.add(key);
        const label = event.type === "wait.started" && typeof event.label === "string" ? event.label.trim() : "";
        const reason = typeof event.reason === "string" ? event.reason : "";
        const others = (state.agentWaits ?? []).filter((wait) => !(wait.taskId === taskId && wait.waitId === event.waitId));
        publish({
          agentWaits: event.type === "wait.started"
            ? [...others, {
              taskId,
              waitId: event.waitId,
              reason,
              label,
              startedAt: Number.isFinite(event.startedAt) && event.startedAt > 0 ? event.startedAt : Date.now(),
            }]
            : others,
        });
        commandUserWaitHandlers.get(taskId)?.(event.type, event.waitId, reason, label);
        return;
      }
      // 同一回合的全部工具都进过程折叠；安装提示与联网失败归并只看联网两工具。
      const isToolEvent = (event.type === "tool.start" || event.type === "tool.end" || event.type === "tool.outcome")
        && isToolName(event.toolName);
      const isWebTool = isToolEvent && isWebAccessTool(event.toolName);
      if (event.type === "tool.start" && isToolEvent) {
        const callId = typeof event.callId === "string" && event.callId ? event.callId : undefined;
        const startedAt = hostToolTime(event.timestamp);
        const toolName = event.toolName;
        let ordinal = 0;
        mutateToolGroupCard(taskId, (card) => {
          ordinal = (card.totalCalls ?? card.calls.length) + 1;
          card.totalCalls = ordinal;
          card.calls.push({ ...(callId ? { callId } : {}), tool: toolName, status: "running", at: startedAt === undefined ? "" : new Date(startedAt).toISOString() });
          // 没解决的失败、在途调用、每个工具最近一次调用优先保留：结果不会因为明细上限落空。
          capToolCalls(card);
          card.status = "running";
        });
        const unended = commandToolUnended.get(taskId) ?? new Set<number>();
        unended.add(ordinal);
        commandToolUnended.set(taskId, unended);
        if (callId) {
          const key = `${taskId}:${callId}`;
          if (startedAt !== undefined) commandToolCallStarts.set(key, startedAt);
          commandToolCallOrdinals.set(key, ordinal);
        }
        publishRunningAgentCards(taskId);
        const progressGroup = commandAgentCards.get(taskId)?.find((card): card is ToolGroupCard => card.kind === "tool-group");
        if (progressGroup) commandProgressHandlers.get(taskId)?.(toolProgressText(progressGroup));
        // While the original tool waits for installation, expose the same
        // install action in its conversation as well as the Host notification.
        if (isWebTool) void ctx.apps.status({ appId: "com.reai.browser" }).then((dependency) => {
          if (dependency.installed && dependency.enabled) return;
          if (!activeCommandRuns.has(taskId)) return;
          // 状态快照可能晚于工具结果返回；只能为仍在等待的原调用显示安装提示。
          if (!commandToolUnended.get(taskId)?.has(ordinal)) return;
          const current = commandAgentCards.get(taskId) ?? [];
          const group = current.find((card): card is ToolGroupCard => card.kind === "tool-group");
          if (!group || group.status !== "running") return;
          const card = presentAgentToolError("browser_plugin_required", { code: "browser_plugin_required", message: "" }).card;
          if (card) {
            commandAgentCards.set(taskId, [...current.filter((entry) => entry.kind !== "capability-required"), card]);
            publishRunningAgentCards(taskId);
          }
        }).catch(() => undefined);
      }
      if (event.type === "tool.end" && isToolEvent) {
        const callId = typeof event.callId === "string" && event.callId ? event.callId : undefined;
        const key = callId ? `${taskId}:${callId}` : undefined;
        const startedAt = key ? commandToolCallStarts.get(key) : undefined;
        const ordinal = key ? commandToolCallOrdinals.get(key) : undefined;
        if (key) commandToolCallStarts.delete(key);
        if (ordinal !== undefined) commandToolUnended.get(taskId)?.delete(ordinal);
        const toolName = event.toolName;
        let successfulEnd = false;
        mutateToolGroupCard(taskId, (card) => {
          // 旧 runtime 无 ID 时不按同名工具猜归属；只保留未能确认的明细。
          const call = callId ? toolCallRow(taskId, card, callId, toolName, startedAt) : undefined;
          if (call) {
            const failed = event.isError || !!call.errorLabel;
            if (failed) countFailedToolCall(taskId, callId, card);
            call.status = failed ? "failed" : "completed";
            const duration = hostToolElapsed(startedAt, hostToolTime(event.timestamp));
            if (duration !== undefined) call.durationMs = duration;
            successfulEnd = !failed;
          }
          if (event.isError && !call) countFailedToolCall(taskId, callId, card);
          capToolCalls(card);
          // 任务仍在跑；一次工具失败只留在明细中，不让摘要闪红后又变绿。
          card.status = "running";
        });
        if (successfulEnd && ordinal !== undefined && isWebAccessTool(toolName)) {
          const latest = commandToolLatestSuccess.get(taskId) ?? {};
          latest[toolName] = Math.max(latest[toolName] ?? 0, ordinal);
          commandToolLatestSuccess.set(taskId, latest);
          const unresolved = (commandAgentToolErrors.get(taskId) ?? [])
            .filter((failure) => failure.tool !== toolName || failure.ordinal >= ordinal);
          if (unresolved.length) commandAgentToolErrors.set(taskId, unresolved);
          else commandAgentToolErrors.delete(taskId);
        }
        // 安装提示卡随首次联网结果收掉：工具已真实返回（无论成败）。
        const current = commandAgentCards.get(taskId) ?? [];
        if (isWebTool && current.some((card) => card.kind === "capability-required")) {
          commandAgentCards.set(taskId, current.filter((card) => card.kind !== "capability-required"));
        }
        publishRunningAgentCards(taskId);
        const progressGroup = commandAgentCards.get(taskId)?.find((card): card is ToolGroupCard => card.kind === "tool-group");
        if (progressGroup) commandProgressHandlers.get(taskId)?.(toolProgressText(progressGroup));
      }
      if (event.type === "tool.outcome" && isToolEvent) {
        const toolName = event.toolName;
        // 稳定错误码回填到对应调用的明细行；Host 两种顺序都可能出现。
        const callId = typeof event.callId === "string" && event.callId ? event.callId : undefined;
        const ordinal = callId ? commandToolCallOrdinals.get(`${taskId}:${callId}`) : undefined;
        if (callId) {
          mutateToolGroupCard(taskId, (card) => {
            const call = toolCallRow(taskId, card, callId, toolName, commandToolCallStarts.get(`${taskId}:${callId}`));
            if (call) {
              call.status = "failed";
              call.errorLabel = presentAgentToolError(event.errorCode, { code: event.errorCode, message: "" }).message;
              if (typeof event.errorCode === "string" && event.errorCode) call.errorCode = event.errorCode;
            }
            countFailedToolCall(taskId, callId, card);
            capToolCalls(card);
            card.status = "running";
          });
          publishRunningAgentCards(taskId);
        }
        const failureOrdinal = ordinal ?? Number.MAX_SAFE_INTEGER;
        if (isWebAccessTool(toolName) && (commandToolLatestSuccess.get(taskId)?.[toolName] ?? 0) <= failureOrdinal) {
          commandAgentToolErrors.set(taskId, [
            ...(commandAgentToolErrors.get(taskId) ?? []),
            { code: event.errorCode, tool: toolName, ordinal: failureOrdinal },
          ]);
        }
      }
    }, pendingAdmissions);

    ctx.events.onLocalAgent(agentTurns.onEvent);

    const releaseForegroundCommand = (
      taskId: string,
      patch: Partial<VoiceViewState> = {},
    ): boolean => {
      if (activeForegroundTaskId !== taskId) return false;
      activeForegroundTaskId = undefined;
      // 胶囊叠放下前台命令收尾时下一段可能已经开录：录音槽归属留给它。
      publish(settledPatch({
        commandPhase: "idle",
        activeMode: undefined,
        sessionId: undefined,
        ...patch,
      }));
      return true;
    };

    let commandAgentSessionLedger = stored.commandAgentSessionLedger;
    const registerCommandAgentSession = async (sessionId: string, createdMs = Date.now()) => {
      commandAgentSessionLedger = await repository.registerCommandAgentSession(sessionId, createdMs);
    };
    const removeCommandAgentSession = async (sessionId: string) => {
      commandAgentSessionLedger = await repository.removeCommandAgentSession(sessionId);
    };
    const deleteOwnedCommandAgentSession = async (sessionId: string) => {
      try {
        await ctx.agent.deleteSession({ sessionId });
        await removeCommandAgentSession(sessionId);
      } catch (cause) {
        if (normalizedError(cause).code === "AGENT_SESSION_NOT_FOUND") {
          await removeCommandAgentSession(sessionId);
          return;
        }
        throw cause;
      }
    };
    const reconcileCommandAgentSessions = async () => {
      // 对账开始前冻结台账快照。否则 listSessions 在途时新命令刚建出的会话可能
      // 被旧 Host 快照误判为“不存在”，台账被删掉后就再也无法安全回收。
      const ledgerSnapshot = [...commandAgentSessionLedger];
      let sessions: Awaited<ReturnType<typeof ctx.agent.listSessions>>["sessions"];
      try {
        const [legacy, current] = await Promise.all([
          ctx.agent.listSessions(), ctx.agent.listSessions({ schemaVersion: 2 }),
        ]);
        sessions = [...new Map([...legacy.sessions, ...current.sessions].map(item => [item.sessionId, item])).values()];
      } catch (cause) {
        console.warn("[voice] 命令 Agent 会话对账失败", diagnosticLogFields(cause));
        return;
      }
      const visible = new Set(
        state.commandHistory
          .map((item) => item.agentSessionId)
          .filter((sessionId): sessionId is string => typeof sessionId === "string"),
      );
      const plan = planCommandAgentSessionReconciliation({
        ledger: ledgerSnapshot,
        hostSessions: sessions,
        visibleSessionIds: visible,
        activeSessionIds: new Set(
          [...activeCommandRuns.values()]
            .map((run) => run.agentSessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === "string"),
        ),
        processStartedAt,
      });
      for (const sessionId of plan.forgetSessionIds) {
        await removeCommandAgentSession(sessionId).catch(() => undefined);
      }
      for (const sessionId of plan.deleteSessionIds) {
        await deleteOwnedCommandAgentSession(sessionId).catch((cause) => {
          console.warn("[voice] 回收不可见命令 Agent 会话失败", diagnosticLogFields(cause));
        });
      }
    };
    void reconcileCommandAgentSessions();

    const releaseTrimmedCommandAgentSessions = async (
      previous: VoiceCommandHistoryItem[],
      next: VoiceCommandHistoryItem[],
    ) => {
      const remaining = new Set(
        [
          ...next.map((item) => item.agentSessionId),
          ...[...activeCommandRuns.values()].map((run) => run.agentSessionId),
        ]
          .filter((sessionId): sessionId is string => typeof sessionId === "string"),
      );
      const removed = new Set(
        previous
          .map((item) => item.agentSessionId)
          .filter(
            (sessionId): sessionId is string =>
              typeof sessionId === "string"
              && !remaining.has(sessionId)
              && commandAgentSessionLedger.some((item) => item.sessionId === sessionId),
          ),
      );
      for (const sessionId of removed) {
        await deleteOwnedCommandAgentSession(sessionId).catch((cause) => {
          console.warn("[voice] 回收已裁剪命令 Agent 会话失败", diagnosticLogFields(cause));
        });
      }
    };

    const recoverableHistoryItem = (
      session: RecoverableVoiceInputSession,
    ): VoiceHistoryItem => ({
      id: `recoverable-${session.sessionId}`,
      transcript: session.transcript?.trim() ?? "",
      language: "auto",
      source: session.source === "System" ? "system" : "board",
      inserted: false,
      durationMs: Math.max(0, session.requestedEndMs - session.requestedStartMs),
      createdAt: new Date(session.requestedStartMs).toISOString(),
      requestedEngine: session.requestedEngine ?? undefined,
      ...(session.attempt?.state === "complete" ? { recognitionEngine: session.attempt.selection.engine } : {}),
      ...(session.transcriptionStatus === "complete" ? {} : { transcriptionStatus: session.transcriptionStatus === "pending" ? "pending" : session.transcriptionStatus === "failed" ? "failed" : "not_requested" }),
      ...(session.stopReason === "user_cancel"
        || session.stopReason === "capture_limit"
        || session.stopReason === "source_unavailable"
        ? { stopReason: session.stopReason }
        : {}),
      recordingId: session.recordingId,
      recordingWallStartMs: session.effectiveStartMs,
      recordingDurationMs: Math.max(0, session.effectiveEndMs - session.effectiveStartMs),
    });

    let recoverablePollInFlight = false;
    let recoverablePollAt = 0;
    const syncRecoverableInputSessions = async () => {
      if (recoverablePollInFlight) return;
      recoverablePollInFlight = true;
      recoverablePollAt = Date.now();
      const historyGeneration = repository.historyGeneration;
      try {
        // 每轮只读一次 journal 快照：隐藏运行时不再节流后，这轮扫描每秒都会跑。
        let selections: Map<string, SavedInputSelection> | undefined;
        for (let index = 0; index < 4; index++) {
          const page = await ctx.voiceRecordings.listRecoverableInputSessions({ page: index, perPage: 50, includeSettledRetries: true });
          if (historyGeneration !== repository.historyGeneration) return;
          if (page.items.length > 0 && !selections) {
            selections = await inputSelections.snapshot();
            if (historyGeneration !== repository.historyGeneration) return;
          }
          for (const session of page.items) {
            const originalSelection = selections?.get(session.sessionId);
            const existing = state.history.find(item => item.recordingId === session.recordingId);
            if (existing) {
              const needsIntent = existing.transcriptionStatus && session.requestedEngine != null && existing.requestedEngine !== session.requestedEngine;
              if ((!session.attempt || session.attempt.revision <= (existing.savedInput?.revision ?? 0)) && (!originalSelection || existing.originalSelection) && !needsIntent) continue;
              const history = await repository.updateHistoryItem(existing.id, item => projectSavedInputSession({
                ...item, originalSelection: item.originalSelection ?? originalSelection,
                ...(item.transcriptionStatus ? { requestedEngine: session.requestedEngine ?? item.requestedEngine } : {}),
              }, session));
              publish({ history });
            } else {
              const history = await repository.restoreHistoryItem(projectSavedInputSession({ ...recoverableHistoryItem(session), originalSelection }, session), historyGeneration);
              publish({ history });
            }
          }
          if ((index + 1) * 50 >= page.total) break;
        }
      } catch {
        // Host 版本较旧或权限暂不可用时静默等待下一轮，不拖垮 Voice 主界面。
      } finally {
        recoverablePollInFlight = false;
      }
    };
    void syncRecoverableInputSessions();
    let settingsSaveChain = Promise.resolve();
    const validateFreeOnlySelection = async (selection: { modelId: string; billingPolicy?: "free-only" }) => {
      try {
        await assertFreeOnlyCloudExecution(ctx.aiApi, selection.modelId, selection.billingPolicy);
      } catch (cause) {
        const code = normalizedError(cause).code;
        const upgradeRequired = code === "HOST_API_INCOMPATIBLE";
        throw new VoiceAppError({
          code: upgradeRequired ? "com.reai.voice/VOICE_HOST_UPGRADE_REQUIRED" : code,
          get userMessage() { return upgradeRequired
            ? t("service.hostUpgradeRequired") : t("view.cloudModelsUnavailable"); },
          retryable: true, cause,
        }, undefined, { constantMessage: true });
      }
    };
    type CloudSelection = { billingPolicy?: "free-only"; modelId: string; language: VoiceInputSettings["language"] };
    const requireCloudSelection = async (settings: VoiceInputSettings): Promise<CloudSelection> => ({
      modelId: await selectedCloudModel(),
      billingPolicy: state.featureSettings.cloudModelBillingPolicy,
      language: settings.language,
    });
    let toggleInFlight = false;
    // 胶囊叠放的后台收尾段（见 toggleInput 上方的说明）；服务预约要看它，所以登记在这里。
    const asyncSegments = new Map<string, AsyncVoiceSegment>();
    // 本次激活的生命周期：收尾任务都核对它。段收完尾就从表里撤掉，但它发出的呈现请求可能还在路上，
    // 停用时靠这一层一并中止。
    const asyncActivation = new AbortController();
    disposeAsyncSegments = () => {
      asyncActivation.abort();
      asyncSegments.clear();
      // 等待者随之静默退出、不会再刷新计数：这里直接清掉，重新激活时不留「识别中」。
      if (state.finalizingCount !== undefined) publish({ finalizingCount: undefined });
    };
    // 输入坞听写的起跑要经过 configure + toggle 两次 IPC。人在结果回来前离页时，
    // `dictationPhase` 仍是 idle，不能把取消请求当成“无事可做”丢掉；先记下，Host
    // 真正回 listening 的同一拍立刻 cancel，避免留下一场没有页面能收工的悬空录音。
    let dictationCancelRequested = false;
    // 写回目标只在录音**开始**那次 toggle 里返回；结束那次已经拿不到了，
    // 必须在这两次调用之间存住。云端引擎才用得到，本地路径不读它。
    let pendingDeliveryTarget: VoiceDeliveryTargetRef | undefined;
    // 「这段话要不要写回」的意图在**开始**那次 toggle 时冻住（页面测试按钮传 false）。
    // 识别与插入已解耦（Host API 1.22）：Host 一律收到 insertText:false 只出文本，
    // 写回统一由插件在润色之后经 delivery.commit 做；必须用开始时的意图，否则
    // 「页面按钮开始、硬件键结束」这类混合触发会写回一段本不该写回的测试录音。
    let pendingInsertText: boolean | undefined;
    // 润色档位同样必须在**录音开始**那次冻住：用户可能在说话途中改设置，
    // 上下文采集也是按开始时的档位决定做不做的。
    let pendingPolish: VoicePolishSetting = "raw";
    // 触发瞬间采下来的上下文。设计稿写的是「触发语音瞬间焦点窗口」——等说完再采，
    // 采到的很可能已经是另一个窗口了。存 Promise 而不是结果：采集与说话并行，
    // 不给收尾路径增加等待。
    let pendingContext: Promise<VoiceContextEnvelope | undefined> = Promise.resolve(undefined);
    // 输入法片段增强：按下那一刻已持有采集消费者时冻结其身份与按下时刻（否则 undefined = 走原流程）。
    let pendingClipPress: VoiceClipPressToken | undefined;
    /**
     * 写回权限被拒过。
     *
     * 写回一律由**插件**做（Host 收到 `insertText: false`），而 `voice.deliver@1` 是
     * 用户可以拒的可选权限。没有这个标志的话，拒过的用户会**每说一句写不进一句**：
     * Host 不写、插件也写不了。置位之后下一段在采集前拦住，设置页同时把原因说清楚；
     * 写回成功一次或用户重新挑一次润色档位（「开好了，再试」）就清掉。
     */
    let deliveryPermissionBlocked = false;

    /**
     * 润色上下文的可插拔 provider 注册表（拍板结论 6）。
     *
     * 三个源都在这里注册；加一个源只要再 `register` 一个 provider，
     * 组装、设置页与失败降级逻辑一行不用动。
     */
    const contextRegistry = createDefaultContextRegistry(
      { capture: (options) => ctx.voiceContext.capture(options) },
      {
        // 用时现拉，不读 `state.recordings`：那份缓存只在 Voice 界面挂载时才更新，
        // 而输入法的主场景是按硬件键说话——那时界面通常从没打开过，缓存恒为空。
        segments: async () => {
          const page = await ctx.voiceRecordings.list({ page: 0, perPage: 50 });
          return page.items;
        },
      },
    );

    // §5D 截图同意：独立于窗口文字，默认关闭；持久化在 Voice 私有 KV，
    // 不与 settings 双写。epoch 只信 Host 下发的 sessionEpoch，读不到即 fail-closed。
    const screenshotUses = new WeakMap<VoiceContextEnvelope, VoiceScreenshotGrant>();
    const screenshotConsentSaved = await repositoryStore.get("screenshot-consent");
    const screenshotConsent = new VoiceScreenshotConsent(
      {
        readEpoch: () => readVoiceAccountEpoch(ctx.voiceContext),
        save: (record: VoiceScreenshotConsentRecord) => repositoryStore.set("screenshot-consent", record),
        revoked: () => {
          publish({ screenshotConsent: { enabled: false } });
        },
      },
      screenshotConsentSaved,
    );
    const refreshScreenshotConsent = async () => {
      await screenshotConsent.refresh(enabled => publish({ screenshotConsent: { enabled } }));
    };
    await refreshScreenshotConsent();

    const assembleContext = async (
      sessionId?: string,
      signal?: AbortSignal,
    ): Promise<VoiceContextEnvelope | undefined> => {
      const { polishContext } = state.settings;
      // 截图只在「已同意 + 能取到当前代际 grant + 绑定原 session」时才进采集；
      // 窗口文字与截图互不干涉，关掉截图就一个字节图都不读。
      const screenshotGrant = sessionId !== undefined
        ? await screenshotConsent.grantFor(sessionId).catch(() => undefined)
        : undefined;
      const assembly = await contextRegistry.assemble({
        settings: {
          windowEnabled: polishContext.window,
          screenshotEnabled: screenshotGrant !== undefined,
          recentVoiceEnabled: polishContext.recentVoice,
          recentVoiceRangeMinutes: polishContext.recentVoiceRangeMinutes,
        },
        ...(screenshotGrant ? { screenshot: screenshotGrant } : {}),
        ...(signal ? { signal } : {}),
        now: Date.now(),
      });
      if (assembly.envelope?.images?.length && screenshotGrant) screenshotUses.set(assembly.envelope, screenshotGrant);
      return assembly.envelope;
    };

    /**
     * 跑一次润色。**永远不抛错**——失败就是「原样注入」，用户的输入不能因此停住。
     *
     * 这里的 `.catch` 不是防御性冗余：`polishTranscript` 承诺不抛，但一旦它哪天真的
     * 抛了，后果是用户说的话彻底消失（Host 已经被告知不要写回）。这条兜底就是让那句
     * 承诺**在调用侧也成立**。
     */
    const runPolish = async (
      level: VoicePolishSetting,
      transcript: string,
      context?: VoiceContextEnvelope,
      signal?: AbortSignal,
    ): Promise<VoicePolishOutcome> => {
      if (level === "raw") return { text: transcript, applied: false, changed: false };
      const screenshot = context && screenshotUses.get(context);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const parents = [signal, screenshot?.signal].filter((value): value is AbortSignal => value !== undefined);
      for (const parent of parents) { parent.addEventListener("abort", abort, { once: true }); if (parent.aborted) abort(); }
      if (screenshot && !screenshot.isCurrent()) abort();
      const operation = polishTranscript(
        {
          aiApi: ctx.aiApi,
          newId: () => crypto.randomUUID(),
        },
        { level, transcript, context, signal: controller.signal },
      );
      return operation.then((outcome): VoicePolishOutcome => {
        // 未登录 / 云端用不了：静默按原文，不算「润色失败」（2026-09-27 定稿）。
        if (!isPolishUnavailable(outcome.failure)) return outcome;
        const { failure: _unavailable, ...silent } = outcome;
        return silent;
      }).catch((cause) => {
        // R3：取消不是原文回退——取消的请求不交付也不计成功回退；其余失败仍回原文。
        if (isVoiceRequestInvalidated(cause)) throw cause;
        const failure = describePolishFailure(cause);
        return isPolishUnavailable(failure)
          ? { text: transcript, applied: false, changed: false }
          : {
              text: transcript,
              applied: false,
              changed: false,
              failure: { code: "POLISH_FAILED", get message() { return t("app.polishIsTemporarilyUnavailableTheOriginalTranscript"); } },
            };
      }).finally(() => { for (const parent of parents) parent.removeEventListener("abort", abort); });
    };

    /**
     * 只读探一次上下文能力：不带窗口文字，所以**一个字都不会被读走**。
     * 设置页拿它画真实徽标，而不是画一个可能不成立的「已授权」。
     *
     * 用户没开窗口上下文时**连探都不探**：那枚徽标根本不显示，为它去敲一次
     * 会被拒的能力口没有任何收益，只会在日志里堆一串没人要看的拒绝。
     */
    const probeContext = async (
      settings = state.settings,
    ): Promise<VoiceContextProbe | undefined> => {
      if (!settings.polishContext.window) return undefined;
      try {
        const capture = await ctx.voiceContext.capture({ includeWindowText: false });
        return { granted: true, screenRecording: capture.screenRecording };
      } catch {
        // 权限页没授权、能力未放行都会走这里。查不到就说查不到，不猜屏幕录制状态。
        return { granted: false, screenRecording: "denied" };
      }
    };

    let replayCacheSeq = 0;
    /**
     * 单独把「录音缓存」状态拉一次权威值。
     *
     * 本地那次并入只保证**刚录完的这条**立刻可听（缓存原本为空时下沿是 null）；
     * 它取 min，所以下沿只会往回走。而 Host 的下沿会随过期清理与配额淘汰**前移**——
     * 不追这一次，跨天或撑满 1 GiB 之后就会出现「播放条在、点了取不到件」。
     * 甩在文字交付之后，不占「松开到出字」。
     */
    const refreshReplayCache = async () => {
      // 连说两句时两次刷新可能乱序返回，落后的那份会把下沿拖回旧值。
      // 与 refresh() 的 expectedSessionId 同一套守卫：只认最后发出的那一次。
      const seq = ++replayCacheSeq;
      try {
        const replayCache = await ctx.voiceRecordings.replayCacheStatus();
        if (seq !== replayCacheSeq) return;
        publish({ replayCache });
      } catch {
        // 读不到就沿用上一次：这里不能把「读不到」当成「已过期」。
      }
    };

    let actionMountsSeq = 0;
    /**
     * C-3b：把「哪几条命令事件被挂到 Action 层」从 Host 拉回来（勾选态的真源）。
     *
     * `knownChange` 是刚刚成功落地的那次改动。回读失败时用它兜底——不然会出现
     * 「挂成功了但紧接着的 list 失败」→ 界面显示成未挂，而 Host 其实已经挂上，
     * 用户再点一下变成取消，等于把自己刚做的事撤了。
     */
    const refreshActionMounts = async (
      knownChange?: { commandId: string; mounted: boolean },
    ) => {
      // 连点两次（挂→马上卸）时两次回读可能乱序返回，落后的那份会把已经翻篇的
      // 勾选态写回界面。与 refresh() 的 expectedSessionId、refreshReplayCache 的
      // seq 同一类守卫：只认最后发出的那一次。
      const seq = ++actionMountsSeq;
      try {
        const mounts = await ctx.actionItems.list();
        if (seq !== actionMountsSeq) return;
        publish({
          mountedActionCommandIds: mounts
            .filter((mount) => mount.kind === "command")
            .map((mount) => mount.itemId),
        });
      } catch (cause) {
        // 读不到就保持上一次的勾选态：把它清空会让用户以为自己挂的东西掉了。
        console.warn("[voice] 读取 Action 层挂载失败", diagnosticLogFields(cause));
        if (seq !== actionMountsSeq) return;
        if (!knownChange) return;
        const rest = state.mountedActionCommandIds.filter((id) => id !== knownChange.commandId);
        publish({
          mountedActionCommandIds: knownChange.mounted
            ? [...rest, knownChange.commandId]
            : rest,
        });
      }
    };

    let agentsImStatusSeq = 0;
    // 不能只比较最终值：system → Board → system 这种 ABA 变化会回到同一个值，
    // 但第一次 system 刷新的设备快照已经过期。设置成功发布时递增，刷新按版本落字段。
    let sourceSettingsRevision = 0;
    let windowContextSettingsRevision = 0;
    let cloudSelectionRevision = 0;
    let cloudModelsReadSequence = 0;
    let cloudModelsStopped = false;
    let cloudModelsRetry: ReturnType<typeof setTimeout> | undefined;
    const clearCloudModelsRetry = () => {
      clearTimeout(cloudModelsRetry);
      cloudModelsRetry = undefined;
    };
    stopCloudModels = () => {
      cloudModelsStopped = true;
      ++cloudModelsReadSequence;
      clearCloudModelsRetry();
    };
    // Only background reads retry, with a bounded backoff (cloud-models-retry.ts).
    // An empty ASR subset can also be a partial Host catalog during config failure.
    // With a usable list already shown, rereads are silent: no loading placeholder,
    // and a failure for the same account keeps that list instead of flashing an error.
    let cloudModelsEpoch: string | undefined;
    let lastVisibleCloudRead = 0;
    const usableCloudModels = () => state.cloudModels.some(model => model.kind === "transcribe" && validCloudOptionId(model.id));
    const loadCloudModels = async (backgroundAttempt?: number) => {
      const sequence = ++cloudModelsReadSequence;
      clearCloudModelsRetry();
      const selectionRevision = cloudSelectionRevision;
      let accountEpoch: string | undefined;
      const current = () => !cloudModelsStopped && sequence === cloudModelsReadSequence;
      const retry = () => {
        if (backgroundAttempt === undefined || !current() || listeners.size === 0) return;
        const delay = cloudModelsRetryDelay(backgroundAttempt);
        if (delay === undefined) { publish({ cloudModelsRetryExhausted: true }); return; }
        cloudModelsRetry = setTimeout(() => {
          cloudModelsRetry = undefined;
          if (current() && listeners.size > 0) void loadCloudModels(backgroundAttempt! + 1).catch(() => undefined);
        }, delay);
      };
      const silent = usableCloudModels() && !state.cloudModelsUnavailable;
      if (current()) {
        publish(silent ? { cloudModelsRefreshing: true }
          : { cloudModelsLoading: true, ...(backgroundAttempt === undefined || backgroundAttempt === 0 ? { cloudModelsRetryExhausted: false } : {}) });
      }
      try {
        accountEpoch = await readVoiceAccountEpoch(ctx.voiceContext).catch(() => undefined);
        const models = (await ctx.aiApi.listModels()).filter(model => model.kind === "transcribe" && validCloudOptionId(model.id));
        if (!current()) return [];
        if (accountEpoch && !await isVoiceAccountCurrent(ctx.voiceContext, accountEpoch)) {
          publish({ cloudModels: [], cloudModelsUnavailable: true, cloudModelsLoading: false, cloudModelsRefreshing: false });
          return [];
        }
        if (current()) {
          cloudModelsEpoch = models.length > 0 ? accountEpoch : undefined;
          // Host 回了空列表不是异常：诊断写「列表为空」，不编错误码。
          publish({
            cloudModels: models,
            cloudModelsUnavailable: models.length === 0,
            cloudModelsLoading: false,
            cloudModelsRefreshing: false,
            cloudModelsFailureCode: undefined,
            ...(models.length > 0 ? { cloudModelsRetryExhausted: false } : {}),
            // 空列表没有码也没有原文：诊断「说明」写「列表为空」（视图按无码补固定说明）。
            cloudModelsErrorDetail: models.length === 0
              ? { step: "cloudModels", at: new Date().toISOString(), noteKey: "diagnostics.cloudModelsEmpty" } : undefined,
          });
          if (backgroundAttempt !== undefined && models.length > 0) {
            const operation = settingsSaveChain.then(async () => {
              if (!current() || selectionRevision !== cloudSelectionRevision
                || !await isVoiceAccountCurrent(ctx.voiceContext, accountEpoch)) return;
              const previous = state.featureSettings;
              const chosen = preferredCloudOption(models, previous.cloudModelId, previous.cloudModelBillingPolicy);
              if (!chosen) return;
              const policy = cloudSelectionBillingPolicy(chosen, previous.cloudModelId, previous.cloudModelBillingPolicy);
              if (chosen.id === previous.cloudModelId && policy === previous.cloudModelBillingPolicy) return;
              const next = { ...previous, cloudModelId: chosen.id, cloudModelBillingPolicy: policy };
              try {
                await repository.saveFeatureSettings(next);
                if (current() && selectionRevision === cloudSelectionRevision
                  && await isVoiceAccountCurrent(ctx.voiceContext, accountEpoch)) publish({ featureSettings: next, error: undefined });
              } catch (cause) {
                if (current()) publish(failurePatch("settingsSave", cause));
              }
            });
            settingsSaveChain = operation.catch(() => undefined);
            await operation;
          }
          if (models.length === 0) retry();
        }
        return models;
      } catch (cause) {
        const code = normalizedError(cause).code;
        const reason = voiceRequestFailureReason(cause);
        // Unavailable does not delete or rewrite the user's saved selection.
        // The same account's last good list stays usable; another account's never does.
        // 需要用户动作的失败（未授权、能力被关…）不保留旧列表：清空后如实提示。
        const keep = silent && cloudModelsFailureRetryable(code, reason) && accountEpoch !== undefined && accountEpoch === cloudModelsEpoch
          && await isVoiceAccountCurrent(ctx.voiceContext, accountEpoch).catch(() => false);
        if (current()) {
          publish(keep
            ? { cloudModelsRefreshing: false, cloudModelsLoading: false, cloudModelsFailureCode: code }
            : { cloudModels: [], cloudModelsUnavailable: true, cloudModelsLoading: false, cloudModelsRefreshing: false,
              cloudModelsFailureCode: code, cloudModelsErrorDetail: errorDetailFrom("cloudModels", cause) });
        }
        if (cloudModelsFailureRetryable(code, reason)) retry();
        else if (current() && backgroundAttempt !== undefined) publish({ cloudModelsRetryExhausted: true });
        throw new VoiceAppError({
          code,
          get userMessage() {
            if (["AI_NOT_GRANTED", "AI_PERMISSION_REQUIRED", "AI_PERMISSION_DENIED"].includes(code)) {
              return t("app.cloudRecognitionPermissionIsNotEnabledIn");
            }
            return voiceRequestFailureReason(cause) === "unknown"
              ? t("view.cloudModelsUnavailable") : taskFailureLabel(cause);
          },
          retryable: true,
          cause,
        }, undefined, { constantMessage: true });
      }
    };
    /** 界面重新可见：云端引擎下列表不可用时重读一轮（重获退避预算），有最小间隔、不叠在途读取。 */
    const rereadCloudModelsWhenVisible = () => {
      if (state.settings.engine !== "cloud" || !state.commandLoggedIn) return;
      if (state.cloudModelsLoading || state.cloudModelsRefreshing) return;
      if (usableCloudModels() && !state.cloudModelsUnavailable) return;
      const now = Date.now();
      if (now - lastVisibleCloudRead < cloudModelsRetryTiming.minVisibleIntervalMs) return;
      lastVisibleCloudRead = now;
      void loadCloudModels(0).catch(() => undefined);
    };
    /**
     * 切换模型、切到云端时用已读到的列表；没有列表才等一次读取。
     * `background`：在保存链之外调用（选引擎）时，这次读取带后台退避，失败后照常自动重试；
     * 在保存链之内调用（切模型）不能带——后台修复也排在保存链上，会互相等待。
     */
    const cloudModelsForSelection = async (background = false): Promise<CloudModelOption[]> => {
      if (usableCloudModels() && !state.cloudModelsUnavailable) {
        return state.cloudModels.filter(model => model.kind === "transcribe" && validCloudOptionId(model.id));
      }
      return background ? loadCloudModels(0) : loadCloudModels();
    };
    const selectedCloudModel = async (snapshot?: SavedInputSelection) => {
      await settingsSaveChain;
      const model = snapshot ? snapshot.modelId : state.featureSettings.cloudModelId;
      if (!validCloudOptionId(model)) {
        // 选择还没定下（列表没读到）：本次照旧拒绝，同时补读一次，读到后由后台规则选定免费默认。
        if (!state.cloudModelsLoading && !state.cloudModelsRefreshing) void loadCloudModels(0).catch(() => undefined);
        throw new VoiceAppError({
          code: "com.reai.voice/CLOUD_MODEL_SELECTION_REQUIRED",
          get userMessage() { return t("app.chooseCloudModelBeforeTranscribing"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      // Concrete IDs go unchanged to Host, which distinguishes removal from a
      // temporarily unavailable configuration. An empty list cannot prove either.
      return model;
    };
    /**
     * 录音开始那一刻的引擎/模型快照：云端取 featureSettings.cloudModelId、本地取
     * settings.modelId。听写输入链、命令链、对话页定向听写共用——起跑时定下、
     * 收工那次沿用，是三条链同一条规则，两份实现迟早分叉。
     */
    const snapshotVoiceSelection = (): SavedInputSelection => {
      const settings = state.settings;
      const modelId = settings.engine === "cloud" ? state.featureSettings.cloudModelId : settings.modelId;
      return {
        engine: settings.engine, modelId,
        ...(settings.engine === "cloud" && state.featureSettings.cloudModelBillingPolicy ? { billingPolicy: state.featureSettings.cloudModelBillingPolicy } : {}),
        modelName: settings.engine === "cloud" ? state.cloudModels.find(m => m.id === modelId)?.label : state.models.find(m => m.id === modelId)?.name,
        language: settings.language, punctEnabled: settings.punctEnabled,
      };
    };
    let inputRetryOpSeq = 0;
    const savedInputRetries = new SavedInputRetryController({
      client: ctx.voiceRecordings,
      validateSelection: validateFreeOnlySelection,
      history: () => state.history,
      update: (id, change) => repository.updateHistoryItem(id, change),
      publish: history => publish({ history }),
      busy: (recordingId, phase, attemptId) => {
        const inputRetries = { ...state.inputRetries };
        const attempts = { ...state.inputRetryAttempts };
        if (phase) {
          inputRetries[recordingId] = phase;
          // 诊断计时绑定尝试身份（方案 2.3）：同一阶段同一尝试沿用起点；换阶段或回落到本地
          // （新的 attemptId）就是新尝试、新起点。
          const previous = attempts[recordingId];
          attempts[recordingId] = previous && previous.phase === phase && previous.attemptId === attemptId
            ? previous
            : { phase, ...(attemptId ? { attemptId } : {}), opSeq: ++inputRetryOpSeq, sinceMs: Date.now() };
        } else {
          delete inputRetries[recordingId];
          delete attempts[recordingId];
        }
        publish({ inputRetries, inputRetryAttempts: attempts });
      },
    });
    cancelSavedInputRetries = () => savedInputRetries.dispose();
    const retrySelection = async (): Promise<SavedInputRetryPlan> => {
      await settingsSaveChain;
      const settings = { ...state.settings };
      const localModel = state.models.find(model => model.id === settings.modelId);
      const local = { engine: "local" as const, modelId: settings.modelId, modelName: localModel?.name,
        language: settings.language, punctEnabled: settings.punctEnabled };
      if (settings.engine === "local") return { primary: local };
      const modelId = state.featureSettings.cloudModelId;
      if (!modelId || modelId === "transcribe-default") {
        throw new VoiceAppError({ code: "CLOUD_MODEL_SELECTION_REQUIRED", get userMessage() { return t("app.chooseCloudModelBeforeTranscribing"); }, retryable: true }, undefined, { constantMessage: true });
      }
      const cloud = state.cloudModels.find(model => model.id === modelId);
      return { primary: { engine: "cloud", modelId, billingPolicy: state.featureSettings.cloudModelBillingPolicy, modelName: cloud?.label, language: settings.language, punctEnabled: settings.punctEnabled },
        ...(localModel && ["ready", "active"].includes(localModel.state) ? { fallback: local } : {}) };
    };
    /**
     * A3-24 门控数据：问一次 Host「ni.chat 装没装」。失败（能力不可用、Host 更老）
     * 就沿用上一次的结果——「读不到」不等于「没装」，不能把入口凭空藏掉。
     */
    const refreshAgentsImAvailability = async () => {
      const seq = ++agentsImStatusSeq;
      try {
        const status = await ctx.apps.status({ appId: AGENTS_IM_APP_ID });
        if (seq !== agentsImStatusSeq) return;
        publish({ agentsImAvailable: status.installed && status.enabled });
      } catch {
        // 保持上一次采样；从未采到过就保持 undefined（按钮不渲染，不画假门）。
      }
    };

    const localDownloads = new LocalModelDownloads({
      list: () => ctx.voiceInput.listModels(),
      download: id => ctx.voiceInput.downloadModel(id),
      cancel: id => ctx.voiceInput.cancelModelDownload(id),
      publish: (models, localDownloads) => publish({ models, localDownloads }),
      error: readableError,
    });
    stopLocalDownloads = () => localDownloads.dispose();

    let refreshSequence = 0;
    const refresh = async () => {
      const sequence = ++refreshSequence;
      // Surface reopening after logout/relogin must invalidate the visible saved
      // choice before any recording. Unrelated model/status failures cannot skip it.
      void loadCloudModels(0).catch(() => undefined);
      const expectedSessionId = state.sessionId;
      const expectedSettings = state.settings;
      const expectedSource = expectedSettings.source;
      const expectedSourceRevision = sourceSettingsRevision;
      const expectedWindowContextRevision = windowContextSettingsRevision;
      try {
        const [
          status,
          models,
          permissions,
          accountStatus,
          systemInputs,
          recordings,
          contextProbe,
          replayCache,
        ] =
          await withVoiceRefreshDeadline(async () => {
            await refreshScreenshotConsent();
            return Promise.all([
            readVoiceStatus(expectedSessionId),
            localDownloads.refresh(),
            ctx.voiceInput.checkPermissions(),
            // `account.status@1` 是可选权限：用户拒绝时本地识别仍必须可用，不能让
            // Promise.all 把 Voice 整页一起拖进错误态。云端/Agent 入口保持未登录门禁，
            // 用户可在插件权限页重新授权后刷新真实状态。
            ctx.account.status().catch(() => ({ enabled: false, loggedIn: false })),
            // 键盘麦克风是独立的 Board 音频链路；仅仅打开 Voice 页面不应触碰
            // CoreAudio endpoint。只有用户已经显式选择系统输入时才按需枚举。
            expectedSource === "system"
              ? ctx.voiceInput.listSystemInputs()
              : Promise.resolve([]),
            ctx.voiceRecordings.list({ page: 0, perPage: 50 }),
            probeContext(expectedSettings),
            // 「录音缓存」读不到不该把整个 Voice 页拖垮（能力被撤、Host 更老都会走到这里），
            // 所以单独兜住，并沿用上一次读到的状态，不把「读不到」当成「已过期」。
            ctx.voiceRecordings.replayCacheStatus().catch(() => undefined),
          ]);
          });
        if (sequence !== refreshSequence) return;
        if (toggleInFlight || state.sessionId !== expectedSessionId) return;
        // 门控数据单独走：它读的是注册表不是语音子系统，失败不该拖垮整页刷新。
        void refreshAgentsImAvailability();
        const commonPatch = {
          recognitionSetupRequired: firstRecognitionSetup && !recognitionEngineChoice,
          commandConfigured: true,
          commandLoggedIn: accountStatus.loggedIn,
          // Model refresh publishes through its revision-checked coordinator.
          // audioSources 属于来源版本域：刷新途中用户刚选过档，旧读数不能盖掉新档位。
          permissions: sourceSettingsRevision === expectedSourceRevision
            ? permissions
            : { ...permissions, audioSources: state.permissions.audioSources },
          recordings: recordings.items,
          recordingsTotal: recordings.total,
          // 单次上限不随录音来源变化，不进来源版本域。
          captureLimitSeconds: validCaptureLimitSeconds(status.captureLimitSeconds),
          // 用户刚切换窗口上下文时，设置保存路径会发布一次针对新设置的真实探测；
          // 旧刷新只落其他字段，不能用发起时的 undefined / 旧权限把它覆盖掉。
          ...(windowContextSettingsRevision === expectedWindowContextRevision
            ? { contextProbe }
            : {}),
          replayCache: replayCache ?? state.replayCache,
        };
        // 刷新发出后用户可能已经切换来源。那次切源会按需加载并发布真实的
        // systemInputs 与 source status；旧来源的结果只落与来源无关的整页数据。
        if (sourceSettingsRevision !== expectedSourceRevision) {
          publish(commonPatch);
          return;
        }
        const sourcePatch = {
          ...voiceSourceStatusPatch(withConfirmedArchive(status)),
          systemInputs,
        };
        const authoritative = reconcileAuthoritativeVoiceStatus(state, status, expectedSessionId);
        if (authoritative) {
          publish({
            ...authoritative,
            get error() { return authoritative.error; },
            statusLoadError: undefined,
            ...commonPatch,
            ...sourcePatch,
          });
          if (
            status.sessionId
            && voiceStatusPollMayAcknowledge({
              serviceOperationActive,
              expectedSessionId,
              statusSessionId: status.sessionId,
              stopReason: status.stopReason,
            })
          ) {
            void ctx.voiceInput.acknowledgeResult(status.sessionId).catch(() => undefined);
          }
          return;
        }
        if (state.phase !== "idle" || state.commandPhase !== "idle") return;
        publish({
          statusLoad: "loaded",
          statusLoadError: undefined,
          phase: status.phase,
          // Rust `Option<VoiceInputMode>` 的空闲态经 IPC JSON 会序列化为 null，
          // 而视图用 `activeMode !== undefined` 判断是否繁忙。统一成 undefined，
          // 避免空闲时把 Agent 对话输入框和听写按钮永久锁住。
          activeMode: status.mode ?? undefined,
          commandPhase: status.mode === "command" ? status.phase : state.commandPhase,
          ...commonPatch,
          ...sourcePatch,
          error: undefined,
        });
        scheduleDigestCheck();
      } catch (cause) {
        if (
          sequence !== refreshSequence
          || state.sessionId !== expectedSessionId
          || sourceSettingsRevision !== expectedSourceRevision
        ) return;
        const message = () => cause instanceof Error && cause.message === "VOICE_STATUS_REFRESH_TIMEOUT"
          ? t("app.voiceStatusCheckTimedOut", { seconds: VOICE_REFRESH_TIMEOUT_MS / 1000 }) : readableError(cause);
        // 8 秒超时的 cause 是 Error("VOICE_STATUS_REFRESH_TIMEOUT")：诊断取到的码就是它本身。
        const statusLoadErrorDetail = errorDetailFrom("statusLoad", cause);
        publish({
          statusLoad: "failed",
          get statusLoadError() { return message(); },
          statusLoadErrorDetail,
          get error() { return message(); },
          errorDetail: statusLoadErrorDetail,
        });
      }
    };

    /**
     * 云端转写取词：retainAudio 留在 Host 短时槽里的音频没有本地 transcript，
     * 只能拿 sessionId 去换文本。听写输入链、命令链、对话页定向听写共用这一份
     * 实现——转写语义只有一条，多写一份迟早分叉。
     *
     * 失败语义与本地识别不同：本地识别失败常见于「没听清」，云端失败是这一步
     * 真的没跑通（未登录 / 未授权 / 超时 / 限流……），且插件拿不回那段音频去
     * 本地重跑——不编造文本、不静默切本地，只给一次清楚的错误，用户可以
     * 立刻再按一次语音键重试。
     */
    /** 中央胶囊停到写入那一刻：阶段只换胶囊那一句，写入成功那一刻确认收起（见 voice-overlay-stage）。 */
    const overlayStages = createVoiceOverlayStages(ctx.voiceInput);

    /** 按 `replayClip.id` 回写云端识别结果：`transcript` 缺省 = 失败。尽力而为，不影响交付。 */
    const settleCloudRecording = async (clip: VoiceReplayClipRef | undefined, transcript?: string) => {
      if (!clip) return;
      await ctx.voiceRecordings
        .setInputSessionTranscription(clip.id, transcript === undefined ? "failed" : "complete", transcript)
        .catch(() => undefined);
    };

    /**
     * 云端识别的结算骨架（所有云端链共用一份，免得某条链漏回写、录音卡在「处理中」）：
     * `work` 成功（含空文本）回写 complete 与转写，失败回写 failed 再原样抛出。
     */
    const settleCloudTranscription = async (
      clip: VoiceReplayClipRef | undefined,
      work: () => Promise<string>,
    ): Promise<string> => {
      let transcript: string;
      try {
        transcript = await work();
      } catch (cause) {
        await settleCloudRecording(clip);
        throw cause;
      }
      await settleCloudRecording(clip, transcript);
      return transcript;
    };

    const transcribeRetainedAudio = async (
      audio: NonNullable<VoiceInputResult["audio"]>,
      selection: SavedInputSelection | undefined,
    ): Promise<string> => {
      let cloudResult: { text: string };
      try {
        if (!selection) throw cloudOptionRequiredError();
        await validateFreeOnlySelection(selection);
        cloudResult = await ctx.aiApi.transcribe({
          invocationId: crypto.randomUUID(),
          sessionId: audio.id,
          model: await selectedCloudModel(selection),
          ...((selection as SavedInputSelection & { billingPolicy?: "free-only" }).billingPolicy ? { billingPolicy: "free-only" as const } : {}),
          ...((selection?.language ?? state.settings.language) === "auto" ? {} : { language: selection?.language ?? state.settings.language }),
        });
      } catch (cause) {
        // 未授权（还没在权限页打开 cloud.model.invoke@1）是切到云端引擎后
        // 100% 会先撞上的一道门，比登录失效更前置；给它专门的指路文案，
        // 不要把 Host 那句不知道「哪个权限、去哪开」的通用提示原样甩给用户。
        //
        // ⚠️ 只认这三个「真的没授权」的码，不能用 describeCloudError 归到的
        // 宽泛 permission_denied 档——那一档还盖着 AI_SCOPE_UNAVAILABLE（账户
        // 的云端模型服务本身还没开通，Host 原话是「云端模型服务暂未开通」）。
        // 用宽档判断会把这条准确信息覆盖成「去权限页开关」，而权限页那个
        // 开关明明是开着的，用户会卡在一个开着却「解决不了」的开关上。
        const permissionDenied = ["AI_NOT_GRANTED", "AI_PERMISSION_REQUIRED", "AI_PERMISSION_DENIED"]
          .includes(normalizedError(cause).code);
        // 认不出的失败主句里会插上游原文：不声明固定文案，交回 SDK 时按码查表（插件页面照旧显示）。
        throw new VoiceAppError({
          code: "com.reai.voice/CLOUD_TRANSCRIBE_FAILED",
          get userMessage() { return permissionDenied
            ? t("app.cloudRecognitionPermissionIsNotEnabledIn")
            : t("app.cloudRecognitionFailedValue", { value0: voiceCloudFailureMessage(cause) ?? readableError(cause) }); },
          retryable: true,
        }, withOuterCode(collectErrorFields(cause), "com.reai.voice/CLOUD_TRANSCRIBE_FAILED"), { composedMessage: true });
      }
      return cloudResult.text.trim();
    };

    /**
     * 云端识别一段本插件录下的音频，并按 `replayClip.id` 回写转写结果——成功（含空文本）
     * 与失败都回写。Host 把 retainAudio 的录音以 pending 落盘（输入法与命令两类都落，
     * Host API 1.22），不回写就一直显示「处理中」，直到下次启动才归为失败。回写尽力而为，
     * 不影响本次交付；Host 没留片段（`replayClipStatus` 非 saved）时没有可回写的录音。
     */
    const transcribeCloudRecording = async (
      result: Pick<VoiceInputResult, "replayClip" | "replayClipStatus">,
      audio: NonNullable<VoiceInputResult["audio"]>,
      selection: SavedInputSelection | undefined,
    ): Promise<string> =>
      await settleCloudTranscription(savedReplayClip(result), () => transcribeRetainedAudio(audio, selection));

    /**
     * 云端转写收尾（听写输入链）：转写之后接润色、写回与落历史的共用收尾。
     */
    const finishCloudTranscript = async (
      result: VoiceInputResult,
      audio: NonNullable<VoiceInputResult["audio"]>,
      deliveryTarget: VoiceDeliveryTargetRef | undefined,
      insertText: boolean | undefined,
      polish: VoicePolishSetting,
      context: VoiceContextEnvelope | undefined,
      selection: SavedInputSelection | undefined,
      slotOwner: VoiceSlotOwner,
      lifecycle?: AbortSignal,
    ): Promise<VoiceInputResult> => {
      const transcript = await transcribeCloudRecording(result, audio, selection);
      throwIfAborted(lifecycle);
      if (!transcript) {
        // 云端也可能识别出空文本（整段静音一类）。与本地路径一致：不写回、
        // 不编一条空历史，安静回到 idle——不是失败，只是没听到内容。
        overlayStages.release(result.sessionId);
        publish(settledPatch({ phase: "idle", activeMode: undefined, sessionId: undefined }, slotOwner));
        return { ...result, transcript: "", inserted: false };
      }
      void overlayStages.report(result.sessionId, "transcribed");

      return await deliverRecognizedText({
        result,
        transcript,
        recognitionEngine: "cloud",
        originalSelection: selection,
        deliveryTarget,
        insertText,
        polish,
        context,
        slotOwner,
        lifecycle,
      });
    };

    /**
     * recognize → **polish** → insert 的共用收尾。
     *
     * 本地与云端两条识别路径到这里已经没有区别了：都拿到了一段最终文本，都要先过
     * 润色、再写回、再落历史。合成一条是为了让「失败回退原样注入」只有一份实现——
     * 两份实现迟早会分叉，而分叉出来的那一份就是把失败伪装成成功的地方。
     */
    const deliverRecognizedText = async (input: {
      result: VoiceInputResult;
      transcript: string;
      recognitionEngine: VoiceInputSettings["engine"];
      originalSelection?: SavedInputSelection;
      deliveryTarget: VoiceDeliveryTargetRef | undefined;
      insertText: boolean | undefined;
      polish: VoicePolishSetting;
      context?: VoiceContextEnvelope;
      /** 发布方占录音槽时的会话（见 settledPatch）。 */
      slotOwner: VoiceSlotOwner;
      /** 后台收尾段的生命周期：插件停用后不再写回、不再落历史。 */
      lifecycle?: AbortSignal;
    }): Promise<VoiceInputResult> => {
      const { result, transcript, deliveryTarget, insertText } = input;
      // Tab 层语音搜索已消费这段识别（Host API 1.22 `consumedBy`）：写回凭证已被 Host
      // 撤销。不润色、不写回、不弹取回卡——同一段话不能既换了搜索词又被写进前台应用。
      // 已知残留：润色上下文在录音开始时就按用户同意采了，到收尾才知道被消费，这份
      // 上下文只在本进程内丢弃、不发出。
      const consumed = result.consumedBy !== undefined;
      const polish: VoicePolishSetting = consumed ? "raw" : input.polish;
      if (polish !== "raw") void overlayStages.report(result.sessionId, "polishing");
      const outcome = await runPolish(polish, transcript, input.context);
      throwIfAborted(input.lifecycle);
      const deliverable = outcome.text;
      // 润色 / 写回两个阶段各自的真实失败，按条目落盘供诊断（互不覆盖）：只存结构化字段，
      // 原文另记在本次运行的内存表里（界面主动展开用）。
      const polishFields = outcome.failure ? outcome.failure.fields ?? collectErrorFields(undefined, { code: outcome.failure.code }) : undefined;
      const polishFailure: VoiceStageFailure | undefined = outcome.failure
        ? stageFailure(polishFields!, "POLISH_FAILED")
        : undefined;
      let deliveryFailure: VoiceStageFailure | undefined;
      let deliveryRaw: string | undefined;

      // insertText 显式为 false 时不写回、不产生警告（页面内测试按钮就是这种场景，
      // 此刻焦点已经在 Driver 自己身上）。
      let inserted = false;
      let warningCode: string | undefined;
      if (insertText === false || consumed) {
        // 不写回，也不是失败。
      } else if (!deliveryTarget) {
        warningCode = "no_input_target";
        // 写回阶段自己的失败（与润色失败分开记，同时发生时两条诊断都在）。
        deliveryFailure = { code: warningCode, at: new Date().toISOString() };
      } else {
        try {
          const delivered = await ctx.delivery.commit({
            targetId: deliveryTarget.id,
            text: deliverable,
            behavior: "insert",
          });
          inserted = delivered.committed;
          if (delivered.committed) {
            // 写入成功的这一刻收起中央胶囊（不等润色对照、落历史这些收尾）。
            overlayStages.release(result.sessionId);
            deliveryPermissionBlocked = false;
          }
          else {
            warningCode = delivered.reason;
            // Host 只回类别码（not_editable / not_received …），没有原文：诊断如实写「Host 未提供」。
            deliveryFailure = { code: delivered.reason ?? "insert_failed", at: new Date().toISOString() };
          }
        } catch (cause) {
          // 写回失败不该抹掉已经拿到的识别结果——文本仍然保留在历史里。
          // 区分「还没在权限页开启写回」和其它写入故障：前者指路，后者
          // 才是笼统的「写入失败」，不能把用户没做的一步说成技术故障。
          warningCode = deliveryFailureReason(cause);
          // 诊断保留真实码（warningCode 只是文案类别，§6.0 ⑦ 不许只留模糊类别）；原文只进内存表。
          const fields = collectErrorFields(cause);
          deliveryFailure = stageFailure(fields, warningCode);
          deliveryRaw = fields.raw;
          if (warningCode === "voice_deliver_permission_required") {
            // 记住这件事：云端引擎下是插件负责写回，权限没开就每说一句丢一句。
            // 置位之后下一段会在采集前拦住，直到用户开启权限并明确重试。
            deliveryPermissionBlocked = true;
          }
        }
      }

      // 写回回包期间插件可能已停用：不再弹取回卡、不再落历史。
      throwIfAborted(input.lifecycle);

      // 润色失败的告知优先级低于写回失败：文字**已经**按原话进去了，
      // 那是用户最关心的事；润色没跑成只是「这条不是润色稿」。
      if (!warningCode && outcome.failure) warningCode = "polish_failed";

      // 缺陷2兜底（2026-09-18 升级为系统级卡片）：用户期待写入（insertText !== false）
      // 却没写进去、文字非空，就不能只静默进历史——请 Host 在 Voice 胶囊正上方
      // 弹「取回文字」卡片（全文 + 一键复制）。polish_failed 不算：那条文字已经
      // 写进去了。连续失败时 Host 直接替换卡片内容，不重复堆叠；Input 会话 commit
      // 失败时 Host 自己的兜底卡与这次请求是同一张卡（内容替换），用户只看到一张。
      const undelivered = insertText !== false && !inserted
        && deliverable.trim().length > 0
        && !!warningCode && warningCode !== "polish_failed"
        ? { text: deliverable, reason: warningCode }
        : undefined;
      if (undelivered) {
        // 胶囊先说一句「文字没有写入」（必须先于任何确认送达），再弹取回卡。
        await overlayStages.report(result.sessionId, "insert_failed");
        throwIfAborted(input.lifecycle);
        // 真实码独立传给开发模式诊断；普通原因只用固定人话。
        const code = deliveryFailure?.code ?? undelivered.reason;
        const card = {
          title: t("view.textNotInsertedTitle"),
          reason: deliverReasonLabel(undelivered.reason),
          text: undelivered.text,
          ...hostErrorCode(code),
        };
        // 取回卡被 Host 拒了（旧 Host 不认这条方法；或写回权限被拒——Host 对 `voice.deliver.*`
        // 共用同一道权限门，取回卡跟着被拒）：改弹失败态结果面板，同样的标题、全文（可复制）、
        // 原因与真实码。等待可见回执后收起；若两种窗口都失败，保留胶囊并照常落历史。
        const presentation = ctx.delivery.presentTakeback(card).catch(() => {
          // 取回卡被拒到改弹面板之间插件可能已停用：不再弹。
          throwIfAborted(input.lifecycle);
          return ctx.voiceCommand.presentAnswer({
            runId: `input:${result.sessionId ?? Date.now()}`,
            badge: t("view.voiceInput"),
            title: card.title,
            text: card.text,
            originalText: transcript,
            status: "failed",
            ...(card.errorCode ? { errorCode: card.errorCode } : {}),
            // 与命令的兜底面板同一排法：原文；润色稿与原文不同时再摆一段结果；最后是原因。
            sections: [
              { label: t("app.original"), text: transcript },
              ...(card.text !== transcript
                ? [{ label: t("app.valueResult", { value0: t("view.voiceInput") }), text: card.text }]
                : []),
              { label: t("app.error"), text: card.reason },
            ],
            canCopy: true,
            canContinue: false,
          });
        }).then(() => overlayStages.release(result.sessionId)).catch(() => undefined);
        await waitForPresentation(presentation);
      } else if (!inserted) {
        // 没有要写的（insertText: false / Tab 层已消费 / 润色后为空）：同样收起。
        overlayStages.release(result.sessionId);
      }

      const finalResult: VoiceInputResult = {
        ...result,
        transcript: deliverable,
        inserted,
        ...(warningCode ? { warningCode } : {}),
      };
      // 取回卡等待期间插件可能已停用：不再落历史。
      throwIfAborted(input.lifecycle);
      try {
        const item = historyItem(finalResult, {
          polish,
          recognitionEngine: input.recognitionEngine,
          originalSelection: input.originalSelection,
          // 与 warningCode 分开记：写回失败会把 warningCode 占掉，
          // 那时润色失败就再没有别的地方留痕。
          ...(outcome.failure ? { polishFailed: true } : {}),
          ...(polishFailure ? { polishFailure } : {}),
          ...(deliveryFailure ? { deliveryFailure } : {}),
          // 只有真改过才留对照，改都没改的对照是在假装做了工作。
          ...(outcome.changed ? { originalTranscript: transcript } : {}),
        });
        const history = await repository.appendHistory(item);
        publish(settledPatch({
          failureRaw: withFailureRaw({ [`polish:${item.id}`]: polishFields?.raw, [`deliver:${item.id}`]: deliveryRaw }),
          phase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          history,
          deliveryPermissionBlocked,
          // 云端与本地润色都走这条共用收尾。刚落盘的片段必须立即并进页面状态，
          // 否则缓存原本为空时 retainedSinceMs 仍是 null，详情页会把真录音误报成过期。
          replayCache: replayCacheWithClip(state.replayCache, savedReplayClip(finalResult)),
          // 润色失败要说清原因，但不能装成致命错误——这是行内提示，不是拦路弹窗。
          ...(outcome.failure && polishFailure
            ? {
              get error() { return outcome.failure?.message; },
              errorDetail: errorDetailFrom("polish", undefined, { fields: polishFields!, at: new Date(polishFailure.at) }),
            }
            : {}),
        }, input.slotOwner));
        // 就地合并只解决“刚录完立即可播”；再追一次 Host 权威值同步过期/配额清理后的下沿。
        if (savedReplayClip(finalResult)) void refreshReplayCache();
      } catch (cause) {
        publish(settledPatch({
          phase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          get error() { return t("app.recognitionFinishedButHistoryCouldNotBe", { value0: readableError(cause) }); },
          errorDetail: errorDetailFrom("historySave", cause),
        }, input.slotOwner));
      }
      return finalResult;
    };

    /** 听写进行中（在听 / 识别中），别的语音入口一律让路。 */
    const throwIfDictating = () => {
      if (state.dictationPhase === "idle") return;
      throw new VoiceAppError({
        code: "com.reai.voice/VOICE_BUSY",
        get userMessage() { return t("app.dictationIsInProgressFinishOrCancel"); },
        retryable: true,
      }, undefined, { constantMessage: true });
    };

    /**
     * R8：命令详情输入坞的定向听写——说的话**有且只**落进那个输入框。
     *
     * 走 `voiceInput.toggle({ mode: "command", insertText: false })`：识别只出文本，
     * 转写只回插件、插件也不 commit；插件不跑工作流、不写历史、不碰
     * `commandPhase`（硬件语音键靠它判收工），只把文本通过返回值交给视图。
     * 第一次调用起跑，第二次调用收工并返回转写。
     */
    const toggleDictation = async (): Promise<
      { phase: "listening"; sessionId?: string }
      | {
        phase: "idle";
        transcript: string;
        sessionId?: string;
        outcome?: "recognized" | "cancelled";
      }
    > => {
      const completing = state.dictationPhase === "listening";
      if (!completing) {
        if (
          toggleInFlight ||
          serviceOperationActive ||
          state.dictationPhase !== "idle" ||
          state.phase !== "idle" ||
          state.commandPhase !== "idle" ||
          state.activeMode !== undefined
        ) {
          throw new VoiceAppError({
            code: "com.reai.voice/VOICE_BUSY",
            get userMessage() { return t("app.voiceIsBusyWaitForTheCurrent"); },
            retryable: true,
          }, undefined, { constantMessage: true });
        }
      } else if (toggleInFlight) {
        throw new VoiceAppError({
          code: "com.reai.voice/VOICE_BUSY",
          get userMessage() { return t("app.thePreviousStepIsNotFinishedYet"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      toggleInFlight = true;
      if (!completing) dictationCancelRequested = false;
      publish({ error: undefined });
      try {
        if (!completing) {
          await settingsSaveChain;
          pendingDictationSelection = snapshotVoiceSelection();
          // 云端模型没选/失效要在采集前拦住：Host 对 retainAudio 不查本地模型，
          // 起跑后才失败就只剩一段谁也转写不了的音频。
          if (pendingDictationSelection.engine === "cloud") await selectedCloudModel(pendingDictationSelection);
          await configuration.prepare(state.settings);
        } else {
          publish({ dictationPhase: "recognizing" });
        }
        // 云端引擎没有本地识别可跑：音频必须以 retainAudio 留给 Host 的短时槽，
        // 否则 Host 的「非 retainAudio 就查本地模型」门禁会把没有本地模型的
        // 云端用户挡死在起跑线上（与听写输入链同一条修法）。
        const useCloud = pendingDictationSelection?.engine === "cloud";
        const result = await ctx.voiceInput.toggle({
          mode: "command",
          overlayKind: "input",
          // 识别只出文本（Host API 1.22）：听写结果只落进对话输入框，绝不写回前台应用。
          insertText: false,
          ...(useCloud ? { retainAudio: true } : {}),
        });
        if (result.phase === "listening") {
          noteCaptureLimit(result);
          if (dictationCancelRequested) {
            dictationCancelRequested = false;
            await ctx.voiceInput.cancel(result.sessionId).catch(() => undefined);
            publish({ dictationPhase: "idle", sessionId: undefined });
            throw new VoiceAppError({
              code: "com.reai.voice/VOICE_CANCELLED",
              get userMessage() { return t("app.dictationWasCancelled"); },
              retryable: true,
            }, undefined, { constantMessage: true });
          }
          publish({ dictationPhase: "listening", sessionId: result.sessionId });
          return { phase: "listening", sessionId: result.sessionId };
        }
        publish({ dictationPhase: "idle", sessionId: undefined });
        const originalSelection = pendingDictationSelection;
        pendingDictationSelection = undefined;
        let transcript = result.transcript?.trim() ?? "";
        if (!transcript && result.audio) {
          transcript = await transcribeCloudRecording(result, result.audio, originalSelection);
        }
        return {
          phase: "idle",
          transcript,
          sessionId: result.sessionId,
          outcome: result.outcome ?? "recognized",
        };
      } catch (cause) {
        // 起跑失败 / 收工失败都回 idle：听写的错误只在对话页原地展示，不进全局 error
        // （那会在列表页的状态卡上冒出一条与当前页无关的红字）。
        publish({ dictationPhase: "idle", sessionId: undefined });
        if (isVoiceCancellation(cause)) {
          return { phase: "idle", transcript: "", outcome: "cancelled" };
        }
        throw cause;
      } finally {
        toggleInFlight = false;
      }
    };

    /** 人离开对话页：正在听的听写没有落点了，取消掉。幂等。 */
    const cancelDictation = async () => {
      if (toggleInFlight && state.dictationPhase === "idle") {
        dictationCancelRequested = true;
        return;
      }
      dictationCancelRequested = false;
      if (state.dictationPhase === "idle") return;
      const sessionId = state.sessionId;
      publish({ dictationPhase: "idle", sessionId: undefined });
      await ctx.voiceInput.cancel(sessionId).catch(() => undefined);
    };

    /**
     * F04 跨插件 request-text 服务：一次录音、一次返回、一次终态。
     *
     * 服务会话与 Voice 自有听写共用同一个采集占用槽：任一方向忙时另一方向
     * 立即 busy，不以 toggle 结束别人的录音。硬件二触通过 provider 的控制口
     * 桥回原 Promise，最终文本只交给服务消费者，Voice 不注入、不写历史。
     */
    let serviceOperationActive = false;
    let serviceContext: Promise<VoiceContextEnvelope | undefined> = Promise.resolve(undefined);
    let serviceSettings = state.settings;
    let serviceCloudSelection: CloudSelection | undefined;
    const requestTextAdmission = await VoiceRequestAdmission.open({
      read: () => repositoryStore.get("request-admission"),
      write: (value) => repositoryStore.set("request-admission", value),
    });
    const requestTextProvider = new VoiceRequestTextProvider(requestTextAdmission, {
      reserve: () => {
        if (
          serviceOperationActive
          || toggleInFlight
          || state.phase !== "idle"
          || state.commandPhase !== "idle"
          || state.activeMode !== undefined
          || state.dictationPhase !== "idle"
          // 服务预约仍要求全空闲：还有段在后台收尾（胶囊叠放）时不接。
          || asyncSegments.size > 0
        ) {
          return undefined;
        }
        serviceOperationActive = true;
        serviceContext = Promise.resolve(undefined);
        return () => {
          serviceOperationActive = false;
          publish({ phase: "idle", activeMode: undefined, sessionId: undefined });
        };
      },
      prepare: async (signal, reportWaitingPermission) => {
        await settingsSaveChain;
        serviceSettings = state.settings;
        serviceCloudSelection = serviceSettings.engine === "cloud"
          ? await requireCloudSelection(serviceSettings) : undefined;
        return prepareVoiceRequest({
          configure: configuration.prepare,
          checkPermissions: () => ctx.voiceInput.checkPermissions(),
        }, serviceSettings, signal, reportWaitingPermission, {
          cancelled: t("app.dictationWasCancelled"),
          upgrade: t("service.hostUpgradeRequired"),
          microphone: t("service.microphoneRequired"),
        });
      },
      isAccountCurrent: (expected) => isVoiceAccountCurrent(ctx.voiceContext, expected),
      start: async (options) => {
        const result = await ctx.voiceInput.start({
          requestId: options.requestId,
          mode: "input",
          insertText: false,
          captureDeliveryTarget: false,
          retainAudio: serviceSettings.engine === "cloud",
          retainResultUntilAck: true,
          captureLimitAction: "finish",
        });
        if (result.phase === "listening" && result.sessionId) {
          noteCaptureLimit(result);
          serviceContext = serviceSettings.polish === "raw" ? Promise.resolve(undefined) : assembleContext(result.sessionId).catch(() => undefined);
          publish({ phase: "listening", activeMode: "input", sessionId: result.sessionId, error: undefined });
        }
        return result;
      },
      finish: async (sessionId) => {
        publish({ phase: "recognizing" });
        return await ctx.voiceInput.finish(sessionId);
      },
      cancelPendingStart: async (requestId) => {
        await ctx.voiceInput.cancelPendingStart(requestId);
      },
      cancel: async (sessionId) => {
        await ctx.voiceInput.cancel(sessionId);
      },
      acknowledge: async (sessionId) => {
        await ctx.voiceInput.acknowledgeResult(sessionId);
      },
      readStatus: async (sessionId) => {
        const status = await readVoiceStatus(sessionId);
        if (status.phase === "recognizing") publish({ phase: "recognizing" });
        return status;
      },
      process: async (result, signal) => {
        throwIfAborted(signal);
        let transcript = (result.transcript ?? "").trim();
        if (!transcript && result.audio) {
          // 云端引擎：音频留在 Host，只取转写文本；不写回、不落 Voice 历史。Host 以 pending
          // 落下的录音仍要按 replayClip.id 回写转写结果（成功与失败都回写），否则一直「处理中」。
          const audio = result.audio;
          transcript = await settleCloudTranscription(savedReplayClip(result), async () => {
            if (!serviceCloudSelection) throw cloudOptionRequiredError();
            await validateFreeOnlySelection(serviceCloudSelection);
            const cloud = await ctx.aiApi.transcribe({
              invocationId: crypto.randomUUID(),
              sessionId: audio.id,
              model: serviceCloudSelection.modelId,
              ...(serviceCloudSelection.billingPolicy ? { billingPolicy: serviceCloudSelection.billingPolicy } : {}),
              ...(serviceSettings.language === "auto" ? {} : { language: serviceSettings.language }),
            });
            return cloud.text.trim();
          });
        }
        if (!transcript) {
          throw new AppError({
            code: "com.reai.voice/VOICE_EMPTY_TRANSCRIPT",
            get userMessage() { return t("app.nothingWasHeardPleaseSayItAgain"); },
            retryable: true,
          });
        }
        throwIfAborted(signal);
        const context = serviceSettings.polish === "raw"
          ? undefined
          : await serviceContext;
        throwIfAborted(signal);
        const outcome = await runPolish(serviceSettings.polish, transcript, context, signal);
        throwIfAborted(signal);
        if (outcome.applied && outcome.changed) return { text: outcome.text, kind: "processed" };
        if (serviceSettings.polish === "raw") return { text: transcript, kind: "raw" };
        return { text: outcome.text, kind: outcome.failure ? "raw_fallback" : "raw" };
      },
    });
    registerVoiceRequestTextService(
      ctx.services,
      requestTextProvider,
      () => ctx.locale.getSnapshot().locale,
    );
    requestTextProviderDeactivate = () => {
      requestTextProvider.dispose();
      requestTextProviderDeactivate = undefined;
    };

    const runVoiceStart = async <T>(signal: AbortSignal, start: (bounded: AbortSignal) => Promise<T>): Promise<T> => {
      try { return await withVoiceStartDeadline(signal, start); }
      catch (cause) {
        if (cause instanceof Error && cause.message === "VOICE_START_TIMEOUT") {
          const error = new VoiceAppError({ code: "com.reai.voice/VOICE_START_TIMEOUT", userMessage: t("app.voiceStartTimedOut", { seconds: VOICE_START_TIMEOUT_MS / 1000 }), retryable: true }, undefined, { constantMessage: true });
          publish({ error: error.userMessage, errorDetail: errorDetailFrom("starting", error) });
          throw error;
        }
        throw cause;
      }
    };

    const startOwnedCapture = async (
      signal: AbortSignal | undefined,
      options: Omit<Parameters<typeof ctx.voiceInput.start>[0], "requestId">,
    ) => {
      throwIfAborted(signal);
      const requestId = `${Date.now()}:${crypto.randomUUID()}`;
      const cancel = () => void ctx.voiceInput.cancelPendingStart(requestId).catch(() => undefined);
      signal?.addEventListener("abort", cancel, { once: true });
      try { return await awaitVoicePreparation(signal, () => ctx.voiceInput.start({ ...options, requestId })); }
      finally { signal?.removeEventListener("abort", cancel); }
    };

    /**
     * 胶囊叠放（Host `asyncFinish`，2026-10-23）：一段录音结束即回 `finalizing`，收尾在 Host 后台。
     *
     * `toggleInFlight` 只护开录与结束打标这两步；每段的收尾（取终稿、润色、写回、落历史 / 命令
     * 运行）是各自独立的任务，用开录那一刻冻结的上下文跑完，互不阻塞，下一段可以马上开录。
     * 写回顺序由 Host 按录音结束先后放行，插件不自己排。旧 Host 不回 `finalizing`：段登记在结束
     * 那一刻撤掉，整条路径照旧同步收尾。
     */
    type AsyncSegmentOutcome =
      | { kind: "result"; result: VoiceInputResult }
      | { kind: "error"; cause: unknown }
      | { kind: "unsupported" };
    interface AsyncVoiceSegment {
      sessionId: string;
      mode: "input" | "command";
      /** 本地已让出录音槽：插件 finish 回了 `finalizing`，或 Host 自己结束了这段（胶囊 ✓ / 录音上限）。 */
      ended: boolean;
      /** 让出录音槽的时刻（片段增强的松开时刻）。 */
      endedAt?: number;
      /** 同一段同时只有一个终稿等待者。 */
      watching: boolean;
      /** 收尾只跑一次。 */
      settling: boolean;
      /** 这段等待者的生命周期：放弃这段（drop）或插件停用即中止。收尾本身核对整个激活期的信号。 */
      lifecycle: AbortController;
      /** 用开录时冻结的上下文跑这段的收尾（结果交接之后的全部步骤）。 */
      complete(result: VoiceInputResult): Promise<unknown>;
      /** 终稿没拿到（取消、出错、Host 不再认得这段）：按这段的口径收口。 */
      fail(cause: unknown): Promise<unknown>;
    }
    /** 单次长轮询的上限（Host 夹到 20 秒）。 */
    const ASYNC_RESULT_WAIT_MS = 20_000;
    /** 已收尾的会话：迟到的 `finalizing` 回执不再重新登记、重复收尾。只留最近几段。 */
    const settledAsyncSessions = new Set<string>();
    const rememberSettledAsyncSession = (sessionId: string) => {
      settledAsyncSessions.add(sessionId);
      for (const old of settledAsyncSessions) {
        if (settledAsyncSessions.size <= 16) break;
        settledAsyncSessions.delete(old);
      }
    };
    /** 本次运行里 Host 已回过 `finalizing` / `pending`：确认支持多段，放开录音之间的互斥。 */
    let hostAsyncFinish = false;
    /** 开录要不要声明 `asyncFinish`：已确认支持，或 Host 是带新切片口径的 1.0.6 起版本。 */
    const asyncFinishCapable = () => hostAsyncFinish || state.captureModel === SPAN_MARKERS_CAPTURE_MODEL;
    const publishFinalizingCount = () => {
      // 停用后计数已在 disposeAsyncSegments 清零，迟到的变动不再写回去。
      if (asyncActivation.signal.aborted) return;
      let count = 0;
      for (const segment of asyncSegments.values()) if (segment.ended) count++;
      if ((state.finalizingCount ?? 0) !== count) publish({ finalizingCount: count || undefined });
    };
    const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
    const asyncSegmentCancelled = () => new VoiceAppError({
      code: "com.reai.voice/VOICE_CANCELLED",
      get userMessage() { return t("app.voiceInputWasCancelled"); },
      retryable: true,
    }, undefined, { constantMessage: true });
    /**
     * 按 sessionId 长轮询这段的终稿；Host 不回 `pending`（旧 Host / 不认得这段）即 `unsupported`。
     * 读状态本身失败（传输异常）不等于这段结束：还在录就一直退避重试，已结束才在连续 3 次后放弃。
     */
    const pollAsyncOutcome = async (segment: AsyncVoiceSegment): Promise<AsyncSegmentOutcome> => {
      for (let failures = 0; ;) {
        if (segment.lifecycle.signal.aborted || asyncActivation.signal.aborted) {
          return { kind: "error", cause: asyncSegmentCancelled() };
        }
        const askedAt = Date.now();
        let status: VoiceInputStatus;
        try {
          status = await ctx.voiceInput.getStatus(segment.sessionId, { waitMs: ASYNC_RESULT_WAIT_MS });
          failures = 0;
        } catch (cause) {
          failures++;
          if (segment.ended && failures >= 3) return { kind: "error", cause };
          await sleep(Math.min(5_000, 500 * 2 ** Math.min(failures - 1, 4)));
          continue;
        }
        if (status.result) return { kind: "result", result: status.result };
        if (status.resultError) {
          return {
            kind: "error",
            cause: new AppError({ code: status.resultError.code, userMessage: status.resultError.message, retryable: true }),
          };
        }
        if (!status.pending) return { kind: "unsupported" };
        hostAsyncFinish = true;
        // 长轮询到点，再问一次；万一立即回包也不空转。
        if (Date.now() - askedAt < 200) await sleep(250);
      }
    };
    const settleAsyncSegment = async (segment: AsyncVoiceSegment, outcome: AsyncSegmentOutcome) => {
      if (segment.settling) return;
      segment.settling = true;
      rememberSettledAsyncSession(segment.sessionId);
      // Host 自己结束了这段（胶囊 ✓ / 录音上限）而本地还当它在录：先让出录音槽。
      if (!segment.ended) endAsyncSegment(segment);
      try {
        if (outcome.kind === "result") await segment.complete(outcome.result);
        else await segment.fail(outcome.kind === "error" ? outcome.cause : asyncSegmentCancelled());
      } catch {
        // 收尾自己已经呈现了失败（界面主句 / 取回卡），后台任务不再往外抛。
      } finally {
        if (asyncSegments.get(segment.sessionId) === segment) asyncSegments.delete(segment.sessionId);
        publishFinalizingCount();
      }
    };
    const watchAsyncSegment = (segment: AsyncVoiceSegment) => {
      if (segment.watching || segment.settling) return;
      segment.watching = true;
      void pollAsyncOutcome(segment).then(async (outcome) => {
        segment.watching = false;
        // 插件已停用：Host 按 owner 清掉了这段，不再收尾、不再呈现。
        if (segment.lifecycle.signal.aborted || asyncActivation.signal.aborted) return;
        // 还在录、Host 却不回 pending（旧 Host）：交给结束回执决定（同步结果就地收尾，finalizing 再等一次）。
        if (outcome.kind === "unsupported" && !segment.ended) return;
        await settleAsyncSegment(segment, outcome);
      });
    };
    /** 本地让出录音槽：这段进入后台收尾，下一段可以开录。 */
    const endAsyncSegment = (segment: AsyncVoiceSegment) => {
      if (segment.ended) return;
      segment.ended = true;
      segment.endedAt = Date.now();
      if (state.sessionId === segment.sessionId) {
        publish(segment.mode === "input"
          ? { phase: "idle", activeMode: undefined, sessionId: undefined }
          : { commandPhase: "idle", activeMode: undefined, sessionId: undefined });
      }
      publishFinalizingCount();
      watchAsyncSegment(segment);
    };
    const registerAsyncSegment = (
      sessionId: string,
      mode: AsyncVoiceSegment["mode"],
      handlers: (segment: AsyncVoiceSegment) => Pick<AsyncVoiceSegment, "complete" | "fail">,
    ): AsyncVoiceSegment => {
      const segment = {
        sessionId, mode, ended: false, watching: false, settling: false, lifecycle: new AbortController(),
      } as AsyncVoiceSegment;
      Object.assign(segment, handlers(segment));
      // 已停用（开录回执迟到）：不登记、不等终稿。
      if (asyncActivation.signal.aborted) return segment;
      asyncSegments.set(sessionId, segment);
      // 从开录起就等终稿：Host 自己结束这段（✓ / 录音上限）、终稿早于结束回执都不漏。
      watchAsyncSegment(segment);
      return segment;
    };
    /**
     * 结束回执是 `finalizing`：让出录音槽交给后台收尾。终稿已先到、这段收过尾（或已被清掉）时
     * 不再重新登记，免得同一终稿再写一遍。
     */
    const finalizeAsyncSegment = (sessionId: string, register: () => AsyncVoiceSegment) => {
      hostAsyncFinish = true;
      // 结束请求在路上时插件已停用：Host 按 owner 清掉了这段，不再登记收尾。
      if (asyncActivation.signal.aborted || settledAsyncSessions.has(sessionId)) return;
      endAsyncSegment(asyncSegments.get(sessionId) ?? register());
    };
    /** 撤掉一段的登记并中止它的等待者（放弃这段的后台收尾）。 */
    const dropAsyncSegment = (segment: AsyncVoiceSegment) => {
      segment.lifecycle.abort();
      if (asyncSegments.get(segment.sessionId) === segment) asyncSegments.delete(segment.sessionId);
      publishFinalizingCount();
    };
    /**
     * 结束请求失败（传输异常或 Host 已先结束了这段）：回查 Host 再决定。
     * `ended`：Host 已结束（在收尾 / 已有终稿），交给后台等待者；`listening`：Host 还在录，本地
     * 保持在录、可以再按一次结束；`unknown`：查不清，放弃这段的后台收尾，按旧版失败收口。
     */
    const reconcileFailedFinish = async (segment: AsyncVoiceSegment): Promise<"ended" | "listening" | "unknown"> => {
      if (segment.ended || segment.settling) return "ended";
      try {
        const status = await ctx.voiceInput.getStatus(segment.sessionId);
        // 回查期间后台等待者可能已拿到终稿开始收尾：以它为准，不再看这份可能过时的快照。
        if (segment.ended || segment.settling) return "ended";
        if (status.sessionId === segment.sessionId) {
          if (status.phase === "listening") return "listening";
          if (status.phase === "recognizing") return "ended";
        }
        // 终稿已出、还没确认：普通状态不带它，按 waitMs 0 再问一次 Host 是否还认得这段。
        const outcome = await ctx.voiceInput.getStatus(segment.sessionId, { waitMs: 0 });
        if (segment.ended || segment.settling || outcome.pending || outcome.result || outcome.resultError) return "ended";
      } catch {
        // 查不清就按旧版失败收口。
      }
      return segment.ended || segment.settling ? "ended" : "unknown";
    };

    /** 一段听写在开录那一刻冻结的收尾上下文：多段并存时下一段开录不会改掉它。 */
    interface InputSessionContext {
      deliveryTarget: VoiceDeliveryTargetRef | undefined;
      insertText: boolean | undefined;
      polish: VoicePolishSetting;
      context: Promise<VoiceContextEnvelope | undefined>;
      selection: SavedInputSelection | undefined;
      clipPress: VoiceClipPressToken | undefined;
    }

    /** 听写拿到 Host 终稿之后的收尾：云端转写 / 片段增强 → 润色 → 写回 → 落历史。 */
    const completeInputResult = async (
      result: VoiceInputResult,
      session: InputSessionContext,
      signal: AbortSignal | undefined,
      releasedAtMs: number,
      slotOwner: VoiceSlotOwner,
      /** 后台收尾段的生命周期（插件停用即中止）：写回前核对。同步收尾不传，行为不变。 */
      lifecycle?: AbortSignal,
    ): Promise<VoiceInputResult> => {
      if (result.audio) {
        return await finishCloudTranscript(
          result,
          result.audio,
          session.deliveryTarget,
          session.insertText,
          session.polish,
          await session.context,
          session.selection,
          slotOwner,
          lifecycle,
        );
      }

      // 片段增强（audio.clips@1）：键盘持续收音补按下前的话、松开后顺延 1.5 秒。只在 Host
      // 已正常识别出文字时才替换（取消、没听到都保持原样，片段不能复活一次已结束的录音）；
      // 不可用 / 失败 / 超时 / 为空一律退回 Host 会话自己的识别结果（与旧版一致）。
      const hostTranscript = result.transcript?.trim() ?? "";
      const enhanceClip = session.clipPress !== undefined && hostTranscript !== "" && result.outcome !== "cancelled";
      const clipTranscript = !enhanceClip ? undefined : await voiceClipCapture?.enhance({
        token: session.clipPress!,
        releasedAtMs,
        boardRoute: true,
      }).catch(() => undefined);
      // 只有真的等过片段才复核取消；没走片段时保持旧版行为不变。
      if (enhanceClip) throwIfAborted(signal);
      const localTranscript = clipTranscript ?? hostTranscript;
      if (localTranscript) {
        // 本地与云端识别走同一条收尾：润色（仅输入法）→ commit → 失败弹取回卡 → 落历史。
        return await deliverRecognizedText({
          result,
          transcript: localTranscript,
          recognitionEngine: "local",
          originalSelection: session.selection,
          deliveryTarget: session.deliveryTarget,
          insertText: session.insertText,
          polish: session.polish,
          context: await session.context,
          slotOwner,
          lifecycle,
        });
      }
      overlayStages.release(result.sessionId);
      publish(settledPatch({ phase: "idle", activeMode: undefined, sessionId: undefined }, slotOwner));
      return result;
    };

    /** 识别结束后才失败（云端转写失败等）或取消：没有写入可等，收起中央胶囊。 */
    const settleInputFailure = (
      cause: unknown,
      sessionId: string | undefined,
      /** 失败发生在开录 / 结束这一步（持有录音槽）：直接复位；收尾段只动自己的字段。 */
      owner = false,
    ): VoiceInputResult => {
      const settle = <P extends Partial<VoiceViewState>>(patch: P) => publish(owner ? patch : settledPatch(patch, { sessionId }));
      // 已报 insert_failed 的会话 Host 已结算，这次确认是空操作。
      overlayStages.release(sessionId);
      if (isVoiceCancellation(cause)) {
        settle({
          phase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          error: undefined,
        });
        return cancelledVoiceInputResult();
      }
      settle(Object.assign(failurePatch("recognize", cause), {
        phase: "idle" as const,
        activeMode: undefined,
        sessionId: undefined,
      }));
      throw cause;
    };

    const toggleInput = async (
      signal?: AbortSignal,
      insertText?: boolean,
      finishSessionId?: string,
      startOnly = false,
      /** 硬件触发时 Host 签发的一次性来源凭证：开始录音时原样回传，让发起设备的麦优先。 */
      triggerRef?: string,
    ): Promise<VoiceInputResult> => {
      // 已确认 Host 支持多段：上一段（含前台命令）还在收尾不再挡新录音，只让正在录的命令段。
      const busy = hostAsyncFinish
        ? toggleInFlight || serviceOperationActive || state.commandPhase === "preparing"
          || state.commandPhase === "listening" || state.commandPhase === "recognizing"
        : toggleInFlight || serviceOperationActive || state.commandPhase === "processing" || state.activeMode === "command";
      if (busy) {
        throw new VoiceAppError({
          code: "com.reai.voice/VOICE_BUSY",
          get userMessage() { return t("app.thePreviousRecordingIsStillProcessing"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      throwIfDictating();
      // 写回一律由插件经 voice.deliver@1 完成（本地与云端引擎都一样，Host 不再替写）。
      // 写回权限已经明确拒绝时，下一段若仍然开始录音，只会在整段识别完成后再次写不进去。
      // 必须在采集前拦住并给出可恢复路径。
      if (
        !finishSessionId && (deliveryPermissionBlocked || state.deliveryPermissionBlocked)
        && insertText !== false
      ) {
        const error = new VoiceAppError({
          code: "com.reai.voice/VOICE_DELIVER_PERMISSION_REQUIRED",
          get userMessage() { return t("app.voiceInputIsPausedEnableTextInsertion"); },
          retryable: true,
        }, undefined, { constantMessage: true });
        publish(failurePatch("deliver", error, () => error.userMessage));
        throw error;
      }
      toggleInFlight = true;
      publish({ error: undefined });
      let finishedInputSessionId: string | undefined;
      let completingSessionId: string | undefined;
      try {
        const completing = state.phase === "listening";
        if (completing) {
          completingSessionId = state.sessionId;
          publish({ phase: "recognizing" });
        } else {
          await awaitVoicePreparation(signal, () => settingsSaveChain);
          const settings = { ...state.settings };
          pendingInputSelection = snapshotVoiceSelection();
          if (pendingInputSelection.engine === "cloud") await awaitVoicePreparation(signal, () => selectedCloudModel(pendingInputSelection!));
          await awaitVoicePreparation(signal, () => configuration.prepare(settings));
        }
        throwIfAborted(signal);
        const useCloud = pendingInputSelection?.engine === "cloud";
        const polish = state.settings.polish;
        // 硬件按键开录（start）声明结束即返回；页面按钮的 toggle 与旧 Host 照旧同步收尾。
        const asyncFinish = startOnly && !completing && asyncFinishCapable();
        // 识别与插入解耦（Host API 1.22）：Host 一律只出文本，润色之后由插件经
        // delivery.commit 写回（`deliverRecognizedText`）。Host 若先把识别原文打进去，
        // 润色稿再打一遍，用户会看到同一句话出现两次。
        // 调用前的时刻：开始时即按下时刻，结束时即松开时刻（片段增强用）。
        const callAt = Date.now();
        const result = finishSessionId ? await ctx.voiceInput.finish(finishSessionId) : await (startOnly
          ? (options: Parameters<typeof ctx.voiceInput.toggle>[0]) => startOwnedCapture(signal, {
            ...options ?? {},
            ...(asyncFinish ? { asyncFinish: true } : {}),
          })
          : ctx.voiceInput.toggle)({
          mode: "input",
          insertText: false,
          // 胶囊停到写入成功那一刻再收（旧 Host 忽略此项，照旧 1.2 秒自收）。
          holdOverlayUntilAck: true,
          ...(useCloud ? { retainAudio: true } : {}),
          // 只在开始录音时回传（凭证一次性；结束不需要）。旧 Host 忽略此项。
          ...(triggerRef && !completing ? { triggerRef } : {}),
        });
        if (signal?.aborted) {
          if (result.phase === "listening" && result.sessionId) await ctx.voiceInput.cancel(result.sessionId);
          throwIfAborted(signal);
        }
        if (result.phase === "listening") {
          noteCaptureLimit(result);
          if (result.sessionId && pendingInputSelection) {
            // Failure leaves an honest unknown snapshot on recovery; it must not cancel audio.
            void inputSelections.remember(result.sessionId, pendingInputSelection).catch(() => undefined);
          }
          // 写回目标、「要不要写回」的意图、润色档位都只在这一次（录音开始）成立；
          // 结束那次 Host 完全忽略参数，插件这边也必须用开始时冻住的值。
          pendingDeliveryTarget = result.deliveryTarget;
          pendingInsertText = insertText;
          pendingPolish = polish;
          // 片段增强只用于与 Host 片段转写参数一致的本地识别设置；其余沿用原链路。Host 切片已与
          // 片段增强同一窗口（captureModel）时不再做第二次识别。
          pendingClipPress = pendingInputSelection && clipTranscriptionMatches(pendingInputSelection)
            && state.captureModel !== SPAN_MARKERS_CAPTURE_MODEL
            ? voiceClipCapture?.press(callAt) : undefined;
          // 「触发语音瞬间焦点窗口」——现在采，不是等说完再采。等说完的话，
          // 焦点很可能已经换了窗口，采到的是另一个应用里的文字。
          // 与说话并行进行，收尾时直接拿结果，不给关键路径加等待。
          pendingContext = polish === "raw"
            ? Promise.resolve(undefined)
            : assembleContext(result.sessionId).catch(() => undefined);
          if (asyncFinish && result.sessionId) {
            registerInputSegment(result.sessionId, frozenInputContext());
          }
          publish({ phase: "listening", activeMode: "input", sessionId: result.sessionId });
          return result;
        }

        finishedInputSessionId = result.sessionId;
        const session = frozenInputContext();
        pendingInputSelection = undefined;
        pendingDeliveryTarget = undefined;
        pendingInsertText = undefined;
        pendingPolish = "raw";
        pendingContext = Promise.resolve(undefined);
        pendingClipPress = undefined;

        const segment = result.sessionId ? asyncSegments.get(result.sessionId) : undefined;
        if (isFinalizingResult(result) && result.sessionId) {
          // 结束即返回：录音槽空出，这段的收尾交给后台任务（终稿用 getStatus 长轮询取回）。
          const sessionId = result.sessionId;
          finalizeAsyncSegment(sessionId, () => registerInputSegment(sessionId, session));
          return result;
        }
        // Host 按同步语义收尾（旧 Host 忽略 asyncFinish）：撤掉段登记，就地收尾。
        if (segment) asyncSegments.delete(segment.sessionId);
        // 同步收尾：录音槽此刻仍归这一段（Host 没回 sessionId 时也认得）。
        return await completeInputResult(result, session, signal, callAt, { sessionId: state.sessionId });
      } catch (cause) {
        // asyncFinish 段的结束请求失败：回查 Host。已结束（多半是 Host 先结束了它：胶囊 ✓ / 录音上限）
        // 就交给后台等待者收口、不重复报错；还在录就保持在录，可以再按一次结束。
        // 后台等待者已经收完尾（段登记已撤）：结果已交付，不再报这次结束请求的失败。
        if (completingSessionId && settledAsyncSessions.has(completingSessionId)) return cancelledVoiceInputResult();
        const owned = completingSessionId ? asyncSegments.get(completingSessionId) : undefined;
        if (owned) {
          const host = await reconcileFailedFinish(owned);
          if (host === "ended" || owned.ended || owned.settling) {
            endAsyncSegment(owned);
            return cancelledVoiceInputResult();
          }
          if (host === "listening" && state.sessionId === owned.sessionId) {
            publish(Object.assign(failurePatch("recognize", cause), { phase: "listening" as const }));
            throw cause;
          }
          dropAsyncSegment(owned);
        }
        return settleInputFailure(cause, finishedInputSessionId, true);
      } finally {
        toggleInFlight = false;
      }
    };

    /** 当前 pending* 即这一段开录时冻结的上下文。 */
    const frozenInputContext = (): InputSessionContext => ({
      deliveryTarget: pendingDeliveryTarget,
      insertText: pendingInsertText,
      polish: pendingPolish,
      context: pendingContext,
      selection: pendingInputSelection,
      clipPress: pendingClipPress,
    });
    const registerInputSegment = (sessionId: string, session: InputSessionContext) =>
      registerAsyncSegment(sessionId, "input", segment => ({
        complete: async result => {
          try {
            const lifecycle = asyncActivation.signal;
            return await completeInputResult(result, session, lifecycle, segment.endedAt ?? Date.now(), { sessionId }, lifecycle);
          } catch (cause) {
            return settleInputFailure(cause, result.sessionId ?? sessionId);
          }
        },
        fail: async cause => settleInputFailure(cause, sessionId),
      }));

    // 硬件键常在 Voice 页从没打开时使用（整页刷新只在挂载时跑）：启动时读一次 Host 状态，
    // 拿到切片口径，硬件开录才知道能否声明 asyncFinish。读不到就按旧 Host 处理。
    void readVoiceStatus().catch(() => undefined);
    let statusPollInFlight = false;
    // 「今天存了 N 段 · X 字」在收听中也要跟着长：refresh() 的调用点全在收听
    // 路径之外（activate/模型/权限/删段/任务返回），且它带 phase 守卫、会话进行中
    // 不更新 recordings——没有这一拍，用户开着 Context 档听一小时，数字静默欠报
    // 且无自愈时机（dsh 补审对 #340 的核正）。单独轻量刷段列表：只 list 这一项
    // 请求，5s 一拍、独立 in-flight，出错就静默等下一拍，不拖累 status 轮询。
    let recordingsPollInFlight = false;
    let recordingsPollAt = 0;
    voiceStatusPoll = window.setInterval(() => {
      if (!recoverablePollInFlight && Date.now() - recoverablePollAt >= 1000) {
        void syncRecoverableInputSessions();
      }
      if (
        toggleInFlight ||
        serviceOperationActive ||
        !shouldPollVoiceStatus(state)
      ) {
        return;
      }
      // Background Context recording continues while dictation itself is idle.
      const listeningNow = state.phase === "listening" || state.commandPhase === "listening"
        || (state.timeline?.state === "running" && state.timeline.continuousRecordingEnabled
          && state.timeline.recordingState === "running");
      if (listeningNow && !recordingsPollInFlight && Date.now() - recordingsPollAt >= 5000) {
        recordingsPollInFlight = true;
        recordingsPollAt = Date.now();
        const expectedRecordings = state.recordings;
        const expectedRecordingsTotal = state.recordingsTotal;
        void ctx.voiceRecordings
          .list({ page: 0, perPage: 50 })
          .then((recordings) => {
            // A user edit or refresh while this request was in flight takes precedence.
            if (state.recordings !== expectedRecordings || state.recordingsTotal !== expectedRecordingsTotal) return;
            if (recordings.total !== state.recordingsTotal
              || JSON.stringify(recordings.items) !== JSON.stringify(state.recordings)) {
              publish({ recordings: recordings.items, recordingsTotal: recordings.total });
            }
            scheduleDigestCheck();
          })
          .catch(() => undefined)
          .finally(() => {
            recordingsPollInFlight = false;
          });
      }
      if (statusPollInFlight) {
        return;
      }
      const expectedSessionId = state.sessionId;
      const expectedSourceRevision = sourceSettingsRevision;
      statusPollInFlight = true;
      void readVoiceStatus(expectedSessionId)
        .then((status) => {
          if (toggleInFlight || state.sessionId !== expectedSessionId || sourceSettingsRevision !== expectedSourceRevision) return;
          // Host 自己结束了正在录的 asyncFinish 段（胶囊 ✓ / 录音上限）：它进了收尾集合，本地让出录音槽，
          // 终稿由这段的后台等待者取回。
          const liveSegment = expectedSessionId ? asyncSegments.get(expectedSessionId) : undefined;
          if (liveSegment && !liveSegment.ended && status.phase === "recognizing" && status.sessionId === expectedSessionId) {
            endAsyncSegment(liveSegment);
            return;
          }
          const authoritative = reconcileAuthoritativeVoiceStatus(
            state,
            status,
            expectedSessionId,
          );
          if (authoritative) {
            publish({ ...voiceSourceStatusPatch(withConfirmedArchive(status)), ...authoritative, get error() { return authoritative.error; } });
            if (
              status.sessionId
              && voiceStatusPollMayAcknowledge({
                serviceOperationActive,
                expectedSessionId,
                statusSessionId: status.sessionId,
                stopReason: status.stopReason,
              })
            ) {
              void ctx.voiceInput.acknowledgeResult(status.sessionId).catch(() => undefined);
            }
          } else if (state.phase === "idle" && state.commandPhase === "idle"
            && voiceAvailabilityChanged(state, status)) {
            publish(voiceSourceStatusPatch(withConfirmedArchive(status)));
          }
        })
        .catch(() => undefined)
        .finally(() => {
          statusPollInFlight = false;
        });
    }, 1000);

    const recordCommandFailure = async (
      taskId: string,
      transcript: string,
      cause: unknown,
      commandId?: VoiceCommandId,
      conversation?: VoiceAgentConversationRef,
      metadata?: Pick<VoiceChatMessage, "runtime" | "channel" | "usage">,
    ): Promise<{ persisted: boolean; message: string; alreadySettled?: boolean }> => {
      finalizeToolGroupCard(taskId);
      const original = normalizedError(cause);
      const failureFields = collectErrorFields(cause);
      const purpose: VoiceRequestPurpose | undefined = commandId === BUILTIN_VOICE_COMMANDS.agent
        ? "reply"
        : commandId === BUILTIN_VOICE_COMMANDS.translate
          ? "translation"
          : undefined;
      const normalized = original.code === "AGENT_RECEIPT_UNKNOWN"
        ? { ...original, get message() { return t("app.agentReceiptUnknown"); } }
        : purpose
        ? { ...original, get message() { return voiceRequestFailureMessage(purpose, cause); } }
        // 会落盘进命令历史：固定按普通模式的人话写，不存上游原文。
        : { ...original, get message() { return plainFailureText(cause); } };
      const presented = presentAgentToolError(
        isVoiceCancellation(cause) ? undefined : pendingWebToolError(taskId),
        normalized,
      );
      const createdAt = activeCommandRuns.get(taskId)?.createdAt ?? new Date().toISOString();
      const cards = [...(commandAgentCards.get(taskId) ?? [])];
      if (presented.card && !cards.some((card) => card.kind === presented.card?.kind)) {
        cards.push(presented.card);
      }
      const messages: VoiceChatMessage[] = [
        { from: "user", text: transcript, at: createdAt, attachments: activeCommandRuns.get(taskId)?.inputAttachments },
        ...cards.map((card) => ({ from: "ai" as const, text: "", at: createdAt, card,
          ...(metadata?.runtime ? { runtime: metadata.runtime } : {}),
          ...(metadata?.channel ? { channel: metadata.channel } : {}),
        })),
        { from: "ai", text: presented.message, at: createdAt, ...metadata },
      ];
      const item: VoiceCommandHistoryItem = {
        id: taskId,
        transcript,
        status: "failed",
        createdAt,
        ...(commandId !== undefined ? { commandId } : {}),
        // 失败也留在同一段会话里：详情页按会话聚合，这轮追问失败了也该出现在那页上。
        ...(conversation ?? {}),
        errorCode: presented.code,
        // §6.0：只落结构化字段（原文字符数、来源、HTTP 状态码）与真实失败时刻；原文只进内存表。
        ...commandFailureFields(failureFields),
        failedAt: new Date().toISOString(),
        ...(original.code === "AGENT_RECEIPT_UNKNOWN" && typeof (cause as { pendingRequestId?: unknown })?.pendingRequestId === "string"
          ? { agentRequestKey: (cause as { pendingRequestId: string }).pendingRequestId } : {}),
        get userMessage() { return presented.message; },
        messages,
      };
      try {
        const previous = state.commandHistory;
        const settlement = await repository.settleCommandHistory(item,
          () => !abortedCommandClaims.has(taskId));
        const commandHistory = settlement.history;
        if (!settlement.applied) {
          commandLifecycleTrace("late_failure_dropped", taskId);
          return { persisted: false, message: presented.message, alreadySettled: true };
        }
        await releaseTrimmedCommandAgentSessions(previous, commandHistory);
        publish({
          commandHistory: withOtherRunningCommands(commandHistory, taskId),
          get error() { return presented.message; },
          errorDetail: errorDetailFrom(commandStepKey(commandId), cause, { fields: failureFields }),
          failureRaw: withFailureRaw({ [`command:${taskId}`]: failureFields.raw }),
        });
        return { persisted: true, message: presented.message };
      } catch (storageCause) {
        publish(settledPatch({
          commandPhase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          get error() { return voiceHistorySaveFailureMessage(purpose ?? "transcription"); },
          errorDetail: errorDetailFrom("historySave", storageCause),
        }));
        return { persisted: false, message: presented.message };
      }
    };

    /**
     * 把最终文本写回录音结束时固定的输入位置。
     *
     * Host 跟踪录音期间的输入目标，停止时固定；写入前仍会验证目标可用，单次目标只消费一次。
     * 没有交付目标（页面点的那次录音就没有）时视为「不写回」，不编一个目标出来。
     */
    const deliver = async (
      target: { id: string } | undefined,
      text: string,
    ): Promise<{ committed: boolean; reason?: string; code?: string }> => {
      if (!target) return { committed: false, reason: "no_input_target" };
      // **绝不让它抛**：写回是最后一步，写回失败与「云端没跑成」是两回事。
      // 让它冒泡出去的话，一次云端成功会被外层的 catch 当成云端失败，
      // 转文本还会顺势走「回退原文」——把一次成功记成失败，用户看到的解释也是错的。
      // 写回权限是可选的（用户可以拒绝授权），所以这条路真的会被走到。
      try {
        const result = await ctx.delivery.commit({ targetId: target.id, text });
        return result.committed
          ? { committed: true }
          : { committed: false, reason: result.reason };
      } catch (cause) {
        // reason 只是文案类别（权限 / 不可用 / 写入失败）；登记过的真实码另存，卡片与诊断用它，
        // 不许把 VOICE_DELIVER_INVALID_REQUEST 之类的真实码抹成 insert_failed（§6.0 ⑦）。
        const code = structuredCode(normalizedError(cause).code);
        return { committed: false, reason: deliveryFailureReason(cause), ...(code ? { code } : {}) };
      }
    };

    /**
     * 转文本 / 翻译的失败卡：写回没成功，或翻译本身失败（这时内容是原文）。
     *
     * 只弹 Host 这一张系统级取回卡（全文 + 一键复制）——Command 会话 commit 失败 Host
     * 不会自动弹卡（Host API 1.22），必须由这里显式请求。
     *
     * 返回卡是否已被 Host 接下。被拒（旧 Host 不认这条方法；或写回权限被拒——Host 对
     * `voice.deliver.*` 共用同一道权限门，取回卡会跟着被拒）时，转文本与翻译都由调用方改走
     * 失败结果面板兜底，不能因为「没写进去」连一个窗口都不给。
     */
    /** 取回卡：原因是固定短句（旧 Host 靠它看到码）；新 Host 另收结构化 errorCode，原始原因不传。 */
    const presentCommandTakeback = async (input: CommandTakebackCard): Promise<boolean> => {
      if (!input.text.trim()) return true;
      const { code, ...card } = input;
      try {
        await ctx.delivery.presentTakeback({ ...card, ...hostErrorCode(code) });
        return true;
      } catch {
        return false;
      }
    };

    /**
     * 前台结果面板的呈现结局。`defer`：Host 要求转后台（`VOICE_ANSWER_DEFER_REQUIRED`，胶囊叠放下
     * 有新一段正在录音或前台面板被占），调用方改投 running 帧交接到角落、完成后以 deferred 呈现。
     * 其余失败与旧版一样吞掉，不影响命令本身。
     */
    type VoiceAnswerPresentation = "presented" | "defer" | "failed";
    const answerPresentationFailure = (cause: unknown): VoiceAnswerPresentation => {
      const code = normalizedError(cause).code;
      return code === VOICE_ANSWER_DEFER_REQUIRED || code.endsWith(`/${VOICE_ANSWER_DEFER_REQUIRED}`) ? "defer" : "failed";
    };

    /**
     * 取回卡被拒时的兜底窗口（转文本与翻译；成功从不走这里）：同一张卡的内容改走结果面板的失败态——标题、结果全文（可复制）、
     * 原因与真实错误码都不变，不带任何「已写入」字样。前台在收尾处直接弹；已转入后台的
     * 先报终态帧再以迟到结果框（`deferred`，runId = 后台任务 taskId）弹。
     */
    const presentTakebackFallback = async (input: {
      taskId: string;
      commandId: VoiceCommandId;
      transcript: string;
      card: CommandTakebackCard;
      itemPersisted: boolean;
      deferred?: boolean;
    }): Promise<boolean> => {
      const { card } = input;
      return await ctx.voiceCommand.presentAnswer({
        runId: input.taskId,
        badge: COMMAND_LABEL[input.commandId],
        title: card.title,
        text: card.text,
        originalText: input.transcript,
        status: "failed",
        ...hostErrorCode(card.code),
        sections: [
          ...(input.transcript ? [{ label: t("app.original"), text: input.transcript }] : []),
          // 翻译本身失败、转文本原文回退时卡里就是原文，不重复摆一段。
          ...(card.text !== input.transcript
            ? [{ label: t("app.valueResult", { value0: COMMAND_LABEL[input.commandId] }), text: card.text }]
            : []),
          { label: t("app.error"), text: card.reason },
        ],
        canCopy: true,
        canContinue: input.itemPersisted,
        ...(input.deferred ? { deferred: true } : {}),
      }).then(() => true, () => false);
    };

    /**
     * 转文本 / 翻译交付确认后收尾：不弹结果框，只把中央「处理中」胶囊收掉。
     *
     * 命令会话识别结束后 Host 留有待确认记录，按原 sessionId 确认即收胶囊；本地识别与
     * 云端识别（retainAudio）同口径。确认失败或旧 Host 不认时，胶囊由 Host 的处理态
     * 安全帽或下一次录音收掉。确认走阶段队列，写回失败也只有取回窗口确认可见后才释放。
     */
    const finishWriteBackInForeground = (taskId: string, resultSessionId: string | undefined) => {
      overlayStages.release(resultSessionId);
      releaseForegroundCommand(taskId);
    };

    /**
     * Agent 的只读结果框。3 秒内完成走前台面板；转入后台胶囊之后才完成的走迟到结果框
     * （Host API 1.22 `deferred`：被动显示、不抢键盘；runId 必须是后台任务的 taskId，
     * 且调用前已报终态帧）。「继续」由 Host 打开主窗口里这条任务的会话详情。
     */
    const presentAgentResult = async (input: {
      runId: string;
      commandId: VoiceCommandId;
      transcript: string;
      reply: string;
      title?: string;
      itemPersisted: boolean;
      deferred?: boolean;
      /** 这份结果来自哪段 `asyncFinish` 录音（只给非 deferred 的前台呈现）。 */
      voiceSessionId?: string;
    }): Promise<VoiceAnswerPresentation> => {
      return await ctx.voiceCommand.presentAnswer({
        runId: input.runId,
        badge: COMMAND_LABEL[input.commandId],
        title: input.title ?? t("app.valueResult", { value0: COMMAND_LABEL[input.commandId] }),
        text: input.reply,
        originalText: input.transcript,
        status: "succeeded",
        sections: [
          { label: t("app.prompt"), text: input.transcript },
          // Host 面板按纯文本显示分段：答案去掉 Markdown 标记（不露 ** / - / #）；
          // 「复制」取 text，仍是模型原文，贴到支持 Markdown 的地方格式不丢。
          { label: t("app.answer"), text: plainReply(input.reply) },
        ],
        canCopy: input.reply.length > 0,
        canContinue: input.itemPersisted,
        ...(input.deferred ? { deferred: true } : {}),
        ...(!input.deferred && input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
      }).then(() => "presented" as const, answerPresentationFailure);
    };

    const presentForegroundFailure = async (input: {
      taskId: string;
      commandId: VoiceCommandId;
      transcript: string;
      message: string;
      itemPersisted: boolean;
      /** 真实错误码（进诊断节；浮层只放安全字段，不放上游原文）。 */
      code?: string;
      /** Agent 引擎阶段 / 退出码 / 上游码（已采集字段里按出身取的结构化值）。 */
      agentFailure?: VoiceErrorFields["agentFailure"];
      /** 这份结果来自哪段 `asyncFinish` 录音。 */
      voiceSessionId?: string;
    }): Promise<VoiceAnswerPresentation> => {
      // 业务字段只含失败主句；结构化码交给 Host 开发模式诊断区。
      return await ctx.voiceCommand.presentAnswer({
        runId: input.taskId,
        badge: COMMAND_LABEL[input.commandId],
        get title() { return t("app.valueIncomplete", { value0: COMMAND_LABEL[input.commandId] }); },
        // 普通内容复制只含失败主句；技术字段通过 Host 独立诊断入口复制。
        text: input.message,
        originalText: input.transcript,
        status: "failed",
        // Host API 1.22（#953 同版本并入）：面板失败区显示并随「复制诊断」复制；旧 Host 忽略。原始原因不传。
        ...hostErrorCode(input.code),
        sections: [
          ...(input.transcript
            ? [{ label: t("app.original"), text: input.transcript }]
            : []),
          { label: t("app.error"), text: input.message },
        ],
        canCopy: true,
        canContinue: input.itemPersisted,
        ...(input.voiceSessionId ? { voiceSessionId: input.voiceSessionId } : {}),
      }).then(() => "presented" as const, answerPresentationFailure);
    };

    /**
     * 确认目标 Agent 可用。`requireScope` = 用户显式选了某个 Agent 且这次要用文件 / 命令：
     * 该 Agent 没有范围执行时明确报错，不偷换成别的 Agent。
     */
    const requireUnifiedAgentReady = async (requestedBackend: AgentBackend = state.agentExperiment.backend, requireScope = false) => {
      const snapshot = await ctx.agent.backends({ schemaVersion: 2 });
      const readiness = agentReadiness(requestedBackend, snapshot);
      if (readiness.kind === "ready") {
        if (requireScope && !availableConversationBackends(snapshot.backends).some(status => status.backend === readiness.backend)) {
          const status = snapshot.backends.find(status => status.backend === readiness.backend);
          throw new VoiceAppError({ code: "AGENT_SCOPE_UNAVAILABLE", userMessage: scopeUnavailableMessage(status, t("chat.scopeUnavailable")), retryable: false }, undefined, { constantMessage: true });
        }
        return;
      }
      if (readiness.kind === "preference-invalid") {
        throw new VoiceAppError({
          code: "AGENT_BACKEND_UNAVAILABLE",
          get userMessage() { return t("app.agentDefaultUnavailable"); },
          retryable: false,
        }, undefined, { constantMessage: true });
      }
      const blocked = readiness.status;
      const backend = blocked?.backend === "dsh" ? "DSH" : blocked?.backend === "codex" ? "Codex" : "Pi";
      if (blocked?.downloadRequired) {
        // Called only for an explicit Agent/translation action. Host binds the source
        // app identity and owns preview, consent, verification and attachment. Opening
        // this page is not approval: stop here and require a new action after return.
        try {
          await ctx.systemTasks.open({
            target: "app-managed-resources",
            returnIntent: { reason: "voice-agent-runtime", backend: blocked.backend },
          });
        } catch (cause) {
          // 导航失败的原因只进插件界面的诊断（不可枚举字段），不经 cause 交给 SDK / Host。
          throw new VoiceAppError({
            code: "AGENT_BACKEND_UNAVAILABLE",
            get userMessage() { return t("app.agentRuntimeSetupUnavailable", { backend }); },
            retryable: true,
          }, withOuterCode(collectErrorFields(cause), "AGENT_BACKEND_UNAVAILABLE"), { constantMessage: true });
        }
      }
      throw new VoiceAppError({
        code: "AGENT_BACKEND_UNAVAILABLE",
        get userMessage() { return blocked?.downloadRequired
          ? t("app.theAgentRuntimeIsNotInstalledYet", { backend })
          : voiceAgentUnavailableMessage(blocked?.detail); },
        retryable: blocked?.downloadRequired === true,
        cause: blocked?.downloadRequired ? { kind: "agent-runtime-missing" } : undefined,
        // 主句只有插件文案；voiceAgentUnavailableMessage 只拿 detail 分类，不拼进返回值。
      }, undefined, { constantMessage: true });
    };

    const runCommandAgent = async (
      taskId: string,
      controller: AbortController,
      transcript: string,
      commandId: VoiceCommandId,
      target: { id: string } | undefined,
      options: CommandRunOptions = {},
    ) => {
      const isRunActive = () => activeCommandRuns.get(taskId)?.controller === controller;
      // Only this run's returned Host envelope is evidence; settings/pre-dispatch
      // errors cannot supply historical runtime or usage. Snapshot before throws.
      let finalAgentMetadata: Pick<VoiceChatMessage, "runtime" | "channel" | "usage"> | undefined;
      const targetLanguage = options.translationTarget ?? state.featureSettings.translationTarget;
      // 胶囊叠放的后台收尾段带开录时冻结的润色档；其余入口照旧读当下设置。
      const polishSetting = options.polish ?? state.settings.polish;
      const writesBack = shouldWriteBack(commandId) && !(commandId === BUILTIN_VOICE_COMMANDS.translate && options.readOnlyTranslation);
      const startedAt = Date.now();
      let snapshot = initialSnapshot({
        taskId,
        // 任务卡是**桌面角落的常驻浮层**，标题会被旁人和屏幕共享看见。
        // 硬件触发的这一条沿用说话内容（用户刚说完，自己知道那是什么）；
        // 从历史里挑一段发出去时由调用方给中性标题，别把一段旧对话贴上桌面。
        title: options.title ?? `${COMMAND_LABEL[commandId]} · ${transcript.slice(0, 20)}`,
        startedAt,
      });
      snapshot = {
        ...snapshot,
        stageLabel: commandId === BUILTIN_VOICE_COMMANDS.agent
          ? t("app.agentIsWorking")
          : COMMAND_STAGE[commandId],
      };
      // 帧必须串行投递：Tauri 各 invoke 独立异步处理，Host 侧不保证跨请求顺序。
      // 三帧并发在飞时，极快失败的终态帧可能先被处理、随后被 running 帧覆盖，
      // 卡片就永久停在转圈。链上的失败照旧吞掉——呈现失败不该影响命令本身。
      let presentChain: Promise<unknown> = Promise.resolve();
      let runningFramePresented = false;
      let taskSettled = false;
      // 终态帧一旦入链，晚到的等待变化不再投 running 帧（否则可能排在终态之后）。
      let terminalQueued = false;
      const present = (frame: typeof snapshot): Promise<unknown> => {
        // 终态帧一律不带等人旗：任务结束就不再「等你确认」。
        const sent = frame.state === "running" ? frame : { ...frame, waiting: false };
        if (sent.state !== "running") terminalQueued = true;
        // 胶囊叠放：带上录音会话，Host 认得栈里的那一枚（交接从它起飞、只收它）。旧 Host 忽略。
        const framed = options.voiceSessionId ? { ...sent, voiceSessionId: options.voiceSessionId } : sent;
        // 链上只留「这一帧是否送达」：失败照旧吞掉，交接确认据此决定。
        presentChain = presentChain
          .then(() => ctx.voiceCommand.presentTask(framed))
          .then(() => true, () => false);
        return presentChain;
      };
      /**
       * `asyncFinish` 录音的 Agent 段不写回：交接到角落成功后即确认消费，让 Host 放开排在它后面的
       * 写回与这段的终稿保留；运行结束时（finally）无论结局都确认一次，免得后面的写回干等 Host 超时
       * （确认是幂等的，重复无害）。写回类命令照旧在写回确认处释放。
       */
      const releaseVoiceSegment = () => {
        if (options.voiceSessionId && !writesBack) overlayStages.release(options.voiceSessionId);
      };
      /** 前台呈现被 Host 要求转后台：补 running 帧交接到角落，此后按后台口径收尾。 */
      const deferToBackground = async (): Promise<"background"> => {
        const first = present(snapshot);
        runningFramePresented = true;
        const handedOff = await first;
        releaseForegroundCommand(taskId);
        if (handedOff) releaseVoiceSegment();
        return "background";
      };
      let feedbackChain: Promise<unknown> = Promise.resolve();
      const reportFeedback = (label: string) => {
        if (!options.resultSessionId) return;
        const sessionId = options.resultSessionId;
        feedbackChain = feedbackChain.then(() => {
          if (!isRunActive() || terminalQueued || runningFramePresented) return;
          return ctx.voiceInput.reportStage(sessionId, "processing", label.slice(0, 200));
        }).catch(() => undefined);
      };
      // 等你拍板期间胶囊亮「等你确认」并写明在等什么；全部等待结束后回到原阶段。
      // 还没转入后台时只更新快照，第 3 秒转后台那一帧自然带上。
      const openWaits = new Map<string, { reason: string; label: string }>();
      let stageBeforeWait: string | undefined;
      const onUserWait = (type: "wait.started" | "wait.ended", waitId: string, reason: string, label: string) => {
        if (!isRunActive() || terminalQueued) return;
        if (type === "wait.started") openWaits.set(waitId, { reason, label });
        else if (!openWaits.delete(waitId)) return;
        if (openWaits.size) {
          stageBeforeWait ??= snapshot.stageLabel;
          const latest = [...openWaits.values()].at(-1);
          const current = latest ? userWaitLabel(latest.reason, latest.label) : "";
          snapshot = {
            ...snapshot,
            waiting: true,
            stageLabel: current ? t("app.waitingForYouValue", { value0: current }) : t("app.waitingForYou"),
          };
        } else {
          snapshot = { ...snapshot, waiting: false, stageLabel: stageBeforeWait ?? snapshot.stageLabel };
          stageBeforeWait = undefined;
        }
        if (runningFramePresented) void present(snapshot);
        else reportFeedback(snapshot.stageLabel);
      };
      const onProgress = (label: string) => {
        if (!isRunActive() || terminalQueued || !label) return;
        if (openWaits.size) stageBeforeWait = label;
        else snapshot = { ...snapshot, stageLabel: label };
        if (runningFramePresented) void present(snapshot);
        else reportFeedback(snapshot.stageLabel);
      };
      commandProgressHandlers.set(taskId, onProgress);
      commandUserWaitHandlers.set(taskId, onUserWait);
      const presentationGate = createCommandPresentationGate({
        autoStart: false,
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancel: (timer) => window.clearTimeout(Number(timer)),
        // 仅 Agent 实际受理后计时；听写/翻译始终等待写回或取回确认。
        onBackgrounded: async () => {
          if (!isRunActive()) return;
          // 首帧入链即算已转后台：首帧还在发送时到来的等待变化接着排进同一条链，不会丢。
          const first = present(snapshot);
          runningFramePresented = true;
          const handedOff = await first;
          releaseForegroundCommand(taskId);
          if (handedOff) releaseVoiceSegment();
        },
      });
      // 会话 id 放在 try 外：失败条目也要留在同一段对话里。
      let agentSessionId = options.agentSessionId;
      let createdByThisRun = false;
      let historyPersisted = false;
      let journalSessionLinked = !!agentSessionId;
      try {
        // 润色只作用于语音输入法——「转文本」命令就是它（2026-09-27 定稿）；翻译与 Agent
        // 不润色，交给它们的就是识别原文（翻译效果在翻译 Agent 层优化）。
        // 这也是 `VoiceContextEnvelope` 的真实消费方：窗口文字与近期语音作为参考材料随
        // 润色请求发出。与输入路径同一条口径：不润色就不消费上下文，一个字都不该去读——
        // 「顺手采了但没用上」和「采了」在隐私上没有区别，而且这行 await 卡在
        // 用户说完话之后、结果写回之前的关键路径上。
        const polishes = commandId === BUILTIN_VOICE_COMMANDS.transcribe
          && !options.recovery && !options.resume;
        // 中央胶囊换句子（仅写回类命令；Agent 的呈现规则不动）。
        if (commandId === BUILTIN_VOICE_COMMANDS.translate) {
          void overlayStages.report(options.resultSessionId, "translating");
        } else if (polishes && polishSetting !== "raw") {
          void overlayStages.report(options.resultSessionId, "polishing");
        }
        const context = !polishes || polishSetting === "raw"
          ? undefined
          : await (options.context ?? assembleContext(undefined, controller.signal).catch(() => undefined));
        if (!isRunActive()) return;
        throwIfCommandCancelled(controller.signal);
        const polished = options.resume ? { text: transcript } : options.recovery ? { text: options.recovery.request.text }
          : polishes ? await runPolish(polishSetting, transcript, context, controller.signal)
            : { text: transcript };
        if (!isRunActive()) return;
        throwIfCommandCancelled(controller.signal);
        // 润色没跑成不拦命令：交给 Agent 的仍是用户说的原话。这与输入路径同一条
        // 口径——绝不因为一个可选的加工步骤失败就让整件事办不成。
        let oneShotSessionId: string | undefined;
        const result = commandId === BUILTIN_VOICE_COMMANDS.transcribe
          ? { reply: polished.text, runId: crypto.randomUUID(), durationMs: Date.now() - startedAt }
          : await (async () => {
              const persistent = commandId === BUILTIN_VOICE_COMMANDS.agent;
              // 复用已有会话时：切换后的第一轮还没被 Host 受理过，续接上下文仍待送达。
              const continuationPending = Boolean(agentSessionId && options.conversationId
                && options.conversationOptions?.continuationPending
                && options.conversationOptions.sessionId === agentSessionId);
              let sessionId: string;
              if (persistent) {
                if (agentSessionId) {
                  sessionId = agentSessionId;
                } else {
                  // F02/F04：本对话的显式选择优先；否则沿用 Driver 默认。文件 / 命令
                  // 工具只在 Host 宣称范围执行可用时授予；用户显式选的 Agent 不支持时
                  // 明确报错，不偷换；沿用默认时退化为不带文件工具的普通聊天。
                  const backend = options.conversationOptions?.backend ?? state.agentExperiment.backend;
                  const backendSnapshot = await ctx.agent.backends({ schemaVersion: 2 });
                  noteHostAgentBackendStatuses(backendSnapshot.backends);
                  const readiness = agentReadiness(backend, backendSnapshot);
                  const status = readiness.kind === "ready" ? backendSnapshot.backends.find((item) => item.backend === readiness.backend) : undefined;
                  const scopedExecution = availableConversationBackends(status ? [status] : []).length > 0;
                  if (!scopedExecution && (options.conversationOptions?.backend || options.conversationOptions?.workspace?.kind === "direct")) {
                    throw new VoiceAppError({ code: "AGENT_SCOPE_UNAVAILABLE", userMessage: scopeUnavailableMessage(status, t("chat.scopeUnavailable")), retryable: false }, undefined, { constantMessage: true });
                  }
                  const created = await ctx.agent.createSession(await withVoiceFeatureRef(
                    createVoiceCommandSessionConfig({
                      backend, workspace: options.conversationOptions?.workspace, scopedExecution,
                    }),
                    "command",
                    undefined,
                    ctx.agent,
                    backendSnapshot.backends,
                  ));
                  sessionId = created.sessionId;
                  agentSessionId = sessionId;
                  createdByThisRun = true;
                  try {
                    // 用户显式选了目录 / Agent 时，Host 必须给出真实工作根与范围版本作为
                    // 系统边界证明，否则不发任何模型请求；默认流程以 Host 的能力声明为准。
                    const explicitScope = Boolean(options.conversationOptions?.backend || options.conversationOptions?.workspace?.kind === "direct");
                    if (scopedExecution && explicitScope && (created.scopeVersion !== 1 || !created.workspaceRoot || !created.workspace)) {
                      throw new VoiceAppError({ code: "AGENT_SCOPE_UNAVAILABLE", userMessage: t("chat.scopeUnavailable"), retryable: false }, undefined, { constantMessage: true });
                    }
                    await registerCommandAgentSession(sessionId);
                    if (options.conversationId) {
                      const conversationOptions = await repository.saveConversationOptions(options.conversationId, {
                        ...options.conversationOptions, sessionId,
                        ...(created.workspace ? { workspace: created.workspace } : {}),
                        ...(created.workspaceRoot ? { workspaceRoot: created.workspaceRoot } : {}),
                        ...(created.scopeVersion === 1 ? { scopeVersion: 1 as const } : {}),
                        resolvedBackend: created.backend,
                        // 续接上下文要等新会话第一轮被 Host 受理才算送达（受理前失败，重试仍需附上）。
                        ...(options.visibleContext?.length ? { continuationPending: true as const } : { continuationPending: undefined }),
                      });
                      publish({ conversationOptions });
                    }
                  } catch (cause) {
                    await ctx.agent.deleteSession({ sessionId }).catch(() => undefined);
                    throw cause;
                  }
                }
                const activeRun = activeCommandRuns.get(taskId);
                if (activeRun?.controller === controller) activeRun.agentSessionId = sessionId;
                await repository.attachCommandAgentSession(taskId, sessionId);
                journalSessionLinked = true;
                publishRunningAgentCards(taskId);
              } else {
                oneShotSessionId = (await ctx.agent.createSession(await withVoiceFeatureRef({
                    schemaVersion: 2,
                    runtime: state.agentExperiment.backend,
                    // 指认 manifest 声明的「翻译」功能；目标语言作为参数交给 Host
                    // 渲染/核验（systemPrompt 与模板渲染结果逐字节一致）。
                    systemPrompt: translationPrompt(targetLanguage),
                    tools: [],
                    skills: [],
                    workspace: { kind: "app-private" },
                    memory: "one-shot",
                  }, "translation", { targetLanguage: TRANSLATION_LANGUAGES[targetLanguage] }, ctx.agent))).sessionId;
                sessionId = oneShotSessionId;
              }
              // UI taskId stays stable; v2 receipt supplies the real runtime turnId.
              // The coordinator maps progress/cancellation and reuses this key on a lost ACK.
              const turnId = persistent ? taskId : crypto.randomUUID();
              const activeRun = activeCommandRuns.get(taskId);
              if (activeRun?.controller === controller) activeRun.durableAgent = persistent && sessionId.startsWith("agent2-");
              const cancelTurn = () => {
                void agentTurns.cancel({ sessionId, turnId }).catch(() => undefined);
              };
              controller.signal.addEventListener("abort", cancelTurn, { once: true });
              if (controller.signal.aborted) cancelTurn();
              try {
                throwIfCommandCancelled(controller.signal);
                // Legacy send has no acceptance receipt; dispatch is its observable start.
                if (persistent && !sessionId.startsWith("agent2-")) {
                  presentationGate.start();
                  onProgress(t("app.agentIsWorking"));
                }
                const outcome = await agentTurns.send({
                  sessionId,
                  turnId,
                  // F04：切换后的新会话在第一轮被受理之前（含受理前失败后的重试）都附上有界可见聊天。
                  // 翻译：明确的「只输出译文」指令 + 随机标记包住的原文，不把原话当成对它说的话。
                  text: !persistent ? translationTurnText(polished.text, targetLanguage)
                    : options.attachmentTurnText ?? (options.attachments?.length && !options.attachmentInput ? buildVoiceAttachmentTurn(polished.text, options.attachments.filter((file): file is Extract<PreparedVoiceAttachment,{content:string}> => file.kind!=="image"),
                      createdByThisRun || continuationPending ? options.visibleContext ?? [] : [], VOICE_TEXT_ATTACHMENT_POLICY)
                    : createdByThisRun || continuationPending ? continuationPrompt(options.visibleContext ?? [], polished.text) : polished.text),
                  ...(options.attachmentInput ? { attachmentInput: options.attachmentInput } : {}),
                  taskPresentation: "caller",
                  remember: persistent,
                  ...(persistent ? { onAccepted: async (ref: AgentTurnRef) => {
                    // F03：审批事件带的是 Host 原生 turnId。运行中的条目此前只有 UI taskId，
                    // 原生 id 对不上号，等待提示在回合进行期间根本显示不出来——先把 runId
                    // 挂到活动运行并重发运行中条目，再落库。
                    presentationGate.start();
                    onProgress(t("app.agentIsWorking"));
                    const acceptedRun = activeCommandRuns.get(taskId);
                    if (acceptedRun?.controller === controller) {
                      acceptedRun.runId = ref.turnId;
                      publishRunningAgentCards(taskId);
                    }
                    await repository.attachCommandAgentTurn(taskId, ref.sessionId, ref.turnId);
                    // F04：带着续接上下文的这一轮已被 Host 受理，上下文已进入新会话的记录；
                    // 之后（包括这一轮失败后的重试）不再重复附上。受理前就失败的，标记保留、下次重发。
                    const pendingChoice = options.conversationId ? state.conversationOptions?.[options.conversationId] : undefined;
                    if (options.conversationId && pendingChoice?.continuationPending && pendingChoice.sessionId === ref.sessionId) {
                      const { continuationPending: _delivered, ...delivered } = pendingChoice;
                      const conversationOptions = await repository.saveConversationOptions(options.conversationId, delivered).catch(() => undefined);
                      if (conversationOptions) publish({ conversationOptions });
                    }
                  } } : {}),
                  ...(options.resume ? { resume: options.resume } : {}),
                  ...(options.recovery ? { recovery: options.recovery } : {}),
                });
                if (abortedCommandClaims.has(taskId)) {
                  // 外部中止已认领终局并落「已中断」历史：丢弃晚到的成功，避免双写。
                  // 用取消错误离开正常路径，catch 里的认领检查会静默收尾。
                  commandLifecycleTrace("late_success_dropped", taskId);
                  throw commandCancelledError();
                }
                if (isRunActive() && (sessionId.startsWith("agent2-") || outcome.turnId === turnId)) {
                  const attempts = (outcome as Partial<AgentTurnResult>).toolAttempts;
                  if (outcome.schemaVersion === 2 && Array.isArray(attempts)) reconcileToolAttempts(taskId, attempts);
                  const usage = sanitizeAgentUsage(outcome.usage);
                  finalAgentMetadata = {
                    ...(outcome.runtime === "pi" || outcome.runtime === "dsh" || outcome.runtime === "codex"
                      ? { runtime: outcome.runtime } : {}),
                    ...(outcome.channel === "external-brain" ? { channel: outcome.channel } : {}),
                    ...(usage ? { usage } : {}),
                  };
                }
                throwIfCommandCancelled(controller.signal);
                // A failed Host web tool is terminal for this Voice turn. Some runtimes may
                // still synthesize a generic apology after the tool result; do not persist or
                // present that as an answer because it cannot satisfy the user's request.
                const webToolError = pendingWebToolError(taskId);
                if (webToolError) {
                  // 主句就是工具回执里的码，不是插件固定文案：交回 SDK 时按码查表。
                  throw new VoiceAppError({
                    code: webToolError,
                    userMessage: webToolError,
                    retryable: webToolError !== "browser_plugin_declined",
                  });
                }
                if (outcome.failure) {
                  const purpose: VoiceRequestPurpose = commandId === BUILTIN_VOICE_COMMANDS.agent
                    ? "reply"
                    : "translation";
                  throw new VoiceAppError({
                    // 原样用 Host 给的失败码（例如 AGENT_MODEL_BUDGET_EXCEEDED），不再按 kind 重新包装。
                    code: agentTurnFailureCode(outcome.failure),
                    get userMessage() { return voiceRequestFailureMessage(purpose, outcome.failure); },
                    retryable: outcome.failure.kind !== "killed",
                    cause: outcome.failure,
                  }, undefined, { constantMessage: true });
                }
                if (!outcome.text) {
                  throw new VoiceAppError({
                    code: "AGENT_EMPTY_RESPONSE",
                    get userMessage() { return t("app.voiceAgentReturnedNoContent"); },
                    retryable: true,
                  }, undefined, { constantMessage: true });
                }
                // 翻译结果明显不是译文（模型以助手身份聊天，或整段不是目标语言）：按翻译失败处理，
                // 不写入，走下面「翻译失败」取回卡（带原因码，内容是原话）。拿不准的一律放行。
                const invalidTranslation = persistent ? undefined : assessTranslationOutput(polished.text, outcome.text, targetLanguage);
                if (invalidTranslation) {
                  throw new VoiceAppError({
                    code: invalidTranslation,
                    get userMessage() { return voiceRequestFailureMessage("translation", { code: invalidTranslation }); },
                    retryable: true,
                  }, undefined, { constantMessage: true });
                }
                return {
                  reply: outcome.text,
                  runId: outcome.turnId,
                  durationMs: Date.now() - startedAt,
                  runtime: outcome.runtime,
                  channel: outcome.channel,
                  usage: outcome.usage,
                };
              } finally {
                controller.signal.removeEventListener("abort", cancelTurn);
                if (!persistent && oneShotSessionId) {
                  void ctx.agent.deleteSession({ sessionId: oneShotSessionId }).catch(() => undefined);
                }
              }
            })();
        if (!isRunActive()) return;
        let disposition = await presentationGate.complete();
        throwIfCommandCancelled(controller.signal);
        // 转文本与翻译：和输入法一样，以写回回执为准——写进去了就只收胶囊、不弹任何窗口；
        // 没写进去（没有输入框 / 事前判断确定不可输入 / 写入失败）才弹一张取回卡（内容为结果，
        // 原因带真实错误码，不含任何「已写入」字样）；取回卡被 Host 拒了就在收尾处改弹失败结果面板。
        // Agent 永不写回（shouldWriteBack 排除 agent，合同测试守住）。
        let stageLabel = () => t("app.completed");
        let delivered: { committed: boolean; reason?: string; code?: string } | undefined;
        let takebackFallback: CommandTakebackCard | undefined;
        if (writesBack) {
          delivered = await deliver(target, result.reply);
          if (disposition === "foreground") {
            if (delivered.committed) overlayStages.release(options.resultSessionId);
            else await overlayStages.report(options.resultSessionId, "insert_failed");
          }
          if (!isRunActive()) return;
          if (!delivered.committed) {
            // 报「没写入」阶段那段等待里用户按了停止：运行记录还在、controller 已 abort，
            // 走停止收尾，不再弹取回卡。
            throwIfCommandCancelled(controller.signal);
            const code = delivered.code ?? delivered.reason;
            const card: CommandTakebackCard = {
              // 翻译的卡标明「翻译好了」：卡里是译文，用户要知道复制走的不是原话。
              title: commandId === BUILTIN_VOICE_COMMANDS.translate
                ? t("app.translationNotInsertedTitle")
                : t("view.textNotInsertedTitle"),
              reason: deliverReasonLabel(delivered.reason),
              text: result.reply,
              code,
            };
            // 取回卡被拒才改弹失败面板（合同 voice-command-presentation-routing 精确放行这一种情况）。
            if (!await presentCommandTakeback(card)) takebackFallback = card;
            // 等取回卡回执期间用户按了停止：进停止收尾，不再弹兜底窗口、也不记成完成。
            if (!isRunActive()) return;
            throwIfCommandCancelled(controller.signal);
          }
          stageLabel = () => delivered?.committed
            ? t("app.valueInserted", { value0: COMMAND_LABEL[commandId] })
            // 胶囊上不摆裸枚举：用户该看到「焦点换了地方」而不是「focus_changed」。
            : t("app.valueFinishedButCouldNotBeInserted", { value0: COMMAND_LABEL[commandId], value1: deliverReasonLabel(delivered?.reason) });
        }
        finalizeToolGroupCard(taskId);
        const item: VoiceCommandHistoryItem = {
          // 与后台任务 conversation.entityId 对齐：从胶囊打开时才能落到同一条对话。
          id: taskId,
          transcript,
          reply: result.reply,
          runId: result.runId,
          agentSessionId,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          // 命令类型进历史：详情页页头的头像 / 角色靠它推（R8 页头身份按稿）。
          commandId,
          ...(commandId === BUILTIN_VOICE_COMMANDS.translate ? { translationTarget: targetLanguage } : {}),
          status: "completed",
          durationMs: result.durationMs,
          createdAt: activeCommandRuns.get(taskId)?.createdAt ?? new Date(startedAt).toISOString(),
          messages: [
            { from: "user", text: transcript, at: new Date(startedAt).toISOString(), attachments: activeCommandRuns.get(taskId)?.inputAttachments },
            ...(commandAgentCards.get(taskId) ?? []).map((card) => ({
              from: "ai" as const,
              text: "",
              at: new Date().toISOString(),
              card,
              ...("runtime" in result && result.runtime ? { runtime: result.runtime } : {}),
              ...("channel" in result && result.channel ? { channel: result.channel } : {}),
            })),
            {
              from: "ai",
              text: result.reply,
              at: new Date().toISOString(),
              ...("runtime" in result && result.runtime ? { runtime: result.runtime } : {}),
              ...("channel" in result && result.channel ? { channel: result.channel } : {}),
              ...("usage" in result && result.usage ? { usage: { ...result.usage } } : {}),
            },
          ],
        };
        let itemPersisted = false;
        try {
          const previous = state.commandHistory;
          const settlement = await repository.settleCommandHistory(item,
            () => !abortedCommandClaims.has(taskId));
          const commandHistory = settlement.history;
          if (!settlement.applied) {
            historyPersisted = commandHistory.some((entry) => entry.id === taskId && entry.agentSessionId === agentSessionId);
            commandLifecycleTrace("late_success_dropped", taskId);
            return;
          }
          historyPersisted = commandId === BUILTIN_VOICE_COMMANDS.agent;
          itemPersisted = true;
          await releaseTrimmedCommandAgentSessions(previous, commandHistory);
          publish({
            commandHistory: withOtherRunningCommands(commandHistory, taskId),
            error: undefined,
          });
        } catch (storageCause) {
          publish({
            get error() { return t("app.valueFinishedButHistoryCouldNotBe", { value0: COMMAND_LABEL[commandId], value1: readableError(storageCause) }); },
            errorDetail: errorDetailFrom("historySave", storageCause),
          });
        }
        if (disposition === "foreground") {
          // 落历史期间用户按了停止：不再弹兜底窗口，照常收胶囊（结果已产出，历史照实记）。
          if (takebackFallback && !controller.signal.aborted) {
            if (await presentTakebackFallback({ taskId, commandId, transcript, card: takebackFallback, itemPersisted })) {
              finishWriteBackInForeground(taskId, options.resultSessionId);
            }
          } else if (writesBack) {
            finishWriteBackInForeground(taskId, options.resultSessionId);
          } else {
            const presented = await presentAgentResult({
              runId: result.runId,
              commandId,
              transcript,
              reply: result.reply,
              title: options.title,
              itemPersisted,
              voiceSessionId: options.voiceSessionId,
            });
            if (presented === "defer") disposition = await deferToBackground();
            else releaseForegroundCommand(taskId);
          }
        }
        // 只有已经明确转入后台的运行才更新 Host 胶囊；短任务不能在角落留下第二份结果。
        if (disposition === "background") {
          await present({
            ...snapshot,
            state: "succeeded",
            stageLabel: itemPersisted ? stageLabel() : t("app.valueHistoryCouldNotBeSaved", { value0: stageLabel() }),
            unread: true,
          });
          taskSettled = true;
          // Agent 转入后台后才完成：结果同样一律弹只读结果框（2026-09-27 定稿）。先报终态帧
          // 再请求迟到结果框，runId 用这条后台任务的 taskId——用户关闭或点「继续」即算看过。
          if (!writesBack && isRunActive()) {
            await presentAgentResult({
              runId: taskId,
              commandId,
              transcript,
              reply: result.reply,
              title: options.title,
              itemPersisted,
              deferred: true,
            });
          } else if (takebackFallback && isRunActive() && !controller.signal.aborted) {
            await presentTakebackFallback({ taskId, commandId, transcript, card: takebackFallback, itemPersisted, deferred: true });
          }
        }
      } catch (cause) {
        if (abortedCommandClaims.has(taskId)) {
          // 外部中止已认领终局：deactivate 侧（或正在有界等待）落「已中断」历史，
          // 这里不得再覆盖，静默收尾。
          commandLifecycleTrace("settled_after_external_abort", taskId);
          return;
        }
        if (!isRunActive()) {
          // 运行表已清 = 外部中止路径：deactivate 已（或正在有界等待）落「已中断」
          // 历史，这里不得再覆盖；保持静默返回是正确的。
          commandLifecycleTrace("failure_after_external_abort", taskId);
          return;
        }
        if (controller.signal.aborted) cause = commandCancelledError(commandId);
        const disposition = await presentationGate.complete();
        /** 取回卡被 Host 拒了：失败收尾改弹失败结果面板（同一内容），不能一个窗口都不给。 */
        let failureTakebackFallback: CommandTakebackCard | undefined;
        const settleCommandFailure = async (stageLabel: string) => {
          const recorded = await recordCommandFailure(
            taskId,
            transcript,
            cause,
            commandId,
            agentSessionId ? { agentSessionId, conversationId: options.conversationId } : options.conversationId ? { conversationId: options.conversationId } : undefined,
            finalAgentMetadata,
          );
          if (recorded.alreadySettled) {
            historyPersisted = agentSessionId !== undefined;
            return;
          }
          if (agentSessionId) historyPersisted = recorded.persisted;
          if (disposition === "foreground") {
            // 转文本 / 翻译不弹失败结果框：内容已交给取回卡（用户主动停止则只留历史）。
            if (writesBack && failureTakebackFallback && isRunActive() && !controller.signal.aborted) {
              if (await presentTakebackFallback({ taskId, commandId, transcript, card: failureTakebackFallback,
                itemPersisted: recorded.persisted })) finishWriteBackInForeground(taskId, options.resultSessionId);
              return;
            }
            if (writesBack) {
              finishWriteBackInForeground(taskId, options.resultSessionId);
              return;
            }
            const presented = await presentForegroundFailure({
              taskId,
              commandId,
              transcript,
              message: recorded.message,
              itemPersisted: recorded.persisted,
              ...foregroundFailureFields(cause),
              voiceSessionId: options.voiceSessionId,
            });
            if (presented !== "defer") {
              releaseForegroundCommand(taskId);
              return;
            }
            // Host 要求转后台：交接到角落后按后台失败收尾（角落失败态，不再弹前台面板）。
            await deferToBackground();
          }
          await present({
            ...snapshot,
            state: "failed",
            stageLabel,
            unread: true,
          });
          taskSettled = true;
          if (failureTakebackFallback && isRunActive() && !controller.signal.aborted) {
            await presentTakebackFallback({ taskId, commandId, transcript, card: failureTakebackFallback,
              itemPersisted: recorded.persisted, deferred: true });
          }
        };
        // 失败要被看见：角落里的失败态不参与自动收起（与 run.failed 投影一致）。
        //
        // ⚠️ 桌面胶囊上只放**我们自己写的**失败原因，不透传上游文案：错误串来自
        // Agent 后端的错误信息可能回显请求内容——那会让说话内容出现在一块
        // 旁人和屏幕共享都看得见的浮层上。完整原文照旧进历史（那是用户自己的界面）。
        // 胶囊只放一句简短人话（与 Host #953 口径一致）：不带错误码、版本或诊断入口；
        // 码与诊断在弹出窗口（结果面板 / 取回卡）和 Voice 页里。
        const failureStage = controller.signal.aborted ? stoppedLabel(commandId)
          : t("app.valueFailedValue", { value0: COMMAND_LABEL[commandId], value1: taskFailureLabel(cause) });
        // 只有转文本能拿原文顶上——它要的本来就是这段话本身。
        // 翻译与 Agent 提问必须如实报错：把原文伪装成译文或答案，
        // 比什么都不做糟糕得多（用户会以为已经翻好并写进去了）。
        if (allowsRawFallback(commandId) && !controller.signal.aborted) {
          const delivered = await deliver(target, transcript);
          if (disposition === "foreground") {
            if (delivered.committed) overlayStages.release(options.resultSessionId);
            else await overlayStages.report(options.resultSessionId, "insert_failed");
          }
          if (delivered.committed) {
            // **回退成功也要留一条历史**：文字确实写进了目标应用，历史里却一条不留的话，
            // 用户回头就找不到自己说过什么。云端权限没开通的这段时间里，转文本每一次
            // 都走这条路——历史会一直是空的。
            //
            // 记成 completed（这次交付确实成功了），reply 记本地原文，
            // 并用 errorCode 标出它没经过云端润色，界面要区分时有依据。
            const polishFields = collectErrorFields(cause);
            const item: VoiceCommandHistoryItem = {
              id: taskId,
              transcript,
              reply: transcript,
              commandId,
              status: "completed",
              createdAt: activeCommandRuns.get(taskId)?.createdAt ?? new Date(startedAt).toISOString(),
              // 码只落登记过的；没登记时记插件自己的「润色失败」类别码，回退标记不丢。
              errorCode: structuredCode(normalizedError(cause).code) ?? "POLISH_FAILED",
              get userMessage() { return t("app.cloudPolishingFailedTheOriginalLocalTranscript"); },
              ...commandFailureFields(polishFields),
              failedAt: new Date().toISOString(),
            };
            let itemPersisted = false;
            try {
              const previous = state.commandHistory;
              const settlement = await repository.settleCommandHistory(item,
                () => !abortedCommandClaims.has(taskId));
              const commandHistory = settlement.history;
              if (!settlement.applied) {
                commandLifecycleTrace("late_fallback_dropped", taskId);
                return;
              }
              itemPersisted = true;
              await releaseTrimmedCommandAgentSessions(previous, commandHistory);
              publish({
                commandHistory: withOtherRunningCommands(commandHistory, taskId),
                get error() { return t("app.cloudPolishingFailedTheOriginalLocalTranscript2"); },
                errorDetail: errorDetailFrom("polish", cause, { fields: polishFields }),
                failureRaw: withFailureRaw({ [`command:${taskId}`]: polishFields.raw }),
              });
            } catch (storageCause) {
              publish({
                get error() { return t("app.cloudPolishingFailedAndTheLocalTranscript", { value0: readableError(storageCause) }); },
                errorDetail: errorDetailFrom("historySave", storageCause),
              });
            }
            if (disposition === "foreground") {
              finishWriteBackInForeground(taskId, options.resultSessionId);
            } else {
              await present({
                ...snapshot,
                state: "succeeded",
                stageLabel: itemPersisted
                  ? t("app.polishingFailedOriginalTranscriptKept")
                  : t("app.originalTranscriptKeptHistoryCouldNotBe"),
                unread: true,
              });
              taskSettled = true;
            }
            return;
          }
          // 报「没写入」阶段那段等待里：运行已被外部收走就静默返回（与上面同一口径）；
          // 用户按了停止则按停止收尾，不弹取回卡。
          if (!isRunActive()) return;
          if (controller.signal.aborted) {
            cause = commandCancelledError(commandId);
            await settleCommandFailure(stoppedLabel(commandId));
            return;
          }
          // 原文也没写进去：弹一张取回卡（内容为原文），再按失败落历史。
          const code = delivered.code ?? delivered.reason;
          const card: CommandTakebackCard = {
            title: t("view.textNotInsertedTitle"),
            reason: deliverReasonLabel(delivered.reason),
            text: transcript,
            code,
          };
          // 取回卡被拒时同样改弹失败面板（内容为原文）；等回执期间用户按了停止就不弹。
          if (!await presentCommandTakeback(card) && !controller.signal.aborted) failureTakebackFallback = card;
          await settleCommandFailure(failureStage);
        } else {
          // 翻译本身失败：绝不写原文——弹一张取回卡注明「翻译失败」，内容是原文（2026-09-27
          // 定稿）。用户主动停止不弹：那是用户自己的决定，原文仍在历史里。
          if (commandId === BUILTIN_VOICE_COMMANDS.translate && !controller.signal.aborted) {
            const card: CommandTakebackCard = {
              title: t("app.translationFailedTitle"),
              reason: voiceRequestFailureMessage("translation", cause),
              text: transcript,
              code: collectErrorFields(cause).code,
            };
            // 等回执期间用户按了停止：不再弹兜底窗口（停止是用户自己的决定）。
            if (!await presentCommandTakeback(card) && commandId === BUILTIN_VOICE_COMMANDS.translate && !controller.signal.aborted) failureTakebackFallback = card;
          }
          await settleCommandFailure(failureStage);
        }
      } finally {
        await presentationGate.dispose();
        releaseVoiceSegment();
        if (isRunActive() && runningFramePresented && !taskSettled) {
          await ctx.voiceCommand.dismissTask(taskId).catch(() => undefined);
        }
        if (createdByThisRun && agentSessionId && !historyPersisted
          && !journalSessionLinked && !abortedCommandClaims.has(taskId)) {
          await deleteOwnedCommandAgentSession(agentSessionId).catch((cause) => {
            console.warn("[voice] 回收被打断的命令 Agent 会话失败", diagnosticLogFields(cause));
          });
        }
        // An old detached observer must not clear a newly attached observer's
        // card or running state for the same durable task.
        if (commandProgressHandlers.get(taskId) === onProgress) commandProgressHandlers.delete(taskId);
        if (commandUserWaitHandlers.get(taskId) === onUserWait) commandUserWaitHandlers.delete(taskId);
        if (isRunActive()) {
          activeCommandRuns.delete(taskId);
          abortedCommandClaims.delete(taskId);
          forgetEndedUserWaits(taskId);
          // 回合结束即结束等待：Host 可能来不及补发 wait.ended，对话页不能留一条永远在等的提示。
          if (state.agentWaits?.some((wait) => wait.taskId === taskId)) {
            publish({ agentWaits: state.agentWaits.filter((wait) => wait.taskId !== taskId) });
          }
          if (state.commandHistory.some((item) => item.id === taskId && item.status === "running")) {
            publish({ commandHistory: state.commandHistory.filter((item) => item.id !== taskId) });
          }
          commandAgentCards.delete(taskId);
          commandAgentToolErrors.delete(taskId);
          commandToolLatestSuccess.delete(taskId);
          commandToolUnended.delete(taskId);
          commandToolFailedCallIds.delete(taskId);
          for (const key of commandToolCallOrdinals.keys()) {
            if (!key.startsWith(`${taskId}:`)) continue;
            commandToolCallOrdinals.delete(key);
            commandToolCallStarts.delete(key);
          }
          releaseForegroundCommand(taskId);
        }
      }
    };

    const startCommandAgent = async (
      transcript: string,
      commandId: VoiceCommandId,
      target: { id: string } | undefined,
      options: CommandRunOptions = {},
    ): Promise<string> => {
      const taskId = crypto.randomUUID();
      const controller = new AbortController();
      // F04：Agent 对话的可见身份从第一条起固定；旧条目沿用 session id 作键。
      if (commandId === BUILTIN_VOICE_COMMANDS.agent) options = { ...options, conversationId: options.conversationId ?? options.agentSessionId ?? options.dshSessionId ?? taskId };
      if (options.conversationId && conversationChanges.has(options.conversationId)) {
        throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.scopeSaving"), retryable: true }, undefined, { constantMessage: true });
      }
      const run: ActiveCommandRun = {
        controller,
        repository,
        agentSessionId: options.agentSessionId,
        conversationId: options.conversationId,
        transcript,
        inputAttachments: options.attachments?.map(file => ({ kind: "file", name: file.name, meta: `${file.mimeType} · ${file.byteLength} B` })) ?? options.inputAttachments,
        commandId,
        createdAt: new Date().toISOString(),
      };
      activeCommandRuns.set(taskId, run);
      commandLifecycleTrace("task_allocated", taskId, {
        commandId,
      });
      try {
        await repository.beginCommandHistory({
          id: taskId,
          transcript,
          commandId,
          status: "running",
          createdAt: run.createdAt,
          ...(run.inputAttachments?.length ? { messages: [{ from: "user" as const, text: transcript, at: run.createdAt, attachments: run.inputAttachments }] } : {}),
          ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {}),
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          // 回听引用在 running 落账时登记，终态结算（成功 / 失败 / 中断）沿用。
          ...options.recording,
        });
      } catch (cause) {
        if (activeCommandRuns.get(taskId) === run) activeCommandRuns.delete(taskId);
        commandLifecycleTrace("journal_persist_failed", taskId, {
          commandId,
          code: "VOICE_COMMAND_HISTORY_SAVE_FAILED",
        });
        publish(settledPatch({
          commandPhase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          get error() { return voiceHistorySaveFailureMessage("reply"); },
          errorDetail: errorDetailFrom("historySave", cause),
        }));
        throw new VoiceAppError({
          code: "VOICE_COMMAND_HISTORY_SAVE_FAILED",
          get userMessage() { return voiceHistorySaveFailureMessage("reply"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      commandLifecycleTrace("journal_persisted", taskId, { commandId });
      if (controller.signal.aborted || abortedCommandClaims.has(taskId)) {
        await settleInterruptedCommand(taskId, run);
        if (activeCommandRuns.get(taskId) === run) activeCommandRuns.delete(taskId);
        abortedCommandClaims.delete(taskId);
        return taskId;
      }
      activeForegroundTaskId = taskId;
      publishRunningAgentCards(taskId);
      run.finished = runCommandAgent(taskId, controller, transcript, commandId, target, options);
      return taskId;
    };

    for (const item of durableCommands) {
      if (!visibleAgentSessions?.has(item.agentSessionId!) || activeCommandRuns.has(item.id)) continue;
      const controller = new AbortController();
      const run: ActiveCommandRun = {
        controller, repository, agentSessionId: item.agentSessionId, durableAgent: true,
        // F04：恢复后台回合仍属于原来的可见对话。
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        ...(item.runId ? { runId: item.runId } : {}),
        transcript: item.transcript, commandId: BUILTIN_VOICE_COMMANDS.agent, createdAt: item.createdAt,
        inputAttachments: item.messages?.find(message => message.from === "user")?.attachments,
      };
      activeCommandRuns.set(item.id, run);
      run.finished = runCommandAgent(item.id, controller, item.transcript, BUILTIN_VOICE_COMMANDS.agent, undefined, {
        agentSessionId: item.agentSessionId,
        ...(item.conversationId ? { conversationId: item.conversationId } : {}),
        resume: { sessionId: item.agentSessionId!, turnId: item.runId! },
      });
    }

    /**
     * 这一轮语音命令跑哪一种，以及结果要写回哪个应用。
     *
     * 命令类型在**按下的那一刻**定下（第一次触发），完成时那一次触发就不必再带了——
     * 用户按下时想的是「翻译」，中途换成别的会让同一次说话变成另一件事。
     * 交付目标同理：它是录音开始时 Host 捕获的那个应用，跑完再取就已经晚了。
     */
    let activeCommandId: VoiceCommandId = BUILTIN_VOICE_COMMANDS.agent;
    let activeAgentConversation: VoiceAgentConversationRef | undefined;
    // 命令链的引擎/云端模型快照：与输入链的 pendingInputSelection 同一规则——
    // 引擎与云端模型在**录音开始**那一刻定下（命令类型同理，见上），收工那次
    // （可能由另一颗绑定键触发）沿用开始时的值，不拿说话途中改掉的设置去
    // 转写已经开始的那段音频。
    let pendingCommandSelection: SavedInputSelection | undefined;
    // 与上面语音**输入**那条路的 `pendingDeliveryTarget` 是两份，别合并：两条路各自
    // 是一次独立会话（互斥，见下面的 busy 判据），合成一份只会让「上一条命令的目标」
    // 漏进这一次录音——而写回目标一旦串台，文字就会打进另一个应用。
    let activeCommandContext: Promise<VoiceContextEnvelope | undefined> = Promise.resolve(undefined);
    let activeDeliveryTarget: { id: string } | undefined;
    // 胶囊叠放的后台收尾段要用开录那一刻的润色档与翻译目标（同步收尾不读这两项）。
    let activeCommandPolish: VoicePolishSetting = "raw";
    let activeCommandTranslationTarget: VoiceFeatureSettings["translationTarget"] = state.featureSettings.translationTarget;

    /**
     * A3-24「发给 agent」：把 Context 段作为**附件**带进 Agents·IM（ni.chat）。
     *
     * 去路对稿（:8974-8977 pickAgent → openAgent → atts.push）：driver-v2 的插件
     * 之间不共享窗口状态、voice 也枚举不了 IM 的会话，所以走宿主的跨插件 intent
     * 通道 `apps.open`——由 Host 打开 ni.chat 并把这一段（呈现名 + 转写正文）投给
     * 它的 composer 附件条。稿的 pickAgent 选人步骤没有可落的数据通道（PR 登记
     * 边界），落点由 IM 侧按它自己的选择态决定。
     *
     * V-9 口径不变：还没转录完的段没有可发的内容，如实说，不发空段过去凑数。
     * 这条路与语音命令运行时无关（不动命令锁、不查工作流配置）——发的是一段
     * 引用，不是一次云端问答。
     */
    const sendContextToAgentsIm = async (recordingId: string) => {
      const segment = state.recordings.find((item) => item.id === recordingId);
      if (!segment) {
        // 段在列表刷新 / 删除的竞态里没了：如实说它不存在，不冒充「还没转写」。
        throw new VoiceAppError({
          code: "com.reai.voice/CONTEXT_SEGMENT_NOT_FOUND",
          get userMessage() { return t("app.thisSegmentIsNoLongerInThe"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      const transcript = segment.transcriptText?.trim() ?? "";
      if (!transcript) {
        throw new VoiceAppError({
          code: "com.reai.voice/CONTEXT_NOT_TRANSCRIBED",
          get userMessage() { return t("app.thisSegmentHasNoTranscriptYetWait"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      const startedAt = new Date(segment.wallStartMs);
      const endedAt = new Date(segment.wallStartMs + segment.durationMs);
      const clock = (date: Date) =>
        `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      try {
        await ctx.apps.open(
          { appId: AGENTS_IM_APP_ID, intent: AGENTS_IM_ATTACH_CONTEXT_INTENT },
          {
            // 呈现名只写真实可核的字段（时间区间 + 字数）；稿里的「总结 N 条」
            // 在总结链路就绪前没有数据源，不编。字数与页头 meta 同一条千分位读法。
            get label() { return t("app.liveRecordingValueValueCharactersValue", { value0: clock(startedAt), value1: clock(endedAt), value2: formatChars(transcript.length) }); },
            text: transcript,
            // fromMs/durationMs 是溯源元数据：IM 侧当前 UI 只消费 label/text，
            // 这两个字段供后续「点开附件回看原段」类功能对得上时间轴。
            fromMs: segment.wallStartMs,
            durationMs: segment.durationMs,
          },
        );
        // 投递已被 Host 接受。就地清掉上一次的失败提示——按钮就在详情页头，
        // 成功了还挂着旧错误会让人以为这次也失败了。
        publish({ error: undefined });
      } catch (cause) {
        // 门控状态可能已经变了（刚被卸载/停用）：顺手回读一次，让按钮如实消失。
        const code = (cause as { code?: unknown } | null | undefined)?.code;
        if (code === "APP_INTENT_TARGET_NOT_INSTALLED" || code === "INTENT_TARGET_FAILED") {
          void refreshAgentsImAvailability();
        }
        throw new VoiceAppError({
          code: typeof code === "string" ? code : "com.reai.voice/AGENTS_IM_OPEN_FAILED",
          get userMessage() { return agentsImOpenError(cause); },
          retryable: true,
          cause,
        }, undefined, { constantMessage: true });
      }
    };

    /**
     * A3-16：Chat detail 输入坞的「发送」——沿用历史条目显式记录的 Agent session 来源，
     * 因而同一详情页里的文字与语音追问会进入同一段对话。结果仍作为新条目落进
     * 命令历史，同时走答案面板；没有 session 的旧历史会在首次追问时新建会话。
     */
    const attachmentChoiceKey = (item: VoiceCommandHistoryItem): string => JSON.stringify({key:conversationKey(item),choices:state.conversationOptions?.[conversationKey(item)]??null,session:item.agentSessionId??null});
    let attachmentPreparation: Promise<VoiceAttachmentTarget> | undefined;
    let attachmentPreparationKey: string | undefined;
    const prepareCommandAttachments = (conversation?: VoiceAgentConversationRef): Promise<VoiceAttachmentTarget> => {
      const requestKey=JSON.stringify(conversation);
      if (attachmentPreparation) return attachmentPreparationKey===requestKey?attachmentPreparation:Promise.reject(new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED"));
      attachmentPreparationKey=requestKey;
      const work = async (): Promise<VoiceAttachmentTarget> => {
        const item=state.commandHistory.find(entry=>conversation?.conversationId?conversationKey(entry)===conversation.conversationId:conversation?.agentSessionId?entry.agentSessionId===conversation.agentSessionId:false);
        requireVoiceTaskAttachmentScene(item?.commandId);
        if (!item || !ctx.agent.attachmentAdmission || state.commandPhase!=="idle" || state.phase!=="idle" || state.dictationPhase!=="idle") throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        const key=conversationKey(item);const previous=state.conversationOptions?.[key];
        if(conversationChanges.has(key)||!canChangeConversation(conversationMembers(item,state.commandHistory)))throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        const assertIdle=()=>{if(state.commandPhase!=="idle"||state.phase!=="idle"||state.dictationPhase!=="idle"||state.conversationOptions?.[key]!==previous||conversationChanges.has(key))throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");};
        const backends=await ctx.agent.backends({schemaVersion:2});assertIdle();
        const backend=previous?.backend??state.agentExperiment.backend;
        const ready=agentReadiness(backend,backends);
        const status=ready.kind==="ready"?backends.backends.find(row=>row.backend===ready.backend):undefined;
        if(status?.capabilities?.configuration?.attachmentInputVersion!==1)throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        let sessionId=previous?previous.sessionId:item.agentSessionId;
        if(!sessionId || !sessionId.startsWith("agent2-")){
          const scopedExecution=availableConversationBackends(status?[status]:[]).length>0;
          if(!scopedExecution&&(previous?.backend||previous?.workspace?.kind==="direct"))throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
          const created=await ctx.agent.createSession(await withVoiceFeatureRef(createVoiceCommandSessionConfig({backend,workspace:previous?.workspace,scopedExecution}),"command",undefined,ctx.agent,backends.backends));
          try{
            assertIdle();
            if(scopedExecution&&(previous?.backend||previous?.workspace?.kind==="direct")&&(created.scopeVersion!==1||!created.workspaceRoot||!created.workspace))throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
            await registerCommandAgentSession(created.sessionId);assertIdle();
            const options=await repository.saveConversationOptions(key,{...previous,sessionId:created.sessionId,resolvedBackend:created.backend,...(created.workspace?{workspace:created.workspace}:{}),...(created.workspaceRoot?{workspaceRoot:created.workspaceRoot}:{}),...(created.scopeVersion===1?{scopeVersion:1 as const}:{}),continuationPending:true});
            publish({conversationOptions:options});sessionId=created.sessionId;
          }catch(error){await ctx.agent.deleteSession({sessionId:created.sessionId}).catch(()=>undefined);throw error;}
        }
        const ownerKey=attachmentChoiceKey(item);
        const admission=await ctx.agent.attachmentAdmission({schemaVersion:1,sessionId});
        if(attachmentChoiceKey(item)!==ownerKey||conversationChanges.has(key))throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        const target=parseVoiceAttachmentTarget(sessionId,ownerKey,admission);
        if(!target||!target.formats.length)throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        return target;
      };
      attachmentPreparation=work().finally(()=>{attachmentPreparation=undefined;});return attachmentPreparation;
    };
    let imageUploadQueue: Promise<unknown> = Promise.resolve();
    const uploadCommandImage=(file:File,target:VoiceAttachmentTarget,signal:AbortSignal):Promise<PreparedVoiceAttachment>=>{
      const work=imageUploadQueue.catch(()=>undefined).then(()=>{
        if(!ctx.agent.attachmentUploads)throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        return uploadVoiceImage(file,target,ctx.agent.attachmentUploads,signal);
      });imageUploadQueue=work;return work;
    };
    const releaseCommandAttachment=async (file:PreparedVoiceAttachment)=>{
      if(file.kind!=="image"||!ctx.agent.attachmentUploads)return;
      await ctx.agent.attachmentUploads.cancel({schemaVersion:1,sessionId:file.target.sessionId,admission:{...file.target.admission,modes:["image"]},leaseId:file.part.leaseId}).catch(()=>undefined);
    };
    const sendCommandFollowUp = async (
      text: string,
      conversation?: VoiceAgentConversationRef,
      attachments: readonly PreparedVoiceAttachment[] = [],
    ): Promise<string> => {
      const trimmed = text.trim();
      if (!trimmed) {
        throw new VoiceAppError({
          code: "com.reai.voice/VOICE_EMPTY_FOLLOW_UP",
          get userMessage() { return t("app.enterSomethingToSend"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      if (state.commandPhase !== "idle" || toggleInFlight) {
        throw new VoiceAppError({
          code: "com.reai.voice/VOICE_BUSY",
          get userMessage() { return t("app.thePreviousVoiceCommandIsStillProcessing"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      throwIfDictating();
      // 语音**输入**会话进行中也不放行：publish(processing + activeMode:command) 会
      // 把正在听的那场输入的状态盖掉。（历史版本 sendContextToAgent 的同款缺口是既有模式，
      // 这里是新代码，不再新开一个实例。）
      if (state.phase !== "idle" || state.activeMode === "input") {
        throw new VoiceAppError({
          code: "com.reai.voice/VOICE_BUSY",
          get userMessage() { return t("app.voiceInputIsInProgressWaitFor"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      // F04：追问按「可见对话」路由。对话有显式选择（切换过 Agent / 目录）时，
      // 第一条新建目标 runtime 会话并带上有界可见聊天；旧会话永不提权。
      if (followUpAdmissionInFlight) throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.scopeSaving"), retryable: true }, undefined, { constantMessage: true });
      const sourceItem = state.commandHistory.find((item) => conversation?.conversationId
        ? conversationKey(item) === conversation.conversationId
        : conversation?.agentSessionId ? item.agentSessionId === conversation.agentSessionId
          : conversation?.dshSessionId ? item.dshSessionId === conversation.dshSessionId : false);
      const key = sourceItem ? conversationKey(sourceItem) : conversation?.conversationId;
      const members = sourceItem ? conversationMembers(sourceItem, state.commandHistory) : [];
      if (!canChangeConversation(members)) {
        throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.finishBeforeSwitch"), retryable: true }, undefined, { constantMessage: true });
      }
      const savedChoices = key ? state.conversationOptions?.[key] : undefined;
      const choices = savedChoices;
      const translationScene = sourceItem?.commandId === BUILTIN_VOICE_COMMANDS.translate;
      const sessionId = translationScene ? undefined : choices ? choices.sessionId : conversation?.agentSessionId;
      if (key && conversationChanges.has(key)) throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.scopeSaving"), retryable: true }, undefined, { constantMessage: true });
      // Validate before publishing processing / clearing the UI draft. No original-file handle is granted.
      if (attachments.length) requireVoiceTaskAttachmentScene(sourceItem?.commandId);
      const preparedFiles = attachments.map(file => ({ ...file }));
      const target=preparedFiles.length?await prepareCommandAttachments(conversation):undefined;
      if(target && target.sessionId!==sessionId)throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
      for (const file of preparedFiles) requireVoiceAttachmentAdmission({name:file.name,type:file.mimeType},target?.formats??[]);
      const attachmentInput=target?buildVoiceTypedAttachments(preparedFiles,target):undefined;
      const visibleContext = !translationScene && (!sessionId || choices?.continuationPending) ? visibleConversationContext(members) : [];
      const attachmentTurnText = attachmentInput ? continuationPrompt(visibleContext,trimmed) : undefined;
      followUpAdmissionInFlight = true;
      try {
        // 旧会话不静默提权：没有显式改过 Agent / 目录的对话继续用原会话；用户在范围
        // 面板里改过选择后 sessionId 已被清空，下一条才新建带范围的会话并续接可见聊天。
        if (!sessionId) await requireUnifiedAgentReady(translationScene ? undefined : choices?.backend,
          !translationScene && Boolean(choices?.backend || choices?.workspace?.kind === "direct"));
        if ((key && (conversationChanges.has(key) || state.conversationOptions?.[key] !== savedChoices)) || state.commandPhase !== "idle" || state.phase !== "idle" || state.dictationPhase !== "idle") {
          throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.scopeSaving"), retryable: true }, undefined, { constantMessage: true });
        }
        publish({ commandPhase: "processing", activeMode: "command", error: undefined });
        // 与所有 Command 同一条 3 秒口径；交付目标不存在（这不是录音），也不往当前应用里打字。
        return startCommandAgent(trimmed, translationScene ? BUILTIN_VOICE_COMMANDS.translate : BUILTIN_VOICE_COMMANDS.agent, undefined, {
          ...(translationScene ? { readOnlyTranslation: true, translationTarget: sourceItem.translationTarget } : {}),
          attachments: preparedFiles,
          attachmentTurnText,
          attachmentInput,
          ...(sessionId ? { agentSessionId: sessionId } : {}),
          ...(key ? { conversationId: key } : {}),
          conversationOptions: translationScene ? undefined : choices,
          // 新会话，或切换后的会话还没有一轮被 Host 受理：附上有界可见聊天。
          visibleContext,
        });
      } finally { followUpAdmissionInFlight = false; }
    };

    const currentConversationForChange = (id: string) => {
      const item = state.commandHistory.find((entry) => entry.id === id);
      if (!item) throw new VoiceAppError({ code: "VOICE_CONVERSATION_MISSING", userMessage: t("chat.conversationMissing"), retryable: false }, undefined, { constantMessage: true });
      if (!canChangeConversation(conversationMembers(item, state.commandHistory)) || [...activeCommandRuns.values()].some((run) => run.conversationId === conversationKey(item))) {
        throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", userMessage: t("chat.finishBeforeSwitch"), retryable: true }, undefined, { constantMessage: true });
      }
      return item;
    };

    const refreshConversationBackends = async () => {
      const snapshot = await ctx.agent.backends({ schemaVersion: 2 });
      publish({ agentBackends: snapshot.backends });
    };

    /** 只改当前对话的 Agent；不写 Driver 默认，不动正在跑的任务。 */
    const changeConversationBackend = async (id: string, backend: ResolvedAgentBackend | "auto") => {
      const item = currentConversationForChange(id);
      const key = conversationKey(item);
      if (conversationChanges.has(key)) return;
      conversationChanges.add(key);
      try {
        const snapshot = await ctx.agent.backends({ schemaVersion: 2 });
        if (backend !== "auto" && !availableConversationBackends(snapshot.backends).some((status) => status.backend === backend)) {
          const installed = snapshot.backends.find(status => status.backend === backend && status.available && status.downloadRequired !== true);
          throw new VoiceAppError({ code: installed ? "AGENT_SCOPE_UNAVAILABLE" : "AGENT_BACKEND_UNAVAILABLE", userMessage: installed ? scopeUnavailableMessage(installed, t("chat.scopeUnavailable")) : t("chat.agentUnavailable"), retryable: !installed }, undefined, { constantMessage: true });
        }
        if (backend === "auto") await requireUnifiedAgentReady();
        currentConversationForChange(id);
        const current = state.conversationOptions?.[key];
        if ((current?.backend ?? "auto") === backend) return;
        const conversationOptions = await repository.saveConversationOptions(key, { ...current, backend: backend === "auto" ? undefined : backend, sessionId: undefined, workspaceRoot: undefined, scopeVersion: undefined, resolvedBackend: undefined });
        publish({ conversationOptions, agentBackends: snapshot.backends });
      } finally { conversationChanges.delete(key); }
    };


    /* ═══ R18：当日总结自动生成 ═══
       没有「合成」按钮（R4/R5）：今天第一段结束后生成、新段结束后刷新（最密每小时
       一次）、过了午夜定稿。什么时候该合由 planDigestWork（纯函数）说了算，这里
       只负责按它给的清单发请求、落存储、发布状态。生成器默认走 Dsh 会话；引擎
       不可用时诚实回退云端一次性生成。会话游标随按天总结一起落进私有 KV。 */
    const generateDayDigest: DayDigestGenerator = async (input) =>
      synthesizeDayDigestAuto(summaryDeps(), {
        ...input,
        session: state.dayDigests[input.dayKey]?.dsh,
      });
    /** 各天最近一次失败的合成时刻：私有 KV 回读，跨 Runtime/App 重启保持退避。 */
    const digestAttempts: Record<string, number> = { ...stored.dayDigestAttempts };
    let digestRunInFlight = false;

    const persistDigests = async (next: Record<string, VoiceDayDigest>) => {
      const pruned = pruneDigests(next, Date.now());
      publish({ dayDigests: pruned });
      try {
        await repository.saveDayDigests(pruned);
      } catch (cause) {
        // 落盘失败只影响重启后的回读；这一次运行里的总结照样在内存里。
        console.warn("[voice] 当日总结落盘失败", diagnosticLogFields(cause));
      }
    };

    const persistDigestAttempts = async () => {
      try {
        await repository.saveDayDigestAttempts({ ...digestAttempts });
      } catch (cause) {
        // 写失败时本进程内存退避仍然有效；不能把后台自动总结失败升级成 UI 错误。
        console.warn("[voice] 当日总结失败退避落盘失败", diagnosticLogFields(cause));
      }
    };

    /**
     * 总结两条路共用的依赖：在 #422 的通用 Agent Session 合同上明确选择 Dsh
     * backend；不重新申请已退役的 `agent.dsh@1` 私有能力。Dsh 不可用时仍由
     * `voice-summary-dsh` 诚实回退云端一次性生成。
     */
    const summaryDeps = (): VoiceSummaryDeps => ({
      dshAgent: {
        status: async () => {
          const dsh = (await ctx.agent.backends({ schemaVersion: 2 })).backends.find((item) => item.backend === "dsh");
          return {
            available: dsh?.available ?? false,
            detail: dsh?.detail ?? t("app.theHostDoesNotProvideADsh"),
            // 通用合同把账户/额度门禁收在 agent.session@1 请求本身；能读到 backend
            // 目录就已经过门，不能再伪造两条已从 DTO 收掉的独立状态。
            loggedIn: true,
            modelAccess: true,
          };
        },
        createSession: async () => {
          const created = await ctx.agent.createSession(await withVoiceFeatureRef({
            schemaVersion: 2,
            runtime: "dsh",
            // 指认 manifest 声明的「总结」功能（引擎锁定 DSH，模板集中在 agent-features.ts）。
            systemPrompt: VOICE_SUMMARY_SYSTEM_PROMPT,
            tools: [],
            skills: [],
            workspace: { kind: "app-private" },
            memory: "session",
          }, "summary", undefined, ctx.agent));
          if (created.backend !== "dsh") {
            throw Object.assign(new Error(t("app.theHostDidNotSelectTheRequested")), {
              code: "AGENT_SESSION_INVALID_REQUEST",
            });
          }
          return { sessionId: created.sessionId };
        },
        send: async (options) => {
          const result = await agentTurns.send(options);
          const failure: DshSendResult["failure"] = result.failure
            ? result.failure.kind === "timeout" || result.failure.kind === "killed"
              ? { kind: result.failure.kind }
              : { kind: "engine" as const, stderr_tail: result.failure.stderr_tail ?? t("app.dshAgentExecutionFailed") }
            : null;
          return { turnId: result.turnId, text: result.text, failure };
        },
        cancel: (options) => agentTurns.cancel(options),
        deleteSession: (options) => ctx.agent.deleteSession(options),
      },
      aiApi: ctx.aiApi,
      newId: () => crypto.randomUUID(),
    });

    /**
     * R11 段总结：让 agent（Dsh 会话）给这一段写要点，结果交回 Host 持久化。
     *
     * 再点一次是「重新总结」——复用上次的会话只发一句短追问（前缀缓存命中）。
     * 失败不编内容、旧总结不动；总结跑着的时候这段被删了（Host 回 null）就静默
     * 收尾，不报错——用户已经把它删了，没什么可报的。
     */
    const summarizeSegmentAction = async (recordingId: string) => {
      if (state.segmentSummarizing) {
        throw new VoiceAppError({
          code: "com.reai.voice/SUMMARY_BUSY",
          get userMessage() { return t("app.anotherSegmentIsBeingSummarizedPleaseWait"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      const segment = state.recordings.find((item) => item.id === recordingId);
      if (!segment) {
        throw new VoiceAppError({
          code: "com.reai.voice/CONTEXT_SEGMENT_NOT_FOUND",
          get userMessage() { return t("app.thisSegmentIsNoLongerInThe"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      if (!segment.transcriptText?.trim()) {
        throw new VoiceAppError({
          code: "com.reai.voice/CONTEXT_NOT_TRANSCRIBED",
          get userMessage() { return t("app.thisSegmentHasNoTranscriptYetWait2"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      publish({ segmentSummarizing: recordingId, error: undefined });
      // summarizeSegment 承诺不抛错；这里只分成功 / 失败。
      const outcome = await summarizeSegment(summaryDeps(), {
        segment,
        sessionId: segment.summary?.dshSessionId ?? undefined,
      });
      if (!outcome.summary) {
        publish({ segmentSummarizing: undefined });
        throw new VoiceAppError({
          code: `com.reai.voice/${outcome.failure?.code ?? "SUMMARY_FAILED"}`,
          get userMessage() { return voiceRequestFailureMessage("summary", outcome.failure); },
          retryable: true,
        }, withOuterCode(failureFields(outcome.failure), `com.reai.voice/${outcome.failure?.code ?? "SUMMARY_FAILED"}`), { constantMessage: true });
      }
      const summary = {
        points: outcome.summary.points,
        generatedAtMs: outcome.summary.generatedAtMs,
        dshSessionId: outcome.summary.dshSessionId,
        basedOnTranscribedAtMs: segment.transcribedAtMs ?? null,
      };
      const patchSegment = (patched: typeof segment) =>
        publish({
          recordings: state.recordings.map((item) => (item.id === recordingId ? patched : item)),
          segmentSummarizing: undefined,
          error: undefined,
        });
      try {
        const updated = await ctx.voiceRecordings.setSummary(recordingId, summary);
        if (!updated) {
          // 总结期间这段被删了：列表里也该没了，顺手刷一次，不报错。
          publish({ segmentSummarizing: undefined });
          void ctx.voiceRecordings
            .list({ page: 0, perPage: 50 })
            .then((page) => publish({ recordings: page.items, recordingsTotal: page.total }))
            .catch(() => undefined);
          return;
        }
        patchSegment(updated);
      } catch (storageCause) {
        // 总结已经生成、只是没存住：先让用户看到，再如实说重开 App 会丢。
        patchSegment({ ...segment, summary });
        throw new VoiceAppError({
          code: "com.reai.voice/SUMMARY_SAVE_FAILED",
          get userMessage() { return t("app.summaryGeneratedButNotSavedItWill", { value0: readableError(storageCause) }); },
          retryable: true,
        }, undefined, { composedMessage: true });
      }
    };

    /**
     * A3-10「今天的总结」：把今天的段转写收拢成要点清单。
     *
     * R11 起默认经 Dsh 会话（`synthesizeDayDigestAuto`：一天一个会话、刷新只追加新段），
     * 引擎不可用时回退原来的云端一次性 `generateText` 并在结果上标明来路。失败不回退、
     * 不编内容——把各段原文拼起来冒充总结，正是稿子里点名禁止的「拼起来只是变长，
     * 不是变清楚」。失败如实告诉用户，手上已有的旧总结保留不动。
     */
    /**
     * 跑一轮调度：按计划撤 / 定稿 / 生成。串行、单飞——同一时刻只有一次往返，
     * 新的一轮在上一轮结束后才看最新的 state。`force` 指定某一天强制重合
     * （「重新总结」），绕过每小时一次的节流；失败时抛给调用方原地显示。
     */
    const runDigestScheduler = async (force?: string): Promise<void> => {
      if (!state.featureSettings.summaryEnabled) {
        if (force) {
          throw new VoiceAppError({
            code: "com.reai.voice/DIGEST_DISABLED",
            get userMessage() { return t("app.enableCloudDailySummariesInVoiceSettings"); },
            retryable: false,
          }, undefined, { constantMessage: true });
        }
        return;
      }
      if (!force && state.featureSettings.summaryMode !== "auto") return;
      if (digestRunInFlight) {
        if (force) {
          throw new VoiceAppError({
            code: "com.reai.voice/DIGEST_BUSY",
            get userMessage() { return t("app.aSummaryIsBeingGeneratedPleaseWait"); },
            retryable: true,
          }, undefined, { constantMessage: true });
        }
        return;
      }
      digestRunInFlight = true;
      try {
        const nowMs = Date.now();
        const plan = planDigestWork({
          recordings: state.recordings,
          digests: state.dayDigests,
          nowMs,
          lastAttemptAt: digestAttempts,
          listComplete: state.recordings.length >= state.recordingsTotal,
        });
        const prepared = prepareDigestRun({
          recordings: state.recordings,
          digests: state.dayDigests,
          plan,
          force,
          nowMs,
        });
        let next = prepared.nextDigests;
        if (prepared.dirty) {
          // 即使 force 那一天已经没有素材，也要先提交同批次的撤销/定稿。
          await persistDigests(next);
          next = { ...state.dayDigests };
        }
        if (prepared.forceWithoutSource) {
          throw new VoiceAppError({
            code: "com.reai.voice/DIGEST_NO_SOURCE",
            get userMessage() { return t("app.thisDayHasNoTranscribedRecordingsTo"); },
            retryable: false,
          }, undefined, { constantMessage: true });
        }
        for (const item of prepared.work) {
          publish({ dayDigestGenerating: item.dayKey, dayDigestGeneratingSinceMs: Date.now(), ...(force ? { error: undefined } : {}) });
          // 发请求前先记退避：即使调用抛错或进程中途退出，下次激活也不会立刻连发。
          // 成功后再删；因此落盘里只会留下未成功完成的尝试。
          digestAttempts[item.dayKey] = Date.now();
          await persistDigestAttempts();
          const generatingSince = state.dayDigestGeneratingSinceMs;
          const outcome = await generateDayDigest(item);
          publish({ dayDigestGenerating: undefined, dayDigestGeneratingSinceMs: undefined });
          if (outcome.digest) {
            if (state.dayDigestFailures?.[item.dayKey]) {
              const { [item.dayKey]: _cleared, ...rest } = state.dayDigestFailures;
              publish({ dayDigestFailures: rest });
            }
            next = { ...state.dayDigests, [item.dayKey]: outcome.digest };
            delete digestAttempts[item.dayKey];
            await persistDigestAttempts();
            await persistDigests(next);
            continue;
          }
          if (outcome.sessionInvalidated) {
            next = discardDigestSession(state.dayDigests, item.dayKey);
            if (next !== state.dayDigests) {
              await persistDigests(next);
            }
          }
          // 自动刷新失败不弹红色错误（下一轮按退避再试）；但失败要看得见（§6.0）：只在这一天的
          // 分组里挂一行失败与诊断。用户点了「重新总结」才另外把原因摆到页面错误里。
          console.warn("[voice] 当日总结合成失败", { dayKey: item.dayKey, ...projectDiagnosticLogFields(failureFields(outcome.failure)) });
          publish({
            dayDigestFailures: {
              ...state.dayDigestFailures,
              [item.dayKey]: errorDetailFrom("summaryDay", undefined, {
                fields: failureFields(outcome.failure),
                ...(generatingSince !== undefined ? { sinceMs: generatingSince } : {}),
              }),
            },
          });
          if (force === item.dayKey) {
            throw new VoiceAppError({
              code: `com.reai.voice/${outcome.failure?.code ?? "DIGEST_FAILED"}`,
              get userMessage() { return voiceRequestFailureMessage("summary", outcome.failure); },
              retryable: true,
            }, withOuterCode(failureFields(outcome.failure), `com.reai.voice/${outcome.failure?.code ?? "DIGEST_FAILED"}`), { constantMessage: true });
          }
        }
      } finally {
        digestRunInFlight = false;
        if (state.dayDigestGenerating !== undefined) publish({ dayDigestGenerating: undefined, dayDigestGeneratingSinceMs: undefined });
      }
    };
    /** 自动触发的入口：不抛错（失败只进日志 + 退避）。 */
    const scheduleDigestCheck = () => {
      void runDigestScheduler().catch((cause) => {
        console.warn("[voice] 当日总结调度失败", diagnosticLogFields(cause));
      });
    };

    // The Host owns recurrence and visibility. This command only refreshes the
    // source snapshot and starts the existing single-flight scheduler; it does
    // not wait for AI synthesis to finish.
    ctx.commands.register("com.reai.voice.refresh-day-digest", guardCommand(async () => {
      const recordings = await ctx.voiceRecordings.list({ page: 0, perPage: 50 });
      publish({ recordings: recordings.items, recordingsTotal: recordings.total });
      scheduleDigestCheck();
      return { accepted: true };
    }));

    /**
     * R18 总结行「发给 agent」：把那一天的总结作为**附件**带进 Agents·IM（报告 L-25
     * 裁定：与段详情同一条路、同一个门控），不经过 Command Agent。
     */
    const sendDayDigestToAgentsIm = async (dayKey: string) => {
      const digest = state.dayDigests[dayKey];
      if (!digest) {
        throw new VoiceAppError({
          code: "com.reai.voice/DIGEST_NOT_READY",
          get userMessage() { return t("app.thisDaySSummaryHasNotBeen"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      const todayKey = dayKeyOf(new Date());
      const name = () => dayKey === todayKey ? t("app.todaySSummary") : t("app.summaryForValue", { value0: dayDateLabel(dayKey, todayKey) });
      const text = digest.points.map((point, index) => `${index + 1}. ${point}`).join("\n");
      try {
        await ctx.apps.open(
          { appId: AGENTS_IM_APP_ID, intent: AGENTS_IM_ATTACH_CONTEXT_INTENT },
          {
            get label() { return t("app.valueSegmentsValue", { value0: name(), value1: digest.segs }); },
            text,
            fromMs: digest.fromMs,
            durationMs: Math.max(0, digest.toMs - digest.fromMs),
          },
        );
      } catch (cause) {
        throw new VoiceAppError({
          code: "com.reai.voice/AGENTS_IM_OPEN_FAILED",
          get userMessage() { return t("app.couldNotSendTheSummaryToAgent", { value0: readableError(cause) }); },
          retryable: true,
        }, undefined, { composedMessage: true });
      }
    };

    /** 一段语音命令在开录那一刻冻结的上下文：多段并存时下一段开录不会改掉它。 */
    interface CommandSessionContext {
      commandId: VoiceCommandId;
      conversation: VoiceAgentConversationRef | undefined;
      deliveryTarget: { id: string } | undefined;
      context: Promise<VoiceContextEnvelope | undefined>;
      selection: SavedInputSelection | undefined;
      polish: VoicePolishSetting;
      translationTarget: VoiceFeatureSettings["translationTarget"];
    }
    const frozenCommandContext = (): CommandSessionContext => ({
      commandId: activeCommandId,
      conversation: activeAgentConversation,
      deliveryTarget: activeDeliveryTarget,
      context: activeCommandContext,
      selection: pendingCommandSelection,
      polish: activeCommandPolish,
      translationTarget: activeCommandTranslationTarget,
    });

    /** 命令段在 Agent 实际起跑前失败（识别为空、云端转写失败、门禁失败等）的收口。 */
    const settleCommandStartFailure = async (
      cause: unknown,
      input: {
        workflowStarted: boolean;
        resultSessionId: string | undefined;
        commandId: VoiceCommandId;
        /** 失败发生在开录 / 结束这一步（持有录音槽）：直接复位；收尾段只动自己的字段。 */
        owner?: boolean;
        /** 这段录音的会话（收尾段发布时认自己的录音槽归属）。 */
        sessionId?: string;
        /** `asyncFinish` 段：取消也要确认消费，Host 才放开排在它后面的写回。 */
        asyncSession?: boolean;
      },
    ): Promise<VoiceInputResult> => {
      const settle = <P extends Partial<VoiceViewState>>(patch: P) =>
        publish(input.owner ? patch : settledPatch(patch, { sessionId: input.sessionId }));
      if (isVoiceCancellation(cause)) {
        if (input.asyncSession && input.sessionId) overlayStages.release(input.sessionId);
        settle({
          commandPhase: "idle",
          activeMode: undefined,
          sessionId: undefined,
          error: undefined,
        });
        return cancelledVoiceInputResult();
      }
      if (!input.workflowStarted) {
        if (input.resultSessionId) {
          await ctx.voiceInput.acknowledgeResult(input.resultSessionId).catch(() => undefined);
        }
        settle(Object.assign(failurePatch("commandStart", cause), {
          commandPhase: "idle" as const,
          activeMode: undefined,
          sessionId: undefined,
        }));
        // 云端命令的门禁失败发生在 3 秒 gate 起跑前，但它仍是短任务结果：
        // 用同一结果面板如实说明，不登记一条根本没有进入后台的全局失败任务。
        const normalized = normalizedError(cause);
        if (isCommandGateFailureCode(normalized.code)) {
          void presentForegroundFailure({
            taskId: crypto.randomUUID(),
            commandId: input.commandId,
            transcript: "",
            // 结果面板是浮层：只放声明为固定文案的插件主句（按出身登记，见 voice-app-error），
            // 或按码查表的固定短句；Host / 上游的 userMessage 不透传（§6.0 ⑧）。
            message: constantUserMessage(cause) ?? taskFailureLabel(cause),
            itemPersisted: false,
            code: normalized.code,
          });
        }
      }
      throw cause;
    };

    /**
     * 命令段拿到 Host 终稿之后的收尾：（云端转写）→ 空话门禁 → 起跑命令 Agent。
     * `voiceSessionId` 只给 `asyncFinish` 段：任务帧与前台结果带上它，Host 认得栈里那一枚胶囊。
     */
    const completeCommandResult = async (
      result: VoiceInputResult,
      session: CommandSessionContext,
      /** 发布方占录音槽时的会话（见 settledPatch）。 */
      slotOwner: VoiceSlotOwner,
      voiceSessionId?: string,
      /** 后台收尾段的生命周期（插件停用即中止）；同步收尾不传。 */
      signal?: AbortSignal,
    ): Promise<VoiceInputResult | { phase: "processing"; transcript: string }> => {
      let commandResultSessionId = result.sessionId;
      let workflowStarted = false;
      try {
        if (result.outcome === "cancelled") {
          if (voiceSessionId) overlayStages.release(voiceSessionId);
          publish(settledPatch({ commandPhase: "idle", activeMode: undefined, sessionId: undefined }, slotOwner));
          return result;
        }
        let transcript = result.transcript?.trim() ?? "";
        if (!transcript && result.audio) {
          // 云端命令收尾：音频留在 Host 短时槽、没有本地 transcript，先拿
          // sessionId 换文本再喂命令 Agent。只加 retainAudio 不做这一步，
          // transcript 恒为 null，命令链会把每次云端录音都判成「没有听清」。
          if (shouldWriteBack(session.commandId)) void overlayStages.report(result.sessionId, "transcribing");
          transcript = await transcribeCloudRecording(result, result.audio, session.selection);
        }
        throwIfAborted(signal);
        // 翻译保留短确认和实义单字；Agent 沿用原 substantive 门禁。转文本保持原样。
        const translationUtterance = session.commandId === BUILTIN_VOICE_COMMANDS.translate;
        const skipUtterance = translationUtterance
          ? !shouldTranslateUtterance(transcript)
          : session.commandId !== BUILTIN_VOICE_COMMANDS.transcribe && classifyUtterance(transcript) !== "substantive";
        if (skipUtterance) {
          publish(settledPatch({ commandPhase: "idle", activeMode: undefined, sessionId: undefined }, slotOwner));
          // Host 只在本地识别结果完全为空时显示「没有听清」：让这句停一会儿再收。其余情况
          // （识别出语气词 / 单字，或云端转写）胶囊显示的是「处理中」，交给下面 catch 立刻收掉。
          if (commandResultSessionId && !result.audio && !result.transcript) {
            const heldSessionId = commandResultSessionId;
            commandResultSessionId = undefined;
            setTimeout(() => {
              try {
                void ctx.voiceInput.acknowledgeResult(heldSessionId).catch(() => undefined);
              } catch {
                // 插件已停用：Host 按 owner 清掉了这份待确认结果，不需要再收。
              }
            }, EMPTY_UTTERANCE_HINT_MS);
          }
          // 固定文案、固定码：诊断里只有码与版本，不带用户说了什么。
          throw new VoiceAppError({ code: "com.reai.voice/VOICE_EMPTY_UTTERANCE", get userMessage() { return translationUtterance
            ? t("app.emptyTranslationNotSent") : t("app.emptyUtteranceNotSent"); }, retryable: true }, undefined, { constantMessage: true });
        }
        if (!transcript) {
          publish(settledPatch({ commandPhase: "idle", activeMode: undefined, sessionId: undefined }, slotOwner));
          throw new VoiceAppError({ code: "VOICE_COMMAND_NO_SPEECH", get userMessage() { return t("app.nothingWasHeardPleaseSayItAgain"); }, retryable: true }, undefined, { constantMessage: true });
        }
        publish(settledPatch({ commandPhase: "processing", activeMode: "command", sessionId: undefined }, slotOwner));
        await startCommandAgent(transcript, session.commandId, session.deliveryTarget, {
          ...session.conversation,
          context: session.context,
          ...(result.sessionId ? { resultSessionId: result.sessionId } : {}),
          // 后台收尾段用开录时冻结的润色档与翻译目标（同步收尾照旧读当下设置）。
          ...(voiceSessionId ? { voiceSessionId, polish: session.polish, translationTarget: session.translationTarget } : {}),
          // 三个方向都存切片原始音频：Host 带回 replayClip 就把回听引用挂到这条命令上。
          recording: recordingRefFromClip(savedReplayClip(result)),
        });
        workflowStarted = true;
        // 命令录音也落了回听片段：并进缓存状态并追一次权威值（与输入法同一口径）。
        const commandClip = savedReplayClip(result);
        if (commandClip) {
          publish({ replayCache: replayCacheWithClip(state.replayCache, commandClip) });
          void refreshReplayCache();
        }
        return { phase: "processing", transcript };
      } catch (cause) {
        return await settleCommandStartFailure(cause, {
          workflowStarted,
          resultSessionId: commandResultSessionId,
          commandId: session.commandId,
          sessionId: slotOwner.sessionId,
          asyncSession: voiceSessionId !== undefined,
        });
      }
    };

    const toggleCommand = async (
      signal?: AbortSignal,
      commandId?: VoiceCommandId,
      conversation?: VoiceAgentConversationRef,
      finishSessionId?: string,
      startOnly = false,
      /** 同 {@link toggleInput} 的 triggerRef。 */
      triggerRef?: string,
    ): Promise<VoiceInputResult | { phase: "processing"; transcript: string }> => {
      // 已确认 Host 支持多段：上一条命令还在跑（含前台 3 秒）不再挡新录音，只让正在录的听写段。
      const busy = hostAsyncFinish
        ? toggleInFlight || serviceOperationActive || state.phase !== "idle"
        : toggleInFlight || serviceOperationActive || state.commandPhase === "processing" || state.activeMode === "input";
      if (busy) {
        throw new VoiceAppError({ code: "com.reai.voice/VOICE_BUSY", get userMessage() { return t("app.thePreviousVoiceCommandIsStillProcessing"); }, retryable: true }, undefined, { constantMessage: true });
      }
      // 硬件语音键在听写期间按下：不把这场听写当命令收走，也不另起一场。
      throwIfDictating();
      toggleInFlight = true;
      let completionOwned = false;
      let completingSessionId: string | undefined;
      let commandResultSessionId: string | undefined;
      let commandPrepareStartedAt: number | undefined;
      let globalPreparingRequestId: string | undefined;
      publish({ error: undefined });
      try {
        const completing = state.commandPhase === "listening";
        if (!completing) {
          const requestedCommand = commandId ?? BUILTIN_VOICE_COMMANDS.agent;
          // 按键已受理：立刻给「正在准备」反馈再跑就绪检查——3 秒窗口内任何一步
          // 慢，用户看到的不再是死键；录音浮层出现后自然替换（链③）。
          publish({ commandPhase: "preparing" });
          const prepareStartedAt = Date.now();
          commandPrepareStartedAt = prepareStartedAt;
          const timedStage = async (name: string, run: () => Promise<unknown>) => {
            const stageStartedAt = Date.now();
            try {
              await awaitVoicePreparation(signal, run);
            } finally {
              // 分段耗时（链③定位）：只记阶段名与毫秒数，不记内容。
              console.info("[voice-start]", name, {
                elapsedMs: Date.now() - stageStartedAt,
                totalMs: Date.now() - prepareStartedAt,
              });
            }
          };
          // Host 的独立全局胶囊只显示固定准备文案，不开麦。Voice 页面不在前台
          // （例如用户还在设置页）时，也能立即看到这次按键已被受理。
          globalPreparingRequestId = crypto.randomUUID();
          await timedStage("global_feedback", () => ctx.voiceInput.beginPreparing(
            globalPreparingRequestId!, commandOverlayKind(requestedCommand),
          ));
          if (requestedCommand !== BUILTIN_VOICE_COMMANDS.transcribe && !conversation?.agentSessionId) {
            await timedStage("agent_ready", () => requireUnifiedAgentReady());
          }
          await timedStage("settings_save", () => settingsSaveChain);
          pendingCommandSelection = snapshotVoiceSelection();
          // 云端模型没选/失效要在采集前拦住：Host 对 retainAudio 不查本地模型，
          // 起跑后才失败就只剩一段谁也转写不了的音频。
          if (pendingCommandSelection.engine === "cloud") await timedStage("cloud_model", () => selectedCloudModel(pendingCommandSelection!));
          await timedStage("configure", () => configuration.prepare(state.settings));
          throwIfAborted(signal);
          activeCommandId = requestedCommand;
          activeAgentConversation = requestedCommand === BUILTIN_VOICE_COMMANDS.agent
            ? conversation
            : undefined;
          activeDeliveryTarget = undefined;
        }
        if (completing) {
          completingSessionId = state.sessionId;
          publish({ commandPhase: "recognizing" });
        }
        // 云端引擎没有本地识别可跑：音频必须以 retainAudio 留给 Host 的短时槽，
        // 否则 Host 的「非 retainAudio 就查本地模型」门禁会把没有本地模型的
        // 云端用户挡死在起跑线上（#289 只修了听写输入链，命令链同样要接）。
        const useCloud = pendingCommandSelection?.engine === "cloud";
        // 硬件按键开录（start）声明结束即返回；页面入口的 toggle 与旧 Host 照旧同步收尾。
        const asyncFinish = startOnly && !completing && asyncFinishCapable();
        const captureStartedAt = Date.now();
        let result: VoiceInputResult;
        try {
          result = finishSessionId ? await ctx.voiceInput.finish(finishSessionId) : await (startOnly
            ? (options: Parameters<typeof ctx.voiceInput.toggle>[0]) => startOwnedCapture(signal, {
              ...options ?? {},
              ...(asyncFinish ? { asyncFinish: true } : {}),
            })
            : ctx.voiceInput.toggle)({
            mode: "command",
            overlayKind: commandOverlayKind(activeCommandId),
            // 识别只出文本（Host API 1.22）：转文本 / 翻译由插件自己 commit，Agent 永不写回。
            insertText: false,
            ...(useCloud ? { retainAudio: true } : {}),
            // 只在开始录音时回传（凭证一次性；结束不需要）。旧 Host 忽略此项。
            ...(triggerRef && !completing ? { triggerRef } : {}),
          });
        } finally {
          if (commandPrepareStartedAt !== undefined) {
            console.info("[voice-start]", "capture_start", {
              elapsedMs: Date.now() - captureStartedAt,
              totalMs: Date.now() - commandPrepareStartedAt,
            });
          }
        }
        if (signal?.aborted) {
          // A Host toggle already in flight can finish after command.cancel.
          // Retire that exact late session before releasing the local admission lock.
          if (result.phase === "listening" && result.sessionId) {
            await ctx.voiceInput.cancel(result.sessionId);
          }
          throwIfAborted(signal);
        }
        if (result.phase === "listening") {
          noteCaptureLimit(result);
          // 交付目标只在这一帧给出：它是「录音开始时前台是谁」的凭据，
          // 跑完再问已经晚了（用户早就切走了）。
          activeDeliveryTarget = result.deliveryTarget;
          activeCommandPolish = state.settings.polish;
          activeCommandTranslationTarget = state.featureSettings.translationTarget;
          // 上下文只喂润色，而润色只作用于转文本（2026-09-27 定稿）：翻译与 Agent 一个字都不采。
          activeCommandContext = activeCommandId !== BUILTIN_VOICE_COMMANDS.transcribe || state.settings.polish === "raw"
            ? Promise.resolve(undefined)
            : assembleContext(result.sessionId).catch(() => undefined);
          if (asyncFinish && result.sessionId) {
            registerCommandSegment(result.sessionId, frozenCommandContext());
          }
          publish({
            commandPhase: "listening",
            activeMode: "command",
            sessionId: result.sessionId,
          });
          return result;
        }
        commandResultSessionId = result.sessionId;
        const session = frozenCommandContext();
        pendingCommandSelection = undefined;
        const segment = result.sessionId ? asyncSegments.get(result.sessionId) : undefined;
        if (isFinalizingResult(result) && result.sessionId) {
          // 结束即返回：录音槽空出，这段的收尾交给后台任务（终稿用 getStatus 长轮询取回）。
          const sessionId = result.sessionId;
          finalizeAsyncSegment(sessionId, () => registerCommandSegment(sessionId, session));
          return result;
        }
        // Host 按同步语义收尾（旧 Host 忽略 asyncFinish）：撤掉段登记，就地收尾。
        if (segment) asyncSegments.delete(segment.sessionId);
        completionOwned = true;
        // 同步收尾：录音槽此刻仍归这一段（Host 没回 sessionId 时也认得）。
        return await completeCommandResult(result, session, { sessionId: state.sessionId });
      } catch (cause) {
        // 收尾自己已经收过口（呈现失败 / 落历史），原样交回调用方。
        if (completionOwned) throw cause;
        // asyncFinish 段的结束请求失败：回查 Host（同听写，见 reconcileFailedFinish）。
        if (completingSessionId && settledAsyncSessions.has(completingSessionId)) return cancelledVoiceInputResult();
        const owned = completingSessionId ? asyncSegments.get(completingSessionId) : undefined;
        if (owned) {
          const host = await reconcileFailedFinish(owned);
          if (host === "ended" || owned.ended || owned.settling) {
            endAsyncSegment(owned);
            return cancelledVoiceInputResult();
          }
          if (host === "listening" && state.sessionId === owned.sessionId) {
            publish(Object.assign(failurePatch("commandStart", cause), { commandPhase: "listening" as const }));
            throw cause;
          }
          dropAsyncSegment(owned);
        }
        return await settleCommandStartFailure(cause, {
          workflowStarted: false,
          resultSessionId: commandResultSessionId,
          commandId: activeCommandId,
          owner: true,
        });
      } finally {
        if (globalPreparingRequestId) {
          // Host 只收匹配 owner + requestId + overlay generation 的准备胶囊；
          // 真正的录音 start 已换代，迟到的清理不会误收正在听的胶囊。
          await ctx.voiceInput.endPreparing(globalPreparingRequestId).catch(() => undefined);
        }
        toggleInFlight = false;
      }
    };

    const registerCommandSegment = (sessionId: string, session: CommandSessionContext) =>
      registerAsyncSegment(sessionId, "command", () => ({
        complete: result => completeCommandResult(result, session, { sessionId }, sessionId, asyncActivation.signal),
        fail: cause => settleCommandStartFailure(cause, {
          workflowStarted: false,
          resultSessionId: sessionId,
          commandId: session.commandId,
          sessionId,
          asyncSession: true,
        }),
      }));

    /**
     * 三种可绑定的语音胶囊行为共用同一个关闭入口。
     *
     * 用户按下时只需要表达两件事：空闲时“用这条命令开始”，已有胶囊时“把当前
     * 胶囊关掉”。关闭必须沿用录音开始时已经冻结的行为，不能拿后来按下的命令把
     * 转文本改成翻译、或把 Agent 改成输入；也不能因为入口 ID 不同就报 VOICE_BUSY。
     */
    const finishActiveVoiceCapture = (expectedSessionId?: string): Promise<unknown> | undefined => {
      if (expectedSessionId && state.sessionId !== expectedSessionId) return undefined;
      // 服务会话在听：二触只结束当前服务请求，终稿仍回原 request-text Promise。
      const serviceListening = requestTextProvider.listeningRequests()[0];
      if (serviceListening && state.phase === "listening") {
        return Promise.resolve(
          requestTextProvider.finish(serviceListening.caller, { requestId: serviceListening.requestId }),
        );
      }
      if (state.phase === "listening") return toggleInput(undefined, undefined, expectedSessionId);
      if (state.commandPhase === "listening") return toggleCommand(undefined, undefined, undefined, expectedSessionId);
      return undefined;
    };

    const captureOperations = new VoiceCaptureOperations();
    const invokeCaptureOperation = (
      operation: { id: string; phase: "start" | "end" },
      signal: AbortSignal,
      start: () => Promise<VoiceInputResult | { phase: "processing"; transcript: string }>,
    ) => captureOperations.invoke(operation, signal, {
      current: () => state.phase === "listening" || state.commandPhase === "listening" ? state.sessionId : undefined,
      start,
      finish: finishActiveVoiceCapture,
      cancel: async sessionId => {
        await ctx.voiceInput.cancel(sessionId);
        if (state.sessionId === sessionId) publish({ phase: "idle", commandPhase: "idle", activeMode: undefined, sessionId: undefined });
      },
      failed: cause => publish({ get error() { return readableError(cause); }, errorDetail: errorDetailFrom("capture", cause) }),
    });

    ctx.commands.register("com.reai.voice.toggle-input", guardCommand(async ({ signal, operation, triggerRef }) => {
      throwIfAborted(signal);
      // triggerRef：硬件按键触发时 Host 签发的一次性来源凭证，开始录音时原样回传（发起设备优先）。
      if (operation) return invokeCaptureOperation(operation, signal, () => runVoiceStart(signal, bounded => toggleInput(bounded, undefined, undefined, true, triggerRef)));
      const finishing = finishActiveVoiceCapture();
      if (finishing) {
        // 识别可能在慢机器上超过 Command 的 30 秒 deadline。第二次硬件触发只负责
        // 结束当前采集并启动后台识别，结果继续由 Voice Surface/历史承接。当前采集
        // 可能是输入、翻译或 Agent；由开始时冻结的状态决定，不由这次按键决定。
        void finishing.catch(() => undefined);
        return { phase: "recognizing" };
      }
      const cancel = () => void ctx.voiceInput.cancel(state.sessionId).catch(() => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await runVoiceStart(signal, bounded => toggleInput(bounded, undefined, undefined, true, triggerRef));
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    }), { supportsOperations: true });

    /**
     * 一条可被绑定的语音命令事件。
     *
     * 第二次触发只负责结束采集：命令类型在按下的那一刻就定下了，这里不再重取
     * ——否则用户按下时想的是「翻译」，松手前换了绑定，同一次说话会变成另一件事。
     */
    const registerCommandEvent = (eventId: string, defaultCommandId: VoiceCommandId) => {
      ctx.commands.register(eventId, guardCommand(async ({ signal, input, operation, triggerRef }) => {
        throwIfAborted(signal);
        if (operation) return invokeCaptureOperation(operation, signal, () => runVoiceStart(signal, bounded => toggleCommand(bounded, resolveCommandId(input, defaultCommandId), undefined, undefined, true, triggerRef)));
        const finishing = finishActiveVoiceCapture();
        if (finishing) {
          // 与普通输入一致：识别与后续 Agent 不受 Command dispatcher deadline 取消。
          void finishing.catch(() => undefined);
          return { phase: "recognizing" };
        }
        // 命令类型来自这条按键绑定携带的静态入参；没带就用这个事件自己的类型。
        const commandId = resolveCommandId(input, defaultCommandId);
        const cancel = () => void ctx.voiceInput.cancel(state.sessionId).catch(() => undefined);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          return await runVoiceStart(signal, bounded => toggleCommand(bounded, commandId, undefined, undefined, true, triggerRef));
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      }), { supportsOperations: true });
    };

    // 通用入口：没有静态入参时就是 Agent；转文本与翻译仅由各自显式事件触发。
    registerCommandEvent("com.reai.voice.toggle-command", BUILTIN_VOICE_COMMANDS.agent);
    // 三个各自独立的可绑定事件——键位设置里就是这三条供用户挑。
    for (const [eventId, commandId] of Object.entries(VOICE_COMMAND_EVENTS)) {
      registerCommandEvent(eventId, commandId);
    }

    /* B2-2 面包屑返回键：Host 侧 back-to-root command 的落点。view 是 mount
       handler 的局部变量而 command 注册在 activate——中间用这个会话级引用接驳。
       cleanup 做身份保护：旧 mount 的清理不许清掉新 mount 刚赋上的引用。 */
    let activeVoiceView: VoiceView | null = null;
    ctx.commands.register("com.reai.voice.back-to-root", guardCommand(async () => {
      if (!activeVoiceView) {
        throw new VoiceAppError({
          code: "com.reai.voice/NO_ACTIVE_VIEW",
          get userMessage() { return t("app.theVoiceInterfaceIsNotOpen"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      activeVoiceView.navigateRoot();
      return {};
    }));
    /* B2-9 三级面包屑的中间返回：events → settings。与 back-to-root 分开，
       否则标题栏 back 会一次跳两级，和设计稿路径语义相反。 */
    ctx.commands.register("com.reai.voice.open-settings", guardCommand(async () => {
      if (!activeVoiceView) {
        throw new VoiceAppError({
          code: "com.reai.voice/NO_ACTIVE_VIEW",
          get userMessage() { return t("app.theVoiceInterfaceIsNotOpen"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      activeVoiceView.navigateSettings();
      return {};
    }));
    /* Host 旧 audio-timeline-settings target 的兼容落点。固定到录音缓存，不暴露
       任意 target 参数，避免 Host 借这条窄入口操纵 Voice 的其他内部页面。 */
    ctx.commands.register("com.reai.voice.open-audio-settings", guardCommand(async () => {
      if (!activeVoiceView) {
        throw new VoiceAppError({
          code: "com.reai.voice/NO_ACTIVE_VIEW",
          get userMessage() { return t("app.theVoiceInterfaceIsNotOpen"); },
          retryable: true,
        }, undefined, { constantMessage: true });
      }
      activeVoiceView.openSettings("replay-cache");
      return {};
    }));

    ctx.surfaces.register("main", async (surface) => {
      let view: VoiceView | undefined;
      const navigation = createVoiceSurfaceNavigation(surface, () => ({
        root: t("metadata.name"), detail: t("app.inputDetails"),
        translation: t("app.translationDetails"), chat: t("app.commands"),
        context: t("app.liveRecordings"), settings: t("common.settings"),
        events: t("app.manageTriggerEvents"), models: t("app.modelsRecognition"),
        audioSettings: t("view.settingsRecordingRetention"),
      }));
      const stopReturnIntent = surface.onIntent((intent) => {
        if (isSystemTaskReturnIntent(intent)) void refresh();
      });
      let stopTitlebarIntent: (() => void) | undefined;
      let stopActionMounts: (() => void) | undefined;
      let modelRefreshInFlight = false;
      let stopHostVersionRefresh: (() => void) | undefined;
      let stopPresentationChange: (() => void) | undefined;
      // 本挂载是否已计入 voiceSurfaceMounts（失败分支与 cleanup 只退自己那一份）。
      let surfaceCounted = false;
      const uncountSurface = () => {
        if (!surfaceCounted) return;
        surfaceCounted = false;
        voiceSurfaceMounts = Math.max(0, voiceSurfaceMounts - 1);
        voiceClipCapture?.setMounted(voiceSurfaceMounts === 1);
      };
      const hostVersionScope = {};
      // 这个挂载是否还在：晚到的版本读取结果不能在界面关掉后再安排重试。
      let mounted = true;
      const conversationOpen = createOwnedConversationOpenController<VoiceCommandHistoryItem>({
        async load(entityId, current) {
          if (mounted && current()) {
            view?.setConversationOpenPending(true);
            publish({ error: undefined, errorDetail: undefined });
          }
          const saved = await repository.load();
          if (!mounted || !current()) return undefined;
          publish({ commandHistory: saved.commandHistory ?? [] });
          return (saved.commandHistory ?? []).find(entry => entry.id === entityId
            || entry.runId === entityId || entry.agentSessionId === entityId);
        },
        async prepare(item) {
          if (!item.agentSessionId) return undefined;
          // Old injected SDK has no owned-open API; it retains the guarded legacy path.
          // New SDK/Host source or grant rejection never downgrades to that path.
          if (typeof ctx.agent.prepareConversationOpen !== "function") return undefined;
          return ctx.agent.prepareConversationOpen({ sessionId: item.agentSessionId });
        },
        async land(item, current) {
          if (!mounted || !current() || !view?.openConversation(item.id, { focusComposer: true })) return false;
          return view.waitForConversationLanding(item.id, () => mounted && current());
        },
        async commit(item, receipt) {
          if (item.agentSessionId) {
            await ctx.agent.reportConversationOpened({ sessionId: item.agentSessionId, ...(receipt ? { receipt } : {}) });
          }
          if (!receipt) await ctx.voiceCommand.dismissTask(item.id);
        },
        cancel(sessionId, receipt) { return ctx.agent.cancelConversationOpen({ sessionId, receipt }); },
        async completed(item, current) {
          if (!mounted || !current()) return;
          const commandHistory = await repository.markCommandRead(item.id);
          if (mounted && current()) {
            view?.setConversationOpenPending(false);
            publish({ commandHistory, error: undefined, errorDetail: undefined });
          }
        },
        failed(cause, item, phase) {
          if (!mounted) return;
          // Reading saved content remains possible on old/denied Hosts. This is
          // a preview with explicit failure, never an opened/read fallback.
          if (item) view?.openConversation(item.id, { focusComposer: true });
          view?.setConversationOpenPending(false);
          publish(failurePatch("conversationOpen", cause, () => {
            if (phase === "prepare" || collectErrorFields(cause).code === "TASK_SOURCE_STALE") {
              return t("errors.conversationOpen.sourceStale");
            }
            return t(phase === "commit" || phase === "complete"
              ? "errors.conversationOpen.commitFailed" : "errors.conversationOpen.landingFailed");
          }));
        },
      });
      const listener = (next: VoiceViewState) => view?.update(next);
      const modelPoll = window.setInterval(() => {
        if (modelRefreshInFlight || !localDownloads.busy) return;
        modelRefreshInFlight = true;
        void localDownloads
          .refresh()
          .catch((cause) => publish(failurePatch("modelList", cause)))
          .finally(() => {
            modelRefreshInFlight = false;
          });
      }, 1000);
      try {
        const legacyBack = !surface.navigation && typeof surface.reportNav !== "function";
        view = mountVoiceView(surface.root, state, {
          onOpenHistory: () => {
            if (mounted) stopHostVersionRefresh = hostVersionReader.refreshOnVisible(hostVersionScope);
          },
          onCopyText: (text) => ctx.clipboard.writeText(text).then(() => undefined),
          // 复制诊断前补读 Host 版本：复用在途请求，最多等 3 秒。
          onEnsureHostVersion: () => hostVersionReader.ensure(3000).then(() => undefined),
          // 页面点击发生时 Driver 已经取得焦点，不能诚实地声称还能向此前应用写字。
          // 页面入口只做本地识别并落历史；硬件语音键仍按默认值写入当前应用。
          onToggle: () => toggleInput(undefined, false),
          // 输入坞麦克风会带 commandId（Agent 命令）；Command 档主按钮不带，走默认。
          onCommandToggle: (commandId?: VoiceCommandId, conversation?: VoiceAgentConversationRef) =>
            toggleCommand(undefined, commandId, conversation),
          onOpenSystemTask: async () => {
            try {
              await ctx.systemTasks.open({
                target: "firmware-upgrade",
                returnIntent: { reason: "voice-firmware-required" },
              });
              publish({ error: undefined });
            } catch (cause) {
              publish(failurePatch("firmwareTask", cause));
              throw cause;
            }
          },
          // 车道 F：命令事件卡的键位映射跳转行。失败（BUSY / 待返回）不进全局
          // error——视图在跳转行原地说清楚，用户才知道是哪一下没跳过去。
          onOpenKeymap: () =>
            ctx.systemTasks.open({
              target: "keymap",
              returnIntent: { reason: "voice-keymap-jump" },
            }).then(() => undefined),
          // C-AC PR4：直达 Host「插件 Agent 配置」固定模式（锁定到本插件）。
          onOpenAgentConfig: () =>
            ctx.systemTasks.open({
              target: "agent-config",
              returnIntent: { reason: "voice-agent-config" },
            }).then(() => undefined),
          onOpenAccountLogin: () =>
            ctx.systemTasks.open({
              target: "account-login",
              returnIntent: { reason: "voice-cloud-login" },
            }).then(() => undefined),
          onOpenPermissionSettings: () =>
            ctx.systemTasks.open({
              target: "permission-settings",
              returnIntent: { reason: "voice-permission-settings" },
            }).then(() => undefined),
          onOpenAppPermissions: () =>
            ctx.systemTasks.open({
              target: "app-permissions",
              returnIntent: { reason: "voice-app-permissions" },
            }).then(() => undefined),
          // 缺陷3：把转写缺失 / 失败 / 积压中的 Context 分片重新排进本地引擎
          // 队列。Host 只改索引状态，识别异步消化；这里刷新列表让该条回到
          // 「排队中」的展示口径。
          onRetranscribeSegment: async (recordingId) => {
            publish({
              retranscribingSegments: { ...state.retranscribingSegments, [recordingId]: "running" },
            });
            const settle = (phase: "queued" | undefined) => {
              const next = { ...state.retranscribingSegments };
              if (phase === undefined) delete next[recordingId];
              else next[recordingId] = phase;
              publish({ retranscribingSegments: next });
            };
            try {
              await ctx.voiceRecordings.retranscribeSegment(recordingId);
              settle("queued");
              await refresh();
            } catch (cause) {
              settle(undefined);
              publish(failurePatch("retranscribeQueue", cause, () => t("app.retranscribeFailedValue", { value0: readableError(cause) })));
            }
          },
          onNoticeShown: () => {
            if (state.notice !== SOURCE_MIGRATION_NOTICE) return;
            // 只有 view 确认真正留在可见列表 DOM 才确认；任务深链若马上换页，提示
            // 继续留在 KV，等用户下一次真的回到列表再展示。
            void repository.acknowledgeSourceMigrationNotice().then(() => {
              if (state.notice === SOURCE_MIGRATION_NOTICE) {
                state = { ...state, notice: undefined };
              }
            }).catch(() => {
              // 保留待显示状态，下次 surface 继续尝试确认。
            });
          },
          onNavigated: page => { void navigation.publish(page === "history" ? null : page); },
          onRefresh: refresh,
          onChooseRecognitionEngine: async (engine) => {
            if (state.recognitionSetupBusy) return;
            publish({ recognitionSetupBusy: true, recognitionSetupError: undefined });
            try {
              // Use the Host options already read (or read once when there are none);
              // never invent a provider/model, and do not flash a reload on choice.
              const cloudModels = engine === "cloud"
                ? await cloudModelsForSelection(true) : [];
              if (toggleInFlight || serviceOperationActive) throw operationInProgressError();
              const operation = settingsSaveChain.then(() => chooseRecognitionEngine(
                engine, state.settings, state.featureSettings, cloudModels, {
                  configure: settings => configuration.apply(settings, { writeSource: false }),
                  startDownload: modelId => localDownloads.start(modelId),
                  saveSettings: settings => repository.saveSettings(settings),
                  saveFeatures: features => repository.saveFeatureSettings(features),
                  confirm: choice => repository.confirmRecognitionEngine(choice),
                },
              ));
              settingsSaveChain = operation.then(() => undefined, () => undefined);
              const selected = await operation;
              recognitionEngineChoice = engine;
              publish({ ...selected, recognitionSetupRequired: false });
              await refresh();
            } catch (cause) {
              publish({ get recognitionSetupError() { return cause instanceof RecognitionSetupRollbackError
                ? t("app.valueCouldNotRestoreThePreviousSetting", { value0: readableError(cause.original),
                  value1: cause.rollbackErrors.map(readableError).join("; ") })
                : cause instanceof Error && cause.message === "VOICE_SETUP_CLOUD_UNAVAILABLE"
                  ? t("setup.cloudUnavailable") : readableError(cause); },
              recognitionSetupErrorDetail: errorDetailFrom("recognitionSetup",
                cause instanceof RecognitionSetupRollbackError ? { ...cause, cause: cause.original } : cause) });
            } finally {
              publish({ recognitionSetupBusy: false });
            }
          },
          onSettingsChanged: (patch: Partial<VoiceInputSettings>, options: VoiceSettingsChangeOptions = {}) => {
            if (toggleInFlight || serviceOperationActive) {
              const busy = operationInProgressError();
              publish(failurePatch("settingsSave", busy));
              return Promise.reject(busy);
            }
            const downloadSelection = patch.engine === "local" ||
              (patch.modelId !== undefined && (patch.engine ?? state.settings.engine) === "local");
            const selectedId = patch.modelId ?? state.settings.modelId;
            if (downloadSelection) localDownloads.prepare(selectedId);
            const operation = settingsSaveChain.then(async () => {
              const previous = state.settings;
              let settings = withExplicitVoiceSource(previous, patch);
              // 显式选档（五档对话框）= 用户对音源的明确选择；成功后总是推进来源版本，
              // 免得晚到的旧刷新（例如还带着 UAC 兼容态的读数）把新档位盖回去。
              // 显式选档意图单独传入：旧 Host 上「只用电脑麦」只发旧 source，不能靠 wire 是否带档位判断。
              const chosenMode = options.audioSourceMode ?? patch.audioSourcePreference?.kind;
              const modeChosen = chosenMode !== undefined;
              const sourceChanged = (patch.source !== undefined && patch.source !== previous.source) || modeChosen;
              // Host 是档位的唯一持有者：它一旦接受了这次选档，后面本地落盘或回读失败都不回滚 Host
              // （回滚只能用本地旧设置猜 Host 原策略，猜不出 UAC 兼容态和指定设备）。
              let hostCommitted = false;
              // 与音源无关的保存（语言 / VAD / 润色……）不写 Host 的音源档位。
              const writeSource = modeChosen || patch.source !== undefined || patch.systemEndpointId !== undefined;
              const sourceEndpointChanged =
                patch.systemEndpointId !== undefined
                && patch.systemEndpointId !== previous.systemEndpointId;
              const windowContextChanged =
                settings.polishContext.window !== previous.polishContext.window;
              try {
                let systemInputs = state.systemInputs;
                if (sourceChanged) {
                  if (settings.source === "system") {
                    systemInputs = await ctx.voiceInput.listSystemInputs();
                    if (!settings.systemEndpointId) {
                      settings = {
                        ...settings,
                        systemEndpointId:
                          systemInputs.find((input) => input.isDefault)?.id ?? null,
                      };
                    }
                  } else {
                    systemInputs = [];
                  }
                }
                // 显式选档先把「已明确选择」marker 与完整设置落盘，再交 Host：本地写不进去就整笔
                // 不动 Host；Host 没接受则把本地设置写回原样。这样下次激活读到的本地设置与 Host
                // 一致——旧 Host 不认识 preserve，靠的正是这份已落盘的完整选择。
                if (modeChosen) {
                  await repository.confirmAudioSourceMode();
                  await repository.saveSettings(settings);
                }
                await configuration.apply(settings, { writeSource });
                hostCommitted = true;
                // 只认真实的 source 变化；语言/VAD/润色等普通保存不能冒充音源确认。
                if (!modeChosen && sourceChanged) await repository.confirmSourceSelection();
                if (!modeChosen) await repository.saveSettings(settings);
                // 用户重新挑了润色档位 = 一句明确的「权限我开好了，再试一次」。
                // 这是唯一拿得到的复位信号：封锁期间录音在采集前就被拦住，「写回成功
                // 就清零」那条路永远走不到，标志会一直挂着，而界面上还写着「开启后再切
                // 一下档位即可恢复」。换引擎不算：两种引擎的写回都要这道权限。
                if (patch.polish !== undefined) {
                  deliveryPermissionBlocked = false;
                }
                const status = await readVoiceStatus();
                // 选档后立刻回读 Host 真值（当前档位、两类麦的在场与授权、下一次会用哪类）。
                // 回读失败也不能停在旧档位：已写入成功的选择就是当前档位，否则下次点旧档会被当成「已选」而不生效。
                const permissions = writeSource
                  ? await ctx.voiceInput.checkPermissions().catch(() => ({
                    ...state.permissions,
                    ...(state.permissions.audioSources && chosenMode
                      ? { audioSources: { ...state.permissions.audioSources, mode: chosenMode } }
                      : {}),
                  }))
                  : state.permissions;
                const contextProbePatch = windowContextChanged
                  ? { contextProbe: await probeContext(settings) }
                  : {};
                // system 来源内只换 endpoint 也会改变 sourceReady/sourceIssue/timeline，
                // 与切来源属于同一个 sourcePatch 版本域。
                if (sourceChanged || sourceEndpointChanged) sourceSettingsRevision += 1;
                if (windowContextChanged) windowContextSettingsRevision += 1;
                publish({
                  settings,
                  systemInputs,
                  permissions,
                  deliveryPermissionBlocked,
                  ...voiceSourceStatusPatch(withConfirmedArchive(status)),
                  // 刚打开窗口上下文的那一刻就把真实权限状态探回来，别让用户
                  // 盯着一块什么都不说的说明区等下一次刷新。
                  ...contextProbePatch,
                  error: undefined,
                });
              } catch (cause) {
                // 展示时求值：开发者模式切换后主句跟着变。
                let message = () => readableError(cause);
                if (modeChosen) {
                  // 选档：Host 没接受（configure 失败）就原样未变；接受了就以 Host 为准，
                  // 界面跟随已写入的档位，下一次激活的 prepare 也会保留它。
                  const chosen = chosenMode;
                  publish(Object.assign(failurePatch("settingsSave", cause, () => message()), hostCommitted
                    ? {
                      settings,
                      permissions: state.permissions.audioSources && chosen
                        ? { ...state.permissions, audioSources: { ...state.permissions.audioSources, mode: chosen } }
                        : state.permissions,
                    }
                    : { settings: previous }));
                  if (hostCommitted) sourceSettingsRevision += 1;
                  // Host 没接受：本地已提前落盘的新选择写回原样（尽力而为）。
                  else await repository.saveSettings(previous).catch(() => undefined);
                  localDownloads.clearPreparation(selectedId);
                  throw cause;
                }
                try {
                  await configuration.apply(previous, { writeSource });
                } catch (rollbackCause) {
                  const original = message;
                  message = () => t("app.valueCouldNotRestoreThePreviousSetting", { value0: original(), value1: readableError(rollbackCause) });
                }
                publish(Object.assign(failurePatch("settingsSave", cause, () => message()), { settings: previous }));
                localDownloads.clearPreparation(selectedId);
                throw cause;
              }
              if (downloadSelection && !["cancelling", "cancelled"].includes(state.localDownloads?.[selectedId]?.phase ?? "")) {
                await localDownloads.start(selectedId);
              }
            });
            settingsSaveChain = operation.catch(() => undefined);
            if (patch.engine !== undefined) void operation.then(() => loadCloudModels(0)).catch(() => undefined);
            return operation;
          },
          onFeatureSettingsChanged: (patch: Partial<VoiceFeatureSettings>) => {
            if (patch.cloudModelId !== undefined) ++cloudSelectionRevision;
            if (toggleInFlight || serviceOperationActive) {
              const busy = operationInProgressError();
              publish(failurePatch("settingsSave", busy));
              return Promise.reject(busy);
            }
            const operation = settingsSaveChain.then(async () => {
              const previous = state.featureSettings;
              try {
                const next = sanitizeVoiceFeatureSettings({ ...previous, ...patch });
                if (patch.cloudModelId !== undefined) {
                  // 用已读到的列表校验，不重拉：切换不闪、不报错；执行时 Host 仍按实时计费复核。
                  const models = await cloudModelsForSelection();
                  const selected = selectedCloudOption(models, next.cloudModelId);
                  if (!selected) {
                    throw new VoiceAppError({
                      code: "com.reai.voice/CLOUD_MODEL_SELECTION_REQUIRED",
                      get userMessage() { return models.length === 0
                        ? t("view.cloudModelsUnavailable") : t("view.selectedCloudModelUnavailable"); },
                      retryable: true,
                    }, undefined, { constantMessage: true });
                  }
                  next.cloudModelBillingPolicy = cloudSelectionBillingPolicy(selected, previous.cloudModelId, previous.cloudModelBillingPolicy);
                }
                if (next.summaryEnabled && !next.summaryConsent) {
                  throw new VoiceAppError({
                    code: "com.reai.voice/SUMMARY_CONSENT_REQUIRED",
                    get userMessage() { return t("app.reviewAndAcceptTheUsageAndPrivacy"); },
                    retryable: false,
                  }, undefined, { constantMessage: true });
                }
                await repository.saveFeatureSettings(next);
                publish({ featureSettings: next, error: undefined });
                if (next.summaryEnabled && next.summaryMode === "auto") scheduleDigestCheck();
              } catch (cause) {
                publish(Object.assign(failurePatch("settingsSave", cause), { featureSettings: previous }));
                throw cause;
              }
            });
            settingsSaveChain = operation.catch(() => undefined);
            return operation;
          },
          onAgentExperimentChanged: async (settings: VoiceAgentExperimentSettings) => {
            await repository.saveAgentExperiment(settings);
            publish({ agentExperiment: settings, error: undefined });
          },
          onRefreshConversationBackends: refreshConversationBackends,
          onChangeConversationBackend: changeConversationBackend,
          onDownloadModel: async (modelId) => {
            await localDownloads.start(modelId, true);
          },
          onCancelModelDownload: async (modelId) => {
            await localDownloads.cancel(modelId);
          },
          onRequestPermission: async (kind) => {
            try {
              await ctx.voiceInput.requestPermission(kind);
              await refresh();
            } catch (cause) {
              publish(failurePatch("permission", cause));
              throw cause;
            }
          },
          // 全天存档只决定要不要长期保存全天转写；常驻收音与它无关（2026-10-15 用户拍板）。
          // 点下即记目标值（设置页按目标显示）；同一时间只有一个写入在跑，连点只保留最后一次意图，
          // 跑完发现目标又变了就再写一次。失败后回读 Host 真值，设置页顶部给可读原因与诊断（§6.0 / §6.1）。
          onContinuousRecording: async (enabled) => {
            archiveDesired = enabled;
            archiveRevision += 1;
            publish({ continuousRecordingPending: enabled });
            if (archiveWriting) return;
            archiveWriting = true;
            try {
              while (archiveDesired !== undefined) {
                const target: boolean = archiveDesired;
                let timeline: AudioTimelineStatus;
                try {
                  timeline = await ctx.voiceInput.setContinuousRecording(target);
                } catch (cause) {
                  archiveRevision += 1;
                  // 等待期间用户又改了主意：这笔旧失败已被新意图取代，接着写最新目标。
                  if (archiveDesired !== target) continue;
                  archiveDesired = undefined;
                  // 先立刻收起目标值并报错，不让开关停在「关」而 Host 其实还开着。
                  publish(Object.assign(failurePatch("continuousRecording", cause), { continuousRecordingPending: undefined }));
                  // Host 可能已经写入、只是确认失败：再有界回读一次真值，只取存档位（时间线其余字段
                  // 归来源版本域，不在这里覆盖）；回读超时或失败就保留上次确认的值，期间又有新写入时以新写入为准。
                  const revision = archiveRevision;
                  void Promise.race([
                    ctx.voiceInput.getStatus().then(status => status.timeline),
                    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 3_000)),
                  ]).then((fresh) => {
                    if (!fresh || !state.timeline || revision !== archiveRevision || archiveWriting) return;
                    publish({ timeline: {
                      ...state.timeline,
                      continuousRecordingEnabled: fresh.continuousRecordingEnabled,
                      recordingState: fresh.recordingState,
                    } });
                  }, () => undefined);
                  throw cause;
                }
                archiveRevision += 1;
                // 回执只取存档位：写入期间来源可能已经切换（路由、运行态归来源版本域），
                // 整份旧回执会把切源后的时间线盖回去；没有当前时间线时才整份采用。
                const confirmed: AudioTimelineStatus = state.timeline
                  ? { ...state.timeline, continuousRecordingEnabled: timeline.continuousRecordingEnabled, recordingState: timeline.recordingState }
                  : timeline;
                if (archiveDesired === target) {
                  archiveDesired = undefined;
                  publish({ timeline: confirmed, continuousRecordingPending: undefined, error: undefined });
                } else {
                  publish({ timeline: confirmed });
                }
              }
            } finally {
              archiveWriting = false;
            }
          },
          // §5D：确认=用户在对话框里勾选并点了「确认并开启」；epoch 读取失败
          // （Host 尚未下发 sessionEpoch）时如实报不可用，不静默也不伪造同意。
          onScreenshotConsentConfirm: async () => {
            const enabled = await screenshotConsent.confirmEnable(async () => true);
            publish({
              screenshotConsent: {
                enabled: screenshotConsent.isEnabled(),
                ...(enabled ? {} : { unavailable: true }),
              },
            });
            if (!enabled) {
              publish({ get error() { return t("screenshot.unavailable"); }, errorDetail: errorDetailFrom("screenshot", undefined) });
            }
          },
          onScreenshotConsentRevoked: async () => {
            await screenshotConsent.revoke();
          },
          onTimelinePaused: async (paused) => {
            const timeline = await ctx.voiceInput.setTimelinePaused(paused);
            publish({ timeline });
          },
          onSendContextToAgent: async (recordingId) => {
            try {
              await sendContextToAgentsIm(recordingId);
            } catch (cause) {
              publish(failurePatch("sendToAgent", cause));
              throw cause;
            }
          },
          onPrepareAttachments: prepareCommandAttachments,
          onOpenSourceLink: (url) => openVoiceSourceLink(ctx.surfaces as typeof ctx.surfaces & { openExternal?: (url: string) => Promise<void> }, url),
          onUploadAttachment: uploadCommandImage,
          onReleaseAttachment: releaseCommandAttachment,
          onSendCommandFollowUp: async (text, conversation, attachments) => {
            try {
              return await sendCommandFollowUp(text, conversation, attachments);
            } catch (cause) {
              publish(failurePatch("followUp", cause));
              throw cause;
            }
          },
          onRetryAgentRequest: async (taskId) => {
            if (state.commandPhase !== "idle" || state.phase !== "idle" || activeCommandRuns.size > 0 || toggleInFlight) {
              throw new VoiceAppError({ code: "VOICE_BUSY", userMessage: t("app.thePreviousVoiceCommandIsStillProcessing"), retryable: true }, undefined, { constantMessage: true });
            }
            const item = state.commandHistory.find(item => item.id === taskId && item.errorCode === "AGENT_RECEIPT_UNKNOWN");
            if (!item) throw new VoiceAppError({ code: "AGENT_PENDING_NOT_FOUND", userMessage: t("chat.requestRecoveryUnavailable") }, undefined, { constantMessage: true });
            let recovery: PendingAgentRequest;
            try { recovery = await pendingAdmissions.get(item.agentRequestKey ?? taskId); }
            catch { throw new VoiceAppError({ code: "AGENT_PENDING_NOT_FOUND", userMessage: t("chat.requestRecoveryUnavailable") }, undefined, { constantMessage: true }); }
            if (item.agentSessionId !== recovery.request.sessionId) throw new VoiceAppError({ code: "AGENT_RESULT_IDENTITY_MISMATCH", userMessage: t("chat.requestRecoveryUnavailable") }, undefined, { constantMessage: true });
            if (!recovery.request.attachmentInput && (item.messages?.find(message => message.from === "user")?.attachments?.some(file => file.kind === "file")
              || pendingVoiceRequestHasFileAttachments(recovery.request.text))) {
              requireVoiceTaskAttachmentScene(item.commandId);
              throw new VoiceAppError({ code: "VOICE_ATTACHMENT_MODEL_UNCONFIRMED", userMessage: t("chat.attachments.errors.VOICE_ATTACHMENT_MODEL_UNCONFIRMED"), retryable: false }, undefined, { constantMessage: true });
            }
            if (recovery.request.attachmentInput) requireVoiceTaskAttachmentScene(item.commandId);
            publish({ commandPhase: "processing", activeMode: "command", error: undefined });
            return startCommandAgent(item.transcript, BUILTIN_VOICE_COMMANDS.agent, undefined, {
              agentSessionId: recovery.request.sessionId, recovery,
              inputAttachments: item.messages?.find(message => message.from === "user")?.attachments,
              // F04：回执恢复后的重试留在原对话里，不另起一段。
              ...(item.conversationId ? { conversationId: item.conversationId } : {}),
            });
          },
          onCancelCommand: async (taskId) => {
            const run = activeCommandRuns.get(taskId);
            if (!run) return;
            run.controller.abort();
            await run.finished;
          },
          onInstallBrowserWebAccessAndRetry: async (item) => {
            const originalRun = activeCommandRuns.get(item.id);
            await ctx.agent.requireToolDependency({ tool: "web_search", schemaVersion: 2 });
            // The Host install flow wakes the pending tool. Even if it finishes
            // during installation, never send a second copy of this question.
            if (originalRun) return;
            const conversationId = item.conversationId ? { conversationId: item.conversationId } : {};
            const conversation: VoiceAgentConversationRef | undefined = item.agentSessionId
              ? { agentSessionId: item.agentSessionId, ...conversationId }
              : item.dshSessionId
                ? { dshSessionId: item.dshSessionId, ...conversationId }
                : item.conversationId ? { conversationId: item.conversationId } : undefined;
            await sendCommandFollowUp(item.transcript, conversation);
          },
          // 听写的错误只在对话页原地展示（视图拿 rejected Promise 自己画），不进全局 error。
          onDictateDraft: () => toggleDictation(),
          onDictationResultConsumed: async (sessionId) => {
            await ctx.voiceInput.acknowledgeResult(sessionId);
          },
          onDictateCancel: () => cancelDictation(),
          onRegenerateDayDigest: async (dayKey) => {
            try {
              await runDigestScheduler(dayKey);
            } catch (cause) {
              publish(failurePatch("summaryDay", cause));
              throw cause;
            }
          },
          onSendDayDigestToAgent: async (dayKey) => {
            try {
              await sendDayDigestToAgentsIm(dayKey);
              publish({ error: undefined });
            } catch (cause) {
              publish(failurePatch("sendToAgent", cause));
              throw cause;
            }
          },
          onOpenConversation: entityId => conversationOpen.open(entityId),
          onConversationNavigation: () => conversationOpen.retire(),
          onMarkCommandRead: async (commandId) => {
            try {
              const commandHistory = await repository.markCommandRead(commandId);
              await ctx.voiceCommand.dismissTask(commandId).catch(() => undefined);
              publish({ commandHistory });
            } catch (cause) {
              // 清未读点失败不值得打扰人：下次打开再试。
              console.warn("[voice] 清未读标记失败", diagnosticLogFields(cause));
            }
          },
          onSummarizeSegment: async (recordingId: string) => {
            try {
              await summarizeSegmentAction(recordingId);
            } catch (cause) {
              publish(failurePatch("summarySegment", cause));
              throw cause;
            }
          },
          // 详情页的播放条要自己控播放/暂停，所以这里只负责取件，音频元素的生命周期
          // 归视图。取件仍走既有的 mount 内一次性令牌：令牌只带录音 id，60 秒到期焚毁。
          onLoadReplayAudio: async (recordingId: string) => {
            try {
              const grant = await ctx.voiceRecordings.authorizePlayback(recordingId);
              const bytes = await ctx.evidence.fetch(grant.pickupToken);
              // 成功路径**不** publish：那会触发整页重渲染，把正在加载的播放键换成
              // 一颗新按钮，而旧闭包里的收尾逻辑再也够不着它。
              return new Blob([bytes], { type: grant.mimeType });
            } catch (cause) {
              // R10：取件失败的原始原因进 console（Host 回传插件日志），与 play() 被拒
              // 的那条一起，给真机复现留证据。
              console.error("[voice] replay 取件失败", { recordingId, ...diagnosticLogFields(cause) });
              // 取件失败最常见的原因就是那段录音已经不在了。顺手把权威状态拉回来，
              // 让那条播放条当场变成「录音已过期」，而不是留在原地让用户反复点。
              void refreshReplayCache();
              publish(failurePatch("replay", cause));
              throw cause;
            }
          },
          onRetryInputTranscription: async (historyId: string, recordingId: string) => {
            try {
              await savedInputRetries.start(historyId, recordingId, retrySelection);
            } catch (cause) {
              publish(failurePatch("retranscribe", cause, () => {
                const code = normalizedError(cause).code;
                if (code === "HOST_CAPABILITY_NOT_AVAILABLE" || code.includes("HOST_API") || String(cause).includes("HOST_API_INCOMPATIBLE")) return t("retry.upgradeHost");
                if (code.endsWith("VOICE_SAVED_INPUT_NOT_FOUND") || String(cause).includes("VOICE_SAVED_INPUT_NOT_FOUND")) return t("view.recordingExpiredCopy");
                return readableError(cause);
              }));
            }
          },
          onCancelInputTranscription: async (recordingId: string) => {
            try { await savedInputRetries.cancel(recordingId); }
            catch (cause) { publish(failurePatch("retranscribeCancel", cause)); }
          },
          onReplayRetentionChanged: async (retention: VoiceReplayRetention) => {
            try {
              const replayCache = await ctx.voiceRecordings.setReplayRetention(retention);
              const recordings = await ctx.voiceRecordings.list({ page: 0, perPage: 50 });
              publish({
                replayCache,
                recordings: recordings.items,
                recordingsTotal: recordings.total,
                error: undefined,
              });
            } catch (cause) {
              publish(failurePatch("replayRetention", cause));
              throw cause;
            }
          },
          onClearReplayCache: async () => {
            try {
              // 设置里的动作叫“清空语音记录”，所以不能只清回听 PCM。先把 Host
              // 可见的全天记录全部删除，再清输入回听和插件私有的输入历史/每日总结。
              for (let batch = 0; batch < 100; batch += 1) {
                const page = await ctx.voiceRecordings.list({ page: 0, perPage: 100 });
                if (page.items.length === 0) break;
                for (const item of page.items) {
                  await ctx.voiceRecordings.delete(item.id);
                }
              }
              const remaining = await ctx.voiceRecordings.list({ page: 0, perPage: 1 });
              if (remaining.total > 0) {
                throw new VoiceAppError({
                  code: "com.reai.voice/VOICE_RECORDS_CLEAR_INCOMPLETE",
                  get userMessage() { return t("app.thereAreTooManyRecordingsToClear"); },
                  retryable: true,
                }, undefined, { constantMessage: true });
              }
              const replayCache = await ctx.voiceRecordings.clearReplayCache();
              await repository.clearVoiceRecords();
              for (const dayKey of Object.keys(digestAttempts)) delete digestAttempts[dayKey];
              publish({
                replayCache,
                recordings: [],
                recordingsTotal: 0,
                history: [],
                dayDigests: {},
    screenshotConsent: { enabled: false },
                error: undefined,
              });
            } catch (cause) {
              publish(failurePatch("replayClear", cause));
              throw cause;
            }
          },
          onDeleteRecording: async (recordingId) => {
            // 删之前先记下这一段属于哪一天：publish 之后 state.recordings 就不含它了。
            const deletedStartMs = state.recordings.find((item) => item.id === recordingId)?.wallStartMs;
            try {
              await ctx.voiceRecordings.delete(recordingId);
              const recordings = await ctx.voiceRecordings.list({ page: 0, perPage: 50 });
              publish({
                recordings: recordings.items,
                recordingsTotal: recordings.total,
                error: undefined,
              });
            } catch (cause) {
              publish(failurePatch("recordingDelete", cause));
              throw cause;
            }
            // R17：删完刷新那一天的总结——素材变了（指纹不同），调度器会重合或撤掉；
            // 删段是用户明确的动作，不受每小时一次的节流限制。
            const dayKey = dayKeyOf(new Date(deletedStartMs ?? Date.now()));
            delete digestAttempts[dayKey];
            await persistDigestAttempts();
            void runDigestScheduler(state.dayDigests[dayKey] ? dayKey : undefined).catch((cause) => {
              console.warn("[voice] 删段后刷新当日总结失败", diagnosticLogFields(cause));
            });
          },
          // C-3b：把命令事件挂到 Action 层。Host 只存「哪些被挂了」——命令本来就在
          // 命令目录里，标题跟着 manifest 走，这里不推送任何内容。
          onActionMountChanged: async (commandId, mounted) => {
            const event = COMMAND_EVENT_META.find((meta) => meta.id === commandId);
            // 只有这次改动**确实落地了**才拿它兜底；挂载本身就失败时兜底会把一个
            // 没发生的状态写进界面。
            let landed = false;
            try {
              if (mounted) {
                await ctx.actionItems.mount({
                  kind: "command",
                  id: commandId,
                  title: event?.title ?? commandId,
                  detail: event?.description,
                });
              } else {
                await ctx.actionItems.unmount("command", commandId);
              }
              landed = true;
              publish({ error: undefined });
            } catch (cause) {
              publish(failurePatch("actionMount", cause));
              throw cause;
            } finally {
              // 勾选态的真源在 Host：无论成败都回读一次，别让界面留下一个假的对勾。
              // 回读本身也失败时，才用刚落地的这次改动兜底（见 refreshActionMounts）。
              await refreshActionMounts(landed ? { commandId, mounted } : undefined);
            }
          },
        }, { legacyBack });
        const openTaskConversation = (raw: unknown) => {
          if (!raw || typeof raw !== "object") return;
          const intent = raw as {
            source?: unknown; actionId?: unknown;
            payload?: { entityId?: unknown; openToken?: unknown };
          };
          if (intent.source !== "host.taskConversation" || typeof intent.payload?.entityId !== "string") return;
          const token = intent.payload.openToken;
          if (token !== undefined && (intent.actionId !== "open-conversation"
            || typeof token !== "string" || !/^[\x21-\x7e]{1,128}$/.test(token))) return;
          if (mounted) stopHostVersionRefresh = hostVersionReader.refreshOnVisible(hostVersionScope);
          // Host-delivered owned opens require the captured receipt. Only an
          // explicit local history click may prepare a new operation.
          if (token === undefined && typeof ctx.agent.prepareConversationOpen === "function") {
            publish(failurePatch("conversationOpen", { code: "TASK_SOURCE_STALE" },
              () => t("errors.conversationOpen.sourceStale")));
            return;
          }
          void conversationOpen.open(intent.payload.entityId,
            typeof token === "string" ? { openToken: token } : undefined);
        };
        stopTitlebarIntent = surface.onIntent((raw) => {
          if (!raw || typeof raw !== "object") return;
          const intent = raw as {
            source?: unknown;
            actionId?: unknown;
            payload?: { type?: unknown; entityId?: unknown };
          };
          if (
            intent.source === "host.taskConversation"
            && typeof intent.payload?.entityId === "string"
          ) {
            openTaskConversation(raw);
            return;
          }
          if (
            intent.source === "host.titlebarAction" &&
            intent.actionId === "settings" &&
            intent.payload?.type === "open-settings"
          ) {
            view?.toggleSettings();
          }
        });
        listeners.add(listener);
        // 层管理可从 Voice 以外修改挂载；旧 Host 仍保留打开时回读。
        stopActionMounts = ctx.actionItems.onChange?.(() => void refreshActionMounts());
        /* view 已挂上（mount 成功）：back-to-root command 从这一刻起可用。 */
        activeVoiceView = view ?? null;
        surface.ready();
        voiceSurfaceMounts += 1;
        surfaceCounted = true;
        voiceClipCapture?.setMounted(voiceSurfaceMounts === 1);
        // ready 不等于已可见（冷后台挂载）；用户稍后打开会话时再触发有界刷新，
        // 不依赖「复制诊断」，也不绕过 Host 的可见界面门禁。
        stopHostVersionRefresh = hostVersionReader.refreshOnVisible(hostVersionScope);
        if (typeof surface.onPresentationChange === "function") {
          stopPresentationChange = surface.onPresentationChange(() => {
            if (!mounted) return;
            stopHostVersionRefresh = hostVersionReader.refreshOnVisible(hostVersionScope);
            rereadCloudModelsWhenVisible();
          });
        }
        if (
          surface.initialIntent
          && typeof surface.initialIntent === "object"
          && (surface.initialIntent as { source?: unknown }).source === "host.taskConversation"
        ) {
          openTaskConversation(surface.initialIntent);
        }
        if (isSystemTaskReturnIntent(surface.initialIntent)) void refresh();
        void refresh();
        void refreshActionMounts();
      } catch (cause) {
        mounted = false;
        uncountSurface();
        conversationOpen.retire();
        stopPresentationChange?.();
        stopHostVersionRefresh?.();
        window.clearInterval(modelPoll);
        stopReturnIntent();
        listeners.delete(listener);
        if (listeners.size === 0) clearCloudModelsRetry();
        stopTitlebarIntent?.();
        stopActionMounts?.();
        void navigation.dispose();
        view?.dispose();
        void savedInputRetries.cancelAll();
        /* 身份保护：这个失败分支只收自己的引用，别误伤并发的新 mount。 */
        if (activeVoiceView === (view ?? null)) activeVoiceView = null;
        surface.fail(
          // 不挂 cause：SDK 会把它序列化成 wire diagnostic 交给 Host。
          new VoiceAppError({
            code: "com.reai.voice/SURFACE_INIT_FAILED",
            get userMessage() { return t("app.couldNotOpenVoice"); },
            retryable: true,
          }, withOuterCode(collectErrorFields(cause), "com.reai.voice/SURFACE_INIT_FAILED"), { constantMessage: true }),
        );
        return;
      }
      return () => {
        mounted = false;
        uncountSurface();
        conversationOpen.retire();
        window.clearInterval(modelPoll);
        stopPresentationChange?.();
        stopHostVersionRefresh?.();
        stopReturnIntent();
        listeners.delete(listener);
        if (listeners.size === 0) clearCloudModelsRetry();
        stopTitlebarIntent?.();
        stopActionMounts?.();
        void navigation.dispose();
        view?.dispose();
        void savedInputRetries.cancelAll();
        /* 身份保护：旧 mount 的 cleanup 只在自己仍是当前引用时清空。 */
        if (activeVoiceView === (view ?? null)) activeVoiceView = null;
      };
    });
  },

  async deactivate() {
    stopCloudModels?.();
    stopCloudModels = undefined;
    disposeHostVersion?.();
    disposeHostVersion = undefined;
    disposeAsyncSegments?.();
    disposeAsyncSegments = undefined;
    const cancelRetries = cancelSavedInputRetries;
    cancelSavedInputRetries = undefined;
    await cancelRetries?.();
    stopLocalDownloads?.();
    stopLocalDownloads = undefined;
    stopVoiceLocale?.();
    stopVoiceLocale = undefined;
    requestTextProviderDeactivate?.();
    requestTextProviderDeactivate = undefined;
    voiceClipCapture?.dispose();
    voiceClipCapture = undefined;
    if (voiceStatusPoll !== undefined) window.clearInterval(voiceStatusPoll);
    voiceStatusPoll = undefined;
    listeners.clear();
    const cancel = cancelActiveVoiceInput;
    cancelActiveVoiceInput = undefined;
    // Surface teardown is not user cancellation. Host owns durable v2 turns,
    // including permission/account revocation. Their saved actual identity is
    // resumed by the next Surface; explicit Stop still aborts/cancels above.
    const abortedRuns = [...activeCommandRuns.entries()].filter(([, run]) => !run.durableAgent);
    for (const [taskId, run] of activeCommandRuns) {
      if (run.durableAgent) commandLifecycleTrace("surface_detached", taskId, { commandId: run.commandId });
    }
    for (const [taskId, run] of abortedRuns) {
      abortedCommandClaims.add(taskId);
      commandLifecycleTrace("external_abort", taskId, { commandId: run.commandId });
    }
    for (const [, run] of abortedRuns) run.controller.abort();
    if (abortedRuns.length > 0) {
      await Promise.race([
        Promise.allSettled(abortedRuns.map(([taskId, run]) => settleInterruptedCommand(taskId, run))),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    activeCommandRuns.clear();
    activeForegroundTaskId = undefined;
    // 等你拍板的展示状态只属于这个 Surface：旧回合此后结算时已不在运行表里、不会再清它，
    // 不在这里清掉，下次激活就会留下一条永远在等的提示。
    commandProgressHandlers.clear();
    commandUserWaitHandlers.clear();
    endedUserWaits.clear();
    state = { ...state, agentWaits: [] };
    await cancel?.().catch(() => undefined);
  },
});

/**
 * 阶段失败的落盘形态（§6.0 白名单）：码、来源类别、HTTP 状态码、原文字符数、时间；原文不落盘。
 * 链上没有合文法的码时用插件自己的阶段类别码（`POLISH_FAILED` / 写回类别），不编新码。
 */
function stageFailure(fields: VoiceErrorFields, fallbackCode: string): VoiceStageFailure {
  return {
    code: fields.code ?? fallbackCode,
    at: new Date().toISOString(),
    ...(fields.source ? { source: fields.source } : {}),
    ...(fields.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
    ...(fields.rawLength ? { rawLength: fields.rawLength } : {}),
    ...(fields.omittedCodes ? { omittedCodes: fields.omittedCodes } : {}),
  };
}

function historyItem(
  result: VoiceInputResult,
  polishInfo: {
    polish: VoicePolishSetting;
    recognitionEngine: VoiceInputSettings["engine"];
    originalSelection?: SavedInputSelection;
    originalTranscript?: string;
    polishFailed?: boolean;
    polishFailure?: VoiceStageFailure;
    deliveryFailure?: VoiceStageFailure;
  },
): VoiceHistoryItem {
  const createdAt = new Date().toISOString();
  // not_retained / failed 时只有文字：不挂回听引用（详情页就没有回听入口）。
  const replayClip = savedReplayClip(result);
  const replayRange = replayClip ? replayPresentationRange(replayClip) : undefined;
  return {
    id: `${createdAt}-${crypto.randomUUID()}`,
    transcript: result.transcript?.trim() ?? "",
    language: result.language ?? "auto",
    source: result.source ?? state.settings.source,
    inserted: result.inserted === true,
    durationMs: result.durationMs ?? 0,
    createdAt,
    ...(result.warningCode ? { warningCode: result.warningCode } : {}),
    recognitionEngine: polishInfo.recognitionEngine,
    ...(polishInfo.originalSelection ? { originalSelection: polishInfo.originalSelection } : {}),
    polish: polishInfo.polish,
    ...(polishInfo.polishFailed ? { polishFailed: true } : {}),
    ...(polishInfo.polishFailure ? { polishFailure: polishInfo.polishFailure } : {}),
    ...(polishInfo.deliveryFailure ? { deliveryFailure: polishInfo.deliveryFailure } : {}),
    ...(polishInfo.originalTranscript
      ? { originalTranscript: polishInfo.originalTranscript }
      : {}),
    // 回听片段与这条文字绑在一起。Host 没留（not_retained / failed）就没有这两个字段。
    ...(replayClip
      ? {
          recordingId: replayClip.id,
          recordingWallStartMs: replayRange?.wallStartMs,
          recordingDurationMs: replayRange?.durationMs,
        }
      : {}),
  };
}

/** 浮层文案带上真实错误码（只有码，不带原文）：「翻译失败 · 超时（AI_TIMEOUT）」。 */
/** 总结 / 润色失败已采集的字段；本模块自判的失败（超时等）没有字段时只按它的码补一份。 */
function failureFields(failure: { code: string; fields?: VoiceErrorFields } | undefined): VoiceErrorFields {
  return failure?.fields ?? collectErrorFields(undefined, failure ? { code: failure.code } : {});
}

/** 前台失败结果面板的结构化字段：登记过的错误码与 Agent 阶段（按出身采集）；原文不进浮层。 */
function foregroundFailureFields(cause: unknown): { code?: string; agentFailure?: VoiceErrorFields["agentFailure"] } {
  const fields = collectErrorFields(cause);
  return { ...(fields.code ? { code: fields.code } : {}), ...(fields.agentFailure ? { agentFailure: fields.agentFailure } : {}) };
}

/** 命令历史条目的失败结构化字段（落盘白名单）：原文字符数、来源类别、HTTP 状态码。 */
function commandFailureFields(
  fields: VoiceErrorFields,
): Pick<VoiceCommandHistoryItem, "errorRawLength" | "errorSource" | "errorHttpStatus" | "errorOmittedCodes"
  | "errorAgentStage" | "errorExitCode" | "errorUpstreamCode"> {
  return {
    ...(fields.rawLength ? { errorRawLength: fields.rawLength } : {}),
    ...(fields.omittedCodes ? { errorOmittedCodes: fields.omittedCodes } : {}),
    ...(fields.source ? { errorSource: fields.source } : {}),
    ...(fields.httpStatus !== undefined ? { errorHttpStatus: fields.httpStatus } : {}),
    // Agent 引擎阶段 / 退出码 / 方括号上游码：只从已采集字段（按出身）取，落盘前再逐值校验。
    ...persistedAgentFailure({ errorAgentStage: fields.agentFailure?.agentStage, errorExitCode: fields.agentFailure?.exitCode,
      errorUpstreamCode: fields.agentFailure?.upstreamCode }),
  };
}


/** Keep platform capability admission separate from the user's permission decision. */
function deliveryFailureReason(cause: unknown): "voice_deliver_permission_required" | "voice_deliver_unavailable" | "insert_failed" {
  const code = normalizedError(cause).code;
  switch (code.slice(code.lastIndexOf("/") + 1)) {
    case "VOICE_DELIVER_NOT_GRANTED":
      return "voice_deliver_unavailable";
    case "VOICE_DELIVER_PERMISSION_REQUIRED":
    case "VOICE_DELIVER_PERMISSION_DENIED":
      return "voice_deliver_permission_required";
    default:
      return "insert_failed";
  }
}


function normalizedError(cause: unknown): { code: string; message: string } {
  if (cause && typeof cause === "object") {
    const error = cause as { code?: unknown; userMessage?: unknown; message?: unknown };
    return {
      code: typeof error.code === "string" ? error.code.slice(0, 100) : "VOICE_COMMAND_FAILED",
      get message() { return typeof error.userMessage === "string"
        ? error.userMessage.slice(0, 500)
        : typeof error.message === "string"
          ? error.message.slice(0, 500)
          : t("app.voiceCommandsAreTemporarilyUnavailable"); },
    };
  }
  return { code: "VOICE_COMMAND_FAILED", get message() { return t("app.voiceCommandsAreTemporarilyUnavailable"); } };
}

/**
 * 插件界面上的失败主句。开发者模式可带上游原文（方便排查）；普通模式只用插件自己的人话：
 * 登记过的固定文案 → 组合文案（按当前模式重新求值）→ 按错误码/类别查表 → 统一兜底。
 * 调用方都在 getter 里求值，切换开发者模式后已显示的主句随之更新。
 */
function cloudOptionRequiredError(): VoiceAppError {
  return new VoiceAppError({
    code: "com.reai.voice/CLOUD_MODEL_SELECTION_REQUIRED",
    get userMessage() { return t("app.cloudOptionRequired"); },
    retryable: true,
  }, undefined, { constantMessage: true });
}

function readableError(cause: unknown): string {
  if (voiceDeveloperMode()) {
    if (cause && typeof cause === "object") {
      const error = cause as { userMessage?: unknown; message?: unknown };
      if (typeof error.userMessage === "string") return error.userMessage;
      if (typeof error.message === "string") return error.message;
    }
    return t("app.voiceInputIsTemporarilyUnavailable");
  }
  return plainFailureText(cause);
}

/** 普通模式口径的失败主句（也用于会落盘或离开插件页面的文字）：只用插件自己的人话。 */
function plainFailureText(cause: unknown): string {
  return inPlainMode(() => constantUserMessage(cause) ?? composedUserMessage(cause) ?? knownFailureLabel(cause) ?? t("app.notCompletedTryAgainLater"));
}

function isVoiceCancellation(cause: unknown): boolean {
  const code = normalizedError(cause).code;
  return code === "VOICE_CANCELLED" || code.endsWith("/VOICE_CANCELLED");
}

function cancelledVoiceInputResult(): VoiceInputResult {
  return { phase: "idle", transcript: null, outcome: "cancelled" };
}

/** `apps.open` 打不开 ni.chat 时的用户可读原因（A3-24）。稳定错误码逐条对号，
    其余落到通用的「暂时打不开」——不带上游原文，跨插件错误串里可能有路径。 */
function agentsImOpenError(cause: unknown): string {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  switch (code) {
    case "APP_INTENT_TARGET_NOT_INSTALLED":
      return t("app.niChatIsNotInstalledInstallIt");
    case "INTENT_TARGET_FAILED":
      return t("app.niChatIsDisabledOrIncompatibleEnable");
    case "BRIDGE_DENIED":
      return t("app.niChatCouldNotOpenTryAgain");
    default:
      return t("app.niChatCouldNotOpenTryAgain");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new VoiceAppError({
    code: "com.reai.voice/VOICE_CANCELLED",
    get userMessage() { return t("app.voiceInputWasCancelled"); },
    retryable: true,
  }, undefined, { constantMessage: true });
}

function commandCancelledError(commandId?: string): VoiceAppError {
  return new VoiceAppError({
    code: "com.reai.voice/VOICE_CANCELLED",
    get userMessage() { return stoppedLabel(commandId); },
    retryable: true,
  }, undefined, { constantMessage: true });
}

function throwIfCommandCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw commandCancelledError();
}

/** 字数千分位（稿 fmtChars；与 voice-view 页头 meta 的读法一致）。 */
function formatChars(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
