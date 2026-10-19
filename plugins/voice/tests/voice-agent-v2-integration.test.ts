import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, AgentSessionClient, AgentTurnResult, AgentServiceEvent } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, COMMAND_AGENT_SESSION_LEDGER_KEY, DEFAULT_SETTINGS, type VoiceCommandHistoryItem } from "../src/data";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const ref = { sessionId: "agent2-voice-integration", turnId: "native-accepted-turn" };
const result: AgentTurnResult = { schemaVersion: 2, ...ref, runtime: "dsh", channel: "external-brain", status: "completed", text: "Weather answer", content: [{ type: "text", text: "Weather answer" }], usage: null, toolAttempts: [], failure: null };
const snapshot = { schemaVersion: 2 as const, ...ref, runtime: "dsh" as const, status: "running" as const, expired: false, result: null, createdAt: 1, updatedAt: 1 };
const events: AgentServiceEvent[] = [
  { schemaVersion: 2, ...ref, runtime: "dsh", type: "tool.start", sequence: 1, timestamp: 1, toolName: "web_search", callId: "web-1" },
  { schemaVersion: 2, ...ref, runtime: "dsh", type: "tool.end", sequence: 2, timestamp: 2, toolName: "web_search", callId: "web-1", isError: false },
];
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(await predicate()).toBeTrue();
}
async function setup(loseAcks = 0, replayEvents = events) {
  document.body.replaceChildren();
  let context!: AppContext;
  let submitted: Parameters<AgentSessionClient["startTurn"]>[0] | undefined;
  let finish!: (value: AgentTurnResult) => void;
  let terminal: AgentTurnResult | undefined;
  let waits = 0;
  let owned = true;
  let listUnavailable = false;
  const waiting: Array<(value: AgentTurnResult) => void> = [];
  const created: unknown[] = [], cancelled: unknown[] = [], legacyCalls: unknown[] = [], submissions: unknown[] = [];
  const dismissed: unknown[] = [];
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["agent2-voice-integration"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?agent-v2=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        Object.assign(ctx.agent, {
          createSession: async (config: unknown) => { created.push(config); return { schemaVersion: 2, ...ref, runtime: "dsh", backend: "dsh" }; },
          listSessions: async () => {
            if (listUnavailable) throw new Error("temporary list transport failure");
            return { sessions: created.length && owned ? [{ sessionId: ref.sessionId, runtime: "dsh", backend: "dsh", memory: "session", createdMs: 1, updatedMs: 1, stale: false }] : [] };
          },
          send: async (input: unknown) => { legacyCalls.push(input); throw new Error("new sessions must use v2"); },
          startTurn: async (input: Parameters<AgentSessionClient["startTurn"]>[0]) => {
            submitted = input;
            submissions.push(structuredClone(input));
            const history = await store.get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
            expect(history?.some(item => item.status === "running" && item.agentSessionId === ref.sessionId)).toBe(true);
            if (loseAcks-- > 0) throw new TypeError("simulated missing ACK");
            return snapshot;
          },
          events: async ({ afterSequence = 0 }: { afterSequence?: number }) => ({ ...snapshot, events: replayEvents.filter(event => event.sequence > afterSequence), gap: false, nextSequence: replayEvents.at(-1)?.sequence ?? 0 }),
          waitForTurn: async (input: unknown) => { expect(input).toEqual(ref); waits++; if (terminal) return terminal; return new Promise<AgentTurnResult>(resolve => {
            waiting.push(resolve); finish = value => { terminal = value; waiting.splice(0).forEach(done => done(value)); };
          }); },
          cancel: async (input: unknown) => { cancelled.push(input); return { cancelled: true }; },
        });
        Object.assign(ctx.voiceCommand, { dismissTask: async (id: unknown) => { dismissed.push(id); } });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  const history = async () => await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY) ?? [];
  return { host, created, cancelled, legacyCalls, submissions, dismissed, history, submitted: () => submitted, finish: (value: AgentTurnResult) => finish(value), ready: () => Boolean(finish), waits: () => waits, setOwned: (value: boolean) => { owned = value; }, setListUnavailable: (value: boolean) => { listUnavailable = value; } };
}

