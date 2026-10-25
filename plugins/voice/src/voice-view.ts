import type { PreparedVoiceAttachment, VoiceAttachmentTarget } from "./voice-attachment-input";
import * as surfaceSdk from "@reai/app-sdk/v1";
import type { AgentConversationOpenReceipt } from "@reai/app-sdk/v1";
import { selectedCloudOption, validCloudOptionId } from "./cloud-selection";
import { voiceCloudFailureMessage } from "./voice-user-errors";
import { contextCharacterCount, contextSegmentRuns, contextTime, hasUnfinishedContextStatus, isEmptyContextRecording, isEmptyContextText, isContextFiller, projectContextUtterances } from "./context-display";
import { TRANSLATION_LANGUAGES, translationTarget, translationLabel, type TranslationTarget } from "./voice-translation";
import { t, bindText, bindAttribute, localizedTextNode, releaseLocaleBindings, readText, onVoiceLocaleChange, voiceLocale, type TextSource } from "./voice-i18n";
import type {
  VoiceAudioSourceMode,
  VoiceInputSettings,
  VoiceModelInfo,
  VoicePermissionKind,
  VoicePolishSetting,
  VoiceRecordingSegment,
  VoiceReplayRetention,
} from "@reai/app-sdk/v1";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import {
  collectDaySegments,
  collectDaySegmentsFor,
  dayDateLabel,
  dayKeyOf,
  dayLabel,
  digestPointSegments,
  groupByDay,
  segmentDayKey,
  splitDigestPoint,
  type VoiceDayDigest,
} from "./voice-digest";
import {
  DEFAULT_MODEL_ID,
  isReplayAvailable,
  type VoiceRecordingRef,
  isValidTimeMs,
  type VoiceCommandHistoryItem,
  type VoiceAgentConversationRef,
  type VoiceFeatureSettings,
  type VoiceHistoryItem,
  type VoiceViewState,
  type VoiceErrorDetail,
  sourceMigrationNoticeText,
  SOURCE_MIGRATION_NOTICE,
  LEGACY_CAPTURE_LIMIT_SECONDS,
  MAX_RECORDING_MINUTES,
  MIN_RECORDING_MINUTES,
  sanitizeMaxRecordingMinutes,
} from "./data";
import { createVoiceChatDetail } from "./voice-chat-detail";
import {
  AUDIO_SOURCE_MODES,
  audioSourceModeDisabledReason,
  audioSourceModePatch,
  currentAudioSourceMode,
  hostSupportsFiveModes,
  isLegacyCompatibilityMode,
  noMicrophoneAvailable,
  shouldOfferComputerMicrophoneGrant,
  type AudioSourceDisabledReason,
} from "./voice-audio-source";
import { BUILTIN_VOICE_COMMANDS } from "./voice-ai-contract";
import { interruptedLabel } from "./voice-stop-copy";
import {
  captureDiagnosticsSelection,
  createVoiceDiagnosticsStore,
  restoreDiagnosticsSelection,
  sweepVoiceDiagnostics,
  voiceDiagnosticsBlock,
} from "./voice-diagnostics-view";
import { durationText, entryFromErrorDetail, errorDetailFrom, failureState, tickVoiceElapsed, elapsedNode, type VoiceDiagnosticDetail, type VoiceDiagnosticEntry } from "./voice-diagnostics";
import { replyPreview, toolProgressSummary } from "./voice-agent-presentation";
import { collectErrorFields, diagnosticLogFields, structuredCode } from "./voice-error-fields";
import { diagnosticModelName, diagnosticModelToken } from "./voice-model-registry";

export type VoiceSettingsTarget =
  | "engine"
  | "polish"
  | "polish-context"
  | "model"
  | "source"
  | "gain"
  | "commands"
  | "agent"
  | "summary"
  | "replay-cache"
  | "permissions";

/**
 * 三条可绑定的命令事件（C-3b：每行右侧多一个「挂到 Action 层」开关）。
 *
 * 文案 1:1 取自 `design/VoiceType_UI_Designs.html` 的 `VOICE_CMDS`；`id` 是
 * manifest 里那三条 Command 的 id——挂载走的就是它。
 *
 * ⚠️ 这一页只说「这个插件能干什么」，不说「哪颗键触发它」：后者归键盘，
 * 在设备 › 键位映射里配（第 4 轮拍板的架构分界，插件暴露事件、硬件绑定归 Host）。
 */
export const COMMAND_EVENT_META: ReadonlyArray<{
  id: string;
  title: string;
  description: string;
  outcome: string;
  /** 行首那枚事件图标（稿 `VOICE_CMDS[].ic`：pen / globe / sparkles）。 */
  icon: "pen" | "globe" | "sparkles";
}> = [
  {
    id: "com.reai.voice.toggle-input",
    get title() { return t("view.voiceInput"); },
    get description() { return t("view.turnWhatYouSayIntoTextAnd"); },
    get outcome() { return t("view.insertIntoTheFocusedApp"); },
    icon: "pen",
  },
  {
    id: "com.reai.voice.command.translate",
    get title() { return t("view.voiceTranslation"); },
    get description() { return t("view.speakInOneLanguageAndInsertAnother"); },
    get outcome() { return t("view.insertIntoTheFocusedApp"); },
    icon: "globe",
  },
  {
    id: "com.reai.voice.command.agent",
    get title() { return t("view.voiceAgentTask"); },
    get description() { return t("view.turnSpeechIntoAnAgentRequestFrom"); },
    get outcome() { return t("view.showResultsInAPanelLongerTasks"); },
    icon: "sparkles",
  },
];

/**
 * 润色三档。文案与顺序 1:1 取自 `design/VoiceType_UI_Designs.html` 的 `VS_POLISH`
 * （V1.7.3：标签「原样 / 轻度 / 规整」，第三档描述带「规整」）。
 */
const POLISH_LEVELS: Array<{
  value: VoicePolishSetting;
  label: string;
  /** 详情页「注入前处理」那句话里的叫法：单字「轻度」放进句子读不通，补上「润色」。 */
  noun: string;
  description: string;
}> = [
  { value: "raw", get label() { return t("view.original"); }, get noun() { return t("view.insertOriginal"); }, get description() { return t("view.insertExactlyWhatWasRecognizedWithoutChanges"); } },
  { value: "light", get label() { return t("view.light"); }, get noun() { return t("view.lightPolishing"); }, get description() { return t("view.removeFillersAndImproveWordOrderWhile"); } },
  { value: "formal", get label() { return t("view.formal"); }, get noun() { return t("view.formalPolishing"); }, get description() { return t("view.usePolishedWrittenLanguageForEmailsAnd"); } },
];

/**
 * 识别语言三档（稿 `VS_LANGS`）。值沿用 Host 合同里已有的语言代码，标签照稿。
 * 稿把这一行画成 › 二级占位、点击轮换；二级页稿里也没有，所以这里同样轮换。
 */
const RECOGNITION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "auto", get label() { return t("view.detectAutomatically"); } },
  { value: "zh-CN", get label() { return t("view.simplifiedChinese"); } },
  { value: "en-US", label: "English" },
];

/** 录音缓存四档。产品合同不再提供“不保留”，最短自动留存 4 小时。 */
const REPLAY_RETENTIONS: Array<{
  id: VoiceReplayRetention;
  label: string;
  scope: string;
}> = [
  { id: "4h", get label() { return t("view.hours"); }, get scope() { return t("view.recordingsFromTheLastFourHours"); } },
  { id: "24h", get label() { return t("view.hours2"); }, get scope() { return t("view.recordingsFromTheLastDay"); } },
  { id: "7d", get label() { return t("view.days"); }, get scope() { return t("view.recordingsFromTheLastWeek"); } },
  { id: "30d", get label() { return t("view.days2"); }, get scope() { return t("view.recordingsFromTheLastMonth"); } },
];

const REPLAY_WAVE_BAR_COUNT = 58;

/** One selected conversation, from real hydration through durable Host acknowledgement. */
export function createOwnedConversationOpenController<T extends { id: string; agentSessionId?: string }>(ports: {
  load(entityId: string, current: () => boolean): Promise<T | undefined>;
  prepare(item: T): Promise<AgentConversationOpenReceipt | undefined>;
  land(item: T, current: () => boolean): Promise<boolean>;
  commit(item: T, receipt: AgentConversationOpenReceipt | undefined): Promise<void>;
  cancel(sessionId: string, receipt: AgentConversationOpenReceipt): Promise<void>;
  completed(item: T, current: () => boolean): Promise<void>;
  failed(error: unknown, item?: T, phase?: "hydrate" | "prepare" | "land" | "commit" | "complete"): void;
}) {
  type Selection = {
    entity: string; session: string; receipt?: AgentConversationOpenReceipt;
    pending?: Promise<boolean>; committed: boolean; completed: boolean;
    cancelledToken?: string;
  };
  let selected: Selection | undefined;
  const cancel = (selection: Selection) => {
    const receipt = selection.receipt;
    if (!receipt || selection.committed || selection.cancelledToken === receipt.openToken) return;
    selection.cancelledToken = receipt.openToken;
    void ports.cancel(selection.session, receipt).catch(() => undefined);
  };
  const retire = () => {
    const previous = selected;
    selected = undefined;
    if (previous) cancel(previous);
  };
  const open = (entity: string, receipt?: AgentConversationOpenReceipt): Promise<boolean> => {
    let selection = selected;
    if (!selection || selection.entity !== entity
      || (receipt && receipt.openToken !== selection.receipt?.openToken)
      || (selection.completed && !receipt)) {
      retire();
      selection = { entity, session: entity, receipt, committed: false, completed: false };
      selected = selection;
    }
    if (selection.pending) return selection.pending;
    if (selection.completed) return Promise.resolve(true);
    const operation = selection;
    const current = () => selected === operation;
    const run = async () => {
      let committing = false;
      let item: T | undefined;
      let phase: "hydrate" | "prepare" | "land" | "commit" | "complete" = "hydrate";
      try {
        item = await ports.load(entity, current);
        if (!current()) return false;
        if (!item || (receipt && item.agentSessionId !== entity)) {
          throw { code: "TASK_SOURCE_STALE" };
        }
        operation.session = item.agentSessionId ?? entity;
        if (!operation.receipt && !operation.committed) {
          phase = "prepare";
          operation.receipt = await ports.prepare(item);
          if (!current()) { cancel(operation); return false; }
        }
        phase = "land";
        if (!await ports.land(item, current)) throw { code: "TASK_NAVIGATION_FAILED" };
        if (!current()) return false;
        if (!operation.committed) {
          committing = true;
          phase = "commit";
          await ports.commit(item, operation.receipt);
          operation.committed = true;
        }
        if (!current()) return false;
        phase = "complete";
        await ports.completed(item, current);
        if (!current()) return false;
        operation.completed = true;
        return true;
      } catch (error) {
        if (current()) {
          // A failed durable commit keeps the exact receipt for a same-selection retry.
          // A navigation/hydration failure grants no acknowledgement.
          if (!committing && !operation.committed) { cancel(operation); selected = undefined; }
          ports.failed(error, item, phase);
        }
        return false;
      }
    };
    operation.pending = run().finally(() => { operation.pending = undefined; });
    return operation.pending;
  };
  return { open, retire };
}

export interface VoiceView {
  update(state: VoiceViewState): void;
  openSettings(target?: VoiceSettingsTarget): void;
  /**
   * Host 任务胶囊 / 结果面板要求打开某条真实 Agent 会话。`focusComposer` 为 true 时
   * 打开后光标直接落在输入框（用户明确点了「继续」「打开会话」，接下来就是打字）。
   */
  openConversation(entityId: string, options?: { focusComposer?: boolean }): boolean;
  setConversationOpenPending(pending: boolean): void;
  waitForConversationLanding(entityId: string, current: () => boolean): Promise<boolean>;
  /** 触发事件管理三级页返回 Voice 设置主面；供 Host 中间面包屑命令调用。 */
  navigateSettings(): void;
  /** Trusted Host settings action toggles back to root, including settings descendants. */
  toggleSettings(): void;
  /**
   * 回主列表（B2-2 面包屑返回键的落点）：Host 的 back-to-root command 调它。
   * 与设置页返回钮同一套收口（声音、聊天瞬态），幂等——已在主列表时是空操作。
   */
  navigateRoot(): void;
  dispose(): void;
}

/** 设置保存的附加意图：五档对话框里的显式选档（旧 Host 上 wire 可能不带档位）。 */
export interface VoiceSettingsChangeOptions {
  audioSourceMode?: VoiceAudioSourceMode;
}

export interface VoiceViewActions {
  onPrepareAttachments?(conversation?: VoiceAgentConversationRef): Promise<VoiceAttachmentTarget>;
  onUploadAttachment?(file: File, target: VoiceAttachmentTarget, signal: AbortSignal): Promise<PreparedVoiceAttachment>;
  onReleaseAttachment?(file: PreparedVoiceAttachment): Promise<void>;
  /** 用户打开历史详情时重试可见 Surface 的 Host 版本读取；不由 render 触发。 */
  onOpenHistory?(): void;
  onOpenConversation?(entityId: string): Promise<boolean>;
  onConversationNavigation?(): void;
  onCopyText?(text: string): Promise<void>;
  /** 复制诊断前补读 Host 版本（复用在途请求，最多等 3 秒）。 */
  onEnsureHostVersion?(): Promise<void>;
  onChooseRecognitionEngine?(engine: "local" | "cloud"): Promise<void>;
  onToggle(): Promise<unknown>;
  /**
   * 开始 / 完成一次语音命令采集（Command 档主按钮）。`commandId` 指定命令类型，
   * 缺省转文本。R8 之后命令详情的输入坞麦克风不再走这条路，改走 `onDictateDraft`
   * （定向听写，结果只落当前输入框）。
   */
  onCommandToggle(commandId?: string, conversation?: VoiceAgentConversationRef): Promise<unknown>;
  onOpenSystemTask(): Promise<void>;
  onRefresh(): Promise<void>;
  onSettingsChanged(settings: Partial<VoiceInputSettings>, options?: VoiceSettingsChangeOptions): Promise<void>;
  onFeatureSettingsChanged(settings: Partial<VoiceFeatureSettings>): Promise<void>;
  onDownloadModel(modelId: string): Promise<void>;
  onCancelModelDownload(modelId: string): Promise<void>;
  onRequestPermission(kind: VoicePermissionKind): Promise<void>;
  /** 全天存档开关（R4：Context 档没有控制条，唯一出口在设置 › 记录保留这一颗开关）。 */
  onContinuousRecording(enabled: boolean): Promise<void>;
  /** §5D：用户在截图同意对话框里勾选并确认后触发；app 侧读当前 epoch 并持久化。 */
  onScreenshotConsentConfirm(): Promise<void>;
  /** §5D：关闭截图同意；立即推进 generation，本次及后续采集都不再带图。 */
  onScreenshotConsentRevoked(): Promise<void>;
  /**
   * R17：删掉一段现场记录（段详情总结栏脚部，确认层之后才调）。删完视图回列表；
   * 当日总结的刷新归 app 层（删段 = 素材变了）。
   */
  onDeleteRecording(recordingId: string): Promise<void>;
  /**
   * A3-24「发给 agent」：把这一段 Context 作为附件带进 Agents·IM 的输入侧
   * （经宿主 `apps.open` 跨插件 intent，不走 Command Agent）。R7 起按钮在段详情
   * 总结栏脚部，且只在装了 Agents·IM 时渲染。
   */
  onSendContextToAgent(recordingId: string): Promise<void>;
  /**
   * R18「重新总结」：强制重合某一天的总结（绕过每小时一次的节流）。自动生成
   * 不经视图——那是 app 层调度器的事，视图只渲染 `state.dayDigests`。
   */
  onRegenerateDayDigest(dayKey: string): Promise<void>;
  /**
   * R18 总结行「发给 agent」：把那一天的总结作为附件带进 Agents·IM（与段详情同一条
   * 路，报告 L-25 裁定）；只在装了 Agents·IM 时渲染。
   */
  onSendDayDigestToAgent(dayKey: string): Promise<void>;
  /**
   * R11 段总结：让 agent（Dsh 会话）给这一段写要点，结果由 Host 持久化。再点一次
   * 是「重新总结」，复用同一会话。失败以 rejected Promise 带用户可读原因回到视图，
   * 手上已有的旧总结保留不动。
   */
  onSummarizeSegment(recordingId: string): Promise<void>;
  /** R9 未读点：命令详情被打开，清掉这条的 `unread`。 */
  onMarkCommandRead(commandId: string): Promise<void>;
  /**
   * 缺陷3：对转写缺失 / 失败 / 积压中的 Context 分片重新入队本地转写。
   * 失败以 rejected Promise 带用户可读原因回到本页行内提示。
   */
  onRetranscribeSegment?(recordingId: string): Promise<void>;
  /** Context 档往前多翻一页段；之后的刷新保持已翻到的页数。 */
  onLoadMoreRecordings?(): Promise<void>;
  /**
   * A3-16：Chat detail 输入坞的「发送」。文本沿用详情条目的 Dsh session，
   * 结果落命令历史与答案面板，失败如实回传给视图原地展示。
   */
  /** 返回这次运行的精确 taskId，详情页据此等待自己的新条目。 */
  onSendCommandFollowUp(text: string, conversation?: VoiceAgentConversationRef, attachments?: readonly PreparedVoiceAttachment[]): Promise<string>;
  /** Stop only this command and wait for its terminal state before re-enabling input. */
  onCancelCommand?(taskId: string): Promise<void>;
  onRetryAgentRequest?(taskId: string): Promise<string>;
  /** 缺少浏览器插件时，从聊天能力卡安装依赖并以原问题续跑同一段对话。 */
  onInstallBrowserWebAccessAndRetry?(item: VoiceCommandHistoryItem): Promise<void>;
  onOpenSourceLink?(url: string): Promise<void>;
  /**
   * R8：命令详情输入坞麦克风的定向听写。第一次调用起跑（返回 listening），第二次
   * 调用收工并返回转写；转写**只**通过返回值交给视图落进当前输入框——不走系统
   * 文字插入、不起命令。失败以 rejected Promise 带用户可读原因回到视图。
   */
  onDictateDraft(): Promise<
    { phase: "listening"; sessionId?: string }
    | {
      phase: "idle";
      transcript: string;
      sessionId?: string;
      outcome?: "recognized" | "cancelled";
    }
  >;
  onDictationResultConsumed(sessionId: string): Promise<void>;
  /** 人离开对话页时取消在途的听写；幂等。 */
  onDictateCancel(): Promise<void>;
  /** 详情页回听取件：拿到这一条录音的音频，播放/暂停由视图自己控。 */
  onLoadReplayAudio(recordingId: string): Promise<Blob>;
  /** 对 Esc/中断后保留的录音重新触发本地转写；只更新历史，不写回旧焦点。 */
  onRetryInputTranscription(historyId: string, recordingId: string): Promise<void>;
  onCancelInputTranscription?(recordingId: string): Promise<void>;
  onReplayRetentionChanged(retention: VoiceReplayRetention): Promise<void>;
  onClearReplayCache(): Promise<void>;
  /** Voice 独占的后台听音总开关；true 表示暂停 Host 常驻时间线。 */
  onTimelinePaused(paused: boolean): Promise<void>;
  /** C-3b：把这条命令事件挂到 / 撤出 Action 层。挂载状态由 Host 持有。 */
  onActionMountChanged(commandId: string, mounted: boolean): Promise<void>;
  /**
   * 车道 F：跳到 Host「设备 › 键位映射」子页（system.tasks.open target=keymap）。
   * 失败（SYSTEM_TASK_BUSY / SYSTEM_TASK_RETURN_PENDING）以 rejected Promise
   * 回到视图，由跳转行原地说清楚，不走全局 error。
   */
  onOpenKeymap(): Promise<void>;
  /** 打开 Host 账户页并精确聚焦登录行。 */
  onOpenAccountLogin?(): Promise<void>;
  /** 打开 Host 权限二级页。 */
  onOpenPermissionSettings?(): Promise<void>;
  /** 打开 Host「已安装 › 当前 Voice › 权限」，来源 appId 由 Host 可信会话注入。 */
  onOpenAppPermissions?(): Promise<void>;
  /** 一次性迁移提示已真实留在可见列表 DOM 后回报；深链瞬时首帧不能冒充看过。 */
  onNoticeShown?(): void;
  /**
   * 内部自主导航上报（B2-3 面包屑合同）：页面一变就回调（含挂载后的初始
   * history）；null = 回根页。Host 据此在 titlebar 面包屑显示「Voice / 子页」。
   */
  onNavigated(page: "history" | "detail" | "translation" | "chat" | "context" | "settings" | "events" | "models" | null): void;
}

type Page = "history" | "detail" | "translation" | "chat" | "context" | "settings" | "events" | "models";
type VoiceTab = "all" | "input" | "command" | "context";
/** Context 段详情（A3-22/23）当前那一栏：原文 / 总结。 */
type ContextPane = "raw" | "sum";

const VOICE_TABS: Array<{ id: VoiceTab; label: string }> = [
  { id: "all", get label() { return t("view.tabAll"); } },
  { id: "input", get label() { return t("view.tabInput"); } },
  { id: "command", get label() { return t("view.tabCommand"); } },
  { id: "context", get label() { return t("view.context"); } },
];

