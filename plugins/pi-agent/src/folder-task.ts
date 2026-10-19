/**
 * 「文件夹任务」：让本插件对应的 Agent（Pi / DSH）在用户亲手授权的文件夹里读写文件。
 *
 * - 文件夹来自 `resources.files@1`（`pickRoot` / `listRoots`），插件只拿到不透明引用，
 *   拿不到真实路径；会话以 `{kind:"resource", root}` 工作区经 `agent.session@2` 创建，
 *   Host 每条文件命令重新准入，撤回授权立即失效。
 * - 三档与 Host 同一判定：chat 只读 / plan 只改计划类 md / yolo 可写；资源会话没有命令执行。
 * - 能力检测：Host 未开放、未获批、旧 Host（缺方法）一律视为不可用，入口不出现，旧界面不变；
 *   用户尚未同意可选权限时入口保留，引导去权限页。
 *
 * 本文件在 pi-agent 与 dsh-agent 各有一份逐字相同的副本（插件各自独立打包，不共享源码），
 * 改动须两边同步——仓库测试 `folder-task-parity` 会比对。
 */
import type {
  AgentBackendStatus,
  AgentConfig,
  AgentTurnMode,
  AgentTurnRef,
  ResourceRoot,
} from "@reai/app-sdk/v1";
import MarkdownIt from "markdown-it";
import { t } from "./i18n";

export type FolderBackend = "pi" | "dsh";
export type FolderAvailability = "checking" | "unavailable" | "notAuthorized" | "ready" | "stale";
export type FolderRuntime = "unknown" | "ready" | "downloadRequired" | "unavailable";

export interface FolderMessage { role: "user" | "assistant" | "notice" | "error"; text: string }

export interface FolderTaskState {
  availability: FolderAvailability;
  roots: ResourceRoot[];
  root: ResourceRoot | null;
  mode: AgentTurnMode;
  runtime: FolderRuntime;
  messages: FolderMessage[];
  running: boolean;
  /** 选择/刷新文件夹进行中（按钮置灰，避免重复弹系统面板）。 */
  picking: boolean;
  /** 查询回合进度失败（任务可能仍在跑）：保留回合引用，可「重新查询」或「停止」。 */
  stalled: boolean;
  /** 读不到上次保存的进度：在读成功前锁住会话操作，避免覆盖或丢掉旧记录；可「重试读取」。 */
  restoreFailed: boolean;
  /** 已停止一个未发出的请求，但持久记录与 Host 会话都没能清掉：锁住，等用户「重试停止」。 */
  cleanupFailed: boolean;
}

/** 依赖按 SDK 形状收窄，便于测试注入；方法缺失 = 旧 Host / 未开放。 */
export interface FolderTaskDeps {
  backend: FolderBackend;
  files?: {
    listRoots(input: { requestId: string }): Promise<{ items: ResourceRoot[] }>;
    pickRoot(input: { requestId: string }): Promise<{ root: ResourceRoot | null }>;
  };
  agent?: {
    backends(options: { schemaVersion: 2 }): Promise<{ backends: AgentBackendStatus[] }>;
    createSession(config: AgentConfig): Promise<{ sessionId: string }>;
    startTurn(options: { sessionId: string; idempotencyKey: string; text: string; taskPresentation?: "host" | "caller" }): Promise<{ sessionId: string; turnId: string }>;
    waitForTurn(options: AgentTurnRef): Promise<{
      status: "completed" | "failed" | "cancelled";
      content?: Array<{ type: "text"; text: string }>;
      text?: string | null;
      failure?: { code?: string; message?: string } | null;
    }>;
    cancel(options: AgentTurnRef): Promise<unknown>;
    deleteSession?(options: { sessionId: string }): Promise<unknown>;
  };
  systemTasks?: { open(input: { target: "app-managed-resources" | "app-permissions" }): Promise<unknown> };
  /**
   * Host 私有 KV（`storage.kv@1` 的 `ctx.storage.private("folder-task")`）：插件 WebView 是非持久的，
   * 只能靠它在界面关闭后保存本页对话，重开时恢复在跑回合与「停止」。
   */
  storage?: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
}

export const FOLDER_FILE_TOOLS = ["read", "write", "edit", "list", "glob", "grep"] as const;

/** 给模型的工作约定（模型输入，不随界面语言变化）。 */
export const FOLDER_SYSTEM_PROMPT = [
  "You are working inside one folder that the user explicitly authorized.",
  "Use only the file tools (read, write, edit, list, glob, grep); every path is relative to that folder's root.",
  "You cannot run shell commands. The current mode decides what you may change:",
  "chat = read only; plan = you may only write plan markdown files (for example plan.md); yolo = you may create and edit files.",
  "If a write is refused, explain what you would change instead of retrying.",
].join(" ");

/**
 * Host 未开放 / 未获批 / 旧 Host：入口隐藏，保持旧行为。各能力门禁的真实错误码：
 * resources.* 未获批 = RESOURCE_NOT_AUTHORIZED（仅探测阶段如此解释），agent.* = AGENT_SESSION_NOT_GRANTED，
 * 模型调用 = AI_NOT_GRANTED。
 */
const UNAVAILABLE = new Set([
  "HOST_CAPABILITY_NOT_AVAILABLE", "BRIDGE_UNKNOWN_METHOD", "PLUGIN_PERMISSION_NOT_DECLARED",
  "PLUGIN_PERMISSION_UNSUPPORTED", "DEVELOPMENT_CAPABILITY_DENIED", "AGENT_SESSION_NOT_GRANTED",
  "AI_NOT_GRANTED", "AGENT_SESSION_DISABLED",
]);
/** 已获批但用户尚未同意（或拒绝了）可选权限：入口保留，页内引导去权限页。 */
const PERMISSION = new Set([
  "PLUGIN_PERMISSION_REQUIRED", "PLUGIN_PERMISSION_DENIED",
  "AGENT_SESSION_PERMISSION_REQUIRED", "AGENT_SESSION_PERMISSION_DENIED",
  "AI_PERMISSION_REQUIRED", "AI_PERMISSION_DENIED",
]);
/** 文件夹授权已失效（撤回、换号、被拒）：丢掉这个根，让用户重选。 */
const ROOT_LOST = new Set(["RESOURCE_NOT_AUTHORIZED", "AGENT_WORKSPACE_NOT_AUTHORIZED"]);

