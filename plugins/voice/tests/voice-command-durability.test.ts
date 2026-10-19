import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, AgentSendResult, AgentSessionClient, KeyValueStore } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import {
  COMMAND_HISTORY_KEY,
  DEFAULT_SETTINGS,
  VoiceStateRepository,
  type VoiceCommandHistoryItem,
} from "../src/data";
import { t } from "../src/voice-i18n";
import { commandMessages } from "../src/voice-chat-detail";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

function storeWith(values: Record<string, unknown> = {}): KeyValueStore {
  const data = new Map(Object.entries(values));
  return {
    async compareAndSet(key, expected, value) {
      if (data.has(key) !== (expected !== undefined)
        || (data.has(key) && JSON.stringify(data.get(key)) !== JSON.stringify(expected))) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async keys() { return [...data.keys()]; },
  };
}

const started: VoiceCommandHistoryItem = {
  id: "durable-task", transcript: "weather tomorrow", commandId: "voice.command.agent",
  status: "running", createdAt: "2026-09-23T07:00:00.000Z",
  messages: [{ from: "user", text: "weather tomorrow", at: "2026-09-23T07:00:00.000Z" }],
};

test("running command survives owner loss and next activation recovers it as interrupted", async () => {
  const store = storeWith();
  const owner = new VoiceStateRepository(store);
  await owner.beginCommandHistory(started);
  await owner.attachCommandAgentSession(started.id, "owned-session");

  const nextOwner = new VoiceStateRepository(store);
  const recovered = await nextOwner.recoverInterruptedCommandHistory();
  const item = recovered.find((entry) => entry.id === started.id)!;
  expect(item).toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED", agentSessionId: "owned-session" });
  expect(item.userMessage?.length).toBeGreaterThan(0);
  expect(commandMessages([item]).at(-1)?.from).toBe("ai");
  expect((await nextOwner.recoverInterruptedCommandHistory()).find((entry) => entry.id === started.id))
    .toEqual(item);
  expect((await nextOwner.load()).commandHistory?.find((entry) => entry.id === started.id))
    .toEqual(item);
});

test("success and interruption settle a running command only once, including after reload", async () => {
  const store = storeWith();
  const owner = new VoiceStateRepository(store);
  await owner.beginCommandHistory(started);
  const success = await owner.settleCommandHistory({ ...started, status: "completed", reply: "Sunny" });
  expect(success.applied).toBeTrue();
  const interrupted = await owner.settleCommandHistory({ ...started, status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
  expect(interrupted.applied).toBeFalse();
  expect((await new VoiceStateRepository(store).recoverInterruptedCommandHistory())[0])
    .toMatchObject({ status: "completed", reply: "Sunny" });

  await owner.beginCommandHistory({ ...started, id: "interrupted-first" });
  const stopped = await owner.settleCommandHistory({ ...started, id: "interrupted-first", status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
  expect(stopped.applied).toBeTrue();
  expect((await owner.settleCommandHistory({ ...started, id: "interrupted-first", status: "completed", reply: "Late" })).applied)
    .toBeFalse();
  expect((await owner.load()).commandHistory?.find((entry) => entry.id === "interrupted-first"))
    .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
});

test("interruption claimed while success waits for KV read wins the terminal write", async () => {
  const backing = storeWith();
  let pauseRead = false;
  let releaseRead!: () => void;
  let readEntered!: () => void;
  const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const enteredGate = new Promise<void>((resolve) => { readEntered = resolve; });
  const store: KeyValueStore = {
    ...backing,
    get: async <T>(key: string) => {
      if (key === COMMAND_HISTORY_KEY && pauseRead) {
        pauseRead = false;
        readEntered();
        await readGate;
      }
      return backing.get<T>(key);
    },
  };
  const repository = new VoiceStateRepository(store);
  await repository.beginCommandHistory(started);
  pauseRead = true;
  let aborted = false;
  const success = repository.settleCommandHistory(
    { ...started, status: "completed", reply: "too late" },
    () => !aborted,
  );
  await enteredGate;
  aborted = true;
  const interrupted = repository.settleCommandHistory({
    ...started, status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED",
  });
  releaseRead();
  expect((await success).applied).toBeFalse();
  expect((await interrupted).applied).toBeTrue();
  expect((await repository.load()).commandHistory?.find((entry) => entry.id === started.id))
    .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
});

test("interruption claimed while a success CAS is in flight wins after that CAS returns", async () => {
  const backing = storeWith();
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const enteredGate = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const store: KeyValueStore = {
    ...backing,
    async compareAndSet(key, expected, value) {
      if (key === COMMAND_HISTORY_KEY && Array.isArray(value)
        && value.some((entry) => entry?.id === started.id && entry?.status === "completed")) {
        enteredWrite();
        await writeGate;
      }
      return backing.compareAndSet(key, expected, value);
    },
  };
  const repository = new VoiceStateRepository(store);
  await repository.beginCommandHistory(started);
  let aborted = false;
  const success = repository.settleCommandHistory(
    { ...started, status: "completed", reply: "answer after close" },
    () => !aborted,
  );
  await enteredGate;
  aborted = true;
  const interrupted = repository.settleCommandHistory({
    ...started, status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED",
  });
  releaseWrite();
  expect((await success).applied).toBeFalse();
  expect((await interrupted).applied).toBeTrue();
  expect((await repository.load()).commandHistory?.find((entry) => entry.id === started.id))
    .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
});

test("a previous owner cannot overwrite a new owner's recovered interruption", async () => {
  const backing = storeWith();
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const enteredGate = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const pauseCompletedWrite = async (value: unknown) => {
    if (Array.isArray(value) && value.some((entry) => entry?.id === started.id && entry?.status === "completed")) {
      enteredWrite();
      await writeGate;
    }
  };
  const staleStore: KeyValueStore = {
    ...backing,
    async set(key, value) {
      if (key === COMMAND_HISTORY_KEY) await pauseCompletedWrite(value);
      await backing.set(key, value);
    },
    async compareAndSet(key, expected, value) {
      if (key === COMMAND_HISTORY_KEY) await pauseCompletedWrite(value);
      return backing.compareAndSet(key, expected, value);
    },
  };
  const oldOwner = new VoiceStateRepository(staleStore);
  await oldOwner.beginCommandHistory(started);
  const lateSuccess = oldOwner.settleCommandHistory({ ...started, status: "completed", reply: "late" });
  await enteredGate;
  const newOwner = new VoiceStateRepository(backing);
  expect((await newOwner.recoverInterruptedCommandHistory()).find((entry) => entry.id === started.id))
    .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
  releaseWrite();
  expect((await lateSuccess).applied).toBeFalse();
  expect((await newOwner.load()).commandHistory?.find((entry) => entry.id === started.id))
    .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
});

test("Surface unmount without deactivate leaves a recoverable running task", async () => {
  document.body.replaceChildren();
  let context!: AppContext;
  let request!: Parameters<AgentSessionClient["send"]>[0];
  let finish!: (result: AgentSendResult) => void;
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "new-owned-session"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?command-durability=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        await store.set(COMMAND_HISTORY_KEY, [{
          id: "seed", transcript: "old question", reply: "old answer", status: "completed",
          commandId: "voice.command.agent", agentSessionId: "session-a", createdAt: new Date().toISOString(),
        }]);
        Object.assign(ctx.agent, {
          send: async (input: Parameters<AgentSessionClient["send"]>[0]) => {
            request = input;
            return new Promise<AgentSendResult>((resolve) => { finish = resolve; });
          },
          cancel: async () => ({ cancelled: true }),
          listSessions: async () => ({ sessions: [{ sessionId: "session-a", backend: "dsh", memory: "session", createdMs: Date.now(), updatedMs: Date.now(), stale: false }] }),
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  try {
    const surface = await host.openSurface("main"), root = surface.root!;
    root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root);
    const input = root.querySelector<HTMLInputElement>(".chat-input")!;
    input.value = "Will it rain?";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const deadline = Date.now() + 2000;
    while (!request && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(request).toBeDefined();
    const before = await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(before?.find((entry) => entry.id === request.turnId))
      .toMatchObject({ status: "running", agentSessionId: "session-a" });
    await host.unmountSurface(surface.surfaceMountId);
    const recovered = await new VoiceStateRepository(context.storage.private("voice-state")).recoverInterruptedCommandHistory();
    expect(recovered.find((entry) => entry.id === request.turnId))
      .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED", agentSessionId: "session-a" });
    finish({ turnId: request.turnId!, text: "LATE ANSWER", failure: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(after?.find((entry) => entry.id === request.turnId))
      .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED" });
    expect(after?.find((entry) => entry.id === request.turnId)?.reply).toBeUndefined();
  } finally {
    finish?.({ turnId: request?.turnId ?? "", text: null, failure: { kind: "killed" } });
    await host.disable();
  }
});

test("journal write failure stops before Agent request and shows a retryable error", async () => {
  document.body.replaceChildren();
  let sends = 0;
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "new-owned-session"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?command-journal-failure=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        const privateStore = ctx.storage.private.bind(ctx.storage);
        const store = privateStore("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        await store.set(COMMAND_HISTORY_KEY, [{
          id: "seed", transcript: "old question", reply: "old answer", status: "completed",
          commandId: "voice.command.agent", agentSessionId: "session-a", createdAt: new Date().toISOString(),
        }]);
        Object.assign(ctx.storage, { private: (namespace: string) => {
          const backing = privateStore(namespace);
          if (namespace !== "voice-state") return backing;
          return { ...backing,
            get: backing.get.bind(backing),
            delete: backing.delete.bind(backing),
            keys: backing.keys.bind(backing),
            set: async (key: string, value: unknown) => {
              if (key === COMMAND_HISTORY_KEY
                && Array.isArray(value) && value.some((item) => item?.status === "running")) {
                throw new Error("simulated journal write failure");
              }
              await backing.set(key, value);
            },
            compareAndSet: async (key: string, expected: unknown, value: unknown) => {
              if (key === COMMAND_HISTORY_KEY
                && Array.isArray(value) && value.some((item) => item?.status === "running")) {
                throw new Error("simulated journal write failure");
              }
              return backing.compareAndSet(key, expected, value);
            },
          };
        } });
        Object.assign(ctx.agent, {
          send: async () => { sends++; throw new Error("send must not run"); },
          listSessions: async () => ({ sessions: [{ sessionId: "session-a", backend: "dsh", memory: "session", createdMs: Date.now(), updatedMs: Date.now(), stale: false }] }),
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  try {
    const { root } = await host.openSurface("main");
    root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root!.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root!);
    const input = root!.querySelector<HTMLInputElement>(".chat-input")!;
    input.value = "question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const deadline = Date.now() + 2000;
    while (!root!.querySelector(".chat-send-error") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sends).toBe(0);
    expect(input.disabled).toBeFalse();
    expect(root!.querySelector(".chat-send-error")?.textContent).toContain(t("errors.message18"));
  } finally {
    await host.disable();
  }
});

test("new Agent session is linked in the journal before send and retained by interrupted history", async () => {
  document.body.replaceChildren();
  let context!: AppContext;
  let request!: Parameters<AgentSessionClient["send"]>[0];
  let finish!: (result: AgentSendResult) => void;
  let deletes = 0;
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "new-owned-session"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?command-session-journal=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        Object.assign(ctx.agent, {
          createSession: async () => ({ sessionId: "new-owned-session" }),
          send: async (input: Parameters<AgentSessionClient["send"]>[0]) => {
            request = input;
            const history = await store.get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
            expect(history?.find((entry) => entry.id === input.turnId))
              .toMatchObject({ status: "running", agentSessionId: "new-owned-session" });
            return new Promise<AgentSendResult>((resolve) => { finish = resolve; });
          },
          cancel: async () => ({ cancelled: true }),
          deleteSession: async () => { deletes++; return { deleted: true }; },
          listSessions: async () => ({ sessions: [] }),
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  try {
    host.setNextVoiceCommandTranscript("session must remain linked");
    await host.invokeCommand("com.reai.voice.command.agent");
    await host.invokeCommand("com.reai.voice.command.agent");
    const deadline = Date.now() + 2000;
    while (!request && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(request).toBeDefined();
    await host.disable();
    finish({ turnId: request.turnId!, text: "late", failure: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const history = await context.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(history?.find((entry) => entry.id === request.turnId))
      .toMatchObject({ status: "failed", errorCode: "VOICE_COMMAND_INTERRUPTED", agentSessionId: "new-owned-session" });
    expect(deletes).toBe(0);
  } finally {
    finish?.({ turnId: request?.turnId ?? "", text: null, failure: { kind: "killed" } });
    await host.disable();
  }
});

/** Synthetic fixture waits for the actual asynchronous history/paint boundary. */
async function waitForConversationFixture(root: Element) {
 const end=Date.now()+2500; while(!root.querySelector(".main-body.chat-view,.main-body.translation-detail")&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(!!root.querySelector(".main-body.chat-view,.main-body.translation-detail")).toBeTrue();
}
