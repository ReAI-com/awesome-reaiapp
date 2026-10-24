import { createTerminalMessages, type TerminalMessages } from "./terminal-i18n";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachTerminalRenderer, type TerminalRendererHandle } from "./terminal-renderer";
import type {
  TerminalSessionClient,
  TerminalSessionEvent,
  TerminalSessionInfo,
} from "@reai/app-sdk/v1";
import {
  activateTerminalPane,
  closeTerminalPane,
  compactPaneOrientation,
  createTerminalPane,
  createTerminalTab,
  flattenTerminalPaneIds,
  focusSplitTracks,
  inferTerminalLayoutPreset,
  minLayoutExtent,
  normalizeTerminalDynamicTitle,
  normalizeTerminalTabName,
  reflowTerminalLayout,
  resolveSashPosition,
  splitTerminalPane,
  TERMINAL_SASH_PX,
  updateTerminalSplit,
  type TerminalLayoutNode,
  type TerminalLayoutPreset,
  type TerminalPaneModel,
  type TerminalSplitAxis,
  type TerminalSplitNode,
  type TerminalTabModel,
} from "./workspace-model";
import {
  terminalSchemeSurfaceTokens,
} from "./terminal-theme";
import {
  resolvedTerminalScheme,
  type TerminalPreferences,
  type TerminalPreferencesStore,
} from "./terminal-preferences";

interface PaneView {
  info: TerminalSessionInfo;
  token: string;
  terminal: Terminal;
  fit: FitAddon;
  renderer: TerminalRendererHandle | null;
  element: HTMLElement;
  host: HTMLElement;
  observer: ResizeObserver;
  disposables: Array<{ dispose(): void }>;
  lastSize: string;
  compact: "horizontal" | "vertical" | null;
}