export function mountVoiceView(
  root: HTMLElement,
  initialState: VoiceViewState,
  actions: VoiceViewActions,
  options: { /** 旧 Host（注入的旧 SDK 运行时无 reportNav）降级：保留页内返回出口。 */ legacyBack?: boolean } = {},
): VoiceView {
  let state = initialState;
  // 提示属于“首次打开的这个 surface”：App 在 mount 成功后即可清持久态，但本次页面
  // 仍完整展示；后续 state 刷新也不会把它在用户看见前抹掉。
  const mountedNotice = initialState.notice;
  let page: Page = "history";
  let selectedTab: VoiceTab = "all";
  let selectedId: string | undefined;
  let keymapJumpError: TextSource;
  let keymapJumpErrorDetail: VoiceErrorDetail | undefined;
  let focusedSettingsTarget: VoiceSettingsTarget | undefined;
  let languageDialogOpen = false;
  let sourceDialogOpen = false;
  let summaryConsentOpen = false;
  let screenshotConsentOpen = false;
  let settingsFocusRevealed = false;
  let settingsFocusArmTimer: number | undefined;
  let stopSettingsFocusDismissal: (() => void) | undefined;
  let replayAudio: HTMLAudioElement | undefined;
  let replayObjectUrl: string | undefined;
  let replayPlayingId: string | undefined;
  let replayLoadingId: string | undefined;
  let replayAutoPlayId: string | undefined;
  let replayLoadGeneration = 0;
  let releaseReplayListeners: (() => void) | undefined;
  let releaseReplaySeek: (() => void) | undefined;
  let replayRenderPending = false;
  let replayError: { recordingId: string; message: string; detail?: VoiceErrorDetail } | undefined;
  const replayWaveforms = new Map<string, number[]>();
  /**
   * Context 段详情（A3-22/23）当前那一栏。R7：按稿默认落在「总结」——翻回一段
   * 38 分钟的现场记录，多数时候要的是「那次说定了什么」；没总结时那一栏是
   * 空态 + 「生成总结」，不再是一页只能看的空白。
   */
  let ctxPane: ContextPane = "sum";
  const openContextDetails = new Set<string>();
  /**
   * R18：哪一天的总结行正展开着。只活在这次停留里——离开列表页、切档、重新进来
   * 都回到收起（需求方裁定「不记住」）；但同一次停留里 state 刷新（段列表 5 秒
   * 一拍）不能把它合上，否则人正读着要点它自己收了。
   */
  let openDigestDay: string | undefined;
  /** R17：删除确认层开着（段 id）。确认层是页面上的一层，重渲染要能把它画回来。 */
  let deleteAsk: string | undefined;
  let disposed = false;
  const copyFeedbackTimers = new Set<number>();
  /* ── §6.0 等待 / 失败诊断（#waiting-failure-minimum；口径照 #941 KernelDiagnostics） ── */
  const diagStore = createVoiceDiagnosticsStore();
  /** 等待起点：key 带尝试身份；每轮渲染后清掉没再出现的 key，新尝试不继承旧起点。 */
  const waitStarts = new Map<string, number>();
  const waitSeen = new Set<string>();
  /** 已知真实起点就用它；否则记本页首次看到的时刻，并如实标「自打开页面起」。 */
  const waitSince = (key: string, knownStartMs?: number): Pick<VoiceDiagnosticEntry, "sinceMs" | "sinceObserved"> => {
    waitSeen.add(key);
    if (knownStartMs !== undefined && Number.isFinite(knownStartMs)) return { sinceMs: knownStartMs };
    let since = waitStarts.get(key);
    if (since === undefined) { since = Date.now(); waitStarts.set(key, since); }
    return { sinceMs: since, sinceObserved: true };
  };
  const diagnosticsBlock = (
    key: string,
    entry: VoiceDiagnosticEntry,
    extra: { slowAfterMs?: number; quiet?: boolean; className?: string } = {},
  ): HTMLElement => voiceDiagnosticsBlock({
    developerMode: state.developerMode,
    key,
    entry,
    host: () => state.hostVersion,
    store: diagStore,
    copy: (text) => actions.onCopyText
      ? actions.onCopyText(text)
      : Promise.reject(Object.assign(new Error("clipboard unavailable"), { code: "CLIPBOARD_UNAVAILABLE" })),
    ensureHost: actions.onEnsureHostVersion,
    rerender: () => render(),
    ...extra,
  });
  /** 失败诊断：有 detail 用它；没有（旧路径）如实写「未记录」。主句在旁边的横幅里，不进诊断。 */
  const errorDiagnostics = (key: string, detail: VoiceErrorDetail | undefined, extra: Partial<VoiceDiagnosticEntry> = {}) =>
    diagnosticsBlock(key, detail
      ? entryFromErrorDetail(detail, extra)
      : { state: "failed", step: () => t("diagnostics.step.unknown"), rawNote: "notRecorded", ...extra });
  /** 通用 inline 错误：主句 + 诊断（码、原文、两端版本、查看诊断）。 */
  const inlineErrorBlock = (className: string): HTMLElement => {
    const box = el("div", "voice-error-block");
    box.append(textEl("div", className, () => state.error));
    box.append(errorDiagnostics(`error:${state.errorDetail?.step ?? "unknown"}:${state.errorDetail?.at ?? ""}`, state.errorDetail));
    return box;
  };
  // 已用时间每秒就地刷新（不整页重渲染）；跨过慢阈值的活动行由它切到强调样式。
  const elapsedTicker = window.setInterval(() => { if (!disposed) tickVoiceElapsed(root); }, 1000);
  let noticeReported = false;
  let conversationOpenPending = false;
  let pendingNoticeElement: HTMLElement | undefined;
  const reportNoticeWhenVisible = () => {
    // 延后一轮：mount 返回后 App 会先处理 initialIntent。若任务深链立刻换到对话页，
    // 这颗节点已经断开，不能把那一闪而过的首帧当成用户看过。
    queueMicrotask(() => {
      if (
        disposed
        || conversationOpenPending
        || noticeReported
        || !pendingNoticeElement?.isConnected
        || document.visibilityState === "hidden"
      ) return;
      noticeReported = true;
      actions.onNoticeShown?.();
    });
  };
  const onNoticeVisibilityChanged = () => reportNoticeWhenVisible();
  if (mountedNotice) document.addEventListener("visibilitychange", onNoticeVisibilityChanged);

  const replayDuration = (): number | undefined => {
    const duration = replayAudio?.duration;
    return typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? duration : undefined;
  };
  const replayClock = (seconds: number) => clockDuration(Math.floor(seconds) * 1000);
  const syncReplayProgress = (recordingId: string) => {
    const slider = shell.querySelector<HTMLInputElement>(".replay-seek");
    if (!slider || slider.dataset.replayId !== recordingId) return;
    const duration = replayPlayingId === recordingId ? replayDuration() : undefined;
    const current = replayAudio?.currentTime ?? 0;
    const position = duration && Number.isFinite(current) ? Math.max(0, Math.min(duration, current)) : 0;
    slider.disabled = duration === undefined;
    slider.max = String(duration ?? 0);
    if (!releaseReplaySeek) slider.value = String(position);
    const label = () => duration === undefined
      ? t(replayError?.recordingId === recordingId ? "view.replayUnavailable" : "view.replayLoading")
      : `${replayClock(position)} / ${replayClock(duration)}`;
    bindAttribute(slider, "aria-valuetext", label);
    const time = shell.querySelector<HTMLElement>(".replay-time");
    if (time) bindText(time, label);
    const bars = shell.querySelectorAll<HTMLElement>(".replay-wave i");
    bars.forEach((bar, index) => bar.classList.toggle("played", !!duration && index / bars.length < position / duration));
  };

  /**
   * 把播放键刷成当前播放态。**每次都从页面上现查那颗按钮**，不捕获 DOM 引用——
   * 重渲染会换掉按钮，旧引用刷的是一个已经不在页面上的节点。
   */
  const syncReplayButton = () => {
    const button = shell.querySelector<HTMLButtonElement>(".replay-play");
    if (!button) return;
    const recordingId = button.dataset.replayId ?? "";
    const playing = replayAudio !== undefined
      && replayPlayingId === recordingId
      && !replayAudio.paused;
    button.innerHTML = playing ? pauseIcon() : playIcon();
    bindAttribute(button, "aria-label", () => playing ? t("view.pausePlayback") : t("view.playThisRecording"));
    button.disabled = replayLoadingId === recordingId;
    syncReplayProgress(recordingId);
    const error = shell.querySelector<HTMLElement>(".replay-error");
    if (error) {
      const message = () => replayError?.recordingId === recordingId ? replayError.message : "";
      bindText(error, message);
      error.hidden = message().length === 0;
    }
    // §6.0：回听失败带真实码与原文（DOMException 名 / MediaError 数字码 / Host 码）。
    const diag = shell.querySelector<HTMLElement>(".replay-diag");
    if (diag) {
      const failure = replayError?.recordingId === recordingId ? replayError : undefined;
      diag.replaceChildren(...(failure?.detail
        ? [errorDiagnostics(`replay:${recordingId}:${failure.detail.at}`, failure.detail, {
          details: [{ label: () => t("diagnostics.detail.recording"), tokens: () => [recordingId] }],
        })]
        : []));
    }
  };

  /** 离开这一条（返回列表、换一条、卸载）就把音频与 blob URL 一起收掉，不留后台声音。 */
  const releaseReplayAudio = () => {
    replayLoadGeneration += 1;
    releaseReplaySeek?.();
    releaseReplayListeners?.();
    releaseReplayListeners = undefined;
    replayAudio?.pause();
    replayAudio = undefined;
    replayPlayingId = undefined;
    replayLoadingId = undefined;
    replayAutoPlayId = undefined;
    replayError = undefined;
    if (replayObjectUrl !== undefined) {
      URL.revokeObjectURL(replayObjectUrl);
      replayObjectUrl = undefined;
    }
  };

  const setReplayError = (recordingId: string, cause: unknown, ownedMessage?: () => string) => {
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    const source = cause && typeof cause === "object"
      ? cause as { name?: unknown; userMessage?: unknown; message?: unknown }
      : undefined;
    // R10：真机上 play() 被拒的原因要进 Host 日志（Host 回传插件 console）留证据；只打结构化投影
    // （登记过的码 / 异常名、原文字符数），异常原文可能带用户内容，不进日志（§6.0 白名单）。
    console.error("[voice] replay play() rejected", {
      recordingId,
      name: structuredCode(source?.name) ?? null,
      ...diagnosticLogFields(cause),
    });
    const userMessage = () => typeof source?.userMessage === "string" ? source.userMessage.trim() : "";
    const browserMessage = typeof source?.message === "string" ? source.message.trim() : "";
    // Host / 浏览器原文只在开发者模式进主句；普通模式只用插件自己的文案。
    const message = () => ownedMessage?.() || (state.developerMode ? userMessage() : "")
      || (state.developerMode && browserMessage && /[\u3400-\u9fff]/u.test(browserMessage) ? browserMessage : "")
      || (source?.name === "NotAllowedError"
        ? t("view.playbackIsCurrentlyBlockedByTheSystem")
        : t("view.audioCouldNotPlayReopenThisRecording"));
    replayError = { recordingId, get message() { return message(); }, detail: errorDetailFrom("replay", cause) };
    syncReplayButton();
  };

  const playReplayAudio = (recordingId: string, audio: HTMLAudioElement) => {
    const generation = replayLoadGeneration;
    const isCurrent = () => !disposed && generation === replayLoadGeneration
      && replayPlayingId === recordingId && replayAudio === audio;
    if (!isCurrent()) return;
    replayError = undefined;
    try {
      const duration = replayDuration();
      if (duration !== undefined && audio.currentTime >= duration) audio.currentTime = 0;
      void Promise.resolve(audio.play()).catch((cause) => {
        if (isCurrent()) setReplayError(recordingId, cause);
      });
    } catch (cause) {
      setReplayError(recordingId, cause);
    }
    syncReplayButton();
  };

  /**
   * 详情一打开就把本机 WAV 取到内存。这样用户真正按播放键时只调用 `play()`，
   * 不会在一次异步 Host 往返之后丢掉 WebView 的用户播放权限。
   */
  const prepareReplayAudio = async (recordingId: string, autoPlay = false) => {
    // 这条刚取件失败：渲染触发的自动预取不再重试（否则「失败→刷缓存→重绘→再取」会空转），
    // 只有用户明确点播放、或离开页面清掉错误后才重新取。
    if (!autoPlay && replayError?.recordingId === recordingId) return;
    if (replayAudio && replayPlayingId === recordingId) {
      if (autoPlay) playReplayAudio(recordingId, replayAudio);
      return;
    }
    if (replayLoadingId === recordingId) {
      if (autoPlay) replayAutoPlayId = recordingId;
      return;
    }
    releaseReplayAudio();
    if (autoPlay) replayAutoPlayId = recordingId;
    const generation = replayLoadGeneration;
    replayLoadingId = recordingId;
    syncReplayButton();
    try {
      const blob = await actions.onLoadReplayAudio(recordingId);
      if (disposed || generation !== replayLoadGeneration || replayLoadingId !== recordingId) return;
      replayObjectUrl = URL.createObjectURL(blob);
      const audio = new Audio(replayObjectUrl);
      audio.preload = "auto";
      replayAudio = audio;
      replayPlayingId = recordingId;
      const isCurrent = () => !disposed && generation === replayLoadGeneration
        && replayPlayingId === recordingId && replayAudio === audio;
      const onMediaState = () => { if (isCurrent()) syncReplayButton(); };
      const onMediaError = () => {
        // MediaError 没有 name 字段：显式标上，诊断码才是登记过的「MediaError code N」。
        if (isCurrent()) setReplayError(recordingId,
          audio.error ? { name: "MediaError", code: audio.error.code, message: audio.error.message } : new Error("Audio decoding failed"),
          () => t("view.audioCouldNotBeDecodedReopenThis"));
      };
      const events = ["loadedmetadata", "durationchange", "timeupdate", "seeked", "ended", "pause", "play"];
      for (const event of events) audio.addEventListener(event, onMediaState);
      audio.addEventListener("error", onMediaError);
      releaseReplayListeners = () => {
        for (const event of events) audio.removeEventListener(event, onMediaState);
        audio.removeEventListener("error", onMediaError);
      };

      void blob.arrayBuffer().then((buffer) => {
        if (disposed || generation !== replayLoadGeneration) return;
        const heights = waveformHeightsFromWav(buffer, REPLAY_WAVE_BAR_COUNT);
        if (heights.length === 0) return;
        replayWaveforms.set(recordingId, heights);
        const wave = shell.querySelector<HTMLElement>(`.replay-wave[data-replay-id="${recordingId}"]`);
        if (wave) {
          wave.replaceChildren(replayWaveBars(recordingId, REPLAY_WAVE_BAR_COUNT, heights));
          syncReplayProgress(recordingId);
        }
      }).catch(() => undefined);

      if (replayAutoPlayId === recordingId) playReplayAudio(recordingId, audio);
    } catch (cause) {
      if (!disposed && generation === replayLoadGeneration) setReplayError(recordingId, cause);
    } finally {
      if (generation === replayLoadGeneration && replayLoadingId === recordingId) {
        replayLoadingId = undefined;
      }
      syncReplayButton();
    }
  };

  root.replaceChildren();
  // Older injected SDKs can lack the helper; keep their original frame fallback.
  const layout = typeof surfaceSdk.createSurfaceLayout === "function" ? surfaceSdk.createSurfaceLayout(root) : undefined;
  const frame = layout?.frame ?? el("div", "voice-page plugin-main-frame voice-main-frame");
  frame.classList.add("voice-page", "plugin-main-frame", "voice-main-frame");
  const shell = layout?.body ?? frame;
  if (layout) {
    shell.classList.add("voice-surface-body");
    Object.assign(shell.style, { display: "flex", flexDirection: "column", overflow: "hidden" });
  } else root.append(frame);

  /* B2-3 面包屑合同：每次页面变化都上报（去重同页重复 render），含挂载初始态。 */
  let lastReportedPage: Page | null | undefined;
  const reportNav = (refreshLabels = false) => {
    const current: Page | null = page === "history" ? null : page;
    if (!refreshLabels && lastReportedPage === current) return;
    lastReportedPage = current;
    try {
      actions.onNavigated(current);
    } catch {
      /* 上报失败不影响渲染。 */
    }
  };

  /** 离开列表页 / 详情页时收掉只属于这次停留的瞬态。 */
  const leaveListTransient = () => {
    openDigestDay = undefined;
    deleteAsk = undefined;
  };

  /* 旧 Host 降级出口（B5-14 只在新面包屑合同下撤钮）：与原返回钮同一套收口
     （回听音频停掉、聊天瞬态复位 → 回主列表）。新 Host 上不渲染。 */
  const legacyBackButton = (): HTMLButtonElement | null => {
    if (!options.legacyBack) return null;
    const back = el("button", "voice-legacy-back");
    back.type = "button";
    bindAttribute(back, "aria-label", () => t("view.backToVoice"));
    bindText(back, () => t("view.back"));
    back.addEventListener("click", () => {
      releaseReplayAudio();
      chatDetail.reset();
      leaveListTransient();
      page = "history";
      render();
    });
    return back;
  };

  interface ViewPositionSnapshot {
    page: Page;
    scrollTop: number;
    focusPath?: number[];
    selectionStart?: number | null;
    selectionEnd?: number | null;
  }

  let renderedPage: Page = "history";
  // Host 要求「打开会话并聚焦输入框」时，这一轮重渲染不恢复旧页面的滚动与焦点：
  // 否则同一 DOM 位置上的旧按钮会被选回来，盖掉对话页刚给输入框的焦点。
  let skipViewPositionRestoreOnce = false;

  const captureViewPosition = (): ViewPositionSnapshot | undefined => {
    const scroller = shell.querySelector<HTMLElement>(".main-body");
    if (!scroller) return undefined;
    const active = document.activeElement;
    const focusPath: number[] = [];
    if (active instanceof HTMLElement && scroller.contains(active)) {
      let node: Element | null = active;
      while (node && node !== scroller) {
        const parent: Element | null = node.parentElement;
        if (!parent) break;
        focusPath.unshift(Array.prototype.indexOf.call(parent.children, node));
        node = parent;
      }
    }
    const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active
      : undefined;
    return {
      page: renderedPage,
      scrollTop: scroller.scrollTop,
      ...(focusPath.length > 0 ? { focusPath } : {}),
      ...(input
        ? { selectionStart: input.selectionStart, selectionEnd: input.selectionEnd }
        : {}),
    };
  };

  const restoreViewPosition = (snapshot: ViewPositionSnapshot | undefined): void => {
    if (!snapshot || snapshot.page !== page) return;
    const scroller = shell.querySelector<HTMLElement>(".main-body");
    if (!scroller) return;
    scroller.scrollTop = snapshot.scrollTop;
    let target: Element = scroller;
    for (const index of snapshot.focusPath ?? []) {
      const next = target.children.item(index);
      if (!next) return;
      target = next;
    }
    if (target === scroller || !(target instanceof HTMLElement)) return;
    target.focus({ preventScroll: true });
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      && typeof snapshot.selectionStart === "number"
      && typeof snapshot.selectionEnd === "number"
    ) {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  };
  /* 命令详情（R8：按 Agent 对话界面做）整块在 voice-chat-detail.ts；这里只给它
     读状态 / 改选中项 / 触发重渲染的口。 */
  const chatDetail = createVoiceChatDetail({
    getState: () => state,
    getSelectedId: () => selectedId,
    setSelectedId: (id) => {
      selectedId = id;
    },
    isActive: () => page === "chat",
    render: () => render(),
    actions: {
      onOpenSourceLink: actions.onOpenSourceLink,
      onPrepareAttachments: actions.onPrepareAttachments,
      onUploadAttachment: actions.onUploadAttachment,
      onReleaseAttachment: actions.onReleaseAttachment,
      onSendCommandFollowUp: (text, conversation, attachments) => actions.onSendCommandFollowUp(text, conversation, attachments),
      onCancelCommand: actions.onCancelCommand,
      onRetryAgentRequest: actions.onRetryAgentRequest,
      onInstallBrowserWebAccessAndRetry: (item) => actions.onInstallBrowserWebAccessAndRetry
        ? actions.onInstallBrowserWebAccessAndRetry(item)
        : Promise.reject({ get userMessage() { return t("view.thisVersionCannotInstallTheBrowserPlugin"); } }),
      onDictateDraft: () => actions.onDictateDraft(),
      onDictationResultConsumed: (sessionId) => actions.onDictationResultConsumed(sessionId),
      onDictateCancel: () => actions.onDictateCancel(),
    },
    legacyBackButton,
    diagnostics: {
      block: (key, entry) => diagnosticsBlock(key, entry),
      error: (key, detail, extra) => errorDiagnostics(key, detail, extra),
      since: (key, knownStartMs) => waitSince(key, knownStartMs),
    },
    el,
    textEl,
  });

  let pendingConversation: { id: string; startedAt: number } | undefined;
  let navigationKey: string | undefined;
  let openingConversation = false;
  const render = () => {
    if (disposed) return;
    const nextNavigation = `${page}:${selectedId ?? ""}`;
    if (navigationKey !== undefined && nextNavigation !== navigationKey && !openingConversation) {
      pendingConversation = undefined;
      conversationOpenPending = false;
      actions.onConversationNavigation?.();
    }
    navigationKey = nextNavigation;
    // Host 轮询不能拆掉正在拖动的原生 range；只延后仍有效的同一详情。
    if (releaseReplaySeek) {
      const item = page === "detail" ? state.history.find((entry) => entry.id === selectedId)
        : page === "translation" ? state.commandHistory.find((entry) => entry.id === selectedId) : undefined;
      const sameReplay = page === "detail" || page === "translation"
        ? !!item && item.recordingId === replayPlayingId && isReplayAvailable(item, state.replayCache)
          && (page === "detail" || commandDetailPage(item as VoiceCommandHistoryItem) === "translation")
        : page === "context" && selectedId === replayPlayingId && state.recordings.some((entry) => entry.id === selectedId);
      if (sameReplay && !state.recognitionSetupRequired) {
        replayRenderPending = true;
        return;
      }
      releaseReplaySeek();
    }
    // 先打开的翻译还在跑/失败时走对话页；之后同一条成功落地，就换成一次性的翻译详情，
    // 否则对话页的输入框会把追问当成普通 Agent 命令发出去。
    if (page === "chat") {
      const current = state.commandHistory.find((entry) => entry.id === selectedId);
      if (current && commandDetailPage(current) === "translation") {
        chatDetail.reset();
        page = "translation";
      }
    }
    const position = skipViewPositionRestoreOnce ? undefined : captureViewPosition();
    skipViewPositionRestoreOnce = false;
    // 说明浮层挂在 document.body，不属于 shell；任何状态更新导致的重渲染都要
    // 先收掉旧浮层与全局监听器，避免触发按钮被替换后留下孤悬内容。
    activeHintClose?.();
    releaseLocaleBindings(shell);
    for (const detail of Array.from(shell.querySelectorAll<HTMLDetailsElement>("details[data-context-key]"))) {
      const key = detail.dataset.contextKey!;
      if (detail.open) openContextDetails.add(key); else openContextDetails.delete(key);
    }
    // 用户正在诊断区里手动选择（复制失败后的 <pre>）：重渲染后按同一诊断 key 选回。
    const diagnosticsSelection = captureDiagnosticsSelection(shell);
    shell.replaceChildren();
    if (state.recognitionSetupRequired && actions.onChooseRecognitionEngine) renderRecognitionSetup();
    else if (page === "settings") renderSettings();
    else if (page === "events") renderEvents();
    else if (page === "models") renderModels();
    else if (page === "detail") renderDetail();
    else if (page === "translation") renderTranslationDetail();
    else if (page === "chat") renderChat();
    else if (page === "context") renderContextDetail();
    else renderHistory();
    if ((page === "chat" || page === "translation") && state.error && state.errorDetail?.step === "conversationOpen") {
      const item = state.commandHistory.find(entry => entry.id === selectedId);
      const feedback = inlineErrorBlock("inline-error");
      feedback.classList.add("chat-send-error", "voice-conversation-open-error");
      if (item?.agentSessionId && actions.onOpenConversation) {
        const retry = textEl("button", "dev-btn", () => t("common.retry"));
        retry.type = "button";
        retry.addEventListener("click", () => {
          if (retry.disabled) return;
          retry.disabled = true;
          bindText(retry, () => t("common.loading"));
          void actions.onOpenConversation!(item.agentSessionId!).finally(() => {
            retry.disabled = false;
          });
        });
        feedback.append(retry);
      }
      const header = shell.querySelector(".main-body > header");
      if (header) header.after(feedback);
      else (shell.querySelector(".main-body") ?? shell).prepend(feedback);
    }
    renderedPage = page;
    // 先恢复媒体控件的可用态，避免向仍 disabled 的新 range 恢复焦点。
    syncReplayButton();
    restoreViewPosition(position);
    sweepVoiceDiagnostics(diagStore);
    for (const key of [...waitStarts.keys()]) if (!waitSeen.has(key)) waitStarts.delete(key);
    waitSeen.clear();
    restoreDiagnosticsSelection(shell, diagnosticsSelection);
    if (page === "settings") revealSettingsTarget();
    markOpenedCommandRead();
    reportNav();
  };

  const renderRecognitionSetup = () => {
    const body = el("main", "voice-recognition-setup");
    const heading = textEl("h1", "", () => t("setup.title"));
    const description = textEl("p", "", () => t("setup.description"));
    body.append(heading, description);
    for (const engine of ["local", "cloud"] as const) {
      const card = el("section", "voice-recognition-choice");
      card.append(textEl("h2", "", () => t(`setup.${engine}Title`)), textEl("p", "", () => t(`setup.${engine}Description`)));
      const button = textEl("button", "dev-btn p", () => t(state.recognitionSetupBusy ? "setup.saving" : `setup.${engine}Action`)) as HTMLButtonElement;
      button.disabled = !!state.recognitionSetupBusy;
      button.addEventListener("click", () => fire(() => actions.onChooseRecognitionEngine!(engine)));
      card.append(button);
      body.append(card);
    }
    if (state.recognitionSetupBusy) {
      body.append(diagnosticsBlock("setup:saving", {
        state: "waiting", step: () => t("diagnostics.step.recognitionSetup"), ...waitSince("setup:saving"),
      }));
    }
    if (state.recognitionSetupError) {
      const error = textEl("p", "voice-setup-error", () => state.recognitionSetupError!);
      error.setAttribute("role", "alert"); body.append(error);
      body.append(errorDiagnostics(`setup:${state.recognitionSetupErrorDetail?.at ?? ""}`, state.recognitionSetupErrorDetail));
    }
    shell.append(body);
  };

  /**
   * R9 未读点：命令详情一落地（不论从列表点进来还是输入坞续接切过来），这条就算
   * 看过了。只在仍未读时回调一次；app 层清旗后 state 刷新，视图不再重复发。
   */
  let markReadInFlight: string | undefined;
  const markOpenedCommandRead = () => {
    if (page !== "chat" && page !== "translation") return;
    const item = state.commandHistory.find((entry) => entry.id === selectedId);
    if (item?.agentSessionId && actions.onOpenConversation) return;
    if (!item?.unread || markReadInFlight === item.id) return;
    markReadInFlight = item.id;
    void actions.onMarkCommandRead(item.id).catch(() => undefined).finally(() => {
      if (markReadInFlight === item.id) markReadInFlight = undefined;
    });
  };

  const revealSettingsTarget = () => {
    if (!focusedSettingsTarget || settingsFocusRevealed) return;
    const focusTarget = focusedSettingsTarget;
    const target = shell.querySelector<HTMLElement>(
      `[data-settings-target="${focusTarget}"]`,
    );
    if (!target) return;
    // 滚动与 focus 只做一次；高亮状态继续保留，避免紧随其后的状态刷新重渲染
    // 把用户还没来得及看见的目标吃掉。
    settingsFocusRevealed = true;
    if (typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    target.focus({ preventScroll: true });
    armSettingsFocusDismissal();
  };

  const stopSettingsFocusListeners = () => {
    if (settingsFocusArmTimer !== undefined) {
      window.clearTimeout(settingsFocusArmTimer);
      settingsFocusArmTimer = undefined;
    }
    stopSettingsFocusDismissal?.();
    stopSettingsFocusDismissal = undefined;
  };

  const dismissSettingsFocus = () => {
    stopSettingsFocusListeners();
    focusedSettingsTarget = undefined;
    settingsFocusRevealed = false;
    shell.querySelectorAll(".settings-target-flash").forEach((element) => {
      element.classList.remove("settings-target-flash");
    });
  };

  const armSettingsFocusDismissal = () => {
    stopSettingsFocusListeners();
    // 前五秒强制展示；之后才监听真实操作。DOM 重建自动产生的 mouseover 不算，
    // 否则 WebView 刚换页就会自己把高亮清掉，看起来仍是一闪而过。
    settingsFocusArmTimer = window.setTimeout(() => {
      settingsFocusArmTimer = undefined;
      const eventTypes = [
        "pointermove",
        "pointerdown",
        "click",
        "keydown",
        "wheel",
      ] as const;
      const onUserAction = () => dismissSettingsFocus();
      for (const eventType of eventTypes) {
        document.addEventListener(eventType, onUserAction, true);
      }
      stopSettingsFocusDismissal = () => {
        for (const eventType of eventTypes) {
          document.removeEventListener(eventType, onUserAction, true);
        }
      };
    }, 5_000);
  };

  const openSettings = (target?: VoiceSettingsTarget) => {
    // 与返回列表、换一条同处理：详情页一走开就把声音收掉，否则用户会在设置页里
    // 听见一段找不到来源的录音，只能等它自己播完。
    releaseReplayAudio();
    chatDetail.reset();
    leaveListTransient();
    dismissSettingsFocus();
    focusedSettingsTarget = target;
    settingsFocusRevealed = false;
    page = target === "commands" ? "events" : target === "model" ? "models" : "settings";
    render();
    void actions.onRefresh();
  };

  const renderHistory = () => {
    const body = el("main", "main-body voice-main-body");
    const view = el("div", "voice-list-view task-list-view");
    const header = el("header", "task-header");
    // R14：页头行 = 标题块在左 + 状态胶囊贴右、在整块里垂直居中（稿 .voice-overview-row）。
    const overviewRow = el("div", "voice-overview-row");
    const group = el("div", "voice-overview");
    group.append(
      textEl("div", "voice-overview-title", () => t("view.voiceHistory")),
      textEl("div", "voice-overview-copy", () => t("view.yourSpeechIsHereDictationCommandsAnd")),
    );
    overviewRow.append(group, voiceCapsule());

    const tabs = el("div", "task-tabs");
    tabs.setAttribute("role", "tablist");
    bindAttribute(tabs, "aria-label", () => t("view.voiceHistoryType"));
    for (const tab of VOICE_TABS) {
      const button = textEl(
        "button",
        tab.id === selectedTab ? "task-tab active" : "task-tab",
        () => tab.label,
      );
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab.id === selectedTab));
      button.dataset.voiceTab = tab.id;
      button.addEventListener("click", () => {
        if (selectedTab === tab.id) return;
        selectedTab = tab.id;
        // R18：总结行的展开态不跨档——切档就回到收起。
        openDigestDay = undefined;
        render();
      });
      tabs.append(button);
    }

    header.append(overviewRow, tabs);
    view.append(header);

    if (mountedNotice) {
      const notice = textEl(
        "div",
        "inline-notice voice-source-migration-notice",
        () => mountedNotice === SOURCE_MIGRATION_NOTICE ? sourceMigrationNoticeText() : mountedNotice,
      );
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      notice.setAttribute("aria-atomic", "true");
      view.append(notice);
      pendingNoticeElement = notice;
      reportNoticeWhenVisible();
    }

    // §6.0：页头有真实等待时，下方一行说清在做什么、已用多久、两端版本与诊断入口。
    const activity = activityRow();
    if (activity) view.append(activity);
    // R2：缺配置 ≠ 状态——留在档内做琥珀提醒，不进胶囊。
    for (const warn of voiceWarnRows()) view.append(warn);
    // 动作失败（发给 agent / 重新总结 / 删段）的原地反馈：列表页没有别的落点。
    if (state.error) view.append(inlineErrorBlock("inline-error"));

    if (selectedTab === "all") {
      // A3-11：稿子判据 `curFilter==='all'&&ctxSegs.length>0` —— 今天一段都没存
      // 就整条不渲染，而不是挂一条「还录了 0 段」让人点进去看空页。
      const entry = contextPreview();
      if (entry) view.append(entry);
    }
    if (selectedTab === "context") view.append(contextTimeline());
    else view.append(taskHistory(selectedTab));
    body.append(view);
    shell.append(body);
  };

  type CapsuleAction = { ariaLabel: string; run: () => void };

  /**
   * 页头当前的真实等待（§6.0 ①）：步骤来自状态，key 带会话 / 模型等身份。
   * 胶囊与下方活动行共用同一个起点。
   */
  interface VoiceActivity { key: string; step: TextSource; seg: "mic" | "ctx" }
  const currentActivity = (): VoiceActivity | undefined => {
    if (state.statusLoad === "loading") return { key: "status-load", step: () => t("view.checking"), seg: "mic" };
    if (state.phase === "listening" || state.commandPhase === "listening") {
      return { key: `recording:${state.sessionId ?? ""}`, step: () => t("view.recording"), seg: "mic" };
    }
    if (state.commandPhase === "preparing") return { key: "preparing", step: () => t("view.preparingVoice"), seg: "mic" };
    // 胶囊叠放：录音槽空着、上一段还在后台收尾时，页头同样显示识别中。
    if (state.phase === "recognizing" || state.commandPhase === "recognizing" || (state.finalizingCount ?? 0) > 0) {
      return { key: `recognizing:${state.sessionId ?? ""}`, step: () => t("view.recognizing"), seg: "mic" };
    }
    if (state.commandPhase === "processing") {
      return { key: `processing:${state.sessionId ?? ""}`, step: () => t("diagnostics.step.processing"), seg: "mic" };
    }
    if (state.settings.engine === "cloud" && state.commandLoggedIn && state.cloudModelsLoading) {
      return { key: "cloud-models", step: () => t("view.cloudModelsLoading"), seg: "mic" };
    }
    const model = selectedModel(state);
    if (state.settings.engine !== "cloud" && model?.state === "downloading") {
      return { key: `download:${model.id}`, step: () => t("diagnostics.step.modelDownload", { name: diagnosticModelName(model.id) }), seg: "mic" };
    }
    const timeline = state.timeline;
    if (timeline?.state === "unavailable" && timeline.unavailableReason === "route_reconciling"
      && (timelineStartingAt === undefined || Date.now() - timelineStartingAt < 15000)) {
      return { key: "timeline-starting", step: () => t("setup.timelineStarting"), seg: "ctx" };
    }
    return undefined;
  };
  /** 活动的起点：模型下载用插件记下的操作时刻，其余用本页首次看到的时刻（如实标注口径）。 */
  const activitySince = (activity: VoiceActivity) => {
    const model = selectedModel(state);
    const known = activity.key.startsWith("download:") && model ? state.localDownloads?.[model.id]?.sinceMs : undefined;
    return waitSince(`activity:${activity.key}`, known);
  };
  /**
   * 活动行默认安静：只显示步骤与已用时间，版本与诊断入口等到慢阈值（10 秒）
   * 才由 CSS 显出来（正常几秒内完成的等待不该顶着一块诊断信息，2026-09-30 用户反馈）。
   * 「录音中」不是卡住的等待——录半分钟很正常——不设慢阈值，永不弹诊断入口；
   * 失败态不走这里，版本与真实原因仍从第一帧可见（§6.0 底线不破）。
   */
  const activityRow = (): HTMLElement | undefined => {
    const activity = currentActivity();
    if (!activity) return undefined;
    const since = activitySince(activity);
    const recording = activity.key.startsWith("recording:");
    const block = diagnosticsBlock(`activity:${activity.key}`, {
      state: "waiting",
      step: activity.step,
      ...since,
      details: [
        { label: () => t("diagnostics.detail.phase"), tokens: () => [state.phase, state.commandPhase] },
        { label: () => t("diagnostics.detail.source"), value: sourceLabel, tokens: () => [state.settings.source] },
      ],
    }, { slowAfterMs: recording ? undefined : 10_000, quiet: true, className: "voice-activity" });
    block.setAttribute("role", "status");
    return block;
  };
  /** 胶囊等待段追加「· 已用 N 秒」。 */
  const withActivityElapsed = (segment: HTMLElement, seg: "mic" | "ctx"): HTMLElement => {
    const activity = currentActivity();
    if (activity?.seg === seg) segment.append(elapsedNode(activitySince(activity), undefined, true));
    return segment;
  };

  /* ── 页头状态胶囊 ──
     正常/过渡态是纯状态 span；只有异常态才是 button，并且每个按钮只去能解决这件事
     的精确落点。首次加载与读取失败收成单段，避免空占位先冒充两条故障。 */
  const voiceCapsule = (): HTMLElement => {
    const cap = el("div", "voice-cap");
    bindAttribute(cap, "aria-label", () => t("view.voiceStatus"));
    // 异常态会包含真实 button，不能用 role=status（其后代会被部分辅助技术
    // 当成纯文本状态）。保留温和 live announcement，同时让按钮语义原样暴露。
    cap.setAttribute("aria-live", "polite");
    cap.setAttribute("aria-atomic", "true");
    if (state.statusLoad === "loading") {
      cap.append(withActivityElapsed(capSegment("", activityIcon(), () => t("view.checking"), "status"), "mic"));
      return cap;
    }
    if (state.statusLoad === "failed") {
      cap.append(capSegment("off", alertIcon(), () => t("view.couldNotReadStatus"), "status", {
        get ariaLabel() { return t("view.couldNotReadVoiceStatusCheckAgain"); },
        run: () => fire(() => actions.onRefresh()),
      }));
      return cap;
    }
    if (keyboardOff(state)) {
      cap.append(capSegment("off", micOffIcon(), () => t("view.keyboardDisconnected"), "kb", {
        get ariaLabel() { return t("view.keyboardDisconnectedOpenRecordingSettingsToUse"); },
        run: () => openSettings("source"),
      }));
      return cap;
    }
    cap.append(capMicSegment(), el("span", "voice-cap-sep"), capContextSegment());
    return cap;
  };

  const capSegment = (
    modifier: "" | "rec" | "off",
    lead: string | HTMLElement,
    label: TextSource,
    seg: "mic" | "ctx" | "kb" | "status",
    action?: CapsuleAction,
  ): HTMLElement => {
    const className = modifier ? `voice-cap-seg ${modifier}` : "voice-cap-seg";
    const node: HTMLElement = action
      ? el("button", `${className} voice-cap-action`)
      : el("span", className);
    node.dataset.capSeg = seg;
    if (action) {
      const button = node as HTMLButtonElement;
      button.type = "button";
      bindAttribute(button, "aria-label", () => action.ariaLabel);
      button.addEventListener("click", action.run);
    }
    if (typeof lead === "string") {
      const icon = el("span", "voice-cap-icon");
      icon.innerHTML = lead;
      icon.setAttribute("aria-hidden", "true");
      node.append(icon);
    } else {
      node.append(lead);
    }
    node.append(localizedTextNode(() => label));
    return node;
  };

  /** 麦克风段：先报当前动作，再按“能由用户解决”的优先级给唯一异常与去路。 */
  const capMicSegment = (): HTMLElement => {
    const listening = state.phase === "listening" || state.commandPhase === "listening";
    if (listening) {
      const dot = el("span", "voice-cap-dot");
      dot.setAttribute("aria-hidden", "true");
      return withActivityElapsed(capSegment("rec", dot, () => t("view.recording"), "mic"), "mic");
    }
    if (state.commandPhase === "preparing") {
      // 按键已受理、启动准备中（3 秒窗口内）：给出瞬时视觉反馈，别让用户面对
      // 一颗“没反应”的键（链③）。录音浮层出现后自然替换。
      return withActivityElapsed(capSegment("", activityIcon(), () => t("view.preparingVoice"), "mic"), "mic");
    }
    const busy = state.phase === "recognizing"
      || state.commandPhase === "recognizing"
      || state.commandPhase === "processing"
      || (state.finalizingCount ?? 0) > 0;
    if (busy) {
      return withActivityElapsed(capSegment("", activityIcon(), () => t("view.recognizing"), "mic"), "mic");
    }
    if (state.sourceIssue === "firmware_unknown") {
      return capSegment("", activityIcon(), () => t("view.checkFirmware"), "mic");
    }
    if (state.sourceIssue === "firmware_too_old") {
      return capSegment("off", micOffIcon(), () => t("view.firmwareUpdateRequired"), "mic", {
        get ariaLabel() { return t("view.aiBoardFirmwareNeedsAnUpdateOpen"); },
        run: () => fire(() => actions.onOpenSystemTask()),
      });
    }
    if (state.settings.source === "system" && state.permissions.microphone !== "granted") {
      return capSegment("off", micOffIcon(), () => t("view.microphonePermissionMissing"), "mic", {
        get ariaLabel() { return t("view.systemMicrophonePermissionIsMissingOpenPrivacy"); },
        run: () => fire(() => actions.onOpenPermissionSettings?.() ?? Promise.resolve()),
      });
    }
    if (!isSourceReady(state)) {
      return capSegment("off", micOffIcon(), () => t("view.microphoneUnavailable"), "mic", {
        get ariaLabel() { return t("view.microphoneUnavailableOpenRecordingSourceAndInput"); },
        run: () => openSettings("source"),
      });
    }
    if (state.permissions.accessibility !== "granted") {
      return capSegment("off", micOffIcon(), () => t("view.permissionsMissing"), "mic", {
        get ariaLabel() { return t("view.voiceNeedsSystemPermissionsToInsertText"); },
        run: () => fire(() => actions.onOpenPermissionSettings?.() ?? Promise.resolve()),
      });
    }
    if (state.deliveryPermissionBlocked) {
      return capSegment("off", micOffIcon(), () => t("view.voiceInsertionPermissionMissing"), "mic", {
        get ariaLabel() { return t("view.voiceCannotInsertTextIntoTheCurrent"); },
        run: () => fire(() => actions.onOpenAppPermissions?.() ?? Promise.resolve()),
      });
    }
    if (state.settings.engine === "cloud") {
      if (state.commandLoggedIn && state.cloudModelsLoading) {
        return withActivityElapsed(capSegment("", activityIcon(), () => t("view.cloudModelsLoading"), "mic"), "mic");
      }
      if (state.commandLoggedIn && !selectedCloudOption(state.cloudModels, state.featureSettings.cloudModelId)) {
        return capSegment("off", micOffIcon(), () => state.cloudModelsUnavailable
          ? t("view.cloudOptionsUnavailable") : t("view.cloudOptionRequired"), "mic", {
          get ariaLabel() { return t("view.chooseACloudModel"); },
          run: () => openSettings("engine"),
        });
      }
      return state.commandLoggedIn
        ? capSegment("", micIcon(), () => t("view.cloudReady"), "mic")
        : capSegment("off", micOffIcon(), () => t("view.signInRequired"), "mic", {
          get ariaLabel() { return t("view.cloudRecognitionRequiresSignInOpenYour"); },
          run: () => fire(() => actions.onOpenAccountLogin?.() ?? Promise.resolve()),
        });
    }
    const model = selectedModel(state);
    if (model?.state === "downloading") {
      return withActivityElapsed(capSegment("", activityIcon(), () => t("view.downloadingModel"), "mic"), "mic");
    }
    if (model?.state === "failed") {
      return capSegment("off", micOffIcon(), () => t("view.modelDownloadFailed"), "mic", {
        get ariaLabel() { return t("view.localVoiceModelDownloadFailedOpenModel"); },
        run: () => openSettings("model"),
      });
    }
    if (!isModelReady(model)) {
      return capSegment("off", micOffIcon(), () => t("view.modelNotConfigured"), "mic", {
        get ariaLabel() { return t("view.localVoiceModelIsNotConfiguredOpen"); },
        run: () => openSettings("model"),
      });
    }
    return capSegment("", micIcon(), () => t("view.localReady"), "mic");
  };

  /** Context 段：正常 running 只陈述；关闭与异常都回 Voice 自己的录音缓存设置。 */
  let timelineStartingAt: number | undefined;
  let timelineStartingTimer: ReturnType<typeof setTimeout> | undefined;
  const capContextSegment = (): HTMLElement => {
    const timeline = state.timeline;
    const starting = timeline?.state === "unavailable" && timeline.unavailableReason === "route_reconciling";
    if (!starting) {
      timelineStartingAt = undefined;
      if (timelineStartingTimer !== undefined) clearTimeout(timelineStartingTimer);
      timelineStartingTimer = undefined;
    }
    else {
      timelineStartingAt ??= Date.now();
      // This is an explicit Host transition, not an assumption that every
      // unavailable route is healthy. A stuck transition becomes a real error.
      if (Date.now() - timelineStartingAt < 15000) {
        if (timelineStartingTimer === undefined) {
          timelineStartingTimer = setTimeout(() => {
            timelineStartingTimer = undefined;
            if (!disposed) render();
          }, 15000 - (Date.now() - timelineStartingAt));
        }
        return withActivityElapsed(capSegment("", activityIcon(), () => t("setup.timelineStarting"), "ctx"), "ctx");
      }
    }
    if (!timeline) {
      return capSegment("off", micOffIcon(), () => t("view.timelineUnavailable"), "ctx", {
        get ariaLabel() { return t("view.audioTimelineIsUnavailableOpenRecordingRetention"); },
        run: () => openSettings("replay-cache"),
      });
    }
    if (!timeline.continuousRecordingEnabled) {
      const node = capSegment("off", micOffIcon(), () => t("view.off"), "ctx", {
        get ariaLabel() { return t("view.allDayRecordingIsOffOpenRecording"); },
        run: () => openSettings("replay-cache"),
      });
      bindAttribute(node, "title", () => t("view.allDayRecordingIsDisabledInSettings"));
      return node;
    }
    if (timeline.cacheHealth === "degraded" || timeline.recordingState === "degraded") {
      return capSegment("off", micOffIcon(), () => t("view.recordingArchiveError"), "ctx", {
        get ariaLabel() { return t("view.allDayRecordingCouldNotBeSaved"); },
        run: () => openSettings("replay-cache"),
      });
    }
    if (timeline.state === "running") {
      // H02:C04 状态胶囊即暂停入口：与 off 段「状态+动作」同一构造，
      // 点击暂停 Host 常驻时间线，回推由 app 层 publish 完成。
      const node = capSegment("", listenBars(), () => t("view.listening"), "ctx", {
        get ariaLabel() { return t("view.pauseAllDayRecording"); },
        run: () => fire(() => actions.onTimelinePaused(true)),
      });
      bindAttribute(node, "title", () => t("view.pauseAllDayRecording"));
      return node;
    }
    if (timeline.state === "paused_by_user") {
      const node = capSegment("off", micOffIcon(), () => t("view.paused"), "ctx", {
        get ariaLabel() { return t("view.resumeAllDayRecording"); },
        run: () => fire(() => actions.onTimelinePaused(false)),
      });
      bindAttribute(node, "title", () => t("view.resumeAllDayRecording"));
      return node;
    }
    const label = () => timeline.state === "disabled_by_safety_switch"
        ? t("view.disabledForSafety")
        : t("view.timelineUnavailable");
    return capSegment("off", micOffIcon(), () => label(), "ctx", {
      get ariaLabel() { return t("view.valueOpenRecordingRetentionSettings", { value0: label() }); },
      run: () => openSettings("replay-cache"),
    });
  };

  /* ── R2：档内缺配置提醒 ──
     「工作流还没填」「模型没下载」「固件太旧」是差一步配置，不是状态：一行琥珀软底，
     右侧一个去路。只在对应档出现（模型 → Input / All，命令 → Command，固件 → 四档）。 */
  const sourceLabel = () => state.settings.source === "system" ? t("diagnostics.sourceSystem") : t("diagnostics.sourceBoard");
  /** 音源诊断：码是 Host 报告的 sourceIssue 原值；没有就如实写「Host 未提供错误码」。 */
  const sourceDiagnostics = (key: string) => diagnosticsBlock(key, {
    state: "failed",
    step: () => t("diagnostics.step.source"),
    ...(state.sourceIssue ? { code: state.sourceIssue } : {}),
    rawNote: "hostNotProvided",
    details: [
      { label: () => t("diagnostics.detail.source"), value: sourceLabel, tokens: () => [state.settings.source] },
      { label: () => t("diagnostics.detail.sourceReady"), tokens: () => [state.sourceReady === undefined ? undefined : String(state.sourceReady)] },
      { label: () => t("diagnostics.detail.firmware"), tokens: () => [state.boardFirmwareVersion, state.minimumBoardFirmwareVersion] },
    ],
  });
  /** 本地模型下载失败：插件下载协调器保留的结构化字段优先，其次 Host 的 model.error（原文只供展开）。 */
  const modelFailureDiagnostics = (key: string, model: VoiceModelInfo) => {
    const local = state.localDownloads?.[model.id];
    const fields = local?.fields ?? (model.error ? collectErrorFields(model.error) : undefined);
    return diagnosticsBlock(key, {
      state: "failed",
      step: () => t("diagnostics.step.modelDownload", { name: diagnosticModelName(model.id) }),
      ...(fields?.code ? { code: fields.code } : {}),
      ...(fields?.upstreamCodes.length ? { upstreamCodes: fields.upstreamCodes } : {}),
      ...(fields?.source ? { source: fields.source } : {}),
      ...(fields?.httpStatus !== undefined ? { httpStatus: fields.httpStatus } : {}),
      ...(fields?.raw ? { raw: fields.raw, rawLength: fields.rawLength } : {}),
      rawNote: "hostNotProvided",
      ...(isValidTimeMs(local?.failedAtMs) ? { at: new Date(local!.failedAtMs!).toISOString() } : {}),
      ...(isValidTimeMs(local?.sinceMs) && isValidTimeMs(local?.failedAtMs) ? { sinceMs: local!.sinceMs!, endMs: local!.failedAtMs! } : {}),
      details: [
        { label: () => t("diagnostics.detail.model"), tokens: () => [diagnosticModelToken(model.id, "local"), model.state] },
        { label: () => t("diagnostics.detail.progress"), tokens: () => [model.downloadedBytes ?? 0, model.sizeBytes] },
      ],
    });
  };
  /** 全天录音的真实异常（关着不算异常；连接中 15 秒内算等待，超过才算异常）。 */
  const timelineFailureLabel = (): string | undefined => {
    const timeline = state.timeline;
    // 只对 Host 真实报告的时间线状态出 warn 行；读不到时间线（旧 Host）时胶囊已如实显示，不再叠一行。
    if (state.statusLoad !== "loaded" || !timeline) return undefined;
    if (timeline.cacheHealth === "degraded" || timeline.recordingState === "degraded") return t("view.recordingArchiveError");
    if (!timeline.continuousRecordingEnabled) return undefined;
    if (timeline.state === "disabled_by_safety_switch") return t("view.disabledForSafety");
    if (timeline.state === "unavailable") {
      const starting = timeline.unavailableReason === "route_reconciling";
      if (starting && (timelineStartingAt === undefined || Date.now() - timelineStartingAt < 15000)) return undefined;
      return t("view.timelineUnavailable");
    }
    return undefined;
  };
  const timelineDiagnostics = () => {
    const timeline = state.timeline;
    return diagnosticsBlock(`warn:timeline:${timeline?.state ?? "none"}:${timeline?.unavailableReason ?? ""}`, {
      state: timeline?.unavailableReason === "route_reconciling" ? "timeout" : "failed",
      step: () => t("diagnostics.step.timeline"),
      ...(timeline?.unavailableReason ? { code: timeline.unavailableReason } : {}),
      rawNote: "hostNotProvided",
      ...(timeline?.unavailableReason === "route_reconciling" && timelineStartingAt !== undefined
        ? { sinceMs: timelineStartingAt, sinceObserved: true } : {}),
      details: [
        { label: () => t("diagnostics.detail.timelineState"), tokens: () => [timeline?.state] },
        { label: () => t("diagnostics.detail.route"), tokens: () => [timeline?.route] },
        { label: () => t("diagnostics.detail.cacheHealth"), tokens: () => [timeline?.cacheHealth] },
        { label: () => t("diagnostics.detail.recordingState"), tokens: () => [timeline?.recordingState] },
        { label: () => t("diagnostics.detail.backlog"), tokens: () => [timeline?.sttBacklog] },
      ],
    });
  };

  /** 重新登录后插件授权仍未恢复，且自动重试已停：需要用户去连接一次云服务。 */
  const cloudNeedsReconnect = () => state.cloudModelsFailureCode === "PLUGIN_OAUTH_REAUTH_REQUIRED" && state.cloudModelsRetryExhausted === true;
  /** 普通模式下云端选项读不到时的人话：区分自动重试中、已停、需要重新连接。 */
  const cloudUnavailableHint = () => cloudNeedsReconnect() ? t("view.cloudReconnectHint")
    : state.cloudModelsRetryExhausted ? t("view.cloudRetryStoppedHint") : t("view.cloudRetryingHint");
  const voiceWarnRows = (): HTMLElement[] => {
    const rows: HTMLElement[] = [];
    if (state.statusLoad === "loading") return rows;
    if (state.statusLoad === "failed") {
      rows.push(warnRow(
        () => t("view.couldNotReadStatus"),
        () => state.statusLoadError ?? t("view.voiceStatusIsTemporarilyUnavailable"),
        () => t("view.checkAgain"),
        () => fire(() => actions.onRefresh()),
        "refresh",
        errorDiagnostics(`warn:status:${state.statusLoadErrorDetail?.at ?? ""}`, state.statusLoadErrorDetail),
      ));
      return rows;
    }
    const model = selectedModel(state);
    if (keyboardOff(state)) {
      rows.push(warnRow(
        () => t("view.keyboardDisconnected"),
        () => state.developerMode
          ? t("diagnostics.sourceReason", { source: sourceLabel(), issue: state.sourceIssue ?? t("diagnostics.hostNoCode") })
          : t("view.keyboardDisconnectedHint"),
        () => t("view.openSettings"),
        () => openSettings("source"),
        "keyboard",
        sourceDiagnostics("warn:keyboard"),
      ));
    }
    const timelineFailure = timelineFailureLabel();
    if (timelineFailure && !keyboardOff(state)) {
      rows.push(warnRow(
        () => t("diagnostics.timelineTitle"),
        () => timelineFailure,
        () => t("view.openSettings"),
        () => openSettings("replay-cache"),
        "timeline",
        timelineDiagnostics(),
      ));
    }
    if (state.settings.engine === "cloud" && state.commandLoggedIn && !state.cloudModelsLoading
      && state.cloudModelsUnavailable && !selectedCloudOption(state.cloudModels, state.featureSettings.cloudModelId)) {
      const reconnect = cloudNeedsReconnect() && !!actions.onOpenAppPermissions;
      rows.push(warnRow(
        () => t("view.cloudOptionsUnavailable"),
        () => state.developerMode ? t("diagnostics.cloudModelsReason") : cloudUnavailableHint(),
        () => state.developerMode ? t("view.openSettings") : reconnect ? t("view.reconnectCloud") : t("view.retryNow"),
        () => state.developerMode ? openSettings("engine")
          : reconnect ? fire(() => actions.onOpenAppPermissions!()) : fire(() => actions.onRefresh()),
        "cloud-models",
        errorDiagnostics(`warn:cloud-models:${state.cloudModelsErrorDetail?.at ?? ""}`, state.cloudModelsErrorDetail),
      ));
    }
    if (state.sourceIssue === "firmware_too_old") {
      const minimum = state.minimumBoardFirmwareVersion ?? "1.50";
      rows.push(warnRow(
        () => t("view.aiBoardFirmwareNeedsAnUpdate"),
        () => t("view.currentValueVoiceRequiresValue", { value0: state.boardFirmwareVersion ?? t("view.fallback0"), value1: minimum }),
        () => t("view.update"),
        () => fire(() => actions.onOpenSystemTask()),
        "firmware",
        sourceDiagnostics("warn:firmware"),
      ));
    }
    if (
      isSourceReady(state) === false
      && state.sourceIssue !== "firmware_too_old"
      && !keyboardOff(state)
    ) {
      // 音源不可用但不是「固件太旧」也不是「键盘断了」：系统麦克风选错 / 被拔、
      // Board 固件还在检查。胶囊只会写「未就绪」，原因在这里说。
      if (state.settings.source === "system") {
        rows.push(warnRow(
          () => t("view.systemMicrophoneUnavailable"),
          () => t("view.checkYourAudioDeviceOrChooseAnother"),
          () => t("view.openSettings"),
          () => openSettings("source"),
          "source",
          sourceDiagnostics("warn:source:system"),
        ));
      } else if (state.sourceIssue === "firmware_unknown") {
        // 过渡态只留在胶囊里，不把正常检查过程画成橙色警告。
      } else {
        rows.push(warnRow(
          () => t("view.aiBoardIsTemporarilyUnavailable"),
          // 开发者模式说真实原因（当前音源 + Host 报告的状态）；普通模式只给人话与下一步。
          () => state.developerMode
            ? t("diagnostics.sourceReason", { source: sourceLabel(), issue: state.sourceIssue ?? t("diagnostics.hostNoCode") })
            : t("view.aiBoardUnavailableHint"),
          () => t("view.openSettings"),
          () => openSettings("source"),
          "source",
          sourceDiagnostics("warn:source:board"),
        ));
      }
    }
    if (
      state.settings.engine === "local"
      && (selectedTab === "all" || selectedTab === "input")
      && !isModelReady(model)
    ) {
      if (!model) {
        rows.push(warnRow(
          () => t("view.voiceInputNeedsOneMoreSetupStep"),
          () => t("view.aLocalVoiceModelIsNotConfigured"),
          () => t("view.openSettings"),
          () => openSettings("model"),
          "model",
        ));
      } else if (model.state === "downloading") {
        // 下载是用户已在解决的过渡态，胶囊中性显示进度，不再画成警告。
      } else if (model.state === "failed") {
        rows.push(warnRow(
          () => t("view.localVoiceModelDownloadFailed"),
          () => (state.developerMode ? model.error : undefined) ?? t("view.voiceInputCannotRecognizeYourSpeechRight"),
          () => t("view.openSettings"),
          () => openSettings("model"),
          "model",
          modelFailureDiagnostics(`warn:model:${model.id}`, model),
        ));
      } else {
        rows.push(warnRow(
          () => t("view.voiceInputNeedsOneMoreSetupStep"),
          () => t("view.theLocalVoiceModelHasNotBeen"),
          () => t("view.openSettings"),
          () => openSettings("model"),
          "model",
        ));
      }
    }
    if (selectedTab === "command") {
      if (!state.commandLoggedIn) {
        rows.push(warnRow(
          () => t("view.signInToUseVoiceCommands"),
          () => t("view.commandsThatRequireAccountAccessCanRun"),
          () => actions.onOpenAccountLogin ? t("view.signIn") : undefined,
          actions.onOpenAccountLogin
            ? () => fire(() => actions.onOpenAccountLogin!())
            : undefined,
          "command",
        ));
      }
    }
    // Continuous transcription always stays local. Choosing cloud dictation
    // does not authorize uploading all-day recordings or silently downloading
    // its local model. Use the design's in-tab missing-configuration row.
    // 本地引擎用同一行（同判定、同组件、同去路）：All / Input 档已有「本地语音模型还没下载」，
    // Context 档此前只剩一串「等待本地转写」却不说原因（§6.0）。判定只看设置里的识别引擎与
    // 这个本地模型的状态；本地引擎只在 Context 档出，免得 All 档与语音输入那一行重复说模型。
    const timelineModel = state.models.find(item => item.id === DEFAULT_MODEL_ID);
    const cloudEngine = state.settings.engine === "cloud";
    if ((selectedTab === "context" || (cloudEngine && selectedTab === "all"))
      && state.timeline?.continuousRecordingEnabled
      && !isModelReady(timelineModel)) {
      const failedModel = !cloudEngine && timelineModel?.state === "failed" ? timelineModel : undefined;
      rows.push(warnRow(
        () => t("setup.timelineModelTitle"),
        () => cloudEngine
          ? t(timelineModel?.state === "downloading" ? "setup.timelineModelDownloading" : "setup.timelineModelDetail")
          : localTimelineModelDetail(timelineModel),
        () => t("view.openSettings"),
        () => openSettings("model"),
        "timeline-model",
        failedModel ? modelFailureDiagnostics(`warn:timeline-model:${failedModel.id}`, failedModel) : undefined,
      ));
    }
    if (
      selectedTab === "context"
      && state.timeline
      && !state.timeline.continuousRecordingEnabled
    ) {
      rows.push(warnRow(
        () => t("view.allDayRecordingIsOff"),
        () => t("view.contextWillNotAddRecordingsAndFeatures"),
        () => t("view.openSettings"),
        () => openSettings("replay-cache"),
        "context",
      ));
    }
    return rows;
  };

  /**
   * 本地引擎下全天记录那一行的正文（§6.0）：对象与状态（全天录音照常保存、暂时转不成文字，
   * 能数的给待转写段数与时长）→ 真实原因（模型没下载 / 下载中 / 下载失败）→ 下载后接着转写。
   * 段数只数已加载的列表：列表没拿全就只说「至少」几段，不编总时长。
   * 合计时长用诊断的时长写法（「25 分 0 秒」「8 小时 5 分」/「25m 0s」「8h 5m」）：可能是一整天，
   * 不写成「485 分钟」，英文也不出现段详情那种「Minutes: 25」「900 ms」的统计读法。
   */
  const localTimelineModelDetail = (model: VoiceModelInfo | undefined): string => {
    const pending = state.recordings.filter((item) => item.transcriptStatus === "pending");
    const durationMs = pending.reduce(
      (sum, item) => sum + (Number.isFinite(item.durationMs) && item.durationMs > 0 ? item.durationMs : 0),
      0,
    );
    const summary = pending.length === 0 ? ""
      : state.recordings.length < state.recordingsTotal
        ? t("setup.timelinePendingAtLeast", { count: pending.length })
        : durationMs > 0
          ? t("setup.timelinePendingCountDuration", { count: pending.length, duration: durationText(durationMs) })
          : t("setup.timelinePendingCount", { count: pending.length });
    const key = model?.state === "downloading" ? "setup.timelineModelLocalDownloading"
      : model?.state === "failed" ? "setup.timelineModelLocalFailed"
        : "setup.timelineModelLocalDetail";
    return t(key, { pending: summary });
  };

  const warnRow = (
    title: TextSource,
    detail: TextSource,
    go: TextSource,
    onGo: (() => void) | undefined,
    kind: string,
    diagnostics?: HTMLElement,
  ): HTMLElement => {
    const row = el("div", "voice-warn");
    row.dataset.warn = kind;
    row.setAttribute("role", "status");
    const icon = el("span", "voice-warn-icon");
    icon.innerHTML = alertIcon();
    icon.setAttribute("aria-hidden", "true");
    const copy = el("span", "voice-warn-copy");
    copy.append(textEl("b", "", () => title), localizedTextNode(() => ` — ${readText(detail)}`));
    row.append(icon, copy);
    if (readText(go) && onGo) {
      const button = textEl("button", "voice-warn-go", () => go);
      button.type = "button";
      button.addEventListener("click", onGo);
      row.append(button);
    }
    if (diagnostics) row.append(diagnostics);
    return row;
  };

  /* ── R18：All / Input / Command 档按天分组（吸顶标题形态与 Context 一致，没有总结行）。 ── */
  const taskHistory = (tab: Exclude<VoiceTab, "context">): HTMLElement => {
    const list = el("div", "task-list");
    const entries = [
      ...(tab !== "command"
        ? state.history.map((item) => ({
            at: new Date(item.createdAt).getTime(),
            row: () => historyRow(item),
          }))
        : []),
      ...(tab !== "input"
        ? state.commandHistory.map((item) => ({
            at: new Date(item.createdAt).getTime(),
            row: () => commandHistoryRow(item),
          }))
        : []),
    ].sort((a, b) => b.at - a.at);
    if (entries.length === 0) {
      list.append(tab === "command" ? commandEmptyState() : inputEmptyState());
      return list;
    }
    const todayKey = dayKeyOf(new Date());
    for (const group of groupByDay(entries, (entry) => dayKeyOf(new Date(entry.at)))) {
      list.append(dayHead(group.dayKey, todayKey, () => t("view.entriesValue", { value0: group.items.length })));
      for (const entry of group.items) list.append(entry.row());
    }
    return list;
  };

  /** 吸顶的天标题（稿 dayHeadHTML）：「今天 · 3 段 · 1,920 字」/「昨天 · 2 条」。 */
  const dayHead = (dayKey: string, todayKey: string, meta: TextSource): HTMLElement => {
    const head = el("div", "day-hd");
    head.dataset.day = dayKey;
    head.append(textEl("b", "", () => dayLabel(dayKey, todayKey)), textEl("span", "day-hd-m", () => `· ${readText(meta)}`));
    return head;
  };

  const commandEmptyState = (): HTMLElement => {
    const empty = el("div", "empty-state");
    empty.append(
      iconEl("div", "empty-icon", commandIcon()),
      textEl("div", "empty-title", () => t("view.noVoiceCommandsYet")),
      textEl("div", "empty-copy", () => t("view.successfulRepliesAndFailedAttemptsAreBoth")),
    );
    return empty;
  };

  const taskCopyButton = (labelKey: string, text: string): HTMLButtonElement => {
    const button = textEl("button", "task-copy", () => t(labelKey as never)) as HTMLButtonElement;
    button.type = "button";
    button.addEventListener("click", event => {
      event.stopPropagation();
      button.disabled = true;
      void (actions.onCopyText?.(text) ?? Promise.reject(new Error("clipboard unavailable"))).then(() => {
        button.classList.add("done");
        button.textContent = t("view.copied");
      }, () => {
        button.classList.add("fail");
        button.textContent = t("view.copyFailed");
      }).finally(() => {
        const timer = window.setTimeout(() => {
          copyFeedbackTimers.delete(timer);
          if (disposed) return;
          button.disabled = false;
          button.classList.remove("done", "fail");
          button.textContent = t(labelKey as never);
        }, 1_500);
        copyFeedbackTimers.add(timer);
      });
    });
    return button;
  };

  const commandHistoryRow = (item: VoiceCommandHistoryItem): HTMLElement => {
    const row = el("div", "task-item command-history-item");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    bindAttribute(row, "aria-label", () => t("view.openCommandTaskDetailsValue", { value0: item.transcript }));
    // R3：emoji 头像（稿 TASKS.ava）；失败的命令换成警示 emoji，圆钮居中规范在 CSS。
    const avatar = textEl(
      "span",
      "task-ava",
      () => item.status === "failed" ? "⚠️" : isTranslationItem(item) ? "🌐" : "✨",
    );
    avatar.setAttribute("aria-hidden", "true");
    const info = el("span", "task-info");
    info.append(
      textEl("span", "task-name", () => `“${item.transcript}”`),
      textEl(
        "span",
        "task-preview",
        // 摘要只显示纯文本：回答去掉 Markdown 标记（对话页里才按 Markdown 排版）。
        () => (item.reply !== undefined ? replyPreview(item.reply) : undefined)
          ?? item.userMessage
          // 中断恢复在存储吃紧时只留码（不删记录）：按码补回文案，不画成笼统的「执行失败」。
          ?? (item.errorCode === "VOICE_COMMAND_INTERRUPTED" ? interruptedLabel(item.commandId) : undefined)
          // 还没有回答：这个回合的过程折叠写成一行（与对话页同一口径）。
          ?? toolProgressSummary(item.messages ?? [], item.status)
          ?? (item.status === "running" ? t("view.running") : t("view.failed")),
      ),
    );
    const meta = el("span", "task-meta");
    const metaRow = el("span", "task-meta-row");
    // R9：类型徽章回稿的 `command`（失败已由头像区分），时间按相对读法。
    metaRow.append(
      textEl("span", `task-type command-${item.status}`, () => t("view.tabCommand")),
      textEl("span", "task-time", () => relativeTime(item.createdAt)),
    );
    if (item.unread) {
      const dot = el("span", "task-dot");
      bindAttribute(dot, "aria-label", () => t("view.unread"));
      metaRow.append(dot);
    }
    meta.append(metaRow);
    if (item.status === "completed") {
      const user = (item.messages ?? []).filter(message => message.from === "user" && message.text).map(message => message.text).join("\n") || item.transcript;
      const ai = (item.messages ?? []).filter(message => message.from === "ai" && message.text).map(message => message.text).join("\n") || item.reply || "";
      // 历史条目存的是内置命令 ID（voice.command.translate），不是 Host 事件 ID
      // （com.reai.voice.command.translate）；拿事件 ID 比对会让翻译条目永远落到「问题 / 答案」。
      const translated = isTranslationItem(item);
      const copyRow = el("span", "task-copy-row");
      if (user) copyRow.append(taskCopyButton(translated ? "view.copyOriginal" : "view.copyQuestion", user));
      if (ai) copyRow.append(taskCopyButton(translated ? "view.copyTranslation" : "view.copyAnswer", ai));
      if (copyRow.childNodes.length > 0) meta.append(copyRow);
    }
    if (pendingConversation?.id === item.id) {
      row.setAttribute("aria-busy", "true");
      row.setAttribute("aria-disabled", "true");
      const activity = info.querySelector<HTMLElement>(".task-preview")!;
      releaseLocaleBindings(activity);
      activity.replaceChildren();
      bindText(activity, () => t("common.loading"));
      activity.setAttribute("role", "status");
      activity.append(elapsedNode({ sinceMs: pendingConversation.startedAt, sinceObserved: true }, undefined, true));
    }
    row.append(avatar, info, meta);
    const open = () => {
      if (item.agentSessionId && actions.onOpenConversation) {
        if (pendingConversation?.id === item.id) return;
        const pending = { id: item.id, startedAt: Date.now() };
        pendingConversation = pending;
        render();
        actions.onOpenHistory?.();
        void actions.onOpenConversation(item.agentSessionId).finally(() => {
          if (pendingConversation === pending) { pendingConversation = undefined; render(); }
        });
        return;
      }
      // 换一条就换一个对话：草稿与原地错误不跨条目串门，续接观察窗也从新一条算起。
      chatDetail.reset();
      releaseReplayAudio();
      selectedId = item.id;
      page = commandDetailPage(item);
      actions.onOpenHistory?.();
      render();
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", event => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    return row;
  };

  const inputEmptyState = (): HTMLElement => {
    const empty = el("div", "empty-state");
    empty.append(
      iconEl("div", "empty-icon", microphoneIcon()),
      textEl("div", "empty-title", () => t("view.noVoiceInputYet")),
      textEl(
        "div",
        "empty-copy",
        () => t("view.pressTheVoiceKeyToInsertText"),
      ),
    );
    return empty;
  };

  /**
   * A3-11：All 档的现场记录入口条（稿 ctxEntry）：单行虚线框。文案逐字对稿：
   * 「今天还录了 **N 段**现场记录（X 字）—— 它们不混在这张清单里，单独放在 Context 档」。
   * N 与 X 都按**今天的段**真实计算（collectDaySegments：今天且带转写）。
   * 今天一段都没有时返回 undefined，挂载点据此整条不渲染（稿 `ctxSegs.length>0`）。
   */
  const contextPreview = (): HTMLElement | undefined => {
    const daySegments = collectDaySegments(state.recordings);
    if (daySegments.length === 0) return undefined;
    const chars = daySegments.reduce(
      (sum, segment) => sum + contextCharacterCount(segment.transcriptText ?? ""),
      0,
    );
    const preview = el("button", "ctx-entry context-preview");
    preview.type = "button";
    preview.addEventListener("click", () => {
      selectedTab = "context";
      openDigestDay = undefined;
      render();
    });
    const copy = el("span", "ctx-entry-copy");
    bindText(copy, () => t("view.contextPreview", { count: daySegments.length, chars: formatChars(chars) }));
    preview.append(iconEl("span", "ctx-entry-icon", timelineIcon()), copy);
    return preview;
  };

  /* ── R4 / R18：Context 档 = 按天分组的时间线 ──
     每天：吸顶标题 → 当日总结（一行，默认收着）→ 段。总结是这一天最新的一条，不置顶；
     今天还没记录就不画「今天」这一组。没有控制条：不能停、不能清空、不靠按钮合成。 */
  const dayDigestStatus = (dayKey: string): HTMLElement | undefined => {
    if (state.dayDigestGenerating === dayKey) {
      const line = el("div", "ctx-dg-status");
      line.append(diagnosticsBlock(`digest:${dayKey}:generating`, {
        state: "waiting",
        step: () => t("diagnostics.step.summaryDay"),
        ...waitSince(`digest:${dayKey}`, state.dayDigestGeneratingSinceMs),
        details: [{ label: () => t("diagnostics.detail.day"), tokens: () => [dayKey] }],
      }));
      return line;
    }
    const detail = state.dayDigestFailures?.[dayKey];
    if (!detail) return undefined;
    const line = el("div", "ctx-dg-status");
    line.append(
      textEl("div", "inline-warning", () => t("diagnostics.digestFailed")),
      errorDiagnostics(`digest:${dayKey}:failed:${detail.at}`, detail, {
        noteKey: "diagnostics.digestFailed",
        details: [{ label: () => t("diagnostics.detail.day"), tokens: () => [dayKey] }],
      }),
    );
    return line;
  };

  const contextTimeline = (): HTMLElement => {
    const list = el("div", "task-list ctx-timeline");
    // Host 已只返回有效转写与 pending 段；这里再守一道，升级中或旧 Host 也不能
    // 把空段画成记录。pending 段（缺陷3）保留——积压条目要有「重新转写」入口。
    const validRecordings = state.recordings.filter(
      (recording) => (recording.transcriptText ?? "").trim().length > 0
        || recording.transcriptStatus === "pending",
    );
    if (validRecordings.length === 0) {
      const empty = el("div", "ctx-empty");
      empty.append(
        localizedTextNode(() => t("view.noLiveRecordingsYet")),
        document.createElement("br"),
        localizedTextNode(() => t("view.speechIsAutomaticallySavedHereWhileThe")),
      );
      list.append(empty);
      return list;
    }
    const todayKey = dayKeyOf(new Date());
    for (const group of groupByDay(validRecordings, segmentDayKey)) {
      const chars = group.items.reduce(
        (sum, segment) => sum + contextCharacterCount(segment.transcriptText ?? ""),
        0,
      );
      list.append(dayHead(
        group.dayKey,
        todayKey,
        () => t("view.segmentsValueCharactersValue", { value0: group.items.length, value1: formatChars(chars) }),
      ));
      const digest = state.dayDigests[group.dayKey];
      // 总结溯源的段一条不剩就不渲染（素材全删后的总结是在冒名）；调度器随后会撤掉它。
      const daySegments = collectDaySegmentsFor(validRecordings, group.dayKey);
      if (digest && daySegments.length > 0) {
        list.append(digestRow(group.dayKey, todayKey, digest, daySegments));
      }
      // §6.0：当日总结在生成（含首次生成、还没有旧总结可显示）或失败时，这一天的分组里说清楚。
      const digestStatus = dayDigestStatus(group.dayKey);
      if (digestStatus) list.append(digestStatus);
      for (const run of contextSegmentRuns(group.items)) {
        list.append(run.length > 1 ? emptySegmentRun(run) : segmentRow(run[0]!));
      }
    }
    if (actions.onLoadMoreRecordings && state.recordings.length < state.recordingsTotal) {
      const more = textEl(
        "button",
        "ctx-btn ctx-load-more",
        () => state.recordingsLoadingMore ? t("view.contextLoadingMore") : t("view.contextLoadMore"),
      );
      more.type = "button";
      more.dataset.action = "load-more-recordings";
      more.disabled = state.recordingsLoadingMore === true;
      more.addEventListener("click", () => fire(() => actions.onLoadMoreRecordings!()));
      list.append(more);
    }
    return list;
  };

  /**
   * 连续的「没人说话」段收成一行：全天录音开着时空段成串出现，逐行画只会刷屏。
   * 展开后仍是原来的各段行，每段照样点得进详情（原始转写与音频都不动）。
   */
  const emptySegmentRun = (run: VoiceRecordingSegment[]): HTMLElement => {
    const box = el("details", "ctx-empty-run") as HTMLDetailsElement;
    box.dataset.contextKey = `run:${run[0]!.id}`;
    box.open = openContextDetails.has(box.dataset.contextKey);
    const startMs = Math.min(...run.map((item) => item.wallStartMs));
    const endMs = Math.max(...run.map((item) => item.wallStartMs + item.durationMs));
    const summary = el("summary", "ctx-seg ctx-seg-empty ctx-empty-run-row");
    summary.append(
      textEl("span", "ctx-seg-empty-range", () => `${clockTime(startMs)} – ${clockTime(endMs)}`),
      textEl("span", "ctx-seg-empty-label", () => t("view.contextSilentRun", { count: run.length })),
      iconEl("span", "ctx-seg-empty-arrow", chevronDownIcon()),
    );
    const rows = el("div", "ctx-empty-run-body");
    for (const segment of run) rows.append(segmentRow(segment));
    box.append(summary, rows);
    return box;
  };

  /**
   * R18 当日总结行（稿 ctxDigestHTML）：这一天分组里普通的一行，默认收着；点标题行
   * 原地展开要点 + 重新总结 / 发给 agent。今天 = 「截至 HH:MM 的总结」，定稿 =
   * 「8 月 21 日的总结」。展开态只活在这次停留里（openDigestDay），不持久化。
   */
  const digestRow = (
    dayKey: string,
    todayKey: string,
    digest: VoiceDayDigest,
    daySegments: readonly VoiceRecordingSegment[],
  ): HTMLElement => {
    const open = openDigestDay === dayKey;
    const box = el("section", open ? "ctx-dg open" : "ctx-dg");
    box.dataset.day = dayKey;
    const title = () => digest.final || dayKey !== todayKey
      ? t("app.summaryForValue", { value0: dayDateLabel(dayKey, todayKey) })
      : t("view.summaryThroughValue", { value0: clockTime(digest.toMs) });

    const row = el("button", "ctx-dg-row");
    row.type = "button";
    row.dataset.dg = "toggle";
    row.setAttribute("aria-expanded", String(open));
    const body = el("div", "ctx-dg-body");
    body.id = `ctx-dg-body-${dayKey}`;
    row.setAttribute("aria-controls", body.id);
    const copy = el("span", "ctx-seg-b");
    copy.append(
      textEl("span", "ctx-seg-t", () => title()),
      textEl(
        "span",
        "ctx-seg-p",
        () => t("view.aiGeneratedNotYourOriginalWordsSegments", { value0: digest.segs, value1: clockTime(digest.fromMs), value2: clockTime(digest.toMs) })
          + t("view.contextDigestRawCharacters", { count: formatChars(digest.chars), points: digest.points.length })
          // 云端回退如实披露原因（已本地化），不再只说「走了云端」。
          + (digest.backend === "cloud"
            ? t("view.dshUnavailableGeneratedDirectlyByTheCloud")
              + (digest.fallbackReason ? `（${digest.fallbackReason}）` : "")
            : ""),
      ),
    );
    row.append(
      iconEl("span", "ctx-dg-i", sparklesIcon()),
      copy,
      iconEl("span", "ctx-dg-chev", chevronDownIcon()),
    );
    row.addEventListener("click", () => {
      openDigestDay = open ? undefined : dayKey;
      render();
    });

    const points = el("div", "ctx-sum-l");
    for (const point of digest.points) {
      const { text, times } = splitDigestPoint(point);
      const sources = digestPointSegments(times, daySegments);
      const line = el("div", sources.length > 0 ? "ctx-sum-i ctx-sum-linked" : "ctx-sum-i");
      line.append(textEl("span", "ctx-sum-tx", () => text));
      // 要点带了来源时刻、且那一段还在列表里：每个来源一枚时刻钮，点进那段原文。
      for (const source of sources) {
        const jump = textEl("button", "ctx-sum-src-jump", () => clockTime(source.wallStartMs));
        jump.type = "button";
        jump.dataset.action = "open-digest-source";
        jump.dataset.recordingId = source.id;
        bindAttribute(jump, "aria-label", () => t("view.contextOpenDigestSource", { value0: ctxRangeTitle(source) }));
        jump.addEventListener("click", () => openContextSegment(source, "raw"));
        line.append(jump);
      }
      points.append(line);
    }
    const footer = el("div", "ctx-sum-ft");
    const generating = state.dayDigestGenerating === dayKey;
    const regen = textEl("button", "ctx-btn", () => generating ? t("view.summarizing") : t("view.summarizeAgain"));
    regen.type = "button";
    regen.dataset.action = "regenerate-day-digest";
    regen.disabled = generating;
    regen.addEventListener("click", () => fire(() => actions.onRegenerateDayDigest(dayKey)));
    footer.append(regen);
    // 跨扩展入口只在对方装了时存在（稿 extOn('agents')），不画灰门。
    if (state.agentsImAvailable === true) {
      const send = textEl("button", "ctx-btn", () => t("view.sendToAgent"));
      send.type = "button";
      send.dataset.action = "send-day-digest-to-agent";
      send.addEventListener("click", () => fire(() => actions.onSendDayDigestToAgent(dayKey)));
      footer.append(send);
    }
    body.append(points, footer);
    box.append(row, body);
    return box;
  };

  /**
   * R6 段行（稿 ctxSegHTML）：轻行——波形图标 + 「HH:MM – HH:MM」+ 首句 + 右侧
   * 「N 分钟 / X 字」。行上没有播放、没有删除，那两件事在段详情页。
   */
  const segmentRow = (item: VoiceRecordingSegment): HTMLElement => {
    const row = el("button", "ctx-seg recording-copy");
    row.type = "button";
    row.dataset.recordingId = item.id;
    bindAttribute(row, "aria-label", () => t("view.viewLiveRecordingDetailsValue", { value0: new Date(item.wallStartMs).toLocaleString() }));
    const transcript = item.transcriptText?.trim() ?? "";
    // 缺陷3：pending 且没文本的段是「等待 / 积压本地转写」的记录，不是不存在；
    // 行内如实标「等待转写」，点进去原文栏有「重新转写」入口。
    const pendingTranscription = item.transcriptStatus === "pending" && !transcript;
    const copy = el("span", "ctx-seg-b");
    copy.append(
      textEl("span", "ctx-seg-t", () => ctxRangeTitle(item)),
      textEl(
        "span",
        "ctx-seg-p",
        () => [...(item.sentences ?? []).map((sentence) => sentence.text), ...splitTranscriptLines(transcript)]
          .find((text) => !isEmptyContextText(text)) ?? transcript,
      ),
    );
    const meta = el("span", "ctx-seg-m");
    meta.append(localizedTextNode(() => ctxDurationLabel(item.durationMs)));
    if (transcript) {
      meta.append(document.createElement("br"), localizedTextNode(() => t("view.charactersValue", { value0: formatChars(contextCharacterCount(transcript)) })));
    }
    if (isEmptyContextRecording(item) || pendingTranscription) {
      row.classList.add("ctx-seg-empty");
      row.append(
        textEl("span", "ctx-seg-empty-range", () => ctxRangeTitle(item)),
        textEl(
          "span",
          "ctx-seg-empty-label",
          () => pendingTranscription ? t("view.contextPendingTranscription") : t("view.contextNoTextYet"),
        ),
        iconEl("span", "ctx-seg-empty-arrow", chevronDownIcon()),
      );
    } else {
      row.append(iconEl("span", "ctx-seg-i", timelineIcon()), copy, meta);
    }
    row.addEventListener("click", () => openContextSegment(item));
    return row;
  };

  const openContextSegment = (item: VoiceRecordingSegment, pane?: ContextPane) => {
    const pendingTranscription = item.transcriptStatus === "pending" && !(item.transcriptText?.trim());
    // R7：每次打开都落在总结栏；上一场看的是哪一栏不带到下一段。
    ctxPane = pane ?? (isEmptyContextRecording(item) || pendingTranscription ? "raw" : "sum");
    releaseReplayAudio();
    selectedId = item.id;
    page = "context";
    actions.onOpenHistory?.();
    render();
  };

  const historyRow = (item: VoiceHistoryItem): HTMLElement => {
    const row = el("div", "task-item");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const pendingTranscript = !!item.transcriptionStatus;
    const cancelled = item.stopReason === "user_cancel" && item.savedInput?.state !== "complete";
    if (pendingTranscript) row.classList.add("is-pending");
    if (item.transcriptionStatus === "failed") row.classList.add("is-failed");
    if (cancelled) row.classList.add("is-cancelled");
    // R3：emoji 头像（稿 TASKS.ava 🎙️），圆钮居中规范在 CSS。ESC 取消时用叠加
    // 禁止徽标表达「只有这一条不同」，整组仍作为一个可访问图像朗读。
    const avatar = el("span", "task-ava");
    if (item.transcriptionStatus === "failed") {
      avatar.setAttribute("role", "img");
      bindAttribute(avatar, "aria-label", () => t("view.theLastTranscriptionFailedTheRecordingIs"));
      const mic = textEl("span", "task-ava-mic", () => "🎙️");
      mic.setAttribute("aria-hidden", "true");
      const fail = textEl("span", "task-ava-fail", () => "!");
      fail.setAttribute("aria-hidden", "true");
      avatar.append(mic, fail);
    } else if (cancelled) {
      avatar.setAttribute("role", "img");
      bindAttribute(avatar, "aria-label", () => t("view.recordingCancelled"));
      const mic = textEl("span", "task-ava-mic", () => "🎙️");
      mic.setAttribute("aria-hidden", "true");
      const ban = textEl("span", "task-ava-ban", () => "🚫");
      ban.setAttribute("aria-hidden", "true");
      avatar.append(mic, ban);
    } else {
      bindText(avatar, () => "🎙️");
      avatar.setAttribute("aria-hidden", "true");
    }
    const info = el("span", "task-info");
    info.append(
      textEl(
        "span",
        "task-name",
        () => pendingTranscript ? t("view.recordingSavedWithoutTranscription") : `“${item.transcript}”`,
      ),
      // R9：副行文案按稿「Voice input · N chars」。
      textEl(
        "span",
        "task-preview",
        () => pendingTranscript
          ? t("view.voiceInputReadyToTranscribeAgain")
          : t("view.inputCharacters", { count: Array.from(item.transcript).length }),
      ),
    );
    const meta = el("span", "task-meta");
    const metaRow = el("span", "task-meta-row");
    metaRow.append(
      textEl("span", "task-type", () => t("view.tabInput")),
      textEl("span", "task-time", () => relativeTime(item.createdAt)),
    );
    meta.append(metaRow);
    if (!pendingTranscript && !cancelled && item.transcript) {
      const copyRow = el("span", "task-copy-row");
      copyRow.append(taskCopyButton("view.copyText", item.transcript));
      meta.append(copyRow);
    }
    row.append(avatar, info, meta);
    const open = () => {
      // 换了一条就别接着上一条的播放态——那会让人以为新打开的这条正在响。
      releaseReplayAudio();
      selectedId = item.id;
      page = "detail";
      actions.onOpenHistory?.();
      render();
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", event => {
      if (event.target !== row) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
    return row;
  };

  /**
   * 详情页的回听区：能播就是播放条，播不了就是一句「录音已过期」。
   *
   * 不留一颗点不动的播放键——过期是用户自己设的保留时长到点了，属于正常结果，
   * 所以语气中性，并指明去哪儿改。文字永远留着，不受保留时长影响。
   */
  const replaySection = (item: VoiceRecordingRef): HTMLElement => {
    if (!isReplayAvailable(item, state.replayCache)) {
      const gone = el("div", "replay-gone");
      gone.innerHTML = volumeOffIcon();
      const copy = document.createElement("div");
      // 「从来没录上」和「录过但过期了」是两件事，不能把落盘失败伪装成正常到期。
      if (item.recordingId) {
        bindText(copy, () => t("view.recordingExpiredCopy"));
      } else {
        bindText(copy, () => t("view.recordingMissingCopy"));
      }
      gone.append(copy);
      return gone;
    }
    return replayBar(item.recordingId ?? "");
  };

  /**
   * 播放条（稿 .ctx-play）：输入详情的回听与段详情的原始录音是同一件东西的同一种长相，
   * 所以共用一套播放机（预取 → 同步 play / pause → 真波形），时间只取真实媒体。
   */
  const replayBar = (recordingId: string): HTMLElement => {
    const bar = el("div", "replay-bar");
    const button = el("button", "replay-play");
    button.type = "button";
    // 播放态活在闭包外（模块级变量 + DOM 上的 data-replay-id），按钮换了一颗也接得上：
    // 取件成功/失败、播放/暂停/播完都可能发生在一次重渲染之后，捕获 DOM 引用的
    // 旧闭包那时操作的是已经离开页面的按钮，表现就是「点一次就永久变灰」。
    button.dataset.replayId = recordingId;
    const wave = el("div", "replay-wave");
    wave.setAttribute("aria-hidden", "true");
    wave.dataset.replayId = recordingId;
    wave.replaceChildren(replayWaveBars(
      recordingId,
      REPLAY_WAVE_BAR_COUNT,
      replayWaveforms.get(recordingId),
    ));
    const seek = el("input", "replay-seek") as HTMLInputElement;
    seek.type = "range";
    seek.min = "0";
    seek.max = "0";
    seek.step = "0.01";
    seek.value = "0";
    seek.disabled = true;
    seek.dataset.replayId = recordingId;
    bindAttribute(seek, "aria-label", () => t("view.replayPosition"));
    const seekTo = (position: number) => {
      const duration = replayDuration();
      if (replayPlayingId !== recordingId || !replayAudio || duration === undefined || !Number.isFinite(position)) return;
      try {
        replayAudio.currentTime = Math.max(0, Math.min(duration, position));
        syncReplayProgress(recordingId);
      } catch (cause) { setReplayError(recordingId, cause); }
    };
    seek.addEventListener("input", () => seekTo(Number(seek.value)));
    seek.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || seek.disabled) return;
      releaseReplaySeek?.();
      const finish = (end: Event) => {
        if (end instanceof PointerEvent && end.pointerId !== event.pointerId) return;
        const pending = replayRenderPending;
        releaseReplaySeek?.();
        if (pending) render(); else syncReplayProgress(recordingId);
      };
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
      window.addEventListener("blur", finish);
      releaseReplaySeek = () => {
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", finish);
        releaseReplaySeek = undefined;
        replayRenderPending = false;
      };
    });
    seek.addEventListener("keydown", (event) => {
      const duration = replayDuration();
      if (seek.disabled || duration === undefined) return;
      const position = replayAudio?.currentTime ?? 0;
      const target = event.key === "Home" ? 0 : event.key === "End" ? duration
        : event.key === "ArrowRight" || event.key === "ArrowUp" ? position + 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown" ? position - 1
        : event.key === "PageUp" ? position + 10 : event.key === "PageDown" ? position - 10 : undefined;
      if (target === undefined) return;
      event.preventDefault();
      seekTo(target);
    });
    const track = el("div", "replay-track");
    track.append(wave, seek);
    const time = textEl("output", "replay-time", () => t("view.replayLoading"));

    button.addEventListener("click", () => {
      if (replayAudio && replayPlayingId === recordingId) {
        if (replayAudio.paused) playReplayAudio(recordingId, replayAudio);
        else replayAudio.pause();
        syncReplayButton();
        return;
      }
      // 极快点击可能发生在预取完成前：记住这次明确的播放意图，音频一落地就接着播。
      void prepareReplayAudio(recordingId, true);
      syncReplayButton();
    });

    const error = textEl("div", "replay-error", () => "");
    error.setAttribute("role", "status");
    error.hidden = true;
    bar.append(button, track, time, error, el("div", "replay-diag"));
    return bar;
  };

  /**
   * 重新转写的等待 / 失败诊断（方案 2.3）：计时绑定尝试身份——身份匹配的 Host 回执时间优先，
   * 接管已在 pending 的旧任务用它自己的回执；回落本地换了 attemptId 就是新尝试。
   */
  const inputRetryDiagnostics = (item: VoiceHistoryItem, pending: boolean, cancelled: boolean, step: () => string): HTMLElement | undefined => {
    const recordingId = item.recordingId ?? "";
    const attempt = state.inputRetryAttempts?.[recordingId];
    const saved = item.savedInput;
    // 等待中只认身份匹配本次尝试的回执：新尝试（如云端失败后回落本地）的回执还没到时，
    // 计时、引擎、模型、尝试明细都不回退到上一轮失败的回执，未知项如实写「无」。
    const receipt = !pending
      || (saved?.state === "pending" && (!attempt?.attemptId || attempt.attemptId === saved.attemptId))
      ? saved : undefined;
    const attemptEngine = attempt?.phase === "cloud" ? "cloud" : attempt?.phase === "local" || attempt?.phase === "fallback" ? "local" : undefined;
    const details: VoiceDiagnosticDetail[] = [
      { label: () => t("diagnostics.detail.recording"), tokens: () => [recordingId || undefined] },
      { label: () => t("diagnostics.detail.engine"), tokens: () => [receipt?.selection.engine ?? (pending ? attemptEngine : item.requestedEngine)] },
      {
        label: () => t("diagnostics.detail.model"),
        value: () => receipt?.selection.modelName ?? receipt?.selection.modelId ?? t("diagnostics.none"),
        // 复制只写登记的 ID；自定义模型写固定标签（显示值只在界面，不复制）。
        tokens: () => [diagnosticModelToken(receipt?.selection.modelId, receipt?.selection.engine)],
      },
      ...(receipt ? [{ label: () => t("diagnostics.detail.attempt"), tokens: () => [receipt.attemptId, `r${receipt.revision}`, receipt.state] }]
        : attempt?.attemptId ? [{ label: () => t("diagnostics.detail.attempt"), tokens: () => [attempt.attemptId, attempt.phase] }] : []),
    ];
    if (pending) {
      const identity = attempt?.attemptId ?? receipt?.attemptId ?? `op${attempt?.opSeq ?? 0}`;
      const since = waitSince(`retry:${recordingId}:${identity}:${attempt?.phase ?? "pending"}`,
        receipt && isValidTimeMs(receipt.startedAtMs) ? receipt.startedAtMs : attempt?.sinceMs);
      return diagnosticsBlock(`retry:${recordingId}:${identity}`, { state: "waiting", step, ...since, details });
    }
    if (cancelled) return undefined;
    const finished = isValidTimeMs(receipt?.finishedAtMs) ? receipt!.finishedAtMs! : undefined;
    const code = receipt?.errorCode ?? undefined;
    return diagnosticsBlock(`retry-failed:${recordingId}:${receipt?.attemptId ?? item.id}`, {
      state: failureState(code),
      step: () => t("diagnostics.step.retranscribe"),
      ...(code ? { code } : {}),
      rawNote: receipt ? "hostNotProvided" : "notRecorded",
      ...(finished !== undefined ? { at: new Date(finished).toISOString() } : {}),
      ...(receipt && finished !== undefined && isValidTimeMs(receipt.startedAtMs) ? { sinceMs: receipt.startedAtMs, endMs: finished } : {}),
      details,
    });
  };

  /**
   * 润色 / 写回两个阶段各自的失败诊断；旧条目只有 warningCode 时如实写「未记录」。
   * 落盘只有结构化字段；本次运行里的原文从内存表取（`failureRaw`），重启后如实写「未保留」。
   */
  const stageFailureDiagnostics = (item: VoiceHistoryItem): HTMLElement[] => {
    const blocks: HTMLElement[] = [];
    for (const [stage, failure] of [["deliver", item.deliveryFailure], ["polish", item.polishFailure]] as const) {
      if (!failure) continue;
      blocks.push(diagnosticsBlock(`stage:${item.id}:${stage}`, {
        state: failureState(failure.code),
        step: () => t(`diagnostics.step.${stage}`),
        code: failure.code,
        ...(failure.source ? { source: failure.source } : {}),
        ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
        ...(failure.rawLength ? { rawLength: failure.rawLength } : {}),
        ...(failure.omittedCodes ? { omittedCodes: failure.omittedCodes } : {}),
        ...(state.failureRaw?.[`${stage}:${item.id}`] ? { raw: state.failureRaw[`${stage}:${item.id}`] } : {}),
        rawNote: "hostNotProvided",
        at: failure.at,
      }));
    }
    // 按阶段补齐：warningCode 指向的那个阶段没有自己的失败记录时（旧条目，或只记了类别），如实写「未记录」。
    const warningStage = item.warningCode === "polish_failed" ? item.polishFailure : item.deliveryFailure;
    if (item.warningCode && !warningStage) {
      blocks.push(diagnosticsBlock(`stage:${item.id}:legacy`, {
        state: "failed",
        step: () => t(item.warningCode === "polish_failed" ? "diagnostics.step.polish" : "diagnostics.step.deliver"),
        code: item.warningCode,
        rawNote: "notRecorded",
        at: item.createdAt,
      }));
    }
    return blocks;
  };

  const renderDetail = () => {
    const item = state.history.find((entry) => entry.id === selectedId);
    if (!item) {
      // 这一条被新记录挤出历史上限（或历史被清空）：自动退回列表。正在播的回听
      // 必须一起收掉——播放控件已经不在了，留着就是一段找不到出处的后台声音。
      releaseReplayAudio();
      page = "history";
      renderHistory();
      return;
    }
    const view = el("main", "main-body input-detail");
    const header = el("header", "detail-header input-detail-header");
    // B5-14：页内返回钮撤除——返回由 Host 面包屑承载（back-to-root → navigateRoot）。
    const legacyBack = legacyBackButton();
    if (legacyBack) header.append(legacyBack);
    const identity = el("div", "detail-identity chat-hdr-main");
    const who = el("div", "chat-who");
    const whoCopy = el("div", "chat-who-text");
    whoCopy.append(
      textEl("div", "chat-who-name detail-title", () => t("view.voiceInputTitle")),
      textEl("div", "chat-who-role detail-sub", () => relativeTime(item.createdAt)),
    );
    const avatar = textEl("div", "chat-who-ava input-detail-avatar", () => "🎙️");
    avatar.setAttribute("aria-hidden", "true");
    who.append(avatar, whoCopy);
    identity.append(who);
    header.append(identity);

    const body = el("div", "input-detail-body voice-input-detail-body");
    // 详情页开着的时候录音到期（保留时长推进或配额淘汰了这条）：播放条要换成
    // 「录音已过期」说明，正在响的音频与 blob URL 也得一起收掉——此刻持有的
    // 回听态只可能是这一条的（换一条时已收口），不收就成了一段没有控件的后台声音。
    if (!isReplayAvailable(item, state.replayCache)) releaseReplayAudio();
    // 播放条在转写文本上面：先是你当时说的那段声音，底下才是它变成的文字，
    // 顺序跟事情发生的顺序一致。
    body.append(replaySection(item));
    const hasTranscript = !!item.transcript.trim();
    if (hasTranscript) body.append(textEl("div", "input-detail-text", () => item.transcript));
    const original = item.originalSelection;
    body.append(textEl("div", "input-detail-selection", () => t("retry.originalSelection", {
      model: original ? `${original.engine === "cloud" ? t("view.cloudRecognition") : t("view.localRecognition")} · ${original.modelName || t("view.notRecorded")} · ${original.language}`
        : item.requestedEngine ? `${item.requestedEngine === "cloud" ? t("view.cloudRecognition") : t("view.localRecognition")} · ${t("view.notRecorded")}` : t("view.notRecorded"),
    })));
    const phase = item.recordingId ? state.inputRetries?.[item.recordingId] : undefined;
    const pending = !!phase || item.savedInput?.state === "pending" || item.transcriptionStatus === "pending";
    let retryPanel: HTMLElement | undefined;
    let retryCopy: HTMLElement | undefined;
    if (item.transcriptionStatus || pending) {
      const cancelled = item.savedInput?.state === "cancelled" || item.transcriptionStatus === "not_requested";
      retryPanel = el("section", `voice-retry-panel ${pending ? "pending" : cancelled ? "cancelled" : "failed"}`);
      retryPanel.setAttribute("aria-live", "polite");
      const symbol = iconEl("div", "voice-retry-symbol", alertIcon());
      symbol.setAttribute("aria-hidden", "true");
      retryCopy = el("div", "voice-retry-copy");
      retryCopy.append(textEl("h3", "voice-retry-title", () => pending ? t("view.transcribing")
        : cancelled ? t("view.transcriptionCancelled") : t("view.transcriptionIncomplete")));
      // 只由阶段与码推出的固定文案：也作等待诊断的步骤名。
      const statusText = () => {
        if (phase === "preparing") return t("retry.preparing");
        if (phase === "fallback") return t("retry.fallbackRunning");
        if (phase === "cloud") return t("retry.cloudRunning");
        if (pending) return t("view.transcribing");
        if (!isReplayAvailable(item, state.replayCache)) return t("view.transcriptionIncompleteRecordingUnavailable");
        if (item.savedInput?.state === "no_speech") return t("view.noClearSpeechWasDetectedTryAgain");
        if (item.savedInput?.state === "cancelled" || item.transcriptionStatus === "not_requested") return t("view.transcriptionWasCancelledTheRecordingIsStill");
        const code = item.savedInput?.errorCode ?? "";
        if (code.includes("PERMISSION") || code.includes("NOT_GRANTED")) return t("app.cloudRecognitionPermissionIsNotEnabledIn");
        if (code === "PLUGIN_OAUTH_REAUTH_REQUIRED") return t("retry.reconnectCloud");
        if (code === "VOICE_RECORDING_READ_FAILED") return t("view.recordingExpiredCopy");
        const cloud = voiceCloudFailureMessage({ code });
        if (cloud) return cloud;
        return t("view.theLastTranscriptionFailedTheRecordingIs");
      };
      const status = textEl("p", "voice-retry-message", statusText);
      status.setAttribute("role", "status");
      const intent = item.savedInput?.selection.engine ?? original?.engine ?? item.requestedEngine;
      retryCopy.append(status, textEl("span", "voice-retry-source", () => t("view.attemptedRecognition", {
        engine: intent === "cloud" ? t("view.cloudRecognition") : intent === "local" ? t("view.localRecognition") : t("view.recognitionNotRecorded"),
      })));
      const retryDiagnostics = inputRetryDiagnostics(item, pending, cancelled, statusText);
      if (retryDiagnostics) retryCopy.append(retryDiagnostics);
      retryPanel.append(symbol, retryCopy);
      body.append(retryPanel);
    }
    if (item.savedInput) {
      const execution = item.savedInput;
      const line = textEl("div", retryCopy ? "voice-retry-info" : "input-detail-recognition", () => t("retry.execution", {
        engine: execution.selection.engine === "cloud" ? t("view.cloudRecognition") : t("view.localRecognition"),
        model: execution.selection.modelName || t("view.notRecorded"),
      }));
      line.dataset.savedInputSource = execution.selection.engine;
      (retryCopy ?? body).append(line);
      if (item.retryPlan?.primary.engine === "cloud" && execution.selection.engine === "local") {
        const fallback = textEl(retryCopy ? "div" : "span", retryCopy ? "voice-retry-info" : "input-detail-recognition-note", () => t("retry.fallbackUsed"));
        (retryCopy ?? line).append(fallback);
      }
      // Successful retries already explain ASR-only once in the processing facts.
      // Non-success states keep the explanation inside their status panel.
      if (retryCopy) retryCopy.append(textEl("div", "voice-retry-info", () => t("retry.asrOnly")));
    } else if (!item.transcriptionStatus && !pending) {
      body.append(recognitionEngineCard(item));
    }
    if ((item.transcriptionStatus || pending) && item.recordingId) {
      if (!pending) {
        const model = state.settings.engine === "cloud"
          ? state.cloudModels.find(model => model.id === state.featureSettings.cloudModelId)?.label
          : state.models.find(model => model.id === state.settings.modelId)?.name;
        (retryCopy ?? body).append(textEl("div", retryCopy ? "voice-retry-info" : "input-detail-meta", () => t("retry.currentSelection", { model: model || t("view.notRecorded") })));
        if (state.settings.engine === "cloud" && state.models.some(model => model.id === state.settings.modelId && ["ready", "active"].includes(model.state))) {
          (retryCopy ?? body).append(textEl("div", retryCopy ? "voice-retry-info" : "input-detail-meta", () => t("retry.fallbackNotice")));
        }
      }
      const action = textEl("button", "detail-primary-action primary-button voice-retry-button", () => pending ? t("view.cancel") : state.settings.engine === "cloud" ? t("view.transcribeAgainCloud") : t("view.transcribeAgainLocally")) as HTMLButtonElement;
      action.type = "button";
      action.disabled = pending ? !actions.onCancelInputTranscription : !isReplayAvailable(item, state.replayCache);
      action.addEventListener("click", () => {
        action.disabled = true;
        if (pending) fire(() => actions.onCancelInputTranscription?.(item.recordingId ?? "") ?? Promise.resolve());
        else fire(() => actions.onRetryInputTranscription(item.id, item.recordingId ?? ""));
      });
      (retryPanel ?? body).append(action);
    }
    if (hasTranscript) {
    // 润色真的改过才画前后对照：两边一样的 diff 是在假装做了工作。
    // 摆在转写下面：先看写进去的那句，再看它原来是什么样。
    if (item.originalTranscript && item.savedInput?.state !== "complete") {
      const compare = el("section", "detail-polish-compare");
      compare.append(
        textEl("div", "detail-section-label", () => t("view.yourOriginalWords")),
        textEl("div", "detail-original-transcript", () => item.originalTranscript),
      );
      body.append(compare);
    }
    const meta = el("div", "input-detail-meta");
    const charCount = Array.from(item.transcript).length;
    const displayedLanguage = item.savedInput?.state === "complete" ? item.savedInput.selection.language : item.language;
    meta.dataset.polishSummary = polishSummary(item);
    meta.setAttribute("role", "group");
    // 「注入前处理」由下方 facts 列表以可见文字朗读，这里不再重复一遍。
    bindAttribute(meta, "aria-label", () => t("view.inputMetadata", { count: charCount, language: displayedLanguage }));
    meta.append(
      textEl("span", "input-detail-tag", () => t("view.characterCount", { count: charCount })),
      textEl("span", "input-detail-tag", () => displayedLanguage),
    );
    body.append(meta);
    // 设计稿的 tag 行只放字符数与语言，但「写入结果」和「注入前处理」是必须以
    // 可见文字呈现的诚实标注，不能只进 aria-label：页面本地测试的条目写的是
    // 未写入（insertText 显式为 false），润色失败回退也必须与「本来就没开润色」
    // 分开说。沿用 metadata-label / metadata-value 语义类，让合同断言继续锚在这。
    const facts = el("dl", "input-detail-facts");
    facts.append(
      textEl("dt", "metadata-label", () => t("view.inputResult")),
      textEl("dd", "metadata-value", () => item.inserted && item.savedInput?.state !== "complete" ? t("view.inserted") : t("view.notInserted")),
      textEl("dt", "metadata-label", () => t("view.processingBeforeInsertion")),
      textEl("dd", "metadata-value", () => polishSummary(item)),
    );
    body.append(facts);
    if (item.warningCode && item.savedInput?.state !== "complete") {
      body.append(textEl("div", "inline-warning", () => warningMessage(item.warningCode ?? "")));
      for (const block of stageFailureDiagnostics(item)) body.append(block);
    }
    }
    view.append(header, body);
    shell.append(view);
    if (item.recordingId && isReplayAvailable(item, state.replayCache)) {
      void prepareReplayAudio(item.recordingId);
    }
  };

  /**
   * 翻译详情：与转文本详情同一个壳（页头 / 回听条 / 文字 / 标签），文字区是「原文」
   * 「译文」两块，各自带写明内容的复制按钮；译文下只放一行小标签写用了哪个 Agent 内核。
   * 没有对话、输入框与工作目录——翻译是一次性的，看完复制就结束。
   * 数据只用历史里已有的：原文 = transcript，译文 = reply，目标语言 = translationTarget。
   */
  const renderTranslationDetail = () => {
    const item = state.commandHistory.find((entry) => entry.id === selectedId);
    if (!item || commandDetailPage(item) !== "translation") {
      // 这一条被挤出历史（或改了状态、不再是成功的翻译）：退回列表，回听一并收掉。
      releaseReplayAudio();
      page = "history";
      renderHistory();
      return;
    }
    const source = item.transcript;
    const result = item.reply ?? "";
    const view = el("main", "main-body input-detail translation-detail");
    const header = el("header", "detail-header input-detail-header");
    const legacyBack = legacyBackButton();
    if (legacyBack) header.append(legacyBack);
    const identity = el("div", "detail-identity chat-hdr-main");
    const who = el("div", "chat-who");
    const whoCopy = el("div", "chat-who-text");
    whoCopy.append(
      textEl("div", "chat-who-name detail-title", () => t("view.translationTitle")),
      textEl("div", "chat-who-role detail-sub", () => relativeTime(item.createdAt)),
    );
    const avatar = textEl("div", "chat-who-ava input-detail-avatar", () => "🌐");
    avatar.setAttribute("aria-hidden", "true");
    who.append(avatar, whoCopy);
    identity.append(who);
    header.append(identity);

    const body = el("div", "input-detail-body voice-input-detail-body");
    // 录音引用没了或已过期：旧的播放/预取一并失效，不能只是控件消失。
    if (!item.recordingId || !isReplayAvailable(item, state.replayCache)) releaseReplayAudio();
    if (item.recordingId) body.append(replaySection(item));
    const label = (name: TextSource, copy: HTMLButtonElement): HTMLElement => {
      const row = el("div", "input-detail-label");
      row.append(textEl("span", "", name), copy);
      return row;
    };
    const target = translationTarget(item.translationTarget);
    body.append(
      label(() => t("view.sourceText"), taskCopyButton("view.copyOriginal", source)),
      textEl("div", "input-detail-text translation-source", () => source),
    );
    const translated = el("section", "input-detail-trans");
    translated.append(
      label(() => t("view.translatedText", { language: translationLabel(target) }), taskCopyButton("view.copyTranslation", result)),
      textEl("div", "input-detail-text translation-result", () => result),
    );
    body.append(translated);
    const meta = el("div", "input-detail-meta");
    const counts = { source: Array.from(source).length, result: Array.from(result).length };
    meta.setAttribute("role", "group");
    bindAttribute(meta, "aria-label", () => t("view.translationCharacterCount", counts));
    meta.append(
      textEl("span", "input-detail-tag", () => t("view.translationCharacterCount", counts)),
      textEl("span", "input-detail-tag", () => target),
    );
    body.append(meta);
    view.append(header, body);
    shell.append(view);
    if (item.recordingId && isReplayAvailable(item, state.replayCache)) {
      void prepareReplayAudio(item.recordingId);
    }
  };

  /**
   * Chat detail（A3-15 → R8）：命令任务的对话式详情页，整块在 voice-chat-detail.ts。
   * 选中条目已不在（历史被清）时回列表，不留在空详情页。
   */
  const renderChat = () => {
    if (chatDetail.mount(shell)) return;
    page = "history";
    renderHistory();
  };

  /**
   * Context 段详情（A3-22/23），结构与文案贴设计稿 `#ctxDetail`——只读时间线 +
   * 原文·总结两栏。页头与输入详情同构（稿 .input-detail-header：白底 + 底边线，
   * R16），左侧身份（稿 ctxTitle/ctxMeta）；返回走 Host 面包屑。
   *
   * R7：默认落在总结栏；「生成总结 / 重新总结」「发给 agent」都在总结栏脚部
   * （「发给 agent」从页头挪回，只在装了 Agents·IM 时渲染）；R17：「删掉这段记录」
   * 也在脚部、靠右红字，点下去先问一次（确认层）。
   *
   * 数据边界：Host 的 RecordingSegmentInfo 在起始墙钟 / 时长 / 整段转写之外，R12 起
   * 带句级时间戳（`sentences`，新转写才有）、R11 起带 agent 总结（`summary`，Host
   * 持久化）。两者都可能为空：没有句级数据时原文栏退回「按转写分句、只有首句标
   * 时刻」；没有总结时总结栏给空态 + 真实的「生成总结」入口。
   */
  const renderContextDetail = () => {
    const item = state.recordings.find((entry) => entry.id === selectedId);
    if (!item) {
      // 段已不在（删掉了 / 列表刷新）：回列表，确认层一起收。
      deleteAsk = undefined;
      releaseReplayAudio();
      page = "history";
      renderHistory();
      return;
    }
    const view = el("main", "main-body ctx-view input-detail");

    const header = el("header", "detail-header input-detail-header ctx-detail-header");
    const headerMain = el("div", "detail-identity chat-hdr-main");
    const who = el("div", "chat-who");
    const whoText = el("div", "chat-who-text");
    const transcript = item.transcriptText?.trim() ?? "";
    const todayKey = dayKeyOf(new Date());
    const dayName = dayLabel(segmentDayKey(item), todayKey);
    whoText.append(
      textEl("div", "chat-who-name", () => ctxRangeTitle(item)),
      textEl(
        "div",
        "chat-who-role",
        // 稿 ctxMeta 逐字：现场记录 · 今天 · 时长 · 字数。还没转写完时字数不可知，不写。
        () => transcript
          ? t("view.liveRecordingValueValueCharactersValue", { value0: dayName, value1: ctxDurationLabel(item.durationMs), value2: formatChars(contextCharacterCount(transcript)) })
          : t("view.liveRecordingValueValue", { value0: dayName, value1: ctxDurationLabel(item.durationMs) }),
      ),
    );
    who.append(iconEl("div", "chat-who-ava", timelineIcon()), whoText);
    headerMain.append(who);
    // B5-14：context 页内返回钮撤除——返回由 Host 面包屑承载。
    const ctxLegacyBack = legacyBackButton();
    if (ctxLegacyBack) headerMain.prepend(ctxLegacyBack);
    header.append(headerMain);
    view.append(header);

    // 总结 / 发给 agent / 删除的失败反馈都留在本页（按钮在这里，报错不能退回列表才看见）。
    if (state.error) view.append(inlineErrorBlock("inline-error"));

    // 稿 .ctx-tabs：原文 / 总结两栏，默认总结（R7）。
    const tabs = el("div", "ctx-tabs");
    tabs.setAttribute("role", "tablist");
    bindAttribute(tabs, "aria-label", () => t("view.contextSegmentContentView"));
    const CTX_PANES: Array<{ id: ContextPane; label: string }> = [
      { id: "raw", get label() { return t("view.original2"); } },
      { id: "sum", get label() { return t("view.summary"); } },
    ];
    for (const pane of CTX_PANES) {
      const tab = textEl(
        "button",
        pane.id === ctxPane ? "ctx-tab active" : "ctx-tab",
        () => pane.label,
      );
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(pane.id === ctxPane));
      tab.dataset.ctxPane = pane.id;
      tab.addEventListener("click", () => {
        if (ctxPane === pane.id) return;
        ctxPane = pane.id;
        render();
      });
      tabs.append(tab);
    }
    view.append(tabs);

    const body = el("div", "ctx-body input-detail-body");
    body.append(ctxPane === "raw" ? ctxRawPane(item) : ctxSumPane(item));
    view.append(body);
    if (deleteAsk === item.id) view.append(deleteAskLayer(item));
    shell.append(view);
    // 原文栏一打开就预取这一段的音频，点播放只负责同步 play()（与输入详情同一条路）。
    if (ctxPane === "raw") void prepareReplayAudio(item.id);
  };

  /**
   * 原文栏（稿 #ctxRaw → #ctxPlay + #ctxLines）：播放条 + 逐句时间线。
   * 播放走与回听同一套播放机（授权取件 → 本地 WAV → play / pause）；
   *
   * R12：Host 给了句级时间戳（`item.sentences`）就逐句标真实时刻（段起始 + 句内
   * 偏移，稿 `lines[].ts` 的 HH:MM 形态）；旧数据没有句级信息时退回原来的做法——
   * 按转写自身分句、只有首句标段起始时刻，并在脚注里说清「没有」，不内插编造。
   */
  /**
   * Context 段转写的等待 / 状态诊断。Host 只给 pending / complete / disabled，没有失败码与开始时间：
   * 等待时长从这一段录音结束算（步骤名里写明口径），失败原因如实写「Host 未提供」。
   */
  const segmentTranscriptionDiagnostics = (item: VoiceRecordingSegment): HTMLElement => {
    const retrying = state.retranscribingSegments?.[item.id];
    const status = item.transcriptStatus ?? "pending";
    const details: VoiceDiagnosticDetail[] = [
      { label: () => t("diagnostics.detail.recording"), tokens: () => [item.id] },
      { label: () => t("diagnostics.detail.transcriptStatus"), tokens: () => [status] },
    ];
    if (retrying === "running") {
      return diagnosticsBlock(`segment:${item.id}:requeue`, {
        state: "waiting", step: () => t("diagnostics.step.retranscribeQueue"), ...waitSince(`segment-requeue:${item.id}`), details,
      });
    }
    if (status === "disabled") {
      return diagnosticsBlock(`segment:${item.id}:disabled`, {
        state: "failed", step: () => t("diagnostics.step.transcribeSegment"), noteKey: "diagnostics.segmentDisabled",
        rawNote: "hostNotProvided", details,
      });
    }
    return diagnosticsBlock(`segment:${item.id}:pending:${retrying ?? ""}`, {
      state: "waiting",
      step: () => t(retrying === "queued" ? "diagnostics.step.transcribeQueued" : "diagnostics.step.transcribeSegment"),
      ...waitSince(`segment:${item.id}`, item.wallStartMs + item.durationMs),
      details,
    });
  };

  const ctxRawPane = (item: VoiceRecordingSegment): HTMLElement => {
    const pane = el("div", "ctx-pane");
    // 回听时长与位置由真实媒体提供，段时长仍只用于页头。
    const playback = replayBar(item.id);
    pane.append(playback);
    const transcript = item.transcriptText?.trim() ?? "";
    if (!transcript) {
      // 还没转写完的段也点得进来：时间线先给诚实的「还没有」，不画一行假句子。
      pane.append(textEl(
        "div",
        "ctx-empty",
        () => t("view.thisSegmentIsStillBeingTranscribedIts"),
      ));
      pane.append(segmentTranscriptionDiagnostics(item));
      // 缺陷3：积压 / 失败 / 缺失都不该让用户干等——给一个「重新转写」入口，
      // 把这段的转写范围重新排进本地引擎队列。转写排队中如实说明。
      if (actions.onRetranscribeSegment) {
        const phase = state.retranscribingSegments?.[item.id];
        if (phase === "queued") {
          pane.append(textEl("div", "ctx-retranscribe-note", () => t("view.retranscribeQueuedNote")));
        }
        const button = textEl(
          "button",
          "ctx-btn ctx-retranscribe",
          () => phase === "running" ? t("view.retranscribing") : t("view.retranscribe"),
        );
        button.type = "button";
        button.dataset.action = "retranscribe-segment";
        button.dataset.recordingId = item.id;
        button.disabled = phase === "running";
        button.addEventListener("click", () => {
          fire(() => actions.onRetranscribeSegment!(item.id));
        });
        pane.append(button);
      }
      return pane;
    }
    const lines = el("div", "ctx-lines");
    const disclosure = (key: string, title: () => string): HTMLDetailsElement => {
      const box = el("details", "ctx-empty-fold") as HTMLDetailsElement;
      box.dataset.contextKey = `${item.id}:${key}`;
      box.open = openContextDetails.has(box.dataset.contextKey);
      box.append(textEl("summary", "ctx-empty-fold-title", title));
      return box;
    };
    const rawLine = (text: string, stamp: string): HTMLElement => {
      const line = el("div", "ctx-line");
      line.append(textEl("div", "ctx-line-ts", () => stamp), textEl("div", "ctx-line-tx", () => text));
      return line;
    };
    const timed = item.sentences ?? [];
    if (timed.length > 0) {
      const blocks = projectContextUtterances(item);
      // 分散的多个空块只是审计素材，各起一条「无内容」只会刷屏：合并成一条折叠，
      // 位置取首个空块；区间标题只在仍剩单个空块时保留，跨块拼区间会撒谎。
      const emptyBlocks = blocks.filter((block) => block.empty);
      const mergedEmpty = emptyBlocks.length > 1
        ? disclosure("empty:merged", () => t("view.contextNoContent"))
        : null;
      for (const block of emptyBlocks) {
        for (const sentence of block.sentences) {
          mergedEmpty?.append(rawLine(sentence.text, `${contextTime(item.wallStartMs + sentence.startMs, true)}～${contextTime(item.wallStartMs + sentence.endMs, true)}`));
        }
      }
      let mergedEmptyPlaced = false;
      for (const block of blocks) {
        if (!block.empty) {
          const stamp = block.startMs === undefined ? "" : contextTime(block.startMs);
          const fragments = disclosure(`${block.filler ? "filler" : "fragments"}:${block.indices.join(",")}`, () => block.filler
            ? `${stamp ? stamp + " " : ""}${t("view.contextFillerFragments", { count: block.sentences.length })}`
            : t("view.contextSourceFragments", { count: block.sentences.length }));
          fragments.classList.add("ctx-fragments");
          if (!block.filler) {
            const line = rawLine(block.text, stamp);
            line.classList.add("ctx-utterance-line");
            lines.append(line);
          }
          for (const sentence of block.sentences) fragments.append(rawLine(sentence.text,
            `${contextTime(item.wallStartMs + sentence.startMs, true)}～${contextTime(item.wallStartMs + sentence.endMs, true)}`));
          lines.append(fragments);
          continue;
        }
        if (mergedEmpty) {
          if (!mergedEmptyPlaced) {
            lines.append(mergedEmpty);
            mergedEmptyPlaced = true;
          }
          continue;
        }
        const box = disclosure(`empty:${block.indices.join(",")}`, () => {
          const range = block.startMs === undefined || block.endMs === undefined ? ""
            : `[${contextTime(block.startMs)}～${contextTime(block.endMs)}] `;
          return range + t("view.contextNoContent");
        });
        for (const sentence of block.sentences) {
          box.append(rawLine(sentence.text, `${contextTime(item.wallStartMs + sentence.startMs, true)}～${contextTime(item.wallStartMs + sentence.endMs, true)}`));
        }
        lines.append(box);
      }
    } else {
      // Legacy data: no invented sentence ranges, including all-punctuation text.
      if (isEmptyContextRecording(item)) {
        const box = disclosure("legacy-empty", () => t("view.contextNoContent"));
        box.append(rawLine(item.transcriptText ?? "", ""));
        lines.append(box);
      } else {
        (item.transcriptText ?? "").split(/\r?\n/u).filter(sentence => sentence.trim().length > 0).forEach((sentence, index) => {
          if (!hasUnfinishedContextStatus(item) && isEmptyContextText(sentence)) {
            const box = disclosure(`legacy:${index}`, () => t("view.contextNoContent"));
            box.append(rawLine(sentence, ""));
            lines.append(box);
          } else if (!hasUnfinishedContextStatus(item) && isContextFiller(sentence)) {
            const box = disclosure(`legacy-filler:${index}`, () => t("view.contextFillerFragments", { count: 1 }));
            box.append(rawLine(sentence, ""));
            lines.append(box);
          } else {
            const line = rawLine(sentence, index === 0 ? contextTime(item.wallStartMs) : "");
            line.classList.add("ctx-utterance-line");
            lines.append(line);
          }
        });
      }
      pane.append(textEl("p", "ctx-lines-note", () => t("view.sentencesFollowTheTranscriptSSegmentationOnly")));
    }
    if (isEmptyContextRecording(item)) {
      const allEmpty = disclosure("all-empty", () => t("view.contextExpandEmpty", { count: timed.length || 1 }));
      allEmpty.append(lines);
      pane.prepend(allEmpty);
    } else pane.prepend(lines);
    // Audio remains first; the audit text is literal and never written back to Host.
    pane.prepend(playback);
    const audit = disclosure("audit", () => t("view.contextOriginalText", { count: Array.from(item.transcriptText ?? "").length }));
    audit.append(textEl("pre", "ctx-original-text", () => item.transcriptText ?? ""));
    pane.append(audit);
    return pane;
  };

  /**
   * 总结栏（稿 #ctxSumPane，R7 / R11）。数据源是 Host 持久化的 `item.summary`：
   * 有总结时显示 AI 标签、溯源、要点与「重新总结」；没有时显示空态和「生成总结」。
   * 发给 agent 与删除继续留在同一栏脚，保持 Lane A 已落的交互位置。
   */
  const ctxSumPane = (item: VoiceRecordingSegment): HTMLElement => {
    const pane = el("div", "ctx-pane");
    const transcript = item.transcriptText?.trim() ?? "";
    const summary = item.summary;
    const points = (summary?.points ?? []).filter((point) => point.trim().length > 0);
    const currentBusy = state.segmentSummarizing === item.id;
    const busy = state.segmentSummarizing !== undefined;
    const summarize = textEl(
      "button",
      "ctx-btn",
      () => currentBusy ? t("view.summarizing") : busy ? t("view.summarizingAnotherSegment") : points.length > 0 ? t("view.summarizeAgain") : t("view.generateSummary"),
    );
    summarize.type = "button";
    summarize.dataset.action = "summarize-segment";
    summarize.disabled = busy || transcript.length === 0;
    summarize.addEventListener("click", () => fire(() => actions.onSummarizeSegment(item.id)));
    if (currentBusy) {
      pane.append(diagnosticsBlock(`summary:${item.id}`, {
        state: "waiting",
        step: () => t("diagnostics.step.summarySegment"),
        ...waitSince(`summary:${item.id}`),
        details: [{ label: () => t("diagnostics.detail.recording"), tokens: () => [item.id] }],
      }));
    }

    const footer = el("div", "ctx-sum-ft");
    if (points.length > 0) {
      const header = el("div", "ctx-sum-h");
      const source = () => t("view.fromSegmentValueValueCharactersValue", { value0: clockTime(item.wallStartMs), value1: clockTime(item.wallStartMs + item.durationMs), value2: formatChars(contextCharacterCount(transcript)) });
      header.append(
        textEl("span", "ctx-sum-lb", () => t("view.aiSummary")),
        textEl(
          "span",
          "ctx-sum-src",
          () => summary?.dshSessionId ? source() : t("view.valueDshUnavailableGeneratedDirectlyByThe", { value0: source() }),
        ),
      );
      const list = el("div", "ctx-sum-l");
      for (const point of points) list.append(textEl("div", "ctx-sum-i", () => point));
      pane.append(header, list);
      footer.append(summarize);
    } else {
      const empty = el("div", "ctx-empty");
      empty.append(
        localizedTextNode(() => transcript ? t("view.thisSegmentHasNoSummaryYet") : t("view.thisSegmentIsStillBeingTranscribedWait")),
        document.createElement("br"),
        summarize,
      );
      pane.append(empty);
    }
    // A3-24「发给 agent」：只在装了 Agents·IM 时渲染（没装就该不存在，不画灰门）；
    // 装了还看这段有没有转写（V-9），没有就禁用而不是发空段。
    if (state.agentsImAvailable === true) {
      const sendToAgent = textEl("button", "ctx-btn", () => t("view.sendToAgent"));
      sendToAgent.type = "button";
      sendToAgent.dataset.action = "send-context-to-agent";
      sendToAgent.disabled = transcript.length === 0;
      bindAttribute(sendToAgent, "aria-label", () => t("view.sendTheSegmentFromValueToAgent", { value0: new Date(item.wallStartMs).toLocaleString() }));
      sendToAgent.addEventListener("click", () =>
        fire(() => actions.onSendContextToAgent(item.id)),
      );
      footer.append(sendToAgent);
    }
    // R17：删除靠右、红字无边框，与主动作隔开防误触；点下去先问一次。
    const remove = textEl("button", "ctx-btn danger", () => t("view.deleteThisRecording"));
    remove.type = "button";
    remove.dataset.action = "delete-recording";
    remove.addEventListener("click", () => {
      deleteAsk = item.id;
      render();
    });
    footer.append(remove);
    pane.append(footer);
    return pane;
  };

  /**
   * R17 删除确认层（稿 #ctxDelAsk）：删除不可逆，且删的是「记忆」——录音、文字、
   * 总结里的这一段一起没。默认焦点在「取消」；Esc = 取消；点遮罩 = 取消。只问这
   * 一次，确定就删，不再弹第二层。
   */
  const deleteAskLayer = (item: VoiceRecordingSegment): HTMLElement => {
    const layer = el("div", "voice-ask");
    layer.dataset.ask = "delete-recording";
    const dialog = el("div", "voice-ask-in");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    const title = textEl("div", "voice-ask-h", () => t("view.deleteThisRecording2"));
    title.id = "voice-ask-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const whichDay = () => segmentDayKey(item) === dayKeyOf(new Date()) ? t("view.today") : t("view.thatDay");
    const copy = textEl(
      "div",
      "voice-ask-p",
      () => t("view.thisCannotBeUndoneValueValue", { value0: clockTime(item.wallStartMs), value1: clockTime(item.wallStartMs + item.durationMs) })
        + t("view.theAudioAndTextForThisSegment", { value0: whichDay() }),
    );
    copy.id = "voice-ask-copy";
    dialog.setAttribute("aria-describedby", copy.id);
    const foot = el("div", "voice-ask-ft");
    const cancel = textEl("button", "ctx-btn", () => t("common.cancel"));
    cancel.type = "button";
    cancel.dataset.ask = "no";
    const confirm = textEl("button", "ctx-btn danger solid", () => t("common.delete"));
    confirm.type = "button";
    confirm.dataset.ask = "yes";
    const close = () => {
      deleteAsk = undefined;
      render();
    };
    cancel.addEventListener("click", close);
    confirm.addEventListener("click", () => {
      deleteAsk = undefined;
      // 先回列表再删：删除成功后 state 刷新会把这一段从列表里拿掉；失败时 error
      // 落在列表页的原地反馈里，段还在列表里可以再进来。
      releaseReplayAudio();
      page = "history";
      render();
      fire(() => actions.onDeleteRecording(item.id));
    });
    layer.addEventListener("click", (event) => {
      if (event.target === layer) close();
    });
    layer.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    foot.append(cancel, confirm);
    dialog.append(title, copy, foot);
    layer.append(dialog);
    // 默认焦点在「取消」：误按 Enter 不会删东西。节点进 DOM 之后才能聚焦。
    queueMicrotask(() => {
      if (!disposed && deleteAsk === item.id) cancel.focus();
    });
    return layer;
  };

  /** 已验收顺序：高频识别 → 云端润色 → 命令 → 本地记录 → 每日总结 → 系统。 */
  const renderSettings = () => {
    const view = el("main", "main-body voice-settings-view voice-settings-body");
    const intro = el("div", "voice-settings-intro");
    const introMain = el("div", "voice-settings-intro-main");
    // B5-14：设置页返回钮撤除——返回由 Host 面包屑承载（B2-3 通道已通）。
    const settingsLegacyBack = legacyBackButton();
    if (settingsLegacyBack) introMain.append(settingsLegacyBack);
    const group = el("div", "voice-settings-intro-copy");
    const titleRow = el("div", "voice-settings-intro-title-row");
    titleRow.append(textEl("div", "voice-settings-intro-title", () => t("view.voiceSettings")));
    const help = el("div", "voice-settings-help");
    // 稿 `vsChainQ`：页头问号里是「说完这句话之后」的 5 步链路图，不是功能清单。
    help.append(hintDetails(chainHint(), () => t("view.afterYouFinishSpeaking")));
    titleRow.append(help);
    group.append(titleRow, textEl("div", "voice-settings-intro-sub", () => t("view.configureWhatHappensAfterYouSpeak")));
    introMain.append(group);
    intro.append(introMain);

    // Local and cloud recognition share the same optional cloud processing step.
    // Its settings stay visible regardless of recognition engine or login state.
    const content = el("div", "settings-content");
    content.append(
      settingsSection(
        () => t("view.recordingRecognition"),
        engineSettings(),
        "engine",
        focusedSettingsTarget === "engine",
      ),
    );
    content.append(
      settingsSection(() => t("view.polish"), polishSettings(), "polish", focusedSettingsTarget === "polish"),
    );
    content.append(
      settingsSection(
        () => t("view.voiceCommands"),
        commandEventsEntry(),
        "commands",
        focusedSettingsTarget === "commands",
      ),
      settingsSection(
        () => t("view.recordingRetention"),
        replayCacheSettings(),
        "replay-cache",
        focusedSettingsTarget === "replay-cache",
        replayCacheHint(),
      ),
      settingsSection(
        () => t("view.dailySummary"),
        dailySummarySettings(),
        "summary",
        focusedSettingsTarget === "summary" || focusedSettingsTarget === "agent",
        undefined,
        () => t("view.beta"),
      ),
    );
    content.append(
      settingsSection(
        () => t("view.system"),
        permissionSettings(),
        "permissions",
        focusedSettingsTarget === "permissions",
      ),
    );
    if (state.error) content.prepend(inlineErrorBlock("inline-error settings-error"));
    view.append(intro, content);
    shell.append(view);
    if (languageDialogOpen) shell.append(languageDialog());
    if (sourceDialogOpen) shell.append(sourceDialog());
    if (summaryConsentOpen) shell.append(summaryConsentDialog());
    if (screenshotConsentOpen) shell.append(screenshotConsentDialog());
  };

  /** 设置主面按稿只留一条去路；三个真实事件与 Action 层开关放在独立子页。 */
  const commandEventsEntry = (): HTMLElement => {
    const card = el("div", "settings-card");
    const entry = el("button", "settings-row settings-row-action voice-events-entry");
    entry.type = "button";
    const copy = el("div", "settings-row-copy");
    copy.append(
      textEl("div", "settings-row-title", () => t("app.manageTriggerEvents")),
      textEl("div", "settings-row-sub", () => t("view.manageTranscriptionTranslationAskAgentAndTheir")),
    );
    entry.append(
      copy,
      textEl("span", "settings-row-value", () => t("view.eventsValue", { value0: COMMAND_EVENT_META.length })),
      iconEl("span", "settings-row-chevron", chevronRightIcon()),
    );
    entry.addEventListener("click", () => {
      focusedSettingsTarget = undefined;
      page = "events";
      render();
    });
    card.append(entry);
    const target = el("select", "settings-select");
    target.dataset.translationTarget = "true";
    bindAttribute(target, "aria-label", () => t("translation.target"));
    for (const language of Object.keys(TRANSLATION_LANGUAGES) as TranslationTarget[]) {
      const option = el("option", "");
      option.value = language;
      bindText(option, () => translationLabel(language));
      target.append(option);
    }
    target.value = state.featureSettings.translationTarget;
    target.addEventListener("change", () => {
      fire(() => actions.onFeatureSettingsChanged({ translationTarget: translationTarget(target.value) }));
    });
    const targetShell = el("div", "settings-select-shell");
    targetShell.append(target, iconEl("span", "settings-select-chevron", chevronDownIcon()));
    card.append(settingsRow(() => t("translation.target"), () => t("translation.description"), targetShell));
    return card;
  };

  const dailySummarySettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    let control: HTMLElement;
    if (!state.commandLoggedIn) {
      const actionsCell = el("span", "settings-row-value settings-row-chips");
      actionsCell.append(statusChip("warn", () => t("view.notSignedIn")));
      if (actions.onOpenAccountLogin) {
        const login = textEl("button", "secondary-button settings-inline-button", () => t("view.signIn2"));
        login.type = "button";
        login.dataset.action = "open-account-login";
        const openAccount = actions.onOpenAccountLogin;
        login.addEventListener("click", () => fire(() => openAccount()));
        actionsCell.append(login);
      }
      control = actionsCell;
    } else {
      control = switchControl(
        () => t("view.generateDailySummariesInTheCloud"),
        state.featureSettings.summaryEnabled,
        (checked) => {
          if (!checked) return actions.onFeatureSettingsChanged({ summaryEnabled: false });
          if (state.featureSettings.summaryConsent) {
            return actions.onFeatureSettingsChanged({ summaryEnabled: true });
          }
          summaryConsentOpen = true;
          render();
          return Promise.resolve();
        },
      );
      control.dataset.action = "summary-enabled";
    }
    card.append(settingsRow(
      () => t("view.cloudGeneration"),
      () => t("view.offByDefaultSendsOnlyValidTranscripts"),
      control,
    ));
    if (state.commandLoggedIn && state.featureSettings.summaryEnabled) {
      const mode = settingsSeg(
        () => t("view.dailySummaryGenerationMode"),
        [
          { value: "manual", get label() { return t("view.manual"); } },
          { value: "auto", get label() { return t("view.automatic"); } },
        ],
        state.featureSettings.summaryMode,
        (value) => fire(() => actions.onFeatureSettingsChanged({
          summaryMode: value === "auto" ? "auto" : "manual",
        })),
      );
      card.append(settingsRow(() => t("view.generationMode"), () => t("view.automaticModeUpdatesAtMostOnceAn"), mode));
    }
    return card;
  };

  const languageDialog = (): HTMLElement => {
    const layer = el("div", "voice-dialog-layer");
    const dialog = el("div", "voice-dialog voice-language-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "voice-language-title");
    const title = textEl("div", "voice-dialog-title", () => t("view.chooseRecognitionLanguage"));
    title.id = "voice-language-title";
    const modelName = () => state.settings.engine === "cloud"
      ? state.cloudModels.find((model) => model.id === state.featureSettings.cloudModelId)?.label
        ?? t("view.chooseACloudModel")
      : selectedModel(state)?.name ?? t("view.localModel");
    const list = el("div", "voice-dialog-list");
    list.setAttribute("role", "radiogroup");
    for (const language of RECOGNITION_LANGUAGES) {
      const selected = language.value === state.settings.language;
      const button = textEl(
        "button",
        selected ? "voice-dialog-option selected" : "voice-dialog-option",
        () => language.label,
      );
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.dataset.languageValue = language.value;
      if (selected) button.append(textEl("span", "voice-dialog-check", () => "✓"));
      button.addEventListener("click", () => {
        languageDialogOpen = false;
        fire(() => saveSettings({ language: language.value }));
        render();
      });
      list.append(button);
    }
    const cancel = textEl("button", "voice-dialog-button", () => t("common.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      languageDialogOpen = false;
      render();
    });
    closeDialogOnEscape(layer, () => cancel.click());
    dialog.append(
      title,
      textEl("div", "voice-dialog-sub", () => t("view.currentModelValue", { value0: modelName() })),
      list,
      el("div", "voice-dialog-foot"),
    );
    dialog.lastElementChild?.append(cancel);
    layer.append(dialog);
    layer.addEventListener("click", (event) => {
      if (event.target === layer) {
        languageDialogOpen = false;
        render();
      }
    });
    return layer;
  };

  const summaryConsentDialog = (): HTMLElement => {
    const layer = el("div", "voice-dialog-layer");
    const dialog = el("div", "voice-dialog voice-consent-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "voice-summary-consent-title");
    const title = textEl("div", "voice-dialog-title", () => t("view.enableCloudDailySummaries"));
    title.id = "voice-summary-consent-title";
    const usage = document.createElement("input");
    usage.type = "checkbox";
    const privacy = document.createElement("input");
    privacy.type = "checkbox";
    const check = (input: HTMLInputElement, heading: TextSource, copy: TextSource, risk = false) => {
      const label = el("label", "voice-consent-check");
      const body = el("span", "voice-consent-copy");
      body.append(
        textEl("strong", risk ? "voice-consent-risk" : "", () => heading),
        textEl("span", "", () => copy),
      );
      label.append(input, body);
      return label;
    };
    const confirm = textEl("button", "voice-dialog-button primary", () => t("view.confirmAndEnable"));
    confirm.type = "button";
    confirm.disabled = true;
    const sync = () => {
      confirm.disabled = !(usage.checked && privacy.checked);
    };
    usage.addEventListener("change", sync);
    privacy.addEventListener("change", sync);
    confirm.addEventListener("click", () => {
      if (confirm.disabled) return;
      summaryConsentOpen = false;
      fire(() => actions.onFeatureSettingsChanged({
        summaryConsent: true,
        summaryEnabled: true,
      }));
      render();
    });
    const cancel = textEl("button", "voice-dialog-button", () => t("common.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      summaryConsentOpen = false;
      render();
    });
    closeDialogOnEscape(layer, () => cancel.click());
    const foot = el("div", "voice-dialog-foot");
    foot.append(cancel, confirm);
    dialog.append(
      title,
      textEl("div", "voice-dialog-sub", () => t("view.sendsValidTranscriptsForTheSelectedDate")),
      check(usage, () => t("view.iUnderstandThatOnlineUsageMayBe"), () => t("view.moreRecordingsUseMoreResourcesAutomaticMode")),
      check(
        privacy,
        () => t("view.iAcceptThePrivacyRiskOfSending"),
        () => t("view.theProviderDoesNotProactivelyReadUser"),
        true,
      ),
      foot,
    );
    layer.append(dialog);
    return layer;
  };

  /** §5D 截图同意：单独确认框，云发送事实说清楚；同意按登录会话生效。 */
  const screenshotConsentDialog = (): HTMLElement => {
    const layer = el("div", "voice-dialog-layer");
    const dialog = el("div", "voice-dialog voice-consent-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "voice-screenshot-consent-title");
    const title = textEl("div", "voice-dialog-title", () => t("screenshot.dialogTitle"));
    title.id = "voice-screenshot-consent-title";
    const cloud = document.createElement("input");
    cloud.type = "checkbox";
    const label = el("label", "voice-consent-check");
    const copy = el("span", "voice-consent-copy");
    copy.append(
      textEl("strong", "voice-consent-risk", () => t("screenshot.riskTitle")),
      textEl("span", "", () => t("screenshot.riskCopy")),
    );
    label.append(cloud, copy);
    const confirm = textEl("button", "voice-dialog-button primary", () => t("screenshot.confirm"));
    confirm.type = "button";
    confirm.disabled = true;
    cloud.addEventListener("change", () => {
      confirm.disabled = !cloud.checked;
    });
    confirm.addEventListener("click", () => {
      if (confirm.disabled) return;
      screenshotConsentOpen = false;
      fire(() => actions.onScreenshotConsentConfirm());
      render();
    });
    const cancel = textEl("button", "voice-dialog-button", () => t("screenshot.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      screenshotConsentOpen = false;
      render();
    });
    closeDialogOnEscape(layer, () => cancel.click());
    const foot = el("div", "voice-dialog-foot");
    foot.append(cancel, confirm);
    dialog.append(
      title,
      textEl("div", "voice-dialog-sub", () => t("screenshot.dialogSub")),
      label,
      foot,
    );
    layer.append(dialog);
    return layer;
  };

  const renderEvents = () => {
    const view = el("main", "main-body voice-settings-view voice-settings-body voice-events-view");
    const intro = el("div", "voice-settings-intro");
    const introMain = el("div", "voice-settings-intro-main");
    const eventsLegacyBack = legacyBackButton();
    if (eventsLegacyBack) introMain.append(eventsLegacyBack);
    const group = el("div", "voice-settings-intro-copy");
    group.append(
      textEl("div", "voice-settings-intro-title", () => t("app.manageTriggerEvents")),
      textEl("div", "voice-settings-intro-sub", () => t("view.manageVoiceEventsAndTheirVisibilityIn")),
    );
    introMain.append(group);
    intro.append(introMain);
    const content = el("div", "settings-content");
    content.append(settingsSection(() => t("view.triggerEvents"), commandEventSettings(), "commands", false, commandEventsHint()));
    if (state.error) content.prepend(inlineErrorBlock("inline-error settings-error"));
    view.append(intro, content);
    shell.append(view);
  };

  const renderModels = () => {
    const view = el("main", "main-body voice-settings-view voice-settings-body voice-models-view");
    const intro = el("div", "voice-settings-intro");
    const introMain = el("div", "voice-settings-intro-main");
    const back = legacyBackButton();
    if (back) introMain.append(back);
    const copy = el("div", "voice-settings-intro-copy");
    copy.append(
      textEl("div", "voice-settings-intro-title", () => t("app.modelsRecognition")),
      textEl("div", "voice-settings-intro-sub", () => t("view.theseSettingsUsuallyOnlyNeedToBe")),
    );
    introMain.append(copy);
    intro.append(introMain);
    const content = el("div", "settings-content");
    content.append(
      settingsSection(
        () => t("view.localModel"),
        modelSettings(),
        "model",
        focusedSettingsTarget === "model",
      ),
    );
    if (state.error) content.prepend(inlineErrorBlock("inline-error settings-error"));
    view.append(intro, content);
    shell.append(view);
  };

  /**
   * 「触发事件」卡（稿 `vsCmdsHTML` 的 `.r3-cmd` 行）：行首事件图标、标题、
   * 「描述　·　结果：…」、「当前绑着它的键：chips」，右侧「挂到 Action 层」开关 + 小字。
   *
   * 挂上的那几条会出现在 Action 层的「挂上来的命令」分区里，按 Action 键直接使。
   * 不挂就没有——那一层是静态清单，不会自己冒出新条目。
   *
   * chips 那一行**有数据才画**：插件桥里没有读 Host 绑定表的方法（稿回稿 ①），
   * 画出来只能是编的。`state.commandKeyBindings` 等 Host 补桥方法后接上即可。
   */
  const commandEventSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    const mounted = new Set(state.mountedActionCommandIds);
    for (const event of COMMAND_EVENT_META) {
      const row = el("div", "command-event-row");
      row.dataset.commandEvent = event.id;
      row.append(iconEl("div", "command-event-icon", commandEventIcon(event.icon)));
      const body = el("div", "command-event-body");
      body.append(
        textEl("div", "command-event-title", () => event.title),
        textEl("div", "command-event-desc", () => t("view.valueResultValue", { value0: event.description, value1: event.outcome })),
      );
      const bindings = state.commandKeyBindings?.[event.id];
      if (bindings) {
        const sources = el("div", "command-event-sources");
        sources.append(localizedTextNode(() => t("view.keysCurrentlyBoundToThisEvent")));
        if (bindings.length === 0) {
          sources.append(textEl("span", "command-event-chip none", () => t("view.noKeysAreBoundYet")));
        } else {
          for (const label of bindings) sources.append(textEl("span", "command-event-chip", () => label));
        }
        body.append(sources);
      }
      const pinWrap = el("div", "command-event-pin");
      const pin = switchControl(
        () => t("view.showInTheActionLayerValue", { value0: event.title }),
        mounted.has(event.id),
        (checked) => actions.onActionMountChanged(event.id, checked),
      );
      pin.classList.add("settings-switch-small");
      pinWrap.append(pin, textEl("span", "command-event-pin-label", () => t("view.showInTheActionLayer")));
      row.append(body, pinWrap);
      card.append(row);
    }
    // 稿 :13308-13310 逐字：撤走绑定表之后留的唯一去路。一行，不解释，
    // 点过去就是键位映射页。整行可点，右值 + chev 与稿同形。
    const keymapJump = el("button", "settings-row settings-row-action");
    keymapJump.type = "button";
    keymapJump.dataset.keymapJump = "";
    const keymapCopy = el("div", "settings-row-copy");
    keymapCopy.append(
      textEl("div", "settings-row-title", () => t("view.whichKeysTriggerTheseCommands")),
      textEl("div", "settings-row-sub", () => t("view.leverPositionAndKeyCombinationsAreConfigured")),
    );
    keymapJump.append(
      keymapCopy,
      textEl("span", "settings-row-value", () => t("view.devicesKeyMapping")),
      iconEl("span", "settings-row-chevron", chevronRightIcon()),
    );
    keymapJump.addEventListener("click", () => {
      keymapJumpError = undefined;
      render();
      void actions
        .onOpenKeymap()
        .catch((cause) => {
          keymapJumpError = () => keymapJumpErrorText(cause, state.developerMode);
          keymapJumpErrorDetail = errorDetailFrom("keymap", cause);
        })
        .finally(() => render());
    });
    card.append(keymapJump);
    // 失败态诚实：任务槽是单例，忙 / 待返回要在卡片上原样说出来，不静默。
    // 稿里没有这段失败文案（稿内是纯前端跳转），这里是最小诚实文案，PR 已登记。
    if (keymapJumpError) {
      card.append(textEl("div", "settings-card-foot settings-card-foot-error", () => keymapJumpError));
      card.append(errorDiagnostics(`keymap:${keymapJumpErrorDetail?.at ?? ""}`, keymapJumpErrorDetail));
    }
    return card;
  };

  /** 本地只说本地，切到云端后第二行才承接登录或模型选择。 */
  const engineSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    const local = state.settings.engine !== "cloud";
    const seg = settingsSeg(
      () => t("view.recognitionEngine"),
      [
        { value: "local", get label() { return t("view.localEngine"); } },
        { value: "cloud", get label() { return t("view.cloudEngine"); } },
      ],
      state.settings.engine,
      (value) => fire(() => saveSettings({ engine: value === "cloud" ? "cloud" : "local" })),
      true,
    );
    card.append(settingsRow(
      () => t("view.engine"),
      () => local ? t("view.localFailuresNeverAutomaticallyUploadAudio") : t("view.recognizeSpeechUsingYourAccountSCloud"),
      seg,
    ));

    if (local) {
      const currentModel = selectedModel(state);
      const row = settingsLinkRow(
        () => t("view.localModel"),
        () => t("view.downloadsModelSelectionAndRecognitionDetails"),
        () => currentModel?.name ?? t("view.loadingLocalModels"),
        () => {
          page = "models";
          render();
        },
      );
      row.dataset.settingsTarget = "model";
      card.append(row);
      if (currentModel) { const status = localModelStatus(currentModel); if (status) card.append(status); }
    } else if (!state.commandLoggedIn) {
      const cloudCell = el("span", "settings-row-value settings-row-chips");
      cloudCell.append(statusChip("warn", () => t("view.notSignedIn")));
      if (actions.onOpenAccountLogin) {
        const login = textEl("button", "secondary-button settings-inline-button", () => t("view.signIn2"));
        login.type = "button";
        login.dataset.action = "open-account-login";
        const openAccount = actions.onOpenAccountLogin;
        login.addEventListener("click", () => fire(() => openAccount()));
        cloudCell.append(login);
      }
      card.append(settingsRow(
        () => t("view.cloudStatus"),
        () => actions.onOpenAccountLogin ? t("view.cloudModelsAreAvailableAfterSignIn") : t("view.signInThroughAccountInTheSidebar"),
        cloudCell,
      ));
    } else {
      const select = document.createElement("select");
      select.className = "settings-select settings-cloud-model";
      bindAttribute(select, "aria-label", () => t("view.chooseACloudModel"));
      const models = state.cloudModels.filter(model => model.kind === "transcribe" && validCloudOptionId(model.id));
      const selected = selectedCloudOption(models, state.featureSettings.cloudModelId);
      if (!selected) {
        const retainedId = state.featureSettings.cloudModelId;
        // 内部模型编号只在开发者模式出现；普通模式只说状态。
        const unavailable = option(() => state.developerMode && retainedId
          ? `${retainedId} · ${t("view.cloudOptionsUnavailable")}`
          : state.cloudModelsLoading ? t("view.cloudModelsLoading")
            : retainedId && validCloudOptionId(retainedId) ? t("view.previousCloudChoiceUnavailable") : t("view.noCloudOptionsYet"),
          retainedId || "cloud-unavailable");
        unavailable.disabled = true;
        select.append(unavailable);
      }
      // 设置页只列模型名称，不展示价格（2026-10-06 用户裁定）。
      for (const model of models) select.append(option(() => model.label, model.id));
      select.value = selected?.id ?? (state.featureSettings.cloudModelId || "cloud-unavailable");
      select.disabled = !!state.cloudModelsLoading || models.length === 0;
      // 后台刷新（已有列表）不禁用、不换占位，只在旁边转圈。
      select.setAttribute("aria-busy", String(!!state.cloudModelsLoading || !!state.cloudModelsRefreshing));
      select.addEventListener("change", () => {
        fire(() => actions.onFeatureSettingsChanged({ cloudModelId: select.value }));
      });
      const selectShell = el("div", "settings-select-shell");
      selectShell.append(select, iconEl("span", "settings-select-chevron", chevronDownIcon()));
      if (state.cloudModelsRefreshing && !state.cloudModelsLoading) {
        const refreshing = el("span", "settings-cloud-refreshing");
        refreshing.setAttribute("role", "status");
        bindAttribute(refreshing, "aria-label", () => t("view.cloudModelsRefreshing"));
        selectShell.append(refreshing);
      }
      card.append(settingsRow(
        () => t("view.cloudModel"),
        () => state.cloudModelsLoading ? t("view.cloudModelsLoading")
          : selected ? (state.featureSettings.cloudModelBillingPolicy === "free-only" ? t("view.cloudModelFreeOnly") : t("view.cloudOptionSaved"))
          : models.length === 0 && !state.developerMode
            ? cloudUnavailableHint()
            : models.length === 0 && validCloudOptionId(state.featureSettings.cloudModelId)
              ? t("view.cloudSelectionRetained") : t("view.cloudDefaultUnavailable"),
        selectShell,
      ));
      if (models.length === 0 || !selected || state.errorDetail?.step === "settingsSave") {
        const reload = textEl("button", "settings-link-btn", () => t("view.refresh")) as HTMLButtonElement;
        reload.type = "button";
        reload.disabled = !!state.cloudModelsLoading;
        reload.addEventListener("click", () => fire(() => actions.onRefresh()));
        card.append(reload);
        if (models.length === 0 && cloudNeedsReconnect() && actions.onOpenAppPermissions) {
          const openPermissions = actions.onOpenAppPermissions;
          const reconnect = textEl("button", "settings-link-btn", () => t("view.reconnectCloud")) as HTMLButtonElement;
          reconnect.type = "button";
          reconnect.dataset.action = "reconnect-cloud";
          reconnect.addEventListener("click", () => fire(() => openPermissions()));
          card.append(reconnect);
        }
      }
      // §6.0：读取云端选项的等待与失败在设置里同样说清步骤、已用时间、真实码与两端版本（开发者模式）；
      // 普通模式等待只剩中性的步骤与转圈，失败不挂诊断。
      if (state.cloudModelsLoading) {
        card.append(diagnosticsBlock("settings:cloud-models:loading", {
          state: "waiting", step: () => t("diagnostics.step.cloudModels"), ...waitSince("settings:cloud-models"),
        }));
      } else if (models.length === 0 && state.cloudModelsErrorDetail) {
        card.append(errorDiagnostics(`settings:cloud-models:${state.cloudModelsErrorDetail.at}`, state.cloudModelsErrorDetail));
      }
    }

    card.append(sourceRow());
    const sourceNotice = sourceAvailabilityNotice();
    if (sourceNotice) card.append(sourceNotice);
    if (state.settings.source === "system") card.append(systemEndpointRow());
    card.append(languageRow());
    card.append(maxRecordingRow());
    return card;
  };

  /**
   * 单次录音最长时间（1–10 分钟）。Host 回带 `captureLimitSeconds` 才算支持；旧 Host
   * 不回，置灰并按它固定的 120 秒显示，提示更新 ReAI Board。倒计时由 Host 胶囊负责。
   */
  const maxRecordingRow = (): HTMLElement => {
    const supported = state.captureLimitSeconds !== undefined;
    const minutes = supported
      ? sanitizeMaxRecordingMinutes(state.settings.maxRecordingMinutes)
      : LEGACY_CAPTURE_LIMIT_SECONDS / 60;
    const select = document.createElement("select");
    select.className = "settings-select settings-max-recording";
    bindAttribute(select, "aria-label", () => t("view.maxRecordingDurationCurrentValue", { value0: minutes }));
    for (let value = MIN_RECORDING_MINUTES; value <= MAX_RECORDING_MINUTES; value += 1) {
      select.append(option(() => t("view.maxRecordingMinutesOption", { value0: value }), String(value)));
    }
    select.value = String(minutes);
    select.disabled = !supported;
    select.addEventListener("change", () => {
      fire(() => saveSettings({ maxRecordingMinutes: sanitizeMaxRecordingMinutes(Number(select.value)) }));
    });
    const shell = el("div", "settings-select-shell settings-select-shell-compact");
    shell.append(select, iconEl("span", "settings-select-chevron", chevronDownIcon()));
    const row = settingsRow(
      () => t("view.maxRecordingDuration"),
      // 首次状态还没读回时不急着说「要更新」，只置灰。
      () => supported || state.statusLoad !== "loaded"
        ? t("view.maxRecordingDurationDesc") : t("view.maxRecordingDurationNeedsHostUpdate"),
      shell,
    );
    row.dataset.settingsTarget = "max-recording";
    if (!supported) row.dataset.hostUnsupported = "";
    return row;
  };

  /** 语言是集合选择，不做“点一下猜下一项”的轮换。 */
  const languageRow = (): HTMLElement => {
    const index = Math.max(
      0,
      RECOGNITION_LANGUAGES.findIndex((entry) => entry.value === state.settings.language),
    );
    const current = RECOGNITION_LANGUAGES[index] ?? RECOGNITION_LANGUAGES[0]!;
    const row = settingsLinkRow(
      () => t("view.recognitionLanguage"),
      () => t("view.usedForSpeechRecognitionAndPunctuationConventions"),
      () => current.label,
      () => {
        languageDialogOpen = true;
        render();
      },
    );
    bindAttribute(row, "aria-label", () => t("view.chooseRecognitionLanguageCurrentValue", { value0: current.label }));
    row.setAttribute("aria-haspopup", "dialog");
    row.dataset.languageRow = current.value;
    return row;
  };

  /** 五档的标题与说明（顺序即对话框顺序）。 */
  const audioModeCopy: Record<VoiceAudioSourceMode, { label: () => string; desc: () => string }> = {
    auto: { label: () => t("view.audioModeAuto"), desc: () => t("view.audioModeAutoDesc") },
    prefer_board: { label: () => t("view.audioModePreferBoard"), desc: () => t("view.audioModePreferBoardDesc") },
    prefer_computer: { label: () => t("view.audioModePreferComputer"), desc: () => t("view.audioModePreferComputerDesc") },
    board_only: { label: () => t("view.audioModeBoardOnly"), desc: () => t("view.audioModeBoardOnlyDesc") },
    computer_only: { label: () => t("view.audioModeComputerOnly"), desc: () => t("view.audioModeComputerOnlyDesc") },
  };
  const audioDisabledCopy: Record<AudioSourceDisabledReason, () => string> = {
    no_hardware: () => t("view.audioSourceNoHardware"),
    no_computer: () => t("view.audioSourceNoComputer"),
    no_microphone: () => t("view.audioSourceNoMicrophone"),
    host_upgrade: () => t("view.audioSourceNeedsHostUpgrade"),
  };

  /**
   * 稿 `data-vssource`：录音来源 › 行。值只写档位名（「推荐」只留在对话框里），说明行写当前
   * 实际在用的麦克风：键盘这边的 USB / 蓝牙按 Host 解析出的真实路由写，路由未知时只写「键盘麦克风」。
   * 各档完整解释只在点开的五档单选对话框里。
   */
  const sourceRow = (): HTMLElement => {
    const mode = currentAudioSourceMode(state.settings, state.permissions);
    const info = state.permissions.audioSources;
    const route = state.timeline?.route;
    const boardValue = () => route === "usb_vendor_hid" || route === "usb_uac"
      ? t("view.keyboardUsb")
      : route === "ble_gatt"
        ? t("view.keyboardBluetooth")
        : t("view.keyboardMicrophone");
    const resolved = info?.resolved
      ?? (state.settings.source === "system" ? "system" : "board");
    const now = () => resolved === "system"
      ? t("view.computerMicrophone")
      : resolved === "unavailable" ? t("view.audioSourceUnavailable") : boardValue();
    const modeLabel = () => isLegacyCompatibilityMode(state.permissions)
      ? t("view.audioSourceLegacyUac")
      : mode === "auto" ? t("view.audioModeAutoShort") : audioModeCopy[mode].label();
    const row = settingsLinkRow(
      () => t("view.recordingSource"),
      () => t("view.audioSourceCurrent", { value0: now() }),
      modeLabel,
      () => {
        sourceDialogOpen = true;
        render();
      },
    );
    row.dataset.settingsTarget = "source";
    row.dataset.audioSourceMode = mode;
    row.setAttribute("aria-haspopup", "dialog");
    if (focusedSettingsTarget === "source") row.classList.add("settings-target-flash");
    bindAttribute(row, "aria-label", () => t("view.recordingSourceValueClickToChoose", { value0: modeLabel(), value1: now() }));
    return row;
  };

  /**
   * 来源行下方的状态说明：两类麦都没有 → 语音不可用；电脑麦在场但未授权且当前档位可能用到它
   * → 授权引导（用户点按钮才请求系统权限；录音过程中从不请求）。
   */
  const sourceAvailabilityNotice = (): HTMLElement | undefined => {
    const info = state.permissions.audioSources;
    const mode = currentAudioSourceMode(state.settings, state.permissions);
    if (noMicrophoneAvailable(info)) {
      const note = el("div", "settings-note settings-note-warn voice-audio-source-note");
      note.dataset.audioSourceNotice = "no-microphone";
      note.append(textEl("span", "", () => t("view.noMicrophoneAvailable")));
      return note;
    }
    if (!shouldOfferComputerMicrophoneGrant(mode, info)) return undefined;
    const note = el("div", "settings-note voice-audio-source-note");
    note.dataset.audioSourceNotice = "grant-computer-microphone";
    const denied = state.permissions.microphone === "denied";
    note.append(textEl("span", "", () => denied ? t("view.computerMicrophoneDenied") : t("view.computerMicrophoneNotGranted")));
    if (!denied) {
      const grant = textEl("button", "settings-link-btn", () => t("view.grantComputerMicrophone")) as HTMLButtonElement;
      grant.type = "button";
      grant.dataset.grantComputerMicrophone = "";
      grant.addEventListener("click", () => fire(() => actions.onRequestPermission("microphone")));
      note.append(grant);
    }
    return note;
  };

  /** 五档单选。机器上没有某类麦时对应档 disabled 并写明原因。 */
  const sourceDialog = (): HTMLElement => {
    const layer = el("div", "voice-dialog-layer");
    const dialog = el("div", "voice-dialog voice-source-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "voice-source-title");
    const title = textEl("div", "voice-dialog-title", () => t("view.chooseRecordingSource"));
    title.id = "voice-source-title";
    const info = state.permissions.audioSources;
    const current = currentAudioSourceMode(state.settings, state.permissions);
    const legacy = isLegacyCompatibilityMode(state.permissions);
    const close = () => {
      sourceDialogOpen = false;
      render();
    };
    const list = el("div", "voice-dialog-list");
    list.setAttribute("role", "radiogroup");
    for (const mode of AUDIO_SOURCE_MODES) {
      const selected = !legacy && mode === current;
      const disabled = audioSourceModeDisabledReason(mode, info);
      const button = el("button", selected ? "voice-dialog-option voice-source-option selected" : "voice-dialog-option voice-source-option") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.dataset.audioSourceMode = mode;
      const copy = el("span", "voice-source-option-copy");
      copy.append(
        textEl("span", "voice-source-option-label", () => audioModeCopy[mode].label()),
        textEl("span", "voice-source-option-desc", () => disabled ? audioDisabledCopy[disabled]() : audioModeCopy[mode].desc()),
      );
      button.append(copy);
      if (selected) button.append(textEl("span", "voice-dialog-check", () => "✓"));
      if (disabled) {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.dataset.disabledReason = disabled;
      }
      button.addEventListener("click", () => {
        if (button.disabled) return;
        sourceDialogOpen = false;
        if (!selected) {
          fire(() => saveSettings(audioSourceModePatch(mode, hostSupportsFiveModes(state.permissions)), { audioSourceMode: mode }));
        }
        render();
      });
      list.append(button);
    }
    const cancel = textEl("button", "voice-dialog-button", () => t("common.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", close);
    closeDialogOnEscape(layer, close);
    dialog.append(
      title,
      textEl("div", "voice-dialog-sub", () => t("view.chooseRecordingSourceSub")),
      list,
      el("div", "voice-dialog-foot"),
    );
    dialog.lastElementChild?.append(cancel);
    layer.append(dialog);
    layer.addEventListener("click", (event) => {
      if (event.target === layer) close();
    });
    return layer;
  };

  /** 选了电脑麦克风才出现（稿无；挑哪只麦克风是真实需要，设备移除时不静默改用默认）。 */
  const systemEndpointRow = (): HTMLElement => {
    const endpoint = document.createElement("select");
    endpoint.className = "settings-select";
    bindAttribute(endpoint, "aria-label", () => t("view.systemInputDevice"));
    if (state.systemInputs.length === 0) {
      endpoint.append(option(() => t("view.noSystemInputDevicesAvailable"), ""));
      endpoint.disabled = true;
    } else {
      endpoint.append(option(() => t("view.systemDefaultDevice"), ""));
      for (const input of state.systemInputs) {
        endpoint.append(option(() => `${input.name}${input.isDefault ? t("view.default") : ""}`, input.id));
      }
      endpoint.value = state.settings.systemEndpointId ?? "";
    }
    endpoint.addEventListener("change", () => {
      fire(() => saveSettings({ systemEndpointId: endpoint.value || null }));
    });
    const shell = el("div", "settings-select-shell");
    const chevron = el("span", "settings-select-chevron");
    chevron.innerHTML = chevronDownIcon();
    chevron.setAttribute("aria-hidden", "true");
    shell.append(endpoint, chevron);
    return settingsRow(
      () => t("view.inputDevice"),
      () => t("view.pinsSelectionByDeviceUidRemovingThe"),
      shell,
    );
  };

  /**
   * 润色档位（设计稿「润色 › 注入前的处理」）。
   *
   * 三档是分段按钮而不是下拉：设计稿画的就是 `.seg`，而且三档要能一眼比出差别。
   */
  const polishSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    const current = state.settings.polish;
    const seg = settingsSeg(
      () => t("view.processingBeforeInsert"),
      POLISH_LEVELS.map((level) => ({ value: level.value, get label() { return level.label; } })),
      current,
      (value) => fire(() => saveSettings({ polish: value as VoicePolishSetting })),
    );
    // 插件设计规范 §6.1：首行 + 有内缩分隔与留白的反馈区；这里只调整 DOM 布局。
    // https://ai-board.reai.com/docs/plugin-design-system-v1#settings-content-layout
    const item = el("div", "settings-item");
    item.append(settingsRow(() => t("view.processingBeforeInsert"), () => "", seg));
    const feedback = el("div", "settings-feedback");
    const description = textEl("div", "settings-desc", () => POLISH_LEVELS.find((level) => level.value === current)?.description ?? "");
    description.id = "voice-polish-description";
    description.setAttribute("aria-live", "polite");
    seg.setAttribute("aria-describedby", description.id);
    feedback.append(description);
    item.append(feedback);
    card.append(item);
    // 原样注入这一档根本不发请求，说它「会失败回退」是无中生有；只有真会走云端的
    // 两档才提这件事，而且必须说清楚失败时发生了什么——用户等的是文字进输入框。
    if (current !== "raw") {
      const note = el("div", "settings-note settings-policy");
      note.append(
        textEl("strong", "settings-note-title", () => t("view.whatHappensOnFailure")),
        textEl(
          "span",
          "",
          () => t("view.polishingUsesCloudTextGenerationAndRequires"),
        ),
      );
      feedback.append(note);
      // 写回权限被拒时润色根本没法生效（文字由插件写入，而那道权限是用户可拒的）。
      // 这时候必须把话说明白，否则用户只会看到「选了润色但一直是原样」。
      if (state.deliveryPermissionBlocked) {
        const blocked = el("div", "settings-note settings-note-warn");
        blocked.append(
          textEl("strong", "settings-note-title", () => t("view.polishingPaused")),
          textEl(
            "span",
            "",
            // 「切一下」而不是「再选一次」：分段按钮点已选中项不触发变更，
            // 用户照着「再选一次」做会什么都没发生。
            () => t("view.textInsertionPermissionIsDisabledInInstalled"),
          ),
          statusChip("warn", () => t("view.blockedBeforeRecording")),
        );
        feedback.append(blocked);
      }
      // §5D 截图同意：独立开关、默认关、只对云端两档有意义（原样档什么都不发）。
      const consentSwitch = switchControl(
        () => t("screenshot.switchLabel"),
        state.screenshotConsent.enabled,
        (checked) => {
          if (!checked) return actions.onScreenshotConsentRevoked();
          screenshotConsentOpen = true;
          render();
          return Promise.resolve();
        },
      );
      card.append(settingsRow(
        () => t("screenshot.rowTitle"),
        () => t("screenshot.rowDescription"),
        consentSwitch,
      ));
    }
    return card;
  };

  /**
   * 录音缓存块：全天存档开关 + 保留多久 + 占用 + 清空。
   * 全天存档只决定要不要长期保存全天转写（Context 档 / 每日记录），常驻收音不受它控制；
   * 按 2026-10-15 用户拍板，开关旁不放解释性说明，只有标签。
   */
  const replayCacheSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    // 开关读 Host 时间线真值；点下还没确认时按目标值显示（任何重渲染都不把它拨回去）；
    // 读不到时间线（未加载 / 旧 Host）时禁用，不猜状态。
    const archive = switchControl(
      () => t("view.allDayArchive"),
      state.continuousRecordingPending ?? state.timeline?.continuousRecordingEnabled === true,
      (checked) => actions.onContinuousRecording(checked),
    );
    archive.dataset.continuousRecording = "";
    archive.disabled = !state.timeline;
    card.append(settingsRow(() => t("view.allDayArchive"), () => "", archive));
    const current = state.replayCache?.retention ?? "24h";
    const seg = el("div", "settings-seg");
    seg.setAttribute("role", "radiogroup");
    bindAttribute(seg, "aria-label", () => t("view.recordingRetention2"));
    for (const entry of REPLAY_RETENTIONS) {
      const button = textEl(
        "button",
        entry.id === current ? "active" : "",
        () => entry.label,
      );
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(entry.id === current));
      button.dataset.replayRetention = entry.id;
      button.disabled = !state.replayCache;
      button.addEventListener("click", () => {
        if (entry.id === current) return;
        fire(() => actions.onReplayRetentionChanged(entry.id));
      });
      seg.append(button);
    }
    // 稿子里这一行只有标题，没有第二行——「它管的是声音不是文字」那句话收在问号里，
    // 摆回正文就是把已经收进去的东西又抖出来。四档与标题同一行（稿 .row 不换行）。
    card.append(settingsRow(
      () => t("view.retentionPeriod"),
      () => t("view.keepsOnlyRecordingsWithValidTextFor"),
      seg,
    ));

    const selected = REPLAY_RETENTIONS.find((entry) => entry.id === current);
    // 「选哪一档」要能对着代价比，所以占用与它的因果必须写在一起。
    card.append(settingsRow(
      () => t("view.storageUsed"),
      () => t("view.valueRecordingsBeyondTheRetentionPeriodAre", { value0: selected?.scope ?? t("view.fallback3") }),
      textEl(
        "span",
        "settings-row-value",
        () => formatBytes(state.replayCache?.usedBytes ?? 0),
      ),
    ));

    const clear = el("button", "settings-row settings-row-action settings-row-danger");
    clear.type = "button";
    const clearCopy = el("div", "settings-row-copy");
    clearCopy.append(
      textEl("div", "settings-row-title", () => t("view.clearVoiceHistoryNow")),
      textEl("div", "settings-row-sub", () => t("view.deleteLocallySavedTranscriptsAndTheirRecordings")),
    );
    clear.append(clearCopy, iconEl("span", "settings-row-chevron", chevronRightIcon()));
    clear.disabled = !state.replayCache
      || (state.replayCache.clipCount === 0 && state.recordingsTotal === 0 && state.history.length === 0);
    clear.addEventListener("click", () => fire(() => actions.onClearReplayCache()));
    card.append(clear);
    return card;
  };

  const option = (label: TextSource, value: string): HTMLOptionElement => {
    const element = document.createElement("option");
    bindText(element, () => label);
    element.value = value;
    return element;
  };

  /**
   * 「模型说明」段：稿是一段两行 note；产品里它是真实的本地模型列表（v17 B8 已记
   * 「模型说明变真模型列表」），note 照稿放在列表下面。稿第三行「横向对比见仓库内
   * 对比报告（阶段 5 E-1 产出后放链接）」是占位，不进产品。
   * 语音活动检测 / 文本规范化两个识别细节开关也落在这里（原「语音输入」段拆散归位）。
   */
  const modelSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    if (state.models.length === 0) {
      card.append(textEl("div", "settings-loading", () => t("view.loadingLocalModels")));
    } else {
      for (const model of state.models) card.append(modelRow(model));
    }
    card.append(toggleRow(
      () => t("view.voiceActivityDetection"),
      () => t("view.removeLeadingAndTrailingSilenceWithoutCutting"),
      state.settings.vadEnabled,
      (checked) => saveSettings({ vadEnabled: checked }),
    ));
    card.append(toggleRow(
      () => t("view.textNormalization"),
      () => t("view.formatNumbersAndDatesAsWrittenText"),
      state.settings.punctEnabled,
      (checked) => saveSettings({ punctEnabled: checked }),
      () => t("view.controlsInverseTextNormalizationItnSuchAs"),
    ));
    const details = el("details", "settings-model-details");
    const summary = textEl("summary", "settings-model-summary", () => t("view.viewModelDetails"));
    const note = el("div", "settings-note settings-note-model");
    note.append(
      textEl("strong", "settings-note-title", () => t("view.smallLocalModel")),
      textEl("span", "", () => t("view.transcriptionRunsOnThisDeviceOfflineAnd")),
      document.createElement("br"),
      textEl("strong", "settings-note-title", () => t("view.largeCloudModel")),
      textEl("span", "", () => t("view.betterAccuracyAndContextUnderstandingRequiresSign")),
    );
    details.append(summary, note);
    card.append(details);
    return card;
  };

  const localModelStatus = (model: VoiceModelInfo): HTMLElement | undefined => {
    const local = state.localDownloads?.[model.id];
    const available = model.state === "ready" || model.state === "active";
    if (available && !local) return;
    const phase = local?.phase ?? model.state;
    const row = el("div", "local-model-status");
    row.dataset.modelState = phase;
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");
    const line = el("div", "local-model-status-line");
    const bytes = Math.max(0, Math.min(model.downloadedBytes ?? 0, model.sizeBytes));
    const progress = model.state === "downloading" || model.resumeAvailable === true;
    const message = () => phase === "completed" ? t("download.completed")
      : phase === "preparing" ? t("download.preparing")
      : phase === "cancelling" ? t("download.cancelling")
      : phase === "cancelled" ? t("download.cancelled")
      : phase === "failed" ? (state.developerMode ? local?.error ?? model.error : undefined) ?? t("download.failed")
      : model.state === "downloading" ? t("download.downloading")
      : model.resumeAvailable ? t("download.retained") : t("download.missing");
    line.append(textEl("span", "", message));
    if (phase !== "completed") {
      const cancel = phase === "preparing" || phase === "cancelling" || model.state === "downloading";
      const button = textEl("button", "secondary-button", () => cancel ? t("view.cancelDownload")
        : model.resumeAvailable ? t("download.resume") : phase === "failed" ? t("download.retry") : t("view.download"));
      button.type = "button";
      button.disabled = phase === "cancelling";
      button.addEventListener("click", () => fire(() => cancel
        ? actions.onCancelModelDownload(model.id) : actions.onDownloadModel(model.id)));
      line.append(button);
    }
    row.append(line);
    if (phase === "failed") {
      row.append(modelFailureDiagnostics(`model:${model.id}:${local?.sinceMs ?? ""}`, model));
    } else if (phase === "preparing" || phase === "cancelling" || model.state === "downloading") {
      row.append(diagnosticsBlock(`model:${model.id}:${phase}`, {
        state: "waiting",
        step: () => t(phase === "cancelling" ? "diagnostics.step.modelCancel" : "diagnostics.step.modelDownload", { name: diagnosticModelName(model.id) }),
        ...waitSince(`model:${model.id}:${phase === "cancelling" ? "cancel" : "download"}`, local?.sinceMs),
        details: [
          { label: () => t("diagnostics.detail.model"), tokens: () => [diagnosticModelToken(model.id, "local"), model.state] },
          { label: () => t("diagnostics.detail.progress"), tokens: () => [model.downloadedBytes ?? 0, model.sizeBytes] },
        ],
      }));
    }
    if (progress && model.sizeBytes > 0) {
      const percent = Math.max(0, Math.min(100, Math.round(bytes / model.sizeBytes * 100)));
      const track = el("div", "model-progress-track");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(percent));
      bindAttribute(track, "aria-label", () => t("view.downloadProgressForValue", { value0: model.name }));
      const fill = el("span", "model-progress-fill"); fill.style.width = percent + "%"; track.append(fill);
      row.append(track, textEl("span", "model-progress-label", () => percent + "% · " + formatBytes(bytes) + " / " + formatBytes(model.sizeBytes)));
    }
    return row;
  };

  const modelRow = (model: VoiceModelInfo): HTMLElement => {
    const updateAvailable = hasModelUpdate(model);
    const action = textEl("button", "secondary-button", () => modelActionLabel(model));
    action.type = "button";
    bindAttribute(action, "aria-label", () => `${model.name}：${modelActionLabel(model)}`);
    action.disabled = (model.active || model.state === "active") && !updateAvailable;
    action.addEventListener("click", () => {
      if (model.state === "downloading") fire(() => actions.onCancelModelDownload(model.id));
      else if (updateAvailable) fire(() => actions.onDownloadModel(model.id));
      else if (model.active || model.state === "active") return;
      else if (model.state === "missing" || model.state === "failed") fire(() => actions.onDownloadModel(model.id));
      else if (!model.active) fire(() => saveSettings({ modelId: model.id }));
    });
    const trailing = ["ready", "active"].includes(model.state) ? action : el("span", "settings-row-value");
    const row = settingsRow(() => model.name, () => modelDescription(model, state.developerMode), trailing);
    const status = localModelStatus(model);
    if (status) row.append(status);
    return row;
  };

  const permissionSettings = (): HTMLElement => {
    const card = el("div", "settings-card");
    const permissions = el("button", "settings-row settings-row-action");
    permissions.type = "button";
    permissions.dataset.action = "open-permission-settings";
    bindAttribute(permissions, "aria-label", () => t("view.openPrivacySecurityInSystemSettings"));
    const copy = el("div", "settings-row-copy");
    copy.append(
      textEl("div", "settings-row-title", () => t("view.privacySecurity")),
      textEl("div", "settings-row-sub", () => t("view.seeTheSystemPermissionsRequiredByYour")),
    );
    permissions.append(
      copy,
      iconEl("span", "settings-external-link", externalLinkIcon()),
    );
    permissions.addEventListener("click", () => {
      fire(() => actions.onOpenPermissionSettings?.() ?? Promise.resolve());
    });
    card.append(permissions);
    return card;
  };
  const saveSettings = async (next: Partial<VoiceInputSettings>, options?: VoiceSettingsChangeOptions) => {
    await actions.onSettingsChanged(next, options);
  };

  const fire = (action: () => Promise<unknown>) => {
    void action().catch(() => {
      // App 层会把可读错误发布回 state；这里仅终止 DOM 事件产生的 rejected Promise。
    });
  };

  root.lang = voiceLocale();
  const stopLocale = onVoiceLocaleChange(() => { root.lang = voiceLocale(); reportNav(true); });
  render();
  return {
    setConversationOpenPending(pending) {
      conversationOpenPending = pending;
      if (!pending) reportNoticeWhenVisible();
    },
    openSettings(target) {
      openSettings(target);
    },
    openConversation(entityId, options) {
      const item = state.commandHistory.find(
        (entry) =>
          entry.id === entityId
          || entry.runId === entityId
          || entry.agentSessionId === entityId,
      );
      if (!item) return false;
      releaseReplayAudio();
      chatDetail.reset();
      if (options?.focusComposer) {
        chatDetail.focusComposerOnNextMount();
        skipViewPositionRestoreOnce = true;
      }
      leaveListTransient();
      selectedId = item.id;
      page = commandDetailPage(item);
      openingConversation = true;
      try { render(); } finally { openingConversation = false; }
      return true;
    },
    waitForConversationLanding(entityId, current) {
      const item = state.commandHistory.find(entry => entry.id === entityId
        || entry.runId === entityId || entry.agentSessionId === entityId);
      const landed = () => !!item && current() && !disposed && frame.parentNode === root
        && frame.isConnected && selectedId === item.id && page === commandDetailPage(item)
        && !!shell.querySelector(".main-body");
      if (!landed()) return Promise.resolve(false);
      return new Promise(resolve => {
        let finished = false;
        const finish = (value: boolean) => {
          if (finished) return;
          finished = true;
          window.clearTimeout(timer);
          resolve(value);
        };
        const timer = window.setTimeout(() => finish(false), 1_500);
        window.requestAnimationFrame(() => {
          if (!landed()) { finish(false); return; }
          window.requestAnimationFrame(() => finish(landed()));
        });
      });
    },
    navigateSettings() {
      releaseReplayAudio();
      chatDetail.reset();
      leaveListTransient();
      dismissSettingsFocus();
      if (page !== "settings") {
        page = "settings";
        render();
      }
    },
    navigateRoot() {
      pendingConversation = undefined;
      conversationOpenPending = false;
      actions.onConversationNavigation?.();
      // 与 openSettings 同一套「离开当前页」的收口：回听音频停掉、聊天输入的
      // 瞬态（草稿/录音态）复位，再把 page 归位重渲染。幂等：已在主列表时空跑。
      releaseReplayAudio();
      chatDetail.reset();
      leaveListTransient();
      dismissSettingsFocus();
      page = "history";
      render();
    },
    toggleSettings() {
      if (page === "settings" || page === "events" || page === "models") this.navigateRoot();
      else this.openSettings();
    },
    update(next) {
      state = next;
      // 对话页的追问落地后把页切到新条目（在 render 之前，切完这一帧就画新条目）。
      chatDetail.onStateChanged(next);
      render();
    },
    dispose() {
      if (disposed) return;
      actions.onConversationNavigation?.();
      disposed = true;
      window.clearInterval(elapsedTicker);
      if (timelineStartingTimer !== undefined) clearTimeout(timelineStartingTimer);
      for (const timer of copyFeedbackTimers) window.clearTimeout(timer);
      copyFeedbackTimers.clear();
      stopLocale();
      releaseReplayAudio();
      chatDetail.reset();
      activeHintClose?.();
      stopSettingsFocusListeners();
      if (mountedNotice) {
        document.removeEventListener("visibilitychange", onNoticeVisibilityChanged);
      }
      // A retired async mount can finish cleanup after a newer mount reused root.
      // Release only this view's bindings and leave the newer frame in place.
      const ownsRoot = frame.parentNode === root;
      releaseLocaleBindings(frame);
      layout?.dispose();
      if (ownsRoot) root.replaceChildren();
    },
  };
}

