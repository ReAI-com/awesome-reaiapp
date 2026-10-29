import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultVoiceViewState } from "../src/data";
import { setVoiceLocale } from "../src/voice-i18n";
import {
  mountVoiceView,
  type VoiceViewActions,
} from "../src/voice-view";

const driverRoot = join(import.meta.dir, "..");
const repoRoot = join(driverRoot, "../../..");
const readDriver = (path: string) => readFileSync(join(driverRoot, path), "utf8");
const readRepo = (path: string) => readFileSync(join(repoRoot, path), "utf8");

let ownsDomRegistration = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDomRegistration = true;
  }
});
afterAll(() => {
  if (ownsDomRegistration) GlobalRegistrator.unregister();
});
beforeEach(() => document.body.replaceChildren());

const noopActions = new Proxy({}, {
  get: () => async () => undefined,
}) as VoiceViewActions;

function mountDefaultVoice() {
  const root = document.createElement("div");
  document.body.append(root);
  const view = mountVoiceView(root, createDefaultVoiceViewState(), noopActions);
  return { root, view };
}

function mountVoiceWith(
  patch: Partial<ReturnType<typeof createDefaultVoiceViewState>> = {},
) {
  const root = document.createElement("div");
  document.body.append(root);
  const base = createDefaultVoiceViewState();
  const view = mountVoiceView(root, { ...base, ...patch }, noopActions);
  return { root, view };
}

describe("Voice V1.7 插件页面骨架", () => {
  test("旧 mount 的延迟清理不会移除同一 root 的新视图或其语言绑定", () => {
    setVoiceLocale("zh");
    const { root, view: oldView } = mountDefaultVoice();
    const nextView = mountVoiceView(root, createDefaultVoiceViewState(), noopActions);
    const nextFrame = root.firstElementChild;
    try {
      oldView.dispose();
      oldView.dispose();
      expect(root.firstElementChild === nextFrame).toBeTrue();
      expect(root.querySelector(".voice-overview-title")?.textContent).toBe("语音记录");
      setVoiceLocale("en");
      expect(root.querySelector(".voice-overview-title")?.textContent).toBe("Voice history");
      nextView.openSettings();
      expect(root.querySelector(".voice-settings-view")).not.toBeNull();
    } finally {
      nextView.dispose();
      setVoiceLocale("zh");
    }
    expect(root.childElementCount).toBe(0);
  });

  test("隔离 WebView 补回设计稿 appwin 的 card-bg Surface，日期吸顶条与页面同底", () => {
    const css = readDriver("src/voice.css");

    expect(css).toMatch(
      /--voice-surface:\s*linear-gradient\(var\(--voice-card\), var\(--voice-card\)\), var\(--voice-canvas\)/,
    );
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--voice-surface\)/s);
    expect(css).toMatch(/\.day-hd\s*\{[^}]*background:\s*var\(--voice-surface\)/s);
    expect(css).not.toMatch(/body\s*\{[^}]*background:\s*var\(--voice-canvas\)/s);
  });

  test("根页面只消费一次 Host 标题栏安全区，main-body 是唯一顶层滚动容器", () => {
    const { root, view } = mountDefaultVoice();
    const frame = root.firstElementChild as HTMLElement;

    expect(frame.classList.contains("voice-page")).toBeTrue();
    expect(frame.classList.contains("plugin-main-frame")).toBeTrue();
    expect(frame.querySelectorAll(":scope > .main-body")).toHaveLength(1);
    expect(frame.querySelector(":scope > .voice-surface-body > .main-body.voice-main-body")).not.toBeNull();
    expect(frame.querySelector(":scope > .voice-surface-body > .main-body > .voice-list-view.task-list-view")).not.toBeNull();

    const css = readDriver("src/voice.css");
    // happy-dom drops var() padding; actual pixels are verified in the browser fixture.
    expect(frame.classList.contains("reai-surface-frame")).toBeTrue();
    expect(frame.querySelector<HTMLElement>(":scope > .reai-surface-footer")?.style.display).toBe("none");
    expect(css).toContain("--reai-titlebar-h: var(--reai-plugin-titlebar-safe-top, 44px)");
    expect(css).toMatch(
      /\.plugin-main-frame\s*\{[^}]*padding-top:\s*var\(--reai-titlebar-h\)/s,
    );
    expect(css).toMatch(/\.voice-surface-body > \.main-body\s*\{[^}]*overflow-y:\s*auto/s);
    expect(css).not.toMatch(
      /\.task-list-view,\s*\.voice-settings-view,\s*\.input-detail\s*\{[^}]*overflow-y:\s*auto/s,
    );
    view.dispose();
  });

  test("Voice 首页使用 V1.7 精确概览层级和文案", () => {
    const { root, view } = mountDefaultVoice();
    const overview = root.querySelector(".voice-overview");

    expect(overview?.querySelector(".voice-overview-title")?.textContent).toBe("语音记录");
    expect(overview?.querySelector(".voice-overview-copy")?.textContent).toBe(
      "说过的话都在这里：输入、命令，以及键盘听到的现场",
    );
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(root.querySelector('[aria-label="Voice 设置"]')).toBeNull();
    view.dispose();
  });

  test("设置页留在同一 frame 内，没有自绘第二条粘性页头", () => {
    const { root, view } = mountDefaultVoice();
    view.openSettings();
    const frame = root.firstElementChild as HTMLElement;

    expect(frame.querySelectorAll(":scope > .main-body")).toHaveLength(1);
    expect(frame.querySelector(":scope > .voice-surface-body > .main-body.voice-settings-view")).not.toBeNull();
    expect(frame.querySelector("header.settings-header")).toBeNull();
    expect(frame.textContent).toContain("说话之后发生什么，都在这一页定");
    /* V1.7.0 / B5-14：设置页自绘返回钮撤除，返回由 Host 面包屑承载。 */
    expect(frame.querySelector('[aria-label="返回 Voice"]')).toBeNull();
    view.dispose();
  });
});

