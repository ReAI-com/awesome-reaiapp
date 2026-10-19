import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AppContext, AppDependencyStatus, AgentSendResult, AgentSessionClient } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, VoiceStateRepository, type VoiceCommandHistoryItem } from "../src/data";
import { renderChatMessage } from "@reai/chat-ui";
import { commandMessages } from "../src/voice-chat-detail";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate(), message).toBeTrue();
}

async function harness(twoConversations = false) {
  document.body.replaceChildren();
  let context!: AppContext;
  let emit!: Parameters<AppContext["events"]["onLocalAgent"]>[0];
  const requests: Parameters<AgentSessionClient["send"]>[0][] = [];
  const pending: { resolve: (value: AgentSendResult) => void; reject: (error: unknown) => void }[] = [];
  let deferBrowserStatus = false;
  const browserStatusPending: Array<(value: AppDependencyStatus) => void> = [];
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ["session-a", "session-b"] },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      // A fresh plugin module models a new runtime, including deactivation cases.
      const { default: app } = await import("../src/app?failure-metadata=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const onAgent = ctx.events.onLocalAgent.bind(ctx.events);
        ctx.events.onLocalAgent = handler => { emit = handler; onAgent(handler); };
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        await store.set(COMMAND_HISTORY_KEY, [{
          id: "seed", transcript: "old question", reply: "old answer", status: "completed",
          commandId: "voice.command.agent", agentSessionId: "session-a", createdAt: new Date().toISOString(),
          messages: [{ from: "ai", text: "old answer", at: new Date().toISOString(), totalTokens: 42 }],
        }, ...(twoConversations ? [{
          id: "seed-b", transcript: "SECOND CONVERSATION", reply: "ready", status: "completed",
          commandId: "voice.command.agent", agentSessionId: "session-b", createdAt: new Date().toISOString(),
        }] : [])]);
        Object.assign(ctx.agent, {
          send: async (input: Parameters<AgentSessionClient["send"]>[0]) => {
            requests.push(input);
            return new Promise<AgentSendResult>((resolve, reject) => pending.push({ resolve, reject }));
          },
          cancel: async () => ({ cancelled: true }),
          listSessions: async () => ({ sessions: ["session-a", "session-b"].map(sessionId => ({ sessionId, backend: "dsh", memory: "session", createdMs: Date.now(), updatedMs: Date.now(), stale: false })) }),
        });
        const originalAppStatus = ctx.apps.status.bind(ctx.apps);
        Object.assign(ctx.apps, {
          status: (target: { appId: string }) => {
            if (target.appId === "com.reai.browser" && deferBrowserStatus) {
              deferBrowserStatus = false;
              return new Promise<AppDependencyStatus>(resolve => browserStatusPending.push(resolve));
            }
            return originalAppStatus(target);
          },
        });
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  const surface = await host.openSurface("main"), root = surface.root!;
  root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
  Array.from(root.querySelectorAll<HTMLButtonElement>(".command-history-item")).find(row => row.textContent?.includes("old question"))!.click();
    await waitForConversationFixture(root);
  return {
    host, root, requests, pending, browserStatusPending,
    deferNextBrowserStatus: () => { deferBrowserStatus = true; },
    resolveBrowserStatus: (status: AppDependencyStatus) => {
      const resolve = browserStatusPending.shift();
      expect(resolve).toBeDefined();
      resolve!(status);
    },
    emit: (event: Parameters<typeof emit>[0]) => emit(event),
    history: async () => (await new VoiceStateRepository(context.storage.private("voice-state")).load()).commandHistory!,
    send: async (text: string) => {
      const count = requests.length, input = root.querySelector<HTMLInputElement>(".chat-input")!;
      expect(input.disabled).toBeFalse();
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => requests.length === count + 1, "real command reaches Host agent.send");
      return count;
    },
    settle: async () => until(() => !root.querySelector(".chat-cancel") && root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false, "command settles"),
    cleanup: async () => {
      pending.forEach((p, i) => p.resolve({ turnId: requests[i]!.turnId!, text: null, failure: { kind: "killed" } }));
      await host.disable();
    },
  };
}

