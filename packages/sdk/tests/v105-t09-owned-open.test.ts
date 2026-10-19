import { expect, test } from "bun:test";
import { runApp, type AppContext, type HostBridge, type HostMessage, type SurfaceHandle } from "../src/v1/index";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(descriptor: unknown = { version: 1, available: true, runtimeSessionId: "rt", surfaceMountId: "mt", presentationToken: "view-1" }) {
  let receive!: (message: HostMessage) => void;
  let context!: AppContext;
  let surface!: SurfaceHandle;
  const calls: Array<{ method: string; params: any }> = [];
  const events: string[] = [];
  const control = { descriptor, envReply: undefined as Promise<unknown> | undefined, prepareReply: undefined as Promise<unknown> | undefined, commitReply: undefined as Promise<unknown> | undefined };
  const bridge: HostBridge = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "environment.get") return (control.envReply ? await control.envReply : { ownedConversationOpen: control.descriptor }) as never;
      if ((params as any)?.phase === "prepare") { events.push("prepare"); return (control.prepareReply ? await control.prepareReply : { openToken: "opaque-open-1" }) as never; }
      if ((params as any)?.phase === "commit") { events.push("commit"); return (control.commitReply ? await control.commitReply : { acknowledged: true }) as never; }
      return {} as never;
    }, notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp({ activate(ctx) { context = ctx; ctx.surfaces.register("main", s => { surface = s; s.ready(); }); } }, bridge);
  receive({ type: "activate", runtimeSessionId: "rt" });
  receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mt", presentationToken: "view-1" });
  receive({ type: "surface.mount", surfaceMountId: "mt", surfaceId: "main", root: {} });
  return { control, calls, events, running, send: (message: HostMessage) => receive(message), get ctx() { return context; }, get surface() { return surface; } };
}

test("direct Agent open captures a receipt before rendering and commits exactly that receipt", async () => {
  for (const sessionId of ["agent2-session", "session-v1"]) {
    const f = fixture(); await tick();
    try {
      const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId });
      f.events.push("render");
      await f.ctx.agent.reportConversationOpened({ sessionId, receipt });
      expect(f.events).toEqual(["prepare", "render", "commit"]);
      const method = sessionId.startsWith("agent2-") ? "agent.v2.session.conversation-opened" : "agent.session.conversation-opened";
      expect(f.calls.filter(call => call.method === method)).toEqual([
        { method, params: { sessionId, phase: "prepare" } },
        { method, params: { sessionId, phase: "commit", openToken: receipt.openToken } },
      ]);
    } finally { await f.running.dispose(); }
  }
});

test("missing or unavailable private descriptor keeps legacy report but rejects owned prepare", async () => {
  for (const descriptor of [undefined, null, { version: 1, available: false }, { version: 2, available: true }]) {
    const f = fixture(descriptor); f.control.descriptor = descriptor; await tick();
    try {
      await expect(f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" })).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE" });
      expect(f.calls.some(call => call.params?.phase === "prepare")).toBe(false);
      await f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session" });
      expect(f.calls.at(-1)).toEqual({ method: "agent.v2.session.conversation-opened", params: { sessionId: "agent2-session" } });
    } finally { await f.running.dispose(); }
  }
});

test("a receipt cannot move to another session or replaced presentation", async () => {
  const f = fixture(); await tick();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-other", receipt })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    f.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mt", presentationToken: "view-2" });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    expect(f.events).toEqual(["prepare"]);
  } finally { await f.running.dispose(); }
});

test("cancelling a selected view sends the exact token and forbids a later commit", async () => {
  const f = fixture(); await tick();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" });
    await f.ctx.agent.cancelConversationOpen({ sessionId: "agent2-session", receipt });
    expect(f.calls.at(-1)?.params).toEqual({ sessionId: "agent2-session", phase: "cancel", openToken: receipt.openToken });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    expect(f.events).toEqual(["prepare"]);
  } finally { await f.running.dispose(); }
});

