/**
 * In-memory synthetic resource provider for the loopback preview and unit tests only.
 * The production entry never imports this module; it carries no Host authority.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { AuthorizedResource, ResourceRef, ResourceRoot, ResourceStat } from "@reai/app-sdk/v1";
import { CLOUD_HOST_MESSAGES, FILE_LIMITS, FilesError, decodeBytes, encodeBytes, type FilesClient } from "./adapter";

interface Node { kind: "file" | "directory"; name: string; bytes: Uint8Array; revision: number; modifiedAtMs: number; id: string }
/** `projectId` set = a cloud Project root (provider `cloud-project`, stable per-node resourceId). */
interface Workspace { grantRef: string; workspaceId: string; name: string; nodes: Map<string, Node>; projectId?: string }
interface Transfer { target: string; workspaceId: string; grantRef: string; expectedRevision: string; idempotencyKey: string; sizeBytes: number; chunks: Uint8Array[]; received: number; committed?: ResourceStat }

const MUTATION = ["requestId", "target", "expectedRevision", "idempotencyKey"];
const REQUEST_FIELDS: Record<string, { required: string[]; allowed: string[] }> = {
  listRoots: { required: ["requestId"], allowed: ["requestId"] },
  pickRoot: { required: ["requestId"], allowed: ["requestId"] },
  revokeRoot: { required: ["requestId", "grantRef"], allowed: ["requestId", "grantRef"] },
  attachCloudProject: { required: ["requestId", "projectId"], allowed: ["requestId", "projectId"] },
  list: { required: ["requestId", "target"], allowed: ["requestId", "target", "cursor", "pageSize"] },
  stat: { required: ["requestId", "target"], allowed: ["requestId", "target"] },
  read: { required: ["requestId", "target", "expectedRevision", "offset", "maxBytes"], allowed: ["requestId", "target", "expectedRevision", "offset", "maxBytes"] },
  startWrite: { required: [...MUTATION, "sizeBytes"], allowed: [...MUTATION, "sizeBytes"] },
  writeChunk: { required: ["requestId", "transferId", "offset", "bodyBase64"], allowed: ["requestId", "transferId", "offset", "bodyBase64"] },
  commitWrite: { required: [...MUTATION, "transferId", "sha256"], allowed: [...MUTATION, "transferId", "sha256"] },
  cancel: { required: ["requestId", "transferId"], allowed: ["requestId", "transferId"] },
  createFile: { required: [...MUTATION, "name"], allowed: [...MUTATION, "name"] },
  mkdir: { required: [...MUTATION, "name"], allowed: [...MUTATION, "name"] },
  rename: { required: [...MUTATION, "name"], allowed: [...MUTATION, "name"] },
  delete: { required: MUTATION, allowed: MUTATION },
};
const fail = (code: string, message = ""): never => { throw new FilesError(code, message); };
const encoder = new TextEncoder();
let fixtureSequence = 0;
const nodeId = () => `res-${++fixtureSequence}`;

export interface SyntheticOptions {
  /** Async delay per call (ms) to exercise busy states. */
  delayMs?: number;
}

/** Synthetic Host-like client. Every method validates the grant like the real provider. */
export class SyntheticFiles implements FilesClient {
  private workspaces = new Map<string, Workspace>();
  private transfers = new Map<string, Transfer>();
  private nextPick: string | null = null;
  private failures = new Map<string, { code: string; message: string }>();
  private cloudProjects = new Map<string, { name: string; files: Record<string, string | null> }>();
  /** The plugin's own cloud connection (Manifest oauth_app + backend grant). */
  cloudConnected = true;
  /** What the user answers in the Host's confirmation for the next attach. */
  nextAttach: "allow" | "deny" = "allow";
  private hooks = new Map<string, () => void | Promise<void>>();
  private clock = 1_700_000_000_000;
  readonly calls: string[] = [];
  delayMs: number;
  constructor(options: SyntheticOptions = {}) { this.delayMs = options.delayMs ?? 0; }

