import { createSurfaceLayout, type ResourceRoot, type ResourceStat } from "@reai/app-sdk/v1";
import { FILE_LIMITS, parseProjectId, validName } from "./adapter";
import type { FilesController, FilesSnapshot, Operation } from "./controller";
import { createTranslator } from "./i18n";
import { installFilesStyles } from "./styles";

export type FilesViewController = Pick<FilesController,
  "getSnapshot" | "subscribe" | "init" | "addRoot" | "openRoot" | "removeRoot" | "openEntry" | "goTo" | "up" | "refresh" | "loadMore"
  | "openText" | "edit" | "closeDraft" | "save" | "reloadFromDisk" | "saveAs" | "discardRecovered" | "createFile" | "createFolder"
  | "rename" | "remove" | "startImport" | "startExport" | "closeChooser" | "chooserOpenRoot" | "chooserPickFolder" | "chooserOpen"
  | "chooserGoTo" | "chooserLoadMore" | "exportHere" | "cancel" | "openCloudPicker" | "closeCloudPicker" | "loadProjects" | "attachCloud">;
export interface FilesViewOptions { locale: string; pluginVersion: string }

type NamePurpose = "newFile" | "newFolder" | "rename" | "saveAs";
type Dialog =
  | { kind: "name"; purpose: NamePurpose; value: string; item?: ResourceStat; touched: boolean }
  | { kind: "confirm"; purpose: "delete" | "deleteCloud" | "removeRoot" | "removeCloud" | "discard"; name: string; then: () => void };

const SPINNER_DELAY_MS = 400;
/** Errors after which re-reading the folder is the right next step (cloud outcome unknown). */
const REFRESH_CODES = new Set(["CLOUD_OUTCOME_UNKNOWN", "CLOUD_UNREACHABLE", "CLOUD_UNAVAILABLE", "CLOUD_IO_FAILED", "CLOUD_LOGIN_TEMPORARY"]);
const isCloud = (root: ResourceRoot | null | undefined) => root?.resource.resource.provider === "cloud-project";
const ICONS = {
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6z M14 2v6h6",
  up: "M12 19V5 M5 12l7-7 7 7",
  x: "M18 6 6 18 M6 6l12 12",
  cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z",
  busy: "M21 12a9 9 0 1 1-9-9",
  chevron: "m9 18 6-6-6-6",
} as const;