test("Voice new requests use v2, keep the UI identity and persist one replayed tool card with the real run ID", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    expect(f.created).toEqual([expect.objectContaining({ schemaVersion: 2, runtime: "auto", tools: expect.arrayContaining([{ ref: "web_search" }, { ref: "web_fetch" }]) })]);
    const taskId = f.submitted()!.idempotencyKey;
    expect(taskId).not.toBe(ref.turnId);
    f.finish(result);
    await until(async () => (await f.history()).some(item => item.id === taskId && item.status === "completed"));
    const item = (await f.history()).find(item => item.id === taskId)!;
    expect(item).toMatchObject({ id: taskId, runId: ref.turnId, agentSessionId: ref.sessionId, reply: "Weather answer" });
    const cards = item.messages?.map(message => message.card).filter(card => card?.kind === "tool-group");
    expect(cards).toEqual([expect.objectContaining({ kind: "tool-group", status: "completed", totalCalls: 1, calls: [expect.objectContaining({ callId: "web-1", status: "completed" })] })]);
    expect(f.legacyCalls).toHaveLength(0);
  } finally { await f.host.disable(); }
});

test("batched Host tool events display their real elapsed time, not replay delivery time", async () => {
  const start = 1790251000000;
  const f = await setup(0, events.map((event, index) => ({ ...event, timestamp: start + index * 290464 })));
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    f.finish(result);
    await until(async () => (await f.history()).some(item => item.status === "completed"));
    const item = (await f.history())[0]!;
    const card = item.messages?.find(message => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool card missing");
    expect(card.calls).toHaveLength(1);
    expect(card.calls[0]).toMatchObject({ callId: "web-1", durationMs: 290464, at: new Date(start).toISOString() });
    const { root } = await f.host.openSurface("main");
    root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root!.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root!);
    expect(root!.querySelector(".chat-status-call-duration")?.textContent).toBe("290.5s");
    expect(f.submissions).toHaveLength(1);
  } finally { await f.host.disable(); }
});

for (const withEvents of [false, true]) {
  test(`terminal tool timings survive failed turn recovery ${withEvents ? "and replace replay timing" : "without progress events"}`, async () => {
    const f = await setup(0, withEvents ? events : []);
    const attempts: AgentTurnResult["toolAttempts"] = [
      { callId: "web-1", toolName: "web_search", status: "completed", startedAt: 1790251000000, finishedAt: 1790251290464, durationMs: 290464 },
      { callId: "web-2", toolName: "web_fetch", status: "failed", startedAt: 1790251290500, finishedAt: 1790251293141, errorCode: "web_access_unavailable" },
    ];
    try {
      f.host.setNextVoiceCommandTranscript("weather question");
      await f.host.invokeCommand("com.reai.voice.command.agent");
      await f.host.invokeCommand("com.reai.voice.command.agent");
      await until(f.ready);
      await f.host.disable();
      f.finish({ ...result, status: "failed", text: null, content: [], toolAttempts: [...attempts].reverse(),
        failure: { kind: "engine", code: "AGENT_MODEL_BUDGET_EXCEEDED", message: "budget exhausted" } });
      await f.host.installAndEnable();
      await until(async () => (await f.history()).some(item => item.status === "failed"));
      const item = (await f.history())[0]!;
      const cards = item.messages?.map(message => message.card).filter(card => card?.kind === "tool-group");
      expect(cards).toHaveLength(1);
      const card = cards![0]!;
      if (card.kind !== "tool-group") throw new Error("tool card missing");
      expect(card).toMatchObject({ totalCalls: 2, failedCalls: 1 });
      expect(card.calls).toEqual([
        expect.objectContaining({ callId: "web-1", status: "completed", durationMs: 290464 }),
        expect.objectContaining({ callId: "web-2", status: "failed", durationMs: 2641 }),
      ]);
      const { root } = await f.host.openSurface("main");
      root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
      root!.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root!);
      expect(Array.from(root!.querySelectorAll(".chat-status-call-duration"), el => el.textContent)).toEqual(["290.5s", "2.6s"]);
      expect(f.submissions).toHaveLength(1);
      expect(f.cancelled).toHaveLength(0);
    } finally { await f.host.disable(); }
  });
}

