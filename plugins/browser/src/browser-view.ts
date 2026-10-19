/**
 * 浏览器主页视图：快捷方式 + 当前标签一览 + 打开抽屉。
 *
 * 纯 DOM（与 todo-view 同款形态）；样式在 browser.css，用宿主注入的主题 token。
 * 状态只来自 Host；挂载、操作结束与 Host 状态通知后刷新。
 *
 * 语言切换走 `applyBrowserHomeLocale`：只更新现有节点的文字与属性，不重建
 * DOM，焦点/滚动原样保留；真实网页标题、URL 与品牌名始终原样显示。
 */

import { t } from "./browser-i18n";

export interface BrowserHomeHandlers {
  onOpenDrawer: () => void;
  onNewTab: (url?: string) => void;
  onRefresh: () => void;
  onSelectTab: (tabId: number) => void;
  onCloseTab: (tabId: number) => void;
}

export interface BrowserTabSummary {
  tabId: number;
  url: string;
  title: string;
  loading: boolean;
  openedByAgent: boolean;
}

export interface BrowserStateSummary {
  tabs: BrowserTabSummary[];
  activeTabId: number | null;
  agentTabId: number | null;
}

// 品牌名不翻译；快捷入口的 URL 是原始数据。
const QUICK_LINKS: Array<{ label: string; url: string }> = [
  { label: "Bing", url: "https://www.bing.com" },
  { label: "GitHub", url: "https://github.com" },
  { label: "知乎", url: "https://www.zhihu.com" },
  { label: "MDN", url: "https://developer.mozilla.org" },
];

export type BrowserPhase = "open" | "new" | "refresh" | "select" | "close";
export interface BrowserActivity { phase: BrowserPhase; stage?: BrowserPhase; tabId?: number; url?: string }

export interface BrowserHome {
  root: HTMLElement;
  listEl: HTMLElement;
  statusEl: HTMLElement;
  handlers: BrowserHomeHandlers;
  introEl: HTMLElement;
  openBtn: HTMLButtonElement;
  newTabBtn: HTMLButtonElement;
  linksTitleEl: HTMLElement;
  tabsTitleEl: HTMLElement;
  refreshBtn: HTMLButtonElement;
  /** 最近一次引擎事实；语言切换时据此原位重画文字，不重新请求。 */
  state: BrowserStateSummary | null;
  errorDetail: unknown;
  failedPhase: BrowserPhase;
  activity?: BrowserActivity;
  elapsedMs: number;
  developerMode: boolean;
  diagnosticEl: HTMLElement;
  progressEl: HTMLElement;
  feedbackEl: HTMLElement;
  actionsEl: HTMLElement;
  diagnosticGeneratedAt?: string;
  pluginVersion?: string;
  hostVersion?: string;
  hostVersionError?: unknown;
}

/** 标签行标题：真实标题/URL 优先，两者皆空才用带 tabId 的占位译文。 */
function tabLabelText(label: HTMLElement): string {
  const title = label.dataset.rbTitle ?? "";
  const url = label.dataset.rbUrl ?? "";
  const tabId = Number(label.dataset.rbTabId);
  return title || url || t("tabs.titleFallback", { tabId });
}

function applyRowTexts(row: HTMLElement): void {
  const label = row.querySelector<HTMLElement>(".rb-tab-title");
  if (label) {
    const value = tabLabelText(label);
    if (label.textContent !== value) label.textContent = value;
  }
  const work = row.querySelector<HTMLElement>(".rb-tab-badge.work");
  if (work) {
    const value = t("tabs.workBadge");
    if (work.textContent !== value) work.textContent = value;
  }
  const close = row.querySelector<HTMLElement>(".rb-tab-close");
  if (close) {
    const value = t("tabs.close");
    if (close.getAttribute("title") !== value) {
      close.setAttribute("title", value);
      close.setAttribute("aria-label", value);
    }
  }
}

