import { createSurfaceNavigation } from "./navigation";
import { browserEscapeEnvironment, createSurfaceEscapeResponder, SURFACE_ESCAPE_INGRESS } from "./surface-escape";
import type { SurfaceBinding } from "./platform-contracts";
import { isPlatformCapabilityAvailable, isPlatformMethodAvailable, type AudioConsumerReceipt } from "./platform-contracts";
import type { AgentTurnSnapshot, AgentTurnRef } from "./agent-service";
import type { AgentConversationOpenReceipt } from "./agent-session";
/**
 * SDK 运行时：把 App 的声明接到 Bridge 上。
 *
 * Host 的 bootstrap（M1 生成，App 不可覆盖）做三件事：import 规范化后的 entry、
 * 拿到 `default` 导出、调用 [`runApp`]。此后所有交互都经 Bridge。
 *
 * 这一层顺手把几条**容易写错且后果隐蔽**的约束固化下来：
 *
 * - 注册只能发生在 `activate` 期间。晚注册的 Command 在 Manifest 比对时不存在，
 *   Host 会判定「声明与实际不一致」并回滚整个 activate——但那时错误信息指向的是
 *   Host，开发者查不到自己身上。
 * - 每个 mount 的 `ready` / `fail` 恰好一次。多调一次是 App 里最常见的 bug（错误
 *   分支里 fail 完忘了 return），表现是界面闪一下又消失。
 */

import { AppError, toWireError, type WireError } from "./errors";
import { createLocaleEnvironment, parseLocaleSnapshot } from "./locale";
import { ServiceCancellationLedger, serviceRequestIdFactory, sameServiceOwner, type ServiceEnvelope } from "./service-cancellation";
import {
  BRIDGE_GLOBAL_KEY,
  NotifyMethod,
  RequestMethod,
  type CommandSettlement,
  type HostBridge,
  type HostMessage,
  type RegistrationReport,
  type ServiceSettlement,
  type TaskRequestMethod,
  type AudioClipsRequestMethod,
  type ResourceFilesRequestMethod,
} from "./protocol";
import type {
  AppContext,
  AccountStatusResult,
  AppDefinition,
  AppDependencyStatus,
  AppEvent,
  CommandHandler,
  KeyValueStore,
  NotificationPostResult,
  SurfaceHandle,
  SurfaceMountHandler,
  TabItemInfo,
  ActionMountInfo,
  AppHttpFetchOptions,
} from "./types";
import type { ServiceCaller, ServiceHandler } from "./services";

interface BrokerResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string;
}

const nativeFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;

/** 声明一个 App。返回值原样交给 Host 的 bootstrap。 */
export function defineApp(definition: AppDefinition): AppDefinition {
  return definition;
}

/** 运行中的 App 句柄（Host bootstrap 持有；测试里也用它驱动） */
export interface RunningApp {
  /** 断开与 Bridge 的连接并跑完所有清理。 */
  dispose(): Promise<void>;
}

interface MountState {
  surfaceId: string;
  settled: boolean;
  intentHandlers: Set<(intent: unknown) => void>;
  presentationHandlers: Set<() => void>;
  /**
   * 最近一条还没人接的 intent（M6.1）。意图是状态不是流水——只留最新一条，
   * 首个 `onIntent` 注册时补发并清。没有它的话，handler 注册前到达的 intent
   * 会被静默吃掉（mount 与注册之间没有同步点，磁盘慢一拍就丢）。
   */
  pendingIntent?: unknown;
  cleanup?: () => void;
}

/**
 * 把 App 接到 Bridge 上开始跑。
 *
 * @param bridge 省略时从全局取 Host bootstrap 注入的那个。
 */