export const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
};
const isUnavailable = (code: string): boolean =>
  UNAVAILABLE.has(code) || code.endsWith("_NOT_GRANTED") || code.startsWith("APP_CAPABILITY_");

/** 本页对话的持久形状（Host 私有 KV）；只存不透明引用与对话文字，不存路径。 */
interface StoredConversation {
  v: 2;
  grantRef: string;
  mode: AgentTurnMode;
  sessionId: string;
  /** 已发出、回执未确认的请求：重开时用同一幂等键向 Host 取回原回合（不会重复执行）。 */
  pending: PendingRequest | null;
  turn: AgentTurnRef | null;
  /** 用户已点停止：重开取回原回合后立即取消，不当作新请求。 */
  stopRequested: boolean;
  messages: FolderMessage[];
}
/** dispatched：已真正调用过 startTurn（Host 可能已受理）。未发出的请求在停止后绝不再发。 */
interface PendingRequest { idempotencyKey: string; text: string; dispatched: boolean }
const STORE_KEY = "conversation";
const MAX_STORED_MESSAGES = 60;
const MAX_STORED_TEXT = 8_000;
/** Host 私有 KV 单值上限 256 KiB；留足余量，超出时从最旧的消息开始裁。 */
const MAX_STORED_BYTES = 192 * 1024;
const utf8Bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
/** Host 对单条输入的上限（agent.v2 文本 64 KiB）；超出时让用户改短后再发，而不是发出必然失败的请求。 */
const MAX_INPUT_BYTES = 64 * 1024;
const MODES_SET = new Set<AgentTurnMode>(["chat", "plan", "yolo"]);
const ROLES = new Set<FolderMessage["role"]>(["user", "assistant", "notice", "error"]);

const isTurnRef = (value: unknown): value is AgentTurnRef => !!value && typeof value === "object"
  && typeof (value as AgentTurnRef).sessionId === "string" && typeof (value as AgentTurnRef).turnId === "string";

/** 读回的记录逐字段校验；任何不符都按“没有记录”处理。 */
function parseStored(value: unknown): StoredConversation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<StoredConversation>;
  if (record.v !== 2 || typeof record.grantRef !== "string" || typeof record.sessionId !== "string") return null;
  if (!record.mode || !MODES_SET.has(record.mode)) return null;
  const turn = record.turn === null || record.turn === undefined ? null : isTurnRef(record.turn) ? record.turn : undefined;
  if (turn === undefined) return null;
  const pending = record.pending && typeof record.pending === "object"
    && typeof record.pending.idempotencyKey === "string" && typeof record.pending.text === "string"
    // 读回的 pending 一律视为“可能已受理”：dispatched=true 的写入可能没落盘而 Host 已受理，
    // 持久化的 false 不能证明没发出。只有当前页内存里的请求才能证明从未提交。
    ? { idempotencyKey: record.pending.idempotencyKey, text: record.pending.text, dispatched: true } : null;
  const messages = Array.isArray(record.messages) ? record.messages.filter((item): item is FolderMessage =>
    !!item && typeof item === "object" && ROLES.has((item as FolderMessage).role) && typeof (item as FolderMessage).text === "string")
    .slice(-MAX_STORED_MESSAGES).map((item) => ({ role: item.role, text: item.text.slice(0, MAX_STORED_TEXT) })) : [];
  return { v: 2, grantRef: record.grantRef, mode: record.mode, sessionId: record.sessionId, pending, turn, stopRequested: record.stopRequested === true, messages };
}

/** 这些错误说明回合已不可能再继续 / 查询，不必保留引用。其余查询失败都当作“可能仍在跑”。 */
const TERMINAL_QUERY = new Set(["AGENT_RESULT_EXPIRED", "AGENT_SESSION_NOT_FOUND"]);

export class FolderTaskController {
  private state: FolderTaskState = {
    availability: "checking", roots: [], root: null, mode: "chat", runtime: "unknown",
    messages: [], running: false, picking: false, stalled: false, restoreFailed: false, cleanupFailed: false,
  };
  private listeners = new Set<(state: FolderTaskState) => void>();
  private sessionId: string | null = null;
  private turn: AgentTurnRef | null = null;
  private pendingRequest: PendingRequest | null = null;
  /** 换文件夹 / 换档 / 新对话 / 销毁都会推进代次，迟到结果不得写回新会话。 */
  private generation = 0;
  /** 只有最新一次探测可以提交结果（「重新检查」可能连点）。 */
  private probeGeneration = 0;
  /** 回合受理回执到达前用户就点了停止：回执一到立即取消。 */
  private stopRequested = false;
  private sequence = 0;
  private disposed = false;
  private restored = false;
  private pending: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  /** 正在从持久记录恢复：期间锁住会改变会话的操作，避免迟到恢复覆盖用户的新选择。 */
  private restoring = false;
  /** 停止的是一个已落盘、未发出的请求（重试停止时只做清理，绝不发出）。 */
  private unsentDrop = false;
  private cleanup: Promise<void> | null = null;

  constructor(private readonly deps: FolderTaskDeps) {}

  get snapshot(): FolderTaskState { return this.state; }

  /** 当前在跑的发送 / 恢复流程结束（测试与需要串行的调用方使用）。 */
  whenIdle(): Promise<void> { return this.pending; }

