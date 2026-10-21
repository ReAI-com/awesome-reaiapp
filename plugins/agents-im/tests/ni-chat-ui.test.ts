import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NiChatStateCoordinator,
  createMockNiChatAdapter,
  createMockNiChatState,
  mountNiChatView,
  type Interaction,
  type Message,
  type NiChatAdapter,
  type NiChatEvent,
  type NiChatState,
} from "../packages/ni-chat-ui/src/index";
import { icon } from "@reai/agent-ui";

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

function message(overrides: Partial<Message> & Pick<Message, "id" | "conversationId" | "senderId">): Message {
  return {
    revision: 1,
    origin: "profile",
    parts: [{ kind: "text", text: "hello" }],
    createdAt: "2026-08-12T08:00:00Z",
    ...overrides,
  };
}

function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: "interaction-1",
    conversationId: "human-agent",
    state: "pending",
    version: 1,
    prompt: "选择发布范围",
    schema: { kind: "choice", options: [{ id: "app", label: "只发 App" }] },
    eligibleResponderIds: ["me"],
    ...overrides,
  };
}

async function flushRender(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("ni.chat revision-aware state coordinator", () => {
  test("update-before-create、重复和旧 revision 都收敛到最高 revision", () => {
    const base = createMockNiChatState();
    const coordinator = new NiChatStateCoordinator({ ...base, messagesByConversation: { "human-agent": [] } });

    coordinator.apply({
      type: "message.updated",
      message: message({ id: "stream-1", conversationId: "human-agent", senderId: "agent-coder", revision: 2, parts: [{ kind: "text", text: "第二版" }] }),
    });
    expect(coordinator.current.messagesByConversation["human-agent"]).toEqual([]);

    coordinator.apply({
      type: "message.created",
      message: message({ id: "stream-1", conversationId: "human-agent", senderId: "agent-coder", revision: 1, parts: [{ kind: "text", text: "第一版" }] }),
    });
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.revision).toBe(2);
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.parts).toEqual([{ kind: "text", text: "第二版" }]);

    coordinator.apply({
      type: "message.updated",
      message: message({ id: "stream-1", conversationId: "human-agent", senderId: "agent-coder", revision: 2, parts: [{ kind: "text", text: "重复第二版" }] }),
    });
    coordinator.apply({
      type: "message.updated",
      message: message({ id: "stream-1", conversationId: "human-agent", senderId: "agent-coder", revision: 1, parts: [{ kind: "text", text: "迟到第一版" }] }),
    });
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.parts).toEqual([{ kind: "text", text: "第二版" }]);

    coordinator.apply({
      type: "message.updated",
      message: message({ id: "stream-1", conversationId: "human-agent", senderId: "agent-coder", revision: 3, parts: [{ kind: "text", text: "最终版" }] }),
    });
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.revision).toBe(3);
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.parts).toEqual([{ kind: "text", text: "最终版" }]);
  });

  test("Interaction 只允许 eligible profile 用当前 version 回答一次", async () => {
    const state = createMockNiChatState();
    state.interactions = { "interaction-1": interaction() };
    const adapter = createMockNiChatAdapter(state);

    await adapter.answerInteraction({ interactionId: "interaction-1", version: 1, answer: { optionId: "app" } });
    expect((await adapter.getSnapshot()).interactions["interaction-1"]?.state).toBe("answered");
    await expect(adapter.answerInteraction({ interactionId: "interaction-1", version: 1, answer: { optionId: "app" } })).rejects.toThrow("INTERACTION_NOT_PENDING");

    const stale = createMockNiChatAdapter({ ...state, interactions: { "interaction-1": interaction({ version: 2 }) } });
    await expect(stale.answerInteraction({ interactionId: "interaction-1", version: 1, answer: { optionId: "app" } })).rejects.toThrow("INTERACTION_VERSION_CONFLICT");

    const ineligibleState: NiChatState = { ...state, selfProfileId: "human-alice", interactions: { "interaction-1": interaction() } };
    await expect(createMockNiChatAdapter(ineligibleState).answerInteraction({ interactionId: "interaction-1", version: 1, answer: { optionId: "app" } })).rejects.toThrow("INTERACTION_NOT_ELIGIBLE");
  });

  test("presence/status 只消费 capability 和 TTL，不从 Agent 工作状态推断", () => {
    const state = createMockNiChatState();
    const coordinator = new NiChatStateCoordinator(state, { now: () => Date.parse("2026-08-12T08:00:30Z") });
    expect(coordinator.visiblePresence("agent-coder")?.state).toBe("online");
    expect(coordinator.visibleTransientStatus("human-agent")?.kind).toBe("thinking");

    const expired = new NiChatStateCoordinator(state, { now: () => Date.parse("2026-08-12T08:05:00Z") });
    expect(expired.visibleTransientStatus("human-agent")).toBeUndefined();

    const withoutCapability = new NiChatStateCoordinator({ ...state, capabilities: state.capabilities.filter((item) => item !== "presence.public") });
    expect(withoutCapability.visiblePresence("agent-coder")).toBeUndefined();
  });

  test("Interaction、presence 和瞬时状态都拒绝迟到的旧事件", () => {
    const state = createMockNiChatState();
    const coordinator = new NiChatStateCoordinator(state);
    coordinator.apply({
      type: "interaction.updated",
      interaction: interaction({ state: "answered", version: 3, answer: { profileId: "me", optionId: "app", answeredAt: "2026-08-12T08:02:00Z" } }),
    });
    coordinator.apply({ type: "interaction.updated", interaction: interaction({ state: "pending", version: 2 }) });
    expect(coordinator.current.interactions["interaction-1"]?.state).toBe("answered");
    expect(coordinator.current.interactions["interaction-1"]?.version).toBe(3);

    coordinator.apply({
      type: "presence.updated",
      presence: { profileId: "agent-coder", revision: 3, state: "offline", lastSeenAt: "2026-08-12T08:05:00Z" },
    });
    coordinator.apply({
      type: "presence.updated",
      presence: { profileId: "agent-coder", revision: 2, state: "online", expiresAt: "2026-08-12T08:03:00Z" },
    });
    expect(coordinator.current.presenceByProfile["agent-coder"]?.state).toBe("offline");

    coordinator.apply({
      type: "transient.updated",
      status: { conversationId: "human-agent", profileId: "agent-coder", revision: 3, kind: "typing", expiresAt: "2026-08-12T08:06:00Z" },
    });
    coordinator.apply({
      type: "transient.updated",
      status: { conversationId: "human-agent", profileId: "agent-coder", revision: 2, kind: "tool_calling", expiresAt: "2026-08-12T08:04:00Z" },
    });
    expect(coordinator.current.transientByConversation["human-agent"]?.kind).toBe("typing");

    coordinator.apply({
      type: "presence.updated",
      presence: { profileId: "agent-coder", state: "online", expiresAt: "2026-08-12T08:30:00Z" },
    } as unknown as NiChatEvent);
    coordinator.apply({
      type: "transient.updated",
      status: { conversationId: "human-agent", profileId: "agent-coder", kind: "tool_calling", expiresAt: "2026-08-12T08:30:00Z" },
    } as unknown as NiChatEvent);
    coordinator.apply({
      type: "interaction.updated",
      interaction: { ...interaction({ state: "pending" }), version: undefined },
    } as unknown as NiChatEvent);
    expect(coordinator.current.presenceByProfile["agent-coder"]?.state).toBe("offline");
    expect(coordinator.current.presenceByProfile["agent-coder"]?.revision).toBe(3);
    expect(coordinator.current.transientByConversation["human-agent"]?.kind).toBe("typing");
    expect(coordinator.current.transientByConversation["human-agent"]?.revision).toBe(3);
    expect(coordinator.current.interactions["interaction-1"]?.state).toBe("answered");
    expect(coordinator.current.interactions["interaction-1"]?.version).toBe(3);
  });

  test("畸形消息信封不会抛错、毒化会话或用字符串 revision 错序", () => {
    const state = createMockNiChatState();
    state.messagesByConversation["human-agent"] = [];
    const coordinator = new NiChatStateCoordinator(state);
    expect(() => coordinator.apply({
      type: "message.created",
      message: { ...message({ id: "bad-date", conversationId: "human-agent", senderId: "agent-coder" }), createdAt: undefined },
    } as unknown as NiChatEvent)).not.toThrow();
    expect(coordinator.current.messagesByConversation["human-agent"]?.[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");

    expect(() => coordinator.apply({
      type: "message.created",
      message: message({ id: "normal-after-bad", conversationId: "human-agent", senderId: "agent-coder", createdAt: "2026-08-12T08:01:00Z" }),
    })).not.toThrow();
    expect(coordinator.current.messagesByConversation["human-agent"]).toHaveLength(2);

    coordinator.apply({
      type: "message.updated",
      message: { ...message({ id: "normal-after-bad", conversationId: "human-agent", senderId: "agent-coder", parts: [{ kind: "text", text: "不得覆盖" }] }), revision: "10" },
    } as unknown as NiChatEvent);
    expect(coordinator.current.messagesByConversation["human-agent"]?.find((item) => item.id === "normal-after-bad")?.parts)
      .toEqual([{ kind: "text", text: "hello" }]);

    coordinator.apply({
      type: "message.created",
      message: { ...message({ id: "", conversationId: "human-agent", senderId: "agent-coder" }) },
    });
    expect(coordinator.current.messagesByConversation["human-agent"]).toHaveLength(2);
  });

  test("conversation.updated 按 revision 单调收敛", () => {
    const state = createMockNiChatState();
    const coordinator = new NiChatStateCoordinator(state);
    const current = state.conversations.find((item) => item.id === "human-agent")!;
    coordinator.apply({
      type: "conversation.updated",
      conversation: { ...current, revision: 3, lastMessagePreview: "当前预览", unreadCount: 2 },
    });
    coordinator.apply({
      type: "conversation.updated",
      conversation: { ...current, revision: 2, lastMessagePreview: "迟到旧预览", unreadCount: 42 },
    });
    const result = coordinator.current.conversations.find((item) => item.id === "human-agent");
    expect(result?.lastMessagePreview).toBe("当前预览");
    expect(result?.unreadCount).toBe(2);
    expect(result?.revision).toBe(3);
  });

  test("新会话消息早于摘要到达时有界缓冲，并在摘要建立后重放", () => {
    const coordinator = new NiChatStateCoordinator(createMockNiChatState());
    coordinator.apply({
      type: "message.updated",
      message: message({
        id: "brand-new-message",
        conversationId: "brand-new",
        senderId: "human-alice",
        revision: 2,
        parts: [{ kind: "text", text: "第二版" }],
      }),
    });
    coordinator.apply({
      type: "message.created",
      message: message({
        id: "brand-new-message",
        conversationId: "brand-new",
        senderId: "human-alice",
        revision: 1,
        parts: [{ kind: "text", text: "第一版" }],
      }),
    });
    expect(coordinator.current.messagesByConversation["brand-new"]).toBeUndefined();
    coordinator.apply({
      type: "conversation.updated",
      conversation: {
        id: "brand-new",
        revision: 1,
        type: "private",
        participantIds: ["me", "human-alice"],
        lastMessagePreview: "第二版",
        lastMessageAt: "2026-08-12T08:00:00Z",
        unreadCount: 1,
      },
    });
    expect(coordinator.current.messagesByConversation["brand-new"]?.[0]?.revision).toBe(2);
    expect(coordinator.current.messagesByConversation["brand-new"]?.[0]?.parts).toEqual([{ kind: "text", text: "第二版" }]);
  });

  test("所有协议时间进入状态前统一为 UTC，混合时区仍按绝对时间排序", () => {
    const state = createMockNiChatState();
    state.messagesByConversation["human-agent"] = [];
    const coordinator = new NiChatStateCoordinator(state);
    coordinator.apply({
      type: "message.created",
      message: message({ id: "later", conversationId: "human-agent", senderId: "agent-coder", createdAt: "2026-08-12T09:00:00Z" }),
    });
    coordinator.apply({
      type: "message.created",
      message: message({ id: "earlier", conversationId: "human-agent", senderId: "agent-coder", createdAt: "2026-08-12T16:00:00+08:00" }),
    });
    expect(coordinator.current.messagesByConversation["human-agent"]?.map((item) => item.id)).toEqual(["earlier", "later"]);
    expect(coordinator.current.messagesByConversation["human-agent"]?.map((item) => item.createdAt)).toEqual([
      "2026-08-12T08:00:00.000Z",
      "2026-08-12T09:00:00.000Z",
    ]);
  });

  test("TTL 非法时 fail-closed，不永久显示在线或输入状态", () => {
    const state = createMockNiChatState();
    state.presenceByProfile["agent-coder"] = {
      profileId: "agent-coder",
      revision: 2,
      state: "online",
      expiresAt: "不是时间",
    };
    state.transientByConversation["human-agent"] = {
      conversationId: "human-agent",
      profileId: "agent-coder",
      revision: 2,
      kind: "typing",
      expiresAt: "",
    };
    const coordinator = new NiChatStateCoordinator(state, { now: () => Date.parse("2099-01-01T00:00:00Z") });
    expect(coordinator.visiblePresence("agent-coder")).toBeUndefined();
    expect(coordinator.visibleTransientStatus("human-agent")).toBeUndefined();
  });
});