for (const kind of ["engine", "timeout", "killed"] as const) {
  test(`actual workflow persists ${kind} Host metadata through repository reload`, async () => {
    const h = await harness();
    try {
      const i = await h.send("fail with real metadata");
      const runtime = kind === "engine" ? "dsh" : "codex";
      h.pending[i]!.resolve({ turnId: h.requests[i]!.turnId!, text: null, failure: { kind },
        runtime, channel: "external-brain", usage: { complete: false } });
      await h.settle();
      const history = await h.history(), failed = history.find(x => x.id === h.requests[i]!.turnId)!;
      expect(failed.status).toBe("failed");
      expect(failed.messages!.at(-1)).toMatchObject({ runtime, channel: "external-brain", usage: { complete: false } });
      const rendered = renderChatMessage(commandMessages([failed]).at(-1)!, { developerMode: true });
      expect(rendered.querySelector(".chat-devmeta")?.textContent).toContain(runtime);
      expect(rendered.querySelector(".tok")).toBeNull();
      const old = history.find(x => x.id === "seed")!.messages![0]!;
      expect(old.runtime).toBeUndefined(); expect(old.usage).toBeUndefined();
      expect(renderChatMessage(commandMessages([history.find(x => x.id === "seed")!])[0]!, { developerMode: true }).querySelector(".tok")).toBeNull();
    } finally { await h.cleanup(); }
  });
}

