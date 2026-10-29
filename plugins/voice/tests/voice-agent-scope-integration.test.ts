import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { AgentApprovalSummary, AgentAttachmentAdmission, AgentAttachmentUploads, AgentServiceEvent, AgentTurnResult, AgentTurnStart, AppContext } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { COMMAND_HISTORY_KEY, DEFAULT_SETTINGS, VoiceStateRepository, type VoiceCommandHistoryItem } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";
import type { PendingAgentRequest } from "../src/agent-pending";
import type { VoiceConversationOptions } from "../src/agent-conversation";
import { resetFeatureRefSupportForTests } from "../src/agent-features";

/*
  F02 / F03 / F04 在真实 Voice 激活、挂载与聊天详情交互上的端到端行为（Host 用内存替身）：
  保留存量对话 Agent 选择、续接有界可见聊天、旧会话不提权、审批只显示等待；
  工作目录设置入口已按 2026-09-30 用户裁定移除，存量 direct 目录选择仍生效。
*/
let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 2500;
  while (!await check() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5));
  expect(await check()).toBeTrue();
}

type Config = { runtime?: string; tools: { ref: string }[]; workspace: { kind: string; path?: string }; mode?: string; memory?: string; systemPrompt?: string; featureRef?: string };
type Start = AgentTurnStart;
type LegacySend = { sessionId: string; turnId?: string; text: string };

/** 旧条目没有 conversationId：可见对话的键沿用它的会话 id（`conversationKey`）。 */
const SEED: VoiceCommandHistoryItem = {
  id: "seed", transcript: "原来的问题", reply: "PI_OLD_ANSWER", status: "completed", commandId: "voice.command.agent",
  agentSessionId: "pi-old", createdAt: "2026-09-20T09:00:00.000Z", messages: [
    { from: "user", text: "原来的问题", at: "2026-09-20T09:00:00.000Z" },
    { from: "ai", text: "PI_OLD_ANSWER", runtime: "pi", usage: { complete: true, inputTokens: 10, outputTokens: 2, totalTokens: 12 }, at: "2026-09-20T09:00:01.000Z" },
  ],
};