test("终态账本补回的调用超过明细上限：没解决的失败留在明细里，工具组判红", async () => {
  const f = await setup(0, []);
  const at = 1790251000000;
  const attempts: AgentTurnResult["toolAttempts"] = [
    { callId: "read-1", toolName: "read", status: "failed", startedAt: at, finishedAt: at + 10, errorCode: "AGENT_TOOL_NOT_GRANTED" },
    ...Array.from({ length: 20 }, (_, index) => ({ callId: `grep-${index}`, toolName: "grep", status: "completed" as const,
      startedAt: at + 100 + index, finishedAt: at + 101 + index })),
  ];
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    f.finish({ ...result, toolAttempts: attempts });
    await until(async () => (await f.history()).some(item => item.status === "completed"));
    const card = (await f.history())[0]!.messages?.find(message => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool card missing");
    expect(card).toMatchObject({ status: "failed", totalCalls: 21, omittedCalls: 1 });
    expect(card.calls).toHaveLength(20);
    expect(card.calls[0]).toMatchObject({ callId: "read-1", status: "failed", errorCode: "AGENT_TOOL_NOT_GRANTED" });
  } finally { await f.host.disable(); }
});

test("终态账本：已记过但被明细上限裁掉的重试也补回，20 种工具全部重试成功后工具组完成", async () => {
  const at = 1790251000000;
  const tools = Array.from({ length: 20 }, (_, index) => `mcp.t${index}`);
  const replay = [0, 1].flatMap((round) => tools.flatMap((tool, index): AgentServiceEvent[] => {
    const sequence = (round * 20 + index) * 2 + 1, callId = `${tool}-${round}`, timestamp = at + round * 100 + index;
    return [{ ...events[0]!, toolName: tool, callId, sequence, timestamp } as AgentServiceEvent,
      { ...events[1]!, toolName: tool, callId, isError: round === 0, sequence: sequence + 1, timestamp } as AgentServiceEvent];
  }));
  const f = await setup(0, replay);
  const attempts: AgentTurnResult["toolAttempts"] = tools.flatMap((tool, index) => [
    { callId: `${tool}-0`, toolName: tool, status: "failed" as const, startedAt: at + index, finishedAt: at + index },
    { callId: `${tool}-1`, toolName: tool, status: "completed" as const, startedAt: at + 100 + index, finishedAt: at + 101 + index },
  ]);
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    f.finish({ ...result, toolAttempts: attempts });
    await until(async () => (await f.history()).some(item => item.status === "completed"));
    const card = (await f.history())[0]!.messages?.find(message => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool card missing");
    expect(card).toMatchObject({ status: "completed", totalCalls: 40, omittedCalls: 20 });
    expect(card.calls.map((call) => call.callId)).toEqual(tools.map((tool) => `${tool}-1`));
  } finally { await f.host.disable(); }
});

