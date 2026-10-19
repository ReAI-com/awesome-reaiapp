/**
 * v1.0.5 grant-gated 平台服务的确定性模拟：`audio.capture@1`、`tasks.present@1`、
 * `notifications.publish@1`。只有测试显式给出 `platformServices.approvals`（模拟平台审核批准）
 * 且 Manifest 同时声明能力与同名 permission、用户决定为 granted 时才成功；缺省一律拒绝。
 * 这只是合同测试夹具，不是原生采音、真实胶囊或系统通知的证据。
 */
import { PLATFORM_CONTRACTS, RequestMethod } from "@reai/app-sdk/v1";

export type MockPermissionDecision = "granted" | "pending" | "denied";
export type MockNotificationLevel = "off" | "in_app" | "system";

export interface MockPlatformServicesFixture {
  /** 模拟平台审核批准的能力（按包摘要审核的替身）。缺省为空 = 全部未批准。 */
  approvals: string[];
  /** 同名用户 permission 的决定；缺省：Manifest 声明了 permission 视为 granted。 */
  decisions?: Partial<Record<string, MockPermissionDecision>>;
  /** Host 派生的账号代次（只出现在回执里，请求不能自报）。 */
  accountGeneration?: string;
  /** 插件自己拥有的 Agent 会话 entityId；tasks.present 只接受这些实体。 */
  taskEntities?: string[];
  /** 插件通知总决定与场景深度（Host 设置抽屉的替身）。 */
  notificationDecision?: MockPermissionDecision;
  notificationLevels?: Record<string, MockNotificationLevel>;
  /** 系统通知可用且已授权；缺省 false → system 请求降级为 in_app 并给 reason。 */
  systemNotifications?: "granted" | "denied" | "not-determined" | "unavailable";
  now?: () => number;
}

interface Manifest {
  appId: string;
  contributes?: { notificationScenes?: { key: string; maxLevel: MockNotificationLevel; defaultLevel?: MockNotificationLevel }[] };
  requires?: { hostCapabilities?: string[] };
  permissions?: { id: string }[];
}

type Fail = (code: string) => never;
const LEVEL_RANK: Record<MockNotificationLevel, number> = { off: 0, in_app: 1, system: 2 };
const minLevel = (...levels: MockNotificationLevel[]) => levels.reduce((a, b) => (LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b));
const ascii = (value: unknown, max = 128): value is string => typeof value === "string" && /^[\x21-\x7e]+$/.test(value) && value.length <= max;
const exact = (p: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => k in p) && Object.keys(p).every(k => required.includes(k) || optional.includes(k));

const CAPS = {
  audio: "audio.capture@1",
  tasks: "tasks.present@1",
  notifications: "notifications.publish@1",
} as const;
const ERRORS = {
  [CAPS.audio]: ["AUDIO_NOT_GRANTED", "AUDIO_PERMISSION_REQUIRED", "AUDIO_PERMISSION_DENIED"],
  [CAPS.tasks]: ["TASK_NOT_GRANTED", "TASK_PERMISSION_REQUIRED", "TASK_PERMISSION_DENIED"],
  [CAPS.notifications]: ["HOST_CAPABILITY_NOT_AVAILABLE", "NOTIFICATION_PERMISSION_REQUIRED", "NOTIFICATION_PERMISSION_DENIED"],
} as const;

const AUDIO_METHODS: readonly string[] = PLATFORM_CONTRACTS.capabilities[CAPS.audio].methods;
const TASK_METHODS: readonly string[] = PLATFORM_CONTRACTS.capabilities[CAPS.tasks].methods;
const NOTIFICATION_METHODS: readonly string[] = PLATFORM_CONTRACTS.capabilities[CAPS.notifications].methods;

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

export class MockPlatformServices {
  /** 「继续」实际导航到的来源（appId + entityId），供测试断言回到来源插件自己的会话。 */
  readonly continued: { appId: string; entityId: string }[] = [];
  readonly tasks = new Map<string, { entityId: string; state: string; stage?: string; ceiling: MockNotificationLevel }>();
  private readonly results = new Map<string, { panelToken: string; entityId: string }>();
  private readonly consumers = new Set<string>();
  private readonly history: { notificationId: string; source: { appId: string; accountGeneration: string }; sceneKey: string; taskId?: string;
    title: string; body: string; requestedLevel: "in_app" | "system"; effectiveLevel: "in_app" | "system"; createdAtMs: number; readAtMs: number | null }[] = [];
  private readonly dedupe = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();