async function mount(options: {
  scopeProof?: boolean; unsupportedBackends?: string[]; pick?: () => Promise<string | undefined>;
  history?: VoiceCommandHistoryItem[]; choices?: Record<string, VoiceConversationOptions>; failSave?: boolean;
  rejectFirstStart?: boolean; rejectAttachmentCapability?: boolean;
  lostAcks?: number; knownSessions?: string[]; pending?: PendingAgentRequest[];
  readyAttachments?: boolean;
  localAttachmentAdmission?: AgentAttachmentAdmission;
} = {}) {
  document.body.replaceChildren();
  resetFeatureRefSupportForTests();
  let context!: AppContext;
  const configs: Config[] = [];
  const starts: Start[] = [];
  const legacy: LegacySend[] = [];
  const legacyPending: ((value: unknown) => void)[] = [];
  const waiting = new Map<string, (value: AgentTurnResult) => void>();
  const events = new Map<string, AgentServiceEvent[]>();
  const deleted: string[] = [];
  const runtimeOf = new Map<string, "pi" | "dsh" | "codex">();
  let picks = 0;
  let attachmentCapabilityReads = 0;
  const attachmentCalls: { method: string; sessionId: string; leaseId?: string }[] = [];
  const uploadStarts: Parameters<AgentAttachmentUploads["start"]>[0][] = [];
  const imageLeases = new Map<string, { owner: Parameters<AgentAttachmentUploads["start"]>[0]; bytes: Uint8Array }>();
  const attachmentSnapshot = { schemaVersion: 1 as const, opaqueBinding: "a".repeat(64), revision: 2,
    inputs: { text: true, image: true, nativePdf: false } };
  const readyAdmission: AgentAttachmentAdmission = { schemaVersion: 1, state: "ready", snapshot: attachmentSnapshot,
    readers: { text: true, extractedPdfText: true, extractedSpreadsheetText: true, images: true, nativePdf: false },
    transports: { textEnvelope: true, imageInput: true, nativePdfInput: false } };
  let emitAgentEvent: Parameters<AppContext["events"]["onLocalAgent"]>[0] | undefined;
  let rejectStart = options.rejectFirstStart ?? false;
  let lostAcks = options.lostAcks ?? 0;
  const ownedSessions = ["pi-old", ...(options.knownSessions ?? [])];
  const host = new MockHost({
    ownedConversationOpen: { accountGeneration: "t09-synthetic", packageDigest: "a".repeat(64), admitted: true, decision: "granted", userCeiling: "in_app", sessionIds: ownedSessions },
    manifest: structuredClone(manifest) as never,
    loadApp: async () => {
      const { default: app } = await import("../src/app?agent-scope=" + crypto.randomUUID());
      return { default: { ...app, async activate(ctx: AppContext) {
        context = ctx;
        const onLocalAgent = ctx.events.onLocalAgent.bind(ctx.events);
        ctx.events.onLocalAgent = (handler) => { emitAgentEvent = handler; return onLocalAgent(handler); };
        const store = ctx.storage.private("voice-state");
        await store.set("recognition-engine-choice-v1", "local");
        await store.set("settings", { ...DEFAULT_SETTINGS, polish: "raw" });
        if (options.choices) await store.set("command-conversation-options-v1", options.choices);
        await store.set(COMMAND_HISTORY_KEY, options.history ?? [SEED]);
        if (options.pending) await store.set("agent-pending-admissions-v2", options.pending);
        ctx.folderPick.pick = async () => { picks++; return options.pick ? options.pick() : "/Users/example/project"; };
        if (options.failSave) {
          const privateStore = ctx.storage.private.bind(ctx.storage);
          ctx.storage.private = name => {
            const target = privateStore(name);
            return { ...target, set: async (key, value) => {
              if (key === "command-conversation-options-v1") throw new Error("simulated storage failure");
              await target.set(key, value);
            } };
          };
        }
        if (options.rejectAttachmentCapability) Object.defineProperty(ctx.agent, "attachmentAdmission", { get() { attachmentCapabilityReads++; throw new Error("synthetic attachment cache unavailable"); } });
        Object.assign(ctx.agent, {
          backends: async () => ({ schemaVersion: 2, defaultBackend: "pi", backends: (["pi", "dsh", "codex"] as const).map(backend => ({
            backend, available: true, downloadRequired: false, detail: "",
            capabilities: { hostTools: true, fileTools: true, turnModes: ["chat", "plan", "yolo"], modelSelection: "host-settings",
              ...(options.readyAttachments ? { configuration: { attachmentInputVersion: 1, featureRef: true } } : {}),
              ...(options.unsupportedBackends?.includes(backend) ? {} : { scopedExecutionVersion: 1, commandExecution: true }) },
          })) }),
          createSession: async (config: Config) => {
            configs.push(structuredClone(config));
            const sessionId = `agent2-new-${configs.length}`;
            ownedSessions.push(sessionId);
            const runtime = config.runtime === "dsh" || config.runtime === "codex" ? config.runtime : "pi";
            runtimeOf.set(sessionId, runtime);
            // 范围执行的会话以文件工具为标志：`command` 只在 yolo 档申请，不能拿它判定。
            const scoped = config.tools.some(tool => tool.ref === "read");
            return { schemaVersion: 2, sessionId, backend: runtime, runtime,
              ...(options.scopeProof === false || !scoped ? {} : {
                workspace: config.workspace,
                workspaceRoot: config.workspace.kind === "direct" ? config.workspace.path : "/Host/private/workspace",
                scopeVersion: 1,
              }) };
          },
          listSessions: async () => ({ sessions: [
            ...(options.knownSessions ?? []).map(sessionId => ({ sessionId, memory: "session", createdMs: 1, updatedMs: 1, stale: false })),
            { sessionId: "pi-old", memory: "session", createdMs: 1, updatedMs: 1, stale: false },
            ...[...runtimeOf].map(([sessionId, backend]) => ({ sessionId, backend, runtime: backend, memory: "session", createdMs: 1, updatedMs: 1, stale: false })),
          ] }),
          startTurn: async (input: Start) => {
            starts.push(structuredClone(input));
            if (lostAcks-- > 0) throw new TypeError("synthetic missing ACK");
            if (rejectStart) { rejectStart = false; throw Object.assign(new Error("admission rejected"), { code: "AGENT_BACKEND_UNAVAILABLE", retryable: false }); }
            return { schemaVersion: 2, sessionId: input.sessionId, turnId: `native-${starts.length}`, runtime: runtimeOf.get(input.sessionId) ?? "pi",
              status: "running", expired: false, result: null, createdAt: 1, updatedAt: 1 };
          },
          events: async ({ sessionId, turnId }: { sessionId: string; turnId: string }) => ({ schemaVersion: 2, sessionId, turnId, runtime: runtimeOf.get(sessionId) ?? "pi",
            status: "running", expired: false, result: null, createdAt: 1, updatedAt: 1, events: events.get(turnId) ?? [], gap: false, nextSequence: events.get(turnId)?.length ?? 0 }),
          waitForTurn: async ({ turnId }: { turnId: string }) => new Promise<AgentTurnResult>(resolve => waiting.set(turnId, resolve)),
          cancel: async () => ({ cancelled: true }),
          deleteSession: async ({ sessionId }: { sessionId: string }) => { deleted.push(sessionId); return { deleted: true }; },
          send: async (input: LegacySend) => { legacy.push(structuredClone(input)); return new Promise(resolve => legacyPending.push(resolve)); },
        });
        if (options.readyAttachments) {
          ctx.agent.attachmentAdmission = async ({ sessionId }) => {
            attachmentCapabilityReads++;
            attachmentCalls.push({ method: "read", sessionId });
            expect(runtimeOf.has(sessionId)).toBeTrue();
            return structuredClone(options.localAttachmentAdmission ?? readyAdmission);
          };
          const ownedImage = (request: Parameters<AgentAttachmentUploads["finish"]>[0]) => {
            const lease = imageLeases.get(request.leaseId);
            expect(lease).toBeDefined();
            expect(request.sessionId).toBe(lease!.owner.sessionId);
            expect(request.admission).toEqual(lease!.owner.admission);
            return lease!;
          };
          ctx.agent.attachmentUploads = {
            async start(request) {
              // 图片上传归属发起会话；Agent 由 Host 决定，这里的 mock 一律解析成 pi。
              expect(runtimeOf.get(request.sessionId)).toBe("pi");
              expect(request.admission).toEqual({ schemaVersion: 1, opaqueBinding: attachmentSnapshot.opaqueBinding,
                revision: attachmentSnapshot.revision, modes: ["image"] });
              expect([...imageLeases.values()].some(lease => lease.bytes.length < lease.owner.byteLength)).toBeFalse();
              const leaseId = (uploadStarts.length + 1).toString(16).padStart(64, "0");
              uploadStarts.push(structuredClone(request));
              imageLeases.set(leaseId, { owner: structuredClone(request), bytes: new Uint8Array() });
              attachmentCalls.push({ method: "start", sessionId: request.sessionId, leaseId });
              return { schemaVersion: 1, leaseId, chunkBytes: 262144 };
            },
            async chunk(request) {
              const lease = ownedImage(request);
              expect(request.index * 262144).toBe(lease.bytes.length);
              const chunk = Uint8Array.from(atob(request.base64), value => value.charCodeAt(0));
              const next = new Uint8Array(lease.bytes.length + chunk.length);
              next.set(lease.bytes); next.set(chunk, lease.bytes.length); lease.bytes = next;
              attachmentCalls.push({ method: "chunk", sessionId: request.sessionId, leaseId: request.leaseId });
              return { schemaVersion: 1, ok: true };
            },
            async finish(request) {
              const lease = ownedImage(request);
              expect(lease.bytes.length).toBe(lease.owner.byteLength);
              const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", lease.bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
              expect(actualHash).toBe(lease.owner.sha256);
              attachmentCalls.push({ method: "finish", sessionId: request.sessionId, leaseId: request.leaseId });
              return { schemaVersion: 1, part: { kind: "image", name: lease.owner.name, mimeType: lease.owner.mimeType,
                leaseId: request.leaseId, sha256: lease.owner.sha256, byteLength: lease.owner.byteLength } };
            },
            async cancel(request) {
              ownedImage(request);
              attachmentCalls.push({ method: "cancel", sessionId: request.sessionId, leaseId: request.leaseId });
              imageLeases.delete(request.leaseId);
              return { schemaVersion: 1, ok: true };
            },
          };
        }
        return app.activate(ctx);
      } } };
    },
    createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; },
  });
  await host.installAndEnable();
  const { root: surface } = await host.openSurface("main");
  const root = surface!;
  root.querySelector<HTMLButtonElement>('[data-voice-tab="command"]')!.click();
  root.querySelector<HTMLButtonElement>(".command-history-item")!.click();
    await waitForConversationFixture(root);
  const finish = (index: number, result: Partial<AgentTurnResult>) => {
    const start = starts[index]!;
    const turnId = `native-${index + 1}`;
    waiting.get(turnId)!({ schemaVersion: 2, sessionId: start.sessionId, turnId, runtime: runtimeOf.get(start.sessionId) ?? "pi",
      channel: "external-brain", status: "completed", text: null, content: [], usage: null, toolAttempts: [], failure: null, ...result } as AgentTurnResult);
  };
  return {
    root, host, configs, starts, legacy, legacyPending, deleted, events, finish, attachmentCalls, uploadStarts,
    picks: () => picks, attachmentCapabilityReads: () => attachmentCapabilityReads,
    emit: (event: AgentServiceEvent) => { expect(emitAgentEvent).toBeDefined(); emitAgentEvent!(event as never); },
    waitingFor: (turnId: string) => waiting.has(turnId),
    load: () => new VoiceStateRepository(context.storage.private("voice-state")).load(),
    send: (text: string) => {
      const input = root.querySelector<HTMLInputElement>(".chat-input")!;
      expect(input.disabled).toBeFalse();
      input.value = text; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    },
    settle: () => until(() => root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false),
    close: async () => {
      for (const [, resolve] of waiting) resolve({ schemaVersion: 2, sessionId: "", turnId: "", runtime: "pi", channel: "external-brain", status: "cancelled", text: null, content: [], usage: null, toolAttempts: [], failure: { kind: "killed", code: "AGENT_CANCELLED", stage: "cancel", retry: "new-turn", message: "" } } as unknown as AgentTurnResult);
      legacyPending.forEach(resolve => resolve({ turnId: "", text: null, failure: { kind: "killed" } }));
      await host.disable();
    },
  };
}

