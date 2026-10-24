/**
 * 外脑云端探针：用插件自己的 OAuth 应用身份（Driver 代附令牌，插件拿不到令牌原文）调外脑开放给插件的接口。
 *
 * 写操作只发生在名为「test」的项目里（能力探针的 OAuth 应用就绑在这个项目上），找不到就停下，不碰别的项目。
 * 「反例」是外脑目前没对插件开放的接口：被拒（401 / 403）才算按预期。
 * 接口与权限依据外脑后端 origin/main（2026-10-23）的路由与 scope 登记。
 */
import { describeError, isGateCode, gateHint, scrub } from "./errors";
import type { ProbePort } from "./port";
import type { ProbeDefinition, ProbeRun } from "./probes";

export const WAINAO_ORIGIN = "https://block2-api.wainao.chat";
/** 插件自己的 OAuth 应用身份访问外脑的地址（清单里 auth.mode = oauth_app）。 */
export const WAINAO_ENDPOINT_ID = "wainao-api";
/** 只往这个项目里写测试数据。 */
export const TEST_PROJECT_NAME = "test";
/** 每次测试上传的固定内容：内容不变，所以内容指纹应当不变。 */
/** 探针在外脑里留下的测试数据都带这些标记，清理工具只认这些标记，别的数据不碰。 */
export const PROBE_FILE_NAME = "capability-probe.txt";
export const PROBE_ROW_NAME = "能力探针测试行";
export const PROBE_KB_MARKER = "能力探针知识库测试";
export const PROBE_WORKFLOW_TITLE = "能力探针测试工作流";
export const PROBE_FILE_TEXT = "能力探针测试文件：这一行内容固定不变，用来核对同一内容上传两次的内容指纹。\n";

const OAUTH_HINTS: Record<string, string> = {
  PLUGIN_OAUTH_REAUTH_REQUIRED: "插件还没拿到外脑授权：重新安装插件，在安装弹窗里同意「连接网络服务」那一项",
  PLUGIN_OAUTH_METADATA_UNAVAILABLE: "Driver 读不到这个 OAuth 应用的开发版信息：确认应用勾了权限、填了回调地址，登录的是创建应用的账号",
  PLUGIN_OAUTH_METADATA_CHANGED: "OAuth 应用的设置改过了：重新安装插件",
  PLUGIN_OAUTH_SCOPE_REQUIRED: "OAuth 应用没勾这项权限：到开放平台给应用勾上后重新安装插件",
  PLUGIN_OAUTH_CLIENT_ID_CONFLICT: "另一个已装插件用了同一个 OAuth 应用编号",
};

export interface CloudResponse {
  status: number;
  text: string;
  json: unknown;
}

/** 调用没走到外脑（Driver 拦下 / 授权没走通 / 网络错误）时抛出，带着已经翻成人话的结果。 */
export class CloudStop extends Error {
  constructor(readonly run: ProbeRun) {
    super(run.summary);
  }
}

function failureRun(error: unknown): ProbeRun {
  const { code, message } = describeError(error);
  if (OAUTH_HINTS[code]) return { outcome: "blocked", summary: OAUTH_HINTS[code]!, code, detail: scrub(message) };
  if (isGateCode(code)) return { outcome: "blocked", summary: gateHint(code), code, detail: scrub(message) };
  return { outcome: "failed", summary: "调用出错", code, detail: scrub(message) };
}

/** 经 Driver 用插件自己的 OAuth 身份调外脑；Driver 侧的拒绝抛 CloudStop，外脑的 HTTP 状态原样返回。 */
export async function cloudCall(
  port: ProbePort,
  method: string,
  path: string,
  signal: AbortSignal,
  body?: { json?: unknown; form?: FormData },
): Promise<CloudResponse> {
  try {
    const response = await port.fetch(`${WAINAO_ORIGIN}${path}`, {
      endpointId: WAINAO_ENDPOINT_ID,
      method,
      signal,
      ...(body?.json !== undefined ? { body: JSON.stringify(body.json), headers: { "Content-Type": "application/json" } } : {}),
      ...(body?.form ? { body: body.form } : {}),
    });
    let json: unknown = null;
    try { json = JSON.parse(response.text); } catch { json = null; }
    return { status: response.status, text: response.text, json };
  } catch (error) {
    throw new CloudStop(failureRun(error));
  }
}

