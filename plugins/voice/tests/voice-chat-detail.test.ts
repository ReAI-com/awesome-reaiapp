import { setVoiceLocale } from "../src/voice-i18n";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultVoiceViewState,
  type VoiceCommandHistoryItem,
  type VoiceViewState,
} from "../src/data";
import { mountVoiceView, type VoiceViewActions } from "../src/voice-view";

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

function commandItem(overrides: Partial<VoiceCommandHistoryItem> = {}): VoiceCommandHistoryItem {
  return {
    id: "2026-08-18T03:00:00.000Z-command",
    transcript: "帮我查一下明天北京到上海的高铁时刻表",
    status: "completed",
    createdAt: "2026-08-18T03:00:00.000Z",
    reply: "最早一班 G6 次 06:20 出发，10:38 到达上海虹桥。",
    durationMs: 42_000,
    ...overrides,
  };
}

interface Harness {
  root: HTMLElement;
  update(state: VoiceViewState): void;
  dispose(): void;
  /** B5-14 后「离开对话页」的工具：页内返回钮已撤，走面包屑同款 navigateRoot。 */
  navigateRoot(): void;
  /** 输入坞「发送」收到的文本，按发出顺序。 */
  sent: string[];
  cancelledCommands: string[];
  releaseCancel(): void;
  /** 输入坞麦克风触发 onDictateDraft 的次数。 */
  dictations: () => number;
  /** 对话页收口时触发 onDictateCancel 的次数。 */
  dictateCancels: () => number;
  /** 输入坞已经消费或明确丢弃的语音结果 session。 */
  acknowledgedResults: string[];
  browserInstallRetries: VoiceCommandHistoryItem[];
  openedSourceLinks: string[];
  /** 控制「发送」什么时候算发起成功（命令工作流起跑）。 */
  releaseSend: (taskId?: string) => void;
  rejectSend: (cause: unknown) => void;
  /** 让最近一次 onDictateDraft 以这个结果收敛。 */
  resolveDictation(result: { phase: "listening"; sessionId?: string } | {
    phase: "idle";
    transcript: string;
    sessionId?: string;
    outcome?: "recognized" | "cancelled";
  }): void;
  rejectDictation(cause: unknown): void;
}

function mount(overrides: Partial<VoiceViewState> = {}, openSource?: (url: string) => Promise<void>): Harness {
  const root = document.createElement("div");
  document.body.append(root);
  const harness: Harness = {
    root,
    update: () => undefined,
    dispose: () => undefined,
    sent: [],
    cancelledCommands: [],
    releaseCancel: () => undefined,
    dictations: () => 0,
    dictateCancels: () => 0,
    acknowledgedResults: [],
    browserInstallRetries: [],
    openedSourceLinks: [],
    releaseSend: () => undefined,
    rejectSend: () => undefined,
    resolveDictation: () => undefined,
    rejectDictation: () => undefined,
    navigateRoot: () => undefined,
  };
  let settleSend: ((taskId: string) => void) | undefined;
  let failSend: ((cause: unknown) => void) | undefined;
  let settleCancel: (() => void) | undefined;
  let dictations = 0;
  let dictateCancels = 0;
  let settleDictation: ((result: { phase: "listening"; sessionId?: string } | {
    phase: "idle";
    transcript: string;
    sessionId?: string;
    outcome?: "recognized" | "cancelled";
  }) => void) | undefined;
  let failDictation: ((cause: unknown) => void) | undefined;
  const actions = {
    onToggle: async () => undefined,
    onCommandToggle: async () => undefined,
    onDictateDraft: async () => {
      dictations += 1;
      return await new Promise<{ phase: "listening"; sessionId?: string } | {
        phase: "idle";
        transcript: string;
        sessionId?: string;
        outcome?: "recognized" | "cancelled";
      }>((resolve, reject) => {
        settleDictation = resolve;
        failDictation = reject;
      });
    },
    onDictationResultConsumed: async (sessionId: string) => {
      harness.acknowledgedResults.push(sessionId);
    },
    onDictateCancel: async () => {
      dictateCancels += 1;
    },
    onOpenSystemTask: async () => undefined,
    onRefresh: async () => undefined,
    onSettingsChanged: async () => undefined,
    onDownloadModel: async () => undefined,
    onCancelModelDownload: async () => undefined,
    onConfigureWorkflow: async () => ({ configured: true, loggedIn: true }),
    onRequestPermission: async () => undefined,
    onContinuousRecording: async () => undefined,
    onDeleteRecording: async () => undefined,
    onSendContextToAgent: async () => undefined,
    onRegenerateDayDigest: async () => undefined,
    onSendDayDigestToAgent: async () => undefined,
    onSummarizeSegment: async () => undefined,
    onMarkCommandRead: async () => undefined,
    onSendCommandFollowUp: async (text: string) => {
      harness.sent.push(text);
      return await new Promise<string>((resolve, reject) => {
        settleSend = resolve;
        failSend = reject;
      });
    },
    onCancelCommand: async (taskId: string) => {
      harness.cancelledCommands.push(taskId);
      await new Promise<void>((resolve) => { settleCancel = resolve; });
    },
    onInstallBrowserWebAccessAndRetry: async (item: VoiceCommandHistoryItem) => {
      harness.browserInstallRetries.push(item);
    },
    onOpenSourceLink: async (url: string) => { if (openSource) await openSource(url); harness.openedSourceLinks.push(url); },
    onLoadReplayAudio: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }),
    onReplayRetentionChanged: async () => undefined,
    onClearReplayCache: async () => undefined,
    onOpenKeymap: async () => undefined,
  } as unknown as VoiceViewActions;
  const view = mountVoiceView(root, createDefaultVoiceViewState(overrides), actions);
  harness.update = (next) => view.update(next);
  harness.navigateRoot = () => view.navigateRoot();
  harness.dispose = () => view.dispose();
  harness.releaseSend = (taskId = "task-follow-up") => settleSend?.(taskId);
  harness.rejectSend = (cause) => failSend?.(cause);
  harness.releaseCancel = () => settleCancel?.();
  harness.dictations = () => dictations;
  harness.dictateCancels = () => dictateCancels;
  harness.resolveDictation = (result) => settleDictation?.(result);
  harness.rejectDictation = (cause) => failDictation?.(cause);
  return harness;
}