  /** Adds an authorized folder; returns its grantRef. */
  addRoot(name: string, files: Record<string, string | null> = {}): string {
    const id = `ws${++fixtureSequence}`;
    const workspace: Workspace = { grantRef: `grant-${id}`, workspaceId: id, name, nodes: new Map() };
    workspace.nodes.set("", { kind: "directory", name, bytes: new Uint8Array(), revision: 1, modifiedAtMs: this.clock, id: "root" });
    this.workspaces.set(workspace.grantRef, workspace);
    for (const [path, content] of Object.entries(files)) this.seed(workspace.grantRef, path, content);
    return workspace.grantRef;
  }
  /** Seeds `path` (null = directory) and creates missing parents. */
  seed(grantRef: string, path: string, content: string | null): void {
    const workspace = this.workspace(grantRef);
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (!workspace.nodes.has(parent)) workspace.nodes.set(parent, { kind: "directory", name: parts[index - 1]!, bytes: new Uint8Array(), revision: 1, modifiedAtMs: this.clock, id: nodeId() });
    }
    workspace.nodes.set(path, { kind: content === null ? "directory" : "file", name: parts.at(-1)!, bytes: encoder.encode(content ?? ""), revision: 1, modifiedAtMs: this.clock, id: nodeId() });
  }
  /** Simulates another app writing the file outside the plugin. */
  externalWrite(grantRef: string, path: string, content: string): void {
    const node = this.workspace(grantRef).nodes.get(path) ?? fail("RESOURCE_NOT_FOUND");
    node.bytes = encoder.encode(content); node.revision++; node.modifiedAtMs = ++this.clock;
    this.touchParent(this.workspace(grantRef), path);
  }
  /** Simulates the user withdrawing consent / removing the root in Host settings. */
  revoke(grantRef?: string): void {
    if (grantRef) this.workspaces.delete(grantRef); else this.workspaces.clear();
  }
  /** Next pickRoot returns this new folder (null = the user cancels the panel). */
  preparePick(name: string | null, files: Record<string, string | null> = {}): void {
    this.nextPick = name === null ? null : this.addRoot(name, files);
  }
  /** Next call of `method` rejects with `code` (and the Host user message, if any). */
  failNext(method: string, code: string, message = ""): void { this.failures.set(method, { code, message }); }
  /** A Project the signed-in user may access; it becomes a root only after attach + consent. */
  addCloudProject(projectId: string, name: string, files: Record<string, string | null> = {}): void {
    this.cloudProjects.set(projectId, { name, files });
  }
  /** grantRef of the attached cloud root for `projectId`, if any. */
  cloudGrant(projectId: string): string | undefined {
    return [...this.workspaces.values()].find((workspace) => workspace.projectId === projectId)?.grantRef;
  }
  /** Path of a node by its cloud resourceId (tests only). */
  pathOf(grantRef: string, resourceId: string): string | undefined {
    for (const [path, node] of this.workspace(grantRef).nodes) if (node.id === resourceId) return path;
    return undefined;
  }
  text(grantRef: string, path: string): string | undefined {
    const node = this.workspace(grantRef).nodes.get(path);
    return node?.kind === "file" ? new TextDecoder().decode(node.bytes) : undefined;
  }
  /** Transfers started and neither committed nor cancelled (Host caps these per App). */
  openTransfers(): number { return [...this.transfers.values()].filter((transfer) => !transfer.committed).length; }
  /** Runs `hook` right after `method` succeeded at the provider but before the caller sees it. */
  afterNext(method: string, hook: () => void | Promise<void>): void { this.hooks.set(method, hook); }
  has(grantRef: string, path: string): boolean { return this.workspaces.get(grantRef)?.nodes.has(path) ?? false; }

  async listRoots(input: { requestId: string }) {
    await this.enter("listRoots", input);
    return { items: [...this.workspaces.values()].map((workspace) => this.root(workspace)) };
  }
  async pickRoot(input: { requestId: string }) {
    await this.enter("pickRoot", input);
    const grant = this.nextPick; this.nextPick = null;
    if (!grant) return { root: null };
    return { root: this.root(this.workspace(grant)) };
  }
  async revokeRoot(input: { requestId: string; grantRef: string }) {
    await this.enter("revokeRoot", input);
    if (!this.workspaces.delete(input.grantRef)) fail("RESOURCE_NOT_AUTHORIZED");
    return { revoked: true as const };
  }
  async attachCloudProject(input: { requestId: string; projectId: string }) {
    await this.enter("attachCloudProject", input);
    // Same order as the Host: plugin identity → Project ACL → user confirmation.
    if (!this.cloudConnected) fail("RESOURCE_NOT_AUTHORIZED", CLOUD_HOST_MESSAGES.notConnected);
    const project = this.cloudProjects.get(input.projectId) ?? fail("RESOURCE_NOT_AUTHORIZED", "插件没有访问该云项目或文件的权限（project acl）");
    if (this.nextAttach === "deny") { this.nextAttach = "allow"; return { root: null }; }
    const existing = this.cloudGrant(input.projectId);
    if (existing) return { root: this.root(this.workspace(existing)) };
    const grant = this.addRoot(project.name, project.files);
    this.workspace(grant).projectId = input.projectId;
    return await this.leave("attachCloudProject", { root: this.root(this.workspace(grant)) });
  }
  async list(input: { requestId: string; target: AuthorizedResource; cursor?: string; pageSize?: number }) {
    await this.enter("list", input);
    const { workspace, path, node } = this.resolve(input.target);
    if (node.kind !== "directory") fail("RESOURCE_PATH_INVALID");
    const children = [...workspace.nodes.entries()]
      .filter(([key]) => key !== "" && key.split("/").slice(0, -1).join("/") === path)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => this.stat0(workspace, key, child));
    const size = input.pageSize ?? 50;
    const start = input.cursor ? Number(input.cursor.slice(1)) : 0;
    const items = children.slice(start, start + size);
    return await this.leave("list", { items, nextCursor: start + size < children.length ? `c${start + size}` : null });
  }
  async stat(input: { requestId: string; target: AuthorizedResource }) {
    await this.enter("stat", input);
    const { workspace, path, node } = this.resolve(input.target);
    return this.stat0(workspace, path, node);
  }
  async read(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; offset: number; maxBytes: number }) {
    await this.enter("read", input);
    const { node } = this.resolve(input.target);
    if (node.kind !== "file") fail("RESOURCE_PATH_INVALID");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    const bytes = node.bytes.subarray(input.offset, input.offset + Math.min(input.maxBytes, FILE_LIMITS.maxReadBytes));
    return { resource: input.target.resource, revision: `r${node.revision}`, bodyBase64: encodeBytes(bytes), offset: input.offset, bytes: bytes.length, eof: input.offset + bytes.length >= node.bytes.length };
  }
  async startWrite(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string; sizeBytes: number }) {
    await this.enter("startWrite", input);
    const { workspace, path, node } = this.resolve(input.target);
    if (node.kind !== "file") fail("RESOURCE_PATH_INVALID");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    if (input.sizeBytes > FILE_LIMITS.maxTransferBytes) fail("RESOURCE_LIMIT_EXCEEDED");
    const transferId = `t${++fixtureSequence}`;
    this.transfers.set(transferId, { target: path, workspaceId: workspace.workspaceId, grantRef: input.target.grantRef, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey, sizeBytes: input.sizeBytes, chunks: [], received: 0 });
    return await this.leave("startWrite", { transferId, expiresAtMs: Date.now() + 300_000, maxChunkBytes: FILE_LIMITS.maxChunkBytes, maxBytes: FILE_LIMITS.maxTransferBytes });
  }
  async writeChunk(input: { requestId: string; transferId: string; offset: number; bodyBase64: string }) {
    await this.enter("writeChunk", input);
    const transfer = this.transfers.get(input.transferId) ?? fail("RESOURCE_TRANSFER_EXPIRED");
    if (transfer.committed) fail("RESOURCE_TRANSFER_EXPIRED");
    if (input.offset !== transfer.received) fail("RESOURCE_IO_FAILED");
    const bytes = decodeBytes(input.bodyBase64, FILE_LIMITS.maxChunkBytes);
    transfer.chunks.push(bytes); transfer.received += bytes.length;
    if (transfer.received > transfer.sizeBytes) fail("RESOURCE_LIMIT_EXCEEDED");
    return { receivedBytes: transfer.received };
  }
  async commitWrite(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string; transferId: string; sha256: string }) {
    await this.enter("commitWrite", input);
    const transfer = this.transfers.get(input.transferId) ?? fail("RESOURCE_TRANSFER_EXPIRED");
    const { workspace, path, node } = this.resolve(input.target);
    if (transfer.committed) fail("RESOURCE_TRANSFER_EXPIRED");
    // The Host binds a transfer to its exact start target, grant, revision and key.
    if (path !== transfer.target || workspace.workspaceId !== transfer.workspaceId || input.target.grantRef !== transfer.grantRef
      || input.expectedRevision !== transfer.expectedRevision || transfer.received !== transfer.sizeBytes || input.idempotencyKey !== transfer.idempotencyKey) fail("RESOURCE_IO_FAILED");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    const bytes = new Uint8Array(transfer.received); let offset = 0;
    for (const chunk of transfer.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (bytesToHex(sha256(bytes)) !== input.sha256) fail("RESOURCE_IO_FAILED");
    node.bytes = bytes; node.revision++; node.modifiedAtMs = ++this.clock;
    this.touchParent(workspace, path);
    transfer.committed = this.stat0(workspace, path, node);
    return await this.leave("commitWrite", transfer.committed);
  }
  async cancel(input: { requestId: string; transferId: string }) {
    await this.enter("cancel", input);
    const transfer = this.transfers.get(input.transferId);
    // Committed receipts stay terminal (the Host keeps answering "committed").
    if (!transfer?.committed) this.transfers.delete(input.transferId);
    return transfer?.committed ? { cancelled: false as const, committed: transfer.committed } : { cancelled: true as const };
  }
  async createFile(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string; name: string }) {
    await this.enter("createFile", input);
    return await this.leave("createFile", this.create(input, "file"));
  }
  async mkdir(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string; name: string }) {
    await this.enter("mkdir", input);
    return this.create(input, "directory");
  }
  async rename(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string; name: string }) {
    await this.enter("rename", input);
    const { workspace, path, node } = this.resolve(input.target);
    if (path === "") fail("RESOURCE_PATH_INVALID");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    this.checkName(input.name);
    const parent = path.split("/").slice(0, -1).join("/");
    const next = parent ? `${parent}/${input.name}` : input.name;
    if (workspace.nodes.has(next)) fail("RESOURCE_ALREADY_EXISTS");
    for (const [key, value] of [...workspace.nodes.entries()]) {
      if (key === path || key.startsWith(`${path}/`)) { workspace.nodes.delete(key); workspace.nodes.set(next + key.slice(path.length), value); }
    }
    node.name = input.name; node.revision++;
    this.touchParent(workspace, next);
    return this.stat0(workspace, next, node);
  }
  async move(): Promise<ResourceStat> { return fail("RESOURCE_UNAVAILABLE"); }
  async delete(input: { requestId: string; target: AuthorizedResource; expectedRevision: string; idempotencyKey: string }) {
    await this.enter("delete", input);
    const { workspace, path, node } = this.resolve(input.target);
    if (path === "") fail("RESOURCE_PATH_INVALID");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    if (node.kind === "directory" && [...workspace.nodes.keys()].some((key) => key.startsWith(`${path}/`))) fail("RESOURCE_IO_FAILED");
    workspace.nodes.delete(path); this.touchParent(workspace, path);
    return { deleted: true as const };
  }

  private async enter(method: string, input: unknown): Promise<void> {
    this.calls.push(method);
    if (!input || typeof input !== "object" || typeof (input as { requestId?: unknown }).requestId !== "string") fail("RESOURCE_UNAVAILABLE");
    // Mirror the Host's serde `deny_unknown_fields` request shapes (driver-v2 files/local.rs).
    const shape = REQUEST_FIELDS[method];
    if (shape) {
      const keys = Object.keys(input as object);
      if (keys.some((key) => !shape.allowed.includes(key)) || shape.required.some((key) => !keys.includes(key))) fail("RESOURCE_UNAVAILABLE");
      const target = (input as { target?: unknown }).target;
      if (target !== undefined && (typeof target !== "object" || target === null || Object.keys(target).sort().join() !== "grantRef,resource")) fail("RESOURCE_UNAVAILABLE");
    }
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const failure = this.failures.get(method);
    if (failure) { this.failures.delete(method); fail(failure.code, failure.message); }
  }
  private async leave<T>(method: string, result: T): Promise<T> {
    const hook = this.hooks.get(method);
    if (hook) { this.hooks.delete(method); await hook(); }
    return result;
  }
  private workspace(grantRef: string): Workspace { return this.workspaces.get(grantRef) ?? fail("RESOURCE_NOT_AUTHORIZED"); }
  private ref(workspace: Workspace, path: string, node: Node): ResourceRef {
    return workspace.projectId
      ? { version: 1, provider: "cloud-project", projectId: workspace.projectId, resourceId: node.id }
      : { version: 1, provider: "local", workspaceId: workspace.workspaceId, relativePath: path };
  }
  private root(workspace: Workspace): ResourceRoot {
    return { name: workspace.name, resource: { grantRef: workspace.grantRef, resource: this.ref(workspace, "", workspace.nodes.get("")!) } };
  }
  private resolve(target: AuthorizedResource) {
    const workspace = this.workspace(target.grantRef);
    const ref = target.resource;
    if (workspace.projectId) {
      // Host: grantRef must belong to this plugin and name the same Project, else no network.
      if (ref.provider !== "cloud-project" || ref.projectId !== workspace.projectId) fail("RESOURCE_NOT_AUTHORIZED", "插件没有访问该云项目或文件的权限（grant mismatch）");
      const id = (ref as Extract<ResourceRef, { provider: "cloud-project" }>).resourceId;
      for (const [path, node] of workspace.nodes) if (node.id === id) return { workspace, path, node };
      return fail("RESOURCE_NOT_FOUND");
    }
    if (ref.provider !== "local" || ref.workspaceId !== workspace.workspaceId) fail("RESOURCE_NOT_AUTHORIZED");
    const path = (ref as Extract<ResourceRef, { provider: "local" }>).relativePath;
    const node = workspace.nodes.get(path) ?? fail("RESOURCE_NOT_FOUND");
    return { workspace, path, node };
  }
  private stat0(workspace: Workspace, path: string, node: Node): ResourceStat {
    return { resource: this.ref(workspace, path, node), kind: node.kind, name: node.name, revision: `r${node.revision}`, sizeBytes: node.kind === "file" ? node.bytes.length : 0, modifiedAtMs: node.modifiedAtMs };
  }
  private touchParent(workspace: Workspace, path: string): void {
    const parent = workspace.nodes.get(path.split("/").slice(0, -1).join("/"));
    if (parent) { parent.revision++; parent.modifiedAtMs = ++this.clock; }
  }
  private checkName(name: string): void {
    if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || encoder.encode(name).length > FILE_LIMITS.maxNameBytes) fail("RESOURCE_PATH_INVALID");
  }
  private create(input: { target: AuthorizedResource; expectedRevision: string; name: string }, kind: Node["kind"]): ResourceStat {
    const { workspace, path, node } = this.resolve(input.target);
    if (node.kind !== "directory") fail("RESOURCE_PATH_INVALID");
    if (`r${node.revision}` !== input.expectedRevision) fail("RESOURCE_REVISION_CONFLICT");
    this.checkName(input.name);
    const child = path ? `${path}/${input.name}` : input.name;
    if (workspace.nodes.has(child)) fail("RESOURCE_ALREADY_EXISTS");
    const created: Node = { kind, name: input.name, bytes: new Uint8Array(), revision: 1, modifiedAtMs: ++this.clock, id: nodeId() };
    workspace.nodes.set(child, created); node.revision++;
    return this.stat0(workspace, child, created);
  }
}