const failure = { kind: "engine", code: "AGENT_RUNTIME_FAILED", stage: "runtime", retry: "new-turn", message: "engine failed" } as unknown as AgentTurnResult["failure"];

test("存量对话第一次升级到 v2 会话：新会话带 16 项工具（chat 不申请 command）、没有拨杆信息按 chat，第一条续接可见聊天；受理后失败的重试不重放背景", async () => {
  const h = await mount({ choices: { "pi-old": {} } });
  try {
    h.send("新的问题");
    await until(() => h.starts.length === 1);
    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]).toMatchObject({ runtime: "auto", mode: "chat", workspace: { kind: "app-private" } });
    // Host 的工具 × 档位矩阵只在 yolo 接受 command；chat 会话带上它会在建会话时被拒。
    expect(h.configs[0]!.tools).toHaveLength(16);
    expect(h.configs[0]!.tools.map(tool => tool.ref)).toEqual(expect.arrayContaining(["read", "write", "edit", "list", "glob", "grep"]));
    expect(h.configs[0]!.tools.map(tool => tool.ref)).not.toContain("command");
    expect(h.starts[0]!.text).toContain("PI_OLD_ANSWER");
    expect(h.starts[0]!.text).toContain("不重放已执行动作");
    // 工具卡、用量等元数据永远不进续接种子；用户界面也看不到这段引用资料。
    expect(h.starts[0]!.text).not.toContain("totalTokens");
    expect(h.root.textContent).not.toContain("此前可见聊天");
    // 受理之后才失败：上下文已进入新会话的记录。
    await until(() => h.waitingFor("native-1"));
    h.finish(0, { status: "failed", failure });
    await h.settle();
    expect((await h.load()).conversationOptions["pi-old"]?.continuationPending).toBeUndefined();
    h.send("继续，只处理这句话");
    await until(() => h.starts.length === 2);
    expect(h.configs).toHaveLength(1);
    expect(h.starts[1]!.sessionId).toBe(h.starts[0]!.sessionId);
    expect(h.starts[1]!.text).toBe("继续，只处理这句话");
    await until(() => h.waitingFor("native-2"));
    h.finish(1, { text: "DSH_NEW_ANSWER" });
    await h.settle();
    const loaded = await h.load();
    // 只改本对话，不写 Driver 全局默认；旧条目的运行归属与用量原样保留。
    expect(loaded.conversationOptions["pi-old"]).toMatchObject({ resolvedBackend: "pi", sessionId: "agent2-new-1", scopeVersion: 1 });
    expect(loaded.commandHistory!.find(item => item.id === "seed")).toMatchObject({ agentSessionId: "pi-old" });
    expect(loaded.commandHistory!.find(item => item.id === "seed")!.messages!.at(-1)).toMatchObject({ runtime: "pi", usage: { totalTokens: 12 } });
    expect(loaded.commandHistory!.filter(item => item.conversationId === "pi-old" || item.id === "seed")).toHaveLength(3);
    expect(h.root.textContent).toContain("PI_OLD_ANSWER");
    expect(h.root.textContent).toContain("DSH_NEW_ANSWER");
    expect(h.legacy).toHaveLength(0);
  } finally { await h.close(); }
});

