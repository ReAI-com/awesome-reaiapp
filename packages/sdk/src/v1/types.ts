/** SDK 对 App 暴露的类型。 */

import type { VoiceInputClient } from "./voice-input";
import type { VoiceRecordingsClient } from "./voice-recordings";
import type { VoiceContextClient } from "./voice-context";
import type { VoiceCommandClient } from "./voice-command";
import type { FolderPickClient } from "./folder-pick";
import type { SystemTaskClient } from "./system-tasks";
import type { LocalAgentClient } from "./local-agent";
import type { DshAgentClient } from "./dsh-agent";
import type { AgentSessionClient } from "./agent-session";
import type { PiManagementClient } from "./pi-management";
import type { DshObserverClient } from "./dsh-observer";
import type { CodexTasksClient } from "./codex-tasks";
import type { LocalFilesClient } from "./local-files";
import type { LocalTtsClient } from "./local-tts";
import type { AppServicesClient, AppGatewayClient } from "./services";
import type { TerminalSessionClient } from "./terminal-session";
import type { DeveloperPlatformClient } from "./developer-platform";
import type {
  CloudAiClient,
  CloudDeliveryClient,
  CloudFlowClient,
  CloudStreamEvent,
} from "./cloud";

/** 私有 KV 存储。命名空间由 Host 按 `appId/storeId` 强制，App 改不了。 */
export interface KeyValueStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  /** Host API 1.20: atomic durable CAS; undefined means absent, null is a value. */
  compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface AccountStatusResult {
  enabled: boolean;
  loggedIn: boolean;
}

/** `apps.status`（A3-24 门控数据源）的结果：只答「装没装、启没启」两件事。 */
export interface AppDependencyStatus {
  appId: string;
  installed: boolean;
  enabled: boolean;
}

/** 系统通知最小纯文本负载。归属标题与真实系统投递由 Host 控制。 */
export interface NotificationPostOptions {
  title: string;
  body: string;
}

/** queued 只表示 Host 已加入本地发送队列，不保证系统最终展示。 */
export interface NotificationPostResult {
  queued: true;
}

export interface AppHttpFetchOptions extends RequestInit {
  /** 严格预览/发布模式下可显式选择 Manifest 中声明的 endpoint。 */
  endpointId?: string;
}

export interface AppHttpClient {
  /** 所有外部 HTTP(S) 请求由 Host Broker 执行；返回标准 Web Response。 */
  fetch(input: RequestInfo | URL, init?: AppHttpFetchOptions): Promise<Response>;
}

/** 一次 Surface mount 的句柄。 */
export interface SurfaceHandle<TIntent = unknown> {
  readonly surfaceId: string;
  /** 本次 mount 的唯一 id。关掉再打开会换一个新的。 */
  readonly surfaceMountId: string;
  /** 承载 App DOM 的根节点，由 Host 的 bootstrap 页面提供。 */
  readonly root: HTMLElement;
  /** 打开时携带的意图（来自 Command / 侧栏 / 其他 App）。 */
  readonly initialIntent?: TIntent;

  /**
   * 宣告已就绪，Host 可以展示了。
   *
   * 与 [`fail`](SurfaceHandle.fail) **二选一且恰好一次**。不调用的话 Host 会在超时后
   * 判定 mount 失败——这不是宽容，是防止用户对着永远转圈的空白页干等。
   */
  ready(): void;

  /** 宣告起不来。与 `ready` 二选一且恰好一次。 */
  fail(error: unknown): void;

  /** 报一个非致命错误（比如一次保存失败）。Surface 继续可用，可多次调用。 */
  reportError(error: unknown): void;

  /**
   * 上报内部自主导航状态（面包屑合同，审计 B2-3）：Host 据此在 titlebar 面包屑
   * 显示「App / 子页」路径并承载返回。每次页面变化都要报（含挂载后的初始态）；
   * `null` 表示回到根页。
   *
   * **可选能力**：插件跑在 Host 注入的 SDK 运行时上（不打包 SDK），旧 1.5 运行时
   * 没有这个方法——调用方必须 `typeof surface.reportNav === "function"` 探测，
   * 缺席时退化为「面包屑只有根段」，不是错误。
   */
  reportNav?(nav: { key: string; label: string } | null): void;