test("终态账本按时间纠正先后：被明细上限裁掉的较晚成功重试补回后，旧失败不再判红", async () => {
  const at = 1790251000000;
  // 进度到达顺序：重试成功 r-late 先到、较早的失败 r-early 后到；随后 20 次 grep 把 r-late 挤出明细。
  const plan: Array<[string, string, boolean, number]> = [["read", "r-late", false, at + 50], ["read", "r-early", true, at + 10],
    ...Array.from({ length: 20 }, (_, index): [string, string, boolean, number] => ["grep", `g-${index}`, false, at + 100 + index])];
  const replay = plan.flatMap(([tool, callId, isError, timestamp], index): AgentServiceEvent[] => [
    { ...events[0]!, toolName: tool, callId, sequence: index * 2 + 1, timestamp } as AgentServiceEvent,
    { ...events[1]!, toolName: tool, callId, isError, sequence: index * 2 + 2, timestamp: timestamp + 1 } as AgentServiceEvent,
  ]);
  const f = await setup(0, replay);
  const attempts: AgentTurnResult["toolAttempts"] = plan.map(([tool, callId, isError, timestamp]) =>
    ({ callId, toolName: tool, status: isError ? "failed" as const : "completed" as const, startedAt: timestamp, finishedAt: timestamp + 1 }));
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    f.finish({ ...result, toolAttempts: attempts });
    await until(async () => (await f.history()).some(item => item.status === "completed"));
    const card = (await f.history())[0]!.messages?.find(message => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool card missing");
    expect(card).toMatchObject({ status: "completed", totalCalls: 22, omittedCalls: 2 });
    expect(card.calls.find((call) => call.tool === "read")).toMatchObject({ callId: "r-late", status: "completed" });
  } finally { await f.host.disable(); }
});

test("missing or invalid Host timing remains unknown instead of displaying a fabricated zero", async () => {
  for (const times of [[undefined, undefined], [NaN, Infinity], [2000, 1000]]) {
    const replay = events.map((event, index) => ({ ...event, timestamp: times[index] })) as AgentServiceEvent[];
    const f = await setup(0, replay);
    try {
      f.host.setNextVoiceCommandTranscript("weather question");
      await f.host.invokeCommand("com.reai.voice.command.agent");
      await f.host.invokeCommand("com.reai.voice.command.agent");
      await until(f.ready);
      f.finish(result);
      await until(async () => (await f.history()).some(item => item.status === "completed"));
      const card = (await f.history())[0]!.messages?.find(message => message.card?.kind === "tool-group")?.card;
      if (card?.kind !== "tool-group") throw new Error("tool card missing");
      expect(card.calls[0]!.durationMs).toBeUndefined();
    } finally { await f.host.disable(); }
  }
});

test("unordered terminal attempts repair a replay gap without treating an older failure as the latest retry", async () => {
  const start = 1790251000000;
  // Only the successful retry is in the event page; the earlier failed call
  // must be recovered from the call-ID-sorted terminal summary.
  const f = await setup(0, events.map((event, index) => ({ ...event, toolName: "web_fetch", callId: "a-success", timestamp: index + 1 })));
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    f.finish({ ...result, toolAttempts: [
      { callId: "a-success", toolName: "web_fetch", status: "completed", startedAt: start + 4000, finishedAt: start + 6641, durationMs: 2641 },
      { callId: "z-failure", toolName: "web_fetch", status: "failed", startedAt: start, finishedAt: start + 2000, durationMs: 2000, errorCode: "web_access_unavailable" },
    ] });
    await until(async () => (await f.history()).some(item => item.status !== "running"));
    const item = (await f.history())[0]!;
    expect(item.status).toBe("completed");
    const card = item.messages?.find(message => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool card missing");
    expect(card).toMatchObject({ status: "completed", totalCalls: 2, failedCalls: 1 });
    expect(card.calls).toEqual([
      expect.objectContaining({ callId: "z-failure", status: "failed", durationMs: 2000 }),
      expect.objectContaining({ callId: "a-success", status: "completed", durationMs: 2641 }),
    ]);
    expect(f.submissions).toHaveLength(1);
  } finally { await f.host.disable(); }
});

