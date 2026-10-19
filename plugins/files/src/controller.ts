import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { AuthorizedResource, ResourceRoot, ResourceStat } from "@reai/app-sdk/v1";
import { FILE_LIMITS, cloudErrorCode, decodeBytes, encodeBytes, errorCode, errorMessage, fail, integer, numberedName, opaque, parseProjectId, refKey, validName, validStat, type FilesClient } from "./adapter";
import type { CloudProject, CloudProjectLister } from "./cloud-projects";

/** Overall reachability of the Host provider for this plugin. */
export type Availability = "checking" | "ready" | "notOpen" | "notAuthorized" | "stale";
export interface Crumb { name: string; target: AuthorizedResource }
export interface Draft { text: string; base: ResourceStat; dirty: boolean }
export interface Chooser {
  mode: "import" | "export";
  root: ResourceRoot | null;
  trail: Crumb[];
  items: ResourceStat[];
  nextCursor: string | null;
}
/**
 * "Connect a cloud Project" panel. `projects` is filled only when the plugin can list
 * Projects with its own cloud connection; otherwise the user types an ID or pastes a link.
 */
export interface CloudPicker {
  listing: "unavailable" | "loading" | "ready" | "failed";
  projects: CloudProject[];
  listError: string | null;
}
export type Operation =
  | "roots" | "pick" | "revokeRoot" | "list" | "open" | "read" | "save" | "saveAs" | "reload"
  | "createFile" | "createFolder" | "rename" | "delete" | "import" | "export" | "projects" | "attach";
export type NoticeKind = "saved" | "created" | "renamed" | "deleted" | "imported" | "exported" | "cancelled" | "revoked" | "rootRemoved" | "pickCancelled" | "reloaded" | "tooLateToCancel" | "cloudAttached" | "cloudDeclined";
export interface FilesSnapshot {
  availability: Availability;
  roots: ResourceRoot[];
  root: ResourceRoot | null;
  trail: Crumb[];
  items: ResourceStat[];
  nextCursor: string | null;
  selected: ResourceStat | null;
  draft: Draft | null;
  /** Save hit RESOURCE_REVISION_CONFLICT; the draft is kept until the user decides. */
  conflict: boolean;
  /** Unsaved text kept after the folder authorization disappeared. Never written anywhere automatically. */
  recovered: { name: string; text: string } | null;
  chooser: Chooser | null;
  /** The Host offers cloud Project roots (`attachCloudProject`). */
  cloudSupported: boolean;
  cloudPicker: CloudPicker | null;
  busy: { operation: Operation; startedAt: number; progress: { done: number; total: number } | null; cancellable: boolean } | null;
  /** `detail` is the Host's user message, shown only in developer mode. */
  error: { code: string; operation: Operation; detail?: string } | null;
  notice: { kind: NoticeKind; name?: string } | null;
}
interface Active {
  operation: Operation; epoch: number; cancelled: boolean; transferId?: string; lateCommit?: string; done?: boolean;
  /** The Host could not confirm a user cancel on the cloud: the failure must say "unknown", not "cancelled". */
  unknown?: unknown;
}

const clone = <T>(value: T): T => structuredClone(value);
const PERMISSION_CODES = new Set(["PLUGIN_PERMISSION_REQUIRED", "PLUGIN_PERMISSION_DENIED"]);
const MAX_NAME_ATTEMPTS = 20;
/** Errors that end the page's authority; they must never be swallowed by best-effort cleanup. */
const FATAL_CODES = new Set(["RESOURCE_SCOPE_STALE", "HOST_CAPABILITY_NOT_AVAILABLE", "PLUGIN_PERMISSION_REQUIRED", "PLUGIN_PERMISSION_DENIED"]);
function isFatal(error: unknown): boolean { return FATAL_CODES.has(errorCode(error)); }
/** Higher wins: a lost scope beats lost capability beats lost permission beats a revoked folder beats anything else. */
function severity(error: unknown): number {
  const code = errorCode(error);
  if (code === "RESOURCE_SCOPE_STALE") return 4;
  if (code === "HOST_CAPABILITY_NOT_AVAILABLE") return 3;
  if (code === "PLUGIN_PERMISSION_REQUIRED" || code === "PLUGIN_PERMISSION_DENIED") return 2;
  if (code === "RESOURCE_NOT_AUTHORIZED") return 1;
  return 0;
}
/** Picks the error that must drive the page state when cleanup fails after an original failure. */
function graver(original: unknown, cleanup: unknown): unknown { return severity(cleanup) > severity(original) && severity(cleanup) >= 2 ? cleanup : original; }

function initial(): FilesSnapshot {
  return { availability: "checking", roots: [], root: null, trail: [], items: [], nextCursor: null, selected: null, draft: null, conflict: false, recovered: null, chooser: null, cloudSupported: false, cloudPicker: null, busy: null, error: null, notice: null };
}

/**
 * Plugin-private state machine over `resources.files@1`. The Host re-authorizes every call;
 * this class never stores paths, never retries a mutation blindly and keeps at most one
 * operation in flight.
 */
export class FilesController {
  private state = initial();
  private listeners = new Set<(state: FilesSnapshot) => void>();
  private active: Active | null = null;
  private epoch = 1;
  private sequence = 1;
  private disposed = false;
  private readonly prefix = bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  private readonly pageSize: number;
  private readonly now: () => number;
  private readonly projects: CloudProjectLister | null;
  private readonly cloudSupported: boolean;

