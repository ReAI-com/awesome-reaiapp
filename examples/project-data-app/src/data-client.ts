import type { AppContext } from "@reai/app-sdk/v1";

export const DATA_ORIGIN = "https://block2-api.wainao.chat";
export interface Selection { projectId: string; collectionId: string }
export interface FieldSchema { name: string; type: string; knowledgeBaseTag?: string; properties?: FieldSchema[]; items?: FieldSchema }
export interface CollectionSchema { fields: FieldSchema[] }
export interface CollectionNode { key: string; label: string; type: "folder" | "table"; children?: CollectionNode[]; schema?: CollectionSchema }
export interface ProjectRow {
  id: string; project_id: string; collection_id: string; team_id: string; owner_user_id: string;
  data: Record<string, unknown>; created_at: string; updated_at: string; deleted_at: string | null;
}
export interface DataPage { data: ProjectRow[]; total: number; page: number; pageSize: number; totalPages: number }
export class DataError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly uncertain = false) { super(code); }
}
export interface DataClient {
  collections(projectId: string, signal?: AbortSignal): Promise<CollectionNode[]>;
  schema(selection: Selection, signal?: AbortSignal): Promise<CollectionSchema>;
  list(selection: Selection, page?: number, pageSize?: number, signal?: AbortSignal): Promise<DataPage>;
  trash(selection: Selection, signal?: AbortSignal): Promise<ProjectRow[]>;
  count(selection: Selection, signal?: AbortSignal): Promise<number>;
  read(selection: Selection, id: string, signal?: AbortSignal): Promise<ProjectRow>;
  create(selection: Selection, data: Record<string, unknown>, signal?: AbortSignal): Promise<ProjectRow>;
  update(selection: Selection, id: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<ProjectRow>;
  remove(selection: Selection, id: string, signal?: AbortSignal): Promise<void>;
  restore(selection: Selection, id: string, signal?: AbortSignal): Promise<ProjectRow>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const inputError = () => new DataError("DATA_INPUT_INVALID");
function identifier(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ["trash", "count", "batch-import", "batch-delete"].includes(value)) throw inputError();
  return value;
}
function path(selection: Selection) { return `/projects/${identifier(selection.projectId)}/data`; }
function jsonData(data: Record<string, unknown>) {
  const visit = (value: unknown, depth = 0, parents = new Set<object>()): void => {
    if (depth > 16) throw inputError();
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
    if (!object(value) && !Array.isArray(value)) throw inputError();
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw inputError();
    if (parents.has(value)) throw inputError();
    parents.add(value); for (const child of Object.values(value)) visit(child, depth + 1, parents); parents.delete(value);
  };
  if (!object(data)) throw inputError(); visit(data);
  const text = JSON.stringify(data); if (new TextEncoder().encode(text).length > 64 * 1024) throw inputError(); return text;
}
function invalid(uncertain = false): never { throw new DataError("DATA_RESPONSE_INVALID", 0, uncertain); }
function row(value: unknown, selection: Selection, id?: string, uncertain = false): ProjectRow {
  if (!object(value) || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    || value.project_id !== selection.projectId || value.collection_id !== selection.collectionId || (id && value.id !== id)
    || !object(value.data) || typeof value.team_id !== "string" || typeof value.owner_user_id !== "string"
    || typeof value.created_at !== "string" || typeof value.updated_at !== "string"
    || !(value.deleted_at === null || typeof value.deleted_at === "string")) invalid(uncertain);
  return value as unknown as ProjectRow;
}
function field(value: unknown, depth = 0): value is FieldSchema {
  if (depth > 16 || !object(value) || typeof value.name !== "string" || typeof value.type !== "string") return false;
  if (value.knowledgeBaseTag !== undefined && typeof value.knowledgeBaseTag !== "string") return false;
  if (value.properties !== undefined && (!Array.isArray(value.properties) || !value.properties.every(item => field(item, depth + 1)))) return false;
  return value.items === undefined || field(value.items, depth + 1);
}
function schema(value: unknown): CollectionSchema {
  if (!object(value) || !Array.isArray(value.fields) || !value.fields.every(item => field(item))) invalid();
  return value as unknown as CollectionSchema;
}
export function hasKnowledgeFields(value: CollectionSchema): boolean {
  const marked = (field: FieldSchema): boolean => !!field.knowledgeBaseTag || !!field.properties?.some(marked) || !!(field.items && marked(field.items));
  return value.fields.some(marked);
}
export function collectionTables(nodes: CollectionNode[]): CollectionNode[] {
  return nodes.flatMap(node => node.type === "table" ? [node] : collectionTables(node.children ?? []));
}
function tree(value: unknown, depth = 0): CollectionNode[] {
  if (depth > 16 || !Array.isArray(value)) invalid();
  return value.map(item => {
    if (!object(item) || typeof item.key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.key) || typeof item.label !== "string" || !["folder", "table"].includes(String(item.type))) invalid();
    if (item.schema !== undefined) schema(item.schema);
    if (item.children !== undefined) tree(item.children, depth + 1);
    return item as unknown as CollectionNode;
  });
}
export function createDataClient(http: Pick<AppContext["http"], "fetch">): DataClient {
  async function request(url: string, method = "GET", body?: string, signal?: AbortSignal): Promise<unknown> {
    const mutation = method !== "GET";
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let response: Response;
    try {
      response = await http.fetch(DATA_ORIGIN + url, { endpointId: "project-data", method, headers: body === undefined ? {} : { "content-type": "application/json" }, body, signal });
    } catch (error: unknown) {
      const code = object(error) && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : "DATA_NETWORK_FAILED";
      throw new DataError(code, 0, mutation);
    }
    let value: unknown;
    try { value = await response.json(); } catch { if (response.ok) invalid(mutation); value = null; }
    if (!response.ok) {
      const safeErrors = ["insufficient_scope", "invalid_token", "COLLECTION_NOT_FOUND", "COLLECTION_DELETED"];
      const code = object(value) && safeErrors.includes(String(value.error)) ? String(value.error) : `DATA_HTTP_${response.status}`;
      throw new DataError(code, response.status, mutation && response.status >= 500);
    }
    return value;
  }
  const selected = (selection: Selection) => { identifier(selection.collectionId); return path(selection); };
  async function loadSchema(selection: Selection, signal?: AbortSignal) {
    selected(selection); const value = await request(`/projects/${selection.projectId}/collections/${selection.collectionId}/schema`, "GET", undefined, signal);
    if (!object(value)) invalid(); return schema(value.schema);
  }
  async function safeTable(selection: Selection, signal?: AbortSignal) {
    if (hasKnowledgeFields(await loadSchema(selection, signal))) throw new DataError("DATA_KB_TABLE_EXCLUDED");
  }
  async function read(selection: Selection, id: string, signal?: AbortSignal) {
    const base = selected(selection); identifier(id); return row(await request(`${base}/${id}`, "GET", undefined, signal), selection, id);
  }
  async function trash(selection: Selection, signal?: AbortSignal) {
    const base = selected(selection); const value = await request(`${base}/trash?${new URLSearchParams({ collectionId: selection.collectionId })}`, "GET", undefined, signal);
    if (!object(value) || !Array.isArray(value.data)) invalid();
    return value.data.map(item => { const result = row(item, selection); if (result.deleted_at === null) invalid(); return result; });
  }
  return {
    async collections(projectId, signal) {
      identifier(projectId); const value = await request(`/projects/${projectId}/collections`, "GET", undefined, signal);
      if (!object(value)) invalid(); return tree(value.databaseFolder);
    },
    schema: loadSchema,
    async list(selection, page = 1, pageSize = 5, signal) {
      const base = selected(selection);
      if (!integer(page) || page < 1 || !integer(pageSize) || pageSize < 1 || pageSize > 100) throw inputError();
      const query = new URLSearchParams({ collectionId: selection.collectionId, page: String(page), pageSize: String(pageSize), sort: "created_at", order: "desc" });
      const value = await request(`${base}?${query}`, "GET", undefined, signal);
      if (!object(value) || !Array.isArray(value.data) || !integer(value.total) || value.page !== page || value.pageSize !== pageSize || value.totalPages !== Math.ceil(value.total / pageSize) || value.data.length > pageSize || value.data.length > value.total) invalid();
      return { data: value.data.map(item => { const result = row(item, selection); if (result.deleted_at !== null) invalid(); return result; }), total: value.total, page, pageSize, totalPages: value.totalPages as number };
    },
    trash,
    async count(selection, signal) {
      const base = selected(selection); const value = await request(`${base}/count?${new URLSearchParams({ collectionId: selection.collectionId })}`, "GET", undefined, signal);
      if (!object(value) || !integer(value.count)) invalid(); return value.count;
    },
    read,
    async create(selection, data, signal) {
      const base = selected(selection); const encoded = jsonData(data); await safeTable(selection, signal);
      return row(await request(base, "POST", `{"collectionId":${JSON.stringify(selection.collectionId)},"data":${encoded}}`, signal), selection, undefined, true);
    },
    async update(selection, id, data, signal) {
      const base = selected(selection); identifier(id); const encoded = jsonData(data);
      await safeTable(selection, signal); await read(selection, id, signal);
      return row(await request(`${base}/${id}`, "PATCH", `{"data":${encoded}}`, signal), selection, id, true);
    },
    async remove(selection, id, signal) {
      const base = selected(selection); identifier(id); await safeTable(selection, signal); await read(selection, id, signal);
      const value = await request(`${base}/${id}`, "DELETE", undefined, signal);
      if (!object(value) || value.success !== true) invalid(true);
    },
    async restore(selection, id, signal) {
      const base = selected(selection); identifier(id);
      // Missing Collection is rejected before any write by the pinned restore route (410).
      // Preserve that backend response instead of inventing a local 410 from schema's 404.
      try { await safeTable(selection, signal); } catch (error) { if (!(error instanceof DataError && error.status === 404)) throw error; }
      if (!(await trash(selection, signal)).some(item => item.id === id)) throw new DataError("DATA_ROW_NOT_IN_TRASH", 404);
      return row(await request(`${base}/${id}/restore`, "POST", undefined, signal), selection, id, true);
    },
  };
}
