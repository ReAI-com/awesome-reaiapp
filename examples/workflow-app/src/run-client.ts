import type { AppHttpClient } from "@reai/app-sdk/v1";

export const RUN_ORIGIN = "https://block2-api.wainao.chat";
export const RUN_STATUSES = ["running", "success", "interrupted", "cancelled", "error", "completed"] as const;
export type RunStatus = typeof RUN_STATUSES[number];
export interface RunSummary { id: string; status: RunStatus; data: Record<string, unknown> }
export class WorkflowError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly uncertain = false) { super(code); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(value);
const invalidInput = (): never => { throw new WorkflowError("WORKFLOW_INPUT_INVALID"); };

/** SDK 1.24 finite JSON requests. OAuth credentials and principal come only from the Host. */
export function createRunClient(http: AppHttpClient) {
  async function request(path: string, method: "GET" | "POST", body?: object, signal?: AbortSignal, key?: string) {
    if (signal?.aborted) throw new WorkflowError("NETWORK_ABORTED");
    let response: Response;
    try {
      response = await http.fetch(`${RUN_ORIGIN}/runs${path}`, {
        endpointId: "workflow-runs", method, signal, redirect: "error",
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      const code = object(error) && safeCode(error.code) ? error.code : signal?.aborted ? "NETWORK_ABORTED" : "NETWORK_UPSTREAM_FAILED";
      throw new WorkflowError(code, 0, method === "POST");
    }
    let data: unknown;
    try { data = await response.json(); } catch { /* A malformed mutation receipt leaves an unknown outcome. */ }
    if (!response.ok) {
      throw new WorkflowError(object(data) && safeCode(data.error) ? data.error : `WORKFLOW_HTTP_${response.status}`, response.status, method === "POST" && response.status >= 500);
    }
    if (!object(data)) throw new WorkflowError("WORKFLOW_RESPONSE_INVALID", response.status, method === "POST");
    return data;
  }
  const invalidResponse = (mutation = false): never => { throw new WorkflowError("WORKFLOW_RESPONSE_INVALID", 200, mutation); };
  return {
    async create(documentId: string, inputs: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<{ runId: string }> {
      if (!identifier(documentId) || !identifier(requestId) || !object(inputs)) invalidInput();
      try { if (new TextEncoder().encode(JSON.stringify(inputs)).length > 256 * 1024) invalidInput(); } catch { invalidInput(); }
      const data = await request("", "POST", { documentId, inputs, requestId }, signal, requestId);
      return identifier(data.runId) ? { runId: data.runId } : invalidResponse(true);
    },
    async read(runId: string, signal?: AbortSignal): Promise<RunSummary> {
      if (!identifier(runId)) invalidInput();
      const data = await request(`/${runId}?trace=skip`, "GET", undefined, signal);
      if (data.id !== runId || !RUN_STATUSES.includes(data.status as RunStatus) || (data.data !== null && !object(data.data))) invalidResponse();
      return { id: runId, status: data.status as RunStatus, data: (data.data ?? {}) as Record<string, unknown> };
    },
    async resume(runId: string, askEventKey: string, answer: string, signal?: AbortSignal): Promise<{ ok: true; initialSequence: number }> {
      if (!identifier(runId) || !/^[0-9a-f]{40}$/.test(askEventKey) || !answer.trim() || new TextEncoder().encode(answer).length > 64 * 1024) invalidInput();
      const data = await request(`/${runId}/resume`, "POST", { mode: "answer", askEventKey, answer }, signal);
      if (data.ok !== true || !Number.isSafeInteger(data.initialSequence) || Number(data.initialSequence) < 0) invalidResponse(true);
      return { ok: true, initialSequence: Number(data.initialSequence) };
    },
    async cancel(runId: string, signal?: AbortSignal): Promise<{ ok: true; status: string }> {
      if (!identifier(runId)) invalidInput();
      const data = await request(`/${runId}/cancel`, "POST", { reason: "workflow-example-user-cancel" }, signal);
      if (data.ok !== true || !["cancelling", "cancelled", "success", "error"].includes(String(data.status))) invalidResponse(true);
      return { ok: true, status: String(data.status) };
    },
  };
}
export type RunClient = ReturnType<typeof createRunClient>;