test("cancelled late success keeps cancellation and its own cloned metadata; next turn is independent", async () => {
  const h = await harness();
  try {
    const first = await h.send("cancel this");
    h.root.querySelector<HTMLButtonElement>(".chat-cancel")!.click();
    const usage = { complete: false };
    h.pending[first]!.resolve({ turnId: h.requests[first]!.turnId!, text: "LATE_ANSWER", failure: null,
      runtime: "codex", channel: "external-brain", usage });
    await h.settle();
    const second = await h.send("next");
    h.pending[second]!.resolve({ turnId: h.requests[second]!.turnId!, text: "NEXT", failure: null,
      runtime: "dsh", channel: "external-brain", usage: { complete: true, inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
    await h.settle();
    usage.complete = true;
    const history = await h.history(), stopped = history.find(x => x.id === h.requests[first]!.turnId)!;
    expect(history.filter(x => x.id === stopped.id)).toHaveLength(1);
    expect(stopped.errorCode).toContain("VOICE_CANCELLED");
    expect(stopped.messages!.at(-1)).toMatchObject({ runtime: "codex", usage: { complete: false } });
    expect(h.root.textContent).not.toContain("LATE_ANSWER");
    expect(history.find(x => x.id === h.requests[second]!.turnId)!.messages!.at(-1))
      .toMatchObject({ runtime: "dsh", usage: { complete: true, totalTokens: 4 } });
  } finally { await h.cleanup(); }
});

test("web-tool failure keeps precedence and metadata, never the runtime apology", async () => {
  const h = await harness();
  try {
    const i = await h.send("search");
    h.emit({ type: "tool.outcome", toolName: "web_search", errorCode: "web_access_unavailable", turnId: h.requests[i]!.turnId! });
    h.pending[i]!.resolve({ turnId: h.requests[i]!.turnId!, text: "APOLOGY_NOT_ANSWER", failure: null,
      runtime: "dsh", channel: "external-brain", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === h.requests[i]!.turnId)!;
    expect(item.status).toBe("failed"); expect(item.errorCode).toContain("web_access_unavailable");
    expect(item.messages!.at(-1)).toMatchObject({ runtime: "dsh", usage: { complete: false } });
    expect(JSON.stringify(item)).not.toContain("APOLOGY_NOT_ANSWER");
  } finally { await h.cleanup(); }
});

test("pre-dispatch rejection does not guess metadata", async () => {
  const h = await harness();
  try {
    const i = await h.send("reject");
    h.pending[i]!.reject(new Error("session unavailable"));
    await h.settle();
    const item = (await h.history()).find(x => x.id === h.requests[i]!.turnId)!;
    const message = commandMessages([item]).at(-1)!;
    expect(message.runtime).toBeUndefined(); expect(message.channel).toBeUndefined(); expect(message.usage).toBeUndefined();
  } finally { await h.cleanup(); }
});

test("invalid Host counts in failure remain unknown through existing sanitizer", async () => {
  const h = await harness();
  try {
    const i = await h.send("bad count");
    h.pending[i]!.resolve({ turnId: h.requests[i]!.turnId!, text: null, failure: { kind: "engine" },
      runtime: "dsh", usage: { complete: true, inputTokens: 1, outputTokens: 2, totalTokens: 99 } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === h.requests[i]!.turnId)!;
    const message = commandMessages([item]).at(-1)!;
    expect(message.usage?.complete).toBe(false); expect(message.usage?.totalTokens).toBeUndefined();
    expect(renderChatMessage(message, { developerMode: true }).querySelector(".tok")).toBeNull();
  } finally { await h.cleanup(); }
});

test("deactivated owner keeps an interrupted record and discards late metadata", async () => {
  const h = await harness();
  try {
    const i = await h.send("old owner");
    await h.host.disable();
    h.pending[i]!.resolve({ turnId: h.requests[i]!.turnId!, text: null, failure: { kind: "engine" },
      runtime: "codex", usage: { complete: false } });
    await new Promise(resolve => setTimeout(resolve, 20));
    // 新契约（链②）：外部中止不再无声蒸发——历史保留一条「已中断」失败记录；
    // 晚到的成功/元数据不得覆盖它（runtime/usage 不出现）。
    const item = (await h.history()).find(x => x.id === h.requests[i]!.turnId);
    expect(item).toBeDefined();
    expect(item!.status).toBe("failed");
    expect(item!.errorCode).toBe("VOICE_COMMAND_INTERRUPTED");
    const last = item!.messages!.at(-1)!;
    expect((last as { runtime?: unknown }).runtime).toBeUndefined();
    expect((last as { usage?: unknown }).usage).toBeUndefined();
  } finally { await h.cleanup(); }
});

test("web tool calls aggregate into one card with failure retries kept", async () => {
  const h = await harness();
  try {
    const i = await h.send("aggregate");
    const turnId = h.requests[i]!.turnId!;
    // 同一任务内：搜索成功、一次读取失败、重试成功——全部进同一张 tool-group 卡。
    h.emit({ type: "tool.start", toolName: "web_search", callId: "call-1", turnId });
    h.emit({ type: "tool.end", toolName: "web_search", isError: false, callId: "call-1", turnId });
    h.emit({ type: "tool.start", toolName: "web_fetch", callId: "call-2", turnId });
    h.emit({ type: "tool.end", toolName: "web_fetch", isError: true, callId: "call-2", turnId });
    h.emit({ type: "tool.start", toolName: "web_fetch", callId: "call-3", turnId });
    h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, callId: "call-3", turnId });
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", channel: "external-brain",
      usage: { complete: true, inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const groupMessages = (item.messages ?? []).filter((message) => message.card?.kind === "tool-group");
    expect(groupMessages).toHaveLength(1);
    const card = groupMessages[0]!.card as {
      kind: "tool-group";
      status: string;
      calls: { callId?: string; tool: string; status: string; durationMs?: number }[];
    };
    expect(card.status).toBe("completed");
    expect(card.calls).toHaveLength(3);
    expect(card.calls[0]).toMatchObject({ callId: "call-1", tool: "web_search", status: "completed" });
    expect(card.calls[1]).toMatchObject({ callId: "call-2", tool: "web_fetch", status: "failed" });
    expect(card.calls[2]).toMatchObject({ callId: "call-3", tool: "web_fetch", status: "completed" });
  } finally { await h.cleanup(); }
});

test("同一回合不同类型的工具调用（联网、浏览器、文件）全部进同一张卡，界面上只有一条折叠进度", async () => {
  const h = await harness();
  try {
    const i = await h.send("search then open and read");
    const turnId = h.requests[i]!.turnId!;
    h.emit({ type: "tool.start", toolName: "web_search", callId: "t-1", turnId });
    h.emit({ type: "tool.end", toolName: "web_search", isError: false, callId: "t-1", turnId });
    h.emit({ type: "tool.start", toolName: "browser_navigate", callId: "t-2", turnId });
    await until(() => h.root.querySelector(".chat-status-card.tool-group .chat-status-label")?.textContent === "正在打开网页",
      "running summary names the current step");
    h.emit({ type: "tool.end", toolName: "browser_navigate", isError: false, callId: "t-2", turnId });
    h.emit({ type: "tool.start", toolName: "read", callId: "t-3", turnId });
    h.emit({ type: "tool.outcome", toolName: "read", errorCode: "AGENT_TOOL_AUTHORIZATION_UNAVAILABLE", callId: "t-3", turnId });
    h.emit({ type: "tool.end", toolName: "read", isError: true, callId: "t-3", turnId });
    h.emit({ type: "tool.start", toolName: "not a tool name", callId: "t-4", turnId });
    h.pending[i]!.resolve({ turnId, text: "**已打开**官网", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    expect(item.status).toBe("completed");
    const cards = (item.messages ?? []).filter((message) => message.card);
    expect(cards).toHaveLength(1);
    const card = cards[0]!.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.calls.map((call) => [call.tool, call.status])).toEqual([
      ["web_search", "completed"], ["browser_navigate", "completed"], ["read", "failed"]]);
    expect(card.calls[2]?.errorCode).toBe("AGENT_TOOL_AUTHORIZATION_UNAVAILABLE");
    // 非联网工具失败不改写这条命令的结果（回答照常落地）；工具组自己的终态如实判红（W2）。
    expect(item.reply).toBe("**已打开**官网");
    expect(card.status).toBe("failed");
    expect(card.label).toBe("读取文件未完成：工具授权不可用 · 1 次失败");
    expect(h.root.querySelectorAll(".chat-status-card")).toHaveLength(1);
    expect(h.root.querySelector(".chat-status-card .chat-status-label")?.textContent).toBe("读取文件未完成：工具授权不可用");
    expect(h.root.querySelector(".chat-status-card .chat-status-meta")?.textContent)
      .toBe("1 次失败");
  } finally { await h.cleanup(); }
});

test("非联网工具失败后同一工具重试成功：工具组完成，摘要仍写明失败次数", async () => {
  const h = await harness();
  try {
    const i = await h.send("read retry");
    const turnId = h.requests[i]!.turnId!;
    h.emit({ type: "tool.start", toolName: "read", callId: "r-1", turnId });
    h.emit({ type: "tool.end", toolName: "read", isError: true, callId: "r-1", turnId });
    h.emit({ type: "tool.start", toolName: "read", callId: "r-2", turnId });
    h.emit({ type: "tool.end", toolName: "read", isError: false, callId: "r-2", turnId });
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.status).toBe("completed");
    expect(card.label).toBe("已调用 1 个工具（共 2 次）：读取文件 · 1 次失败");
  } finally { await h.cleanup(); }
});

test("非联网工具失败后同类以外的调用超过明细上限：失败仍在明细里，工具组判红，工具个数不缩水", async () => {
  const h = await harness();
  try {
    const i = await h.send("read then many greps");
    const turnId = h.requests[i]!.turnId!;
    h.emit({ type: "tool.start", toolName: "read", callId: "r-1", turnId });
    h.emit({ type: "tool.outcome", toolName: "read", errorCode: "AGENT_TOOL_NOT_GRANTED", callId: "r-1", turnId });
    h.emit({ type: "tool.end", toolName: "read", isError: true, callId: "r-1", turnId });
    for (let index = 0; index < 20; index += 1) {
      h.emit({ type: "tool.start", toolName: "grep", callId: `g-${index}`, turnId });
      h.emit({ type: "tool.end", toolName: "grep", isError: false, callId: `g-${index}`, turnId });
    }
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.calls).toHaveLength(20);
    expect(card.calls[0]).toMatchObject({ tool: "read", status: "failed", errorCode: "AGENT_TOOL_NOT_GRANTED" });
    expect(card.totalCalls).toBe(21);
    expect(card.omittedCalls).toBe(1);
    expect(card.status).toBe("failed");
    expect(card.label).toBe("读取文件未完成：未获准使用这个工具 · 1 次失败");
    expect(item.status).toBe("completed");
  } finally { await h.cleanup(); }
});

test("20 种工具各失败一次、随后全部重试成功：在途重试不被明细上限裁掉，工具组完成", async () => {
  const h = await harness();
  try {
    const i = await h.send("fail all then retry all");
    const turnId = h.requests[i]!.turnId!;
    const tools = Array.from({ length: 20 }, (_, index) => `mcp.t${index}`);
    for (const [round, isError] of [[0, true], [1, false]] as const) {
      for (const tool of tools) {
        const callId = `${tool}-${round}`;
        h.emit({ type: "tool.start", toolName: tool, callId, turnId });
        h.emit({ type: "tool.end", toolName: tool, isError, callId, turnId });
      }
    }
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.status).toBe("completed");
    expect(card.totalCalls).toBe(40);
    expect(card.calls).toHaveLength(20);
    expect(card.calls.every((call) => call.status === "completed")).toBe(true);
    expect(card.label).toContain("20 次失败");
  } finally { await h.cleanup(); }
});

for (const mode of ["码先到", "结束先到", "只有结束"] as const) {
  test(`同时在途超过明细上限：被裁掉的调用随后失败（${mode}），按序号补回明细并判红`, async () => {
    const h = await harness();
    try {
      const i = await h.send("parallel read and greps");
      const turnId = h.requests[i]!.turnId!;
      h.emit({ type: "tool.start", toolName: "read", callId: "r-1", turnId });
      for (let index = 0; index < 20; index += 1) h.emit({ type: "tool.start", toolName: "grep", callId: `g-${index}`, turnId });
      const outcome = { type: "tool.outcome", toolName: "read", errorCode: "AGENT_EXEC_TIMEOUT", callId: "r-1", turnId } as const;
      if (mode === "码先到") h.emit(outcome);
      h.emit({ type: "tool.end", toolName: "read", isError: true, callId: "r-1", turnId });
      if (mode === "结束先到") h.emit(outcome);
      for (let index = 0; index < 20; index += 1) h.emit({ type: "tool.end", toolName: "grep", isError: false, callId: `g-${index}`, turnId });
      h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
      await h.settle();
      const item = (await h.history()).find(x => x.id === turnId)!;
      const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
      if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
      expect(card).toMatchObject({ status: "failed", totalCalls: 21, omittedCalls: 1, failedCalls: 1 });
      expect(card.calls[0]).toMatchObject({ callId: "r-1", status: "failed" });
      expect(card.label).toBe(mode === "只有结束" ? "读取文件未完成：调用失败 · 1 次失败"
        : "读取文件未完成：命令执行超时 · 1 次失败");
    } finally { await h.cleanup(); }
  });
}

test("late disabled browser status cannot restore install card after its tool call ended", async () => {
  const h = await harness();
  try {
    const i = await h.send("search while browser is being enabled");
    const turnId = h.requests[i]!.turnId!;
    h.deferNextBrowserStatus();
    h.emit({ type: "tool.start", toolName: "web_search", callId: "install-race", turnId });
    await until(() => h.browserStatusPending.length === 1, "browser status request is held in flight");
    h.emit({ type: "tool.end", toolName: "web_search", isError: false, callId: "install-race", turnId });
    await until(() => h.root.querySelector(".chat-status-card.tool-group") !== null, "tool card is visible");
    expect(h.root.querySelector(".chat-status-card.capability-required") === null).toBeTrue();

    // The original status snapshot was taken before the browser became ready.
    // The tool has already returned, but the Agent task remains active.
    h.resolveBrowserStatus({ appId: "com.reai.browser", installed: false, enabled: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.pending[i]).toBeDefined();
    expect(h.root.querySelector(".chat-status-card.capability-required") === null).toBeTrue();
  } finally { await h.cleanup(); }
});

test("late tool outcome backfills the matching call's error label", async () => {
  const h = await harness();
  try {
    const i = await h.send("outcome backfill");
    const turnId = h.requests[i]!.turnId!;
    h.emit({ type: "tool.start", toolName: "web_search", callId: "call-9", turnId });
    h.emit({ type: "tool.end", toolName: "web_search", isError: false, callId: "call-9", turnId });
    // outcome 晚于 end 到达：稳定错误码回填到同 callId 的明细行（本地化文案非空）。
    h.emit({ type: "tool.outcome", toolName: "web_search", errorCode: "web_access_unavailable", callId: "call-9", turnId });
    h.pending[i]!.resolve({ turnId, text: null, failure: { kind: "engine" }, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")!.card as {
      calls: { callId?: string; errorLabel?: string }[];
    };
    expect(card.calls[0]!.callId).toBe("call-9");
    expect(typeof card.calls[0]!.errorLabel).toBe("string");
    expect(card.calls[0]!.errorLabel!.length).toBeGreaterThan(0);
  } finally { await h.cleanup(); }
});

for (const lateOutcome of [false, true]) {
  test(`同一联网工具重试成功后不沿用旧错误（${lateOutcome ? "迟到" : "提前"} outcome）`, async () => {
    const h = await harness();
    try {
      const i = await h.send("retry web fetch");
      const turnId = h.requests[i]!.turnId!;
      h.emit({ type: "tool.start", toolName: "web_fetch", callId: "failed-fetch", turnId });
      if (!lateOutcome) h.emit({ type: "tool.outcome", toolName: "web_fetch", errorCode: "web_access_unavailable", callId: "failed-fetch", turnId });
      h.emit({ type: "tool.end", toolName: "web_fetch", isError: true, callId: "failed-fetch", turnId });
      h.emit({ type: "tool.start", toolName: "web_fetch", callId: "retry-fetch", turnId });
      h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, callId: "retry-fetch", turnId });
      if (lateOutcome) h.emit({ type: "tool.outcome", toolName: "web_fetch", errorCode: "web_access_unavailable", callId: "failed-fetch", turnId });
      h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
      await h.settle();
      const item = (await h.history()).find(x => x.id === turnId)!;
      expect(item.status).toBe("completed");
      expect(item.reply).toBe("DONE");
      const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
      if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
      expect(card.status).toBe("completed");
      expect(card.calls.map((call) => call.status)).toEqual(["failed", "completed"]);
      expect(card.totalCalls).toBe(2);
      expect(card.failedCalls).toBe(1);
      expect(card.label).toContain("1 次失败");
      expect(card.calls[0]?.errorLabel).toBeTruthy();
    } finally { await h.cleanup(); }
  });
}

test("另一个联网工具成功不能清掉未恢复的工具错误", async () => {
  const h = await harness();
  try {
    const i = await h.send("search and fetch");
    const turnId = h.requests[i]!.turnId!;
    h.emit({ type: "tool.start", toolName: "web_search", callId: "failed-search", turnId });
    h.emit({ type: "tool.outcome", toolName: "web_search", errorCode: "web_access_unavailable", callId: "failed-search", turnId });
    h.emit({ type: "tool.end", toolName: "web_search", isError: true, callId: "failed-search", turnId });
    h.emit({ type: "tool.start", toolName: "web_fetch", callId: "successful-fetch", turnId });
    h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, callId: "successful-fetch", turnId });
    h.pending[i]!.resolve({ turnId, text: "APOLOGY_NOT_ANSWER", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    expect(item.status).toBe("failed");
    expect(item.errorCode).toContain("web_access_unavailable");
    expect(JSON.stringify(item)).not.toContain("APOLOGY_NOT_ANSWER");
  } finally { await h.cleanup(); }
});

test("联网操作超过明细上限时保留总次数和省略数量", async () => {
  const h = await harness();
  try {
    const i = await h.send("many fetches");
    const turnId = h.requests[i]!.turnId!;
    for (let index = 0; index < 23; index += 1) {
      const callId = `fetch-${index}`;
      h.emit({ type: "tool.start", toolName: "web_fetch", callId, turnId });
      if (index >= 2) h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, callId, turnId });
    }
    // Both old rows have left the 20-row detail window. Late failure events
    // must still contribute to the all-call summary, without double counting.
    h.emit({ type: "tool.end", toolName: "web_fetch", isError: true, callId: "fetch-0", turnId });
    h.emit({ type: "tool.outcome", toolName: "web_fetch", errorCode: "web_access_unavailable", callId: "fetch-0", turnId });
    h.emit({ type: "tool.outcome", toolName: "web_fetch", errorCode: "web_access_unavailable", callId: "fetch-1", turnId });
    h.emit({ type: "tool.end", toolName: "web_fetch", isError: true, callId: "fetch-1", turnId });
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find(x => x.id === turnId)!;
    const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.calls).toHaveLength(20);
    expect(card.totalCalls).toBe(23);
    expect(card.omittedCalls).toBe(3);
    expect(card.failedCalls).toBe(2);
    expect(card.label).toContain("23");
    expect(card.label).toContain("2 次失败");
  } finally { await h.cleanup(); }
});

