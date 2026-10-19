/**
 * Host ↔ App 的 Bridge 协议（v1）。
 *
 * 这份文件是**三方共用的合同**：SDK（App 侧）、`@reai/app-test` 的 Mock Host、
 * 以及 M1 落地的真实 Host。三方各写一遍消息形状必然漂，所以只有这一处定义。
 *
 * ## 两层会话身份
 *
 * - `runtimeSessionId`：每次 Component `activate` 生成。Bridge 与一次性 token 绑它。
 * - `surfaceMountId`：每次 Surface mount 生成。`ready` / `intent` / 可见性绑它。
 *
 * 分两层是因为它们**寿命不同**：一个 Runtime 内可以反复开关 Surface。只用一个 id 的话，
 * 关掉 Surface 再打开，旧 mount 的迟到消息会被当成新 mount 的，UI 就会莫名其妙地跳。
 */

import type { WireError } from "./errors";
import type { LocaleSnapshot } from "./locale";
import type { ServiceCaller } from "./services";

/** Host → App 的消息。 */
export type HostMessage =
  | { type: "activate"; runtimeSessionId: string; locale?: LocaleSnapshot }
  | { type: "locale.changed"; runtimeSessionId: string; locale: LocaleSnapshot }
  | { type: "environment.changed"; runtimeSessionId: string; developerMode: boolean }
  | { type: "deactivate" }
  | { type: "layers.changed"; version: 1; layer: "tab" | "action"; runtimeSessionId: string; surfaceMountId: string }
  | {
      type: "command.invoke";
      operation?: { id: string; phase: "start" | "end" };
      /**
       * 按下走了配对操作、松开命令却没声明 `supportsOperations` 时，Host 把松开作为普通调用
       * 发出，并用这个字段带上原 operation id：SDK 据此释放按下保留的取消句柄（不触发 abort）。
       */
      completesOperation?: string;
      correlationId: string;
      commandId: string;
      input: unknown;
      timeoutMs: number;
    }
  | { type: "command.cancel"; correlationId: string }
  | {
      type: "service.invoke";
      correlationId: string;
      serviceId: string;
      method: string;
      input: unknown;
      caller?: ServiceCaller;
      /** 原 services.call 的外层 ID，与业务 input.requestId 独立。 */
      requestId?: string;
      deadlineUnixMs?: number;
    }
  | { type: "service.cancel"; correlationId: string; caller?: ServiceCaller; requestId?: string; deadlineUnixMs?: number }
  | {
      type: "surface.mount";
      surfaceMountId: string;
      surfaceId: string;
      /** 承载 App DOM 的根节点。Host 生成的 bootstrap 页面提供它。 */
      root: unknown;
      initialIntent?: unknown;
    }
  | { type: "surface.presentation"; runtimeSessionId: string; surfaceMountId: string; presentationToken: string }
  /** `surface.escape@1`: frozen SurfaceEscapeRequest DTO; answered by the Host-injected runtime. */
  | { type: "surface.escape.request"; requestId: string; runtimeSessionId: string; surfaceMountId: string; presentationToken: string; deadlineUnixMs: number }
  /** Host-internal: a Host overlay sits above this approved Surface (Esc goes to it first). */
  | { type: "surface.escape.hostLayer"; runtimeSessionId: string; surfaceMountId: string; presentationToken: string; open: boolean; layer: number }
  | { type: "surface.unmount"; surfaceMountId: string }
  | { type: "surface.intent"; surfaceMountId: string; intent: unknown }
  | {
      /**
       * C1-2 能力事件（声明即订阅：Manifest `contributes.eventSubscriptions`）。
       * 携带两层会话身份——接收方必须校验 `runtimeSessionId` 是本轮会话，
       * 迟到/串台的事件直接丢。
       */
      type: "event";
      eventType: string;
      surfaceMountId: string;
      runtimeSessionId: string;
      deliveryId: string;
      payload: unknown;
    }
  | {
      /** `agent.codex@1` 专用摘要流；两层会话身份必须同时匹配。 */
      type: "codex.event";
      surfaceMountId: string;
      runtimeSessionId: string;
      event: unknown;
    }
  | {
      /**
       * 两条云端 AI 通道的增量与终局（`ai.stream.*` / `flow.event`）。
       * 两层会话身份必须同时匹配，迟到/串台的事件直接丢。
       */
      type: "cloud.event";
      surfaceMountId: string;
      runtimeSessionId: string;
      event: unknown;
    }
  | {
      /**
       * 本地 agent 内核（`agent.local@1`）的回合进度（tool.start / message /
       * turn.settled 等）。与 cloud.event 同一套两层身份校验。
       */
      type: "local.event";
      surfaceMountId: string;
      runtimeSessionId: string;
      event: unknown;
    }
  | {
      /** `terminal.session@1` 的有界输出/丢失/关闭事件。 */
      type: "terminal.event";
      surfaceMountId: string;
      runtimeSessionId: string;
      event: unknown;
    }
  | {
      /** Host document-start 队列的数据消息溢出；控制消息从不计入该上限。 */
      type: "host.pending_overflow";
      dropped: number;
    };

