import type { MockNetworkHandler } from "@reai/app-test/v1";
import type { CollectionNode, ProjectRow } from "../src/data-client";

// A synthetic subset of the public project data API. No database, OAuth token or live fetch.
export interface FixtureActor {
  userId: string;
  scopes: Set<string>;
  acl: Map<string, { read: boolean; write: boolean }>;
}
export const fixtureActor = (userId = "user-a"): FixtureActor => ({
  userId, scopes: new Set(["project:data:read", "project:data:write"]),
  acl: new Map([["project-a", { read: true, write: true }]]),
});
export const jsonResponse = (status: number, value: unknown) => ({
  status, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
});
export function createDataFixture() {
  const rows = new Map<string, ProjectRow>();
  const projects = new Map<string, CollectionNode[]>([
    ["project-a", [{ key: "folder-a", label: "Fixture folder", type: "folder", children: [{ key: "table-a", label: "Fixture records", type: "table", schema: { fields: [{ name: "title", type: "string" }] } }] }]],
    ["project-b", [{ key: "table-b", label: "Other project", type: "table", schema: { fields: [] } }]],
  ]);
  const records: Array<{ userId: string; method: string; path: string; query: string; body: Record<string, unknown> }> = [];
  let nextId = 0;
  const find = (nodes: CollectionNode[], key: string): CollectionNode | undefined => {
    for (const node of nodes) { if (node.key === key) return node; const child = find(node.children ?? [], key); if (child) return child; }
  };
  const handler = (actor: FixtureActor): MockNetworkHandler => async ({ request, body }) => {
    const url = new URL(String(request.url)); const method = String(request.method); const parts = url.pathname.split("/").filter(Boolean);
    if (url.origin !== "https://block2-api.wainao.chat" || parts[0] !== "projects") return jsonResponse(404, { error: "fixture_route_not_found" });
    const input = body.size ? JSON.parse(await body.text()) as Record<string, unknown> : {};
    records.push({ userId: actor.userId, method, path: url.pathname, query: url.search, body: structuredClone(input) });
    const projectId = parts[1]!; const write = method !== "GET";
    const scope = write ? "project:data:write" : "project:data:read";
    if (!actor.scopes.has(scope)) return jsonResponse(403, { error: "insufficient_scope", required_scope: scope });
    const tree = projects.get(projectId);
    if (!tree || !actor.acl.get(projectId)?.[write ? "write" : "read"]) return jsonResponse(404, { error: "项目不存在或无权访问" });
    if (parts[2] === "collections") {
      if (method !== "GET") return jsonResponse(401, { error: "fixture_jwt_route_excluded" });
      if (!parts[3]) return jsonResponse(200, { databaseFolder: tree });
      const table = find(tree, parts[3]);
      if (!table) return jsonResponse(404, { error: "Collection not found" });
      if (parts[4] === "schema") return table.type === "table" ? jsonResponse(200, { schema: table.schema ?? { fields: [] } }) : jsonResponse(400, { error: "Only table has schema" });
      return jsonResponse(200, table);
    }
    if (parts[2] !== "data") return jsonResponse(404, { error: "fixture_route_not_found" });
    const collection = url.searchParams.get("collectionId");
    const scoped = [...rows.values()].filter(row => row.project_id === projectId && (!collection || row.collection_id === collection));
    if (method === "GET" && !parts[3]) {
      if (!collection) return jsonResponse(400, { error: "collectionId 参数是必填的" });
      const page = Number(url.searchParams.get("page") ?? 1); const pageSize = Math.min(Number(url.searchParams.get("pageSize") ?? 20), 100);
      const active = scoped.filter(row => row.deleted_at === null).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return jsonResponse(200, { data: active.slice((page - 1) * pageSize, page * pageSize), total: active.length, page, pageSize, totalPages: Math.ceil(active.length / pageSize) });
    }
    if (method === "GET" && parts[3] === "trash") {
      if (!collection) return jsonResponse(400, { error: "collectionId 参数是必填的" });
      return jsonResponse(200, { data: scoped.filter(row => row.deleted_at !== null).sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!)) });
    }
    if (method === "GET" && parts[3] === "count") return jsonResponse(200, { count: scoped.filter(row => row.deleted_at === null).length });
    if (method === "POST" && !parts[3]) {
      const table = find(tree, String(input.collectionId));
      if (!table || table.type !== "table") return jsonResponse(404, { error: "COLLECTION_NOT_FOUND" });
      const id = `row-${++nextId}`; const time = new Date(Date.UTC(2026, 9, 5, 0, 0, nextId)).toISOString();
      const row: ProjectRow = { id, project_id: projectId, collection_id: String(input.collectionId), team_id: "team-a", owner_user_id: actor.userId, data: structuredClone(input.data) as Record<string, unknown>, created_at: time, updated_at: time, deleted_at: null };
      rows.set(id, row); return jsonResponse(201, row);
    }
    const row = rows.get(parts[3] ?? "");
    if (!row || row.project_id !== projectId || (row.deleted_at && parts[4] !== "restore")) return jsonResponse(404, { error: "数据不存在" });
    if (method === "GET" && parts.length === 4) return jsonResponse(200, row);
    if (method === "PATCH" && parts.length === 4) { row.data = structuredClone(input.data) as Record<string, unknown>; return jsonResponse(200, row); }
    if (method === "DELETE" && parts.length === 4) { row.deleted_at = "2026-10-05T01:00:00Z"; return jsonResponse(200, { success: true }); }
    if (method === "POST" && parts[4] === "restore" && parts.length === 5) {
      if (!find(tree, row.collection_id)) return jsonResponse(410, { error: "COLLECTION_DELETED", message: "The collection this data belongs to has been deleted" });
      row.deleted_at = null; return jsonResponse(200, row);
    }
    return jsonResponse(405, { error: "fixture_method_excluded" });
  };
  return { rows, projects, records, handler };
}