/** Owns plugin DOM only; every file action goes through the injected controller. */
export function createFilesView(root: HTMLElement, controller: FilesViewController, options: FilesViewOptions) {
  const document = root.ownerDocument;
  const translator = createTranslator(options.locale);
  const t = translator.t;
  const removeStyles = installFilesStyles(document);
  const layout = createSurfaceLayout(root);
  layout.frame.classList.add("files-app");
  layout.body.classList.add("files-main");
  let state = controller.getSnapshot();
  let disposed = false;
  let dialog: Dialog | null = null;
  let dialogSignature = "";
  let returnFocusKey: string | undefined;
  let clickedKey: string | undefined;
  let chaining = false;
  let pendingFocusKey: string | undefined;
  /** Text in the "Project ID or link" field; kept across renders, cleared when the panel closes. */
  let cloudInput = "";
  let cloudInputTouched = false;
  function settleFocus() {
    if (!pendingFocusKey || busy() || !dialogLayer.hidden) return;
    const key = pendingFocusKey; pendingFocusKey = undefined;
    const target = stack.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(key)}"]`);
    // If the trigger is gone (e.g. its file was deleted), fall back to the next sensible control.
    const fallback = target && !target.disabled ? target : stack.querySelector<HTMLElement>(".files-row:not(:disabled), [data-key=\"newFile\"]:not(:disabled), [data-key=\"addRoot\"]:not(:disabled)");
    fallback?.focus({ preventScroll: true });
  }
  let diagnostics = { developerMode: false, hostVersion: "" };

  const stack = el("div", "files-stack");
  const toolbar = el("section", "files-toolbar");
  const status = el("div", "files-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const recoveredArea = el("div");
  const content = el("div", "files-content");
  stack.append(toolbar, status, recoveredArea, content);
  const dialogLayer = el("div", "files-dialog-layer"); dialogLayer.hidden = true;
  layout.body.append(stack);
  // Anchored to the frame below the Host title bar, so it covers the visible body even when scrolled.
  layout.frame.append(dialogLayer);

  // Persistent editor node: keeps caret, selection and IME composition across renders.
  const editor = el("textarea", "files-editor");
  editor.spellcheck = false;
  editor.dataset.key = "editor";
  editor.addEventListener("input", () => {
    if (disposed) return;
    if (new TextEncoder().encode(editor.value).byteLength > FILE_LIMITS.maxReadBytes || !controller.edit(editor.value)) {
      editor.value = state.draft?.text ?? "";
    }
  });
  const recoveredText = el("textarea", "files-editor files-recovered-text");
  recoveredText.readOnly = true;

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function svg(name: keyof typeof ICONS, extra = "") {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("class", `files-icon ${extra}`.trim());
    node.setAttribute("viewBox", "0 0 24 24");
    node.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICONS[name]);
    node.append(path);
    return node;
  }
  function busy() { return state.busy !== null; }
  function button(key: string, label: string, onClick: () => void, opts: { primary?: boolean; op?: Operation | Operation[]; disabled?: boolean; icon?: keyof typeof ICONS; iconOnly?: boolean } = {}) {
    const node = el("button", opts.iconOnly ? "files-icon-btn" : `files-btn${opts.primary ? " files-btn-primary" : ""}`);
    node.type = "button"; node.dataset.key = key; node.dataset.action = key;
    const ops = opts.op === undefined ? [] : Array.isArray(opts.op) ? opts.op : [opts.op];
    const running = state.busy && ops.includes(state.busy.operation);
    if (opts.icon) node.append(svg(opts.icon));
    if (opts.iconOnly) node.setAttribute("aria-label", label);
    else node.append(document.createTextNode(running ? `${t(`operation.${state.busy!.operation}`)}…` : label));
    node.disabled = busy() || !!opts.disabled;
    // WKWebView may not focus a clicked button: record the trigger from the click itself.
    node.addEventListener("click", () => { if (!node.disabled && !disposed) { clickedKey = key; try { onClick(); } finally { clickedKey = undefined; } } });
    return node;
  }
  function act(action: () => Promise<unknown> | unknown) { void Promise.resolve(action()).catch(() => undefined); }
  function rememberFocus() {
    if (chaining || dialog || state.chooser || state.cloudPicker) return; // keep the original trigger across chained dialogs
    const active = document.activeElement as HTMLElement | null;
    const key = clickedKey ?? (active && !dialogLayer.contains(active) ? active.dataset?.key : undefined);
    if (key) returnFocusKey = key;
  }
  function guardDraft(next: () => void) {
    const draft = state.draft;
    if (draft?.dirty) { openDialog({ kind: "confirm", purpose: "discard", name: draft.base.name, then: next }); return; }
    next();
  }
  function bytes(value: number) {
    const format = new Intl.NumberFormat(translator.locale === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 1 });
    if (value < 1024) return t("file.bytes", { count: format.format(value) });
    if (value < 1024 * 1024) return t("file.kib", { count: format.format(value / 1024) });
    return t("file.mib", { count: format.format(value / 1024 / 1024) });
  }
  function time(ms: number | undefined) {
    if (ms === undefined) return "";
    return new Intl.DateTimeFormat(translator.locale === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(ms);
  }
  function meta(item: ResourceStat) {
    if (item.kind === "directory") return t("file.directory");
    return [bytes(item.sizeBytes), item.modifiedAtMs !== undefined ? t("file.modified", { time: time(item.modifiedAtMs) }) : ""].filter(Boolean).join(" · ");
  }
  function cleanKey() { return isCloud(state.root) ? "file.cleanCloud" : "file.clean"; }
  function same(a: ResourceStat | null, b: ResourceStat) { return !!a && JSON.stringify(a.resource) === JSON.stringify(b.resource); }

  // ---- regions -----------------------------------------------------------------------
  function renderToolbar() {
    toolbar.replaceChildren();
    const row = el("div", "files-toolbar-row");
    const label = el("span", "files-label", t("toolbar.folders"));
    const chips = el("div", "files-chips"); chips.setAttribute("role", "group"); chips.setAttribute("aria-label", t("toolbar.folders"));
    for (const item of state.roots) {
      const active = state.root?.resource.grantRef === item.resource.grantRef;
      const chip = el("div", `files-chip${active ? " is-active" : ""}`);
      const open = button(`root:${item.resource.grantRef}`, item.name, () => guardDraft(() => act(() => controller.openRoot(item))), { icon: isCloud(item) ? "cloud" : "folder" });
      open.classList.add("files-chip-main"); open.setAttribute("aria-pressed", String(active));
      const remove = button(`remove:${item.resource.grantRef}`, t(isCloud(item) ? "toolbar.removeCloud" : "toolbar.removeFolder", { name: item.name }), () => openDialog({ kind: "confirm", purpose: isCloud(item) ? "removeCloud" : "removeRoot", name: item.name, then: () => act(() => controller.removeRoot(item)) }), { icon: "x", iconOnly: true });
      chip.append(open, remove); chips.append(chip);
    }
    const add = button("addRoot", t("toolbar.addFolder"), () => guardDraft(() => act(() => controller.addRoot())), { op: "pick", disabled: state.availability !== "ready" });
    let cloud: HTMLButtonElement;
    if (state.cloudSupported) {
      cloud = button("cloud", t("toolbar.connectCloud"), () => guardDraft(() => { rememberFocus(); cloudInput = ""; cloudInputTouched = false; controller.openCloudPicker(); }), { icon: "cloud", op: ["projects", "attach"], disabled: state.availability !== "ready" });
      cloud.classList.add("files-cloud");
    } else {
      // This Host cannot attach cloud Projects: visible slot, never fake data.
      cloud = el("button", "files-btn files-cloud"); cloud.type = "button"; cloud.disabled = true; cloud.dataset.key = "cloud";
      cloud.append(svg("cloud"), document.createTextNode(`${t("toolbar.cloud")} · ${t("toolbar.cloudUnavailable")}`));
    }
    row.append(label, chips, add, cloud);
    toolbar.append(row);
    if (state.availability === "ready") toolbar.append(el("p", "files-muted", t("toolbar.persistHint")));
  }
  function renderStatus() {
    status.replaceChildren();
    status.dataset.tone = "neutral";
    const b = state.busy;
    if (b) {
      const elapsed = Math.floor((Date.now() - b.startedAt) / 1000);
      const line = el("div", "files-status-line");
      if (Date.now() - b.startedAt >= SPINNER_DELAY_MS || b.operation !== "list") line.append(svg("busy", "files-spinner"));
      line.append(el("span", "", t(`operation.${b.operation}`)));
      const detail = [b.progress ? t("operation.progress", { done: bytes(b.progress.done), total: bytes(b.progress.total) }) : "", elapsed >= 1 ? t("operation.elapsed", { seconds: elapsed }) : ""].filter(Boolean).join(" · ");
      if (detail) line.append(el("span", "files-muted", detail));
      if (b.cancellable) line.append(button("cancel", t("actions.cancelTransfer"), () => act(() => controller.cancel())));
      const cancelButton = line.querySelector<HTMLButtonElement>('[data-key="cancel"]'); if (cancelButton) cancelButton.disabled = false;
      status.append(line);
      return;
    }
    if (state.error && !state.conflict) {
      status.dataset.tone = "error";
      const code = state.error.code;
      const key = `errors.${code}`;
      status.append(el("strong", "", t("errors.title")), el("p", "", translator.has(key) ? t(key) : t("errors.unknown")));
      if (REFRESH_CODES.has(code) && state.trail.length) {
        const row = el("div", "files-actions");
        row.append(button("errorRefresh", t("actions.refresh"), () => act(() => controller.refresh()), { op: "list" }));
        status.append(row);
      }
      if (diagnostics.developerMode) status.append(el("p", "files-muted files-diagnostic", `${t("diagnostics.code", { code })}${state.error.detail ? ` · ${state.error.detail}` : ""} · ${versions()}`));
      return;
    }
    if (state.notice) {
      status.dataset.tone = state.notice.kind === "revoked" ? "warn" : "success";
      status.append(el("p", "", t(`notice.${state.notice.kind}`, { name: state.notice.name ?? "" })));
      return;
    }
    status.hidden = true;
  }
  function versions() { return t("diagnostics.versions", { plugin: options.pluginVersion, host: diagnostics.hostVersion || t("diagnostics.hostPending") }); }
  function renderRecovered() {
    recoveredArea.replaceChildren();
    const recovered = state.recovered;
    if (!recovered) return;
    const card = el("section", "files-card files-recovered"); card.dataset.recovered = "";
    card.append(el("h2", "", t("recovered.title")), el("p", "files-muted", t("recovered.detail", { name: recovered.name })));
    if (recoveredText.value !== recovered.text) recoveredText.value = recovered.text;
    recoveredText.setAttribute("aria-label", t("recovered.title"));
    const actions = el("div", "files-actions");
    const canSave = state.trail.length > 0 && !state.draft;
    actions.append(
      button("saveRecovered", t("actions.saveRecovered"), () => openDialog({ kind: "name", purpose: "saveAs", value: recovered.name, touched: false }), { op: "saveAs", disabled: !canSave }),
      button("discardRecovered", t("actions.discardRecovered"), () => controller.discardRecovered()),
    );
    card.append(recoveredText, actions);
    if (!canSave) card.append(el("p", "files-muted", t("recovered.needFolder")));
    recoveredArea.append(card);
  }
  function statePanel(title: string, detail: string, actions: HTMLElement[] = [], showVersion = false) {
    const panel = el("section", "files-card files-empty-state"); panel.dataset.state = state.availability;
    panel.append(el("h2", "", title), el("p", "files-muted", detail));
    if (actions.length) { const row = el("div", "files-actions"); row.append(...actions); panel.append(row); }
    // Versions are technical diagnostics: shown only in Host developer mode (design §6.0).
    if (showVersion && diagnostics.developerMode) panel.append(el("p", "files-muted files-version", versions()));
    return panel;
  }
  function renderContent() {
    content.replaceChildren();
    switch (state.availability) {
      case "checking":
        content.append(statePanel(t("state.checking"), "", [], true)); return;
      case "notOpen":
        content.append(statePanel(t("state.notOpenTitle"), t("state.notOpenDetail"), [], true)); return;
      case "notAuthorized":
        content.append(statePanel(t("state.notAuthorizedTitle"), t("state.notAuthorizedDetail"), [button("recheck", t("actions.recheck"), () => act(() => controller.init()), { op: "roots" })], true)); return;
      case "stale":
        content.append(statePanel(t("state.staleTitle"), t("state.staleDetail"), [], true)); return;
    }
    if (state.roots.length === 0) {
      content.append(statePanel(t("state.noRootsTitle"), t("state.noRootsDetail"), [button("chooseFolder", t("actions.chooseFolder"), () => guardDraft(() => act(() => controller.addRoot())), { primary: true, op: "pick" })]));
      return;
    }
    if (!state.root) { content.append(statePanel(t("state.chooseRootTitle"), t("state.chooseRootDetail"))); return; }

    const pathBar = el("nav", "files-path"); pathBar.setAttribute("aria-label", t("path.label"));
    pathBar.append(button("up", t("path.up"), () => guardDraft(() => act(() => controller.up())), { icon: "up", iconOnly: true, disabled: state.trail.length < 2 }));
    const crumbs = el("ol", "files-crumbs");
    state.trail.forEach((crumb, index) => {
      const li = el("li");
      if (index > 0) li.append(svg("chevron", "files-crumb-sep"));
      if (index === state.trail.length - 1) { const current = el("span", "files-crumb-current", crumb.name); current.setAttribute("aria-current", "location"); li.append(current); }
      else { const link = button(`crumb:${index}`, crumb.name, () => guardDraft(() => act(() => controller.goTo(index)))); link.className = "files-crumb"; li.append(link); }
      crumbs.append(li);
    });
    pathBar.append(crumbs);

    const cloudRoot = isCloud(state.root);
    const actions = el("div", "files-actions files-folder-actions");
    actions.append(
      button("newFile", t("actions.newFile"), () => guardDraft(() => openDialog({ kind: "name", purpose: "newFile", value: "", touched: false })), { op: "createFile" }),
      button("newFolder", t("actions.newFolder"), () => openDialog({ kind: "name", purpose: "newFolder", value: "", touched: false }), { op: "createFolder" }),
      button("import", t(cloudRoot ? "actions.upload" : "actions.import"), () => guardDraft(() => { rememberFocus(); controller.startImport(); }), { op: "import" }),
      button("refresh", t("actions.refresh"), () => act(() => controller.refresh()), { op: "list" }),
    );

    const columns = el("div", "files-columns");
    columns.append(renderList(), renderDetail());
    content.append(pathBar, actions, columns);
  }
  function renderList() {
    const card = el("section", "files-card files-list-card");
    card.setAttribute("aria-label", state.trail.at(-1)?.name ?? "");
    if (state.items.length === 0) {
      const empty = el("div", "files-empty");
      empty.append(el("p", "files-empty-title", t("state.emptyFolderTitle")), el("p", "files-muted", t("state.emptyFolderDetail")));
      card.append(empty);
      return card;
    }
    const list = el("ul", "files-list");
    for (const item of state.items) {
      const li = el("li");
      const row = button(`entry:${JSON.stringify(item.resource)}`, "", () => guardDraft(() => act(() => controller.openEntry(item))));
      row.className = "files-row"; row.replaceChildren();
      row.setAttribute("aria-pressed", String(same(state.selected, item)));
      const text = el("span", "files-row-text");
      text.append(el("span", "files-row-name", item.name), el("span", "files-muted", meta(item)));
      row.append(svg(item.kind === "directory" ? "folder" : "file"), text);
      li.append(row); list.append(li);
    }
    card.append(list);
    if (state.nextCursor) { const more = el("div", "files-actions"); more.append(button("loadMore", t("actions.loadMore"), () => act(() => controller.loadMore()), { op: "list" })); card.append(more); }
    return card;
  }
  function renderDetail() {
    const card = el("section", "files-card files-detail");
    const selected = state.selected;
    if (!selected) {
      const empty = el("div", "files-empty");
      empty.append(el("p", "files-empty-title", t("state.noSelectionTitle")), el("p", "files-muted", t("state.noSelectionDetail")));
      card.append(empty);
      return card;
    }
    card.append(el("h2", "files-title-name", selected.name), el("p", "files-muted", meta(selected)));
    const draft = state.draft;
    const actions = el("div", "files-actions");
    const tooLarge = selected.sizeBytes > FILE_LIMITS.maxReadBytes;
    if (!draft) actions.append(button("openText", t("actions.openText"), () => act(() => controller.openText()), { op: "read", disabled: tooLarge }));
    actions.append(
      button("export", t(isCloud(state.root) ? "actions.download" : "actions.export"), () => { rememberFocus(); controller.startExport(); }, { op: "export", disabled: !!draft?.dirty }),
      button("rename", t("actions.rename"), () => openDialog({ kind: "name", purpose: "rename", value: selected.name, item: selected, touched: false }), { op: "rename", disabled: !!draft?.dirty }),
      button("delete", t("actions.delete"), () => openDialog({ kind: "confirm", purpose: isCloud(state.root) ? "deleteCloud" : "delete", name: selected.name, then: () => act(() => controller.remove(selected)) }), { op: "delete", disabled: !!draft?.dirty }),
    );
    card.append(actions);
    if (tooLarge && !draft) card.append(el("p", "files-muted", t("file.tooLargeToEdit")));
    if (!draft) return card;

    const label = el("label", "files-editor-label", t("file.editorLabel", { name: draft.base.name }));
    editor.id = "files-editor"; label.htmlFor = editor.id;
    if (editor.value !== draft.text) editor.value = draft.text;
    editor.disabled = busy();
    const meta2 = el("p", "files-muted files-draft-state", `${t(draft.dirty ? "file.dirty" : cleanKey())} · ${t("file.editorLimit")}`);
    card.append(label, editor, meta2);
    if (state.conflict) {
      const box = el("div", "files-conflict"); box.dataset.conflict = "";
      box.append(el("strong", "", t("conflict.title")), el("p", "", t(isCloud(state.root) ? "conflict.detailCloud" : "conflict.detail")));
      const row = el("div", "files-actions");
      row.append(
        button("reload", t("actions.reload"), () => act(() => controller.reloadFromDisk()), { op: "reload" }),
        button("saveAs", t("actions.saveAs"), () => openDialog({ kind: "name", purpose: "saveAs", value: draft.base.name, touched: false }), { op: "saveAs", primary: true }),
      );
      box.append(row); card.append(box);
      return card;
    }
    const row = el("div", "files-actions");
    row.append(
      button("save", t("actions.save"), () => act(() => controller.save()), { op: "save", primary: draft.dirty, disabled: !draft.dirty }),
      button("closeEditor", t("actions.closeEditor"), () => guardDraft(() => controller.closeDraft())),
    );
    card.append(row);
    return card;
  }
  function renderChooser() {
    const chooser = state.chooser;
    const panel = el("section", "files-dialog files-chooser"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true");
    const title = chooser!.mode === "import" ? t("dialog.importTitle") : t("dialog.exportTitle", { name: state.selected?.name ?? "" });
    panel.setAttribute("aria-label", title);
    const head = el("div", "files-dialog-head");
    head.append(el("h2", "", title), button("closeChooser", t("common.close"), () => controller.closeChooser(), { icon: "x", iconOnly: true }));
    panel.append(head, el("p", "files-muted", chooser!.mode === "import" ? t("dialog.importDetail", { name: state.trail.at(-1)?.name ?? "" }) : t("dialog.exportDetail")));
    const roots = el("div", "files-chips");
    for (const item of state.roots) {
      const isCurrent = item.resource.grantRef === state.root?.resource.grantRef;
      const chip = button(`chooserRoot:${item.resource.grantRef}`, isCurrent ? `${item.name} ${t("dialog.sameFolder")}` : item.name, () => act(() => controller.chooserOpenRoot(item)), { icon: isCloud(item) ? "cloud" : "folder" });
      chip.classList.add("files-chip-solo"); chip.setAttribute("aria-pressed", String(chooser!.root?.resource.grantRef === item.resource.grantRef));
      roots.append(chip);
    }
    roots.append(button("chooserPick", t("actions.chooseOtherFolder"), () => act(() => controller.chooserPickFolder()), { op: "pick" }));
    panel.append(roots);
    if (state.roots.length <= 1) panel.append(el("p", "files-muted", t("dialog.chooserNoRoots")));
    if (chooser!.root) {
      const crumbs = el("ol", "files-crumbs");
      chooser!.trail.forEach((crumb, index) => {
        const li = el("li"); if (index > 0) li.append(svg("chevron", "files-crumb-sep"));
        if (index === chooser!.trail.length - 1) li.append(el("span", "files-crumb-current", crumb.name));
        else { const link = button(`chooserCrumb:${index}`, crumb.name, () => act(() => controller.chooserGoTo(index))); link.className = "files-crumb"; li.append(link); }
        crumbs.append(li);
      });
      panel.append(crumbs);
      const list = el("ul", "files-list files-chooser-list");
      for (const item of chooser!.items) {
        const li = el("li");
        const isFile = item.kind === "file";
        const row = button(`chooserEntry:${JSON.stringify(item.resource)}`, "", () => act(() => controller.chooserOpen(item)), { disabled: isFile && chooser!.mode === "export" });
        row.className = "files-row"; row.replaceChildren();
        const text = el("span", "files-row-text"); text.append(el("span", "files-row-name", item.name), el("span", "files-muted", meta(item)));
        row.append(svg(isFile ? "file" : "folder"), text); li.append(row); list.append(li);
      }
      if (!chooser!.items.length) panel.append(el("p", "files-muted", t("dialog.chooserEmpty")));
      else panel.append(list);
      const row = el("div", "files-actions");
      if (chooser!.nextCursor) row.append(button("chooserMore", t("actions.loadMore"), () => act(() => controller.chooserLoadMore()), { op: "list" }));
      if (chooser!.mode === "export") row.append(button("copyHere", t("actions.copyHere"), () => act(() => controller.exportHere()), { primary: true, op: "export" }));
      panel.append(row);
    }
    if (state.busy) {
      const progress = el("div", "files-status"); progress.dataset.tone = "neutral";
      const line = el("div", "files-status-line");
      line.append(svg("busy", "files-spinner"), el("span", "", t(`operation.${state.busy.operation}`)));
      const elapsed = Math.floor((Date.now() - state.busy.startedAt) / 1000);
      const detail = [state.busy.progress ? t("operation.progress", { done: bytes(state.busy.progress.done), total: bytes(state.busy.progress.total) }) : "", elapsed >= 1 ? t("operation.elapsed", { seconds: elapsed }) : ""].filter(Boolean).join(" · ");
      const detailNode = el("span", "files-muted files-chooser-detail", detail); detailNode.hidden = !detail;
      line.append(detailNode);
      if (state.busy.cancellable) {
        const cancel = button("chooserCancel", t("actions.cancelTransfer"), () => act(() => controller.cancel()));
        cancel.disabled = false; line.append(cancel);
      }
      progress.append(line); panel.append(progress);
    }
    else if (state.error) { const err = el("div", "files-status"); err.dataset.tone = "error"; const key = `errors.${state.error.code}`; err.textContent = translator.has(key) ? t(key) : t("errors.unknown"); panel.append(err); }
    return panel;
  }
  function busyLine() {
    const progress = el("div", "files-status"); progress.dataset.tone = "neutral";
    const line = el("div", "files-status-line");
    line.append(svg("busy", "files-spinner"), el("span", "", t(`operation.${state.busy!.operation}`)));
    const elapsed = Math.floor((Date.now() - state.busy!.startedAt) / 1000);
    const detail = [state.busy!.progress ? t("operation.progress", { done: bytes(state.busy!.progress.done), total: bytes(state.busy!.progress.total) }) : "", elapsed >= 1 ? t("operation.elapsed", { seconds: elapsed }) : ""].filter(Boolean).join(" · ");
    const detailNode = el("span", "files-muted files-chooser-detail", detail); detailNode.hidden = !detail;
    line.append(detailNode);
    progress.append(line);
    return progress;
  }
  function renderCloudPicker() {
    const picker = state.cloudPicker!;
    const title = t("cloud.title");
    const panel = el("section", "files-dialog files-cloud-picker"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", title);
    const head = el("div", "files-dialog-head");
    head.append(el("h2", "", title), button("closeCloud", t("common.close"), () => controller.closeCloudPicker(), { icon: "x", iconOnly: true }));
    panel.append(head, el("p", "files-muted", t("cloud.detail")));
    // 1) Projects the plugin can list with its own cloud connection.
    const section = el("div", "files-cloud-section");
    if (picker.listing === "loading") { if (state.busy?.operation !== "projects") section.append(el("p", "files-muted", t("cloud.listing"))); }
    else if (picker.listing === "unavailable") section.append(el("p", "files-muted", t("cloud.listUnavailable")));
    else if (picker.listing === "failed") {
      const key = `cloud.listErrors.${picker.listError}`;
      const box = el("div", "files-status"); box.dataset.tone = "warn"; box.setAttribute("role", "alert");
      box.append(el("p", "", translator.has(key) ? t(key) : t("cloud.listErrors.PROJECTS_UNREACHABLE")));
      const row = el("div", "files-actions"); row.append(button("retryProjects", t("common.retry"), () => act(() => controller.loadProjects()), { op: "projects" }));
      box.append(row); section.append(box);
    } else if (!picker.projects.length) section.append(el("p", "files-muted", t("cloud.noProjects")));
    else {
      const list = el("ul", "files-list files-chooser-list");
      for (const project of picker.projects) {
        const li = el("li");
        const row = button(`project:${project.id}`, "", () => act(() => controller.attachCloud(project.id)));
        row.className = "files-row"; row.replaceChildren();
        const text = el("span", "files-row-text");
        text.append(el("span", "files-row-name", project.name));
        if (project.description) text.append(el("span", "files-muted", project.description));
        row.append(svg("cloud"), text); li.append(row); list.append(li);
      }
      section.append(list);
    }
    panel.append(section);
    // 2) Always available: type a Project ID or paste a Project link.
    const form = el("form", "files-cloud-manual");
    const input = el("input", "files-input"); input.type = "text"; input.id = "files-cloud-input"; input.dataset.key = "cloudInput";
    input.autocomplete = "off"; input.spellcheck = false; input.value = cloudInput; input.placeholder = t("cloud.inputPlaceholder");
    const label = el("label", "files-editor-label", t("cloud.inputLabel")); label.htmlFor = input.id;
    const hint = el("p", "files-field-error", t("cloud.inputInvalid")); hint.hidden = !cloudInputTouched || parseProjectId(cloudInput) !== null;
    const connect = button("attachCloud", t("cloud.connect"), () => submit(), { primary: true, op: "attach", disabled: parseProjectId(cloudInput) === null });
    connect.type = "submit";
    input.addEventListener("input", () => {
      cloudInput = input.value; cloudInputTouched = true;
      const valid = parseProjectId(cloudInput) !== null;
      hint.hidden = valid; connect.disabled = !valid || busy();
    });
    function submit() {
      if (busy()) return;
      if (parseProjectId(cloudInput) === null) { cloudInputTouched = true; hint.hidden = false; return; }
      act(() => controller.attachCloud(cloudInput));
    }
    form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
    const row = el("div", "files-actions"); row.append(connect);
    form.append(label, input, hint, el("p", "files-muted", t("cloud.inputHelp")), row);
    panel.append(form);
    if (state.busy) { const line = busyLine(); line.setAttribute("role", "status"); panel.append(line); }
    else if (state.error?.operation === "attach") {
      const err = el("div", "files-status"); err.dataset.tone = "error"; err.setAttribute("role", "alert");
      const key = `errors.${state.error.code}`;
      err.append(el("p", "", translator.has(key) ? t(key) : t("errors.unknown")));
      if (diagnostics.developerMode) err.append(el("p", "files-muted files-diagnostic", `${t("diagnostics.code", { code: state.error.code })}${state.error.detail ? ` · ${state.error.detail}` : ""}`));
      panel.append(err);
    }
    return panel;
  }
  function renderDialog() {
    const signature = JSON.stringify([state.chooser, state.cloudPicker, diagnostics.developerMode, dialog && { ...dialog, then: undefined, value: undefined }, state.busy?.operation ?? null, state.busy?.progress ?? null, state.busy?.cancellable ?? null, state.error, state.roots, translator.locale]);
    if (signature === dialogSignature) return;
    dialogSignature = signature;
    const restore = document.activeElement as HTMLElement | null;
    const restoreKey = restore && dialogLayer.contains(restore) ? restore.dataset.key : undefined;
    const inputSelection = restore instanceof HTMLInputElement ? [restore.selectionStart, restore.selectionEnd, restore.selectionDirection] as const : null;
    const wasHidden = dialogLayer.hidden;
    const scrolls = { layer: dialogLayer.scrollTop, list: dialogLayer.querySelector(".files-chooser-list")?.scrollTop ?? 0 };
    dialogLayer.replaceChildren();
    if (state.chooser) { dialogLayer.hidden = false; dialogLayer.append(renderChooser()); }
    else if (state.cloudPicker) { dialogLayer.hidden = false; dialogLayer.append(renderCloudPicker()); }
    else if (dialog) { dialogLayer.hidden = false; dialogLayer.append(dialog.kind === "name" ? nameDialog(dialog) : confirmDialog(dialog)); }
    else {
      dialogLayer.hidden = true;
      stack.inert = false;
      // Return focus to the control that opened the dialog (design §5).
      const key = returnFocusKey; returnFocusKey = undefined;
      // The follow-up operation may still be running (trigger disabled): finish the return once idle.
      if (!wasHidden && key) pendingFocusKey = key;
      return;
    }
    dialogLayer.scrollTop = scrolls.layer;
    const list = dialogLayer.querySelector<HTMLElement>(".files-chooser-list"); if (list) list.scrollTop = scrolls.list;
    // A control that just turned disabled (busy) cannot hold focus: fall back inside the dialog.
    const restored = restoreKey ? dialogLayer.querySelector<HTMLElement>(`[data-key="${CSS.escape(restoreKey)}"]`) : null;
    const usable = (node: HTMLElement | null) => !!node && !(node as HTMLButtonElement).disabled;
    const target = (usable(restored) ? restored : null) || dialogLayer.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)");
    target?.focus({ preventScroll: true });
    if (inputSelection && target instanceof HTMLInputElement) {
      try { target.setSelectionRange(inputSelection[0], inputSelection[1], inputSelection[2] ?? "none"); } catch { /* value changed */ }
    }
  }
  function nameDialog(current: Extract<Dialog, { kind: "name" }>) {
    const titles: Record<NamePurpose, string> = { newFile: t("dialog.newFileTitle"), newFolder: t("dialog.newFolderTitle"), rename: t("dialog.renameTitle", { name: current.item?.name ?? "" }), saveAs: t("dialog.saveAsTitle") };
    const form = el("form", "files-dialog"); form.setAttribute("role", "dialog"); form.setAttribute("aria-modal", "true"); form.setAttribute("aria-label", titles[current.purpose]);
    const input = el("input", "files-input"); input.type = "text"; input.value = current.value; input.dataset.key = "nameInput"; input.id = "files-name-input"; input.autocomplete = "off"; input.spellcheck = false;
    const label = el("label", "files-editor-label", t("dialog.nameLabel")); label.htmlFor = input.id;
    const hint = el("p", "files-field-error", t("dialog.nameInvalid")); hint.hidden = !current.touched || validName(current.value);
    input.addEventListener("input", () => { current.value = input.value; current.touched = true; hint.hidden = validName(input.value); confirm.disabled = !validName(input.value) || busy(); });
    const row = el("div", "files-actions");
    const confirm = button("confirmName", t("common.confirm"), () => submit(), { primary: true, disabled: !validName(current.value) });
    confirm.type = "submit";
    row.append(confirm, button("cancelDialog", t("common.cancel"), () => closeDialog()));
    form.append(el("h2", "", titles[current.purpose]), label, input, hint, row);
    form.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
    function submit() {
      if (!validName(current.value) || busy()) { current.touched = true; hint.hidden = validName(current.value); return; }
      const name = current.value;
      // Start the operation first (it turns busy synchronously), then close: the focus
      // return waits until the operation settles instead of landing on a disabled button.
      dialog = null;
      if (current.purpose === "newFile") act(() => controller.createFile(name));
      else if (current.purpose === "newFolder") act(() => controller.createFolder(name));
      else if (current.purpose === "rename" && current.item) act(() => controller.rename(current.item!, name));
      else if (current.purpose === "saveAs") act(() => controller.saveAs(name));
      closeDialog();
    }
    return form;
  }
  function confirmDialog(current: Extract<Dialog, { kind: "confirm" }>) {
    const keys = {
      delete: ["dialog.deleteTitle", "dialog.deleteDetail", "actions.delete"], deleteCloud: ["dialog.deleteTitle", "dialog.deleteCloudDetail", "actions.delete"],
      removeRoot: ["dialog.removeTitle", "dialog.removeDetail", "common.confirm"], removeCloud: ["dialog.removeCloudTitle", "dialog.removeCloudDetail", "common.confirm"],
      discard: ["dialog.discardTitle", "dialog.discardDetail", "actions.discard"],
    } as const;
    const [titleKey, detailKey, confirmKey] = keys[current.purpose];
    const panel = el("section", "files-dialog"); panel.setAttribute("role", "alertdialog"); panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", t(titleKey, { name: current.name }));
    const row = el("div", "files-actions");
    // Safe choice first so Enter on the default focus never destroys data.
    row.append(
      button("cancelDialog", current.purpose === "discard" ? t("actions.keepEditing") : t("common.cancel"), () => closeDialog()),
      button("confirmDialog", t(confirmKey), () => {
        // A confirmed step may open the next dialog/chooser: keep the original trigger for focus return.
        const next = current.then; dialog = null; chaining = true;
        try { next(); } finally { chaining = false; }
        if (!dialog && !state.chooser) closeDialog(); else { dialogSignature = ""; render(); }
      }, { primary: true }),
    );
    panel.append(el("h2", "", t(titleKey, { name: current.name })), el("p", "files-muted", t(detailKey, { name: current.name })), row);
    return panel;
  }
  function openDialog(next: Dialog) { if (disposed || busy()) return; rememberFocus(); dialog = next; dialogSignature = ""; render(); }
  function closeDialog() { dialog = null; dialogSignature = ""; render(); }

  // ---- render loop -------------------------------------------------------------------
  function render() {
    if (disposed) return;
    layout.frame.lang = translator.locale;
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const editorFocused = document.activeElement === editor;
    const selection = [editor.selectionStart, editor.selectionEnd, editor.selectionDirection] as const;
    const focusInStack = !!document.activeElement && stack.contains(document.activeElement);
    status.hidden = false;
    renderToolbar(); renderStatus(); renderRecovered(); renderContent();
    stack.inert = !!state.chooser || !!state.cloudPicker || !!dialog;
    renderDialog();
    settleFocus();
    if (editorFocused && editor.isConnected && !editor.disabled) {
      editor.focus({ preventScroll: true });
      try { editor.setSelectionRange(selection[0], selection[1], selection[2] ?? "none"); } catch { /* value shrank */ }
    } else if (focusInStack && focusKey && focusKey !== "editor") {
      const node = stack.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`);
      if (node && document.activeElement !== node) node.focus({ preventScroll: true });
    }
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !dialogLayer.hidden) {
      const focusable = [...dialogLayer.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== "Escape" || dialogLayer.hidden) return;
    event.preventDefault();
    if (state.chooser) { if (!busy()) controller.closeChooser(); } else if (state.cloudPicker) { if (!busy()) controller.closeCloudPicker(); } else closeDialog();
  };
  dialogLayer.addEventListener("keydown", onKey);
  dialogLayer.addEventListener("click", (event) => { if (event.target === dialogLayer) { if (state.chooser) { if (!busy()) controller.closeChooser(); } else if (state.cloudPicker) { if (!busy()) controller.closeCloudPicker(); } else closeDialog(); } });
  const structure = (snapshot: FilesSnapshot) => JSON.stringify({ ...snapshot, draft: snapshot.draft && { base: snapshot.draft.base } });
  const unsubscribe = controller.subscribe((snapshot) => {
    // Typing only changes the draft text/dirty flag: patch in place so the editor keeps focus and IME state.
    if (!disposed && state.draft && snapshot.draft && structure(snapshot) === structure(state) && editor.isConnected) {
      state = snapshot;
      const save = content.querySelector<HTMLButtonElement>('[data-key="save"]');
      if (save) { save.disabled = busy() || !snapshot.draft!.dirty; save.classList.toggle("files-btn-primary", snapshot.draft!.dirty); }
      const draftState = content.querySelector(".files-draft-state");
      if (draftState) draftState.textContent = `${t(snapshot.draft!.dirty ? "file.dirty" : cleanKey())} · ${t("file.editorLimit")}`;
      for (const key of ["export", "rename", "delete"]) { const node = content.querySelector<HTMLButtonElement>(`[data-key="${key}"]`); if (node) node.disabled = busy() || snapshot.draft!.dirty; }
      return;
    }
    const hadDialogItem = dialog?.kind === "name" && dialog.item && !snapshot.items.some((item) => same(item, dialog!.kind === "name" ? dialog!.item! : item));
    state = snapshot;
    if (snapshot.availability !== "ready" || hadDialogItem) dialog = null;
    render();
  });
  function tickChooser() {
    const node = dialogLayer.querySelector<HTMLElement>(".files-chooser-detail");
    if (!node || !state.busy) return;
    const elapsed = Math.floor((Date.now() - state.busy.startedAt) / 1000);
    const detail = [state.busy.progress ? t("operation.progress", { done: bytes(state.busy.progress.done), total: bytes(state.busy.progress.total) }) : "", elapsed >= 1 ? t("operation.elapsed", { seconds: elapsed }) : ""].filter(Boolean).join(" · ");
    if (node.textContent !== detail) node.textContent = detail;
    node.hidden = !detail;
  }
  // Only text changes on the tick: the chooser list (and its scroll) is never rebuilt for time.
  const clock = setInterval(() => { if (!disposed && state.busy) { renderStatus(); tickChooser(); } }, 250);
  render();
  return {
    setLocale(locale: string) { if (disposed) return; translator.setLocale(locale); dialogSignature = ""; render(); },
    setDiagnostics(update: Partial<typeof diagnostics>) { if (disposed) return; diagnostics = { ...diagnostics, ...update }; render(); },
    dispose() {
      if (disposed) return;
      disposed = true; dialog = null; clearInterval(clock); unsubscribe();
      editor.value = ""; recoveredText.value = "";
      layout.dispose(); removeStyles();
    },
  };
}

export type FilesView = ReturnType<typeof createFilesView>;
export type { FilesSnapshot, ResourceRoot };
