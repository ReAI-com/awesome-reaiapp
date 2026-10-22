import { describe, expect, test } from "bun:test";
import { brokerFetch } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { createDataClient, DataError, type Selection } from "../src/data-client";
import { createDataFixture, fixtureActor, type FixtureActor } from "./data-fixture";
import { fixtureDevice } from "./device";

const selected: Selection = { projectId: "project-a", collectionId: "table-a" };
const rawClient = (fixture: ReturnType<typeof createDataFixture>, actor: FixtureActor) => {
  const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }), networkHandler: fixture.handler(actor) });
  return { host, client: createDataClient({ fetch: (input, init) => brokerFetch(host.bridge, input, init) }) };
};
describe("source-bound project data OAuth subset (synthetic only)", () => {
  test("two independent SDK AppContexts share Project CRUD, pagination, trash and restore", async () => {
    const fixture = createDataFixture(); const a = await fixtureDevice(fixture); const b = await fixtureDevice(fixture);
    try {
      expect(a.context).not.toBe(b.context); expect(a.context.http).not.toBe(b.context.http);
      expect((await a.client.collections("project-a"))[0]!.children![0]!.key).toBe("table-a");
      const created = await a.client.create(selected, { title: "fixture-a", untouched: { value: 42 } });
      expect((await b.client.read(selected, created.id)).data).toEqual(created.data);
      for (let i = 0; i < 6; i++) await a.client.create(selected, { title: `fixture-${i}` });
      const first = await b.client.list(selected, 1, 5); const second = await b.client.list(selected, 2, 5);
      expect(first).toMatchObject({ total: 7, page: 1, pageSize: 5, totalPages: 2 }); expect(first.data.length).toBe(5); expect(second.data.length).toBe(2);
      expect(new Set([...first.data, ...second.data].map(row => row.id)).size).toBe(7);
      await b.client.update(selected, created.id, { ...created.data, title: "edited" });
      expect((await a.client.read(selected, created.id)).data).toEqual({ title: "edited", untouched: { value: 42 } });
      await b.client.remove(selected, created.id); expect((await a.client.trash(selected)).map(row => row.id)).toEqual([created.id]);
      await expect(a.client.read(selected, created.id)).rejects.toMatchObject({ status: 404 });
      await a.client.restore(selected, created.id); expect((await b.client.read(selected, created.id)).deleted_at).toBeNull(); expect(await b.client.trash(selected)).toEqual([]);
      expect(await a.client.count(selected)).toBe(7);
      for (const request of [...a.host.networkRequests, ...b.host.networkRequests]) {
        expect(request.endpointId).toBe("project-data"); expect(new Headers(request.headers as HeadersInit).has("authorization")).toBe(false);
      }
      expect(a.host.storageKeys()).toEqual([]); expect(b.host.storageKeys()).toEqual([]);
    } finally { await a.stop(); await b.stop(); }
  });
  test("read/write scopes and project ACL are separate; row IDs never bypass project", async () => {
    const f = createDataFixture(); const actor = fixtureActor(); const { client } = rawClient(f, actor);
    const row = await client.create(selected, { title: "fixture" });
    actor.scopes.delete("project:data:read"); await expect(client.list(selected)).rejects.toMatchObject({ status: 403, code: "insufficient_scope" });
    actor.scopes.add("project:data:read"); actor.scopes.delete("project:data:write"); await expect(client.update(selected, row.id, {})).rejects.toMatchObject({ status: 403 });
    actor.scopes.add("project:data:write"); actor.acl.set("project-a", { read: true, write: false });
    expect((await client.read(selected, row.id)).id).toBe(row.id); await expect(client.remove(selected, row.id)).rejects.toMatchObject({ status: 404 });
    actor.acl.set("project-b", { read: true, write: true }); await expect(client.read({ projectId: "project-b", collectionId: "table-b" }, row.id)).rejects.toMatchObject({ status: 404 });
    expect(f.rows.get(row.id)!.deleted_at).toBeNull();
  });
  test("project data is shared by ACL, not falsely bound to creator or plugin identity", async () => {
    const f = createDataFixture(); const a = rawClient(f, fixtureActor()); const b = rawClient(f, fixtureActor("user-b"));
    const row = await a.client.create(selected, { title: "shared" });
    expect((await b.client.read(selected, row.id)).owner_user_id).toBe("user-a");
    await b.client.update(selected, row.id, { title: "member edit" }); expect((await a.client.read(selected, row.id)).data.title).toBe("member edit");
  });
  test("unknown Collection list/trash is empty; schema/create fail and deleted Collection restore is 410", async () => {
    const f = createDataFixture(); const { client } = rawClient(f, fixtureActor()); const unknown = { ...selected, collectionId: "absent" };
    expect((await client.list(unknown)).data).toEqual([]); expect(await client.trash(unknown)).toEqual([]);
    await expect(client.schema(unknown)).rejects.toMatchObject({ status: 404 }); await expect(client.create(unknown, {})).rejects.toMatchObject({ status: 404 });
    const row = await client.create(selected, {}); await client.remove(selected, row.id); f.projects.set("project-a", []);
    // Backend accepts restore by row ID; the client must preserve its exact 410 response.
    await expect(client.restore(selected, row.id)).rejects.toMatchObject({ status: 410, code: "COLLECTION_DELETED" });
  });
  test("PATCH is a whole replacement without fabricated CAS/idempotency; KB-marked schema blocks writes", async () => {
    const f = createDataFixture(); const { client } = rawClient(f, fixtureActor()); const row = await client.create(selected, { a: 1, b: 2 });
    await client.update(selected, row.id, { a: 3 }); expect((await client.read(selected, row.id)).data).toEqual({ a: 3 });
    expect(f.records.find(r => r.method === "PATCH")!.body).toEqual({ data: { a: 3 } });
    f.projects.get("project-a")![0]!.children![0]!.schema = { fields: [{ name: "title", type: "string", knowledgeBaseTag: "fixture-kb" }] };
    const before = f.records.filter(r => r.method !== "GET").length;
    await expect(client.create(selected, { title: "safe" })).rejects.toMatchObject({ code: "DATA_KB_TABLE_EXCLUDED" });
    await expect(client.update(selected, row.id, {})).rejects.toMatchObject({ code: "DATA_KB_TABLE_EXCLUDED" });
    expect(f.records.filter(r => r.method !== "GET").length).toBe(before);
  });
  test("invalid IDs/page/data/pre-aborted calls send zero HTTP requests", async () => {
    const f = createDataFixture(); const { client, host } = rawClient(f, fixtureActor());
    for (const bad of ["../a", "a/b", "a?x", "", "a".repeat(129)]) await expect(client.collections(bad)).rejects.toMatchObject({ code: "DATA_INPUT_INVALID" });
    for (const page of [0, -1, 1.5, NaN]) await expect(client.list(selected, page)).rejects.toMatchObject({ code: "DATA_INPUT_INVALID" });
    await expect(client.list(selected, 1, 101)).rejects.toMatchObject({ code: "DATA_INPUT_INVALID" });
    await expect(client.create(selected, [] as unknown as Record<string, unknown>)).rejects.toMatchObject({ code: "DATA_INPUT_INVALID" });
    for (const bad of [{ value: new Date() }, { value: undefined }, { value: NaN }, { value: "x".repeat(65536) }]) await expect(client.create(selected, bad)).rejects.toMatchObject({ code: "DATA_INPUT_INVALID" });
    const c = new AbortController(); c.abort(); await expect(client.list(selected, 1, 5, c.signal)).rejects.toBeDefined();
    expect(host.networkRequests).toHaveLength(0);
  });
  test("malformed or mismatched success fails closed; failed mutations never retry and may be uncertain", async () => {
    const f = createDataFixture(); const { client } = rawClient(f, fixtureActor()); const row = await client.create(selected, {});
    const invalid = createDataClient({ fetch: async () => Response.json({ ...row, project_id: "other" }) });
    await expect(invalid.read(selected, row.id)).rejects.toMatchObject({ code: "DATA_RESPONSE_INVALID" });
    let calls = 0;
    const timeout = createDataClient({ fetch: async input => {
      calls++; if (String(input).endsWith("/schema")) return Response.json({ schema: { fields: [] } }); throw { code: "NETWORK_TIMEOUT", userMessage: "secret raw input" };
    } });
    await expect(timeout.create(selected, {})).rejects.toMatchObject({ code: "NETWORK_TIMEOUT", uncertain: true }); expect(calls).toBe(2);
    const malformed = createDataClient({ fetch: async input => String(input).endsWith("/schema") ? Response.json({ schema: { fields: [] } }) : Response.json({}) });
    await expect(malformed.create(selected, {})).rejects.toMatchObject({ code: "DATA_RESPONSE_INVALID", uncertain: true });
    const unavailable = createDataClient({ fetch: async input => String(input).endsWith("/schema") ? Response.json({ schema: { fields: [] } }) : new Response(JSON.stringify({ error: "private raw detail" }), { status: 503 }) });
    await expect(unavailable.create(selected, {})).rejects.toMatchObject({ code: "DATA_HTTP_503", status: 503, uncertain: true });
    expect(new DataError("DATA_HTTP_500").message).toBe("DATA_HTTP_500");
  });
});