  constructor(private readonly fixture: MockPlatformServicesFixture, private readonly manifest: () => Manifest, private readonly fail: Fail) {}

  static handles(method: string): boolean {
    return AUDIO_METHODS.includes(method) || TASK_METHODS.includes(method) || NOTIFICATION_METHODS.includes(method);
  }

  private get owner() { return { appId: this.manifest().appId, accountGeneration: this.fixture.accountGeneration ?? "mock-account" }; }

  /** 批准 + 声明 + 同名 permission 决定；与 Host 双层门同序。 */
  admitted(capability: keyof typeof ERRORS): void {
    const [notGranted, required, denied] = ERRORS[capability];
    const m = this.manifest();
    if (!this.fixture.approvals.includes(capability) || !m.requires?.hostCapabilities?.includes(capability)) this.fail(notGranted);
    if (!m.permissions?.some(p => p.id === capability)) this.fail(required);
    const decision = this.fixture.decisions?.[capability] ?? "granted";
    if (decision === "pending") this.fail(required);
    if (decision === "denied") this.fail(denied);
  }

  available(capability: keyof typeof ERRORS): boolean {
    try { this.admitted(capability); return true; } catch { return false; }
  }

  /**
   * environment.get 片段。与真实 Host 一致：描述符只表达这个 Host 已实现并在矩阵开放该能力，
   * 不代表本插件已获批准或同意；批准与同意在每个方法里检查，返回各域的稳定错误码。
   */
  descriptors(binding: { runtimeSessionId?: string | undefined; surfaceMountId?: string | undefined }): Record<string, unknown> {
    const descriptor = (capability: string, methods: readonly string[]) => ({ ...binding, platformCapabilities: { version: 1, capabilities: {
      [capability]: { version: 1, available: true, methods: [...methods] } } } });
    return {
      audioCapture: descriptor(CAPS.audio, AUDIO_METHODS),
      taskPresentation: descriptor(CAPS.tasks, TASK_METHODS),
      notificationPublish: descriptor(CAPS.notifications, NOTIFICATION_METHODS),
    };
  }

  /** 任务登记时的通知上限（单调，之后授权只对新任务生效），与 Host 的 provenance 上限同义。 */
  private taskCeiling(): MockNotificationLevel {
    if (!this.available(CAPS.notifications) || this.fixture.notificationDecision !== "granted") return "off";
    const scene = this.manifest().contributes?.notificationScenes?.find(s => s.key === "task.lifecycle");
    if (!scene) return "off";
    return minLevel(this.fixture.notificationLevels?.[scene.key] ?? scene.defaultLevel ?? "in_app", scene.maxLevel);
  }

