import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CodexStore } from "../src/codex-repository";
import { mountCodexView } from "../src/codex-view";

const NOW = 1_800_000_000_000;

function memoryStore(): CodexStore {
  const values = new Map<string, unknown>();
  return {
    async get<T>(key: string) { return values.get(key) as T | undefined; },
    async set(key: string, value: unknown) { values.set(key, value); },
    async delete(key: string) { values.delete(key); },
    async keys() { return [...values.keys()]; },
  };
}

describe("Codex Link 0.5 Surface", () => {
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

  test("按设计稿展示四档任务、精确操作、Skills 和新任务浮层", async () => {
    const root = document.createElement("div");
    const calls: Array<{ method: string; params: unknown }> = [];
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "codex.status") return {
          connected: true,
          version: "codex-cli/0.147.0",
          threadCount: 4,
          features: { thread_state_v1: true },
          threads: [
            { threadId: "wait", state: "needsInput", lastEventMs: NOW - 60_000, managedByDriver: true, pendingRequests: [{ serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" }] },
            { threadId: "done", state: "completed", lastEventMs: NOW - 120_000, managedByDriver: true, pendingRequests: [] },
            { threadId: "run", state: "thinking", lastEventMs: NOW - 180_000, activeTurnId: "01911111-1111-7111-8111-111111111111", managedByDriver: true, pendingRequests: [] },
          ],
        } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 },
          { id: "done", cwd: "/work/a", name: "完成未看", recencyAt: (NOW - 120_000) / 1_000 },
          { id: "run", cwd: "/work/a", name: "正在执行", recencyAt: (NOW - 180_000) / 1_000 },
          { id: "old", cwd: "/work/old", name: "很早以前", recencyAt: (NOW - 72 * 60 * 60 * 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [{ name: "test-first", description: "先写验收", path: "/skills/test-first/SKILL.md" }] }] } as T;
        if (["codex.respond_approval", "codex.interrupt_turn", "codex.open_thread"].includes(method)) return {} as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    expect(root.querySelector(".cx-page")).not.toBeNull();
    expect(root.querySelector(".cx-group.hot")?.textContent).toContain("在等你");
    expect(root.querySelector(".cx-group.done")?.textContent).toContain("干完了，你还没看");
    expect(root.querySelector(".cx-group.other")?.textContent).toContain("正在执行");
    expect(root.textContent).toContain("48 小时以外");
    expect(root.textContent).toContain("实时状态仅覆盖由 Driver 管理");
    // 审批已经从列表行搬进任务详情，行内不再有批准/拒绝。
    // 用布尔形式：断言失败意味着那颗按钮真的存在，`toBeNull()` 会去序列化它连着的整棵 DOM，
    // 输出几十 MB、CI 上表现成 job 超时而不是一条可读的失败。
    expect(root.querySelector('[data-action="approve"]') === null).toBeTrue();
    expect(root.querySelector('[data-action="deny"]') === null).toBeTrue();
    expect(root.querySelector('[data-action="interrupt"][data-thread-id="run"]')).not.toBeNull();
    expect(root.querySelector('[data-action="start-skill"][data-skill-name="test-first"]')).not.toBeNull();

    // 第一次点选中，再点一次同一行才进详情。
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    expect((root.querySelector(".cx-detail") as HTMLElement).hidden).toBeTrue();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    expect(detail.hidden).toBeFalse();
    expect(detail.textContent).toContain("等待审批");
    expect(detail.textContent).toContain("等待你审批：运行 cargo test");
    expect(detail.querySelector('[data-action="approve"][data-request-id="41"]')).not.toBeNull();
    expect(detail.querySelector('[data-action="deny"][data-request-id="41"]')).not.toBeNull();

    (detail.querySelector('[data-action="approve"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(calls).toContainEqual({
      method: "codex.respond_approval",
      params: { serverRequestId: 41, decision: "approved", reason: undefined },
    });

    // 点蒙版关掉详情，回到列表。
    detail.click();
    expect(detail.hidden).toBeTrue();

    view.openCompose();
    expect(root.querySelector(".cx-compose")?.getAttribute("aria-hidden")).toBe("false");
    expect((root.querySelector(".cx-compose") as HTMLElement).hidden).toBeFalse();
    // 目录默认值写在 placeholder 上（不动它就用它），候选列表不常驻。
    expect(root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')?.placeholder).toBe("/work/a");
    expect(root.querySelector('[data-slot="cwd-list"]')?.childElementCount).toBe(0);
    view.dispose();
  });

  for (const scenario of [
    { name: "空响应", data: [], empty: true },
    { name: "空目录", data: [{ cwd: "/work/a", skills: [] }], empty: true },
    { name: "全部禁用", data: [{ cwd: "/work/a", skills: [{ name: "disabled", path: "/skills/disabled/SKILL.md", enabled: false }] }], empty: true },
    { name: "读取失败", data: [], failed: true, message: "Skill 读取失败", empty: false },
    { name: "扫描错误", data: [{ cwd: "/work/a", skills: [], errors: [{ path: "/skills/broken/SKILL.md", message: "invalid frontmatter" }] }], message: "1 个 Skill 无法读取", empty: false },
    { name: "存在可用 Skill", data: [{ cwd: "/work/a", skills: [{ name: "review", path: "/skills/review/SKILL.md" }] }], empty: false },
  ]) test(`Skill 目录状态：${scenario.name}，侧栏与抽屉区分空态和错误`, async () => {
    const { data, failed, message, empty } = scenario;
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [{ id: "a", cwd: "/work/a", name: "任务", updatedAt: NOW / 1_000 }] } as T;
        if (method === "codex.list_skills") {
          expect(params).toEqual({ cwds: ["/work/a"], forceReload: true });
          if (failed) throw new Error("unavailable");
          return { data } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    try {
      await view.refresh();
      const panels = root.querySelectorAll<HTMLElement>('[data-slot="skills"]');
      expect(panels.length).toBe(2);
      for (const panel of Array.from(panels)) {
        expect(panel.querySelector('[data-action="pick-skills-folder"]')?.textContent).toContain("添加 Skill 目录…");
        expect(panel.textContent?.includes("当前目录没有可用 Skill。")).toBe(empty);
        if (message) expect(panel.textContent).toContain(message);
      }
    } finally {
      view.dispose();
    }
  });

  test("刷新 Skills 在后台读取期间仍会强制重读，而不复用旧缓存", async () => {
    let releaseRead!: () => void;
    const pending = new Promise<void>(resolve => { releaseRead = resolve; });
    const reloads: boolean[] = [];
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(), pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "codex.status") return { connected: true, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_skills") {
          reloads.push((params as { forceReload: boolean }).forceReload);
          if (reloads.length === 2) await pending;
        }
        return { data: [] } as T;
      },
    });
    try {
      await view.refresh();
      const background = view.refresh();
      await new Promise(resolve => setTimeout(resolve, 0));
      root.querySelector<HTMLButtonElement>('[aria-label="刷新 Skills"]')!.click();
      releaseRead();
      await background;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(reloads).toEqual([true, false, true]);
    } finally { releaseRead(); view.dispose(); }
  });

  test("手动账号刷新期间暂停读取，Skills 刷新不会重建账号连接", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const sync = new Promise<void>(resolve => { release = resolve; });
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(), pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        calls.push(method);
        if (method === "codex.status") return { connected: true,
          features: { thread_state_v1: true, account_v1: true, account_sync_v1: true }, threads: [] } as T;
        if (method === "codex.account_read") return { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true } as T;
        if (method === "codex.account_sync") await sync;
        return { data: [] } as T;
      },
    });
    try {
      await view.refresh();
      root.querySelector<HTMLButtonElement>('[aria-label="刷新 Skills"]')!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).not.toContain("codex.account_sync");
      const refresh = root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!;
      refresh.click();
      refresh.click();
      await new Promise(resolve => setTimeout(resolve, 0));
      const lengthDuringSync = calls.length;
      const background = view.refresh();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls.length).toBe(lengthDuringSync);
      expect(calls.filter(method => method === "codex.account_sync")).toHaveLength(1);
      release();
      await background;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls.slice(lengthDuringSync)).toContain("codex.account_read");
    } finally { release(); view.dispose(); }
  });

  test("超长描述的 Skill 挂进 Action 层：detail 按码点截到 Host 200 字上限内，不再被整单拒收", async () => {
    const root = document.createElement("div");
    // 验收实测的回归：skill 描述来自用户环境（SKILL.md），长描述 + 固定前缀
    // 超过 Host `MAX_TEXT_LEN = 200` 后 `actionItems.mount` 整单被拒，
    // 弹 ACTION_ITEM_MOUNT_INVALID 红卡。截断要按码点（Rust 侧按 chars 计数）。
    const longDesc = "很".repeat(400);
    const mounts: Array<{ id: string; title: string; detail?: string; badge?: string }> = [];
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [{ name: "ask-project", description: longDesc, path: "/skills/ask-project/SKILL.md" }] }] } as T;
        return { data: [] } as T;
      },
      actionLayer: {
        list: async () => [],
        mount: async (item) => { mounts.push(item); },
        unmount: async () => {},
      },
    });
    await view.refresh();
    (root.querySelector('[data-action="toggle-skill-pin"][data-skill-name="ask-project"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mounts.length).toBe(1);
    const detail = mounts[0].detail ?? "";
    expect([...detail].length).toBeLessThanOrEqual(200);
    expect(detail.startsWith("用这个 skill 起一个快速对话 · 很")).toBeTrue();
    expect(detail.endsWith("…")).toBeTrue();
    // intent 里的完整名字/路径不受展示层截断影响，按下去仍能找到原 skill。
    view.dispose();
  });

  test("settings unmount invalidation refreshes Skill pin and unsubscribes on disposal", async () => {
    const root = document.createElement("div");
    let mounted = true;
    let changed = () => {};
    let stopped = false;
    const view = mountCodexView(root, {
      store: memoryStore(), pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [{ name: "test", path: "/skills/test/SKILL.md" }] }] } as T;
        return { data: [] } as T;
      },
      actionLayer: {
        list: async () => mounted ? [{ kind: "item", itemId: "skill:/work/a:test" }] : [],
        mount: async () => {}, unmount: async () => {},
        onChange: handler => { changed = handler; return () => { stopped = true; }; },
      },
    });
    await view.refresh();
    await new Promise(resolve => setTimeout(resolve, 0));
    const pin = () => root.querySelector('[data-action="toggle-skill-pin"]')!;
    expect(pin().getAttribute("aria-checked")).toBe("true");
    mounted = false;
    changed();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(pin().getAttribute("aria-checked")).toBe("false");
    view.dispose();
    expect(stopped).toBe(true);
  });

  test("compose 卡逐字对齐设计稿：标签、按钮、rows 与 placeholder", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    const card = root.querySelector<HTMLElement>(".cx-compose-card")!;
    expect(card.querySelector("h2")?.textContent).toBe("新建 Codex 任务");
    const labels = Array.from(card.querySelectorAll(".cx-field > :first-child"), (item) => item.textContent);
    expect(labels).toEqual(["在哪个目录", "模型", "推理强度", "要做什么"]);
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    expect(prompt.getAttribute("rows")).toBe("4");
    expect(prompt.placeholder).toBe("说一句就行，比如「把发布说明写完」");
    expect(root.querySelector('[data-action="submit-task"]')?.textContent).toBe("创建并打开");
    expect(card.querySelector("footer span")?.textContent).toContain("Enter 创建并打开");
    expect(card.querySelector("footer span")?.textContent).toContain("Esc 取消");
    // 设计稿把键名包在 <i> 里单独给了键帽底色，不是普通文字。
    expect(Array.from(card.querySelectorAll("footer span i"), (item) => item.textContent))
      .toEqual(["Enter", "Shift+Enter", "Esc"]);
    view.dispose();
  });

  test("目录改成带搜索的输入框：敲字才出候选，选完收起并换 placeholder", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    const list = root.querySelector<HTMLElement>('[data-slot="cwd-list"]')!;
    expect(search.placeholder).toBe("/work/ai-board");
    expect(list.childElementCount).toBe(0);

    search.focus();
    expect(search.placeholder).toBe("输入搜索");

    search.value = "firm";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const hits = list.querySelectorAll<HTMLButtonElement>('[data-action="pick-cwd"]');
    expect(Array.from(hits, (item) => item.dataset.cwd)).toEqual(["/work/firmware"]);

    hits[0]!.click();
    expect(list.childElementCount).toBe(0);
    expect(search.value).toBe("");
    expect(search.placeholder).toBe("/work/firmware");

    search.value = "不存在的目录";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    // 逐字照设计稿，且必须指向「选文件夹…」——搜不到时那颗按钮是唯一的出路。
    expect(list.querySelector(".dirpick-empty")?.textContent)
      .toBe("没有匹配的目录。用右边的「选文件夹…」挑一个新的。");
    expect(list.querySelectorAll('[data-action="pick-cwd"]')).toHaveLength(0);
    view.dispose();
    root.remove();
  });

  test("目录搜索框里的回车只选中第一条候选，不把任务发出去", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let startThreadCalls = 0;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") { startThreadCalls += 1; return { thread: { id: "t" } } as T; }
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "随便做点什么";
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    search.value = "firm";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Bun.sleep(10);
    expect(startThreadCalls).toBe(0);
    expect(search.placeholder).toBe("/work/firmware");
    view.dispose();
    root.remove();
  });

  test("焦点离开目录框就丢掉没落地的搜索词，屏幕上永远写着真正会用的目录", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let startedCwd: unknown;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") { startedCwd = (params as { cwd?: string }).cwd; return { thread: { id: "t" } } as T; }
        if (method === "codex.start_turn") return { turn: { id: "u" } } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    const list = root.querySelector<HTMLElement>('[data-slot="cwd-list"]')!;

    // 敲了「firm」但没点候选，就跑去写「要做什么」——框里留着字时 placeholder 不显示，
    // 屏幕上就没有任何地方写着「将在哪个目录跑」，而「开始」照样能点。
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    search.focus();
    search.value = "firm";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(list.querySelectorAll('[data-action="pick-cwd"]')).toHaveLength(1);
    prompt.focus();
    expect(search.value).toBe("");
    expect(list.childElementCount).toBe(0);
    expect(search.placeholder).toBe("/work/ai-board");

    prompt.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    expect(startedCwd).toBe("/work/ai-board");

    // 上面那条规矩不能把「点候选」踩坏：失焦在 mousedown 阶段就发生，
    // 列表要是先被拆掉，click 就没有落点了（autocomplete 的经典坑）。
    search.focus();
    search.value = "firm";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const item = list.querySelector<HTMLButtonElement>('[data-action="pick-cwd"]')!;
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    item.dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBeTrue();
    expect(document.activeElement).toBe(search);
    item.click();
    expect(search.placeholder).toBe("/work/firmware");
    view.dispose();
    root.remove();
  });

  test("键盘 Tab 到候选项时列表不许被拆掉——候选用 button 就是为了这条路走得通", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/ai-firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    const list = root.querySelector<HTMLElement>('[data-slot="cwd-list"]')!;
    search.focus();
    search.value = "ai-";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const second = list.querySelectorAll<HTMLButtonElement>('[data-action="pick-cwd"]')[1]!;

    // Tab 从输入框走到第 2 条候选：焦点还在这一格里，列表不能被清掉，
    // 否则浏览器要 focus 的那个元素已经不在文档里，焦点直接掉到 <body>。
    second.focus();
    expect(second.isConnected).toBeTrue();
    expect(document.activeElement).toBe(second);
    expect(list.querySelectorAll('[data-action="pick-cwd"]')).toHaveLength(2);
    second.click();
    expect(search.placeholder).toBe("/work/ai-firmware");
    view.dispose();
    root.remove();
  });

  test("重试首个回合时目录被锁住——它是既成事实，不是还能改的选项", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/甲", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/乙", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        if (method === "codex.start_turn") throw new Error("首轮炸了");
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    expect(search.disabled).toBeFalse();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);

    expect(root.querySelector('[data-action="submit-task"]')?.textContent).toBe("重试首个回合");
    expect(search.disabled).toBeTrue();
    // 重试进行中要说清楚「目录不会变」，否则用户会以为自己还能靠改目录救这次失败。
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    expect(root.querySelector('[data-slot="compose-progress"]')?.textContent).toContain("原目录");
    await Bun.sleep(10);

    // 关掉重开会清掉重试态，目录格也该跟着解锁。
    root.querySelector<HTMLButtonElement>('[data-action="close-compose"]')!.click();
    view.openCompose();
    expect(search.disabled).toBeFalse();
    view.dispose();
  });

  test("上次用过的目录不在候选集里也照样继承，不倒退成「没有可用目录」", async () => {
    const store = memoryStore();
    // 车道 A 的「选文件夹…」挑的就是候选集之外的目录；会话老化出榜后也是这个局面。
    await store.set("compose-defaults", { cwd: "/work/自己挑的" });
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") return { thread: { id: "t" } } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    await Bun.sleep(0);
    view.openCompose();
    expect(root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')?.placeholder).toBe("/work/自己挑的");
    expect(root.querySelector<HTMLElement>('[data-slot="cwd-empty"]')?.hidden).toBeTrue();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeFalse();
    view.dispose();
  });

  test("默认值写盘失败不影响任务创建，也不把已经建好的任务判成失败", async () => {
    const store = memoryStore();
    const realSet = store.set.bind(store);
    // 只让「表单默认值」这一条写不进去：会话状态写失败是另一回事，那时诚实报错才对。
    store.set = async (key: string, value: unknown) => {
      if (key === "compose-defaults") throw new Error("磁盘满了");
      await realSet(key, value);
    };
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [{ id: "a", cwd: "/work/a", name: "甲", recencyAt: NOW / 1_000 }] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        if (method === "codex.start_turn") return { turn: { id: "u" } } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(20);
    expect(root.querySelector('[data-slot="toast"]')?.textContent).toBe("任务已交给 Codex");
    expect((root.querySelector(".cx-compose") as HTMLElement).hidden).toBeTrue();
    view.dispose();
    root.remove();
  });

  test("用户挑过的目录，后台刷新一律不许改掉", async () => {
    const root = document.createElement("div");
    let threads = [
      { id: "a", cwd: "/work/甲", name: "甲", recencyAt: NOW / 1_000 },
      { id: "b", cwd: "/work/乙", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
    ];
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: threads } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    search.value = "乙";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="pick-cwd"]')!.click();
    expect(search.placeholder).toBe("/work/乙");

    // 新数据进来把「甲」顶成最近的一条，用户挑过的选择也不能被顶掉。
    threads = [{ id: "a", cwd: "/work/甲", name: "甲", recencyAt: (NOW + 60_000) / 1_000 }, ...threads.slice(1)];
    await view.refresh();
    expect(search.placeholder).toBe("/work/乙");
    view.dispose();
  });

  test("目录里的控制字符与双向覆盖符只在显示时被打回原形，发出去的值原样保留", async () => {
    const spoof = "/work/‮gnp.txt";
    const root = document.createElement("div");
    let startedCwd: unknown;
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [{ id: "a", cwd: spoof, name: "甲", recencyAt: NOW / 1_000 }] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") {
          startedCwd = (params as { cwd?: string }).cwd;
          return { thread: { id: "t" } } as T;
        }
        if (method === "codex.start_turn") return { turn: { id: "u" } } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    // 显示面：覆盖符被换成 U+FFFD，用户看得见「这条路径不对劲」。
    expect(search.placeholder).not.toContain("‮");
    expect(search.placeholder).toContain("�");
    search.value = "work";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector('[data-action="pick-cwd"] span')?.textContent).not.toContain("‮");

    // 传输面：发给 Codex 的还是真路径，不能被显示层改写。
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    expect(startedCwd).toBe(spoof);
    view.dispose();
  });

  test("搜索框空着时回车只是确认这一格并把焦点交给下一格，不盲发任务", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let startThreadCalls = 0;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") { startThreadCalls += 1; return { thread: { id: "t" } } as T; }
        if (method === "codex.start_turn") return { turn: { id: "u" } } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;

    // 组字中的回车（中文输入法确认候选词）绝不能变成「提交」——半句 prompt 就开跑任务。
    prompt.value = "把发布说";
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true } as KeyboardEventInit));
    await Bun.sleep(5);
    expect(startThreadCalls).toBe(0);

    // 组字中的 Esc 是「取消这次组字」，不能顺手把整张表单关掉。
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, isComposing: true } as KeyboardEventInit));
    expect((root.querySelector(".cx-compose") as HTMLElement).hidden).toBeFalse();

    // 目录框一聚焦，placeholder 就被「输入搜索」占着——此刻屏幕上没有任何地方写着
    // 「将在哪个目录跑」。所以空搜索词的回车只是确认这一格、把焦点交给「要做什么」，
    // 顺便让 placeholder 换回目录名，绝不能在用户看不见目标的那一刻把任务发出去。
    search.focus();
    expect(search.placeholder).toBe("输入搜索");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Bun.sleep(10);
    expect(startThreadCalls).toBe(0);
    expect(document.activeElement).toBe(prompt);
    expect(search.placeholder).toBe("/work/ai-board");

    // 焦点已经在「要做什么」上，这里的回车才是设计稿说的「Enter 开始」。
    prompt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Bun.sleep(10);
    expect(startThreadCalls).toBe(1);
    view.dispose();
    root.remove();
  });

  test("还没拿到第一份快照时不说「没有可用目录」", async () => {
    const root = document.createElement("div");
    let releaseStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          await statusGate;
          return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        }
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    const refreshPromise = view.refresh();
    view.openCompose();
    await Bun.sleep(5);
    // 连接还没回来，说「请先在 Codex 打开一次项目」是误报。
    expect(root.querySelector<HTMLElement>('[data-slot="cwd-empty"]')?.hidden).toBeTrue();
    releaseStatus?.();
    await refreshPromise;
    expect(root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')?.placeholder).toBe("/work/ai-board");
    view.dispose();
  });

  test("候选按最近用过排序，首次使用的默认目录就是最近那个", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "old", cwd: "/work/一年前", name: "老的", recencyAt: (NOW - 40 * 60 * 60 * 1_000) / 1_000 },
          { id: "new", cwd: "/work/刚刚在用", name: "新的", recencyAt: (NOW - 60_000) / 1_000 },
        ] } as T;
        // Skills 的目录没有时间戳，只能排在有时间戳的后面，不该抢默认位。
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/一年前", skills: [] }] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    expect(root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')?.placeholder).toBe("/work/刚刚在用");
    view.dispose();
  });

  test("创建中不许再改目录，且后台刷新不会把候选上的焦点打掉", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/ai-firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") return { thread: { id: "t" } } as T;
        if (method === "codex.start_turn") { await turnGate; return { turn: { id: "u" } } as T; }
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    search.value = "ai-";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const items = root.querySelectorAll<HTMLButtonElement>('[data-action="pick-cwd"]');
    expect(items).toHaveLength(2);

    // 内容没变的刷新不重建 DOM，否则会把停在候选按钮上的键盘焦点打到 <body>。
    items[1]!.focus();
    await view.refresh();
    expect(document.activeElement).toBe(items[1]!);

    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(0);
    // 创建中改目录只会让界面显示的目录与真正在跑的对不上。
    for (const item of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action="pick-cwd"]'))) {
      expect(item.disabled).toBeTrue();
    }
    releaseTurn?.();
    await Bun.sleep(10);
    view.dispose();
    root.remove();
  });

  test("换模型把推理强度带回新模型自己的默认，不沿用上一个模型的取值", async () => {
    const store = memoryStore();
    await store.set("compose-defaults", { model: "model-a", effort: "low" });
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true, threadCount: 0,
          features: { thread_state_v1: true, task_options_v1: true }, threads: [],
        } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        if (method === "codex.list_models") return { data: [
          { id: "model-a", displayName: "A", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
          { id: "model-b", displayName: "B", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
        ] } as T;
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    await Bun.sleep(0);
    const model = root.querySelector<HTMLSelectElement>('[data-field="model"]')!;
    const effort = root.querySelector<HTMLSelectElement>('[data-field="effort"]')!;
    expect(model.value).toBe("model-a");
    expect(effort.value).toBe("low");

    model.value = "model-b";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    // B 也支持 low，但用户换的是模型——强度必须回到 B 自己的默认，不能悄悄带过去。
    expect(effort.value).toBe("high");

    model.value = "model-a";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    expect(effort.value).toBe("medium");
    view.dispose();
  });

  test("重试首个回合不把没跑过的目录记成「上次用过的」", async () => {
    const store = memoryStore();
    const root = document.createElement("div");
    let turnCalls = 0;
    const view = mountCodexView(root, {
      store,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/甲", name: "甲", recencyAt: NOW / 1_000 },
          { id: "b", cwd: "/work/乙", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        if (method === "codex.start_turn") {
          turnCalls += 1;
          if (turnCalls === 1) throw new Error("首轮炸了");
          return { turn: { id: "u" } } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "开工";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    expect(root.querySelector('[data-action="submit-task"]')?.textContent).toBe("重试首个回合");

    // 用户以为是目录不对，改成乙再重试——可 thread 已经建在甲，窄口根本不收 cwd。
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    search.value = "乙";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-action="pick-cwd"]')!.click();
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    expect(turnCalls).toBe(2);
    // 关键：绝不能把一个从来没跑过的目录写成下次的默认值。
    expect(await store.get("compose-defaults")).toBeUndefined();
    view.dispose();
  });

  test("目录 / 模型 / 强度默认值继承上次成功创建的那一次", async () => {
    const store = memoryStore();
    const models = [
      { id: "gpt-5.6-sol", displayName: "GPT-5.6", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
      { id: "gpt-5.6-max", displayName: "GPT-5.6 Max", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    ];
    const call = async <T>(method: string): Promise<T> => {
      if (method === "codex.status") return {
        connected: true,
        threadCount: 0,
        features: { thread_state_v1: true, task_options_v1: true },
        threads: [],
      } as T;
      if (method === "codex.list_threads") return { data: [
        { id: "a", cwd: "/work/ai-board", name: "甲", recencyAt: NOW / 1_000 },
        { id: "b", cwd: "/work/firmware", name: "乙", recencyAt: (NOW - 1_000) / 1_000 },
      ] } as T;
      if (method === "codex.list_skills") return { data: [] } as T;
      if (method === "codex.list_models") return { data: models } as T;
      if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
      if (method === "codex.start_turn") return { turn: { id: "019ff15d-20e1-7123-a4b1-1807dcc44197" } } as T;
      throw new Error(`unexpected ${method}`);
    };

    const first = document.createElement("div");
    const firstView = mountCodexView(first, { store, pollIntervalMs: 0, call });
    await firstView.refresh();
    firstView.openCompose();
    await Bun.sleep(0);
    const search = first.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    search.value = "firm";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    first.querySelector<HTMLButtonElement>('[data-action="pick-cwd"]')!.click();
    const modelSelect = first.querySelector<HTMLSelectElement>('[data-field="model"]')!;
    modelSelect.value = "gpt-5.6-max";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    first.querySelector<HTMLSelectElement>('[data-field="effort"]')!.value = "high";
    first.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "把发布说明写完";
    first.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    firstView.dispose();

    // 重新挂载 = 下一次打开 App：三项都该回到上次用过的那一套。
    const second = document.createElement("div");
    const secondView = mountCodexView(second, { store, pollIntervalMs: 0, call });
    await secondView.refresh();
    secondView.openCompose();
    await Bun.sleep(0);
    expect(second.querySelector<HTMLInputElement>('[data-field="cwd-search"]')?.placeholder).toBe("/work/firmware");
    expect(second.querySelector<HTMLSelectElement>('[data-field="model"]')?.value).toBe("gpt-5.6-max");
    expect(second.querySelector<HTMLSelectElement>('[data-field="effort"]')?.value).toBe("high");
    secondView.dispose();
  });

  test("新任务惰性加载模型、pending 防重复并在成功后关闭", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const calls: Array<{ method: string; params: any }> = [];
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        calls.push({ method, params });
        if (method === "codex.status") return {
          connected: true,
          threadCount: 0,
          features: { thread_state_v1: true, task_options_v1: true, desktop_handoff_v1: true },
          desktopHandoffAvailable: true,
          threads: [],
        } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        if (method === "codex.list_models") return { data: [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "快" },
            { reasoningEffort: "medium", description: "均衡" },
          ],
        }] } as T;
        if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        if (method === "codex.start_turn") {
          await turnGate;
          return { turn: { id: "019ff15d-20e1-7123-a4b1-1807dcc44197" } } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });
    await view.refresh();
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!; // B6-27：页内新任务按钮撤除，焦点锚点换成常驻刷新钮
    trigger.focus();
    view.openCompose();
    await Bun.sleep(0);
    expect(calls.filter((item) => item.method === "codex.list_models")).toHaveLength(1);
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')?.value).toBe("gpt-5.6-sol");
    expect(root.querySelector<HTMLSelectElement>('[data-field="effort"]')?.value).toBe("medium");
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    prompt.value = "把任务做完并测试";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')!;
    expect(submit.disabled).toBeFalse();
    submit.click();
    submit.click();
    await Bun.sleep(0);
    expect(root.querySelector('[data-slot="compose-progress"]')?.textContent).toContain("正在创建新任务");
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeTrue();
    expect(calls.filter((item) => item.method === "codex.start_thread")).toHaveLength(1);
    releaseTurn?.();
    await Bun.sleep(10);
    expect((root.querySelector(".cx-compose") as HTMLElement).hidden).toBeTrue();
    expect(calls.find((item) => item.method === "codex.start_turn")?.params).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    expect(document.activeElement).toBe(trigger);
    view.dispose();
    root.remove();
  });

  test("没有 cwd 时显示恢复说明并禁用提交", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    // 候选为空时的出路已经不是「回去 Codex 开个项目」，而是右边那颗「选文件夹…」——
    // 那正是它存在的理由，空态文案必须指向它。
    expect(root.querySelector('[data-slot="cwd-empty"]')?.textContent).toContain("选文件夹…");
    expect(root.querySelector<HTMLButtonElement>('[data-action="pick-folder"]')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeTrue();
    view.dispose();
  });

  test("模型目录失败只显示一次重试且不影响任务看板", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true, task_options_v1: true },
          threads: [],
        } as T;
        if (method === "codex.list_threads") return {
          data: [{ id: "history", name: "已有任务", cwd: "/work/a", recencyAt: NOW / 1_000 }],
        } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.list_models") throw { code: "CODEX_LINK_TIMEOUT", userMessage: "请求超时" };
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    expect(root.textContent).toContain("已有任务");
    view.openCompose();
    await Bun.sleep(0);
    expect(root.querySelectorAll('[data-action="retry-models"]')).toHaveLength(1);
    expect(root.querySelector('[data-slot="model-status"]')?.textContent).toContain("模型列表不可用");
    expect(root.textContent).toContain("已有任务");
    view.dispose();
  });

  test("长等待后允许关闭视图但不取消 Host 创建请求", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let startTurnCalls = 0;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      pendingCloseDelayMs: 5,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        if (method === "codex.start_thread") return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        if (method === "codex.start_turn") {
          startTurnCalls += 1;
          await turnGate;
          return { turn: { id: "019ff15d-20e1-7123-a4b1-1807dcc44197" } } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!; // B6-27：页内新任务按钮撤除，焦点锚点换成常驻刷新钮
    trigger.focus();
    view.openCompose();
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    prompt.value = "慢任务";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    const close = root.querySelector<HTMLButtonElement>('[data-action="close-compose"]')!;
    expect(close.disabled).toBeTrue();
    await Bun.sleep(10);
    expect(close.disabled).toBeFalse();
    expect(root.querySelector('[data-slot="compose-progress"]')?.textContent).toContain("任务会继续");
    close.click();
    expect((root.querySelector(".cx-compose") as HTMLElement).hidden).toBeTrue();
    expect(trigger.disabled).toBeFalse();
    expect(document.activeElement).toBe(trigger);
    expect(startTurnCalls).toBe(1);
    releaseTurn?.();
    await Bun.sleep(10);
    expect(root.querySelector('[data-slot="toast"]')?.textContent).toContain("任务已交给 Codex");
    view.dispose();
    root.remove();
  });

  test("首 turn 结果不确定时禁用原表单重发并刷新任务", async () => {
    const root = document.createElement("div");
    let statusCalls = 0;
    let startThreadCalls = 0;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          statusCalls += 1;
          return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        }
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        if (method === "codex.start_thread") {
          startThreadCalls += 1;
          return { thread: { id: "019ff15d-20e1-7123-a4b1-1807dcc44196" } } as T;
        }
        if (method === "codex.start_turn") throw { code: "CODEX_LINK_TIMEOUT", userMessage: "请求超时" };
        throw new Error(`unexpected ${method}`);
      },
    });
    await view.refresh();
    view.openCompose();
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value = "可能已提交";
    root.querySelector<HTMLFormElement>('[data-form="compose"]')!.requestSubmit();
    await Bun.sleep(10);
    expect(root.querySelector('[data-slot="compose-progress"]')?.textContent).toContain("结果不确定");
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeTrue();
    expect(statusCalls).toBeGreaterThan(1);
    root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    }));
    await Bun.sleep(10);
    expect(startThreadCalls).toBe(1);
    view.dispose();
  });

  test("弹窗早于首个 Host 快照打开时会在连接后补载模型", async () => {
    const root = document.createElement("div");
    let releaseStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    let modelCalls = 0;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          await statusGate;
          return {
            connected: true,
            threadCount: 0,
            features: { thread_state_v1: true, task_options_v1: true },
            threads: [],
          } as T;
        }
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{ cwd: "/work/a", skills: [] }] } as T;
        if (method === "codex.list_models") {
          modelCalls += 1;
          return { data: [{
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "均衡" }],
          }] } as T;
        }
        throw new Error(`unexpected ${method}`);
      },
    });

    const refreshPromise = view.refresh();
    view.openCompose();
    await Bun.sleep(0);
    expect(modelCalls).toBe(0);
    releaseStatus?.();
    await refreshPromise;
    await Bun.sleep(0);
    expect(modelCalls).toBe(1);
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')?.value).toBe("gpt-5.6-sol");
    view.dispose();
  });

  test("交接按钮区分 active、其他 Host 托管 active、明确 unavailable 与旧 Host 未知", async () => {
    const render = async (features: Record<string, boolean>, handoff: boolean | undefined, threads: any[]) => {
      const root = document.createElement("div");
      const view = mountCodexView(root, {
        store: memoryStore(),
        pollIntervalMs: 0,
        call: async <T>(method: string): Promise<T> => {
          if (method === "codex.status") return { connected: true, threadCount: threads.length, features, desktopHandoffAvailable: handoff, threads } as T;
          if (method === "codex.list_threads") return { data: [{ id: "target", cwd: "/work", recencyAt: NOW / 1_000 }] } as T;
          if (method === "codex.list_skills") return { data: [] } as T;
          throw new Error(`unexpected ${method}`);
        },
      });
      await view.refresh();
      return { root, view, open: root.querySelector<HTMLButtonElement>('[data-action="open"][data-thread-id="target"]')! };
    };
    const active = await render({ thread_state_v1: true, desktop_handoff_v1: true }, true, [
      { threadId: "target", state: "thinking", lastEventMs: NOW, managedByDriver: true, pendingRequests: [] },
    ]);
    expect(active.open.disabled).toBeTrue();
    expect(active.open.textContent).toBe("完成后可打开");
    active.view.dispose();

    const unavailable = await render({ thread_state_v1: true, desktop_handoff_v1: true }, false, [
      { threadId: "target", state: "completed", lastEventMs: NOW, managedByDriver: true, pendingRequests: [] },
    ]);
    expect(unavailable.open.disabled).toBeTrue();
    expect(unavailable.open.textContent).toBe("当前连接无法交接");
    unavailable.view.dispose();

    const legacy = await render({ thread_state_v1: true }, undefined, [
      { threadId: "target", state: "completed", lastEventMs: NOW, managedByDriver: true, pendingRequests: [] },
    ]);
    expect(legacy.open.disabled).toBeFalse();
    expect(legacy.open.textContent).toBe("在 Codex 打开");
    legacy.view.dispose();
  });

  test("旧 Host 明确只读降级并隐藏全部写操作", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 1 } as T;
        if (method === "codex.list_threads") return { data: [{ id: "legacy", cwd: "/old", name: "旧会话", recencyAt: NOW / 1_000 }] } as T;
        if (method === "codex.list_active_threads") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    expect(root.textContent).toContain("当前 Driver 版本不支持这些操作");
    expect(Array.from(root.querySelectorAll<HTMLElement>("[data-write-action]")).every((item) => item.hidden)).toBeTrue();
    expect(root.textContent).toContain("旧会话");
    view.dispose();
  });

  test("窄屏 Skills 入口显示数量并通过可访问抽屉展开", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 0,
          features: { thread_state_v1: true },
          threads: [],
        } as T;
        if (method === "codex.list_threads") return { data: [] } as T;
        if (method === "codex.list_skills") return { data: [{
          cwd: "/work/a",
          skills: [
            { name: "test-first", path: "/skills/test-first/SKILL.md" },
            { name: "auto-dev", path: "/skills/auto-dev/SKILL.md" },
            { name: "disabled", path: "/skills/disabled/SKILL.md", enabled: false },
          ],
        }] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="open-skills-drawer"]')!;
    const drawer = root.querySelector<HTMLElement>("#cx-skills-drawer")!;
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toContain("2");
    expect(trigger.getAttribute("aria-controls")).toBe("cx-skills-drawer");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(drawer.hidden).toBeTrue();

    trigger.focus();
    trigger.click();
    expect(drawer.hidden).toBeFalse();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(drawer.querySelectorAll('[data-action="start-skill"]')).toHaveLength(2);

    drawer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawer.hidden).toBeTrue();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    view.dispose();
    root.remove();
  });

  test("响应式布局限制插件宽度并在更窄断点切换抽屉", async () => {
    const css = await Bun.file(new URL("../src/codex.css", import.meta.url)).text();
    expect(css).toContain("overflow-x: hidden");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("width: min(340px, calc(100% - 24px))");
    expect(css).toContain(".cx-skills-fab");
    expect(css).toContain(".cx-compose-grid");
    expect(css).toContain("@media (max-width: 520px)");
  });

  test("根框架只消费一次 Host 安全区，主列与侧栏不重复加顶距（A4-64）", async () => {
    const css = await Bun.file(new URL("../src/codex.css", import.meta.url)).text();
    expect(css).toMatch(/\.plugin-main-frame\s*\{[^}]*padding-top\s*:\s*var\(--reai-plugin-titlebar-safe-top,\s*44px\)/s);
    expect(css).not.toContain("--reai-plugin-safe-top");
    expect(css).not.toMatch(/\.cx-head\s*\{[^}]*margin-top/);
    expect(css).not.toMatch(/\.cx-side-head\s*\{[^}]*margin-top/);
    // 根安全区结束后保留正常内容留白；这 20px 不属于标题栏补偿。
    expect(css).toMatch(/\.cx-main\s*\{[^}]*padding\s*:\s*20px 24px 0/);
    expect(css).toMatch(/\.cx-side\s*\{[^}]*padding\s*:\s*20px 16px 16px/);
    expect(css).toMatch(/\.cx-main\s*\{[^}]*padding\s*:\s*20px 20px 50px/);
    // 根框架以外不得重新造 34/35px 裸顶距。
    expect(css).not.toMatch(/padding(?:-top)?\s*:\s*3[45]px\s/);
  });

  test("断开时显示结构化错误且不出现 object Object", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") throw {
          code: "CODEX_LINK_NOT_CONNECTED",
          userMessage: "插件尚未连接",
        };
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    expect(root.textContent).toContain("CODEX_LINK_NOT_CONNECTED · 插件尚未连接");
    expect(root.textContent).not.toContain("[object Object]");
    view.dispose();
  });

  test("实时事件按波次合并且刷新期间的新事件不会丢", async () => {
    const root = document.createElement("div");
    let statusCalls = 0;
    let releaseSecondStatus: (() => void) | undefined;
    const secondStatusGate = new Promise<void>((resolve) => { releaseSecondStatus = resolve; });
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          statusCalls += 1;
          if (statusCalls === 2) await secondStatusGate;
          return {
            connected: true,
            threadCount: 0,
            features: { thread_state_v1: true },
            threads: [],
          } as T;
        }
        if (method === "codex.list_threads" || method === "codex.list_skills") {
          return { data: [] } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    view.notifyRealtime();
    view.notifyRealtime();
    view.notifyRealtime();
    await Bun.sleep(120);
    expect(statusCalls).toBe(2);

    view.notifyRealtime();
    releaseSecondStatus?.();
    await Bun.sleep(30);
    expect(statusCalls).toBe(3);
    view.dispose();
  });

  test("任务详情一次只呈现一条待审批，按钮批的就是屏幕上那条", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    // 故意把「只能去 Codex 回答的问题」排在最前：它绝不能被当成按钮要批的那条。
    let pending: any[] = [
      { threadId: "wait", kind: "userInput", summary: "问你：0.2.0 还是 0.1.4？" },
      { serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" },
      { serverRequestId: 42, threadId: "wait", kind: "fileChangeApproval", summary: "写入 src/auth.rs" },
    ];
    const calls: Array<{ method: string; params: any }> = [];
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: any): Promise<T> => {
        calls.push({ method, params });
        if (method === "codex.status") return {
          connected: true,
          version: "codex-cli/0.147.0",
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "wait",
            state: "needsInput",
            lastEventMs: NOW - 60_000,
            managedByDriver: true,
            pendingRequests: pending,
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.respond_approval") {
          pending = pending.filter((item) => item.serverRequestId !== params.serverRequestId);
          return {} as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    expect(detail.hidden).toBeFalse();
    // 警示块说的必须就是页脚按钮要处理的那一条，不能是排在前面的那个问句。
    const ask = detail.querySelector(".cx-d-ask:not(.mut)") as HTMLElement;
    expect(ask.textContent).toBe("等待你审批：运行 cargo test");
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("拒绝批准");
    expect(detail.querySelector('[data-action="approve"]')?.getAttribute("data-request-id")).toBe("41");
    // 答不了的那条仍然要露出来，并说清该去哪儿处理。
    expect((detail.querySelector(".cx-d-ask.mut") as HTMLElement).textContent)
      .toBe("问你：0.2.0 还是 0.1.4？（这里不能填写，去 Codex 回答）");
    expect(detail.textContent).toContain("还有 1 条待审批");
    // 打开时焦点在卡片上，不能默认落在破坏性的「拒绝」上。
    // 比类名而不是比节点：断言失败时 bun 会尝试序列化两个 happy-dom 元素，
    // 输出上万行且跑不完，在 CI 上表现成 job 超时而不是一条可读的失败。
    expect((document.activeElement as HTMLElement).className).toBe("cx-d-card");

    (detail.querySelector('[data-action="approve"]') as HTMLButtonElement).click();
    await Bun.sleep(10);
    // 还剩一条，详情留着继续，页脚换成下一条的按钮。
    expect(detail.hidden).toBeFalse();
    expect(detail.querySelector('[data-action="approve"]')?.getAttribute("data-request-id")).toBe("42");
    expect((detail.querySelector(".cx-d-ask:not(.mut)") as HTMLElement).textContent)
      .toBe("等待你审批：写入 src/auth.rs");
    expect(detail.textContent).not.toContain("还有 1 条待审批");

    (detail.querySelector('[data-action="deny"]') as HTMLButtonElement).click();
    await Bun.sleep(10);
    expect(detail.hidden).toBeTrue();
    expect(calls.filter((item) => item.method === "codex.respond_approval")).toEqual([
      { method: "codex.respond_approval", params: { serverRequestId: 41, decision: "approved", reason: undefined } },
      { method: "codex.respond_approval", params: { serverRequestId: 42, decision: "denied", reason: undefined } },
    ]);
    view.dispose();
  });

  test("Host 快照还没追上时，已处理的审批不会被重复提交", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const calls: Array<{ method: string; params: any }> = [];
    // 关键：respond_approval 成功了，但 status 永远返回同一条待审批（模拟快照滞后）。
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: any): Promise<T> => {
        calls.push({ method, params });
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "wait",
            state: "needsInput",
            lastEventMs: NOW - 60_000,
            managedByDriver: true,
            pendingRequests: [
              { serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" },
            ],
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.respond_approval") return {} as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    const approve = detail.querySelector('[data-action="approve"]') as HTMLButtonElement;
    approve.click();
    // 第一下会重建卡片，手里那个引用已经脱离文档——必须重新查一次，
    // 否则「第二下点不动」证明的只是「离场的节点点不动」，删掉防抖照样绿。
    const live = detail.querySelector('[data-action="approve"]') as HTMLButtonElement;
    expect(live).not.toBe(approve);
    expect(live.disabled).toBeTrue();   // 提交中先靠 disabled 挡住
    live.disabled = false;              // 绕过 disabled，直击 respondApproval 自己的防抖
    live.click();
    await Bun.sleep(10);
    expect(calls.filter((item) => item.method === "codex.respond_approval").length).toBe(1);
    // 快照没变，但这条已经处理完了——详情要关掉，而不是留着诱人再点一次。
    expect(detail.hidden).toBeTrue();
    view.dispose();
  });

  test("历史会话刷新后仍保持选中，再点一次就能进详情", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        // 纯历史会话：不在 runtimeThreads 里。
        if (method === "codex.status") return {
          connected: true, threadCount: 1, features: { thread_state_v1: true }, threads: [],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "old", cwd: "/work/a", name: "历史会话", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="old"]') as HTMLButtonElement).click();
    await view.refresh();   // 轮询/窗口聚焦都会走到这里
    expect(root.querySelector('[data-action="select"][data-thread-id="old"]')?.getAttribute("aria-pressed"))
      .toBe("true");
    (root.querySelector('[data-action="select"][data-thread-id="old"]') as HTMLButtonElement).click();
    expect((root.querySelector(".cx-detail") as HTMLElement).hidden).toBeFalse();
    view.dispose();
  });

  test("只有本页答不了的等待项时，警示块只出现一次且是压低样式", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "ask",
            state: "needsInput",
            lastEventMs: NOW - 60_000,
            managedByDriver: true,
            pendingRequests: [{ threadId: "ask", kind: "userInput", summary: "问你：0.2.0 还是 0.1.4？" }],
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "ask", cwd: "/work/a", name: "等你回答", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="ask"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="ask"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    // 同一句话不能先以强调样式来一遍、再以压低样式来一遍。
    expect(detail.querySelectorAll(".cx-d-ask").length).toBe(1);
    expect(detail.querySelectorAll(".cx-d-ask.mut").length).toBe(1);
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("关闭");
    view.dispose();
  });

  test("刷新不打断详情里的焦点，Shift+Tab 也出不去这一层", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "wait",
            state: "needsInput",
            lastEventMs: NOW - 60_000,
            managedByDriver: true,
            pendingRequests: [
              { serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" },
            ],
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    const card = detail.querySelector(".cx-d-card") as HTMLElement;

    // 焦点停在卡片上时，Shift+Tab 必须被收回来——否则会顺着文档顺序走出模态层。
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    root.querySelector(".cx-page")!.dispatchEvent(back);
    expect(back.defaultPrevented).toBeTrue();

    const approve = detail.querySelector('[data-action="approve"]') as HTMLButtonElement;
    approve.focus();
    // 正向 Tab 从最后一颗按钮要绕回第一颗**按钮**——不能落到图标的 <use> 上，
    // 那东西不可聚焦，焦点会卡住不动、看起来像 Tab 键失灵。
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    root.querySelector(".cx-page")!.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBeTrue();
    expect((document.activeElement as HTMLElement).dataset.action).toBe("deny");

    approve.focus();
    await view.refresh();
    await view.refresh();
    // 内容没变就不该重建，焦点和按钮实例都要留在原地。
    // 比 dataset 不比节点：断言失败时序列化 happy-dom 元素会把 CI job 拖到超时。
    expect((document.activeElement as HTMLElement).dataset.action).toBe("approve");
    expect(document.activeElement === approve).toBeTrue();
    expect(approve.isConnected).toBeTrue();
    expect(card.isConnected).toBeTrue();
    view.dispose();
  });

  test("已处理的审批号被另一个会话复用时，不会连累那个会话", async () => {
    // app-server 的 request id 每次重启都从头递增，复用在所难免。
    // 这里让「已批过的 A:41」与「另一个会话的 B:41」同时存在（A 的快照滞后没撤），
    // 只记裸数字的实现会把 B 一起遮蔽掉，B 就变成「说着等你审批、却只有关闭按钮」。
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 2,
          features: { thread_state_v1: true },
          threads: [
            {
              threadId: "a", state: "needsInput", lastEventMs: NOW - 60_000, managedByDriver: true,
              pendingRequests: [{ serverRequestId: 41, threadId: "a", kind: "commandApproval", summary: "运行 cargo test" }],
            },
            {
              threadId: "b", state: "needsInput", lastEventMs: NOW - 30_000, managedByDriver: true,
              pendingRequests: [{ serverRequestId: 41, threadId: "b", kind: "commandApproval", summary: "删除 build/ 目录" }],
            },
          ],
        } as T;
        if (method === "codex.list_threads") return { data: [
          { id: "a", cwd: "/work/a", name: "会话 A", recencyAt: (NOW - 60_000) / 1_000 },
          { id: "b", cwd: "/work/b", name: "会话 B", recencyAt: (NOW - 30_000) / 1_000 },
        ] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.respond_approval") return {} as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    (root.querySelector('[data-action="select"][data-thread-id="a"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="a"]') as HTMLButtonElement).click();
    (detail.querySelector('[data-action="approve"]') as HTMLButtonElement).click();
    await Bun.sleep(10);

    // A 的快照没撤，但 A 这条已经处理过——A 里不该再出现按钮。
    (root.querySelector('[data-action="select"][data-thread-id="a"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="a"]') as HTMLButtonElement).click();
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("关闭");
    (detail.querySelector('[data-action="close-detail"]') as HTMLButtonElement).click();

    // B 的 41 是另一回事，必须照常可处理。
    (root.querySelector('[data-action="select"][data-thread-id="b"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="b"]') as HTMLButtonElement).click();
    expect((detail.querySelector(".cx-d-ask:not(.mut)") as HTMLElement).textContent)
      .toBe("等待你审批：删除 build/ 目录");
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("拒绝批准");
    view.dispose();
  });

  test("选中历史会话时上报的就是那一行，硬件审批键不会越过它去批别的", async () => {
    // 上报 undefined 会让 Host 落进「全局只有一条就批它」的分支——
    // 用户视线停在一条历史会话上，硬件键却去批另一个会话里他没看见的命令，正是本 PR 要消灭的失败。
    const root = document.createElement("div");
    document.body.append(root);
    const selections: Array<string | undefined> = [];
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      onSnapshot: (_snapshot, selected) => selections.push(selected),
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true, threadCount: 1, features: { thread_state_v1: true }, threads: [],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "old", cwd: "/work/a", name: "历史会话", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="old"]') as HTMLButtonElement).click();
    expect(selections.at(-1)).toBe("old");
    await view.refresh();
    expect(selections.at(-1)).toBe("old");
    view.dispose();
  });

  test("刷新不会把列表里的焦点丢掉，第二击照样能进详情", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true, threadCount: 1, features: { thread_state_v1: true }, threads: [],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "old", cwd: "/work/a", name: "历史会话", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="old"]') as HTMLButtonElement).click();
    await view.refresh();
    expect((document.activeElement as HTMLElement).dataset.action).toBe("select");
    expect((document.activeElement as HTMLElement).dataset.threadId).toBe("old");
    view.dispose();
  });

  test("按钮上的审批号被改过就拒绝提交，不拿 DOM 属性直接调 Host", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const calls: Array<{ method: string; params: any }> = [];
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string, params?: any): Promise<T> => {
        calls.push({ method, params });
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "wait", state: "needsInput", lastEventMs: NOW - 60_000, managedByDriver: true,
            pendingRequests: [{ serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" }],
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.respond_approval") return {} as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="wait"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    const approve = detail.querySelector('[data-action="approve"]') as HTMLButtonElement;
    approve.dataset.requestId = "77";   // 伪造成另一条（详情里从未展示过）
    approve.click();
    await Bun.sleep(10);
    expect(calls.filter((item) => item.method === "codex.respond_approval").length).toBe(0);
    expect(root.querySelector('[data-slot="toast"]')?.textContent).toBe("这条审批已经不在当前任务里了");
    // 被改过的 DOM 要被拉回真值，不能停在 77 上。
    expect(detail.querySelector('[data-action="approve"]')?.getAttribute("data-request-id")).toBe("41");
    view.dispose();
  });

  test("Codex 文本一律按纯文本渲染，标签不会变成节点", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "evil", state: "needsInput", lastEventMs: NOW - 60_000, managedByDriver: true,
            pendingRequests: [{
              serverRequestId: 41, threadId: "evil", kind: "commandApproval",
              summary: '<svg onload="alert(3)"></svg>',
            }],
          }],
        } as T;
        if (method === "codex.list_threads") return { data: [{
          id: "evil", cwd: "/work/a",
          name: '<img src=x onerror="alert(1)">',
          preview: "<script>alert(2)</script>",
          recencyAt: (NOW - 60_000) / 1_000,
        }] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="evil"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="evil"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    // 用布尔断言而不是 toBeNull()：一旦失败，序列化 happy-dom 节点会把输出撑到几万行、CI 直接超时。
    expect(detail.querySelector("img") === null).toBeTrue();
    expect(detail.querySelector("script") === null).toBeTrue();
    expect(detail.querySelector("[onerror]") === null).toBeTrue();
    expect(detail.querySelector("[onload]") === null).toBeTrue();
    // 卡片里只该有我们自己那颗警示图标，Codex 文本里的 <svg> 必须还是字面量。
    expect(detail.querySelectorAll("svg").length).toBe(1);
    expect((detail.querySelector(".cx-d-t") as HTMLElement).textContent).toBe('<img src=x onerror="alert(1)">');
    expect((detail.querySelector(".cx-d-ask") as HTMLElement).textContent)
      .toBe('等待你审批：<svg onload="alert(3)"></svg>');
    expect(detail.textContent).toContain("<script>alert(2)</script>");
    view.dispose();
  });

  test("只读降级时详情不给审批入口", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        // 没有 thread_state_v1 → 只读降级
        if (method === "codex.status") return { connected: true, threadCount: 1 } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "legacy", cwd: "/old", name: "旧会话", recencyAt: NOW / 1_000 }] } as T;
        }
        if (method === "codex.list_active_threads") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    (root.querySelector('[data-action="select"][data-thread-id="legacy"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="select"][data-thread-id="legacy"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    expect(detail.hidden).toBeFalse();
    expect(detail.querySelector('[data-action="approve"]') === null).toBeTrue();
    expect(detail.querySelector('[data-action="deny"]') === null).toBeTrue();
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("关闭");
    view.dispose();
  });

  test("没有待审批时详情只给「关闭」，Esc 可退出", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return {
          connected: true,
          threadCount: 1,
          features: { thread_state_v1: true },
          threads: [{
            threadId: "done",
            state: "completed",
            lastEventMs: NOW - 60_000,
            managedByDriver: true,
            pendingRequests: [],
          }],
        } as T;
        if (method === "codex.list_threads") {
          return { data: [{ id: "done", cwd: "/work/a", name: "干完未看", preview: "改了 6 个文件", recencyAt: (NOW - 60_000) / 1_000 }] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });

    await view.refresh();
    const entry = root.querySelector('[data-action="select"][data-thread-id="done"]') as HTMLButtonElement;
    entry.click();
    (root.querySelector('[data-action="select"][data-thread-id="done"]') as HTMLButtonElement).click();
    const detail = root.querySelector(".cx-detail") as HTMLElement;
    expect(detail.hidden).toBeFalse();
    expect(detail.textContent).toContain("/work/a");
    expect(detail.textContent).toContain("done");
    expect(detail.textContent).toContain("改了 6 个文件");
    expect(detail.querySelector('[data-action="approve"]') === null).toBeTrue();
    expect(detail.querySelector(".cx-d-ft")?.textContent).toBe("关闭");

    root.querySelector(".cx-page")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(detail.hidden).toBeTrue();
    view.dispose();
  });

  test("图标精灵图必须脱离布局流，否则会占掉一个网格格子", async () => {
    // 回归防护：sprite 曾经写成裸的 <svg width="0" height="0"> 放在 .cx-page 第一个子元素上。
    // 零尺寸不等于不占位——在两列 grid 里它照样占一格，把主内容挤进侧栏那条窄列、
    // 侧栏挤到第二行。测试环境不做真实布局计算，所以这里断言的是「脱离流」这个契约本身。
    const root = document.createElement("div");
    const view = mountCodexView(root, { store: memoryStore(), now: () => NOW, call: async () => ({ data: [] }) as never });

    const sprite = root.querySelector("svg.cx-sprite");
    expect(sprite).not.toBeNull();
    expect(sprite?.hasAttribute("width")).toBe(false);   // 别退回靠宽高为 0 撑
    expect(sprite?.hasAttribute("height")).toBe(false);

    const css = await Bun.file(new URL("../src/codex.css", import.meta.url)).text();
    const rule = css.match(/\.cx-sprite\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("position: absolute");

    // 页面内所有 <use> 都要能在自带 sprite 里找到对应 symbol
    const ids = new Set(Array.from(root.querySelectorAll("symbol"), (s) => s.id));
    for (const use of Array.from(root.querySelectorAll("use"))) {
      expect(ids.has((use.getAttribute("href") ?? "").slice(1))).toBe(true);
    }

    // 字符图标不得回潮
    expect(root.innerHTML).not.toMatch(/[×↻＋]/);
    view.dispose();
  });

  /** 一台连得上、但一个会话都没有的 Codex（= 第一次用的人看到的样子）。 */
  const emptyCall = async <T>(method: string): Promise<T> => {
    if (method === "codex.status") {
      return { connected: true, threadCount: 0, features: { thread_state_v1: true, task_options_v1: true }, threads: [] } as T;
    }
    if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
    if (method === "codex.list_models") return { data: [] } as T;
    throw new Error(`unexpected method: ${method}`);
  };

  test("选文件夹挑回来的目录进候选并当场选中，取消什么都不改", async () => {
    const root = document.createElement("div");
    let answer: string | undefined = "/Users/me/work/demo";
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: emptyCall,
      pickFolder: async () => answer,
    });
    await view.refresh();
    view.openCompose();

    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    // 一个会话都没有：候选为空，空态该指向这颗按钮——它是这种人唯一的出路。
    expect(search.placeholder).toBe("选一个目录");
    const empty = root.querySelector<HTMLElement>('[data-slot="cwd-empty"]')!;
    expect(empty.hidden).toBeFalse();
    expect(empty.textContent).toContain("选文件夹…");
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeTrue();

    (root.querySelector('[data-action="pick-folder"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    // 刚挑的目录还没有任何 Codex 会话，从快照里推不出来——不自己记住就等于白挑。
    // 选完写在 placeholder 上（不动它就用它），空态收起，可以提交了。
    expect(search.placeholder).toBe("~/work/demo");
    expect(empty.hidden).toBeTrue();
    expect(root.querySelector<HTMLButtonElement>('[data-action="submit-task"]')?.disabled).toBeFalse();

    // 用户按取消：这不是失败，界面一个字都不该变。
    answer = undefined;
    (root.querySelector('[data-action="pick-folder"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(search.placeholder).toBe("~/work/demo");
    view.dispose();
  });

  test("刷新不会把「选文件夹…」挑的目录冲掉", async () => {
    // 它不在快照的候选集里（没有会话），一刷新就没了的话，这颗按钮等于白点。
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: emptyCall,
      pickFolder: async () => "/Users/me/work/demo",
    });
    await view.refresh();
    view.openCompose();
    (root.querySelector('[data-action="pick-folder"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    await view.refresh();
    const search = root.querySelector<HTMLInputElement>('[data-field="cwd-search"]')!;
    expect(search.placeholder).toBe("~/work/demo");
    view.dispose();
  });

  test("拨杆档位预设把前缀铺进输入框并打开表单，光标落在末尾", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: emptyCall,
    });
    await view.refresh();

    view.applyComposePreset({ promptPrefix: "先出方案：" });
    const compose = root.querySelector<HTMLElement>(".cx-compose")!;
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    expect(compose.hidden).toBeFalse();
    // 前缀写进输入框而不是提交时偷偷拼上——用户看得见，不想要能当场删掉。
    expect(prompt.value).toBe("先出方案：");
    expect(prompt.selectionStart).toBe(prompt.value.length);

    // 同一档再按一次不该把前缀叠两遍。
    view.applyComposePreset({ promptPrefix: "先出方案：" });
    expect(prompt.value).toBe("先出方案：");

    // 已经敲了半句话时只补前缀，不吃掉用户刚写的内容。
    prompt.value = "把发布说明写完";
    view.applyComposePreset({ promptPrefix: "直接做完：" });
    expect(prompt.value).toBe("直接做完：把发布说明写完");

    // 换档位要把上一档的前缀摘掉再铺新的。拨杆本来就是随手换的，
    // 不摘就会得到两句互相矛盾的开场白叠在一起。
    view.applyComposePreset({ promptPrefix: "先出方案：" });
    expect(prompt.value).toBe("先出方案：把发布说明写完");

    // 用户自己动过开头就不碰——那是他写的字。
    prompt.value = "我自己写的开头";
    view.applyComposePreset({ promptPrefix: "直接做完：" });
    expect(prompt.value).toBe("直接做完：我自己写的开头");
    view.dispose();
  });

  test("第一份快照还没到就铺预设：先攒着，快照落地才铺", async () => {
    // 硬件键把插件从零拉起时就是这个时刻。当场铺的话：只读态判不出来（掀开一张点不动
    // 的表单）、模型目录也还没读（预设里的 model 既选不中也不报错）。
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.list_models") {
          return {
            data: [{
              id: "gpt-a",
              displayName: "gpt-a",
              isDefault: false,
              supportedReasoningEfforts: ["low"],
              defaultReasoningEffort: "low",
            }],
          } as T;
        }
        return emptyCall<T>(method);
      },
    });

    // 还没 refresh 过：没有快照。
    view.applyComposePreset({ promptPrefix: "先出方案：", model: "gpt-a" });
    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeTrue();
    expect(root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value).toBe("");

    await view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 快照落地后才铺，而且这一次模型目录已经读得到了。
    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeFalse();
    expect(root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value).toBe("先出方案：");
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')!.value).toBe("gpt-a");
    view.dispose();
  });

  test("刷新失败时攒着的预设要有出口：说清楚，而不是悄无声息", async () => {
    // 没有出口的话：用户按下硬件键 → Host 拉起插件 → 首次刷新失败（Codex 没起来）
    // → 表单不开、没提示、什么都没发生。对一颗「按一下就开始干活」的键，
    // 这是最坏的失败模式——他分不清是键没绑上、插件没装，还是 Codex 没连上。
    // 也不能继续攒着等轮询：20 秒轮一次，Codex 半小时后起来会让表单自己掀开。
    const root = document.createElement("div");
    let failing = true;
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (failing) throw new Error("app-server 连不上");
        return emptyCall<T>(method);
      },
    });
    view.applyComposePreset({ promptPrefix: "先出方案：" });
    await view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeTrue();
    const toast = root.querySelector<HTMLElement>('[data-slot="toast"]')!;
    expect(toast.hidden).toBeFalse();
    expect(toast.textContent).toContain("Codex 还没连上");

    // 攒着的那条已经丢掉：连上之后不该有一张自己掀开的表单。
    failing = false;
    await view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeTrue();
    expect(root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!.value).toBe("");
    view.dispose();
  });

  test("快照还没到就铺预设、而结果是只读态：不掀开表单", async () => {
    // 攒着的那条同样要过只读拦截，否则拦截只在「界面已经开着」的路径上生效。
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          return { connected: true, threadCount: 0, features: {}, threads: [] } as T;
        }
        if (method === "codex.list_active_threads") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        return emptyCall<T>(method);
      },
    });
    view.applyComposePreset({ promptPrefix: "先出方案：" });
    await view.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.getSnapshot()?.compatibility.readOnly).toBeTrue();
    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeTrue();
    view.dispose();
  });

  test("模型目录还在路上时铺的预设，等它到了会被应用", async () => {
    // 硬件键把插件从零拉起时就是这条路：表单已经开着，模型目录还在读。
    // 不接上 `.then(applyPresetToFields)` 的话，目录回来了也没人去应用预设——
    // 用户填的 model 静默失效，还不报错。
    const root = document.createElement("div");
    let releaseModels!: () => void;
    const modelsGate = new Promise<void>((resolve) => { releaseModels = resolve; });
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.list_models") {
          await modelsGate;
          return {
            data: [{
              id: "gpt-later",
              displayName: "gpt-later",
              isDefault: true,
              supportedReasoningEfforts: ["low"],
              defaultReasoningEffort: "low",
            }],
          } as T;
        }
        return emptyCall<T>(method);
      },
    });
    await view.refresh();

    view.applyComposePreset({ model: "gpt-later" });
    // 目录还没回来：既没选中，也不该报「当前没有这个模型」——还不知道服务端有什么。
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')!.value).toBe("");
    expect(root.querySelector<HTMLElement>('[data-slot="preset-note"]')?.hidden).toBeTrue();

    releaseModels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')!.value).toBe("gpt-later");
    view.dispose();
  });

  test("只读态下硬件键不掀开一张点不动的表单，而是说清楚为什么", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          // 没有 thread_state_v1 → repository 判定只读。
          return { connected: true, threadCount: 0, features: {}, threads: [] } as T;
        }
        // 只读路径会另外去问活动会话并排空事件。
        if (method === "codex.list_active_threads") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        return emptyCall<T>(method);
      },
    });
    await view.refresh();
    expect(view.getSnapshot()?.compatibility.readOnly).toBeTrue();

    view.applyComposePreset({ promptPrefix: "先出方案：" });
    // 表单的提交/选目录按钮在只读态是藏起来的，掀开它只会让用户盯着一张点不动的表。
    expect(root.querySelector<HTMLElement>(".cx-compose")?.hidden).toBeTrue();
    expect(root.querySelector<HTMLElement>('[data-slot="toast"]')?.hidden).toBeFalse();
    view.dispose();
  });

  test("关掉表单会卸掉档位预设，之后手动新建不再被套用", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: emptyCall,
      pickFolder: async () => "/Users/me/work/demo",
    });
    await view.refresh();

    view.applyComposePreset({ promptPrefix: "先出方案：", skillName: "planner" });
    const prompt = root.querySelector<HTMLTextAreaElement>('[data-field="prompt"]')!;
    expect(prompt.value).toBe("先出方案：");

    (root.querySelector('[data-action="close-compose"]') as HTMLButtonElement).click();
    view.openCompose();
    // 手动开的任务不该继承上一次拨杆那一档的东西——界面上没有任何地方说明它从哪来。
    expect(prompt.value).toBe("");
    expect(root.querySelector<HTMLElement>('[data-slot="preset-note"]')?.hidden).toBeTrue();
    view.dispose();
  });

  test("预设的模型服务端没有时照实说明，不静默换成别的档位", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.list_models") {
          return { data: [{ id: "gpt-real", displayName: "gpt-real", isDefault: true, supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }] } as T;
        }
        return emptyCall<T>(method);
      },
    });
    await view.refresh();
    view.applyComposePreset({ model: "gpt-不存在" });
    // 目录是异步读回来的，让它跑完。
    await new Promise((resolve) => setTimeout(resolve, 0));

    const note = root.querySelector<HTMLElement>('[data-slot="preset-note"]')!;
    expect(note.hidden).toBeFalse();
    expect(note.textContent).toContain("gpt-不存在");
    expect(note.textContent).toContain("已用默认模型");
    expect(root.querySelector<HTMLSelectElement>('[data-field="model"]')!.value).not.toBe("gpt-不存在");

    // 说明每次整条重写，不往后接。以前是追加到模型状态行后面，
    // 一次按键接两遍，再开一次表单又长一截。
    const once = note.textContent;
    view.applyComposePreset({ model: "gpt-不存在" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(note.textContent).toBe(once);
    view.dispose();
  });
});

