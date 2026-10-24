import { collectErrorFields, type VoiceErrorFields } from "./voice-error-fields";
import { t, readText, type TextSource } from "./voice-i18n";
/**
 * 当日总结（A3-10，设计稿 Voice 页「今天的总结」卡）。
 *
 * ## 与润色（voice-polish.ts）的两点不同
 *
 * 1. **没有「失败回退」**。润色失败可以按原话注入——原话本来就是用户要的结果；
 *    总结失败没有等价物可退：把各段转写原样拼起来冒充总结，就是稿子里点名禁止的
 *    「拼起来只是变长，不是变清楚」。所以失败只如实报 [`VoiceDigestFailure`]，
 *    一条要点都不编。
 * 2. **超时给得宽**。润色卡在「说完话到文字落进输入框」的关键路径上，4 秒是
 *    「等得住」的上限；总结是用户点了按钮在等一份产物，没有写回窗口会过期的问题，
 *    给 30 秒换一次真实完成的机会。
 */

import type { CloudAiClient, CloudGenerateMessage } from "@reai/app-sdk/v1";
import type { VoiceRecordingSegment } from "@reai/app-sdk/v1";
import {
  VOICE_DIGEST_PREAMBLE,
  VOICE_DIGEST_PROMPT,
} from "./voice-ai-prompts";
import { sanitizeContextText } from "./voice-polish";
import { voiceRequestFailureMessage } from "./voice-user-errors";

/** 当日总结合成的硬超时。见文件头注释第 2 点。 */
export const DIGEST_TIMEOUT_MS = 30_000;

/**
 * 素材总字数的绝对上限。一天的持续录音可能非常长，全部塞进一次请求既慢又贵；
 * 超出预算时从最新的段开始保留完整段（丢较早的），并在消息里注明还有几段没带上
 * ——静默截断会让「由 N 段合成」变成一句不完全的话。
 */
export const MAX_DIGEST_SOURCE_CHARS = 12_000;

/** 要点条数上限，与提示词第 3 条一致；解析侧再卡一道，不依赖模型听话。 */
export const MAX_DIGEST_POINTS = 8;

/** 单条要点的长度上限。超出按截断处理而不是丢弃：结论本身仍然有效。 */
export const MAX_DIGEST_POINT_CHARS = 200;

/** 总结用的模型档位。真实模型 id 归 Host，插件只给档位名（与润色同一条约定）。 */
export const DIGEST_MODEL = "text-default";

/**
 * 一份当日总结。结构对应设计稿 `ctxDigest`（pts/segs/chars/from/to）。
 *
 * R18：按天各存一份（dayKey → 这份），不再是「今天的总结」单变量。`final` 与
 * `sourceKey` 是自动刷新链路的两个判据：过了午夜定稿、素材变了才重合。
 */
export interface VoiceDayDigest {
  /** 合成时素材的本地日期（YYYY-MM-DD）。 */
  dayKey: string;
  /** 要点清单，已解析、已截断；恒非空（空结果在合成阶段就判失败）。 */
  points: string[];
  /** 实际参与合成的段数（素材超长被丢弃的段不计入——「由 N 段合成」必须是真的）。 */
  segs: number;
  /** 参与合成的各段转写字数总和。 */
  chars: number;
  /** 素材里最早一段的开始时刻（墙钟毫秒）。 */
  fromMs: number;
  /** 素材里最晚一段的结束时刻（开始 + 时长，墙钟毫秒）。 */
  toMs: number;
  /** 合成完成时刻（ISO 字符串）。 */
  createdAt: string;
  /** 过了午夜就定稿；今天的总结恒为 false。 */
  final: boolean;
  /** 参与合成的素材指纹；自动刷新用它判断是否真有新素材。 */
  sourceKey: string;
  /** `dsh` = agent 会话；`cloud` = Dsh 不可用时的一次性云端回退。 */
  backend?: "dsh" | "cloud";
  /** 走了云端回退时的原因（来自 resolveSummaryBackend，已本地化）；仅披露用。 */
  fallbackReason?: string;
  /** Dsh 会话与已经送入会话的段；随按天总结一起持久化。 */
  dsh?: {
    sessionId: string;
    sentSegmentIds: string[];
    /** 新档案用素材指纹识别同 id 的重转写；没有该字段的旧档案会重建会话。 */
    sentSegmentKeys?: string[];
  };
}