export interface TerminalWorkspace {
  accept(event: TerminalSessionEvent): void;
  restartActive(): Promise<void>;
  stopActive(): Promise<void>;
  refresh(): void;
  showFooter(visible: boolean): void;
  dispose(): Promise<void>;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uniqueId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function icon(name: "plus" | "x" | "code" | "grip" | "pen", size: number): string {
  const paths = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="m18 6-12 12M6 6l12 12"/>',
    code: '<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  } as const;
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function paneFromSession(info: TerminalSessionInfo): TerminalPaneModel {
  return createTerminalPane(uniqueId("pane"), info.id, info.sequence, info.cwd);
}

export async function mountTerminalWorkspace(
  root: HTMLElement,
  terminalClient: TerminalSessionClient,
  preferenceStore: TerminalPreferencesStore,
  messages: TerminalMessages = createTerminalMessages(),
  footer?: HTMLElement,
): Promise<TerminalWorkspace> {
  root.innerHTML = `
    <main class="terminal-main-frame">
      <div class="terminal-tabs-bar">
        <div class="terminal-tabs" role="tablist" data-i18n-aria-label="tabs" aria-label=""></div>
        <button class="terminal-tab-add" type="button" data-i18n-title="addTab" title="" data-i18n-aria-label="addTab" aria-label="">${icon("plus", 14)}</button>
        <div class="terminal-tabs-spacer"></div>
        <div class="terminal-layout-wrap">
          <button class="terminal-layout-trigger" type="button" aria-haspopup="menu" aria-expanded="false"><span class="layout-four"><i></i><i></i><i></i><i></i></span><span><span data-i18n="layout"></span></span></button>
          <div class="terminal-layout-menu" role="menu">
            <div class="terminal-layout-menu-title"><span data-i18n="layoutTitle"></span></div>
            <div class="terminal-layout-presets">
              <button class="terminal-layout-preset" data-preset="columns" type="button" role="menuitemradio"><span class="terminal-layout-glyph cols"><i></i><i></i></span><span><span data-i18n="columns"></span></span></button>
              <button class="terminal-layout-preset" data-preset="rows" type="button" role="menuitemradio"><span class="terminal-layout-glyph rows"><i></i><i></i></span><span><span data-i18n="rows"></span></span></button>
              <button class="terminal-layout-preset" data-preset="focus-stack" type="button" role="menuitemradio"><span class="terminal-layout-glyph stack"><i></i><i></i><i></i></span><span><span data-i18n="focusStack"></span></span></button>
            </div>
            <div class="terminal-layout-note"><span data-i18n="layoutNote"></span></div>
          </div>
        </div>
      </div>
      <div class="terminal-workspaces"><div class="terminal-workspace-shell"></div></div>
      <footer class="terminal-statusbar"></footer>
      <div class="terminal-toast" role="status" hidden><span></span><button type="button" data-i18n-aria-label="closeNotice" aria-label="">${icon("x", 12)}</button></div>
      <div class="terminal-tab-context" role="menu" hidden>
        <button data-action="rename" type="button" role="menuitem">${icon("pen", 13)}<span data-i18n="rename"></span></button>
        <button data-action="close" type="button" role="menuitem">${icon("x", 13)}<span data-i18n="closeTab"></span></button>
      </div>
      <div class="terminal-tab-name-dialog" role="presentation" hidden>
        <form role="dialog" aria-modal="true">
          <h2></h2><p></p><input autocomplete="off" data-i18n-aria-label="tabName" aria-label="" />
          <span class="terminal-name-error" role="alert"></span>
          <div><button data-action="cancel" type="button"><span data-i18n="common.cancel"></span></button><button class="primary" type="submit"><span data-i18n="common.save"></span></button></div>
        </form>
      </div>
    </main>`;

  const tabsElement = root.querySelector<HTMLElement>(".terminal-tabs")!;
  const workspaceElement = root.querySelector<HTMLElement>(".terminal-workspace-shell")!;
  const statusElement = root.querySelector<HTMLElement>(".terminal-statusbar")!;
  const statusParent = statusElement.parentElement!;
  if (footer) footer.append(statusElement);
  const toastElement = root.querySelector<HTMLElement>(".terminal-toast")!;
  const toastText = toastElement.querySelector<HTMLElement>("span")!;
  const menuTrigger = root.querySelector<HTMLButtonElement>(".terminal-layout-trigger")!;
  const menuElement = root.querySelector<HTMLElement>(".terminal-layout-menu")!;
  const contextElement = root.querySelector<HTMLElement>(".terminal-tab-context")!;
  const dialogElement = root.querySelector<HTMLElement>(".terminal-tab-name-dialog")!;
  const dialogForm = dialogElement.querySelector<HTMLFormElement>("form")!;
  const dialogTitle = dialogElement.querySelector<HTMLElement>("h2")!;
  const dialogCopy = dialogElement.querySelector<HTMLElement>("p")!;
  const dialogInput = dialogElement.querySelector<HTMLInputElement>("input")!;
  const dialogError = dialogElement.querySelector<HTMLElement>(".terminal-name-error")!;
  const dialogSubmit = dialogElement.querySelector<HTMLButtonElement>("button.primary")!;
  const views = new Map<string, PaneView>();
  const layoutObservers = new Set<ResizeObserver>();
  const restartingIds = new Set<string>();
  let tabs: TerminalTabModel[] = [];
  const generatedNames = new Map<string, { key: string; params: Record<string, number> }>();
  const tabName = (tab: TerminalTabModel) => {
    const generated = generatedNames.get(tab.id);
    return generated ? messages.t(generated.key, generated.params) : tab.name;
  };
  let activeTabId = "";
  let dynamicTitles: Record<string, string> = {};
  let nextTabNumber = 1;
  let busy = false;
  let disposed = false;
  let layoutMenuOpen = false;
  let contextTabId = "";
  let namingMode: "create" | "rename" = "create";
  let namingTabId = "";
  const frame = root.querySelector<HTMLElement>(".terminal-main-frame")!;

  function applyPreferences(preferences: TerminalPreferences) {
    const scheme = resolvedTerminalScheme(preferences);
    const surface = terminalSchemeSurfaceTokens(scheme);
    frame.dataset.terminalTheme = scheme.id;
    for (const [name, value] of Object.entries({
      "--term-bg": surface.workspace,
      "--term-pane": surface.pane,
      "--term-header": surface.header,
      "--term-header-active": surface.headerActive,
      "--term-border": surface.border,
      "--term-divider": surface.divider,
      "--term-fg": scheme.colors.foreground,
      "--term-muted": surface.muted,
      "--term-compact": surface.compact,
      "--term-compact-core": surface.compactCore,
      "--term-accent": surface.accent,
      "--term-accent-soft": `color-mix(in srgb, ${surface.accent} 18%, transparent)`,
      "--term-accent-glow": `color-mix(in srgb, ${surface.accent} 28%, transparent)`,
      "--term-accent-contrast": surface.accentContrast,
    })) frame.style.setProperty(name, value);
    for (const view of views.values()) {
      view.terminal.options.theme = scheme.colors;
      view.terminal.options.fontSize = preferences.fontSize;
      view.terminal.options.cursorStyle = preferences.cursorStyle;
      view.terminal.options.cursorBlink = preferences.cursorBlink;
      view.terminal.options.scrollback = preferences.scrollback;
      queueMicrotask(() => fitAndResize(view));
    }
  }

  applyPreferences(preferenceStore.value);
  const stopPreferences = preferenceStore.subscribe(applyPreferences);

  const activeTab = () => tabs.find((tab) => tab.id === activeTabId) ?? null;
  const sessionCount = () => tabs.reduce((total, tab) => total + Object.keys(tab.panes).length, 0);

  let toastMessage: (() => string) | undefined;
  function showMessage(message: () => string, tone: "ok" | "error" = "error") {
    toastMessage = message;
    toastText.textContent = message();
    toastElement.classList.toggle("error", tone === "error");
    toastElement.hidden = false;
  }

  function clearMessage() {
    toastElement.hidden = true;
    toastMessage = undefined;
    toastText.textContent = "";
  }

  function replaceTab(next: TerminalTabModel) {
    tabs = tabs.map((tab) => tab.id === next.id ? next : tab);
  }

  function paneLabel(tab: TerminalTabModel, paneId: string): string {
    return dynamicTitles[paneId]
      ?? (flattenTerminalPaneIds(tab.root)[0] === paneId ? tabName(tab) : messages.t("newPane"));
  }

  function fitAndResize(view: PaneView) {
    if (disposed || view.compact || !view.element.isConnected) return;
    try { view.fit.fit(); } catch { return; }
    const rows = Math.max(2, view.terminal.rows);
    const cols = Math.max(2, view.terminal.cols);
    const size = `${rows}x${cols}`;
    if (size === view.lastSize) return;
    view.lastSize = size;
    void terminalClient.resize(view.info.id, rows, cols).catch(() => undefined);
  }

  function measurePane(view: PaneView) {
    const compact = compactPaneOrientation(
      view.element.clientWidth,
      view.element.clientHeight,
      view.compact !== null,
    );
    if (compact === view.compact) return;
    view.compact = compact;
    view.element.classList.toggle("is-compact", compact !== null);
    view.element.classList.toggle("compact-horizontal", compact === "horizontal");
    view.element.classList.toggle("compact-vertical", compact === "vertical");
    renderStatus();
    if (!compact) queueMicrotask(() => fitAndResize(view));
  }

  async function createView(info: TerminalSessionInfo): Promise<PaneView> {
    const attachment = await terminalClient.attach(info.id);
    const preferences = preferenceStore.value;
    const scheme = resolvedTerminalScheme(preferences);
    const element = document.createElement("section");
    element.className = "terminal-pane";
    const host = document.createElement("div");
    host.className = "terminal-renderer-host";
    Terminal.strings.promptLabel = messages.t("terminalInput");
    Terminal.strings.tooMuchOutput = messages.t("terminalOutputLimit");
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: preferences.cursorBlink,
      cursorStyle: preferences.cursorStyle,
      fontFamily: "'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
      fontSize: preferences.fontSize,
      lineHeight: 1.2,
      scrollback: preferences.scrollback,
      allowTransparency: false,
      theme: scheme.colors,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const observer = new ResizeObserver(() => {
      const view = views.get(info.id);
      if (!view) return;
      measurePane(view);
      fitAndResize(view);
    });
    const input = terminal.onData((data) => {
      void terminalClient.write(info.id, new TextEncoder().encode(data)).catch((cause) => {
        showMessage(() => messages.t("inputFailed", { error: String(cause) }));
      });
    });
    const title = terminal.onTitleChange((rawTitle) => {
      const tab = tabs.find((candidate) => Object.values(candidate.panes).some((pane) => pane.sessionId === info.id));
      const pane = tab && Object.values(tab.panes).find((candidate) => candidate.sessionId === info.id);
      if (!tab || !pane) return;
      const normalized = normalizeTerminalDynamicTitle(rawTitle);
      if (normalized) dynamicTitles = { ...dynamicTitles, [pane.id]: normalized };
      else {
        const next = { ...dynamicTitles };
        delete next[pane.id];
        dynamicTitles = next;
      }
      render();
    });
    const view: PaneView = {
      info,
      token: attachment.token,
      terminal,
      fit,
      renderer: null,
      element,
      host,
      observer,
      disposables: [input, title],
      lastSize: "",
      compact: null,
    };
    views.set(info.id, view);
    if (attachment.truncated) terminal.writeln("\r\n[ReAI: " + messages.t("outputOmitted") + "]");
    if (attachment.replayBase64) terminal.write(decodeBase64(attachment.replayBase64));
    return view;
  }

  function disposeView(sessionId: string, detach = true) {
    const view = views.get(sessionId);
    if (!view) return;
    view.observer.disconnect();
    view.disposables.forEach((item) => item.dispose());
    view.terminal.dispose();
    view.element.remove();
    views.delete(sessionId);
    if (detach) void terminalClient.detach(sessionId, view.token).catch(() => undefined);
  }

  function renderPane(tab: TerminalTabModel, pane: TerminalPaneModel): HTMLElement {
    const view = views.get(pane.sessionId);
    if (!view) {
      const missing = document.createElement("section");
      missing.className = "terminal-pane terminal-pane-missing";
      messages.text(missing, "connecting");
      return missing;
    }
    const label = paneLabel(tab, pane.id);
    const canClose = Object.keys(tab.panes).length > 1;
    view.element.classList.toggle("active", tab.activePaneId === pane.id);
    view.element.dataset.sessionId = pane.sessionId;
    messages.text(view.element, "paneAria", { number: pane.number }, "aria-label");
    view.element.innerHTML = `
      <button class="terminal-compact-face" type="button" tabindex="${view.compact ? 0 : -1}" aria-hidden="${view.compact ? "false" : "true"}">
        <span class="terminal-compact-core">${icon("code", 18)}<span class="terminal-compact-copy"><span class="terminal-compact-id">T${pane.number}</span><span class="terminal-compact-title"></span></span></span>
      </button>
      <header class="terminal-pane-header">
        <div class="terminal-pane-identity"><span class="terminal-id">T${pane.number}</span><strong class="terminal-pane-title"></strong><span class="terminal-pane-path"></span></div>
        <div class="terminal-pane-actions">
          <button class="terminal-icon-btn" data-split="horizontal" type="button" data-i18n-aria-label="splitRight" data-i18n-params='{"number":${pane.number}}' ${busy ? "disabled" : ""}><span class="split-glyph columns"><i></i><i></i></span></button>
          <button class="terminal-icon-btn" data-split="vertical" type="button" data-i18n-aria-label="splitBelow" data-i18n-params='{"number":${pane.number}}' ${busy ? "disabled" : ""}><span class="split-glyph rows"><i></i><i></i></span></button>
          <button class="terminal-icon-btn danger" data-close type="button" data-i18n-aria-label="closePane" data-i18n-params='{"number":${pane.number}}' ${canClose ? "" : "disabled"}>${icon("x", 13)}</button>
        </div>
      </header>
      <div class="terminal-pane-body"><div class="terminal-renderer"></div></div>`;
    const compactFace = view.element.querySelector<HTMLButtonElement>(".terminal-compact-face")!;
    const compactDescription = messages.t("expandPane", { number: pane.number, name: label });
    compactFace.setAttribute("aria-label", compactDescription);
    compactFace.title = compactDescription;
    view.element.querySelector<HTMLElement>(".terminal-compact-title")!.textContent = label;
    view.element.querySelector<HTMLElement>(".terminal-pane-title")!.textContent = label;
    const path = view.element.querySelector<HTMLElement>(".terminal-pane-path")!;
    path.textContent = pane.cwd || messages.t("defaultDirectory");
    path.title = pane.cwd || "";
    view.element.querySelector<HTMLElement>(".terminal-renderer")!.append(view.host);
    if (!view.host.hasChildNodes()) view.terminal.open(view.host);
    if (view.renderer) view.renderer.resume();
    else {
      view.renderer = attachTerminalRenderer(view.terminal);
      view.disposables.push(view.renderer);
    }
    compactFace.onclick = () => {
      replaceTab({ ...activateTerminalPane(tab, pane.id), focusedPaneId: pane.id });
      render();
    };
    view.element.querySelectorAll<HTMLButtonElement>("[data-split]").forEach((button) => {
      button.onclick = () => void splitPane(tab.id, pane.id, button.dataset.split as TerminalSplitAxis);
    });
    view.element.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => void closePane(tab.id, pane.id);
    view.element.onpointerdown = (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      replaceTab(activateTerminalPane(tab, pane.id));
      render();
      view.terminal.focus();
    };
    view.observer.observe(view.element);
    queueMicrotask(() => fitAndResize(view));
    return view.element;
  }

  function renderSplit(tab: TerminalTabModel, node: TerminalSplitNode): HTMLElement {
    const element = document.createElement("div");
    element.className = `terminal-layout-split ${node.axis}`;
    const first = document.createElement("div");
    first.className = "terminal-layout-track";
    const sash = document.createElement("div");
    sash.className = `terminal-sash ${node.axis}`;
    sash.tabIndex = 0;
    sash.setAttribute("role", "separator");
    messages.text(sash, "resize", {}, "aria-label");
    sash.innerHTML = "<i></i>";
    const second = document.createElement("div");
    second.className = "terminal-layout-track";
    first.append(renderLayout(tab, node.first));
    second.append(renderLayout(tab, node.second));
    element.append(first, sash, second);

    const applyTracks = () => {
      const extent = node.axis === "horizontal" ? element.clientWidth : element.clientHeight;
      const available = Math.max(0, extent - TERMINAL_SASH_PX);
      const tracks = tab.focusedPaneId
        ? focusSplitTracks(node, extent, tab.focusedPaneId)
        : { firstPx: Math.round(available * node.ratio), secondPx: available - Math.round(available * node.ratio) };
      first.style.flexBasis = `${tracks.firstPx}px`;
      second.style.flexBasis = `${tracks.secondPx}px`;
    };
    queueMicrotask(applyTracks);
    const observer = new ResizeObserver(applyTracks);
    layoutObservers.add(observer);
    observer.observe(element);

    sash.onpointerdown = (event) => {
      replaceTab({ ...tab, focusedPaneId: null });
      sash.setPointerCapture(event.pointerId);
      let latest = { ratio: node.ratio, lockedSide: node.lockedSide };
      const move = (next: PointerEvent) => {
        const rect = element.getBoundingClientRect();
        const containerPx = node.axis === "horizontal" ? rect.width : rect.height;
        const pointerPx = node.axis === "horizontal" ? next.clientX - rect.left : next.clientY - rect.top;
        latest = resolveSashPosition({
          containerPx,
          pointerPx,
          firstMinPx: minLayoutExtent(node.first, node.axis),
          secondMinPx: minLayoutExtent(node.second, node.axis),
          previousLockedSide: node.lockedSide,
        });
        const available = Math.max(0, containerPx - TERMINAL_SASH_PX);
        first.style.flexBasis = `${Math.round(available * latest.ratio)}px`;
        second.style.flexBasis = `${available - Math.round(available * latest.ratio)}px`;
      };
      const end = () => {
        sash.removeEventListener("pointermove", move);
        sash.removeEventListener("pointerup", end);
        sash.removeEventListener("pointercancel", end);
        const current = tabs.find((candidate) => candidate.id === tab.id);
        if (current) replaceTab({ ...current, root: updateTerminalSplit(current.root, node.id, latest) });
        render();
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", end);
      sash.addEventListener("pointercancel", end);
    };
    return element;
  }

  function renderLayout(tab: TerminalTabModel, node: TerminalLayoutNode): HTMLElement {
    if (node.kind === "leaf") return renderPane(tab, tab.panes[node.paneId]!);
    return renderSplit(tab, node);
  }

  function renderTabs() {
    tabsElement.replaceChildren();
    for (const tab of tabs) {
      const shell = document.createElement("div");
      shell.className = `terminal-tab${tab.id === activeTabId ? " active" : ""}`;
      shell.dataset.tabId = tab.id;
      messages.text(shell, "renameHint", { name: tabName(tab) }, "title");
      const main = document.createElement("button");
      main.className = "terminal-tab-main";
      main.type = "button";
      main.setAttribute("role", "tab");
      main.setAttribute("aria-selected", String(tab.id === activeTabId));
      const name = document.createElement("span");
      name.className = "terminal-tab-name";
      name.textContent = tabName(tab);
      const count = document.createElement("span");
      count.className = "terminal-tab-count";
      count.textContent = String(Object.keys(tab.panes).length);
      main.append(name, count);
      main.onclick = () => { activeTabId = tab.id; render(); };
      const close = document.createElement("button");
      close.className = "terminal-tab-close";
      close.type = "button";
      messages.text(close, "closeNamed", { name: tabName(tab) }, "aria-label");
      close.innerHTML = icon("x", 11);
      close.onclick = (event) => { event.stopPropagation(); void closeTab(tab.id); };
      shell.ondblclick = () => openNamingDialog("rename", tab.id);
      shell.oncontextmenu = (event) => {
        event.preventDefault();
        activeTabId = tab.id;
        contextTabId = tab.id;
        contextElement.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 158))}px`;
        contextElement.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 82))}px`;
        contextElement.hidden = false;
        render();
      };
      shell.append(main, close);
      tabsElement.append(shell);
    }
  }