export function runApp(definition: AppDefinition, bridge?: HostBridge): RunningApp {
  const wire = wrapBridgeErrors(bridge ?? readInjectedBridge());
  const waitForAgentTurn = async (ref: AgentTurnRef, accepted?: AgentTurnSnapshot): Promise<NonNullable<AgentTurnSnapshot["result"]>> => {
    const started = Date.now();
    let turn = accepted ?? await wire.request<AgentTurnSnapshot>(RequestMethod.AgentV2GetTurn, ref);
    let deadline = started + 610_000;
    while (turn.status === "queued" || turn.status === "running") {
      // 等用户拍板期间 Host 暂停任务上限，这里的截止同步顺延（始终晚于 Host 侧）。
      // 按累计等待时长顺延：等待刚结束的快照已不带 waiting，轮询又可能被挂起过一阵，
      // 只看 waiting 会在用户同意后的第一张快照上误判超时。
      deadline = Math.max(deadline, started + 610_000 + (turn.waitedMs ?? 0));
      if (turn.waiting) deadline = Math.max(deadline, Date.now() + 610_000);
      if (Date.now() >= deadline) throw new AppError({ code: "AGENT_WAIT_TIMEOUT", userMessage: "任务仍可通过 getTurn 查询", retryable: true });
      await new Promise(resolve => setTimeout(resolve, 250));
      turn = await wire.request<AgentTurnSnapshot>(RequestMethod.AgentV2GetTurn, ref);
    }
    if (!turn.result) throw new AppError({ code: "AGENT_RESULT_EXPIRED", userMessage: "任务结果已过期，任务不会重新执行", retryable: false });
    return turn.result;
  };

  const commands = new Map<string, CommandHandler>();
  const operationCommands = new Set<string>();
  const surfaces = new Map<string, SurfaceMountHandler>();
  const intents = new Set<string>();
  const services = new Map<string, ServiceHandler>();
  const eventHandlers = new Set<(event: AppEvent) => void>();
  const codexEventHandlers = new Set<(event: unknown) => void>();
  const cloudEventHandlers = new Set<(event: import("./cloud").CloudStreamEvent) => void>();
  const localEventHandlers = new Set<(event: import("./local-agent").LocalAgentEvent) => void>();
  const terminalEventHandlers = new Set<
    (event: import("./terminal-session").TerminalSessionEvent) => void
  >();
  const mounts = new Map<string, MountState>();
  const presentations = new Map<string, SurfaceBinding>();
  // surface.escape@1: inert unless the Host's real descriptor (environment.get) says it is
  // available. Fetched lazily on the first Esc activity of each presentation (activation,
  // remount and account switch all change the presentation), never on plain presentation.
  const escapeDescriptors = new Map<string, { token: string; result: Promise<boolean>; value?: boolean }>();
  const ensureEscapeDescriptor = (binding: SurfaceBinding): Promise<boolean> => {
    // A stale (retired) presentation never touches the current cache.
    const live = presentations.get(binding.surfaceMountId);
    if (disposed || !mounts.has(binding.surfaceMountId) || live?.presentationToken !== binding.presentationToken
      || live.runtimeSessionId !== binding.runtimeSessionId) return Promise.resolve(false);
    const cached = escapeDescriptors.get(binding.surfaceMountId);
    if (cached?.token === binding.presentationToken) return cached.result;
    const entry: { token: string; result: Promise<boolean>; value?: boolean } = { token: binding.presentationToken, result: Promise.resolve(false) };
    entry.result = wire.request<{ surfaceEscape?: { runtimeSessionId?: unknown; surfaceMountId?: unknown; platformCapabilities?: unknown } }>(RequestMethod.EnvironmentGet, {})
      .then((environment) => {
        const descriptor = environment?.surfaceEscape;
        entry.value = !disposed && presentations.get(binding.surfaceMountId)?.presentationToken === binding.presentationToken
          && descriptor?.runtimeSessionId === binding.runtimeSessionId && descriptor?.surfaceMountId === binding.surfaceMountId
          && isPlatformCapabilityAvailable(descriptor?.platformCapabilities, "surface.escape@1");
        return entry.value;
      }, () => {
        // Transient failure: forget it so the next Esc can ask again; this press fails closed.
        if (escapeDescriptors.get(binding.surfaceMountId) === entry) escapeDescriptors.delete(binding.surfaceMountId);
        return false;
      });
    escapeDescriptors.set(binding.surfaceMountId, entry);
    if (escapeDescriptors.size > 16) escapeDescriptors.delete(escapeDescriptors.keys().next().value!);
    return entry.result;
  };
  const escape = createSurfaceEscapeResponder({
    wire: {
      respond: (input) => wire.request(RequestMethod.SurfaceEscapeRespond, input),
      ingress: (binding, hostLayer) => wire.notify(SURFACE_ESCAPE_INGRESS as NotifyMethod,
        hostLayer === undefined ? binding : { ...binding, hostLayer }),
    },
    available: (binding) => {
      const entry = escapeDescriptors.get(binding.surfaceMountId);
      return entry?.token === binding.presentationToken && entry.value === true;
    },
    ensure: ensureEscapeDescriptor,
    env: browserEscapeEnvironment,
    binding: (surfaceMountId) => !disposed && mounts.has(surfaceMountId) ? presentations.get(surfaceMountId) : undefined,
    presented: () => {
      if (disposed) return undefined;
      const live = [...presentations.values()].filter(binding => mounts.has(binding.surfaceMountId));
      return live.length === 1 ? live[0] : undefined;
    },
  });
  const endedPresentationMounts = new Set<string>();
  const inflight = new Map<string, AbortController>();
  const activeOperations = new Map<string, string>();
  const serviceInflight = new Map<string, AbortController>();
  const serviceCancellations = new ServiceCancellationLedger(() => Date.now());
  const serviceEnvelopes = new Map<string, ServiceEnvelope>();
  const nextServiceRequestId = serviceRequestIdFactory(() => Date.now());

  const settleServiceError = (correlationId: string, code: string, userMessage: string) => {
    wire.notify(NotifyMethod.ServiceSettled, {
      correlationId, ok: false, error: { code, userMessage, retryable: code === "SERVICE_BUSY" },
    } satisfies ServiceSettlement);
  };

  let registrationOpen = false;
  let runtimeSessionId = "";
  // Host 创建 WebView 后会紧接着投递 activate 与 surface.mount。activate 允许先做
  // 异步初始化再注册 Surface，因此 mount 必须越过这道屏障后才能查注册表；否则
  // 只要插件在首次 await 之后注册，就会被误判成 MISSING_SURFACE_HANDLER 并白屏。
  type ActivationResult = { ok: true } | { ok: false; error?: WireError };
  let activationBarrier: Promise<ActivationResult> = Promise.resolve({ ok: false });
  let activationEpoch = 0;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancelLocaleRead: (() => void) | undefined;
  const locale = createLocaleEnvironment();
  const failedActivationMounts = new Set<string>();
  const queuedMounts = new Map<string, { pendingIntent?: unknown }>();
  const queuedCommands = new Map<string, object>();
  const queuedServices = new Map<string, object>();
  const layerHandlers = { tab: new Set<() => void>(), action: new Set<() => void>() };
  const environmentHandlers = new Set<(value: { developerMode: boolean }) => void>();
  let environmentRevision = 0;
  let environmentSnapshot = { developerMode: false };

  const audioReceipts = new Map<string, { epoch: number; session: string; mount: string; state: MountState }>();
  const audioRequest = async <T>(method: typeof RequestMethod.AudioConsumersAcquire | typeof RequestMethod.AudioConsumersRelease | typeof RequestMethod.AudioConsumersStatus, input: unknown, releaseId?: string): Promise<T> => {
    const epoch = activationEpoch;
    const session = runtimeSessionId;
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    if (!entry || !session || disposed) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频调用界面已退出" });
    const [mount, state] = entry;
    const current = () => !disposed && activationEpoch === epoch && runtimeSessionId === session && mounts.get(mount) === state;
    const previous = releaseId ? audioReceipts.get(releaseId) : undefined;
    if (previous && (previous.epoch !== epoch || previous.session !== session || previous.mount !== mount || previous.state !== state)) {
      throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频消费者属于旧界面" });
    }
    // Query this Host for every operation; the installed SDK version grants nothing.
    // A withheld capability may still release a receipt acquired by this exact mount.
    let environment: { audioCapture?: { runtimeSessionId?: string; surfaceMountId?: string; platformCapabilities?: unknown } } | undefined;
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (error) { if (!previous) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放音频采集", cause: error }); }
    if (!current()) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频调用界面已退出" });
    const descriptor = environment?.audioCapture;
    if (descriptor && (descriptor.runtimeSessionId !== session || descriptor.surfaceMountId !== mount)) {
      throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频Host实例已变化" });
    }
    if (!previous && !isPlatformCapabilityAvailable(descriptor?.platformCapabilities, "audio.capture@1")) {
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放音频采集" });
    }
    const result = await wire.request<T>(method, input);
    if (!current()) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "迟到音频回执已失效" });
    if (releaseId) audioReceipts.delete(releaseId);
    return result;
  };

  type ClipCallOwner = { epoch: number; session: string; mount: string; state: MountState };
  // Advisory identities only. The current Host rechecks the original binding on every call.
  const clipReceipts = new Map<string, ClipCallOwner>();
  const rememberClipReceipt = (kind: string, id: string, owner: ClipCallOwner) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw new AppError({ code: "AUDIO_RANGE_INVALID", userMessage: "无效音频回执" });
    const key = kind + ":" + id;
    clipReceipts.delete(key); clipReceipts.set(key, owner);
    if (clipReceipts.size > 256) clipReceipts.delete(clipReceipts.keys().next().value!);
  };
  const clipRequest = async <T>(method: AudioClipsRequestMethod, input: unknown, keys: readonly string[], receiptKind?: string, receiptId?: string): Promise<{ value: T; owner: ClipCallOwner }> => {
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    if (!entry || !runtimeSessionId || disposed) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频调用界面已退出" });
    const owner: ClipCallOwner = { epoch: activationEpoch, session: runtimeSessionId, mount: entry[0], state: entry[1] };
    const same = (old: ClipCallOwner) => old.epoch === owner.epoch && old.session === owner.session && old.mount === owner.mount && old.state === owner.state;
    const current = () => !disposed && activationEpoch === owner.epoch && runtimeSessionId === owner.session && mounts.get(owner.mount) === owner.state;
    const previous = receiptKind && receiptId ? clipReceipts.get(receiptKind + ":" + receiptId) : undefined;
    if (previous && !same(previous)) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频回执属于旧界面" });
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError({ code: "AUDIO_RANGE_INVALID", userMessage: "无效音频请求" });
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some(key => !keys.includes(key)) || keys.some(key => !(key in record))) throw new AppError({ code: "AUDIO_RANGE_INVALID", userMessage: "无效音频字段" });
    for (const key of keys) {
      const value = record[key];
      const valid = key.endsWith("Ms") || key === "offset" || key === "maxBytes"
        ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && (key !== "maxBytes" || value >= 1 && value <= 262144)
        : typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
      if (!valid) throw new AppError({ code: "AUDIO_RANGE_INVALID", userMessage: "无效音频参数" });
    }
    let environment: { audioClips?: { runtimeSessionId?: string; surfaceMountId?: string; platformCapabilities?: unknown } } | undefined;
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (error) {
      if (!current()) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频调用界面已退出" });
      if (error instanceof AppError && error.code !== "BRIDGE_UNKNOWN_METHOD") throw error;
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放音频片段", cause: error });
    }
    if (!current()) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "迟到音频描述符已失效" });
    const descriptor = environment?.audioClips;
    if (descriptor && (descriptor.runtimeSessionId !== owner.session || descriptor.surfaceMountId !== owner.mount)) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频Host实例已变化" });
    if (!isPlatformCapabilityAvailable(descriptor?.platformCapabilities, "audio.clips@1")) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放音频片段" });
    const value = await wire.request<T>(method, input);
    if (!current()) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "迟到音频回执已失效" });
    return { value, owner };
  };

  // resources.files@1: requery the Host descriptor per call; results that arrive after
  // the calling mount/runtime changed are discarded. The Host re-authorizes every call.
  const resourceRequest = async <T>(method: ResourceFilesRequestMethod, input: unknown): Promise<T> => {
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    const stale = (userMessage: string) => new AppError({ code: "RESOURCE_SCOPE_STALE", userMessage });
    if (!entry || !runtimeSessionId || disposed) throw stale("文件调用界面已退出");
    const owner = { epoch: activationEpoch, session: runtimeSessionId, mount: entry[0], state: entry[1] };
    const current = () => !disposed && activationEpoch === owner.epoch && runtimeSessionId === owner.session && mounts.get(owner.mount) === owner.state;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError({ code: "RESOURCE_UNAVAILABLE", userMessage: "无效文件请求" });
    let environment: { resourceFiles?: { runtimeSessionId?: string; surfaceMountId?: string; platformCapabilities?: unknown } } | undefined;
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (error) {
      if (!current()) throw stale("文件调用界面已退出");
      if (error instanceof AppError && error.code !== "BRIDGE_UNKNOWN_METHOD") throw error;
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放文件访问", cause: error });
    }
    if (!current()) throw stale("迟到文件描述符已失效");
    const descriptor = environment?.resourceFiles;
    if (descriptor && (descriptor.runtimeSessionId !== owner.session || descriptor.surfaceMountId !== owner.mount)) throw stale("文件Host实例已变化");
    if (!isPlatformMethodAvailable(descriptor?.platformCapabilities, "resources.files@1", method)) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放文件访问" });
    let value: T;
    try { value = await wire.request<T>(method, input); }
    catch (error) {
      // A late rejection belongs to the retired mount just like a late success.
      if (!current()) throw stale("迟到文件回执已失效");
      throw error;
    }
    if (!current()) throw stale("迟到文件回执已失效");
    return value;
  };

  type TaskCallOwner = { epoch: number; session: string; mount: string; state: MountState };
  // Bounded advisory receipt caches. Every operation still asks the current Host;
  // these records cannot authorize a task, result, source or return intent.
  const taskReceipts = new Map<string, TaskCallOwner>();
  const resultReceipts = new Map<string, TaskCallOwner & { panelToken: string }>();
  type OpenOwner = TaskCallOwner & { entity: string; presentation: SurfaceBinding; hostDelivered?: true };
  const openReceipts = new Map<string, OpenOwner>();
  const preparingOpens = new Map<string, object>();
  const openMethod = (sessionId: string) => sessionId.startsWith("agent2-") ? RequestMethod.AgentV2ConversationOpened : RequestMethod.AgentSessionConversationOpened;
  const staleOpen = () => new AppError({ code: "TASK_SOURCE_STALE", userMessage: "会话打开回执已失效" });
  const currentOpen = (owner: OpenOwner) => !disposed && activationEpoch === owner.epoch && runtimeSessionId === owner.session
    && mounts.get(owner.mount) === owner.state && presentations.get(owner.mount) === owner.presentation;
  const cancelOpenToken = (token: string, owner: OpenOwner) => {
    // Negative cleanup only. The Host still checks the original operation's
    // source and cannot undo an already committed read. No legacy fallback.
    if (currentOpen(owner)) void wire.request(openMethod(owner.entity), {
      sessionId: owner.entity, phase: "cancel", openToken: token,
    }).catch(() => undefined);
  };
  const retireOpenReceipts = (matches: (owner: OpenOwner) => boolean) => {
    for (const [token, owner] of openReceipts) if (matches(owner)) {
      openReceipts.delete(token);
      cancelOpenToken(token, owner);
    }
  };
  const captureOpenOwner = (entity: string): OpenOwner => {
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    const presentation = entry ? presentations.get(entry[0]) : undefined;
    if (!entry || !presentation || !runtimeSessionId || disposed || !/^[\x21-\x7e]{1,128}$/.test(entity)) throw staleOpen();
    return { epoch: activationEpoch, session: runtimeSessionId, mount: entry[0], state: entry[1], entity, presentation };
  };
  const requireOpenDescriptor = async (owner: OpenOwner) => {
    let environment: { ownedConversationOpen?: { version?: unknown; available?: unknown; runtimeSessionId?: unknown; surfaceMountId?: unknown; presentationToken?: unknown } };
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (cause) {
      if (!currentOpen(owner)) throw staleOpen();
      if (cause instanceof AppError && cause.code !== "BRIDGE_UNKNOWN_METHOD") throw cause;
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放会话确认", cause });
    }
    if (!currentOpen(owner)) throw staleOpen();
    const descriptor = environment?.ownedConversationOpen;
    if (!descriptor || descriptor.version !== 1 || descriptor.available !== true) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放会话确认" });
    if (descriptor.runtimeSessionId !== owner.session || descriptor.surfaceMountId !== owner.mount || descriptor.presentationToken !== owner.presentation.presentationToken) throw staleOpen();
  };
  const requireOpenReceipt = (entity: string, receipt: AgentConversationOpenReceipt): OpenOwner => {
    const owner = openReceipts.get(receipt?.openToken);
    if (!owner || owner.entity !== entity || !currentOpen(owner)) throw staleOpen();
    return owner;
  };
  const registerOpenIntent = (mount: string, state: MountState, intent: unknown) => {
    if (!intent || typeof intent !== "object" || (intent as any).source !== "host.taskConversation" || (intent as any).actionId !== "open-conversation") return;
    const payload = (intent as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") return;
    const { entityId, openToken } = payload as { entityId?: unknown; openToken?: unknown };
    const presentation = presentations.get(mount);
    if (!presentation || !runtimeSessionId || disposed || mounts.get(mount) !== state
      || typeof entityId !== "string" || typeof openToken !== "string"
      || ![entityId, openToken].every(value => /^[\x21-\x7e]{1,128}$/.test(value))) return;
    const repeated = openReceipts.get(openToken);
    if (repeated?.hostDelivered && repeated.entity === entityId && repeated.mount === mount && currentOpen(repeated)) return;
    preparingOpens.delete(mount);
    retireOpenReceipts(previous => !currentOpen(previous) || previous.mount === mount);
    if (openReceipts.size >= 16) return;
    openReceipts.set(openToken, { epoch: activationEpoch, session: runtimeSessionId, mount, state, entity: entityId, presentation, hostDelivered: true });
  };
  const requireTaskOwner = (owner: TaskCallOwner) => {
    if (disposed || activationEpoch !== owner.epoch || runtimeSessionId !== owner.session || mounts.get(owner.mount) !== owner.state) {
      throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "迟到任务回执已失效" });
    }
  };
  type OpenCall = [string, OpenOwner];
  const currentOpenCall = (open: OpenCall) => openReceipts.get(open[0]) === open[1] && currentOpen(open[1]);
  const taskValue = <T>(reply: { value: T; owner: TaskCallOwner; opened?: OpenCall }): T => {
    requireTaskOwner(reply.owner);
    if (reply.opened && !currentOpenCall(reply.opened)) throw staleOpen();
    return reply.value;
  };
  const rememberTaskReceipt = <T>(cache: Map<string, T>, id: string, value: T) => {
    cache.delete(id);
    cache.set(id, value);
    if (cache.size > 128) cache.delete(cache.keys().next().value!);
  };
  // One correlated opened callback may consume a truthful partial Host descriptor.
  // This never advertises the frozen full capability or admits sibling methods.
  const supportsOwnedConversationOpened = (snapshot: unknown): boolean => {
    const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    if (!record(snapshot) || snapshot.version !== 1 || !Object.hasOwn(snapshot, "capabilities") || !record(snapshot.capabilities)
      || !Object.hasOwn(snapshot.capabilities, "tasks.present@1")) return false;
    const descriptor = snapshot.capabilities["tasks.present@1"];
    return record(descriptor) && descriptor.version === 1 && descriptor.available === true
      && Array.isArray(descriptor.methods) && descriptor.methods.every(m => typeof m === "string")
      && descriptor.methods.includes(RequestMethod.TasksConversationOpened);
  };
  const taskRequest = async <T>(method: TaskRequestMethod, input: unknown, taskId?: string, resultId?: string, panelToken?: string): Promise<{ value: T; owner: TaskCallOwner; opened?: OpenCall }> => {
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    if (!entry || !runtimeSessionId || disposed) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "任务调用界面已退出" });
    const owner = { epoch: activationEpoch, session: runtimeSessionId, mount: entry[0], state: entry[1] };
    // Capture before the first await. An old renderer callback must never adopt
    // a newer Host intent for the same entity while probing its descriptor.
    const opened: OpenCall | undefined = method === RequestMethod.TasksConversationOpened && input && typeof input === "object"
      ? [...openReceipts].find(([, receipt]) => receipt.hostDelivered && receipt.entity === (input as { entityId?: unknown }).entityId && currentOpen(receipt))
      : undefined;
    const same = (previous: TaskCallOwner) => previous.epoch === owner.epoch && previous.session === owner.session && previous.mount === owner.mount && previous.state === owner.state;
    const current = () => !disposed && activationEpoch === owner.epoch && runtimeSessionId === owner.session && mounts.get(owner.mount) === owner.state
      && (!opened || currentOpenCall(opened));
    const task = taskId ? taskReceipts.get(taskId) : undefined;
    const result = resultId ? resultReceipts.get(resultId) : undefined;
    if (task && !same(task)) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "任务回执属于旧界面" });
    if (result && (!same(result) || result.panelToken !== panelToken)) throw new AppError({ code: "TASK_RESULT_STALE", userMessage: "结果回执已失效" });
    let environment: { taskPresentation?: { runtimeSessionId?: string; surfaceMountId?: string; platformCapabilities?: unknown } } | undefined;
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (error) {
      if (!current()) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "任务调用界面已退出" });
      if (error instanceof AppError && error.code !== "BRIDGE_UNKNOWN_METHOD") throw error;
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放任务呈现", cause: error });
    }
    if (!current()) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "任务调用界面已退出" });
    const descriptor = environment?.taskPresentation;
    if (descriptor && (descriptor.runtimeSessionId !== owner.session || descriptor.surfaceMountId !== owner.mount)) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "任务Host实例已变化" });
    const full = isPlatformCapabilityAvailable(descriptor?.platformCapabilities, "tasks.present@1");
    const partialOk = method === RequestMethod.TasksConversationOpened && opened !== undefined
      && supportsOwnedConversationOpened(descriptor?.platformCapabilities);
    if (!full && !partialOk) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放任务呈现" });
    let transport = input;
    if (opened) transport = { ...input as object, openToken: opened[0] };
    const value = await wire.request<T>(method, transport);
    if (!current()) throw new AppError({ code: "TASK_SOURCE_STALE", userMessage: "迟到任务回执已失效" });
    return { value, owner, ...(opened ? { opened } : {}) };
  };


  // `notifications.publish@1`: every call reads this Host's live descriptor; the installed SDK
  // version grants nothing. The Host derives appId/account and rechecks approval + consent.
  type NotificationMethod = typeof RequestMethod.NotificationsPublish | typeof RequestMethod.NotificationsHistoryList | typeof RequestMethod.NotificationsHistoryMarkRead;
  const notificationRequest = async <T>(method: NotificationMethod, input: unknown): Promise<T> => {
    const entry = mounts.size === 1 ? mounts.entries().next().value : undefined;
    if (!entry || !runtimeSessionId || disposed) throw new AppError({ code: "NOTIFICATION_SOURCE_STALE", userMessage: "通知调用界面已退出" });
    const owner = { epoch: activationEpoch, session: runtimeSessionId, mount: entry[0], state: entry[1] };
    const current = () => !disposed && activationEpoch === owner.epoch && runtimeSessionId === owner.session && mounts.get(owner.mount) === owner.state;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError({ code: "NOTIFICATION_PAYLOAD_INVALID", userMessage: "通知请求不合法" });
    let environment: { notificationPublish?: { runtimeSessionId?: string; surfaceMountId?: string; platformCapabilities?: unknown } } | undefined;
    try { environment = await wire.request(RequestMethod.EnvironmentGet, {}); }
    catch (error) {
      if (!current()) throw new AppError({ code: "NOTIFICATION_SOURCE_STALE", userMessage: "通知调用界面已退出" });
      if (error instanceof AppError && error.code !== "BRIDGE_UNKNOWN_METHOD") throw error;
      throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放通知发布", cause: error });
    }
    if (!current()) throw new AppError({ code: "NOTIFICATION_SOURCE_STALE", userMessage: "迟到通知描述符已失效" });
    const descriptor = environment?.notificationPublish;
    if (descriptor && (descriptor.runtimeSessionId !== owner.session || descriptor.surfaceMountId !== owner.mount)) throw new AppError({ code: "NOTIFICATION_SOURCE_STALE", userMessage: "通知Host实例已变化" });
    if (!isPlatformCapabilityAvailable(descriptor?.platformCapabilities, "notifications.publish@1")) throw new AppError({ code: "HOST_CAPABILITY_NOT_AVAILABLE", userMessage: "Host尚未开放通知发布" });
    const value = await wire.request<T>(method, input);
    if (!current()) throw new AppError({ code: "NOTIFICATION_SOURCE_STALE", userMessage: "迟到通知回执已失效" });
    return value;
  };

  const makeStore = (storeId: string): KeyValueStore => ({
    async get<T>(key: string) {
      const result = await wire.request<{ found: boolean; value?: T }>(RequestMethod.StorageGet, {
        storeId,
        key,
      });
      return result.found ? (result.value as T) : undefined;
    },
    async set(key, value) {
      await wire.request<void>(RequestMethod.StorageSet, { storeId, key, value });
    },
    async compareAndSet(key, expected, value) {
      const result = await wire.request<{ exchanged: boolean }>(RequestMethod.StorageCompareAndSet, {
        storeId, key, expected: expected === undefined ? { found: false } : { found: true, value: expected }, value,
      });
      return result.exchanged;
    },
    async delete(key) {
      await wire.request<void>(RequestMethod.StorageDelete, { storeId, key });
    },
    async keys() {
      return await wire.request<string[]>(RequestMethod.StorageKeys, { storeId });
    },
  });

  const requireRegistrationWindow = (what: string, id: string) => {
    if (!registrationOpen) {
      throw new AppError({
        code: "app-sdk/REGISTRATION_CLOSED",
        userMessage: "扩展初始化异常",
        retryable: false,
        cause: `${what} ${id} 在 activate 之外注册；Host 只在 activate 期间收集注册项`,
      });
    }
  };

  const context: AppContext = {
    tasks: {
      async present(input) {
        const { value, owner } = await taskRequest<import("./platform-contracts").TaskReceipt>(RequestMethod.TasksPresent, input);
        requireTaskOwner(owner);
        rememberTaskReceipt(taskReceipts, value.taskId, owner);
        return value;
      },
      async progress(input) { taskValue(await taskRequest<void>(RequestMethod.TasksProgress, input, input.taskId)); },
      async finish(input) { taskValue(await taskRequest<void>(RequestMethod.TasksFinish, input, input.taskId)); },
      async dismiss(input) { taskValue(await taskRequest<void>(RequestMethod.TasksDismiss, input, input.taskId)); },
      async conversationOpened(input) { return taskValue(await taskRequest<{ acknowledged: true }>(RequestMethod.TasksConversationOpened, input)); },
      async presentResult(input) {
        const { value, owner } = await taskRequest<import("./platform-contracts").ResultReceipt>(RequestMethod.ResultsPresent, input, input.taskId);
        requireTaskOwner(owner);
        rememberTaskReceipt(resultReceipts, value.resultId, { ...owner, panelToken: value.panelToken });
        return value;
      },
      async continueResult(input) { return taskValue(await taskRequest<{ opened: true; acknowledged: true }>(RequestMethod.ResultsContinue, input, undefined, input.resultId, input.panelToken)); },
      async dismissResult(input) { return taskValue(await taskRequest<{ acknowledged: boolean }>(RequestMethod.ResultsDismiss, input, undefined, input.resultId, input.panelToken)); },
    },
    audioClips: {
      async start(input) {
        const { value, owner } = await clipRequest<import("./platform-contracts").AudioRangeReceipt>(RequestMethod.AudioRangesStart, input, ["requestId", "consumerId", "startMs"]);
        rememberClipReceipt("range", value.rangeId, owner); return value;
      },
      async finish(input) {
        const { value, owner } = await clipRequest<import("./platform-contracts").AudioClipRef>(RequestMethod.AudioRangesFinish, input, ["requestId", "rangeId", "endMs"], "range", input?.rangeId);
        rememberClipReceipt("clip", value.clipId, owner); return value;
      },
      async cancel(input) { await clipRequest<void>(RequestMethod.AudioRangesCancel, input, ["requestId", "rangeId"], "range", input?.rangeId); },
      async read(input) { return (await clipRequest<import("./platform-contracts").BoundedBytes>(RequestMethod.AudioClipsRead, input, ["requestId", "clipId", "offset", "maxBytes"], "clip", input?.clipId)).value; },
      async release(input) { await clipRequest<void>(RequestMethod.AudioClipsRelease, input, ["requestId", "clipId"], "clip", input?.clipId); },
      async transcribe(input) {
        const { value, owner } = await clipRequest<import("./platform-contracts").AudioTranscriptionReceipt>(RequestMethod.AudioClipsTranscribe, input, ["requestId", "clipId", "idempotencyKey"], "clip", input?.clipId);
        rememberClipReceipt("job", value.jobId, owner); return value;
      },
      async transcriptionStatus(input) { return (await clipRequest<import("./platform-contracts").AudioTranscriptionReceipt>(RequestMethod.AudioClipsTranscriptionStatus, input, ["requestId", "jobId"], "job", input?.jobId)).value; },
    },
    resourceFiles: {
      listRoots: (input) => resourceRequest(RequestMethod.ResourcesRootsList, input),
      pickRoot: (input) => resourceRequest(RequestMethod.ResourcesRootsPick, input),
      attachCloudProject: (input) => resourceRequest(RequestMethod.ResourcesRootsAttach, input),
      revokeRoot: (input) => resourceRequest(RequestMethod.ResourcesRootsRevoke, input),
      list: (input) => resourceRequest(RequestMethod.ResourcesList, input),
      stat: (input) => resourceRequest(RequestMethod.ResourcesStat, input),
      read: (input) => resourceRequest(RequestMethod.ResourcesRead, input),
      startWrite: (input) => resourceRequest(RequestMethod.ResourcesWriteStart, input),
      writeChunk: (input) => resourceRequest(RequestMethod.ResourcesWriteChunk, input),
      commitWrite: (input) => resourceRequest(RequestMethod.ResourcesWriteCommit, input),
      cancel: (input) => resourceRequest(RequestMethod.ResourcesCancel, input),
      createFile: (input) => resourceRequest(RequestMethod.ResourcesCreateFile, input),
      mkdir: (input) => resourceRequest(RequestMethod.ResourcesMkdir, input),
      rename: (input) => resourceRequest(RequestMethod.ResourcesRename, input),
      move: (input) => resourceRequest(RequestMethod.ResourcesMove, input),
      delete: (input) => resourceRequest(RequestMethod.ResourcesDelete, input),
    },
    audioCapture: {
      async acquire(input) {
        const epoch = activationEpoch;
        const session = runtimeSessionId;
        const original = mounts.size === 1 ? mounts.entries().next().value : undefined;
        const receipt = await audioRequest<AudioConsumerReceipt>(RequestMethod.AudioConsumersAcquire, input);
        if (disposed || epoch !== activationEpoch || session !== runtimeSessionId || !original || mounts.get(original[0]) !== original[1]) throw new AppError({ code: "AUDIO_CONSUMER_STALE", userMessage: "音频调用实例已变化" });
        audioReceipts.set(receipt.consumerId, { epoch, session, mount: original[0], state: original[1] });
        return receipt;
      },
      async release(input) { await audioRequest<void>(RequestMethod.AudioConsumersRelease, input, input.consumerId); },
      async status(input) { return await audioRequest<AudioConsumerReceipt>(RequestMethod.AudioConsumersStatus, input); },
    },
    locale: locale.client,
    get runtimeSessionId() {
      return runtimeSessionId;
    },
    environment: {
      async get() {
        const revision = environmentRevision;
        const value = await wire.request<{ developerMode: boolean }>(RequestMethod.EnvironmentGet, {});
        if (revision === environmentRevision) {
          environmentSnapshot = { developerMode: value?.developerMode === true };
        }
        return { ...environmentSnapshot };
      },
      onChange(handler) {
        environmentHandlers.add(handler);
        return () => { environmentHandlers.delete(handler); };
      },
    },
    http: {
      fetch(input, init) {
        return brokerFetch(wire, input, init);
      },
    },
    terminal: {
      async create(options) {
        return await wire.request(RequestMethod.TerminalSessionCreate, options);
      },
      async list() {
        return await wire.request(RequestMethod.TerminalSessionList, {});
      },
      async attach(sessionId) {
        return await wire.request(RequestMethod.TerminalSessionAttach, { sessionId });
      },
      async detach(sessionId, attachmentToken) {
        await wire.request<void>(RequestMethod.TerminalSessionDetach, {
          sessionId,
          attachmentToken,
        });
      },
      async write(sessionId, data) {
        let binary = "";
        for (const byte of data) binary += String.fromCharCode(byte);
        await wire.request<void>(RequestMethod.TerminalSessionWrite, {
          sessionId,
          dataBase64: btoa(binary),
        });
      },
      async resize(sessionId, rows, cols) {
        await wire.request<void>(RequestMethod.TerminalSessionResize, { sessionId, rows, cols });
      },
      async restart(sessionId, rows, cols) {
        return await wire.request(RequestMethod.TerminalSessionRestart, { sessionId, rows, cols });
      },
      async close(sessionId) {
        await wire.request<void>(RequestMethod.TerminalSessionClose, { sessionId });
      },
      onEvent(handler) {
        requireRegistrationWindow("terminal event", "terminal.session@1");
        terminalEventHandlers.add(handler);
      },
    },
    developerPlatform: {
      workflow: {
        async request(action, input) {
          return await wire.request(RequestMethod.DeveloperPlatformWorkflow, { action, input });
        },
      },
      async getContext() {
        return await wire.request(RequestMethod.DeveloperPlatformContextGet, {});
      },
      async listProjects(input) {
        return await wire.request(RequestMethod.DeveloperPlatformProjectsList, {
          teamId: input.teamId,
        });
      },
      async listScopes(input) {
        return await wire.request(RequestMethod.DeveloperPlatformScopesList, {
          teamId: input.teamId,
          projectId: input.projectId,
          context: input.context,
        });
      },
      async listProducts(input) {
        return await wire.request(RequestMethod.DeveloperPlatformProductsList, {
          teamId: input.teamId,
        });
      },
      async createProduct(input) {
        return await wire.request(RequestMethod.DeveloperPlatformProductsCreate, {
          teamId: input.teamId,
          projectId: input.projectId,
          name: input.name,
          purpose: input.purpose,
          scopeCodes: [...input.scopeCodes],
          idempotencyKey: input.idempotencyKey,
        });
      },
      async getClient(input) {
        return await wire.request(RequestMethod.DeveloperPlatformClientsGet, {
          teamId: input.teamId,
          managementClientId: input.managementClientId,
        });
      },
      async listTesters(input) {
        return await wire.request(RequestMethod.DeveloperPlatformTestersList, {
          teamId: input.teamId,
          productId: input.productId,
        });
      },
      async addTester(input) {
        return await wire.request(RequestMethod.DeveloperPlatformTestersAdd, {
          teamId: input.teamId,
          productId: input.productId,
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        });
      },
      async removeTester(input) {
        return await wire.request(RequestMethod.DeveloperPlatformTestersRemove, {
          teamId: input.teamId,
          productId: input.productId,
          testerUserId: input.testerUserId,
        });
      },
    },
    voiceInput: {
      async beginPreparing(requestId, overlayKind) {
        await wire.request<void>(RequestMethod.VoicePreparing, {
          action: "begin", requestId,
          ...(overlayKind === undefined ? {} : { overlayKind }),
        });
      },
      async endPreparing(requestId) {
        await wire.request<void>(RequestMethod.VoicePreparing, { action: "end", requestId });
      },
      async start(options) {
        return await wire.request(RequestMethod.VoiceToggle, { ...options, action: "start", mode: options.mode ?? "input" });
      },
      async finish(sessionId) {
        return await wire.request(RequestMethod.VoiceToggle, { action: "finish", sessionId });
      },
      async cancelPendingStart(requestId) {
        await wire.request<void>(RequestMethod.VoiceCancel, { requestId });
      },
      async getStatus(sessionId) {
        return await wire.request(
          RequestMethod.VoiceStatus,
          sessionId === undefined ? {} : { sessionId },
        );
      },
      async configure(settings) {
        await wire.request<void>(RequestMethod.VoiceConfigure, settings);
      },
      async toggle(options) {
        return await wire.request(
          RequestMethod.VoiceToggle,
          {
            mode: options?.mode ?? "input",
            ...(options?.overlayKind === undefined ? {} : { overlayKind: options.overlayKind }),
            ...(options?.insertText === undefined ? {} : { insertText: options.insertText }),
            ...(options?.retainAudio === undefined ? {} : { retainAudio: options.retainAudio }),
            ...(options?.holdOverlayUntilAck === undefined
              ? {}
              : { holdOverlayUntilAck: options.holdOverlayUntilAck }),
          },
        );
      },
      async acknowledgeResult(sessionId) {
        return await wire.request(RequestMethod.VoiceAcknowledgeResult, { sessionId });
      },
      async reportStage(sessionId, stage, label) {
        return await wire.request(RequestMethod.VoiceReportStage, { sessionId, stage, ...(label === undefined ? {} : { label }) });
      },
      async cancel(sessionId) {
        await wire.request<void>(
          RequestMethod.VoiceCancel,
          sessionId === undefined ? {} : { sessionId },
        );
      },
      async listModels() {
        const result = await wire.request<{ models: import("./voice-input").VoiceModelInfo[] }>(
          RequestMethod.VoiceModelsList,
          {},
        );
        return result.models;
      },
      async downloadModel(modelId) {
        return await wire.request(RequestMethod.VoiceModelDownload, { modelId });
      },
      async cancelModelDownload(modelId) {
        await wire.request<void>(RequestMethod.VoiceModelCancelDownload, { modelId });
      },
      async deleteModel(modelId) {
        await wire.request<void>(RequestMethod.VoiceModelDelete, { modelId });
      },
      async checkPermissions() {
        return await wire.request(RequestMethod.VoicePermissionsCheck, {});
      },
      async requestPermission(kind) {
        const result = await wire.request<{ state: import("./voice-input").VoicePermissionState }>(
          RequestMethod.VoicePermissionRequest,
          { kind },
        );
        return result.state;
      },
      async getTimelineStatus() {
        return await wire.request(RequestMethod.VoiceTimelineStatus, {});
      },
      async setTimelinePaused(paused) {
        return await wire.request(RequestMethod.VoiceTimelineSetPaused, { paused });
      },
      async clearTimelineCache() {
        return await wire.request(RequestMethod.VoiceTimelineClear, {});
      },
      async setContinuousRecording(enabled) {
        return await wire.request(RequestMethod.VoiceTimelineSetRecording, { enabled });
      },
      async listSystemInputs() {
        const result = await wire.request<{ endpoints: import("./voice-input").SystemInputEndpoint[] }>(
          RequestMethod.VoiceSystemInputsList,
          {},
        );
        return result.endpoints;
      },
    },
    localTts: {
      async getStatus() {
        return await wire.request(RequestMethod.TtsLocalStatus, {});
      },
      async requestMicrophonePermission() {
        const result = await wire.request<{ state: import("./local-tts").LocalTtsStatus["microphonePermission"] }>(
          RequestMethod.TtsLocalMicrophoneRequest,
          {},
        );
        return result.state;
      },
      async startRecording() {
        return await wire.request(RequestMethod.TtsLocalRecordingStart, {});
      },
      async stopRecording() {
        return await wire.request(RequestMethod.TtsLocalRecordingStop, {});
      },
      async cancelRecording() {
        await wire.request<void>(RequestMethod.TtsLocalRecordingCancel, {});
      },
      async authorizeSamplePlayback(sampleId) {
        return await wire.request(RequestMethod.TtsLocalRecordingPlaybackAuthorize, { sampleId });
      },
      async prepareRecognition() {
        return await wire.request(RequestMethod.TtsLocalRecognitionPrepare, {});
      },
      async confirmRecognition(sampleId, transcript) {
        return await wire.request(RequestMethod.TtsLocalRecognitionConfirm, { sampleId, transcript });
      },
      async downloadModel(modelId) {
        return await wire.request(RequestMethod.TtsLocalModelDownload, { modelId });
      },
      async cancelModelDownload(modelId) {
        await wire.request<void>(RequestMethod.TtsLocalModelCancelDownload, { modelId });
      },
      async deleteModel(modelId) {
        await wire.request<void>(RequestMethod.TtsLocalModelDelete, { modelId });
      },
      async registerVoice(input) {
        return await wire.request(RequestMethod.TtsLocalVoiceRegister, input);
      },
      async deleteVoice(modelId, voiceId) {
        await wire.request<void>(RequestMethod.TtsLocalVoiceDelete, { modelId, voiceId });
      },
      async getDefaultVoice() {
        return await wire.request(RequestMethod.TtsLocalDefaultGet, {});
      },
      async setDefaultVoice(input) {
        return await wire.request(RequestMethod.TtsLocalDefaultSet, input);
      },
      async synthesize(input) {
        return await wire.request(RequestMethod.TtsLocalSynthesize, input);
      },
      async cancel() {
        await wire.request<void>(RequestMethod.TtsLocalCancel, {});
      },
    },
    voiceRecordings: {
      async list(options) {
        return await wire.request(RequestMethod.VoiceRecordingsList, {
          page: options?.page ?? 0,
          perPage: options?.perPage ?? 20,
        });
      },
      async authorizePlayback(recordingId) {
        return await wire.request(RequestMethod.VoiceRecordingPlaybackAuthorize, { recordingId });
      },
      async delete(recordingId) {
        const result = await wire.request<{ deleted: boolean }>(RequestMethod.VoiceRecordingDelete, {
          recordingId,
        });
        return result.deleted;
      },
      async retranscribeSegment(recordingId) {
        return await wire.request<{ requeued: number }>(
          RequestMethod.VoiceRecordingRetranscribeSegment,
          { recordingId },
        );
      },
      async setSummary(recordingId, summary) {
        const result = await wire.request<{
          segment: import("./voice-recordings").VoiceRecordingSegment | null;
        }>(RequestMethod.VoiceRecordingSetSummary, {
          recordingId,
          points: summary.points,
          ...(summary.generatedAtMs === undefined ? {} : { generatedAtMs: summary.generatedAtMs }),
          ...(summary.dshSessionId ? { dshSessionId: summary.dshSessionId } : {}),
          ...(summary.basedOnTranscribedAtMs === undefined
            ? {}
            : { basedOnTranscribedAtMs: summary.basedOnTranscribedAtMs }),
        });
        return result.segment ?? null;
      },
      async replayCacheStatus() {
        return await wire.request(RequestMethod.VoiceReplayCacheStatus, {});
      },
      async setReplayRetention(retention) {
        return await wire.request(RequestMethod.VoiceReplaySetRetention, { retention });
      },
      async clearReplayCache() {
        return await wire.request(RequestMethod.VoiceReplayCacheClear, {});
      },
      async listRecoverableInputSessions(options) {
        return await wire.request(RequestMethod.VoiceRecoverableInputSessionsList, {
          page: options?.page ?? 0,
          perPage: options?.perPage ?? 50,
          ...(options?.includeSettledRetries === undefined ? {} : { includeSettledRetries: options.includeSettledRetries }),
        });
      },
      async getInputSession(recordingId) {
        return await wire.request(RequestMethod.VoiceInputSessionGet, { recordingId });
      },
      async transcribeSavedInput(input) {
        return await wire.request(RequestMethod.VoiceSavedInputTranscribe, input);
      },
      async cancelSavedInput(input) {
        return await wire.request(RequestMethod.VoiceSavedInputCancel, input);
      },
      async transcribeInputSession(recordingId) {
        return await wire.request(RequestMethod.VoiceInputSessionTranscribe, { recordingId });
      },
      async setInputSessionTranscription(recordingId, status, transcript) {
        await wire.request<void>(RequestMethod.VoiceInputSessionSetTranscription, {
          recordingId,
          status,
          ...(transcript === undefined ? {} : { transcript }),
        });
      },
    },
    voiceContext: {
      async capture(options) {
        // 默认 false 是合同的一部分：没显式要就一个字都不读。这里显式写出来，
        // 免得将来有人以为「不传 = Host 自己看着办」。
        return await wire.request(RequestMethod.VoiceContextCapture, {
          includeWindowText: options?.includeWindowText === true,
          includeWindowScreenshot: options?.includeWindowScreenshot === true,
          ...(options?.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...(options?.consentEpoch === undefined ? {} : { consentEpoch: options.consentEpoch }),
        });
      },
    },
    voiceCommand: {
      async getStatus(options) {
        return await wire.request(RequestMethod.VoiceCommandStatus, {}, options);
      },
      async configure(workflowUrl) {
        return await wire.request(RequestMethod.VoiceCommandConfigure, { workflowUrl });
      },
      async presentTask(snapshot) {
        await wire.request(RequestMethod.VoiceCommandPresentTask, snapshot);
      },
      async dismissTask(taskId) {
        await wire.request(RequestMethod.VoiceCommandDismissTask, { taskId });
      },
      async presentPlan(input) {
        await wire.request(RequestMethod.VoiceCommandPresentPlan, input);
      },
      async presentAnswer(input) {
        await wire.request(RequestMethod.VoiceCommandPresentAnswer, input);
      },
      async run(input, options) {
        if (options?.signal?.aborted) {
          throw new AppError({
            code: "voice.command/CANCELLED",
            userMessage: "语音命令已取消",
          });
        }
        const requestId = crypto.randomUUID();
        const cancel = () => {
          void wire.request(RequestMethod.VoiceCommandCancel, { requestId }).catch(() => undefined);
        };
        options?.signal?.addEventListener("abort", cancel, { once: true });
        if (options?.signal?.aborted) {
          options.signal.removeEventListener("abort", cancel);
          throw new AppError({
            code: "voice.command/CANCELLED",
            userMessage: "语音命令已取消",
          });
        }
        try {
          return await wire.request(
            RequestMethod.VoiceCommandRun,
            {
              requestId,
              text: input.text,
              // 命令类型跟着这一次请求走：同一条运行时上，转文本 / 翻译 / Agent 提问
              // 的差别就在这里。缺省不带字段，老工作流的请求体一字不变。
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            },
            options,
          );
        } finally {
          options?.signal?.removeEventListener("abort", cancel);
        }
      },
    },
    aiApi: {
      freeOnlyTranscriptionSupported: true,
      async listModels() {
        const result = await wire.request<{
          models: import("./cloud").CloudModelOption[];
        }>(RequestMethod.AiModelsList, {});
        return result.models;
      },
      async generateText(options) {
        return await wire.request(RequestMethod.AiTextGenerate, {
          invocationId: options.invocationId,
          model: options.model,
          messages: options.messages,
          ...(options.stream === undefined ? {} : { stream: options.stream }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: options.maxOutputTokens }),
        });
      },
      async transcribe(options) {
        return await wire.request(RequestMethod.AiAudioTranscribe, {
          invocationId: options.invocationId,
          sessionId: options.sessionId,
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.billingPolicy === undefined ? {} : { billingPolicy: options.billingPolicy }),
          ...(options.language === undefined ? {} : { language: options.language }),
        });
      },
      async cancel(invocationId) {
        return await wire.request(RequestMethod.AiCancel, { invocationId });
      },
    },
    flowApi: {
      async invoke(options) {
        return await wire.request(RequestMethod.FlowInvoke, {
          invocationId: options.invocationId,
          workflow: options.workflow,
          ...(options.input === undefined ? {} : { input: options.input }),
        });
      },
      async cancel(invocationId) {
        return await wire.request(RequestMethod.FlowCancel, { invocationId });
      },
    },
    delivery: {
      async commit(options) {
        return await wire.request(RequestMethod.VoiceDeliverCommit, {
          targetId: options.targetId,
          text: options.text,
          behavior: options.behavior ?? "insert",
        });
      },
      async presentTakeback(options) {
        await wire.request(RequestMethod.VoiceDeliverPresentTakeback, {
          title: options.title,
          reason: options.reason,
          text: options.text,
          // Host API 1.22 可选诊断字段：缺省就不发，旧调用的请求形状不变。
          ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
        });
      },
    },
    localAgent: {
      async status() {
        return await wire.request(RequestMethod.LocalStatus, {});
      },
      async send(options) {
        return await wire.request(RequestMethod.LocalChatSend, {
          message: options.message,
        });
      },
      async cancel() {
        await wire.request<void>(RequestMethod.LocalChatCancel, {});
      },
    },
    dshAgent: {
      async status() {
        return await wire.request(RequestMethod.DshStatus, {});
      },
      async createSession() {
        return await wire.request(RequestMethod.DshSessionCreate, {});
      },
      async send(options) {
        return await wire.request(RequestMethod.DshSessionSend, options);
      },
      async cancel(options) {
        return await wire.request(RequestMethod.DshSessionCancel, options);
      },
      async history(options) {
        return await wire.request(RequestMethod.DshSessionHistory, options);
      },
      async listSessions() {
        return await wire.request(RequestMethod.DshSessionList, {});
      },
      async deleteSession(options) {
        return await wire.request(RequestMethod.DshSessionDelete, options);
      },
    },
    agent: {
      approvals: {
        // 1.21：只读；批准 / 拒绝没有 Bridge 方法，属于 Host 主窗口。
        async list(options) {
          return await wire.request(options.sessionId.startsWith("agent2-") ? RequestMethod.AgentV2ApprovalsList : RequestMethod.AgentSessionApprovalsList, options);
        },
      },
      async waitForTurn(options) { return await waitForAgentTurn(options); },
      async startTurn(options) { return await wire.request(RequestMethod.AgentV2StartTurn, options); },
      async attachmentAdmission(options) { return await wire.request(RequestMethod.AgentV2AttachmentRead, options); },
      attachmentUploads: {
        async start(options) { return await wire.request(RequestMethod.AgentV2AttachmentUploadStart, options); },
        async chunk(options) { return await wire.request(RequestMethod.AgentV2AttachmentUploadChunk, options); },
        async finish(options) { return await wire.request(RequestMethod.AgentV2AttachmentUploadFinish, options); },
        async cancel(options) { return await wire.request(RequestMethod.AgentV2AttachmentUploadCancel, options); },
      },
      async getTurn(options) { return await wire.request(RequestMethod.AgentV2GetTurn, options); },
      async events(options) { return await wire.request(RequestMethod.AgentV2Events, options); },
      async backends(options) {
        return await wire.request(options?.schemaVersion === 2 ? RequestMethod.AgentV2Backends : RequestMethod.AgentBackendsList, {});
      },
      async createSession(spec) {
        if ("schemaVersion" in spec) {
          return await wire.request(RequestMethod.AgentV2Create, { config: spec });
        }
        return await wire.request(RequestMethod.AgentSessionCreate, { spec });
      },
      async send(options) {
        if (options.sessionId.startsWith("agent2-")) {
          const request = { sessionId: options.sessionId, idempotencyKey: options.turnId ?? crypto.randomUUID(), text: options.text, taskPresentation: options.taskPresentation,
            ...(options.attachmentInput ? { attachmentInput: options.attachmentInput } : {}) };
          const turn = await wire.request<AgentTurnSnapshot>(RequestMethod.AgentV2StartTurn, request);
          return await waitForAgentTurn({ sessionId: options.sessionId, turnId: turn.turnId }, turn);
        }
        return await wire.request(RequestMethod.AgentSessionSend, options);
      },
      async cancel(options) {
        return await wire.request(options.sessionId.startsWith("agent2-") ? RequestMethod.AgentV2Cancel : RequestMethod.AgentSessionCancel, options);
      },
      async history(options) {
        return await wire.request(options.sessionId.startsWith("agent2-") ? RequestMethod.AgentV2History : RequestMethod.AgentSessionHistory, options);
      },
      async listSessions(options) {
        return await wire.request(options?.schemaVersion === 2 ? RequestMethod.AgentV2List : RequestMethod.AgentSessionList, {});
      },
      async deleteSession(options) {
        return await wire.request(options.sessionId.startsWith("agent2-") ? RequestMethod.AgentV2Delete : RequestMethod.AgentSessionDelete, options);
      },
      async prepareConversationOpen({ sessionId }) {
        const owner = captureOpenOwner(sessionId);
        const selection = {};
        preparingOpens.set(owner.mount, selection);
        retireOpenReceipts(previous => !currentOpen(previous) || previous.mount === owner.mount);
        const current = () => currentOpen(owner) && preparingOpens.get(owner.mount) === selection;
        try {
          await requireOpenDescriptor(owner);
          if (!current()) throw staleOpen();
          if (openReceipts.size >= 16) throw new AppError({ code: "TASK_LIMIT_EXCEEDED", userMessage: "会话确认仍在处理中" });
          const receipt = await wire.request<AgentConversationOpenReceipt>(openMethod(sessionId), { sessionId, phase: "prepare" });
          if (!receipt || typeof receipt.openToken !== "string" || !/^[\x21-\x7e]{1,128}$/.test(receipt.openToken)) throw staleOpen();
          if (!current()) { cancelOpenToken(receipt.openToken, owner); throw staleOpen(); }
          openReceipts.set(receipt.openToken, owner);
          return Object.freeze({ openToken: receipt.openToken });
        } finally {
          if (preparingOpens.get(owner.mount) === selection) preparingOpens.delete(owner.mount);
        }
      },
      async reportConversationOpened({ sessionId, receipt }) {
        if (!receipt) { await wire.request(openMethod(sessionId), { sessionId }); return; }
        const owner = requireOpenReceipt(sessionId, receipt);
        await requireOpenDescriptor(owner);
        requireOpenReceipt(sessionId, receipt);
        await wire.request(openMethod(sessionId), { sessionId, phase: "commit", openToken: receipt.openToken });
        if (!currentOpen(owner)) throw staleOpen();
        requireOpenReceipt(sessionId, receipt);
      },
      async cancelConversationOpen({ sessionId, receipt }) {
        const owner = requireOpenReceipt(sessionId, receipt);
        openReceipts.delete(receipt.openToken);
        await wire.request(openMethod(sessionId), { sessionId, phase: "cancel", openToken: receipt.openToken });
        if (!currentOpen(owner)) throw staleOpen();
      },
      async requireToolDependency(options) {
        await wire.request(options.schemaVersion === 2 ? RequestMethod.AgentV2ToolDependencyRequire : RequestMethod.AgentToolDependencyRequire, { tool: options.tool });
      },
    },
    piManagement: {
      async snapshot() {
        return await wire.request(RequestMethod.PiManagementSnapshot, {});
      },
      async session(sessionId) {
        return await wire.request(RequestMethod.PiManagementSessionGet, { sessionId });
      },
      async models() {
        return await wire.request(RequestMethod.PiManagementModels, {});
      },
      async updateSettings(settings) {
        return await wire.request(RequestMethod.PiManagementSettingsUpdate, settings);
      },
    },
    dshObserver: {
      async snapshot() {
        return await wire.request(RequestMethod.DshObserverSnapshot, {});
      },
      async sessionDetail(sessionId) {
        return await wire.request(RequestMethod.DshObserverSessionDetail, { sessionId });
      },
      async historyPage(sessionId, cursor, limit) {
        return await wire.request(RequestMethod.DshObserverHistoryPage, {
          sessionId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
      async settings() {
        return await wire.request(RequestMethod.DshObserverSettings, {});
      },
      async updateSettings(modelAlias) {
        return await wire.request(RequestMethod.DshObserverSettingsUpdate, { modelAlias });
      },
    },
    systemTasks: {
      async getVersionStatus(options) {
        return await wire.request(
          RequestMethod.SystemTasksVersionStatus,
          options?.refresh === undefined ? {} : { refresh: options.refresh },
        );
      },
      async open(options) {
        return await wire.request(RequestMethod.SystemTasksOpen, {
          target: options.target,
          ...(options.returnIntent === undefined ? {} : { returnIntent: options.returnIntent }),
        });
      },
    },
    folderPick: {
      async pick() {
        const result = await wire.request<{ path?: string | null }>(
          RequestMethod.SystemFolderPick,
          {},
        );
        // 用户按取消是正常结果，不是错误——统一成 undefined，调用方保持原样即可。
        return typeof result?.path === "string" && result.path.length > 0
          ? result.path
          : undefined;
      },
    },
    codexTasks: {
      async status() {
        return await wire.request(RequestMethod.CodexTasksRuntimeStatus, {});
      },
      async account() {
        return await wire.request(RequestMethod.CodexTasksAccountRead, {});
      },
      async rateLimits() {
        return await wire.request(RequestMethod.CodexTasksRateLimits, {});
      },
      async usage() {
        return await wire.request(RequestMethod.CodexTasksUsage, {});
      },
      async startLogin(mode = "browser") {
        return await wire.request(RequestMethod.CodexTasksLoginStart, { mode });
      },
      async cancelLogin(loginId) {
        await wire.request(RequestMethod.CodexTasksLoginCancel, { loginId });
      },
      async logout() {
        await wire.request(RequestMethod.CodexTasksLogout, {});
      },
      async listModels() {
        return await wire.request(RequestMethod.CodexTasksModelsList, {});
      },
      async listSkills(cwds) {
        return await wire.request(RequestMethod.CodexTasksSkillsList, cwds ? { cwds } : {});
      },
      async listThreads(options) {
        return await wire.request(RequestMethod.CodexTasksThreadList, options ?? {});
      },
      async readThread(threadId) {
        return await wire.request(RequestMethod.CodexTasksThreadRead, { threadId });
      },
      async startThread(cwd) {
        return await wire.request(RequestMethod.CodexTasksThreadStart, { cwd });
      },
      async resumeThread(threadId) {
        return await wire.request(RequestMethod.CodexTasksThreadResume, { threadId });
      },
      async archiveThread(threadId) {
        return await wire.request(RequestMethod.CodexTasksThreadArchive, { threadId });
      },
      async nameThread(threadId, name) {
        await wire.request(RequestMethod.CodexTasksThreadName, { threadId, name });
      },
      async startTurn(options) {
        return await wire.request(RequestMethod.CodexTasksTurnStart, options);
      },
      async steerTurn(options) {
        return await wire.request(RequestMethod.CodexTasksTurnSteer, options);
      },
      async interruptTurn(threadId, turnId) {
        await wire.request(RequestMethod.CodexTasksTurnInterrupt, { threadId, turnId });
      },
      async respondApproval(options) {
        await wire.request(RequestMethod.CodexTasksApprovalRespond, options);
      },
      async respondUserInput(requestId, answers) {
        await wire.request(RequestMethod.CodexTasksUserInputRespond, { requestId, answers });
      },
      async drainEvents() {
        return await wire.request(RequestMethod.CodexTasksEventsDrain, {});
      },
      async conversationOpened(threadId) {
        await wire.request(RequestMethod.CodexTasksConversationOpened, { threadId });
      },
      async createFileHandoff(threadId, path) {
        return await wire.request(RequestMethod.CodexTasksFileHandoffCreate, { threadId, path });
      },
    },
    localFiles: {
      async pickWorkspace() {
        const result = await wire.request<{ workspace?: import("./local-files").LocalWorkspace | null }>(
          RequestMethod.LocalFilesWorkspacePick,
          {},
        );
        return result.workspace ?? undefined;
      },
      async listWorkspaces() {
        const result = await wire.request<{ workspaces: import("./local-files").LocalWorkspace[] }>(
          RequestMethod.LocalFilesWorkspaceList,
          {},
        );
        return result.workspaces;
      },
      async revokeWorkspace(workspaceId) {
        await wire.request(RequestMethod.LocalFilesWorkspaceRevoke, { workspaceId });
      },
      async listDirectory(workspaceId, path) {
        return await wire.request(RequestMethod.LocalFilesDirectoryList, {
          workspaceId,
          ...(path ? { path } : {}),
        });
      },
      async readDocument(workspaceId, path) {
        return await wire.request(RequestMethod.LocalFilesDocumentRead, { workspaceId, path });
      },
      async writeDocument(options) {
        return await wire.request(RequestMethod.LocalFilesDocumentWrite, options);
      },
      async claimHandoff(token) {
        return await wire.request(RequestMethod.LocalFilesHandoffClaim, { token });
      },
    },
    gateway: {
      async list() { return wire.request<import("./services").GatewayHandle[]>(RequestMethod.GatewayList, {}); },
      async issue(scope) { return wire.request<import("./services").GatewayConnection>(RequestMethod.GatewayIssue, scope); },
      async revoke(id) { await wire.request<void>(RequestMethod.GatewayRevoke, { id }); },
    },
    storage: { private: makeStore },
    account: {
      async status() {
        return await wire.request<AccountStatusResult>(RequestMethod.AccountStatus, {});
      },
    },
    notifications: {
      async post(options) {
        return await wire.request<NotificationPostResult>(RequestMethod.NotificationsPost, options);
      },
      async publish(input) {
        return await notificationRequest<import("./platform-contracts").NotificationPublishReceipt>(RequestMethod.NotificationsPublish, input);
      },
      async listHistory(input) {
        return await notificationRequest<import("./platform-contracts").NotificationHistoryPage>(RequestMethod.NotificationsHistoryList, input);
      },
      async markRead(input) {
        await notificationRequest<void>(RequestMethod.NotificationsHistoryMarkRead, input);
      },
    },
    clipboard: {
      async writeText(text) {
        return await wire.request(RequestMethod.ClipboardWriteText, { text });
      },
    },
    tabItems: {
      onChange(handler) {
        layerHandlers.tab.add(handler);
        return () => { layerHandlers.tab.delete(handler); };
      },
      async isVisible() {
        const result = await wire.request<{ visible?: boolean }>(RequestMethod.TabItemsList, {});
        return result.visible ?? true;
      },
      async upsert(item) {
        await wire.request<void>(RequestMethod.TabItemsUpsert, item);
      },
      async remove(entityId) {
        await wire.request<void>(RequestMethod.TabItemsRemove, { entityId });
      },
      async list() {
        const result = await wire.request<{ items: TabItemInfo[] }>(RequestMethod.TabItemsList, {});
        return result.items;
      },
    },
    actionItems: {
      onChange(handler) {
        layerHandlers.action.add(handler);
        return () => { layerHandlers.action.delete(handler); };
      },
      async mount(item) {
        await wire.request<void>(RequestMethod.ActionItemsMount, item);
      },
      async unmount(kind, id) {
        await wire.request<void>(RequestMethod.ActionItemsUnmount, { kind, id });
      },
      async list() {
        const result = await wire.request<{ mounts: ActionMountInfo[] }>(
          RequestMethod.ActionItemsList,
          {},
        );
        return result.mounts;
      },
    },
    evidence: {
      async fetch(pickupToken) {
        const result = await wire.request<{ dataBase64: string }>(RequestMethod.EvidenceFetch, {
          token: pickupToken,
        });
        // base64 → 字节（WebView 环境 atob 恒在）。
        const binary = atob(result.dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      },
    },
    events: {
      on(handler) {
        if (!registrationOpen) {
          throw new AppError({
            code: "app-sdk/REGISTRATION_CLOSED",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: "events.on 只能在 activate 期间调用",
          });
        }
        eventHandlers.add(handler);
      },
      onCodex(handler) {
        if (!registrationOpen) {
          throw new AppError({
            code: "app-sdk/REGISTRATION_CLOSED",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: "events.onCodex 只能在 activate 期间调用",
          });
        }
        codexEventHandlers.add(handler);
      },
      onCloud(handler) {
        if (!registrationOpen) {
          throw new AppError({
            code: "app-sdk/REGISTRATION_CLOSED",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: "events.onCloud 只能在 activate 期间调用",
          });
        }
        cloudEventHandlers.add(handler);
      },
      onLocalAgent(handler) {
        if (!registrationOpen) {
          throw new AppError({
            code: "app-sdk/REGISTRATION_CLOSED",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: "events.onLocalAgent 只能在 activate 期间调用",
          });
        }
        localEventHandlers.add(handler);
      },
    },
    commands: {
      register(commandId, handler, options) {
        requireRegistrationWindow("Command", commandId);
        if (commands.has(commandId)) {
          throw new AppError({
            code: "app-sdk/DUPLICATE_REGISTRATION",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: `Command ${commandId} 注册了两次`,
          });
        }
        commands.set(commandId, handler as CommandHandler);
        if (options?.supportsOperations) operationCommands.add(commandId);
      },
    },
    surfaces: {
      register(surfaceId, handler) {
        requireRegistrationWindow("Surface", surfaceId);
        if (surfaces.has(surfaceId)) {
          throw new AppError({
            code: "app-sdk/DUPLICATE_REGISTRATION",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: `Surface ${surfaceId} 注册了两次`,
          });
        }
        surfaces.set(surfaceId, handler as SurfaceMountHandler);
      },
      async open(surfaceId, payload, options) {
        await wire.request<void>(
          RequestMethod.SurfaceOpen,
          { surfaceId, intent: payload?.intent },
          options,
        );
      },
    },
    apps: {
      async open(target, input, options) {
        await wire.request<void>(
          RequestMethod.AppsOpen,
          { appId: target.appId, intent: target.intent, input },
          options,
        );
      },
      async status(target) {
        return await wire.request<AppDependencyStatus>(
          RequestMethod.AppsStatus,
          { appId: target.appId },
        );
      },
    },
    services: {
      provide(serviceId, method, handler) {
        const key = `${serviceId}#${method}`;
        requireRegistrationWindow("Service", key);
        if (services.has(key)) {
          throw new AppError({
            code: "app-sdk/DUPLICATE_REGISTRATION",
            userMessage: "扩展初始化异常",
            retryable: false,
            cause: `Service ${key} 注册了两次`,
          });
        }
        services.set(key, handler as ServiceHandler);
      },
      async call(serviceId, method, input, options) {
        const serviceRequestId = nextServiceRequestId();
        const signal = options?.signal;
        if (signal?.aborted) {
          throw new AppError({
            code: "SERVICE_CANCELLED",
            userMessage: "Service 调用已取消",
            retryable: false,
          });
        }
        const cancel = () => {
          void wire.request<void>(RequestMethod.ServicesCancel, { requestId: serviceRequestId })
            .catch(() => undefined);
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          signal.removeEventListener("abort", cancel);
          throw new AppError({
            code: "SERVICE_CANCELLED",
            userMessage: "Service 调用已取消",
            retryable: false,
          });
        }
        try {
          return await wire.request(
            RequestMethod.ServicesCall,
            { requestId: serviceRequestId, serviceId, method, input },
            options,
          );
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
      },
    },
  };

  // One bounded local IPC read closes the bootstrap/mount broadcast window. The
  // production bridge ignores AbortSignal, so cancellation cannot rely on it.
  const readLocale = () => new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelLocaleRead === cancel) cancelLocaleRead = undefined;
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new AppError({ code: "LOCALE_INIT_CANCELLED", userMessage: "Language initialization cancelled" }));
    const timer = setTimeout(() => finish(new AppError({
      code: "LOCALE_INIT_TIMEOUT", userMessage: "Language initialization timed out", retryable: true,
    })), 3_000);
    cancelLocaleRead = cancel;
    void wire.request(RequestMethod.LocaleGet, {}).then(
      (value) => finish(null, value), (error) => finish(error),
    );
  });

  const activate = async (message: Extract<HostMessage, { type: "activate" }>, epoch: number): Promise<ActivationResult> => {
    const sessionId = message.runtimeSessionId;
    runtimeSessionId = sessionId;
    registrationOpen = false;
    const current = () => !disposed && epoch === activationEpoch;
    try {
      const initial = parseLocaleSnapshot(message.locale);
      if (message.locale !== undefined && !initial) throw new AppError({
        code: "LOCALE_INVALID_SNAPSHOT", userMessage: "Invalid UI language snapshot",
      });
      locale.begin(sessionId, initial);
      if (initial) {
        const reply = await readLocale();
        if (!current()) return { ok: false };
        const next = parseLocaleSnapshot(reply);
        if (!next || (reply as { runtimeSessionId?: unknown }).runtimeSessionId !== sessionId) {
          throw new AppError({ code: "LOCALE_INVALID_SNAPSHOT", userMessage: "Invalid UI language snapshot" });
        }
        locale.receive(sessionId, next);
      }
      if (!current()) return { ok: false };
      registrationOpen = true;
      await definition.activate(context);
      if (!current()) return { ok: false };
    } catch (thrown) {
      if (!current()) return { ok: false };
      registrationOpen = false;
      const error = toWireError(thrown);
      wire.notify(NotifyMethod.ActivateFailed, error);
      return { ok: false, error };
    }
    registrationOpen = false;

    const report: RegistrationReport = {
      runtimeSessionId: sessionId,
      surfaces: [...surfaces.keys()],
      commands: [...commands.keys()],
      intents: [...intents],
      services: [...services.keys()],
      operationCommands: [...operationCommands],
    };
    wire.notify(NotifyMethod.Registered, report);
    return { ok: true };
  };

  const invokeCommand = async (
    correlationId: string,
    commandId: string,
    input: unknown,
    operation?: { id: string; phase: "start" | "end" },
    completesOperation?: string,
  ) => {
    if (operation && (!operationCommands.has(commandId) || !operation.id || !["start", "end"].includes(operation.phase))) {
      wire.notify(NotifyMethod.CommandSettled, { correlationId, ok: false, error: { code: "COMMAND_OPERATION_UNSUPPORTED", userMessage: "请更新扩展以使用此操作", retryable: false } });
      return;
    }
    const handler = commands.get(commandId);
    if (!handler) {
      const settlement: CommandSettlement = {
        correlationId,
        ok: false,
        error: {
          code: "MISSING_COMMAND_HANDLER",
          userMessage: "这个功能暂时不可用",
          retryable: false,
          diagnostic: `Command ${commandId} 未注册`,
        },
      };
      wire.notify(NotifyMethod.CommandSettled, settlement);
      return;
    }

    const finishedOperation = operation?.phase === "end" ? operation.id : completesOperation;
    if (finishedOperation) {
      const startCorrelation = activeOperations.get(finishedOperation);
      if (startCorrelation) inflight.delete(startCorrelation);
      activeOperations.delete(finishedOperation);
    }
    const controller = new AbortController();
    inflight.set(correlationId, controller);
    let retainOperation = false;
    try {
      const output = await handler({ input, signal: controller.signal, ...(operation ? { operation } : {}) });
      if (operation?.phase === "start" && !controller.signal.aborted) {
        // Settlement delivery can race Host cancellation. Keep the exact start
        // cancellable until its paired end, even after the handler returned.
        activeOperations.set(operation.id, correlationId);
        retainOperation = true;
      }
      const settlement: CommandSettlement = { correlationId, ok: true, output };
      wire.notify(NotifyMethod.CommandSettled, settlement);
    } catch (thrown) {
      const settlement: CommandSettlement = {
        correlationId,
        ok: false,
        error: toWireError(thrown),
      };
      wire.notify(NotifyMethod.CommandSettled, settlement);
    } finally {
      if (!retainOperation) inflight.delete(correlationId);
    }
  };

  const invokeService = async (
    correlationId: string,
    serviceId: string,
    method: string,
    input: unknown,
    caller?: ServiceCaller,
    deadlineUnixMs?: number,
  ) => {
    const key = `${serviceId}#${method}`;
    const handler = services.get(key);
    if (!handler) {
      serviceEnvelopes.delete(correlationId);
      const settlement: ServiceSettlement = {
        correlationId,
        ok: false,
        error: {
          code: "SERVICE_METHOD_NOT_PROVIDED",
          userMessage: "服务暂时不可用",
          retryable: false,
          diagnostic: `Service ${key} 没有注册`,
        },
      };
      wire.notify(NotifyMethod.ServiceSettled, settlement);
      return;
    }
    const controller = new AbortController();
    serviceInflight.set(correlationId, controller);
    try {
      const output = await handler({
        input, signal: controller.signal,
        ...(caller === undefined ? {} : { caller: Object.freeze({ ...caller }) }),
        ...(deadlineUnixMs === undefined ? {} : { deadlineUnixMs }),
      });
      if (!controller.signal.aborted && !disposed) {
        wire.notify(NotifyMethod.ServiceSettled, { correlationId, ok: true, output } satisfies ServiceSettlement);
      }
    } catch (thrown) {
      if (!controller.signal.aborted && !disposed) {
        wire.notify(NotifyMethod.ServiceSettled, {
          correlationId,
          ok: false,
          error: toWireError(thrown),
        } satisfies ServiceSettlement);
      }
    } finally {
      serviceInflight.delete(correlationId);
      serviceEnvelopes.delete(correlationId);
    }
  };

  const mountSurface = async (message: Extract<HostMessage, { type: "surface.mount" }>, pendingIntent?: unknown) => {
    const handler = surfaces.get(message.surfaceId);
    const state: MountState = {
      surfaceId: message.surfaceId,
      settled: false,
      intentHandlers: new Set(),
      presentationHandlers: new Set(),
      pendingIntent,
    };
    mounts.set(message.surfaceMountId, state);
    registerOpenIntent(message.surfaceMountId, state, pendingIntent ?? message.initialIntent);

    const settle = (method: typeof NotifyMethod.SurfaceReady | typeof NotifyMethod.SurfaceFailed, payload: unknown) => {
      if (state.settled) return false;
      state.settled = true;
      wire.notify(method, payload);
      return true;
    };

    if (!handler) {
      settle(NotifyMethod.SurfaceFailed, {
        surfaceMountId: message.surfaceMountId,
        error: {
          code: "MISSING_SURFACE_HANDLER",
          userMessage: "这个界面暂时打不开",
          retryable: false,
          diagnostic: `Surface ${message.surfaceId} 未注册`,
        },
      });
      return;
    }

    const handle: SurfaceHandle = {
      surfaceId: message.surfaceId,
      surfaceMountId: message.surfaceMountId,
      root: message.root as HTMLElement,
      ...(message.initialIntent === undefined ? {} : { initialIntent: message.initialIntent }),
      ready() {
        settle(NotifyMethod.SurfaceReady, { surfaceMountId: message.surfaceMountId });
      },
      fail(error) {
        settle(NotifyMethod.SurfaceFailed, {
          surfaceMountId: message.surfaceMountId,
          error: toWireError(error),
        });
      },
      reportError(error) {
        wire.notify(NotifyMethod.SurfaceError, {
          surfaceMountId: message.surfaceMountId,
          error: toWireError(error),
        });
      },
      get navigation() {
        if (!presentations.has(message.surfaceMountId)) return undefined;
        return createSurfaceNavigation(wire, () => !disposed && mounts.get(message.surfaceMountId) === state ? presentations.get(message.surfaceMountId) : undefined);
      },
      reportNav(nav) {
        if (disposed || mounts.get(message.surfaceMountId) !== state) return;
        const binding = presentations.get(message.surfaceMountId);
        wire.notify(NotifyMethod.SurfaceNav, {
          ...(binding ? {runtimeSessionId:binding.runtimeSessionId,presentationToken:binding.presentationToken} : {}),
          surfaceMountId: message.surfaceMountId,
          nav: nav === null ? null : { key: nav.key, label: nav.label },
        });
      },
      onPresentationChange(handler) {
        if (disposed || mounts.get(message.surfaceMountId) !== state) return () => {};
        // Each subscription owns its entry, even when callers reuse the same function.
        const listener = () => {
          try { handler(); }
          catch (error) { console.error("[app-sdk] Surface 呈现通知处理失败", error); }
        };
        state.presentationHandlers.add(listener);
        if (presentations.has(message.surfaceMountId)) listener();
        return () => { state.presentationHandlers.delete(listener); };
      },
      onIntent(handler) {
        const fn = handler as (intent: unknown) => void;
        state.intentHandlers.add(fn);
        // 注册前先到的 intent 补发给这个新 handler（只留最新一条，不排队）。
        // 补发也必须「抛错不致命」：直达路径的异常被 bootstrap 的 deliver 接住
        // 只是一条日志，补发路径要是让它传播进 mount handler，会把整个 Surface
        // 拆了——同一条 intent 晚到一拍只是日志、早到一拍拆界面，这种不对称
        // 比丢 intent 更糟。
        if (state.pendingIntent !== undefined) {
          const buffered = state.pendingIntent;
          state.pendingIntent = undefined;
          try {
            fn(buffered);
          } catch (error) {
            console.error("[app-sdk] intent 补发处理失败", error);
          }
        }
        return () => state.intentHandlers.delete(fn);
      },
    };

    try {
      const cleanup = await handler(handle);
      if (typeof cleanup === "function") {
        if (!disposed && mounts.get(message.surfaceMountId) === state) state.cleanup = cleanup;
        else cleanup();
      }
    } catch (thrown) {
      settle(NotifyMethod.SurfaceFailed, {
        surfaceMountId: message.surfaceMountId,
        error: toWireError(thrown),
      });
    }
  };

  const unmountSurface = (surfaceMountId: string) => {
    preparingOpens.delete(surfaceMountId);
    retireOpenReceipts(owner => owner.mount === surfaceMountId);
    for (const [id, receipt] of audioReceipts) {
      if (receipt.mount === surfaceMountId) audioReceipts.delete(id);
    }
    presentations.delete(surfaceMountId);
    endedPresentationMounts.add(surfaceMountId);
    if (endedPresentationMounts.size > 128) endedPresentationMounts.delete(endedPresentationMounts.values().next().value!);
    const state = mounts.get(surfaceMountId);
    if (!state) return;
    mounts.delete(surfaceMountId);
    state.intentHandlers.clear();
    state.presentationHandlers.clear();
    try {
      state.cleanup?.();
    } catch (thrown) {
      // 清理失败不该让卸载卡住：Host 那边 WebView 已经要销毁了。
      console.error("[app-sdk] Surface 清理函数抛错", thrown);
    }
  };

  const handle = (message: HostMessage) => {
    if (disposed) return;
    switch (message.type) {
      case "activate":
        // A Host WebView owns exactly one runtime session. A new session needs a
        // new runApp; accepting a second activate would share registration state.
        if (runtimeSessionId) return;
        activationEpoch++;
        cancelLocaleRead?.();
        failedActivationMounts.clear();
        activationBarrier = activate(message, activationEpoch);
        return;
      case "locale.changed":
        locale.receive(message.runtimeSessionId, message.locale);
        return;
      case "environment.changed":
        if (!runtimeSessionId || message.runtimeSessionId !== runtimeSessionId) return;
        environmentRevision++;
        environmentSnapshot = { developerMode: message.developerMode === true };
        for (const handler of [...environmentHandlers]) handler({ ...environmentSnapshot });
        return;
      case "deactivate":
        void dispose();
        return;
      case "command.invoke": {
        if (queuedCommands.has(message.correlationId) || inflight.has(message.correlationId)) return;
        const epoch = activationEpoch;
        const token = {};
        queuedCommands.set(message.correlationId, token);
        void activationBarrier.then((result) => {
          if (queuedCommands.get(message.correlationId) !== token) return;
          queuedCommands.delete(message.correlationId);
          if (disposed || epoch !== activationEpoch) return;
          if (result.ok) return invokeCommand(message.correlationId, message.commandId, message.input, message.operation, message.completesOperation);
          if (result.error) wire.notify(NotifyMethod.CommandSettled, {
            correlationId: message.correlationId, ok: false, error: result.error,
          } satisfies CommandSettlement);
        });
        return;
      }
      case "command.cancel":
        if (queuedCommands.delete(message.correlationId)) wire.notify(NotifyMethod.CommandSettled, {
          correlationId: message.correlationId, ok: false,
          error: { code: "COMMAND_CANCELLED", userMessage: "Command cancelled", retryable: false },
        } satisfies CommandSettlement);
        inflight.get(message.correlationId)?.abort();
        inflight.delete(message.correlationId);
        for (const [id, correlation] of activeOperations) {
          if (correlation === message.correlationId) activeOperations.delete(id);
        }
        return;
      case "service.invoke": {
        if (queuedServices.has(message.correlationId) || serviceInflight.has(message.correlationId)) return;
        const rejection = serviceCancellations.admit(message);
        if (rejection) {
          // Host has already settled cancellations; duplicate delivery stays silent.
          if (rejection !== "SERVICE_CANCELLED") settleServiceError(
            message.correlationId, rejection,
            rejection === "SERVICE_BUSY" ? "Service cancellation queue is full" : "Service call is no longer valid",
          );
          return;
        }
        const epoch = activationEpoch;
        const token = {};
        serviceEnvelopes.set(message.correlationId, message);
        queuedServices.set(message.correlationId, token);
        void activationBarrier.then((result) => {
          if (queuedServices.get(message.correlationId) !== token) return;
          queuedServices.delete(message.correlationId);
          if (disposed || epoch !== activationEpoch) {
            serviceEnvelopes.delete(message.correlationId);
            return;
          }
          if (message.deadlineUnixMs !== undefined && message.deadlineUnixMs <= serviceCancellations.now()) {
            serviceEnvelopes.delete(message.correlationId);
            settleServiceError(message.correlationId, "SERVICE_TIMEOUT", "Service call timed out");
            return;
          }
          if (result.ok) return invokeService(
            message.correlationId, message.serviceId, message.method, message.input, message.caller, message.deadlineUnixMs,
          );
          serviceEnvelopes.delete(message.correlationId);
          if (result.error) wire.notify(NotifyMethod.ServiceSettled, {
            correlationId: message.correlationId, ok: false, error: result.error,
          } satisfies ServiceSettlement);
        });
        return;
      }
      case "service.cancel": {
        const known = serviceEnvelopes.get(message.correlationId);
        if (known && !sameServiceOwner(known, message)) return;
        // Legacy cancellation omissions are filled from the original invoke only.
        serviceCancellations.cancel(known ?? message);
        serviceEnvelopes.delete(message.correlationId);
        const queued = queuedServices.delete(message.correlationId);
        const controller = serviceInflight.get(message.correlationId);
        if (queued || (controller && !controller.signal.aborted)) {
          // 先占终态再 abort，handler 的同步 abort 回调也不能再发成功。
          settleServiceError(message.correlationId, "SERVICE_CANCELLED", "Service call cancelled");
          controller?.abort();
        }
        return;
      }
      case "surface.presentation": {
        if (!runtimeSessionId || message.runtimeSessionId !== runtimeSessionId || endedPresentationMounts.has(message.surfaceMountId) || ![message.runtimeSessionId, message.surfaceMountId, message.presentationToken].every(v => typeof v === "string" && /^[\x21-\x7e]{1,128}$/.test(v))) return;
        if (!presentations.has(message.surfaceMountId) && presentations.size >= 16) return;
        const previous = presentations.get(message.surfaceMountId);
        if (previous?.presentationToken === message.presentationToken && previous.runtimeSessionId === message.runtimeSessionId) return;
        preparingOpens.delete(message.surfaceMountId);
        retireOpenReceipts(owner => owner.mount === message.surfaceMountId);
        const binding = { runtimeSessionId: message.runtimeSessionId, surfaceMountId: message.surfaceMountId, presentationToken: message.presentationToken };
        presentations.set(message.surfaceMountId, binding);
        const state = mounts.get(message.surfaceMountId);
        if (state) for (const listener of [...state.presentationHandlers]) {
          // A callback can unmount, replace the binding or unsubscribe another callback.
          if (disposed || mounts.get(message.surfaceMountId) !== state || presentations.get(message.surfaceMountId) !== binding) break;
          if (state.presentationHandlers.has(listener)) listener();
        }
        return;
      }
      case "surface.escape.request":
        escape.handleRequest(message);
        return;
      case "surface.escape.hostLayer":
        escape.handleHostLayer(message);
        return;
      case "surface.mount": {
        if (queuedMounts.has(message.surfaceMountId) || mounts.has(message.surfaceMountId)) return;
        const epoch = activationEpoch;
        const token: { pendingIntent?: unknown } = {};
        queuedMounts.set(message.surfaceMountId, token);
        void activationBarrier.then((result) => {
          if (queuedMounts.get(message.surfaceMountId) !== token) return;
          queuedMounts.delete(message.surfaceMountId);
          if (disposed || epoch !== activationEpoch) return;
          if (result.ok) return mountSurface(message, token.pendingIntent);
          // ActivateFailed alone does not release the Host ready waiter.
          if (result.error && !failedActivationMounts.has(message.surfaceMountId)) {
            failedActivationMounts.add(message.surfaceMountId);
            wire.notify(NotifyMethod.SurfaceFailed, { surfaceMountId: message.surfaceMountId, error: result.error });
          }
        });
        return;
      }
      case "surface.unmount":
        queuedMounts.delete(message.surfaceMountId);
        unmountSurface(message.surfaceMountId);
        return;
      case "layers.changed": {
        if (message.version !== 1 || message.runtimeSessionId !== runtimeSessionId || !mounts.has(message.surfaceMountId)) return;
        for (const handler of [...(layerHandlers[message.layer] ?? [])]) {
          try { handler(); } catch (error) { console.error("Layer change handler failed", error); }
        }
        return;
      }
      case "event": {
        // 会话身份校验：迟到/串台（旧会话）的事件直接丢，不进处理器。
        if (message.runtimeSessionId !== runtimeSessionId) return;
        const event: AppEvent = { eventType: message.eventType, payload: message.payload };
        for (const handler of [...eventHandlers]) handler(event);
        return;
      }
      case "codex.event": {
        if (message.runtimeSessionId !== runtimeSessionId) return;
        if (!mounts.has(message.surfaceMountId)) return;
        for (const handler of [...codexEventHandlers]) handler(message.event);
        return;
      }
      case "cloud.event": {
        // 与 codex.event 同一套两层身份校验：迟到 / 串台的事件直接丢，
        // 否则上一次会话的增量会写进这一次的界面。
        if (message.runtimeSessionId !== runtimeSessionId) return;
        if (!mounts.has(message.surfaceMountId)) return;
        const event = message.event as import("./cloud").CloudStreamEvent;
        for (const handler of [...cloudEventHandlers]) handler(event);
        return;
      }
      case "local.event": {
        // 与 cloud.event 同一套两层身份校验。
        if (message.runtimeSessionId !== runtimeSessionId) return;
        if (!mounts.has(message.surfaceMountId)) return;
        const event = message.event as import("./local-agent").LocalAgentEvent;
        for (const handler of [...localEventHandlers]) handler(event);
        return;
      }
      case "terminal.event": {
        if (message.runtimeSessionId !== runtimeSessionId) return;
        if (!mounts.has(message.surfaceMountId)) return;
        const event = message.event as import("./terminal-session").TerminalSessionEvent;
        for (const handler of [...terminalEventHandlers]) handler(event);
        return;
      }
      case "host.pending_overflow": {
        const event: AppEvent = {
          eventType: "host.pending_overflow",
          payload: { dropped: message.dropped },
        };
        for (const handler of [...eventHandlers]) handler(event);
        return;
      }
      case "surface.intent": {
        const queued = queuedMounts.get(message.surfaceMountId);
        if (queued) { queued.pendingIntent = message.intent; return; }
        const state = mounts.get(message.surfaceMountId);
        if (!state) return;
        registerOpenIntent(message.surfaceMountId, state, message.intent);
        // handler 还没注册（mount 进行中）→ 缓冲最近一条，注册时补发；
        // 已有 handler → 正常直达，不进缓冲。
        if (state.intentHandlers.size === 0) {
          state.pendingIntent = message.intent;
          return;
        }
        state.pendingIntent = undefined;
        for (const handler of [...state.intentHandlers]) handler(message.intent);
        return;
      }
    }
  };

  function dispose(): Promise<void> {
    if (disposePromise) return disposePromise;
    preparingOpens.clear();
    retireOpenReceipts(() => true);
    disposed = true;
    escape.uninstall();
    layerHandlers.tab.clear();
    layerHandlers.action.clear();
    environmentHandlers.clear();
    activationEpoch++;
    registrationOpen = false;
    cancelLocaleRead?.();
    locale.dispose();
    failedActivationMounts.clear();
    queuedMounts.clear();
    queuedCommands.clear();
    queuedServices.clear();
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    activeOperations.clear();
    for (const controller of serviceInflight.values()) controller.abort();
    serviceInflight.clear();
    serviceCancellations.clear();
    serviceEnvelopes.clear();
    for (const surfaceMountId of [...mounts.keys()]) unmountSurface(surfaceMountId);
    presentations.clear();
    endedPresentationMounts.clear();
    commands.clear();
    surfaces.clear();
    services.clear();
    eventHandlers.clear();
    codexEventHandlers.clear();
    cloudEventHandlers.clear();
    localEventHandlers.clear();
    terminalEventHandlers.clear();
    disposePromise = Promise.resolve().then(async () => {
      try {
        await definition.deactivate?.();
      } finally {
        unsubscribe?.();
        unsubscribe = undefined;
        escape.uninstall();
      }
    });
    return disposePromise;
  }

  // subscribe can synchronously flush a queued deactivate; all state and the
  // hoisted cleanup function must already exist when that happens.
  unsubscribe = wire.subscribe(handle);
  if (disposed) { unsubscribe(); unsubscribe = undefined; }
  else escape.install();

  return { dispose };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `http-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Windows 的插件资源也使用 HTTP origin；它们必须继续走 WebView 原生 fetch，不能被
 * 外部网络代理误接管。`reai-app.localhost` 只有当前 originId 路径算内部资源。
 */
export function isHostInternalUrl(input: RequestInfo | URL, baseUrl = globalThis.location?.href): boolean {
  if (!baseUrl) return false;
  let url: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(input instanceof Request ? input.url : input.toString(), base);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (url.hostname === "ipc.localhost") return true;
  if (url.hostname !== "reai-app.localhost") return false;
  if (url.origin !== base.origin || base.hostname !== "reai-app.localhost") return false;
  const originId = base.pathname.split("/").filter(Boolean)[0];
  return Boolean(originId) && (url.pathname === `/${originId}` || url.pathname.startsWith(`/${originId}/`));
}

const INLINE_BODY_BYTES = 512 * 1024;
const UPLOAD_CHUNK_BYTES = 256 * 1024;
const UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const UPLOAD_BODY_BYTES = 52 * 1024 * 1024;

function abortNetwork(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

function uploadTooLarge(): AppError {
  return new AppError({ code: "NETWORK_REQUEST_TOO_LARGE", userMessage: "文件或请求正文超过上传限额" });
}

/** 保留浏览器原生 multipart boundary；仅按有界 chunk 消费，不编码整份正文。 */
async function boundedNetworkBody(request: Request): Promise<Blob | undefined> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return undefined;
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener("abort", cancelReader, { once: true });
  try {
    for (;;) {
      abortNetwork(request.signal);
      const item = await reader.read();
      abortNetwork(request.signal);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > UPLOAD_BODY_BYTES) {
        await reader.cancel();
        throw uploadTooLarge();
      }
      chunks.push(item.value);
    }
    return new Blob(chunks);
  } finally {
    request.signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

export async function brokerFetch(
  bridge: HostBridge,
  input: RequestInfo | URL,
  init: AppHttpFetchOptions = {},
): Promise<Response> {
  const { endpointId, ...requestInit } = init;
  if (init.signal) abortNetwork(init.signal);
  // 检查原始 File 总量，避免超限文件先进入原生 multipart 序列化。
  if (typeof FormData !== "undefined" && init.body instanceof FormData) {
    let fileBytes = 0;
    let overheadBytes = 0;
    init.body.forEach((value, name) => {
      overheadBytes += new TextEncoder().encode(name).byteLength + 256;
      if (typeof value === "string") overheadBytes += new TextEncoder().encode(value).byteLength;
      else {
        fileBytes += value.size;
        overheadBytes += new TextEncoder().encode(value.name).byteLength + value.type.length;
      }
      if (fileBytes > UPLOAD_FILE_BYTES || overheadBytes > UPLOAD_BODY_BYTES - UPLOAD_FILE_BYTES) throw uploadTooLarge();
    });
  }
  const request = new Request(input, requestInit);
  abortNetwork(request.signal);
  const id = requestId();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  const cancel = () => {
    void bridge.request(RequestMethod.HttpCancel, { requestId: id }).catch(() => undefined);
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  let uploadStarted = false;
  try {
    const body = await boundedNetworkBody(request);
    abortNetwork(request.signal);
    const metadata = {
      requestId: id, url: request.url, ...(endpointId ? { endpointId } : {}),
      method: request.method, headers, redirect: request.redirect,
    };
    let result: BrokerResponse;
    if (body && body.size > INLINE_BODY_BYTES) {
      let opened: { uploadId: string };
      try {
        opened = await bridge.request(RequestMethod.HttpUploadStart, { ...metadata, bodyBytes: body.size });
      } catch (thrown) {
        if (typeof thrown === "object" && thrown !== null && "code" in thrown && thrown.code === "BRIDGE_UNKNOWN_METHOD") {
          throw new AppError({ code: "NETWORK_UPLOAD_UNSUPPORTED", userMessage: "当前应用版本不支持大文件上传，请升级应用" });
        }
        throw thrown;
      }
      uploadStarted = true;
      abortNetwork(request.signal);
      for (let offset = 0; offset < body.size; offset += UPLOAD_CHUNK_BYTES) {
        const bytes = new Uint8Array(await body.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer());
        abortNetwork(request.signal);
        await bridge.request(RequestMethod.HttpUploadChunk, { uploadId: opened.uploadId, offset, bodyBase64: encodeBase64(bytes) });
        abortNetwork(request.signal);
      }
      result = await bridge.request<BrokerResponse>(RequestMethod.HttpUploadFinish, { uploadId: opened.uploadId });
      uploadStarted = false;
    } else {
      const encoded = body === undefined ? undefined : encodeBase64(new Uint8Array(await body.arrayBuffer()));
      abortNetwork(request.signal);
      result = await bridge.request<BrokerResponse>(RequestMethod.HttpFetch, {
        ...metadata, ...(encoded === undefined ? {} : { bodyBase64: encoded }),
      });
    }
    abortNetwork(request.signal);
    const response = new Response(decodeBase64(result.bodyBase64), {
      status: result.status, statusText: result.statusText, headers: result.headers,
    });
    Object.defineProperty(response, "url", { value: result.url });
    return response;
  } catch (thrown) {
    if (uploadStarted) cancel();
    abortNetwork(request.signal);
    throw normalizeBridgeError(thrown);
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}

/** 安装全局 fetch 代理。Host 在 import 插件 entry 之前已经注入 Bridge。 */
export function installGlobalNetworkFetch(
  bridge: HostBridge = readInjectedBridge(),
  baseUrl = globalThis.location?.href,
): () => void {
  if (!nativeFetch) return () => undefined;
  const previous = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (isHostInternalUrl(input, baseUrl)) return nativeFetch(input, init);
    return brokerFetch(bridge, input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previous;
  };
}

// bootstrap 在模块求值前已注入 Bridge。此处比 `runApp` 更早，能覆盖插件依赖在
// module evaluation 阶段发出的 fetch；普通 Node 测试没有注入键，不修改全局。
if (nativeFetch && (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY]) {
  installGlobalNetworkFetch();
}

function readInjectedBridge(): HostBridge {
  const injected = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL_KEY];
  if (!injected) {
    throw new AppError({
      code: "app-sdk/BRIDGE_MISSING",
      userMessage: "扩展无法与主程序通信",
      retryable: false,
      cause: `全局 ${BRIDGE_GLOBAL_KEY} 不存在；App 只能由 Host 的 bootstrap 加载`,
    });
  }
  return injected as HostBridge;
}

/**
 * 把 Host 桥接错误（`{code, message}`）归一为 AppError 形状（`{code, userMessage}`）。
 *
 * Host 的 `BridgeError` 序列化是 `{code, message}`，而 `toWireError` 只认
 * `{code, userMessage}`——不归一的话，任何桥接拒绝（能力缺失 / ACL / 配额）
 * 经 `wire.request` 抛进 handler 的 catch，都会被兜底成「扩展遇到未处理的错误」，
 * 真实原因蒸发（M6 冒烟实测：「第二界面」拒绝就被误报成了这句）。
 */
export function normalizeBridgeError(thrown: unknown): unknown {
  if (typeof thrown !== "object" || thrown === null) return thrown;
  const candidate = thrown as Record<string, unknown>;
  // 已是 AppError 形状的透传（含插件自己打包了另一份 SDK 抛出的 AppError）。
  if (typeof candidate["userMessage"] === "string") return thrown;
  if (typeof candidate["code"] === "string" && typeof candidate["message"] === "string") {
    return { code: candidate["code"], userMessage: candidate["message"], retryable: false };
  }
  return thrown;
}

/** 在桥接出口统一套错误归一：一处改动覆盖全部 `wire.request` 拒绝。 */
function wrapBridgeErrors(bridge: HostBridge): HostBridge {
  return {
    request: <T>(
      method: Parameters<HostBridge["request"]>[0],
      params: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> =>
      bridge.request<T>(method, params, options).catch((thrown: unknown) => {
        throw normalizeBridgeError(thrown);
      }),
    notify: (method, params) => bridge.notify(method, params),
    subscribe: (handler) => bridge.subscribe(handler),
  };
}