export interface VoiceDigestFailure {
  /** Host 的稳定错误码，或本模块的 `DIGEST_TIMEOUT` / `DIGEST_EMPTY` / `DIGEST_NO_SOURCE`。 */
  code: string;
  /** 可以直接给用户看的一句话。 */
  message: string;
  /** 结构化诊断字段（§6.0）；原文只在内存。 */
  fields?: VoiceErrorFields;
}

export interface VoiceDigestOutcome {
  digest?: VoiceDayDigest;
  failure?: VoiceDigestFailure;
  /** 失败回合可能已写入未确认素材；编排层应丢掉旧会话游标。 */
  sessionInvalidated?: true;
}

export interface VoiceDigestDeps {
  aiApi: Pick<CloudAiClient, "generateText" | "cancel">;
  /** 生成 invocationId。必须先于调用拿到，取消要用它。 */
  newId: () => string;
  /** 注入定时器，测试用假时钟。 */
  setTimeout?: (handler: () => void, ms: number) => number;
  clearTimeout?: (handle: number) => void;
  timeoutMs?: number;
  now?: () => number;
}

/** 本地日期键（YYYY-MM-DD）。「今天」按用户本地时区算，不按 UTC 切天。 */
export function dayKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** dayKey → 该日 00:00 的本地 Date。键格式固定（YYYY-MM-DD），解析不走 Date 的字符串构造。 */
export function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map((part) => Number.parseInt(part, 10));
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/**
 * 段归属哪一天：按**开始时间**所在的本地日（R18：23:40–00:25 的段归昨天，
 * 午夜后新开始的才归新的一天）。
 */
export function segmentDayKey(segment: Pick<VoiceRecordingSegment, "wallStartMs">): string {
  return dayKeyOf(new Date(segment.wallStartMs));
}

/**
 * 按天分组（最新的一天在前；组内保持传入顺序——列表本来就是新到旧）。
 * 四档共用：Context 档分的是段，All / Input / Command 档分的是历史条目，
 * 所以只要求调用方给出「这条属于哪一天」。
 */
export function groupByDay<T>(
  items: readonly T[],
  dayKeyOfItem: (item: T) => string,
): Array<{ dayKey: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKeyOfItem(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([dayKey, bucket]) => ({ dayKey, items: bucket }));
}



/**
 * 天的标题（稿 CTX_DAYS.nm）：今天 / 昨天 / 「8 月 20 日 周四」；跨年才带年份。
 * `todayKey` 由调用方传入（视图用当前时刻，测试用假时钟）。
 */
export function dayLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return t("digest.message1");
  const today = dayKeyToDate(todayKey);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey === dayKeyOf(yesterday)) return t("digest.message2");
  const date = dayKeyToDate(dayKey);
  return t(date.getFullYear() === today.getFullYear() ? "digest.dateWeekday" : "digest.dateYearWeekday", {
    month: date.getMonth() + 1, day: date.getDate(), year: date.getFullYear(),
    weekday: t(`digest.weekday.day${date.getDay()}`),
  });
}

/** 定稿总结的标题用的日期（稿 CTX_DAYS.date：「8 月 21 日」），跨年带年份。 */
export function dayDateLabel(dayKey: string, todayKey: string): string {
  const date = dayKeyToDate(dayKey);
  return t(date.getFullYear() === dayKeyToDate(todayKey).getFullYear() ? "digest.date" : "digest.dateYear", {
    month: date.getMonth() + 1, day: date.getDate(), year: date.getFullYear(),
  });
}

/**
 * 素材指纹：参与合成的段 id 与各自的转写时刻。任一段新增、删除或转写更新都会
 * 换一个指纹——调度器据此决定要不要重合，比存一份转写副本轻得多。
 */
export function digestSourceKey(segments: readonly VoiceRecordingSegment[]): string {
  return [...segments]
    .sort((a, b) => a.wallStartMs - b.wallStartMs)
    .map((segment) => `${segment.id}@${segment.transcribedAtMs ?? 0}`)
    .join("|");
}

/**
 * 从录音列表里挑出「今天且有转写」的段，按时间正序排列。
 *
 * 还没转录完的段挑不进来——没有文本的段带进素材只会教模型编内容。跨天的段同样
 * 不算：这份总结的名字就叫「今天的总结」。
 */