describe("ni.chat IM client UI", () => {
  async function mount(state = createMockNiChatState()) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const adapter = createMockNiChatAdapter(state);
    const view = await mountNiChatView(root, { adapter, now: () => Date.parse("2026-08-12T08:00:30Z") });
    return { root, adapter, view };
  }

  /* A4-6 之后初始是未选态：依赖「挂载即进入第一个会话」的用例统一从这里起步 */
  function enterFirst(root: HTMLElement): void {
    (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
  }

  /* A4-14：模拟在输入框里打字——value 变化 + 光标在末尾 + input 事件；
     光标要在派发前就位，syncMentionTyping 读的是 selectionStart。 */
  function typeInto(input: HTMLTextAreaElement, value: string): void {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /* document 级 Esc 收栈的通用派发：从当前焦点元素冒泡（焦点不在组件里时
     从 body 起步），与真实按键路径一致。 */
  function pressEscapeKey(): void {
    const anchor = (document.activeElement instanceof HTMLElement && document.body.contains(document.activeElement)
      ? document.activeElement
      : document.body) as HTMLElement;
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  test("人、Agent、System 共用会话组件，身份只通过 badge 区分", async () => {
    const { root, view } = await mount();
    expect(root.querySelector(".ni-chat-app")).not.toBeNull();
    expect(root.querySelectorAll(".ni-conversation-item").length).toBeGreaterThanOrEqual(4);
    expect(root.querySelector('[data-profile-type="agent"]')?.textContent).toContain("Agent");
    expect(root.querySelector(".ni-conversation-item[aria-current]")).toBeNull();

    (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
    expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
    expect(root.querySelector(".ni-composer-input")?.getAttribute("aria-label")).toBe("消息内容");

    (root.querySelector('[data-conversation-id="human-human"]') as HTMLButtonElement).click();
    expect(root.querySelector(".ni-conversation-header")?.querySelector('[data-profile-type="user"]')?.textContent).toContain("人类");
    expect(root.querySelector(".ni-message-sender")?.querySelector('[data-profile-type="user"]')?.textContent).toContain("人类");

    (root.querySelector('[data-conversation-id="system-news"]') as HTMLButtonElement).click();
    expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("ni.chat 公告");
    expect(root.querySelector('[data-profile-type="system"]')?.textContent).toContain("System");
    expect(root.querySelector(".ni-message-list")?.textContent).toContain("系统维护窗口");
    expect(root.querySelector(".ni-composer-form")).toBeNull();
    expect(root.querySelector(".ni-message-reply-action")).toBeNull();
    expect(root.querySelector(".ni-message-list")?.getAttribute("role")).toBe("log");
    expect(root.querySelector(".ni-sr-live")?.getAttribute("aria-live")).toBe("polite");
    view.dispose();
  });

  test("协议边界把未知或畸形 part 归一化为安全占位，不影响其余会话", async () => {
    const state = createMockNiChatState();
    state.messagesByConversation["human-agent"]?.push(message({
      id: "future-raw",
      conversationId: "human-agent",
      senderId: "agent-coder",
      parts: [
        { kind: "future_card", payload: { unsafe: true } },
        { kind: "text" },
      ] as unknown as Message["parts"],
    }));
    const { root, adapter, view } = await mount(state);
    enterFirst(root);
    expect(root.querySelectorAll('[data-message-id="future-raw"] .ni-part-unknown')).toHaveLength(2);
    expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("代码助手");

    adapter.push({
      type: "message.created",
      message: message({
        id: "future-event",
        conversationId: "human-agent",
        senderId: "agent-coder",
        parts: [{ kind: "another_future_part" }] as unknown as Message["parts"],
      }),
    });
    await flushRender();
    expect(root.querySelector('[data-message-id="future-event"] .ni-part-unknown')?.textContent).toContain("another_future_part");
    view.dispose();
  });

  test("畸形 Profile/capability 快照安全降级，不能拖垮整个客户端", async () => {
    const state = createMockNiChatState();
    const malformed = {
      ...state,
      selfProfileId: "",
      profiles: undefined,
      participants: "not-an-array",
      capabilities: "presence.public",
      transport: "future-transport",
    } as unknown as NiChatState;
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountNiChatView(root, { adapter: createMockNiChatAdapter(malformed) });
    expect(root.querySelector(".ni-chat-app")).not.toBeNull();
    expect(root.querySelector(".ni-transport-badge")?.textContent).toBe("已连接");
    expect(root.textContent).not.toContain("在线");
    view.dispose();
  });

  test("Agent IM part 全部有显式呈现，thinking 默认折叠且 unknown 安全降级", async () => {
    const { root, view } = await mount();
    enterFirst(root);
    expect(root.querySelector(".ni-part-thinking details")?.hasAttribute("open")).toBeFalse();
    expect(root.querySelector(".ni-part-tool-call")?.textContent).toContain("search_repository");
    expect(root.querySelector(".ni-part-tool-result")?.textContent).toContain("已完成");
    expect(root.querySelector(".ni-part-file")?.textContent).toContain("release-notes.md");
    expect(root.querySelector(".ni-part-image")).not.toBeNull();
    expect(root.querySelector(".ni-part-audio")).not.toBeNull();
    expect(root.querySelector(".ni-part-video")).not.toBeNull();
    expect(root.querySelector(".ni-part-webpage")).not.toBeNull();
    expect(root.querySelector(".ni-part-unknown")?.textContent).toContain("当前版本暂不支持");
    expect(root.querySelector(".ni-message-reply")?.textContent).toContain("发布说明");
    expect(root.querySelector(".ni-mention")?.getAttribute("data-profile-id")).toBe("me");
    view.dispose();
  });

  test("搜索、切换会话和发送都走 adapter，不出现任务或 runtime 语义", async () => {
    const { root, adapter, view } = await mount();
    const search = root.querySelector(".ni-conversation-search") as HTMLInputElement;
    search.value = "Alice";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect([...root.querySelectorAll<HTMLElement>(".ni-conversation-item")].map((item) => item.dataset.conversationId)).toEqual([
      "human-human",
      "mixed-group",
    ]);

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector('[data-conversation-id="human-human"]') as HTMLButtonElement).click();
    const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    input.value = "今晚见";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector(".ni-composer-form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await adapter.whenIdle();
    expect(root.querySelector(".ni-message-list")?.textContent).toContain("今晚见");
    /* 「本机 agent」从禁词里移出：A4-3 菜单引入了设计稿的「扫描本机 Agent」入口，
       它是新建落点文案而不是 runtime 状态语义；其余三个禁词继续守着。
       A4-7 的任务锚点入口同理是稿定 UI——可见文案用「锚点」两字，完整词
       「任务锚点」只出现在 aria-label/title 里，不进 textContent。 */
    expect(root.textContent).not.toMatch(/任务锚点|工作中|provider/i);
    view.dispose();
  });

  test("会话内 Interaction 提交一次答案并收敛为已回答", async () => {
    const { root, adapter, view } = await mount();
    enterFirst(root);
    const option = root.querySelector('[data-interaction-id="interaction-1"] .ni-interaction-option') as HTMLButtonElement;
    expect(option).not.toBeNull();
    option.click();
    await adapter.whenIdle();
    expect(root.querySelector('[data-interaction-id="interaction-1"]')?.textContent).toContain("已回答");
    expect(root.querySelector('[data-interaction-id="interaction-1"] .ni-interaction-option')).toBeNull();
    view.dispose();
  });

  test("Interaction 防止重复提交，并消费 adapter 返回值而不依赖推送回声", async () => {
    const state = createMockNiChatState();
    let answers = 0;
    const adapter: NiChatAdapter = {
      async getSnapshot() { return structuredClone(state); },
      subscribe() { return () => undefined; },
      async sendMessage() { throw new Error("NOT_USED"); },
      async answerInteraction(input) {
        answers += 1;
        const current = state.interactions[input.interactionId]!;
        return {
          ...current,
          state: "answered",
          version: current.version + 1,
          answer: { profileId: "me", optionId: input.answer.optionId, answeredAt: "2026-08-12T08:03:00Z" },
        };
      },
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountNiChatView(root, { adapter });
    enterFirst(root);
    const option = root.querySelector('[data-interaction-id="interaction-1"] .ni-interaction-option') as HTMLButtonElement;
    option.click();
    option.click();
    await flushRender();
    expect(answers).toBe(1);
    expect(root.querySelector('[data-interaction-id="interaction-1"]')?.textContent).toContain("已回答");
    view.dispose();
  });

  test("开放文本 Interaction 也由客户端表单提交并收敛", async () => {
    const state = createMockNiChatState();
    state.interactions["interaction-open"] = interaction({
      id: "interaction-open",
      prompt: "还需要补充什么？",
      schema: { kind: "text", placeholder: "补充说明", maxLength: 120 },
    });
    state.messagesByConversation["human-agent"]?.push(message({
      id: "ha-open",
      conversationId: "human-agent",
      senderId: "agent-coder",
      parts: [{ kind: "interaction_ref", interactionId: "interaction-open" }],
    }));
    const { root, adapter, view } = await mount(state);
    enterFirst(root);
    const input = root.querySelector('[data-interaction-id="interaction-open"] .ni-interaction-text') as HTMLTextAreaElement;
    input.value = "把升级提醒也写进去";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector('[data-interaction-id="interaction-open"] .ni-interaction-open-form') as HTMLFormElement)
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await adapter.whenIdle();
    expect(root.querySelector('[data-interaction-id="interaction-open"]')?.textContent).toContain("已回答");
    expect(root.querySelector('[data-interaction-id="interaction-open"]')?.textContent).toContain("把升级提醒也写进去");
    view.dispose();
  });

  test("订阅先于快照并缓冲竞态事件，初始化期间不会丢消息", async () => {
    const state = createMockNiChatState();
    state.messagesByConversation["human-agent"] = [];
    const currentConversation = state.conversations.find((item) => item.id === "human-agent")!;
    currentConversation.revision = 2;
    currentConversation.lastMessagePreview = "快照中的当前预览";
    currentConversation.unreadCount = 2;
    let listener: ((event: NiChatEvent) => void) | undefined;
    const racedMessage = message({
      id: "snapshot-race",
      conversationId: "human-agent",
      senderId: "agent-coder",
      parts: [{ kind: "text", text: "初始化期间到达" }],
    });
    const adapter: NiChatAdapter = {
      subscribe(next) {
        listener = next;
        return () => { listener = undefined; };
      },
      async getSnapshot() {
        listener?.({
          type: "conversation.updated",
          conversation: { ...currentConversation, revision: 1, lastMessagePreview: "初始化竞态期的旧数据", unreadCount: 42 },
        });
        listener?.({ type: "message.created", message: racedMessage });
        return structuredClone(state);
      },
      async sendMessage() { throw new Error("NOT_USED"); },
      async answerInteraction() { throw new Error("NOT_USED"); },
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountNiChatView(root, { adapter });
    enterFirst(root);
    expect(root.querySelector('[data-message-id="snapshot-race"]')?.textContent).toContain("初始化期间到达");
    const sidebarItem = root.querySelector('[data-conversation-id="human-agent"]');
    expect(sidebarItem?.textContent).toContain("快照中的当前预览");
    expect(sidebarItem?.querySelector(".ni-unread")?.textContent).toBe("2");
    view.dispose();
  });

  test("增量协议事件保留 composer 和开放 Interaction 的草稿、焦点与光标", async () => {
    const state = createMockNiChatState();
    state.interactions["interaction-open"] = interaction({
      id: "interaction-open",
      schema: { kind: "text", placeholder: "补充说明" },
    });
    state.messagesByConversation["human-agent"]?.push(message({
      id: "ha-open-focus",
      conversationId: "human-agent",
      senderId: "agent-coder",
      parts: [{ kind: "interaction_ref", interactionId: "interaction-open" }],
    }));
    const { root, adapter, view } = await mount(state);
    enterFirst(root);

    const composer = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    composer.value = "正在输入的消息";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.focus();
    composer.setSelectionRange(2, 5);
    adapter.push({
      type: "presence.updated",
      presence: { profileId: "agent-coder", revision: 2, state: "online", expiresAt: "2026-08-12T08:20:00Z" },
    });
    await flushRender();
    const composerAfter = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    expect(composerAfter.value).toBe("正在输入的消息");
    expect(document.activeElement).toBe(composerAfter);
    expect([composerAfter.selectionStart, composerAfter.selectionEnd]).toEqual([2, 5]);

    const interactionInput = root.querySelector('[data-interaction-id="interaction-open"] .ni-interaction-text') as HTMLTextAreaElement;
    interactionInput.value = "尚未提交的回答";
    interactionInput.dispatchEvent(new Event("input", { bubbles: true }));
    interactionInput.focus();
    interactionInput.setSelectionRange(1, 4);
    adapter.push({
      type: "transient.updated",
      status: { conversationId: "human-agent", profileId: "agent-coder", revision: 2, kind: "typing", expiresAt: "2026-08-12T08:21:00Z" },
    });
    await flushRender();
    const interactionAfter = root.querySelector('[data-interaction-id="interaction-open"] .ni-interaction-text') as HTMLTextAreaElement;
    expect(interactionAfter.value).toBe("尚未提交的回答");
    expect(document.activeElement).toBe(interactionAfter);
    expect([interactionAfter.selectionStart, interactionAfter.selectionEnd]).toEqual([1, 4]);
    view.dispose();
  });

  test("同步重绘保留输入区控件焦点，历史未贴底时保留滚动位置", async () => {
    const { root, adapter, view } = await mount();
    enterFirst(root);
    /* A4-14 起 @ 选择器由打字符触发（无按钮），输入区控件的同步重绘焦点
       保持改用「+」触发钮验证——同一套 captureFocus/restoreFocus 机制。 */
    const attach = root.querySelector(".ni-composer-attach") as HTMLButtonElement;
    attach.focus();
    attach.click();
    await flushRender();
    const attachAfter = root.querySelector(".ni-composer-attach") as HTMLButtonElement;
    expect(document.activeElement).toBe(attachAfter);
    expect(root.querySelector(".ni-plus-menu")).not.toBeNull();
    pressEscapeKey();
    expect(root.querySelector(".ni-plus-menu")).toBeNull();

    const composer = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    composer.focus();
    composer.setSelectionRange(0, 0);
    adapter.push({
      type: "presence.updated",
      presence: { profileId: "agent-coder", revision: 2, state: "online", expiresAt: "2026-08-12T08:20:00Z" },
    });
    await flushRender();
    const composerAfter = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(composerAfter);

    (root.querySelector('[data-message-id="ha-1"] .ni-message-reply-action') as HTMLButtonElement).click();
    await flushRender();
    const cancelReply = root.querySelector(".ni-composer-reply-cancel") as HTMLButtonElement;
    cancelReply.focus();
    cancelReply.click();
    await flushRender();
    expect(document.activeElement).toBe(root.querySelector(".ni-composer-input"));

    const list = root.querySelector(".ni-message-list") as HTMLElement;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 300, writable: true },
    });
    adapter.push({
      type: "presence.updated",
      presence: { profileId: "agent-coder", revision: 3, state: "online", expiresAt: "2026-08-12T08:20:00Z" },
    });
    await flushRender();
    expect((root.querySelector(".ni-message-list") as HTMLElement).scrollTop).toBe(300);
    view.dispose();
  });

  test("常驻 live region 跨重绘不换节点并播报新消息和瞬时状态", async () => {
    const { root, adapter, view } = await mount();
    enterFirst(root);
    const live = root.querySelector(".ni-sr-live") as HTMLElement;
    adapter.push({
      type: "message.created",
      message: message({
        id: "live-message",
        conversationId: "human-agent",
        senderId: "agent-coder",
        parts: [{ kind: "text", text: "需要播报的新消息" }],
      }),
    });
    await flushRender();
    await flushRender();
    expect(root.querySelector(".ni-sr-live")).toBe(live);
    expect(live.textContent).toContain("代码助手：需要播报的新消息");

    adapter.push({
      type: "transient.updated",
      status: { conversationId: "human-agent", profileId: "agent-coder", revision: 2, kind: "tool_calling", expiresAt: "2026-08-12T08:20:00Z" },
    });
    await flushRender();
    await flushRender();
    expect(root.querySelector(".ni-sr-live")).toBe(live);
    expect(live.textContent).toBe("正在调用工具…");

    adapter.push({
      type: "message.created",
      message: message({
        id: "other-conversation-live",
        conversationId: "human-human",
        senderId: "human-alice",
        parts: [{ kind: "text", text: "这条在别的会话里" }],
      }),
    });
    await flushRender();
    await flushRender();
    expect(live.textContent).toBe("正在调用工具…");

    adapter.push({
      type: "message.created",
      message: message({
        id: "ghost-live",
        conversationId: "missing-conversation",
        senderId: "human-alice",
        parts: [{ kind: "text", text: "幽灵会话消息" }],
      }),
    });
    await flushRender();
    expect(live.textContent).toBe("正在调用工具…");
    expect((await adapter.getSnapshot()).messagesByConversation["missing-conversation"]).toBeUndefined();
    view.dispose();
  });

  test("侧栏按 pinned 优先、其余会话按最新消息时间重排", async () => {
    const { root, adapter, view } = await mount();
    (root.querySelector('button[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
    const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    input.value = "让发布小组浮到前面";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector(".ni-composer-form") as HTMLFormElement)
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await adapter.whenIdle();
    await flushRender();
    const order = Array.from(root.querySelectorAll<HTMLElement>("button.ni-conversation-item"))
      .map((item) => item.dataset.conversationId);
    expect(order.slice(0, 2)).toEqual(["human-agent", "mixed-group"]);
    view.dispose();
  });

  /* ===== B6-3：中栏状态分组（需要你确认 / 工作中 / 全部，对照稿 renderAgentList）=====
     段头文案「组名 · 数量」、需要你确认组带 alert、空组整组不渲染、置顶在分组外。
     状态映射：needsActionCount>0 → 确认组；活跃非本人 transient → 工作中；其余 → 全部。 */
  describe("中栏状态分组（B6-3）", () => {
    function groupHeaders(root: HTMLElement): string[] {
      return Array.from(root.querySelectorAll<HTMLElement>(".ni-conversation-group-key"))
        .map((node) => node.textContent ?? "");
    }

    function groupOf(root: HTMLElement, conversationId: string): string {
      const item = root.querySelector(`[data-conversation-id="${conversationId}"]`);
      let node = item?.previousElementSibling ?? null;
      while (node && !node.classList.contains("ni-conversation-group")) {
        node = node.previousElementSibling;
      }
      return node?.querySelector(".ni-conversation-group-key")?.textContent ?? "";
    }

    /* 分组夹具：置顶 human-agent（带 needsAction + transient，按稿不进组）；
       mixed-group 等确认；agent-agent 工作中；其余（human-human、system-news）落全部。 */
    function groupedState() {
      const state = createMockNiChatState();
      const mixed = state.conversations.find((item) => item.id === "mixed-group")!;
      mixed.needsActionCount = 2;
      state.transientByConversation["agent-agent"] = {
        conversationId: "agent-agent",
        profileId: "agent-research",
        revision: 1,
        kind: "tool_calling",
        expiresAt: new Date(Date.parse("2026-08-12T08:00:30Z") + 60_000).toISOString(),
      };
      return state;
    }

    test("段头对稿：组名 · 数量，需要你确认带 alert，空组不渲染，顺序确认→工作中→全部", async () => {
      const { root, view } = await mount(groupedState());
      expect(groupHeaders(root)).toEqual(["需要你确认 · 1", "工作中 · 1", "全部 · 4"]);
      expect(root.querySelector(".ni-conversation-group-key.alert")?.textContent).toBe("需要你确认 · 1");
      // 归组：置顶在分组外（human-agent 不在任何组内条目之前有段头）。
      expect(groupOf(root, "mixed-group")).toBe("需要你确认 · 1");
      expect(groupOf(root, "agent-agent")).toBe("工作中 · 1");
      expect(groupOf(root, "human-human")).toBe("全部 · 4");
      // 置顶分隔线存在，且置顶项仍是列表第一项。
      expect(root.querySelector(".ni-pin-rule")).not.toBeNull();
      const first = root.querySelector<HTMLButtonElement>("button.ni-conversation-item");
      expect(first?.dataset.conversationId).toBe("human-agent");
      view.dispose();
    });

    test("默认夹具只有「全部」一组：空组不渲染、无数据不编段", async () => {
      const { root, view } = await mount();
      // 默认态：非置顶会话既没 needsAction 也没活跃非本人 transient——只渲染「全部」。
      // （human-agent 的 transient 在置顶项上，按稿不参与分组。）
      expect(groupHeaders(root)).toEqual(["全部 · 6"]);
      expect(root.querySelector(".ni-conversation-group-key.alert")).toBeNull();
      view.dispose();
    });

    test("已过期的 transient 不算工作中；自己的 transient 也不算", async () => {
      const state = groupedState();
      state.transientByConversation["agent-agent"]!.expiresAt = "2026-08-12T07:00:00Z"; // 早于注入时钟
      state.transientByConversation["human-human"] = {
        conversationId: "human-human",
        profileId: "me", // 自己在打字——这组会话不该因此进「工作中」
        revision: 1,
        kind: "typing",
        expiresAt: new Date(Date.parse("2026-08-12T08:00:30Z") + 60_000).toISOString(),
      };
      const { root, view } = await mount(state);
      expect(groupHeaders(root)).toEqual(["需要你确认 · 1", "全部 · 5"]);
      view.dispose();
    });

    test("同一会话既待确认又在干活：wait 优先，三组互斥、DOM 只出现一份", async () => {
      const state = groupedState();
      // mixed-group 已有 needsActionCount=2，再给它加一个活跃的非本人 transient。
      state.transientByConversation["mixed-group"] = {
        conversationId: "mixed-group",
        profileId: "agent-coder",
        revision: 1,
        kind: "thinking",
        expiresAt: new Date(Date.parse("2026-08-12T08:00:30Z") + 60_000).toISOString(),
      };
      const { root, view } = await mount(state);
      expect(groupHeaders(root)).toEqual(["需要你确认 · 1", "工作中 · 1", "全部 · 4"]);
      expect(root.querySelectorAll('[data-conversation-id="mixed-group"]')).toHaveLength(1);
      expect(groupOf(root, "mixed-group")).toBe("需要你确认 · 1");
      view.dispose();
    });

    test("搜索过滤先于分组：命中之外的组整组隐藏", async () => {
      const { root, view } = await mount(groupedState());
      const search = root.querySelector(".ni-conversation-search") as HTMLInputElement;
      search.value = "接口证据"; // 只命中 agent-agent（工作组的那个）
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await flushRender();
      expect(groupHeaders(root)).toEqual(["工作中 · 1"]);
      view.dispose();
    });

    test("工作中到点自动移出：transient 过期触发重绘，落回「全部」", async () => {
      // 真实时钟 + 短 TTL：visibleTransientStatus 判过期只在重渲染时发生，
      // 这条用例钉「到期闹钟」——没有它，到期的那条会一直赖在「工作中」。
      const state = createMockNiChatState();
      const expiresAt = new Date(Date.now() + 60).toISOString();
      state.transientByConversation["agent-agent"] = {
        conversationId: "agent-agent",
        profileId: "agent-research",
        revision: 1,
        kind: "thinking",
        expiresAt,
      };
      const root = document.createElement("div");
      document.body.appendChild(root);
      const adapter = createMockNiChatAdapter(state);
      const view = await mountNiChatView(root, { adapter, now: () => Date.now() });
      expect(groupHeaders(root)).toEqual(["工作中 · 1", "全部 · 5"]);
      await new Promise((resolve) => setTimeout(resolve, 220));
      await flushRender();
      expect(groupHeaders(root)).toEqual(["全部 · 6"]);
      view.dispose();
    });

    test("dispose 清掉到期闹钟：卸载后到点不重绘、不抛错", async () => {
      const state = createMockNiChatState();
      state.transientByConversation["agent-agent"] = {
        conversationId: "agent-agent",
        profileId: "agent-research",
        revision: 1,
        kind: "thinking",
        expiresAt: new Date(Date.now() + 60).toISOString(),
      };
      const root = document.createElement("div");
      document.body.appendChild(root);
      const adapter = createMockNiChatAdapter(state);
      const view = await mountNiChatView(root, { adapter, now: () => Date.now() });
      expect(groupHeaders(root)).toEqual(["工作中 · 1", "全部 · 5"]);
      // 钉住「闹钟确实被 clearTimeout」而不只靠 disposed 早退兜底：spy 全局
      // clearTimeout，dispose 时必须清掉一个真实句柄（此刻活跃的正是到期闹钟）。
      const cleared: unknown[] = [];
      const originalClearTimeout = globalThis.clearTimeout;
      globalThis.clearTimeout = ((handle?: unknown) => {
        cleared.push(handle);
        if (handle !== undefined && handle !== null) {
          originalClearTimeout(handle as Parameters<typeof originalClearTimeout>[0]);
        }
      }) as typeof clearTimeout;
      try {
        view.dispose();
      } finally {
        globalThis.clearTimeout = originalClearTimeout;
      }
      expect(cleared.some((handle) => handle !== undefined && handle !== null)).toBe(true);
      // dispose 已把根清空——跨过到期线后不应有任何重建（也没有未捕获异常）。
      await new Promise((resolve) => setTimeout(resolve, 150));
      await flushRender();
      expect(root.querySelector(".ni-conversation-group")).toBeNull();
      expect(root.querySelector(".ni-conversation-item")).toBeNull();
    });
  });

  test("mention 与 reply 展示只信任本地 profile 和原消息，不信任远端摘要标签", async () => {
    const state = createMockNiChatState();
    const response = state.messagesByConversation["human-agent"]?.find((candidate) => candidate.id === "ha-2");
    if (!response) throw new Error("fixture missing");
    response.replyTo = { messageId: "ha-1", senderLabel: "伪造管理员", preview: "伪造摘要" };
    response.parts.push({
      kind: "text",
      text: "提及校验",
      mentions: [
        { profileId: "system-ni", label: "伪造客服" },
        { profileId: "missing-profile", label: "伪造账号" },
      ],
    });
    const { root, view } = await mount(state);
    enterFirst(root);
    const reply = root.querySelector('[data-message-id="ha-2"] .ni-message-reply')?.textContent ?? "";
    expect(reply).toContain("你：帮我整理这版发布说明");
    expect(reply).not.toMatch(/伪造管理员|伪造摘要/);
    const mentions = [...root.querySelectorAll<HTMLElement>('[data-message-id="ha-2"] .ni-mention')].map((node) => node.textContent);
    expect(mentions).toContain("@ni.chat 系统");
    expect(mentions).toContain("@未知账号");
    expect(root.querySelector(".ni-mention.is-unresolved")).not.toBeNull();
    view.dispose();
  });

  test("引用已删除消息只显示删除态，不泄露原文", async () => {
    const state = createMockNiChatState();
    state.messagesByConversation["human-human"] = [
      message({
        id: "deleted-original",
        conversationId: "human-human",
        senderId: "human-alice",
        deletedAt: "2026-08-12T08:01:00Z",
        parts: [{ kind: "text", text: "这条已撤回的敏感原文" }],
      }),
      message({
        id: "reply-deleted",
        conversationId: "human-human",
        senderId: "me",
        replyTo: { messageId: "deleted-original", senderLabel: "伪造", preview: "伪造" },
        parts: [{ kind: "text", text: "收到" }],
        createdAt: "2026-08-12T08:02:00Z",
      }),
    ];
    const { root, view } = await mount(state);
    (root.querySelector('[data-conversation-id="human-human"]') as HTMLButtonElement).click();
    const reply = root.querySelector('[data-message-id="reply-deleted"] .ni-message-reply')?.textContent ?? "";
    expect(reply).toBe("Alice：消息已删除");
    expect(reply).not.toContain("敏感原文");
    view.dispose();
  });

  test("未知 Interaction schema 安全降级，不伪装成可提交文本表单", async () => {
    const state = createMockNiChatState();
    state.interactions["interaction-1"]!.schema = { kind: "future_form" } as unknown as Interaction["schema"];
    const { root, view } = await mount(state);
    enterFirst(root);
    const card = root.querySelector('[data-interaction-id="interaction-1"]');
    expect(card?.querySelector(".ni-interaction-text")).toBeNull();
    expect(card?.querySelector(".ni-interaction-submit")).toBeNull();
    expect(card?.querySelector(".ni-part-unknown")?.textContent).toContain("future_form");
    view.dispose();
  });

  test("choice 空 label 回落到稳定 option id，不渲染无名称按钮", async () => {
    const state = createMockNiChatState();
    state.interactions["interaction-1"]!.schema = {
      kind: "choice",
      options: [{ id: "approve", label: " " }, { id: "reject", label: "拒绝" }],
    };
    const { root, view } = await mount(state);
    enterFirst(root);
    const labels = Array.from(root.querySelectorAll<HTMLButtonElement>(".ni-interaction-option"))
      .map((button) => button.textContent);
    expect(labels).toEqual(["approve", "拒绝"]);
    expect(labels.every((label) => Boolean(label?.trim()))).toBeTrue();
    view.dispose();
  });

  test("adapter 机器错误转换成用户可读中文，不暴露内部错误码", async () => {
    const base = createMockNiChatAdapter(createMockNiChatState());
    const adapter: NiChatAdapter = {
      getSnapshot: () => base.getSnapshot(),
      subscribe: (listener) => base.subscribe(listener),
      async sendMessage() { throw new Error("NETWORK_UNAVAILABLE"); },
      answerInteraction: (input) => base.answerInteraction(input),
    };
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountNiChatView(root, { adapter });
    enterFirst(root);
    const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    input.value = "测试错误";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector(".ni-composer-form") as HTMLFormElement)
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flushRender();
    expect(root.querySelector(".ni-client-note")?.textContent).toBe("网络暂时不可用，请稍后重试");
    expect(root.textContent).not.toContain("NETWORK_UNAVAILABLE");
    view.dispose();
  });

  test("composer 创建稳定 profile ID mention 和结构化 reply", async () => {
    const { root, adapter, view } = await mount();
    (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
    (root.querySelector('[data-message-id="mg-1"] .ni-message-reply-action') as HTMLButtonElement).click();
    expect(root.querySelector(".ni-composer-reply")?.textContent).toContain("封面需要再确认一下");

    /* A4-14：打 @ 字符触发成员选择（不再有触发按钮），点候选回填 */
    const composer = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    typeInto(composer, "@");
    expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
    (root.querySelector('[data-mention-profile-id="human-alice"]') as HTMLButtonElement).click();
    await flushRender();
    const composerAfter = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
    expect(composerAfter.value).toBe("@Alice ");
    expect(root.querySelector('[data-composer-mention-id="human-alice"]')?.textContent).toContain("Alice");

    composerAfter.value = "收到，我来确认";
    composerAfter.dispatchEvent(new Event("input", { bubbles: true }));
    (root.querySelector(".ni-composer-form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await adapter.whenIdle();

    const sent = (await adapter.getSnapshot()).messagesByConversation["mixed-group"]?.at(-1);
    expect(sent?.replyTo?.messageId).toBe("mg-1");
    expect(sent?.parts[0]).toEqual({
      kind: "text",
      text: "收到，我来确认",
      mentions: [{ profileId: "human-alice", label: "Alice" }],
    });
    view.dispose();
  });

  describe("「+」菜单与三个新建落点（A4-3/A4-4）", () => {
    function menuLabels(root: HTMLElement): string[] {
      return Array.from(root.querySelectorAll(".ni-add-menu-item")).map((item) => item.textContent ?? "");
    }

    function openMenu(root: HTMLElement): void {
      (root.querySelector(".ni-add-contact") as HTMLButtonElement).click();
    }

    function pickMenu(root: HTMLElement, am: string): void {
      (root.querySelector(`.ni-add-menu-item[data-am="${am}"]`) as HTMLButtonElement).click();
    }

    function pressEscape(root: HTMLElement): void {
      /* 按真实路径派发：焦点在哪就从哪冒泡（焦点不在浮层内也要能关掉），
         只有焦点完全不在组件里时才退回 root。 */
      const anchor = (document.activeElement instanceof HTMLElement && document.body.contains(document.activeElement)
        ? document.activeElement
        : root) as HTMLElement;
      anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    test("菜单条目逐字对照设计稿，含演示分隔项；开合受 aria-expanded 与外部点击约束", async () => {
      const { root, view } = await mount();
      const toggle = root.querySelector(".ni-add-contact") as HTMLButtonElement;
      expect(root.querySelector(".ni-add-menu")).not.toBeNull();
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);
      expect(toggle.getAttribute("aria-haspopup")).toBe("menu");

      openMenu(root);
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(true);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(menuLabels(root)).toEqual(["添加 Agent", "发起群聊", "扫描本机 Agent", "（演示）重置为出厂状态"]);
      expect(root.querySelector(".ni-add-menu-sep")).not.toBeNull();
      const reset = root.querySelector('.ni-add-menu-item[data-am="reset"]') as HTMLButtonElement;
      expect(reset.disabled).toBe(true);
      expect(reset.title).toContain("ni.chat 协议同步");

      document.body.click();
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      openMenu(root);
      toggle.click();
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);
      view.dispose();
    });

    test("「添加 Agent」转交置顶的外脑会话：切回置顶会话并预填开场话", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="human-human"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("Alice");

      openMenu(root);
      pickMenu(root, "add");
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      expect(input.value).toBe("我想加一个 agent，它负责……");
      view.dispose();
    });

    test("没有可转交的置顶会话时给诚实提示，不静默也不造表单", async () => {
      const state = createMockNiChatState();
      state.conversations = state.conversations.map((conversation) => ({ ...conversation, pinned: false }));
      const { root, view } = await mount(state);
      openMenu(root);
      pickMenu(root, "add");
      expect(root.querySelector(".ni-client-note")?.textContent)
        .toBe("还没有可以转交的置顶会话，先把外脑会话置顶再从这里转交");
      view.dispose();
    });

    test("发起群聊浮层：结构逐字、勾选反馈与两条校验文案对照稿", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "group");
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);
      const overlay = root.querySelector('.ni-overlay[data-overlay="new-group"]') as HTMLElement;
      expect(overlay.hidden).toBe(false);
      expect(root.querySelector('.ni-overlay[data-overlay="new-group"] .ni-overlay-title')?.textContent).toBe("发起群聊");
      const nameInput = root.querySelector(".ni-new-group-name") as HTMLInputElement;
      expect(nameInput.placeholder).toBe("这个群叫什么，比如「AI Board 01 发布小组」");
      expect(root.querySelector('.ni-overlay[data-overlay="new-group"] .ni-overlay-foot')?.textContent)
        .toBe("点选成员 · 填好名字后建群 · Esc 取消");

      const candidates = Array.from(root.querySelectorAll(".ni-pick-item[data-pick-profile-id]")) as HTMLButtonElement[];
      expect(candidates.map((item) => item.textContent)).toEqual(["C代码助手@code-helper✓", "R研究助手@research-helper✓", "◆Claude Code@claude-code✓", "⬡Codex@codex✓"]);
      candidates[0].click();
      expect(root.querySelector('.ni-pick-item[data-pick-profile-id="agent-coder"]')?.classList.contains("is-on")).toBe(true);
      expect(root.querySelector(".ni-pick-go")?.textContent).toBe("建群 · 已选 1 人");

      (root.querySelector(".ni-pick-go") as HTMLButtonElement).click();
      expect(nameInput.placeholder).toBe("先给它起个名字——不然过两天你也认不出这是干嘛的群");
      expect(nameInput.classList.contains("shake")).toBe(true);
      expect(overlay.hidden).toBe(false);

      nameInput.value = "发布小组";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector(".ni-pick-item[data-pick-profile-id='agent-coder']") as HTMLButtonElement).click();
      (root.querySelector(".ni-pick-go") as HTMLButtonElement).click();
      expect(nameInput.placeholder).toBe("还要挑至少一个 agent 进来");
      view.dispose();
    });

    test("建群表单校验通过后停在协议边界：提示接入后开放、浮层不假关", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "group");
      const nameInput = root.querySelector(".ni-new-group-name") as HTMLInputElement;
      nameInput.value = "发布小组";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector('.ni-pick-item[data-pick-profile-id="agent-coder"]') as HTMLButtonElement).click();
      (root.querySelector(".ni-pick-go") as HTMLButtonElement).click();
      const overlay = root.querySelector('.ni-overlay[data-overlay="new-group"]') as HTMLElement;
      expect(overlay.hidden).toBe(false);
      expect(root.querySelector('.ni-overlay[data-overlay="new-group"] .ni-overlay-note')?.textContent)
        .toBe("群聊创建将在 ni-chat 协议接入后开放");

      pressEscape(root);
      expect(overlay.hidden).toBe(true);
      view.dispose();
    });

    test("扫描本机 Agent 浮层：1.5 秒不确定态后出演示清单，已在列表的禁用", async () => {
      const state = createMockNiChatState();
      state.profiles["cc-local"] = {
        id: "cc-local",
        type: "agent",
        username: "claude-code",
        displayName: "Claude Code",
        avatarText: "◆",
      };
      const { root, view } = await mount(state);
      openMenu(root);
      pickMenu(root, "scan");
      const overlay = root.querySelector('.ni-overlay[data-overlay="scan-local"]') as HTMLElement;
      expect(overlay.hidden).toBe(false);
      expect(root.querySelector(".ni-scan-bar")?.classList.contains("done")).toBe(false);
      expect(root.querySelector('.ni-overlay[data-overlay="scan-local"] .ni-overlay-foot')?.textContent)
        .toBe("正在找这台机器上装了什么…");
      expect(root.querySelectorAll('.ni-overlay[data-overlay="scan-local"] .ni-pick-item').length).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 1600));
      const rows = Array.from(root.querySelectorAll('.ni-overlay[data-overlay="scan-local"] .ni-pick-item'));
      expect(rows.map((row) => row.querySelector(".ni-pick-title")?.textContent))
        .toEqual(["Claude Code", "Codex", "Gemini CLI", "Kimi Code"]);
      // B6-26 夹具新增 cc 与 codex 两个 profile：扫描清单前两行都已是列表成员。
      expect(rows[0].classList.contains("is-off")).toBe(true);
      expect(rows[1].classList.contains("is-off")).toBe(true);
      expect(rows[0].querySelector(".ni-pick-tag")?.textContent).toBe("已在列表");
      expect(rows[1].querySelector(".ni-pick-tag")?.textContent).toBe("已在列表");
      expect(rows[2].querySelector(".ni-pick-tag")?.textContent).toBe("添加");
      expect(root.querySelector(".ni-scan-bar")?.classList.contains("done")).toBe(true);
      expect(root.querySelector('.ni-overlay[data-overlay="scan-local"] .ni-overlay-foot')?.textContent)
        .toBe("点按添加 · Esc 关闭");

      (rows[2] as HTMLButtonElement).click();
      expect(root.querySelector('.ni-overlay[data-overlay="scan-local"] .ni-overlay-note')?.textContent)
        .toBe("添加本机 Agent 将在 ni-chat 协议接入后开放");

      pressEscape(root);
      expect(overlay.hidden).toBe(true);
      view.dispose();
    });

    test("能找到的都已在列表时脚注如实说，且全部行禁用", async () => {
      const state = createMockNiChatState();
      const found = [
        { id: "cc", username: "claude-code", displayName: "Claude Code", avatarText: "◆" },
        { id: "codex", username: "codex", displayName: "Codex", avatarText: "⬡" },
        { id: "gemini", username: "gemini", displayName: "Gemini CLI", avatarText: "✦" },
        { id: "kimi", username: "kimi", displayName: "Kimi Code", avatarText: "◇" },
      ];
      found.forEach((profile) => {
        state.profiles[profile.id] = { ...profile, type: "agent" };
      });
      const { root, view } = await mount(state);
      openMenu(root);
      pickMenu(root, "scan");
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(root.querySelector('.ni-overlay[data-overlay="scan-local"] .ni-overlay-foot')?.textContent)
        .toBe("这台机器上能找到的都已经在列表里了 · Esc 关闭");
      expect(root.querySelectorAll('.ni-overlay[data-overlay="scan-local"] .ni-pick-item.is-off').length).toBe(4);
      view.dispose();
    });

    test("两个落点浮层互斥：后开替换先开，菜单与浮层不同时在场", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "group");
      const groupOverlay = root.querySelector('.ni-overlay[data-overlay="new-group"]') as HTMLElement;
      const scanOverlayEl = root.querySelector('.ni-overlay[data-overlay="scan-local"]') as HTMLElement;
      expect(groupOverlay.hidden).toBe(false);
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);

      pressEscape(root);
      openMenu(root);
      pickMenu(root, "scan");
      expect(groupOverlay.hidden).toBe(true);
      expect(scanOverlayEl.hidden).toBe(false);
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);

      pressEscape(root);
      expect(scanOverlayEl.hidden).toBe(true);
      expect((document.activeElement as HTMLElement).className).toContain("ni-add-contact");
      view.dispose();
    });

    test("Esc 走 document 级收栈：菜单和浮层都不依赖焦点位置", async () => {
      const { root, view } = await mount();
      openMenu(root);
      // 焦点留在 body（从没进过组件），Esc 也要能收菜单
      (document.activeElement as HTMLElement | null)?.blur?.();
      pressEscape(root);
      expect(root.querySelector(".ni-add-menu")?.classList.contains("open")).toBe(false);

      openMenu(root);
      pickMenu(root, "scan");
      (document.activeElement as HTMLElement | null)?.blur?.();
      pressEscape(root);
      expect((root.querySelector('.ni-overlay[data-overlay="scan-local"]') as HTMLElement).hidden).toBe(true);
      view.dispose();
    });

    test("名字框 Enter 等价建群：空名先校验，齐了停在协议边界", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "group");
      const nameInput = root.querySelector(".ni-new-group-name") as HTMLInputElement;
      nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(nameInput.placeholder).toBe("先给它起个名字——不然过两天你也认不出这是干嘛的群");

      nameInput.value = "发布小组";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector('.ni-pick-item[data-pick-profile-id="agent-coder"]') as HTMLButtonElement).click();
      nameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(root.querySelector('.ni-overlay[data-overlay="new-group"] .ni-overlay-note')?.textContent)
        .toBe("群聊创建将在 ni-chat 协议接入后开放");
      view.dispose();
    });

    test("扫描出结果后关掉重开，回到不确定态而不是残留上次结果", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "scan");
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(root.querySelectorAll('.ni-overlay[data-overlay="scan-local"] .ni-pick-item').length).toBe(4);

      pressEscape(root);
      openMenu(root);
      pickMenu(root, "scan");
      expect(root.querySelector('.ni-overlay[data-overlay="scan-local"] .ni-overlay-foot')?.textContent)
        .toBe("正在找这台机器上装了什么…");
      expect(root.querySelectorAll('.ni-overlay[data-overlay="scan-local"] .ni-pick-item').length).toBe(0);
      expect(root.querySelector(".ni-scan-bar")?.classList.contains("done")).toBe(false);
      view.dispose();
    });

    test("输入法组合中的 Esc 只取消拼音，不关闭浮层", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "group");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true }));
      expect((root.querySelector('.ni-overlay[data-overlay="new-group"]') as HTMLElement).hidden).toBe(false);
      view.dispose();
    });

    test("dispose 在扫描不确定态中清理定时器，回调不再落进已卸载的界面", async () => {
      const { root, view } = await mount();
      openMenu(root);
      pickMenu(root, "scan");
      view.dispose();
      await new Promise((resolve) => setTimeout(resolve, 1600));
      expect(document.querySelector(".ni-overlay")).toBeNull();
      expect(document.querySelectorAll(".ni-chat-app").length).toBe(0);
    });
  });

  describe("会话头「更多」菜单与 @ 成员卡（A4-8/A4-9）", () => {
    function openMore(root: HTMLElement): void {
      (root.querySelector('.ni-header-action[aria-haspopup="menu"]') as HTMLButtonElement).click();
    }

    function moreLabels(root: HTMLElement): string[] {
      return Array.from(root.querySelectorAll(".ni-more-menu-item")).map((item) => item.textContent ?? "");
    }

    function pickMore(root: HTMLElement, acm: string): void {
      (root.querySelector(`.ni-more-menu-item[data-acm="${acm}"]`) as HTMLButtonElement).click();
    }

    function enterConversation(root: HTMLElement, conversationId: string): void {
      (root.querySelector(`[data-conversation-id="${conversationId}"]`) as HTMLButtonElement).click();
    }

    function pressEscape(root: HTMLElement): void {
      const anchor = (document.activeElement instanceof HTMLElement && document.body.contains(document.activeElement)
        ? document.activeElement
        : root) as HTMLElement;
      anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    function openMenu(root: HTMLElement): void {
      (root.querySelector(".ni-add-contact") as HTMLButtonElement).click();
    }

    function pickMenu(root: HTMLElement, am: string): void {
      (root.querySelector(`.ni-add-menu-item[data-am="${am}"]`) as HTMLButtonElement).click();
    }

    /* adapter 的可选能力走异步事件回声，清空 microtask 队列再断言重绘结果 */
    async function settle(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushRender();
    }

    test("菜单条目逐字对照设计稿：单聊三项、群聊含「拉 agent 进群」，mute 文案随状态切换", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const more = root.querySelector('.ni-header-action[aria-haspopup="menu"]') as HTMLButtonElement;
      expect(more.getAttribute("aria-label")).toBe("会话设置");
      expect(more.getAttribute("aria-expanded")).toBe("false");
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);

      openMore(root);
      expect(more.getAttribute("aria-expanded")).toBe("true");
      expect(moreLabels(root)).toEqual(["静音通知", "标为未读", "关闭对话"]);
      openMore(root);
      expect(more.getAttribute("aria-expanded")).toBe("false");

      enterConversation(root, "mixed-group");
      openMore(root);
      expect(moreLabels(root)).toEqual(["取消静音", "标为未读", "拉 agent 进群", "关闭对话"]);
      view.dispose();
    });

    test("静音切换接真实数据：conversation.updated 驱动列表徽标与菜单文案双向变化", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      expect(root.querySelector('[data-conversation-id="mixed-group"] .ni-muted')?.textContent).toBe("已静音");

      openMore(root);
      pickMore(root, "mute");
      await settle();
      expect(root.querySelector('[data-conversation-id="mixed-group"] .ni-muted')).toBeNull();

      openMore(root);
      expect(moreLabels(root)[0]).toBe("静音通知");
      pickMore(root, "mute");
      await settle();
      expect(root.querySelector('[data-conversation-id="mixed-group"] .ni-muted')?.textContent).toBe("已静音");
      view.dispose();
    });

    test("标为未读置徽标并真的退出会话；再进入即已读（对照稿 openAgent）", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-human");
      expect(root.querySelector('[data-conversation-id="human-human"] .ni-unread')).toBeNull();

      openMore(root);
      pickMore(root, "unread");
      await settle();
      expect(root.querySelector('[data-conversation-id="human-human"] .ni-unread')?.textContent).toBe("1");
      expect(root.querySelector(".ni-conversation-empty")?.textContent).toContain("选一个 agent 开始说话");

      enterConversation(root, "human-human");
      await settle();
      expect(root.querySelector('[data-conversation-id="human-human"] .ni-unread')).toBeNull();
      view.dispose();
    });

    test("「关闭对话」退到空会话态，菜单不残留", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openMore(root);
      pickMore(root, "close");
      expect(root.querySelector(".ni-conversation-empty")?.textContent).toContain("选一个 agent 开始说话");
      expect(root.querySelector(".ni-more-menu")).toBeNull();
      view.dispose();
    });

    test("「拉 agent 进群」浮层：标题与空态逐字，群成员齐时如实说", async () => {
      const state = createMockNiChatState();
      // B6-26 夹具新增了 Claude Code（cc）与 Codex：先都拉进群，「成员齐」口径才成立。
      state.conversations.find((item) => item.id === "mixed-group")!.participantIds.push("cc", "codex");
      state.participants.push(
        { conversationId: "mixed-group", profileId: "cc", role: "member", joinedAt: "2026-08-12T08:00:00Z" },
        { conversationId: "mixed-group", profileId: "codex", role: "member", joinedAt: "2026-08-12T08:00:00Z" },
      );
      const { root, view } = await mount(state);
      enterConversation(root, "mixed-group");
      openMore(root);
      pickMore(root, "invite");
      const overlay = root.querySelector('.ni-overlay[data-overlay="invite"]') as HTMLElement;
      expect(overlay.hidden).toBe(false);
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);
      expect(root.querySelector('.ni-overlay[data-overlay="invite"] .ni-overlay-title')?.textContent)
        .toBe("拉 agent 进「发布小组」");
      expect(root.querySelector('.ni-overlay[data-overlay="invite"] .ni-overlay-empty')?.textContent)
        .toBe("能拉的都已经在群里了");
      expect(root.querySelector('.ni-overlay[data-overlay="invite"] .ni-overlay-foot')?.textContent)
        .toBe("点按添加 · Esc 关闭");

      pressEscape(root);
      expect(overlay.hidden).toBe(true);
      view.dispose();
    });

    test("有群外候选时逐个可选，选择停在协议边界提示上，浮层不假关", async () => {
      const state = createMockNiChatState();
      state.profiles["agent-writer"] = {
        id: "agent-writer",
        type: "agent",
        username: "writer",
        displayName: "写作助手",
        avatarText: "W",
      };
      const { root, view } = await mount(state);
      enterConversation(root, "mixed-group");
      openMore(root);
      pickMore(root, "invite");
      const candidates = Array.from(root.querySelectorAll('.ni-overlay[data-overlay="invite"] .ni-pick-item[data-pick-profile-id]')) as HTMLButtonElement[];
      expect(candidates.map((item) => item.textContent)).toEqual(["◆Claude Code@claude-code添加", "⬡Codex@codex添加", "W写作助手@writer添加"]);

      candidates[0].click();
      expect(root.querySelector('.ni-overlay[data-overlay="invite"] .ni-overlay-note')?.textContent)
        .toBe("拉 agent 进群将在 ni-chat 协议接入后开放");
      expect((root.querySelector('.ni-overlay[data-overlay="invite"]') as HTMLElement).hidden).toBe(false);
      view.dispose();
    });

    test("点外收菜单与成员卡；Esc 不依赖焦点位置逐层退", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openMore(root);
      document.body.click();
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);

      openMore(root);
      (document.activeElement as HTMLElement | null)?.blur?.();
      pressEscape(root);
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);

      enterConversation(root, "mixed-group");
      const mention = root.querySelector('.ni-mention[data-profile-id="me"]') as HTMLElement;
      mention.click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(true);
      pressEscape(root);
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);
      view.dispose();
    });

    test("同级轻浮层互斥：打 @ 开的选择器被更多菜单收，开建群浮层收更多菜单", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root.querySelector(".ni-composer-input") as HTMLTextAreaElement, "@");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();

      openMore(root);
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(true);
      expect(root.querySelector(".ni-mention-picker")).toBeNull();

      openMenu(root);
      pickMenu(root, "group");
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);
      expect((root.querySelector('.ni-overlay[data-overlay="new-group"]') as HTMLElement).hidden).toBe(false);
      view.dispose();
    });

    test("未实现设置能力的 adapter 上给诚实边界提示，不静默也不假成功", async () => {
      const state = createMockNiChatState();
      const base = createMockNiChatAdapter(state);
      const limited: NiChatAdapter = {
        getSnapshot: () => base.getSnapshot(),
        subscribe: (listener) => base.subscribe(listener),
        sendMessage: (input) => base.sendMessage(input),
        answerInteraction: (input) => base.answerInteraction(input),
      };
      const root = document.createElement("div");
      document.body.appendChild(root);
      const view = await mountNiChatView(root, { adapter: limited, now: () => Date.parse("2026-08-12T08:00:30Z") });
      enterConversation(root, "human-agent");
      // 「进入即已读」是隐式路径：能力缺失时静默跳过——不弹与动作不搭的设置
      // 边界提示（dsh 补审对 #339：否则点进未读会话每次都弹「会话设置将在
      // ni-chat 协议接入后开放」，且徽标清不掉让提示反复出现）。徽标保留是
      // 诚实边界本身。
      expect(root.querySelector(".ni-client-note")?.textContent ?? "").not.toContain("会话设置");
      expect(root.querySelector('[data-conversation-id="human-agent"] .ni-unread')?.textContent).toBe("1");
      openMore(root);
      pickMore(root, "mute");
      expect(root.querySelector(".ni-client-note")?.textContent).toBe("会话设置将在 ni-chat 协议接入后开放");
      view.dispose();
    });

    test("点 @ 弹成员卡：内容只画真实字段，自己没有「单独找他」", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      const mention = root.querySelector('.ni-mention[data-profile-id="me"]') as HTMLElement;
      expect(mention.getAttribute("role")).toBe("button");
      expect(mention.tabIndex).toBe(0);
      mention.click();
      const card = root.querySelector(".ni-member-card") as HTMLElement;
      expect(card.classList.contains("show")).toBe(true);
      expect(card.querySelector(".ni-member-card-nm")?.textContent).toBe("你");
      expect(card.querySelector(".ni-member-card-rl")?.textContent).toContain("人类");
      expect(card.querySelector(".ni-member-card-rl")?.textContent).toContain("@kongkang");
      expect(card.querySelector(".ni-member-card-st")).toBeNull(); // me 没有 bio，presence 也没有
      expect(card.querySelector(".ni-member-card-go")).toBeNull(); // 自己不能「单独找他」
      view.dispose();
    });

    test("别人的 @ 弹出完整成员卡：徽章/bio/presence 与「单独找他」跳单聊", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      // 打 @ 选择成员发一条带结构化 mention 的消息（协议路径，不走测试后门）
      typeInto(root.querySelector(".ni-composer-input") as HTMLTextAreaElement, "@");
      (root.querySelector('[data-mention-profile-id="agent-coder"]') as HTMLButtonElement).click();
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      input.value = "代码助手，看下封面";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector(".ni-composer-form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();

      const mention = root.querySelector('.ni-mention[data-profile-id="agent-coder"]') as HTMLElement;
      expect(mention.textContent).toBe("@代码助手");
      mention.click();
      const card = root.querySelector(".ni-member-card") as HTMLElement;
      expect(card.querySelector(".ni-member-card-nm")?.textContent).toBe("代码助手");
      expect(card.querySelector(".ni-member-card-rl")?.textContent).toContain("Agent");
      expect(card.querySelector(".ni-member-card-rl")?.textContent).toContain("@code-helper");
      expect(card.querySelector(".ni-member-card-st")?.textContent).toContain("通过 ni-chat 连接");
      expect(Array.from(card.querySelectorAll(".ni-member-card-st")).map((node) => node.textContent)).toContain("在线");

      (card.querySelector(".ni-member-card-go") as HTMLButtonElement).click();
      expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("代码助手");
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);
      view.dispose();
    });

    test("没有单聊路的成员不画「单独找他」；对不上人的 @ 只高亮不可点", async () => {
      const state = createMockNiChatState();
      state.messagesByConversation["mixed-group"]?.push(message({
        id: "mg-2",
        conversationId: "mixed-group",
        senderId: "agent-research",
        parts: [{ kind: "text", text: "证据在路上了", mentions: [{ profileId: "agent-research", label: "研究助手" }] }],
      }));
      state.messagesByConversation["mixed-group"]?.push(message({
        id: "mg-3",
        conversationId: "mixed-group",
        senderId: "agent-coder",
        parts: [{ kind: "text", text: "收到", mentions: [{ profileId: "ghost-profile", label: "幽灵" }] }],
      }));
      const { root, view } = await mount(state);
      enterConversation(root, "mixed-group");

      (root.querySelector('.ni-mention[data-profile-id="agent-research"]') as HTMLElement).click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(true);
      expect(root.querySelector(".ni-member-card-go")).toBeNull(); // 与研究助手没有单聊会话，不画按钮

      const unresolved = root.querySelector('.ni-mention[data-profile-id="ghost-profile"]') as HTMLElement;
      expect(unresolved.classList.contains("is-unresolved")).toBe(true);
      expect(unresolved.getAttribute("role")).toBeNull();
      unresolved.click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);
      view.dispose();
    });

    test("成员卡关闭路径：点流内空白收、滚动收、点外收、换会话不存续", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      const mention = root.querySelector('.ni-mention[data-profile-id="me"]') as HTMLElement;
      mention.click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(true);

      (root.querySelector(".ni-message-list") as HTMLElement).click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);

      mention.click();
      (root.querySelector(".ni-message-list") as HTMLElement).dispatchEvent(new Event("scroll"));
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);

      mention.click();
      (root.querySelector(".ni-composer-input") as HTMLElement).click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);

      mention.click();
      enterConversation(root, "human-human");
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false);
      view.dispose();
    });
  });

  describe("未选对话空白页（A4-6）", () => {
    test("初始不自动选中任何会话：右栏是空白页，文案与键位教学逐字对照稿", async () => {
      const { root, view } = await mount();
      // 不自动打开第一个/上一个：列表没有 active 项，也不持久化「上次会话」
      expect(root.querySelector(".ni-conversation-item[aria-current]")).toBeNull();
      expect(root.querySelector(".ni-conversation-item.is-active")).toBeNull();
      // 右栏是空白页，不是会话
      expect(root.querySelector(".ni-conversation-header")).toBeNull();
      expect(root.querySelector(".ni-composer-input")).toBeNull();
      const empty = root.querySelector(".ni-conversation-empty");
      expect(empty).not.toBeNull();
      expect(empty?.querySelector(".ni-conversation-empty-icon svg")?.getAttribute("width")).toBe("34");
      expect(empty?.querySelector(".ni-conversation-empty-icon svg")?.getAttribute("stroke-width")).toBe("1.6");
      expect(empty?.querySelector(".ni-conversation-empty-title")?.textContent).toBe("选一个 agent 开始说话");
      const hint = empty?.querySelector(".ni-conversation-empty-hint");
      expect(hint?.textContent).toBe("旋钮选，按下或 Enter 进去；Tab 可以直接搜");
      expect(Array.from(hint?.querySelectorAll("b") ?? []).map((node) => node.textContent)).toEqual(["Enter", "Tab"]);
      view.dispose();
    });

    test("只有用户点击列表项才进入会话——跨窗导航的最终落点也是点击，直达不受影响", async () => {
      const { root, view } = await mount();
      const item = root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement;
      item.click();
      // renderList 全量重建列表：选中态要在换发后的新节点上断言
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      expect(root.querySelector(".ni-conversation-empty")).toBeNull();
      expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("代码助手");
      expect(root.querySelector(".ni-composer-input")).not.toBeNull();
      view.dispose();
    });

    test("初始未选态不动未读数，进入那一刻才清零（对照稿 openAgent 的 a.unread=0）", async () => {
      const { root, view } = await mount();
      expect(root.querySelector('[data-conversation-id="human-agent"] .ni-unread')?.textContent).toBe("1");
      (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushRender();
      expect(root.querySelector('[data-conversation-id="human-agent"] .ni-unread')).toBeNull();
      view.dispose();
    });

    test("「关闭对话」回到同一张空白页，键位教学原样在", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      (root.querySelector('.ni-header-action[aria-haspopup="menu"]') as HTMLButtonElement).click();
      (root.querySelector('.ni-more-menu-item[data-acm="close"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-conversation-empty-title")?.textContent).toBe("选一个 agent 开始说话");
      expect(root.querySelector(".ni-conversation-empty-hint")?.textContent).toBe("旋钮选，按下或 Enter 进去；Tab 可以直接搜");
      view.dispose();
    });
  });

  describe("单层 Host 安全区与任务锚点钮（A4-7）", () => {
    test("安全区只在根框架消费一次，会话头不再重复偏移", () => {
      const css = readFileSync(join(import.meta.dir, "../packages/ni-chat-ui/src/ni-chat-ui.css"), "utf8");
      expect(css).toMatch(/\.plugin-main-frame\s*\{[^}]*padding-top\s*:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/s);
      expect(css).not.toContain("--reai-plugin-safe-top");
      expect(css).not.toMatch(/\.ni-conversation-header\s*\{[^}]*margin-top/);
    });

    test("任务锚点钮渲染在成员钮与「更多」钮之间；A4-15 抽屉落地后点亮为可开合入口", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      const labels = Array.from(root.querySelectorAll<HTMLButtonElement>(".ni-conversation-header .ni-header-action"))
        .map((action) => action.getAttribute("aria-label"));
      expect(labels).toEqual(["查看联系人资料", "任务锚点", "会话设置"]);
      const anchor = root.querySelector('.ni-conversation-header .ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement;
      expect(anchor.textContent).toBe("锚点");
      expect(anchor.disabled).toBe(false); // A4-15 点亮：接右侧锚点抽屉，不再是禁用占位
      expect(anchor.title).toBe(""); // 占位 title 一并撤下——钮自己说明自己了
      expect(anchor.dataset.drawerMode).toBe("anchor");
      expect(anchor.getAttribute("aria-expanded")).toBe("false");

      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      const groupLabels = Array.from(root.querySelectorAll<HTMLButtonElement>(".ni-conversation-header .ni-header-action"))
        .map((action) => action.getAttribute("aria-label"));
      expect(groupLabels).toEqual(["查看群成员", "任务锚点", "会话设置"]); // 稿上单聊/群聊都有这颗钮
      view.dispose();
    });
  });

  describe("右侧推挤式抽屉：任务锚点 / 群成员两档（A4-15）", () => {
    function openAnchorDrawer(root: HTMLElement): void {
      (root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement).click();
    }

    function openMemberDrawer(root: HTMLElement): void {
      (root.querySelector('.ni-header-action[aria-label="查看群成员"]') as HTMLButtonElement).click();
    }

    function pressEscape(root: HTMLElement): void {
      const anchor = (document.activeElement instanceof HTMLElement && document.body.contains(document.activeElement)
        ? document.activeElement
        : root) as HTMLElement;
      anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    test("推挤形态对稿：宽度 0↔236px 参与 flex 主轴、非覆盖式定位，标题在 main-body 内起线", () => {
      const css = readFileSync(join(import.meta.dir, "../packages/ni-chat-ui/src/ni-chat-ui.css"), "utf8");
      // 收起态宽度 0 + 不收缩：开合全靠宽度过渡推挤主区
      expect(css).toMatch(/\.ni-drawer\s*\{[^}]*width\s*:\s*0[^}]*flex\s*:\s*0 0 auto/s);
      expect(css).toMatch(/\.ni-drawer\.open\s*\{[^}]*width\s*:\s*236px[^}]*border-left-color\s*:\s*var\(--ni-divider\)/s);
      // 推挤不是覆盖：抽屉本体不得用 absolute/fixed/transform 盖在会话区上
      expect(css).not.toMatch(/\.ni-drawer\s*\{[^}]*position\s*:\s*(absolute|fixed)/s);
      expect(css).not.toMatch(/\.ni-drawer\s*\{[^}]*transform/s);
      expect(css).not.toMatch(/\.ni-drawer-h\s*\{[^}]*margin-top/s);
      expect(css).toMatch(/\.ni-drawer-acts\s*\{[^}]*top\s*:\s*0/s);
      // 过渡曲线对稿：.26s cubic-bezier(.4,0,.2,1)
      expect(css).toMatch(/\.ni-drawer\s*\{[^}]*transition\s*:\s*width 0\.26s cubic-bezier\(0\.4,\s*0,\s*0\.2,\s*1\)/s);
    });

    test("抽屉是会话区的 flex 兄弟节点（推挤它让位）；DOM 结构与稿同构", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      const app = root.querySelector(".ni-chat-app") as HTMLElement;
      const pane = app.querySelector(".ni-conversation-pane") as HTMLElement;
      const drawer = app.querySelector(".ni-drawer") as HTMLElement;
      expect(drawer).not.toBeNull();
      expect(drawer.previousElementSibling).toBe(pane); // 紧跟会话区右侧
      expect(drawer.querySelector(".ni-drawer-inner")).not.toBeNull();
      expect(drawer.querySelector(".ni-drawer-h .ni-drawer-t")).not.toBeNull();
      expect(drawer.querySelector(".ni-drawer-acts .ni-drawer-x")).not.toBeNull();
      expect(drawer.querySelector(".ni-drawer-b")).not.toBeNull();
      expect(drawer.classList.contains("open")).toBe(false); // 初始收起
      // 收起态挡键盘与读屏（width:0 挡不住 Tab），开抽屉时解除（dsh 审查意见）
      expect(drawer.inert).toBe(true);
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
      openAnchorDrawer(root);
      expect(drawer.inert).toBe(false);
      expect(drawer.getAttribute("aria-hidden")).toBe("false");
      view.dispose();
    });

    test("抽屉不参与点外收：点会话区空白处它保持开着（稿：可常开的辅助面板）", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      openAnchorDrawer(root);
      document.body.click(); // 点外（会话区之外的空白）
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(true);
      (root.querySelector(".ni-message-list") as HTMLElement).click(); // 点流内非 @ 处
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(true);
      view.dispose();
    });

    test("锚点档：点亮后的锚点钮开抽屉，标题计数与诚实空态对稿；再点同钮收起", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      openAnchorDrawer(root);
      const drawer = root.querySelector(".ni-drawer") as HTMLElement;
      expect(drawer.classList.contains("open")).toBe(true);
      expect(drawer.querySelector(".ni-drawer-t")?.textContent).toBe("任务锚点 · 0");
      // 协议没有锚点数据源：不编锚点条目、不出搜索框（稿：空列表不出搜索框）
      expect(drawer.querySelectorAll(".ni-drawer-item").length).toBe(0);
      expect(drawer.querySelector("input")).toBeNull();
      expect(drawer.querySelector(".ni-drawer-empty")?.textContent)
        .toBe("会话关联的任务锚点将在 ni-chat 协议接入后出现");
      // 入口钮开态与 aria 同步（对照稿 .ac-act.on）
      const anchorBtn = root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement;
      expect(anchorBtn.classList.contains("is-open")).toBe(true);
      expect(anchorBtn.getAttribute("aria-expanded")).toBe("true");
      // toggle：同钮再点收起
      (root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement).click();
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false);
      expect((root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
      view.dispose();
    });

    test("成员档：真实成员数据全字段呈现（头像/昵称/role/presence 点），标题计数对稿", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      const drawer = root.querySelector(".ni-drawer") as HTMLElement;
      expect(drawer.classList.contains("open")).toBe(true);
      expect(drawer.querySelector(".ni-drawer-t")?.textContent).toBe("群成员 · 4");
      const rows = Array.from(drawer.querySelectorAll(".ni-drawer-mem"));
      expect(rows.map((row) => row.querySelector(".ni-drawer-mem-n")?.textContent))
        .toEqual(["你", "Alice", "代码助手", "研究助手"]);
      expect(rows.map((row) => row.querySelector(".ni-drawer-mem-av")?.textContent)).toEqual(["K", "A", "C", "R"]);
      // role 副行来自协议 participants：me 是 owner，其余 member
      expect(rows.map((row) => row.querySelector(".ni-drawer-mem-r")?.textContent))
        .toEqual(["群主", "成员", "成员", "成员"]);
      // presence 状态点只画有数据的：coder/research 在线绿、Alice 离线灰、me 无 presence 不画
      const dots = rows.map((row) => row.querySelector(".ni-drawer-st")?.className ?? "");
      expect(dots[0]).toBe(""); // 自己没有 presence 记录
      expect(dots[1]).toContain("is-offline");
      expect(dots[2]).toContain("is-online");
      expect(dots[3]).toContain("is-online");
      view.dispose();
    });

    test("成员档底部「拉 agent 进群」是 invite 浮层的第二入口，真实打开", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      const add = root.querySelector(".ni-drawer-add") as HTMLButtonElement;
      expect(add.textContent).toBe("拉 agent 进群");
      add.click();
      const invite = root.querySelector('[data-overlay="invite"]') as HTMLElement;
      expect(invite.hidden).toBe(false); // 与「更多」菜单共用同一浮层（稿：两个入口共用这一层）
      expect(invite.querySelector(".ni-overlay-title")?.textContent).toBe("拉 agent 进「发布小组」");
      view.dispose();
    });

    test("两档共用一个抽屉：开着成员档点锚点钮直接换档，不叠不闪", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      expect(root.querySelector(".ni-drawer-t")?.textContent).toBe("群成员 · 4");
      openAnchorDrawer(root);
      const drawers = root.querySelectorAll(".ni-drawer");
      expect(drawers.length).toBe(1); // 单一抽屉节点，换档不造第二个
      expect(drawers[0].classList.contains("open")).toBe(true);
      expect(drawers[0].querySelector(".ni-drawer-t")?.textContent).toBe("任务锚点 · 0");
      // 开态钮切换：锚点钮亮、成员钮灭
      expect((root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLElement).classList.contains("is-open")).toBe(true);
      expect((root.querySelector('.ni-header-action[aria-label="查看群成员"]') as HTMLElement).classList.contains("is-open")).toBe(false);
      view.dispose();
    });

    test("✕ 关闭抽屉；Esc 在会话内层级链里只关抽屉（成员卡先于抽屉，退会话在其后）", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      (root.querySelector(".ni-drawer-x") as HTMLButtonElement).click();
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false);

      openAnchorDrawer(root);
      pressEscape(root);
      const drawer = root.querySelector(".ni-drawer") as HTMLElement;
      expect(drawer.classList.contains("open")).toBe(false); // Esc 只关抽屉
      expect(root.querySelector(".ni-conversation-title")?.textContent).toBe("发布小组"); // 人还在会话里

      // 成员卡与抽屉同场：Esc 先收刚交互的成员卡（对照稿 doEsc 顺序），再按才轮到抽屉
      openMemberDrawer(root);
      const mention = root.querySelector(".ni-mention.is-resolved") as HTMLElement;
      mention.click();
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(true);
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(true);
      pressEscape(root);
      expect(root.querySelector(".ni-member-card")?.classList.contains("show")).toBe(false); // 卡先收
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(true); // 抽屉还在
      pressEscape(root);
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false); // 这一次才收抽屉
      view.dispose();
    });

    test("换会话与「关闭对话」都收抽屉——抽屉档不跨会话存续（对照稿 openAgent/closeAgent）", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false);
      expect((root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLElement).classList.contains("is-open")).toBe(false);

      openAnchorDrawer(root);
      (root.querySelector('.ni-header-action[aria-haspopup="menu"]') as HTMLButtonElement).click();
      (root.querySelector('.ni-more-menu-item[data-acm="close"]') as HTMLButtonElement).click();
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false);
      view.dispose();
    });

    test("单聊的「资料」钮不接抽屉（稿上成员钮仅群聊在场）；单聊锚点钮照常开锚点档", async () => {
      const { root, view } = await mount();
      enterFirst(root); // human-agent 单聊
      const profileBtn = root.querySelector('.ni-header-action[aria-label="查看联系人资料"]') as HTMLButtonElement;
      expect(profileBtn.dataset.drawerMode).toBeUndefined();
      profileBtn.click();
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(false);
      openAnchorDrawer(root);
      expect((root.querySelector(".ni-drawer") as HTMLElement).classList.contains("open")).toBe(true);
      view.dispose();
    });

    test("抽屉开着时事件驱动的全量重绘保持内容与开态（presence 变化实时刷）", async () => {
      const { root, adapter, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      openMemberDrawer(root);
      const before = Array.from(root.querySelectorAll(".ni-drawer-mem"));
      expect(before[1]?.querySelector(".ni-drawer-st")?.classList.contains("is-offline")).toBe(true); // Alice 离线
      // 注入 presence.updated 事件回声 → 全量重绘 → 抽屉内容跟着刷新（不重开、不收起）
      adapter.push({
        type: "presence.updated",
        presence: { profileId: "human-alice", revision: 2, state: "online", expiresAt: "2026-08-12T08:10:00Z" },
      });
      await flushRender();
      const drawer = root.querySelector(".ni-drawer") as HTMLElement;
      expect(drawer.classList.contains("open")).toBe(true);
      const after = Array.from(root.querySelectorAll(".ni-drawer-mem"));
      expect(after[1]?.querySelector(".ni-drawer-mem-n")?.textContent).toBe("Alice");
      expect(after[1]?.querySelector(".ni-drawer-st")?.classList.contains("is-online")).toBe(true);
      view.dispose();
    });
  });

  describe("输入区三层：附件条 / 「+」能力清单 / 回到最新（A4-10/A4-12/A4-13）", () => {
    function openPlus(root: HTMLElement): void {
      (root.querySelector(".ni-composer-attach") as HTMLButtonElement).click();
    }

    function plusRows(root: HTMLElement): Array<{ nm: string; ds: string }> {
      return Array.from(root.querySelectorAll(".ni-plus-item")).map((row) => ({
        nm: row.querySelector(".ni-plus-item-nm")?.textContent ?? "",
        ds: row.querySelector(".ni-plus-item-ds")?.textContent ?? "",
      }));
    }

    function pressEscape(root: HTMLElement): void {
      const anchor = (document.activeElement instanceof HTMLElement && document.body.contains(document.activeElement)
        ? document.activeElement
        : root) as HTMLElement;
      anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    function enterConversation(root: HTMLElement, conversationId: string): void {
      (root.querySelector(`[data-conversation-id="${conversationId}"]`) as HTMLButtonElement).click();
    }

    function mockListMetrics(list: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number): void {
      Object.defineProperties(list, {
        scrollHeight: { configurable: true, value: scrollHeight },
        clientHeight: { configurable: true, value: clientHeight },
        scrollTop: { configurable: true, value: scrollTop, writable: true },
      });
      list.dispatchEvent(new Event("scroll"));
    }

    test("「+」清单开合：组标题/候选文案/脚注逐字对稿，aria 与开态同步", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const attach = root.querySelector(".ni-composer-attach") as HTMLButtonElement;
      expect(attach.disabled).toBe(false); // 不再是恒禁用的假门
      expect(attach.getAttribute("aria-expanded")).toBe("false");
      expect(attach.classList.contains("is-open")).toBe(false);

      openPlus(root);
      expect(root.querySelector(".ni-plus-menu")).not.toBeNull();
      const attachOpen = root.querySelector(".ni-composer-attach") as HTMLButtonElement;
      expect(attachOpen.getAttribute("aria-expanded")).toBe("true");
      expect(attachOpen.classList.contains("is-open")).toBe(true);
      expect(root.querySelector(".ni-plus-group")?.textContent).toBe("带上");
      expect(plusRows(root)).toEqual([
        { nm: "图片", ds: "截图、相册里的图" },
        { nm: "文件", ds: "本机任意文件" },
        { nm: "使用上下文", ds: "让这句话带上本会话最近的来回 · 共 2 条" }, // fixture 里 human-agent 有 2 条消息
      ]);
      expect(root.querySelector(".ni-plus-foot")?.textContent).toBe("点选带上 · Esc 收起");

      openPlus(root); // 再点收起（重取节点：开清单走整屏重绘，旧引用已脱离文档）
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      expect((root.querySelector(".ni-composer-attach") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
      view.dispose();
    });

    test("图片/文件候选停在诚实边界：不进附件条、不伪造附件", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="图片"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-plus-menu")).toBeNull(); // 选完一律收起
      expect(root.querySelector(".ni-composer-attachments")).toBeNull(); // 没有附件被伪造出来
      expect(root.querySelector(".ni-client-note")?.textContent).toBe("图片将在 Host 文件能力接入后可附带");

      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="文件"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-client-note")?.textContent).toBe("文件将在 Host 文件能力接入后可附带");
      view.dispose();
    });

    test("上下文附件真实闭环：chip 进附件条、点本体循环换档、× 移除、清单文案随状态切换", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="context"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      const chip = root.querySelector(".ni-composer-attachment") as HTMLElement;
      expect(chip.classList.contains("is-scope")).toBe(true);
      expect(chip.title).toBe("点一下换范围");
      expect(chip.querySelector("b")?.textContent).toBe("上下文 · 最近 5 条");
      expect(chip.querySelector(".ni-composer-attachment-swap")?.textContent).toBe("换");

      chip.click(); // 点 chip 本体 = 往后转一档
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 最近 20 条");
      (root.querySelector(".ni-composer-attachment") as HTMLElement).click();
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 本会话全部");
      (root.querySelector(".ni-composer-attachment") as HTMLElement).click();
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 最近 5 条"); // 三档循环

      // 已带过：清单那行变成「改范围」，ds 写明当前档位
      openPlus(root);
      const rows = plusRows(root);
      expect(rows[2]).toEqual({ nm: "改上下文范围", ds: "现在带的是最近 5 条 · 点附件也能换" });
      pressEscape(root);
      expect(root.querySelector(".ni-plus-menu")).toBeNull();

      (root.querySelector(".ni-composer-attachment-x") as HTMLButtonElement).click();
      expect(root.querySelector(".ni-composer-attachments")).toBeNull(); // 移除后整条收起
      view.dispose();
    });

    test("× 的键盘路径不被 chip 的换档 keydown 截胡（dsh 补审对 #345）", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="context"]') as HTMLButtonElement).click();
      const chip = root.querySelector(".ni-composer-attachment") as HTMLElement;
      expect(chip.querySelector("b")?.textContent).toBe("上下文 · 最近 5 条");

      // 键盘聚焦 × 后按 Enter/Space：keydown 冒泡到 chip，但换档处理器必须放过
      // 它——否则 preventDefault 防掉按钮的原生合成 click，「移除」被偷成「换范围」，
      // 纯键盘用户没有任何移除附件的路径（附件按会话持久，不发送不消失）。
      const remove = chip.querySelector(".ni-composer-attachment-x") as HTMLButtonElement;
      remove.focus();
      const enterOnRemove = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      remove.dispatchEvent(enterOnRemove);
      expect(enterOnRemove.defaultPrevented).toBe(false); // 不拦截按钮自己的默认行为
      expect(chip.querySelector("b")?.textContent).toBe("上下文 · 最近 5 条"); // 没被换档
      const spaceOnRemove = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      remove.dispatchEvent(spaceOnRemove);
      expect(spaceOnRemove.defaultPrevented).toBe(false);
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 最近 5 条");

      // chip 本体的键盘换档不受影响（role=button 的 Enter/Space 语义）。
      chip.focus();
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 最近 20 条");
      view.dispose();
    });

    test("「+」清单背景实心：垫不透明 --bg 再叠卡色，不透消息流（dsh 补审对 #345）", () => {
      // 稿 1712 的硬要求：宿主注入的 --card-bg 是 rgba(.8) 毛玻璃卡色，直接用
      // 会把底下的对话透上来跟选项混读（同 shell-adapt.css 浮层先例的合成做法）。
      const css = readFileSync(join(import.meta.dir, "../packages/ni-chat-ui/src/ni-chat-ui.css"), "utf8");
      const plusMenuRule = /\.ni-plus-menu\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
      expect(plusMenuRule).toContain("linear-gradient(var(--card-bg");
      expect(plusMenuRule).toContain("var(--bg");
      expect(plusMenuRule).not.toMatch(/background:\s*var\(--card-bg/); // 不再是裸半透明卡色
    });

    test("发送把附件带上：消息流呈现上下文标记、范围对齐真实历史、发完附件归零", async () => {
      const { root, adapter, view } = await mount();
      enterConversation(root, "human-agent");
      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="context"]') as HTMLButtonElement).click();
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      input.value = "就按刚才说的整理";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector(".ni-composer-form") as HTMLFormElement)
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await adapter.whenIdle();
      await flushRender();

      const sent = (await adapter.getSnapshot()).messagesByConversation["human-agent"]?.at(-1);
      expect(sent?.parts[0]).toEqual({ kind: "context_ref", label: "最近 5 条", messageCount: 2 }); // 范围对齐真实历史（只有 2 条）
      expect(sent?.parts[1]).toMatchObject({ kind: "text", text: "就按刚才说的整理" });
      const contextBlock = root.querySelector(".ni-part-context");
      expect(contextBlock?.textContent).toContain("带上的上下文 · 最近 5 条 · 2 条消息");
      expect(contextBlock?.querySelector(".ni-context-symbol")?.textContent).toBe("〰");
      expect(root.querySelector(".ni-composer-attachments")).toBeNull(); // 发完归零
      view.dispose();
    });

    test("空会话不列「使用上下文」——没东西可带就不列，不编", async () => {
      const state = createMockNiChatState();
      state.messagesByConversation["human-human"] = [];
      const { root, view } = await mount(state);
      enterConversation(root, "human-human");
      openPlus(root);
      expect(plusRows(root)).toEqual([
        { nm: "图片", ds: "截图、相册里的图" },
        { nm: "文件", ds: "本机任意文件" },
      ]);
      view.dispose();
    });

    test("同级轻浮层互斥：+ 清单与打 @ 选择器、「更多」菜单不同场，Esc 逐层收", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root.querySelector(".ni-composer-input") as HTMLTextAreaElement, "@");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      openPlus(root); // 开 + 收 @
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      expect(root.querySelector(".ni-plus-menu")).not.toBeNull();

      (root.querySelector('.ni-header-action[aria-haspopup="menu"]') as HTMLButtonElement).click(); // 开更多收 +
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(true);

      openPlus(root); // 开 + 也要收更多
      expect(root.querySelector(".ni-more-menu")?.classList.contains("open")).toBe(false);
      pressEscape(root); // Esc 收清单、焦点还给触发钮
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      expect((document.activeElement as HTMLElement).className).toContain("ni-composer-attach");

      // 点外收：点消息流空白处
      openPlus(root);
      (root.querySelector(".ni-message-list") as HTMLElement).click();
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      view.dispose();
    });

    test("换会话收「+」清单：轻浮层不跨会话存续，附件按会话隔离", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      openPlus(root);
      (root.querySelector('.ni-plus-item[data-plus-item="context"]') as HTMLButtonElement).click();
      expect(root.querySelector(".ni-composer-attachment")).not.toBeNull();

      enterConversation(root, "mixed-group"); // 换会话
      expect(root.querySelector(".ni-plus-menu")).toBeNull();
      expect(root.querySelector(".ni-composer-attachment")).toBeNull(); // 各看各的

      enterConversation(root, "human-agent"); // 回来：附件还在（没发就不清）
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe("上下文 · 最近 5 条");
      view.dispose();
    });

    test("回到最新：距底超过阈值浮现、点击滚底、贴底隐藏、滞回区不闪", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const list = root.querySelector(".ni-message-list") as HTMLElement;
      const jump = root.querySelector(".ni-jump") as HTMLButtonElement;
      expect(jump).not.toBeNull();
      expect(jump.getAttribute("aria-label")).toBe("回到最新");
      expect(jump.textContent).toContain("回到最新");
      expect(jump.querySelector("svg")).not.toBeNull(); // 稿的 arrow-down 图标
      expect(jump.classList.contains("show")).toBe(false); // 贴底（gap=0）不出现

      mockListMetrics(list, 1000, 200, 300); // gap=500 > 140：浮现
      expect(jump.classList.contains("show")).toBe(true);

      mockListMetrics(list, 1000, 200, 700); // gap=100 落进滞回区：已显示就维持
      expect(jump.classList.contains("show")).toBe(true);

      const calls: Array<{ top?: number; behavior?: string }> = [];
      list.scrollTo = ((options?: ScrollToOptions) => { calls.push({ ...options }); }) as typeof list.scrollTo;
      jump.click();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.top).toBe(1000); // 滚到流底 = 最新消息
      expect(calls[0]?.behavior).toBe("smooth");

      mockListMetrics(list, 1000, 200, 800); // gap=0：贴底隐藏
      expect(jump.classList.contains("show")).toBe(false);

      mockListMetrics(list, 1000, 200, 750); // gap=50 < 60：维持隐藏（未显示侧要越过 140）
      expect(jump.classList.contains("show")).toBe(false);
      view.dispose();
    });

    test("「回到最新」显隐跨重绘保持：不在底部来新消息重渲染不弹也不丢", async () => {
      const { root, adapter, view } = await mount();
      enterConversation(root, "human-agent");
      const list = root.querySelector(".ni-message-list") as HTMLElement;
      mockListMetrics(list, 1000, 200, 300); // 浮现
      expect((root.querySelector(".ni-jump") as HTMLElement).classList.contains("show")).toBe(true);

      adapter.push({
        type: "message.created",
        message: message({
          id: "jump-keep",
          conversationId: "human-agent",
          senderId: "agent-coder",
          parts: [{ kind: "text", text: "不在底部时来了新消息" }],
        }),
      });
      await flushRender();
      const listAfter = root.querySelector(".ni-message-list") as HTMLElement;
      // 重绘保留 scrollTop=300（未贴底分支）；测试环境量不出新节点的真实尺寸，
      // 渲染时 syncJump 算的是 0——补一次带尺寸的 scroll，验证显隐记忆没丢：
      // 已显示侧用 lo 阈值（gap=600 > 60 维持），这就是「跨重绘保持」的语义。
      expect(listAfter.scrollTop).toBe(300);
      mockListMetrics(listAfter, 1100, 200, 300);
      expect((root.querySelector(".ni-jump") as HTMLElement).classList.contains("show")).toBe(true);
      view.dispose();
    });
  });

  describe("待确认坞：未决 Interaction 钉在输入区上方（A4-11）", () => {
    function enterConversation(root: HTMLElement, conversationId: string): void {
      (root.querySelector(`[data-conversation-id="${conversationId}"]`) as HTMLButtonElement).click();
    }

    function mockListMetrics(list: HTMLElement, scrollHeight: number, clientHeight: number, scrollTop: number): void {
      Object.defineProperties(list, {
        scrollHeight: { configurable: true, value: scrollHeight },
        clientHeight: { configurable: true, value: clientHeight },
        scrollTop: { configurable: true, value: scrollTop, writable: true },
      });
      list.dispatchEvent(new Event("scroll"));
    }

    test("坞形态对照稿：收缩条「等你确认：」+ 问题摘要、问题全文与选项在 body；流内不渲染未决", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const dock = root.querySelector(".ni-ask-dock") as HTMLElement;
      expect(dock).not.toBeNull();
      expect(dock.dataset.interactionId).toBe("interaction-1");
      expect(dock.classList.contains("is-mini")).toBe(false); // 贴底进场是展开态
      const bar = dock.querySelector(".ni-ask-bar") as HTMLButtonElement;
      expect(bar.querySelector("svg")).not.toBeNull(); // 稿的 alert-circle
      expect(bar.querySelector(".ni-ask-bar-t")?.textContent).toBe("等你确认：发布说明要包含哪些内容？"); // prompt 前 18 字 + 稿前缀
      expect(dock.querySelector(".ni-ask-q")?.textContent).toBe("发布说明要包含哪些内容？"); // 问题全文
      const options = Array.from(dock.querySelectorAll<HTMLButtonElement>(".ni-interaction-option")).map((o) => o.textContent);
      expect(options).toEqual(["App 和固件", "只发 App", "拆成两篇"]);
      // 未决的确认不在流里渲染（对照稿：答完了才落回流里成为记录）
      expect(root.querySelector(".ni-message-list [data-interaction-id]")).toBeNull();
      expect(root.querySelector(".ni-message-list .ni-part-ask-docked")).not.toBeNull();
      // 输入坞在输入行上方（DOM 顺序先于表单）
      expect(dock.compareDocumentPosition(root.querySelector(".ni-composer-form") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      view.dispose();
    });

    test("坞上答题走真实 adapter：答完坞收起、答案落回流里成记录", async () => {
      const { root, adapter, view } = await mount();
      enterConversation(root, "human-agent");
      (root.querySelectorAll(".ni-ask-dock .ni-interaction-option")[1] as HTMLButtonElement).click(); // 「只发 App」
      await adapter.whenIdle();
      expect(root.querySelector(".ni-ask-dock")).toBeNull(); // 坞随未决消失
      const record = root.querySelector('.ni-message-list [data-interaction-id="interaction-1"]');
      expect(record?.textContent).toContain("已回答");
      expect(record?.textContent).toContain("你的回答：只发 App");
      expect(record?.querySelector(".ni-interaction-option")).toBeNull();
      view.dispose();
    });

    test("坞收缩/展开的 CSS 行为级联正确：hidden 延迟淡出、hover 展开自带无延迟清单", () => {
      const css = readFileSync(join(import.meta.dir, "../packages/ni-chat-ui/src/ni-chat-ui.css"), "utf8");
      const mini = css.match(/\.ni-ask-dock\.is-mini \.ni-ask-body \{[^}]*\}/)?.[0] ?? "";
      // 收缩：hidden 延迟 0.16s（等淡出结束）——Esc 收起后按钮退出可聚焦树
      expect(mini).toMatch(/visibility:\s*hidden/);
      expect(mini).toMatch(/visibility 0s linear 0\.16s/);
      // hover 临时展开：必须自带无延迟 transition（变更后样式是过渡参数来源）
      const hover = css.match(/\.ni-ask-dock\.is-mini:hover \.ni-ask-body \{[^}]*\}/)?.[0] ?? "";
      expect(hover).toMatch(/visibility:\s*visible/);
      expect(hover).toMatch(/visibility 0s linear 0s/);
    });

    test("滚动收缩走 80/220 滞回：越 220 收缩、稳定区维持、贴底展开", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const list = root.querySelector(".ni-message-list") as HTMLElement;
      const dock = () => root.querySelector(".ni-ask-dock") as HTMLElement;

      mockListMetrics(list, 1000, 200, 300); // gap=500 > 220：收缩
      expect(dock().classList.contains("is-mini")).toBe(true);

      mockListMetrics(list, 1000, 200, 700); // gap=100 落进稳定区（80~220）：已收缩维持
      expect(dock().classList.contains("is-mini")).toBe(true);

      mockListMetrics(list, 1000, 200, 780); // gap=20 ≤ 80：展开
      expect(dock().classList.contains("is-mini")).toBe(false);

      mockListMetrics(list, 1000, 200, 750); // gap=50 在稳定区：已展开维持
      expect(dock().classList.contains("is-mini")).toBe(false);
      view.dispose();
    });

    test("点收缩条展开并回到最新；Esc 只收起选项面板且显式收起后自动展开让位", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-agent");
      const list = root.querySelector(".ni-message-list") as HTMLElement;
      const dock = () => root.querySelector(".ni-ask-dock") as HTMLElement;

      // Esc 收起（不代答：协议 options 没有 no 标记，只走稿的「只收起」分支）
      pressEscapeKey();
      expect(dock().classList.contains("is-mini")).toBe(true);
      const answered = (await createMockNiChatAdapter(createMockNiChatState()).getSnapshot()).interactions["interaction-1"]?.state;
      expect(answered).toBe("pending"); // 待确认状态一点不变

      // 显式收起后，滚回底部不自动展开（askPinned 让位）
      mockListMetrics(list, 1000, 200, 780);
      expect(dock().classList.contains("is-mini")).toBe(true);

      // 点收缩条：解除收起意图、展开并滚回最新（等过渡的 250ms 后）
      const calls: Array<{ top?: number; behavior?: string }> = [];
      list.scrollTo = ((options?: ScrollToOptions) => { calls.push({ ...options }); }) as typeof list.scrollTo;
      (dock().querySelector(".ni-ask-bar") as HTMLButtonElement).click();
      expect(dock().classList.contains("is-mini")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 260));
      expect(calls).toHaveLength(1);
      expect(calls[0]?.top).toBe(1000);
      expect(calls[0]?.behavior).toBe("smooth");
      view.dispose();
    });

    test("别人要答的 pending 不进坞、不冒充我的待办", async () => {
      const state = createMockNiChatState();
      state.interactions["interaction-1"]!.eligibleResponderIds = ["someone-else"];
      const { root, view } = await mount(state);
      enterConversation(root, "human-agent");
      expect(root.querySelector(".ni-ask-dock")).toBeNull();
      const card = root.querySelector('.ni-message-list [data-interaction-id="interaction-1"]');
      expect(card?.querySelector(".ni-interaction-option")).toBeNull(); // 只读呈现
      view.dispose();
    });

    test("同一会话多条 pending：坞钉消息流最早那条，其余留流内可答；答掉后下一条晋升", async () => {
      const state = createMockNiChatState();
      state.interactions["interaction-2"] = interaction({
        id: "interaction-2",
        prompt: "第二个问题",
        schema: { kind: "choice", options: [{ id: "ok", label: "好的" }] },
      });
      // 消息流顺序：ha-1、ha-2（引用 interaction-1）、新消息引用 interaction-2 —— 坞应钉 interaction-1
      // ha-3 混排引用第二条（流内渲染卡）；ha-4 只引用坞上那条（docked-only，整条不渲染）
      state.messagesByConversation["human-agent"]?.push(message({
        id: "ha-3",
        conversationId: "human-agent",
        senderId: "agent-coder",
        parts: [{ kind: "text", text: "顺手再问一句" }, { kind: "interaction_ref", interactionId: "interaction-2" }],
        createdAt: "2026-08-12T08:01:00Z",
      }));
      state.messagesByConversation["human-agent"]?.push(message({
        id: "ha-4",
        conversationId: "human-agent",
        senderId: "agent-coder",
        parts: [{ kind: "interaction_ref", interactionId: "interaction-1" }],
        createdAt: "2026-08-12T08:01:30Z",
      }));
      const { root, adapter, view } = await mount(state);
      enterConversation(root, "human-agent");
      expect(root.querySelector<HTMLElement>(".ni-ask-dock")?.dataset.interactionId).toBe("interaction-1");
      // 第二条 pending 留在流内、带完整动作（不因「坞只有一个」被藏掉）
      const second = root.querySelector('.ni-message-list [data-interaction-id="interaction-2"]');
      expect(second?.querySelector(".ni-interaction-option")?.textContent).toBe("好的");
      // 只引用坞上那条的纯 interaction 消息整条不渲染（不留空气泡）
      expect(root.querySelector('[data-message-id="ha-4"]')).toBeNull();

      // 答掉坞上那条：interaction-2 晋升进坞
      (root.querySelectorAll(".ni-ask-dock .ni-interaction-option")[0] as HTMLButtonElement).click();
      await adapter.whenIdle();
      expect(root.querySelector<HTMLElement>(".ni-ask-dock")?.dataset.interactionId).toBe("interaction-2");
      view.dispose();
    });

    test("跨会话畸形引用不藏待确认：interaction 不属于当前会话时留在流内", async () => {
      const state = createMockNiChatState();
      // 畸形数据：当前流里的 interaction_ref 指向挂在别的会话上的 pending
      state.interactions["interaction-1"]!.conversationId = "mixed-group";
      const { root, view } = await mount(state);
      enterConversation(root, "human-agent");
      expect(root.querySelector(".ni-ask-dock")).toBeNull(); // 不进坞（conversationId 不属于当前会话）
      const card = root.querySelector('.ni-message-list [data-interaction-id="interaction-1"]');
      expect(card).not.toBeNull(); // 也不藏：留在流内可答
      expect(card?.querySelector(".ni-interaction-option")).not.toBeNull();
      view.dispose();
    });

    test("text 型待确认的开放表单在坞上提交并收敛", async () => {
      const state = createMockNiChatState();
      state.interactions["interaction-1"] = interaction({
        prompt: "还需要补充什么？",
        schema: { kind: "text", placeholder: "补充说明", maxLength: 120 },
      });
      const { root, adapter, view } = await mount(state);
      enterConversation(root, "human-agent");
      const input = root.querySelector('.ni-ask-dock .ni-interaction-text') as HTMLTextAreaElement;
      expect(input.placeholder).toBe("补充说明");
      input.value = "把升级提醒也写进去";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector(".ni-ask-dock .ni-interaction-open-form") as HTMLFormElement)
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await adapter.whenIdle();
      expect(root.querySelector(".ni-ask-dock")).toBeNull();
      expect(root.querySelector('.ni-message-list [data-interaction-id="interaction-1"]')?.textContent)
        .toContain("把升级提醒也写进去");
      view.dispose();
    });
  });

  describe("打 @ 弹成员选择（A4-14）", () => {
    function enterConversation(root: HTMLElement, conversationId: string): void {
      (root.querySelector(`[data-conversation-id="${conversationId}"]`) as HTMLButtonElement).click();
    }

    function pickerNames(root: HTMLElement): string[] {
      return Array.from(root.querySelectorAll(".ni-mention-picker-item .ni-at-nm")).map((node) => node.textContent ?? "");
    }

    /* 打 @ 首次触发会整屏重绘换掉输入框节点，每次都重查当前节点再写值 */
    function typeInto(root: HTMLElement, value: string): void {
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    test("打 @ 字符触发：仅群聊，候选行结构对照稿（头像/名字/稳定标识），自己不在列", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root, "@");
      const picker = root.querySelector(".ni-mention-picker") as HTMLElement;
      expect(picker.getAttribute("role")).toBe("listbox");
      expect(pickerNames(root)).toEqual(["Alice", "代码助手", "研究助手"]); // 排除自己（me）
      const first = picker.querySelector(".ni-mention-picker-item") as HTMLElement;
      expect(first.querySelector(".ni-at-av")?.textContent).toBe("A");
      expect(first.querySelector(".ni-at-nm")?.textContent).toBe("Alice");
      expect(first.querySelector(".ni-at-rl")?.textContent).toBe("@alice");
      expect(first.classList.contains("is-sel")).toBe(true); // 首行选中（对照稿 atSel=0）
      view.dispose();
    });

    test("单聊打 @ 不弹：只有两个人，@ 没有意义（以稿为准）", async () => {
      const { root, view } = await mount();
      enterConversation(root, "human-human");
      typeInto(root, "@");
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      enterConversation(root, "human-agent"); // 人- Agent 单聊同样不弹
      typeInto(root, "@");
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      view.dispose();
    });

    test("继续输入过滤 + 前缀命中排在包含命中前面", async () => {
      const state = createMockNiChatState();
      // 造「前缀 vs 包含」场景：打「代」时「代码助手」前缀命中，「审代」是包含命中
      state.profiles["agent-review"] = {
        id: "agent-review",
        type: "agent",
        username: "review-helper",
        displayName: "审代助手",
        avatarText: "V",
      };
      state.conversations = state.conversations.map((conversation) =>
        conversation.id === "mixed-group"
          ? { ...conversation, participantIds: [...conversation.participantIds, "agent-review"] }
          : conversation);
      const { root, view } = await mount(state);
      enterConversation(root, "mixed-group");
      typeInto(root, "@代");
      expect(pickerNames(root)).toEqual(["代码助手", "审代助手"]); // startsWith('代') 在前

      typeInto(root, "@zzz");
      expect(root.querySelector(".ni-mention-picker-empty")?.textContent).toBe("没有匹配的成员");
      expect(root.querySelector(".ni-mention-picker-item")).toBeNull();
      view.dispose();
    });

    test("键盘路径：上下键移候选、Enter 选定回填「@名字␣」、光标落在名字后、chip 台账登记", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root, "叫一下@");
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); // 0→1：代码助手
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })); // 1→0：Alice
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flushRender();
      const after = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      expect(after.value).toBe("叫一下@Alice "); // 回填带尾随空格（对照稿 tag='@'+name+' '）
      expect(after.selectionStart).toBe("叫一下@Alice ".length); // 光标落在名字后
      expect(root.querySelector(".ni-mention-picker")).toBeNull(); // 选完收起
      expect(root.querySelector('[data-composer-mention-id="human-alice"]')?.textContent).toContain("Alice");
      expect(document.activeElement).toBe(after);
      view.dispose();
    });

    test("点击候选同样回填；@ 后打空格或删掉 @ 浮层收起；点外与 Esc 收起", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root, "@");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      (root.querySelector('[data-mention-profile-id="agent-research"]') as HTMLButtonElement).click();
      await flushRender();
      expect((root.querySelector(".ni-composer-input") as HTMLTextAreaElement).value).toBe("@研究助手 ");

      typeInto(root, "@研究 助手"); // @ 后出现空格：这次 @ 当写完了
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      typeInto(root, "没有符号");
      expect(root.querySelector(".ni-mention-picker")).toBeNull();

      typeInto(root, "@代");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      (root.querySelector(".ni-message-list") as HTMLElement).click(); // 点外收
      expect(root.querySelector(".ni-mention-picker")).toBeNull();

      typeInto(root, "@代");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      view.dispose();
    });

    test("换会话收 @ 浮层：不跨会话存续（对照稿换会话连栈里那条一起摘）", async () => {
      const { root, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root, "@");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      enterConversation(root, "human-agent");
      expect(root.querySelector(".ni-mention-picker")).toBeNull();
      view.dispose();
    });

    test("输入法组合期：Enter 不选人也不发送，方向键不劫持拼音翻页", async () => {
      const { root, adapter, view } = await mount();
      enterConversation(root, "mixed-group");
      typeInto(root, "@");
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      // 拼音组合中按 Enter（确认拼音）：选择器不动、消息不被发出
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
      expect(root.querySelector(".ni-mention-picker")).not.toBeNull();
      // 组合中的方向键（拼音候选翻页）：选择器选中行不动
      const selBefore = root.querySelector(".ni-mention-picker-item.is-sel")?.textContent;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, isComposing: true }));
      expect(root.querySelector(".ni-mention-picker-item.is-sel")?.textContent).toBe(selBefore);
      view.dispose();
      void adapter;
    });
  });

  describe("输入行麦克风钮（A4-16）", () => {
    test("麦克风钮在输入行、图标与 aria 对稿；点击停在诚实边界提示，不假装在听", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="mixed-group"]') as HTMLButtonElement).click();
      const form = root.querySelector(".ni-composer-form") as HTMLElement;
      const mic = form.querySelector(".ni-composer-mic") as HTMLButtonElement;
      expect(mic).not.toBeNull();
      expect(mic.getAttribute("aria-label")).toBe("语音输入");
      expect(mic.querySelector("svg")).not.toBeNull(); // 稿的 mic 图标
      // 位于输入框与发送钮之间（对照稿：输入框右侧）
      const order = Array.from(form.children).map((child) => child.className);
      expect(order.indexOf("ni-composer-mic")).toBe(order.indexOf("ni-composer-input") + 1);
      expect(order.indexOf("ni-composer-mic")).toBeLessThan(order.indexOf("ni-composer-send"));

      mic.click();
      expect(root.querySelector(".ni-client-note")?.textContent).toBe("语音输入将在插件语音链路接入后开放");
      view.dispose();
    });

    test("麦克风图标与 agent-ui composer 用同一枚 path（任务/日程与 IM 是同一张脸）", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="human-human"]') as HTMLButtonElement).click();
      const ours = root.querySelector(".ni-composer-mic svg")?.innerHTML ?? "";
      expect(ours).toBe(icon("mic", 14).innerHTML); // 同一枚 path，改一处就分叉
      view.dispose();
    });
  });

  describe("跨 App 外部上下文（A3-24「发给 agent」的落点）", () => {
    const ATTACHMENT = { label: "现场记录 14:03–14:41 · 84 字", text: "我们先把发布节奏定下来。" };

    /** Host 把 intent 投给 ni.chat 后，视图暴露的落点；返回 true = 找到了会话。 */
    function attach(view: { attachExternalContext(attachment: { label: string; text: string }): boolean }): boolean {
      return view.attachExternalContext({ ...ATTACHMENT });
    }

    test("落进当前已开会话的附件条：chip 只报呈现名、不可换挡、可移除", async () => {
      const { root, view } = await mount();
      (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
      expect(attach(view)).toBe(true);
      const chip = root.querySelector(".ni-composer-attachment") as HTMLElement;
      expect(chip.classList.contains("is-external")).toBe(true);
      expect(chip.querySelector("b")?.textContent).toBe(ATTACHMENT.label);
      expect(chip.title).toBe(ATTACHMENT.label);
      // 内容固定的一段引用，没有「换」——换挡是本会话上下文才有的语义。
      expect(chip.querySelector(".ni-composer-attachment-swap")).toBeNull();
      (chip.querySelector(".ni-composer-attachment-x") as HTMLButtonElement).click();
      expect(root.querySelector(".ni-composer-attachments")).toBeNull(); // 移除后整条收起
      view.dispose();
    });

    test("一个会话都没选时落第一个（A4-6 的既定例外：跨 App intent 本身就是一次用户动作）", async () => {
      const { root, view } = await mount();
      expect(root.querySelector(".ni-conversation-item[aria-current]")).toBeNull(); // 未选态
      expect(attach(view)).toBe(true);
      // 第一个会话被进入，附件条出现在它的输入侧。
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      expect(root.querySelector(".ni-composer-attachment b")?.textContent).toBe(ATTACHMENT.label);
      view.dispose();
    });

    test("没有任何会话时如实返回 false，不落地也不报错", async () => {
      const state = createMockNiChatState();
      state.conversations = [];
      const { view } = await mount(state);
      expect(attach(view)).toBe(false);
      view.dispose();
    });

    test("发送随消息走：external_context part 原样快照，消息流呈现「带上的现场记录」标记", async () => {
      const { root, adapter, view } = await mount();
      (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
      attach(view);
      const input = root.querySelector(".ni-composer-input") as HTMLTextAreaElement;
      input.value = "按这段记录把发布节奏整理成清单";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      (root.querySelector(".ni-composer-form") as HTMLFormElement)
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await adapter.whenIdle();
      await flushRender();

      const sent = (await adapter.getSnapshot()).messagesByConversation["human-agent"]?.at(-1);
      expect(sent?.parts[0]).toEqual({ kind: "external_context", label: ATTACHMENT.label, text: ATTACHMENT.text });
      expect(sent?.parts[1]).toMatchObject({ kind: "text", text: "按这段记录把发布节奏整理成清单" });
      const block = root.querySelector(".ni-part-context.is-external");
      expect(block?.textContent).toContain(`带上的现场记录 · ${ATTACHMENT.label}`);
      expect(block?.querySelector(".ni-context-symbol")?.textContent).toBe("〰");
      expect(root.querySelector(".ni-composer-attachments")).toBeNull(); // 发完归零
      view.dispose();
    });
  });

  describe("按 agent 打开会话（B6-26「在 IM 里看上下文」）", () => {
    test("agentId/呈现名/用户名任一命中；一对一私聊优先于群", async () => {
      const { root, view } = await mount();
      // Claude Code（fixtures 的 me+cc 一对一）——按 agentId 命中。
      expect(view.openConversationByAgent({ agentId: "cc", agentName: "Claude Code" })).toBe(true);
      expect(root.querySelector('[data-conversation-id="human-cc"]')?.getAttribute("aria-current")).toBe("true");
      expect(root.querySelector(".ni-conversation-title")?.textContent).toContain("Claude Code");
      // displayName 命中代码助手：me+agent-coder 的一对一优先于含它的 mixed-group。
      expect(view.openConversationByAgent({ agentName: "代码助手" })).toBe(true);
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      // username 命中回退口径。
      expect(view.openConversationByAgent({ agentName: "research-helper" })).toBe(true);
      // agent-research 与本人没有一对一，含它的会话只有 agent-agent（无本人）→ 如实 false。
      view.dispose();
    });

    test("没有一对一时回退含该 agent 的群会话；无本人参与则不落", async () => {
      const state = createMockNiChatState();
      const { root, view } = await mount(state);
      // me + agent-research 只共同出现在 mixed-group：群回退。
      expect(view.openConversationByAgent({ agentName: "研究助手" })).toBe(true);
      expect(root.querySelector('[data-conversation-id="mixed-group"]')?.getAttribute("aria-current")).toBe("true");
      // agent-agent（agent-coder × agent-research）没有本人参与，绝不能被选中。
      expect(root.querySelector('[data-conversation-id="agent-agent"]')?.getAttribute("aria-current")).toBeNull();
      view.dispose();
    });

    test("agent 不存在或没有任何共同会话时返回 false，不落错误会话", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      expect(view.openConversationByAgent({ agentName: "不存在的 agent" })).toBe(false);
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      view.dispose();
    });

    test("只认 agent 身份：人类/System 的呈现名或误传的 agentId 不开门", async () => {
      const { root, view } = await mount();
      enterFirst(root);
      expect(view.openConversationByAgent({ agentName: "Alice" })).toBe(false);
      expect(view.openConversationByAgent({ agentName: "ni.chat 系统" })).toBe(false);
      expect(view.openConversationByAgent({ agentName: "你" })).toBe(false);
      // agentId 误传本人：不命中任何 agent id，也不能落到错误会话。
      expect(view.openConversationByAgent({ agentId: "me", agentName: "不存在" })).toBe(false);
      // 冲突身份（错误 ID + 可命中的名称）：agentId 是精确锚，不做名称兜底——
      // 宁可不开门，也不把人带进「看起来对」的错误会话。
      expect(view.openConversationByAgent({ agentId: "me", agentName: "Claude Code" })).toBe(false);
      expect(root.querySelector('[data-conversation-id="human-agent"]')?.getAttribute("aria-current")).toBe("true");
      // ID 指向合法 agent 时按 ID 命中（名称只是显示提示，不参与判定）。
      expect(view.openConversationByAgent({ agentId: "cc", agentName: "Codex" })).toBe(true);
      expect(root.querySelector('[data-conversation-id="human-cc"]')?.getAttribute("aria-current")).toBe("true");
      view.dispose();
    });

    test("进入即已读：未读数经 adapter 清零（flush 后断言）", async () => {
      const { root, adapter, view } = await mount();
      // human-agent 初始未读 1；用代码助手打开它。
      expect(view.openConversationByAgent({ agentName: "代码助手" })).toBe(true);
      await adapter.whenIdle();
      await flushRender();
      const snapshot = await adapter.getSnapshot();
      expect(snapshot.conversations.find((conversation) => conversation.id === "human-agent")?.unreadCount).toBe(0);
      expect(root.querySelector('[data-conversation-id="human-agent"] .ni-unread')).toBeNull();
      view.dispose();
    });
  });
});