/** App → Host 的请求方法名。请求有返回值，会等 Host 回应。 */
export const RequestMethod = {
  LocaleGet: "locale.get",
  EnvironmentGet: "environment.get",
  StorageGet: "storage.get",
  StorageSet: "storage.set",
  StorageCompareAndSet: "storage.compareAndSet",
  StorageDelete: "storage.delete",
  StorageKeys: "storage.keys",
  SurfaceOpen: "surface.open",
  SurfaceNavigationRegister: "surface.navigation.register",
  SurfaceNavigationClear: "surface.navigation.clear",
  SurfaceEscapeRespond: "surface.escape.respond",
  AudioConsumersAcquire: "audio.consumers.acquire",
  AudioConsumersRelease: "audio.consumers.release",
  AudioConsumersStatus: "audio.consumers.status",
  AudioRangesStart: "audio.ranges.start",
  AudioRangesFinish: "audio.ranges.finish",
  AudioRangesCancel: "audio.ranges.cancel",
  AudioClipsRead: "audio.clips.read",
  AudioClipsRelease: "audio.clips.release",
  AudioClipsTranscribe: "audio.clips.transcribe",
  AudioClipsTranscriptionStatus: "audio.clips.transcriptionStatus",
  ResourcesRootsList: "resources.roots.list",
  ResourcesRootsPick: "resources.roots.pick",
  ResourcesRootsAttach: "resources.roots.attach",
  ResourcesRootsRevoke: "resources.roots.revoke",
  ResourcesList: "resources.list",
  ResourcesStat: "resources.stat",
  ResourcesRead: "resources.read",
  ResourcesWriteStart: "resources.write.start",
  ResourcesWriteChunk: "resources.write.chunk",
  ResourcesWriteCommit: "resources.write.commit",
  ResourcesCancel: "resources.cancel",
  ResourcesMkdir: "resources.mkdir",
  ResourcesRename: "resources.rename",
  ResourcesMove: "resources.move",
  ResourcesDelete: "resources.delete",
  ResourcesCreateFile: "resources.createFile",
  TasksPresent: "tasks.present",
  TasksProgress: "tasks.progress",
  TasksFinish: "tasks.finish",
  TasksDismiss: "tasks.dismiss",
  TasksConversationOpened: "tasks.conversationOpened",
  ResultsPresent: "results.present",
  ResultsContinue: "results.continue",
  ResultsDismiss: "results.dismiss",
  AppsOpen: "apps.open",
  /** 按调用方 Manifest 声明的依赖查目标 App「装没装、启没启」（A3-24 门控数据源）。 */
  AppsStatus: "apps.status",
  ServicesCall: "services.call",
  GatewayList: "gateway.list",
  GatewayIssue: "gateway.issue",
  GatewayRevoke: "gateway.revoke",
  ServicesCancel: "services.cancel",
  /** C1-3：Tab 层实体条目推送口。 */
  TabItemsUpsert: "tabItems.upsert",
  TabItemsRemove: "tabItems.remove",
  TabItemsList: "tabItems.list",
  /** C-3b：Action 层挂载口（用户挂上来的静态快捷）。 */
  ActionItemsMount: "actionItems.mount",
  ActionItemsUnmount: "actionItems.unmount",
  ActionItemsList: "actionItems.list",
  /** C1-5：凭一次性 pickupToken 取存证。 */
  EvidenceFetch: "evidence.fetch",
  AccountStatus: "account.status",
  NotificationsPost: "notifications.post",
  /** `notifications.publish@1`：按声明场景发布纯文本通知，并读写本插件自己的通知历史。 */
  NotificationsPublish: "notifications.publish",
  NotificationsHistoryList: "notifications.history.list",
  NotificationsHistoryMarkRead: "notifications.history.markRead",
  /** 永久写入系统剪贴板（`surface.clipboard@1`）；不触发粘贴或焦点切换。 */
  ClipboardWriteText: "clipboard.writeText",
  HttpFetch: "http.fetch",
  HttpCancel: "http.cancel",
  HttpUploadStart: "http.upload.start",
  HttpUploadChunk: "http.upload.chunk",
  HttpUploadFinish: "http.upload.finish",
  VoiceStatus: "voice.status",
  VoiceConfigure: "voice.configure",
  VoicePreparing: "voice.preparing",
  VoiceToggle: "voice.toggle",
  VoiceCancel: "voice.cancel",
  VoiceAcknowledgeResult: "voice.acknowledge-result",
  /** Host API 1.22（2026-09-28 并入）：写回阶段只改中央胶囊那一句（`holdOverlayUntilAck` 会话）。 */
  VoiceReportStage: "voice.report-stage",
  VoiceModelsList: "voice.models.list",
  VoiceModelDownload: "voice.models.download",
  VoiceModelCancelDownload: "voice.models.cancel-download",
  VoiceModelDelete: "voice.models.delete",
  VoicePermissionsCheck: "voice.permissions.check",
  VoicePermissionRequest: "voice.permissions.request",
  VoiceTimelineStatus: "voice.timeline.status",
  VoiceTimelineSetPaused: "voice.timeline.set-paused",
  VoiceTimelineClear: "voice.timeline.clear",
  VoiceTimelineSetRecording: "voice.timeline.set-recording",
  VoiceSystemInputsList: "voice.system-inputs.list",
  VoiceRecordingsList: "voice.recordings.list",
  VoiceRecordingPlaybackAuthorize: "voice.recordings.playback-authorize",
  VoiceRecordingDelete: "voice.recordings.delete",
  VoiceRecordingSetSummary: "voice.recordings.set-summary",
  VoiceRecordingRetranscribeSegment: "voice.recordings.retranscribe-segment",
  VoiceReplayCacheStatus: "voice.recordings.replay-status",
  VoiceReplaySetRetention: "voice.recordings.replay-set-retention",
  VoiceReplayCacheClear: "voice.recordings.replay-clear",
  VoiceRecoverableInputSessionsList: "voice.recordings.input-sessions",
  VoiceInputSessionTranscribe: "voice.recordings.transcribe-input-session",
  VoiceInputSessionSetTranscription: "voice.recordings.set-input-transcription",
  VoiceInputSessionGet: "voice.recordings.get-input-session",
  VoiceSavedInputTranscribe: "voice.recordings.transcribe-saved-input",
  VoiceSavedInputCancel: "voice.recordings.cancel-saved-input",
  VoiceCommandStatus: "voice.command.status",
  VoiceCommandConfigure: "voice.command.configure",
  VoiceCommandRun: "voice.command.run",
  /** 呈现：上报任务快照 / 撤下任务 / 弹计划面板 / 弹答案面板。 */
  VoiceCommandPresentTask: "voice.command.present-task",
  VoiceCommandDismissTask: "voice.command.dismiss-task",
  VoiceCommandPresentPlan: "voice.command.present-plan",
  VoiceCommandPresentAnswer: "voice.command.present-answer",
  VoiceCommandCancel: "voice.command.cancel",
  SystemTasksVersionStatus: "system.tasks.version-status",
  SystemTasksOpen: "system.tasks.open",
  /** 选文件夹（`system.folder-pick@1`）：弹系统面板，只回用户挑的那一个绝对路径。 */
  SystemFolderPick: "system.folder-pick",
  CodexTasksRuntimeStatus: "codex.tasks.runtime.status",
  CodexTasksAccountRead: "codex.tasks.account.read",
  CodexTasksRateLimits: "codex.tasks.account.rate-limits",
  CodexTasksUsage: "codex.tasks.account.usage",
  CodexTasksLoginStart: "codex.tasks.account.login.start",
  CodexTasksLoginCancel: "codex.tasks.account.login.cancel",
  CodexTasksLogout: "codex.tasks.account.logout",
  CodexTasksModelsList: "codex.tasks.models.list",
  CodexTasksSkillsList: "codex.tasks.skills.list",
  CodexTasksThreadList: "codex.tasks.thread.list",
  CodexTasksThreadRead: "codex.tasks.thread.read",
  CodexTasksThreadStart: "codex.tasks.thread.start",
  CodexTasksThreadResume: "codex.tasks.thread.resume",
  CodexTasksThreadArchive: "codex.tasks.thread.archive",
  CodexTasksThreadName: "codex.tasks.thread.name",
  CodexTasksTurnStart: "codex.tasks.turn.start",
  CodexTasksTurnSteer: "codex.tasks.turn.steer",
  CodexTasksTurnInterrupt: "codex.tasks.turn.interrupt",
  CodexTasksApprovalRespond: "codex.tasks.approval.respond",
  CodexTasksUserInputRespond: "codex.tasks.user-input.respond",
  CodexTasksEventsDrain: "codex.tasks.events.drain",
  CodexTasksConversationOpened: "codex.tasks.conversation.opened",
  CodexTasksFileHandoffCreate: "codex.tasks.file.handoff.create",
  LocalFilesWorkspacePick: "local.files.workspace.pick",
  LocalFilesWorkspaceList: "local.files.workspace.list",
  LocalFilesWorkspaceRevoke: "local.files.workspace.revoke",
  LocalFilesDirectoryList: "local.files.directory.list",
  LocalFilesDocumentRead: "local.files.document.read",
  LocalFilesDocumentWrite: "local.files.document.write",
  LocalFilesHandoffClaim: "local.files.handoff.claim",
  /** aiApi（`cloud.model.invoke@1`）。 */
  AiModelsList: "ai.models.list",
  AiTextGenerate: "ai.text.generate",
  AiAudioTranscribe: "ai.audio.transcribe",
  AiCancel: "ai.cancel",
  /** flowApi（`cloud.workflow.invoke@1`）。 */
  FlowInvoke: "flow.invoke",
  FlowCancel: "flow.cancel",
  /** 结果写回（`voice.deliver@1`）。 */
  VoiceDeliverCommit: "voice.deliver.commit",
  /** 写回失败后的「取回文字」系统级卡片呈现（`voice.deliver@1`）。 */
  VoiceDeliverPresentTakeback: "voice.deliver.present-takeback",
  /** 润色上下文采集（`voice.context@1`）。 */
  VoiceContextCapture: "voice.context.capture",
  /** 本地 TTS（`tts.local@1`，官方开发者验证插件专属）。 */
  TtsLocalStatus: "tts.local.status",
  TtsLocalMicrophoneRequest: "tts.local.microphone.request",
  TtsLocalRecordingStart: "tts.local.recording.start",
  TtsLocalRecordingStop: "tts.local.recording.stop",
  TtsLocalRecordingCancel: "tts.local.recording.cancel",
  TtsLocalRecordingPlaybackAuthorize: "tts.local.recording.playback-authorize",
  TtsLocalRecognitionPrepare: "tts.local.recognition.prepare",
  TtsLocalRecognitionConfirm: "tts.local.recognition.confirm",
  TtsLocalModelDownload: "tts.local.model.download",
  TtsLocalModelCancelDownload: "tts.local.model.cancel-download",
  TtsLocalModelDelete: "tts.local.model.delete",
  TtsLocalVoiceRegister: "tts.local.voice.register",
  TtsLocalVoiceDelete: "tts.local.voice.delete",
  TtsLocalDefaultGet: "tts.local.default.get",
  TtsLocalDefaultSet: "tts.local.default.set",
  TtsLocalSynthesize: "tts.local.synthesize",
  TtsLocalCancel: "tts.local.cancel",
  /** 本地 agent 内核（`agent.local@1`，官方诊断助手专属）。 */
  LocalStatus: "local.status",
  LocalChatSend: "local.chat.send",
  LocalChatCancel: "local.chat.cancel",
  /** DSH 基础底座服务（`agent.dsh@1`，按请求孵化 + session 续跑）。 */
  DshStatus: "dsh.status",
  DshSessionCreate: "dsh.session.create",
  DshSessionSend: "dsh.session.send",
  DshSessionCancel: "dsh.session.cancel",
  DshSessionHistory: "dsh.session.history",
  DshSessionList: "dsh.session.list",
  DshSessionDelete: "dsh.session.delete",
  /** Harness 无关的 Agent Session 服务（`agent.session@1`）。 */
  AgentBackendsList: "agent.backends.list",
  AgentSessionCreate: "agent.session.create",
  AgentV2Backends: "agent.v2.backends.list",
  AgentV2List: "agent.v2.session.list",
  AgentV2ConversationOpened: "agent.v2.session.conversation-opened",
  AgentV2ToolDependencyRequire: "agent.v2.tool-dependency.require",
  AgentV2Create: "agent.v2.session.create",
  AgentV2AttachmentRead: "agent.v2.attachment.read",
  AgentV2AttachmentUploadStart: "agent.v2.attachment.upload.start",
  AgentV2AttachmentUploadChunk: "agent.v2.attachment.upload.chunk",
  AgentV2AttachmentUploadFinish: "agent.v2.attachment.upload.finish",
  AgentV2AttachmentUploadCancel: "agent.v2.attachment.upload.cancel",
  AgentV2StartTurn: "agent.v2.turn.start",
  AgentV2GetTurn: "agent.v2.turn.get",
  AgentV2Events: "agent.v2.turn.events",
  AgentV2Cancel: "agent.v2.turn.cancel",
  AgentV2History: "agent.v2.session.history",
  AgentV2Delete: "agent.v2.session.delete",
  AgentV2ApprovalsList: "agent.v2.session.approvals.list",
  AgentSessionApprovalsList: "agent.session.approvals.list",
  AgentSessionSend: "agent.session.send",
  AgentSessionCancel: "agent.session.cancel",
  AgentSessionHistory: "agent.session.history",
  AgentSessionList: "agent.session.list",
  AgentSessionDelete: "agent.session.delete",
  AgentSessionConversationOpened: "agent.session.conversation-opened",
  AgentToolDependencyRequire: "agent.tool-dependency.require",
  PiManagementSnapshot: "pi.management.snapshot",
  PiManagementSessionGet: "pi.management.session.get",
  PiManagementModels: "pi.management.models",
  PiManagementSettingsUpdate: "pi.management.settings.update",
  DshObserverSnapshot: "dsh.observe.snapshot",
  DshObserverSessionDetail: "dsh.observe.session.detail",
  DshObserverHistoryPage: "dsh.observe.session.history.page",
  DshObserverSettings: "dsh.observe.settings",
  DshObserverSettingsUpdate: "dsh.observe.settings.update",
  DeveloperPlatformContextGet: "developer.platform.context.get",
  DeveloperPlatformProjectsList: "developer.platform.projects.list",
  DeveloperPlatformScopesList: "developer.platform.scopes.list",
  DeveloperPlatformProductsList: "developer.platform.products.list",
  DeveloperPlatformProductsCreate: "developer.platform.products.create",
  DeveloperPlatformWorkflow: "developer.platform.workflow",
  DeveloperPlatformClientsGet: "developer.platform.clients.get",
  DeveloperPlatformTestersList: "developer.platform.testers.list",
  DeveloperPlatformTestersAdd: "developer.platform.testers.add",
  DeveloperPlatformTestersRemove: "developer.platform.testers.remove",
  TerminalSessionCreate: "terminal.session.create",
  TerminalSessionList: "terminal.session.list",
  TerminalSessionAttach: "terminal.session.attach",
  TerminalSessionDetach: "terminal.session.detach",
  TerminalSessionWrite: "terminal.session.write",
  TerminalSessionResize: "terminal.session.resize",
  TerminalSessionRestart: "terminal.session.restart",
  TerminalSessionClose: "terminal.session.close",
} as const;

