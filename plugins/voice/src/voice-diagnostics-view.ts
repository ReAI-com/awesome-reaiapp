import { bindAttribute, bindText, readText, t, type TextSource } from "./voice-i18n";
import {
  VOICE_HOST_API_VERSION,
  VOICE_PLUGIN_VERSION,
  agentFailureRows,
  buildVoiceDiagnosticsText,
  detailDisplayValue,
  elapsedNode,
  hostVersionLabel,
  rawReasonLabel,
  safeCount,
  sourceLabel,
  stateLabel,
  structuredToken,
  versionsLabel,
  type VoiceDiagnosticEntry,
  type VoiceHostVersion,
} from "./voice-diagnostics";
import { collectErrorFields, structuredCode } from "./voice-error-fields";
import { constantReasonForCode } from "./voice-failure-labels";

/**
 * 诊断状态行 + 「查看诊断」诊断区（界面口径照 #941 `KernelDiagnostics.vue`）。
 * 展开态与复制结果按 key（含尝试身份）存在视图级 store：整页重渲染不收起；复制在点击时
 * 以 opId 快照，异步结果只更新同一次操作，失败时 `<pre>` 给出当次全文供手动选择。
 */
export interface VoiceCopyRecord {
  opId: number;
  state: "copying" | "copied" | "failed";
  text: string;
  error?: string;
}

export interface VoiceDiagnosticsStore {
  readonly open: Set<string>;
  readonly copy: Map<string, VoiceCopyRecord>;
  /** 本轮渲染出现过的 key；渲染后清掉没出现的，新尝试不继承旧反馈。 */
  readonly seen: Set<string>;
  nextOp: number;
}

export function createVoiceDiagnosticsStore(): VoiceDiagnosticsStore {
  return { open: new Set(), copy: new Map(), seen: new Set(), nextOp: 0 };
}

/** 渲染结束后调用：丢掉这一轮没有再出现的诊断 key。 */
export function sweepVoiceDiagnostics(store: VoiceDiagnosticsStore): void {
  for (const key of [...store.open]) if (!store.seen.has(key)) store.open.delete(key);
  for (const key of [...store.copy.keys()]) if (!store.seen.has(key)) store.copy.delete(key);
  store.seen.clear();
}

export interface VoiceDiagnosticsBlockOptions {
  developerMode?: boolean;
  key: string;
  entry: VoiceDiagnosticEntry;
  host(): VoiceHostVersion | undefined;
  store: VoiceDiagnosticsStore;
  /** 写剪贴板（surface.clipboard@1）。 */
  copy(text: string): Promise<void>;
  /** 复制前补读 Host 版本：复用在途请求，最多等 3 秒。 */
  ensureHost?(): Promise<unknown>;
  rerender(): void;
  /** 等待态超过这个时长后强调显示（由每秒计时器切换）。 */
  slowAfterMs?: number;
  /**
   * 安静模式（正常进行中的活动，如录音）：版本与「查看诊断」入口默认藏起，
   * 只留步骤与已用时间；跨过慢阈值（`data-slow="true"`）后由 CSS 显出来。
   * 没配慢阈值的安静活动永远不显——它不是卡住的等待，不该顶着一块诊断。
   */
  quiet?: boolean;
  className?: string;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, source?: TextSource): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (source !== undefined) bindText(element, source);
  return element;
}