function errorReason(error: unknown): string {
  const e = error as { code?: unknown; userMessage?: unknown; message?: unknown } | null;
  const text = [e?.code, e?.userMessage, e?.message, typeof error === "string" ? error : ""].filter(value => typeof value === "string").join(" ");
  if (/TIMEOUT|timed out/i.test(text)) return "timeout";
  if (/PLUGIN_(?:APP_)?DISABLED/.test(text)) return "disabled";
  if (/NOT_GRANTED|PERMISSION_(?:REQUIRED|DENIED)|CAPABILITY_NOT/.test(text)) return "permission";
  if (/BRIDGE_UNAVAILABLE|ENGINE_(?:UNAVAILABLE|EXITED)|ENGINE[-_]OFFLINE/i.test(text)) return "unavailable";
  return "failed";
}

function diagnosticText(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : t("status.noCode");
  const reason = typeof e?.message === "string" ? e.message : String(error);
  return `${code}: ${reason}`
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return "[URL]"; } })
    .replace(/(?:Bearer\s+)[^\s,;]+/gi, "[redacted]")
    .replace(/(?:token|cookie|secret|password|authorization|credential|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted]")
    .slice(0, 1000);
}

function applyStatusText(home: BrowserHome): void {
  const failed = home.errorDetail !== undefined;
  let value = "";
  if (home.activity) {
    value = t(`activity.${home.activity.stage ?? home.activity.phase}`);
    if (home.elapsedMs >= 1000) value = t("status.waiting", { activity: value, seconds: Math.floor(home.elapsedMs / 1000) });
  } else if (failed) {
    value = t(`status.${errorReason(home.errorDetail)}`, { action: t(`action.${home.failedPhase}`) });
  } else if (!home.state || home.state.tabs.length === 0) value = t("tabs.empty");
  home.statusEl.classList.toggle("error", failed && !home.activity);
  if (home.statusEl.textContent !== value) home.statusEl.textContent = value;
  home.progressEl.hidden = !home.activity || home.elapsedMs < 400;
  home.progressEl.setAttribute("aria-label", value);
  home.diagnosticEl.hidden = !home.developerMode || (!failed && !home.activity);
  home.diagnosticEl.textContent = home.diagnosticEl.hidden ? "" : t("status.diagnostic", {
    pluginVersion: home.pluginVersion ?? t("status.versionUnavailable"),
    hostVersion: home.hostVersion ?? (home.hostVersionError === undefined ? t("status.versionUnavailable") : `${t("status.versionUnavailable")} (${diagnosticText(home.hostVersionError)})`),
    detail: failed ? diagnosticText(home.errorDetail) : t(`activity.${home.activity!.stage ?? home.activity!.phase}`),
    state: t(failed ? "status.objectFailed" : "status.objectWaiting"),
    generatedAt: home.diagnosticGeneratedAt ?? new Date().toISOString(),
    logs: t("status.logsUnavailable"),
  });
}

function applyActivity(home: BrowserHome): void {
  const activity = home.activity;
  home.root.setAttribute("aria-busy", String(!!activity));
  for (const button of Array.from(home.root.querySelectorAll<HTMLButtonElement>("button"))) button.disabled = !!activity;
  home.openBtn.textContent = t(activity?.phase === "open" ? "activity.open" : "home.openBrowser");
  home.newTabBtn.textContent = t(activity?.phase === "new" && !activity.url ? "activity.new" : "home.newTab");
  home.refreshBtn.textContent = t(activity?.phase === "refresh" ? "activity.refresh" : "home.refresh");
  for (const chip of Array.from(home.root.querySelectorAll<HTMLButtonElement>(".rb-link"))) {
    chip.textContent = activity?.phase === "new" && activity.url === chip.dataset.rbUrl ? t("activity.new") : chip.dataset.rbLabel ?? "";
  }
  for (const row of Array.from(home.listEl.querySelectorAll<HTMLElement>(".rb-tab"))) {
    applyRowTexts(row);
    const close = row.querySelector<HTMLElement>(".rb-tab-close");
    const closing = activity?.phase === "close" && activity.tabId === Number(row.dataset.rbTabId);
    close?.classList.toggle("busy", closing);
    close?.querySelector("path")?.setAttribute("d", closing ? "M21 12a9 9 0 1 1-9-9" : "M6 6l12 12M18 6L6 18");
    if (closing) close?.setAttribute("aria-label", t("activity.close"));
    if (activity?.tabId === Number(row.dataset.rbTabId)) {
      if (activity.phase === "select") row.querySelector<HTMLElement>(".rb-tab-title")!.textContent = t("activity.select");
    }
  }
  if (activity?.phase === "open" || activity?.phase === "new") home.actionsEl.after(home.feedbackEl);
  else if (activity?.phase === "refresh") home.tabsTitleEl.after(home.feedbackEl);
  else home.listEl.after(home.feedbackEl);
  applyStatusText(home);
}