function settingsSection(
  title: TextSource,
  content: HTMLElement,
  target: VoiceSettingsTarget,
  focused = false,
  hint?: HTMLElement,
  badge?: TextSource,
): HTMLElement {
  const section = el("section", "settings-section");
  section.dataset.settingsTarget = target;
  section.tabIndex = -1;
  if (focused) section.classList.add("settings-target-flash");
  const heading = el("div", "settings-section-heading");
  heading.append(textEl("h2", "settings-section-title", () => title));
  if (readText(badge)) {
    const marker = textEl("span", "settings-dev-badge", () => badge);
    marker.dataset.devBadge = target;
    heading.append(marker);
  }
  if (hint) heading.append(hintDetails(hint, () => title));
  section.append(heading, content);
  return section;
}

/**
 * 「录音缓存」的问号说明。它讲的是原理，属于用户只看一次的东西，
 * 所以收在标题旁边、点开才展开，不摆进正文第一屏替他阅读。
 */
function replayCacheHint(): HTMLElement {
  const hint = document.createElement("div");
  hint.append(
    textEl("strong", "", () => t("view.thisControlsAudioNotText")),
    localizedTextNode(() => t("view.transcriptsAreRetainedIndependentlyThisLimitApplies")),
    document.createElement("br"),
    textEl("strong", "", () => t("view.whereToListenToRecordings")),
    localizedTextNode(() => t("view.openAnInputEntryInVoiceTo")),
    document.createElement("br"),
    textEl("strong", "", () => t("view.minimumRetentionPeriod")),
    localizedTextNode(() => t("view.hoursEvenIfYouCancelTranscriptionWith")),
    document.createElement("br"),
    localizedTextNode(() => t("view.recordingsStayOnThisComputerAndAre")),
  );
  return hint;
}