  /** Optional on Hosts that provide a live presentation binding. */
  readonly navigation?: import("./navigation").SurfaceNavigation | undefined;

  /**
   * Host 为本次挂载提供新的呈现绑定时调用；已有绑定在订阅时同步回放。
   * 这不证明物理可见，也不授予权限。旧运行时可能没有此方法，须探测后调用。
   * 返回幂等退订函数；卸载或运行时销毁后不再通知。
   */
  onPresentationChange?(handler: () => void): () => void;

  /** 订阅后续意图。返回退订函数。 */
  onIntent(handler: (intent: TIntent) => void): () => void;
}

/**
 * Host 标题栏动作投递的可判别信封；`payload` 来自 Manifest 的 intent。
 * `source` 属于 Host 保留字段：App-to-App `apps.open()` 会拒绝带顶层 source 的 input。
 */
export interface HostTitlebarActionIntent<TPayload = unknown> {
  source: "host.titlebarAction";
  actionId: string;
  deliveryId: string;
  payload: TPayload;
}

/**
 * Surface 的挂载处理器。
 *
 * 返回的函数会在 SDK 收到 unmount 时调用——**App 自建的资源必须在这里释放**。
 * SDK 只负责撤销自己发出的注册，管不了 App 的定时器、订阅和监听器。
 * 当前生产 Host 尚未保证所有关闭路径都会发送 unmount，因此清理函数必须幂等，且未释放资源
 * 不得继续产生外部副作用。
 */
export type SurfaceMountHandler<TIntent = unknown> = (
  surface: SurfaceHandle<TIntent>,
) => void | (() => void) | Promise<void | (() => void)>;

/** Command 处理器的上下文。 */
export interface CommandInvocation<TInput = unknown> {
  /** Generic paired operation; end must never start a new operation. */
  operation?: { id: string; phase: "start" | "end" };
  input: TInput;
  /** 收到 Host 的 command.cancel 时触发。Host 超时或撤销操作时会发送 cancel。 */
  signal: AbortSignal;
}

export type CommandHandler<TInput = unknown, TOutput = unknown> = (
  invocation: CommandInvocation<TInput>,
) => TOutput | Promise<TOutput>;

/** `activate` 拿到的上下文。 */
export interface AppContext {
  /** Host UI language; no capability or permission grant is needed. */
  readonly locale: import("./locale").LocaleClient;
  /** 本次 activate 的会话 id。Bridge 与一次性凭据都绑它。 */
  readonly runtimeSessionId: string;
  /** Host-owned, read-only environment flags. */
  readonly environment: {
    get(): Promise<{ developerMode: boolean }>;
    onChange(handler: (value: { developerMode: boolean }) => void): () => void;
  };

  readonly http: AppHttpClient;

  /** 官方 Voice Input 插件的原生音频/STT/文字注入窄口。Host 仍会逐次校验 grant。 */
  readonly voiceInput: VoiceInputClient;
  /** Shared Host source; current Host descriptor, platform approval and consent are required. */
  readonly audioCapture: import("./platform-contracts").AudioCaptureClient;
  /** Bounded owned clips; every call checks the current Host descriptor and authority. */
  readonly audioClips: import("./platform-contracts").AudioClipsClient;
  /**
   * `resources.files@1`: user-selected local folders and user-confirmed cloud Projects.
   * Every call checks the current Host descriptor, platform approval and user consent.
   */
  readonly resourceFiles: import("./platform-contracts").ResourceFilesClient &
    import("./platform-contracts").ResourceRootsClient &
    import("./platform-contracts").ResourceCloudRootsClient;
  /** Neutral task/result presentation; current Host authority, approval and consent are required. */
  readonly tasks: import("./platform-contracts").TaskPresentationClient;
  /** 持久录音列表/删除/一次性播放授权；不暴露 Host 私有路径。 */
  readonly voiceRecordings: VoiceRecordingsClient;
  /** 润色上下文采集（`voice.context@1`）：有界焦点文字 / 窗口截图 + 应用粗分类 + 只读权限状态。 */
  readonly voiceContext: VoiceContextClient;
  /** URL 与外壳的 OAuth token 始终留在 Host。 */
  readonly voiceCommand: VoiceCommandClient;
  /** 本地 Audio8 TTS：录音、模型、声纹与生成均由 Host 托管。 */
  readonly localTts: LocalTtsClient;