  request(method: string, params: unknown): unknown {
    const p = (params && typeof params === "object" && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    if (AUDIO_METHODS.includes(method)) return this.audio(method, p);
    if (TASK_METHODS.includes(method)) return this.task(method, p);
    return this.notification(method, p);
  }

  private audio(method: string, p: Record<string, unknown>): unknown {
    if (method !== RequestMethod.AudioConsumersRelease) this.admitted(CAPS.audio);
    const route = { policy: { kind: "board-first" }, source: "board-usb-hid", epoch: "mock-epoch", gap: false, permission: "granted" };
    if (method === RequestMethod.AudioConsumersAcquire) {
      if (!exact(p, ["requestId", "purpose"]) || !ascii(p.requestId) || typeof p.purpose !== "string" || !p.purpose.trim()) this.fail("AUDIO_RANGE_INVALID");
      const consumerId = nextId("mock-consumer");
      this.consumers.add(consumerId);
      return { consumerId, owner: this.owner, route };
    }
    if (!exact(p, ["requestId", "consumerId"]) || !ascii(p.consumerId)) this.fail("AUDIO_RANGE_INVALID");
    if (!this.consumers.has(p.consumerId as string)) this.fail("AUDIO_CONSUMER_STALE");
    if (method === RequestMethod.AudioConsumersRelease) { this.consumers.delete(p.consumerId as string); return undefined; }
    return { consumerId: p.consumerId, owner: this.owner, route };
  }

  private task(method: string, p: Record<string, unknown>): unknown {
    this.admitted(CAPS.tasks);
    const invalid = () => this.fail("TASK_INVALID_REQUEST");
    if (!ascii(p.requestId)) invalid();
    const source = (entityId: string) => ({ ...this.owner, entityId });
    const ownedEntity = (entityId: unknown) => {
      if (!ascii(entityId)) invalid();
      if (!this.fixture.taskEntities?.includes(entityId as string)) this.fail("TASK_SOURCE_STALE");
      return entityId as string;
    };
    const ownedTask = () => {
      if (!ascii(p.taskId)) invalid();
      const task = this.tasks.get(p.taskId as string);
      if (!task) this.fail("TASK_NOT_FOUND");
      return task!;
    };
    switch (method) {
      case RequestMethod.TasksPresent: {
        if (!exact(p, ["requestId", "entityId", "title"], ["detail"])) invalid();
        const entityId = ownedEntity(p.entityId);
        if ([...this.tasks.values()].filter(t => t.state === "running").length >= 16) this.fail("TASK_LIMIT_EXCEEDED");
        const taskId = nextId("mock-task");
        this.tasks.set(taskId, { entityId, state: "running", ceiling: this.taskCeiling() });
        return { taskId, source: source(entityId), accepted: true };
      }
      case RequestMethod.TasksProgress: {
        if (!exact(p, ["requestId", "taskId", "stage"], ["detail"]) || typeof p.stage !== "string") invalid();
        const task = ownedTask();
        task.stage = p.stage as string;
        task.ceiling = minLevel(task.ceiling, this.taskCeiling());
        return undefined;
      }
      case RequestMethod.TasksFinish: {
        if (!exact(p, ["requestId", "taskId", "outcome"], ["detail"]) || !["completed", "failed", "cancelled"].includes(String(p.outcome))) invalid();
        const task = ownedTask();
        task.state = String(p.outcome);
        task.ceiling = minLevel(task.ceiling, this.taskCeiling());
        return undefined;
      }
      case RequestMethod.TasksDismiss: {
        if (!exact(p, ["requestId", "taskId"])) invalid();
        ownedTask();
        this.tasks.delete(p.taskId as string);
        return undefined;
      }
      case RequestMethod.ResultsPresent: {
        if (!exact(p, ["requestId", "entityId", "title", "body", "deferred"], ["taskId"]) || typeof p.deferred !== "boolean") invalid();
        const entityId = ownedEntity(p.entityId);
        if (p.taskId !== undefined && this.tasks.get(String(p.taskId))?.entityId !== entityId) this.fail("TASK_OWNER_MISMATCH");
        const resultId = nextId("mock-result");
        const panelToken = nextId("mock-panel");
        this.results.set(resultId, { panelToken, entityId });
        return { resultId, panelToken, source: source(entityId), ...(p.taskId !== undefined ? { taskId: p.taskId } : {}), deferred: p.deferred };
      }
      case RequestMethod.ResultsContinue:
      case RequestMethod.ResultsDismiss: {
        if (!exact(p, ["requestId", "resultId", "panelToken"])) invalid();
        const result = this.results.get(String(p.resultId));
        if (!result || result.panelToken !== p.panelToken) this.fail("TASK_RESULT_STALE");
        this.results.delete(String(p.resultId));
        if (method === RequestMethod.ResultsDismiss) return { acknowledged: false };
        // 「继续」回到结果来源插件自己的会话，而不是任何固定插件。
        this.continued.push({ appId: this.owner.appId, entityId: result!.entityId });
        return { opened: true, acknowledged: true };
      }
      default:
        return this.fail("HOST_CAPABILITY_NOT_AVAILABLE");
    }
  }

  private notification(method: string, p: Record<string, unknown>): unknown {
    this.admitted(CAPS.notifications);
    const invalid = () => this.fail("NOTIFICATION_PAYLOAD_INVALID");
    if (!ascii(p.requestId)) invalid();
    const decision = this.fixture.notificationDecision ?? "pending";
    if (decision === "pending") this.fail("NOTIFICATION_PERMISSION_REQUIRED");
    if (decision === "denied") this.fail("NOTIFICATION_PERMISSION_DENIED");
    const owner = this.owner;
    const now = this.fixture.now?.() ?? Date.now();
    if (method === RequestMethod.NotificationsHistoryList) {
      if (!exact(p, ["requestId"], ["cursor", "pageSize"])) invalid();
      const size = p.pageSize === undefined ? 20 : Number(p.pageSize);
      if (!Number.isInteger(size) || size < 1 || size > 100) invalid();
      const start = p.cursor === undefined ? 0 : this.history.findIndex(n => n.notificationId === p.cursor) + 1;
      if (p.cursor !== undefined && start === 0) this.fail("NOTIFICATION_HISTORY_UNAVAILABLE");
      const items = this.history.slice(start, start + size).map(n => structuredClone(n));
      return { items, nextCursor: start + size < this.history.length ? items.at(-1)?.notificationId ?? null : null };
    }
    if (method === RequestMethod.NotificationsHistoryMarkRead) {
      if (!exact(p, ["requestId", "notificationIds"]) || !Array.isArray(p.notificationIds) || !p.notificationIds.length
        || p.notificationIds.length > 100 || !p.notificationIds.every(id => ascii(id))) invalid();
      const ids = p.notificationIds as string[];
      if (!ids.every(id => this.history.some(n => n.notificationId === id))) this.fail("NOTIFICATION_SOURCE_STALE");
      for (const n of this.history) if (ids.includes(n.notificationId) && n.readAtMs === null) n.readAtMs = now;
      return undefined;
    }
    if (!exact(p, ["requestId", "sceneKey", "requestedLevel", "title", "body"], ["dedupeKey", "taskId"])
      || !["in_app", "system"].includes(String(p.requestedLevel)) || typeof p.title !== "string" || typeof p.body !== "string"
      || ![...p.title].length || [...p.title].length > 80 || [...p.body].length > 500
      || (p.dedupeKey !== undefined && !ascii(p.dedupeKey))) invalid();
    const scene = this.manifest().contributes?.notificationScenes?.find(s => s.key === p.sceneKey);
    if (!scene) this.fail("NOTIFICATION_SCENE_UNDECLARED");
    const task = p.taskId === undefined ? undefined : this.tasks.get(String(p.taskId));
    if (p.taskId !== undefined && !task) this.fail("NOTIFICATION_SOURCE_STALE");
    const requested = p.requestedLevel as "in_app" | "system";
    const user = this.fixture.notificationLevels?.[scene!.key] ?? scene!.defaultLevel ?? "in_app";
    // Host: the stored provenance ceiling (shrunk only by task updates) and the source's
    // current ceiling both bound this publish; publishing itself does not shrink the task.
    const taskLevel = task ? minLevel(task.ceiling, this.taskCeiling()) : "system";
    let level = minLevel(requested, user, scene!.maxLevel, taskLevel);
    if (level === "off") return { notificationId: null, stored: false, requestedLevel: requested, effectiveLevel: "off", systemDelivery: "not-requested", reason: "scene-limited" };
    const fingerprint = JSON.stringify([requested, p.title, p.body, p.taskId ?? null]);
    const dedupeKey = p.dedupeKey === undefined ? undefined : JSON.stringify([scene!.key, p.dedupeKey]);
    if (dedupeKey && this.dedupe.has(dedupeKey)) {
      const previous = this.dedupe.get(dedupeKey)!;
      if (previous.fingerprint !== fingerprint) invalid();
      return { ...previous.receipt, reason: "deduplicated" };
    }
    let reason: string | undefined = LEVEL_RANK[level] < LEVEL_RANK[requested] ? "scene-limited" : undefined;
    let systemDelivery = "not-requested";
    if (level === "system") {
      const system = this.fixture.systemNotifications ?? "unavailable";
      if (system === "granted") systemDelivery = "queued";
      else {
        level = "in_app";
        reason = system === "denied" ? "system-permission-denied" : system === "not-determined" ? "system-permission-required" : "system-unavailable";
      }
    }
    const notificationId = nextId("mock-notification");
    this.history.unshift({ notificationId, source: owner, sceneKey: scene!.key, ...(p.taskId !== undefined ? { taskId: String(p.taskId) } : {}),
      title: p.title as string, body: p.body as string, requestedLevel: requested, effectiveLevel: level as "in_app" | "system", createdAtMs: now, readAtMs: null });
    const receipt = { notificationId, stored: true, requestedLevel: requested, effectiveLevel: level, systemDelivery, ...(reason ? { reason } : {}) };
    if (dedupeKey) this.dedupe.set(dedupeKey, { fingerprint, receipt });
    return receipt;
  }
}
