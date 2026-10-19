import { expect, test } from "bun:test";
import { defineApp, runApp, type HostBridge, type HostMessage } from "../src/v1/index";
import {
  classifyPhysicalEscape,
  createSurfaceEscapeResponder,
  resolveEscapeRequest,
  type EscapeEnvironment,
} from "../src/v1/surface-escape";

/** Minimal element: `closest` matches when the element is tagged as an input owner. */
function el(name: string, inputOwner = false, parent?: any): any {
  const node: any = {
    name, parent, parentElement: parent, listeners: [] as Array<(e: any) => void>,
    closest(selector: string) {
      for (let cursor: any = node; cursor; cursor = cursor.parent) if (cursor.inputOwner && selector.includes("textarea")) return cursor;
      return null;
    },
  };
  node.inputOwner = inputOwner;
  return node;
}
function env(options: { active?: any; focus?: boolean; consumeAt?: any; now?: number } = {}) {
  const body = el("body");
  const replays: any[] = [];
  const keydown: Array<(e: any) => void> = [];
  const capture: Array<(e: any) => void> = [];
  const deferred: Array<() => void> = [];
  const value: EscapeEnvironment & { body: any; replays: any[]; press(e: any): void; flush(): void } = {
    body, replays,
    document: {
      activeElement: options.active ?? body,
      body,
      hasFocus: () => options.focus ?? false,
      contains: (node) => !!node && node !== null,
    },
    replay(target, marker) {
      replays.push({ target, marker });
      // Bubble: an element-level owner on the path consumes.
      for (let cursor: any = target; cursor; cursor = cursor.parent) if (cursor === options.consumeAt) return true;
      return false;
    },
    addKeydown(listener, isCapture) {
      const list = isCapture ? capture : keydown;
      list.push(listener); return () => list.splice(list.indexOf(listener), 1);
    },
    defer(callback) { deferred.push(callback); },
    now: () => options.now ?? 1_000,
    press(e) {
      e.preventDefault ??= () => { e.defaultPrevented = true; };
      e.stopImmediatePropagation ??= () => { e.stopped = true; };
      for (const listener of [...capture]) listener(e);
      if (!e.stopped) for (const listener of [...keydown]) listener(e);
    },
    flush() { while (deferred.length) deferred.shift()!(); },
  };
  return value;
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const key = (extra: Record<string, unknown> = {}) => ({ key: "Escape", defaultPrevented: false, ...extra });

test("physical Esc: IME/repeat/editor/PTY stay raw, consumed inner layers stop, otherwise forward", () => {
  const editor = el("textarea", true);
  expect(classifyPhysicalEscape(key({ isComposing: true }) as any, [])).toBe("input");
  expect(classifyPhysicalEscape(key({ keyCode: 229 }) as any, [])).toBe("input");
  expect(classifyPhysicalEscape(key({ repeat: true }) as any, [])).toBe("input");
  expect(classifyPhysicalEscape(key() as any, [el("xterm-row", true, el(".xterm", true))])).toBe("input");
  expect(classifyPhysicalEscape(key() as any, [editor])).toBe("input");
  expect(classifyPhysicalEscape(key({ defaultPrevented: true }) as any, [el("drawer")])).toBe("consumed");
  expect(classifyPhysicalEscape(key({ metaKey: true }) as any, [])).toBe("ignore");
  expect(classifyPhysicalEscape({ ...key(), __reaiSurfaceEscapeSynthetic: true } as any, [])).toBe("ignore");
  expect(classifyPhysicalEscape(key() as any, [el("button")])).toBe("forward");
});

test("Host request: focused input owns Esc; element-level inner layer consumes; otherwise pass", () => {
  const input = el("textarea", true);
  expect(resolveEscapeRequest(env({ active: input, focus: true }))).toBe("input-owned");
  // Unfocused document: a stale textarea selection is not an owner and is not replayed into,
  // but its containing drawer still receives the bubble (code-worker drawer + textarea).
  const drawer = el("drawer"); const draft = el("textarea", true, drawer);
  const unfocused = env({ active: draft, focus: false, consumeAt: drawer });
  expect(resolveEscapeRequest(unfocused)).toBe("consumed");
  expect(unfocused.replays[0].target).toBe(drawer);
  const loose = env({ active: input, focus: false });
  expect(resolveEscapeRequest(loose)).toBe("pass");
  expect(loose.replays[0].target).toBe(loose.body);
  // Voice delete-confirm layer: focus on the cancel button inside the layer.
  const layer = el("layer"); const cancel = el("cancel", false, layer);
  const withLayer = env({ active: cancel, consumeAt: layer });
  expect(resolveEscapeRequest(withLayer)).toBe("consumed");
  expect(withLayer.replays[0].target).toBe(cancel);
});

function responder(e: ReturnType<typeof env>, descriptor = { available: true }) {
  const responses: any[] = []; const ingresses: any[] = [];
  const bindings = new Map([["m", { runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p" }]]);
  const r = createSurfaceEscapeResponder({
    wire: { respond: async (input) => { responses.push(input); },
      ingress: (b, layer) => { ingresses.push(layer === undefined ? b : { ...b, hostLayer: layer }); } },
    env: () => e, binding: (id) => bindings.get(id), presented: () => bindings.get("m"),
    available: () => descriptor.available,
    ensure: async () => descriptor.available,
  });
  return { r, responses, ingresses, bindings, descriptor };
}
const request = (extra: Record<string, unknown> = {}) => ({ type: "surface.escape.request" as const, requestId: "main:1", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", deadlineUnixMs: 1_250, ...extra });

test("responder answers once per request; stale binding, late or replayed requests have no side effect", async () => {
  const e = env(); const { r, responses } = responder(e);
  r.handleRequest(request()); await settle();
  expect(responses).toEqual([{ requestId: "main:1", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", disposition: "pass" }]);
  r.handleRequest(request()); // duplicate delivery
  r.handleRequest(request({ requestId: "main:2", presentationToken: "old" }));
  r.handleRequest(request({ requestId: "main:3", deadlineUnixMs: 1_000 })); // queued past deadline
  r.handleRequest(request({ requestId: "main:4", surfaceMountId: "gone" })); await settle();
  expect(responses.length).toBe(1);
  expect(e.replays.length).toBe(1);
});

test("physical Esc forwards only after all plugin handlers ran and only when unconsumed", async () => {
  const e = env(); const { r, ingresses } = responder(e); r.install();
  const consumed: any = key(); e.press(consumed); consumed.defaultPrevented = true; // later listener prevents
  e.flush(); await settle(); expect(ingresses).toEqual([]);
  e.press(key({ target: el("button") })); e.flush(); await settle();
  expect(ingresses).toEqual([{ runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p" }]);
  r.uninstall(); e.press(key()); e.flush(); await settle(); expect(ingresses.length).toBe(1);
});

test("runtime routes surface.escape.request to the responder with live bindings only", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  let receive!: (message: HostMessage) => void;
  const bridge: HostBridge = {
    async request(method, params) { calls.push({ method, params }); return { settled: true } as never; },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { s.ready(); }); } }), bridge);
  receive({ type: "activate", runtimeSessionId: "rt" });
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p" });
  receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "m", root: {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  // No DOM in this runtime: the responder is inert and never answers or replays.
  receive({ ...request(), deadlineUnixMs: Date.now() + 250 });
  expect(calls.filter(c => c.method === "surface.escape.respond")).toEqual([]);
  await running.dispose();
});

test("Host overlay above an approved Surface takes the physical press before plugin layers", () => {
  const e = env(); const { r, ingresses } = responder(e); r.install();
  r.handleHostLayer({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: true, layer: 3 });
  let pluginSaw = false;
  const press: any = key({ target: el("drawer-button") });
  e.press(press); pluginSaw = !press.stopped; e.flush();
  expect(pluginSaw).toBe(false); expect(press.defaultPrevented).toBe(true);
  expect(ingresses).toEqual([{ runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", hostLayer: 3 }]);
  // IME / PTY keep raw Esc even with a Host overlay open.
  e.press(key({ isComposing: true })); e.press(key({ target: el("term", true) })); e.flush();
  expect(ingresses.length).toBe(1);
  // Stale presentation token or closed layer: back to normal plugin-first handling.
  r.handleHostLayer({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "old", open: false, layer: 9 });
  r.handleHostLayer({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: false, layer: 2 }); // reordered older
  const again: any = key(); e.press(again); expect(again.stopped).toBe(true); e.flush();
  r.handleHostLayer({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: false, layer: 4 });
  const normal: any = key(); e.press(normal); expect(normal.stopped).toBeUndefined();
  r.uninstall();
});

test("missing or unavailable Host descriptor fails closed on every Esc path", async () => {
  const e = env(); const { r, responses, ingresses, descriptor } = responder(e, { available: false }); r.install();
  r.handleRequest(request()); await settle(); expect(responses).toEqual([]); expect(e.replays).toEqual([]);
  e.press(key({ target: el("button") })); e.flush(); await settle(); expect(ingresses).toEqual([]);
  r.handleHostLayer({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: true, layer: 1 });
  const press: any = key(); e.press(press); expect(press.stopped).toBeUndefined(); e.flush(); expect(ingresses).toEqual([]);
  descriptor.available = true; r.handleRequest(request({ requestId: "main:2" })); await settle(); expect(responses.length).toBe(1);
  r.uninstall();
});

test("runtime fetches the real descriptor lazily on Esc activity, once per presentation", async () => {
  const calls: Array<{ method: string; params: any }> = [];
  let receive!: (message: HostMessage) => void;
  const descriptor = { runtimeSessionId: "rt", surfaceMountId: "m", platformCapabilities: { version: 1, capabilities: { "surface.escape@1": { version: 1, available: true, methods: ["surface.escape.respond"] } } } };
  const bridge: HostBridge = {
    async request(method, params) { calls.push({ method, params }); return (method === "environment.get" ? { surfaceEscape: descriptor } : { settled: true }) as never; },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const envCalls = () => calls.filter(c => c.method === "environment.get").length;
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { s.ready(); }); } }), bridge);
  receive({ type: "activate", runtimeSessionId: "rt" });
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p" });
  receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "m", root: {} });
  await settle();
  expect(envCalls()).toBe(0); // plain presentation never asks (legacy plugins see no new traffic)
  receive({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: true, layer: 1 });
  receive({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p", open: false, layer: 2 });
  await settle(); expect(envCalls()).toBe(1);
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p2" });
  receive({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p2", open: true, layer: 3 });
  await settle(); expect(envCalls()).toBe(2);
  await running.dispose();
});

test("a deferred press is never re-homed to a newer presentation", async () => {
  const e = env(); const { r, ingresses, bindings } = responder(e); r.install();
  e.press(key({ target: el("button") }));
  bindings.set("m", { runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p2" });
  e.flush(); await settle(); expect(ingresses).toEqual([]);
  r.uninstall();
});

test("unknown descriptor: the press only warms it (never waits), the next press forwards", async () => {
  const e = env(); const ingresses: any[] = []; let known = false; let ensures = 0;
  const bindingP = { runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p" };
  const r = createSurfaceEscapeResponder({
    wire: { respond: async () => {}, ingress: (b) => { ingresses.push(b); } },
    env: () => e, binding: () => bindingP, presented: () => bindingP,
    available: () => known, ensure: async () => { ensures++; known = true; return true; },
  });
  r.install();
  e.press(key({ target: el("button") })); e.flush(); await settle();
  expect(ingresses).toEqual([]); expect(ensures).toBe(1);
  e.press(key({ target: el("button") })); e.flush(); await settle();
  expect(ingresses).toEqual([bindingP]);
  r.uninstall();
});

test("runtime: a retired presentation can never overwrite the current descriptor cache", async () => {
  const calls: string[] = [];
  let receive!: (message: HostMessage) => void;
  let token = "p1";
  const bridge: HostBridge = {
    async request(method) { calls.push(method); return (method === "environment.get"
      ? { surfaceEscape: { runtimeSessionId: "rt", surfaceMountId: "m", platformCapabilities: { version: 1, capabilities: { "surface.escape@1": { version: 1, available: true, methods: ["surface.escape.respond"] } } } } }
      : { settled: true }) as never; },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { s.ready(); }); } }), bridge);
  receive({ type: "activate", runtimeSessionId: "rt" });
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: token });
  receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "m", root: {} });
  await settle();
  token = "p2";
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: token });
  // A late p1 host-layer message is rejected outright (stale binding) and fetches nothing.
  receive({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p1", open: true, layer: 1 });
  await settle(); expect(calls.filter(c => c === "environment.get").length).toBe(0);
  receive({ type: "surface.escape.hostLayer", runtimeSessionId: "rt", surfaceMountId: "m", presentationToken: "p2", open: true, layer: 2 });
  await settle(); expect(calls.filter(c => c === "environment.get").length).toBe(1);
  await running.dispose();
});
