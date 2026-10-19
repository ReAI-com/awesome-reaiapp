/**
 * `surface.escape@1` responder that runs inside the Host-injected SDK runtime.
 *
 * Plugins do not call anything: an Escape keydown handler that closes an inner
 * layer simply calls `event.preventDefault()`. The runtime then
 *  - answers Host requests (Esc pressed in another realm) by replaying one
 *    synthetic Escape on the plugin's active target, and
 *  - reports physical Escapes the plugin did not consume as an untrusted
 *    "go back one layer" intent (Host rechecks declaration, grant and binding).
 * Without an approved `surface.escape@1` the Host neither sends requests nor
 * accepts reports, so legacy plugins behave exactly as before.
 */
import type { SurfaceBinding, SurfaceEscapeResponse } from "./platform-contracts";

/** Private runtime → Host method; intentionally not part of the public method tables. */
export const SURFACE_ESCAPE_INGRESS = "surface.escape.ingress";
export const SURFACE_ESCAPE_RESPOND = "surface.escape.respond";
const SYNTHETIC = "__reaiSurfaceEscapeSynthetic";
const INPUT_OWNER =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm, [data-escape-owner="input"]';

interface ElementLike { closest?(selector: string): unknown; parentElement?: unknown }
interface EscapeKeyEvent {
  key: string; defaultPrevented: boolean; isComposing?: boolean; keyCode?: number; repeat?: boolean;
  metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
  target?: unknown; composedPath?: () => unknown[];
  preventDefault?(): void; stopImmediatePropagation?(): void;
}
export interface EscapeDocument {
  activeElement: unknown;
  body: unknown;
  hasFocus(): boolean;
  contains(node: unknown): boolean;
}
export interface EscapeEnvironment {
  document: EscapeDocument;
  /** Dispatch one cancelable, bubbling Escape keydown; return whether it was default-prevented. */
  replay(target: unknown, marker: string): boolean;
  /** `capture`: window capture phase (runs before the plugin's own handlers). */
  addKeydown(listener: (event: EscapeKeyEvent) => void, capture?: boolean): () => void;
  /** Any user activity in this document (pointer down / focus in): used to warm the descriptor. */
  addActivity?(listener: () => void): () => void;
  defer(callback: () => void): void;
  now(): number;
}
export interface EscapeRequestMessage {
  type: "surface.escape.request"; requestId: string; runtimeSessionId: string;
  surfaceMountId: string; presentationToken: string; deadlineUnixMs: number;
}
export interface EscapeHostLayerMessage {
  type: "surface.escape.hostLayer"; runtimeSessionId: string; surfaceMountId: string; presentationToken: string; open: boolean; layer: number;
}
export interface EscapeWire {
  respond(input: SurfaceEscapeResponse): Promise<unknown>;
  /** `hostLayer`: the Host overlay layer id this press was handed to (capture path only). */
  ingress(binding: SurfaceBinding, hostLayer?: number): void;
}

const opaque = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
function inputOwned(node: unknown): boolean {
  const element = node as ElementLike | null;
  return !!element && typeof element.closest === "function" && !!element.closest(INPUT_OWNER);
}

/** Classify a physical keydown after the plugin's own handlers have all run. */
export function classifyPhysicalEscape(event: EscapeKeyEvent, path: unknown[]): "ignore" | "consumed" | "input" | "forward" {
  if (event.key !== "Escape" || (event as unknown as Record<string, unknown>)[SYNTHETIC] === true) return "ignore";
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return "ignore";
  if (event.isComposing || event.keyCode === 229 || event.repeat) return "input";
  if (event.defaultPrevented) return "consumed";
  if (path.some(inputOwned)) return "input";
  return "forward";
}

/** Decide one Host request: IME/editor/PTY first, otherwise replay to the innermost layer. */
export function resolveEscapeRequest(env: EscapeEnvironment): SurfaceEscapeResponse["disposition"] {
  const doc = env.document;
  const active = doc.activeElement;
  const ownsKeyboard = (() => { try { return doc.hasFocus(); } catch { return false; } })();
  if (ownsKeyboard && inputOwned(active)) return "input-owned";
  // Without keyboard focus a stale input selection is not an owner and its own key
  // handling must not run, but its containers (drawer/overlay) still get the bubble.
  const inside = active && active !== doc.body && doc.contains(active) ? active : null;
  const parent = inside ? (inside as ElementLike).parentElement : null;
  const target = inside && !inputOwned(inside) ? inside : parent && doc.contains(parent) ? parent : doc.body;
  if (!target) return "pass";
  try { return env.replay(target, SYNTHETIC) ? "consumed" : "pass"; } catch { return "pass"; }
}