export type RequestMethod = (typeof RequestMethod)[keyof typeof RequestMethod];

/** Frozen clip routes. Registration alone does not make the Host available. */
const audioClipsMethods = [
  RequestMethod.AudioRangesStart, RequestMethod.AudioRangesFinish, RequestMethod.AudioRangesCancel,
  RequestMethod.AudioClipsRead, RequestMethod.AudioClipsRelease, RequestMethod.AudioClipsTranscribe,
  RequestMethod.AudioClipsTranscriptionStatus,
] as const;
export type AudioClipsRequestMethod = (typeof audioClipsMethods)[number];
export function audioClipsRequestMethod(method: string): method is AudioClipsRequestMethod {
  return (audioClipsMethods as readonly string[]).includes(method);
}

/** `resources.files@1` routes. Registration alone does not make the Host available. */
const resourceFilesMethods = [
  RequestMethod.ResourcesRootsList, RequestMethod.ResourcesRootsPick, RequestMethod.ResourcesRootsAttach, RequestMethod.ResourcesRootsRevoke,
  RequestMethod.ResourcesList, RequestMethod.ResourcesStat, RequestMethod.ResourcesRead,
  RequestMethod.ResourcesWriteStart, RequestMethod.ResourcesWriteChunk, RequestMethod.ResourcesWriteCommit,
  RequestMethod.ResourcesCancel, RequestMethod.ResourcesMkdir, RequestMethod.ResourcesRename,
  RequestMethod.ResourcesMove, RequestMethod.ResourcesDelete, RequestMethod.ResourcesCreateFile,
] as const;
export type ResourceFilesRequestMethod = (typeof resourceFilesMethods)[number];
export function resourceFilesRequestMethod(method: string): method is ResourceFilesRequestMethod {
  return (resourceFilesMethods as readonly string[]).includes(method);
}

