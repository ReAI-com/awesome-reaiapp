/**
 * 电脑操控主页视图：紧急停止 + 权限引导 + 任务控制台 + 审计流。
 *
 * 纯 DOM（与 browser-view 同款形态）；样式在 computer.css，用宿主注入的主题 token。
 * 引擎调用全部容错降级——bridge 不可用时页面显示错误提示而不是白屏。
 */
import type { ComputerState, PermissionsStatus, StepLike } from "./types";

export interface ComputerHomeHandlers {
  onStop: () => void;
  onResume: () => void;
  onRequestAccessibility: () => void;
  onOpenScreenSettings: () => void;
  onRefreshPermissions: () => void;
  onStartTask: (task: string) => void;
  onAbortTask: () => void;
  onSaveVlm: (modelAlias: string) => void;
  onRefreshTrace: () => void;
}

/** 设置区底部「版本 / 关于插件」所需的本机安装包信息（来自 app.manifest.json）。 */
export interface ComputerHomeInfo {
  appId: string;
  name: string;
  version: string;
  changelogText: string;
}

export interface ComputerHome {
  root: HTMLElement;
  setPermissions(status: PermissionsStatus | null, error?: string): void;
  setEngineState(state: ComputerState | null, error?: string): void;
  setTaskRunning(running: boolean): void;
  appendStep(step: StepLike): void;
  setTaskResult(text: string, ok: boolean): void;
  clearSteps(): void;
  setVlmDraft(modelAlias: string): void;
  setNotice(text: string): void;
}

interface TaskRunState {
  running: boolean;
}

