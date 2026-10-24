/**
 * 一键清理探针测试数据。
 *
 * 只删探针自己留下的东西，靠固定标记认，别的数据一律不碰：
 * - 本地：本插件存储里 probe.* / page.* 的键（测试结果由界面另走「清空」流程）。
 * - 外脑：只在名为「test」的项目里找。
 *   - 知识库内容：以「能力探针知识库测试」开头的节点 → 删除。
 *   - 数据表的行：名字以「能力探针测试行」开头的行 → 删除（外脑是移到回收站）。
 *   - 测试文件、测试工作流：外脑没对插件开放删除，只数出来，提示到外脑网页删。
 *
 * 接口与权限依据外脑后端 origin/main（2026-10-24）：DELETE kb/nodes 需 project:kb:write，
 * DELETE data 需 project:data:write；DELETE /documents 对插件只允许删 Skill，删不了工作流。
 */
import { describeError, scrub } from "./errors";
import type { KvPort, ProbePort } from "./port";
import { SAVED_RESULTS_KEY } from "./saved-results";
import {
  allCollections, CloudStop, cloudCall, ok2xx, PROBE_FILE_NAME, PROBE_KB_MARKER, PROBE_ROW_NAME,
  PROBE_WORKFLOW_TITLE, record, StepStop, str, TEST_PROJECT_NAME, testProject, unwrap,
} from "./cloud-probes";

export type CleanupStatus = "deleted" | "none" | "partial" | "manual" | "failed" | "skipped";

export interface CleanupItem {
  id: "local" | "kb" | "rows" | "files" | "workflows";
  title: string;
  status: CleanupStatus;
  summary: string;
  detail?: string;
}

/** 翻页上限：每页 100 条，最多看 10 页，避免在很大的项目里无限翻；到上限还没翻完就如实说没扫完。 */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const LOCAL_PREFIXES = ["probe.", "page."];

/** 删本插件存储里探针写过的键；测试结果（probe.savedResults）留给界面的「清空」流程，那里会挡住在途的保存。 */
export async function cleanLocal(kv: KvPort): Promise<CleanupItem> {
  const title = "本地存储里的测试数据";
  try {
    const keys = (await kv.keys()).filter((key) => key !== SAVED_RESULTS_KEY && LOCAL_PREFIXES.some((prefix) => key.startsWith(prefix)));
    for (const key of keys) await kv.delete(key);
    const left = (await kv.keys()).filter((key) => keys.includes(key));
    if (left.length > 0) return { id: "local", title, status: "failed", summary: `删了 ${keys.length - left.length} 条，还剩 ${left.length} 条没删掉`, detail: left.join(", ") };
    return keys.length === 0
      ? { id: "local", title, status: "none", summary: "没有要删的（测试结果已一并清空）" }
      : { id: "local", title, status: "deleted", summary: `删了 ${keys.length} 条，测试结果也已清空`, detail: keys.join(", ") };
  } catch (error) {
    const { code, message } = describeError(error);
    return { id: "local", title, status: "failed", summary: `删除失败（${code}）`, detail: scrub(message, 200) };
  }
}

function listOf(json: unknown, key?: string): Record<string, unknown>[] {
  const value = key ? record(unwrap(json))?.[key] : unwrap(json);
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => record(item) !== undefined) : [];
}

function stopItem(id: CleanupItem["id"], title: string, error: unknown): CleanupItem {
  if (error instanceof CloudStop || error instanceof StepStop) {
    return { id, title, status: error.run.outcome === "waiting" ? "skipped" : "failed", summary: error.run.summary, ...(error.run.detail ? { detail: error.run.detail } : {}) };
  }
  const { code, message } = describeError(error);
  return { id, title, status: "failed", summary: `出错（${code}）`, detail: scrub(message, 200) };
}

function httpFail(id: CleanupItem["id"], title: string, step: string, status: number, text: string): CleanupItem {
  return { id, title, status: "failed", summary: `${step}失败：外脑返回 HTTP ${status}`, detail: scrub(text, 300) };
}

/** 逐个删除；返回删成功的个数和第一条失败。 */
async function deleteAll(port: ProbePort, paths: string[], signal: AbortSignal): Promise<{ deleted: number; failure?: { status: number; text: string } }> {
  let deleted = 0;
  let failure: { status: number; text: string } | undefined;
  for (const path of paths) {
    if (signal.aborted) break;
    const response = await cloudCall(port, "DELETE", path, signal);
    // 404 说明已经不在了（例如别处先删了），也算删掉了。
    if (ok2xx(response) || response.status === 404) deleted += 1;
    else failure ??= { status: response.status, text: response.text };
  }
  return failure ? { deleted, failure } : { deleted };
}

function deletedItem(id: CleanupItem["id"], title: string, found: number, result: { deleted: number; failure?: { status: number; text: string } }, what: string, truncated: boolean): CleanupItem {
  const more = truncated ? `；数据太多，只查了前 ${PAGE_SIZE * MAX_PAGES} 条，后面的没查到，请到外脑网页核对` : "";
  if (result.failure) {
    return { id, title, status: "failed", summary: `找到 ${found} ${what}，删了 ${result.deleted} ${what}；其余被外脑拒绝（HTTP ${result.failure.status}）${more}`, detail: scrub(result.failure.text, 300) };
  }
  return { id, title, status: truncated ? "partial" : "deleted", summary: `找到并删了 ${result.deleted} ${what}${more}` };
}

