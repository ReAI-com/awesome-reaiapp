/** `voice.input@1` —— 官方 Voice Input 插件的原生能力窄口。 */

export type VoiceInputSource = "board" | "system";
export type VoiceInputPhase = "idle" | "listening" | "recognizing";
export type VoiceInputMode = "input" | "command";
export type VoicePermissionKind = "microphone" | "accessibility";
export type VoicePermissionState = "granted" | "denied" | "not_determined" | "unavailable";
export type VoiceModelState = "missing" | "downloading" | "ready" | "active" | "failed";
export type VoiceSourceIssue =
  | "disconnected"
  | "firmware_too_old"
  | "firmware_unknown"
  | "source_unavailable";

export type VoiceRecognitionEngine = "local" | "cloud";

/**
 * 用户可见的五档音源（2026-10-11）：自动（= 硬件优先，默认）/ 硬件优先 / 电脑优先 /
 * 只用硬件麦 / 只用电脑麦（配合 `systemEndpointId` 选具体设备）。
 */
export type VoiceAudioSourceMode =
  | "auto"
  | "prefer_board"
  | "prefer_computer"
  | "board_only"
  | "computer_only";

export interface VoiceInputSettings {
  source: VoiceInputSource;
  /**
   * 显式选择的音源档位；只有用户主动选档时才写入 Host 全局策略。
   * 旧 Host 只认识 `prefer_board` / `prefer_computer`；旧 `source` 字段继续兼容。
   */
  audioSourcePreference?: { kind: VoiceAudioSourceMode };
  /**
   * 激活时的准备性 configure：只同步业务设置，保留 Host 已持久的音源档位。
   * 显式选档（带 `audioSourcePreference`）优先于它。旧 Host 忽略此字段。
   */
  preserveAudioSourcePreference?: boolean;
  systemEndpointId?: string | null;
  modelId: string;
  language: string;
  vadEnabled: boolean;
  punctEnabled: boolean;
  /**
   * 识别引擎：`local` 用本地模型（默认），`cloud` 把音频留给云端转写
   * （`voiceInput.toggle({ retainAudio: true })` + `aiApi.transcribe`）。
   * 纯插件侧路由字段，Host 的 `voice.configure` 不认识它、也不需要认识。
   */
  engine: VoiceRecognitionEngine;
  /**
   * 注入前的润色档位。与 `engine` 一样是**纯插件侧**字段，Host 的 `voice.configure`
   * 不认识它——润色发生在识别之后、写回之前，全程在插件里编排。
   */
  polish: VoicePolishSetting;
  /** 润色上下文采集设置；同样是纯插件侧字段。 */
  polishContext: VoicePolishContextSetting;
  /** SDK migration hint; Host independently verifies the legacy route facts. */
  legacySourceMigration?: boolean;
}

/**
 * 润色档位。
 *
 * `raw` 不是「关掉功能」而是一个平等的档：识别成什么就注入什么，一个字节都不改。
 * 新用户默认轻度润色；已明确选择 raw 的设置保留，云失败清楚回退原文。
 */
export type VoicePolishSetting = "raw" | "light" | "formal";

export interface VoicePolishContextSetting {
  /** 窗口文字；与截图同意独立。 */
  window: boolean;
  /** 带上近期语音上下文（voice:context）。 */
  recentVoice: boolean;
  /** 近期语音的时间范围（分钟）。 */
  recentVoiceRangeMinutes: number;
}

