/**
 * 电脑操控主页视图：紧急停止 + 权限引导 + 任务控制台 + 模型设置 + 审计流 + 版本 / 关于。
 *
 * 纯 DOM；样式在 computer.css，只用 Host 主题 Token。
 * 语言：所有插件文案经 t() 渲染；视图缓存权限、引擎、步骤、结果、通知与信息卡的结构化数据，
 * applyLocale() 原位改写文字与无障碍属性，不重建节点，输入框内容、焦点、滚动与进行中的任务都保留。
 * 诊断：第三方原文（宿主原始错误、模型回复）只在 Host 开发者模式开启时脱敏后展示。
 */
import { render, t, type UiMessage } from "./computer-i18n";
import type { ComputerState, PermissionsStatus, StepLike } from "./types";

export interface ComputerHomeHandlers {
  onStop: () => Promise<void>;
  onResume: () => Promise<void>;
  onRequestAccessibility: () => Promise<void>;
  onOpenScreenSettings: () => Promise<void>;
  onRefreshPermissions: () => Promise<void>;
  onStartTask: (task: string) => void;
  onAbortTask: () => void;
  /** 保存模型档位；失败时 reject，视图恢复为之前已生效的值。 */
  onSaveVlm: (modelAlias: string) => Promise<void>;
  onRefreshTrace: () => Promise<void>;
}

/** 设置区底部「版本 / 关于插件」所需的本机安装包信息（来自 app.manifest.json）。 */
export interface ComputerHomeInfo {
  appId: string;
  version: string;
  changelogText: string;
}

/** 视图通知：level 决定样式；message 可翻译，raw 为原始错误详情（开发者模式才显示）。 */
export interface HomeNotice {
  level: "info" | "error";
  message: UiMessage;
}

export interface ComputerHome {
  root: HTMLElement;
  setPermissions(status: PermissionsStatus | null, error?: string): void;
  setEngineState(state: ComputerState | null, error?: string): void;
  setTaskRunning(running: boolean): void;
  setTaskProgress(step: number): void;
  appendStep(step: StepLike): void;
  setTaskResult(message: UiMessage, ok: boolean): void;
  clearSteps(): void;
  /** 已保存的模型档位读取完成：写入当前值并开放下拉与「开始任务」（读取前两者都禁用，避免竞态与用错档位）。 */
  setVlmReady(modelAlias: string): void;
  setNotice(notice: HomeNotice | null): void;
  setDeveloperMode(enabled: boolean): void;
  applyLocale(): void;
  dispose(): void;
}

const MODEL_OPTIONS = [
  { value: "text-quality", key: "model.quality" },
  { value: "text-default", key: "model.default" },
] as const;

type Binder = () => void;

