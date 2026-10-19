/**
 * Agent 回答与工具过程的展示投影（负责人 rc.2.7 真机反馈 问题 3 / 4）。
 *
 * - 工具过程：同一个 Agent 回合里的全部工具调用（联网搜索、网页读取、浏览器操作、文件、命令……）
 *   合成**一条**过程折叠（稿 `.voice-process`）。摘要行说清在做 / 做了什么，运行中给当前步骤与
 *   已用时间，失败给真实原因与错误码；点开才是逐次调用明细。旧历史里「每工具一张」的卡也在
 *   渲染时并进同一条，不改写存量数据。
 * - 回答正文：只显示纯文本的地方（历史列表摘要、Host 结果面板）用同一套解析器投影成纯文本，
 *   不露 `**`、`-`、`#` 等标记；对话详情里按 Markdown 渲染（chat-ui）。
 */
import { markdownToPlainText, type ChatMessage, type ChatStatusCard, type ChatToolCallEntry } from "@reai/chat-ui";
import { presentAgentToolError } from "./agent-error-presentation";
import { agentCodeLabel, agentToolCodeDetail } from "./agent-failure-codes";
import { durationText } from "./voice-diagnostics";
import { structuredCode } from "./voice-error-fields";
import { t } from "./voice-i18n";

type ToolGroupCard = Extract<ChatStatusCard, { kind: "tool-group" }>;
type ToolStatus = ToolGroupCard["status"];
type EntryStatus = "running" | "completed" | "failed";

/** 联网 / 网页类（地球仪图标）：联网搜索、网页读取与浏览器操作。 */
/** 等你拍板的原因写成当前界面语言：已知原因用本插件文案，未知原因回退 Host 给的说明。 */
export function userWaitLabel(reason: string, hostLabel: string): string {
  if (reason === "browser_plugin_required") return t("app.userWaitReason.browserPlugin");
  if (reason === "scope_approval") return t("app.userWaitReason.scopeApproval");
  return hostLabel;
}

export function isWebTool(tool: string): boolean {
  return tool === "web_search" || tool === "web_fetch" || tool.startsWith("browser_");
}

const NAME_KEYS: Readonly<Record<string, string>> = {
  web_search: "webSearch", web_fetch: "webFetch", browser_navigate: "browserNavigate", browser_observe: "browserObserve",
  browser_click: "browserClick", browser_fill: "browserFill", browser_press: "browserPress", browser_tabs_list: "browserTabs",
  browser_tab_new: "browserTabNew", browser_tab_select: "browserTabSelect", browser_tab_close: "browserTabClose",
  browser_back: "browserBack", browser_reload: "browserReload", computer_frontmost: "computerFrontmost",
  computer_windows_list: "computerWindows", computer_mouse_click: "computerClick", computer_mouse_scroll: "computerScroll",
  computer_key_press: "computerKeyPress", computer_text_type: "computerTypeText", computer_stop: "computerStop",
  device_status: "deviceStatus", permission_status: "permissionStatus", recent_logs: "recentLogs", app_environment: "appEnvironment",
  read: "readFile", write: "writeFile", edit: "editFile", list: "listFolder", glob: "findFiles", grep: "searchFiles",
  run: "runProgram", command: "runCommand",
};

/** 显示名：工具目录里的每个工具各有一个；没登记的直接带上工具标识，不同工具绝不同名。 */
export function toolDisplayName(tool: string): string {
  return Object.hasOwn(NAME_KEYS, tool) ? t(`chat.tools.name.${NAME_KEYS[tool]}`) : t("chat.tools.name.unknown", { tool });
}

export interface ToolProgressCall {
  callId?: string;
  tool: string;
  status: ToolStatus;
  at?: string;
  durationMs?: number;
  errorLabel?: string;
  errorCode?: string;
}
export interface ToolProgress {
  status: ToolStatus;
  calls: readonly ToolProgressCall[];
  totalCalls?: number;
  failedCalls?: number;
}

