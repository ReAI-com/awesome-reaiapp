/**
 * 测试结果存进本插件自己的存储：「跳到 Driver 设置页」会离开页面、界面被卸载，
 * 回来时重新挂载也能看到之前的结果。只存本插件的探针结果，不存别的数据。
 *
 * 规则：
 * - 同一个存储的所有读写排进同一条队列（跨界面挂载共享），不会交错。
 * - 保存是「按探针合并」：同一探针只留开始时间更晚的那条，旧界面晚到的结果不会盖掉新结果。
 * - 清空写入一个清空时间，比它早的结果一律丢掉，在途的保存也写不回来。
 * - 每条结果记下当时的 Driver 版本和插件版本；恢复时只认和现在一致的。
 */
import type { KvPort } from "./port";
import { probeById, type Outcome, type ProbeResult } from "./probes";

export const SAVED_RESULTS_KEY = "probe.savedResults";
const LOG_LIMIT = 100;
const OUTCOMES = new Set<Outcome>(["ok", "blocked", "unexpected", "failed", "waiting"]);

/** 保存的一条结果：探针结果 + 当时的 Driver 版本与插件版本。 */
export interface SavedRecord extends ProbeResult {
  host: string;
  plugin: string;
}

export interface SavedState {
  clearedAt: string | null;
  results: SavedRecord[];
  log: SavedRecord[];
}

const EMPTY: SavedState = { clearedAt: null, results: [], log: [] };

/** 每个存储一条队列；同一个 Host 端口在多次挂载之间是同一个对象。 */
const queues = new WeakMap<KvPort, Promise<unknown>>();

function enqueue<T>(kv: KvPort, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(kv) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  queues.set(kv, next.catch(() => undefined));
  return next;
}

function asRecord(value: unknown): SavedRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.probeId !== "string" || !probeById(v.probeId)) return undefined;
  if (typeof v.outcome !== "string" || !OUTCOMES.has(v.outcome as Outcome)) return undefined;
  // 「跳到 Driver 设置页」的过渡状态（已接受、等回执）不该被保存；旧开发版存下的一律丢掉。
  if (v.probeId === "system-task-open" && v.outcome === "waiting") return undefined;
  if (typeof v.summary !== "string" || typeof v.startedAt !== "string" || Number.isNaN(Date.parse(v.startedAt))) return undefined;
  // 开始时间在未来（超过 1 分钟）的记录不可信，会压过真实重测结果，丢掉。
  if (Date.parse(v.startedAt) > Date.now() + 60_000) return undefined;
  if (typeof v.durationMs !== "number" || !Number.isFinite(v.durationMs)) return undefined;
  if (typeof v.host !== "string" || typeof v.plugin !== "string") return undefined;
  return {
    probeId: v.probeId,
    outcome: v.outcome as Outcome,
    summary: v.summary,
    startedAt: v.startedAt,
    durationMs: v.durationMs,
    host: v.host,
    plugin: v.plugin,
    ...(v.expected === true ? { expected: true } : {}),
    ...(typeof v.code === "string" ? { code: v.code } : {}),
    ...(typeof v.detail === "string" ? { detail: v.detail } : {}),
  };
}

function parse(raw: unknown): SavedState {
  if (!raw || typeof raw !== "object") return { ...EMPTY };
  const v = raw as { clearedAt?: unknown; results?: unknown; log?: unknown };
  const clearedAt = typeof v.clearedAt === "string" && !Number.isNaN(Date.parse(v.clearedAt)) ? v.clearedAt : null;
  const list = (value: unknown) => (Array.isArray(value) ? value.map(asRecord).filter((item): item is SavedRecord => item !== undefined) : []);
  const fresh = (record: SavedRecord) => clearedAt === null || Date.parse(record.startedAt) >= Date.parse(clearedAt);
  return { clearedAt, results: list(v.results).filter(fresh), log: list(v.log).filter(fresh).slice(0, LOG_LIMIT) };
}

const sameRun = (a: ProbeResult, b: ProbeResult) => a.probeId === b.probeId && a.startedAt === b.startedAt;

/** 把一条新结果并进已存状态：同探针留更晚的（时间相同留先到的）；记录去重、按时间倒序、限条数。 */
export function mergeRecord(state: SavedState, record: SavedRecord): SavedState {
  if (state.clearedAt !== null && Date.parse(record.startedAt) < Date.parse(state.clearedAt)) return state;
  const current = state.results.find((item) => item.probeId === record.probeId);
  const results = current && Date.parse(current.startedAt) >= Date.parse(record.startedAt)
    ? state.results
    : [...state.results.filter((item) => item.probeId !== record.probeId), record];
  const log = state.log.some((item) => sameRun(item, record))
    ? state.log
    : [...state.log, record].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, LOG_LIMIT);
  return { clearedAt: state.clearedAt, results, log };
}

/** 读回保存的状态（排在已提交的保存之后）；读不到就当没有。 */
export function loadSavedResults(kv: KvPort): Promise<SavedState> {
  return enqueue(kv, async () => parse(await kv.get(SAVED_RESULTS_KEY))).catch(() => ({ ...EMPTY }));
}

/** 保存一条结果；保存失败不影响界面。 */
export function saveResult(kv: KvPort, record: SavedRecord): Promise<void> {
  return enqueue(kv, async () => {
    const state = parse(await kv.get(SAVED_RESULTS_KEY));
    await kv.set(SAVED_RESULTS_KEY, mergeRecord(state, record));
  }).catch(() => undefined);
}

/** 清空：写入清空时间，比它早的结果以后都不再恢复。失败时抛出，让界面如实提示。 */
export function clearSavedResults(kv: KvPort, at = new Date().toISOString()): Promise<void> {
  return enqueue(kv, () => kv.set(SAVED_RESULTS_KEY, { clearedAt: at, results: [], log: [] }));
}