  /**
   * 中转各家大模型服务商既有 API 的纯管道（`cloud.model.invoke@1`）。
   * 需要 Manifest 同时声明同名平台能力与用户权限，且由用户在安装时同意。
   */
  readonly aiApi: CloudAiClient;
  /**
   * 调用已编排好、导出成 API 的工作流（`cloud.workflow.invoke@1`）。
   * 与 `aiApi` **并列**，不是它的编排版。
   */
  readonly flowApi: CloudFlowClient;
  /** 把最终文本写入交付时当前聚焦的可写输入框（`voice.deliver@1`）。 */
  readonly delivery: CloudDeliveryClient;
  /**
   * 本地 agent 内核窄口（`agent.local@1`）。只授予官方 seed 插件（设备诊断助手）：
   * 只读工具 + 日志摘要经云端分析，只支持文字。
   */
  readonly localAgent: LocalAgentClient;
  /**
   * DSH 基础底座服务窄口（`agent.dsh@1`）。按请求孵化一次性引擎进程，
   * `sessionId` 续跑持久会话（跨请求记忆 + 前缀缓存）；会话归属 Host 强制。
   */
  readonly dshAgent: DshAgentClient;
  /** Harness 无关的通用 Agent Session 服务（`agent.session@1`）。 */
  readonly agent: AgentSessionClient;
  /** 官方 Pi Agent 管理插件专用的跨 App 只读与模型设置窄口。 */
  readonly piManagement: PiManagementClient;
  /** 官方 DSH 插件专用的跨 App 脱敏透明度与新会话默认模型窄口。 */
  readonly dshObserver: DshObserverClient;
  /** 受控系统任务；插件拿不到设置路由、下载地址、文件路径或底层设备句柄。 */
  readonly systemTasks: SystemTaskClient;
  /** 让用户亲手挑一个目录（`system.folder-pick@1`）。 */
  readonly folderPick: FolderPickClient;
  /** Driver-owned 官方 Codex app-server work 客户端。 */
  readonly codexTasks: CodexTasksClient;
  /** 官方文本编辑器的本地 UTF-8 文件 Broker。 */
  readonly localFiles: LocalFilesClient;
  /** 受审核的交互式 Shell；进程、PTY 与调用方身份均由 Host 托管。 */
  readonly terminal: TerminalSessionClient;
  /** 精确系统插件 `com.reai.developer-center` 专用的开放平台管理窄口。 */
  readonly developerPlatform: DeveloperPlatformClient;

  /** Explicit local-device delegation of this plugin’s declared services (Host API 1.20). */
  readonly gateway: AppGatewayClient;

  readonly storage: {
    /** 取一个 Manifest 里声明过的私有 store。未声明的 id 会被 Host 拒绝。 */
    private(storeId: string): KeyValueStore;
  };

  readonly account: {
    /**
     * 只查询 OAuth 功能是否启用与当前是否登录；不返回用户身份或凭据。
     * 这是刻意边界：外壳不替插件转发身份。插件需要身份时应经外壳通道用
     * 自己的外脑 OAuth App 令牌去取（链路规划中，见主仓
     * plans/2026-08-14-plugin-oauth-parent-child-architecture.md）。
     */
    status(): Promise<AccountStatusResult>;
  };

  readonly notifications: {
    /** 需在 Manifest 声明 `os.notification.post@1` 并由用户明确允许。 */
    post(options: NotificationPostOptions): Promise<NotificationPostResult>;
  } & import("./platform-contracts").NotificationsV1Client;

