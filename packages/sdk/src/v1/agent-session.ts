import type { AgentConfig, AgentServiceClient } from "./agent-service";
import type { AuthorizedResource } from "./platform-contracts";
/** Harness 无关的 Agent Session 合同（`agent.session@1`）。 */

export type AgentBackend = "auto" | "pi" | "dsh" | "codex";
export type ResolvedAgentBackend = Exclude<AgentBackend, "auto">;
export type AgentMemoryMode = "session" | "one-shot";

export interface AgentSkillDocument {
  id: string;
  title: string;
  /** 只读 UTF-8 文档；不会作为脚本、插件或包加载。 */
  content: string;
  digest?: string;
}

/**
 * 会话工作区（M3 Workspace v2 + Host API 1.21 F02）。
 *
 * - `app-private`：Host 为会话分配的独立工作根（申请文件 / 命令工具时才建），
 *   不是插件设置或凭据目录，也不是整个 Host 数据目录；
 * - `direct`（1.21）：直接使用本插件经 `system.folder-pick@1` 授权的原目录，
 *   读写不经镜像、不承诺自动回滚；范围外的目标由 Host 可信界面逐次单次确认，
 *   插件不能代替用户批准；
 * - `mounted`：用户挂接目录。`path` 必须是本插件经 `system.folder-pick@1`
 *   原生面板选出并授权过的目录（或其子目录）——「folder-pick 即授权」，
 *   插件不能凭任意路径自授，未授权路径创建会返回
 *   `AGENT_WORKSPACE_NOT_AUTHORIZED`。挂接后 Host 在本地建 git worktree
 *   镜像：agent 的文件改动先落镜像（改动前自动 commit，可回溯回滚），
 *   写回用户目录时做冲突检测。旧 mounted 会话不会自动转成 direct。
 * - `resource`（v1.0.5）：本插件经 `resources.files@1` 授权的目录根
 *   （`resourceFiles.pickRoot()` / `listRoots()` 返回的 `root.resource`）。
 *   引用不自带权限：创建时 Host 以当前插件身份复核一次，之后 Pi / DSH / Codex
 *   的同名文件工具（read/write/edit/list/glob/grep）全部经资源 provider 分派、
 *   每次重新准入（撤回授权即失效）。不提供 `run` / `command`。
 *   需要插件同时获批 `resources.files@1` 并得到用户同意；云项目根暂不可用。
 */
export type AgentWorkspace =
  | { kind: "app-private" }
  | { kind: "direct"; path: string }
  | { kind: "mounted"; path: string }
  | { kind: "resource"; root: AuthorizedResource };

/**
 * 三档写权限（M3；封闭词表，不发明新词）。拨杆绑定是键盘自己的行为，
 * 插件只消费这三个值（终决④）。
 * - `chat`：只读——文件写命令被拒绝，改动留在镜像等用户确认；
 * - `plan`：只允许写 plan 类型的 md 文件（如 plan.md）；
 * - `yolo`：已授权工作范围内自由写（镜像会话写回用户目录）；范围外仍必须经 Host 确认，
 *   `command` 只在这一档开放。
 */
export type AgentTurnMode = "chat" | "plan" | "yolo";

/** 标准 CLI 命名的文件工具；1.21 起 app-private / direct / mounted 三种工作区都可授予。 */
export type AgentFileTool = "read" | "write" | "edit" | "list" | "glob" | "grep";

/**
 * 1.21：工作范围内的 shell 命令（仅 direct / app-private + yolo，macOS）。
 * 系统层只放行工作范围与本次临时目录；`extraPaths` 里的范围外路径逐条经 Host 单次确认。
 */
export type AgentCommandTool = "command";

export interface AgentSessionSpec {
  backend: AgentBackend;
  systemPrompt: string;
  /** Host Tool Catalog 的稳定工具 id；最多 32 项；范围执行能力须由 backend 显式声明。 */
  tools: (string | AgentFileTool | AgentCommandTool)[];
  skills: AgentSkillDocument[];
  /** 1.21 新增 direct；mounted 的镜像语义保持不变；旧 Host 只认 app-private。 */
  workspace: AgentWorkspace;
  memory: AgentMemoryMode;
  /** M3 起提供；缺省 chat（旧 Spec JSON 零迁移）。 */
  mode?: AgentTurnMode;
}

/** 模型来源渠道（M1 起进入合同）：外脑云代理 / Codex 订阅（M3/M4 接入）。 */
export type AgentBackendChannel = "external-brain" | "codex-subscription";