describe("Voice V1.7 图标与交互基线", () => {
  const source = readDriver("src/voice-view.ts");
  const css = readDriver("src/voice.css");

  test("装饰图标不再由字符字形冒充；清单行 / 详情页头的 emoji 头像是 R3 裁定的规范，圆钮居中", () => {
    for (const glyphLiteral of ['"⌘"', '"〰"', '"◉"', '"›"']) {
      expect(source).not.toContain(glyphLiteral);
    }
    // R3（稿 V1.7.1）：emoji 头像保留，圆钮套 line-height:1 + text-indent:.25em 归零。
    expect(source).toContain('bindText(avatar, () => "🎙️")');
    expect(source).toContain('textEl("span", "task-ava-mic", () => "🎙️")');
    expect(css).toMatch(/\.task-ava,\s*\.detail-avatar\s*\{[^}]*line-height:\s*1;[^}]*text-indent:\s*\.25em/s);
    expect(css).toMatch(/\.chat-who-ava\s*\{[^}]*line-height:\s*1;[^}]*text-indent:\s*\.25em/s);
    // 问号是稿 qhint 的 `circle-help` 线性图标（V1.7.3 起浮层），带 aria-label，不是字符字形。
    expect(source).toContain('bindAttribute(button, "aria-label", () => label)');
    expect(source).toContain("button.innerHTML = helpCircleIcon()");
    expect(source).not.toContain('textContent = "?"');
  });

  test("设置主面按频次收口，云端能力按引擎条件出现", () => {
    const local = mountVoiceWith();
    local.view.openSettings();
    expect(
      Array.from(local.root.querySelectorAll(".settings-section-title"), (node) => node.textContent),
    ).toEqual(["录音与识别", "润色", "语音命令", "记录保留", "每日总结", "系统"]);
    expect(local.root.textContent).not.toContain("润色上下文");
    local.view.dispose();

    const base = createDefaultVoiceViewState();
    const cloud = mountVoiceWith({
      commandLoggedIn: true,
      settings: { ...base.settings, engine: "cloud" },
    });
    cloud.view.openSettings();
    expect(
      Array.from(cloud.root.querySelectorAll(".settings-section-title"), (node) => node.textContent),
    ).toEqual([
      "录音与识别",
      "润色",
      "语音命令",
      "记录保留",
      "每日总结",
      "系统",
    ]);
    expect(cloud.root.textContent).not.toContain("Agent 底层");
    cloud.view.dispose();
  });

  test("云端未登录仍可选择并在第二行去 Host 登录；问号是 body 浮层", () => {
    let loginRequests = 0;
    const actions = new Proxy({}, {
      get: (_target, key) => key === "onOpenAccountLogin"
        ? async () => { loginRequests += 1; }
        : async () => undefined,
    }) as VoiceViewActions;
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountVoiceView(
      root,
      {
        ...createDefaultVoiceViewState(),
        commandLoggedIn: false,
        settings: { ...createDefaultVoiceViewState().settings, engine: "cloud" },
      },
      actions,
    );
    view.openSettings();

    const cloud = root.querySelector<HTMLButtonElement>('[data-setting-value="cloud"]');
    expect(cloud?.disabled).toBeFalse();
    root.querySelector<HTMLButtonElement>('[data-action="open-account-login"]')?.click();
    expect(loginRequests).toBe(1);

    const content = root.querySelector(".settings-content");
    const sectionCount = content?.children.length;
    root.querySelector<HTMLButtonElement>(".settings-hint-trigger")?.click();
    const panel = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(panel).not.toBeNull();
    expect(panel?.parentElement).toBe(document.body);
    expect(content?.children.length).toBe(sectionCount);
    expect(root.querySelector("details.settings-hint")).toBeNull();
    panel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    // 输入法组字中的 Esc 原样放行，提示不关。
    const composing = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: true });
    document.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();
    // 普通 Esc 只关提示并声明已消费（surface.escape@1：Host 不再当成返回上一页）。
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    view.dispose();
  });

  test("记录保留：只有「全天存档」一颗开关（稿 V1.12.3），没有录音缓存开关", () => {
    const actions = new Proxy({}, {
      get: () => async () => undefined,
    }) as VoiceViewActions;
    const root = document.createElement("div");
    document.body.append(root);
    const view = mountVoiceView(root, createDefaultVoiceViewState({
      timeline: {
        state: "running",
        hotRingDurationMs: 10_000,
        cacheDurationMs: 60_000,
        cacheHealth: "healthy",
        continuousRecordingEnabled: true,
        recordingState: "running",
        sttBacklog: 0,
        hostLocalDropFrames: 0,
      },
    }), actions);
    view.openSettings();

    const section = root.querySelector('[data-settings-target="replay-cache"]');
    const switches = Array.from(section?.querySelectorAll('[role="switch"]') ?? []);
    expect(switches.map(node => node.getAttribute("aria-label"))).toEqual(["全天存档"]);
    expect(section?.textContent).toContain("保留多久");
    expect(section?.textContent).toContain("立刻清空语音记录");
    view.dispose();
  });

  test("Host 状态更新触发重渲染时清理 body 问号浮层", () => {
    const { root, view } = mountDefaultVoice();
    view.openSettings();
    root.querySelector<HTMLButtonElement>(".settings-hint-trigger")?.click();
    expect(document.body.querySelector('[role="tooltip"]')).not.toBeNull();

    view.update(createDefaultVoiceViewState());

    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    view.dispose();
  });

  test("按钮有统一 focus/disabled 基线，独立图标按钮命中区不小于 44px", () => {
    expect(css).toMatch(/button:focus-visible\s*\{/);
    expect(css).toMatch(/button:disabled\s*\{/);
    expect(css).toMatch(/\.icon-button\s*\{[^}]*(?:min-width|width):\s*44px[^}]*(?:min-height|height):\s*44px/s);
    /* V1.7.0 / B5-14：.back-button 与 .chat-back 随页内返回钮一并撤除；
       R6 / R17：.ctx-seg-x（总结卡删除叉）与 .recording-controls（段行播放 / 删除）
       随列表轻行化一并撤除，删除进段详情总结栏脚部（.ctx-btn.danger + 确认层）。 */
    expect(css).not.toContain(".ctx-seg-x");
    expect(css).not.toContain(".recording-controls");
    // R8：输入坞的「+」与麦克风来自共享包 @reai/chat-ui——稿画 34px 圆，命中区用
    // 透明 ::after 向外扩 5px 到 44px（同 .replay-play::after 的先例）。
    const chatUiCss = readDriver("packages/chat-ui/src/chat-ui.css");
    expect(chatUiCss).toMatch(/\.chat-attach,\s*\.chat-mic\s*\{[^}]*width:\s*34px[^}]*height:\s*34px/s);
    expect(chatUiCss).toMatch(/\.chat-attach::after,\s*\.chat-mic::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*-5px/s);
    // 详情播放器按设计稿显示 30px 圆，::after 向外扩 7px，实际热区仍是 44px。
    expect(css).toMatch(/\.replay-play\s*\{[^}]*min-width:\s*30px[^}]*min-height:\s*30px/s);
    expect(css).toMatch(/\.replay-play::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*-7px/s);
    // R15：波形条最小一条线（2px），不许 0 高。
    expect(css).toMatch(/\.replay-wave i\s*\{[^}]*min-height:\s*2px/s);
    expect(css).toMatch(/\.ctx-btn\.danger\s*\{[^}]*margin-left:\s*auto/s);
    expect(css).toMatch(/\.workflow-controls\s*\{[^}]*gap:\s*8px/s);
    expect(css).toMatch(
      /\.workflow-controls \.primary-button,\s*\.workflow-controls \.workflow-clear-button\s*\{[^}]*min-height:\s*28px/s,
    );
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