function usedSummary(progress: ToolProgress): string {
  // 按工具标识计数（不同工具即使显示名相近也分开算），再映射显示名。
  const names = [...new Set(progress.calls.map((call) => call.tool))].map(toolDisplayName);
  const calls = Math.max(progress.totalCalls ?? 0, progress.calls.length);
  if (names.length === 0) return t("chat.tools.usedCount", { calls });
  const shown = names.slice(0, 3).join(t("chat.tools.separator"));
  const list = names.length > 3 ? t("chat.tools.namesMore", { names: shown }) : shown;
  return t(calls > names.length ? "chat.tools.usedRepeated" : "chat.tools.used", { count: names.length, calls, names: list });
}

/**
 * 没解决的失败：某个工具最后一次有结果的调用是失败（之后没有同一工具的成功重试）。返回最近的一条；
 * 工具组终态据此判红，不只看联网两工具（app 收尾与旧历史合成共用）。
 */
export function unresolvedToolFailure(calls: readonly ToolProgressCall[]): ToolProgressCall | undefined {
  const last = new Map<string, ToolProgressCall>();
  for (const call of calls) if (call.status === "failed" || call.status === "completed") last.set(call.tool, call);
  return calls.filter((call) => call.status === "failed" && last.get(call.tool) === call).at(-1);
}

/**
 * 明细超出上限时裁掉哪些：没解决的失败、还在跑的调用、每个工具最近一次调用与最近一次有结果的调用
 * 依次优先保留（工具个数、没解决的失败及其原因与码都靠它们判断，不能因为后面调用多就被挤掉），
 * 其余从最早的开始裁。保持原有先后顺序。被裁掉的调用之后再有结果，由调用方按序号补回再裁。
 */
export function trimToolCalls<T extends ToolProgressCall>(calls: readonly T[], max: number): T[] {
  if (calls.length <= max) return [...calls];
  const keep = new Set<T>();
  const latest = new Map<string, T>();
  const settledLatest = new Map<string, T>();
  for (const call of calls) {
    latest.set(call.tool, call);
    if (call.status === "failed" || call.status === "completed") settledLatest.set(call.tool, call);
  }
  // 必留的也超过上限时：先保没解决的失败（同一工具正在重试的除外，由重试结果决定），再保在途调用，
  // 再保每个工具最近一次，各档内保最近的。
  const tiers: Array<(call: T) => boolean> = [
    (call) => call.status === "failed" && settledLatest.get(call.tool) === call && latest.get(call.tool)?.status !== "running",
    (call) => call.status === "running",
    (call) => latest.get(call.tool) === call,
    (call) => settledLatest.get(call.tool) === call,
    () => true,
  ];
  for (const inTier of tiers) {
    for (let index = calls.length - 1; index >= 0 && keep.size < max; index -= 1) if (inTier(calls[index]!)) keep.add(calls[index]!);
  }
  return calls.filter((call) => keep.has(call));
}

function failingCall(progress: ToolProgress): ToolProgressCall | undefined {
  return unresolvedToolFailure(progress.calls) ?? progress.calls.filter((call) => call.status === "failed").at(-1);
}

/**
 * 失败原因：已登记的码先给联网工具的专门说法，其次是 Host Agent 码的分类短句，再是落盘时的说明
 * （含旧版卡的原文），都没有就如实说「调用失败」。
 */
function failureReason(call: ToolProgressCall, developerMode = true): string {
  const code = structuredCode(call.errorCode);
  return (code ? presentAgentToolError(code, { code, message: "" }).message || agentToolCodeDetail(code)
    || agentCodeLabel(code) : "")
    || (developerMode ? call.errorLabel : "") || t("chat.tools.callFailed");
}

/** 摘要行主句：运行中 = 当前步骤；失败 = 哪个工具没完成 + 原因；其余 = 调用了哪些工具。 */
export function toolProgressLabel(progress: ToolProgress, developerMode = true): string {
  if (progress.status === "running") {
    const current = progress.calls.filter((call) => call.status === "running").at(-1);
    if (current) return t("chat.tools.running", { name: toolDisplayName(current.tool) });
  }
  const failed = progress.status === "failed" ? failingCall(progress) : undefined;
  if (failed) return t("chat.tools.failed", { name: toolDisplayName(failed.tool), reason: failureReason(failed, developerMode) });
  return usedSummary(progress);
}

