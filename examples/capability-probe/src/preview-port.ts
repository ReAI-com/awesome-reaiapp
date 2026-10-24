/**
 * 浏览器预览与测试用的假 Host：只有内存数据，不发任何网络请求。
 * 不会被打进插件安装包（安装包入口是 src/app.ts）。
 */
import type { SystemTaskVersionStatus } from "@reai/app-sdk/v1";
import type { KvPort, ProbePort } from "./port";

export interface PreviewOptions {
  developerMode?: boolean;
  /** 模拟用户还没同意的权限。 */
  deniedPermissions?: Set<string>;
  voiceInstalled?: boolean;
  /** 模拟 Driver 检查未声明的存储空间（真实行为未核实）。 */
  rejectUndeclaredStore?: boolean;
  delayMs?: number;
  /** 模拟旧版 Driver 的宽松网络档：不检查声明，也放行 http。默认按当前 Driver 的严格档。 */
  lenientNetwork?: boolean;
}

interface PreviewDictation {
  phase: "listening" | "processing" | "completed" | "cancelled";
  revision: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** 与 Voice 插件相同的请求号规则：`<毫秒时间>:<UUIDv4>`。 */
const VOICE_REQUEST_ID = /^(\d{1,16}):[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

const KV_VALUE_LIMIT = 256 * 1024;

function bridgeError(code: string, message: string): Error & { code: string; userMessage: string } {
  return Object.assign(new Error(message), { code, userMessage: message });
}

export function createPreviewPort(options: PreviewOptions = {}): ProbePort & { setDeveloperMode(value: boolean): void } {
  const dictations = new Map<string, PreviewDictation>();
  const cloudState: FakeCloudState = { uploads: 0, rows: [], kb: [], nextId: 0 };
  /** 结束一次进行中的模拟听写：清掉待完成的计时器，终态记为已取消。 */
  const stop = (item: PreviewDictation, message: string) => {
    if (item.phase !== "listening" && item.phase !== "processing") return;
    if (item.timer !== undefined) clearTimeout(item.timer);
    item.timer = undefined;
    item.phase = "cancelled";
    item.revision += 1;
    item.reject(bridgeError("SERVICE_CANCELLED", message));
  };
  const stores = new Map<string, Map<string, unknown>>();
  const listeners = new Set<(value: { developerMode: boolean }) => void>();
  let developerMode = options.developerMode ?? true;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 120));
  const denied = (permission: string) => options.deniedPermissions?.has(permission) === true;

  const kvStore = (storeId: string): KvPort => {
    const declared = storeId === "probe";
    const data = stores.get(storeId) ?? new Map<string, unknown>();
    stores.set(storeId, data);
    const guard = () => {
      if (!declared && options.rejectUndeclaredStore) throw bridgeError("STORAGE_NOT_DECLARED", "存储空间没有在清单里声明");
    };
    return {
      async get(key) { await delay(); guard(); return structuredClone(data.get(key)); },
      async set(key, value) {
        await delay();
        guard();
        if (JSON.stringify(value).length > KV_VALUE_LIMIT) throw bridgeError("STORAGE_QUOTA_EXCEEDED", "单条数据超过 256 KiB");
        data.set(key, structuredClone(value));
      },
      async compareAndSet(key, expected, value) {
        await delay();
        guard();
        if (JSON.stringify(data.get(key)) !== JSON.stringify(expected)) return false;
        data.set(key, structuredClone(value));
        return true;
      },
      async delete(key) { await delay(); guard(); data.delete(key); },
      async keys() { await delay(); guard(); return [...data.keys()]; },
    };
  };

  const versionStatus: SystemTaskVersionStatus = {
    firmware: { currentVersion: "1.59", latestVersion: "1.59", updateAvailable: false, connected: true, connectionType: "usb" },
    app: { currentVersion: "预览", latestVersion: null, updateAvailable: false, installable: false, blockedReason: "development-build" },
    checkedAt: null,
    source: "unavailable",
  };