/** backend 能力声明。槽位描述「现在为真」的事实；未来能力先入合同、值保守。 */
export interface AgentBackendCapabilities {
  /** 是否支持 Spec.tools 的 Host 白名单工具。 */
  hostTools: boolean;
  /** 镜像文件工具（M3 起三 backend 均为 true；仅挂接会话实际可用）。 */
  fileTools: boolean;
  /** 回合模式档位（M3 起三 backend 均为 ["chat","plan","yolo"]）。 */
  turnModes: string[];
  /** `host-settings` = Host 侧设置解析；`spec` = Spec 直传（M2）。 */
  modelSelection: "host-settings" | "spec";
  /**
   * 1.21：`1` = Host 强制执行工作范围（direct / app-private 独立工作根、越界单次确认）。
   * 缺席不能视为支持——当前只有 macOS 提供。
   */
  scopedExecutionVersion?: 1;
  /** 1.21：当前 backend 可用受 Host 工作范围约束的 `command` 工具；缺席 = 不支持。 */
  commandExecution?: boolean;
  configuration?: {
    schemaVersions: number[];
    modelChannels: AgentBackendChannel[];
    modelTiers: string[];
    modelParameters: string[];
    outputFormats: string[];
    skillLoading: string[];
    toolConfiguration: boolean;
    /**
     * 1.23：本 Host 接受 AgentConfig.featureRef（插件 Agent 功能声明）。缺席 =
     * 旧 Host，创建会话时应省略该字段，否则整包会被拒绝。
     */
    featureRef?: boolean;
    /** Additive probe; absence keeps file inputs closed even on an older 1.24 Host. */
    attachmentInputVersion?: 1;
    delivery: "buffered" | "streaming";
    durableTurns: boolean;
    resultRetentionSeconds: number;
    idempotencyRetentionSeconds: number;
  };
}

export interface AgentBackendStatus {
  backend: ResolvedAgentBackend;
  available: boolean;
  detail: string;
  /**
   * 当前插件缺少可用的托管运行组件引用（组件未安装或尚未获授权）。
   * `detail` 是诊断文案，不要解析。引导到来源插件的 app-managed-resources
   * 由 Host 确认安装或使用授权；不能仅凭此字段断言共享组件未安装。
   */
  downloadRequired?: boolean;
  /** 模型来源渠道（M1 起提供）。 */
  channel?: AgentBackendChannel;
  /** 能力描述符（M1 起提供）。 */
  capabilities?: AgentBackendCapabilities;
}

export interface AgentHistoryItem {
  role: "user" | "assistant";
  text: string;
}

export interface AgentSessionSummary {
  sessionId: string;
  backend: ResolvedAgentBackend;
  memory: AgentMemoryMode;
  createdMs: number;
  updatedMs: number;
  /** 后端 profile 已升级；保留历史，但下一条消息应新建会话。 */
  stale: boolean;
}

