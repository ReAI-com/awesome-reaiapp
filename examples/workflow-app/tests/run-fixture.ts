import type { MockNetworkHandler } from "@reai/app-test/v1";

/** Synthetic contract fixture for the public workflow API. No token or live network. */
export interface FixtureActor {
  userId: string;
  appId: string;
  scopes: Set<string>;
  execute: boolean;
  readTrace: boolean;
}
export const ASK_KEY = "a".repeat(40);
export const fixtureActor = (appId = "app-a", userId = "user-a"): FixtureActor => ({
  userId, appId, scopes: new Set(["flows:execute", "runs:read", "release:invoke"]),
  execute: true, readTrace: true,
});

interface FixtureRun {
  id: string;
  userId: string;
  appId: string | null;
  sourceType: string;
  status: string;
  fingerprint: string;
  requestId: string;
  sequence: number;
}
export function createRunFixture() {
  const runs = new Map<string, FixtureRun>();
  const records: Array<{ actor: { userId: string; appId: string }; path: string; body: Record<string, unknown> }> = [];
  const json = (status: number, body: unknown) => ({ status, headers: { "content-type": "application/json" }, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") });
  const handler = (actor: FixtureActor): MockNetworkHandler => async ({ request, body }) => {
    const url = new URL(String(request.url));
    const path = url.pathname;
    const method = String(request.method);
    const input = body.size ? JSON.parse(await body.text()) as Record<string, unknown> : {};
    records.push({ actor: { userId: actor.userId, appId: actor.appId }, path, body: input });
    const headers = request.headers as Record<string, string>;
    const scope = path === "/runs" ? "flows:execute" : method === "GET" && !path.endsWith("events") ? "runs:read" : "release:invoke";
    if (!actor.scopes.has(scope)) return json(403, { error: "insufficient_scope" });
    if (path === "/runs" && method === "POST") {
      if (!actor.execute) return json(403, { error: "无运行权限，请联系项目管理员授权" });
      const requestId = String(new Headers(headers).get("idempotency-key") ?? input.requestId ?? "");
      const fingerprint = JSON.stringify(input);
      const replay = [...runs.values()].find(run => run.userId === actor.userId && run.appId === actor.appId && run.requestId === requestId);
      if (replay) return replay.fingerprint === fingerprint
        ? json(200, { runId: replay.id, status: replay.status, idempotentReplay: true })
        : json(409, { error: "idempotency_conflict" });
      const id = `run-${runs.size + 1}`;
      runs.set(id, { id, userId: actor.userId, appId: actor.appId, status: "running", sourceType: "oauth", fingerprint, requestId, sequence: 0 });
      return json(200, { runId: id, initialEventId: "fixture-0", executeMode: "inline" });
    }
    const run = runs.get(path.split("/")[2] ?? "");
    if (!run) return json(404, { error: "运行记录不存在" });
    if (run.userId !== actor.userId || run.appId !== actor.appId || run.sourceType !== "oauth") return json(403, { error: "无权访问该运行记录" });
    if (path.endsWith("events")) {
      if (!actor.readTrace) return json(403, { error: "oauth_run_trace_requires_project_read" });
      // Only the trace gate is modeled. Do not invent a finite JSON response for the real SSE route.
      return json(501, { error: "FIXTURE_SSE_NOT_IMPLEMENTED" });
    }
    if (path.endsWith("/resume")) {
      if (!["success", "interrupted"].includes(run.status)) return json(409, { error: "run_not_resumable" });
      if (input.mode !== "answer" || input.askEventKey !== ASK_KEY || !input.answer) return json(400, { error: "answer_invalid" });
      run.status = "running";
      run.sequence += 1;
      return json(200, { ok: true, acceptedAt: "2026-10-05T00:00:00Z", initialSequence: run.sequence, askAnswerEventKey: "b".repeat(40) });
    }
    if (path.endsWith("/cancel")) {
      if (["success", "error", "cancelled"].includes(run.status)) return json(200, { ok: true, status: run.status, alreadyTerminated: true });
      if (run.status === "interrupted") run.status = "cancelled";
      return json(200, { ok: true, status: run.status === "cancelled" ? "cancelled" : "cancelling" });
    }
    return json(200, { id: run.id, status: run.status, source_type: "oauth", triggered_by_user_id: run.userId,
      data: run.status === "success" ? { output: { endpointId: "result", endpointName: "Result", value: "fixture result" } } : {} });
  };
  return { runs, records, handler };
}