export function ok2xx(response: CloudResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** 正向调用拿到非 2xx 时的统一说法。 */
function httpRun(step: string, response: CloudResponse): ProbeRun {
  if (response.status === 401 || response.status === 403) {
    return { outcome: "blocked", summary: `${step}被外脑拒绝（HTTP ${response.status}）：OAuth 应用可能没勾这项权限`, detail: scrub(response.text, 300) };
  }
  return { outcome: "failed", summary: `${step}失败：外脑返回 HTTP ${response.status}`, detail: scrub(response.text, 300) };
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * 外脑有的接口把结果包在 data 里（{ success, data }），有的直接返回对象。
 * 直接返回的对象自己也可能有 data 字段（例如数据行的内容、运行摘要），所以带 id 的对象不拆。
 */
export function unwrap(json: unknown): unknown {
  const r = record(json);
  if (r && !("id" in r) && "data" in r && (record(r.data) || Array.isArray(r.data))) return r.data;
  return json;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function short(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** 一个探针里的多步调用：任何一步不对就停下，结果说明停在哪一步。 */
async function steps(run: () => Promise<ProbeRun>): Promise<ProbeRun> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CloudStop) return error.run;
    if (error instanceof StepStop) return error.run;
    return failureRun(error);
  }
}

export class StepStop extends Error {
  constructor(readonly run: ProbeRun) {
    super(run.summary);
  }
}

function stop(run: ProbeRun): never {
  throw new StepStop(run);
}

export function projectList(json: unknown): Record<string, unknown>[] | undefined {
  const value = unwrap(json);
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => record(item) !== undefined);
  const r = record(value);
  if (r) {
    for (const key of ["items", "projects", "results"]) {
      const list = r[key];
      if (Array.isArray(list)) return list.filter((item): item is Record<string, unknown> => record(item) !== undefined);
    }
  }
  return undefined;
}

/** 找名为 test 的项目；找不到就停下，不往别的项目里写。 */
export async function testProject(port: ProbePort, signal: AbortSignal): Promise<{ id: string; name: string }> {
  const response = await cloudCall(port, "GET", "/projects", signal);
  if (!ok2xx(response)) stop(httpRun("列项目", response));
  const list = projectList(response.json) ?? [];
  const found = list.find((item) => item.name === TEST_PROJECT_NAME);
  const id = str(found?.id);
  if (!id) stop({ outcome: "waiting", summary: `没找到名为「${TEST_PROJECT_NAME}」的项目：探针只往这个项目里写测试数据，请先在外脑建一个` });
  return { id, name: TEST_PROJECT_NAME };
}

function probeFile(): File {
  return new File([PROBE_FILE_TEXT], PROBE_FILE_NAME, { type: "text/plain" });
}

interface Uploaded {
  id: string;
  contentHash?: string;
}

async function upload(port: ProbePort, projectId: string, signal: AbortSignal): Promise<Uploaded> {
  const form = new FormData();
  form.append("file", probeFile());
  form.append("source", "capability-probe");
  const response = await cloudCall(port, "POST", `/storage/${encodeURIComponent(projectId)}/upload`, signal, { form });
  if (!ok2xx(response)) stop(httpRun("上传", response));
  const body = record(unwrap(response.json));
  const id = str(body?.id);
  if (!id) stop({ outcome: "unexpected", summary: "上传返回了成功，但没有文件编号", detail: scrub(response.text, 300) });
  const hash = str(body?.contentHash);
  return hash ? { id, contentHash: hash } : { id };
}