/** Exact neutral task/result routes; does not include legacy Voice or Agent methods. */
const taskMethods = [
  RequestMethod.TasksPresent, RequestMethod.TasksProgress, RequestMethod.TasksFinish,
  RequestMethod.TasksDismiss, RequestMethod.TasksConversationOpened,
  RequestMethod.ResultsPresent, RequestMethod.ResultsContinue, RequestMethod.ResultsDismiss,
] as const;
export type TaskRequestMethod = (typeof taskMethods)[number];
export function taskRequestMethod(method: string): method is TaskRequestMethod {
  return (taskMethods as readonly string[]).includes(method);
}

/** App → Host 的通知方法名。单向，不等回应。 */
export const NotifyMethod = {
  /** activate 完成后上报实际注册了什么。Host 拿它与 Manifest 声明比对。 */
  Registered: "app.registered",
  /** activate 抛错。 */
  ActivateFailed: "app.activate-failed",
  /** 一次 Command 调用的终局。 */
  CommandSettled: "command.settled",
  ServiceSettled: "service.settled",
  /** Surface 已就绪，可以展示。每个 mount 恰好一次。 */
  SurfaceReady: "surface.ready",
  /** Surface 起不来。与 ready 二选一，同样恰好一次。 */
  SurfaceFailed: "surface.failed",
  /** Surface 内的非致命错误（比如一次保存失败）。可以多次。 */
  SurfaceError: "surface.error",
  /**
   * Surface 内部自主导航状态上报（面包屑合同，审计 B2-3）。每次页面变化都要报，
   * 含挂载后的初始态；`nav: null` 表示回到根页。可以多次调用。
   */
  SurfaceNav: "surface.nav",
} as const;