  function renderStatus() {
    const tab = activeTab();
    if (!tab) {
      statusElement.replaceChildren();
      return;
    }
    const pane = tab.panes[tab.activePaneId];
    const compactCount = Object.values(tab.panes).filter((item) => views.get(item.sessionId)?.compact).length;
    statusElement.innerHTML = `<span><span data-i18n="target"></span></span><b>T${pane?.number ?? "—"}</b><span class="terminal-active-label"></span><span class="spacer"></span>${compactCount
      ? `<span class="capacity-note show" data-i18n="compactCount" data-i18n-params='{"count":${compactCount}}'></span>`
      : `<span class="drag-note">${icon("grip", 11)}<span data-i18n="dragNote"></span></span>`}`;
    statusElement.querySelector<HTMLElement>(".terminal-active-label")!.textContent = pane ? paneLabel(tab, pane.id) : "—";
    messages.update(statusElement);
  }

  function render() {
    if (disposed) return;
    layoutObservers.forEach((observer) => observer.disconnect());
    layoutObservers.clear();
    renderTabs();
    const tab = activeTab();
    workspaceElement.replaceChildren();
    // 先让不在当前标签里的窗格释放 WebGL 上下文，再渲染可见窗格；切回时在 renderPane 里重新获取。
    const visible = new Set(tab ? Object.values(tab.panes).map((pane) => pane.sessionId) : []);
    for (const [sessionId, view] of views) if (!visible.has(sessionId)) view.renderer?.suspend();
    if (tab) {
      const layout = renderLayout(tab, tab.root);
      layout.classList.add("terminal-layout-root");
      layout.style.minWidth = `${minLayoutExtent(tab.root, "horizontal")}px`;
      layout.style.minHeight = `${minLayoutExtent(tab.root, "vertical")}px`;
      workspaceElement.append(layout);
    } else {
      const empty = document.createElement("div");
      empty.className = "terminal-workspace-empty";
      empty.innerHTML = '<strong data-i18n="empty"></strong><button type="button" data-i18n="newTerminal"></button>';
      empty.querySelector("button")!.addEventListener("click", () => openNamingDialog("create"));
      workspaceElement.append(empty);
    }
    const preset = tab ? inferTerminalLayoutPreset(tab.root) : null;
    root.querySelectorAll<HTMLElement>(".terminal-layout-preset").forEach((button) => {
      const active = button.dataset.preset === preset;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", String(active));
    });
    root.querySelector<HTMLButtonElement>(".terminal-tab-add")!.disabled = busy || sessionCount() >= 24;
    renderStatus();
    messages.update(root);
  }