/** 「命令事件」只解释共用胶囊规则和按键配置去路。 */
function commandEventsHint(): HTMLElement {
  const hint = document.createElement("div");
  hint.append(
    textEl("strong", "", () => t("view.toggleBehavior")),
    localizedTextNode(() => t("view.whenIdleAnEventStartsItsCommand")),
    document.createElement("br"),
    localizedTextNode(() => t("view.theThreeCommandsAreMutuallyExclusiveAnd")),
  );
  return hint;
}

/**
 * 跳转行失败的诚实文案。Host 的任务槽是单例：固件升级进行中会得到
 * SYSTEM_TASK_BUSY，上一个任务还在等「返回 / 关闭」会得到 SYSTEM_TASK_RETURN_PENDING
 * ——两种都不是「跳转失败」，是「现在跳不了」，原因要原样说给用户。
 */
function jumpErrorText(scope: string, cause: unknown, developerMode: boolean): string {
  // 与 keymapJumpErrorText 同一判据集合；scope 仅用于排查日志与未来差异化文案。
  void scope;
  return keymapJumpErrorText(cause, developerMode);
}

function keymapJumpErrorText(cause: unknown, developerMode: boolean): string {
  const code =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "";
  if (code === "SYSTEM_TASK_BUSY") return t("view.cannotNavigateNowASystemTaskIs");
  if (code === "SYSTEM_TASK_RETURN_PENDING") {
    return t("view.cannotNavigateNowThePreviousSystemTask");
  }
  // 上游原文只在开发者模式拼进主句；普通模式给固定人话。
  if (!developerMode) return t("view.cannotNavigateNowTryAgainLater");
  const message =
    cause && typeof cause === "object"
      ? (cause as { userMessage?: unknown; message?: unknown })
      : undefined;
  const text =
    typeof message?.userMessage === "string"
      ? message.userMessage
      : typeof message?.message === "string"
        ? message.message
        : "";
  return text ? t("view.cannotNavigateNowValue", { value0: text }) : t("view.cannotNavigateNowTryAgainLater");
}

