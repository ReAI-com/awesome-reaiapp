/**
 * 能力探针主界面。只依赖 ProbePort，Driver 和浏览器预览共用同一份界面代码。
 */
import { buildCatalog, CONTRACT_HOST_API, officialPluginRows, PLUGIN_APP_ID, PLUGIN_VERSION, TIER_LABELS, tierCounts, usableByLocalPackage, type CapabilityEntry, type Tier } from "./catalog";
import { GROUP_LABELS } from "./capability-text";
import { h, icon, type IconName } from "./dom";
import { OFFICIAL_PLUGINS_SNAPSHOT } from "./generated/official-plugins";
import { BAD_SPECS, DEMO_SPEC, parsePageSpec } from "./page-spec";
import { PageActionError, renderPage, type RenderedPage } from "./page-renderer";
import type { KvPort, ProbePort } from "./port";
import { acceptanceOrder, passed, systemTaskReturnResult, PROBES, runnableProbes, runProbe, safeProbes, SECTION_LABELS, VERDICT_LABELS, VERDICT_ORDER, verdictOf, type ProbeDefinition, type ProbeResult, type ProbeSection, type Verdict } from "./probes";
import { CHANGELOG_TEXT } from "./release-notes";
import { describeError, scrub } from "./errors";
import { buildReport } from "./report";
import { diskLocation, manualDelete, manualRead, manualWrite, MANUAL_KEY, type ManualView } from "./kv-manual";
import { DICTATION_PHASE_LABELS, DICTATION_TIMEOUT_MS, isActive, VoiceDictation } from "./voice-dictation";
import { clearSavedResults, loadSavedResults, saveResult } from "./saved-results";
import { cleanCloud, cleanLocal, type CleanupItem, type CleanupStatus } from "./cleanup";
import { PROBE_KB_MARKER, PROBE_ROW_NAME, TEST_PROJECT_NAME } from "./cloud-probes";

export type PageId = "overview" | ProbeSection | "capabilities" | "official" | "records" | "settings" | "changelog" | "about";

export interface ProbeViewOptions {
  port: ProbePort;
  /** Driver 版本；读取失败时带错误码（只在开发者模式显示）。 */
  hostVersion: Promise<HostVersion>;
  reportNav?(nav: { key: string; label: string } | null): void;
  /** 跳到 Driver 设置页之前的提示倒计时，默认 3 秒；测试里设 0。 */
  jumpDelayMs?: number;
}

export type HostVersion = { ok: true; version: string } | { ok: false; code: string };

export interface ProbeView {
  show(page: PageId): void;
  /** 标题栏「设置」：总是打开设置页（Host 不把它当开关，标签固定是「打开设置」）。 */
  openSettings(): void;
  /** Host 面包屑点祖先时调用（back-to-root 命令）。 */
  backToRoot(): void;
  runSafe(): Promise<void>;
  /** 按验收顺序跑完全部能运行的测试（含弹通知、启动 Voice、跳到设置页）。 */
  runEverything(): Promise<void>;
  /** Driver 从系统页返回时投递的意图；是本探针发起的跳转就记下结果，返回是否认得。 */
  handleIntent(intent: unknown): boolean;
  readonly currentPage: PageId;
  dispose(): void;
}

const NAV: { id: PageId; label: string; icon: IconName }[] = [
  { id: "overview", label: "总览", icon: "home" },
  { id: "basic", label: "本机基础能力", icon: "grid" },
  { id: "permission", label: "需要同意的能力", icon: "shield" },
  { id: "page", label: "页面与脚本", icon: "layout" },
  { id: "cloud", label: "外脑云端", icon: "cloud" },
  { id: "gated", label: "需要平台批准", icon: "lock" },
  { id: "capabilities", label: "全部能力", icon: "list" },
  { id: "official", label: "插件仓对照", icon: "file" },
  { id: "records", label: "记录与报告", icon: "clock" },
];

const SUB_PAGES: Partial<Record<PageId, string>> = { settings: "设置", changelog: "更新日志", about: "关于插件" };

function clock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const CLEANUP_LABELS: Record<CleanupStatus, string> = { deleted: "已删除", none: "没有", partial: "没扫完", manual: "需手动删", failed: "失败", skipped: "没清理" };
const CLEANUP_TONES: Record<CleanupStatus, string> = { deleted: "ok", none: "muted", partial: "waiting", manual: "waiting", failed: "failed", skipped: "waiting" };

const VERDICT_ICON: Record<Verdict, IconName> = { ok: "check", expected: "shield", blocked: "shield", unexpected: "alert", failed: "x", waiting: "clock" };