export function mountComputerHome(
  parent: HTMLElement,
  handlers: ComputerHomeHandlers,
  info: ComputerHomeInfo,
): ComputerHome {
  const binders: Binder[] = [];
  /** 登记一个随语言更新的文字或属性；立即渲染一次。 */
  const bind = (update: Binder) => {
    binders.push(update);
    update();
  };
  const text = (el: HTMLElement, key: string, params?: () => Record<string, string | number>) =>
    bind(() => {
      el.textContent = t(key, params?.());
    });
  const attr = (el: HTMLElement, name: string, key: string, params?: () => Record<string, string | number>) =>
    bind(() => el.setAttribute(name, t(key, params?.())));

  let developerMode = false;
  const name = () => t("metadata.name");

  const frame = document.createElement("div");
  frame.className = "plugin-main-frame";
  const root = document.createElement("div");
  root.className = "main-body cu-home";
  frame.appendChild(root);
  parent.appendChild(frame);

  // ── 紧急停止条 ──
  const stopBar = document.createElement("div");
  stopBar.className = "cu-stopbar";
  const stopBtn = button("cu-danger-btn");
  const stopHint = document.createElement("span");
  stopHint.className = "cu-stop-hint";
  text(stopHint, "stop.hint");
  stopBar.append(stopBtn, stopHint);
  root.appendChild(stopBar);

  const stoppedBanner = document.createElement("div");
  stoppedBanner.className = "cu-stopped-banner";
  stoppedBanner.hidden = true;
  const stoppedText = document.createElement("span");
  text(stoppedText, "stop.banner");
  const resumeBtn = button("cu-secondary-btn");
  stoppedBanner.append(stoppedText, resumeBtn);
  root.appendChild(stoppedBanner);

  // ── 权限卡 ──
  const permCard = section("permissions.title");
  const permAccessibility = permRow("permissions.accessibility", "permissions.accessibilityAction");
  const permScreen = permRow("permissions.screen", "permissions.screenAction");
  const permRefresh = button("cu-link-btn");
  const permError = document.createElement("p");
  permError.className = "cu-sub cu-query-error";
  permError.hidden = true;
  permCard.append(permAccessibility.row, permScreen.row, permError, permRefresh);
  root.appendChild(permCard);

  // ── 任务控制台 ──
  const consoleCard = section("console.title");
  const consoleSub = paragraph("console.intro");
  const taskInput = document.createElement("textarea");
  taskInput.className = "cu-task-input";
  taskInput.rows = 3;
  attr(taskInput, "placeholder", "console.placeholder");
  attr(taskInput, "aria-label", "console.inputLabel");
  const runRow = document.createElement("div");
  runRow.className = "cu-runrow";
  const startBtn = button("cu-primary-btn");
  text(startBtn, "console.start");
  startBtn.disabled = true; // 模型档位读回前不允许启动任务
  const abortBtn = button("cu-secondary-btn");
  text(abortBtn, "console.abort");
  abortBtn.disabled = true;
  runRow.append(startBtn, abortBtn);
  const egressHint = paragraph("console.egress");
  const progress = document.createElement("p");
  progress.className = "cu-progress";
  progress.setAttribute("role", "status");
  progress.hidden = true;
  const taskResult = document.createElement("div");
  taskResult.className = "cu-task-result";
  taskResult.hidden = true;
  const stepsList = document.createElement("ol");
  stepsList.className = "cu-steps";
  attr(stepsList, "aria-label", "console.stepsLabel");
  consoleCard.append(consoleSub, taskInput, runRow, egressHint, progress, taskResult, stepsList);
  root.appendChild(consoleCard);

  // ── 模型设置 ──
  const settingsCard = section("model.title");
  const settingsSub = paragraph("model.intro");
  const aliasRow = document.createElement("label");
  aliasRow.className = "cu-field";
  const aliasName = document.createElement("span");
  text(aliasName, "model.label");
  const selectWrap = document.createElement("span");
  selectWrap.className = "cu-select";
  const aliasSelect = document.createElement("select");
  for (const option of MODEL_OPTIONS) {
    const el = document.createElement("option");
    el.value = option.value;
    text(el, option.key);
    aliasSelect.appendChild(el);
  }
  aliasSelect.disabled = true; // 等已保存的档位读回后才开放
  selectWrap.appendChild(aliasSelect);
  const aliasStatus = document.createElement("span");
  aliasStatus.className = "cu-field-status";
  aliasStatus.setAttribute("role", "status");
  aliasRow.append(aliasName, selectWrap, aliasStatus);
  settingsCard.append(settingsSub, aliasRow);
  root.appendChild(settingsCard);

  // ── 审计流 ──
  const traceCard = document.createElement("section");
  traceCard.className = "cu-card";
  const traceHead = document.createElement("div");
  traceHead.className = "cu-card-head";
  const traceTitle = document.createElement("h2");
  text(traceTitle, "trace.title");
  const traceRefresh = button("cu-link-btn");
  traceHead.append(traceTitle, traceRefresh);
  const traceList = document.createElement("ul");
  traceList.className = "cu-trace";
  traceCard.append(traceHead, traceList);
  root.appendChild(traceCard);

  // ── 通知（含开发者模式诊断）──
  const notice = document.createElement("div");
  notice.className = "cu-notice";
  notice.setAttribute("role", "status");
  notice.hidden = true;
  const noticeText = document.createElement("p");
  noticeText.className = "cu-notice-text";
  const noticeDetail = document.createElement("pre");
  noticeDetail.className = "cu-notice-detail";
  noticeDetail.hidden = true;
  const noticeHint = document.createElement("p");
  noticeHint.className = "cu-notice-hint";
  noticeHint.hidden = true;
  notice.append(noticeText, noticeDetail, noticeHint);
  root.appendChild(notice);

  // ── 版本 / 关于插件（规范 docs/plugin-settings-and-release-notes-v1.md §1）──
  const footer = document.createElement("footer");
  footer.className = "cu-footer";
  const versionBtn = button("cu-link-btn");
  text(versionBtn, "settings.version", () => ({ version: info.version }));
  attr(versionBtn, "aria-label", "settings.versionLabel", () => ({ version: info.version }));
  const aboutBtn = button("cu-link-btn");
  text(aboutBtn, "settings.about");
  bind(() => aboutBtn.setAttribute("aria-label", t("settings.aboutLabel", { name: name() })));
  footer.append(versionBtn, aboutBtn);
  root.appendChild(footer);

  const infoCard = document.createElement("section");
  infoCard.className = "cu-card cu-info";
  infoCard.hidden = true;
  // 标题与「收起」按钮常驻，语言切换只改文字、不替换节点，焦点不会丢。
  const infoHead = document.createElement("div");
  infoHead.className = "cu-card-head";
  const infoTitle = document.createElement("h2");
  const infoClose = button("cu-link-btn");
  text(infoClose, "settings.collapse");
  infoHead.append(infoTitle, infoClose);
  const infoBody = document.createElement("div");
  infoBody.className = "cu-info-body";
  infoCard.append(infoHead, infoBody);
  root.appendChild(infoCard);

  // ── 缓存的结构化状态（语言切换时据此重渲染）──
  let permissions: { status: PermissionsStatus | null; error?: string } = { status: null };
  let engine: { state: ComputerState | null; error?: string } = { state: null };
  const steps: StepLike[] = [];
  let result: { message: UiMessage; ok: boolean } | null = null;
  let currentNotice: HomeNotice | null = null;
  let infoKind: "changelog" | "about" | null = null;
  let running = false;
  let progressStep = 0;
  let progressStartedAt = 0;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let vlmEffective = MODEL_OPTIONS[0].value as string;
  let configReady = false;
  let vlmSaving = false;
  /** 模型档位状态提示（资源键 + 参数），语言切换时重新渲染。 */
  let aliasState: { key: string; params?: () => Record<string, string | number> } | null = null;
  type PendingKey = "stop" | "resume" | "accessibility" | "screen" | "permRefresh" | "trace";
  const pending = new Set<PendingKey>();

  // ── 异步入口：点击后立即进入进行中（文案 + 禁用），完成或失败都回到终态 ──
  const runPending = (key: PendingKey, action: () => Promise<void>) => {
    if (pending.has(key)) return;
    pending.add(key);
    applyPending();
    void action()
      .catch(() => undefined) // 失败原因由调用方写入通知
      .finally(() => {
        pending.delete(key);
        applyPending();
      });
  };

  stopBtn.addEventListener("click", () => runPending("stop", handlers.onStop));
  resumeBtn.addEventListener("click", () => runPending("resume", handlers.onResume));
  permAccessibility.button.addEventListener("click", () =>
    runPending("accessibility", handlers.onRequestAccessibility),
  );
  permScreen.button.addEventListener("click", () => runPending("screen", handlers.onOpenScreenSettings));
  permRefresh.addEventListener("click", () => runPending("permRefresh", handlers.onRefreshPermissions));
  traceRefresh.addEventListener("click", () => runPending("trace", handlers.onRefreshTrace));
  startBtn.addEventListener("click", () => {
    const task = taskInput.value.trim();
    if (!task || running || !configReady) return;
    handlers.onStartTask(task);
  });
  abortBtn.addEventListener("click", () => handlers.onAbortTask());
  aliasSelect.addEventListener("change", () => {
    if (vlmSaving) return;
    const next = aliasSelect.value;
    const previous = vlmEffective;
    if (next === previous) return;
    vlmSaving = true;
    aliasSelect.disabled = true;
    setAliasState({ key: "model.saving" });
    handlers
      .onSaveVlm(next)
      .then(() => {
        vlmEffective = next;
        setAliasState({ key: "model.saved" });
      })
      .catch(() => {
        // 保存失败：界面恢复为之前已生效的值，并说清仍在使用哪一档。
        aliasSelect.value = previous;
        setAliasState({ key: "model.saveFailed", params: () => ({ previous: modelLabel(previous) }) });
      })
      .finally(() => {
        vlmSaving = false;
        aliasSelect.disabled = false;
      });
  });
  infoClose.addEventListener("click", () => {
    const opener = infoKind === "changelog" ? versionBtn : aboutBtn;
    infoKind = null;
    renderInfo();
    opener.focus();
  });
  versionBtn.addEventListener("click", () => showInfo("changelog"));
  aboutBtn.addEventListener("click", () => showInfo("about"));

  function setAliasState(next: typeof aliasState) {
    aliasState = next;
    renderAliasState();
  }

  function renderAliasState() {
    aliasStatus.textContent = aliasState ? t(aliasState.key, aliasState.params?.()) : "";
  }

  function applyPending() {
    stopBtn.disabled = pending.has("stop");
    stopBtn.textContent = t(pending.has("stop") ? "stop.pending" : "stop.button");
    resumeBtn.disabled = pending.has("resume");
    resumeBtn.textContent = t(pending.has("resume") ? "stop.resumePending" : "stop.resume");
    permAccessibility.button.disabled = pending.has("accessibility");
    permAccessibility.button.textContent = t(
      pending.has("accessibility") ? "permissions.pending" : "permissions.accessibilityAction",
    );
    permScreen.button.disabled = pending.has("screen");
    permScreen.button.textContent = t(pending.has("screen") ? "permissions.pending" : "permissions.screenAction");
    permRefresh.disabled = pending.has("permRefresh");
    permRefresh.textContent = t(pending.has("permRefresh") ? "permissions.pending" : "permissions.refresh");
    traceRefresh.disabled = pending.has("trace");
    traceRefresh.textContent = t(pending.has("trace") ? "trace.pending" : "trace.refresh");
  }

  function renderPermissions() {
    applyPermState(permAccessibility, permissions.status?.accessibility ?? null, permissions.status === null && !permissions.error);
    applyPermState(permScreen, permissions.status?.screenRecording ?? null, permissions.status === null && !permissions.error);
    // 查询失败：给出本地化原因与重试入口（下方「刷新权限状态」），开发者模式附脱敏原文。
    permError.hidden = !permissions.error;
    permError.textContent = permissions.error ? queryFailureText(permissions.error, "permissions.queryFailed") : "";
  }

  function queryFailureText(raw: string, key: string): string {
    return developerMode ? `${t(key)}\n${sanitizeDiagnostic(raw)}` : t(key);
  }

  function renderEngine() {
    stoppedBanner.hidden = !(engine.state?.stopped ?? false);
    traceList.replaceChildren();
    if (engine.error) {
      const li = document.createElement("li");
      li.className = "cu-trace-item is-error";
      const head = document.createElement("span");
      head.textContent = t("trace.unavailable");
      const reason = document.createElement("span");
      reason.className = "cu-trace-meta";
      reason.textContent = queryFailureText(engine.error, "trace.queryFailed");
      li.append(head, reason);
      traceList.appendChild(li);
      return;
    }
    for (const item of engine.state?.trace ?? []) {
      const li = document.createElement("li");
      li.className = `cu-trace-item ${item.ok ? "is-ok" : "is-error"}`;
      const meta = document.createElement("span");
      meta.className = "cu-trace-meta";
      meta.textContent = `${item.action} · ${item.source}`;
      const summary = document.createElement("span");
      summary.textContent = item.summary; // 宿主生成的审计摘要，原样显示
      li.append(meta, summary);
      traceList.appendChild(li);
    }
    if (!traceList.childElementCount) {
      const li = document.createElement("li");
      li.className = "cu-trace-item";
      li.textContent = t("trace.empty");
      traceList.appendChild(li);
    }
  }

  function renderSteps() {
    const scroll = stepsList.scrollTop;
    stepsList.replaceChildren(...steps.map(stepItem));
    stepsList.scrollTop = scroll;
  }

  function stepItem(step: StepLike): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `cu-step ${step.ok ? "is-ok" : "is-error"}`;
    const head = document.createElement("span");
    head.className = "cu-step-head";
    head.textContent = `#${step.step} ${describeAction(step.action)}`;
    li.appendChild(head);
    if (step.thought) {
      const thought = document.createElement("span");
      thought.className = "cu-step-thought";
      thought.textContent = step.thought; // 模型原文，不翻译
      li.appendChild(thought);
    }
    if (step.error) {
      const err = document.createElement("span");
      err.className = "cu-step-error";
      err.textContent = render(step.error);
      li.appendChild(err);
      if (developerMode && step.error.raw) {
        const raw = document.createElement("span");
        raw.className = "cu-step-raw";
        raw.textContent = sanitizeDiagnostic(step.error.raw);
        li.appendChild(raw);
      }
    }
    return li;
  }

  function renderResult() {
    taskResult.hidden = result === null;
    if (!result) return;
    taskResult.className = `cu-task-result ${result.ok ? "is-ok" : "is-error"}`;
    const head = document.createElement("span");
    head.textContent = render(result.message);
    const parts: HTMLElement[] = [head];
    // done / fail 的说明来自模型，属于用户可见内容，原样显示；宿主错误原文只在开发者模式显示。
    const modelDetail = result.message.key === "result.done" || result.message.key === "result.fail";
    if (result.message.raw && (modelDetail || developerMode)) {
      const detail = document.createElement("span");
      detail.className = modelDetail ? "cu-result-detail" : "cu-step-raw";
      detail.textContent = modelDetail ? result.message.raw : sanitizeDiagnostic(result.message.raw);
      parts.push(detail);
    }
    taskResult.replaceChildren(...parts);
  }

  function renderProgress() {
    progress.hidden = !running;
    if (!running) return;
    const seconds = Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1000));
    progress.textContent =
      progressStep > 0 ? t("console.running", { step: progressStep, seconds }) : t("console.starting", { seconds });
  }

  function renderNotice() {
    notice.hidden = currentNotice === null;
    if (!currentNotice) return;
    notice.className = `cu-notice ${currentNotice.level === "error" ? "is-error" : ""}`;
    noticeText.textContent = render(currentNotice.message);
    const raw = currentNotice.message.raw;
    noticeDetail.hidden = !(developerMode && raw);
    noticeDetail.textContent = developerMode && raw ? `${t("notice.details")}\n${sanitizeDiagnostic(raw)}` : "";
    noticeHint.hidden = !(raw && !developerMode);
    noticeHint.textContent = raw && !developerMode ? t("notice.detailsHint") : "";
  }

  function renderInfo() {
    infoCard.hidden = infoKind === null;
    if (!infoKind) return;
    const children: HTMLElement[] = [];
    if (infoKind === "changelog") {
      infoTitle.textContent = t("settings.changelogTitle", { version: info.version });
      const section = changelogSection(info.changelogText, info.version);
      const body = document.createElement("pre");
      body.className = "cu-changelog";
      body.textContent = section ?? t("settings.changelogMissing", { version: info.version });
      children.push(body);
      if (section) children.push(paragraphText(t("settings.changelogLanguageNote")));
    } else {
      infoTitle.textContent = t("settings.aboutTitle", { name: name() });
      const detailUrl = `https://open.reai.com/apps/${encodeURIComponent(info.appId)}`;
      const list = document.createElement("dl");
      list.className = "cu-about";
      for (const [term, value] of [
        [t("settings.aboutPlugin"), name()],
        [t("settings.aboutVersion"), t("settings.aboutVersionValue", { version: info.version })],
        [t("settings.aboutAppId"), info.appId],
        [t("settings.aboutDetail"), detailUrl],
      ]) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        list.append(dt, dd);
      }
      children.push(list, paragraphText(t("settings.aboutBlocked")));
    }
    infoBody.replaceChildren(...children);
  }

  function showInfo(kind: "changelog" | "about") {
    infoKind = kind;
    renderInfo();
    infoCard.scrollIntoView?.({ block: "nearest" });
  }

  function stopProgressTimer() {
    if (progressTimer !== null) clearInterval(progressTimer);
    progressTimer = null;
  }

  applyPending();
  renderPermissions();
  renderEngine();

  return {
    root,
    setPermissions(status, error) {
      permissions = error ? { status, error } : { status };
      renderPermissions();
    },
    setEngineState(state, error) {
      engine = error ? { state, error } : { state };
      renderEngine();
    },
    setTaskRunning(next) {
      running = next;
      startBtn.disabled = next || !configReady;
      abortBtn.disabled = !next;
      stopProgressTimer();
      if (next) {
        result = null;
        renderResult();
        progressStep = 0;
        progressStartedAt = Date.now();
        progressTimer = setInterval(renderProgress, 1000);
      }
      renderProgress();
    },
    setTaskProgress(step) {
      progressStep = step;
      renderProgress();
    },
    appendStep(step) {
      steps.push(step);
      stepsList.appendChild(stepItem(step));
      stepsList.scrollTop = stepsList.scrollHeight;
    },
    setTaskResult(message, ok) {
      result = { message, ok };
      renderResult();
    },
    clearSteps() {
      steps.length = 0;
      stepsList.replaceChildren();
    },
    setVlmReady(modelAlias) {
      configReady = true;
      vlmEffective = modelAlias;
      aliasSelect.value = modelAlias;
      aliasSelect.disabled = false;
      startBtn.disabled = running;
    },
    setNotice(next) {
      currentNotice = next;
      renderNotice();
    },
    setDeveloperMode(enabled) {
      if (developerMode === enabled) return;
      developerMode = enabled;
      // 关闭开发者模式时立即清掉所有原始详情。
      renderNotice();
      renderSteps();
      renderResult();
      renderPermissions();
      renderEngine();
    },
    applyLocale() {
      for (const update of binders) update();
      applyPending();
      renderPermissions();
      renderEngine();
      renderSteps();
      renderResult();
      renderProgress();
      renderNotice();
      renderInfo();
      renderAliasState();
    },
    dispose() {
      stopProgressTimer();
    },
  };

  function section(titleKey: string): HTMLElement {
    const card = document.createElement("section");
    card.className = "cu-card";
    const title = document.createElement("h2");
    text(title, titleKey);
    card.appendChild(title);
    return card;
  }

  function paragraph(key: string): HTMLParagraphElement {
    const p = document.createElement("p");
    p.className = "cu-sub";
    text(p, key);
    return p;
  }

  function permRow(labelKey: string, actionKey: string) {
    const row = document.createElement("div");
    row.className = "cu-perm-row";
    const label = document.createElement("span");
    text(label, labelKey);
    const state = document.createElement("span");
    state.className = "cu-perm-state is-unknown";
    const btn = button("cu-secondary-btn");
    btn.textContent = t(actionKey);
    row.append(label, state, btn);
    return { row, state, button: btn };
  }
}