  subscribe(listener: (state: FolderTaskState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * 界面卸载。v2 回合是持久任务，Surface 关闭后 Host 不再接受本界面的取消/删除请求，
   * 所以这里不假装取消：对话与回合引用已存进 Host 私有 KV，重开本页会恢复进度与「停止」。
   */
  dispose(): void {
    if (this.disposed) return;
    this.generation++;
    this.probeGeneration++;
    this.disposed = true;
    this.listeners.clear();
  }

  private patch(next: Partial<FolderTaskState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener(this.state);
  }

  private requestId(): string { return `folder-task-${Date.now().toString(36)}-${++this.sequence}`; }

  /**
   * 串行写入当前对话；返回本次写入是否落盘。发送前的关键写入失败时调用方必须放弃发送，
   * 其余写入失败只影响重开后的恢复。消息按 UTF-8 总字节从最旧处裁剪，保证不超过 KV 单值上限。
   */
  private persist(): Promise<boolean> {
    const storage = this.deps.storage;
    if (!storage) return Promise.resolve(true);
    if (this.disposed) return this.writes.then(() => false);
    const root = this.state.root;
    let record: StoredConversation | null = null;
    if (root && this.sessionId) {
      record = {
        v: 2, grantRef: root.resource.grantRef, mode: this.state.mode, sessionId: this.sessionId,
        pending: this.pendingRequest, turn: this.turn, stopRequested: this.stopRequested,
        messages: this.state.messages.slice(-MAX_STORED_MESSAGES).map((item) => ({ role: item.role, text: item.text.slice(0, MAX_STORED_TEXT) })),
      };
      while (record.messages.length > 0 && utf8Bytes(record) > MAX_STORED_BYTES) record.messages.shift();
    }
    const write = this.writes.then(() => record ? storage.set(STORE_KEY, record) : storage.delete(STORE_KEY)).then(() => true, () => false);
    this.writes = write.then(() => undefined);
    return write;
  }

  /**
   * 丢弃当前会话：推进代次（迟到结果不再写回），取消在跑的回合，并删除 Host 侧会话，
   * 避免旧会话继续写旧目录或在每插件会话上限里堆积。均为尽力而为。
   */
  private resetConversation(): void {
    this.generation++;
    const sessionId = this.sessionId;
    const turn = this.turn;
    this.sessionId = null;
    this.turn = null;
    this.pendingRequest = null;
    this.stopRequested = false;
    void this.persist();
    this.unsentDrop = false;
    if (this.state.running || this.state.stalled || this.state.cleanupFailed) this.patch({ running: false, stalled: false, cleanupFailed: false });
    const agent = this.deps.agent;
    if (!agent || !sessionId) return;
    const cancelled = turn ? agent.cancel(turn).catch(() => undefined) : Promise.resolve();
    void cancelled.then(() => agent.deleteSession?.({ sessionId })).catch(() => undefined);
  }

  /** 探测两项能力；任何一项明确不可用都隐藏入口（fail closed）。 */
  async probe(): Promise<FolderAvailability> {
    const { files, agent } = this.deps;
    if (!files?.listRoots || !files.pickRoot || !agent?.backends || !agent.createSession || !agent.startTurn) {
      this.patch({ availability: "unavailable" });
      return "unavailable";
    }
    const probe = ++this.probeGeneration;
    // 两项独立探测再聚合：不能让第一项"未同意"遮住第二项"根本没开放"。
    const [rootsResult, backendsResult] = await Promise.allSettled([
      files.listRoots({ requestId: this.requestId() }),
      agent.backends({ schemaVersion: 2 }),
    ]);
    if (this.disposed || probe !== this.probeGeneration) return this.state.availability;
    const classify = (result: PromiseSettledResult<unknown>): FolderAvailability => {
      if (result.status === "fulfilled") return "ready";
      const code = errorCode(result.reason);
      if (PERMISSION.has(code)) return "notAuthorized";
      if (code === "RESOURCE_SCOPE_STALE") return "stale";
      // RESOURCE_NOT_AUTHORIZED 在列根阶段 = 平台未批准；其余未知错误同样按不可用处理：
      // 宁可不出入口，也不展示一个点了就报错的功能。
      return "unavailable";
    };
    const states = [classify(rootsResult), classify(backendsResult)];
    const availability: FolderAvailability = states.includes("unavailable") ? "unavailable"
      : states.includes("stale") ? "stale" : states.includes("notAuthorized") ? "notAuthorized" : "ready";
    if (availability !== "ready") {
      // 只清本地界面状态；持久记录留给权限恢复后的下一次打开。
      this.generation++;
      this.sessionId = null;
      this.turn = null;
      this.pendingRequest = null;
      this.restored = false; // 能力恢复后的下一次成功探测再从持久记录恢复
      this.patch({ availability, roots: [], root: null, running: false, stalled: false, restoreFailed: false, messages: [] });
      return availability;
    }
    const roots = (rootsResult as PromiseFulfilledResult<{ items: ResourceRoot[] }>).value.items ?? [];
    const statuses = (backendsResult as PromiseFulfilledResult<{ backends: AgentBackendStatus[] }>).value.backends ?? [];
    const runtime = this.runtimeOf(statuses);
    const kept = this.state.root && roots.find((item) => item.resource.grantRef === this.state.root?.resource.grantRef);
    if (!kept && this.state.root) this.resetConversation();
    this.patch({ availability: "ready", roots, root: kept ?? null, runtime });
    if (!this.restored) {
      this.restored = true;
      // 恢复可能要一直等到在跑回合结束，不阻塞探测本身；用 whenIdle() 观察。
      this.pending = this.restore(probe);
    }
    return "ready";
  }

  /** 重开页面：按持久记录恢复对话；在跑回合继续等结果，未确认的请求用原幂等键取回原回合。 */
  private async restore(probe: number): Promise<void> {
    if (!this.deps.storage) return;
    const generation = this.generation;
    this.restoring = true;
    this.patch({});
    let raw: unknown;
    try {
      raw = await this.deps.storage.get(STORE_KEY);
    } catch {
      // 读不到不等于没有：不写、不删记录，锁住会话操作，等用户「重试读取」或下次打开。
      this.restoring = false;
      this.restored = false;
      if (!this.disposed && probe === this.probeGeneration) this.patch({ restoreFailed: true });
      return;
    }
    this.restoring = false;
    if (this.state.restoreFailed) this.patch({ restoreFailed: false });
    const stored = parseStored(raw);
    // 读取期间页面已被重置、卸载或重新探测：迟到的记录不得覆盖新状态。
    if (!stored || this.disposed || probe !== this.probeGeneration || generation !== this.generation
      || this.sessionId || this.state.running || this.state.stalled) { this.patch({}); return; }
    const root = this.state.roots.find((item) => item.resource.grantRef === stored.grantRef);
    this.sessionId = stored.sessionId;
    this.turn = stored.turn;
    this.pendingRequest = stored.pending;
    this.stopRequested = stored.stopRequested;
    if (!root) { this.resetConversation(); return; } // 授权已不在：会话无法再用，按丢弃处理。
    this.patch({ root, mode: stored.mode, messages: stored.messages });
    if (stored.turn) {
      if (stored.stopRequested) void this.deps.agent?.cancel(stored.turn).catch(() => undefined);
      await this.follow(stored.turn, this.generation);
      return;
    }
    if (stored.pending) {
      // 回执前中断的请求绝不自动重放：授权代次变化（停用/撤权再恢复）后同一幂等键会被当成新任务。
      // 用户已点过停止 → 只清理；否则显示“状态未知”，由用户明确选择「重新查询」（可能重新执行）或「放弃」。
      if (stored.stopRequested) { this.patch({ running: true }); await this.dropUnsentRequest(this.generation); return; }
      this.patch({ stalled: true, messages: [...this.state.messages, { role: "notice", text: t("folder.pendingUnknown") }] });
    }
  }

  private runtimeOf(statuses: AgentBackendStatus[]): FolderRuntime {
    const status = statuses.find((item) => item.backend === this.deps.backend);
    if (!status) return "unavailable";
    if (status.downloadRequired) return "downloadRequired";
    return status.available ? "ready" : "unavailable";
  }

  private get busy(): boolean {
    return this.restoring || !!this.cleanup || this.state.restoreFailed || this.state.cleanupFailed || this.state.running || this.state.picking || this.state.stalled;
  }

  /** 「重试读取」上次进度。 */
  async retryRestore(): Promise<void> {
    if (!this.state.restoreFailed || this.restoring || this.state.availability !== "ready") return;
    this.restored = true;
    this.pending = this.restore(this.probeGeneration);
    await this.pending;
  }

  /** 视图用：恢复进行中也算忙。 */
  get locked(): boolean { return this.busy; }

  async pick(): Promise<void> {
    if (this.state.availability !== "ready" || this.busy) return;
    const generation = this.generation;
    this.patch({ picking: true });
    try {
      const picked = (await this.deps.files!.pickRoot({ requestId: this.requestId() })).root;
      // 用户取消，或选择期间页面已被重置 / 卸载：都不改动当前状态。
      if (!picked || this.disposed || generation !== this.generation) return;
      const roots = [picked, ...this.state.roots.filter((item) => item.resource.grantRef !== picked.resource.grantRef)];
      this.resetConversation();
      this.patch({ roots, root: picked, messages: [] });
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.handleError(error, "pick");
    } finally {
      this.patch({ picking: false });
    }
  }

  selectRoot(grantRef: string): void {
    if (this.busy) return;
    const root = this.state.roots.find((item) => item.resource.grantRef === grantRef) ?? null;
    if (root?.resource.grantRef === this.state.root?.resource.grantRef) return;
    this.resetConversation();
    this.patch({ root, messages: [] });
  }

  setMode(mode: AgentTurnMode): void {
    if (this.busy || mode === this.state.mode) return;
    // 档位写进会话配置：换档即开新会话，避免旧会话沿用旧档位。
    const keep = this.state.messages.length > 0;
    this.resetConversation();
    this.patch({ mode, messages: keep ? [...this.state.messages, { role: "notice", text: t("folder.modeChanged") }] : [] });
  }

  newConversation(): void {
    if (this.busy) return;
    this.resetConversation();
    this.patch({ messages: [] });
  }

  /** 返回 true 表示已受理（调用方据此清空输入框）；被拒绝时输入应保留。 */
  async send(input: string): Promise<boolean> {
    const text = input.trim();
    const root = this.state.root;
    if (!text || !root || this.busy || this.state.availability !== "ready") return false;
    if (this.state.runtime !== "ready") return false;
    if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES) {
      this.patch({ messages: [...this.state.messages, { role: "error", text: t("folder.inputTooLong") }] });
      return false;
    }
    const agent = this.deps.agent!;
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    this.stopRequested = false;
    this.patch({ running: true, messages: [...this.state.messages, { role: "user", text }] });
    this.pending = (async () => {
      try {
        if (!this.sessionId) {
          const created = await agent.createSession({
            schemaVersion: 2,
            runtime: this.deps.backend,
            systemPrompt: FOLDER_SYSTEM_PROMPT,
            tools: FOLDER_FILE_TOOLS.map((ref) => ({ ref })),
            skills: [],
            workspace: { kind: "resource", root: root.resource },
            memory: "session",
            mode: this.state.mode,
          });
          if (!current()) {
            // 创建期间对话已被丢弃：这个会话没人再用，顺手删掉。
            void Promise.resolve(agent.deleteSession?.({ sessionId: created.sessionId })).catch(() => undefined);
            return;
          }
          this.sessionId = created.sessionId;
        }
        if (this.stopRequested) { this.finishTurn(generation, { role: "notice", text: t("folder.cancelled") }); return; }
        // 先把“已发出的请求”落盘，再发：界面在回执前关闭也能用同一幂等键取回原回合。
        const request: PendingRequest = { idempotencyKey: `folder-${this.requestId()}-${Math.random().toString(36).slice(2, 10)}`, text, dispatched: false };
        this.pendingRequest = request;
        const saved = await this.persist();
        if (!current()) return;
        if (!saved) {
          // 关键记录没落盘就不发：否则界面关闭后既无法恢复也无法停止。
          this.finishTurn(generation, { role: "error", text: t("folder.saveFailed") });
          return;
        }
        if (this.stopRequested) { await this.dropUnsentRequest(generation); return; }
        await this.start(this.sessionId, request, generation);
      } catch (error) {
        if (current()) { this.handleError(error, "send"); this.finishTurn(generation); }
      }
    })();
    return true;
  }

  /** 发出（或按原幂等键重新取回）一个回合，并等它的终态。 */
  private async start(sessionId: string, request: PendingRequest, generation: number): Promise<void> {
    const agent = this.deps.agent!;
    const current = () => !this.disposed && generation === this.generation;
    try {
      // 先标记“已发出”再调用：此后的停止只能取回原回合再取消，不能当作未发出直接丢弃。
      if (!request.dispatched) { request.dispatched = true; void this.persist(); }
      const started = await agent.startTurn({ sessionId, idempotencyKey: request.idempotencyKey, text: request.text, taskPresentation: "caller" });
      if (!current()) return;
      const turn = { sessionId, turnId: started.turnId };
      this.turn = turn;
      void this.persist();
      // 受理前就点了停止：回执一到立刻取消真实回合，再照常等终态。
      if (this.stopRequested) void agent.cancel(turn).catch(() => undefined);
      await this.follow(turn, generation);
    } catch (error) {
      if (!current()) return;
      if (this.isDefinitive(errorCode(error))) {
        if (errorCode(error) === "AGENT_SESSION_NOT_FOUND") this.forgetSession();
        this.handleError(error, "send");
        this.finishTurn(generation);
        return;
      }
      // 受理结果不确定（Host 可能已启动任务、只是回执失败）：保留原幂等键，可按原 key 重新取回或停止。
      this.patch({ running: false, stalled: true });
      this.push({ role: "error", text: t("folder.queryFailed") });
    }
  }

  /**
   * 已落盘但还没发出的请求被停止：清掉持久记录里的 pending。清不掉时必须确认删除 Host 会话
   * （或会话已不存在），使旧 pending 在重开后也无法执行；两者都失败就保持锁定并允许「重试停止」，
   * 不显示“已停止”。对话文字仍留在本页。
   */
  private dropUnsentRequest(generation: number): Promise<void> {
    // 合并在途清理：重复点击「重试停止」不会并行出多份清理。
    this.cleanup ??= this.runDropUnsent(generation).finally(() => { this.cleanup = null; this.patch({}); });
    return this.cleanup;
  }

  private async runDropUnsent(generation: number): Promise<void> {
    const sessionId = this.sessionId;
    const request = this.pendingRequest;
    // 清理只对“发起它的那次会话”生效：期间若已换会话（新发送、换文件夹等），迟到结果一律作废。
    const same = () => !this.disposed && generation === this.generation && this.sessionId === sessionId;
    this.pendingRequest = null;
    // 已发出（或受理状态未知）的请求可能正在 Host 上跑：必须确认删除会话（Host 删除时取消其回合），
    // 不能只清本地记录。从未发出的请求只需清记录，清不掉才删会话兜底。
    const dispatched = request?.dispatched === true;
    const saved = dispatched ? false : await this.persist();
    if (!same()) return;
    if (!saved && sessionId) {
      let deleted = false;
      try {
        await this.deps.agent?.deleteSession?.({ sessionId });
        deleted = !!this.deps.agent?.deleteSession;
      } catch (error) {
        deleted = errorCode(error) === "AGENT_SESSION_NOT_FOUND";
      }
      if (!same()) return;
      if (!deleted) {
        this.pendingRequest = request;
        void this.persist();
        this.unsentDrop = true;
        this.patch({ running: false, stalled: false, cleanupFailed: true, messages: [...this.state.messages, { role: "error", text: t("folder.stopUnconfirmed") }] });
        return;
      }
      this.sessionId = null;
    }
    this.unsentDrop = false;
    this.stopRequested = false;
    if (this.state.cleanupFailed) this.patch({ cleanupFailed: false });
    this.finishTurn(generation, { role: "notice", text: t("folder.cancelled") });
  }

  /** 确定没有（或不再）在跑任务的错误：权限、能力、文件夹授权、界面失效、运行组件。 */
  private isDefinitive(code: string): boolean {
    return PERMISSION.has(code) || ROOT_LOST.has(code) || isUnavailable(code) || code === "RESOURCE_SCOPE_STALE"
      || code === "RESOURCE_UNAVAILABLE" || code.startsWith("AGENT_RUNTIME_") || code === "AGENT_DEFAULT_BINDING_REQUIRED"
      || code === "AGENT_SESSION_INVALID_REQUEST" || code === "AGENT_SESSION_SESSION_STALE"
      || code === "AGENT_SESSION_NOT_FOUND" || code === "AGENT_BACKEND_UNAVAILABLE"
      || code === "AGENT_ATTACHMENT_TOO_LARGE";
  }

  /** 等一个已受理回合的终态并写回（新发送、重开恢复与「重新查询」共用）。 */
  private async follow(turn: AgentTurnRef, generation: number): Promise<void> {
    const agent = this.deps.agent!;
    const current = () => !this.disposed && generation === this.generation;
    this.turn = turn;
    if (!this.state.running || this.state.stalled) this.patch({ running: true, stalled: false });
    try {
      const result = await agent.waitForTurn(turn);
      if (!current()) return;
      if (result.status === "completed") {
        const answer = (result.content ?? []).map((part) => part.text).join("").trim() || (result.text ?? "").trim();
        this.finishTurn(generation, { role: "assistant", text: answer || t("folder.emptyAnswer") });
      } else if (result.status === "cancelled") {
        this.finishTurn(generation, { role: "notice", text: t("folder.cancelled") });
      } else {
        const code = result.failure?.code ?? "";
        if (ROOT_LOST.has(code)) this.loseRoot();
        else this.finishTurn(generation, { role: "error", text: result.failure?.message?.trim() || t("folder.failed") });
      }
    } catch (error) {
      if (!current()) return;
      const code = errorCode(error);
      if (TERMINAL_QUERY.has(code)) {
        if (code === "AGENT_SESSION_NOT_FOUND") this.forgetSession();
        this.finishTurn(generation, { role: "notice", text: t("folder.resultExpired") });
        return;
      }
      if (this.isDefinitive(code)) { this.handleError(error, "send"); this.finishTurn(generation); return; }
      // 查询失败不等于任务结束（例如等待超时、暂时读不到记录）：保留引用，允许重新查询或停止。
      this.patch({ running: false, stalled: true });
      this.push({ role: "error", text: t("folder.queryFailed") });
    }
  }

  /** Host 已没有这个会话：下次发送新建，不再复用。 */
  private forgetSession(): void {
    this.sessionId = null;
    this.turn = null;
    this.pendingRequest = null;
  }

  private finishTurn(generation: number, message?: FolderMessage): void {
    if (this.disposed || generation !== this.generation) return;
    this.turn = null;
    this.pendingRequest = null;
    this.stopRequested = false;
    this.patch({ running: false, stalled: false, ...(message ? { messages: [...this.state.messages, message] } : {}) });
    void this.persist();
  }

  /**
   * 「重新查询」：有回合引用时只再等一次结果；只有未确认请求时由用户明确选择按原幂等键重新提交——
   * 同一授权代次内 Host 返回原回合，授权代次变化或 Host 从未收到时会作为新任务执行。
   */
  async requery(): Promise<void> {
    if (!this.state.stalled || this.state.cleanupFailed || !this.sessionId) return;
    const generation = this.generation;
    const turn = this.turn;
    const request = this.pendingRequest;
    if (turn) this.pending = this.follow(turn, generation);
    else if (request) { this.patch({ running: true, stalled: false }); this.pending = this.start(this.sessionId, request, generation); }
    else return;
    await this.pending;
  }

  async stop(): Promise<void> {
    if ((this.state.cleanupFailed && this.unsentDrop) || this.cleanup) {
      if (this.state.cleanupFailed) this.pending = this.dropUnsentRequest(this.generation);
      await this.pending;
      return;
    }
    if (!this.state.running && !this.state.stalled) return;
    this.stopRequested = true;
    // 停止意图跨关闭保留：重开取回原回合后直接取消。写不进去时如实提示，不假装已保存。
    void this.persist().then((saved) => {
      if (!saved && !this.disposed && this.stopRequested) this.patch({ messages: [...this.state.messages, { role: "error", text: t("folder.stopNotSaved") }] });
    });
    const turn = this.turn;
    if (!this.deps.agent?.cancel) return;
    if (!turn) {
      // 失联且只有未确认请求：「停止」= 放弃这次请求，不为了取消而重新提交（可能触发执行）。
      if (this.state.stalled && this.pendingRequest) { this.pending = this.dropUnsentRequest(this.generation); await this.pending; }
      return; // 发送流程中：回执到达后补发取消
    }
    try {
      await this.deps.agent.cancel(turn);
      // 已失联的回合：取消请求送达后再查一次终态。
      if (this.state.stalled) await this.requery();
    } catch (error) { this.push({ role: "error", text: t("folder.cancelFailed", { code: errorCode(error) || "?" }) }); }
  }

  async openRuntimeSetup(): Promise<void> {
    try { await this.deps.systemTasks?.open({ target: "app-managed-resources" }); }
    catch { this.push({ role: "error", text: t("folder.openSetupFailed") }); }
  }

  async openPermissions(): Promise<void> {
    try { await this.deps.systemTasks?.open({ target: "app-permissions" }); }
    catch { this.push({ role: "error", text: t("folder.openSetupFailed") }); }
  }

  private push(message: FolderMessage): void {
    this.patch({ messages: [...this.state.messages, message] });
    void this.persist();
  }

  private loseRoot(): void {
    const lost = this.state.root;
    const messages = this.state.messages;
    this.resetConversation();
    this.patch({
      root: null,
      roots: lost ? this.state.roots.filter((item) => item.resource.grantRef !== lost.resource.grantRef) : this.state.roots,
      messages: [...messages, { role: "notice", text: t("folder.rootLost", { name: lost?.name ?? "" }) }],
      running: false,
    });
  }

  private handleError(error: unknown, operation: "pick" | "send"): void {
    const code = errorCode(error);
    if (PERMISSION.has(code)) { this.resetConversation(); this.patch({ availability: "notAuthorized", root: null, roots: [], running: false }); return; }
    if (code === "RESOURCE_NOT_AUTHORIZED" && operation === "pick") { this.push({ role: "error", text: t("folder.pickRejected") }); return; }
    if (code === "RESOURCE_SCOPE_STALE") { this.generation++; this.patch({ availability: "stale", running: false, stalled: false }); return; }
    if (isUnavailable(code)) { this.resetConversation(); this.patch({ availability: "unavailable", running: false }); return; }
    if (ROOT_LOST.has(code)) { this.loseRoot(); return; }
    if (code === "RESOURCE_UNAVAILABLE") { this.push({ role: "error", text: t("folder.folderUnavailable") }); return; }
    if (code.startsWith("AGENT_RUNTIME_") || code === "AGENT_DEFAULT_BINDING_REQUIRED") {
      this.patch({ runtime: "downloadRequired" });
      this.push({ role: "error", text: t("folder.runtimeMissing") });
      return;
    }
    const message = (error as { userMessage?: unknown; message?: unknown } | null);
    const detail = typeof message?.userMessage === "string" ? message.userMessage
      : typeof message?.message === "string" ? message.message : "";
    this.push({ role: "error", text: detail ? t("folder.errorWithDetail", { detail }) : t("folder.failed") });
  }
}

/* ============================== 视图 ============================== */

const esc = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const MODES: AgentTurnMode[] = ["chat", "plan", "yolo"];

// 模型输出不可信：关闭原始 HTML；只放行 http(s)/mailto 链接且渲染为可选文字（Surface 不允许外部导航）；
// 不加载任何图片；表格对齐改走 class（插件 CSP 不允许内联样式）。
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false });
markdown.validateLink = (url) => /^(https?:\/\/|mailto:)/i.test(url);
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.link_open = () => '<span class="ft-md-link">';
markdown.renderer.rules.link_close = (tokens, index) => {
  // 取对应 link_open 的地址，作为可见文字附在后面。
  for (let i = index - 1; i >= 0; i--) {
    if (tokens[i].type === "link_open") {
      const href = String(tokens[i].attrGet("href") ?? "");
      return `</span>${href ? ` <span class="ft-md-source">(${markdown.utils.escapeHtml(href)})</span>` : ""}`;
    }
  }
  return "</span>";
};
for (const type of ["th_open", "td_open"] as const) {
  markdown.renderer.rules[type] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    const alignment = String(token.attrGet("style") ?? "").match(/^text-align:(left|center|right)$/)?.[1];
    token.attrs = token.attrs?.filter(([name]) => name !== "style") ?? null;
    if (alignment) token.attrSet("class", `ft-align-${alignment}`);
    return renderer.renderToken(tokens, index, options);
  };
}
// 与 Voice chat-ui 同一处理（plugins/official/voice/packages/chat-ui/src/markdown.ts）。
/**
 * 中日韩文字与全角标点。CommonMark 的「左右侧翼」规则假设词与词之间有空格：`**天气：**晴`
 * 里收尾的 `**` 前是标点、后是汉字，按原规则既不能开也不能关，整段 `**` 原样露出（负责人
 * rc.2.7 真机反馈）。模型的中文回答几乎都这样写（`**气温：**18℃`、`**《三体》**这本书`），
 * 所以侧翼判定里全角标点按普通字符看待，半角标点在另一侧紧挨 CJK 字符时放宽；两侧都不是
 * CJK 的英文写法判定不变。
 */