  constructor(private readonly files: FilesClient | null, options: { pageSize?: number; now?: () => number; projects?: CloudProjectLister | null } = {}) {
    this.pageSize = options.pageSize ?? 50;
    integer(this.pageSize, 1, FILE_LIMITS.maxPageSize);
    this.now = options.now ?? Date.now;
    this.projects = options.projects ?? null;
    this.cloudSupported = typeof files?.attachCloudProject === "function";
    this.state.cloudSupported = this.cloudSupported;
    if (!files) this.state.availability = "notOpen";
  }

  getSnapshot(): FilesSnapshot { return clone(this.state); }
  subscribe(listener: (state: FilesSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.getSnapshot());
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    if (this.disposed) return;
    this.epoch++;
    // Drafts and recovered text belong to this mount only: wipe them on unmount.
    this.state = { ...initial(), cloudSupported: this.cloudSupported };
    this.disposed = true;
    const active = this.active;
    if (active?.transferId && this.files) void this.files.cancel({ requestId: this.requestId(), transferId: active.transferId }).catch(() => undefined);
    this.listeners.clear();
  }

  // ---- roots -------------------------------------------------------------------------
  async init(): Promise<void> {
    if (!this.files) return;
    this.patch({ availability: "checking", error: null });
    await this.run("roots", async () => {
      const roots = await this.loadRoots();
      this.patch({ availability: "ready", roots });
      // Open the first allowed folder right away; the toolbar switches between folders.
      if (roots.length > 0) await this.enterRoot(roots[0]!);
    });
  }
  async addRoot(): Promise<void> {
    await this.run("pick", async (active) => {
      const result = await this.call(active, () => this.files!.pickRoot({ requestId: this.requestId() }));
      if (!result.root) { this.patch({ notice: { kind: "pickCancelled" } }); return; }
      const root = this.validRoot(result.root);
      const roots = await this.loadRoots();
      this.patch({ roots });
      await this.enterRoot(roots.find((item) => item.resource.grantRef === root.resource.grantRef) ?? root, active);
    });
  }
  async openRoot(root: ResourceRoot): Promise<void> {
    await this.run("list", async (active) => { await this.enterRoot(this.ownRoot(root), active); });
  }
  async removeRoot(root: ResourceRoot): Promise<void> {
    await this.run("revokeRoot", async (active) => {
      const own = this.ownRoot(root);
      await this.call(active, () => this.files!.revokeRoot({ requestId: this.requestId(), grantRef: own.resource.grantRef }));
      if (this.state.root?.resource.grantRef === own.resource.grantRef) this.clearFolder(true);
      if (this.state.chooser?.root?.resource.grantRef === own.resource.grantRef) this.patch({ chooser: { ...this.state.chooser, root: null, trail: [], items: [], nextCursor: null } });
      this.patch({ roots: this.state.roots.filter((item) => item.resource.grantRef !== own.resource.grantRef), notice: { kind: "rootRemoved", name: own.name } });
    });
  }

  // ---- cloud Projects (T21) ----------------------------------------------------------
  /** Opens the "connect a cloud Project" panel and lists Projects when the plugin can. */
  openCloudPicker(): void {
    if (!this.cloudSupported || this.state.availability !== "ready" || this.state.busy || this.disposed) return;
    this.patch({ cloudPicker: { listing: this.projects ? "loading" : "unavailable", projects: [], listError: null }, chooser: null, notice: null, error: null });
    if (this.projects) void this.loadProjects();
  }
  closeCloudPicker(): void { if (!this.state.busy) this.patch({ cloudPicker: null }); }
  async loadProjects(): Promise<void> {
    const lister = this.projects;
    if (!lister || !this.state.cloudPicker) return;
    await this.run("projects", async (active) => {
      this.patch({ cloudPicker: { ...this.state.cloudPicker!, listing: "loading", listError: null } });
      let projects: CloudProject[];
      try { projects = await lister.list(); }
      catch (error) {
        this.check(active);
        // Listing is only a convenience: typing an ID or pasting a link still works.
        if (this.state.cloudPicker) this.patch({ cloudPicker: { ...this.state.cloudPicker, listing: "failed", projects: [], listError: errorCode(error) } });
        return;
      }
      this.check(active);
      if (this.state.cloudPicker) this.patch({ cloudPicker: { ...this.state.cloudPicker, listing: "ready", projects, listError: null } });
    });
  }
  /**
   * Asks the Host to attach a Project (an ID or a pasted link). The Host checks access with
   * this plugin's own cloud identity and shows its own confirmation; `root: null` = declined.
   */
  async attachCloud(text: string): Promise<void> {
    if (!this.cloudSupported) return;
    await this.run("attach", async (active) => {
      const projectId = parseProjectId(text) ?? fail("CLOUD_PROJECT_ID_INVALID");
      const result = await this.call(active, () => this.files!.attachCloudProject!({ requestId: this.requestId(), projectId }));
      if (!result || !result.root) { this.patch({ cloudPicker: null, notice: { kind: "cloudDeclined" } }); return; }
      const root = this.validRoot(result.root);
      if (root.resource.resource.provider !== "cloud-project") fail("RESOURCE_IO_FAILED");
      const roots = await this.call(active, () => this.loadRoots());
      this.patch({ roots: roots.some((item) => item.resource.grantRef === root.resource.grantRef) ? roots : [...roots, root], cloudPicker: null });
      await this.enterRoot(roots.find((item) => item.resource.grantRef === root.resource.grantRef) ?? root, active);
      this.patch({ notice: { kind: "cloudAttached", name: root.name } });
    });
  }