function settingsRow(
  title: TextSource,
  subtitle: TextSource,
  control: HTMLElement,
  hint?: TextSource,
): HTMLElement {
  const row = el("div", "settings-row");
  const copy = el("div", "settings-row-copy");
  const titleEl = readText(hint) ? titleWithHint(() => title, () => hint) : textEl("div", "settings-row-title", () => title);
  copy.append(titleEl);
  // 空副标题不占位：留一个空 div 会把行高撑成两行，与只有标题的那一行对不齐。
  if (readText(subtitle)) copy.append(textEl("div", "settings-row-sub", () => subtitle));
  row.append(copy, control);
  return row;
}

/**
 * 稿 `.row[data-…] > .rl + .rv + .chev` 的可点行：左边标题 + 副文案，右边当前值 + ›。
 * 整行是一颗按钮（与 settings-row-action 同一套 hover / 焦点）。
 */
function settingsLinkRow(
  title: TextSource,
  subtitle: TextSource,
  value: TextSource,
  onClick: () => void,
): HTMLButtonElement {
  const row = el("button", "settings-row settings-row-action settings-row-link");
  row.type = "button";
  const copy = el("div", "settings-row-copy");
  copy.append(textEl("div", "settings-row-title", () => title));
  if (readText(subtitle)) copy.append(textEl("div", "settings-row-sub", () => subtitle));
  row.append(
    copy,
    textEl("span", "settings-row-value", () => value),
    iconEl("span", "settings-row-chevron", chevronRightIcon()),
  );
  row.addEventListener("click", onClick);
  return row;
}

