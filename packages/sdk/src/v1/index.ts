/**
 * `@reai/app-sdk/v1` —— ReAI App 平台 SDK 公开面。
 *
 * App 只应该 import 这里的东西。协议细节（消息形状、Bridge）也导出，但那是给
 * Host 与测试工具用的，App 直接用它等于绕过 SDK 的约束检查。
 */

export { AppError, toWireError, type AppErrorInit, type WireError } from "./errors";
export {
  APP_PLATFORM_ERROR_CODES,
  PLUGIN_BRIDGE_ERROR_CODES,
  type AppPlatformErrorCode,
  type PluginBridgeErrorCode,
  type StableErrorCode,
} from "./error-codes";
export { HOST_API_VERSION, SDK_VERSION } from "./version";
export type { UiLocale, LocaleSnapshot, LocaleClient } from "./locale";
export {
  DEVELOPER_CENTER_APP_ID,
  DEVELOPER_PLATFORM_BACKEND_ERROR_CODES,
  DEVELOPER_PLATFORM_CAPABILITY,
  DEVELOPER_PLATFORM_REQUEST_METHODS,
  DeveloperPlatformRequestMethod,
  type DeveloperClientDetail,
  type DeveloperClientGetInput,
  type DeveloperClientRevisionSummary,
  type DeveloperPlatformBackendErrorCode,
  type DeveloperPlatformClient,
  type DeveloperPlatformContext,
  type DeveloperPlatformRequest,
  type DeveloperProductClientSummary,
  type DeveloperProductCreateInput,
  type DeveloperProductCreateResult,
  type DeveloperProductReleaseSummary,
  type DeveloperProductSummary,
  type DeveloperProductsListInput,
  type DeveloperProjectSummary,
  type DeveloperProjectsListInput,
  type DeveloperReviewSubmissionSummary,
  type DeveloperScopeSummary,
  type DeveloperScopesListInput,
  type DeveloperTeamSummary,
  type DeveloperTesterAddInput,
  type DeveloperTesterEntry,
  type DeveloperTesterRemoveInput,
  type DeveloperTestersListInput,
  type DeveloperTestersSummary,
} from "./developer-platform";
export {
  brokerFetch,
  defineApp,
  installGlobalNetworkFetch,
  isHostInternalUrl,
  normalizeBridgeError,
  runApp,
  type RunningApp,
} from "./runtime";
export type {
  AppContext,
  AppHttpClient,
  AppHttpFetchOptions,
  AccountStatusResult,
  AppDefinition,
  AppDependencyStatus,
  AppEvent,
  CommandHandler,
  CommandInvocation,
  KeyValueStore,
  NotificationPostOptions,
  NotificationPostResult,
  HostTitlebarActionIntent,
  SurfaceHandle,
  SurfaceMountHandler,
  TabItemInfo,
  TabItemUpsert,
  ActionItemKind,
  ActionItemMount,
  ActionMountInfo,
} from "./types";
export type {
  AppServicesClient,
  ServiceHandler,
  ServiceCaller,
  ServiceInvocation,
} from "./services";
export type {
  VoiceInputClient,
  VoiceInputStartOptions,
  VoiceHoldOverlayOption,
  VoiceReportedStage,
  VoiceOverlayKind,
  AudioTimelineStatus,
  SystemInputEndpoint,
  VoiceInputPhase,
  VoiceInputResult,
  VoiceInputSettings,
  VoiceInputSource,
  VoiceInputStatus,
  VoiceRecognitionEngine,
  VoiceSourceIssue,
  VoiceAudioRef,
  VoiceDeliveryTargetRef,
  VoiceReplayClipRef,
  VoiceReplayClipStatus,
  VoiceModelInfo,
  VoiceModelState,
  VoicePermissionInfo,
  VoiceAudioSourceMode,
  VoiceAudioSourcesInfo,
  VoicePermissionKind,
  VoicePermissionState,
  VoicePolishContextSetting,
  VoicePolishSetting,
} from "./voice-input";
export type {
  VoiceRecordingPage,
  VoiceRecordingPlaybackGrant,
  VoiceRecordingSegment,
  VoiceRecordingSentence,
  VoiceRecordingSummary,
  VoiceRecordingSummaryInput,
  RecoverableVoiceInputSession,
  RecoverableVoiceInputSessionPage,
  VoiceInputStopReason,
  VoiceInputTranscriptionStatus,
  SavedInputSelection,
  SavedInputRequest,
  SavedInputReceipt,
  VoiceRecordingsClient,
  VoiceReplayCacheStatus,
  VoiceReplayRetention,
} from "./voice-recordings";
export type {
  VoiceContextAppCategory,
  VoiceContextCapture,
  VoiceContextClient,
  VoiceContextImage,
  VoiceContextScreenRecordingState,
  VoiceContextWindowTextStatus,
} from "./voice-context";
export type {
  VoiceCommandClient,
  VoiceCommandResult,
  VoiceCommandStatus,
} from "./voice-command";
export type {
  LocalTtsClient,
  LocalTtsHardwareInfo,
  LocalTtsModelId,
  LocalTtsModelInfo,
  LocalTtsModelState,
  LocalTtsPlaybackGrant,
  LocalTtsRecommendation,
  LocalTtsStatus,
  LocalTtsSynthesisResult,
  LocalTtsVoiceInfo,
} from "./local-tts";
export {
  describeCloudError,
  type CloudAiClient,
  type CloudCancelResult,
  type CloudDeliveryClient,
  type CloudDeliveryResult,
  type CloudErrorInfo,
  type CloudFlowClient,
  type CloudFlowInvokeOptions,
  type CloudFlowResult,
  type CloudGenerateMessage,
  type CloudGenerateContentPart,
  type CloudGenerateOptions,
  type CloudGenerateResult,
  type CloudModelOption,
  type CloudTranscriptionEffectivePrice,
  type CloudStreamEvent,
  type CloudTranscribeOptions,
  type CloudTranscribeResult,
} from "./cloud";
export {
  isSystemTaskReturnIntent,
  type SystemTaskClient,
  type SystemTaskConfigSource,
  type SystemTaskOpenOptions,
  type SystemTaskOpenResult,
  type SystemTaskReturnIntent,
  type SystemTaskTarget,
  type SystemTaskVersionStatus,
} from "./system-tasks";
export { type FolderPickClient } from "./folder-pick";
export type {
  CodexFileHandoff,
  CodexLoginStartResult,
  CodexRuntimeStatus,
  CodexTaskEventPage,
  CodexTasksClient,
  CodexTurnMode,
} from "./codex-tasks";
export type {
  LocalDirectoryEntry,
  LocalFilesClient,
  LocalTextDocument,
  LocalWorkspace,
} from "./local-files";
export {
  describeLocalAgentError,
  type LocalAgentClient,
  type LocalAgentErrorInfo,
  type AgentUserWait,
  type LocalAgentEvent,
  type LocalAgentState,
  type LocalAgentStatus,
  type LocalChatResult,
  type LocalChatSendOptions,
} from "./local-agent";
export {
  describeDshAgentError,
  type DshAgentClient,
  type DshAgentErrorInfo,
  type DshHistoryItem,
  type DshSendResult,
  type DshSessionSummary,
  type DshStatus,
  type DshTurnFailure,
} from "./dsh-agent";
export type {
  DshObserverClient,
  DshObserverHistoryItem,
  DshObserverHistoryPage,
  DshObserverModelOption,
  DshObserverNextAction,
  DshObserverOutcome,
  DshObserverRuntime,
  DshObserverRuntimeComponent,
  DshObserverRuntimeState,
  DshObserverSession,
  DshObserverSessionDetail,
  DshObserverSettings,
  DshObserverSkill,
  DshObserverSnapshot,
  DshObserverSourceApp,
  DshObserverTool,
} from "./dsh-observer";
export type {
  AgentApprovalSummary,
  AgentBackend,
  AgentBackendCapabilities,
  AgentBackendStatus,
  AgentCommandTool,
  AgentFileTool,
  AgentHistoryItem,
  AgentMemoryMode,
  AgentSendResult,
  AgentTokenUsage,
  AgentSessionClient,
  AgentConversationOpenReceipt,
  AgentSessionSpec,
  AgentSessionSummary,
  AgentSkillDocument,
  AgentTurnMode,
  AgentWorkspace,
  ResolvedAgentBackend,
} from "./agent-session";
export type {
  PiManagementClient,
  PiManagementModel,
  PiManagementSession,
  PiManagementSessionDetail,
  PiManagementSettings,
  PiManagementSkill,
  PiManagementSnapshot,
  PiManagementTurn,
  PiTurnState,
} from "./pi-management";
export type {
  TerminalAttachment,
  TerminalSessionClient,
  TerminalSessionEvent,
  TerminalSessionInfo,
} from "./terminal-session";
export {
  BRIDGE_GLOBAL_KEY,
  NotifyMethod,
  RequestMethod,
  audioClipsRequestMethod,
  type AudioClipsRequestMethod,
  taskRequestMethod,
  type TaskRequestMethod,
  type CommandSettlement,
  type HostBridge,
  type HostMessage,
  type RegistrationReport,
} from "./protocol";