  // ---- browsing ----------------------------------------------------------------------
  async openEntry(item: ResourceStat): Promise<void> {
    await this.run(item.kind === "directory" ? "list" : "open", async (active) => {
      validStat(item);
      const target = this.inRoot(item);
      const current = await this.call(active, () => this.files!.stat({ requestId: this.requestId(), target }));
      validStat(current);
      if (refKey(current.resource) !== refKey(item.resource)) fail("RESOURCE_IO_FAILED");
      if (current.kind === "directory") {
        const page = await this.page(active, target);
        this.patch({ trail: [...this.state.trail, { name: current.name, target }], items: page.items, nextCursor: page.nextCursor, selected: null, draft: null, conflict: false });
      } else {
        this.patch({ selected: current, draft: null, conflict: false });
        this.replaceItem(current);
      }
    });
  }
  async goTo(index: number): Promise<void> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.state.trail.length) return;
    await this.run("list", async (active) => {
      const crumb = this.state.trail[index]!;
      const page = await this.page(active, crumb.target);
      this.patch({ trail: this.state.trail.slice(0, index + 1), items: page.items, nextCursor: page.nextCursor, selected: null, draft: null, conflict: false });
    });
  }
  async up(): Promise<void> { await this.goTo(this.state.trail.length - 2); }
  async refresh(): Promise<void> {
    await this.run("list", async (active) => { await this.reloadListing(active); });
  }
  async loadMore(): Promise<void> {
    const directory = this.state.trail.at(-1); const cursor = this.state.nextCursor;
    if (!directory || !cursor) return;
    await this.run("list", async (active) => {
      let page;
      try { page = await this.page(active, directory.target, cursor); }
      catch (error) {
        // The folder changed between pages: drop the cursor and show the fresh first page.
        if (errorCode(error) !== "RESOURCE_REVISION_CONFLICT") throw error;
        await this.reloadListing(active);
        this.patch({ error: { code: "RESOURCE_LISTING_CHANGED", operation: "list" } });
        return;
      }
      const seen = new Set(this.state.items.map((item) => refKey(item.resource)));
      this.patch({ items: [...this.state.items, ...page.items.filter((item) => !seen.has(refKey(item.resource)))], nextCursor: page.nextCursor });
    });
  }

  // ---- text editing ------------------------------------------------------------------
  async openText(): Promise<void> {
    await this.run("read", async (active) => {
      const selected = this.file();
      const text = await this.readText(active, selected);
      this.patch({ draft: { text, base: selected, dirty: false }, conflict: false });
    });
  }
  edit(text: string): boolean {
    const draft = this.state.draft;
    if (!draft || this.state.busy || typeof text !== "string") return false;
    if (new TextEncoder().encode(text).byteLength > FILE_LIMITS.maxReadBytes) return false;
    this.patch({ draft: { ...draft, text, dirty: true }, notice: null, error: null });
    return true;
  }
  closeDraft(): void {
    if (this.state.busy) return;
    this.patch({ draft: null, conflict: false });
  }
  async save(): Promise<void> {
    await this.run("save", async (active) => {
      const draft = this.state.draft ?? fail("RESOURCE_UNAVAILABLE");
      if (this.state.conflict) fail("RESOURCE_REVISION_CONFLICT");
      const bytes = new TextEncoder().encode(draft.text);
      const result = await this.writeBytes(active, draft.base, bytes);
      this.patch({ selected: result, draft: { text: draft.text, base: result, dirty: false }, conflict: false, notice: { kind: "saved", name: result.name } });
      this.replaceItem(result);
    });
  }
  /** Conflict choice: drop my edits and load the version that is on disk now. */
  async reloadFromDisk(): Promise<void> {
    await this.run("reload", async (active) => {
      const base = this.state.draft?.base ?? this.file();
      const current = await this.call(active, () => this.files!.stat({ requestId: this.requestId(), target: this.inRoot(base) }));
      validStat(current);
      if (refKey(current.resource) !== refKey(base.resource) || current.kind !== "file") fail("RESOURCE_IO_FAILED");
      const text = await this.readText(active, current);
      this.patch({ selected: current, draft: { text, base: current, dirty: false }, conflict: false, notice: { kind: "reloaded", name: current.name } });
      this.replaceItem(current);
    });
  }
  /** Conflict choice (or recovered text): write the text into a new file in the current folder. */
  async saveAs(name: string): Promise<void> {
    await this.run("saveAs", async (active) => {
      const text = this.state.draft?.text ?? this.state.recovered?.text ?? fail("RESOURCE_UNAVAILABLE");
      const fromRecovered = !this.state.draft;
      const directory = this.state.trail.at(-1) ?? fail("RESOURCE_NOT_AUTHORIZED");
      if (!validName(name)) fail("RESOURCE_PATH_INVALID");
      const created = await this.createUnique(active, directory.target, name, "file", false);
      const target: AuthorizedResource = { resource: created.resource, grantRef: directory.target.grantRef };
      const bytes = new TextEncoder().encode(text);
      let result: ResourceStat;
      try {
        this.check(active);
        result = await this.writeStream(active, target, created, bytes.length, async (offset, max) => bytes.subarray(offset, offset + max));
      } catch (error) { await this.discardPlaceholder(target, created).catch((cleanup: unknown) => { throw graver(error, cleanup); }); throw error; }
      // Register the saved result first; the listing refresh is secondary.
      this.patch({ selected: result, draft: { text, base: result, dirty: false }, conflict: false, ...(fromRecovered ? { recovered: null } : {}), notice: { kind: "saved", name: result.name } });
      await this.softReload(active, result);
    });
  }
  discardRecovered(): void { this.patch({ recovered: null }); }

  // ---- folder mutations --------------------------------------------------------------
  async createFile(name: string): Promise<void> { await this.create(name, "file"); }
  async createFolder(name: string): Promise<void> { await this.create(name, "directory"); }
  async rename(item: ResourceStat, name: string): Promise<void> {
    await this.run("rename", async (active) => {
      validStat(item);
      if (!validName(name)) fail("RESOURCE_PATH_INVALID");
      if (this.isDraftOf(item) && this.state.draft!.dirty) fail("DRAFT_UNSAVED");
      const result = await this.call(active, () => this.files!.rename({ ...this.mutation(this.inRoot(item), item.revision), name }));
      validStat(result);
      const keepSelected = this.state.selected && refKey(this.state.selected.resource) === refKey(item.resource);
      this.patch({ items: this.state.items.map((entry) => refKey(entry.resource) === refKey(item.resource) ? result : entry), ...(keepSelected ? { selected: result, draft: null, conflict: false } : {}), notice: { kind: "renamed", name: result.name } });
      await this.softReload(active, result);
    });
  }
  async remove(item: ResourceStat): Promise<void> {
    await this.run("delete", async (active) => {
      validStat(item);
      await this.call(active, () => this.files!.delete(this.mutation(this.inRoot(item), item.revision)));
      const wasSelected = this.state.selected && refKey(this.state.selected.resource) === refKey(item.resource);
      this.patch({ items: this.state.items.filter((entry) => refKey(entry.resource) !== refKey(item.resource)), ...(wasSelected ? { selected: null, draft: null, conflict: false } : {}), notice: { kind: "deleted", name: item.name } });
      await this.softReload(active);
    });
  }

  // ---- import / export (copy between user-chosen folders) ---------------------------
  startImport(): void { this.openChooser("import"); }
  startExport(): void { if (this.state.selected?.kind === "file") this.openChooser("export"); }
  closeChooser(): void { if (!this.state.busy) this.patch({ chooser: null }); }
  async chooserOpenRoot(root: ResourceRoot): Promise<void> {
    await this.run("list", async (active) => { await this.enterChooserRoot(active, this.ownRoot(root)); });
  }
  async chooserPickFolder(): Promise<void> {
    await this.run("pick", async (active) => {
      const result = await this.call(active, () => this.files!.pickRoot({ requestId: this.requestId() }));
      if (!result.root) { this.patch({ notice: { kind: "pickCancelled" } }); return; }
      const root = this.validRoot(result.root);
      const roots = await this.loadRoots();
      this.patch({ roots });
      await this.enterChooserRoot(active, roots.find((item) => item.resource.grantRef === root.resource.grantRef) ?? root);
    });
  }
  async chooserOpen(item: ResourceStat): Promise<void> {
    const chooser = this.state.chooser;
    if (!chooser?.root) return;
    if (item.kind === "file") { if (chooser.mode === "import") await this.importFile(item); return; }
    await this.run("list", async (active) => {
      validStat(item);
      const target = this.inChooser(item);
      const page = await this.page(active, target);
      const current = this.state.chooser!;
      this.patch({ chooser: { ...current, trail: [...current.trail, { name: item.name, target }], items: page.items, nextCursor: page.nextCursor } });
    });
  }
  async chooserGoTo(index: number): Promise<void> {
    const chooser = this.state.chooser;
    if (!chooser || index < 0 || index >= chooser.trail.length) return;
    await this.run("list", async (active) => {
      const page = await this.page(active, chooser.trail[index]!.target);
      this.patch({ chooser: { ...this.state.chooser!, trail: chooser.trail.slice(0, index + 1), items: page.items, nextCursor: page.nextCursor } });
    });
  }
  async chooserLoadMore(): Promise<void> {
    const chooser = this.state.chooser; const cursor = chooser?.nextCursor; const directory = chooser?.trail.at(-1);
    if (!chooser || !cursor || !directory) return;
    await this.run("list", async (active) => {
      const page = await this.page(active, directory.target, cursor);
      const current = this.state.chooser!;
      this.patch({ chooser: { ...current, items: [...current.items, ...page.items], nextCursor: page.nextCursor } });
    });
  }
  async exportHere(): Promise<void> {
    await this.run("export", async (active) => {
      const chooser = this.state.chooser;
      if (chooser?.mode !== "export") fail("RESOURCE_UNAVAILABLE");
      const destination = chooser.trail.at(-1) ?? fail("RESOURCE_NOT_AUTHORIZED");
      const source = this.file();
      const result = await this.copy(active, this.inRoot(source), source, destination.target);
      this.patch({ chooser: null, notice: { kind: "exported", name: result.name } });
    });
  }
  private async importFile(item: ResourceStat): Promise<void> {
    await this.run("import", async (active) => {
      validStat(item);
      const directory = this.state.trail.at(-1) ?? fail("RESOURCE_NOT_AUTHORIZED");
      const result = await this.copy(active, this.inChooser(item), item, directory.target);
      this.patch({ chooser: null, selected: result, draft: null, conflict: false, notice: { kind: "imported", name: result.name } });
      await this.softReload(active, result);
    });
  }

  /** Cancels the in-flight transfer (save, import or export) if any. */
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active || !this.files || !this.state.busy?.cancellable || active.done) return;
    active.cancelled = true;
    if (active.transferId) {
      await this.files.cancel({ requestId: this.requestId(), transferId: active.transferId }).catch((error: unknown) => {
        if (cloudErrorCode(errorCode(error), errorMessage(error)) === "CLOUD_OUTCOME_UNKNOWN") active.unknown = error;
      });
    }
  }

  // ---- internals ---------------------------------------------------------------------
  private requestId(): string { return `files-${this.prefix}-${this.sequence++}`; }
  private mutation(target: AuthorizedResource, expectedRevision: string) {
    return { requestId: this.requestId(), target, expectedRevision, idempotencyKey: `files-${this.prefix}-m${this.sequence++}` };
  }
  private patch(update: Partial<FilesSnapshot>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) { try { listener(snapshot); } catch { /* one view cannot block another */ } }
  }
  private current(active: Active): boolean { return !this.disposed && active.epoch === this.epoch && this.active === active; }
  private check(active: Active): void {
    if (!this.current(active)) fail("RESOURCE_SCOPE_STALE");
    if (active.cancelled && !active.done) fail("RESOURCE_CANCELLED");
  }
  /** The write is final: cancel can no longer undo anything, so stop offering it. */
  private markDone(active: Active): void {
    active.done = true;
    if (active.cancelled) { active.cancelled = false; active.lateCommit ??= ""; }
    if (this.state.busy) this.patch({ busy: { ...this.state.busy, cancellable: false } });
  }
  private async call<T>(active: Active, perform: () => Promise<T>): Promise<T> {
    this.check(active); const result = await perform(); this.check(active); return result;
  }
  private async run(operation: Operation, perform: (active: Active) => Promise<void>): Promise<void> {
    if (!this.files || this.disposed || this.active) return;
    if (this.state.availability !== "ready" && operation !== "roots") return;
    const active: Active = { operation, epoch: this.epoch, cancelled: false };
    this.active = active;
    const cancellable = operation === "save" || operation === "saveAs" || operation === "import" || operation === "export";
    // Visible state changes before the first await (design §3.6).
    // A background roots re-read must not wipe the notice that explains why it happened.
    this.patch({ busy: { operation, startedAt: this.now(), progress: null, cancellable }, ...(operation === "roots" ? {} : { notice: null, error: null }) });
    try {
      await perform(active);
      if (active.lateCommit && this.current(active)) this.patch({ notice: { kind: "tooLateToCancel", name: active.lateCommit } });
    } catch (error) {
      // Losing scope/permission still wins; otherwise an unconfirmed cloud cancel outranks "cancelled".
      if (active.epoch === this.epoch && !this.disposed) this.handleError(active, active.unknown && !isFatal(error) ? active.unknown : error);
    } finally {
      if (this.active === active) { this.active = null; this.patch({ busy: null }); }
    }
  }
  private handleError(active: Active, error: unknown): void {
    const code = errorCode(error);
    const detail = errorMessage(error);
    // Cloud failures carry their meaning in the Host message (files/cloud_provider.rs map_error).
    const cloud = cloudErrorCode(code, detail);
    if (code === "RESOURCE_SCOPE_STALE") {
      // The Surface/runtime/account that owned this view is gone (e.g. account switch): drop everything, keep nothing.
      this.epoch++;
      this.state = { ...initial(), cloudSupported: this.cloudSupported, availability: "stale" };
      this.patch({});
      return;
    }
    if (active.operation === "attach" && !PERMISSION_CODES.has(code)) {
      // Attaching never affects the folders already open; older Hosts lack only this method.
      const attachCode = code === "HOST_CAPABILITY_NOT_AVAILABLE" ? "CLOUD_NOT_SUPPORTED"
        : cloud ?? (code === "RESOURCE_NOT_AUTHORIZED" ? "CLOUD_NOT_AUTHORIZED" : code);
      this.patch({ error: { code: attachCode, operation: "attach", ...(detail ? { detail } : {}) } });
      return;
    }
    if (code === "HOST_CAPABILITY_NOT_AVAILABLE") { this.revokeReset(); this.patch({ availability: "notOpen", roots: [] }); return; }
    if (PERMISSION_CODES.has(code)) { this.revokeReset(); this.patch({ availability: "notAuthorized", roots: [] }); return; }
    // The Host stopped waiting on the cloud (revocation, account change…): whether the change
    // landed is unknown — even after a user cancel — so never claim "cancelled"; ask to re-query.
    if (cloud === "CLOUD_OUTCOME_UNKNOWN") { this.patch({ error: { code: cloud, operation: active.operation, ...(detail ? { detail } : {}) } }); return; }
    // Scope/authorization loss wins over a user cancel; only then is a cancel reported as such.
    if (code === "RESOURCE_CANCELLED" || (active.cancelled && code !== "RESOURCE_NOT_AUTHORIZED")) { this.patch({ notice: { kind: "cancelled" } }); return; }
    if (code === "RESOURCE_NOT_AUTHORIZED" && active.operation === "pick") {
      // The Host refused the chosen folder (e.g. a protected system/Driver directory); existing roots stay valid.
      this.patch({ error: { code: "RESOURCE_PICK_REJECTED", operation: "pick" } });
      return;
    }
    if (code === "RESOURCE_NOT_AUTHORIZED" && cloud && active.operation !== "roots") {
      // Cloud access ended (plugin cloud connection missing, Project ACL or consent withdrawn).
      // Keep unsaved text, leave the root list to the Host and explain what to do.
      this.revokeReset();
      this.patch({ error: { code: cloud, operation: active.operation, ...(detail ? { detail } : {}) } });
      setTimeout(() => { void this.resyncRoots(); }, 0);
      return;
    }
    if (code === "RESOURCE_NOT_AUTHORIZED") {
      if (active.operation === "roots") { this.revokeReset(); this.patch({ availability: "notAuthorized", roots: [] }); return; }
      const lost = this.state.root;
      this.revokeReset();
      this.patch({ roots: lost ? this.state.roots.filter((item) => item.resource.grantRef !== lost.resource.grantRef) : this.state.roots, notice: { kind: "revoked", ...(lost ? { name: lost.name } : {}) } });
      // Re-read the remaining roots once this operation has released the busy slot.
      setTimeout(() => { void this.resyncRoots(); }, 0);
      return;
    }
    if (code === "RESOURCE_REVISION_CONFLICT" && active.operation === "save") { this.patch({ conflict: true, error: { code, operation: "save" } }); return; }
    this.patch({ error: { code: cloud ?? code, operation: active.operation, ...(detail ? { detail } : {}) } });
  }
  /** Keeps unsaved text (never the folder) when access to the open folder disappears. */
  private revokeReset(): void {
    const draft = this.state.draft;
    const recovered = draft?.dirty ? { name: draft.base.name, text: draft.text } : this.state.recovered;
    this.epoch++;
    this.clearFolder(false);
    this.patch({ recovered, chooser: null, cloudPicker: null });
  }
  private clearFolder(keepDraft: boolean): void {
    const draft = this.state.draft;
    const recovered = keepDraft && draft?.dirty ? { name: draft.base.name, text: draft.text } : this.state.recovered;
    this.patch({ root: null, trail: [], items: [], nextCursor: null, selected: null, draft: null, conflict: false, recovered });
  }
  private async resyncRoots(): Promise<void> {
    if (!this.files || this.active || this.disposed) return;
    await this.run("roots", async () => { this.patch({ roots: await this.loadRoots(), availability: "ready" }); });
  }
  private async loadRoots(): Promise<ResourceRoot[]> {
    const result = await this.files!.listRoots({ requestId: this.requestId() });
    if (!result || !Array.isArray(result.items) || result.items.length > FILE_LIMITS.maxPageSize) fail("RESOURCE_IO_FAILED");
    // Local folders and user-confirmed cloud Projects share one list and one UI.
    return result.items.map((root) => this.validRoot(root));
  }
  private validRoot(root: ResourceRoot): ResourceRoot {
    if (!root || typeof root.name !== "string" || !root.resource) fail("RESOURCE_IO_FAILED");
    refKey(root.resource.resource); opaque(root.resource.grantRef);
    return clone(root);
  }
  private ownRoot(root: ResourceRoot): ResourceRoot {
    return this.state.roots.find((item) => item.resource.grantRef === root.resource.grantRef) ?? fail("RESOURCE_NOT_AUTHORIZED");
  }
  private async enterRoot(root: ResourceRoot, active = this.active!): Promise<void> {
    const page = await this.page(active, root.resource);
    this.patch({ root, trail: [{ name: root.name, target: clone(root.resource) }], items: page.items, nextCursor: page.nextCursor, selected: null, draft: null, conflict: false });
  }
  private async enterChooserRoot(active: Active, root: ResourceRoot): Promise<void> {
    const page = await this.page(active, root.resource);
    const chooser = this.state.chooser ?? fail("RESOURCE_UNAVAILABLE");
    this.patch({ chooser: { ...chooser, root, trail: [{ name: root.name, target: clone(root.resource) }], items: page.items, nextCursor: page.nextCursor } });
  }
  private openChooser(mode: Chooser["mode"]): void {
    if (this.state.availability !== "ready" || this.state.busy || !this.state.root || this.state.cloudPicker) return;
    this.patch({ chooser: { mode, root: null, trail: [], items: [], nextCursor: null }, notice: null, error: null });
  }
  private async reloadListing(active: Active, keep?: ResourceStat): Promise<void> {
    const directory = this.state.trail.at(-1);
    if (!directory) return;
    const page = await this.page(active, directory.target);
    const items = keep && !page.items.some((item) => refKey(item.resource) === refKey(keep.resource)) ? [...page.items, keep] : page.items;
    const selected = this.state.selected ? items.find((item) => refKey(item.resource) === refKey(this.state.selected!.resource)) ?? null : null;
    this.patch({ items, nextCursor: page.nextCursor, selected: selected ?? (this.state.draft ? this.state.selected : null) });
  }
  private async page(active: Active, target: AuthorizedResource, cursor?: string) {
    const result = await this.call(active, () => this.files!.list({ requestId: this.requestId(), target, pageSize: this.pageSize, ...(cursor ? { cursor } : {}) }));
    if (!result || !Array.isArray(result.items) || result.items.length > this.pageSize) fail("RESOURCE_IO_FAILED");
    for (const item of result.items) { validStat(item); if (item.resource.provider !== target.resource.provider) fail("RESOURCE_PROVIDER_MISMATCH"); }
    if (result.nextCursor !== null) opaque(result.nextCursor);
    const items = clone(result.items).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { items, nextCursor: result.nextCursor };
  }
  private inRoot(item: ResourceStat): AuthorizedResource {
    const root = this.state.root ?? fail("RESOURCE_NOT_AUTHORIZED");
    if (item.resource.provider !== root.resource.resource.provider) fail("RESOURCE_PROVIDER_MISMATCH");
    return { resource: clone(item.resource), grantRef: root.resource.grantRef };
  }
  private inChooser(item: ResourceStat): AuthorizedResource {
    const root = this.state.chooser?.root ?? fail("RESOURCE_NOT_AUTHORIZED");
    return { resource: clone(item.resource), grantRef: root.resource.grantRef };
  }
  private file(): ResourceStat {
    const selected = this.state.selected;
    if (!selected || selected.kind !== "file") fail("RESOURCE_UNAVAILABLE");
    return clone(selected);
  }
  private isDraftOf(item: ResourceStat): boolean {
    return !!this.state.draft && refKey(this.state.draft.base.resource) === refKey(item.resource);
  }
  private replaceItem(item: ResourceStat): void {
    this.patch({ items: this.state.items.map((current) => refKey(current.resource) === refKey(item.resource) ? clone(item) : current) });
  }
  private progress(done: number, total: number): void {
    if (this.state.busy) this.patch({ busy: { ...this.state.busy, progress: { done, total } } });
  }
  private async read(active: Active, target: AuthorizedResource, stat: ResourceStat, offset: number, maxBytes: number): Promise<Uint8Array> {
    const result = await this.call(active, () => this.files!.read({ requestId: this.requestId(), target, expectedRevision: stat.revision, offset, maxBytes }));
    if (refKey(result.resource) !== refKey(stat.resource) || result.revision !== stat.revision) fail("RESOURCE_REVISION_CONFLICT");
    if (result.offset !== offset) fail("RESOURCE_IO_FAILED");
    integer(result.bytes, 0, maxBytes);
    const bytes = decodeBytes(result.bodyBase64, maxBytes);
    if (bytes.length !== result.bytes || offset + bytes.length > stat.sizeBytes || (!bytes.length && offset < stat.sizeBytes)) fail("RESOURCE_IO_FAILED");
    return bytes;
  }
  private async readText(active: Active, stat: ResourceStat): Promise<string> {
    if (stat.sizeBytes > FILE_LIMITS.maxReadBytes) fail("TEXT_TOO_LARGE");
    const target = this.inRoot(stat);
    const bytes = new Uint8Array(stat.sizeBytes);
    let offset = 0;
    while (offset < stat.sizeBytes) {
      const part = await this.read(active, target, stat, offset, Math.min(FILE_LIMITS.maxChunkBytes, stat.sizeBytes - offset));
      bytes.set(part, offset); offset += part.length;
    }
    if (bytes.includes(0)) fail("TEXT_ENCODING_UNSUPPORTED");
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("TEXT_ENCODING_UNSUPPORTED"); }
  }
  /** Overwrites `target` (CAS on its revision) with chunks produced by `next`. */
  private async writeStream(active: Active, grantTarget: AuthorizedResource, target: ResourceStat, sizeBytes: number, next: (offset: number, max: number) => Promise<Uint8Array>): Promise<ResourceStat> {
    integer(sizeBytes, 0, FILE_LIMITS.maxTransferBytes);
    const mutation = this.mutation(grantTarget, target.revision);
    this.check(active);
    // Record the transfer before any cancel/stale check so it is always released.
    const receipt = await this.files!.startWrite({ ...mutation, sizeBytes });
    opaque(receipt.transferId); active.transferId = receipt.transferId;
    const hash = sha256.create();
    let offset = 0;
    try {
      this.check(active);
      integer(receipt.maxChunkBytes, 1, FILE_LIMITS.maxChunkBytes);
      if (sizeBytes > receipt.maxBytes) fail("RESOURCE_LIMIT_EXCEEDED");
      while (offset < sizeBytes) {
        const chunk = await next(offset, Math.min(receipt.maxChunkBytes, sizeBytes - offset));
        if (!chunk.length) fail("RESOURCE_IO_FAILED");
        const result = await this.call(active, () => this.files!.writeChunk({ requestId: this.requestId(), transferId: receipt.transferId, offset, bodyBase64: encodeBytes(chunk) }));
        if (result.receivedBytes !== offset + chunk.length) fail("RESOURCE_IO_FAILED");
        hash.update(chunk); offset += chunk.length;
        this.progress(offset, sizeBytes);
      }
      const committed = await this.call(active, () => this.files!.commitWrite({ ...mutation, requestId: this.requestId(), transferId: receipt.transferId, sha256: bytesToHex(hash.digest()) }));
      validStat(committed);
      this.markDone(active);
      if (refKey(committed.resource) !== refKey(target.resource) || committed.sizeBytes !== sizeBytes) fail("RESOURCE_IO_FAILED");
      active.transferId = undefined;
      return committed;
    } catch (error) {
      const transferId = active.transferId;
      active.transferId = undefined;
      if (transferId) {
        // A commit may have landed before the cancel: report the committed file, never "cancelled".
        let cleanupError: unknown = null;
        const receipt = await this.files!.cancel({ requestId: this.requestId(), transferId }).catch((reason: unknown) => { cleanupError = reason; return null; });
        if (cleanupError && graver(error, cleanupError) === cleanupError) throw cleanupError;
        // The cloud could not tell whether the transfer landed: that beats "cancelled".
        if (cleanupError && !isFatal(error) && cloudErrorCode(errorCode(cleanupError), errorMessage(cleanupError)) === "CLOUD_OUTCOME_UNKNOWN") throw cleanupError;
        if (receipt && receipt.cancelled === false && receipt.committed) {
          validStat(receipt.committed);
          if (refKey(receipt.committed.resource) !== refKey(target.resource)) throw error;
          const wasCancelled = active.cancelled;
          this.markDone(active);
          if (wasCancelled) active.lateCommit = receipt.committed.name;
          return receipt.committed;
        }
      }
      throw error;
    } finally { hash.destroy(); }
  }
  private async writeBytes(active: Active, target: ResourceStat, bytes: Uint8Array): Promise<ResourceStat> {
    integer(bytes.length, 0, FILE_LIMITS.maxTransferBytes);
    return await this.writeStream(active, this.inRoot(target), target, bytes.length, async (offset, max) => bytes.subarray(offset, offset + max));
  }
  private async createUnique(active: Active, directory: AuthorizedResource, name: string, kind: "file" | "directory", numbered: boolean): Promise<ResourceStat> {
    for (let attempt = 1; attempt <= (numbered ? MAX_NAME_ATTEMPTS : 1); attempt++) {
      const candidate = attempt === 1 ? name : numberedName(name, attempt);
      if (!validName(candidate)) fail("RESOURCE_PATH_INVALID");
      const parent = await this.call(active, () => this.files!.stat({ requestId: this.requestId(), target: directory }));
      validStat(parent);
      if (parent.kind !== "directory") fail("RESOURCE_PATH_INVALID");
      try {
        const input = { ...this.mutation(directory, parent.revision), name: candidate };
        this.check(active);
        // No post-check here: callers own the placeholder and check inside their cleanup scope.
        const created = await (kind === "file" ? this.files!.createFile(input) : this.files!.mkdir(input));
        validStat(created);
        return created;
      } catch (error) {
        if (errorCode(error) !== "RESOURCE_ALREADY_EXISTS" || !numbered) throw error;
      }
    }
    return fail("RESOURCE_ALREADY_EXISTS");
  }
  /** Best effort: deletes only at the creation revision, so a committed or foreign write is never removed. */
  private async discardPlaceholder(target: AuthorizedResource, created: ResourceStat): Promise<void> {
    if (!this.files || this.disposed) return;
    let cleanupError: unknown = null;
    await this.files.delete(this.mutation(target, created.revision)).catch((reason: unknown) => { cleanupError = reason; });
    if (cleanupError && isFatal(cleanupError)) throw cleanupError;
  }
  /** Refreshes the listing after a successful write; a listing failure must not hide that success. */
  private async softReload(active: Active, keep?: ResourceStat): Promise<void> {
    try { await this.reloadListing(active, keep); }
    catch (error) {
      if (isFatal(error) || errorCode(error) === "RESOURCE_NOT_AUTHORIZED") throw error;
      this.patch({ error: { code: "RESOURCE_LISTING_CHANGED", operation: "list" } });
    }
  }
  private async create(name: string, kind: "file" | "directory"): Promise<void> {
    await this.run(kind === "file" ? "createFile" : "createFolder", async (active) => {
      if (!validName(name)) fail("RESOURCE_PATH_INVALID");
      const directory = this.state.trail.at(-1) ?? fail("RESOURCE_NOT_AUTHORIZED");
      const created = await this.createUnique(active, directory.target, name, kind, false);
      this.patch({ items: [...this.state.items, created], ...(kind === "file" ? { selected: created, draft: { text: "", base: created, dirty: false }, conflict: false } : {}), notice: { kind: "created", name: created.name } });
      await this.softReload(active, created);
    });
  }
  /** Streams one file between two user-authorized folders; removes the empty target on failure. */
  private async copy(active: Active, source: AuthorizedResource, sourceStat: ResourceStat, destination: AuthorizedResource): Promise<ResourceStat> {
    const current = await this.call(active, () => this.files!.stat({ requestId: this.requestId(), target: source }));
    validStat(current);
    if (current.kind !== "file" || refKey(current.resource) !== refKey(sourceStat.resource)) fail("RESOURCE_IO_FAILED");
    if (current.sizeBytes > FILE_LIMITS.maxTransferBytes) fail("RESOURCE_LIMIT_EXCEEDED");
    const created = await this.createUnique(active, destination, current.name, "file", true);
    const target: AuthorizedResource = { resource: created.resource, grantRef: destination.grantRef };
    try {
      this.check(active);
      if (current.sizeBytes === 0) { this.markDone(active); return created; }
      return await this.writeStream(active, target, created, current.sizeBytes, (offset, max) => this.read(active, source, current, offset, Math.min(max, FILE_LIMITS.maxReadBytes)));
    } catch (error) {
      if (active.done) throw error;
      await this.discardPlaceholder(target, created).catch((cleanup: unknown) => { throw graver(error, cleanup); });
      throw error;
    }
  }
}
