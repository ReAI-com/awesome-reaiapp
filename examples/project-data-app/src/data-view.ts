import type { LocaleClient } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { collectionTables, DataError, type CollectionNode, type DataClient, type DataPage, type ProjectRow, type Selection } from "./data-client";
import { createMessages, type MessageKey } from "./i18n";

export function mountDataView(root: HTMLElement, client: DataClient, locale?: LocaleClient, configured = false): () => void {
  const doc = root.ownerDocument; const messages = createMessages(locale); const controller = new AbortController();
  let disposed = false; let busy: string | null = null; let began = 0; let tables: CollectionNode[] = []; let selected: Selection | null = null;
  let mode: "records" | "trash" | "review" = "records"; let editing: string | null = null; let uncertain = false; let verified = false;
  let status: MessageKey = "idle"; let page: DataPage = { data: [], page: 1, pageSize: 5, total: 0, totalPages: 0 }; let deleted: ProjectRow[] = [];
  const labels: Array<{ node: HTMLElement; key: MessageKey }> = []; const buttons = new Map<string, { node: HTMLButtonElement; key: MessageKey }>();
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, key?: MessageKey) { const element = doc.createElement(tag); if (key) labels.push({ node: element, key }); return element; }
  const frame = node("section"); frame.className = "plugin-main-frame";
  const body = node("main"); body.className = "main-body";
  const help = node("p", "help"); const unconfigured = node("p", "unconfigured"); unconfigured.className = "notice"; unconfigured.hidden = configured;
  const scope = node("section"); scope.className = "group";
  const projectLabel = node("label", "project"); projectLabel.htmlFor = "project-id"; const project = node("input"); project.id = "project-id"; project.dataset.field = "project"; project.autocomplete = "off";
  const collectionLabel = node("label", "collection"); collectionLabel.htmlFor = "collection-id"; const collection = node("select"); collection.id = "collection-id"; collection.dataset.field = "collection";
  function button(action: string, key: MessageKey, parent: HTMLElement, work: () => void) {
    const element = node("button"); element.type = "button"; element.dataset.action = action; element.className = "btn-secondary";
    element.onclick = work; buttons.set(action, { node: element, key }); parent.append(element); return element;
  }
  const projectRow = node("div"); projectRow.className = "input-row"; projectRow.append(project);
  button("load", "load", projectRow, () => { void run("load", false, async () => {
    selected = null; tables = []; resetRows(); collection.replaceChildren(); renderRows();
    tables = collectionTables(await client.collections(project.value.trim(), controller.signal));
    if (disposed) return;
    const placeholder = node("option"); placeholder.value = ""; collection.append(placeholder);
    for (const table of tables) { const option = node("option"); option.value = table.key; option.textContent = table.label; collection.append(option); }
    status = tables.length ? "loaded" : "noTables";
  }); });
  const selectWrap = node("div"); selectWrap.className = "select-wrap"; selectWrap.append(collection);
  scope.append(projectLabel, projectRow, collectionLabel, selectWrap);
  const editor = node("section"); editor.className = "group";
  const dataLabel = node("label", "editor"); dataLabel.htmlFor = "record-json";
  const data = node("textarea"); data.id = "record-json"; data.dataset.field = "data"; data.value = "{}"; data.rows = 6; data.spellcheck = false;
  const warning = node("p", "replaceWarning"); warning.className = "hint";
  const editActions = node("div"); editActions.className = "actions";
  button("save", "create", editActions, () => { void run("save", true, async known => {
    const selection = selectionNow(); let value: unknown;
    try { value = JSON.parse(data.value); } catch { throw new DataError("DATA_INPUT_INVALID"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DataError("DATA_INPUT_INVALID");
    const row = editing ? await client.update(selection, editing, value as Record<string, unknown>, controller.signal) : await client.create(selection, value as Record<string, unknown>, controller.signal);
    if (disposed) return; editing = row.id; data.value = JSON.stringify(row.data, null, 2); mode = "records"; known("saved"); await refreshRecords(1);
  }); }).className = "btn-primary";
  button("clear", "clear", editActions, () => { if (busy || uncertain) return; editing = null; data.value = "{}"; render(); });
  editor.append(dataLabel, data, warning, editActions);
  const feedback = node("section"); feedback.className = "feedback";
  const statusNode = node("p"); statusNode.setAttribute("role", "status"); statusNode.setAttribute("aria-live", "polite");
  const elapsed = node("p"); elapsed.className = "hint";
  const checkActions = node("div"); checkActions.className = "actions";
  button("verify", "verify", checkActions, () => { void run("verify", false, async () => {
    verified = false; await refreshRecords(1); if (disposed) return; deleted = await client.trash(selectionNow(), controller.signal); if (disposed) return;
    mode = "review"; verified = true; status = "review"; renderRows();
  }); });
  button("acknowledge", "acknowledge", checkActions, () => { if (busy || !verified) return; uncertain = false; verified = false; status = "loaded"; render(); });
  feedback.append(statusNode, elapsed, checkActions);
  const query = node("div"); query.className = "actions";
  button("browse", "browse", query, () => { void run("browse", false, async () => { mode = "records"; await refreshRecords(1); status = "loaded"; }); });
  button("trash", "trash", query, () => { void run("trash", false, async () => { deleted = await client.trash(selectionNow(), controller.signal); if (disposed) return; mode = "trash"; status = "loaded"; renderRows(); }); });
  const lists = node("section"); lists.className = "records";
  const pagination = node("div"); pagination.className = "actions"; const pageInfo = node("span");
  button("previous", "previous", pagination, () => { void run("previous", false, async () => { await refreshRecords(page.page - 1); status = "loaded"; }); });
  pagination.append(pageInfo);
  button("next", "next", pagination, () => { void run("next", false, async () => { await refreshRecords(page.page + 1); status = "loaded"; }); });
  const version = node("p"); version.className = "hint";
  body.append(help, unconfigured, scope, editor, feedback, query, lists, pagination, version); frame.append(body); root.replaceChildren(frame);
  function selectionNow(): Selection { if (!selected) throw new DataError("DATA_INPUT_INVALID"); return { ...selected }; }
  function resetRows() { page = { data: [], total: 0, page: 1, pageSize: 5, totalPages: 0 }; deleted = []; editing = null; data.value = "{}"; }
  async function refreshRecords(number: number) { const result = await client.list(selectionNow(), number, 5, controller.signal); if (!disposed) { page = result; renderRows(); } }
  function errorMessage(error: unknown): MessageKey {
    if (!(error instanceof DataError)) return "denied";
    if (error.code === "DATA_INPUT_INVALID") return "invalid";
    if (error.code === "DATA_KB_TABLE_EXCLUDED") return "kbExcluded";
    if (error.code === "insufficient_scope") return "scopeDenied";
    if (["NETWORK_PERMISSION_REQUIRED", "PLUGIN_PERMISSION_DENIED"].includes(error.code)) return "permissionDenied";
    if (error.status === 410) return "collectionGone";
    if (error.status === 404) return "notFound";
    if (error.code === "DATA_RESPONSE_INVALID") return "invalidResponse";
    return "networkFailed";
  }
  async function run(action: string, mutation: boolean, work: (known: (key: MessageKey) => void) => Promise<void>) {
    if (disposed || busy || !configured || (mutation && uncertain)) return;
    busy = action; began = Date.now(); status = "working"; render(); let knownResult: MessageKey | undefined;
    try { await work(key => { knownResult = key; status = key; }); if (knownResult) status = knownResult; }
    catch (error) {
      if (disposed) return;
      if (error instanceof DataError && error.uncertain) { uncertain = true; verified = false; status = "unknown"; }
      else status = knownResult ? "knownReadFailed" : errorMessage(error);
    } finally { if (!disposed) { busy = null; render(); } }
  }
  project.oninput = () => { if (busy || uncertain) return; selected = null; tables = []; collection.replaceChildren(); resetRows(); status = "idle"; renderRows(); render(); };
  collection.onchange = () => { if (busy || uncertain) return; selected = collection.value ? { projectId: project.value.trim(), collectionId: collection.value } : null; resetRows(); mode = "records"; renderRows(); render(); };
  function renderRows() {
    if (disposed) return; lists.replaceChildren();
    function group(rows: ProjectRow[], deletedGroup: boolean) {
      const heading = node("h2"); heading.dataset.message = deletedGroup ? "recycle" : "records"; heading.textContent = messages.t(deletedGroup ? "recycle" : "records"); lists.append(heading);
      if (deletedGroup) { const note = node("p"); note.className = "hint"; note.dataset.message = "trashNote"; note.textContent = messages.t("trashNote"); lists.append(note); }
      if (!rows.length) { const empty = node("p"); empty.dataset.message = deletedGroup ? "emptyTrash" : "empty"; empty.textContent = messages.t(deletedGroup ? "emptyTrash" : "empty"); lists.append(empty); }
      for (const row of rows) {
        const item = node("article"); item.className = "record"; item.dataset.record = row.id;
        const id = node("small"); id.textContent = row.id; const content = node("pre"); content.textContent = JSON.stringify(row.data, null, 2);
        const actions = node("div"); actions.className = "actions";
        const add = (action: string, key: MessageKey, work: () => void) => { const element = node("button"); element.className = "btn-secondary"; element.type = "button"; element.dataset.rowAction = action; element.textContent = messages.t(key); element.disabled = !configured || !!busy || uncertain; element.onclick = work; actions.append(element); };
        if (deletedGroup) add("restore", "restore", () => { void run("restore", true, async known => { await client.restore(selectionNow(), row.id, controller.signal); if (disposed) return; known("restored"); deleted = await client.trash(selectionNow(), controller.signal); if (!disposed) renderRows(); }); });
        else {
          add("edit", "edit", () => { if (busy || uncertain || disposed) return; void run("edit", false, async () => { const fresh = await client.read(selectionNow(), row.id, controller.signal); if (!disposed) { editing = fresh.id; data.value = JSON.stringify(fresh.data, null, 2); data.focus(); status = "loaded"; } }); });
          add("delete", "delete", () => { void run("delete", true, async known => { await client.remove(selectionNow(), row.id, controller.signal); if (disposed) return; known("deleted"); if (editing === row.id) { editing = null; data.value = "{}"; } await refreshRecords(page.page); }); });
        }
        item.append(id, content, actions); lists.append(item);
      }
    }
    if (mode !== "trash") group(page.data, false); if (mode !== "records") group(deleted, true);
  }
  function render() {
    if (disposed) return;
    for (const { node, key } of labels) node.textContent = messages.t(key);
    for (const [action, entry] of buttons) { entry.node.textContent = messages.t(busy === action ? "busyButton" : action === "save" && editing ? "save" : entry.key); }
    project.disabled = !configured || !!busy || uncertain; collection.disabled = !configured || !!busy || uncertain || !tables.length;
    data.disabled = !configured || !!busy || uncertain || !selected;
    for (const [action, entry] of buttons) {
      entry.node.disabled = !configured || !!busy;
      if (["save", "clear"].includes(action)) entry.node.disabled ||= !selected || uncertain;
      if (["browse", "trash", "previous", "next"].includes(action)) entry.node.disabled ||= !selected;
      if (action === "load") entry.node.disabled ||= uncertain;
      if (action === "previous") entry.node.disabled ||= page.page <= 1 || mode === "trash";
      if (action === "next") entry.node.disabled ||= page.page >= page.totalPages || mode === "trash";
      if (action === "verify") entry.node.disabled ||= !selected;
      if (action === "acknowledge") entry.node.disabled ||= !verified;
    }
    checkActions.hidden = !uncertain; statusNode.textContent = messages.t(status); feedback.dataset.state = uncertain ? "unknown" : status;
    pageInfo.textContent = messages.t("page", { page: page.page, pages: page.totalPages, total: page.total }); pagination.hidden = mode === "trash" || !selected;
    version.textContent = messages.t("version", { version: manifest.version });
    const seconds = Math.floor((Date.now() - began) / 1000); elapsed.textContent = busy && seconds >= 1 ? messages.t("elapsed", { activity: messages.t(["save", "delete", "restore"].includes(busy) ? "activityWrite" : "activityRead"), seconds }) : "";
    const placeholder = collection.querySelector('option[value=""]'); if (placeholder) placeholder.textContent = messages.t("choose");
    // Keep record nodes, focus and scroll during status/locale updates.
    for (const item of lists.querySelectorAll<HTMLElement>("[data-record]")) for (const element of item.querySelectorAll<HTMLButtonElement>("[data-row-action]")) {
      const action = element.dataset.rowAction as "restore" | "edit" | "delete"; element.textContent = messages.t(action); element.disabled = !configured || !!busy || uncertain;
    }
    for (const element of lists.querySelectorAll<HTMLElement>("[data-message]")) element.textContent = messages.t(element.dataset.message as MessageKey);
  }
  const stopLocale = messages.subscribe(render); const timer = setInterval(render, 1000); render();
  return () => { disposed = true; controller.abort(); clearInterval(timer); stopLocale(); root.replaceChildren(); };
}
