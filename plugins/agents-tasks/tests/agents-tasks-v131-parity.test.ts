import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* 与 ni-chat / todo / codex 套件并行执行时共用 happy-dom 全局注册：
   只在没人注册过时才注册，也只有注册方负责解注册（B6-16 测试基建）。 */
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

const pluginRoot = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(pluginRoot, path), "utf8");
const agentUiRoot = join(dirname(fileURLToPath(import.meta.resolve("@reai/agent-ui"))), "..");
const readAgentUi = (path: string) => readFileSync(join(agentUiRoot, path), "utf8");

async function mountTasks(options?: Parameters<typeof import("../src/tasks-view").mountTasksView>[1]) {
  const root = document.createElement("main");
  document.body.appendChild(root);
  const { mountTasksView } = await import("../src/tasks-view");
  const view = mountTasksView(root, options);
  return { root, view };
}

function click(root: HTMLElement, selector: string): void {
  const target = root.querySelector(selector);
  expect(target).not.toBeNull();
  (target as HTMLButtonElement).click();
}

describe("Agents · 任务 V1.3.1 静态 UI 合同", () => {
  test("根框架只消费一次 Host 安全区，左右页头不再各自叠加 44px", () => {
    const css = read("src/tasks.css");
    const view = read("src/tasks-view.ts");
    expect(view).toContain("plugin-main-frame");
    expect(view).toContain("main-body");
    expect(css).toMatch(/\.plugin-main-frame\{[^}]*padding-top:var\(--reai-plugin-titlebar-safe-top,44px\)/);
    expect(css).not.toContain("--reai-plugin-safe-top");
    expect(css).not.toMatch(/\.task-list-top\{[^}]*margin-top/);
    expect(css).not.toMatch(/\.task-conversation-header\{[^}]*margin-top/);
    expect(css).toMatch(/\.task-header-state\[hidden\]\{display:none!important\}/);
    expect(css).not.toContain("--content-top");
  });

  test("紧凑页头与 App 本地图标不扩散到共享 Agent UI", () => {
    const css = read("src/tasks.css");
    const view = read("src/tasks-view.ts");
    const icons = read("src/icons.ts");
    expect(css).toMatch(/\.task-list-actions\{[^}]*margin-left:auto[^}]*margin-top:3px/);
    expect(css).toMatch(/\.task-list-sort\{[^}]*(?:width:24px[^}]*height:24px|height:24px[^}]*width:24px)/);
    // B6-27：页内「+」撤除，入口只留 titlebar 栈。
    expect(css).not.toContain("task-list-add");
    expect(view).not.toContain("task-list-add");
    expect(view).toContain('from "./icons"');
    for (const name of ["sort-desc", "more-vertical", "x", "check", "alert-circle"]) {
      expect(icons).toContain(`"${name}"`);
    }
    expect(view).not.toMatch(/\b(fetch|localStorage|sessionStorage|indexedDB)\b/);
    expect(view).not.toContain("@tauri-apps");
    expect(view).not.toContain("invoke(");
  });
});