export function mountComputerHome(
  parent: HTMLElement,
  handlers: ComputerHomeHandlers,
  info: ComputerHomeInfo,
): ComputerHome {
  const frame = document.createElement("div");
  frame.className = "plugin-main-frame";
  const root = document.createElement("div");
  root.className = "main-body cu-home";
  frame.appendChild(root);
  parent.appendChild(frame);

  // ── 紧急停止条 ──
  const stopBar = document.createElement("div");
  stopBar.className = "cu-stopbar";
  const stopBtn = document.createElement("button");
  stopBtn.className = "cu-stop-btn";
  stopBtn.type = "button";
  stopBtn.textContent = "■ 紧急停止";
  stopBtn.addEventListener("click", () => handlers.onStop());
  const stopHint = document.createElement("span");
  stopHint.className = "cu-stop-hint";
  stopHint.textContent = "停止后所有注入立即拒绝，按住的鼠标按键会被强制抬起";
  stopBar.append(stopBtn, stopHint);
  root.appendChild(stopBar);

  const stoppedBanner = document.createElement("div");
  stoppedBanner.className = "cu-stopped-banner";
  stoppedBanner.hidden = true;
  const stoppedText = document.createElement("span");
  stoppedText.textContent = "已紧急停止：注入通道关闭中";
  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.textContent = "恢复操控";
  resumeBtn.addEventListener("click", () => handlers.onResume());
  stoppedBanner.append(stoppedText, resumeBtn);
  root.appendChild(stoppedBanner);

  // ── 权限卡 ──
  const permCard = document.createElement("section");
  permCard.className = "cu-card";
  const permTitle = document.createElement("h2");
  permTitle.textContent = "系统权限";
  permCard.appendChild(permTitle);

  const permAccessibility = createPermRow(
    "辅助功能（鼠标键盘注入必需）",
    "去授权",
    () => handlers.onRequestAccessibility(),
  );
  const permScreen = createPermRow(
    "屏幕录制（截图与鼠标坐标护栏必需，授权后需重启应用生效）",
    "引导授权",
    () => handlers.onOpenScreenSettings(),
  );
  const permRefresh = document.createElement("button");
  permRefresh.type = "button";
  permRefresh.className = "cu-link-btn";
  permRefresh.textContent = "刷新权限状态";
  permRefresh.addEventListener("click", () => handlers.onRefreshPermissions());
  permCard.append(permAccessibility.row, permScreen.row, permRefresh);
  root.appendChild(permCard);

  // ── 任务控制台 ──
  const consoleCard = document.createElement("section");
  consoleCard.className = "cu-card";
  const consoleTitle = document.createElement("h2");
  consoleTitle.textContent = "任务控制台";
  const consoleSub = document.createElement("p");
  consoleSub.className = "cu-sub";
  consoleSub.textContent =
    "用自然语言描述任务，例如：打开微信，给文件传输助手发一条消息「你好，这是 Computer Use 第一版」。执行全程可见，随时紧急停止。";
  consoleCard.append(consoleTitle, consoleSub);

  const taskInput = document.createElement("textarea");
  taskInput.className = "cu-task-input";
  taskInput.rows = 3;
  taskInput.placeholder = "描述要让 Agent 做的事……";
  const runRow = document.createElement("div");
  runRow.className = "cu-runrow";
  const startBtn = document.createElement("button");
  startBtn.type = "button";
  startBtn.className = "cu-primary-btn";
  startBtn.textContent = "开始任务";
  const abortBtn = document.createElement("button");
  abortBtn.type = "button";
  abortBtn.className = "cu-secondary-btn";
  abortBtn.textContent = "中止任务";
  abortBtn.disabled = true;
  runRow.append(startBtn, abortBtn);
  const egressHint = document.createElement("p");
  egressHint.className = "cu-sub cu-egress-hint";
  egressHint.textContent =
    "开始后，每一步的屏幕截图与任务描述会发送到云端视觉模型。运行期间请勿操作鼠标键盘，也不要让屏幕显示不希望外发的内容。";
  consoleCard.append(taskInput, runRow, egressHint);

  const taskResult = document.createElement("div");
  taskResult.className = "cu-task-result";
  taskResult.hidden = true;
  consoleCard.appendChild(taskResult);

  const stepsList = document.createElement("ol");
  stepsList.className = "cu-steps";
  consoleCard.appendChild(stepsList);
  root.appendChild(consoleCard);

  const run: TaskRunState = { running: false };
  startBtn.addEventListener("click", () => {
    const task = taskInput.value.trim();
    if (!task || run.running) return;
    handlers.onStartTask(task);
  });
  abortBtn.addEventListener("click", () => handlers.onAbortTask());

  // ── 模型设置 ──
  // 视觉决策走 Host 云通道（登录账号计费），插件不接触 API key；这里只选档位。
  const settingsCard = document.createElement("section");
  settingsCard.className = "cu-card";
  const settingsTitle = document.createElement("h2");
  settingsTitle.textContent = "视觉模型（经登录账号的云端网关）";
  const settingsSub = document.createElement("p");
  settingsSub.className = "cu-sub";
  settingsSub.textContent =
    "截图与任务指令经 Host 云通道发送（凭据归登录账号，无需填写 API Key）。视觉定位建议用高质量档。";
  settingsCard.append(settingsTitle, settingsSub);

  const aliasRow = document.createElement("label");
  aliasRow.className = "cu-field";
  const aliasName = document.createElement("span");
  aliasName.textContent = "模型档位";
  const aliasSelect = document.createElement("select");
  for (const option of [
    { value: "text-quality", label: "高质量文本（推荐）" },
    { value: "text-default", label: "通用文本（更快）" },
  ]) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    aliasSelect.appendChild(el);
  }
  aliasSelect.addEventListener("change", () => handlers.onSaveVlm(aliasSelect.value));
  aliasRow.append(aliasName, aliasSelect);
  settingsCard.appendChild(aliasRow);
  root.appendChild(settingsCard);

  // ── 审计流 ──
  const traceCard = document.createElement("section");
  traceCard.className = "cu-card";
  const traceHead = document.createElement("div");
  traceHead.className = "cu-trace-head";
  const traceTitle = document.createElement("h2");
  traceTitle.textContent = "操作审计";
  const traceRefresh = document.createElement("button");
  traceRefresh.type = "button";
  traceRefresh.className = "cu-link-btn";
  traceRefresh.textContent = "刷新";
  traceRefresh.addEventListener("click", () => handlers.onRefreshTrace());
  traceHead.append(traceTitle, traceRefresh);
  const traceList = document.createElement("ul");
  traceList.className = "cu-trace";
  traceCard.append(traceHead, traceList);
  root.appendChild(traceCard);

  const notice = document.createElement("div");
  notice.className = "cu-notice";
  notice.hidden = true;
  root.appendChild(notice);

  // ── 版本 / 关于插件（规范 docs/plugin-settings-and-release-notes-v1.md §1）──
  // SDK 当前没有打开外部链接的能力，先在插件内展示本机版本日志与应用详情地址。
  const footer = document.createElement("footer");
  footer.className = "cu-footer";
  const versionBtn = document.createElement("button");
  versionBtn.type = "button";
  versionBtn.className = "cu-link-btn";
  versionBtn.textContent = `版本 ${info.version}`;
  versionBtn.setAttribute("aria-label", `查看版本 ${info.version} 的更新日志`);
  const aboutBtn = document.createElement("button");
  aboutBtn.type = "button";
  aboutBtn.className = "cu-link-btn";
  aboutBtn.textContent = "关于插件";
  aboutBtn.setAttribute("aria-label", `关于 ${info.name}`);
  footer.append(versionBtn, aboutBtn);
  root.appendChild(footer);

  const infoCard = document.createElement("section");
  infoCard.className = "cu-card cu-info";
  infoCard.hidden = true;
  root.appendChild(infoCard);

  function showInfo(kind: "changelog" | "about") {
    const head = document.createElement("div");
    head.className = "cu-trace-head";
    const title = document.createElement("h2");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cu-link-btn";
    close.textContent = "收起";
    close.addEventListener("click", () => {
      infoCard.hidden = true;
      (kind === "changelog" ? versionBtn : aboutBtn).focus();
    });
    head.append(title, close);
    const body = document.createElement(kind === "changelog" ? "pre" : "dl");
    body.className = kind === "changelog" ? "cu-changelog" : "cu-about";
    if (kind === "changelog") {
      title.textContent = `版本 ${info.version} 更新日志`;
      body.textContent = changelogSection(info.changelogText, info.version);
    } else {
      title.textContent = `关于 ${info.name}`;
      const detailUrl = `https://open.reai.com/apps/${encodeURIComponent(info.appId)}`;
      for (const [term, value] of [
        ["插件", info.name],
        ["版本", `${info.version} · 本地源码候选，尚未公开发布`],
        ["应用标识", info.appId],
        ["公开应用详情", detailUrl],
      ]) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        body.append(dt, dd);
      }
    }
    infoCard.replaceChildren(head, body);
    infoCard.hidden = false;
    infoCard.scrollIntoView?.({ block: "nearest" });
  }
  versionBtn.addEventListener("click", () => showInfo("changelog"));
  aboutBtn.addEventListener("click", () => showInfo("about"));

  return {
    root,
    setPermissions(status, error) {
      applyPermState(permAccessibility, status?.accessibility ?? null);
      applyPermState(permScreen, status?.screenRecording ?? null);
      if (error) {
        permAccessibility.state.textContent = `状态未知（${error}）`;
        permAccessibility.state.className = "cu-perm-state unknown";
      }
    },
    setEngineState(state, error) {
      stoppedBanner.hidden = !(state?.stopped ?? false);
      traceList.replaceChildren();
      if (error) {
        const li = document.createElement("li");
        li.className = "cu-trace-item error";
        li.textContent = `引擎状态不可用：${error}`;
        traceList.appendChild(li);
        return;
      }
      for (const item of state?.trace ?? []) {
        const li = document.createElement("li");
        li.className = `cu-trace-item ${item.ok ? "ok" : "error"}`;
        const meta = document.createElement("span");
        meta.className = "cu-trace-meta";
        meta.textContent = `${item.action} · ${item.source}`;
        const summary = document.createElement("span");
        summary.textContent = item.summary;
        li.append(meta, summary);
        traceList.appendChild(li);
      }
      if (!traceList.childElementCount) {
        const li = document.createElement("li");
        li.className = "cu-trace-item";
        li.textContent = "暂无操作记录";
        traceList.appendChild(li);
      }
    },
    setTaskRunning(running) {
      run.running = running;
      startBtn.disabled = running;
      abortBtn.disabled = !running;
      if (running) {
        taskResult.hidden = true;
      }
    },
    appendStep(step) {
      const li = document.createElement("li");
      li.className = `cu-step ${step.ok ? "ok" : "error"}`;
      const head = document.createElement("span");
      head.className = "cu-step-head";
      head.textContent = `#${step.step} ${describeAction(step.action)}`;
      if (step.thought) {
        const thought = document.createElement("span");
        thought.className = "cu-step-thought";
        thought.textContent = step.thought;
        head.appendChild(thought);
      }
      li.appendChild(head);
      if (step.error) {
        const err = document.createElement("span");
        err.className = "cu-step-error";
        err.textContent = step.error;
        li.appendChild(err);
      }
      stepsList.appendChild(li);
      stepsList.scrollTop = stepsList.scrollHeight;
    },
    setTaskResult(text, ok) {
      taskResult.hidden = false;
      taskResult.textContent = text;
      taskResult.className = `cu-task-result ${ok ? "ok" : "error"}`;
    },
    clearSteps() {
      stepsList.replaceChildren();
    },
    setVlmDraft(modelAlias) {
      aliasSelect.value = modelAlias;
    },
    setNotice(text) {
      notice.hidden = !text;
      notice.textContent = text;
    },
  };
}