test("unmount during prepare or commit rejects late responses", async () => {
  for (const phase of ["prepare", "commit"] as const) {
    const f = fixture(); await tick();
    let resolve!: (reply: unknown) => void;
    try {
      const receipt = phase === "commit" ? await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" }) : undefined;
      const reply = new Promise<unknown>(r => { resolve = r; });
      if (phase === "prepare") f.control.prepareReply = reply; else f.control.commitReply = reply;
      const pending = phase === "prepare" ? f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" }) : f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", ...(receipt ? { receipt } : {}) });
      await tick();
      f.send({ type: "surface.unmount", surfaceMountId: "mt" });
      resolve(phase === "prepare" ? { openToken: "late-token" } : { acknowledged: true });
      await expect(pending).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    } finally { resolve?.({}); await f.running.dispose(); }
  }
});

test("durable commit failure retains the current receipt for an explicit same-view retry", async () => {
  const f = fixture(); await tick();
  try {
    const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-session" });
    f.control.commitReply = Promise.reject({ code: "NOTIFICATION_HISTORY_UNAVAILABLE", userMessage: "synthetic disk failure" });
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt })).rejects.toMatchObject({ code: "NOTIFICATION_HISTORY_UNAVAILABLE" });
    f.control.commitReply = undefined;
    await f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt });
    expect(f.events).toEqual(["prepare", "commit", "commit"]);
  } finally { await f.running.dispose(); }
});

test("actual Host intent is registered before its renderer callback and replacement retires the old receipt", async () => {
  const f = fixture(); await tick();
  try {
    let commit!: Promise<void>;
    f.surface.onIntent((intent: any) => { commit = f.ctx.agent.reportConversationOpened({ sessionId: intent.payload.entityId, receipt: { openToken: intent.payload.openToken } }); });
    f.send({ type: "surface.intent", surfaceMountId: "mt", intent: { source: "host.taskConversation", actionId: "open-conversation", deliveryId: "delivery-1", payload: { entityId: "agent2-session", openToken: "first-intent" } } });
    await commit;
    expect(f.calls.at(-1)?.params).toEqual({ sessionId: "agent2-session", phase: "commit", openToken: "first-intent" });
    f.send({ type: "surface.intent", surfaceMountId: "mt", intent: { source: "host.taskConversation", actionId: "open-conversation", deliveryId: "delivery-2", payload: { entityId: "agent2-session", openToken: "second-intent" } } });
    await commit;
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt: { openToken: "first-intent" } })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
  } finally { await f.running.dispose(); }
});