describe("Agents · 任务 V1.3.1 UI-only 行为", () => {
  test("标题、排序与加项目处于同一页头，详情图标不污染纯标题节点", async () => {
    const { root, view } = await mountTasks();
    const actions = root.querySelector(".task-list-actions");
    expect(actions?.querySelector(".task-list-sort")).not.toBeNull();
    // B6-27：页内新增按钮撤除（titlebar 栈保入口）。
    expect(actions?.querySelector(".task-list-add")).toBeNull();
    expect(root.querySelector(".task-list-tools .task-list-sort")).toBeNull();

    click(root, '[data-task-title="修复 Windows 拨杆注入"]');
    const title = root.querySelector(".task-conversation-title");
    expect(title?.textContent).toBe("修复 Windows 拨杆注入");
    expect(title?.previousElementSibling?.classList.contains("task-conversation-title-icon")).toBeTrue();
    const meta = root.querySelector(".task-conversation-meta")?.textContent ?? "";
    expect(meta.indexOf("~/Developer/ai-vibe-board")).toBeLessThan(meta.indexOf("Claude Code"));
    view.dispose();
  });

  test("排序、项目菜单和临时层互斥，Esc 与蒙版都能关闭", async () => {
    const { root, view } = await mountTasks();
    click(root, ".task-list-sort");
    const sortMenu = root.querySelector('.task-menu[data-menu-kind="sort"].is-open');
    expect(sortMenu).not.toBeNull();
    expect(sortMenu?.getAttribute("role")).toBe("menu");
    expect(sortMenu?.querySelector('[role="menuitemradio"][aria-checked="true"]')).not.toBeNull();
    expect(sortMenu?.textContent).toContain("按最后活跃排");

    click(root, '[data-project-dir="~/Developer/ai-vibe-board"] .task-project-menu-button');
    expect(root.querySelector('.task-menu[data-menu-kind="sort"].is-open')).toBeNull();
    expect(root.querySelector('.task-menu[data-menu-kind="project"].is-open')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".task-menu.is-open")).toBeNull();

    // B6-27：加项目走 titlebar intent 同款入口（view.applyIntent）。
    const sort = root.querySelector(".task-list-sort") as HTMLButtonElement;
    sort.focus();
    view.applyIntent({ type: "add-project" });
    const folderPicker = root.querySelector(".task-folder-picker.is-open");
    expect(folderPicker).not.toBeNull();
    expect(folderPicker?.getAttribute("aria-labelledby")).toBe("tasks-folder-dialog-title");
    expect(document.activeElement?.classList.contains("task-folder-choice")).toBeTrue();
    expect(root.querySelector(".task-list-pane")?.hasAttribute("inert")).toBeTrue();
    click(root, ".task-layer-scrim");
    expect(root.querySelector(".task-folder-picker.is-open")).toBeNull();
    expect(document.activeElement).toBe(sort);
    expect(root.querySelector(".task-list-pane")?.hasAttribute("inert")).toBeFalse();
    view.dispose();
  });

  test("搜索重绘会关闭锚点菜单，Finder 不可用原因保持可感知", async () => {
    const { root, view } = await mountTasks();
    click(root, '[data-project-dir="~/Developer/ai-vibe-board"] .task-project-menu-button');
    const reveal = root.querySelector(".task-menu-item.is-disabled");
    expect(reveal?.getAttribute("aria-disabled")).toBe("true");
    expect(reveal?.getAttribute("aria-describedby")).toBe("tasks-finder-disabled-note");
    expect((reveal as HTMLButtonElement).disabled).toBeFalse();
    expect(root.querySelector(".task-menu-note")?.textContent).toContain("Finder 需要 Host 文件系统能力");

    const input = root.querySelector(".agent-search-input") as HTMLInputElement;
    input.value = "landing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector(".task-menu.is-open")).toBeNull();
    view.dispose();
  });

  test("加项目产生 mount 级空项目，移走当前项目后详情回空态且搜索不会复活", async () => {
    const { root, view } = await mountTasks();
    const before = root.querySelectorAll("[data-project-dir]").length;
    view.applyIntent({ type: "add-project" });
    const choice = root.querySelector('[data-folder-choice="~/Developer/voice-app"]');
    expect(choice).not.toBeNull();
    (choice as HTMLButtonElement).click();
    expect(root.querySelectorAll("[data-project-dir]")).toHaveLength(before + 1);
    expect(root.querySelector('[data-project-dir="~/Developer/voice-app"]')?.textContent).toContain("还没有任务");

    click(root, '[data-task-title="官网价格表改版审查"]');
    click(root, '[data-project-dir="~/Developer/landing"] .task-project-menu-button');
    click(root, '[data-project-action="remove"]');
    expect(root.querySelector(".task-conversation-empty")).not.toBeNull();
    expect(root.querySelector('[data-project-dir="~/Developer/landing"]')).toBeNull();

    // V1.7.0（B6-16）：搜索不筛项目——项目已从列表移走才不复活，其余项目原位保留。
    const input = root.querySelector(".agent-search-input") as HTMLInputElement;
    input.value = "landing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector('[data-project-dir="~/Developer/landing"]')).toBeNull();
    root.querySelectorAll("[data-project-dir]").forEach((project) => {
      expect(project.querySelector(".task-project-empty")?.textContent).toBe("这个项目里没有匹配的任务");
    });
    view.dispose();
  });

  test("V1.7.0（B6-16）搜索只筛任务不筛项目：空项目留原位、命中强制展开、计数按全量", async () => {
    const { root, view } = await mountTasks();
    const totalProjects = root.querySelectorAll("[data-project-dir]").length;
    expect(totalProjects).toBeGreaterThan(1);

    // 先人为折叠有命中的项目（~/Developer/landing，查询词命中它的目录）。
    const landingHeader = root.querySelector('[data-project-dir="~/Developer/landing"] .task-project-header') as HTMLButtonElement;
    landingHeader.click();
    expect(root.querySelector('[data-project-dir="~/Developer/landing"]')?.classList.contains("is-folded")).toBeTrue();

    const input = root.querySelector(".agent-search-input") as HTMLInputElement;
    input.value = "landing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 项目一个都没少：无命中的项目留在原位，空态文案按稿分档。
    expect(root.querySelectorAll("[data-project-dir]")).toHaveLength(totalProjects);
    const landing = root.querySelector('[data-project-dir="~/Developer/landing"]');
    expect(landing?.querySelectorAll(".task-list-item").length).toBeGreaterThan(0);
    expect(landing?.classList.contains("is-folded")).toBeFalse();
    const emptyOthers = Array.from(root.querySelectorAll("[data-project-dir]")).filter(
      (project) => project.querySelectorAll(".task-list-item").length === 0,
    );
    expect(emptyOthers.length).toBeGreaterThan(0);
    emptyOthers.forEach((project) => {
      expect(project.classList.contains("is-folded")).toBeFalse();
      expect(project.querySelector(".task-project-empty")?.textContent).toBe("这个项目里没有匹配的任务");
    });
    // 项目头计数按全量任务算：零命中的项目头计数仍是它的全量数，不是 0。
    emptyOthers.forEach((project) => {
      expect(Number(project.querySelector(".task-project-count")?.textContent)).toBeGreaterThan(0);
    });
    // 全局命中数 > 0 时没有全局兜底行
    expect(Array.from(root.querySelectorAll(".task-list-empty")).filter((node) => node.textContent === "没有匹配的任务。")).toHaveLength(0);

    // 清空搜索：回到用户原折叠态（collapsedDirectories 没被搜索改写）。
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector('[data-project-dir="~/Developer/landing"]')?.classList.contains("is-folded")).toBeTrue();

    // 全局兜底：查询谁都不命中时尾部追加「没有匹配的任务。」，项目仍在。
    input.value = "不存在的查询词";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelectorAll("[data-project-dir]")).toHaveLength(totalProjects);
    const fallback = Array.from(root.querySelectorAll(".task-list-empty")).map((node) => node.textContent);
    expect(fallback).toContain("没有匹配的任务。");
    view.dispose();
  });

  test("运行态兼容节点保持隐藏，document 监听在幂等 dispose 中全部解注册", async () => {
    const added = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const removed = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const originalAdd = document.addEventListener.bind(document);
    const originalRemove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "click" || type === "keydown") {
        const listeners = added.get(type) ?? new Set();
        listeners.add(listener);
        added.set(type, listeners);
      }
      originalAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "click" || type === "keydown") {
        const listeners = removed.get(type) ?? new Set();
        listeners.add(listener);
        removed.set(type, listeners);
      }
      originalRemove(type, listener, options);
    }) as typeof document.removeEventListener;

    try {
      const { root, view } = await mountTasks();
      click(root, '[data-task-title="写这版发布说明"]');
      const compatibilityState = root.querySelector(".task-header-state") as HTMLElement;
      expect(compatibilityState.hidden).toBeTrue();
      expect(compatibilityState.getAttribute("aria-hidden")).toBe("true");
      expect(added.get("click")?.size).toBeGreaterThan(0);
      expect(added.get("keydown")?.size).toBeGreaterThan(0);

      view.dispose();
      view.dispose();
      for (const type of ["click", "keydown"]) {
        for (const listener of added.get(type) ?? []) {
          expect(removed.get(type)?.has(listener)).toBeTrue();
        }
      }
      expect(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }).not.toThrow();
    } finally {
      document.addEventListener = originalAdd as typeof document.addEventListener;
      document.removeEventListener = originalRemove as typeof document.removeEventListener;
    }
  });
});