export type NotifyMethod = (typeof NotifyMethod)[keyof typeof NotifyMethod];

/** [`NotifyMethod.Registered`] 的负载：App 实际注册了什么。 */
export interface RegistrationReport {
  runtimeSessionId: string;
  surfaces: string[];
  commands: string[];
  intents: string[];
  services: string[];
  /**
   * 以 `supportsOperations: true` 注册的 Command。Host 据此决定按住类绑定怎么派发：
   * 按下命令在列表里的走配对操作；不在的整对按配对操作出现之前的方式，按下、松开
   * 各发一次不带 operation 的普通调用。
   */
  operationCommands: string[];
}

export type ServiceSettlement =
  | { correlationId: string; ok: true; output: unknown }
  | { correlationId: string; ok: false; error: WireError };

/** 一次 Command 调用的终局。 */
export type CommandSettlement =
  | { correlationId: string; ok: true; output: unknown }
  | { correlationId: string; ok: false; error: WireError };

/**
 * Bridge：SDK 唯一的对外通道。
 *
 * 真实实现在 M1（custom scheme + per-WebView 通道，**不用** `tauri::ipc::Channel`），
 * 测试实现在 `@reai/app-test`。SDK 本身对传输一无所知。
 */
export interface HostBridge {
  /** 发请求并等结果。`signal` 取消后 Host 侧也要停。 */
  request<T = unknown>(
    method: RequestMethod,
    params: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T>;

  /** 发通知，不等回应。 */
  notify(method: NotifyMethod, params: unknown): void;

  /** 订阅 Host 消息。返回退订函数。 */
  subscribe(handler: (message: HostMessage) => void): () => void;
}

/**
 * Host bootstrap 注入 Bridge 的全局键。
 *
 * 用一个带前缀的符号名而不是 `window.bridge`：Surface 页面里跑的是 App 自己的代码，
 * 名字太普通迟早撞车，撞了之后表现是「Bridge 莫名其妙不工作」，极难查。
 */
export const BRIDGE_GLOBAL_KEY = "__REAI_APP_BRIDGE_V1__";