function toolSpanMs(calls: readonly ToolProgressCall[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const call of calls) {
    const at = call.at ? Date.parse(call.at) : Number.NaN;
    if (!Number.isFinite(at) || typeof call.durationMs !== "number" || !Number.isFinite(call.durationMs)) continue;
    start = Math.min(start, at);
    end = Math.max(end, at + Math.max(0, call.durationMs));
  }
  return Number.isFinite(start) && end - start >= 1000 ? end - start : undefined;
}

/**
 * 摘要行右侧（结束后）：失败态先给错误码；随后只要有失败就写失败次数（不论 Agent 最终是否作答），
 * 再是未确认结束次数与用时。运行中的已用时间由视图给活节点。
 */
export function toolProgressMeta(progress: ToolProgress, developerMode = true): string | undefined {
  if (progress.status === "running") return undefined;
  const parts: string[] = [];
  const failed = progress.status === "failed" ? failingCall(progress) : undefined;
  if (failed && developerMode) {
    const code = structuredCode(failed.errorCode);
    parts.push(code ? t("chat.tools.code", { code }) : t("chat.tools.noCode"));
  }
  const failures = Math.max(progress.failedCalls ?? 0, progress.calls.filter((call) => call.status === "failed").length);
  if (failures > 0) parts.push(t("chat.tools.failures", { count: failures }));
  const unconfirmed = progress.calls.filter((call) => call.status === "unknown" || call.status === "running").length;
  if (unconfirmed > 0) parts.push(t("chat.tools.unconfirmed", { count: unconfirmed }));
  const span = toolSpanMs(progress.calls);
  if (span !== undefined) parts.push(t("diagnostics.took", { duration: durationText(span) }));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** 一行纯文本（落盘标签、桌面胶囊进度、历史列表摘要用）：主句 + 右侧补充。
 * 会离开详情页、也会落盘，所以固定按普通模式生成：不带错误码与上游原文。 */
export function toolProgressText(progress: ToolProgress): string {
  const meta = toolProgressMeta(progress, false);
  const label = toolProgressLabel(progress, false);
  return meta ? `${label} · ${meta}` : label;
}

/** 回合结束后不再有「进行中」：没收到结束事件的调用如实记为未确认结束，图标也不再转。 */
function settled(status: ToolStatus, entry: EntryStatus): ToolStatus {
  return entry !== "running" && status === "running" ? "unknown" : status;
}

type ToolCard = Extract<ChatStatusCard, { kind: "tool" | "tool-group" }>;
function isToolCard(card: ChatStatusCard | undefined): card is ToolCard {
  return card?.kind === "tool" || card?.kind === "tool-group";
}

function callNote(call: ToolProgressCall, developerMode: boolean): string {
  if (call.status === "unknown") return t("chat.tools.callUnconfirmed");
  if (!developerMode) return failureReason(call, false);
  const code = structuredCode(call.errorCode);
  return code
    ? t("chat.tools.callError", { reason: failureReason(call), code })
    : t("chat.tools.callErrorNoCode", { reason: failureReason(call) });
}

/** 明细行：沿用 chat-ui 明细行；显示名、原因随语言切换即时更新（getter 由绑定每次重读）。 */
function presentCall(call: ToolProgressCall, developerMode: boolean): ChatToolCallEntry {
  const entry: ChatToolCallEntry = {
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    status: call.status,
    at: call.at ?? "",
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
    get label() { return toolDisplayName(call.tool); },
    ...(isWebTool(call.tool) ? { icon: "globe" as const } : {}),
  };
  if (call.status === "failed" || call.status === "unknown") {
    Object.defineProperty(entry, "errorLabel", { get: () => callNote(call, developerMode), enumerable: true });
  }
  return entry;
}

/**
 * 把一个回合（一条命令历史）里的全部工具卡并成一条过程折叠，放在第一张工具卡的位置；
 * 其余工具卡消息去掉卡片（没有正文与附件的整条去掉）。没有工具卡时原样返回。
 */
export function mergeToolProgress(messages: ChatMessage[], entryStatus: EntryStatus, developerMode = true): ChatMessage[] {
  const cards = messages.map((message) => message.card).filter(isToolCard);
  if (cards.length === 0) return messages;
  const calls: ToolProgressCall[] = [];
  const statuses: ToolStatus[] = [];
  let totalCalls = 0;
  let failedCalls = 0;
  let omittedCalls = 0;
  for (const card of cards) {
    statuses.push(settled(card.status, entryStatus));
    if (card.kind === "tool") {
      // 旧版「每工具一张」：一张卡就是一次调用，状态照卡；失败卡的说明文字是唯一的原因，带进明细。
      calls.push({ tool: card.tool, status: settled(card.status, entryStatus),
        ...(card.status === "failed" && card.label ? { errorLabel: card.label } : {}) });
      totalCalls += 1;
      if (card.status === "failed") failedCalls += 1;
      continue;
    }
    for (const call of card.calls as readonly ToolProgressCall[]) calls.push({ ...call, status: settled(call.status, entryStatus) });
    totalCalls += Math.max(card.totalCalls ?? 0, card.calls.length);
    failedCalls += card.failedCalls ?? card.calls.filter((call) => call.status === "failed").length;
    omittedCalls += card.omittedCalls ?? 0;
  }
  // 卡上记的终态可能只按联网失败算过（2.14.3 以前）；有没解决的失败就如实判红。
  const status: ToolStatus = statuses.includes("running") ? "running"
    : statuses.includes("failed") || unresolvedToolFailure(calls) ? "failed"
    : statuses.includes("unknown") ? "unknown" : "completed";
  const progress: ToolProgress = { status, calls, totalCalls, failedCalls };
  const merged: ToolGroupCard = {
    kind: "tool-group",
    status,
    get label() { return toolProgressLabel(progress, developerMode); },
    get meta() { return toolProgressMeta(progress, developerMode); },
    ...(calls.some((call) => isWebTool(call.tool)) ? { icon: "globe" as const } : {}),
    calls: calls.map(call => presentCall(call, developerMode)),
    totalCalls,
    failedCalls,
    omittedCalls,
  };
  const out: ChatMessage[] = [];
  let placed = false;
  for (const message of messages) {
    if (!isToolCard(message.card)) {
      out.push(message);
    } else if (!placed) {
      out.push({ ...message, card: merged });
      placed = true;
    } else {
      const { card: _card, ...rest } = message;
      if (rest.text || rest.attachments?.length) out.push(rest);
    }
  }
  return out;
}

/** 列表摘要用：这个回合的过程折叠写成一行纯文本（普通模式口径，不带错误码）；没有工具卡时 undefined。 */
export function toolProgressSummary(messages: ReadonlyArray<{ card?: ChatStatusCard }>, entryStatus: EntryStatus): string | undefined {
  const cards = messages.flatMap((message): ChatMessage[] => message.card ? [{ from: "ai", text: "", at: 0, card: message.card }] : []);
  const card = mergeToolProgress(cards, entryStatus, false).find((message) => message.card?.kind === "tool-group")?.card;
  if (card?.kind !== "tool-group") return undefined;
  return card.meta ? `${card.label} · ${card.meta}` : card.label;
}

/** Host 结果面板等只显示纯文本的位置：去掉 Markdown 标记；投影为空（例如只有分隔线）时保留原文。 */
export function plainReply(text: string): string {
  const plain = markdownToPlainText(text);
  return plain.trim() ? plain : text;
}

const previews = new Map<string, string>();
/** 历史列表摘要：一行纯文本；列表每次重渲染都会取，同一回答只解析一次。 */
export function replyPreview(text: string): string {
  const cached = previews.get(text);
  if (cached !== undefined) return cached;
  const preview = plainReply(text.slice(0, 2000)).replace(/\s+/g, " ").trim();
  if (previews.size >= 200) previews.delete(previews.keys().next().value!);
  previews.set(text, preview);
  return preview;
}