describe("中栏拖宽手柄（A4-22，对照稿 tmResize/makeResizer）", () => {
  const readCss = (path: string) => read(path);

  beforeEach(() => {
    localStorage.removeItem("agents-tasks.paneWidth");
  });

  async function mountPane() {
    const root = document.createElement("main");
    document.body.appendChild(root);
    const { mountTasksView } = await import("../src/tasks-view");
    const view = mountTasksView(root);
    const pane = root.querySelector(".task-list-pane") as HTMLElement;
    const handle = pane.querySelector(".rs-handle") as HTMLElement;
    return { root, view, pane, handle };
  }

  function dragTo(handle: HTMLElement, fromX: number, toX: number, pointerId = 5): void {
    handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId, clientX: fromX, bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: toX, bubbles: true }));
  }

  function endDrag(pointerId = 5): void {
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId, bubbles: true }));
  }

  test("形态逐字对稿（agent-ui 共享表）：8px 热区、2px 强调线、720 窄档撤柄、pane 变量驱动", () => {
    const css = readAgentUi("src/agent-ui.css");
    expect(css).toMatch(/\.agent-ui \.rs-handle\{position:absolute;top:0;bottom:0;right:-3px;width:8px;cursor:col-resize;z-index:60;touch-action:none;user-select:none;-webkit-user-select:none\}/);
    expect(css).toMatch(/\.agent-ui \.rs-handle::after\{content:'';position:absolute;top:0;bottom:0;left:2px;width:2px;background:var\(--accent,#5f55e6\);opacity:0;transition:opacity \.15s\}/);
    expect(css).toMatch(/\.agent-ui \.rs-handle:hover::after,\.agent-ui \.rs-handle\.dragging::after\{opacity:\.85\}/);
    expect(css).toMatch(/body\.rs-dragging\{cursor:col-resize;user-select:none;-webkit-user-select:none\}/);
    // 720 是本表把 --agent-pane 钉成 226px 的窄档：宽度概念从这里失效，手柄撤掉
    expect(css).toMatch(/@media\(max-width:720px\)\{\.agent-ui\{--agent-pane:226px\}\.agent-ui \.rs-handle\{display:none\}/);
    // tasks 侧：记忆宽优先，默认回 --agent-pane（264，对稿 TM_DEF）；position:relative 是手柄锚点
    const tasksCss = readCss("src/tasks.css");
    expect(tasksCss).toMatch(/\.task-list-pane\{width:var\(--pane-w,var\(--agent-pane\)\)/);
    expect(tasksCss).toMatch(/\.task-list-pane\{[^}]*position:relative/);
  });

  test("手柄是中栏最后一个子元素，title 逐字、separator 语义带刻度（min 260 对稿 TM_MIN）", async () => {
    const { pane, handle, view } = await mountPane();
    expect(pane.lastElementChild).toBe(handle);
    expect(handle.title).toBe("拖动调整宽度 · 双击复位");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("aria-label")).toBe("任务列表栏宽");
    expect(handle.getAttribute("aria-valuemin")).toBe("260");
    expect(handle.getAttribute("aria-valuemax")).toBe("540"); // 稿 PANE_MAX
    // 启动即把显示宽画出去（稿 applyUI 总写），默认 264 = --agent-pane = 稿 TM_DEF
    expect(pane.style.getPropertyValue("--pane-w")).toBe("264px");
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBeNull(); // 启动不写盘
    view.dispose();
  });

  test("拖拽改宽：delta 改栏宽、途中锁光标不落盘、松手才落盘", async () => {
    const { pane, handle, view } = await mountPane();
    dragTo(handle, 300, 420);
    expect(pane.style.getPropertyValue("--pane-w")).toBe("384px"); // 264 + 120
    expect(handle.classList.contains("dragging")).toBeTrue();
    expect(document.body.classList.contains("rs-dragging")).toBeTrue();
    expect(handle.getAttribute("aria-valuenow")).toBe("384");
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBeNull();
    endDrag();
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBe("384");
    expect(document.body.classList.contains("rs-dragging")).toBeFalse();
    view.dispose();
  });

  test("钳制边界：上界 540（稿 PANE_MAX 扣 CENTER_MIN 后仍 540）、下界 260（稿 TM_MIN）", async () => {
    const { pane, handle, view } = await mountPane();
    dragTo(handle, 300, 1500);
    expect(pane.style.getPropertyValue("--pane-w")).toBe("540px");
    endDrag();
    dragTo(handle, 300, -400);
    expect(pane.style.getPropertyValue("--pane-w")).toBe("260px");
    endDrag();
    view.dispose();
  });

  test("双击复位到默认宽 264（稿 TM_DEF = --agent-pane 默认）并落盘", async () => {
    const { pane, handle, view } = await mountPane();
    dragTo(handle, 300, 400);
    endDrag();
    expect(pane.style.getPropertyValue("--pane-w")).toBe("364px");
    handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(pane.style.getPropertyValue("--pane-w")).toBe("264px");
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBe("264");
    view.dispose();
  });

  test("宽度记忆持久化：重新挂载从 localStorage 恢复；720 窄档以下记忆让位、手柄短路", async () => {
    localStorage.setItem("agents-tasks.paneWidth", "400");
    const width = window.innerWidth;
    try {
      const { pane, view } = await mountPane();
      expect(pane.style.getPropertyValue("--pane-w")).toBe("400px");
      view.dispose();
      localStorage.removeItem("agents-tasks.paneWidth");

      // 窄档：记忆宽不落变量（宽度交还 --agent-pane:226px），按下不进入拖拽
      localStorage.setItem("agents-tasks.paneWidth", "400");
      (window as { innerWidth: number }).innerWidth = 700;
      const narrow = await mountPane();
      expect(narrow.pane.style.getPropertyValue("--pane-w")).toBe("");
      narrow.handle.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 5, clientX: 300, bubbles: true, cancelable: true }));
      expect(narrow.handle.classList.contains("dragging")).toBeFalse();
      endDrag();
      expect(localStorage.getItem("agents-tasks.paneWidth")).toBe("400"); // 未被窄档覆盖
      narrow.view.dispose();
    } finally {
      (window as { innerWidth: number }).innerWidth = width;
    }
  });

  /* 模拟「releasePointerCapture 同步派发 lostpointercapture」的 WebView：
     monkeypatch release 使其内联再派发一次 lost——stop 的重入路径由此真实
     走到（happy-dom 自己不派发）。配 Storage.setItem 计数，落盘次数可断言：
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
    const { handle, view } = await mountPane();
    dragTo(handle, 300, 420);
    handle.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 5, bubbles: true }));
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBe("384");
    expect(document.body.classList.contains("rs-dragging")).toBeFalse();
    localStorage.removeItem("agents-tasks.paneWidth");
    dragTo(handle, 300, 460); // 起点是上一轮留存的意愿 384：384+160=544 → 钳到 540
    patchSyncLost(handle);
    const counted = countSetItem(() => endDrag());
    expect(counted.writes).toBe(1); // 旧排序（release 先于 pid 复位）下这里是 2
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBe("540");
    view.dispose();
  });

  test("拖拽中 dispose（release 同步派发 lost）：一次盘都不落——卸载不是用户意图", async () => {
    const { handle, view } = await mountPane();
    dragTo(handle, 300, 420);
    patchSyncLost(handle);
    const counted = countSetItem(() => view.dispose());
    expect(counted.writes).toBe(0);
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBeNull();
  });

  test("拖拽中 dispose：body 光标锁与监听一并摘掉，卸载不落盘", async () => {
    const { handle, view } = await mountPane();
    dragTo(handle, 300, 420);
    expect(document.body.classList.contains("rs-dragging")).toBeTrue();
    view.dispose();
    expect(document.body.classList.contains("rs-dragging")).toBeFalse();
    expect(handle.isConnected).toBeFalse();
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 5, clientX: 900, bubbles: true }));
    endDrag();
    expect(localStorage.getItem("agents-tasks.paneWidth")).toBeNull();
  });

  test("静态合同不回归：宽度记忆住在共享包模块，tasks-view 本身仍是 UI-only", () => {
    const view = read("src/tasks-view.ts");
    expect(view).not.toMatch(/\b(fetch|localStorage|sessionStorage|indexedDB)\b/);
    expect(view).toContain("mountPaneResizer"); // 手柄来自 @reai/agent-ui 的 pane-resizer
    const resizer = readAgentUi("src/pane-resizer.ts");
    expect(resizer).toContain('"--pane-w"');
  });
});

describe("任务详情坞「在 IM 里看上下文」（B6-26）", () => {
  async function mountWithAgentsIm(available: boolean) {
    const opened: Array<{ agentId?: string; agentName: string }> = [];
    const { root, view } = await mountTasks({
      agentsIm: { available, open: (task) => opened.push({ agentId: task.agentId, agentName: task.agentName }) },
    });
    return { root, view, opened };
  }

  test("IM 可用才渲染 ctx-btn：点击带任务的 agent 身份走注入的去路", async () => {
    const { root, view, opened } = await mountWithAgentsIm(true);
    click(root, '[data-task-title="写这版发布说明"]');
    const btn = root.querySelector(".task-ctx-btn") as HTMLButtonElement;
    expect(btn?.textContent).toBe("在 IM 里看上下文");
    btn.click();
    expect(opened).toHaveLength(1);
    expect(opened[0]!.agentName).toBe("Claude Code");
    view.dispose();
  });

  test("IM 缺席时不渲染（不画假门）；setAgentsIm 可中途开关", async () => {
    const { root, view } = await mountWithAgentsIm(false);
    click(root, '[data-task-title="写这版发布说明"]');
    expect(root.querySelector(".task-ctx-btn")).toBeNull();
    view.setAgentsIm({
      available: true,
      open: () => {},
    });
    expect(root.querySelector(".task-ctx-btn")?.textContent).toBe("在 IM 里看上下文");
    view.setAgentsIm(undefined);
    expect(root.querySelector(".task-ctx-btn")).toBeNull();
    view.dispose();
  });

});