export function createSurfaceEscapeResponder(options: {
  wire: EscapeWire;
  env: () => EscapeEnvironment | undefined;
  /** Current live binding for a mount, or undefined once retired. */
  binding(surfaceMountId: string): SurfaceBinding | undefined;
  /** The single presented mount in this WebView, if any. */
  presented(): SurfaceBinding | undefined;
  /** Cached answer of the Host's real per-presentation descriptor (fail closed if unknown). */
  available(binding: SurfaceBinding): boolean;
  /** Fetch (once per presentation) the Host's real descriptor; only Esc activity triggers it. */
  ensure(binding: SurfaceBinding): Promise<boolean>;
}) {
  const answered = new Set<string>();
  const hostLayers = new Map<string, { token: string; layer: number; open: boolean }>();
  let removeKeydown: (() => void) | undefined;
  let removeCapture: (() => void) | undefined;
  let removeActivity: (() => void) | undefined;
  const warm = () => { const binding = options.presented(); if (binding) void options.ensure(binding).catch(() => {}); };
  return {
    install() {
      const env = options.env();
      if (!env || removeKeydown) return;
      // Host overlay above this Surface (passive overlays do not take focus): the
      // physical press belongs to it before any plugin inner layer. IME/editor/PTY
      // still keep their raw Esc.
      removeCapture = env.addKeydown((event) => {
        const binding = options.presented();
        const layer = binding && hostLayers.get(binding.surfaceMountId);
        if (!binding || !layer?.open || layer.token !== binding.presentationToken || !options.available(binding)) return;
        const path = event.composedPath?.() ?? [event.target];
        if (classifyPhysicalEscape(event, path) !== "forward") return;
        event.preventDefault?.();
        event.stopImmediatePropagation?.();
        // Host acts only if this exact layer is still its top overlay.
        options.wire.ingress({ ...binding }, layer.layer);
      }, true);
      // Warm on any key or pointer activity so the first Esc already has an answer.
      removeActivity = env.addActivity?.(warm);
      removeKeydown = env.addKeydown((event) => {
        // composedPath() is empty after dispatch, so capture it now and decide after
        // every plugin listener (any phase, any registration order) has run.
        const path = event.composedPath?.() ?? [event.target];
        // Bind the press to the presentation that received it; never re-home it.
        const pressed = options.presented();
        if (!pressed) return;
        // Decide synchronously from the cached descriptor: never wait (a Host layer could
        // open meanwhile). Unknown → warm it and let this one press go (fail closed).
        const known = options.available(pressed);
        if (!known) void options.ensure(pressed).catch(() => {});
        env.defer(() => {
          if (!known || classifyPhysicalEscape(event, path) !== "forward") return;
          const binding = options.presented();
          if (!binding || binding.runtimeSessionId !== pressed.runtimeSessionId || binding.surfaceMountId !== pressed.surfaceMountId
            || binding.presentationToken !== pressed.presentationToken) return;
          options.wire.ingress({ ...binding });
        });
      });
    },
    uninstall() {
      removeKeydown?.(); removeKeydown = undefined; removeCapture?.(); removeCapture = undefined;
      removeActivity?.(); removeActivity = undefined;
      answered.clear(); hostLayers.clear();
    },
    handleHostLayer(message: EscapeHostLayerMessage) {
      if (![message.runtimeSessionId, message.surfaceMountId, message.presentationToken].every(opaque)) return;
      const binding = options.binding(message.surfaceMountId);
      if (!binding || binding.runtimeSessionId !== message.runtimeSessionId || binding.presentationToken !== message.presentationToken) return;
      if (typeof message.open !== "boolean" || !Number.isSafeInteger(message.layer) || message.layer < 0) return;
      const previous = hostLayers.get(message.surfaceMountId);
      // Messages can be reordered: an older layer id never overrides a newer one.
      if (previous && previous.token === message.presentationToken && previous.layer >= message.layer) return;
      hostLayers.set(message.surfaceMountId, { token: message.presentationToken, layer: message.layer, open: message.open });
      // Warm the descriptor so the synchronous capture path can decide on the next press.
      void options.ensure(binding).catch(() => {});
    },
    handleRequest(message: EscapeRequestMessage) {
      const env = options.env();
      if (!env || ![message.requestId, message.runtimeSessionId, message.surfaceMountId, message.presentationToken].every(opaque)
        || typeof message.deadlineUnixMs !== "number" || !Number.isFinite(message.deadlineUnixMs)) return;
      const bound = options.binding(message.surfaceMountId);
      if (!bound || bound.runtimeSessionId !== message.runtimeSessionId || bound.presentationToken !== message.presentationToken) return;
      // A queued/replayed request past its deadline must not close anything.
      if (!(env.now() < message.deadlineUnixMs) || answered.has(message.requestId)) return;
      answered.add(message.requestId);
      if (answered.size > 64) answered.delete(answered.values().next().value!);
      void options.ensure(bound).then((ok) => {
        // Re-check after the (first-use) descriptor fetch: still live, still in time.
        const binding = options.binding(message.surfaceMountId);
        if (!ok || !binding || binding.presentationToken !== message.presentationToken || !(env.now() < message.deadlineUnixMs)) return;
        const disposition = resolveEscapeRequest(env);
        void options.wire.respond({ requestId: message.requestId, ...binding, disposition }).catch(() => {});
      }, () => {});
    },
  };
}

/** Browser bindings for the injected runtime; absent outside a DOM (tests, workers). */
export function browserEscapeEnvironment(): EscapeEnvironment | undefined {
  const g = globalThis as unknown as {
    document?: Document; addEventListener?: Window["addEventListener"]; removeEventListener?: Window["removeEventListener"];
    KeyboardEvent?: typeof KeyboardEvent;
  };
  if (!g.document || typeof g.addEventListener !== "function" || typeof g.KeyboardEvent !== "function") return undefined;
  const doc = g.document;
  return {
    document: doc,
    replay(target, marker) {
      const event = new g.KeyboardEvent!("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, marker, { value: true });
      (target as EventTarget).dispatchEvent(event);
      return event.defaultPrevented;
    },
    addKeydown(listener, capture = false) {
      const handler = (event: Event) => listener(event as unknown as EscapeKeyEvent);
      g.addEventListener!("keydown", handler, capture);
      return () => g.removeEventListener!("keydown", handler, capture);
    },
    addActivity(listener) {
      const handler = () => listener();
      for (const type of ["pointerdown", "focusin", "keydown"]) g.addEventListener!(type, handler, true);
      return () => { for (const type of ["pointerdown", "focusin", "keydown"]) g.removeEventListener!(type, handler, true); };
    },
    defer(callback) { setTimeout(callback, 0); },
    now: () => Date.now(),
  };
}