test("纯文本双 ACK 丢失后显式恢复沿用原正文和幂等键", async () => {
  const h = await mount({ choices: { "pi-old": {} }, lostAcks: 2 });
  try {
    h.send("SYNTHETIC_ACK_MARKER");
    await until(() => h.starts.length === 2 && Boolean(h.root.querySelector(".chat-retry-request")));
    h.root.querySelector<HTMLButtonElement>(".chat-retry-request")!.click();
    await until(() => h.starts.length === 3 && h.waitingFor("native-3"));
    expect(h.starts[2]).toEqual(h.starts[0]);
    expect(h.starts[2]!.text.split("SYNTHETIC_ACK_MARKER")).toHaveLength(2);
    expect(Object.keys(h.starts[2]!)).not.toContain("attachments");
    h.finish(2, { text: "recovered synthetic content" });
    await h.settle();
    const loaded = await h.load();
    const recovered = loaded.commandHistory!.find(item => item.reply === "recovered synthetic content")!;
    expect(recovered.messages?.find(message => message.from === "user")?.attachments).toBeUndefined();
    expect(h.configs).toHaveLength(1);
  } finally { await h.close(); }
});


test("historical attachment receipt recovery cannot bypass unknown model admission", async () => {
  const request = { sessionId: "agent2-historical", idempotencyKey: "synthetic-historical-key", text: "SYNTHETIC_HISTORICAL_ATTACHMENT", taskPresentation: "caller" as const };
  const item: VoiceCommandHistoryItem = { ...SEED, id: "synthetic-historical-task", agentSessionId: request.sessionId,
    status: "failed", errorCode: "AGENT_RECEIPT_UNKNOWN", agentRequestKey: "synthetic-historical-task", reply: undefined,
    messages: [{ from: "user", text: "synthetic question", at: SEED.createdAt,
      attachments: [{ kind: "file", name: "synthetic.txt", meta: "Plain text · 30 bytes" }] }],
  };
  const h = await mount({ history: [item], knownSessions: [request.sessionId],
    pending: [{ taskId: item.id, createdAt: Date.now(), cancelled: false, request }] });
  try {
    await until(() => Boolean(h.root.querySelector(".chat-retry-request")));
    h.root.querySelector<HTMLButtonElement>(".chat-retry-request")!.click();
    await until(() => h.root.textContent?.includes("尚未确认当前 Agent 模型的附件支持能力") === true);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.configs).toHaveLength(0);
    expect(h.root.querySelector<HTMLInputElement>(".chat-input")!.disabled).toBeFalse();
    expect(h.root.querySelector(".chat-retry-request")).not.toBeNull();
    expect((await h.load()).commandHistory!.find(row => row.id === item.id)?.errorCode).toBe("AGENT_RECEIPT_UNKNOWN");
  } finally { await h.close(); }
});