/** 切到 Command 档并点开第一条命令，进入 Chat detail。 */
function openChat(harness: Harness): void {
  (harness.root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
  (harness.root.querySelector(".command-history-item") as HTMLButtonElement).click();
}

/** 发送动作的 then/catch/finally 跨了几个 Promise 环节，排空微任务队列再断言。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("Chat detail（A3-15）：命令任务详情页", () => {
  test("运行中的当前对话可停止，等待终态后恢复发送", async () => {
    const running = commandItem({ id: "running-a", status: "running", reply: undefined, agentSessionId: "session-a" });
    const harness = mount({ commandHistory: [running] });
    openChat(harness);
    const stop = harness.root.querySelector<HTMLButtonElement>(".chat-cancel");
    expect(stop).not.toBeNull();
    expect(stop!.disabled).toBeFalse();
    stop!.click();
    (harness.root.querySelector(".chat-cancel") as HTMLButtonElement).click();
    expect(harness.cancelledCommands).toEqual(["running-a"]);
    expect((harness.root.querySelector(".chat-cancel") as HTMLButtonElement).disabled).toBeTrue();
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeTrue();
    harness.update(createDefaultVoiceViewState({ commandHistory: [{ ...running, status: "failed", userMessage: "已停止回答" }] }));
    harness.releaseCancel();
    await flush();
    expect(harness.root.querySelector(".chat-cancel")).toBeNull();
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    expect(input.disabled).toBeFalse();
    input.value = "继续这一场对话";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(harness.sent).toEqual(["继续这一场对话"]);
    harness.dispose();
  });

  test("浏览旧条目时只停止同一会话的运行回合，不停止其它会话", () => {
    const prior = commandItem({ id: "old-a", agentSessionId: "session-a" });
    const running = commandItem({ id: "running-a", status: "running", reply: undefined, agentSessionId: "session-a" });
    const other = commandItem({ id: "running-b", status: "running", reply: undefined, agentSessionId: "session-b" });
    const harness = mount({ commandHistory: [prior, running, other] });
    openChat(harness);
    const stop = harness.root.querySelector<HTMLButtonElement>(".chat-cancel");
    expect(stop).not.toBeNull();
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeTrue();
    stop!.click();
    expect(harness.cancelledCommands).toEqual(["running-a"]);
    harness.dispose();
  });

  test("命令行可点进对话式详情页，消息流按真实数据呈现来龙去脉", () => {
    const item = commandItem();
    const harness = mount({ commandHistory: [item] });
    openChat(harness);

    const view = harness.root.querySelector(".chat-view");
    expect(view).not.toBeNull();

    // 页头（R8 对照 9：稿 chatAva / chatName / chatRole）：emoji 头像 + 任务标题 + 角色。
    // 旧条目没有 commandId：头像用麦克风，角色位「语音命令」。B5-14：右侧返回钮已撤。
    const avatar = harness.root.querySelector(".chat-who-ava");
    expect(avatar?.classList.contains("is-emoji")).toBeTrue();
    expect(avatar?.textContent).toBe("🎙️");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe(item.transcript);
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("语音命令");
    expect(harness.root.querySelector(".chat-back")).toBeNull();

    // 对话流：用户那句话在右（from-user），工作流回答在左（from-ai），各带时间。
    const user = harness.root.querySelector(".chat-msg.from-user .chat-bubble");
    const ai = harness.root.querySelector(".chat-msg.from-ai .chat-bubble");
    expect(user?.textContent).toBe(item.transcript);
    expect(ai?.textContent).toBe(item.reply);
    // 时间戳是稿的 `2:47 PM` 短格式（D-5：不带秒）。
    expect(harness.root.querySelector(".chat-msg.from-user .chat-ts")?.textContent)
      .toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    expect(harness.root.querySelector(".chat-msg.from-ai .chat-ts")?.textContent)
      .toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    harness.dispose();
  });

  test("缺联网能力卡保留一键安装入口并把当前条目交给重试动作", () => {
    const item = commandItem({
      status: "failed",
      reply: undefined,
      messages: [
        { from: "user", text: "查天气", at: "2026-08-18T03:00:00.000Z" },
        {
          from: "ai",
          text: "",
          at: "2026-08-18T03:00:01.000Z",
          card: {
            kind: "capability-required",
            capability: "browser-web-access",
            title: "当前需要联网搜索功能才能完成这个请求",
            detail: "安装后可以继续",
            actionId: "install-browser-web-access",
            actionLabel: "一键安装并继续",
          },
        },
      ],
    });
    const harness = mount({ commandHistory: [item] });
    openChat(harness);
    const action = harness.root.querySelector<HTMLButtonElement>(".chat-status-action");
    expect(action?.textContent).toBe("一键安装并继续");
    action?.click();
    expect(harness.browserInstallRetries).toEqual([item]);
    harness.dispose();
  });

  test("联网操作卡展开后，调用进度更新仍保持展开", () => {
    const item = commandItem({
      messages: [
        { from: "user", text: "查天气", at: "2026-08-18T03:00:00.000Z" },
        {
          from: "ai",
          text: "",
          at: "2026-08-18T03:00:01.000Z",
          card: {
            kind: "tool-group",
            status: "running",
            label: "浏览器操作 23 次",
            calls: [{ callId: "call-a", tool: "web_search", status: "running", at: "2026-08-18T03:00:01.000Z" }],
            totalCalls: 23,
            failedCalls: 0,
            omittedCalls: 22,
          },
        },
      ],
    });
    const harness = mount({ commandHistory: [item] });
    openChat(harness);
    const toggle = harness.root.querySelector<HTMLButtonElement>(".chat-status-toggle");
    expect(toggle).not.toBeNull();
    toggle!.click();
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");

    const updated = structuredClone(item);
    const card = updated.messages?.[1]?.card;
    if (card?.kind !== "tool-group") throw new Error("test setup lost tool card");
    card.status = "completed";
    card.calls[0]!.status = "completed";
    harness.update(createDefaultVoiceViewState({ commandHistory: [updated] }));

    const updatedToggle = harness.root.querySelector<HTMLButtonElement>(".chat-status-toggle");
    expect(updatedToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(harness.root.querySelector(".chat-status-calls")?.hasAttribute("hidden")).toBeFalse();
    expect(harness.root.querySelector(".chat-status-call[data-status='completed']")).not.toBeNull();
    expect(harness.root.querySelector(".chat-status-call.omitted")?.textContent).toContain("22");
    harness.dispose();
  });

  test("页头身份：commandId 推出头像与角色；条目自带 identity 时逐字照用", () => {
    const harness = mount({
      commandHistory: [
        // 有译文的成功翻译走独立的翻译详情页（见 voice-translation-detail.test.ts）；
        // 没有译文的旧条目仍落在对话页，页头身份照 commandId 推出。
        commandItem({ commandId: "voice.command.translate", reply: "" }),
        commandItem({
          id: "cmd-identity",
          createdAt: "2026-08-18T02:00:00.000Z",
          identity: { avatar: "✉️", title: "Email — Q3 timeline update", role: "Writing assistant" },
        }),
      ],
    });
    openChat(harness);
    expect(harness.root.querySelector(".chat-who-ava")?.textContent).toBe("🌐");
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("翻译");
    harness.navigateRoot();
    const rows = harness.root.querySelectorAll(".command-history-item");
    (rows[1] as HTMLButtonElement).click();
    expect(harness.root.querySelector(".chat-who-ava")?.textContent).toBe("✉️");
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe("Email — Q3 timeline update");
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("Writing assistant");
    harness.dispose();
  });

  test("同一 Agent Session 的多轮追问在一页里连着看，按时间正序；页头取第一句", () => {
    const first = commandItem({ id: "c1", agentSessionId: "s1", transcript: "第一轮", reply: "回一", createdAt: "2026-08-18T03:00:00.000Z", commandId: "voice.command.agent" });
    const second = commandItem({ id: "c2", agentSessionId: "s1", transcript: "第二轮", reply: "回二", createdAt: "2026-08-18T03:05:00.000Z", commandId: "voice.command.agent" });
    const other = commandItem({ id: "c3", agentSessionId: "s2", transcript: "别的会话", reply: "无关", createdAt: "2026-08-18T03:06:00.000Z" });
    const harness = mount({ commandHistory: [other, second, first] });
    (harness.root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    // 点开第二轮那条：看到的是整段会话。
    (harness.root.querySelectorAll(".command-history-item")[1] as HTMLButtonElement).click();
    const bubbles = Array.from(harness.root.querySelectorAll(".chat-bubble")).map((node) => node.textContent);
    expect(bubbles).toEqual(["第一轮", "回一", "第二轮", "回二"]);
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe("第一轮");
    expect(harness.root.querySelector(".chat-who-ava")?.textContent).toBe("✨");
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("Agent 提问");
    harness.dispose();
  });

  test("自带 messages 的条目按消息流渲染，文件 / 图片 / 语音三种附件卡都在（对照 10 / 11）", () => {
    const harness = mount({
      commandHistory: [
        commandItem({
          messages: [
            { from: "user", text: "分析 3 个主要竞品的语音输入方案", at: "2026-08-18T07:01:00.000Z" },
            { from: "ai", text: "", at: "2026-08-18T07:02:00.000Z", attachments: [{ kind: "image", alt: "Comparison chart screenshot" }] },
            { from: "ai", text: "Draft ready:", at: "2026-08-18T07:04:00.000Z", attachments: [{ kind: "file", icon: "📊", name: "Competitive_Analysis.xlsx", meta: "Spreadsheet · 24 KB" }] },
            { from: "user", text: "", at: "2026-08-18T07:06:00.000Z", attachments: [{ kind: "audio", durationMs: 42_000 }] },
          ],
        }),
      ],
    });
    openChat(harness);
    const rows = Array.from(harness.root.querySelectorAll(".chat-msg"));
    expect(rows.map((row) => row.className)).toEqual([
      "chat-msg from-user",
      "chat-msg from-ai",
      "chat-msg from-ai",
      "chat-msg from-user",
    ]);
    expect(rows[1]?.querySelector(".chat-card-img")?.textContent).toBe("Comparison chart screenshot");
    expect(rows[2]?.querySelector(".chat-card-name")?.textContent).toBe("Competitive_Analysis.xlsx");
    expect(rows[2]?.querySelector(".chat-card-meta")?.textContent).toBe("Spreadsheet · 24 KB");
    expect(rows[3]?.querySelector(".chat-card-dur")?.textContent).toBe("0:42");
    const bars = Array.from(rows[3]?.querySelectorAll<HTMLElement>(".chat-card-wave i") ?? []);
    expect(bars.length).toBeGreaterThan(0);
    // 波形高度走 CSSOM（插件 CSP 没有 unsafe-inline，内联 style 属性会被丢掉）。
    expect(bars.every((bar) => Number.parseInt(bar.style.height, 10) >= 3)).toBeTrue();
    harness.dispose();
  });

  test("失败条目的回答位是失败原因，页头如实说执行失败", () => {
    const harness = mount({
      commandHistory: [
        commandItem({
          status: "failed",
          reply: undefined,
          durationMs: undefined,
          errorCode: "VOICE_COMMAND_LOGIN_REQUIRED",
          userMessage: "请先登录再使用语音命令",
        }),
      ],
    });
    openChat(harness);
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("执行失败");
    expect(harness.root.querySelector(".chat-who-ava")?.textContent).toBe("🎙️");
    expect(harness.root.querySelector(".chat-who-ava")?.getAttribute("aria-hidden")).toBe("true");
    expect(harness.root.querySelector(".chat-msg.from-ai .chat-bubble")?.textContent)
      .toBe("请先登录再使用语音命令");
    harness.dispose();
  });

  test("云端润色失败回退原文的完成条目，补一条说明而不是让人以为回答就是原话", () => {
    const harness = mount({
      commandHistory: [
        commandItem({
          reply: "帮我查一下明天北京到上海的高铁时刻表",
          errorCode: "unavailable",
          userMessage: "云端润色失败，已写回本地识别的原文",
        }),
      ],
    });
    openChat(harness);
    const replies = Array.from(
      harness.root.querySelectorAll(".chat-msg.from-ai .chat-bubble"),
    ).map((node) => node.textContent);
    expect(replies).toEqual([
      "帮我查一下明天北京到上海的高铁时刻表",
      "云端润色失败，已写回本地识别的原文",
    ]);
    harness.dispose();
  });

  test("B5-14 后返回走 navigateRoot（Host 面包屑合同），仍停在 Command 档", () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    harness.navigateRoot();
    expect(harness.root.querySelector(".chat-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    // 回去还是 Command 档：命令行还在，输入行不在。
    expect(harness.root.querySelector(".command-history-item")).not.toBeNull();
    expect(harness.root.querySelector('[data-voice-tab="command"]')?.classList.contains("active"))
      .toBeTrue();
    harness.dispose();
  });

  test("条目已不在（历史被清）时返回列表，不留在空详情页", () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    harness.update(createDefaultVoiceViewState({ commandHistory: [] }));
    expect(harness.root.querySelector(".chat-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    harness.dispose();
  });
});

describe("输入坞（A3-16）", () => {
  test("中文文案随语言包；未知模型附件能力时隐藏入口", () => {
    const harness = mount({ commandHistory: [commandItem({ commandId: "voice.command.agent" })] });
    openChat(harness);
    expect(harness.root.querySelector(".chat-input")?.getAttribute("placeholder"))
      .toBe("说点什么，或输入文字…");
    // 未确认模型能力时只保留输入框与麦克风。
    expect(
      Array.from(harness.root.querySelector(".chat-input-bar")?.children ?? []).map((node) => node.className),
    ).toEqual(["chat-input", "chat-mic"]);
    // 未知能力没有可点击或 disabled 的附件入口。
    expect(harness.root.querySelector(".chat-attach")).toBeNull();
    expect(harness.root.querySelector("input[type=file]")).not.toBeNull();
    harness.dispose();
  });

  test("输入 + 回车发起一次 Agent 命令，发出后清空并收口输入，结果落地自动接上", async () => {
    const first = commandItem();
    const harness = mount({ commandHistory: [first] });
    openChat(harness);

    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "再帮我看看返程最早的一班";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(harness.sent).toEqual(["再帮我看看返程最早的一班"]);
    // 发起中：输入清空并禁用，避免连发第二条。
    const sending = harness.root.querySelector(".chat-input") as HTMLInputElement;
    expect(sending.value).toBe("");
    expect(sending.disabled).toBeTrue();

    harness.releaseSend("2026-08-18T03:05:00.000Z-command");
    await flush();

    // 命令跑完，新条目落进历史：对话页自动切到刚发的那条上（合同没有会话续接，
    // 这是单发 run 之上的最小真实续接形态）。
    const landed = commandItem({
      id: "2026-08-18T03:05:00.000Z-command",
      transcript: "再帮我看看返程最早的一班",
      reply: "返程最早 G102 次 06:13 出发。",
      createdAt: "2026-08-18T03:05:00.000Z",
    });
    harness.update(createDefaultVoiceViewState({ commandHistory: [landed, first] }));
    expect(harness.root.querySelector(".chat-msg.from-user .chat-bubble")?.textContent)
      .toBe("再帮我看看返程最早的一班");
    expect(harness.root.querySelector(".chat-msg.from-ai .chat-bubble")?.textContent)
      .toBe("返程最早 G102 次 06:13 出发。");
    // 输入恢复可用。
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeFalse();
    harness.dispose();
  });

  test("发送被拒（如未配置工作流）在输入坞上方原地说明，草稿还回去、输入恢复", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "再来一句";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    harness.rejectSend(Object.assign(new Error("x"), { userMessage: "请先在设置中配置工作流地址" }));
    await flush();

    const error = harness.root.querySelector(".chat-send-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("请先在设置中配置工作流地址");
    // 可重试的失败不该让人重打整句话：草稿原样回到输入框。
    const restored = harness.root.querySelector(".chat-input") as HTMLInputElement;
    expect(restored.value).toBe("再来一句");
    expect(restored.disabled).toBeFalse();
    harness.dispose();
  });

  test("失败落地的条目也把对话页接过去（失败也是来龙去脉的一部分）", async () => {
    const first = commandItem();
    const harness = mount({ commandHistory: [first] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "查一下天气";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    harness.releaseSend("2026-08-18T03:07:00.000Z-command");
    await flush();

    const landed = commandItem({
      id: "2026-08-18T03:07:00.000Z-command",
      transcript: "查一下天气",
      status: "failed",
      reply: undefined,
      durationMs: undefined,
      errorCode: "timeout",
      userMessage: "云端工作流超时，请稍后再试",
      createdAt: "2026-08-18T03:07:00.000Z",
    });
    harness.update(createDefaultVoiceViewState({ commandHistory: [landed, first] }));
    expect(harness.root.querySelector(".chat-who-role")?.textContent).toContain("执行失败");
    expect(harness.root.querySelector(".chat-msg.from-user .chat-bubble")?.textContent)
      .toBe("查一下天气");
    expect(harness.root.querySelector(".chat-msg.from-ai .chat-bubble")?.textContent)
      .toBe("云端工作流超时，请稍后再试");
    harness.dispose();
  });

  test("发出后续后离开对话页，落地的新条目不把人拽回去", async () => {
    const first = commandItem();
    const harness = mount({ commandHistory: [first] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "再帮我看一眼";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    harness.releaseSend();
    await flush();
    harness.navigateRoot();

    const landed = commandItem({
      id: "2026-08-18T03:09:00.000Z-command",
      transcript: "再帮我看一眼",
      createdAt: "2026-08-18T03:09:00.000Z",
    });
    harness.update(createDefaultVoiceViewState({ commandHistory: [landed, first] }));
    expect(harness.root.querySelector(".chat-view")).toBeNull();
    expect(harness.root.querySelector(".task-list-view")).not.toBeNull();
    harness.dispose();
  });

  test("精确 taskId 不会被后来落地的不相关命令替换", async () => {
    const first = commandItem();
    const harness = mount({ commandHistory: [first] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "查下天气";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    harness.releaseSend();
    await flush();

    // 目标 taskId 还没落地时先收到 idle，再来一条不相关命令，也不能猜成自己的结果。
    harness.update(createDefaultVoiceViewState({ commandHistory: [first] }));
    // 之后一条不相关的命令（比如硬件触发）落地，不该把人从当前对话拽走。
    const unrelated = commandItem({
      id: "2026-08-18T03:12:00.000Z-command",
      transcript: "硬件触发的那件事",
      createdAt: "2026-08-18T03:12:00.000Z",
    });
    harness.update(createDefaultVoiceViewState({ commandHistory: [unrelated, first] }));
    expect(harness.root.querySelector(".chat-msg.from-user .chat-bubble")?.textContent)
      .toBe(first.transcript);
    harness.dispose();
  });

  test("发送回来时人已换到另一场对话：草稿与错误不跨条目串门", async () => {
    const a = commandItem({ transcript: "第一场对话" });
    const b = commandItem({
      id: "2026-08-18T02:00:00.000Z-command-b",
      transcript: "第二场对话",
      createdAt: "2026-08-18T02:00:00.000Z",
    });
    const harness = mount({ commandHistory: [a, b] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "第一场的追问";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    // 发送在途时返回列表、点开另一场对话，第一场的失败这才回来。
    harness.navigateRoot();
    const rows = harness.root.querySelectorAll(".command-history-item");
    (rows[1] as HTMLButtonElement).click();
    harness.rejectSend(Object.assign(new Error("x"), { userMessage: "请先登录再使用语音命令" }));
    await flush();

    expect(harness.root.querySelector(".chat-send-error")).toBeNull();
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("");
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe("第二场对话");
    harness.dispose();
  });

  test("发送成功回调也一样认条目：人已换场，落地的新条目不挂观察窗", async () => {
    const a = commandItem({ transcript: "第一场对话" });
    const b = commandItem({
      id: "2026-08-18T02:00:00.000Z-command-b",
      transcript: "第二场对话",
      createdAt: "2026-08-18T02:00:00.000Z",
    });
    const harness = mount({ commandHistory: [a, b] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "第一场的追问";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    harness.navigateRoot();
    const rows = harness.root.querySelectorAll(".command-history-item");
    (rows[1] as HTMLButtonElement).click();
    harness.releaseSend();
    await flush();

    const landed = commandItem({
      id: "2026-08-18T03:15:00.000Z-command",
      transcript: "第一场的追问",
      reply: "第一场的回答。",
      createdAt: "2026-08-18T03:15:00.000Z",
    });
    harness.update(createDefaultVoiceViewState({ commandHistory: [landed, a, b] }));
    // 留在第二场对话，没有被拽去第一场的新条目。
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe("第二场对话");
    expect(harness.root.querySelector(".chat-msg.from-user .chat-bubble")?.textContent)
      .toBe("第二场对话");
    harness.dispose();
  });

  test("空输入按回车不发起；命令运行中麦克风与输入都不可点", () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(harness.sent).toEqual([]);

    // 语音命令正在跑：不是把发送静默吞掉，而是把入口收口（可点性本身就是状态）。
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem()],
        commandPhase: "processing",
        activeMode: "command",
      }),
    );
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeTrue();
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeTrue();

    // 后台联网任务可能已经把全局 commandPhase 释放为 idle；条目自身的 running
    // 状态仍必须收口输入，避免用户在同一轮尚未结束时继续发送。
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem({ status: "running", reply: undefined })],
      }),
    );
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeTrue();
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeTrue();

    // 语音**输入**会话进行中同样收口麦克风（App 层发送门禁见文末源断言）。
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem()],
        phase: "listening",
        activeMode: "input",
      }),
    );
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeTrue();
    // 别处起的命令采集（硬件键）：麦克风同样不可点——它不是那场采集的收工键。
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem()],
        commandPhase: "listening",
        activeMode: "command",
      }),
    );
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeTrue();
    harness.dispose();
  });

  test("麦克风 = 定向听写：起跑后输入框收口、麦克风变「完成听写」；收工的转写只落进输入框，不发送", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "先打了半句";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const mic = harness.root.querySelector(".chat-mic") as HTMLButtonElement;
    expect(mic.title).toBe("开始听写到输入框");
    mic.click();
    expect(harness.dictations()).toBe(1);
    // 在途（IPC 没回来）：按钮节点还没重渲染，但第二次点也必须被本地门禁挡住。
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeFalse();
    mic.click();
    expect(harness.dictations()).toBe(1);
    harness.resolveDictation({ phase: "listening" });
    await flush();
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem()],
        dictationPhase: "listening",
      }),
    );
    const listening = harness.root.querySelector(".chat-mic") as HTMLButtonElement;
    expect(listening.disabled).toBeFalse();
    expect(listening.title).toBe("完成听写");
    expect(listening.classList.contains("is-listening")).toBeTrue();
    // 在听的时候输入框收口：说的话要落进来，别让键盘和语音抢同一个框。
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).disabled).toBeTrue();
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("先打了半句");

    listening.click();
    expect(harness.dictations()).toBe(2);
    harness.update(
      createDefaultVoiceViewState({
        commandHistory: [commandItem()],
        dictationPhase: "recognizing",
      }),
    );
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeTrue();
    // 真实顺序：App 层先 publish(idle) 帧，promise 才带着转写收敛。
    harness.update(createDefaultVoiceViewState({ commandHistory: [commandItem()] }));
    harness.resolveDictation({
      phase: "idle",
      transcript: "再帮我看看返程",
      sessionId: "dictation-success",
    });
    await flush();
    // 转写接在草稿后面、只在这个输入框里；没有发送、没有新命令。
    const filled = harness.root.querySelector(".chat-input") as HTMLInputElement;
    expect(filled.value).toBe("先打了半句再帮我看看返程");
    expect(filled.disabled).toBeFalse();
    expect(document.activeElement).toBe(filled);
    expect(harness.sent).toEqual([]);
    expect(harness.root.querySelector(".chat-send-error")).toBeNull();
    expect(harness.acknowledgedResults).toEqual(["dictation-success"]);
    // 回车才发送——发的是拼好的整句。
    filled.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(harness.sent).toEqual(["先打了半句再帮我看看返程"]);
    harness.dispose();
  });

  test("听写起跑失败在输入坞上方原地说明，草稿不动；不进全局状态", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    const input = harness.root.querySelector(".chat-input") as HTMLInputElement;
    input.value = "草稿";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    harness.rejectDictation(Object.assign(new Error("x"), { userMessage: "语音正忙，等当前这段结束再试" }));
    await flush();
    const error = harness.root.querySelector(".chat-send-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("语音正忙，等当前这段结束再试");
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("草稿");
    expect((harness.root.querySelector(".chat-mic") as HTMLButtonElement).disabled).toBeFalse();
    harness.dispose();
  });

  test("听写途中离开对话页：取消听写，转写回来也不落进别处", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    harness.resolveDictation({ phase: "listening" });
    await flush();
    harness.update(createDefaultVoiceViewState({ commandHistory: [commandItem()], dictationPhase: "listening" }));
    harness.navigateRoot();
    expect(harness.dictateCancels()).toBe(1);
    // 迟到的转写（比如取消前那一拍已经收工）不该写进任何地方。
    openChat(harness);
    harness.update(createDefaultVoiceViewState({ commandHistory: [commandItem()] }));
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("");
    harness.dispose();
  });

  test("听写起跑 IPC 尚未返回就离页：先请求取消，迟到的 listening 不落字", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);
    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    expect(harness.dictations()).toBe(1);

    // 这时 View state 仍是 idle；reset 也必须把“起跑后立刻取消”的意图交给 App 层。
    harness.navigateRoot();
    expect(harness.dictateCancels()).toBe(1);
    harness.resolveDictation({ phase: "listening" });
    await flush();

    openChat(harness);
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("");
    expect(harness.sent).toEqual([]);
    harness.dispose();
  });

  test("转写回来时人已换到另一场对话：只落回起跑的那一条，不串门", async () => {
    const a = commandItem({ transcript: "第一场对话" });
    const b = commandItem({
      id: "2026-08-18T02:00:00.000Z-command-b",
      transcript: "第二场对话",
      createdAt: "2026-08-18T02:00:00.000Z",
    });
    const harness = mount({ commandHistory: [a, b] });
    openChat(harness);
    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    harness.resolveDictation({ phase: "listening" });
    await flush();
    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    // 收工在途时换场。
    harness.navigateRoot();
    (harness.root.querySelectorAll(".command-history-item")[1] as HTMLButtonElement).click();
    harness.resolveDictation({
      phase: "idle",
      transcript: "第一场的话",
      sessionId: "dictation-stale-target",
    });
    await flush();
    expect(harness.root.querySelector(".chat-who-name")?.textContent).toBe("第二场对话");
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("");
    expect(harness.acknowledgedResults).toEqual(["dictation-stale-target"]);
    harness.dispose();
  });

  test("听写空文本照常提示、用户取消不显示红字，两者都明确结算 session", async () => {
    const harness = mount({ commandHistory: [commandItem()] });
    openChat(harness);

    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    harness.resolveDictation({
      phase: "idle",
      transcript: "",
      sessionId: "dictation-empty",
      outcome: "recognized",
    });
    await flush();
    expect((harness.root.querySelector(".chat-input") as HTMLInputElement).value).toBe("");
    expect(harness.root.querySelector(".chat-send-error")?.textContent)
      .toContain("没有听清，请再说一次");
    expect(harness.acknowledgedResults).toEqual(["dictation-empty"]);

    (harness.root.querySelector(".chat-mic") as HTMLButtonElement).click();
    harness.resolveDictation({
      phase: "idle",
      transcript: "",
      sessionId: "dictation-cancelled",
      outcome: "cancelled",
    });
    await flush();
    expect(harness.root.querySelector(".chat-send-error")).toBeNull();
    expect(harness.acknowledgedResults).toEqual([
      "dictation-empty",
      "dictation-cancelled",
    ]);
    harness.dispose();
  });
});

describe("App 层定向听写（源断言）", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/app.ts"),
    "utf8",
  );

  test("听写走 Host 的 Command 模式（只出文本、不写回），不碰 commandPhase、不跑工作流、不写历史", () => {
    const block = source.slice(
      source.indexOf("const toggleDictation = async"),
      source.indexOf("const cancelDictation = async"),
    );
    // 仍是 Command 模式 + input 胶囊、绝不注入；云端引擎时按开始那一刻的快照
    // 附 retainAudio 留音频（与听写输入链同一条云端解耦路径，否则被 Host 的
    // 「非 retainAudio 就查本地模型」门禁挡死）。
    expect(block).toContain('mode: "command"');
    expect(block).toContain('overlayKind: "input"');
    expect(block).toContain("...(useCloud ? { retainAudio: true } : {})");
    // 只读 commandPhase 做忙碌判定，绝不写它（硬件键靠它判收工）。
    expect(block).not.toMatch(/commandPhase:/);
    expect(block).not.toContain("runCommandWorkflow");
    expect(block).not.toContain("appendCommandHistory");
    // 识别只出文本（Host API 1.22）：显式 insertText:false，且听写结果绝不 commit 到前台应用。
    expect(block).toContain("insertText: false");
    expect(block).not.toContain("delivery.commit");
    expect(block).toContain('publish({ dictationPhase: "listening"');
  });

  test("听写期间硬件语音键 / 语音输入 / 输入坞发送一律让路（VOICE_BUSY）", () => {
    expect(source).toContain('if (state.dictationPhase === "idle") return;');
    // 三条入口都过 throwIfDictating：命令采集（硬件键）、语音输入、输入坞发送。
    expect(source.match(/throwIfDictating\(\);/g)?.length).toBe(3);
    const toggleCommand = source.slice(
      source.indexOf("const toggleCommand = async"),
      source.indexOf("toggleInFlight = true;", source.indexOf("const toggleCommand = async")),
    );
    expect(toggleCommand).toContain("throwIfDictating();");
  });

  test("离页主动取消携带原 session，作为明确丢弃且不误伤后续会话", () => {
    const block = source.slice(
      source.indexOf("const cancelDictation = async"),
      source.indexOf("const toggleInput = async"),
    );
    expect(block).toContain("const sessionId = state.sessionId");
    expect(block).toContain("ctx.voiceInput.cancel(sessionId)");
    expect(block.indexOf("const sessionId = state.sessionId"))
      .toBeLessThan(block.indexOf('publish({ dictationPhase: "idle", sessionId: undefined })'));
  });

  test("Preparing 阶段取消在输入与命令入口都按正常控制流收口", () => {
    // 取消与失败的收口抽成了输入 / 命令各自的共用函数（开录结束同步收尾与胶囊叠放的后台收尾共用）。
    const inputBlock = source.slice(
      source.indexOf("const settleInputFailure = ("),
      source.indexOf("let statusPollInFlight"),
    );
    const commandBlock = source.slice(
      source.indexOf("const settleCommandStartFailure = async"),
      source.indexOf('ctx.commands.register("com.reai.voice.toggle-input"'),
    );
    expect(inputBlock).toContain("return settleInputFailure(cause, finishedInputSessionId, true)");
    expect(commandBlock).toContain("return await settleCommandStartFailure(cause, {");
    expect(source).toContain("function isVoiceCancellation(cause: unknown): boolean");
    expect(inputBlock).toContain("if (isVoiceCancellation(cause))");
    expect(inputBlock).toContain("return cancelledVoiceInputResult()");
    expect(commandBlock).toContain("if (isVoiceCancellation(cause))");
    expect(commandBlock).toContain("return cancelledVoiceInputResult()");
    expect(source).not.toContain("throwForVoiceStopReason");
  });
});

describe("App 层发送门禁（源断言）", () => {
  // app.ts 的 sendCommandFollowUp 不在本文件的 mock 化范围内，用源断言钉住门禁
  // 条件本身（与 tests/voice-panel-parity.test.ts 对 app.ts 的手法一致）。
  test("语音输入会话进行中，输入坞发送不放行", () => {
    const source = readFileSync(
      join(import.meta.dir, "../src/app.ts"),
      "utf8",
    );
    expect(source).toContain('if (state.phase !== "idle" || state.activeMode === "input")');
    expect(source).toContain('t("app.voiceInputIsInProgressWaitFor")');
  });
});

describe("A3-24「发给 agent」去路与门控（源断言）", () => {
  // sendContextToAgentsIm 不在本文件的 mock 化范围内，用源断言钉住三件事：
  // 去路是 apps.open 的 attach-context intent（IM 附件），不是命令工作流；
  // 门控数据源是 apps.status（装没装 Agents·IM）；V-9 空转写口径保留。
  const source = readFileSync(
    join(import.meta.dir, "../src/app.ts"),
    "utf8",
  );

  test("去路：经宿主跨插件通道把段投给 Agents·IM 的 attach-context intent", () => {
    expect(source).toContain('const AGENTS_IM_APP_ID = "com.reai.agents-im"');
    expect(source).toContain('const AGENTS_IM_ATTACH_CONTEXT_INTENT = "attach-context"');
    expect(source).toContain("intent: AGENTS_IM_ATTACH_CONTEXT_INTENT");
    expect(source).toContain('t("app.liveRecordingValueValueCharactersValue"');
  });

  test("去路不是命令工作流：发送路径不再检查 commandPhase / 工作流配置", () => {
    const send = source.slice(
      source.indexOf("const sendContextToAgentsIm"),
      source.indexOf("agentsImOpenError(cause)"),
    );
    expect(send).not.toContain("runCommandWorkflow");
    expect(send).not.toContain("VOICE_COMMAND_NOT_CONFIGURED");
    expect(send).not.toContain("commandPhase");
  });

  test("门控：装没装 Agents·IM 采样自 apps.status，读不到时沿用上次结果", () => {
    expect(source).toContain("const status = await ctx.apps.status({ appId: AGENTS_IM_APP_ID })");
    expect(source).toContain("publish({ agentsImAvailable: status.installed && status.enabled })");
    // 打开后目标缺失/失败时回读一次，让按钮如实消失。
    expect(source).toContain('code === "APP_INTENT_TARGET_NOT_INSTALLED" || code === "INTENT_TARGET_FAILED"');
  });

  test("V-9 口径保留：没有转写的段不发给 agent", () => {
    expect(source).toContain('t("app.thisSegmentHasNoTranscriptYetWait")');
  });

});

 test("failed chat status follows locale without replacing the draft or changing historical content", () => {
  setVoiceLocale("zh");
  const harness = mount({ commandHistory: [commandItem({ status: "failed", reply: undefined, userMessage: undefined })] });
  openChat(harness);
  const input = harness.root.querySelector<HTMLInputElement>(".chat-input")!;
  input.value = "保留 draft";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.setSelectionRange(1, 3);
  const originalBubble = harness.root.querySelector(".from-user .chat-bubble")?.textContent;
  expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("执行失败");
  setVoiceLocale("en");
  expect(harness.root.querySelector(".chat-who-role")?.textContent).toBe("Failed");
  expect(harness.root.querySelector(".from-ai .chat-bubble")?.textContent).toBe("Failed");
  expect(harness.root.querySelector(".from-user .chat-bubble")?.textContent).toBe(originalBubble);
  expect(harness.root.querySelector(".chat-input")).toBe(input);
  expect(input.value).toBe("保留 draft");
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  harness.dispose();
  setVoiceLocale("zh");
});

describe("负责人 rc.2.7 反馈：工具过程合成一条、回答按 Markdown 渲染", () => {
  const legacyCard = (tool: "web_search" | "web_fetch", label: string) => ({
    from: "ai" as const, text: "", at: "2026-08-18T03:00:01.000Z",
    card: { kind: "tool" as const, tool, status: "completed" as const, label },
  });
  const reply = "**天气：**多云转晴\n\n- **气温：**18~26℃\n- 风力 3级\n\n[来源](https://example.com/w) <script>alert(1)</script>";

  test("同一回合多个不同工具（真机截图那两张卡）只渲染一条折叠进度；点开出全部明细，再点收起；回合结束后保持折叠", async () => {
    setVoiceLocale("zh");
    const item = commandItem({
      reply,
      messages: [
        { from: "user", text: "明天北京天气", at: "2026-08-18T03:00:00.000Z" },
        legacyCard("web_search", "已使用浏览器插件完成联网搜索"),
        legacyCard("web_fetch", "已使用浏览器插件完成网页读取"),
        { from: "ai", text: reply, at: "2026-08-18T03:00:05.000Z" },
      ],
    });
    const harness = mount({ commandHistory: [item] });
    openChat(harness);
    const cards = harness.root.querySelectorAll(".chat-status-card");
    expect(cards).toHaveLength(1);
    expect(harness.root.textContent).not.toContain("已使用浏览器插件完成");
    const head = harness.root.querySelector<HTMLButtonElement>(".chat-status-toggle")!;
    expect(head.querySelector(".chat-status-label")?.textContent).toBe("已调用 2 个工具：联网搜索、读取网页");
    expect(head.querySelector(".chat-globe")?.getAttribute("data-spinning")).toBe("false");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(harness.root.querySelector(".chat-status-calls")?.hasAttribute("hidden")).toBeTrue();
    head.click();
    expect(harness.root.querySelector(".chat-status-calls")?.hasAttribute("hidden")).toBeFalse();
    expect(Array.from(harness.root.querySelectorAll(".chat-status-call-name"), (node) => node.textContent))
      .toEqual(["联网搜索", "读取网页"]);
    harness.root.querySelector<HTMLButtonElement>(".chat-status-toggle")!.click();
    expect(harness.root.querySelector(".chat-status-calls")?.hasAttribute("hidden")).toBeTrue();

    // 回答按 Markdown 渲染；脚本不执行，来源点击经 Host 打开，插件不导航。
    const bubble = harness.root.querySelector(".from-ai .chat-markdown")!;
    expect(Array.from(bubble.querySelectorAll("strong"), (node) => node.textContent)).toEqual(["天气：", "气温："]);
    expect(bubble.querySelectorAll("ul li")).toHaveLength(2);
    expect(bubble.textContent).not.toContain("**");
    expect(bubble.textContent).not.toMatch(/^- /m);
    expect(bubble.querySelector("script") === null).toBe(true);
    expect(bubble.querySelector(".chat-markdown-source")?.textContent).toBe("来源 (https://example.com/w)");
    expect(harness.openedSourceLinks).toEqual([]);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    bubble.querySelector("a")!.dispatchEvent(click);
    bubble.querySelector("a")!.click();
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(harness.openedSourceLinks).toEqual(["https://example.com/w"]);
    bubble.querySelector("a")!.click();
    await flush();
    expect(harness.openedSourceLinks).toEqual(["https://example.com/w"]);
    harness.dispose();
  });

  test("运行中：摘要是当前步骤 + 每秒刷新的已用时间，联网类地球仪在转", () => {
    setVoiceLocale("zh");
    const running = commandItem({
      status: "running", reply: undefined, createdAt: new Date(Date.now() - 6_000).toISOString(),
      messages: [
        { from: "user", text: "查一下再打开官网", at: "2026-08-18T03:00:00.000Z" },
        { from: "ai", text: "", at: "2026-08-18T03:00:01.000Z", card: { kind: "tool-group", status: "running", label: "x", calls: [
          { tool: "web_search", status: "completed", at: "2026-08-18T03:00:01.000Z" },
          { tool: "browser_navigate", status: "running", at: "2026-08-18T03:00:02.000Z" },
        ], totalCalls: 2 } },
      ],
    });
    const harness = mount({ commandHistory: [running] });
    openChat(harness);
    expect(harness.root.querySelectorAll(".chat-status-card")).toHaveLength(1);
    const head = harness.root.querySelector(".chat-status-head")!;
    expect(head.querySelector(".chat-status-label")?.textContent).toBe("正在打开网页");
    const elapsed = head.querySelector<HTMLElement>(".chat-status-meta [data-voice-elapsed-since]")!;
    expect(elapsed.textContent).toMatch(/^已用 \d+ 秒$/);
    expect(head.querySelector(".chat-globe")?.getAttribute("data-spinning")).toBe("true");
    harness.dispose();
  });

  test("source failure stays on the detail page and a successful retry clears it", async () => {
    setVoiceLocale("zh");
    let unavailable = true;
    const item = commandItem({ reply: "[来源](https://example.com/source)" });
    const harness = mount({ commandHistory: [item] }, async () => {
      if (unavailable) throw { code: "EXTERNAL_LINK_UNAVAILABLE", userMessage: "当前 App 不支持打开来源链接，请更新 App，或复制网址到浏览器打开" };
    });
    openChat(harness);
    harness.root.querySelector<HTMLAnchorElement>(".chat-markdown a")!.click();
    await flush();
    expect(harness.root.textContent).toContain("请更新 App");
    expect(harness.root.textContent).toContain("https://example.com/source");
    unavailable = false;
    harness.root.querySelector<HTMLAnchorElement>(".chat-markdown a")!.click();
    await flush();
    expect(harness.openedSourceLinks).toEqual(["https://example.com/source"]);
    expect(harness.root.textContent).not.toContain("请更新 App");
    harness.dispose();
  });

  test("历史列表摘要是纯文本：不露 Markdown 标记", () => {
    setVoiceLocale("zh");
    const harness = mount({ commandHistory: [commandItem({ reply })] });
    (harness.root.querySelector('[data-voice-tab="command"]') as HTMLButtonElement).click();
    const preview = harness.root.querySelector(".command-history-item .task-preview")?.textContent ?? "";
    expect(preview).toBe("天气：多云转晴 • 气温：18~26℃ • 风力 3级 来源 (https://example.com/w) <script>alert(1)</script>");
    expect(preview).not.toContain("**");
    harness.dispose();
  });
});