export function voiceDiagnosticsBlock(options: VoiceDiagnosticsBlockOptions): HTMLElement {
  const { key, entry, store } = options;
  if (options.developerMode !== true) {
    const progress = node("div", "voice-progress");
    // 普通模式只给中性的等待步骤；只有真实起点（如录音时长）才显示「已用 N 秒」，
    // 「已等待至少 N 秒（自打开页面起）」这类观测下限只在开发者模式出现。失败主句和恢复动作由业务区提供。
    if (entry.state === "waiting") {
      const spinner = node("span", "voice-progress-spinner");
      spinner.setAttribute("aria-hidden", "true");
      progress.append(spinner, node("span", "voice-progress-step", entry.step));
      if (entry.sinceMs !== undefined && entry.sinceObserved !== true) progress.append(elapsedNode(entry));
    }
    return progress;
  }
  store.seen.add(key);
  const box = node("div", `voice-diag${options.className ? ` ${options.className}` : ""}`);
  box.dataset.diagKey = key;
  box.dataset.diagState = entry.state;
  const meta = node("div", "voice-diag-meta");
  if (options.slowAfterMs !== undefined) box.dataset.voiceSlowScope = "true";
  if (entry.state === "waiting") {
    const step = node("span", "voice-diag-step", () => readText(entry.step));
    meta.append(step);
    if (entry.sinceMs !== undefined) meta.append(node("span", "voice-diag-sep", "·"), elapsedNode(entry, options.slowAfterMs));
  } else {
    const code = structuredCode(entry.code);
    meta.append(node("span", "voice-diag-code", () => t("diagnostics.codeLine", { code: code ?? t("diagnostics.none") })));
    if (entry.sinceMs !== undefined) meta.append(node("span", "voice-diag-sep", "·"), elapsedNode(entry));
  }
  // 安静模式只对等待态生效：一旦进入失败态，版本与入口必须立刻可见（§6.0 底线）。
  const quiet = options.quiet === true && entry.state === "waiting";
  const quietClass = quiet ? " voice-diag-quiet" : "";
  meta.append(
    node("span", `voice-diag-sep${quietClass}`, "·"),
    node("span", `voice-diag-versions${quietClass}`, () => versionsLabel(options.host())),
  );
  const open = store.open.has(key);
  const toggle = node("button", `voice-diag-toggle${quietClass}`, () => t(open ? "diagnostics.close" : "diagnostics.open"));
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", String(open));
  const panelId = `voice-diag-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  toggle.setAttribute("aria-controls", panelId);
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (open) store.open.delete(key); else store.open.add(key);
    options.rerender();
  });
  meta.append(toggle);
  box.append(meta);
  if (open) box.append(diagnosticsPanel(options, panelId));
  return box;
}

/**
 * 用户在诊断区里手动选中的文字，整页重渲染后原样选回。起止两端各记在所属的稳定字段里
 * （`data-diag-field`：每行的 dt / dd、复制失败的 <pre>），偏移只相对该字段计算；字段内容变了
 * （例如「用时」跳了一秒）就不选回，绝不选到错位的文字上。
 */
interface SelectionPoint {
  field: string;
  offset: number;
  text: string;
}

export interface VoiceDiagnosticsSelection {
  key: string;
  start: SelectionPoint;
  end: SelectionPoint;
}

function capturePoint(panel: Element, container: Node, offset: number): SelectionPoint | undefined {
  const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container as Element;
  const field = element?.closest<HTMLElement>("[data-diag-field]");
  if (!field || !panel.contains(field) || container.nodeType !== Node.TEXT_NODE) return undefined;
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === container) return { field: field.dataset.diagField!, offset: total + offset, text: field.textContent ?? "" };
    total += current.textContent?.length ?? 0;
  }
  return undefined;
}

function locatePoint(panel: Element, point: SelectionPoint): { node: Node; offset: number } | undefined {
  const field = Array.from(panel.querySelectorAll<HTMLElement>("[data-diag-field]")).find((element) => element.dataset.diagField === point.field);
  if (!field || (field.textContent ?? "") !== point.text) return undefined;
  const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const length = current.textContent?.length ?? 0;
    if (point.offset <= total + length) return { node: current, offset: point.offset - total };
    total += length;
  }
  return undefined;
}

export function captureDiagnosticsSelection(root: ParentNode): VoiceDiagnosticsSelection | undefined {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const panel = range.startContainer.parentElement?.closest<HTMLElement>(".voice-diag-panel");
  if (!panel || !root.contains(panel) || !panel.contains(range.endContainer)) return undefined;
  const start = capturePoint(panel, range.startContainer, range.startOffset);
  const end = capturePoint(panel, range.endContainer, range.endOffset);
  const key = panel.dataset.diagKey;
  return key && start && end ? { key, start, end } : undefined;
}

export function restoreDiagnosticsSelection(root: ParentNode, saved: VoiceDiagnosticsSelection | undefined): void {
  if (!saved) return;
  const panel = Array.from(root.querySelectorAll<HTMLElement>(".voice-diag-panel"))
    .find((element) => element.dataset.diagKey === saved.key);
  if (!panel) return;
  const start = locatePoint(panel, saved.start);
  const end = locatePoint(panel, saved.end);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function diagnosticsPanel(options: VoiceDiagnosticsBlockOptions, panelId: string): HTMLElement {
  const { key, entry, store } = options;
  const panel = node("section", "voice-diag-panel");
  panel.id = panelId;
  panel.dataset.diagKey = key;
  bindAttribute(panel, "aria-label", () => t("diagnostics.title"));
  const list = node("dl", "");
  let rows = 0;
  const row = (label: TextSource, value: TextSource | HTMLElement, className = "") => {
    rows += 1;
    const term = node("dt", "", label);
    term.dataset.diagField = `dt-${rows}`;
    list.append(term);
    const cell = node("dd", className);
    cell.dataset.diagField = `dd-${rows}`;
    if (value instanceof HTMLElement) cell.append(value); else bindText(cell, value);
    list.append(cell);
  };
  // 行与复制全文逐项对应（白名单字段）；原文只在最后的展开区里，且不进复制。
  const none = () => t("diagnostics.none");
  const code = structuredCode(entry.code);
  row(() => t("diagnostics.version"), () => `Voice ${VOICE_PLUGIN_VERSION} · App ${hostVersionLabel(options.host())} · Host API ${VOICE_HOST_API_VERSION}`);
  row(() => t("diagnostics.status"), () => stateLabel(entry.state));
  const current = node("span", "", entry.step);
  if (entry.sinceMs !== undefined) current.append(" · ", elapsedNode(entry));
  row(() => t("diagnostics.current"), current);
  if (entry.noteKey) row(() => t("diagnostics.message"), () => t(entry.noteKey!));
  row(() => t("diagnostics.errorCode"), () => code ?? none(), "voice-diag-mono");
  const upstream = (entry.upstreamCodes ?? []).map(structuredCode).filter(Boolean).join(", ");
  if (upstream) row(() => t("diagnostics.upstreamCodes"), upstream, "voice-diag-mono");
  if (safeCount(entry.omittedCodes)) row(() => t("diagnostics.omittedCodes"), () => t("diagnostics.omittedCodesValue", { count: safeCount(entry.omittedCodes)! }));
  // Agent 阶段 / 退出码 / 上游码：与复制全文同一份逐值校验；行数不随语言变，键与值随语言重算。
  agentFailureRows(entry.agentFailure).forEach((_, index) => row(
    () => agentFailureRows(entry.agentFailure)[index]?.[0] ?? "",
    () => agentFailureRows(entry.agentFailure)[index]?.[1] ?? "", "voice-diag-mono"));
  if (sourceLabel(entry.source)) row(() => t("diagnostics.source"), () => sourceLabel(entry.source) ?? t("diagnostics.none"));
  if (typeof entry.httpStatus === "number") row(() => t("diagnostics.httpStatus"), structuredToken(entry.httpStatus), "voice-diag-mono");
  if (constantReasonForCode(code)) row(() => t("diagnostics.codeReason"), () => constantReasonForCode(code) ?? none());
  row(() => t("diagnostics.rawReason"), () => safeCount(entry.rawLength) && !entry.raw
    ? `${rawReasonLabel(entry)} · ${t("diagnostics.rawNotKept")}` : rawReasonLabel(entry), "voice-diag-raw");
  if (entry.at) row(() => t(entry.atKind === "detected" ? "diagnostics.detectedAt" : "diagnostics.occurredAt"), entry.at);
  if (entry.details?.length) {
    const items = node("ul", "");
    for (const detail of entry.details) items.append(node("li", "", () => `${readText(detail.label)}: ${detailDisplayValue(detail)}`));
    row(() => t("diagnostics.details"), items);
  }
  row(() => t("diagnostics.logLocation"), () => t("diagnostics.logLocationValue"));
  panel.append(list);
  if (entry.raw) panel.append(rawExpander(key, entry.raw, store));

  const record = store.copy.get(key);
  const actions = node("div", "voice-diag-actions");
  const button = node("button", "secondary-button voice-diag-copy", () => t(record?.state === "copying" ? "diagnostics.copying" : "diagnostics.copy"));
  button.type = "button";
  button.disabled = record?.state === "copying";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const opId = ++store.nextOp;
    store.copy.set(key, { opId, state: "copying", text: "" });
    options.rerender();
    void (async () => {
      await options.ensureHost?.().catch(() => undefined);
      // 快照：这次点击对应的诊断全文。之后状态再变，也不影响这次复制与失败时给出的 <pre>。
      const text = buildVoiceDiagnosticsText(entry, options.host());
      const matches = () => store.copy.get(key)?.opId === opId;
      if (!matches()) return;
      try {
        await options.copy(text);
        if (matches()) store.copy.set(key, { opId, state: "copied", text });
      } catch (cause) {
        // 只写码或异常名（结构化值），不写异常原文。
        const name = cause && typeof cause === "object" ? (cause as { name?: unknown }).name : undefined;
        const error = collectErrorFields(cause).code ?? structuredCode(name) ?? t("diagnostics.none");
        if (matches()) store.copy.set(key, { opId, state: "failed", text, error });
      }
      options.rerender();
    })();
  });
  actions.append(button);
  if (record?.state === "copied") {
    const status = node("span", "voice-diag-feedback", () => t("diagnostics.copied"));
    status.setAttribute("role", "status");
    actions.append(status);
  } else if (record?.state === "failed") {
    const alert = node("span", "voice-diag-feedback voice-diag-feedback-error", () => t("diagnostics.copyFailed", { error: record.error ?? t("diagnostics.none") }));
    alert.setAttribute("role", "alert");
    actions.append(alert);
  }
  panel.append(actions);
  if (record?.state === "failed") {
    const fallback = node("pre", "voice-diag-fallback", record.text);
    fallback.dataset.diagField = `fallback-${record.opId}`;
    panel.append(fallback);
  }
  return panel;
}

/**
 * 原始信息展开区：只在插件自己的界面、用户主动点开时显示原文（可能含用户内容）。
 * 不进复制全文、不落盘、不进浮层；展开状态跟诊断区一样按 key 记在 store 里，整页重渲染不收起。
 */
function rawExpander(key: string, raw: string, store: VoiceDiagnosticsStore): HTMLElement {
  const rawKey = `${key}#raw`;
  store.seen.add(rawKey);
  const box = node("details", "voice-diag-rawbox");
  box.open = store.open.has(rawKey);
  box.addEventListener("toggle", () => {
    if (box.open) store.open.add(rawKey); else store.open.delete(rawKey);
  });
  box.append(node("summary", "voice-diag-rawsummary", () => t("diagnostics.rawExpand")));
  const text = node("pre", "voice-diag-rawtext", raw);
  text.dataset.diagField = "raw";
  box.append(text);
  return box;
}
