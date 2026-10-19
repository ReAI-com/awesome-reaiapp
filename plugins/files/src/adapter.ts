import { PLATFORM_CONTRACT_LIMITS, type ResourceCloudRootsClient, type ResourceFilesClient, type ResourceRef, type ResourceRootsClient, type ResourceStat } from "@reai/app-sdk/v1";

export const FILE_LIMITS = PLATFORM_CONTRACT_LIMITS.resources;
/**
 * The Host `resources.files@1` surface as exposed by `ctx.resourceFiles`. Cloud Project
 * roots (T21) are optional: a client without `attachCloudProject` simply has no cloud entry.
 */
export type FilesClient = ResourceFilesClient & ResourceRootsClient & Partial<ResourceCloudRootsClient>;

export class FilesError extends Error {
  constructor(readonly code: string, readonly userMessage = "") { super(code); this.name = "FilesError"; }
}
export function fail(code: string): never { throw new FilesError(code); }
export function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "RESOURCE_IO_FAILED";
}
/** Host-provided user message (`AppError.userMessage`); never contains URLs or tokens. */
export function errorMessage(error: unknown): string {
  return error && typeof error === "object" && "userMessage" in error && typeof error.userMessage === "string" ? error.userMessage.slice(0, 200) : "";
}

/** Same rule as the Host (`files/cloud.rs::validate_uuid`): RFC 4122 variant, version 1–8. */
const UUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])/i;
/**
 * Accepts a bare Project ID or a pasted link that contains one, normalized to the canonical
 * lowercase form the Host requires. Returns null when the text holds no valid Project ID.
 */
export function parseProjectId(text: string): string | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > 2048) return null;
  const uuid = value.match(UUID);
  return uuid ? uuid[0].toLowerCase() : null;
}
export function integer(value: number, min: number, max: number = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("RESOURCE_LIMIT_EXCEEDED");
}
export function opaque(value: string): void {
  if (typeof value !== "string" || !/^[\x20-\x7e]{1,128}$/.test(value)) fail("RESOURCE_PATH_INVALID");
}
export function revision(value: string): void {
  opaque(value);
  if (["*", "absent", "null"].includes(value)) fail("RESOURCE_REVISION_CONFLICT");
}
export function validRef(value: ResourceRef): void {
  if (!value || value.version !== 1) fail("RESOURCE_PATH_INVALID");
  const allowed = value.provider === "local" ? ["version", "provider", "workspaceId", "relativePath"] : ["version", "provider", "projectId", "resourceId"];
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) fail("RESOURCE_PATH_INVALID");
  if (value.provider === "local") {
    opaque(value.workspaceId);
    const path = value.relativePath;
    if (typeof path !== "string" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[a-zA-Z]:/.test(path) || new TextEncoder().encode(path).byteLength > FILE_LIMITS.maxRelativePathBytes || (path !== "" && path.split("/").some((part) => !part || part === "." || part === ".."))) fail("RESOURCE_PATH_INVALID");
  } else if (value.provider === "cloud-project") {
    opaque(value.projectId); opaque(value.resourceId);
  } else fail("RESOURCE_PROVIDER_MISMATCH");
}
export function refKey(ref: ResourceRef): string {
  validRef(ref);
  return ref.provider === "local" ? JSON.stringify([ref.provider, ref.workspaceId, ref.relativePath]) : JSON.stringify([ref.provider, ref.projectId, ref.resourceId]);
}
export function validStat(value: ResourceStat): void {
  if (!value || (value.kind !== "file" && value.kind !== "directory") || typeof value.name !== "string" || new TextEncoder().encode(value.name).byteLength > FILE_LIMITS.maxNameBytes) fail("RESOURCE_IO_FAILED");
  validRef(value.resource); revision(value.revision); integer(value.sizeBytes, 0);
  if (value.modifiedAtMs !== undefined) integer(value.modifiedAtMs, 0);
}
/** Same rule as the Host provider: no separators, control characters, dot names or >255 bytes. */
export function validName(name: string): boolean {
  return typeof name === "string" && name.trim() === name && name !== "" && name !== "." && name !== ".."
    && !/[/\\\0]/.test(name) && ![...name].some((char) => /\p{Cc}/u.test(char))
    && new TextEncoder().encode(name).byteLength <= FILE_LIMITS.maxNameBytes;
}
export function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
/** Check encoded length before any decode or allocation, then check decoded bytes. */
export function decodeBytes(body: string, maxBytes: number): Uint8Array {
  integer(maxBytes, 0, FILE_LIMITS.maxReadBytes);
  if (typeof body !== "string") fail("RESOURCE_IO_FAILED");
  if (body.length > Math.ceil(maxBytes / 3) * 4) fail("RESOURCE_LIMIT_EXCEEDED");
  if (body.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) fail("RESOURCE_IO_FAILED");
  let decoded: string;
  try { decoded = atob(body); } catch { return fail("RESOURCE_IO_FAILED"); }
  if (decoded.length > maxBytes) fail("RESOURCE_LIMIT_EXCEEDED");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}
/** "a.txt" -> "a (2).txt"; directories and dotfiles keep the suffix at the end. */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/**
 * Host cloud provider messages (driver-v2 `files/cloud_provider.rs::map_error`). The frozen
 * `RESOURCE_*` code alone cannot tell "service not open yet" from "route missing" or
 * "plugin has no cloud connection", so the Host message refines it. Local errors never match.
 */
export const CLOUD_HOST_MESSAGES = {
  notOpen: "云文件服务尚未开放",
  routeMissing: "后台未提供该接口",
  loginTemporary: "插件的云端登录暂不可用",
  service: "云文件服务",
  notConnected: "插件尚未连接自己的云端账号",
  project: "云项目",
  outcomeUnknown: "云端是否已生效未知",
  unreachable: "无法连接云文件服务",
} as const;
export function cloudErrorCode(code: string, message: string): string | null {
  const m = CLOUD_HOST_MESSAGES;
  if (!message) return null;
  if (code === "RESOURCE_UNAVAILABLE") {
    if (message.includes(m.notOpen)) return "CLOUD_NOT_OPEN";
    if (message.includes(m.routeMissing)) return "CLOUD_ROUTE_MISSING";
    if (message.includes(m.loginTemporary)) return "CLOUD_LOGIN_TEMPORARY";
    if (message.includes(m.service)) return "CLOUD_UNAVAILABLE";
  }
  if (code === "RESOURCE_NOT_AUTHORIZED") {
    if (message.includes(m.notConnected)) return "CLOUD_NOT_CONNECTED";
    if (message.includes(m.project)) return "CLOUD_NOT_AUTHORIZED";
  }
  if (code === "RESOURCE_CANCELLED" && message.includes(m.outcomeUnknown)) return "CLOUD_OUTCOME_UNKNOWN";
  if (code === "RESOURCE_IO_FAILED") {
    if (message.includes(m.unreachable)) return "CLOUD_UNREACHABLE";
    if (message.includes(m.service)) return "CLOUD_IO_FAILED";
  }
  return null;
}