/** 一条都没找到：扫完了就是「没有」；扫到上限还没扫完就如实说没扫完。 */
function noneItem(id: CleanupItem["id"], title: string, summary: string, truncated: boolean): CleanupItem {
  return truncated
    ? { id, title, status: "partial", summary: `只查了前 ${PAGE_SIZE * MAX_PAGES} 条，没找到；后面的没查，请到外脑网页核对` }
    : { id, title, status: "none", summary };
}

async function cleanKb(port: ProbePort, pid: string, signal: AbortSignal): Promise<CleanupItem> {
  const title = "知识库里的测试内容";
  try {
    const ids = new Set<string>();
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await cloudCall(port, "GET", `/projects/${pid}/kb/nodes?page=${page}&pageSize=${PAGE_SIZE}`, signal);
      if (!ok2xx(response)) return httpFail("kb", title, "列知识库内容", response.status, response.text);
      const nodes = listOf(response.json);
      for (const node of nodes) {
        const content = str(node.content) ?? "";
        const id = str(node.id);
        if (id && content.startsWith(PROBE_KB_MARKER)) ids.add(id);
      }
      if (nodes.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) truncated = true;
    }
    if (ids.size === 0) return noneItem("kb", title, "没有探针写的知识库内容", truncated);
    const result = await deleteAll(port, [...ids].map((id) => `/projects/${pid}/kb/nodes/${encodeURIComponent(id)}`), signal);
    return deletedItem("kb", title, ids.size, result, "条", truncated);
  } catch (error) {
    return stopItem("kb", title, error);
  }
}

async function cleanRows(port: ProbePort, pid: string, signal: AbortSignal): Promise<CleanupItem> {
  const title = "数据表里的测试行";
  try {
    const collections = await cloudCall(port, "GET", `/projects/${pid}/collections`, signal);
    if (!ok2xx(collections)) return httpFail("rows", title, "列数据表", collections.status, collections.text);
    const tables = allCollections(collections.json);
    if (tables.length === 0) return { id: "rows", title, status: "none", summary: "项目里没有数据表" };
    const paths = new Set<string>();
    let truncated = false;
    for (const table of tables) {
      const cid = encodeURIComponent(table.id);
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await cloudCall(port, "GET", `/projects/${pid}/data?collectionId=${cid}&page=${page}&pageSize=${PAGE_SIZE}`, signal);
        if (!ok2xx(response)) return httpFail("rows", title, `读数据表「${table.name ?? table.id}」`, response.status, response.text);
        const rows = listOf(response.json);
        for (const row of rows) {
          const id = str(row.id);
          const name = str(record(row.data)?.name) ?? "";
          if (id && name.startsWith(PROBE_ROW_NAME)) paths.add(`/projects/${pid}/data/${encodeURIComponent(id)}`);
        }
        if (rows.length < PAGE_SIZE) break;
        if (page === MAX_PAGES) truncated = true;
      }
    }
    if (paths.size === 0) return noneItem("rows", title, `查了 ${tables.length} 张表，没有探针加的行`, truncated);
    const result = await deleteAll(port, [...paths], signal);
    const item = deletedItem("rows", title, paths.size, result, "行", truncated);
    return item.status === "failed" ? item : { ...item, summary: `${item.summary}（外脑移到了回收站）` };
  } catch (error) {
    return stopItem("rows", title, error);
  }
}

async function countFiles(port: ProbePort, pid: string, signal: AbortSignal): Promise<CleanupItem> {
  const title = "上传的测试文件";
  try {
    const response = await cloudCall(port, "GET", `/storage/${pid}/files`, signal);
    if (!ok2xx(response)) return httpFail("files", title, "列文件", response.status, response.text);
    const count = listOf(response.json, "files").filter((file) => file.name === PROBE_FILE_NAME).length;
    if (count === 0) return { id: "files", title, status: "none", summary: "没有探针上传的文件" };
    return { id: "files", title, status: "manual", summary: `有 ${count} 个「${PROBE_FILE_NAME}」：外脑没对插件开放删文件，请到外脑网页「${TEST_PROJECT_NAME}」项目的文件里删` };
  } catch (error) {
    return stopItem("files", title, error);
  }
}

function workflowsItem(): CleanupItem {
  return {
    id: "workflows",
    title: "测试工作流",
    status: "manual",
    summary: `外脑没对插件开放列出和删除工作流，请到外脑网页「${TEST_PROJECT_NAME}」项目里删标题以「${PROBE_WORKFLOW_TITLE}」开头的工作流`,
  };
}

/** 清理外脑「test」项目里探针留下的数据；找不到 test 项目或没授权时，每一项都如实说明。 */
export async function cleanCloud(port: ProbePort, signal: AbortSignal): Promise<CleanupItem[]> {
  let project: { id: string };
  try {
    project = await testProject(port, signal);
  } catch (error) {
    const first = stopItem("kb", "外脑云端", error);
    return (["kb", "rows", "files"] as const).map((id) => ({
      id,
      title: { kb: "知识库里的测试内容", rows: "数据表里的测试行", files: "上传的测试文件" }[id],
      status: first.status === "failed" ? "failed" : "skipped",
      summary: `没清理：${first.summary}`,
      ...(first.detail ? { detail: first.detail } : {}),
    } as CleanupItem)).concat(workflowsItem());
  }
  const pid = encodeURIComponent(project.id);
  return [await cleanKb(port, pid, signal), await cleanRows(port, pid, signal), await countFiles(port, pid, signal), workflowsItem()];
}