  function setBusy(value: boolean) {
    busy = value;
    render();
  }

  function openNamingDialog(mode: "create" | "rename", tabId = "") {
    namingMode = mode;
    namingTabId = tabId;
    const tab = tabs.find((item) => item.id === tabId);
    messages.text(dialogTitle, mode === "create" ? "createTitle" : "renameTitle");
    messages.text(dialogCopy, mode === "create" ? "createHint" : "renameCopy");
    dialogInput.value = mode === "create" ? messages.t("defaultTab", { number: nextTabNumber }) : tab ? tabName(tab) : "";
    messages.clear(dialogError);
    messages.text(dialogSubmit, mode === "create" ? "create" : "common.save");
    dialogElement.hidden = false;
    contextElement.hidden = true;
    queueMicrotask(() => { dialogInput.focus(); dialogInput.select(); });
  }

  async function addTab(rawName: string): Promise<boolean> {
    const normalized = normalizeTerminalTabName(rawName);
    if (!normalized.ok) { messages.text(dialogError, normalized.error); return false; }
    setBusy(true);
    try {
      const info = await terminalClient.create({ rows: 24, cols: 80 });
      await createView(info);
      const tab = createTerminalTab(uniqueId("tab"), normalized.name, paneFromSession(info));
      tabs = [...tabs, tab];
      activeTabId = tab.id;
      nextTabNumber += 1;
      clearMessage();
      return true;
    } catch (cause) {
      showMessage(() => messages.t("createFailed", { error: String(cause) }));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function splitPane(tabId: string, paneId: string, axis: TerminalSplitAxis) {
    if (busy || sessionCount() >= 24) return;
    const tab = tabs.find((item) => item.id === tabId);
    const source = tab?.panes[paneId];
    if (!tab || !source) return;
    setBusy(true);
    let info: TerminalSessionInfo | null = null;
    try {
      info = await terminalClient.create({ rows: 24, cols: 80, cwd: source.cwd ?? undefined });
      await createView(info);
      const current = tabs.find((item) => item.id === tabId);
      if (!current?.panes[paneId]) {
        disposeView(info.id);
        await terminalClient.close(info.id).catch(() => undefined);
        return;
      }
      replaceTab(splitTerminalPane(current, paneId, paneFromSession(info), axis));
      clearMessage();
    } catch (cause) {
      if (info) disposeView(info.id);
      showMessage(() => messages.t("splitFailed", { error: String(cause) }));
    } finally {
      setBusy(false);
    }
  }

  async function closePane(tabId: string, paneId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    const pane = tab?.panes[paneId];
    if (!tab || !pane) return;
    const next = closeTerminalPane(tab, paneId);
    if (next) replaceTab(next);
    else tabs = tabs.filter((item) => item.id !== tabId);
    if (!tabs.some((item) => item.id === activeTabId)) activeTabId = tabs[0]?.id ?? "";
    render();
    await terminalClient.close(pane.sessionId).catch((cause) => showMessage(() => messages.t("closeFailed", { error: String(cause) })));
    disposeView(pane.sessionId, false);
  }

  async function closeTab(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    tabs = tabs.filter((item) => item.id !== tabId);
    if (activeTabId === tabId) activeTabId = tabs[0]?.id ?? "";
    render();
    await Promise.all(Object.values(tab.panes).map(async (pane) => {
      await terminalClient.close(pane.sessionId).catch(() => undefined);
      disposeView(pane.sessionId, false);
    }));
  }

  async function restartPane(tabId: string, paneId: string) {
    if (busy) return;
    const tab = tabs.find((item) => item.id === tabId);
    const pane = tab?.panes[paneId];
    if (!tab || !pane) return;
    const previousId = pane.sessionId;
    restartingIds.add(previousId);
    setBusy(true);
    try {
      const info = await terminalClient.restart(previousId, 24, 80);
      disposeView(previousId, false);
      await createView(info);
      const current = tabs.find((item) => item.id === tabId);
      const currentPane = current?.panes[paneId];
      if (!current || !currentPane || currentPane.sessionId !== previousId) {
        disposeView(info.id);
        await terminalClient.close(info.id).catch(() => undefined);
        return;
      }
      replaceTab({
        ...current,
        panes: {
          ...current.panes,
          [paneId]: {
            ...currentPane,
            sessionId: info.id,
            number: info.sequence,
            cwd: info.cwd,
          },
        },
      });
      const nextTitles = { ...dynamicTitles };
      delete nextTitles[paneId];
      dynamicTitles = nextTitles;
      clearMessage();
    } catch (cause) {
      showMessage(() => messages.t("restartFailed", { error: String(cause) }));
    } finally {
      restartingIds.delete(previousId);
      setBusy(false);
    }
  }

  function removeClosedSession(sessionId: string) {
    if (restartingIds.has(sessionId)) return;
    for (const tab of tabs) {
      const pane = Object.values(tab.panes).find((item) => item.sessionId === sessionId);
      if (!pane) continue;
      const next = closeTerminalPane(tab, pane.id);
      if (next) replaceTab(next);
      else tabs = tabs.filter((item) => item.id !== tab.id);
      break;
    }
    if (!tabs.some((item) => item.id === activeTabId)) activeTabId = tabs[0]?.id ?? "";
    disposeView(sessionId, false);
    render();
  }

  root.querySelector<HTMLButtonElement>(".terminal-tab-add")!.onclick = () => openNamingDialog("create");
  toastElement.querySelector<HTMLButtonElement>("button")!.onclick = clearMessage;
  menuTrigger.onclick = (event) => {
    event.stopPropagation();
    layoutMenuOpen = !layoutMenuOpen;
    menuElement.classList.toggle("open", layoutMenuOpen);
    menuTrigger.classList.toggle("on", layoutMenuOpen);
    menuTrigger.setAttribute("aria-expanded", String(layoutMenuOpen));
  };
  menuElement.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
    button.onclick = () => {
      const tab = activeTab();
      if (tab) replaceTab(reflowTerminalLayout(tab, button.dataset.preset as TerminalLayoutPreset));
      layoutMenuOpen = false;
      menuElement.classList.remove("open");
      menuTrigger.classList.remove("on");
      render();
    };
  });
  contextElement.querySelector<HTMLButtonElement>("[data-action=rename]")!.onclick = () => openNamingDialog("rename", contextTabId);
  contextElement.querySelector<HTMLButtonElement>("[data-action=close]")!.onclick = () => {
    contextElement.hidden = true;
    void closeTab(contextTabId);
  };
  dialogElement.querySelector<HTMLButtonElement>("[data-action=cancel]")!.onclick = () => { dialogElement.hidden = true; };
  dialogForm.onsubmit = (event) => {
    event.preventDefault();
    if (namingMode === "create") {
      void addTab(dialogInput.value).then((created) => { if (created) dialogElement.hidden = true; });
      return;
    }
    const normalized = normalizeTerminalTabName(dialogInput.value);
    if (!normalized.ok) { messages.text(dialogError, normalized.error); return; }
    const tab = tabs.find((item) => item.id === namingTabId);
    if (tab) {
      generatedNames.delete(tab.id);
      replaceTab({ ...tab, name: normalized.name });
    }
    dialogElement.hidden = true;
    render();
  };
  const onDocumentPointer = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (!target.closest(".terminal-tab-context")) contextElement.hidden = true;
    if (!target.closest(".terminal-layout-wrap")) {
      layoutMenuOpen = false;
      menuElement.classList.remove("open");
      menuTrigger.classList.remove("on");
    }
  };
  const onDocumentKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.isComposing || (event.target as HTMLElement | null)?.closest(".xterm")) return;
    // Claim the press only when an inner layer actually closed: an unclaimed Esc is
    // handed to the Host's single-Esc order (surface.escape@1) to go back one level.
    if (!dialogElement.hidden) dialogElement.hidden = true;
    else if (!contextElement.hidden) contextElement.hidden = true;
    else if (layoutMenuOpen) {
      layoutMenuOpen = false;
      menuElement.classList.remove("open");
      menuTrigger.classList.remove("on");
    } else return;
    event.preventDefault();
  };
  try {
    const existing = await terminalClient.list();
    if (existing.length === 0) {
      const info = await terminalClient.create({ rows: 24, cols: 80 });
      await createView(info);
      const tab = createTerminalTab(uniqueId("tab"), messages.t("defaultTab", { number: nextTabNumber++ }), paneFromSession(info));
      generatedNames.set(tab.id, { key: "defaultTab", params: { number: nextTabNumber - 1 } });
      tabs = [tab];
      activeTabId = tab.id;
    } else {
      const results = await Promise.allSettled(existing.map(createView));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const [first, ...rest] = existing;
      let recovered = createTerminalTab(uniqueId("tab"), messages.t("recovered"), paneFromSession(first!));
      for (const info of rest) {
        const target = flattenTerminalPaneIds(recovered.root).at(-1)!;
        recovered = splitTerminalPane(recovered, target, paneFromSession(info), "horizontal");
      }
      generatedNames.set(recovered.id, { key: "recovered", params: {} });
      tabs = [recovered];
      activeTabId = recovered.id;
      nextTabNumber = 2;
    }
    render();
  } catch (error) {
    disposed = true;
    stopPreferences();
    layoutObservers.forEach(observer => observer.disconnect());
    await Promise.all([...views.values()].map(async view => {
      view.observer.disconnect();
      view.disposables.forEach(item => item.dispose());
      view.terminal.dispose();
      await terminalClient.detach(view.info.id, view.token).catch(() => undefined);
    }));
    views.clear();
    statusElement.remove();
    root.replaceChildren();
    throw error;
  }
  document.addEventListener("pointerdown", onDocumentPointer);
  document.addEventListener("keydown", onDocumentKey);
  const stopLocale = messages.subscribe(() => {
    messages.update(root);
    Terminal.strings.promptLabel = messages.t("terminalInput");
    Terminal.strings.tooMuchOutput = messages.t("terminalOutputLimit");
    for (const view of views.values()) view.terminal.textarea?.setAttribute("aria-label", Terminal.strings.promptLabel);
    if (toastMessage) toastText.textContent = toastMessage();
    tabsElement.querySelectorAll<HTMLElement>("[data-tab-id]").forEach(shell => {
      const tab = tabs.find(item => item.id === shell.dataset.tabId);
      if (!tab) return;
      shell.querySelector<HTMLElement>(".terminal-tab-name")!.textContent = tabName(tab);
      messages.text(shell, "renameHint", { name: tabName(tab) }, "title");
      messages.text(shell.querySelector<HTMLElement>(".terminal-tab-close")!, "closeNamed", { name: tabName(tab) }, "aria-label");
    });
    for (const tab of tabs) for (const pane of Object.values(tab.panes)) {
      const view = views.get(pane.sessionId);
      if (!view) continue;
      const label = paneLabel(tab, pane.id);
      for (const node of view.element.querySelectorAll<HTMLElement>(".terminal-compact-title, .terminal-pane-title")) node.textContent = label;
      const compact = view.element.querySelector<HTMLElement>(".terminal-compact-face");
      if (compact) {
        compact.title = messages.t("expandPane", { number: pane.number, name: label });
        compact.setAttribute("aria-label", compact.title);
      }
      if (!pane.cwd) {
        const path = view.element.querySelector<HTMLElement>(".terminal-pane-path");
        if (path) path.textContent = messages.t("defaultDirectory");
      }
    }
    messages.update(statusElement);
    const tab = activeTab();
    const activeLabel = statusElement.querySelector<HTMLElement>(".terminal-active-label");
    if (tab && activeLabel) activeLabel.textContent = paneLabel(tab, tab.activePaneId);
  });

  return {
    accept(event) {
      const view = views.get(event.sessionId);
      if (!view || view.token !== event.attachmentToken) return;
      if (event.kind === "output") view.terminal.write(decodeBase64(event.dataBase64));
      else if (event.kind === "output_lost") {
        showMessage(() => messages.t("outputLost"));
        const info = view.info;
        void terminalClient.detach(info.id, view.token)
          .catch(() => undefined)
          .then(() => { disposeView(info.id, false); return createView(info); })
          .then(() => { clearMessage(); render(); })
          .catch((cause) => showMessage(() => messages.t("syncFailed", { error: String(cause) })));
      } else if (event.kind === "closed") removeClosedSession(event.sessionId);
    },
    async restartActive() {
      const tab = activeTab();
      if (tab) await restartPane(tab.id, tab.activePaneId);
    },
    async stopActive() {
      const tab = activeTab();
      if (tab) await closePane(tab.id, tab.activePaneId);
    },
    showFooter(visible) {
      if (!footer) return;
      if (visible) footer.append(statusElement);
      else statusParent.append(statusElement);
    },
    refresh() {
      render();
      queueMicrotask(() => {
        for (const view of views.values()) fitAndResize(view);
      });
    },
    async dispose() {
      disposed = true;
      stopPreferences();
      stopLocale();
      document.removeEventListener("pointerdown", onDocumentPointer);
      document.removeEventListener("keydown", onDocumentKey);
      layoutObservers.forEach((observer) => observer.disconnect());
      layoutObservers.clear();
      await Promise.all([...views.values()].map(async (view) => {
        view.observer.disconnect();
        view.disposables.forEach((item) => item.dispose());
        view.terminal.dispose();
        await terminalClient.detach(view.info.id, view.token).catch(() => undefined);
      }));
      views.clear();
      statusElement.remove();
      root.replaceChildren();
    },
  };
}
