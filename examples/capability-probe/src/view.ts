/**
 * 能力探针主界面。只依赖 ProbePort，Driver 和浏览器预览共用同一份界面代码。
 */
import { buildCatalog, CONTRACT_HOST_API, officialPluginRows, PLUGIN_APP_ID, PLUGIN_VERSION, TIER_LABELS, tierCounts, usableByLocalPackage, type CapabilityEntry, type Tier } from "./catalog";
import { GROUP_LABELS } from "./capability-text";
import { h, icon, type IconName } from "./dom";
import { OFFICIAL_PLUGINS_SNAPSHOT } from "./generated/official-plugins";
import { BAD_SPECS, DEMO_SPEC, parsePageSpec } from "./page-spec";
import { renderPage, type RenderedPage } from "./page-renderer";
import type { ProbePort } from "./port";
import { OUTCOME_LABELS, PROBES, runProbe, safeProbes, SECTION_LABELS, type Outcome, type ProbeDefinition, type ProbeResult, type ProbeSection } from "./probes";
import { CHANGELOG_TEXT } from "./release-notes";
import { buildReport } from "./report";

export type PageId = "overview" | ProbeSection | "capabilities" | "official" | "records" | "settings" | "changelog" | "about";

export interface ProbeViewOptions {
  port: ProbePort;
  /** Driver 版本；读取失败时传带错误码的说明。 */
  hostVersion: Promise<string>;
  reportNav?(nav: { key: string; label: string } | null): void;
}

export interface ProbeView {
  show(page: PageId): void;
  toggleSettings(): void;
  runSafe(): Promise<void>;
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
  { id: "official", label: "官方插件对照", icon: "file" },
  { id: "records", label: "记录与报告", icon: "clock" },
];

const SUB_PAGES: Partial<Record<PageId, string>> = { settings: "设置", changelog: "更新日志", about: "关于插件" };

