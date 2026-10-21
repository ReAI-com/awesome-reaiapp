import {
  appendSafeMarkup,
  button,
  conversationSliceForTask,
  createDemoAgentState,
  createSearchInput,
  deriveTasks,
  element,
  findPendingPrompt,
  formatDuration,
  icon,
  mountAgentComposer,
  mountConversationStream,
  mountPaneResizer,
  type AgentOrGroup,
  type AgentTask,
  type StreamAnchor,
  type StreamAsk,
} from "@reai/agent-ui";
import { tasksIcon } from "./icons";

export interface TasksView {
  dispose(): void;
  /** B6-26：任务详情坞「在 IM 里看上下文」反向入口的可用性与去路（app 层注入）。 */
  setAgentsIm(next: { available: boolean; open: (task: AgentTask) => void } | undefined): void;
  /** titlebar / 测试共用的 intent 入口（B6-27：{ type: "add-project" }）。 */
  applyIntent(intent: { type: string }): void;
}

/** B6-26 任务详情坞反向入口的形状（app 层用 ctx.apps 门控后注入）。 */
export interface TasksAgentsImBridge {
  available: boolean;
  open: (task: AgentTask) => void;
}

type SortMode = "recent" | "name";
type OverlayState =
  | { kind: "sort"; anchor: HTMLElement }
  | { kind: "project"; anchor: HTMLElement; directory: string }
  | { kind: "folder" }
  | { kind: "new"; directory: string }
  | null;

const FOLDER_CANDIDATES = [
  "~/Developer/ai-vibe-board",
  "~/Developer/landing",
  "~/Developer/voice-app",
  "~/Developer/firmware",
];

const directoryName = (directory: string) => directory.split("/").pop() || directory;
const plainText = (value: string) => value.replace(/<[^>]+>/g, "");

function tbcTag(id: string, title: string): HTMLElement {
  const tag = element("span", "tbc-option-tag");
  tag.dataset.tbcId = id;
  tag.textContent = "TBC";
  tag.title = title;
  tag.setAttribute("aria-label", `TBC：${title}`);
  return tag;
}