test("省略的早期调用若没有结束事件，整张卡仍显示未知", async () => {
  const h = await harness();
  try {
    const i = await h.send("unfinished old fetch");
    const turnId = h.requests[i]!.turnId!;
    for (let index = 0; index < 21; index += 1) {
      const callId = `fetch-${index}`;
      h.emit({ type: "tool.start", toolName: "web_fetch", callId, turnId });
      if (index > 0) h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, callId, turnId });
    }
    h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
    await h.settle();
    const item = (await h.history()).find((entry) => entry.id === turnId)!;
    const card = item.messages?.find((message) => message.card?.kind === "tool-group")?.card;
    if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
    expect(card.calls).toHaveLength(20);
    expect(card.omittedCalls).toBe(1);
    expect(card.status).toBe("unknown");
  } finally { await h.cleanup(); }
});

for (const missingId of [false, true]) {
  test(`工具${missingId ? "缺调用 ID" : "缺结束事件"}时不猜测为成功或失败`, async () => {
    const h = await harness();
    try {
      const i = await h.send("uncertain fetch");
      const turnId = h.requests[i]!.turnId!;
      h.emit({ type: "tool.start", toolName: "web_fetch", ...(missingId ? {} : { callId: "unfinished-fetch" }), turnId });
      if (missingId) h.emit({ type: "tool.end", toolName: "web_fetch", isError: false, turnId });
      h.pending[i]!.resolve({ turnId, text: "DONE", failure: null, runtime: "dsh", usage: { complete: false } });
      await h.settle();
      const item = (await h.history()).find(x => x.id === turnId)!;
      expect(item.status).toBe("completed");
      const card = (item.messages ?? []).find((message) => message.card?.kind === "tool-group")?.card;
      if (card?.kind !== "tool-group") throw new Error("tool-group card missing");
      expect(card.status).toBe("unknown");
      expect(card.calls[0]?.status).toBe("unknown");
      expect(card.failedCalls).toBe(0);
    } finally { await h.cleanup(); }
  });
}