test("leaving Voice for the browser keeps an admitted turn running; reopening recovers the real result without resubmission", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    const taskId = f.submitted()!.idempotencyKey;
    // Production destroys the Voice runtime when another plugin opens. This
    // dispatches the same deactivate envelope; actual disable/revoke is Host-owned.
    await f.host.disable();
    expect(f.cancelled).toEqual([]);
    expect((await f.history()).find(item => item.id === taskId)).toMatchObject({
      status: "running", runId: ref.turnId, agentSessionId: ref.sessionId,
    });
    f.finish(result); // the service completes while Voice has no Surface
    await f.host.installAndEnable();
    await until(async () => (await f.history()).some(item => item.id === taskId && item.status === "completed"));
    expect(f.submissions).toHaveLength(1);
    expect(f.created).toHaveLength(1);
    expect((await f.history()).find(item => item.id === taskId)).toMatchObject({
      runId: ref.turnId, agentSessionId: ref.sessionId, reply: "Weather answer",
    });
    expect(f.waits()).toBe(2);
  } finally { await f.host.disable(); }
});

test("a reopened running turn can still be explicitly stopped using the original native identity", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    const taskId = f.submitted()!.idempotencyKey;
    await f.host.disable();
    expect(f.cancelled).toEqual([]);
    await f.host.installAndEnable();
    await until(() => f.waits() === 2);
    const surface = await f.host.openSurface("main");
    const root = surface.root!;
    root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root);
    await until(() => !!root.querySelector(".chat-cancel"));
    root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
    await until(() => f.cancelled.length === 1);
    expect(f.cancelled).toEqual([ref]);
    f.finish(result); // a late success must not undo the user's Stop
    await until(async () => (await f.history()).some(item => item.id === taskId && item.status === "failed"));
    expect((await f.history()).find(item => item.id === taskId)).toMatchObject({ runId: ref.turnId, agentSessionId: ref.sessionId });
    expect((await f.history()).find(item => item.id === taskId)?.reply).toBeUndefined();
    expect(f.submissions).toHaveLength(1);
  } finally { await f.host.disable(); }
});

test("Host revocation while the Surface is absent is recovered as failure, with no new model request", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    const taskId = f.submitted()!.idempotencyKey;
    await f.host.disable();
    f.finish({ ...result, status: "cancelled", text: null, content: [], failure: { kind: "killed", code: "AGENT_CANCELLED", message: "revoked" } });
    await f.host.installAndEnable();
    await until(async () => (await f.history()).some(item => item.id === taskId && item.status === "failed"));
    expect(f.submissions).toHaveLength(1);
    expect(f.cancelled).toHaveLength(0); // revocation belongs to Host, not teardown
    expect((await f.history()).find(item => item.id === taskId)).toMatchObject({ runId: ref.turnId, agentSessionId: ref.sessionId });
    expect((await f.history()).find(item => item.id === taskId)?.reply).toBeUndefined();
  } finally { await f.host.disable(); }
});

test("reopening under another account never queries a saved turn that is not in its session list", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    await f.host.disable();
    f.finish(result);
    f.setOwned(false);
    await f.host.installAndEnable();
    expect(f.waits()).toBe(1);
    expect(f.submissions).toHaveLength(1);
    expect(f.cancelled).toHaveLength(0);
    expect((await f.history())[0]).toMatchObject({ status: "failed", errorCode: "AGENT_RESULT_UNAVAILABLE" });
    expect((await f.history())[0]?.reply).toBeUndefined();
  } finally { await f.host.disable(); }
});

test("temporary listing failure preserves the accepted identity and a later reopen retrieves it without another execution", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    await f.host.disable();
    f.finish(result);
    f.setListUnavailable(true);
    await f.host.installAndEnable();
    expect((await f.history())[0]).toMatchObject({ status: "running", runId: ref.turnId });
    expect(f.waits()).toBe(1);
    await f.host.disable();
    f.setListUnavailable(false);
    await f.host.installAndEnable();
    await until(async () => (await f.history())[0]?.status === "completed");
    expect(f.submissions).toHaveLength(1);
    expect(f.cancelled).toHaveLength(0);
  } finally { await f.host.disable(); }
});