/**
 * 开关（稿 `.tog` 42×26 / 事件页 `.r3-pin` 34×20 同一套，后者加 `settings-switch-small`）。
 * 是一颗 `role="switch"` 的按钮而不是原生 checkbox：稿画的就是滑块，而且
 * 原生 checkbox 的 `accent-color` 在插件隔离 WebView 里拿不到 Host 的主题 token。
 */
function switchControl(
  label: TextSource,
  checked: boolean,
  onChange: (checked: boolean) => Promise<unknown>,
): HTMLButtonElement {
  const button = el("button", checked ? "settings-switch on" : "settings-switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(checked));
  bindAttribute(button, "aria-label", () => label);
  button.append(el("i", "settings-switch-knob"));
  button.addEventListener("click", () => {
    // 点下去就先把滑块翻过去（乐观），真源回来时 render 会校正；失败由 App 层发布可读错误。
    const next = button.getAttribute("aria-checked") !== "true";
    button.classList.toggle("on", next);
    button.setAttribute("aria-checked", String(next));
    void onChange(next).catch(() => undefined);
  });
  return button;
}

function toggleRow(
  title: TextSource,
  subtitle: TextSource,
  checked: boolean,
  onChange: (checked: boolean) => Promise<unknown>,
  hint?: TextSource,
): HTMLElement {
  return settingsRow(() => title, () => subtitle, switchControl(() => title, checked, onChange), () => hint);
}

/**
 * 分段按钮（design/VoiceType_UI_Designs.html 的 `.seg` 组件）。二选一场景
 * 里设计稿明确画的就是这个，不是原生 select——照稿子来，不自造视觉。
 */
function settingsSeg(
  groupLabel: TextSource,
  options: Array<{ value: string; label: string; disabled?: boolean; title?: string }>,
  selected: string,
  onChange: (value: string) => void,
  allowReselect = false,
): HTMLElement {
  const seg = el("div", "settings-seg");
  // 互斥单选、没有面板切换，语义上是 radiogroup 不是 tablist——文件里另一处
  // 分段式控件（VOICE_TABS）用的是 tablist/aria-selected，那个场景是真的在切
  // 不同内容面板；这里选中项代表的是一项持久设置，radiogroup/aria-checked
  // 才是对的角色，不能因为视觉像就照抄 tablist 那一套。
  seg.setAttribute("role", "radiogroup");
  bindAttribute(seg, "aria-label", () => groupLabel);
  for (const item of options) {
    const button = textEl("button", item.value === selected ? "active" : "", () => item.label);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(item.value === selected));
    button.dataset.settingValue = item.value;
    button.disabled = item.disabled === true;
    // 稿 `.seg button:disabled`：禁用项要说明为什么（title），不能只是灰着。
    if (item.title) bindAttribute(button, "title", () => item.title);
    button.addEventListener("click", () => {
      if (item.value === selected && !allowReselect) return;
      onChange(item.value);
    });
    seg.append(button);
  }
  return seg;
}