// ── C-2（车道 B）：会话引用收口 + appendGroup 的 DOM 构造 ──────────────────

describe("Codex Link C-2 任务会话收口", () => {
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

  const threadsCall = async <T>(method: string): Promise<T> => {
    if (method === "codex.status") {
      return {
        connected: true,
        threadCount: 2,
        features: { thread_state_v1: true },
        threads: [
          { threadId: "wait", state: "needsInput", lastEventMs: NOW - 60_000, managedByDriver: true, pendingRequests: [{ serverRequestId: 41, threadId: "wait", kind: "commandApproval", summary: "运行 cargo test" }] },
          { threadId: "done", state: "completed", lastEventMs: NOW - 120_000, managedByDriver: true, pendingRequests: [] },
        ],
      } as T;
    }
    if (method === "codex.list_threads") {
      return { data: [
        { id: "wait", cwd: "/work/a", name: "等待审批", recencyAt: (NOW - 60_000) / 1_000 },
        { id: "done", cwd: "/work/a", name: "完成未看", recencyAt: (NOW - 120_000) / 1_000 },
      ] } as T;
    }
    if (method === "codex.list_skills") return { data: [] } as T;
    if (method === "codex.drain_events") return { events: [] } as T;
    throw new Error(`unexpected method: ${method}`);
  };

  test("分组标题是 DOM 构造出来的：文本 + 计数 b，innerHTML 这扇门焊死", async () => {
    const root = document.createElement("div");
    const view = mountCodexView(root, { store: memoryStore(), now: () => NOW, pollIntervalMs: 0, call: threadsCall });
    await view.refresh();

    const heading = root.querySelector<HTMLElement>(".cx-group.hot > h2")!;
    expect(heading).not.toBeNull();
    // 稿 .cx-grp 没有圆点：结构就是文本节点在前、b（计数）在后。
    expect(heading.querySelector("span")).toBeNull();
    const count = heading.querySelector("b")!;
    expect(count.textContent).toBe("1");
    expect(heading.textContent).toContain("在等你");
    // 标题节点是纯文本节点，不是被解析过的 HTML。
    const textNode = Array.from(heading.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("在等你"),
    );
    expect(textNode).toBeDefined();
    view.dispose();
  });

  test("打开任务详情即回报「那条会话被打开」（手动双击行同一条路）", async () => {
    const opened: string[] = [];
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: threadsCall,
      onConversationOpened: (threadId) => opened.push(threadId),
    });
    await view.refresh();

    // 第一次点选中，第二次点进详情——详情真的渲染出来才回报。列表是整块重渲的，
    // 第二次点要重新拿那颗按钮（旧按钮已离 DOM，事件委托收不到它）。
    root.querySelector<HTMLButtonElement>('[data-action="select"][data-thread-id="done"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="select"][data-thread-id="done"]')!.click();
    expect(opened).toEqual(["done"]);
    view.dispose();
  });

  test("Host 的任务会话 intent：快照里有就落到详情，没有就等下一份快照", async () => {
    const opened: string[] = [];
    const root = document.createElement("div");
    let seeDone = false;
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          return {
            connected: true,
            threadCount: seeDone ? 1 : 0,
            features: { thread_state_v1: true },
            threads: seeDone
              ? [{ threadId: "done", state: "completed", lastEventMs: NOW - 120_000, managedByDriver: true, pendingRequests: [] }]
              : [],
          } as T;
        }
        if (method === "codex.list_threads") {
          return { data: seeDone ? [{ id: "done", cwd: "/work/a", name: "完成未看", recencyAt: (NOW - 120_000) / 1_000 }] : [] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
      onConversationOpened: (threadId) => opened.push(threadId),
    });
    await view.refresh();

    // 冷启动：胶囊点开时快照还没带到这条会话——不回报、不凭空开详情。
    view.openConversation("done");
    expect(opened).toEqual([]);
    expect(root.querySelector<HTMLElement>('[data-slot="detail"]')!.hidden).toBeTrue();

    // 快照到了（会话真的在）才落到详情并回报。
    seeDone = true;
    await view.refresh();
    expect(opened).toEqual(["done"]);
    expect(root.querySelector<HTMLElement>('[data-slot="detail"]')!.hidden).toBeFalse();
    view.dispose();
  });

  test("Host 的任务会话 intent 指向已不存在的会话：过期丢弃，不回报不存在的「已看」", async () => {
    const opened: string[] = [];
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => NOW,
      pollIntervalMs: 0,
      call: threadsCall,
      onConversationOpened: (threadId) => opened.push(threadId),
    });
    await view.refresh();

    view.openConversation("ghost");
    expect(opened).toEqual([]);
    expect(root.querySelector<HTMLElement>('[data-slot="detail"]')!.hidden).toBeTrue();
    view.dispose();
  });
});