test("selecting another entity retires the previous current-view receipt before the next prepare", async () => {
  const f = fixture(); await tick();
  try {
    const first = await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-first" });
    f.control.prepareReply = Promise.resolve({ openToken: "second-open" });
    await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-second" });
    expect(f.calls.some(call => call.params?.phase === "cancel" && call.params.openToken === first.openToken)).toBe(true);
    await expect(f.ctx.agent.reportConversationOpened({ sessionId: "agent2-first", receipt: first })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    expect(f.events).toEqual(["prepare", "prepare"]);
  } finally { await f.running.dispose(); }
});

test("view replacement, unmount and dispose cancel the exact cached operation without legacy fallback", async () => {
  for (const exit of ["presentation", "unmount", "dispose"] as const) {
    const f = fixture(); await tick();
    try {
      const receipt = await f.ctx.agent.prepareConversationOpen({ sessionId: "session-v1" });
      if (exit === "presentation") f.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mt", presentationToken: "view-2" });
      else if (exit === "unmount") f.send({ type: "surface.unmount", surfaceMountId: "mt" });
      else await f.running.dispose();
      await tick();
      expect(f.calls.filter(call => call.params?.phase === "cancel").map(call => call.params)).toEqual([{ sessionId: "session-v1", phase: "cancel", openToken: receipt.openToken }]);
      await expect(f.ctx.agent.reportConversationOpened({ sessionId: "session-v1", receipt })).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
      expect(f.calls.some(call => call.method === "agent.session.conversation-opened" && call.params?.phase === undefined)).toBe(false);
    } finally { await f.running.dispose(); }
  }
});

test("a delayed prepare cannot replace a newer entity selection", async () => {
  const f = fixture(); await tick();
  let resolve!: (reply: unknown) => void;
  try {
    f.control.prepareReply = new Promise(r => { resolve = r; });
    const first = f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-first" });
    await tick();
    f.control.prepareReply = Promise.resolve({ openToken: "newer-open" });
    const newer = await f.ctx.agent.prepareConversationOpen({ sessionId: "agent2-newer" });
    resolve({ openToken: "older-late-open" });
    await expect(first).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    await f.ctx.agent.reportConversationOpened({ sessionId: "agent2-newer", receipt: newer });
    expect(f.calls.at(-1)?.params).toEqual({ sessionId: "agent2-newer", phase: "commit", openToken: "newer-open" });
  } finally { resolve?.({}); await f.running.dispose(); }
});

const neutralEnvironment = () => ({
  taskPresentation: { runtimeSessionId: "rt", surfaceMountId: "mt", platformCapabilities: {
    version: 1, capabilities: { "tasks.present@1": { version: 1, available: true,
      methods: ["tasks.present", "tasks.progress", "tasks.finish", "tasks.dismiss", "tasks.conversationOpened", "results.present", "results.continue", "results.dismiss"] } },
  } },
});
const openIntent = (token: string): HostMessage => ({ type: "surface.intent", surfaceMountId: "mt", intent: {
  source: "host.taskConversation", actionId: "open-conversation", deliveryId: token,
  payload: { entityId: "agent2-session", openToken: token },
} });

test("neutral opened preserves public input and injects the exact current Host-delivered token", async () => {
  const f = fixture(); await tick();
  try {
    f.control.envReply = Promise.resolve(neutralEnvironment());
    f.send(openIntent("captured-open"));
    const input = { requestId: "opened-1", entityId: "agent2-session" };
    await f.ctx.tasks.conversationOpened(input);
    expect(input).toEqual({ requestId: "opened-1", entityId: "agent2-session" });
    expect(f.calls.at(-1)).toEqual({ method: "tasks.conversationOpened", params: { ...input, openToken: "captured-open" } });
  } finally { await f.running.dispose(); }
});

test("neutral opened cannot borrow a newer intent arriving during its descriptor await", async () => {
  const f = fixture(); await tick();
  let resolve!: (reply: unknown) => void;
  try {
    f.send(openIntent("older-open"));
    f.control.envReply = new Promise(r => { resolve = r; });
    const pending = f.ctx.tasks.conversationOpened({ requestId: "opened-older", entityId: "agent2-session" });
    await tick();
    f.send(openIntent("newer-open"));
    resolve(neutralEnvironment());
    await expect(pending).rejects.toMatchObject({ code: "TASK_SOURCE_STALE" });
    expect(f.calls.some(call => call.method === "tasks.conversationOpened")).toBe(false);
  } finally { resolve?.(neutralEnvironment()); await f.running.dispose(); }
});

test("duplicate presentation and delivery preserve the same current operation", async () => {
  const f = fixture(); await tick();
  try {
    f.send(openIntent("same-open"));
    f.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mt", presentationToken: "view-1" });
    f.send(openIntent("same-open"));
    expect(f.calls.some(call => call.params?.phase === "cancel")).toBe(false);
    await f.ctx.agent.reportConversationOpened({ sessionId: "agent2-session", receipt: { openToken: "same-open" } });
    expect(f.calls.at(-1)?.params).toEqual({ sessionId: "agent2-session", phase: "commit", openToken: "same-open" });
  } finally { await f.running.dispose(); }
});