export function mountTasksView(root: HTMLElement, options: { agents?: AgentOrGroup[]; agentsIm?: TasksAgentsImBridge } = {}): TasksView {
  const agents = options.agents ?? createDemoAgentState();
  let agentsIm = options.agentsIm;
  let tasks = deriveTasks(agents);
  let selectedAnchor: StreamAnchor | undefined;
  let query = "";
  let sortMode: SortMode = "recent";
  let overlay: OverlayState = null;
  let overlayReturnFocus: HTMLElement | null = null;
  let disposed = false;
  let composerDispose = () => {};
  const collapsedDirectories = new Set<string>();
  const projectDirectories = [...new Set(tasks.map((task) => task.anchor.dir).filter((directory): directory is string => Boolean(directory)))];

  const frame = element("section", "plugin-main-frame");
  const app = element("section", "main-body agent-ui agents-tasks-app");
  frame.appendChild(app);
  const listPane = element("aside", "task-list-pane");
  const top = element("div", "task-list-top");
  const heading = element("div", "task-list-heading");
  const title = element("h2", "task-list-title");
  title.textContent = "任务";
  title.appendChild(tbcTag("tbc.agents-tasks-data", "任务列表与详情当前来自 demo Agent state"));
  const actions = element("div", "task-list-actions");
  const sort = button("task-list-sort", "", "任务排序");
  sort.appendChild(tasksIcon("sort-desc", 14));
  /* B6-27（用户 2026-08-20 裁定，覆盖稿 4424-4431 侧栏页头画法）：页内「+」撤除，
     入口只留 titlebar 栈（manifest titlebarActions：add-project，经 app 层
     tasksIntentFrom 解包进 view.applyIntent——同一条路，测试也走它）。 */
  actions.append(sort);
  heading.append(title, actions);
  const tools = element("div", "task-list-tools");
  const search = createSearchInput({
    placeholder: "搜索任务…",
    onInput: (value) => {
      if (overlay?.kind === "sort" || overlay?.kind === "project") closeOverlay(false);
      query = value;
      renderList();
    },
  });
  tools.appendChild(search.element);
  top.append(heading, tools);
  const list = element("div", "task-list-scroll");
  listPane.append(top, list);
  const conversation = element("main", "agent-conversation-pane task-conversation-pane");
  const scrim = element("div", "task-layer-scrim");
  scrim.setAttribute("aria-hidden", "true");
  const overlayHost = element("div", "task-overlay-host");
  app.append(listPane, conversation, scrim, overlayHost);
  root.replaceChildren(frame);
  /* 中栏拖宽手柄（A4-22，对照稿 tmResize：min 260 = 任务卡第二行不换行且完整，
     def 264 = --agent-pane 默认，恰与稿 TM_DEF 一致）。本文件保持 UI-only
     （不碰存储，静态合同那条护栏的对象就是它），宽度记忆住在共享包模块里。 */
  const paneResizer = mountPaneResizer(listPane, app, {
    storageKey: "agents-tasks.paneWidth",
    def: 264,
    min: 260,
    ariaLabel: "任务列表栏宽",
  });

  function taskMatches(task: AgentTask): boolean {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return true;
    return [task.title, task.agentName, task.anchor.dir ?? ""].join(" ").toLocaleLowerCase().includes(needle);
  }

  function tasksForDirectory(directory: string, matchFilter = true): AgentTask[] {
    const entries = tasks.filter((task) => task.anchor.dir === directory && (!matchFilter || taskMatches(task)));
    return [...entries].sort((left, right) => {
      const running = Number(right.anchor.st === "run") - Number(left.anchor.st === "run");
      if (running) return running;
      return sortMode === "name" ? left.title.localeCompare(right.title, "zh-CN") : 0;
    });
  }

  function visibleDirectories(): string[] {
    /* B6-16（稿 10135-10137）：搜索只筛任务、不筛项目——搜不到东西的项目
       仍然留在原位，只是空着。把整个项目从列表里抽走，人会以为项目丢了，
       那比多看一行「没有匹配的任务」糟得多。 */
    const directories = [...projectDirectories];
    return sortMode === "name"
      ? directories.sort((left, right) => directoryName(left).localeCompare(directoryName(right), "zh-CN"))
      : directories;
  }

  function taskItem(task: AgentTask): HTMLElement {
    const item = button(`task-list-item${task.anchor === selectedAnchor ? " is-active" : ""}${task.anchor.st === "done" ? " is-done" : ""}`, "");
    item.dataset.taskTitle = task.title;
    const row = element("span", "task-list-item-title-row");
    const taskIcon = element("span", "task-list-item-icon");
    taskIcon.textContent = task.anchor.icon;
    const name = element("strong", "task-list-item-title");
    name.textContent = task.title;
    row.append(taskIcon, name);
    if (task.anchor.st === "run") {
      const elapsed = element("span", "task-list-elapsed");
      elapsed.textContent = `· ${formatDuration(task.anchor.since ?? 0)}`;
      row.appendChild(elapsed);
    }
    const meta = element("small", "task-list-item-meta");
    const metaText = element("span", "task-list-item-meta-text");
    metaText.append(document.createTextNode(`${task.agentName} · `));
    appendSafeMarkup(metaText, task.anchor.meta);
    meta.appendChild(metaText);
    if (findPendingPrompt(conversationSliceForTask(task))) {
      const waiting = element("span", "task-list-waiting");
      waiting.append(tasksIcon("alert-circle", 10), document.createTextNode("等你确认"));
      meta.appendChild(waiting);
    }
    item.append(row, meta);
    item.addEventListener("click", () => {
      selectedAnchor = task.anchor;
      closeOverlay(false);
      renderList();
      renderConversation();
    });
    return item;
  }

  function projectSection(directory: string): HTMLElement {
    const entries = tasksForDirectory(directory);
    const allTasks = tasksForDirectory(directory, false);
    const searching = query.trim().length > 0;
    /* B6-16（稿 10139-10143）：搜索命中时强制展开——折叠状态是人为了腾地方设的，
       不是「不想看见这些」。搜出来的东西藏在折叠里，人看到的就是「搜不到」。
       清空搜索后仍按原折叠状态来：这里只在渲染时无视 collapsedDirectories，
       不去改它。 */
    const foldedByUser = collapsedDirectories.has(directory);
    const isFolded = foldedByUser && !(searching && entries.length > 0);
    const project = element("section", `task-project${isFolded ? " is-folded" : ""}`);
    project.dataset.projectDir = directory;
    const headerRow = element("div", "task-project-header-row");
    const toggle = button("task-project-header", "", `${isFolded ? "展开" : "收起"}${directoryName(directory)}`);
    toggle.appendChild(icon("chevron", 13));
    toggle.appendChild(icon("folder", 14));
    const projectName = element("strong", "task-project-name");
    projectName.textContent = directoryName(directory);
    const count = element("em", "task-project-count");
    /* 头计数按全量任务算（稿 tmGroups 渲染 items.length）：搜索只是视图，
       不能让「这个项目有几件事」跟着查询串变。 */
    count.textContent = String(allTasks.length);
    toggle.append(projectName, count);
    const menu = button("task-project-menu-button", "", `${directoryName(directory)}项目操作`);
    menu.appendChild(tasksIcon("more-vertical", 14));
    toggle.addEventListener("click", () => {
      collapsedDirectories.has(directory) ? collapsedDirectories.delete(directory) : collapsedDirectories.add(directory);
      closeOverlay(false);
      renderList();
    });
    menu.addEventListener("click", (event) => {
      event.stopPropagation();
      if (overlay?.kind === "project" && overlay.directory === directory) closeOverlay();
      else openOverlay({ kind: "project", anchor: menu, directory });
    });
    headerRow.append(toggle, menu);

    const body = element("div", "task-project-body");
    if (entries.length) entries.forEach((task) => body.appendChild(taskItem(task)));
    else {
      const empty = element("div", "task-project-empty");
      /* B6-16（稿 10151）：空态分两档——搜索时说「这个项目里没有匹配的任务」，
         真没任务时才说「还没有任务 · 按 New 键在这里开一件」。 */
      empty.textContent = searching ? "这个项目里没有匹配的任务" : "还没有任务 · 按 New 键在这里开一件";
      body.appendChild(empty);
    }
    const folded = element("div", "task-project-fold-summary");
    /* 折叠摘要也按全量任务算（稿 fold 行用 items/done 全量口径）。 */
    const running = allTasks.filter((task) => task.anchor.st === "run").length;
    folded.textContent = `${allTasks.length} 件${running ? ` · ${running} 件进行中` : ""}`;
    project.append(headerRow, folded, body);
    return project;
  }

  function renderList(): void {
    list.replaceChildren();
    const directories = visibleDirectories();
    if (!directories.length) {
      const empty = element("div", "task-list-empty");
      empty.textContent = query.trim() ? "没有匹配的任务。" : "还没有项目。点右上角的 + 把一个文件夹加进来。";
      list.appendChild(empty);
      return;
    }
    directories.forEach((directory) => list.appendChild(projectSection(directory)));
    /* B6-16（稿 10152）：全局兜底——有查询且一个任务都没命中时，在列表尾部
       追加一行「没有匹配的任务。」（项目都还在，各自空着）。 */
    if (query.trim() && tasks.every((task) => !taskMatches(task))) {
      const none = element("div", "task-list-empty");
      none.textContent = "没有匹配的任务。";
      list.appendChild(none);
    }
  }

  function selected(): AgentTask | undefined {
    return tasks.find((task) => task.anchor === selectedAnchor && task.anchor.dir && projectDirectories.includes(task.anchor.dir));
  }

  function answerPrompt(prompt: StreamAsk, answer: string): void {
    prompt.answered = answer;
    renderConversation();
    renderList();
  }

  function detailMeta(task: AgentTask): HTMLElement {
    const meta = element("div", "task-conversation-meta");
    const values = [task.anchor.dir ?? "", task.agentName];
    values.forEach((value, index) => {
      const span = element("span");
      span.textContent = value;
      meta.appendChild(span);
      if (index < values.length - 1) meta.append(document.createTextNode("·"));
    });
    meta.append(document.createTextNode("·"));
    if (task.anchor.st === "run") {
      const running = element("span", "task-detail-running");
      const dot = element("i");
      running.append(dot, document.createTextNode(`已运行 ${formatDuration(task.anchor.since ?? 0)}`));
      meta.appendChild(running);
    } else {
      const finished = element("span");
      finished.textContent = plainText(task.anchor.meta);
      meta.appendChild(finished);
    }
    return meta;
  }

  function renderConversation(): void {
    composerDispose();
    composerDispose = () => {};
    conversation.replaceChildren();
    const task = selected();
    if (!task) {
      const empty = element("div", "task-conversation-empty");
      const emptyIcon = element("span", "task-conversation-empty-icon");
      emptyIcon.appendChild(icon("tasks", 26));
      const emptyText = element("div");
      emptyText.append(
        document.createTextNode("选一件事，看它的来龙去脉。"),
        document.createElement("br"),
        document.createTextNode("这里显示的就是那段对话本身——跟 Agents · IM 是同一批消息，"),
        document.createElement("br"),
        document.createTextNode("只是按目录切开了。"),
      );
      empty.append(emptyIcon, emptyText);
      conversation.appendChild(empty);
      return;
    }
    const agent = agents.find((candidate) => candidate.id === task.agentId);
    if (!agent) return;
    const header = element("header", "task-conversation-header");
    const heading = element("div", "task-conversation-heading");
    const titleRow = element("div", "task-conversation-title-row");
    const titleIcon = element("span", "task-conversation-title-icon");
    titleIcon.textContent = task.anchor.icon;
    const title = element("h1", "task-conversation-title");
    title.textContent = task.title;
    titleRow.append(titleIcon, title);
    heading.append(titleRow, detailMeta(task));
    // B6-26（稿 10429）：反向入口「在 IM 里看上下文」——IM 缺席时不渲染，
    // 不画假门（可用性由 app 层用 ctx.apps.status 门控注入）。
    if (agentsIm?.available) {
      const ctxBtn = button("task-ctx-btn", "在 IM 里看上下文", "在 IM 里看上下文");
      ctxBtn.dataset.tm = "im";
      ctxBtn.addEventListener("click", () => agentsIm?.open(task));
      heading.appendChild(ctxBtn);
    }
    // 并行分支仍断言旧状态节点；视觉已按 V1.3.1 并入元信息，合并后删除此兼容节点。
    const compatibilityState = element("span", "task-header-state");
    compatibilityState.hidden = true;
    compatibilityState.setAttribute("aria-hidden", "true");
    compatibilityState.textContent = task.anchor.st === "run" ? "进行中" : "已完成";
    header.append(heading, compatibilityState);
    conversation.appendChild(header);
    const items = conversationSliceForTask(task);
    const stream = mountConversationStream(conversation, { agent, items });
    const pending = findPendingPrompt(items);
    const composer = mountAgentComposer(conversation, {
      placeholder: `在「${task.title}」中继续…`,
      pendingPrompt: pending,
      scrollContainer: stream.element,
      onPromptAnswer: pending ? (answer) => answerPrompt(pending, answer) : undefined,
      onSend: (text) => {
        const anchorIndex = task.conversation.indexOf(task.anchor);
        const insertAt = task.anchor.st === "done" ? anchorIndex : anchorIndex + 1;
        task.conversation.splice(insertAt, 0, { k: "msg", me: 1, text, ts: "刚刚" });
        tasks = deriveTasks(agents);
        renderList();
        renderConversation();
      },
    });
    composerDispose = composer.dispose;
    stream.scrollToLatest();
  }

  function menuPosition(menu: HTMLElement, anchor: HTMLElement, alignRight = false): void {
    const appRect = app.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width || 176;
    const menuHeight = menuRect.height;
    const idealLeft = alignRight ? anchorRect.right - appRect.left - menuWidth : anchorRect.left - appRect.left;
    menu.style.left = `${Math.max(8, Math.min(idealLeft, appRect.width - menuWidth - 8))}px`;
    const below = anchorRect.bottom - appRect.top + 4;
    const above = anchorRect.top - appRect.top - menuHeight - 4;
    const idealTop = menuHeight > 0 && below + menuHeight > appRect.height - 8 ? above : below;
    menu.style.top = `${Math.max(48, Math.min(idealTop, appRect.height - menuHeight - 8))}px`;
  }

  function menuItem(label: string, iconName: "plus" | "folder" | "check" | "x", className = ""): HTMLButtonElement {
    const item = button(`task-menu-item${className ? ` ${className}` : ""}`, label);
    item.setAttribute("role", "menuitem");
    item.textContent = "";
    item.append(iconName === "plus" || iconName === "folder" ? icon(iconName, 13) : tasksIcon(iconName, 13), document.createTextNode(label));
    return item;
  }

  function renderSortMenu(): HTMLElement {
    const menu = element("div", "task-menu is-open");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "任务排序");
    menu.dataset.menuKind = "sort";
    ([
      ["recent", "按最后活跃排"],
      ["name", "按名称排"],
    ] as Array<[SortMode, string]>).forEach(([mode, label]) => {
      const item = button("task-menu-item", label);
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(mode === sortMode));
      const marker = element("span", "task-menu-check");
      if (mode === sortMode) marker.appendChild(tasksIcon("check", 13));
      item.prepend(marker);
      item.dataset.sortMode = mode;
      item.addEventListener("click", () => {
        sortMode = mode;
        closeOverlay();
        renderList();
      });
      menu.appendChild(item);
    });
    return menu;
  }

  function renderProjectMenu(state: Extract<OverlayState, { kind: "project" }>): HTMLElement {
    const menu = element("div", "task-menu is-open");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `${directoryName(state.directory)}项目操作`);
    menu.dataset.menuKind = "project";
    const create = menuItem("在这里开一件事", "plus");
    create.appendChild(tbcTag("tbc.agents-tasks-create", "真实新建任务需要 Host 项目能力"));
    create.dataset.projectAction = "new";
    create.addEventListener("click", () => openOverlay({ kind: "new", directory: state.directory }));
    const reveal = menuItem("在 Finder 里显示", "folder", "is-disabled");
    reveal.setAttribute("aria-disabled", "true");
    reveal.setAttribute("aria-describedby", "tasks-finder-disabled-note");
    const remove = menuItem("从列表里移走", "x", "is-danger");
    remove.dataset.projectAction = "remove";
    remove.addEventListener("click", () => {
      const selectedDirectory = tasks.find((task) => task.anchor === selectedAnchor)?.anchor.dir;
      const index = projectDirectories.indexOf(state.directory);
      if (index >= 0) projectDirectories.splice(index, 1);
      collapsedDirectories.delete(state.directory);
      if (selectedDirectory === state.directory) selectedAnchor = undefined;
      closeOverlay();
      renderList();
      renderConversation();
    });
    const note = element("div", "task-menu-note");
    note.id = "tasks-finder-disabled-note";
    note.textContent = "Finder 需要 Host 文件系统能力；移走只改当前列表，不动磁盘文件。";
    menu.append(create, reveal, remove, note);
    return menu;
  }

  function panelHeader(titleText: string, titleId: string): HTMLElement {
    const header = element("div", "task-layer-header");
    const title = element("h3", "task-layer-title");
    title.id = titleId;
    title.textContent = titleText;
    const close = button("task-layer-close", "", "关闭");
    close.appendChild(tasksIcon("x", 15));
    close.addEventListener("click", () => closeOverlay());
    header.append(title, close);
    return header;
  }

  function renderFolderPicker(): HTMLElement {
    const panel = element("section", "task-layer-panel task-folder-picker is-open");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "tasks-folder-dialog-title");
    panel.appendChild(panelHeader("把文件夹加成项目", "tasks-folder-dialog-title"));
    const help = element("p", "task-layer-help");
    help.textContent = "选择一个本地项目；本示例只保留到这次打开期间。";
    const choices = element("div", "task-folder-choices");
    FOLDER_CANDIDATES.forEach((directory) => {
      const choice = button("task-folder-choice", "", directory);
      choice.dataset.folderChoice = directory;
      choice.append(icon("folder", 14), document.createTextNode(directory));
      if (projectDirectories.includes(directory)) {
        choice.disabled = true;
        const state = element("span", "task-folder-choice-state");
        state.textContent = "已经是项目";
        choice.appendChild(state);
      } else {
        choice.addEventListener("click", () => {
          projectDirectories.push(directory);
          closeOverlay();
          renderList();
        });
      }
      choices.appendChild(choice);
    });
    panel.append(help, choices);
    return panel;
  }

  function renderNewTaskPanel(directory: string): HTMLElement {
    const panel = element("section", "task-layer-panel task-new-panel is-open");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "tasks-new-dialog-title");
    const header = panelHeader("在这里开一件事", "tasks-new-dialog-title");
    header.appendChild(tbcTag("tbc.agents-tasks-create", "真实新建任务需要 Host 项目能力"));
    panel.appendChild(header);
    const directoryLabel = element("div", "task-new-directory");
    directoryLabel.append(icon("folder", 14), document.createTextNode(directory));
    const label = element("label", "task-new-label");
    label.textContent = "任务标题";
    const input = element("input", "task-new-input");
    input.placeholder = "说清楚要做什么…";
    input.disabled = true;
    label.appendChild(input);
    const note = element("p", "task-layer-help");
    note.textContent = "真实新建任务需要 Host 项目能力，本 UI 预览不提交数据。";
    const submit = button("task-new-submit", "开始任务");
    submit.disabled = true;
    submit.dataset.newTaskSubmit = "";
    panel.append(directoryLabel, label, note, submit);
    return panel;
  }

  function renderOverlay(): void {
    overlayHost.replaceChildren();
    const modalOpen = overlay?.kind === "folder" || overlay?.kind === "new";
    scrim.classList.toggle("is-open", modalOpen);
    listPane.toggleAttribute("inert", modalOpen);
    conversation.toggleAttribute("inert", modalOpen);
    sort.classList.toggle("is-active", overlay?.kind === "sort");
    if (!overlay) return;
    if (overlay.kind === "sort") {
      const menu = renderSortMenu();
      overlayHost.appendChild(menu);
      menuPosition(menu, overlay.anchor, true);
    } else if (overlay.kind === "project") {
      const menu = renderProjectMenu(overlay);
      overlayHost.appendChild(menu);
      menuPosition(menu, overlay.anchor);
    } else if (overlay.kind === "folder") overlayHost.appendChild(renderFolderPicker());
    else overlayHost.appendChild(renderNewTaskPanel(overlay.directory));
  }

  function openOverlay(next: NonNullable<OverlayState>): void {
    const preserveReturnFocus = overlay?.kind === "project" && next.kind === "new";
    if (!preserveReturnFocus) {
      const active = document.activeElement;
      overlayReturnFocus = active instanceof HTMLElement && app.contains(active) ? active : null;
    }
    overlay = next;
    renderOverlay();
    if (next.kind === "folder" || next.kind === "new") {
      const focusTarget = next.kind === "folder"
        ? overlayHost.querySelector<HTMLElement>(".task-folder-choice:not(:disabled)")
          ?? overlayHost.querySelector<HTMLElement>(".task-layer-close")
        : overlayHost.querySelector<HTMLElement>(".task-layer-close");
      focusTarget?.focus();
    }
  }

  function closeOverlay(restoreFocus = true): void {
    const returnFocus = overlayReturnFocus;
    overlay = null;
    overlayReturnFocus = null;
    renderOverlay();
    if (!restoreFocus) return;
    if (returnFocus?.isConnected) returnFocus.focus();
    /* titlebar 入口打开时插件内没有前置焦点（焦点在独立 titlebar WebView）：
       兜到页头排序钮，别让键盘/读屏用户掉到 <body> 上。 */
    else sort.focus();
  }

  function onDocumentClick(event: Event): void {
    if (!overlay || overlay.kind === "folder" || overlay.kind === "new") return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".task-menu,.task-list-sort,.task-project-menu-button")) return;
    closeOverlay(false);
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && overlay) closeOverlay();
  }

  sort.addEventListener("click", (event) => {
    event.stopPropagation();
    overlay?.kind === "sort" ? closeOverlay() : openOverlay({ kind: "sort", anchor: sort });
  });
  scrim.addEventListener("click", () => closeOverlay());
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);

  renderList();
  renderConversation();

  return {
    setAgentsIm(next) {
      agentsIm = next;
      renderConversation();
    },
    applyIntent(intent) {
      if (intent.type === "add-project") {
        // titlebar「新增项目」与页内原入口同一条路（B6-27 撤页内按钮后的唯一去路）。
        overlay?.kind === "folder" ? closeOverlay() : openOverlay({ kind: "folder" });
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      composerDispose();
      search.dispose();
      paneResizer.dispose();
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
      root.replaceChildren();
    },
  };
}
