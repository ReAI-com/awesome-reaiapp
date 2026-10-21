import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { AgentOrGroup } from "@reai/agent-ui";

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => document.body.replaceChildren());

async function agentUi() {
  return import("@reai/agent-ui");
}

async function mountTasks(agents?: AgentOrGroup[]) {
  const root = document.createElement("main");
  document.body.appendChild(root);
  const { mountTasksView } = await import("../src/tasks-view");
  const view = mountTasksView(root, { agents });
  return { root, view };
}

function setScrollMetrics(stream: HTMLElement, values: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperties(stream, {
    scrollHeight: { configurable: true, value: values.scrollHeight },
    clientHeight: { configurable: true, value: values.clientHeight },
    scrollTop: { configurable: true, writable: true, value: values.scrollTop },
  });
}

function scrollTo(stream: HTMLElement, scrollTop: number): void {
  stream.scrollTop = scrollTop;
  stream.dispatchEvent(new Event("scroll"));
}

describe("Agent UI 共享数据合同", () => {
  test("任务由同一 Agent 流里带 dir 的 anchor 派生，不维护第二份 TASKS", async () => {
    const { createDemoAgentState, deriveTasks } = await agentUi();
    const agents = createDemoAgentState();
    const tasks = deriveTasks(agents);

    expect(tasks.map((task) => task.title)).toEqual([
      "修复 Windows 拨杆注入",
      "yolo_cycle_enabled 开关",
      "写这版发布说明",
      "官网价格表改版审查",
    ]);
    const claudeCode = agents.find((agent) => agent.id === "cc");
    expect(claudeCode).toBeDefined();
    expect(tasks[0]?.conversation).toBe(claudeCode!.stream);
  });

  test("共享包导出搜索、会话流和输入坞三个复用组件", async () => {
    const ui = await agentUi();
    expect(ui.createSearchInput).toBeFunction();
    expect(ui.mountConversationStream).toBeFunction();
    expect(ui.mountAgentComposer).toBeFunction();
  });

  test("会话与 Action 坞都挂载后仍可统一回到最新位置", async () => {
    const { createDemoAgentState, mountConversationStream } = await agentUi();
    const agent = createDemoAgentState()[1]!;
    const container = document.createElement("section");
    const stream = mountConversationStream(container, { agent, items: agent.stream });
    Object.defineProperties(stream.element, {
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    stream.scrollToLatest();
    expect(stream.element.scrollTop).toBe(1200);
  });
});

describe("Agents · 任务 Surface", () => {
  test("任务详情不再是只读归属卡，而是完整会话区间 + 同款输入坞", async () => {
    const { root, view } = await mountTasks();
    expect(root.querySelector(".agent-ui.agents-tasks-app")).not.toBeNull();
    expect(root.querySelector(".task-list-pane")).not.toBeNull();
    expect(root.querySelector(".task-conversation-pane")).not.toBeNull();
    expect(root.querySelector(".task-conversation-empty")?.textContent).toContain("同一批消息");
    (root.querySelector('[data-task-title="修复 Windows 拨杆注入"]') as HTMLButtonElement).click();
    expect(root.querySelector('[data-task-title="修复 Windows 拨杆注入"].is-active')).not.toBeNull();
    expect(root.querySelector(".task-conversation-title")?.textContent).toBe("修复 Windows 拨杆注入");
    expect(root.querySelector(".agent-conversation-stream")?.textContent).toContain("拨杆切模式");
    expect(root.querySelector(".agent-composer-input")).toBeInstanceOf(HTMLInputElement);
    view.dispose();
  });

  test("任务搜索按标题/Agent/目录过滤且不破坏项目层级", async () => {
    const { root, view } = await mountTasks();
    // V1.7.0（B6-16）：搜索只筛任务不筛项目——项目数不随查询变。
    const totalProjects = root.querySelectorAll("[data-project-dir]").length;
    expect(totalProjects).toBeGreaterThan(1);
    const input = root.querySelector(".agent-search-input") as HTMLInputElement;
    input.value = "landing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelectorAll("[data-task-title]")).toHaveLength(1);
    expect(root.querySelectorAll("[data-project-dir]")).toHaveLength(totalProjects);
    const matchedTask = root.querySelector("[data-task-title]");
    expect(matchedTask?.closest("[data-project-dir]")?.getAttribute("data-project-dir")).toBe("~/Developer/landing");
    expect(matchedTask?.textContent).toContain("官网价格表改版审查");
    view.dispose();
  });

  test("任务页使用同一输入坞发送消息", async () => {
    const { root, view } = await mountTasks();
    (root.querySelector('[data-task-title="修复 Windows 拨杆注入"]') as HTMLButtonElement).click();
    const input = root.querySelector(".agent-composer-input") as HTMLInputElement;
    input.value = "继续处理这个任务";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.querySelector(".agent-conversation-stream")?.textContent).toContain("继续处理这个任务");
    expect(root.querySelector(".agent-conversation-stream")?.textContent).not.toContain("再加个开关");
    expect(root.querySelector(".task-header-state")?.textContent).toBe("已完成");
    expect((root.querySelector(".agent-composer-input") as HTMLInputElement).value).toBe("");
    view.dispose();
  });

  test("回答完成态任务里的 Action 不会把任务改回进行中", async () => {
    const agents: AgentOrGroup[] = [{
      id: "finished",
      kind: "agent",
      ava: "◆",
      name: "Finished Agent",
      role: "测试完成态任务",
      status: "idle",
      time: "刚刚",
      last: "等待确认",
      stream: [
        { k: "day", t: "今天" },
        { k: "ask", brief: "确认归档", text: "要保留归档记录吗？", opts: ["保留"] },
        { k: "anchor", icon: "✓", title: "已完成任务", meta: "今天完成", st: "done", dir: "~/Developer/demo" },
      ],
    }];
    const { root, view } = await mountTasks(agents);
    (root.querySelector('[data-task-title="已完成任务"]') as HTMLButtonElement).click();
    expect(root.querySelector(".task-header-state")?.textContent).toBe("已完成");
    (root.querySelector(".agent-prompt-action") as HTMLButtonElement).click();

    expect(root.querySelector(".task-header-state")?.textContent).toBe("已完成");
    expect(root.querySelector('[data-task-title="已完成任务"]')?.classList.contains("is-done")).toBeTrue();
    expect(root.querySelector(".agent-prompt-dock")).toBeNull();
    expect(root.querySelector(".agent-conversation-stream")?.textContent).toContain("✓ 已确认");
    view.dispose();
  });

  test("任务详情复用同一 Action 滚动收缩行为", async () => {
    const { root, view } = await mountTasks();
    (root.querySelector('[data-task-title="写这版发布说明"]') as HTMLButtonElement).click();
    const stream = root.querySelector(".agent-conversation-stream") as HTMLElement;
    const prompt = root.querySelector(".agent-prompt-dock") as HTMLElement;
    setScrollMetrics(stream, { scrollHeight: 900, clientHeight: 360, scrollTop: 250 });

    stream.dispatchEvent(new Event("scroll"));
    expect(prompt.classList.contains("is-compact")).toBeTrue();
    scrollTo(stream, 500);
    expect(prompt.classList.contains("is-compact")).toBeFalse();
    view.dispose();
  });
});