const CJK = /[\u{1100}-\u{11ff}\u{2e80}-\u{2fdf}\u{3000}-\u{303f}\u{3040}-\u{30ff}\u{3100}-\u{31ff}\u{3200}-\u{4dbf}\u{4e00}-\u{9fff}\u{a960}-\u{a97f}\u{ac00}-\u{d7ff}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ffef}\u{20000}-\u{3134f}]/u;
const { isMdAsciiPunct, isPunctCharCode, isWhiteSpace } = markdown.utils;
class CjkFriendlyInlineState extends markdown.inline.State {
  override scanDelims(start: number, canSplitWord: boolean) {
    const scanned = super.scanDelims(start, canSplitWord);
    const marker = this.src.charCodeAt(start);
    let pos = start;
    while (pos < this.posMax && this.src.charCodeAt(pos) === marker) pos += 1;
    const last = start > 0 ? Array.from(this.src.slice(Math.max(0, start - 2), start)).at(-1)! : " ";
    const next = pos < this.posMax ? String.fromCodePoint(this.src.codePointAt(pos)!) : " ";
    const lastCode = last.codePointAt(0)!;
    const nextCode = next.codePointAt(0)!;
    const lastPunct = isMdAsciiPunct(lastCode) || isPunctCharCode(lastCode);
    const nextPunct = isMdAsciiPunct(nextCode) || isPunctCharCode(nextCode);
    const lastSpace = isWhiteSpace(lastCode);
    const nextSpace = isWhiteSpace(nextCode);
    // 全角标点按普通字符看待；半角标点只在另一侧紧挨 CJK 字符时放宽。
    const lastCjk = CJK.test(last);
    const nextCjk = CJK.test(next);
    // 两侧都不挨 CJK 时原样沿用 markdown-it 的判定（含孤立代理码元等边界），英文写法零变化。
    if (!lastCjk && !nextCjk) return scanned;
    const left = !nextSpace && (!nextPunct || nextCjk || lastSpace || lastPunct || lastCjk);
    const right = !lastSpace && (!lastPunct || lastCjk || nextSpace || nextPunct || nextCjk);
    return {
      ...scanned,
      can_open: left && (canSplitWord || !right || lastPunct),
      can_close: right && (canSplitWord || !left || nextPunct),
    };
  }
}
markdown.inline.State = CjkFriendlyInlineState;
/** 只给 assistant 回复用；用户原文、提示与错误仍按纯文本转义。 */
export const renderMarkdown = (text: string): string => markdown.render(text).trim();