export function setBrowserHomeActivity(home: BrowserHome, activity: BrowserActivity | undefined, elapsedMs: number): void {
  if (activity && !home.activity) home.diagnosticGeneratedAt = new Date().toISOString();
  home.activity = activity;
  home.elapsedMs = elapsedMs;
  applyActivity(home);
}

export function setBrowserHomeDeveloperMode(home: BrowserHome, enabled: boolean): void {
  home.developerMode = enabled;
  applyStatusText(home);
}

export function mountBrowserHome(
  parent: HTMLElement,
  handlers: BrowserHomeHandlers,
): BrowserHome {
  const frame = document.createElement("div");
  frame.className = "plugin-main-frame";
  const root = document.createElement("div");
  root.className = "main-body rb-home";
  const content = document.createElement("div");
  content.className = "rb-content";
  root.append(content);
  frame.appendChild(root);

  const sub = document.createElement("div");
  sub.className = "rb-sub";
  sub.textContent = t("home.intro");

  const actions = document.createElement("div");
  actions.className = "rb-actions";
  const openBtn = document.createElement("button");
  openBtn.className = "rb-btn primary";
  openBtn.type = "button";
  openBtn.textContent = t("home.openBrowser");
  openBtn.addEventListener("click", handlers.onOpenDrawer);
  const newTabBtn = document.createElement("button");
  newTabBtn.className = "rb-btn";
  newTabBtn.type = "button";
  newTabBtn.textContent = t("home.newTab");
  newTabBtn.addEventListener("click", () => handlers.onNewTab());
  actions.append(openBtn, newTabBtn);

  const linksTitle = document.createElement("div");
  linksTitle.className = "rb-sec-t";
  linksTitle.textContent = t("home.quickLinks");
  const links = document.createElement("div");
  links.className = "rb-links";
  for (const link of QUICK_LINKS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rb-link";
    chip.textContent = link.label;
    chip.dataset.rbLabel = link.label;
    chip.dataset.rbUrl = link.url;
    chip.addEventListener("click", () => handlers.onNewTab(link.url));
    links.append(chip);
  }

  const tabsTitle = document.createElement("div");
  tabsTitle.className = "rb-sec-t";
  tabsTitle.textContent = t("home.currentTabs");
  const listEl = document.createElement("div");
  listEl.className = "rb-tabs";
  const statusEl = document.createElement("div");
  statusEl.className = "rb-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  const progressEl = document.createElement("div");
  progressEl.className = "rb-progress";
  progressEl.hidden = true;
  progressEl.setAttribute("role", "progressbar");
  const feedbackEl = document.createElement("div");
  feedbackEl.className = "rb-feedback";
  const diagnosticEl = document.createElement("pre");
  diagnosticEl.className = "rb-diagnostic";
  diagnosticEl.hidden = true;

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "rb-refresh";
  refresh.textContent = t("home.refresh");
  refresh.addEventListener("click", handlers.onRefresh);
  tabsTitle.append(refresh);

  feedbackEl.append(statusEl, progressEl, diagnosticEl);
  content.append(sub, actions, linksTitle, links, tabsTitle, listEl, feedbackEl);
  parent.append(frame);
  return {
    root,
    listEl,
    statusEl,
    handlers,
    introEl: sub,
    openBtn,
    newTabBtn,
    linksTitleEl: linksTitle,
    tabsTitleEl: tabsTitle,
    refreshBtn: refresh,
    state: null,
    errorDetail: undefined,
    failedPhase: "refresh",
    elapsedMs: 0,
    developerMode: false,
    diagnosticEl,
    progressEl,
    feedbackEl,
    actionsEl: actions,
  };
}

