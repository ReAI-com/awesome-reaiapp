/**
 * 当日总结的自动刷新调度（R5 / R18）。纯函数：给它录音列表、已有的各天总结和
 * 现在几点，它说「哪几天要重合、哪几天只要定稿、哪几天的总结该撤」。真正发
 * 请求的事归 app.ts，这里一个 IPC 都不碰，所以能用假时钟把午夜、节流、退避
 * 全部单测。
 *
 * 裁定（台账 R18）逐条对应：
 * - 今天第一段结束后生成：今天有带转写的段、还没有总结 → `generate`。
 * - 新段结束后刷新，最密每小时一次：素材指纹变了，且距上次合成 ≥ 1 小时 → `generate`。
 * - 录音中的段不算：Host 只在段**结束**后才把它写进列表，没转写的段也不进素材
 *   （`collectDaySegmentsFor`），所以这里天然满足，不另判。
 * - 午夜后定稿：过了午夜的天，素材没变 → `finalize`（不发请求，只把 `final` 落成
 *   true）；素材变了（跨午夜的段在午夜后才结束）→ 再合一次并定稿。
 * - 失败退避：合成失败的天记 `lastAttemptAt`，同样按 1 小时退避，不连环重试。
 */

import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import {
  collectDaySegmentsFor,
  dayKeyOf,
  digestSourceKey,
  groupByDay,
  segmentDayKey,
  type VoiceDayDigest,
  type VoiceDigestOutcome,
} from "./voice-digest";

/** 同一天两次合成之间的最短间隔（「最密每小时一次」）。 */
export const DIGEST_REFRESH_INTERVAL_MS = 60 * 60_000;

/** 总结在本机留多久：超过这个天数的 dayKey 从存储里剪掉（列表也翻不到那么远）。 */
export const DIGEST_RETENTION_DAYS = 14;

export interface DigestPlanInput {
  recordings: readonly VoiceRecordingSegment[];
  digests: Readonly<Record<string, VoiceDayDigest>>;
  nowMs: number;
  /**
   * 各天最近一次**失败**的合成时刻。成功的那次以 digest.createdAt 为准，
   * 失败的没有 digest 可记，所以单独给一张表（Voice 私有 KV 持久化，跨激活退避）。
   */
  lastAttemptAt?: Readonly<Record<string, number>>;
  /**
   * 录音列表是否完整覆盖了所有段。Host 分页（每页 50）：列表不完整时，某一天
   * 的段可能只是翻不到而不是被删了，那时不能把它的总结当成「素材没了」撤掉。
   */
  listComplete: boolean;
}

export interface DigestWorkItem {
  dayKey: string;
  segments: VoiceRecordingSegment[];
  /** 这一天已经过完：合成结果直接定稿。 */
  final: boolean;
}

export interface DigestPlan {
  /** 要发请求的天（含素材）。 */
  generate: DigestWorkItem[];
  /** 过了午夜、素材没变：不发请求，只把旧总结标成定稿。 */
  finalize: string[];
  /** 这一天一段带转写的素材都不剩（且列表覆盖得到它）：总结跟着撤。 */
  drop: string[];
}

export interface PrepareDigestRunInput {
  recordings: readonly VoiceRecordingSegment[];
  digests: Readonly<Record<string, VoiceDayDigest>>;
  plan: DigestPlan;
  force?: string;
  nowMs: number;
}

export interface PreparedDigestRun {
  nextDigests: Record<string, VoiceDayDigest>;
  dirty: boolean;
  work: DigestWorkItem[];
  /** 强制指定的天已经没有素材；编排层仍须先落盘同批次的 drop/finalize，再报错。 */
  forceWithoutSource: boolean;
}

/**
 * 把一轮计划整理成可执行批次。把「状态变更」与「强制生成是否有素材」同时返回，
 * 避免调用方在发现无素材时提前抛错，漏掉同一轮已经算出的撤销/定稿。
 */
export function prepareDigestRun(input: PrepareDigestRunInput): PreparedDigestRun {
  const nextDigests = { ...input.digests };
  let dirty = false;
  for (const dayKey of input.plan.drop) {
    delete nextDigests[dayKey];
    dirty = true;
  }
  for (const dayKey of input.plan.finalize) {
    const digest = nextDigests[dayKey];
    if (digest) {
      nextDigests[dayKey] = { ...digest, final: true };
      dirty = true;
    }
  }

  const work = [...input.plan.generate];
  let forceWithoutSource = false;
  if (input.force && !work.some((item) => item.dayKey === input.force)) {
    const segments = collectDaySegmentsFor(input.recordings, input.force);
    if (segments.length === 0) {
      forceWithoutSource = true;
    } else {
      work.unshift({
        dayKey: input.force,
        segments,
        final: input.force !== dayKeyOf(new Date(input.nowMs)),
      });
    }
  }
  return { nextDigests, dirty, work, forceWithoutSource };
}