export function mountProbeView(root: HTMLElement, options: ProbeViewOptions): ProbeView {
  const doc = root.ownerDocument;
  const { port } = options;
  const catalog = buildCatalog();
  const results = new Map<string, ProbeResult>();
  /** 正在跑的探针 → 开始时间与进行中的 Promise；同一个探针不会并发跑两次。 */
  const running = new Map<string, { startedAt: number; promise: Promise<ProbeResult> }>();
  const log: ProbeResult[] = [];
  /** 来自上次保存（同一 Driver、同一插件版本）、本次还没重测的探针。 */
  const restoredIds = new Set<string>();
  /** 本次界面里点过「清空」的时间；比它早的保存结果不再恢复。 */
  let clearedAt: number | null = null;
  let clearError = false;
  /** 「清理测试数据」的状态：先确认，再删本地和外脑 test 项目里探针留下的数据，逐项如实报告。 */
  let cleanup: { phase: "idle" | "confirm" | "busy" | "done"; items: CleanupItem[] } = { phase: "idle", items: [] };
  /** 清理进行中：探针、批量测试、单步存储验证都先停着，免得一边删一边又写进新的测试数据。 */
  const cleaning = () => cleanup.phase === "busy";
  /** 记录结果时用的 Driver 版本；读不到时为 null：这次的结果不保存，也不恢复任何历史结果。 */
  const hostVersionKey: Promise<string | null> = options.hostVersion.then((value) => (value.ok ? value.version : null));
  let page: PageId = "overview";
  let rootPage: PageId = "overview";
  let developerMode = false;
  let hostVersionState: HostVersion | undefined;
  let disposed = false;
  let runAll: { index: number; total: number; startedAt: number; current: string } | null = null;
  let renderedSpec: RenderedPage | null = null;
  let specSource = JSON.stringify(DEMO_SPEC, null, 2);
  let capFilter: Tier | "all" = "all";
  const timers = new Set<ReturnType<typeof setInterval>>();
  const abort = new AbortController();

  const frame = h(doc, "div", { className: "cp-frame" });
  const body = h(doc, "main", { className: "main-body cp-body" });
  const nav = h(doc, "nav", { className: "cp-nav", attrs: { "aria-label": "能力探针导航" } });
  const content = h(doc, "section", { className: "cp-content" });
  // 读屏只播报「哪个测试完成、结果如何」，不播报整页重绘。
  const live = h(doc, "div", { className: "cp-visually-hidden", attrs: { role: "status", "aria-live": "polite" } });
  // 跳页面之前的提示条：放在内容区外面，切页、重绘都不会把它冲掉。
  const notice = h(doc, "div", { className: "cp-jump-notice", attrs: { role: "alert", hidden: "" } });
  body.append(nav, content);
  frame.append(notice, body, live);
  root.replaceChildren(frame);

  const offEnv = port.onEnvironmentChange((value) => {
    developerMode = value.developerMode;
    render();
  });
  void port.environment().then((value) => { developerMode = value.developerMode; render(); }).catch(() => undefined);
  void options.hostVersion.then((value) => { hostVersionState = value; render(); });
  void restore();

  /**
   * 读回上次保存的结果：只认同一 Driver 版本、同一插件版本的；按探针合并，本次已经测过的以本次为准。
   */
  async function restore(): Promise<void> {
    const host = await hostVersionKey;
    if (disposed) return;
    const saved = await loadSavedResults(port.kv);
    if (disposed) return;
    for (const record of saved.results) {
      if (host === null || record.host !== host || record.plugin !== PLUGIN_VERSION) continue;
      if (clearedAt !== null && Date.parse(record.startedAt) < clearedAt) continue;
      const current = results.get(record.probeId);
      if (running.has(record.probeId) || (current && Date.parse(current.startedAt) >= Date.parse(record.startedAt))) continue;
      const { host: _host, plugin: _plugin, ...result } = record;
      results.set(record.probeId, result);
      restoredIds.add(record.probeId);
    }
    for (const record of saved.log) {
      if (host === null || record.host !== host || record.plugin !== PLUGIN_VERSION) continue;
      if (clearedAt !== null && Date.parse(record.startedAt) < clearedAt) continue;
      if (log.some((item) => item.probeId === record.probeId && item.startedAt === record.startedAt)) continue;
      const { host: _host, plugin: _plugin, ...result } = record;
      log.push(result);
    }
    log.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    if (log.length > 200) log.length = 200;
    render();
  }

  /** 只在当前界面显示、不保存的过渡结果（跳转请求已被接受、还在等 Driver 的回执）。 */
  const transientIds = new Set<string>();
  /** 跳转因上一次还没结束被 Driver 拒绝时的提示；下一次正式结果到了就清掉。 */
  let jumpBlockedHint = "";

  /**
   * 记下一条结果并保存。界面已卸载时只保存，不再改界面状态。
   * 「跳到 Driver 设置页」被接受但还没回执的结果是过渡状态：只显示、不保存、不进记录，回执一到就被替换。
   */
  function recordResult(result: ProbeResult): void {
    // 清空之前开始的测试，晚到的结果不再收：界面、记录和存储都保持清空后的样子。
    if (clearedAt !== null && Date.parse(result.startedAt) < clearedAt) return;
    if (result.probeId === "system-task-open" && result.outcome === "waiting") {
      if (disposed) return;
      const current = results.get(result.probeId);
      // 新请求因上一次还没结束被拒：这不是一次新结果，只在卡片上给提示，不动已有结果，
      // 上一次的回执（不管先到后到、界面有没有重开过）照样能更新结果。
      if (result.code === "SYSTEM_TASK_RETURN_PENDING" || result.code === "SYSTEM_TASK_BUSY") {
        jumpBlockedHint = result.summary;
        return;
      }
      // 已经有同次或更晚的结果（例如回执先到）就不显示过渡状态。
      if (current && !transientIds.has(result.probeId) && Date.parse(current.startedAt) >= Date.parse(result.startedAt)) return;
      results.set(result.probeId, result);
      transientIds.add(result.probeId);
      restoredIds.delete(result.probeId);
      return;
    }
    if (result.probeId === "system-task-open") jumpBlockedHint = "";
    void hostVersionKey.then((host) => (host === null ? undefined : saveResult(port.kv, { ...result, host, plugin: PLUGIN_VERSION })));
    if (disposed) return;
    const current = results.get(result.probeId);
    // 同一探针只留开始时间更晚的；时间相同时保留先到的，但同一次的正式结果优先于过渡状态。
    // 更早一次的回执（例如连点两次跳转，第一次的回执晚到）不会盖掉新一次的等待状态。
    const currentAt = current ? Date.parse(current.startedAt) : Number.NEGATIVE_INFINITY;
    const resultAt = Date.parse(result.startedAt);
    if (!current || currentAt < resultAt || (transientIds.has(result.probeId) && currentAt === resultAt)) {
      results.set(result.probeId, result);
      transientIds.delete(result.probeId);
      restoredIds.delete(result.probeId);
    }
    if (!log.some((item) => item.probeId === result.probeId && item.startedAt === result.startedAt)) {
      log.unshift(result);
      log.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      if (log.length > 200) log.length = 200;
    }
  }

  function hostVersionText(): string {
    if (!hostVersionState) return "读取中…";
    if (hostVersionState.ok) return hostVersionState.version;
    return developerMode ? `读取失败（${hostVersionState.code}）` : "读取失败";
  }

  function reportNav(): void {
    const label = SUB_PAGES[page];
    options.reportNav?.(label ? { key: page, label } : null);
  }

  function show(next: PageId): void {
    if (!SUB_PAGES[next]) rootPage = next;
    page = next;
    reportNav();
    render();
    content.scrollTop = 0;
  }

  function button(label: string, onClick: () => void, opts: { tier?: "primary" | "secondary" | "link"; disabled?: boolean; icon?: IconName; aria?: string } = {}): HTMLButtonElement {
    const node = h(doc, "button", { className: `cp-btn cp-btn--${opts.tier ?? "secondary"}`, attrs: { type: "button" } });
    if (opts.icon) node.append(icon(doc, opts.icon));
    node.append(doc.createTextNode(label));
    if (opts.aria) node.setAttribute("aria-label", opts.aria);
    node.disabled = opts.disabled === true;
    node.addEventListener("click", onClick);
    return node;
  }

  function badge(text: string, tone: string): HTMLElement {
    return h(doc, "span", { className: `cp-badge cp-badge--${tone}`, text });
  }

  function intro(title: string, description: string): HTMLElement {
    return h(doc, "header", { className: "cp-intro" }, h(doc, "h2", { text: title }), description ? h(doc, "p", { text: description }) : null);
  }

  /**
   * 跳到 Driver 设置页之前先提示几秒：说明要去哪、怎么回来，可以取消。
   * 返回 true = 倒计时结束继续跳；false = 取消或界面已关闭。
   */
  function announceJump(): Promise<boolean> {
    const total = Math.max(0, options.jumpDelayMs ?? 3000);
    return new Promise((resolve) => {
      let left = Math.ceil(total / 1000);
      const text = h(doc, "span", {});
      const update = () => { text.textContent = `${left > 0 ? `${left} 秒后` : "马上"}跳到 Driver 的「本插件权限页」。到那边点右上角的「返回」回到探针，这一项才算通过。`; };
      const cancel = button("取消跳转", () => finish(false), { tier: "secondary" });
      notice.replaceChildren(icon(doc, "alert"), text, cancel);
      notice.hidden = false;
      update();
      const tick = setInterval(() => { left = Math.max(0, left - 1); update(); }, 1000);
      const timer = setTimeout(() => finish(true), total);
      const onAbort = () => finish(false);
      abort.signal.addEventListener("abort", onAbort, { once: true });
      function finish(go: boolean): void {
        clearInterval(tick);
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", onAbort);
        notice.hidden = true;
        notice.replaceChildren();
        resolve(go && !disposed);
      }
    });
  }

  function execute(probe: ProbeDefinition): Promise<ProbeResult> {
    const existing = running.get(probe.id);
    if (existing) return existing.promise;
    // 清理进行中不开始新测试：不记录、不保存。
    if (cleaning()) return Promise.resolve({ probeId: probe.id, outcome: "waiting", summary: "正在清理测试数据，清理完再测", startedAt: new Date().toISOString(), durationMs: 0 });
    const promise = (async () => {
      if (probe.risk === "navigate" && !(await announceJump())) {
        running.delete(probe.id);
        // 取消了：不算一次测试，不记录、不保存。
        const cancelled: ProbeResult = { probeId: probe.id, outcome: "waiting", summary: "已取消跳转", startedAt: new Date().toISOString(), durationMs: 0 };
        if (!disposed) { live.textContent = "已取消跳转"; render(); }
        return cancelled;
      }
      const result = await runProbe(probe, { port, document: doc, signal: abort.signal });
      running.delete(probe.id);
      // 界面卸载后结果也要保存下来。
      recordResult(result);
      if (disposed) return result;
      live.textContent = `「${probe.title}」测试完成：${VERDICT_LABELS[verdictOf(result)]}`;
      render();
      return result;
    })();
    running.set(probe.id, { startedAt: Date.now(), promise });
    ensureTicker();
    render();
    return promise;
  }

  /** 等待超过 1 秒时，原地更新「已用 N 秒」，不整页重绘。 */
  let ticker: ReturnType<typeof setInterval> | undefined;
  function ensureTicker(): void {
    if (ticker !== undefined) return;
    ticker = setInterval(() => {
      if (running.size === 0 && !runAll) {
        clearInterval(ticker);
        timers.delete(ticker!);
        ticker = undefined;
        return;
      }
      updateElapsed();
    }, 1000);
    timers.add(ticker);
  }

  function elapsedText(startedAt: number): string {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    return seconds >= 1 ? `已用 ${seconds} 秒` : "";
  }

  function updateElapsed(): void {
    for (const node of content.querySelectorAll<HTMLElement>("[data-elapsed-for]")) {
      const entry = running.get(node.dataset.elapsedFor ?? "");
      node.textContent = entry ? elapsedText(entry.startedAt) : "";
    }
    const progress = content.querySelector<HTMLElement>(".cp-progress");
    if (progress && runAll) progress.textContent = runAllText();
  }

  function runSafe(): Promise<void> {
    return runList(safeProbes());
  }

  function runEverything(): Promise<void> {
    return runList(acceptanceOrder());
  }

  /** 有「会离开页面」的测试在倒计时或执行中：这时不能再开一轮批量测试，免得跳走打断它。 */
  function navigating(): boolean {
    return [...running.keys()].some((id) => PROBES.find((probe) => probe.id === id)?.risk === "navigate");
  }

  async function runList(list: ProbeDefinition[]): Promise<void> {
    if (runAll || navigating() || cleaning()) return;
    runAll = { index: 0, total: list.length, startedAt: Date.now(), current: list[0]?.title ?? "" };
    ensureTicker();
    try {
      for (const [index, probe] of list.entries()) {
        if (disposed) return;
        runAll = { ...runAll, index: index + 1, current: probe.title };
        await execute(probe);
      }
    } finally {
      runAll = null;
      if (!disposed) {
        live.textContent = "这一轮测试已完成";
        render();
      }
    }
  }

  function resultBlock(probe: ProbeDefinition): HTMLElement | null {
    const result = results.get(probe.id);
    if (!result) return null;
    const verdict = verdictOf(result);
    const block = h(doc, "div", { className: `cp-result cp-result--${verdict}` });
    const head = h(doc, "div", { className: "cp-result-head" }, icon(doc, VERDICT_ICON[verdict]), h(doc, "strong", { text: VERDICT_LABELS[verdict] }), h(doc, "span", { text: result.summary }));
    block.append(head);
    const meta = `${clock(result.startedAt)} · 用时 ${result.durationMs} 毫秒`;
    block.append(h(doc, "span", { className: "cp-result-meta", text: meta }));
    if (developerMode && (result.code || result.detail)) {
      const details = h(doc, "details", { className: "cp-diag" }, h(doc, "summary", { text: "诊断信息" }));
      details.append(h(doc, "pre", { text: [result.code ? `错误码：${result.code}` : "", result.detail ?? ""].filter(Boolean).join("\n") }));
      block.append(details);
    }
    return block;
  }

  function probeCard(probe: ProbeDefinition): HTMLElement {
    const card = h(doc, "article", { className: "cp-card", attrs: { "data-probe": probe.id } });
    const title = h(doc, "div", { className: "cp-card-title" }, h(doc, "h3", { text: probe.title }), badge(probe.level, probe.level === "P0" ? "neutral" : "muted"));
    card.append(title, h(doc, "p", { className: "cp-card-sub", text: probe.capability }));
    card.append(h(doc, "dl", { className: "cp-facts" }, h(doc, "dt", { text: "做什么" }), h(doc, "dd", { text: probe.what }), h(doc, "dt", { text: "预期" }), h(doc, "dd", { text: probe.expect })));
    if (probe.disabledReason) {
      card.append(h(doc, "p", { className: "cp-locked" }, icon(doc, "lock"), h(doc, "span", { text: probe.disabledReason })));
      return card;
    }
    const entry = running.get(probe.id);
    const result = results.get(probe.id);
    const label = entry ? "测试中…" : result ? "再测一次" : "测试";
    const actions = h(doc, "div", { className: "cp-card-actions" }, button(label, () => void execute(probe), { disabled: entry !== undefined || runAll !== null || cleaning(), icon: "play", aria: `${label}：${probe.title}` }));
    if (entry) actions.append(h(doc, "span", { className: "cp-progress", text: elapsedText(entry.startedAt), attrs: { "data-elapsed-for": probe.id } }));
    if (probe.risk === "navigate") actions.append(h(doc, "span", { className: "cp-hint", text: "会先提示 3 秒再离开当前页面，可以取消" }));
    if (probe.risk === "notify") actions.append(h(doc, "span", { className: "cp-hint", text: "会弹出一条系统通知" }));
    if (probe.risk === "wake") actions.append(h(doc, "span", { className: "cp-hint", text: "会启动 Voice 插件" }));
    if (probe.risk === "cost") actions.append(h(doc, "span", { className: "cp-hint", text: "会消耗少量外脑账户额度" }));
    card.append(actions);
    const block = resultBlock(probe);
    if (block) card.append(block);
    if (probe.id === "kv-roundtrip") card.append(manualKvSection());
    if (probe.id === "system-task-open" && jumpBlockedHint) card.append(h(doc, "p", { className: "cp-locked", attrs: { role: "status" } }, icon(doc, "alert"), h(doc, "span", { text: jumpBlockedHint })));
    if (probe.id === "voice-service") card.append(dictationSection());
    return card;
  }

  /** 单步验证的状态：最近一次操作的结果，跨重绘保留。 */
  let manual: { busy: boolean; message: string; tone: "ok" | "failed" | "neutral"; view?: ManualView; written?: string } = { busy: false, message: "", tone: "neutral" };

  async function manualAction(kind: "write" | "read" | "delete"): Promise<void> {
    if (manual.busy || cleaning()) return;
    manual = { ...manual, busy: true };
    render();
    try {
      if (kind === "write") {
        const value = await manualWrite(port.kv);
        const view = await manualRead(port.kv);
        // 写入后立刻读回核对：值、核对码、键列表都对得上才算写入成功。
        const ok = view.value?.code === value.code && view.value.writtenAt === value.writtenAt && view.listed;
        manual = ok
          ? { busy: false, tone: "ok", written: value.code, view, message: `已写入并读回核对，核对码 ${value.code}。按下面的位置到硬盘上核对。` }
          : { busy: false, tone: "failed", written: value.code, view, message: `写入后读回对不上（写的是 ${value.code}），和预期不一致` };
      } else if (kind === "read") {
        const view = await manualRead(port.kv);
        const message = view.value
          ? `插件读回：核对码 ${view.value.code}，写于 ${new Date(view.value.writtenAt).toLocaleString()}`
          : view.exists ? "插件读回：有这个键，但内容不是探针写的格式" : "插件读回：没有这条数据（还没写入，或已经删掉）";
        manual = { ...manual, busy: false, tone: view.exists && !view.value ? "failed" : "ok", view, message };
      } else {
        await manualDelete(port.kv);
        const view = await manualRead(port.kv);
        const gone = !view.exists && !view.listed;
        manual = { busy: false, tone: gone ? "ok" : "failed", view, message: gone ? "已删除：读不到、键列表里也没有了。再到硬盘文件里核对一下" : "删除后仍能读到或键列表里还有，和预期不一致" };
      }
    } catch (error) {
      const { code, message } = describeError(error);
      manual = { ...manual, busy: false, tone: "failed", message: developerMode ? `操作失败（${code}）：${scrub(message, 200)}` : "操作失败" };
    }
    if (!disposed) render();
  }

  function manualKvSection(): HTMLElement {
    const wrap = h(doc, "section", { className: "cp-manual", attrs: { "aria-label": "单步验证" } });
    wrap.append(h(doc, "h4", { text: "单步验证：自己看看存在哪" }));
    wrap.append(h(doc, "p", { className: "cp-card-sub", text: "写入一条固定的测试数据，再查看、删除。查看时对照三处：插件读回的值、键列表、硬盘上的文件。这几个按钮不计入验收项。" }));
    const row = h(doc, "div", { className: "cp-card-actions" },
      button("写入", () => void manualAction("write"), { disabled: manual.busy || cleaning() }),
      button("查看", () => void manualAction("read"), { disabled: manual.busy || cleaning() }),
      button("删除", () => void manualAction("delete"), { disabled: manual.busy || cleaning() }),
    );
    wrap.append(row);
    if (manual.message) wrap.append(h(doc, "p", { className: `cp-manual-msg cp-manual-msg--${manual.tone}`, attrs: { role: "status" }, text: manual.message }));
    if (manual.view) {
      const where = diskLocation(PLUGIN_APP_ID, manual.view.value?.code);
      const facts = h(doc, "dl", { className: "cp-facts" },
        h(doc, "dt", { text: "① 插件读回" }), h(doc, "dd", { text: manual.view.value ? `存在，核对码 ${manual.view.value.code}` : manual.view.exists ? "有这个键，但格式不对" : "不存在" }),
        h(doc, "dt", { text: "② 键列表" }), h(doc, "dd", { text: manual.view.listed ? `有「${MANUAL_KEY}」` : `没有「${MANUAL_KEY}」` }),
        h(doc, "dt", { text: "③ 硬盘文件" }), h(doc, "dd", {}, h(doc, "span", { text: `文件夹 ${where.folder}` }), h(doc, "br", {}), h(doc, "span", { text: `文件 ${where.file}` }), h(doc, "br", {}), h(doc, "span", { text: `在文件的 entries 里找「${where.entryKey}」${manual.view.value ? `，值里的 code 应是 ${manual.view.value.code}` : "，应该找不到"}` })),
      );
      wrap.append(facts);
      const cmd = h(doc, "input", { className: "cp-input cp-mono", attrs: { readonly: "", "aria-label": "到硬盘上核对的终端命令" } });
      cmd.value = where.command;
      wrap.append(h(doc, "p", { className: "cp-hint", text: manual.view.value
        ? "插件拿不到账号目录名。把下面这行粘到「终端」回车：它在所有账号的存储文件里找含这个核对码的那个，访达会选中它（只读，不改任何东西）。"
        : "把下面这行粘到「终端」回车：它列出还含这个键的存储文件，什么都没列出就说明已经删干净了（只读，不改任何东西）。" }), cmd,
        h(doc, "div", { className: "cp-card-actions" }, button("全选命令", () => { cmd.focus(); cmd.select(); }, { tier: "link" })));
    }
    return wrap;
  }

  /** 「录一句话」：真的发起一次听写，跟踪状态，拿到识别出的文字。不计入验收项。 */
  const dictation = new VoiceDictation(port, () => { if (!disposed) render(); });

  function dictationSection(): HTMLElement {
    const state = dictation.state;
    const active = isActive(state);
    const wrap = h(doc, "section", { className: "cp-manual", attrs: { "aria-label": "录一句话" } });
    wrap.append(h(doc, "h4", { text: "录一句话：验证真的能拿到文字" }));
    wrap.append(h(doc, "p", { className: "cp-card-sub", text: `上面的测试只问了一个不存在的请求。这里真的发起一次听写：会打开麦克风，识别走云端、可能消耗账户额度，最长 ${DICTATION_TIMEOUT_MS / 60_000} 分钟。识别出的文字只显示在这里，不保存、不进报告。不计入验收项。` }));
    wrap.append(h(doc, "div", { className: "cp-card-actions" },
      button(active ? "听写中…" : state.phase === "idle" ? "开始听写" : "再录一次", () => dictation.start(), { tier: "primary", disabled: active, icon: "play" }),
      button("说完了", () => void dictation.finish(), { disabled: !active || state.phase === "processing" }),
      button("取消", () => void dictation.cancel(), { disabled: !active }),
    ));
    if (state.phase !== "idle") {
      const tone = state.phase === "completed" ? "ok" : state.phase === "failed" || state.phase === "timed_out" ? "failed" : "neutral";
      wrap.append(h(doc, "p", { className: `cp-manual-msg cp-manual-msg--${tone}`, attrs: { role: "status" }, text: `状态：${DICTATION_PHASE_LABELS[state.phase]}${state.phase === "listening" ? "。说完点「说完了」" : ""}` }));
      const facts = h(doc, "dl", { className: "cp-facts" });
      const row = (label: string, value: string) => facts.append(h(doc, "dt", { text: label }), h(doc, "dd", { text: value }));
      if (state.requestId) row("请求号", state.requestId);
      if (state.revision !== undefined) row("状态版本", String(state.revision));
      if (state.captureStarted !== undefined) row("麦克风已开", state.captureStarted ? "是" : "否");
      if (state.pcmReceived !== undefined) row("收到声音", state.pcmReceived === "unknown" ? "未知" : state.pcmReceived ? "是" : "否");
      if (state.lastControl) row(state.lastControl.action === "finish" ? "「说完了」" : "「取消」", state.lastControl.accepted ? "Voice 已收到" : "Voice 没接受（可能已经结束）");
      if (state.phase === "completed") {
        row("识别类型", state.kind === "processed" ? "润色后" : state.kind === "raw" ? "原文" : state.kind === "raw_fallback" ? "润色失败，退回原文" : state.kind ?? "未知");
        row("识别出的文字", state.text ? state.text : "（空：没听到内容）");
      }
      if (state.message) row("原因", state.message);
      if (developerMode && state.code) row("错误码", state.code);
      wrap.append(facts);
    }
    return wrap;
  }

  function runAllControl(): HTMLElement {
    const wrap = h(doc, "div", { className: "cp-runall" });
    const safeCount = safeProbes().length;
    wrap.append(button(runAll ? "测试中…" : `运行全部安全测试（${safeCount} 项）`, () => void runSafe(), { tier: "primary", disabled: runAll !== null || navigating() || cleaning(), icon: "play" }));
    if (runAll) {
      wrap.append(h(doc, "span", { className: "cp-progress", text: runAllText() }));
    } else {
      wrap.append(h(doc, "span", { className: "cp-hint", text: "不会跳转页面、不会弹通知、不会启动别的插件；只写本插件自己的测试数据，测完删掉。" }));
    }
    return wrap;
  }

  function runAllText(): string {
    if (!runAll) return "";
    const elapsed = elapsedText(runAll.startedAt);
    return `第 ${runAll.index} 个 / 共 ${runAll.total} 个：${runAll.current}${elapsed ? ` · ${elapsed}` : ""}`;
  }

  function outcomeSummary(probes: ProbeDefinition[]): HTMLElement | null {
    const counts = new Map<Verdict, number>();
    for (const probe of probes) {
      const result = results.get(probe.id);
      if (result) counts.set(verdictOf(result), (counts.get(verdictOf(result)) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    const row = h(doc, "div", { className: "cp-chips" });
    for (const verdict of VERDICT_ORDER) {
      const count = counts.get(verdict);
      if (count) row.append(badge(`${VERDICT_LABELS[verdict]} ${count}`, verdict));
    }
    return row;
  }

  /** 总览的验收卡：通过几项、没通过的是哪几项、下一步做什么。 */
  function acceptanceCard(): HTMLElement {
    const all = runnableProbes();
    const tested = all.filter((probe) => results.has(probe.id));
    const ok = tested.filter((probe) => passed(results.get(probe.id)!));
    const failing = tested.filter((probe) => !passed(results.get(probe.id)!));
    const untested = all.filter((probe) => !results.has(probe.id) && !running.has(probe.id));
    const done = ok.length === all.length;
    const card = h(doc, "section", { className: `cp-card cp-accept${done ? " cp-accept--done" : ""}`, attrs: { "data-acceptance": done ? "passed" : "pending" } });
    const headline = done
      ? `全部 ${all.length} 项通过`
      : `通过 ${ok.length} / ${all.length} 项`;
    card.append(h(doc, "div", { className: "cp-accept-head" }, icon(doc, done ? "check" : "clock"), h(doc, "h3", { text: headline })));
    card.append(h(doc, "p", { className: "cp-card-sub", text: "「通过」= 成功，或者反例按预期被拦下。没同意权限、等你操作、出错、与预期不同都算没通过。" }));
    const restored = all.filter((probe) => restoredIds.has(probe.id)).length;
    if (restored > 0) card.append(h(doc, "p", { className: "cp-hint", text: `其中 ${restored} 项是上次保存的结果（同一 Driver、同一插件版本），重新测会覆盖。` }));
    if (failing.length > 0) {
      const list = h(doc, "ul", { className: "cp-accept-list" });
      for (const probe of failing) {
        const result = results.get(probe.id)!;
        const verdict = verdictOf(result);
        const link = h(doc, "button", { className: "cp-btn cp-btn--link", text: probe.title, attrs: { type: "button" } });
        link.addEventListener("click", () => show(probe.section));
        list.append(h(doc, "li", {}, badge(VERDICT_LABELS[verdict], verdict), link, h(doc, "span", { text: result.summary })));
      }
      card.append(list);
    }
    if (untested.length > 0 && !runAll) card.append(h(doc, "p", { className: "cp-hint", text: `还没测：${untested.map((probe) => probe.title).join("、")}` }));
    const actions = h(doc, "div", { className: "cp-runall" });
    actions.append(button(runAll ? "测试中…" : `跑完全部 ${all.length} 项`, () => void runEverything(), { tier: "primary", disabled: runAll !== null || navigating() || cleaning(), icon: "play" }));
    if (runAll) actions.append(h(doc, "span", { className: "cp-progress", text: runAllText() }));
    else actions.append(h(doc, "span", { className: "cp-hint", text: `含 ${all.length - safeProbes().length} 项会弹通知、启动 Voice、最后跳到本插件权限页的测试。只想跑不打扰的，用下面的「运行全部安全测试」。` }));
    card.append(actions);
    return card;
  }

  function renderOverview(): HTMLElement[] {
    const counts = tierCounts(catalog);
    const tiles = h(doc, "div", { className: "cp-tiles" });
    const tile = (tier: Tier, note: string) => {
      const node = h(doc, "button", { className: `cp-tile cp-tile--${tier}`, attrs: { type: "button" } }, h(doc, "strong", { text: String(counts[tier]) }), h(doc, "span", { text: TIER_LABELS[tier] }), h(doc, "small", { text: note }));
      node.addEventListener("click", () => { capFilter = tier; show("capabilities"); });
      return node;
    };
    tiles.append(
      tile("granted", "本地开发包直接能用"),
      tile("permission", "本地包能用，要用户点同意"),
      tile("gated", "要平台批准，本地包装不上"),
      tile("withheld", "Driver 还没开放"),
    );
    const p0 = PROBES.filter((probe) => !probe.disabledReason);
    const explain = h(doc, "div", { className: "cp-card cp-explain" },
      h(doc, "h3", { text: "这个插件是做什么的" }),
      h(doc, "p", { text: "把 Driver 给插件开放的每一项能力讲成人话，能测的点一下就真实调用一次，结果当场显示。外脑云端用插件自己的 OAuth 身份真实调用；需要平台批准的能力本版只说明「会调什么、预期什么」，不发请求。" }),
      h(doc, "p", { className: "cp-card-sub", text: `能力清单来自插件开发包里的支持矩阵（Host API ${CONTRACT_HOST_API}），是打包那一刻的合同；能不能用，以下面按钮的真实结果为准。` }),
    );
    return [intro("能力探针", ""), acceptanceCard(), explain, tiles, runAllControl(), outcomeSummary(p0) ?? h(doc, "p", { className: "cp-hint", text: `本版有 ${p0.length} 个能实际运行的测试，还没有结果。其中 ${p0.length - safeProbes().length} 个会跳页面、弹通知或启动别的插件，不在「全部测试」里。` })];
  }

  function renderSection(section: ProbeSection): HTMLElement[] {
    const probes = PROBES.filter((probe) => probe.section === section);
    const descriptions: Record<ProbeSection, string> = {
      basic: "不需要任何人批准，插件声明了就能用。",
      permission: "插件能声明，但每一项都要用户同意：安装时的权限弹窗里勾选，或者事后到「已安装」点开能力探针，在「权限」里点允许。没同意时测试会显示「被拦下」，这本身就是正确结果。",
      page: "插件页面不允许运行「运行时生成的代码」。下面四项在 Driver 里都应该被拦下；再往下是替代做法：用一份 JSON 描述页面，由插件预置的渲染器画出来。",
      cloud: "这些是外脑对插件开放的接口，用插件自己的 OAuth 应用身份去调：Driver 替插件附令牌，插件拿不到令牌原文。写操作只发生在名为「test」的项目里，测试文件、测试行和测试工作流会留在那个项目里（插件没有删除权限）。「反例」是外脑没对插件开放的接口，被拒才算按预期。标着「会消耗额度」的两项（知识库、大模型）不在「运行全部安全测试」里。",
      gated: "这些能力需要平台审核批准。本地开发包只要在清单里声明了其中任何一项，安装时就会整包失败，所以本版只做说明。",
    };
    const nodes: HTMLElement[] = [intro(SECTION_LABELS[section], descriptions[section])];
    nodes.push(h(doc, "div", { className: "cp-section-summary" }, outcomeSummary(probes)));
    nodes.push(h(doc, "div", { className: "cp-cards" }, ...probes.map(probeCard)));
    if (section === "page") nodes.push(renderSpecPlayground());
    return nodes;
  }

  /** 声明式页面用的存储：清理进行中拒绝写入，免得清理刚删完又被写回测试数据。 */
  const blockWhileCleaning = () => { if (cleaning()) throw new PageActionError("正在清理测试数据，清理完再试"); };
  const pageKv: KvPort = {
    get: (key) => port.kv.get(key),
    keys: () => port.kv.keys(),
    set: async (key, value) => { blockWhileCleaning(); await port.kv.set(key, value); },
    compareAndSet: async (key, expected, value) => { blockWhileCleaning(); return port.kv.compareAndSet(key, expected, value); },
    delete: async (key) => { blockWhileCleaning(); await port.kv.delete(key); },
  };

  function renderSpecPlayground(): HTMLElement {
    const wrap = h(doc, "section", { className: "cp-card cp-spec" }, h(doc, "h3", { text: "声明式页面（替代做法）" }));
    wrap.append(h(doc, "p", { className: "cp-card-sub", text: "左边是一份页面描述 JSON，可以手改，也可以以后让 Agent 生成。点「渲染」：先严格检查，通过才画出来。按钮只能做白名单里的事：读写 page. 开头的本地数据、运行安全测试、发通知（要再点一次确认）。" }));
    const editor = h(doc, "textarea", { className: "cp-code", attrs: { spellcheck: "false", "aria-label": "页面描述 JSON", rows: "16" } });
    editor.value = specSource;
    editor.addEventListener("input", () => { specSource = editor.value; });
    const problems = h(doc, "div", { className: "cp-spec-problems", attrs: { role: "status" } });
    const canvas = h(doc, "div", { className: "cp-spec-canvas" });
    const runnable = new Set(safeProbes().map((probe) => probe.id));
    const renderSpec = () => {
      renderedSpec?.dispose();
      renderedSpec = null;
      problems.replaceChildren();
      const parsed = parsePageSpec(editor.value, runnable);
      if (!parsed.ok) {
        problems.append(h(doc, "strong", { text: `没有渲染：发现 ${parsed.problems.length} 处问题` }));
        problems.append(h(doc, "ul", {}, ...parsed.problems.map((problem) => h(doc, "li", {}, h(doc, "code", { text: problem.path }), ` ${problem.reason}`))));
        problems.dataset.tone = "error";
        canvas.replaceChildren(h(doc, "p", { className: "cp-hint", text: "检查不通过的页面不会被画出来。" }));
        return;
      }
      problems.dataset.tone = "ok";
      problems.append(h(doc, "span", { text: `检查通过：${parsed.spec.components.length} 个组件` }));
      renderedSpec = renderPage(canvas, parsed.spec, {
        kv: pageKv,
        developerMode: () => developerMode,
        runProbe: async (probeId) => {
          if (runAll || running.has(probeId)) throw new PageActionError("这个测试正在运行，请等它结束再点");
          return execute(PROBES.find((probe) => probe.id === probeId)!);
        },
        lastResult: (probeId) => results.get(probeId),
        notify: async (title, body) => { await port.notify(title, body); },
      });
    };
    const samples = h(doc, "div", { className: "cp-chips" }, h(doc, "span", { className: "cp-hint", text: "换一份试试：" }));
    const load = (spec: unknown) => { editor.value = JSON.stringify(spec, null, 2); specSource = editor.value; renderSpec(); };
    samples.append(button("正例：访客登记", () => load(DEMO_SPEC), { tier: "link" }));
    for (const bad of BAD_SPECS) samples.append(button(`反例：${bad.label}`, () => load(bad.spec), { tier: "link" }));
    wrap.append(samples, h(doc, "div", { className: "cp-spec-grid" }, h(doc, "div", {}, editor, h(doc, "div", { className: "cp-card-actions" }, button("渲染", renderSpec, { icon: "play" })), problems), canvas));
    renderSpec();
    return wrap;
  }

  function renderCapabilities(): HTMLElement[] {
    const filters: (Tier | "all")[] = ["all", "granted", "permission", "gated", "withheld"];
    const chips = h(doc, "div", { className: "cp-chips", attrs: { role: "group", "aria-label": "按档位筛选" } });
    for (const filter of filters) {
      const label = filter === "all" ? `全部 ${catalog.length}` : `${TIER_LABELS[filter]} ${catalog.filter((entry) => entry.tier === filter).length}`;
      const chip = h(doc, "button", { className: "cp-chip", text: label, attrs: { type: "button", "aria-pressed": String(capFilter === filter) } });
      chip.addEventListener("click", () => { capFilter = filter; render(); });
      chips.append(chip);
    }
    const rows = catalog.filter((entry) => capFilter === "all" || entry.tier === capFilter);
    const list = h(doc, "div", { className: "cp-cap-list" });
    for (const entry of rows) list.append(capabilityRow(entry));
    return [intro("全部能力", "支持矩阵里的每一项能力。第一行是人话，第二行是技术标识。"), chips, list];
  }

  function capabilityRow(entry: CapabilityEntry): HTMLElement {
    const usable = usableByLocalPackage(entry.tier);
    const row = h(doc, "article", { className: "cp-cap", attrs: { "data-capability": entry.id } });
    const head = h(doc, "div", { className: "cp-cap-head" }, h(doc, "strong", { text: entry.title }), badge(TIER_LABELS[entry.tier], entry.tier));
    if (entry.declaredHere) head.append(badge("本插件已声明", "ok"));
    row.append(head, h(doc, "span", { className: "cp-card-sub", text: `${entry.id} · ${GROUP_LABELS[entry.group]}` }), h(doc, "p", { text: entry.summary }));
    const notes: string[] = [];
    notes.push(usable ? "本地开发包可以用" : entry.tier === "gated" ? "本地开发包不能声明" : "Driver 暂未开放");
    if (entry.tier === "gated") notes.push(entry.approvedApps.length > 0 ? `已批准给 ${entry.approvedApps.length} 个插件：${entry.approvedApps.join("、")}` : "目前没有任何插件获批");
    if (entry.withheldReason) notes.push(`原因：${entry.withheldReason}`);
    if (entry.needsUserConsent && entry.tier !== "withheld") notes.push("还要用户同意");
    row.append(h(doc, "p", { className: "cp-cap-note", text: notes.join("；") }));
    if (developerMode && entry.methods.length > 0) row.append(h(doc, "p", { className: "cp-card-sub cp-mono", text: `接口：${entry.methods.join("、")}` }));
    return row;
  }

  function renderOfficial(): HTMLElement[] {
    const rows = officialPluginRows();
    const list = h(doc, "div", { className: "cp-cards" });
    for (const plugin of rows) {
      const card = h(doc, "article", { className: "cp-card" }, h(doc, "div", { className: "cp-card-title" }, h(doc, "h3", { text: plugin.name }), badge(plugin.version, "neutral")), h(doc, "p", { className: "cp-card-sub", text: plugin.appId }));
      const chips = h(doc, "div", { className: "cp-chips" });
      for (const capability of plugin.capabilities) {
        const tone = capability.tier === "gated" ? (capability.approved ? "gated" : "unexpected") : capability.tier ?? "muted";
        const chip = badge(capability.id, tone);
        chip.title = capability.tier === "gated" ? (capability.approved ? "需要平台批准：审核清单里有批准记录（任一版本）" : "需要平台批准：审核清单里没有批准记录") : capability.tier ? TIER_LABELS[capability.tier] : "支持矩阵里没有这一项";
        chips.append(chip);
      }
      card.append(chips);
      list.append(card);
    }
    return [
      intro("插件仓对照", `插件仓里 ${rows.length} 个插件（官方插件和 com.example 开头的示例）各声明了哪些能力。插件在运行时读不到别的插件的信息，所以这是 ${OFFICIAL_PLUGINS_SNAPSHOT.generatedOn} 打包时的静态快照。橙色是需要平台批准且审核清单里有批准记录的能力；红色表示需要平台批准，但审核清单里没有批准记录。`),
      list,
    ];
  }

  function renderRecords(): HTMLElement[] {
    const nodes: HTMLElement[] = [intro("记录与报告", "测试记录和最近一次结果保存在本插件自己的存储里，跳走再回来、重新打开插件都还在；点「清空测试结果」删掉。")];
    if (log.length === 0) {
      nodes.push(h(doc, "div", { className: "cp-card cp-empty" }, h(doc, "p", { text: "还没有测试记录。" }), button("运行全部安全测试", () => void runSafe(), { tier: "primary", icon: "play", disabled: runAll !== null || navigating() || cleaning() })));
    } else {
      const table = h(doc, "div", { className: "cp-log" });
      for (const entry of log) {
        const probe = PROBES.find((item) => item.id === entry.probeId);
        table.append(h(doc, "div", { className: "cp-log-row" },
          h(doc, "span", { className: "cp-log-time", text: clock(entry.startedAt) }),
          badge(VERDICT_LABELS[verdictOf(entry)], verdictOf(entry)),
          h(doc, "span", { className: "cp-log-title", text: probe?.title ?? entry.probeId }),
          h(doc, "span", { className: "cp-log-summary", text: developerMode && entry.code ? `${entry.summary}（${entry.code}）` : entry.summary }),
        ));
      }
      nodes.push(table);
    }
    const report = buildReport({ mode: port.mode, hostVersion: hostVersionText(), developerMode, results, restored: restoredIds });
    const area = h(doc, "textarea", { className: "cp-code", attrs: { readonly: "", rows: "12", "aria-label": "测试报告 JSON" } });
    area.value = report;
    const select = button("全选报告文字", () => { area.focus(); area.select(); }, { tier: "secondary" });
    const clear = button("清空测试结果", () => { void clearResults(); render(); }, { tier: "secondary", disabled: runAll !== null || running.size > 0 });
    nodes.push(h(doc, "div", { className: "cp-card" },
      h(doc, "h3", { text: "导出报告" }),
      h(doc, "p", { className: "cp-card-sub", text: developerMode
        ? "报告含版本、档位、结果、错误码和诊断信息。会去掉已知格式的令牌，但诊断里可能有路径或个人信息，分享前请检查。全选后复制即可。"
        : "报告含版本、档位和结果，不含令牌和用户数据。打开 Driver 开发者模式后，报告里会多出错误码。全选后复制即可。" }),
      area,
      h(doc, "div", { className: "cp-card-actions" }, select, clear),
      clearError ? h(doc, "p", { className: "cp-hint", text: "存储里的旧结果没删掉，重新打开插件后可能还会出现，请再点一次「清空测试结果」。" }) : null,
    ));
    nodes.push(cleanupCard());
    return nodes;
  }

  /** 清空界面和存储里的测试结果；存储没清掉时返回 false（界面已清空，提示用户再点一次）。 */
  function clearResults(): Promise<boolean> {
    const at = Date.now();
    clearedAt = at;
    clearError = false;
    results.clear();
    log.length = 0;
    restoredIds.clear();
    transientIds.clear();
    jumpBlockedHint = "";
    return clearSavedResults(port.kv, new Date(at).toISOString())
      .then(() => true, () => { clearError = true; return false; })
      .finally(() => { if (!disposed) render(); });
  }


  async function runCleanup(): Promise<void> {
    if (cleaning() || runAll !== null || running.size > 0 || manual.busy) return;
    cleanup = { phase: "busy", items: [] };
    render();
    const items: CleanupItem[] = [];
    const resultsCleared = await clearResults();
    const local = await cleanLocal(port.kv);
    items.push(resultsCleared ? local : { ...local, status: "failed", summary: `${local.summary}；但测试结果没清掉，请再点一次` });
    // 本地清完先显示出来，外脑那几项接着跑。
    cleanup = { phase: "busy", items: [...items] };
    if (!disposed) render();
    items.push(...(await cleanCloud(port, abort.signal)));
    if (disposed) return;
    manual = { busy: false, message: "", tone: "neutral" };
    cleanup = { phase: "done", items };
    render();
  }

  function cleanupCard(): HTMLElement {
    const card = h(doc, "section", { className: "cp-card cp-cleanup", attrs: { "aria-label": "清理测试数据" } });
    card.append(h(doc, "h3", { text: "清理测试数据" }));
    card.append(h(doc, "p", { className: "cp-card-sub", text: `测试完一键删掉探针留下的数据。只认探针自己的标记，别的数据不碰；外脑只看「${TEST_PROJECT_NAME}」项目。` }));
    const blocked = runAll !== null || running.size > 0 || navigating();
    if (cleanup.phase === "confirm") {
      card.append(h(doc, "ul", { className: "cp-cleanup-plan" },
        h(doc, "li", { text: "会删：本插件存储里的测试数据和测试结果" }),
        h(doc, "li", { text: `会删：外脑「${TEST_PROJECT_NAME}」项目里以「${PROBE_KB_MARKER}」开头的知识库内容` }),
        h(doc, "li", { text: `会删：外脑「${TEST_PROJECT_NAME}」项目数据表里名字以「${PROBE_ROW_NAME}」开头的行（移到回收站）` }),
        h(doc, "li", { text: "删不了：测试文件和测试工作流（外脑没对插件开放），清理后会告诉你有几个、去哪删" }),
      ));
      card.append(h(doc, "div", { className: "cp-card-actions" },
        button("确认清理", () => void runCleanup(), { tier: "primary", disabled: blocked }),
        button("取消", () => { cleanup = { phase: "idle", items: [] }; render(); }, { tier: "secondary" }),
      ));
    } else {
      card.append(h(doc, "div", { className: "cp-card-actions" },
        button(cleanup.phase === "busy" ? "清理中…" : "清理测试数据", () => { cleanup = { phase: "confirm", items: [] }; render(); }, { tier: "secondary", icon: "trash", disabled: blocked || cleanup.phase === "busy" }),
      ));
      if (blocked && cleanup.phase !== "busy") card.append(h(doc, "p", { className: "cp-hint", text: "测试还在进行，跑完再清理。" }));
    }
    if (cleanup.items.length > 0) {
      const list = h(doc, "div", { className: "cp-log", attrs: { role: "status" } });
      for (const item of cleanup.items) {
        list.append(h(doc, "div", { className: "cp-log-row", attrs: { "data-cleanup": item.id, "data-status": item.status } },
          badge(CLEANUP_LABELS[item.status], CLEANUP_TONES[item.status]),
          h(doc, "span", { className: "cp-log-title", text: item.title }),
          h(doc, "span", { className: "cp-log-summary", text: developerMode && item.detail ? `${item.summary}（${scrub(item.detail, 200)}）` : item.summary }),
        ));
      }
      card.append(list);
    }
    return card;
  }

  function renderSettings(): HTMLElement[] {
    const rows = h(doc, "div", { className: "cp-card cp-settings" },
      settingRow("构建档位", "P0：本地开发包。只声明免审能力和三项需同意的权限。"),
      settingRow("诊断信息", developerMode ? "Driver 开发者模式已开：结果里显示错误码和原始原因。" : "Driver 开发者模式已关：只显示人话结果。"),
      settingRow("Driver 版本", hostVersionText()),
      settingRow("能力合同", `Host API ${CONTRACT_HOST_API}（打包时的支持矩阵）`),
    );
    const footer = h(doc, "footer", { className: "cp-settings-footer" },
      button(`版本 ${PLUGIN_VERSION}`, () => show("changelog"), { tier: "link", aria: `查看版本 ${PLUGIN_VERSION} 的更新日志` }),
      button("关于插件", () => show("about"), { tier: "link", aria: "关于 能力探针" }),
    );
    return [intro("设置", ""), rows, footer];
  }

  function settingRow(title: string, description: string): HTMLElement {
    return h(doc, "div", { className: "cp-setting" }, h(doc, "span", { className: "cp-setting-title", text: title }), h(doc, "span", { className: "cp-setting-desc", text: description }));
  }

  function renderChangelog(): HTMLElement[] {
    return [intro(`版本 ${PLUGIN_VERSION} 更新日志`, "本地开发示例，未送审、未上架。"), h(doc, "div", { className: "cp-card" }, h(doc, "pre", { className: "cp-changelog", text: CHANGELOG_TEXT }))];
  }

  function renderAbout(): HTMLElement[] {
    const url = `https://open.reai.com/apps/${encodeURIComponent(PLUGIN_APP_ID)}`;
    return [
      intro("关于插件", ""),
      h(doc, "div", { className: "cp-card cp-settings" },
        settingRow("插件", "能力探针"),
        settingRow("版本", `${PLUGIN_VERSION} · 本地开发示例`),
        settingRow("应用标识", PLUGIN_APP_ID),
        settingRow("公开详情页地址", `${url}（本插件是开发示例，不会公开发布，这个地址目前没有页面）`),
      ),
    ];
  }

  function renderNav(): void {
    nav.replaceChildren();
    for (const item of NAV) {
      const active = rootPage === item.id && !SUB_PAGES[page];
      const node = h(doc, "button", { className: "cp-nav-item", attrs: { type: "button", ...(active ? { "aria-current": "page" } : {}) } }, icon(doc, item.icon), h(doc, "span", { text: item.label }));
      node.addEventListener("click", () => show(item.id));
      nav.append(node);
    }
  }

  function render(): void {
    if (disposed) return;
    const keepSpec = page === "page" && content.querySelector(".cp-spec") !== null;
    renderNav();
    if (keepSpec) {
      // 声明式页面区域有用户正在编辑的内容：只重画结果统计和探针卡片，不重建编辑器和渲染结果。
      const probes = PROBES.filter((probe) => probe.section === "page");
      content.querySelector(".cp-section-summary")?.replaceChildren(...[outcomeSummary(probes)].filter((node): node is HTMLElement => node !== null));
      content.querySelector(".cp-cards")?.replaceWith(h(doc, "div", { className: "cp-cards" }, ...probes.map(probeCard)));
      void renderedSpec?.refresh();
      return;
    }
    renderedSpec?.dispose();
    renderedSpec = null;
    let nodes: HTMLElement[];
    switch (page) {
      case "overview": nodes = renderOverview(); break;
      case "capabilities": nodes = renderCapabilities(); break;
      case "official": nodes = renderOfficial(); break;
      case "records": nodes = renderRecords(); break;
      case "settings": nodes = renderSettings(); break;
      case "changelog": nodes = renderChangelog(); break;
      case "about": nodes = renderAbout(); break;
      default: nodes = renderSection(page);
    }
    content.replaceChildren(...nodes);
  }

  reportNav();
  render();

  return {
    show,
    openSettings() {
      show("settings");
    },
    backToRoot() {
      show(rootPage);
    },
    runSafe,
    runEverything,
    handleIntent(intent) {
      const result = systemTaskReturnResult(intent);
      if (!result) return false;
      recordResult(result);
      live.textContent = `「跳到 Driver 设置页」测试完成：${VERDICT_LABELS[verdictOf(result)]}`;
      render();
      return true;
    },
    get currentPage() { return page; },
    dispose() {
      dictation.dispose();
      disposed = true;
      abort.abort();
      offEnv();
      for (const timer of timers) clearInterval(timer);
      renderedSpec?.dispose();
      root.replaceChildren();
    },
  };
}