describe("中栏拖宽手柄（A4-5，对照稿 alResize/makeResizer）", () => {
  const css = readFileSync(join(import.meta.dir, "../packages/ni-chat-ui/src/ni-chat-ui.css"), "utf8");
  let savedInnerWidth = 1024;

  beforeEach(() => {
    localStorage.removeItem("ni-chat.sidebarWidth");
    savedInnerWidth = window.innerWidth;
  });

  async function mountSidebar() {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = await mountNiChatView(root, {
      adapter: createMockNiChatAdapter(createMockNiChatState()),
      now: () => Date.parse("2026-08-12T08:00:30Z"),
    });
    const sidebar = root.querySelector(".ni-sidebar") as HTMLElement;
    const handle = sidebar.querySelector(".rs-handle") as HTMLElement;
    return { root, view, sidebar, handle };
  }

  /* 对稿 makeResizer 的三段事件流：down(捕获) → document move → document up */
  function dragTo(handle: HTMLElement, fromX: number, toX: number, pointerId = 3): void {
    handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId, clientX: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: toX, bubbles: true }));
  }

  function endDrag(pointerId = 3): void {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
  }

  test("形态逐字对稿：8px 隐形热区贴栏右缘、2px 强调线 hover/dragging 淡入、定位锚点就位", () => {
    // 栏宽改为变量驱动（拖拽写入 --ni-sidebar-w），默认仍是 282px
    expect(css).toMatch(/\.ni-sidebar\s*\{[^}]*width\s*:\s*var\(--ni-sidebar-w,\s*282px\)/s);
    expect(css).toMatch(/\.ni-sidebar\s*\{[^}]*flex\s*:\s*0 0 var\(--ni-sidebar-w,\s*282px\)/s);
    expect(css).toMatch(/\.ni-sidebar\s*\{[^}]*position\s*:\s*relative/s); // 手柄定位锚点
    expect(css).toMatch(/\.ni-sidebar > \.rs-handle\s*\{[^}]*position\s*:\s*absolute[^}]*right\s*:\s*-3px[^}]*width\s*:\s*8px[^}]*cursor\s*:\s*col-resize[^}]*z-index\s*:\s*60[^}]*touch-action\s*:\s*none/s);
    expect(css).toMatch(/\.ni-sidebar > \.rs-handle::after\s*\{[^}]*left\s*:\s*2px[^}]*width\s*:\s*2px[^}]*opacity\s*:\s*0[^}]*transition\s*:\s*opacity \.15s/s);
    expect(css).toMatch(/\.ni-sidebar > \.rs-handle:hover::after,\s*\.ni-sidebar > \.rs-handle\.dragging::after\s*\{[^}]*opacity\s*:\s*\.85/s);
    // 拖动中锁死整页光标与选区（稿 body.rs-dragging）
    expect(css).toMatch(/body\.rs-dragging\s*\{[^}]*cursor\s*:\s*col-resize/s);
    // 宽度被窄档（760 起 238px）钉死的区间手柄撤掉——稿小屏短路，断点对齐本包窄档
    const narrow = css.match(/@media \(max-width: 760px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toMatch(/\.ni-sidebar > \.rs-handle\s*\{\s*display\s*:\s*none/);
    expect(narrow).toMatch(/\.ni-sidebar\s*\{[^}]*width\s*:\s*238px/); // 窄档仍钉死宽度
  });

  test("手柄是中栏最后一个子元素，title 逐字、separator 语义带刻度", async () => {
    const { sidebar, handle, view } = await mountSidebar();
    expect(sidebar.lastElementChild).toBe(handle);
    expect(handle.title).toBe("拖动调整宽度 · 双击复位");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("会话列表栏宽");
    expect(handle.getAttribute("aria-valuemin")).toBe("184"); // 稿 AL_MIN
    expect(handle.getAttribute("aria-valuemax")).toBe("540"); // 稿 PANE_MAX
    // 启动即把显示宽画出去（稿 applyUI 总写 --al-w，默认也一样写），只画不落盘
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("282px");
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBeNull();
    view.dispose();
  });

  test("拖拽改宽：delta 直接改栏宽、拖拽期间锁光标不落盘、松手才落盘", async () => {
    const { sidebar, handle, view } = await mountSidebar();
    dragTo(handle, 300, 400);
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("382px"); // 282 + 100
    expect(handle.classList.contains("dragging")).toBe(true);
    expect(document.body.classList.contains("rs-dragging")).toBe(true);
    expect(handle.getAttribute("aria-valuenow")).toBe("382");
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBeNull(); // 途中不写盘
    endDrag();
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBe("382"); // 松手落一次盘
    expect(handle.classList.contains("dragging")).toBe(false);
    expect(document.body.classList.contains("rs-dragging")).toBe(false);
    view.dispose();
  });

  test("钳制边界：上界 540（稿 PANE_MAX 扣 CENTER_MIN 后仍 540）、下界 184（稿 AL_MIN）", async () => {
    const { sidebar, handle, view } = await mountSidebar();
    dragTo(handle, 300, 1500);
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("540px"); // min(540, 1080-320)
    endDrag();
    dragTo(handle, 300, -400);
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("184px");
    endDrag();
    view.dispose();
  });

  test("推挤抽屉展开时上界收紧 236（稿 sideCost），拖中栏不动抽屉（#352 护栏）", async () => {
    const { root, sidebar, handle, view } = await mountSidebar();
    (root.querySelector('[data-conversation-id="human-agent"]') as HTMLButtonElement).click();
    (root.querySelector('.ni-header-action[aria-label="任务锚点"]') as HTMLButtonElement).click();
    const drawer = root.querySelector(".ni-drawer") as HTMLElement;
    expect(drawer.classList.contains("open")).toBe(true);
    dragTo(handle, 300, 1500);
    // 1080 - 236(抽屉) - 320(会话区下界) = 524
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("524px");
    // 手柄拖的是中栏宽度，抽屉开态与宽度不受影响
    expect(drawer.classList.contains("open")).toBe(true);
    endDrag();
    view.dispose();
  });

  test("双击复位到默认宽 282（本包既有对稿默认；稿 AL_DEF=264）并落盘", async () => {
    const { sidebar, handle, view } = await mountSidebar();
    dragTo(handle, 300, 460);
    endDrag();
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("442px");
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("282px");
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBe("282");
    view.dispose();
  });

  test("宽度记忆持久化：重新挂载从 localStorage 恢复，启动不写盘", async () => {
    localStorage.setItem("ni-chat.sidebarWidth", "400");
    const { sidebar, handle, view } = await mountSidebar();
    expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe("400px");
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    view.dispose();
  });

  test("760 窄档以下手柄短路：按下不进入拖拽、不写变量、不落盘（稿小屏短路同款）", async () => {
    (window as { innerWidth: number }).innerWidth = 700;
    try {
      const { sidebar, handle, view } = await mountSidebar();
      expect(sidebar.style.getPropertyValue("--ni-sidebar-w")).toBe(""); // 记忆值让位给窄档
      handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, clientX: 300, bubbles: true, cancelable: true }));
      expect(handle.classList.contains("dragging")).toBe(false);
      expect(document.body.classList.contains("rs-dragging")).toBe(false);
      endDrag();
      expect(localStorage.getItem("ni-chat.sidebarWidth")).toBeNull();
      view.dispose();
    } finally {
      (window as { innerWidth: number }).innerWidth = savedInnerWidth;
    }
  });

  /* 模拟「releasePointerCapture 同步派发 lostpointercapture」的 WebView：
     monkeypatch release 使其内联再派发一次 lost——stop 的重入路径由此真实
     走到（happy-dom 自己不派发）。配 Storage.setItem 计数，落盘次数是可断言的：
     旧排序（release 先于 pid 复位）下 up 会经重入走两遍落盘，这里就红。 */
  function patchSyncLost(handle: HTMLElement): void {
    handle.releasePointerCapture = (pointerId: number) => {
      handle.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId, bubbles: true }));
    };
  }

  /* 计数 localStorage 写盘次数：实例上定义自有 setItem 遮蔽原型——happy-dom 的
     localStorage 与全局 Storage 可能不在同一 realm，动 Storage.prototype 拦不住。 */
  function countSetItem<T>(body: () => T): { result: T; writes: number } {
    let writes = 0;
    const store = localStorage;
    const original = store.setItem.bind(store);
    Object.defineProperty(store, "setItem", {
      configurable: true,
      value: (key: string, value: string) => {
        writes += 1;
        return original(key, value);
      },
    });
    try {
      const result = body();
      return { result, writes };
    } finally {
      /* happy-dom 的 localStorage 是 Proxy，delete 会被拒——写回 bound 原函数还原 */
      Object.defineProperty(store, "setItem", { configurable: true, value: original });
    }
  }

  test("lostpointercapture 兜底收拖拽；同步派发 lost 的 WebView 里松手落盘恰好一次", async () => {
    const { handle, view } = await mountSidebar();
    dragTo(handle, 300, 400);
    // 捕获被系统收走：lost = 拖拽结束，按用户动作终点落一次盘（稿 stop 同款）
    handle.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 3, bubbles: true }));
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBe("382");
    expect(document.body.classList.contains("rs-dragging")).toBe(false);
    // 同步派发 lost 的 WebView：松手的 release 内联再派 lost——重入必须在门口短路
    localStorage.removeItem("ni-chat.sidebarWidth");
    dragTo(handle, 300, 460); // 起点是上一轮留存的意愿 382：382+160=542 → 钳到 540
    patchSyncLost(handle);
    const counted = countSetItem(() => endDrag());
    expect(counted.writes).toBe(1); // 旧排序（release 先于 pid 复位）下这里是 2
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBe("540");
    view.dispose();
  });

  test("拖拽中 dispose（release 同步派发 lost）：一次盘都不落——卸载不是用户意图", async () => {
    const { handle, view } = await mountSidebar();
    dragTo(handle, 300, 400);
    patchSyncLost(handle);
    const counted = countSetItem(() => view.dispose());
    expect(counted.writes).toBe(0);
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBeNull();
  });

  test("拖拽中 dispose：body 光标锁与 document 监听一并摘掉", async () => {
    const { handle, view } = await mountSidebar();
    dragTo(handle, 300, 400);
    expect(document.body.classList.contains("rs-dragging")).toBe(true);
    view.dispose();
    expect(document.body.classList.contains("rs-dragging")).toBe(false);
    expect(handle.isConnected).toBe(false); // 随根节点一并移除
    // 摘掉后的 move/up 不再有副作用（不炸、不写盘）
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 900, bubbles: true }));
    endDrag();
    expect(localStorage.getItem("ni-chat.sidebarWidth")).toBeNull();
  });
});