/** 反例：只认外脑的拒绝（401 / 403）才算按预期；成功了就是和预期不同。 */
function rejection(what: string, response: CloudResponse): ProbeRun {
  const error = str(record(response.json)?.error) ?? "";
  if (response.status === 401 || response.status === 403) {
    return { outcome: "blocked", expected: true, summary: `按预期被拒：外脑没对插件开放${what}（HTTP ${response.status}${error ? ` ${error}` : ""}）`, detail: scrub(response.text, 300) };
  }
  if (ok2xx(response)) return { outcome: "unexpected", summary: `没被拒：外脑接受了插件${what}（HTTP ${response.status}），和公开说明不一致`, detail: scrub(response.text, 300) };
  return { outcome: "failed", summary: `外脑返回 HTTP ${response.status}，不是预期的拒绝`, detail: scrub(response.text, 300) };
}

function cloud(def: Omit<ProbeDefinition, "section" | "level">): ProbeDefinition {
  return { section: "cloud", level: "P1", ...def };
}

/** 集合树里所有数据表（外脑返回 { databaseFolder: DatabaseNode[] }）。 */
export function allCollections(json: unknown): { id: string; name?: string }[] {
  const out: { id: string; name?: string }[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    const r = node as Record<string, unknown>;
    if (r.type === "table" && str(r.key)) {
      const name = str(r.label);
      out.push({ id: str(r.key)!, ...(name ? { name } : {}) });
      return;
    }
    for (const value of Object.values(r)) walk(value);
  };
  walk(unwrap(json));
  return out;
}

/** 在集合树里找第一张数据表（外脑返回 { databaseFolder: DatabaseNode[] }）。 */
export function firstCollectionId(json: unknown): { id: string; name?: string } | undefined {
  const seen = new Set<unknown>();
  const walk = (node: unknown): { id: string; name?: string } | undefined => {
    if (!node || typeof node !== "object" || seen.has(node)) return undefined;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { const hit = walk(item); if (hit) return hit; }
      return undefined;
    }
    const r = node as Record<string, unknown>;
    // 外脑的集合树节点是 { key, label, type: "folder" | "table", children?, schema? }，数据表的编号就是 key。
    if (r.type === "table" && str(r.key)) {
      const name = str(r.label);
      return { id: str(r.key)!, ...(name ? { name } : {}) };
    }
    for (const value of Object.values(r)) { const hit = walk(value); if (hit) return hit; }
    return undefined;
  };
  return walk(unwrap(json));
}