/** 状态徽标（design/VoiceType_UI_Designs.html 的 `.vs-chip` 组件）。 */
function statusChip(kind: "ok" | "warn" | "mut", text: TextSource): HTMLElement {
  return textEl("span", `settings-chip ${kind}`, () => text);
}

/**
 * 标题旁的「问号」说明：默认收起，点开才展开（不是 hover）——D-1 总纲反复
 * 强调「设置页大段说明就是消耗用户注意力」，解释性内容一律收进这里。
 */
function titleWithHint(title: TextSource, hint: TextSource): HTMLElement {
  const wrap = el("div", "settings-row-title settings-row-title-hint");
  wrap.append(textEl("span", "", () => title), hintDetails(hint, () => title));
  return wrap;
}

let activeHintClose: (() => void) | undefined;
let hintSequence = 0;

function hintDetails(content: TextSource | HTMLElement, label: TextSource = () => t("view.help")): HTMLElement {
  const wrap = el("span", "settings-hint");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-hint-trigger";
  bindAttribute(button, "aria-label", () => label);
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = helpCircleIcon();

  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") {
      activeHintClose?.();
      return;
    }
    activeHintClose?.();
    const panel = !(content instanceof HTMLElement)
      ? textEl("div", "settings-hint-panel", () => content)
      : content;
    panel.classList.remove("settings-hint-body");
    panel.classList.add("settings-hint-panel");
    panel.prepend(textEl("span", "settings-hint-title", () => label));
    panel.id = `voice-settings-hint-${++hintSequence}`;
    panel.setAttribute("role", "tooltip");
    button.setAttribute("aria-describedby", panel.id);
    button.setAttribute("aria-expanded", "true");
    document.body.append(panel);

    const position = () => computePosition(button, panel, {
      strategy: "fixed",
      placement: "bottom-start",
      middleware: [offset(8), flip({ padding: 10 }), shift({ padding: 10 })],
    }).then(({ x, y }) => {
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    });
    void position().catch(() => undefined);
    let stopAutoUpdate: () => void = () => undefined;
    try {
      stopAutoUpdate = autoUpdate(button, panel, () => void position().catch(() => undefined));
    } catch {
      window.addEventListener("resize", position);
      stopAutoUpdate = () => window.removeEventListener("resize", position);
    }
    const close = () => {
      stopAutoUpdate();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      panel.remove();
      button.setAttribute("aria-expanded", "false");
      button.removeAttribute("aria-describedby");
      if (activeHintClose === close) activeHintClose = undefined;
    };
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && (panel.contains(target) || button.contains(target))) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法组字中的 Esc 原样放行。
      if (event.key !== "Escape" || event.isComposing) return;
      // 声明本层已消费这次 Esc（surface.escape@1）：Host 不再把它当成返回上一页。
      event.preventDefault();
      close();
      button.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    activeHintClose = close;
  });
  wrap.append(button);
  return wrap;
}