/** Real provider usage for a single turn, including all model calls. */
export interface AgentTokenUsage {
  /** False if any call omitted usage; partial counters are never a turn total. */
  complete: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentSendResult {
  /** 终局 envelope 版本（M1 起提供；未知版本按缺省处理）。 */
  schemaVersion?: number;
  turnId: string;
  text: string | null;
  /** Host 实际解析并执行的内核；auto 永远不会作为终局值返回。 */
  runtime?: "pi" | "dsh" | "codex";
  /** 仅在底层真实提供本回合统计时返回，绝不估算。 */
  usage?: AgentTokenUsage | null;
  /** Actual model transport, not inferred from current settings. */
  channel?: "external-brain";
  /**
   * 挂接会话的镜像收尾报告（M3 起提供；AppPrivate 会话缺席）。
   * - `committed`：回合内镜像改动是否已 commit（任何档位改动前先 commit）；
   * - `syncedFiles`：按档位写回用户目录的文件数（chat 档 / 冲突时为 0）；
   * - `conflict`：写回冲突的文件清单（fail-closed，用户文件未被改动）。
   */
  mirror?: {
    committed: boolean;
    syncedFiles: number;
    conflict?: string[];
  };
  /**
   * 失败形态（M1 起为结构化 envelope failure；`kind` 与 `stderr_tail`
   * 保持历史字段名，旧消费方零迁移）。
   * - `kind`：`engine`（引擎侧失败）/ `killed`（主动取消）/ `timeout`；
   * - `code`：稳定机读码 `AGENT_ENGINE` / `AGENT_KILLED` / `AGENT_TIMEOUT`，
   *   或明确的 `AGENT_MODEL_BUDGET_EXCEEDED` / `AGENT_TOOL_BUDGET_EXCEEDED`；
   * - `message`：有界可展示文案；
   * - `retry`：重试语义分层 `none` / `same-session` / `new-session`；
   * - `stderr_tail`：engine 诊断尾部（可缺席，wire 最多约 512 字符——机读
   *   检索稳定码时按整段尾部处理，不要只看前 200 字符）。
   */
  failure: {
    kind: string;
    code?: string;
    message?: string;
    retry?: "none" | "same-session" | "new-session" | string;
    stderr_tail?: string;
  } | null;
}

/** Host-issued opaque correlation. It contains no account, owner or visibility claim. */
export interface AgentConversationOpenReceipt {
  readonly openToken: string;
}

export interface AgentSessionClient extends AgentServiceClient {
  backends(options?: { schemaVersion: 2 }): Promise<{ backends: AgentBackendStatus[]; defaultBackend?: AgentBackend | null; defaultBackendError?: string | null; defaultBackendSource?: "global" | "plugin" | "corrupt" }>;
  createSession(spec: AgentSessionSpec | AgentConfig): Promise<{
    sessionId: string;
    backend: ResolvedAgentBackend;
    runtime?: ResolvedAgentBackend;
    /** configured = 插件级配置的默认引擎（会话未显式指定时生效）。 */
    selectionSource?: "request" | "default" | "configured";
    schemaVersion?: 2;
    channel?: AgentBackendChannel;
    model?: { tier: string };
    /** 1.21：Host 解析后的工作区（direct 的 path 已规范化）。 */
    workspace?: AgentWorkspace;
    /** 1.21：真实工作根（direct = 用户目录；app-private = Host 分配的独立根）；插件不得猜测。 */
    workspaceRoot?: string;
    /** 1.21：`1` = 本会话按 Host 强制范围执行；缺席 = 平台不支持或未申请文件/命令工具。 */
    scopeVersion?: 1;
  }>;
  /**
   * 1.21：只读观察本插件某个会话的越界审批状态。批准 / 拒绝只能由 Host 主窗口完成，
   * SDK 没有也不会有批准方法。
   */
  approvals: {
    list(options: { sessionId: string }): Promise<{ approvals: AgentApprovalSummary[] }>;
  };
  send(options: {
    sessionId: string;
    turnId?: string;
    text: string;
    /** host = 通用任务胶囊；caller = 调用方自己负责本轮呈现。 */
    taskPresentation?: "host" | "caller";
    attachmentInput?: import("./agent-attachments").AgentAttachmentTurnInput;
  }): Promise<AgentSendResult>;
  cancel(options: { sessionId: string; turnId: string }): Promise<{ cancelled: boolean }>;
  history(options: { sessionId: string }): Promise<{ items: AgentHistoryItem[] }>;
  listSessions(options?: { schemaVersion: 2 }): Promise<{ sessions: AgentSessionSummary[] }>;
  deleteSession(options: { sessionId: string }): Promise<{ deleted: boolean }>;
  /**
   * 会话被用户打开时上报——「已看过」的唯一判据，让任务胶囊/Tab 层/通知
   * 账本一起落旗。插件的会话界面进入前台时调用一次。
   */
  prepareConversationOpen(options: { sessionId: string }): Promise<AgentConversationOpenReceipt>;
  /** Commit after the actual selected conversation has landed. Omission remains legacy-only. */
  reportConversationOpened(options: { sessionId: string; receipt?: AgentConversationOpenReceipt }): Promise<void>;
  cancelConversationOpen(options: { sessionId: string; receipt: AgentConversationOpenReceipt }): Promise<void>;
  /** 用户从聊天卡明确要求安装某个 Host 工具依赖；完成后原调用方可重试。 */
  requireToolDependency(options: { tool: "web_search" | "web_fetch"; schemaVersion?: 2 }): Promise<void>;
}

/**
 * 1.21：一次越界访问的审批摘要。`approval.requested` / `approval.resolved` 会话事件
 * 与 `approvals.list` 都用这份形状；`actionDigest` 绑定完整动作，许可单次消费。
 * 拒绝、关闭弹窗、取消、撤权都不授予范围外访问。等待确认期间回合计时暂停；
 * `expiresMs` 为 0 表示不自动过期（当前 Host 新请求恒为 0，由回合取消收尾）。
 */
export interface AgentApprovalSummary {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  actionDigest: string;
  description: string;
  paths: { path: string; write: boolean }[];
  status: "pending" | "allowed" | "denied" | "expired" | "cancelled";
  createdMs: number;
  expiresMs: number;
}