export interface FolderTaskView {
  refreshLocale(): void;
  destroy(): void;
}

/**
 * 只读渲染 + 事件转发。输入框是常驻节点，状态变化不会冲掉用户正在输入的文字、
 * 焦点或输入法组合；Esc 交给 Host 的单次 Esc 仲裁（输入框内 Esc 归输入框）。
 */
export function mountFolderTaskView(root: HTMLElement, controller: FolderTaskController, agentName: string): FolderTaskView {
  root.innerHTML = `<div class="plugin-main-frame ft-frame">
    <div class="main-body ft-body">
      <header class="ft-intro"><div class="ft-title"></div><div class="ft-sub"></div></header>
      <div class="ft-status" data-ft-status></div>
      <section class="ft-workspace" data-ft-workspace>
        <div class="ft-card ft-folder" data-ft-folder></div>
        <div class="ft-modes" role="radiogroup" data-ft-modes></div>
        <div class="ft-mode-hint" data-ft-mode-hint></div>
        <div class="ft-runtime" data-ft-runtime></div>
        <div class="ft-log" aria-live="polite" data-ft-log></div>
        <form class="ft-composer" data-ft-composer>
          <textarea class="ft-input" rows="3" data-ft-input></textarea>
          <div class="ft-actions">
            <button type="button" class="ft-btn ghost" data-ft-new></button>
            <button type="button" class="ft-btn" data-ft-requery hidden></button>
            <button type="button" class="ft-btn danger" data-ft-stop hidden></button>
            <button type="submit" class="ft-btn primary" data-ft-send></button>
          </div>
        </form>
      </section>
    </div>
  </div>`;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const status = q("[data-ft-status]");
  const workspace = q("[data-ft-workspace]");
  const folder = q("[data-ft-folder]");
  const modes = q("[data-ft-modes]");
  const modeHint = q("[data-ft-mode-hint]");
  const runtime = q("[data-ft-runtime]");
  const log = q("[data-ft-log]");
  const composer = q<HTMLFormElement>("[data-ft-composer]");
  const input = q<HTMLTextAreaElement>("[data-ft-input]");
  const send = q<HTMLButtonElement>("[data-ft-send]");
  const stop = q<HTMLButtonElement>("[data-ft-stop]");
  const requery = q<HTMLButtonElement>("[data-ft-requery]");
  const fresh = q<HTMLButtonElement>("[data-ft-new]");
  let destroyed = false;

  // 重渲染（含切语言）只换文字与状态：记住焦点所在控件、消息区阅读位置，渲染后还原。
  const FOCUS_KEYS = ["ftMode", "ftRoot", "ftPick", "ftPermissions", "ftRecheck", "ftSetup"] as const;
  let renderedMessages = -1;
  let renderedRunning = false;
  const render = (state: FolderTaskState): void => {
    if (destroyed) return;
    const active = root.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = active && root.contains(active) ? FOCUS_KEYS.find((key) => key in active.dataset) : undefined;
    const focusValue = focusKey ? active!.dataset[focusKey] ?? "" : "";
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const previousTop = log.scrollTop;
    const grew = state.messages.length !== renderedMessages || state.running !== renderedRunning;
    renderedMessages = state.messages.length;
    renderedRunning = state.running;
    const busy = controller.locked;
    q(".ft-title").textContent = t("folder.title");
    q(".ft-sub").textContent = t("folder.subtitle", { agent: agentName });
    const ready = state.availability === "ready";
    workspace.hidden = !ready;
    status.innerHTML = state.availability === "checking" ? `<div class="ft-panel">${esc(t("folder.checking"))}</div>`
      : state.availability === "notAuthorized" ? `<div class="ft-panel"><b>${esc(t("folder.notAuthorizedTitle"))}</b>
          <p>${esc(t("folder.notAuthorizedDetail", { agent: agentName }))}</p>
          <div class="ft-panel-actions"><button type="button" class="ft-btn primary" data-ft-permissions>${esc(t("folder.openPermissions"))}</button>
          <button type="button" class="ft-btn ghost" data-ft-recheck>${esc(t("folder.recheck"))}</button></div></div>`
      : state.availability === "unavailable" ? `<div class="ft-panel">${esc(t("folder.unavailable"))}</div>`
      : state.availability === "stale" ? `<div class="ft-panel">${esc(t("folder.stale"))}</div>` : "";
    status.hidden = ready;

    const options = state.roots.map((item) => `<option value="${esc(item.resource.grantRef)}"${item.resource.grantRef === state.root?.resource.grantRef ? " selected" : ""}>${esc(item.name)}</option>`).join("");
    folder.innerHTML = `<div class="ft-folder-copy"><div class="ft-label">${esc(t("folder.folderLabel"))}</div>
        <div class="ft-folder-name">${state.root ? esc(state.root.name) : `<span class="ft-muted">${esc(t("folder.noFolder"))}</span>`}</div></div>
      <div class="ft-folder-actions">
        ${state.roots.length > 1 ? `<select class="ft-select" data-ft-root aria-label="${esc(t("folder.switchFolder"))}"${busy ? " disabled" : ""}>
          ${state.root ? "" : `<option value="" selected>${esc(t("folder.noFolder"))}</option>`}${options}</select>` : ""}
        <button type="button" class="ft-btn" data-ft-pick${busy ? " disabled" : ""}>${esc(t(state.root ? "folder.changeFolder" : "folder.pickFolder"))}</button>
      </div>`;

    modes.setAttribute("aria-label", t("folder.modeLabel"));
    modes.innerHTML = MODES.map((mode) => `<button type="button" role="radio" class="ft-mode${mode === state.mode ? " active" : ""}"
      aria-checked="${mode === state.mode}" data-ft-mode="${mode}"${busy ? " disabled" : ""}>${esc(t(`folder.mode.${mode}`))}</button>`).join("");
    modeHint.textContent = t(`folder.modeHint.${state.mode}`);

    // 关键风险提示放在操作区附近，用户上滚阅读时也看得到。
    runtime.innerHTML = state.cleanupFailed
      ? `<div class="ft-warn">${esc(t("folder.stopUnconfirmed"))}</div>`
      : state.restoreFailed
      ? `<div class="ft-warn">${esc(t("folder.restoreFailed"))} <button type="button" class="ft-link" data-ft-restore>${esc(t("folder.retryRestore"))}</button></div>`
      : state.runtime === "downloadRequired"
      ? `<div class="ft-warn">${esc(t("folder.runtimeMissing"))} <button type="button" class="ft-link" data-ft-setup>${esc(t("folder.openSetup"))}</button></div>`
      : state.runtime === "unavailable" ? `<div class="ft-warn">${esc(t("folder.runtimeUnavailable", { agent: agentName }))}</div>` : "";

    log.innerHTML = state.messages.length === 0
      ? `<div class="ft-empty">${esc(state.root ? t("folder.emptyLog", { agent: agentName }) : t("folder.pickFirst"))}</div>`
      : state.messages.map((message) => `<div class="ft-msg ${message.role}"><div class="ft-msg-who">${esc(
        message.role === "user" ? t("folder.you") : message.role === "assistant" ? agentName : message.role === "error" ? t("folder.errorLabel") : t("folder.noticeLabel"),
      )}</div>${message.role === "assistant" ? `<div class="ft-msg-text ft-markdown">${renderMarkdown(message.text)}</div>`
        : `<div class="ft-msg-text">${esc(message.text)}</div>`}</div>`).join("")
        + (state.running ? `<div class="ft-msg notice"><div class="ft-msg-text">${esc(t("folder.running", { agent: agentName }))}</div></div>` : "");
    // 新消息到达且用户本就在底部时跟随到底；否则（含切语言）保持原阅读位置。
    log.scrollTop = grew && nearBottom ? log.scrollHeight : previousTop;

    input.placeholder = t(state.root ? "folder.placeholder" : "folder.pickFirst");
    input.setAttribute("aria-label", t("folder.inputLabel"));
    input.disabled = !state.root || state.runtime !== "ready";
    send.textContent = t("folder.send");
    send.disabled = busy || !state.root || state.runtime !== "ready";
    stop.textContent = t(state.cleanupFailed ? "folder.retryStop" : "folder.stop");
    stop.hidden = !state.running && !state.stalled && !state.cleanupFailed;
    requery.textContent = t("folder.requery");
    requery.hidden = !state.stalled;
    fresh.textContent = t("folder.newConversation");
    fresh.disabled = busy || state.messages.length === 0;
    if (focusKey) {
      const selector = `[data-${focusKey.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}${focusValue ? `="${focusValue}"` : ""}]`;
      const next = root.querySelector<HTMLElement>(selector);
      if (next && next !== root.ownerDocument.activeElement && !next.hasAttribute("disabled")) next.focus();
    }
  };

  const onClick = (event: Event): void => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("button");
    if (!target || target.hasAttribute("disabled")) return;
    if (target.hasAttribute("data-ft-pick")) void controller.pick();
    else if (target.dataset.ftMode) controller.setMode(target.dataset.ftMode as AgentTurnMode);
    else if (target.hasAttribute("data-ft-setup")) void controller.openRuntimeSetup();
    else if (target.hasAttribute("data-ft-permissions")) void controller.openPermissions();
    else if (target.hasAttribute("data-ft-recheck")) void controller.probe();
    else if (target.hasAttribute("data-ft-stop")) void controller.stop();
    else if (target.hasAttribute("data-ft-requery")) void controller.requery();
    else if (target.hasAttribute("data-ft-restore")) void controller.retryRestore();
    else if (target.hasAttribute("data-ft-new")) controller.newConversation();
  };
  const onChange = (event: Event): void => {
    const select = event.target as HTMLSelectElement | null;
    if (select?.hasAttribute("data-ft-root") && select.value) controller.selectRoot(select.value);
  };
  // 按钮与 ⌘↩ 同一路径：受理即清空刚发出的那段文字；若用户已在改写则保留，被拒绝时原样保留。
  const submit = (): void => {
    const text = input.value;
    void controller.send(text).then((accepted) => { if (accepted && input.value === text) input.value = ""; });
  };
  const onSubmit = (event: Event): void => { event.preventDefault(); submit(); };
  const onKey = (event: KeyboardEvent): void => {
    // ⌘/Ctrl + Enter 发送；普通 Enter 换行；输入法组合中不拦截。
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  composer.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onKey);
  const unsubscribe = controller.subscribe(render);
  render(controller.snapshot);
  return {
    refreshLocale() { render(controller.snapshot); },
    destroy() {
      destroyed = true;
      unsubscribe();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      composer.removeEventListener("submit", onSubmit);
      input.removeEventListener("keydown", onKey);
      root.replaceChildren();
    },
  };
}