function clock(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const OUTCOME_ICON: Record<Outcome, IconName> = { ok: "check", blocked: "shield", unexpected: "alert", failed: "x", waiting: "clock" };

export function mountProbeView(root: HTMLElement, options: ProbeViewOptions): ProbeView {
  const doc = root.ownerDocument;
  const { port } = options;
  const catalog = buildCatalog();
  const results = new Map<string, ProbeResult>();
  const running = new Set<string>();
  const log: ProbeResult[] = [];
  let page: PageId = "overview";
  let rootPage: PageId = "overview";
  let developerMode = false;
  let hostVersion = "读取中…";
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
  const content = h(doc, "section", { className: "cp-content", attrs: { "aria-live": "polite" } });
  body.append(nav, content);
  frame.append(body);
  root.replaceChildren(frame);

  const offEnv = port.onEnvironmentChange((value) => {
    developerMode = value.developerMode;
    render();
  });
  void port.environment().then((value) => { developerMode = value.developerMode; render(); }).catch(() => undefined);
  void options.hostVersion.then((value) => { hostVersion = value; render(); });

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

  async function execute(probe: ProbeDefinition): Promise<ProbeResult> {
    running.add(probe.id);
    render();
    const result = await runProbe(probe, { port, document: doc, signal: abort.signal });
    running.delete(probe.id);
    if (disposed) return result;
    results.set(probe.id, result);
    log.unshift(result);
    if (log.length > 200) log.length = 200;
    render();
    return result;
  }

  async function runSafe(): Promise<void> {
    if (runAll) return;
    const list = safeProbes();
    runAll = { index: 0, total: list.length, startedAt: Date.now(), current: list[0]?.title ?? "" };
    const ticker = setInterval(() => render(), 1000);
    timers.add(ticker);
    try {
      for (const [index, probe] of list.entries()) {
        if (disposed) return;
        runAll = { ...runAll, index: index + 1, current: probe.title };
        await execute(probe);
      }
    } finally {
      clearInterval(ticker);
      timers.delete(ticker);
      runAll = null;
      if (!disposed) render();
    }
  }

  function resultBlock(probe: ProbeDefinition): HTMLElement | null {
    const result = results.get(probe.id);
    if (!result) return null;
    const block = h(doc, "div", { className: `cp-result cp-result--${result.outcome}`, attrs: { role: "status" } });
    const head = h(doc, "div", { className: "cp-result-head" }, icon(doc, OUTCOME_ICON[result.outcome]), h(doc, "strong", { text: OUTCOME_LABELS[result.outcome] }), h(doc, "span", { text: result.summary }));
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
    const busy = running.has(probe.id);
    const result = results.get(probe.id);
    const label = busy ? "测试中…" : result ? "再测一次" : "测试";
    const actions = h(doc, "div", { className: "cp-card-actions" }, button(label, () => void execute(probe), { disabled: busy || runAll !== null, icon: "play", aria: `${label}：${probe.title}` }));
    if (probe.risk === "navigate") actions.append(h(doc, "span", { className: "cp-hint", text: "会离开当前页面" }));
    if (probe.risk === "notify") actions.append(h(doc, "span", { className: "cp-hint", text: "会弹出一条系统通知" }));
    card.append(actions);
    const block = resultBlock(probe);
    if (block) card.append(block);
    return card;
  }

  function runAllControl(): HTMLElement {
    const wrap = h(doc, "div", { className: "cp-runall" });
    const safeCount = safeProbes().length;
    wrap.append(button(runAll ? "测试中…" : `运行全部安全测试（${safeCount} 项）`, () => void runSafe(), { tier: "primary", disabled: runAll !== null, icon: "play" }));
    if (runAll) {
      const seconds = Math.floor((Date.now() - runAll.startedAt) / 1000);
      wrap.append(h(doc, "span", { className: "cp-progress", text: `第 ${runAll.index} 个 / 共 ${runAll.total} 个：${runAll.current} · 已用 ${seconds} 秒` }));
    } else {
      wrap.append(h(doc, "span", { className: "cp-hint", text: "不会跳转页面，也不会弹通知；只写本插件自己的测试数据，测完删掉。" }));
    }
    return wrap;
  }

  function outcomeSummary(probes: ProbeDefinition[]): HTMLElement | null {
    const counts = new Map<Outcome, number>();
    for (const probe of probes) {
      const result = results.get(probe.id);
      if (result) counts.set(result.outcome, (counts.get(result.outcome) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    const row = h(doc, "div", { className: "cp-chips" });
    for (const outcome of ["ok", "blocked", "unexpected", "failed", "waiting"] as Outcome[]) {
      const count = counts.get(outcome);
      if (count) row.append(badge(`${OUTCOME_LABELS[outcome]} ${count}`, outcome));
    }
    return row;
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
      h(doc, "p", { text: "把 Driver 给插件开放的每一项能力讲成人话，能测的点一下就真实调用一次，结果当场显示。外脑云端和需要平台批准的能力，本版只说明「会调什么、预期什么」，不发请求。" }),
      h(doc, "p", { className: "cp-card-sub", text: `能力清单来自插件开发包里的支持矩阵（Host API ${CONTRACT_HOST_API}），是打包那一刻的合同；能不能用，以下面按钮的真实结果为准。` }),
    );
    return [intro("能力探针", ""), explain, tiles, runAllControl(), outcomeSummary(p0) ?? h(doc, "p", { className: "cp-hint", text: `本版有 ${p0.length} 个能实际运行的测试，还没有结果。其中 ${p0.length - safeProbes().length} 个会跳页面或弹通知，不在「全部测试」里，要到对应页面单独点。` })];
  }

  function renderSection(section: ProbeSection): HTMLElement[] {
    const probes = PROBES.filter((probe) => probe.section === section);
    const descriptions: Record<ProbeSection, string> = {
      basic: "不需要任何人批准，插件声明了就能用。",
      permission: "插件能声明，但每一项都要用户在「App Store → 已安装 → 能力探针 → 权限」里点允许。没同意时测试会显示「被拦下」，这本身就是正确结果。",
      page: "插件页面不允许运行「运行时生成的代码」。下面四项在 Driver 里都应该被拦下；再往下是替代做法：用一份 JSON 描述页面，由插件预置的渲染器画出来。",
      cloud: "这些是外脑对插件开放的接口。要用插件自己的 OAuth 应用身份去调，本版还没连上，所以按钮是关的。「反例」是外脑没开放的接口，连上后预期会被拒。",
      gated: "这些能力需要平台审核批准。本地开发包只要在清单里声明了其中任何一项，安装时就会整包失败，所以本版只做说明。",
    };
    const nodes: HTMLElement[] = [intro(SECTION_LABELS[section], descriptions[section])];
    const summary = outcomeSummary(probes);
    if (summary) nodes.push(summary);
    nodes.push(h(doc, "div", { className: "cp-cards" }, ...probes.map(probeCard)));
    if (section === "page") nodes.push(renderSpecPlayground());
    return nodes;
  }

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
        kv: port.kv,
        runProbe: async (probeId) => execute(PROBES.find((probe) => probe.id === probeId)!),
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
        chip.title = capability.tier === "gated" ? (capability.approved ? "需要平台批准：审核清单里已批准" : "需要平台批准：审核清单里没有批准记录") : capability.tier ? TIER_LABELS[capability.tier] : "支持矩阵里没有这一项";
        chips.append(chip);
      }
      card.append(chips);
      list.append(card);
    }
    return [
      intro("官方插件对照", `插件仓里 ${rows.length} 个插件各声明了哪些能力。插件在运行时读不到别的插件的信息，所以这是 ${OFFICIAL_PLUGINS_SNAPSHOT.generatedOn} 打包时的静态快照。红色表示「需要平台批准，但审核清单里没有批准记录」。`),
      list,
    ];
  }

  function renderRecords(): HTMLElement[] {
    const nodes: HTMLElement[] = [intro("记录与报告", "本次打开以来的测试记录。关掉插件后会清空，需要留存请导出报告。")];
    if (log.length === 0) {
      nodes.push(h(doc, "div", { className: "cp-card cp-empty" }, h(doc, "p", { text: "还没有测试记录。" }), button("运行全部安全测试", () => void runSafe(), { tier: "primary", icon: "play", disabled: runAll !== null })));
    } else {
      const table = h(doc, "div", { className: "cp-log" });
      for (const entry of log) {
        const probe = PROBES.find((item) => item.id === entry.probeId);
        table.append(h(doc, "div", { className: "cp-log-row" },
          h(doc, "span", { className: "cp-log-time", text: clock(entry.startedAt) }),
          badge(OUTCOME_LABELS[entry.outcome], entry.outcome),
          h(doc, "span", { className: "cp-log-title", text: probe?.title ?? entry.probeId }),
          h(doc, "span", { className: "cp-log-summary", text: developerMode && entry.code ? `${entry.summary}（${entry.code}）` : entry.summary }),
        ));
      }
      nodes.push(table);
    }
    const report = buildReport({ mode: port.mode, hostVersion, developerMode, results });
    const area = h(doc, "textarea", { className: "cp-code", attrs: { readonly: "", rows: "12", "aria-label": "测试报告 JSON" } });
    area.value = report;
    const download = button("下载报告", () => {
      const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
      const link = h(doc, "a", { attrs: { href: url, download: `capability-probe-${Date.now()}.json` } });
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, { icon: "file" });
    const select = button("全选报告文字", () => { area.focus(); area.select(); }, { tier: "link" });
    nodes.push(h(doc, "div", { className: "cp-card" },
      h(doc, "h3", { text: "导出报告" }),
      h(doc, "p", { className: "cp-card-sub", text: "报告只含版本、档位和结果，不含令牌和用户数据。如果「下载报告」在 Driver 里没反应，全选下面的文字复制即可。" }),
      area,
      h(doc, "div", { className: "cp-card-actions" }, download, select),
    ));
    return nodes;
  }

  function renderSettings(): HTMLElement[] {
    const rows = h(doc, "div", { className: "cp-card cp-settings" },
      settingRow("构建档位", "P0：本地开发包。只声明免审能力和三项需同意的权限。"),
      settingRow("诊断信息", developerMode ? "Driver 开发者模式已开：结果里显示错误码和原始原因。" : "Driver 开发者模式已关：只显示人话结果。"),
      settingRow("Driver 版本", hostVersion),
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
    const keepSpec = page === "page" && renderedSpec !== null && content.querySelector(".cp-spec") !== null;
    renderNav();
    if (keepSpec) {
      // 声明式页面区域有用户正在编辑的内容：只重画探针卡片，不重建编辑器和渲染结果。
      const cards = content.querySelector(".cp-cards");
      const fresh = h(doc, "div", { className: "cp-cards" }, ...PROBES.filter((probe) => probe.section === "page").map(probeCard));
      cards?.replaceWith(fresh);
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
    toggleSettings() {
      show(SUB_PAGES[page] ? rootPage : "settings");
    },
    runSafe,
    get currentPage() { return page; },
    dispose() {
      disposed = true;
      abort.abort();
      offEnv();
      for (const timer of timers) clearInterval(timer);
      renderedSpec?.dispose();
      root.replaceChildren();
    },
  };
}