export function planDigestWork(input: DigestPlanInput): DigestPlan {
  const todayKey = dayKeyOf(new Date(input.nowMs));
  const plan: DigestPlan = { generate: [], finalize: [], drop: [] };
  const days = groupByDay(input.recordings, segmentDayKey).map((group) => group.dayKey);
  // 列表新到旧分页：不完整时最早那一天只翻到了它较晚的一截。拿这一截去重合，
  // 会把一份完整的总结覆盖成残缺的；过去的天不再增长，等翻到全貌再说。
  // 今天例外：素材预算本来就从最新的段保留，截断前后的总结口径一致。
  const partialDay = input.listComplete ? undefined : days.at(-1);

  for (const dayKey of days) {
    const segments = collectDaySegmentsFor(input.recordings, dayKey);
    const digest = input.digests[dayKey];
    if (segments.length === 0) {
      // 只有没转写的段：素材还没到，但总结也不该撤——转写一到它就会合。
      continue;
    }
    const isToday = dayKey === todayKey;
    const sourceKey = digestSourceKey(segments);
    if (digest && digest.sourceKey === sourceKey) {
      if (!isToday && !digest.final) plan.finalize.push(dayKey);
      continue;
    }
    // 没有总结 / 素材变了：看节流与退避。
    const lastSuccessMs = digest ? Date.parse(digest.createdAt) : Number.NaN;
    const lastFailureMs = input.lastAttemptAt?.[dayKey];
    const lastMs = Math.max(
      Number.isFinite(lastSuccessMs) ? lastSuccessMs : 0,
      typeof lastFailureMs === "number" && Number.isFinite(lastFailureMs) ? lastFailureMs : 0,
    );
    if (lastMs > 0 && input.nowMs - lastMs < DIGEST_REFRESH_INTERVAL_MS) continue;
    if (dayKey === partialDay && !isToday) continue;
    plan.generate.push({ dayKey, segments, final: !isToday });
  }

  // 撤总结：这一天在列表里一段带转写的都没有了。列表不完整时只认「比列表里
  // 最早那段更晚」的天——更早的天翻不到，不能当成没了。
  const oldestListedMs = input.recordings.reduce(
    (min, segment) => Math.min(min, segment.wallStartMs),
    Number.POSITIVE_INFINITY,
  );
  const oldestListedKey = Number.isFinite(oldestListedMs)
    ? dayKeyOf(new Date(oldestListedMs))
    : undefined;
  for (const dayKey of Object.keys(input.digests)) {
    if (collectDaySegmentsFor(input.recordings, dayKey).length > 0) continue;
    // 这一天还有没转写的段挂着：素材只是没到，不撤。
    if (input.recordings.some((segment) => segmentDayKey(segment) === dayKey)) continue;
    const covered = input.listComplete
      || (oldestListedKey !== undefined && dayKey >= oldestListedKey);
    if (covered) plan.drop.push(dayKey);
  }
  return plan;
}

/**
 * 把旧的天剪掉（存储体积有界）。保留最近 [`DIGEST_RETENTION_DAYS`] 天。
 */
export function pruneDigests(
  digests: Readonly<Record<string, VoiceDayDigest>>,
  nowMs: number,
): Record<string, VoiceDayDigest> {
  const floor = new Date(nowMs);
  floor.setDate(floor.getDate() - DIGEST_RETENTION_DAYS);
  const floorKey = dayKeyOf(floor);
  const kept: Record<string, VoiceDayDigest> = {};
  for (const [dayKey, digest] of Object.entries(digests)) {
    if (dayKey >= floorKey) kept[dayKey] = digest;
  }
  return kept;
}

/** 失败回合可能已向 Dsh 档案写入素材；保留旧要点，但游标必须失效后完整重建。 */
export function discardDigestSession(
  digests: Readonly<Record<string, VoiceDayDigest>>,
  dayKey: string,
): Record<string, VoiceDayDigest> {
  const previous = digests[dayKey];
  if (!previous?.dsh) return digests as Record<string, VoiceDayDigest>;
  const { dsh: _discarded, ...withoutSession } = previous;
  return { ...digests, [dayKey]: withoutSession };
}

/**
 * 「生成一份当日总结」的可替换接口。今天的实现是云端 generateText
 * （`synthesizeDayDigest`）；车道 B 换 Dsh 会话只换这一个函数，调度、存储与
 * 视图一行不动。**不会抛错**——失败走 `failure`。
 */
export type DayDigestGenerator = (
  input: { dayKey: string; segments: readonly VoiceRecordingSegment[]; final: boolean },
) => Promise<VoiceDigestOutcome>;