export type { AppGatewayClient, GatewayConnection, GatewayHandle } from "./services";

export type { AgentConfig, AgentTurnStart, AgentTurnRef, AgentTurnSnapshot, AgentTurnResult, AgentToolAttempt, AgentServiceEvent, AgentServiceClient } from "./agent-service";
export type { AgentAttachmentAdmission, AgentAttachmentSnapshot, AgentAttachmentTurnAdmission, AgentAttachmentTurnInput, AgentAttachmentPart, AgentAttachmentMode, AgentAttachmentReaders, AgentAttachmentUploadOwner, AgentAttachmentUploads } from "./agent-attachments";

export type { AgentRunArguments, AgentRunOutput } from "./agent-run";
export type { LocalReviewForm, LocalOperation, WorkflowProductRef, WorkflowClientRef, DeveloperWorkflowClient, DeveloperWorkflowRequest, DeveloperWorkflowRequests, DeveloperWorkflowResults, DeveloperWorkflowAction, DeveloperWorkflowContract } from "./developer-workflow";

// Frozen additive contracts; Host runtime wiring and admission remain explicit.
export * from "./platform-contracts";

export type { SurfaceNavigation, SurfaceNavigationInput } from "./navigation";
export { createSurfaceLayout } from "./surface-layout";
export type { SurfaceLayout } from "./surface-layout";