test("wrong turn envelope never contributes failure metadata", async () => {
  const h = await harness();
  try {
    const i = await h.send("wrong turn");
    h.pending[i]!.resolve({ turnId: "another-turn", text: null, failure: { kind: "engine" },
      runtime: "codex", usage: { complete: false } });
    await h.settle();
    const message = (await h.history()).find(x => x.id === h.requests[i]!.turnId)!.messages!.at(-1)!;
    expect(message.runtime).toBeUndefined(); expect(message.usage).toBeUndefined();
  } finally { await h.cleanup(); }
});

test("Host metadata is cloned before asynchronous history persistence", async () => {
  const h = await harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let atWrite = false;
  const settle = VoiceStateRepository.prototype.settleCommandHistory;
  const hook = spyOn(VoiceStateRepository.prototype, "settleCommandHistory").mockImplementation(async function (this: VoiceStateRepository, item) {
    atWrite = true;
    await gate;
    return settle.call(this, item);
  });
  try {
    const i = await h.send("clone before write");
    const usage = { complete: false };
    const outcome: AgentSendResult = { turnId: h.requests[i]!.turnId!, text: null,
      failure: { kind: "engine" }, runtime: "dsh", channel: "external-brain", usage };
    h.pending[i]!.resolve(outcome);
    await until(() => atWrite, "pause before actual repository write");
    usage.complete = true; outcome.runtime = "codex";
    release(); await h.settle();
    expect((await h.history()).find(x => x.id === h.requests[i]!.turnId)!.messages!.at(-1))
      .toMatchObject({ runtime: "dsh", channel: "external-brain", usage: { complete: false } });
  } finally { release(); hook.mockRestore(); await h.cleanup(); }
});