export function collectDaySegments(
  recordings: readonly VoiceRecordingSegment[],
  nowMs: number = Date.now(),
): VoiceRecordingSegment[] {
  return collectDaySegmentsFor(recordings, dayKeyOf(new Date(nowMs)));
}

/** 同 [`collectDaySegments`]，但指定哪一天（按天分组的总结要给昨天、前天也合）。 */
export function collectDaySegmentsFor(
  recordings: readonly VoiceRecordingSegment[],
  dayKey: string,
): VoiceRecordingSegment[] {
  return recordings
    .filter(
      (item) =>
        typeof item.wallStartMs === "number"
        && Number.isFinite(item.wallStartMs)
    && dayKeyOf(new Date(item.wallStartMs)) === dayKey
    && typeof item.transcriptText === "string"
    && item.transcriptText.trim().length > 0,
    )
    .sort((a, b) => a.wallStartMs - b.wallStartMs);
}

/** 把一段转写拼进 user 消息时的样子：先时间，再内容，转写已过 sanitize。 */
function segmentLine(segment: VoiceRecordingSegment): string {
  const start = new Date(segment.wallStartMs);
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");
  return `[${hh}:${mm}] ${sanitizeContextText(segment.transcriptText ?? "").trim()}`;
}

/**
 * 素材预算内的段（返回按时间正序；预算不够时**从最新的段开始保留**，丢的是较早的）。
 *
 * 「今天说定了什么」的结论大多落在最新的段里——被推翻的早期说法提示词本来就不
 * 单列，所以超预算时丢早期、保近期，跟总结的目的对得上。丢弃条数如实返回并在
 * 消息里注明，不静默截断——那会让「由 N 段合成」变成一句不完全的话。
 *
 * 消息组装与「由 N 段合成」的溯源统计**必须共用这一个函数**：各写一份长度公式，
 * 迟早算出两个不同的 N——那时卡上写着「由 12 段合成」，实际只有 11 段进了模型。
 */
export function fitDigestSegments(
  segments: readonly VoiceRecordingSegment[],
): { kept: VoiceRecordingSegment[]; dropped: number } {
  const kept: VoiceRecordingSegment[] = [];
  let used = 0;
  // 倒序累计（最新在前），凑够预算后再 reverse 回正序——消息里的时间线仍从早到晚。
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const line = segmentLine(segment);
    if (used + line.length > MAX_DIGEST_SOURCE_CHARS && kept.length > 0) break;
    kept.push(segment);
    used += line.length;
  }
  kept.reverse();
  return { kept, dropped: segments.length - kept.length };
}

/**
 * 把一次当日总结请求拼成 messages。拆成独立函数是为了能单测「转写有没有被当成
 * 指令发出去」——与 `buildPolishMessages` 同一条理由。
 */
export function buildDigestMessages(
  segments: readonly VoiceRecordingSegment[],
  fence = "DGS",
): CloudGenerateMessage[] {
  const { kept, dropped } = fitDigestSegments(
    [...segments].sort((a, b) => a.wallStartMs - b.wallStartMs),
  );
  const body = [
    VOICE_DIGEST_PREAMBLE,
    `<<<${fence}>>>`,
    ...kept.map(segmentLine),
    `<<<END_${fence}>>>`,
    ...(dropped > 0
      ? [`（素材过长：另有 ${dropped} 段较早的转写未包含，总结只基于上面这些段。）`]
      : []),
    "请给出今天的总结要点。",
  ].join("\n\n");
  return [
    { role: "system", content: VOICE_DIGEST_PROMPT.system },
    { role: "user", content: body },
  ];
}

/** 一条要点末尾最多认几个来源时刻；再多就不是「依据」而是在列目录了。 */
const MAX_DIGEST_POINT_TIMES = 3;

/**
 * 拆出要点末尾的来源时刻标记（提示词要求的「〔HH:MM〕」，多处用顿号分隔）。
 * 模型偶尔写成半角括号或方括号也认；时刻不合法的标记原样留在正文里，不猜。
 * 旧总结没有标记，返回空 times——界面上这条就只是文字，不画假链接。
 */