/**
 * 页头问号里的链路图（稿 `vsChainHTML`）：说话 → 命令事件 → 工作流 → 跑得久(虚) → 做完了(虚)。
 * 它讲的是原理，属于「用户只看一次」的东西，所以收进问号，不摆在第一屏。
 */
function chainHint(): HTMLElement {
  const wrap = document.createElement("div");
  const chain = el("div", "settings-chain");
  const steps: Array<{ k: string; t: string; d: string; optional?: boolean }> = [
    { get k() { return t("view.speak"); }, get t() { return t("view.saySomething"); }, get d() { return t("view.holdTheVoiceKeyOrYourAssigned"); } },
    { get k() { return t("view.commandEvent"); }, get t() { return t("view.becomesACommandEvent"); }, get d() { return t("view.transcribeTranslateAskAgent"); } },
    { get k() { return t("view.workflow"); }, get t() { return t("view.completeTheSelectedCommand"); }, get d() { return t("view.sharedPolishingComesFirstFollowedByEach"); } },
    { get k() { return t("view.longerTask"); }, get t() { return t("view.movesIntoTheDesktopCapsule"); }, get d() { return t("view.continuesWithoutTheWindowInFront"); }, optional: true },
    { get k() { return t("view.finished"); }, get t() { return t("view.systemNotificationNotificationHistory"); }, get d() { return t("view.theResultStaysInTheConversation"); }, optional: true },
  ];
  steps.forEach((step, index) => {
    if (index > 0) chain.append(textEl("div", "settings-chain-arrow", () => "→"));
    const box = el("div", step.optional ? "settings-chain-step optional" : "settings-chain-step");
    box.append(
      textEl("div", "settings-chain-k", () => step.k),
      textEl("div", "settings-chain-t", () => step.t),
      textEl("div", "settings-chain-d", () => step.d),
    );
    chain.append(box);
  });
  wrap.append(
    chain,
    textEl(
      "div",
      "settings-chain-foot",
      () => t("view.theTwoDashedStepsAreOptionalInserting"),
    ),
  );
  return wrap;
}

function isSourceReady(state: VoiceViewState): boolean {
  return state.sourceReady !== false;
}

function selectedModel(state: VoiceViewState): VoiceModelInfo | undefined {
  return state.models.find((model) => model.id === state.settings.modelId) ?? state.models[0];
}

function isModelReady(model: VoiceModelInfo | undefined): boolean {
  return model?.state === "ready" || model?.state === "active";
}

function modelActionLabel(model: VoiceModelInfo): string {
  if (model.state === "downloading") return t("view.cancelDownload");
  if (hasModelUpdate(model)) return t("view.update2");
  if (model.active || model.state === "active") return t("view.inUse");
  if (model.state === "ready") return t("view.use");
  return t("view.download");
}

function modelDescription(model: VoiceModelInfo, developerMode: boolean): string {
  const total = formatBytes(model.sizeBytes);
  if (model.state === "failed") {
    // Host 给的下载失败原文只在开发者模式出现。
    return t("view.downloadFailedValue", { value0: (developerMode ? model.error : undefined) ?? t("view.fallback4") });
  }
  if (model.state === "downloading") {
    const downloaded = Math.min(model.downloadedBytes ?? 0, model.sizeBytes);
    const percent = model.sizeBytes > 0 ? Math.round((downloaded / model.sizeBytes) * 100) : 0;
    return t("view.valueDownloadingValueValueValue", { value0: model.description, value1: percent, value2: formatBytes(downloaded), value3: total });
  }
  if ((model.active || model.state === "active") && !hasModelUpdate(model)) {
    return t("view.valueValueCannotBeDeletedAfterSetup", { value0: model.description, value1: total });
  }
  if (hasModelUpdate(model)) {
    if (!model.installedVersion || !model.latestVersion || model.installedVersion === model.latestVersion) {
      return t("view.valueModelContentUpdateAvailable", { value0: model.description });
    }
    return t("view.valueUpdateAvailableValueValue", { value0: model.description, value1: model.installedVersion, value2: model.latestVersion });
  }
  if (model.state === "ready") {
    return t("view.valueValueCannotBeDeletedAfterSetup", { value0: model.description, value1: total });
  }
  return `${model.description} · ${total}`;
}

function hasModelUpdate(model: VoiceModelInfo): boolean {
  // Host also detects changed catalog digests and receipts with missing version
  // labels. Version text is presentation metadata, not an update-policy gate.
  return model.updateAvailable;
}

/**
 * 详情页那一行「注入前处理」。
 *
 * 四种情况必须分开说，因为它们对用户的意义完全不同：没跑润色 / 跑了但失败回退 /
 * 跑了且改过 / 跑了但原文已经够好。压成两档就会把「失败」说成「原样注入」，
 * 那正是「把失败伪装成正常」。
 */
/** 历史条目存的是内置命令 ID（voice.command.translate），不是 Host 事件 ID。 */
function isTranslationItem(item: VoiceCommandHistoryItem): boolean {
  return item.commandId === BUILTIN_VOICE_COMMANDS.translate;
}

/**
 * 命令条目点进去落到哪一页：翻译成功（有原文有译文）走一次性的「原文 → 译文」页，
 * 不借用 Agent 对话页；翻译还在跑 / 失败仍走对话页，那里有进度、错误诊断与重试。
 */
function commandDetailPage(item: VoiceCommandHistoryItem): "translation" | "chat" {
  return isTranslationItem(item) && item.status === "completed" && !!item.reply?.trim() && !!item.transcript.trim()
    ? "translation" : "chat";
}

function polishSummary(item: VoiceHistoryItem): string {
  if (item.savedInput?.state === "complete") return t("retry.asrOnly");
  const level = POLISH_LEVELS.find((candidate) => candidate.value === item.polish);
  if (!item.polish || item.polish === "raw") return t("view.insertOriginal");
  // 先看润色自己的标记，再看 warningCode：写回失败会把 warningCode 占掉
  // （而「润色超时 → 用户切走窗口 → 写回被拒」正是最常见的一条），
  // 只认 warningCode 的话，那种情况会被显示成「无需修改」——把失败说成成功。
  if (item.polishFailed || item.warningCode === "polish_failed") {
    return t("view.valueIncompleteOriginalInserted", { value0: level?.noun ?? t("view.polish") });
  }
  if (item.originalTranscript) return t("view.valueRewritten", { value0: level?.noun ?? t("view.polish") });
  return t("view.valueNoChangesNeeded", { value0: level?.noun ?? t("view.polish") });
}

/**
 * 详情页只展示用户需要理解的隐私边界，不暴露模型名或供应商。
 * 这是历史快照，不读取 state.settings.engine；旧记录没有字段就如实说“未记录”。
 */
function recognitionEngineCard(item: VoiceHistoryItem): HTMLElement {
  const engine = item.recognitionEngine ?? "unknown";
  const card = el("section", `detail-engine input-detail-engine ${engine}`);
  bindAttribute(card, "aria-label", () => t("view.recognitionMethod"));
  const icon = iconEl(
    "div",
    "detail-engine-icon input-detail-engine-icon",
    engine === "cloud" ? cloudRecognitionIcon() : engine === "local" ? localRecognitionIcon() : alertIcon(),
  );
  const copy = el("div", "detail-engine-copy input-detail-engine-copy");
  const value = () => engine === "cloud" ? t("view.cloudRecognition") : engine === "local" ? t("view.localRecognition") : t("view.notRecorded");
  const note = () => engine === "cloud"
    ? t("view.thisRecordingWasSentToTheCloud")
    : engine === "local"
      ? t("view.thisRecordingWasTranscribedOnlyOnThis")
      : t("view.theRecognitionMethodWasNotSavedFor");
  copy.append(
    textEl("div", "detail-engine-label input-detail-engine-label", () => t("view.recognitionMethod")),
    textEl("div", "detail-engine-value input-detail-engine-value", () => value()),
  );
  card.append(icon, copy, textEl("div", "detail-engine-note input-detail-engine-note", () => note()));
  return card;
}

function warningMessage(code: string): string {
  const messages: Record<string, string> = {
    get no_speech() { return t("view.noClearSpeechWasDetectedTryAgain"); },
    get focus_changed() { return t("view.theInputFocusChangedDuringRecordingText"); },
    get accessibility_permission_required() { return t("view.accessibilityPermissionIsMissingTheRecognitionResult"); },
    get no_input_target() { return t("view.noTextInputTargetWasFound"); },
    // Host API 1.22：事前判断确定不可输入（未粘贴）/ 粘贴后无人取件。
    get not_editable() { return t("view.theCursorWasNotInATextInputText"); },
    get not_received() { return t("view.theTargetAppDidNotTakeTheTextHistory"); },
    get text_insert_failed() { return t("view.textInsertionFailedTheRecognitionResultIs"); },
    get insert_failed() { return t("view.textInsertionFailedTheRecognitionResultIs"); },
    get voice_deliver_permission_required() { return t("view.recognitionFinishedButTextInsertionPermission"); },
    get voice_deliver_unavailable() { return t("app.voiceDeliveryUnavailable"); },
    get denied() { return t("view.textInsertionFailedTheRecognitionResultIs"); },
    get expired() { return t("view.cloudRecognitionTookTooLongAndThe"); },
    get polish_failed() { return t("view.polishingDidNotFinishSoYourOriginal"); },
    get focus_changed_after_polish() { return t("view.theInputFocusMovedDuringPolishingText"); },
  };
  return messages[code] ?? t("view.recognitionFinishedButTextWasNotInserted");
}

/**
 * 行右侧的相对时间（稿 `2 min ago / Yesterday`）。UI 其余全是中文，这里也用中文：
 * 刚刚 / N 分钟前 / N 小时前 / 昨天 / M 月 D 日（跨年带年）。「昨天」按本地日算，
 * 不按 24 小时——凌晨看昨晚的记录写「昨天」比「9 小时前」更像人话。
 */
function relativeTime(value: string, nowMs: number = Date.now()): string {
  const at = new Date(value).getTime();
  const elapsed = nowMs - at;
  if (!Number.isFinite(elapsed) || elapsed < 0) return t("view.justNow");
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return t("view.justNow");
  if (minutes < 60) return t("view.minutesAgoValue", { value0: minutes });
  const todayKey = dayKeyOf(new Date(nowMs));
  const dayKey = dayKeyOf(new Date(at));
  if (dayKey === todayKey) return t("view.hoursAgoValue", { value0: Math.floor(minutes / 60) });
  const label = dayLabel(dayKey, todayKey);
  // dayLabel 给的是「8 月 20 日 周四」，行里只要日期。
  return label === t("view.yesterday") ? label : label.replace(/ 周.$/u, "");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return t("view.secondsValue", { value0: (ms / 1000).toFixed(1) });
}

function formatBytes(bytes: number): string {
  // 一条都没有就是 0，不能被 max(1) 抬成「1 KB」——「已占用」那一行会因此说谎。
  if (bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function microphoneIcon(): string {
  return micIcon();
}

function cloudRecognitionIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
}

function localRecognitionIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
}

function commandIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<rect x="3" y="4" width="18" height="16" rx="3"/>'
    + '<path d="m7 9 3 3-3 3M13 15h4"/></svg>';
}

function alertIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/></svg>';
}

function timelineIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M3 12h3l2-5 4 10 3-7 2 2h4"/></svg>';
}

function chevronRightIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polyline points="9 18 15 12 9 6"/></svg>';
}

function externalLinkIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5"/><path d="M10 14 19 5"/><path d="M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';
}

/** 稿 `circle-help`：问号浮层的按钮图标。 */
function helpCircleIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<circle cx="12" cy="12" r="10"/>'
    + '<path d="M9.09 9a3 3 0 1 1 5.83 1c0 2-3 3-3 3"/>'
    + '<path d="M12 17h.01"/></svg>';
}

/** 触发事件行首图标（稿 ICONS 的 pen / globe / sparkles 路径）。 */
function commandEventIcon(name: "pen" | "globe" | "sparkles"): string {
  const paths = name === "pen"
    ? '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>'
    : name === "globe"
      ? '<circle cx="12" cy="12" r="10"/>'
        + '<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>'
        + '<path d="M2 12h20"/>'
      : '<path d="M12 3l1.9 5.8L19.7 10l-5.8 1.9L12 17.7l-1.9-5.8L4.3 10l5.8-1.9z"/>'
        + '<path d="M19 3l.7 2.1L21.8 6l-2.1.7L19 8.8l-.7-2.1L16.2 6l2.1-.7z"/>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function micIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<rect x="9" y="1" width="6" height="13" rx="3"/>'
    + '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>'
    + '<line x1="12" y1="23" x2="12" y2="19"/></svg>';
}

/* 三个图标的 path 与描边参数直接取自设计稿的 ICONS 表（play-2 / pause-r / volume-x），
   连「描边而不是实心」这一点也照搬：稿子里这几处调用没有传 fill 覆盖。 */
function playIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polygon points="6 4 20 12 6 20 6 4"/></svg>';
}

function pauseIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<rect x="6" y="4" width="4" height="16" rx="1.5"/>'
    + '<rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>';
}

function volumeOffIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M11 5 6 9H2v6h4l5 4z"/>'
    + '<line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
}

/** 安静桶的最小高度（百分比）。与 CSS 的 `min-height:2px` 双保险：R15「最小也是一条线」。 */
const WAVE_FLOOR_PERCENT = 6;

/**
 * 波形条（R10 / R15）。WAV 到达前先用稳定占位条，随后由真实 PCM 峰值替换；
 * 同一段每次打开长得一样（按 id 定值），不会乱跳。
 *
 * **高度一律走 CSSOM 赋值、不写内联 `style` 属性**：插件 WebView 的 CSP 是
 * `style-src … 'nonce-…'`，没有 `'unsafe-inline'`，`<i style="height:…">` 会被 WebKit
 * 整条丢掉——58 根条子全部 0 高，真机上整排看不见（审计夹具没有 CSP，所以
 * 报告里「看得见」）。`el.style.height = …` 不受 `style-src` 管。
 *
 * 占位生成器按「说一阵、停一阵」编节奏：有声的一串是块，安静的一串是 0——
 * 0 由 CSS `min-height:2px` 托成一条细线，一段录音不可能是一片空白。
 */
function replayWaveBars(seed: string, count = 58, heights?: number[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const bars = heights?.length === count ? heights : placeholderWaveHeights(seed, count);
  for (const height of bars) {
    const bar = document.createElement("i");
    bar.style.height = `${Math.max(0, Math.min(100, height))}%`;
    fragment.append(bar);
  }
  return fragment;
}

function placeholderWaveHeights(seed: string, count: number): number[] {
  let hash = 0;
  for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  // `>>> 16` 再 `& 0x7fff`：稿子修掉的那个符号位 bug（`>> 16` 在 hash 过 2^31 时为负，
  // 取模后高度为负被浏览器丢掉）这里从一开始就用无符号位移，再保险一道。
  const next = () => {
    hash = (Math.imul(hash, 1103515245) + 12345) >>> 0;
    return (hash >>> 16) & 0x7fff;
  };
  const out: number[] = [];
  let voiced = true;
  let run = 0;
  for (let index = 0; index < count; index += 1) {
    if (run <= 0) {
      voiced = !voiced;
      run = voiced ? 3 + (next() % 7) : 1 + (next() % 3);
    }
    run -= 1;
    out.push(voiced ? 22 + (next() % 74) : 0);
  }
  return out;
}

/**
 * 从 Host 返回的 PCM16 WAV 中抽取等宽峰值。这里不做解码依赖：Host 合同本来就是
 * 16 kHz / 单声道 / PCM16，直接读 data chunk 能在 WebView 中稳定得到真实波形。
 */
export function waveformHeightsFromWav(buffer: ArrayBuffer, count = 58): number[] {
  if (count <= 0 || buffer.byteLength < 44) return [];
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const textAt = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (textAt(0, 4) !== "RIFF" || textAt(8, 4) !== "WAVE") return [];

  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const chunkId = textAt(offset, 4);
    const chunkLength = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    if (payloadOffset + chunkLength > bytes.length) return [];
    if (chunkId === "data") {
      dataOffset = payloadOffset;
      dataLength = chunkLength;
      break;
    }
    offset = payloadOffset + chunkLength + (chunkLength % 2);
  }
  if (dataOffset < 0 || dataLength < 2) return [];

  const sampleCount = Math.floor(dataLength / 2);
  const peaks = Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * sampleCount / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * sampleCount / count));
    let peak = 0;
    for (let sample = start; sample < end && sample < sampleCount; sample += 1) {
      const value = Math.abs(view.getInt16(dataOffset + sample * 2, true));
      if (value > peak) peak = value;
    }
    return peak;
  });
  const globalPeak = Math.max(1, ...peaks);
  // 安静桶钳到一条细线（WAVE_FLOOR_PERCENT），有声处按峰值开方拉开层次；
  // 不许 0 高（R15），也不再给每根条子垫 18% 的假底——那会把静音画成有声。
  return peaks.map((peak) =>
    Math.max(WAVE_FLOOR_PERCENT, Math.round(Math.sqrt(peak / globalPeak) * 100)),
  );
}

/** 播放条上的时长按 m:ss 走——那是播放器的读法，不是「4.0 秒」这种统计读法。 */
function clockDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** HH:MM——Context 时间线里那一格的时间读法（稿 .ctx-line-ts 显示的就是这个粒度）。 */
function clockTime(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Context 段详情的页头标题：稿 ctxTitle 的「14:03 – 14:41」形态，两个端点都取真实墙钟。 */
function ctxRangeTitle(item: VoiceRecordingSegment): string {
  return `${clockTime(item.wallStartMs)} – ${clockTime(item.wallStartMs + item.durationMs)}`;
}

/**
 * A3-9：收听中的三根跳动条（稿 LISTEN_BARS / CSS `.sb-listen` + `lsnBar`，同名同值）。
 * 「在听」是隐私敏感的常态，必须动得起来才看得见——静态的三根条与装饰没有区别。
 * 动效的降级（prefers-reduced-motion）在 voice.css 里关动画，元素本身照常渲染。
 */
function listenBars(): HTMLElement {
  const bars = el("span", "sb-listen");
  bars.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) bars.append(el("i", "sb-listen-bar"));
  return bars;
}

/**
 * Context 段详情页头的时长。稿 ctxMeta 写「38 分钟」；列表行的 formatDuration 是
 * 统计读法（2280.0 秒），分钟的段用它没法读，所以这里到分钟为止、秒的段保持统计读法。
 */
function ctxDurationLabel(ms: number): string {
  if (ms < 60_000) return formatDuration(ms);
  return t("view.minutesValue", { value0: Math.round(ms / 60_000) });
}

/** 千分位字数（稿 fmtChars）：「1,240 字」而不是「1240 字」。 */
function formatChars(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 把一段转写切成时间线的句子行。切分只用**已有的边界**：Host 落盘时多次后台转写
 * 按 \n 拼接（那是真实的时间线分片边界），段内再按句末标点切（文本自己的分句，
 * 标点留在句尾）。不产出也不需要句级时间戳——真实模型只有段级时间。
 */
function splitTranscriptLines(text: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const sentences = trimmed.match(/[^。！？!?；;]*[。！？!?；;]+|[^。！？!?；;]+$/g);
    if (!sentences) continue;
    for (const sentence of sentences) {
      const candidate = sentence.trim();
      if (candidate) lines.push(candidate);
    }
  }
  return lines;
}

/** 键盘断了：胶囊收成一段「键盘未连接」（稿 voiceKbOff）。只认 Board 音源的断线事实。 */
function keyboardOff(state: VoiceViewState): boolean {
  return state.settings.source === "board" && state.sourceIssue === "disconnected";
}

/* 胶囊 / 分组 / 总结行用到的几枚图标，path 取自设计稿 ICONS 表（mic-off / activity /
   sparkles / chevron-down），描边而不是实心。 */
function micOffIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<line x1="1" y1="1" x2="23" y2="23"/>'
    + '<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/>'
    + '<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/>'
    + '<line x1="12" y1="19" x2="12" y2="23"/></svg>';
}

function activityIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
}

function sparklesIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>'
    + '<path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/></svg>';
}

function chevronDownIcon(): string {
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<polyline points="6 9 12 15 18 9"/></svg>';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function textEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text: TextSource,
): HTMLElementTagNameMap[K] {
  const element = el(tag, className);
  bindText(element, () => text);
  return element;
}

/** 仅接收本文件内的静态 SVG sprite，避免用字体字符充当跨平台图标。 */
function iconEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  svg: string,
): HTMLElementTagNameMap[K] {
  const element = el(tag, className);
  element.innerHTML = svg;
  element.setAttribute("aria-hidden", "true");
  return element;
}

/**
 * 模态弹层的 Esc：只关本层并声明已消费（`preventDefault()`，配合 surface.escape@1），
 * 不让 Host 把这次 Esc 当成返回上一页；叠层时只关最上面一层。焦点不在弹层内（例如还停在
 * 打开它的设置行）也生效。整个文档只挂一个监听，弹层按 WeakMap 登记，重渲染替换或卸载后
 * 随节点回收，不积累监听。输入法组字中的 Esc 原样放行。
 */
const dialogEscapeClosers = new WeakMap<Element, () => void>();
const dialogEscapeDocuments = new WeakSet<Document>();
function closeDialogOnEscape(layer: HTMLElement, close: () => void): void {
  dialogEscapeClosers.set(layer, close);
  const doc = layer.ownerDocument;
  if (dialogEscapeDocuments.has(doc)) return;
  dialogEscapeDocuments.add(doc);
  doc.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    // 说明浮层（问号提示）开着时它在最上面：这次 Esc 归它自己的处理关掉，弹层留到下一次。
    if (doc.querySelector(".settings-hint-panel")) return;
    // 同级弹层按 DOM 顺序叠放，后面的在上：只交给最上面那一层。
    const layers = doc.querySelectorAll(".voice-dialog-layer");
    const top = layers[layers.length - 1];
    const closeTop = top ? dialogEscapeClosers.get(top) : undefined;
    if (!closeTop) return;
    event.preventDefault();
    closeTop();
  });
}