test("two live tasks resolving in reverse order retain their own metadata", async () => {
  const h = await harness(true);
  try {
    const first = await h.send("first pending");
    // Real presentation gate releases the foreground after 3s; no fake model/clock.
    await new Promise(resolve => setTimeout(resolve, 3100));
    await h.host.invokeCommand("com.reai.voice.back-to-root");
    h.root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
    Array.from(h.root.querySelectorAll<HTMLButtonElement>(".command-history-item"))
      .find(row => row.textContent?.includes("SECOND CONVERSATION"))!.click();
    await waitForConversationFixture(h.root);
    const second = await h.send("second pending");
    expect(h.requests[first]!.sessionId).toBe("session-a");
    expect(h.requests[second]!.sessionId).toBe("session-b");
    h.pending[second]!.resolve({ turnId: h.requests[second]!.turnId!, text: null,
      failure: { kind: "timeout" }, runtime: "codex", usage: { complete: false } });
    await h.settle();
    h.pending[first]!.resolve({ turnId: h.requests[first]!.turnId!, text: null,
      failure: { kind: "engine" }, runtime: "dsh", usage: { complete: false } });
    const deadline = Date.now() + 2000;
    let history: VoiceCommandHistoryItem[] = [];
    do { history = await h.history(); if (history.some(x => x.id === h.requests[first]!.turnId)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    expect(history.find(x => x.id === h.requests[first]!.turnId)!.messages!.at(-1))
      .toMatchObject({ runtime: "dsh", usage: { complete: false } });
    expect(history.find(x => x.id === h.requests[second]!.turnId)!.messages!.at(-1))
      .toMatchObject({ runtime: "codex", usage: { complete: false } });
  } finally { await h.cleanup(); }
});

/** Synthetic fixture waits for the actual asynchronous history/paint boundary. */
async function waitForConversationFixture(root: Element) {
 const end=Date.now()+2500; while(!root.querySelector(".main-body.chat-view,.main-body.translation-detail")&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(!!root.querySelector(".main-body.chat-view,.main-body.translation-detail")).toBeTrue();
}