export function splitDigestPoint(point: string): { text: string; times: string[] } {
  const match = /\s*[〔\[（(]\s*((?:[01]?\d|2[0-3])[:：][0-5]\d(?:\s*[、,，;；]\s*(?:[01]?\d|2[0-3])[:：][0-5]\d)*)\s*[〕\]）)]\s*[。.]?$/u.exec(point);
  if (!match) return { text: point, times: [] };
  const times = [...new Set(match[1]!.split(/\s*[、,，;；]\s*/u).map((time) => {
    const [hh, mm] = time.split(/[:：]/u);
    return `${hh!.padStart(2, "0")}:${mm}`;
  }))].slice(0, MAX_DIGEST_POINT_TIMES);
  return { text: point.slice(0, match.index).trim(), times };
}

/**
 * 把要点里的来源时刻落到当天的段：这一分钟与段的 [开始, 结束] 有交集就算。
 * 一个时刻可能落在两段的交界上，两段都返回；找不到就是空——不就近硬凑。
 */
export function digestPointSegments(
  times: readonly string[],
  daySegments: readonly VoiceRecordingSegment[],
): VoiceRecordingSegment[] {
  const found: VoiceRecordingSegment[] = [];
  for (const time of times) {
    const [hh, mm] = time.split(":").map((part) => Number.parseInt(part, 10));
    for (const segment of daySegments) {
      const start = new Date(segment.wallStartMs);
      const minuteStart = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hh, mm).getTime();
      if (minuteStart + 60_000 > segment.wallStartMs && minuteStart <= segment.wallStartMs + Math.max(0, segment.durationMs)
        && !found.includes(segment)) found.push(segment);
    }
  }
  return found.sort((a, b) => a.wallStartMs - b.wallStartMs);
}

/**
 * 解析模型输出为要点清单。纯函数，可单测。
 *
 * 容错范围只覆盖「格式性噪音」：Markdown 围栏行、序号与项目符号、成对引号。
 * 每条超长按 [`MAX_DIGEST_POINT_CHARS`] 截断；条数超限截到 [`MAX_DIGEST_POINTS`]。
 * 解析结果为空 ≠ 失败——素材不足时提示词允许模型什么都不输出，那是诚实行为。
 */