export const CLOUD_PROBES: ProbeDefinition[] = [
  cloud({
    id: "cloud-userinfo",
    title: "读当前用户",
    what: "用插件自己的 OAuth 身份读取当前用户（/oauth/userinfo），Driver 替插件附令牌",
    expect: "返回用户编号和名字；插件拿不到邮箱；界面只显示编号前几位",
    capability: "profile:read",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const response = await cloudCall(port, "GET", "/oauth/userinfo", signal);
      if (!ok2xx(response)) return httpRun("读用户", response);
      const body = record(response.json);
      const sub = str(body?.sub);
      if (!sub) return { outcome: "unexpected", summary: "外脑返回了 200，但里面没有用户编号", detail: scrub(response.text, 200) };
      const name = str(body?.display_name) ?? str(body?.name) ?? str(body?.nickname);
      const email = body?.email;
      const emailNote = email === null || email === undefined ? "，没有返回邮箱（符合预期）" : "，但返回了邮箱（和公开说明不一致）";
      return { outcome: email === null || email === undefined ? "ok" : "unexpected", summary: `外脑认得插件的身份：用户编号 ${sub.slice(0, 6)}…${name ? `，名字「${name.slice(0, 20)}」` : ""}${emailNote}` };
    }),
  }),
  cloud({
    id: "cloud-projects",
    title: "列出项目",
    what: "列出当前用户能读的项目（GET /projects）",
    expect: `返回项目列表；写操作只用名为「${TEST_PROJECT_NAME}」的项目`,
    capability: "projects:read",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const response = await cloudCall(port, "GET", "/projects", signal);
      if (!ok2xx(response)) return httpRun("列项目", response);
      const list = projectList(response.json);
      if (!list) return { outcome: "unexpected", summary: "外脑返回了 200，但不是能认出的项目列表", detail: scrub(response.text, 200) };
      const hasTest = list.some((item) => item.name === TEST_PROJECT_NAME);
      return { outcome: "ok", summary: `能读到 ${list.length} 个项目；${hasTest ? `有「${TEST_PROJECT_NAME}」项目，后面的写测试用它` : `没有「${TEST_PROJECT_NAME}」项目，后面的写测试会停下`}` };
    }),
  }),
  cloud({
    id: "cloud-files-list",
    title: "列出云端文件",
    what: `列出「${TEST_PROJECT_NAME}」项目里的文件（GET /storage/<项目>/files）`,
    expect: "返回文件列表（个数）",
    capability: "project:files:read",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const response = await cloudCall(port, "GET", `/storage/${encodeURIComponent(project.id)}/files`, signal);
      if (!ok2xx(response)) return httpRun("列文件", response);
      const files = record(unwrap(response.json))?.files;
      if (!Array.isArray(files)) return { outcome: "unexpected", summary: "外脑返回了 200，但没有文件列表", detail: scrub(response.text, 200) };
      return { outcome: "ok", summary: `「${project.name}」项目里有 ${files.length} 个文件` };
    }),
  }),
  cloud({
    id: "cloud-files-upload",
    title: "上传文件到云端",
    what: `把一段固定内容的小文本上传到「${TEST_PROJECT_NAME}」项目两次（POST /storage/<项目>/upload）`,
    expect: "两次都成功；内容相同，所以内容指纹（contentHash）相同",
    capability: "project:files:write",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const first = await upload(port, project.id, signal);
      const second = await upload(port, project.id, signal);
      if (!first.contentHash || !second.contentHash) return { outcome: "unexpected", summary: `上传成功（文件 ${short(first.id)}），但没返回内容指纹` };
      if (first.contentHash !== second.contentHash) return { outcome: "unexpected", summary: "同一内容上传两次，内容指纹却不同", detail: `${first.contentHash} / ${second.contentHash}` };
      return { outcome: "ok", summary: `上传两次都成功，内容指纹相同（${first.contentHash.slice(0, 12)}…）；文件编号 ${short(first.id)}、${short(second.id)}` };
    }),
  }),
  cloud({
    id: "cloud-files-delete",
    title: "删除云端文件（反例）",
    what: "上传一个测试文件，再尝试删除它（DELETE /storage/<项目>/files/<文件>）",
    expect: "被拒：外脑目前没对插件开放删除（测试文件会留在项目里）",
    capability: "project:files:write",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const file = await upload(port, project.id, signal);
      const response = await cloudCall(port, "DELETE", `/storage/${encodeURIComponent(project.id)}/files/${encodeURIComponent(file.id)}`, signal);
      return rejection("删除文件", response);
    }),
  }),
  cloud({
    id: "cloud-folder",
    title: "云端文件夹（反例）",
    what: "尝试在测试项目里建文件夹（POST /storage/<项目>/folders）",
    expect: "被拒：外脑目前没对插件开放文件夹操作",
    capability: "project:files:write",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const response = await cloudCall(port, "POST", `/storage/${encodeURIComponent(project.id)}/folders`, signal, { json: { name: "capability-probe" } });
      return rejection("文件夹操作", response);
    }),
  }),
  cloud({
    id: "cloud-kb",
    title: "知识库写入与搜索",
    what: "上传一个测试文件，给它写一条知识库内容（/kb/nodes），再按关键词搜索（/kb/text-search）",
    expect: "写入成功；搜索请求成功（会产生少量向量化费用）",
    capability: "project:kb:read + project:kb:write",
    risk: "cost",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const file = await upload(port, project.id, signal);
      const marker = `${PROBE_KB_MARKER} ${new Date().toISOString()}`;
      const pid = encodeURIComponent(project.id);
      const write = await cloudCall(port, "POST", `/projects/${pid}/kb/nodes`, signal, { json: { source_type: "file", source_id: file.id, level: 0, content: marker } });
      if (!ok2xx(write)) return httpRun("写知识库", write);
      const nodeId = str(record(unwrap(write.json))?.id);
      const search = await cloudCall(port, "POST", `/projects/${pid}/kb/text-search`, signal, { json: { query: PROBE_KB_MARKER } });
      if (!ok2xx(search)) return httpRun("搜知识库", search);
      const hits = unwrap(search.json);
      const count = Array.isArray(hits) ? hits.length : undefined;
      const found = search.text.includes(marker);
      return { outcome: "ok", summary: `写入成功${nodeId ? `（节点 ${short(nodeId)}）` : ""}；搜索成功，返回 ${count ?? "若干"} 条${found ? "，搜到了刚写的内容" : "，刚写的内容还没出现在结果里（向量化可能有延迟）"}` };
    }),
  }),
  cloud({
    id: "cloud-data",
    title: "数据表的行增删改",
    what: "在测试项目第一张数据表里：读行、增一行、改它、删它、再恢复它（最后留下这条测试行）",
    expect: "每一步都成功",
    capability: "project:data:read + project:data:write",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const pid = encodeURIComponent(project.id);
      const collections = await cloudCall(port, "GET", `/projects/${pid}/collections`, signal);
      if (!ok2xx(collections)) return httpRun("列数据表", collections);
      const collection = firstCollectionId(collections.json);
      if (!collection) return { outcome: "waiting", summary: `「${project.name}」项目里没有数据表：插件不能建表，请先在外脑建一张，再回来测`, detail: scrub(collections.text, 300) };
      const cid = encodeURIComponent(collection.id);
      const read = await cloudCall(port, "GET", `/projects/${pid}/data?collectionId=${cid}`, signal);
      if (!ok2xx(read)) return httpRun("读行", read);
      const total = record(unwrap(read.json))?.total ?? record(read.json)?.total;
      const created = await cloudCall(port, "POST", `/projects/${pid}/data`, signal, { json: { collectionId: collection.id, data: { name: PROBE_ROW_NAME } } });
      if (!ok2xx(created)) return httpRun("增一行", created);
      const rowId = str(record(unwrap(created.json))?.id);
      if (!rowId) return { outcome: "unexpected", summary: "增一行返回了成功，但没有行编号", detail: scrub(created.text, 300) };
      const rid = encodeURIComponent(rowId);
      const patched = await cloudCall(port, "PATCH", `/projects/${pid}/data/${rid}`, signal, { json: { data: { name: `${PROBE_ROW_NAME}（改过）` } } });
      if (!ok2xx(patched)) return httpRun("改行", patched);
      const removed = await cloudCall(port, "DELETE", `/projects/${pid}/data/${rid}`, signal);
      if (!ok2xx(removed)) return httpRun("删行", removed);
      const restored = await cloudCall(port, "POST", `/projects/${pid}/data/${rid}/restore`, signal);
      if (!ok2xx(restored)) return httpRun("恢复行", restored);
      return { outcome: "ok", summary: `数据表「${collection.name ?? short(collection.id)}」：读到 ${typeof total === "number" ? total : "若干"} 行，增、改、删、恢复都成功（行 ${short(rowId)}）` };
    }),
  }),
  cloud({
    id: "cloud-collections",
    title: "新建数据表（反例）",
    what: "尝试在测试项目里新建一张数据表（POST /projects/<项目>/collections）",
    expect: "被拒：外脑目前没对插件开放改表结构",
    capability: "project:data:write",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const response = await cloudCall(port, "POST", `/projects/${encodeURIComponent(project.id)}/collections`, signal, { json: { name: "capability-probe" } });
      return rejection("新建数据表", response);
    }),
  }),
  cloud({
    id: "cloud-workflow",
    title: "工作流新建、编辑、运行",
    what: "在测试项目里新建一个最小工作流，读正文、原样编辑保存一次，跑一次并读运行结果",
    expect: "新建、编辑、启动运行、读到运行记录都成功（运行可能还在进行中）",
    capability: "documents:read + documents:write + flows:execute + runs:read",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const created = await cloudCall(port, "POST", "/documents", signal, { json: { project_id: project.id, title: `${PROBE_WORKFLOW_TITLE} ${new Date().toISOString().slice(0, 16)}` } });
      if (!ok2xx(created)) return httpRun("新建工作流", created);
      const doc = record(unwrap(created.json));
      const docId = str(doc?.id);
      if (!docId) return { outcome: "unexpected", summary: "新建返回了成功，但没有文档编号", detail: scrub(created.text, 300) };
      const did = encodeURIComponent(docId);
      const content = await cloudCall(port, "GET", `/documents/${did}/content`, signal);
      if (!ok2xx(content)) return httpRun("读工作流正文", content);
      const contentBody = record(unwrap(content.json));
      const baseVersion = str(contentBody?.content_hash) ?? str(contentBody?.version) ?? str(doc?.content_hash);
      const docContent = contentBody?.content ?? contentBody?.doc;
      if (!baseVersion || !docContent) return { outcome: "unexpected", summary: "读到了正文，但缺版本号或内容，没法编辑", detail: scrub(content.text, 300) };
      const edited = await cloudCall(port, "POST", `/documents/${did}/edit`, signal, { json: { base_version: baseVersion, mode: "content", content: docContent } });
      if (!ok2xx(edited)) return httpRun("编辑工作流", edited);
      const started = await cloudCall(port, "POST", "/runs", signal, { json: { documentId: docId, inputs: {} } });
      if (!ok2xx(started)) return httpRun("运行工作流", started);
      const runId = str(record(unwrap(started.json))?.runId);
      if (!runId) return { outcome: "unexpected", summary: "启动运行返回了成功，但没有运行编号", detail: scrub(started.text, 300) };
      let status = "";
      for (let attempt = 0; attempt < 5 && !signal.aborted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const got = await cloudCall(port, "GET", `/runs/${encodeURIComponent(runId)}`, signal);
        if (!ok2xx(got)) return httpRun("读运行结果", got);
        // 运行详情的状态在顶层（它的 data 字段是运行摘要，不是外层包装）。
        status = str(record(got.json)?.status) ?? str(record(unwrap(got.json))?.status) ?? "";
        if (["completed", "succeeded", "success", "failed", "error", "cancelled"].includes(status)) break;
      }
      return { outcome: "ok", summary: `新建（${short(docId)}）、编辑、启动运行（${short(runId)}）、读运行记录都成功；运行状态：${status || "未知"}` };
    }),
  }),
  cloud({
    id: "cloud-model",
    title: "调用大模型",
    what: "列出模型，用列表里的第一个模型发一句「回复 ok」（/api/model-gateway/v1）",
    expect: "返回模型列表和一次回复（会消耗少量额度）",
    capability: "model-gateway:invoke",
    risk: "cost",
    run: ({ port, signal }) => steps(async () => {
      const models = await cloudCall(port, "GET", "/api/model-gateway/v1/models", signal);
      if (!ok2xx(models)) return httpRun("列模型", models);
      const list = (record(models.json)?.data ?? unwrap(models.json)) as unknown;
      const ids = Array.isArray(list) ? list.map((item) => str(record(item)?.id)).filter((id): id is string => id !== undefined) : [];
      if (ids.length === 0) return { outcome: "unexpected", summary: "列模型返回了成功，但列表是空的", detail: scrub(models.text, 300) };
      const model = ids[0]!;
      const chat = await cloudCall(port, "POST", "/api/model-gateway/v1/chat/completions", signal, { json: { model, messages: [{ role: "user", content: "只回复两个字母：ok" }], max_tokens: 8 } });
      if (!ok2xx(chat)) return httpRun(`用 ${model} 对话`, chat);
      const choice = record((record(chat.json)?.choices as unknown[] | undefined)?.[0]);
      const reply = str(record(choice?.message)?.content) ?? "";
      return { outcome: "ok", summary: `能列出 ${ids.length} 个模型；用 ${model} 对话成功，回复「${reply.slice(0, 30)}」` };
    }),
  }),
  cloud({
    id: "cloud-graph",
    title: "图谱（反例）",
    what: "尝试读取测试项目的图谱状态（GET /projects/<项目>/graph/status）",
    expect: "被拒：外脑目前没对插件开放图谱",
    capability: "—",
    risk: "safe",
    run: ({ port, signal }) => steps(async () => {
      const project = await testProject(port, signal);
      const response = await cloudCall(port, "GET", `/projects/${encodeURIComponent(project.id)}/graph/status`, signal);
      return rejection("图谱", response);
    }),
  }),
];