describe("Codex Link C-2 冷启动会话定位的 TTL", () => {
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

  test("攒着的会话定位过期后丢弃：会话晚到也不补开", async () => {
    const opened: string[] = [];
    let clock = NOW;
    let seeGhost = false;
    const root = document.createElement("div");
    const view = mountCodexView(root, {
      store: memoryStore(),
      now: () => clock,
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") {
          return {
            connected: true,
            threadCount: seeGhost ? 1 : 0,
            features: { thread_state_v1: true },
            threads: seeGhost
              ? [{ threadId: "ghost", state: "completed", lastEventMs: NOW - 120_000, managedByDriver: true, pendingRequests: [] }]
              : [],
          } as T;
        }
        if (method === "codex.list_threads") {
          return { data: seeGhost ? [{ id: "ghost", cwd: "/work/a", name: "迟到", recencyAt: (NOW - 120_000) / 1_000 }] : [] } as T;
        }
        if (method === "codex.list_skills") return { data: [] } as T;
        if (method === "codex.drain_events") return { events: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
      onConversationOpened: (threadId) => opened.push(threadId),
    });
    await view.refresh();

    view.openConversation("ghost");
    expect(opened).toEqual([]);
    // 过了 TTL 才来的快照：定位已过期，不再补开（过半小时凭空弹详情只会吓人）。
    clock = NOW + 60_000;
    seeGhost = true;
    await view.refresh();
    expect(opened).toEqual([]);
    expect(root.querySelector<HTMLElement>('[data-slot="detail"]')!.hidden).toBeTrue();
    view.dispose();
  });

describe("Codex r3-note「全局任务胶囊」教学卡（B6-50）", () => {
  test("文案逐字对稿、无条件渲染在列表尾部，无 mockup 演示按钮", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = mountCodexView(root, {
      store: memoryStore(),
      pollIntervalMs: 0,
      call: async <T>(method: string): Promise<T> => {
        if (method === "codex.status") return { connected: true, threadCount: 0, features: { thread_state_v1: true }, threads: [] } as T;
        if (method === "codex.list_threads" || method === "codex.list_skills") return { data: [] } as T;
        throw new Error(`unexpected method: ${method}`);
      },
    });
    await view.refresh();
    const scroll = root.querySelector<HTMLElement>('[data-slot="groups"]')!;
    const note = scroll.querySelector<HTMLElement>(".cx-r3-note");
    // 空列表态也在（.cx-empty 之后、列表区最后一个元素）。
    expect(note).not.toBeNull();
    expect(note?.textContent).toBe("交出去之后在哪儿看？不在这个窗口里。任务一转后台就交给桌面角落那枚胶囊：它不依赖 ReAI Board 在前台，多个任务是一张列表，每条背后都有一条能继续聊的会话。干完了投一条系统通知。");
    expect(note?.querySelector("b")?.textContent).toBe("交出去之后在哪儿看？");
    expect(scroll.lastElementChild).toBe(note);
    // 稿内「演示：任务完成的那一刻」是 mockup 控件，不进产品。
    expect(note?.querySelector("button")).toBeNull();
    expect(root.querySelector("[data-tcf]")).toBeNull();
    view.dispose();
    root.remove();
  });
});
});
