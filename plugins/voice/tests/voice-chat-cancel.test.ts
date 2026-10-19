import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, AgentSendResult, AgentSessionClient } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, type VoiceCommandHistoryItem } from "../src/data";
import { t } from "../src/voice-i18n";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; }
});
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate(), message).toBeTrue();
}

test("实际 activate/mount/输入/停止链路丢弃迟到成功，只取消原回合并允许同会话继续", async () => {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  const sends: Parameters<AgentSessionClient["send"]>[0][] = [];
  const cancellations: Parameters<AgentSessionClient["cancel"]>[0][] = [];
  const resolvers: ((result: AgentSendResult) => void)[] = [];
  let emitAgentEvent: Parameters<AppContext["events"]["onLocalAgent"]>[0] | undefined;
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "retention-session"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app");
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const onLocalAgent = ctx.events.onLocalAgent.bind(ctx.events);
        ctx.events.onLocalAgent = (handler) => { emitAgentEvent = handler; onLocalAgent(handler); };
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        await store.set(COMMAND_HISTORY_KEY, [{
          id: "test-context", transcript: "Existing test conversation", reply: "Ready",
          status: "completed", commandId: "voice.command.agent", agentSessionId: "session-a",
          createdAt: new Date().toISOString(),
        }]);
        Object.assign(ctx.agent, {
          send: async (input: Parameters<AgentSessionClient["send"]>[0]) => {
            sends.push(input);
            return await new Promise<AgentSendResult>((resolve) => { resolvers.push(resolve); });
          },
          cancel: async (input: Parameters<AgentSessionClient["cancel"]>[0]) => {
            cancellations.push(input);
            return { cancelled: true };
          },
          listSessions: async () => ({ sessions: [{ sessionId: "session-a", backend: "dsh", memory: "session", createdMs: Date.now(), updatedMs: Date.now(), stale: false }] }),
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => {
      const root = document.createElement("div"); document.body.append(root); return root;
    },
  });
  await host.installAndEnable();
  try {
    const surface = await host.openSurface("main");
    const root = surface.root!;
    root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root);
    const send = (text: string) => {
      const input = root.querySelector<HTMLInputElement>(".chat-input")!;
      expect(input.disabled).toBeFalse();
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    send("Keep writing until I stop you");
    await until(() => sends.length === 1 && !!root.querySelector(".chat-cancel"), "Running turn has a stop control");
    emitAgentEvent!({ type: "tool.outcome", toolName: "web_search", errorCode: "web_access_unavailable", turnId: sends[0]!.turnId! });
    root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
    await until(() => cancellations.length === 1, "Cancel reaches the original session and turn");
    expect(cancellations).toEqual([{ sessionId: "session-a", turnId: sends[0]!.turnId! }]);
    expect(root.querySelector<HTMLInputElement>(".chat-input")!.disabled).toBeTrue();
    resolvers[0]!({ turnId: sends[0]!.turnId!, text: "LATE_SUCCESS_MUST_NOT_APPEAR", failure: null });
    await until(() => !root.querySelector(".chat-cancel") && root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false, "Cancellation settles before input is available");
    const history = await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    const stopped = history!.find((item) => item.id === sends[0]!.turnId)!;
    expect(stopped.status).toBe("failed");
    expect(stopped.errorCode).toContain("VOICE_CANCELLED");
    expect(stopped.userMessage).toBe(t("errors.message10"));
    expect(stopped.reply).toBeUndefined();
    expect(root.textContent).not.toContain("LATE_SUCCESS_MUST_NOT_APPEAR");

    send("A short follow-up");
    await until(() => sends.length === 2, "Next turn starts after cancellation");
    expect(sends[1]!.sessionId).toBe("session-a");
    expect(sends[1]!.turnId).not.toBe(sends[0]!.turnId);
    resolvers[1]!({ turnId: sends[1]!.turnId!, text: "NEW_TURN_OK", failure: null,
      runtime: "dsh", channel: "external-brain", usage: { complete: true, inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    await until(() => root.textContent?.includes("NEW_TURN_OK") === true, "New response is shown");
    expect(root.textContent).not.toContain("LATE_SUCCESS_MUST_NOT_APPEAR");
    expect(cancellations).toHaveLength(1);
    const final = await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(final!.find((item) => item.id === sends[1]!.turnId)?.status).toBe("completed");
    expect(final!.find((item) => item.id === sends[1]!.turnId)?.messages?.find((message) => message.text === "NEW_TURN_OK"))
      .toMatchObject({ runtime: "dsh", channel: "external-brain", usage: { complete: true, inputTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(final!.find((item) => item.id === sends[0]!.turnId)?.status).toBe("failed");
  } finally {
    for (const [index, resolve] of resolvers.entries()) resolve({ turnId: sends[index]!.turnId!, text: null, failure: { kind: "killed" } });
    await host.disable();
  }
});

test("转文本在润色期间停止后，不将取消当成失败兜底写回原文", async () => {
  document.body.replaceChildren();
  let context: AppContext | undefined;
  let generated = false;
  let cancelled = false;
  let finishPolish: (() => void) | undefined;
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "retention-session"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app");
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", {
          ...DEFAULT_SETTINGS, polish: "light",
          polishContext: { ...DEFAULT_SETTINGS.polishContext, window: false, recentVoice: false },
        });
        Object.assign(ctx.aiApi, {
          generateText: async ({ invocationId }: { invocationId: string }) => {
            generated = true;
            return await new Promise((resolve) => {
              finishPolish = () => resolve({ invocationId, stream: false, text: "不应写入的迟到润色结果" });
            });
          },
          cancel: async () => { cancelled = true; return { cancelled: true, upstreamStopped: true }; },
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => {
      const root = document.createElement("div"); document.body.append(root); return root;
    },
  });
  await host.installAndEnable();
  try {
    const { root } = await host.openSurface("main");
    await host.invokeCommand("com.reai.voice.command.transcribe");
    await host.invokeCommand("com.reai.voice.command.transcribe");
    await until(() => generated, "Transcription reaches polishing");
    root!.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    root!.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root!);
    root!.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
    await until(() => cancelled && !root!.querySelector(".chat-cancel"), "Polish cancellation settles");
    finishPolish!();
    const history = await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
    expect(history).toHaveLength(1);
    expect(history![0]!.status).toBe("failed");
    expect(history![0]!.errorCode).toContain("VOICE_CANCELLED");
    expect(history![0]!.reply).toBeUndefined();
    expect(host.cloudRequests.filter((request) => request.method === "voice.deliver.commit")).toHaveLength(0);
    expect(root!.textContent).not.toContain("不应写入的迟到润色结果");
  } finally {
    finishPolish?.();
    await host.disable();
  }
});

for (const level of ["light", "formal"] as const) {
  // 2026-09-27 定稿：润色只作用于语音输入法，Agent（含详情页追问）不润色——无论润色档
  // 开到哪一档，交给 Agent 的都是用户原话，也不为它采上下文、不发云端润色请求。
  test(`聊天追问在 ${level} 润色档下不润色，原文直接发给同一 Agent`, async () => {
    document.body.replaceChildren();
    let context: AppContext | undefined;
    const sends: Parameters<AgentSessionClient["send"]>[0][] = [];
    let polishes = 0;
    const transcript = "H04 DSH fresh final. What is the exact code I asked you to remember? Reply with that code only.";
    const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "retention-session"] },
      manifest: structuredClone(manifest) as never,
      loadApp: async () => {
        const { default: app } = await import("../src/app");
        return { default: { ...app, async activate(ctx: AppContext) {
          context = ctx;
          const store = ctx.storage.private("voice-state");
          await store.set("recognition-engine-choice-v1", "local");
          await store.set("settings", { ...DEFAULT_SETTINGS, polish: level,
            polishContext: { ...DEFAULT_SETTINGS.polishContext, window: false, recentVoice: false } });
          await store.set(COMMAND_HISTORY_KEY, [{
            id: "retention-context", transcript: "Remember cedar-47", reply: "Ready",
            status: "completed", commandId: "voice.command.agent", agentSessionId: "retention-session",
            createdAt: new Date().toISOString(),
          }]);
          ctx.aiApi.generateText = async ({ invocationId, messages }) => {
            polishes += 1;
            expect(messages.at(-1)?.content).toBe(transcript);
            return { invocationId, stream: false, text: "H04 DSH fresh final" };
          };
          Object.assign(ctx.agent, {
            send: async (input: Parameters<AgentSessionClient["send"]>[0]) => {
              sends.push(input); return { turnId: input.turnId!, text: "cedar-47", failure: null };
            },
            listSessions: async () => ({ sessions: [{ sessionId: "retention-session", backend: "dsh", memory: "session", createdMs: Date.now(), updatedMs: Date.now(), stale: false }] }),
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
      input.value = transcript; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => sends.length === 1, "Follow-up reaches the Agent");
      expect(polishes).toBe(0);
      expect(sends[0]!.sessionId).toBe("retention-session");
      expect(sends[0]!.text).toBe(transcript);
      await until(() => root!.textContent?.includes("cedar-47") === true, "Agent reply is displayed");
      const history = await context!.storage.private("voice-state").get<VoiceCommandHistoryItem[]>(COMMAND_HISTORY_KEY);
      expect(history!.find(item => item.id === sends[0]!.turnId)?.transcript).toBe(transcript);
    } finally { await host.disable(); }
  });
}

/** Synthetic fixture waits for the actual asynchronous history/paint boundary. */
async function waitForConversationFixture(root: Element) {
 const end=Date.now()+2500; while(!root.querySelector(".main-body.chat-view,.main-body.translation-detail")&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(!!root.querySelector(".main-body.chat-view,.main-body.translation-detail")).toBeTrue();
}