interface PermRow {
  state: HTMLSpanElement;
}

function applyPermState(row: PermRow, granted: boolean | null, checking: boolean) {
  if (checking) {
    row.state.textContent = t("permissions.checking");
    row.state.className = "cu-perm-state is-unknown";
  } else if (granted === null) {
    row.state.textContent = t("permissions.unknown");
    row.state.className = "cu-perm-state is-unknown";
  } else if (granted) {
    row.state.textContent = t("permissions.granted");
    row.state.className = "cu-perm-state is-granted";
  } else {
    row.state.textContent = t("permissions.denied");
    row.state.className = "cu-perm-state is-denied";
  }
}

function button(className: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  return el;
}

function paragraphText(value: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = "cu-sub";
  p.textContent = value;
  return p;
}

function modelLabel(value: string): string {
  const option = MODEL_OPTIONS.find((candidate) => candidate.value === value);
  return option ? t(option.key) : value;
}

/**
 * 诊断脱敏：去掉 URL 查询参数与凭据形态的值，截断长度。只在 Host 开发者模式下使用。
 */
export function sanitizeDiagnostic(raw: string): string {
  return raw
    // URL：去掉 userinfo（账号密码）与查询参数 / 片段。
    .replace(/(https?:\/\/)[^\s/@"']+@/gi, "$1***@")
    .replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?…")
    // 整行属于凭据的头部（多字段 Cookie、Authorization）直接整段遮蔽到行尾。
    .replace(/\b(set-cookie|cookie|authorization|proxy-authorization)(\s*[:=])[^\n]*/gi, "$1$2 ***")
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***")
    // 键值对：值可能带引号（含空格）或是普通片段。
    // 键值对：键可带引号（JSON 序列化的错误对象），值可能带引号（含空格）或是普通片段。
    .replace(
      /(["']?)\b(token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|secret|client[_-]?secret|password|passwd|session|cookie|authorization)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
      "$1$2$1$3***",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "***")
    .slice(0, 600);
}

export function describeAction(action: StepLike["action"]): string {
  switch (action.action) {
    case "click":
      return t("action.click", { x: action.x ?? "?", y: action.y ?? "?" });
    case "type":
      return t("action.type", { text: JSON.stringify((action.text ?? "").slice(0, 60)) });
    case "press":
      return t("action.press", { key: action.key ?? "?" });
    case "scroll":
      return t("action.scroll", { dx: action.dx ?? 0, dy: action.dy ?? 0 });
    case "done":
      return t("action.done");
    case "fail":
      return t("action.fail");
    default:
      return t("action.unknown", { name: action.action });
  }
}

/**
 * 从完整日志里取出当前安装版本那一节；找不到时返回 null，由调用方明确说明，不拿别的版本冒充。
 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^##\s+(\S+)/.exec(line);
    return match?.[1] === version;
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}