test("切换后的第一条在 Host 受理前就失败：同一会话的重试仍附上续接上下文，受理后才清标记", async () => {
  const h = await mount({ rejectFirstStart: true, choices: { "pi-old": {} } });
  try {
    h.send("第一次尝试");
    await until(() => h.starts.length === 1);
    await h.settle();
    expect(h.starts[0]!.text).toContain("PI_OLD_ANSWER");
    expect((await h.load()).conversationOptions["pi-old"]).toMatchObject({ sessionId: "agent2-new-1", continuationPending: true });
    h.send("再试一次");
    await until(() => h.starts.length === 2);
    expect(h.configs).toHaveLength(1);
    expect(h.starts[1]!.sessionId).toBe("agent2-new-1");
    expect(h.starts[1]!.text).toContain("PI_OLD_ANSWER");
    expect(h.starts[1]!.text).toContain("再试一次");
    await until(async () => (await h.load()).conversationOptions["pi-old"]?.continuationPending === undefined);
    await until(() => h.waitingFor("native-2"));
    h.finish(1, { text: "CODEX_ANSWER" });
    await h.settle();
    h.send("第三句");
    await until(() => h.starts.length === 3);
    expect(h.starts[2]!.text).toBe("第三句");
  } finally { await h.close(); }
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale} 对话详情不再提供 Agent 展示条与更换入口，也不提供工作目录入口`, async () => {
    setVoiceLocale(locale);
    const h = await mount({ choices: { "pi-old": { resolvedBackend: "dsh" } } });
    try {
      expect(h.root.querySelector(".chat-folder-pick, .chat-scope-path")).toBeNull();
      expect(h.root.querySelector(".chat-scope, .chat-current-agent, .chat-scope-toggle, .chat-agent-select")).toBeNull();
      expect(h.root.textContent).not.toMatch(/当前 Agent|更换 Agent|Current Agent|Change Agent|工作目录/);
      expect(h.root.textContent).toContain("PI_OLD_ANSWER");
      expect(h.root.querySelector<HTMLInputElement>(".chat-input")?.disabled).toBeFalse();
      expect(h.root.querySelector<HTMLButtonElement>(".chat-mic")?.disabled).toBeFalse();
      expect((await h.load()).conversationOptions["pi-old"]).toMatchObject({ resolvedBackend: "dsh" });
      expect(h.picks()).toBe(0);
    } finally { await h.close(); setVoiceLocale("zh"); }
  });
}

test("存量对话此前选过的 direct 工作目录仍生效：撤的只是 UI 入口，不清洗既有选择", async () => {
  const h = await mount({ choices: { "pi-old": { workspace: { kind: "direct", path: "/Users/example/project" } } } });
  try {
    h.send("写入一个测试文件");
    await until(() => h.starts.length === 1);
    expect(h.configs[0]).toMatchObject({ runtime: "auto", workspace: { kind: "direct", path: "/Users/example/project" }, mode: "chat" });
    expect(h.picks()).toBe(0);
  } finally { await h.close(); }
});

test("Host 没给范围执行证明时，显式选了目录的会话不发任何模型请求并删掉刚建的会话", async () => {
  const h = await mount({ scopeProof: false, choices: { "pi-old": { workspace: { kind: "direct", path: "/Users/example/project" } } } });
  try {
    h.send("write a file");
    await until(() => h.configs.length === 1);
    await h.settle();
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.deleted).toContain("agent2-new-1");
  } finally { await h.close(); }
});

test("没改过选择的旧对话继续用原会话：不新建会话、不追加文件与命令工具", async () => {
  const h = await mount();
  try {
    h.send("继续原来的聊天");
    await until(() => h.legacy.length === 1);
    expect(h.configs).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy[0]).toMatchObject({ sessionId: "pi-old", text: "继续原来的聊天" });
  } finally { await h.close(); }
});

test("显式选了目录但当前平台没有范围执行：零 create/send，也不偷换成别的工作范围", async () => {
  const h = await mount({ unsupportedBackends: ["pi"], choices: { "pi-old": { workspace: { kind: "direct", path: "/Users/example/project" } } } });
  try {
    h.send("读取文件");
    await h.settle();
    expect(h.configs).toHaveLength(0);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.root.querySelector(".chat-send-error")).not.toBeNull();
    expect((await h.load()).conversationOptions["pi-old"]?.workspace).toEqual({ kind: "direct", path: "/Users/example/project" });
  } finally { await h.close(); }
});

test("越界审批只显示「等待 Host 确认」：挂在正在运行的那条上，插件里没有批准入口；解决后消失", async () => {
  const h = await mount({ choices: { "pi-old": {} } });
  try {
    h.send("改一下项目外的文件");
    await until(() => h.waitingFor("native-1"));
    expect(h.root.querySelector(".chat-approval-status")).toBeNull();
    const approval: AgentApprovalSummary = { id: "approval-1", sessionId: "agent2-new-1", turnId: "native-1", toolCallId: "call-1",
      actionDigest: "d".repeat(64), description: "write: /outside/file", paths: [{ path: "/outside/file", write: true }],
      status: "pending", createdMs: 1, expiresMs: Date.now() + 120_000 };
    const event = (sequence: number, type: "approval.requested" | "approval.resolved", status: AgentApprovalSummary["status"]) =>
      ({ ...approval, status, schemaVersion: 2, sessionId: "agent2-new-1", turnId: "native-1", runtime: "pi", type, sequence, timestamp: sequence }) as unknown as AgentServiceEvent;
    h.emit(event(1, "approval.requested", "pending"));
    await until(() => h.root.querySelector(".chat-approval-status") !== null);
    const status = h.root.querySelector(".chat-approval-status")!;
    expect(status.getAttribute("role")).toBe("status");
    // 插件界面里不存在任何批准 / 允许按钮。
    const labels = Array.from(h.root.querySelectorAll("button"), button => button.textContent ?? "");
    expect(labels.some(label => /允许|批准|Allow|Approve/.test(label))).toBeFalse();
    h.emit(event(2, "approval.resolved", "denied"));
    await until(() => h.root.querySelector(".chat-approval-status") === null);
  } finally { await h.close(); }
});

function selectSyntheticFiles(root: HTMLElement, files: { name: string; type: string; content: string | Uint8Array; read?: () => Promise<ArrayBuffer> }[]) {
  const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
  const selected = files.map(({ name, type, content, read }) => {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    return { name, type, size: bytes.byteLength, arrayBuffer: read ?? (async () => bytes.buffer) };
  });
  Object.defineProperty(input, "files", { configurable: true, value: selected });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// Without a confirmed current capability the visible entry is absent. A synthetic
// event on the hidden native picker still cannot bypass the local admission gate.
for (const format of ["txt", "html", "pdf", "xlsx", "xls", "png"] as const) test(`unknown ${format} admission hides plus and rejects before file read or Agent dispatch`, async () => {
  const h = await mount({ choices: { "pi-old": { workspace: { kind: "direct", path: "/Users/example/project" } } } });
  try {
    expect(h.root.querySelector(".chat-attach")).toBeNull();
    let reads = 0;
    selectSyntheticFiles(h.root, [{ name: `synthetic.${format}`, type: "", content: "SYNTHETIC_UNCONFIRMED_MARKER", read: async () => { reads++; return new TextEncoder().encode("SYNTHETIC_UNCONFIRMED_MARKER").buffer as ArrayBuffer; } }]);
    await until(() => h.root.textContent?.includes("尚未确认当前 Agent 模型的附件支持能力") === true);
    expect(reads).toBe(0);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.configs).toHaveLength(0);
    expect(h.root.querySelector<HTMLInputElement>(".chat-input")!.disabled).toBeFalse();
    h.root.querySelector<HTMLInputElement>(".chat-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(h.starts).toHaveLength(0);
    // Rejected selection adds no card and does not prevent a later plain question.
    expect(h.root.querySelectorAll(".chat-draft-file")).toHaveLength(0);
    h.send("plain follow-up after rejected attachment");
    await until(() => h.starts.length === 1 && h.waitingFor("native-1"));
    expect(h.starts[0]!.text).not.toContain("SYNTHETIC_UNCONFIRMED_MARKER");
    h.finish(0, { text: "synthetic plain text receipt" });
    await h.settle();
  } finally { await h.close(); }
});

// These exercise actual Voice activate -> view -> preparation -> coordinator
// with an in-memory Host. They prove typed routing, not provider vision or OAuth.
for (const reason of ["not-initialized", "readers-disabled"] as const) test(`implemented attachment descriptor with ${reason} still hides plus and reads no file bytes`, async () => {
  const localAttachmentAdmission: AgentAttachmentAdmission = reason === "not-initialized"
    ? { schemaVersion: 1, state: "not-initialized", errorCode: "AGENT_ATTACHMENT_UNCONFIRMED" }
    : { schemaVersion: 1, state: "ready", snapshot: { schemaVersion: 1, opaqueBinding: "a".repeat(64), revision: 2,
      inputs: { text: true, image: true, nativePdf: false } },
      readers: { text: false, extractedPdfText: false, extractedSpreadsheetText: false, images: false, nativePdf: false },
      transports: { textEnvelope: true, imageInput: true, nativePdfInput: false } };
  const h = await mount({ readyAttachments: true, localAttachmentAdmission, choices: { "pi-old": {} } });
  try {
    await until(() => h.attachmentCapabilityReads() > 0);
    expect(h.root.querySelector(".chat-attach")).toBeNull();
    let fileReads = 0;
    selectSyntheticFiles(h.root, [{ name: "closed.txt", type: "text/plain", content: "CLOSED_ATTACHMENT_MARKER",
      read: async () => { fileReads++; return new TextEncoder().encode("CLOSED_ATTACHMENT_MARKER").buffer as ArrayBuffer; } }]);
    await until(() => h.root.textContent?.includes("尚未确认当前 Agent 模型的附件支持能力") === true);
    expect(fileReads).toBe(0);
    expect(h.starts).toHaveLength(0);
    expect(h.uploadStarts).toHaveLength(0);
    expect(h.root.querySelectorAll(".chat-draft-file")).toHaveLength(0);
    expect(h.root.querySelector<HTMLInputElement>(".chat-input")?.disabled).toBeFalse();
  } finally { await h.close(); }
});

test("confirmed Task text/HTML enters the owned v2 session once as typed untrusted data", async () => {
  const h = await mount({ readyAttachments: true, choices: { "pi-old": {} } });
  try {
    await until(() => Boolean(h.root.querySelector(".chat-attach")));
    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]).toMatchObject({ runtime: "auto", featureRef: "command", workspace: { kind: "app-private" } });
    expect(h.starts).toHaveLength(0);
    const html = '<h1>HTML_REFERENCE_MARKER</h1><script>globalThis.__voiceSyntheticScriptRan = true</script>';
    selectSyntheticFiles(h.root, [
      { name: "synthetic.txt", type: "text/plain", content: "TXT_REFERENCE_MARKER" },
      { name: "synthetic.html", type: "text/html", content: html },
    ]);
    await until(() => h.root.querySelectorAll(".chat-draft-file").length === 2
      && h.root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false);
    expect((globalThis as { __voiceSyntheticScriptRan?: boolean }).__voiceSyntheticScriptRan).toBeUndefined();
    h.send("Compare both references.");
    await until(() => h.starts.length === 1 && h.waitingFor("native-1"));
    expect(h.starts[0]).toMatchObject({ sessionId: "agent2-new-1", taskPresentation: "caller", attachmentInput: {
      schemaVersion: 1, admission: { schemaVersion: 1, opaqueBinding: "a".repeat(64), revision: 2, modes: ["text"] },
      parts: [
        { kind: "text", mode: "text", name: "synthetic.txt", mimeType: "text/plain", text: "TXT_REFERENCE_MARKER" },
        { kind: "text", mode: "text", name: "synthetic.html", mimeType: "text/html", text: html },
      ],
    } });
    expect(h.starts[0]!.text).toContain("PI_OLD_ANSWER");
    expect(h.starts[0]!.text.split("Compare both references.")).toHaveLength(2);
    expect(h.starts[0]!.text).not.toContain("TXT_REFERENCE_MARKER");
    expect(h.starts[0]!.text).not.toContain("HTML_REFERENCE_MARKER");
    expect(h.uploadStarts).toHaveLength(0);
    h.finish(0, { text: "Synthetic typed text answer" });
    await h.settle();
    const saved = await h.load();
    const entry = saved.commandHistory!.find(item => item.reply === "Synthetic typed text answer")!;
    expect(entry.messages?.find(message => message.from === "user")?.attachments?.map(file => file.name))
      .toEqual(["synthetic.txt", "synthetic.html"]);
    expect(JSON.stringify(saved.commandHistory)).not.toContain("TXT_REFERENCE_MARKER");
    expect(JSON.stringify(saved.commandHistory)).not.toContain("HTML_REFERENCE_MARKER");
    expect(h.configs).toHaveLength(1);
    expect(h.legacy).toHaveLength(0);
  } finally { await h.close(); }
});

const SYNTHETIC_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), value => value.charCodeAt(0));

test("confirmed Task uploads two images sequentially and navigation does not cancel admitted leases", async () => {
  const h = await mount({ readyAttachments: true, choices: { "pi-old": {} } });
  try {
    await until(() => Boolean(h.root.querySelector(".chat-attach")));
    selectSyntheticFiles(h.root, [
      { name: "first.png", type: "image/png", content: SYNTHETIC_PNG },
      { name: "second.png", type: "image/png", content: SYNTHETIC_PNG },
    ]);
    await until(() => h.attachmentCalls.filter(call => call.method === "finish").length === 2
      && h.root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false);
    expect(h.attachmentCalls.filter(call => call.method !== "read").map(call => call.method))
      .toEqual(["start", "chunk", "finish", "start", "chunk", "finish"]);
    const leases = h.attachmentCalls.filter(call => call.method === "start").map(call => {
      expect(call.leaseId).toBeDefined();
      return call.leaseId!;
    });
    expect(new Set(leases).size).toBe(2);
    h.send("Compare these synthetic images.");
    await until(() => h.starts.length === 1 && h.waitingFor("native-1"));
    expect(h.starts[0]!.attachmentInput?.admission.modes).toEqual(["image"]);
    expect(h.starts[0]!.attachmentInput?.parts).toEqual(h.uploadStarts.map((start, index) => ({
      kind: "image", name: start.name, mimeType: start.mimeType, byteLength: start.byteLength,
      sha256: start.sha256, leaseId: leases[index],
    })));
    expect(h.starts[0]!.text).not.toContain("data:image");
    expect(JSON.stringify(h.starts[0]!.attachmentInput)).not.toContain("base64");
    expect((await h.host.invokeCommand("com.reai.voice.back-to-root", {})).ok).toBeTrue();
    expect(h.root.querySelector(".chat-input")).toBeNull();
    expect(h.attachmentCalls.filter(call => call.method === "cancel")).toHaveLength(0);
    h.finish(0, { text: "Synthetic image input receipt" });
    await until(async () => (await h.load()).commandHistory?.some(item => item.reply === "Synthetic image input receipt") === true);
    expect(h.attachmentCalls.filter(call => call.method === "cancel")).toHaveLength(0);
  } finally { await h.close(); }
});

test("typed image double ACK recovery preserves the exact lease identity without uploading again", async () => {
  const h = await mount({ readyAttachments: true, choices: { "pi-old": {} }, lostAcks: 2 });
  try {
    await until(() => Boolean(h.root.querySelector(".chat-attach")));
    selectSyntheticFiles(h.root, [{ name: "recover.png", type: "image/png", content: SYNTHETIC_PNG }]);
    await until(() => h.attachmentCalls.some(call => call.method === "finish")
      && h.root.querySelector<HTMLInputElement>(".chat-input")?.disabled === false);
    h.send("Recover this exact synthetic image request.");
    await until(() => h.starts.length === 2 && Boolean(h.root.querySelector(".chat-retry-request")));
    expect(h.starts[0]).toEqual(h.starts[1]);
    const beforeRecovery = structuredClone(h.starts[0]);
    h.root.querySelector<HTMLButtonElement>(".chat-retry-request")!.click();
    await until(() => h.starts.length === 3 && h.waitingFor("native-3"));
    expect(h.starts[2]).toEqual(beforeRecovery);
    expect(h.uploadStarts).toHaveLength(1);
    expect(h.configs).toHaveLength(1);
    expect(h.attachmentCalls.filter(call => call.method === "cancel")).toHaveLength(0);
    h.finish(2, { text: "Synthetic recovered image receipt" });
    await h.settle();
    expect((await h.load()).commandHistory?.find(item => item.reply === "Synthetic recovered image receipt")?.agentSessionId)
      .toBe(beforeRecovery.sessionId);
  } finally { await h.close(); }
});

// Extraction and frozen text-envelope positive cases are exercised directly in
// voice-document-extraction / voice-attachment-content tests. They are preparation
// evidence, not proof of a real model's PDF/Excel capability or raw-file access.

test("failed translation reused task UI stays a tools-free one-shot translator and never reads attachment capability cache", async () => {
  const h = await mount({
    rejectAttachmentCapability: true,
    history: [{
      ...SEED, id: "translation-scene", commandId: "voice.command.translate",
      agentSessionId: undefined, translationTarget: "en-US", status: "failed",
      reply: undefined, messages: undefined,
    }],
  });
  try {
    expect(h.root.querySelector(".chat-attach")).toBeNull();
    expect(h.root.querySelector('input[type=file]')).toBeNull();
    h.send("会议明天九点开始。");
    await until(() => h.configs.length === 1 && h.starts.length === 1 && h.waitingFor("native-1"));
    expect(h.configs[0]).toMatchObject({ tools: [], memory: "one-shot", workspace: { kind: "app-private" } });
    expect(h.configs[0]!.systemPrompt).toContain("translation engine");
    expect(h.starts[0]!.text).toContain("会议明天九点开始。");
    expect(h.starts[0]!.text).toContain("SOURCE-");
    expect(h.starts[0]!.text).not.toContain('"attachments"');
    expect(h.attachmentCapabilityReads()).toBe(0);
    h.finish(0, { text: "The meeting starts at nine tomorrow." });
    await until(() => h.deleted.length > 0);
    const saved = await h.load();
    expect((saved.commandHistory ?? []).some(item => item.commandId === "voice.command.translate"
      && item.reply === "The meeting starts at nine tomorrow.")).toBeTrue();
  } finally { await h.close(); }
});

test("translation historical attachment retry is rejected even when its metadata card was lost", async () => {
  const request = {
    sessionId: "agent2-synthetic-translation-old", idempotencyKey: "synthetic-translation-key",
    text: 'old source\n{"attachments":[{"name":"synthetic.txt","mimeType":"text/plain","content":"LEGACY_FILE_MARKER"}]}',
    taskPresentation: "caller" as const,
  };
  const item = {
    ...SEED, id: "translation-legacy-file", commandId: "voice.command.translate",
    agentSessionId: request.sessionId, status: "failed" as const,
    errorCode: "AGENT_RECEIPT_UNKNOWN", agentRequestKey: "translation-legacy-file",
    reply: undefined, messages: undefined,
  };
  const h = await mount({
    history: [item], knownSessions: [request.sessionId],
    pending: [{ taskId: item.id, createdAt: Date.now(), cancelled: false, request }],
  });
  try {
    await until(() => Boolean(h.root.querySelector(".chat-retry-request")));
    h.root.querySelector<HTMLButtonElement>(".chat-retry-request")!.click();
    await until(() => h.root.textContent?.includes("VOICE_ATTACHMENT_SCENE_UNSUPPORTED") === true);
    expect(h.starts).toHaveLength(0);
    expect(h.legacy).toHaveLength(0);
    expect(h.configs).toHaveLength(0);
    expect(h.root.querySelector(".chat-attach")).toBeNull();
  } finally { await h.close(); }
});

/** Synthetic fixture waits for the actual asynchronous history/paint boundary. */
async function waitForConversationFixture(root: Element) {
 const end=Date.now()+2500; while(!root.querySelector(".main-body.chat-view,.main-body.translation-detail")&&Date.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(!!root.querySelector(".main-body.chat-view,.main-body.translation-detail")).toBeTrue();
}