  /** 受 Host grant 保护的纯文本剪贴板写入口。 */
  readonly clipboard: {
    writeText(text: string): Promise<{ written: true }>;
  };

  readonly commands: {
    /** 注册一个 Manifest 里声明过的 Command。只能在 activate 期间调用。 */
    register<TInput = unknown, TOutput = unknown>(
      commandId: string,
      handler: CommandHandler<TInput, TOutput>,
      options?: { supportsOperations: boolean },
    ): void;
  };

  readonly surfaces: {
    /** 注册一个 Manifest 里声明过的 Surface。只能在 activate 期间调用。 */
    register<TIntent = unknown>(surfaceId: string, handler: SurfaceMountHandler<TIntent>): void;
    /** 请求 Host 打开本 App 的某个 Surface。 */
    open(
      surfaceId: string,
      payload?: { intent?: unknown },
      options?: { signal?: AbortSignal },
    ): Promise<void>;
  };

  readonly tabItems: {
    /**
     * 向 Tab 层供给/更新一条实体（C1-3）。花名册语义：同 entityId 重推 = 重排
     * 到最前，不产生第二条。`requiresInteraction` 只许配 `waiting_input`——
     * 「需交互」旗只给需要用户决策的状态，滥用会被 Host 门禁拒绝。
     * 需在 Manifest 声明 `contributes.tabItems`。
     */
    upsert(item: TabItemUpsert): Promise<void>;
    /** Host user display preference; read again after onChange. */
    isVisible(): Promise<boolean>;
    onChange(handler: () => void): () => void;
    /** 移除一条实体（幂等；「决策已完成」落旗后清掉就走这里）。 */
    remove(entityId: string): Promise<void>;
    /** 列出本 App 当前供给的全部条目。 */
    list(): Promise<TabItemInfo[]>;
  };

  readonly actionItems: {
    /**
     * 把一条快捷挂到 Action 层（C-3b）。**这是用户的意愿，不是插件的推送**：
     * 只在用户勾选/打开开关时调，别在 activate 里自动挂——那一层的定性是
     * 「内容只在你改挂载时才变」。
     *
     * - `kind: "command"`：本 App manifest 里声明过的 Command（Host 只存
     *   「哪些被挂了」，标题跟着 manifest 走）。不需要额外声明。
     * - `kind: "item"`：**运行时条目**（manifest 里没有的东西，如 Codex 的
     *   Skill），必须在 Manifest 声明 `contributes.actionItems`，且必须带
     *   `target`——按下去要有去处。
     *
     * 挂载记录由 Host 持久化：插件没启动或被停用时，用户挂过的条目仍在层里
     * （标为不可用），不会消失。
     */
    mount(item: ActionItemMount): Promise<void>;
    /** Invalidation only. Call list() to read your own current mounts. */
    onChange(handler: () => void): () => void;
    /** 取消挂载（幂等）。 */
    unmount(kind: ActionItemKind, id: string): Promise<void>;
    /** 列出本 App 当前被挂着的条目（渲染勾选态用）。 */
    list(): Promise<ActionMountInfo[]>;
  };

  readonly evidence: {
    /**
     * 凭广播里的 pickupToken 取存证字节（C1-5）。一次性：取后即焚；
     * 存证本体 TTL 到期后不可再取。
     */
    fetch(pickupToken: string): Promise<Uint8Array>;
  };

  readonly events: {
    /**
     * 注册 Host 事件处理器（C1-2）。收哪类事件由 Manifest
     * `contributes.eventSubscriptions` 声明——没声明的类型 Host 不会投。
     * 只能在 activate 期间调用。
     */
    on(handler: (event: AppEvent) => void): void;
    /** `agent.codex@1` 的 thread 状态摘要；SDK 已校验 runtime + mount 身份。 */
    onCodex(handler: (event: unknown) => void): void;
    /**
     * 两条云端通道的增量与终局。SDK 已校验 runtime + mount 身份。
     *
     * 只能在 activate 期间注册——`ai.text.generate({stream:true})` 立刻返回，
     * 增量随后才来，注册晚了就会丢开头那几条。
     */
    onCloud(handler: (event: CloudStreamEvent) => void): void;
    /**
     * 本地 agent 内核（`agent.local@1`）的回合进度。SDK 已校验 runtime + mount 身份。
     * 只能在 activate 期间注册——send() 立刻开始回合，注册晚了会丢开头的进度事件。
     */
    onLocalAgent(handler: (event: import("./local-agent").LocalAgentEvent) => void): void;
  };