/** 语言切换：只更新文字与属性，保留节点、焦点、滚动与全部业务状态。 */
export function applyBrowserHomeLocale(home: BrowserHome): void {
  const intro = t("home.intro");
  if (home.introEl.textContent !== intro) home.introEl.textContent = intro;
  const open = t("home.openBrowser");
  if (home.openBtn.textContent !== open) home.openBtn.textContent = open;
  const newTab = t("home.newTab");
  if (home.newTabBtn.textContent !== newTab) home.newTabBtn.textContent = newTab;
  const quickLinks = t("home.quickLinks");
  if (home.linksTitleEl.textContent !== quickLinks) {
    home.linksTitleEl.textContent = quickLinks;
  }
  const currentTabs = t("home.currentTabs");
  if (home.tabsTitleEl.firstChild?.textContent !== currentTabs) {
    // 标题容器里还挂着「刷新」按钮，只改标题自己的文字节点，不动按钮。
    if (home.tabsTitleEl.firstChild) home.tabsTitleEl.firstChild.textContent = currentTabs;
  }
  const refresh = t("home.refresh");
  if (home.refreshBtn.textContent !== refresh) {
    home.refreshBtn.textContent = refresh;
  }
  applyActivity(home);
  for (const row of Array.from(home.listEl.children)) {
    if (row instanceof HTMLElement) applyRowTexts(row);
  }
}

export function refreshBrowserHome(
  home: BrowserHome,
  state: BrowserStateSummary | null,
  errorDetail?: unknown,
  failedPhase: BrowserPhase = "refresh",
): void {
  home.state = state;
  home.errorDetail = errorDetail;
  home.failedPhase = failedPhase;
  if (errorDetail !== undefined) home.diagnosticGeneratedAt = new Date().toISOString();
  home.listEl.replaceChildren();
  applyStatusText(home);
  if (!state || state.tabs.length === 0) return;
  for (const tab of state.tabs) {
    const row = document.createElement("div");
    row.dataset.rbTabId = String(tab.tabId);
    row.className = "rb-tab" + (tab.tabId === state.activeTabId ? " active" : "");
    const select = document.createElement("button");
    select.type = "button";
    select.className = "rb-tab-select";
    select.addEventListener("click", () => home.handlers.onSelectTab(tab.tabId));
    const label = document.createElement("span");
    label.className = "rb-tab-title";
    // 语言切换要能原位重算占位标题，原始 title/url/tabId 记在节点上。
    label.dataset.rbTitle = tab.title;
    label.dataset.rbUrl = tab.url;
    label.dataset.rbTabId = String(tab.tabId);
    label.textContent = tab.title || tab.url || t("tabs.titleFallback", { tabId: tab.tabId });
    select.append(label);
    if (tab.openedByAgent) {
      const badge = document.createElement("span");
      badge.className = "rb-tab-badge";
      badge.textContent = "Agent";
      select.append(badge);
    }
    if (tab.tabId === state.agentTabId) {
      const badge = document.createElement("span");
      badge.className = "rb-tab-badge work";
      badge.textContent = t("tabs.workBadge");
      select.append(badge);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "rb-tab-close";
    close.setAttribute("title", t("tabs.close"));
    close.setAttribute("aria-label", t("tabs.close"));
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "16");
    icon.setAttribute("height", "16");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M6 6l12 12M18 6L6 18");
    icon.append(path);
    close.append(icon);
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      home.handlers.onCloseTab(tab.tabId);
    });
    row.append(select, close);
    home.listEl.append(row);
  }
  applyActivity(home);
}