export function parseDigestPoints(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const points: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine
      .trim()
      .replace(/^```.*$/, "")
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*•·]\s+/, "")
      .replace(/^\d+[.、)]\s+/, "")
      .replace(/^["“](.+)["”]$/, "$1")
      .trim();
    if (!line) continue;
    // 来源时刻标记先拆下来再截断正文，截断不能把「点这条去哪一段」一起截掉。
    const { text, times } = splitDigestPoint(line);
    if (!text) continue;
    const body = text.length > MAX_DIGEST_POINT_CHARS
      ? `${text.slice(0, MAX_DIGEST_POINT_CHARS)}…`
      : text;
    points.push(times.length > 0 ? `${body}〔${times.join("、")}〕` : body);
    if (points.length >= MAX_DIGEST_POINTS) break;
  }
  return points;
}

/**
 * 一次「转写 → 要点清单」的云端往返（当日总结与单段总结共用）。**不会抛错**——
 * 失败以 `failure` 返回。超时 / 取消 / 解析 / 空输出的处理都在这里，两种总结只差
 * 提示词与素材组装。
 */
async function requestPoints(
  deps: VoiceDigestDeps,
  build: (fence: string) => CloudGenerateMessage[],
  emptyMessage: TextSource,
): Promise<{ points: string[]; failure?: undefined } | { points?: undefined; failure: VoiceDigestFailure }> {
  // 「不会抛错」与润色同一条铁律：这里一旦抛出去，用户换来的是一条 undefined，
  // 界面既没有总结也没有解释。
  let invocationId = "";
  let messages: CloudGenerateMessage[];
  try {
    invocationId = deps.newId();
    messages = build(`DGS_${deps.newId().replace(/-/g, "").slice(0, 10)}`);
  } catch (cause) {
    return { failure: describeDigestFailure(cause) };
  }

  const timeoutMs = deps.timeoutMs ?? DIGEST_TIMEOUT_MS;
  const schedule = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms) as unknown as number);
  const cancelTimer = deps.clearTimeout ?? ((handle: number) => clearTimeout(handle));
  let timer: number | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = schedule(() => resolve("timeout"), timeoutMs);
  });

  try {
    const race = await Promise.race([
      Promise.resolve()
        .then(() =>
          deps.aiApi.generateText({
            invocationId,
            model: DIGEST_MODEL,
            messages,
          }),
        )
        .then((result) => ({ kind: "ok" as const, result }))
        .catch((cause: unknown) => ({ kind: "error" as const, cause })),
      timedOut,
    ]);

    if (race === "timeout") {
      // 与润色同一条口径：放弃结果，但不谎称上游停了。
      void deps.aiApi.cancel(invocationId).catch(() => undefined);
      return {
        failure: { code: "DIGEST_TIMEOUT", get message() { return t("digest.message3", { seconds: timeoutMs / 1000 }); } },
      };
    }
    if (race.kind === "error") {
      return { failure: describeDigestFailure(race.cause) };
    }

    const points = race.result.stream === false
      ? parseDigestPoints(race.result.text)
      : [];
    // 素材不足时提示词允许模型什么都不输出——那不是故障，但也不能当成功：
    // 界面要解释「内容不够总结」，而不是留一张空卡。
    if (points.length === 0) {
      return { failure: { code: "DIGEST_EMPTY", get message() { return readText(emptyMessage); } } };
    }
    return { points };
  } finally {
    if (timer !== undefined) cancelTimer(timer);
  }
}

/**
 * 跑一次当日总结。**不会抛错**——失败以 `failure` 返回，调用方据此如实告知用户。
 * `final` 由调度器决定（过了午夜的天定稿），缺省按「今天的」处理。
 */
export async function synthesizeDayDigest(
  deps: VoiceDigestDeps,
  input: { segments: readonly VoiceRecordingSegment[]; dayKey: string; final?: boolean },
): Promise<VoiceDigestOutcome> {
  const segments = [...input.segments].sort((a, b) => a.wallStartMs - b.wallStartMs);
  if (segments.length === 0) {
    return {
      failure: {
        code: "DIGEST_NO_SOURCE",
        get message() { return t("digest.message4"); },
      },
    };
  }
  const outcome = await requestPoints(
    deps,
    (fence) => buildDigestMessages(segments, fence),
    () => t("digest.message5"),
  );
  if (outcome.failure) return { failure: outcome.failure };

  const included = fitDigestSegments(segments).kept;
  const now = deps.now?.() ?? Date.now();
  return {
    digest: {
      dayKey: input.dayKey,
      points: outcome.points,
      segs: included.length,
      chars: included.reduce(
        (sum, segment) => sum + (segment.transcriptText ?? "").trim().length,
        0,
      ),
      fromMs: included[0]?.wallStartMs ?? now,
      toMs: included.length > 0
        ? included[included.length - 1].wallStartMs
          + Math.max(0, included[included.length - 1].durationMs)
        : now,
      createdAt: new Date(now).toISOString(),
      final: input.final === true,
      sourceKey: digestSourceKey(segments),
    },
  };
}

/**
 * 把 Host 的稳定码翻成一句人话。口径与 `describePolishFailure` 一致：「服务没开通」
 * 和「你没授权」是两件事；这里没有「已保留原文」可退，失败就是失败。
 */
export function describeDigestFailure(cause: unknown): VoiceDigestFailure {
  const code =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : "";
  // 诊断只取结构化字段（§6.0）；上游原文不拼进给人看的 message。
  const diagnostic = { fields: collectErrorFields(cause, { code: code || "DIGEST_FAILED" }) };
  switch (code) {
    case "AI_NOT_GRANTED":
    case "AI_PERMISSION_REQUIRED":
    case "AI_PERMISSION_DENIED":
      return {
        ...diagnostic,
        code,
        get message() { return t("digest.message6"); },
      };
    case "AI_SCOPE_UNAVAILABLE":
      return { ...diagnostic, code, get message() { return voiceRequestFailureMessage("summary", cause); } };
    case "AI_NOT_LOGGED_IN":
      return { ...diagnostic, code, get message() { return voiceRequestFailureMessage("summary", cause); } };
    case "AI_PAYMENT_REQUIRED":
      return { ...diagnostic, code, get message() { return voiceRequestFailureMessage("summary", cause); } };
    case "AI_RATE_LIMITED":
      return { ...diagnostic, code, get message() { return voiceRequestFailureMessage("summary", cause); } };
    case "AI_TIMEOUT":
      return { ...diagnostic, code, get message() { return voiceRequestFailureMessage("summary", cause); } };
    default: {
      return {
        ...diagnostic,
        code: code || "DIGEST_FAILED",
        get message() { return voiceRequestFailureMessage("summary", cause); },
      };
    }
  }
}
