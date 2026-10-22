import { describe, expect, test } from "bun:test";
import { brokerFetch } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { createRunClient } from "../src/run-client";
import { ASK_KEY, createRunFixture, fixtureActor, type FixtureActor } from "./run-fixture";

const fixtureClient = (fixture: ReturnType<typeof createRunFixture>, actor: FixtureActor) => {
  const host = new MockHost({ manifest, loadApp: async () => ({ default: {} }), networkHandler: fixture.handler(actor) });
  return { host, client: createRunClient({ fetch: (input, init) => brokerFetch(host.bridge, input, init) }) };
};

describe("公开 run HTTP/OAuth 合同（合成 fixture）", () => {
  test("create/read/resume/cancel保持原user+App，受理不是终态", async () => {
    const fixture = createRunFixture();
    const actor = fixtureActor();
    const { host, client } = fixtureClient(fixture, actor);
    const { runId } = await client.create("document-a", { text: "fixture" }, "request-a");
    expect((await client.read(runId)).status).toBe("running");
    fixture.runs.get(runId)!.status = "success";
    expect((await client.resume(runId, ASK_KEY, "answer")).initialSequence).toBe(1);
    expect((await client.cancel(runId)).status).toBe("cancelling");
    expect((await client.read(runId)).status).toBe("running");
    fixture.runs.get(runId)!.status = "cancelled";
    expect((await client.read(runId)).status).toBe("cancelled");
    expect(fixture.records.every(record => record.actor.userId === actor.userId && record.actor.appId === actor.appId)).toBe(true);
    for (const record of fixture.records) {
      expect(record.body).not.toHaveProperty("appId");
      expect(record.body).not.toHaveProperty("userId");
      expect(record.body).not.toHaveProperty("token");
      expect(record.body).not.toHaveProperty("payerTeamId");
    }
    expect(host.networkRequests.every(request => request.endpointId === "workflow-runs" && !(request.headers as object).hasOwnProperty("authorization"))).toBe(true);
  });

  test("两App各自新流程，同用户跨App/异用户/历史NULL App读取继续取消拒绝", async () => {
    const fixture = createRunFixture();
    const a = fixtureClient(fixture, fixtureActor("app-a"));
    const b = fixtureClient(fixture, fixtureActor("app-b"));
    const c = fixtureClient(fixture, fixtureActor("app-a", "user-b"));
    const runA = await a.client.create("document-a", {}, "same-key");
    const runB = await b.client.create("new-workflow", {}, "same-key");
    expect(runA.runId).not.toBe(runB.runId);
    expect((await b.client.read(runB.runId)).id).toBe(runB.runId);
    for (const other of [b, c]) for (const action of [() => other.client.read(runA.runId), () => other.client.resume(runA.runId, ASK_KEY, "answer"), () => other.client.cancel(runA.runId)]) {
      await expect(action()).rejects.toMatchObject({ status: 403, code: "WORKFLOW_HTTP_403" });
    }
    fixture.runs.get(runA.runId)!.appId = null;
    await expect(a.client.read(runA.runId)).rejects.toMatchObject({ status: 403 });
  });

  test("每个scope与Project execute均独立拒绝，无重试/Host身份回退", async () => {
    const fixture = createRunFixture();
    const actor = fixtureActor();
    const { client, host } = fixtureClient(fixture, actor);
    actor.scopes.delete("flows:execute");
    await expect(client.create("doc", {}, "request")).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    actor.scopes.add("flows:execute"); actor.execute = false;
    await expect(client.create("doc", {}, "request")).rejects.toMatchObject({ code: "WORKFLOW_HTTP_403", status: 403 });
    actor.execute = true;
    const { runId } = await client.create("doc", {}, "request");
    actor.scopes.delete("runs:read");
    await expect(client.read(runId)).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    actor.scopes.delete("release:invoke");
    await expect(client.resume(runId, ASK_KEY, "answer")).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    await expect(client.cancel(runId)).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
    expect(host.networkRequests).toHaveLength(6);
  });

  test("固定创建requestId幂等，变更输入冲突，不复用到别的App", async () => {
    const fixture = createRunFixture();
    const { client } = fixtureClient(fixture, fixtureActor());
    const first = await client.create("doc", { text: "a" }, "fixed-key");
    expect((await client.create("doc", { text: "a" }, "fixed-key")).runId).toBe(first.runId);
    await expect(client.create("doc", { text: "b" }, "fixed-key")).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(fixture.runs.size).toBe(1);
  });

  test("幂等header显式发送且优先于body；completed取消按pinned后台受理", async () => {
    const fixture = createRunFixture(); const { client, host } = fixtureClient(fixture, fixtureActor());
    const { runId } = await client.create("doc", {}, "body-key");
    expect(new Headers(host.networkRequests[0]!.headers as Record<string,string>).get("idempotency-key")).toBe("body-key");
    const response = await brokerFetch(host.bridge, "https://block2-api.wainao.chat/runs", { endpointId:"workflow-runs", method:"POST", headers:{"Idempotency-Key":"header-key","content-type":"application/json"}, body:JSON.stringify({documentId:"doc",inputs:{},requestId:"body-key"}) });
    expect(response.status).toBe(200); expect((await response.json()).runId).not.toBe(runId); expect(fixture.runs.size).toBe(2);
    fixture.runs.get(runId)!.status = "completed";
    expect((await client.cancel(runId)).status).toBe("cancelling");
    expect((await client.read(runId)).status).toBe("completed");
    fixture.runs.get(runId)!.status = "interrupted";
    expect((await client.cancel(runId)).status).toBe("cancelled");
    expect((await client.read(runId)).status).toBe("cancelled");
  });

  test("trace额外项目read拒绝；正文读取不申请trace/SSE", async () => {
    const fixture = createRunFixture(); const actor = fixtureActor(); actor.readTrace = false;
    const { client, host } = fixtureClient(fixture, actor);
    const { runId } = await client.create("doc", {}, "key");
    expect((await client.read(runId)).id).toBe(runId);
    const response = await brokerFetch(host.bridge, `https://block2-api.wainao.chat/runs/${runId}/events`, { endpointId: "workflow-runs" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "oauth_run_trace_requires_project_read" });
  });

  test("本地坏路径/ask/answer与已abort不发送，错误体不泄漏原文", async () => {
    const fixture = createRunFixture(); const { client, host } = fixtureClient(fixture, fixtureActor());
    await expect(client.read("../other")).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    await expect(client.resume("run-1", "bad", "a")).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    await expect(client.resume("run-1", ASK_KEY, "中".repeat(22000))).rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    const controller = new AbortController(); controller.abort();
    await expect(client.create("doc", {}, "key", controller.signal)).rejects.toBeDefined();
    expect(host.networkRequests).toHaveLength(0);
    const bad = createRunClient({ fetch: async () => new Response(JSON.stringify({ error: "secret raw body" }), { status: 500 }) });
    await expect(bad.read("run-1")).rejects.toMatchObject({ code: "WORKFLOW_HTTP_500" });
  });

  test("pinned OAuth摘要data允许null；数组仍拒绝", async () => {
    const summary = (data: unknown) => createRunClient({fetch:async()=>new Response(JSON.stringify({id:"run-1",status:"running",data}))});
    expect(await summary(null).read("run-1")).toEqual({id:"run-1",status:"running",data:{}});
    await expect(summary([]).read("run-1")).rejects.toMatchObject({code:"WORKFLOW_RESPONSE_INVALID"});
  });

  test("畸形成功/身份错run/取消回执拒绝；余额与网络失败保持原错误", async () => {
    const body = (value: unknown, status = 200) => createRunClient({ fetch: async () => new Response(JSON.stringify(value), { status }) });
    await expect(body({}).create("doc", {}, "key")).rejects.toMatchObject({ code: "WORKFLOW_RESPONSE_INVALID", uncertain: true });
    await expect(body({ id: "other", status: "running", data: {} }).read("run-1")).rejects.toMatchObject({ code: "WORKFLOW_RESPONSE_INVALID" });
    await expect(body({ ok: false, status: "cancelled" }).cancel("run-1")).rejects.toMatchObject({ code: "WORKFLOW_RESPONSE_INVALID" });
    await expect(body({ error: "insufficient_credits" }, 402).create("doc", {}, "key")).rejects.toMatchObject({ code: "insufficient_credits", status: 402 });
    const network = createRunClient({ fetch: async () => { throw { code: "NETWORK_TIMEOUT" }; } });
    await expect(network.create("doc", {}, "key")).rejects.toMatchObject({ code: "NETWORK_TIMEOUT", uncertain: true });
  });
});
