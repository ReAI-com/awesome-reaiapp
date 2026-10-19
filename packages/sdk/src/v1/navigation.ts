import { AppError } from "./errors";
import type { HostBridge } from "./protocol";
import type { SurfaceBinding, SurfaceNavigationRegistration } from "./platform-contracts";

/** Host injects request and presentation identities; callers provide only their path. */
export type SurfaceNavigationInput = Omit<SurfaceNavigationRegistration, "requestId" | keyof SurfaceBinding>;
export interface SurfaceNavigation {
  register(input: SurfaceNavigationInput): Promise<{ accepted: true; revision: number }>;
  clear(revision: number): Promise<void>;
}
const invalid = () => new AppError({ code: "SURFACE_NAV_INVALID", userMessage: "Invalid surface navigation", retryable: false });
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const text = (v: unknown, max: number) => typeof v === "string" && v.trim() === v && !!v && Array.from(v).length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(v);
function boundedJson(input: unknown): boolean {
  const ancestors = new Set<object>(); let nodes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > 8 || ++nodes > 8192) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (!value || typeof value !== "object" || ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    ancestors.add(value);
    const valid = Object.values(value).every(child => visit(child, depth + 1));
    ancestors.delete(value); return valid;
  };
  if (!visit(input, 1)) return false;
  try { return new TextEncoder().encode(JSON.stringify(input)).byteLength <= 8192; } catch { return false; }
}
const command = (v: unknown) => record(v) && keys(v, ["commandId", "input"]) && typeof v.commandId === "string" && /^[\x21-\x7e]{1,128}$/.test(v.commandId) && (v.input === undefined || boundedJson(v.input));
export const isNavigationRevision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function validateSurfaceNavigation(input: unknown): asserts input is SurfaceNavigationInput {
  if (!record(input) || !keys(input, ["revision", "breadcrumbs", "back", "menu"]) || !isNavigationRevision(input.revision) || !Array.isArray(input.breadcrumbs) || input.breadcrumbs.length < 1 || input.breadcrumbs.length > 8) throw invalid();
  const crumbs = input.breadcrumbs;
  const seen = new Set<string>();
  crumbs.forEach((crumb, i) => {
    if (!record(crumb) || !keys(crumb, ["key", "label", "command"]) || !text(crumb.key, 128) || !text(crumb.label, 80) || seen.has(crumb.key as string)) throw invalid();
    seen.add(crumb.key as string);
    if (i === crumbs.length - 1 ? crumb.command !== undefined : !command(crumb.command)) throw invalid();
  });
  if (input.back !== undefined && !command(input.back)) throw invalid();
  if (input.menu !== undefined) {
    if (!Array.isArray(input.menu) || input.menu.length > 16) throw invalid();
    const menus = new Set<string>();
    for (const item of input.menu) {
      if (!record(item) || !keys(item, ["key", "label", "command", "disabled"]) || !text(item.key, 128) || !text(item.label, 80) || !command(item.command) || (item.disabled !== undefined && typeof item.disabled !== "boolean") || menus.has(item.key as string)) throw invalid();
      menus.add(item.key as string);
    }
  }
}
/** Runtime-only adapter. The Host still rederives every field from its live ledger. */
export function createSurfaceNavigation(wire: HostBridge, binding: () => SurfaceBinding | undefined): SurfaceNavigation {
  const request = (revision: number) => {
    const current = binding();
    if (!current) throw new AppError({ code: "SURFACE_SESSION_STALE", userMessage: "Surface is no longer active", retryable: false });
    if (!isNavigationRevision(revision)) throw invalid();
    return { ...current, requestId: globalThis.crypto?.randomUUID?.() ?? `nav-${Date.now()}-${Math.random().toString(36).slice(2)}`, revision };
  };
  return {
    async register(input) { validateSurfaceNavigation(input); const payload = { ...input, ...request(input.revision) }; return wire.request("surface.navigation.register", payload); },
    async clear(revision) { await wire.request("surface.navigation.clear", request(revision)); },
  };
}