interface PermRow {
  row: HTMLDivElement;
  state: HTMLSpanElement;
}

function createPermRow(label: string, actionText: string, onAction: () => void): PermRow {
  const row = document.createElement("div");
  row.className = "cu-perm-row";
  const name = document.createElement("span");
  name.textContent = label;
  const state = document.createElement("span");
  state.className = "cu-perm-state unknown";
  state.textContent = "检测中…";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cu-secondary-btn";
  btn.textContent = actionText;
  btn.addEventListener("click", onAction);
  row.append(name, state, btn);
  return { row, state };
}

function applyPermState(row: PermRow, granted: boolean | null) {
  if (granted === null) {
    row.state.textContent = "状态未知";
    row.state.className = "cu-perm-state unknown";
  } else if (granted) {
    row.state.textContent = "已授权 ✓";
    row.state.className = "cu-perm-state granted";
  } else {
    row.state.textContent = "未授权";
    row.state.className = "cu-perm-state denied";
  }
}

export function describeAction(action: {
  action: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  dy?: number;
  detail?: string;
}): string {
  switch (action.action) {
    case "click":
      return `点击 (${action.x ?? "?"}, ${action.y ?? "?"})`;
    case "type":
      return `输入 ${JSON.stringify((action.text ?? "").slice(0, 60))}`;
    case "press":
      return `按键 ${action.key ?? "?"}`;
    case "scroll":
      return `滚动 dy=${action.dy ?? 0}`;
    case "done":
      return `任务完成：${action.detail ?? ""}`;
    case "fail":
      return `模型放弃：${action.detail ?? ""}`;
    default:
      return action.action;
  }
}

/**
 * 从完整日志里取出当前安装版本那一节；找不到时明确说明，不拿别的版本冒充。
 */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const match = /^##\s+(\S+)/.exec(line);
    return match?.[1] === version;
  });
  if (start === -1) return `此版本（${version}）的更新日志尚未发布。`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}