export interface SystemInputEndpoint {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface VoiceInputStatus {
  phase: VoiceInputPhase;
  source: VoiceInputSource;
  modelId: string;
  sourceReady: boolean;
  sourceIssue?: VoiceSourceIssue | null;
  boardFirmwareVersion?: string | null;
  minimumBoardFirmwareVersion?: string;
  /** PCM 到达的事实；缺席时为未知，不得由 listening 推导。 */
  pcmReceived?: boolean;
  /** opt-in retainResultUntilAck 的原 session 终态，消费后必须 acknowledge。 */
  result?: VoiceInputResult;
  resultError?: { code: string; message: string };
  /** 活动 session，或按 session 查询时尚未确认消费的异步终态 session。 */
  sessionId?: string;
  mode?: VoiceInputMode;
  /**
   * 当前调用异步自动停止的原因。启动录音的 `toggle` 已经返回，调用方应带原
   * sessionId 轮询 status，并在 phase 回到 idle 时按这个原因收口与确认消费。
   */
  stopReason?: "capture_limit" | "source_unavailable" | "user_cancel";
  timeline?: AudioTimelineStatus;
}

export interface AudioTimelineStatus {
  state: "running" | "paused_by_user" | "disabled_by_safety_switch" | "unavailable";
  route?: "usb_vendor_hid" | "ble_gatt" | "usb_uac" | "system" | null;
  unavailableReason?: string | null;
  hotRingDurationMs: number;
  cacheDurationMs: number;
  cacheHealth: "healthy" | "degraded" | "disabled";
  continuousRecordingEnabled: boolean;
  recordingState: "disabled" | "running" | "degraded";
  sttBacklog: number;
  hostLocalDropFrames: number;
}

/** Host 托管的短时音频引用。插件拿不到本地路径，也不能把它发给任意端点。 */
export interface VoiceAudioRef {
  /** 就是本次录音的 sessionId——不另造一套 id 空间。 */
  id: string;
  expiresAt: string;
  durationMs: number;
  /** 报实话：实际发给云端的就是 WAV。 */
  format: "wav";
}

/**
 * 这次按键语音留下的回听片段。
 *
 * 只有满足全部条件才有：插件握着 `voice.recordings@1`、设置里的调用方有录音
 * 权限且这一段真的落盘成功。Host API 1.22 起输入法与语音命令（翻译 / Agent）
 * 都落盘，命令会话同样返回；旧 Host 只在输入模式返回。插件把它记在对应的
 * 历史条目上，详情页据此回听；拿不到就是这条只有文字，原因见
 * `VoiceInputResult.replayClipStatus`。
 */
export interface VoiceReplayClipRef {
  /** 录音 id，传给 `voiceRecordings.authorizePlayback`。 */
  id: string;
  /** 片段起始墙钟毫秒。与 `replayCacheStatus().retainedSinceMs` 比大小即知还在不在。 */
  wallStartMs: number;
  durationMs: number;
  /**
   * Host 按气口向外修正后的实际回放/转写边界。旧 Host 不传时，
   * 插件回退到 wallStartMs + durationMs。原始时长仍用于缓存占用统计。
   */
  effectiveStartMs?: number;
  effectiveEndMs?: number;
}

export type VoiceReplayClipStatus = "saved" | "not_retained" | "failed";

/** 录音会话的单次交付凭证；不绑定录音时的输入框，插件不能伪造或反解。 */
export interface VoiceDeliveryTargetRef {
  id: string;
  expiresAt: string;
}

export interface VoiceInputResult {
  phase: "listening" | "idle";
  sessionId?: string;
  /**
   * `cancelled` 是用户主动终止，不等于「识别完成但没有听清」。旧 Host 不返回时
   * 保持可选，调用方按既有 transcript 语义降级。
   */
  outcome?: "recognized" | "cancelled";
  /**
   * 本地识别文本。走 `retainAudio` 的云端路径时为 `null`——
   * 没跑本地识别就没有 transcript，不编一个空串假装识别过。
   * 例外：Host 依据整段静音判定确认这段没有内容（带 `noSpeechReason`）时，
   * 云端路径也返回 `""`，且不带 `audio`——没有可上传的音频。
   */
  transcript?: string | null;
  /**
   * Host 判定这段没有可写的内容（2026-10-16，#1291）：`too_short` = 有效录音不足 100ms 且没有
   * 任何语音证据；`silence` = 整段静音；`suppressed` = 本地识别只得到纯标点或公认的静音幻觉整句。
   * 出现时 `transcript` 为 `""`、不带 `audio`（不会上传计费），`warningCode` 为 `"no_speech"`；
   * 中央胶囊由 Host 显示「没听到声音」并自行计时收起，调用方的确认或取消都不会提前收掉它。
   * 调用方按「没听清」处理即可，不要写回、不要弹取回卡。旧 Host 不返回。
   */
  noSpeechReason?: "too_short" | "silence" | "suppressed";
  /** 只有 `retainAudio: true` 的那次录音才有。传给 `aiApi.transcribe`。 */
  audio?: VoiceAudioRef;
  /** 这次录音留下的回听片段；没留就没有。 */
  replayClip?: VoiceReplayClipRef | null;
  /**
   * Host API 1.22：回听片段的落盘结局，与识别并行、互不影响。`saved` 时
   * `replayClip` 非空；`not_retained` = 按授权 / 保留设置不留或没有可留的音频；
   * `failed` = 落盘失败或超时，本次结果拿不到片段引用（超时的那段仍可能稍后
   * 入库，以 `listRecoverableInputSessions` / 按 id 取件为准）。旧 Host 不返回。
   */
  replayClipStatus?: VoiceReplayClipStatus;
  /** `phase: "listening"` 时返回；停止后可认领一次；macOS Host 在交付时才采集当前输入框。 */
  deliveryTarget?: VoiceDeliveryTargetRef;
  language?: string;
  inserted?: boolean;
  source?: VoiceInputSource;
  durationMs?: number;
  warningCode?: string | null;
  mode?: VoiceInputMode;
  /**
   * Host API 1.22：这段识别已被 Host 自己的界面消费（`"tab_layer"` = Tab 层语音搜索）。
   * 出现时该会话的写回凭证已撤销，调用方不应再 `delivery.commit`（只会得到 `expired`），
   * 也不要弹取回卡。旧 Host 不返回。
   */
  consumedBy?: "tab_layer";
}

export interface VoiceModelInfo {
  id: string;
  name: string;
  description: string;
  sizeBytes: number;
  state: VoiceModelState;
  downloadedBytes?: number;
  /** Retained download bytes survive cancellation/restart. Absent on older Hosts. */
  resumeAvailable?: boolean;
  active: boolean;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  error?: string;
}

export interface VoicePermissionInfo {
  /** Host API 1.17+: current route requires system microphone access. Missing on older Hosts.
   * Actual TCC states below are never replaced with a synthetic grant. */
  microphoneRequired?: boolean;
  microphone: VoicePermissionState;
  accessibility: VoicePermissionState;
  /** 五档音源的只读事实；旧 Host 不返回。查询不开端点、不请求权限。 */
  audioSources?: VoiceAudioSourcesInfo;
}

export interface VoiceAudioSourcesInfo {
  /** Host 持久策略的真值；`legacy_board_uac` 是旧 USB Audio 兼容态，不属于五档。 */
  mode: VoiceAudioSourceMode | "legacy_board_uac";
  /** 硬件麦（键盘 USB / 蓝牙）：可用 / 未连接 / 固件过旧 / 正在检查。 */
  hardware: "available" | "disconnected" | "firmware_too_old" | "checking";
  /** 电脑麦：可用（有设备且已授权）/ 有设备未授权 / 没有输入设备。 */
  computer: "available" | "permission_required" | "missing";
  /** 按当前档位，下一次录音会用哪一类麦。 */
  resolved: "board" | "system" | "unavailable";
}

/** Optional visual identity; does not alter capture, delivery or command semantics.
 * Older Hosts ignore this hint and retain their input/task presentation. */
export type VoiceOverlayKind = "input" | "translate" | "task";

export interface VoiceInputStartOptions {
  overlayKind?: VoiceOverlayKind;
  /** Provider 在权限完成后、紧邻 start 才生成的 30 秒时间前缀 UUID。 */
  requestId: string;
  mode?: VoiceInputMode;
  /**
   * @deprecated Host API 1.22 起识别与插入解耦：请传 `false`，拿到文本后由业务分支经
   * `delivery.commit` 写回。本阶段仍生效（缺省 true 时 Host 对 Input 会话本地直写），
   * 待锁定的旧版插件退役后移除。
   */
  insertText?: boolean;
  retainAudio?: boolean;
  /** 服务模式 false，不捕获或覆盖 Voice 自身的写回目标。 */
  captureDeliveryTarget?: boolean;
  captureLimitAction?: "preserve" | "finish";
  retainResultUntilAck?: boolean;
  /** 见 {@link VoiceHoldOverlayOption.holdOverlayUntilAck}。 */
  holdOverlayUntilAck?: boolean;
}

/**
 * 写回阶段，只改中央胶囊那一句：`transcribing` 正在转写、`transcribed` 转写完成、
 * `processing` 为真实 Agent 反馈；`polishing` 正在润色、`translating` 正在翻译、`insert_failed` 文字没有写入（胶囊等待取回窗口可见确认后收）。
 */
export type VoiceReportedStage =
  | "processing"
  | "transcribing"
  | "transcribed"
  | "polishing"
  | "translating"
  | "insert_failed";

export interface VoiceHoldOverlayOption {
  /**
   * Host API 1.22（2026-09-28 同版本并入）起：`mode: "input"` 会话识别结束后，中央胶囊不再固定 1.2 秒收起，而是停在
   * 处理态，直到调用方写入成功后调 `acknowledgeResult(sessionId)` 那一刻才收。空结果与取消
   * 立即收起；连续 60 秒没有任何推进（`reportStage` / 确认）时 Host 兜底：胶囊切到失败态并弹出
   * 无文字失败卡，停 6 秒后收起。旧 Host 忽略此项。
   */
  holdOverlayUntilAck?: boolean;
}

export interface VoiceInputClient {
  /** Show a Host-owned, non-recording global capsule while command startup checks run. */
  beginPreparing(requestId: string, overlayKind?: VoiceOverlayKind): Promise<void>;
  /** Hide only the matching preparation capsule; a later recording is never affected. */
  endPreparing(requestId: string): Promise<void>;
  /** 原子启动；已有任何录音时只报 busy。要求匹配 Host SDK，禁止 toggle 回退。 */
  start(options: VoiceInputStartOptions): Promise<VoiceInputResult>;
  /** 只结束该 session；不能以第二次 start 或无 session toggle 代替。 */
  finish(sessionId: string): Promise<VoiceInputResult>;
  /** 取消尚在启动中的精确 handle，也阻止尚未登记的迟到启动。 */
  cancelPendingStart(requestId: string): Promise<void>;
  getStatus(sessionId?: string): Promise<VoiceInputStatus>;
  configure(settings: VoiceInputSettings): Promise<void>;
  /**
   * 开始 / 结束一段录音。
   *
   * `retainAudio: true` 把音频留给云端转写，并**同时关掉本地识别与模型强制要求**：
   * 跑本地识别是白费一次延迟，还逼没装模型的用户先下 1GB——而云端通道存在的
   * 意义正是「不必先下模型」。本地识别仍是默认路径，不受影响。
   */
  toggle(options?: {
    overlayKind?: VoiceOverlayKind;
    mode?: VoiceInputMode;
    /** @deprecated 同 {@link VoiceInputStartOptions.insertText}。 */
    insertText?: boolean;
    retainAudio?: boolean;
  } & VoiceHoldOverlayOption): Promise<VoiceInputResult>;
  /**
   * 调用方已经消费（或明确丢弃）这次同步识别结果或异步停止终态。Host 只会结算
   * 同一 App、同一 session；迟到和重复确认都是幂等空操作。
   */
  acknowledgeResult(sessionId: string): Promise<{ acknowledged: boolean }>;
  /**
   * 声明了 `holdOverlayUntilAck` 的会话在写回途中报告阶段，Host 只更新胶囊那一句并记一次推进。
   * 不是这次调用方的会话、胶囊已换代或已收起时返回 `accepted: false`，不影响业务流程；
   * 不认识的阶段同样返回 false。同一次待确认里阶段只进不退（transcribing < transcribed <
   * processing / polishing / translating < insert_failed），比已受理阶段更早的迟到上报返回 false。insert_failed 之后若要
   * 确认（回收保留的回执），须等这次上报实际返回再发，否则确认先到会收起胶囊。2026-09-28 并入 1.22；更早的 1.22 Host 会拒绝未知方法，调用方应吞掉错误。
   * processing 的 label 来自实际 Agent 反馈，最多200字符；不传保持旧payload。
   */
  reportStage(sessionId: string, stage: VoiceReportedStage, label?: string): Promise<{ accepted: boolean }>;
  /** 取消并明确丢弃当前调用；传 sessionId 时不会误伤同 App 随后启动的新会话。 */
  cancel(sessionId?: string): Promise<void>;
  listModels(): Promise<VoiceModelInfo[]>;
  downloadModel(modelId: string): Promise<VoiceModelInfo>;
  cancelModelDownload(modelId: string): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  checkPermissions(): Promise<VoicePermissionInfo>;
  requestPermission(kind: VoicePermissionKind): Promise<VoicePermissionState>;
  getTimelineStatus(): Promise<AudioTimelineStatus>;
  setTimelinePaused(paused: boolean): Promise<AudioTimelineStatus>;
  clearTimelineCache(): Promise<AudioTimelineStatus>;
  setContinuousRecording(enabled: boolean): Promise<AudioTimelineStatus>;
  listSystemInputs(): Promise<SystemInputEndpoint[]>;
}
