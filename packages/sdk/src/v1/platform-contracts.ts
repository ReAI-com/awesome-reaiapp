/** Frozen additive contracts. No AppContext methods, implementation, grant or user consent. */
import registry from "@reai/app-contract/platform-services-v1.json";
export const PLATFORM_CONTRACTS = registry;
export const PLATFORM_CONTRACT_LIMITS = registry.limits;
export type PlatformCapabilityId = keyof typeof registry.capabilities;
export interface PlatformCapabilitySnapshot {
  version: 1;
  capabilities: Partial<Record<PlatformCapabilityId, { version: 1; available: boolean; methods: readonly string[] }>>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/**
 * Methods added to a capability after its first Host release. A Host that predates one
 * still serves the rest of the capability; callers negotiate these per call with
 * `isPlatformMethodAvailable`.
 *
 * - `resources.roots.attach`：SDK 1.26.0-v105.1 / contract 1.25.3-v105.1（Driver 1.0.5 T21）追加，
 *   Host API 仍为 1.25.0；早于 T21 的 1.0.5 候选 Host 不广告它。
 */
export const PLATFORM_OPTIONAL_METHODS: ReadonlySet<string> = new Set(["resources.roots.attach"]);
/** Observational compatibility check only. Requery per activation; Host still authorizes every call. */
export function isPlatformCapabilityAvailable(snapshot: unknown, capability: string): boolean {
  if (!record(snapshot) || snapshot.version !== 1 || !record(snapshot.capabilities)) return false;
  if (!Object.prototype.hasOwnProperty.call(registry.capabilities, capability)) return false;
  if (!Object.prototype.hasOwnProperty.call(snapshot.capabilities, capability)) return false;
  const descriptor = snapshot.capabilities[capability];
  if (!record(descriptor) || descriptor.version !== 1 || descriptor.available !== true) return false;
  const methods = descriptor.methods;
  if (!Array.isArray(methods) || !methods.every((v: unknown) => typeof v === "string")) return false;
  return registry.capabilities[capability as PlatformCapabilityId].methods
    .every((method) => PLATFORM_OPTIONAL_METHODS.has(method) || methods.includes(method));
}
/** Capability available and this exact method advertised by the current Host. */
export function isPlatformMethodAvailable(snapshot: unknown, capability: string, method: string): boolean {
  if (!isPlatformCapabilityAvailable(snapshot, capability) || !record(snapshot) || !record(snapshot.capabilities)) return false;
  const descriptor = snapshot.capabilities[capability];
  return record(descriptor) && Array.isArray(descriptor.methods) && descriptor.methods.includes(method);
}
export interface ContractRequest { requestId: string }
/** Adapter injects; Host rederives and verifies. Never trust a caller-supplied account/app identity. */
export interface SurfaceBinding { runtimeSessionId: string; surfaceMountId: string; presentationToken: string }
export interface SurfaceRequest extends ContractRequest, SurfaceBinding {}
export interface NavigationCommand { commandId: string; input?: unknown }
export interface NavigationBreadcrumb { key: string; label: string; command?: NavigationCommand }
export interface NavigationMenuItem { key: string; label: string; command: NavigationCommand; disabled?: boolean }
export interface SurfaceNavigationRegistration extends SurfaceRequest {
  revision: number; breadcrumbs: readonly NavigationBreadcrumb[]; back?: NavigationCommand; menu?: readonly NavigationMenuItem[];
}
export interface SurfaceNavigationClient {
  register(input: SurfaceNavigationRegistration): Promise<{ accepted: true; revision: number }>;
  clear(input: SurfaceRequest & { revision: number }): Promise<void>;
}
/** Host issues once per keypress. Responder echoes binding + requestId before the deadline. */
export interface SurfaceEscapeRequest extends SurfaceRequest { type: "surface.escape.request"; deadlineUnixMs: number }
export interface SurfaceEscapeResponse extends SurfaceRequest { disposition: "consumed" | "pass" | "input-owned" }
export interface SurfaceEscapeClient { respond(input: SurfaceEscapeResponse): Promise<{ settled: true }> }

export type AudioRoutePolicy =
  | { kind: "board-first" } | { kind: "system-first" }
  | { kind: "manual"; source: "board-usb-hid" | "board-ble" | "board-uac" | "system-default" }
  | { kind: "manual"; source: "system-endpoint"; endpointId: string };
export interface AudioRouteSnapshot {
  policy: AudioRoutePolicy; source: "board-usb-hid" | "board-ble" | "board-uac" | "system" | "unavailable";
  epoch: string; fallbackReason?: "board-unavailable" | "system-unavailable"; gap: boolean;
  permission: "granted" | "required" | "denied" | "unavailable";
}
/** Response metadata only; no operation accepts an owner selected by the caller. */
export interface ContractOwner { appId: string; accountGeneration: string }
export interface AudioConsumerReceipt { consumerId: string; owner: ContractOwner; route: AudioRouteSnapshot }
export interface AudioCaptureClient {
  acquire(input: ContractRequest & { purpose: string }): Promise<AudioConsumerReceipt>;
  release(input: ContractRequest & { consumerId: string }): Promise<void>;
  status(input: ContractRequest & { consumerId: string }): Promise<AudioConsumerReceipt>;
}
export interface AudioRangeReceipt {
  rangeId: string; requestId: string; consumerId: string; epoch: string; requestedStartMs: number;
}
export interface AudioClipRef {
  version: 1; clipId: string; requestId: string; owner: ContractOwner; epoch: string;
  requestedStartMs: number; requestedEndMs: number; effectiveStartMs: number; effectiveEndMs: number;
  expiresAtMs: number; sizeBytes: number; sampleRate: 16000; channels: 1; format: "f32le";
}
export interface BoundedBytes { bodyBase64: string; offset: number; bytes: number; eof: boolean }
export interface AudioTranscriptionReceipt {
  jobId: string; clipId: string; state: "queued" | "running" | "complete" | "failed" | "cancelled";
  transcript?: string; errorCode?: PlatformContractErrorCode;
}
export interface AudioClipsClient {
  start(input: ContractRequest & { consumerId: string; startMs: number }): Promise<AudioRangeReceipt>;
  finish(input: ContractRequest & { rangeId: string; endMs: number }): Promise<AudioClipRef>;
  cancel(input: ContractRequest & { rangeId: string }): Promise<void>;
  read(input: ContractRequest & { clipId: string; offset: number; maxBytes: number }): Promise<BoundedBytes>;
  release(input: ContractRequest & { clipId: string }): Promise<void>;
  transcribe(input: ContractRequest & { clipId: string; idempotencyKey: string }): Promise<AudioTranscriptionReceipt>;
  transcriptionStatus(input: ContractRequest & { jobId: string }): Promise<AudioTranscriptionReceipt>;
}

export interface TaskSource extends ContractOwner { entityId: string }
export interface TaskReceipt { taskId: string; source: TaskSource; accepted: true }
export type TaskOutcome = "completed" | "failed" | "cancelled";
export interface ResultReceipt { resultId: string; panelToken: string; source: TaskSource; taskId?: string; deferred: boolean }
export interface TaskPresentationClient {
  present(input: ContractRequest & { entityId: string; title: string; detail?: string }): Promise<TaskReceipt>;
  progress(input: ContractRequest & { taskId: string; stage: string; detail?: string }): Promise<void>;
  finish(input: ContractRequest & { taskId: string; outcome: TaskOutcome; detail?: string }): Promise<void>;
  dismiss(input: ContractRequest & { taskId: string }): Promise<void>;
  conversationOpened(input: ContractRequest & { entityId: string }): Promise<{ acknowledged: true }>;
  presentResult(input: ContractRequest & { entityId: string; taskId?: string; title: string; body: string; deferred: boolean }): Promise<ResultReceipt>;
  continueResult(input: ContractRequest & { resultId: string; panelToken: string }): Promise<{ opened: true; acknowledged: true }>;
  dismissResult(input: ContractRequest & { resultId: string; panelToken: string }): Promise<{ acknowledged: boolean }>;
}

export type NotificationLevel = "off" | "in_app" | "system";
export interface NotificationSceneDeclaration {
  key: string; label: string; description: string; trigger: string; format: "text";
  defaultLevel: "in_app" | "system"; maxLevel: "in_app" | "system";
}
export interface NotificationPublishInput extends ContractRequest {
  sceneKey: string; requestedLevel: "in_app" | "system"; title: string; body: string; dedupeKey?: string;
  /** Owned Host-registered task only; not a caller-supplied appId, source, URL or action. */
  taskId?: string;
}
export interface NotificationPublishReceipt {
  notificationId: string | null; stored: boolean; requestedLevel: "in_app" | "system"; effectiveLevel: NotificationLevel;
  systemDelivery: "not-requested" | "queued" | "failed";
  reason?: "user-disabled" | "scene-limited" | "system-permission-required" | "system-permission-denied" | "system-unavailable" | "system-enqueue-failed" | "deduplicated";
}
export interface NotificationHistoryEntry {
  notificationId: string; source: ContractOwner; sceneKey: string; taskId?: string; title: string; body: string;
  requestedLevel: "in_app" | "system"; effectiveLevel: "in_app" | "system"; createdAtMs: number; readAtMs: number | null;
}
export interface NotificationHistoryPage { items: NotificationHistoryEntry[]; nextCursor: string | null }
export interface NotificationsV1Client {
  publish(input: NotificationPublishInput): Promise<NotificationPublishReceipt>;
  listHistory(input: ContractRequest & { cursor?: string; pageSize?: number }): Promise<NotificationHistoryPage>;
  markRead(input: ContractRequest & { notificationIds: string[] }): Promise<void>;
}

/** Locator only: no authority, actor, token, download URL, absolute path or OAuth scope. */
export type ResourceRef =
  | { version: 1; provider: "local"; workspaceId: string; relativePath: string }
  | { version: 1; provider: "cloud-project"; projectId: string; resourceId: string };
/** Opaque Host authorization-binding reference, not a bearer credential. Host rechecks on each operation. */
export interface AuthorizedResource { resource: ResourceRef; grantRef: string }
export interface ResourceStat {
  resource: ResourceRef; kind: "file" | "directory"; name: string; revision: string; sizeBytes: number; modifiedAtMs?: number;
}
export interface ResourcePage { items: ResourceStat[]; nextCursor: string | null }
export interface ResourceRoot { resource: AuthorizedResource; name: string }
export interface ResourceReadResult extends BoundedBytes { resource: ResourceRef; revision: string }
export interface ResourceMutation extends ContractRequest {
  target: AuthorizedResource; expectedRevision: string; idempotencyKey: string;
}
export interface ResourceTransferReceipt { transferId: string; expiresAtMs: number; maxChunkBytes: number; maxBytes: number }
export interface ResourceWriteCommit extends ResourceMutation { transferId: string; sha256: string }
export type ResourceCancelReceipt = { cancelled: true } | { cancelled: false; committed: ResourceStat };
export interface ResourceFilesClient {
  listRoots(input: ContractRequest): Promise<{ items: ResourceRoot[] }>;
  list(input: ContractRequest & { target: AuthorizedResource; cursor?: string; pageSize?: number }): Promise<ResourcePage>;
  stat(input: ContractRequest & { target: AuthorizedResource }): Promise<ResourceStat>;
  read(input: ContractRequest & { target: AuthorizedResource; expectedRevision: string; offset: number; maxBytes: number }): Promise<ResourceReadResult>;
  startWrite(input: ResourceMutation & { sizeBytes: number }): Promise<ResourceTransferReceipt>;
  writeChunk(input: ContractRequest & { transferId: string; offset: number; bodyBase64: string }): Promise<{ receivedBytes: number }>;
  commitWrite(input: ResourceWriteCommit): Promise<ResourceStat>;
  cancel(input: ContractRequest & { transferId: string }): Promise<ResourceCancelReceipt>;
  createFile(input: ResourceMutation & { name: string }): Promise<ResourceStat>;
  mkdir(input: ResourceMutation & { name: string }): Promise<ResourceStat>;
  rename(input: ResourceMutation & { name: string }): Promise<ResourceStat>;
  move(input: ResourceMutation & { destination: AuthorizedResource; expectedDestinationRevision: string; name: string }): Promise<ResourceStat>;
  delete(input: ResourceMutation): Promise<{ deleted: true }>;
}
/**
 * Host-owned root lifecycle (additive to the frozen ResourceFilesClient).
 * `pickRoot` opens the native folder panel for the visible Surface; the result is an
 * opaque AuthorizedResource, never an absolute path. `null` means the user cancelled.
 */
export interface ResourceRootsClient {
  pickRoot(input: ContractRequest): Promise<{ root: ResourceRoot | null }>;
  revokeRoot(input: ContractRequest & { grantRef: string }): Promise<{ revoked: true }>;
}
/**
 * Cloud Project root (v1.0.5 T21), kept separate so existing `ResourceRootsClient`
 * implementations stay valid. The plugin names a Project it found with its own OAuth
 * connection; the Host checks it with that identity and asks the user to confirm.
 * `null` means the user declined. Hosts before T21 reject with HOST_CAPABILITY_NOT_AVAILABLE.
 */
export interface ResourceCloudRootsClient {
  attachCloudProject(input: ContractRequest & { projectId: string }): Promise<{ root: ResourceRoot | null }>;
}

/** Candidate domain errors; only unavailable is returned before Host implementation. */
export const PLATFORM_CONTRACT_ERROR_CODES = [
  "HOST_CAPABILITY_NOT_AVAILABLE",
  "SURFACE_NAV_INVALID",
  "SURFACE_NAV_COMMAND_UNDECLARED",
  "SURFACE_SESSION_STALE",
  "ESC_REQUEST_STALE",
  "ESC_ALREADY_SETTLED",
  "AUDIO_NOT_GRANTED",
  "AUDIO_PERMISSION_REQUIRED",
  "AUDIO_PERMISSION_DENIED",
  "AUDIO_SOURCE_UNAVAILABLE",
  "AUDIO_CONSUMER_STALE",
  "AUDIO_RANGE_INVALID",
  "AUDIO_RANGE_UNAVAILABLE",
  "AUDIO_CLIP_NOT_FOUND",
  "AUDIO_CLIP_EXPIRED",
  "AUDIO_CLIP_FORBIDDEN",
  "AUDIO_QUEUE_FULL",
  "AUDIO_BUDGET_EXCEEDED",
  "AUDIO_CANCELLED",
  "TASK_NOT_GRANTED",
  "TASK_PERMISSION_REQUIRED",
  "TASK_PERMISSION_DENIED",
  "TASK_NOT_FOUND",
  "TASK_OWNER_MISMATCH",
  "TASK_SOURCE_STALE",
  "TASK_RESULT_STALE",
  "TASK_NAVIGATION_FAILED",
  "TASK_LIMIT_EXCEEDED",
  "TASK_INVALID_REQUEST",
  "NOTIFICATION_SCENE_UNDECLARED",
  "NOTIFICATION_PERMISSION_REQUIRED",
  "NOTIFICATION_PERMISSION_DENIED",
  "NOTIFICATION_SOURCE_STALE",
  "NOTIFICATION_HISTORY_UNAVAILABLE",
  "RESOURCE_UNAVAILABLE",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_NOT_AUTHORIZED",
  "RESOURCE_SCOPE_STALE",
  "RESOURCE_PATH_INVALID",
  "RESOURCE_REVISION_CONFLICT",
  "RESOURCE_ALREADY_EXISTS",
  "RESOURCE_IDEMPOTENCY_CONFLICT",
  "RESOURCE_LIMIT_EXCEEDED",
  "RESOURCE_TRANSFER_EXPIRED",
  "RESOURCE_CANCELLED",
  "RESOURCE_IO_FAILED",
  "RESOURCE_PROVIDER_MISMATCH"
] as const;
export type PlatformContractErrorCode = (typeof PLATFORM_CONTRACT_ERROR_CODES)[number];