  readonly apps: {
    /**
     * 请求 Host 把一个意图投递给另一个 App。
     *
     * 成功只表示**已被接受**，不表示对方已经挂载出来。目标没装会以稳定错误码
     * `APP_INTENT_TARGET_NOT_INSTALLED` 拒绝。
     */
    open(
      target: { appId: string; intent: string },
      input?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<void>;
    /**
     * 查一个跨插件依赖目标的安装状态（A3-24 门控数据源）。
     *
     * 只许查自己 Manifest `requires.appIntents` 里声明过依赖的 App——Host 会拒绝
     * 未声明目标的查询（这不是安装清单通道）。目标没装是**成功的查询结果**
     * （`installed: false`），不是错误。
     */
    status(target: { appId: string }): Promise<AppDependencyStatus>;
  };
  /** 类型化跨 App 服务；与只做导航/投递的 apps.intent 分开。 */
  readonly services: AppServicesClient;
}

/** Tab 层实体 upsert 负载（C1-3）。 */
export interface TabItemUpsert {
  entityId: string;
  title: string;
  icon?: string;
  status: "running" | "waiting_input" | "completed" | "error";
  requiresInteraction?: boolean;
  /** 点击跳转目标：surfaceId 必填，intent 可选。 */
  target?: { surfaceId: string; intent?: unknown };
}

/** Tab 层实体条目（Host 侧快照形状）。 */
export interface TabItemInfo extends TabItemUpsert {
  appId: string;
  createdAt: number;
  activatedAt: number;
}

/** Action 层挂载条目的两种来源（C-3b）。 */
export type ActionItemKind = "command" | "item";

/** `actionItems.mount` 的负载。 */
export interface ActionItemMount {
  kind: ActionItemKind;
  /** command 类是 commandId；item 类是插件自定的条目 id。 */
  id: string;
  /** 层里显示的标题。command 类会被 manifest 里的标题覆盖。 */
  title: string;
  /** 副标题素材。command 类由 Host 拼成「插件名 · 说明」；item 类原样显示。 */
  detail?: string;
  /** 右侧那一小格的静态素材（如 Skill 所属目录名）。 */
  badge?: string;
  icon?: string;
  /** item 类必填：按下时打开哪块画布、投什么 intent。command 类不接受。 */
  target?: { surfaceId: string; intent?: unknown };
}

/** Host 侧的挂载记录快照。 */
export interface ActionMountInfo extends Omit<ActionItemMount, "id"> {
  appId: string;
  /**
   * ⚠️ 快照里这个字段叫 `itemId`，**不是**请求负载里的 `id`——Host 侧是
   * `ActionMount.item_id` 的 camelCase。两边不同名，所以这里不能直接
   * `extends` 整个请求形状。
   *
   * （tabItems 的请求与快照都叫 `entityId`，照抄它的 `extends` 会让读回来的
   * id 恒为 undefined，「取消挂载」整条路当场变成死路。）
   */
  itemId: string;
  mountedAt: number;
}

/** 一条 Host 事件（C1-2）。 */
export interface AppEvent {
  /** 事件类型（如 `actionContext`），与 Manifest 声明对应。 */
  eventType: string;
  payload: unknown;
}

/** `defineApp` 的入参。 */
export interface AppDefinition {
  activate(ctx: AppContext): void | Promise<void>;
  /** 释放 App 级资源。SDK 会自己撤销注册，这里只管 App 自建的东西。 */
  deactivate?(): void | Promise<void>;
}