test("a detached observer finishing cannot dismiss the durable task card", async () => {
  const f = await setup();
  try {
    f.host.setNextVoiceCommandTranscript("weather question");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(f.ready);
    await new Promise(resolve => setTimeout(resolve, 3100)); // Host task card is now shown.
    await f.host.disable();
    f.finish(result);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.dismissed).toEqual([]);
    expect((await f.history())[0]?.status).toBe("running");
  } finally { await f.host.disable(); }
});

test("activation reconciles v1 and v2 ownership together without deleting either visible history", async () => {
  let context!: AppContext;
  const lists: unknown[] = [], deletes: unknown[] = [];
  const saved = ["legacy-session", "agent2-existing"].map((sessionId, index) => ({ id: `history-${index}`, transcript: `question-${index}`, reply: `answer-${index}`, status: "completed", commandId: "voice.command.agent", agentSessionId: sessionId, createdAt: new Date().toISOString() }));
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["agent2-voice-integration"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?v2-history=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set(COMMAND_HISTORY_KEY, saved);
        await store.set(COMMAND_AGENT_SESSION_LEDGER_KEY, saved.map(item => ({ sessionId: item.agentSessionId, createdMs: 1 })));
        Object.assign(ctx.agent, {
          listSessions: async (options?: { schemaVersion: number }) => {
            lists.push(options);
            return { sessions: [{ sessionId: options?.schemaVersion === 2 ? "agent2-existing" : "legacy-session", backend: "dsh", memory: "session", createdMs: 1, updatedMs: 1, stale: false }] };
          },
          deleteSession: async (options: unknown) => { deletes.push(options); return { deleted: true }; },
        });
        return app.activate(ctx);
      } } };
    },
  });
  await host.installAndEnable();
  try {
    await until(() => lists.length === 2);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(lists).toEqual([undefined, { schemaVersion: 2 }]);
    expect(deletes).toHaveLength(0);
    const history = await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(history?.map(item => [item.agentSessionId, item.reply])).toEqual(saved.map(item => [item.agentSessionId, item.reply]));
    const ledger = await context.storage.private("voice-state").get<Array<{ sessionId: string }>>(COMMAND_AGENT_SESSION_LEDGER_KEY);
    expect(ledger?.map(item => item.sessionId)).toEqual(["legacy-session", "agent2-existing"]);
  } finally { await host.disable(); }
});


test("the existing failed record retries a lost admission with its original key and no new session", async () => {
  const f = await setup(2);
  try {
    f.host.setNextVoiceCommandTranscript("question with missing receipt");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await f.host.invokeCommand("com.reai.voice.command.agent");
    await until(async () => (await f.history()).some(item => item.errorCode === "AGENT_RECEIPT_UNKNOWN"));
    const original = (await f.history()).find(item => item.errorCode === "AGENT_RECEIPT_UNKNOWN")!;
    expect(original.agentRequestKey).toBe(original.id);
    const { root } = await f.host.openSurface("main");
    root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root!.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root!);
    const retry = root!.querySelector<HTMLButtonElement>(".chat-retry-request");
    expect(retry?.textContent).toBe("重试这次请求");
    retry!.click();
    await until(f.ready);
    expect(f.created).toHaveLength(1);
    expect(f.submissions).toHaveLength(3);
    expect(f.submissions[2]).toEqual(f.submissions[0]);
    f.finish(result);
    await until(async () => (await f.history()).some(item => item.status === "completed" && item.id !== original.id));
    expect((await f.history()).find(item => item.status === "completed"))
      .toMatchObject({ agentSessionId: ref.sessionId, runId: ref.turnId, reply: "Weather answer" });
  } finally { await f.host.disable(); }
});

/** Synthetic fixture waits for the actual asynchronous history/paint boundary. */
async function waitForConversationFixture(root: Element) {
 const end=Date.now()+2500; while(!root.querySelector(".main-body.chat-view,.main-body.translation-detail")&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(!!root.querySelector(".main-body.chat-view,.main-body.translation-detail")).toBeTrue();
}