  return {
    mode: "preview",
    async environment() { return { developerMode }; },
    onEnvironmentChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    setDeveloperMode(value) {
      developerMode = value;
      for (const listener of listeners) listener({ developerMode });
    },
    locale: () => "zh",
    kv: kvStore("probe"),
    kvStore,
    async versionStatus() { await delay(); return structuredClone(versionStatus); },
    async openSystemTask(_target: unknown, _returnIntent?: unknown) { await delay(); return { taskId: "preview-task" }; },
    async accountStatus() {
      await delay();
      if (denied("account.status@1")) throw bridgeError("PLUGIN_PERMISSION_DENIED", "用户拒绝了 account.status@1");
      return { enabled: true, loggedIn: true };
    },
    async notify() {
      await delay();
      if (denied("os.notification.post@1")) throw bridgeError("PLUGIN_PERMISSION_REQUIRED", "需要用户允许 os.notification.post@1");
      return { queued: true as const };
    },
    async fetch(url, init) {
      await delay();
      if (denied("http.fetch@1")) throw bridgeError("PLUGIN_PERMISSION_REQUIRED", "需要用户允许 http.fetch@1");
      const parsed = new URL(url);
      if (options.lenientNetwork) return { status: 200, text: "预览假数据：宽松网络档放行了这个请求" };
      // 与 Driver 一致：先按清单匹配地址。清单只收 https，所以 http 地址在这一步就按「没声明」拦下。
      if (parsed.origin === "https://block2-api.wainao.chat" && !parsed.pathname.startsWith("/health")) {
        if (init.endpointId !== "wainao-api") throw bridgeError("NETWORK_ENDPOINT_NOT_DECLARED", "没带插件 OAuth 地址");
        let body: unknown;
        try { body = typeof init.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
        return fakeWainao(init.method, parsed.pathname, cloudState, body, parsed.searchParams);
      }
      if (parsed.origin !== "https://block2-api.wainao.chat" || !parsed.pathname.startsWith("/health")) {
        throw bridgeError("NETWORK_ENDPOINT_NOT_DECLARED", "URL origin 未在 Manifest 中申报");
      }
      return { status: 200, text: "{\"status\":\"ok\",\"note\":\"预览假数据，没有真的访问网络\"}" };
    },
    async callService(serviceId, method, input, signal) {
      await delay();
      if (!options.voiceInstalled) throw bridgeError("SERVICE_PROVIDER_UNAVAILABLE", `${serviceId} 未安装或未启用`);
      const requestId = (input as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId !== "string" || !VOICE_REQUEST_ID.test(requestId)) throw bridgeError("VOICE_REQUEST_INVALID", "请求号格式不对");
      // 预览里模拟一次听写：开始后进入「听写中」，点「说完了」进入「识别中」并返回一句假文字。
      const job = dictations.get(requestId);
      if (method === "request-text") {
        if ([...dictations.values()].some((item) => item.phase === "listening" || item.phase === "processing")) throw bridgeError("SERVICE_BUSY", "正在录别的");
        return new Promise((resolve, reject) => {
          const onAbort = () => stop(item, "已取消");
          const item: PreviewDictation = {
            phase: "listening",
            revision: 2,
            resolve: (value) => { signal?.removeEventListener("abort", onAbort); resolve(value); },
            reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
          };
          dictations.set(requestId, item);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (method === "finish") {
        if (!job || job.phase !== "listening") return { accepted: false };
        job.phase = "processing";
        job.revision += 1;
        job.timer = setTimeout(() => {
          job.timer = undefined;
          if (job.phase !== "processing") return;
          job.phase = "completed";
          job.revision += 1;
          job.resolve({ requestId, text: "这是预览里的假识别结果", kind: "processed" });
        }, Math.max(options.delayMs ?? 0, 1));
        return { accepted: true };
      }
      if (method === "cancel") {
        if (!job || (job.phase !== "listening" && job.phase !== "processing")) return { accepted: false };
        stop(job, "已取消");
        return { accepted: true };
      }
      if (!job) return { requestId, phase: "not_found", revision: 0, captureStarted: false, pcmReceived: "unknown" };
      return { requestId, phase: job.phase, revision: job.revision, captureStarted: true, pcmReceived: job.phase !== "listening" || job.revision > 2 };
    },
  };
}

/** 预览里的假外脑：形状按外脑后端真实返回写，数据全是假的，不访问网络。 */
export interface FakeCloudState {
  uploads: number;
  /** 数据行：外脑删行是软删除（进回收站），可以恢复。 */
  rows: { id: string; name: string; deleted?: boolean }[];
  kb: { id: string; content: string }[];
  nextId: number;
}

function fakeWainao(method: string, path: string, state: FakeCloudState, body?: unknown, query = new URLSearchParams()): { status: number; text: string } {
  const json = (status: number, body: unknown) => ({ status, text: JSON.stringify(body) });
  // 和外脑一样按 page / pageSize 分页（pageSize 最多 100）。
  const page = <T>(list: T[]) => {
    const size = Math.min(Number(query.get("pageSize") ?? 20) || 20, 100);
    const at = Math.max(Number(query.get("page") ?? 1) || 1, 1);
    return list.slice((at - 1) * size, at * size);
  };
  if (method === "GET" && path === "/oauth/userinfo") return json(200, { sub: "preview-user-0001", email: null, display_name: "预览用户", name: "预览用户", avatar_url: null, scope: "profile:read" });
  if (method === "GET" && path === "/projects") return json(200, { success: true, data: [{ id: "p-test", name: "test" }, { id: "p-other", name: "别的项目" }] });
  if (method === "GET" && path === "/storage/p-test/files") return json(200, { files: Array.from({ length: state.uploads }, (_, i) => ({ id: `f${i}`, name: "capability-probe.txt" })) });
  if (method === "POST" && path === "/storage/p-test/upload") { state.uploads += 1; return json(200, { id: `f${state.uploads}`, contentHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }); }
  if (method === "DELETE" && path.startsWith("/storage/")) return json(403, { error: "insufficient_scope" });
  if (method === "POST" && path === "/storage/p-test/folders") return json(403, { error: "insufficient_scope" });
  if (method === "POST" && path === "/projects/p-test/kb/nodes") {
    const id = `kb-node-${++state.nextId}`;
    state.kb.push({ id, content: String((body as { content?: unknown } | undefined)?.content ?? "") });
    return json(201, { id });
  }
  if (method === "GET" && path === "/projects/p-test/kb/nodes") return json(200, { data: page(state.kb).map((node) => ({ ...node, source_type: "file" })), total: state.kb.length });
  if (method === "DELETE" && /^\/projects\/p-test\/kb\/nodes\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/").pop()!);
    const before = state.kb.length;
    state.kb = state.kb.filter((node) => node.id !== id);
    return state.kb.length < before ? json(200, { success: true }) : json(404, { error: "KB_NODE_NOT_FOUND" });
  }
  if (method === "POST" && path === "/projects/p-test/kb/text-search") return json(200, { data: [{ id: "kb-node-1" }] });
  if (method === "GET" && path === "/projects/p-test/collections") return json(200, { databaseFolder: [{ key: "folder-1", label: "预览目录", type: "folder", children: [{ key: "c1", label: "预览数据表", type: "table" }] }] });
  if (method === "GET" && path === "/projects/p-test/data") return json(200, { data: page(query.get("collectionId") === "c1" ? state.rows.filter((row) => !row.deleted) : []).map((row) => ({ id: row.id, collection_id: "c1", data: { name: row.name } })), total: state.rows.filter((row) => !row.deleted).length });
  if (method === "POST" && path === "/projects/p-test/data") {
    const row = { id: `row-${++state.nextId}`, name: String((body as { data?: { name?: unknown } } | undefined)?.data?.name ?? "") };
    state.rows.push(row);
    return json(201, { id: row.id, collection_id: "c1", data: { name: row.name } });
  }
  if (method === "PATCH" && /^\/projects\/p-test\/data\/[^/]+$/.test(path)) return json(200, { success: true });
  if (method === "DELETE" && /^\/projects\/p-test\/data\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split("/").pop()!);
    const row = state.rows.find((item) => item.id === id && !item.deleted);
    if (!row) return json(404, { error: "not found" });
    row.deleted = true;
    return json(200, { success: true });
  }
  if (/^\/projects\/p-test\/data\/[^/]+\/restore$/.test(path)) {
    const row = state.rows.find((item) => item.id === decodeURIComponent(path.split("/")[4]!));
    if (row) row.deleted = false;
    return json(200, { id: row?.id ?? "row" });
  }
  if (method === "POST" && path === "/projects/p-test/collections") return json(401, { error: "JWT authentication failed" });
  if (method === "POST" && path === "/documents") return json(201, { id: "doc-1", title: "t", doc_type: "flow", content_hash: "h1" });
  if (method === "GET" && path === "/documents/doc-1/content") return json(200, { content_hash: "h1", content: { type: "doc", content: [] } });
  if (method === "POST" && path === "/documents/doc-1/edit") return json(200, { success: true, content_hash: "h2" });
  if (method === "POST" && path === "/runs") return json(200, { runId: "run-1", executeMode: "async" });
  if (method === "GET" && path === "/runs/run-1") return json(200, { id: "run-1", status: "completed", data: { duration: 12 } });
  if (method === "GET" && path === "/api/model-gateway/v1/models") return json(200, { object: "list", data: [{ id: "preview-model" }] });
  if (method === "POST" && path === "/api/model-gateway/v1/chat/completions") return json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });
  if (method === "GET" && path === "/projects/p-test/graph/status") return json(401, { error: "JWT authentication failed" });
  return json(404, { error: "预览里没有模拟这个接口" });
}
