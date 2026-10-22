/**
 * 语言资源与视图双语回归：
 * - zh / en 同键同插值；t() 插值、未知语言回退英文、缺键告警返回键名；
 * - 视图中英文 DOM、原位切换（节点、输入框内容、焦点、步骤与结果保留），模型原文不翻译；
 * - 开发者模式才展示脱敏后的原始错误，关闭立即清空；
 * - 异步入口进行中禁用、防重复；模型档位保存失败恢复旧值；
 * - 整插件经 MockHost 冷启动英文、切到中文不重建 Surface；挂载失败 AppError 随语言翻译。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import { setComputerLocale, t } from "../src/computer-i18n";
import { mountComputerHome, sanitizeDiagnostic, type ComputerHomeHandlers } from "../src/computer-view";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDom = true;
  }
});
afterAll(() => {
  setComputerLocale("zh");
  if (ownsDom) GlobalRegistrator.unregister();
});

function leafPaths(value: unknown, prefix = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: prefix, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}
const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!).sort();

const resolved = () => Promise.resolve();
function handlers(overrides: Partial<ComputerHomeHandlers> = {}): ComputerHomeHandlers {
  return {
    onStop: resolved,
    onResume: resolved,
    onRequestAccessibility: resolved,
    onOpenScreenSettings: resolved,
    onRefreshPermissions: resolved,
    onStartTask: () => undefined,
    onAbortTask: () => undefined,
    onSaveVlm: resolved,
    onRefreshTrace: resolved,
    ...overrides,
  };
}
const INFO = { appId: manifest.appId, version: manifest.version, changelogText: `## ${manifest.version}\n\n正文` };
const buttonByText = (root: HTMLElement, text: string) =>
  Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text) as HTMLButtonElement | undefined;

describe("语言资源", () => {
  test("zh 与 en 叶子路径与插值变量一一对应，叶子非空", () => {
    const zhLeaves = leafPaths(zh);
    const enLeaves = leafPaths(en);
    expect(enLeaves.map((l) => l.path)).toEqual(zhLeaves.map((l) => l.path));
    for (let i = 0; i < zhLeaves.length; i += 1) {
      expect(placeholders(enLeaves[i]!.text)).toEqual(placeholders(zhLeaves[i]!.text));
      expect(zhLeaves[i]!.text.trim()).not.toBe("");
      expect(enLeaves[i]!.text.trim()).not.toBe("");
    }
  });

  test("两个语言文件都是严格 UTF-8 JSON", () => {
    for (const name of ["zh.json", "en.json"]) {
      const bytes = readFileSync(join(import.meta.dir, "..", "assets/locales", name));
      expect(() => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).not.toThrow();
    }
  });

  test("Manifest i18n 引用的资源键都存在", () => {
    const keys = new Set(leafPaths(zh).map((l) => l.path));
    for (const message of manifest.i18n.messages) expect(keys.has(message.key)).toBe(true);
  });

  test("t() 插值、未知语言回退英文、参数按纯文本", () => {
    setComputerLocale("zh");
    expect(t("settings.version", { version: "1.0" })).toBe("版本 1.0");
    setComputerLocale("ja");
    expect(t("settings.version", { version: "1.0" })).toBe("Version 1.0");
    expect(t("action.press", { key: "{x}<b>" })).toBe("Press {x}<b>");
  });

  test("缺键回退为键名（发布门禁不允许出现）", () => {
    setComputerLocale("en");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });
});

describe("视图双语与原位切换", () => {
  test("冷启动英文，切到中文后同一批节点改写、输入与焦点保留", () => {
    setComputerLocale("en");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const home = mountComputerHome(parent, handlers(), INFO);
    const startBtn = buttonByText(parent, "Start task")!;
    expect(startBtn).toBeDefined();
    expect(parent.textContent).toContain("System permissions");
    const input = parent.querySelector("textarea")!;
    expect(input.getAttribute("placeholder")).toBe("Describe what the agent should do…");
    input.value = "未提交的任务";
    input.focus();

    setComputerLocale("zh");
    home.applyLocale();
    expect(startBtn.textContent).toBe("开始任务");
    expect(parent.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("未提交的任务");
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-label")).toBe("任务描述");
    const version = parent.querySelector(".cu-footer button")!;
    expect(version.getAttribute("aria-label")).toBe(`查看版本 ${manifest.version} 的更新日志`);
    home.dispose();
    parent.remove();
  });

  test("失败结果、步骤、通知在切语言后重新翻译，模型原文保持不变", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    home.appendStep({ step: 1, thought: "模型自己的思路", action: { action: "click", x: 1, y: 2 }, ok: false, error: { key: "notice.actionFailed", raw: "COMPUTER_X: 原因" } });
    home.setTaskResult({ key: "result.fail", params: { steps: 1 }, raw: "模型说找不到" }, false);
    home.setNotice({ level: "error", message: { key: "notice.openSettingsFailed", raw: "boom" } });
    expect(parent.textContent).toContain("点击 (1, 2)");
    expect(parent.textContent).toContain("模型报告无法完成");
    expect(parent.textContent).toContain("打开系统设置失败");

    setComputerLocale("en");
    home.applyLocale();
    const textAfter = parent.textContent ?? "";
    expect(textAfter).toContain("Click (1, 2)");
    expect(textAfter).toContain("Action did not complete");
    expect(textAfter).toContain("The model reported it could not finish");
    expect(textAfter).toContain("Couldn't open System Settings");
    expect(textAfter).toContain("模型自己的思路");
    expect(textAfter).toContain("模型说找不到");
    expect(textAfter).not.toContain("打开系统设置失败");
    home.dispose();
  });

  test("原始错误只在开发者模式下脱敏展示，关闭立即清空", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    const raw = "COMPUTER_X: failed https://api.example.com/v1?token=abc123 Bearer sk-secretvalue123";
    home.setNotice({ level: "error", message: { key: "notice.actionFailed", raw } });
    expect(parent.textContent).not.toContain("COMPUTER_X");
    expect(parent.textContent).toContain(t("notice.detailsHint"));

    home.setDeveloperMode(true);
    const detail = parent.querySelector(".cu-notice-detail")!;
    expect(detail.textContent).toContain("COMPUTER_X: failed");
    expect(detail.textContent).not.toContain("abc123");
    expect(detail.textContent).not.toContain("sk-secretvalue123");

    home.setDeveloperMode(false);
    expect(parent.textContent).not.toContain("COMPUTER_X");
    home.dispose();
  });

  test("状态查询失败：显示原因与重试提示，开发者模式附脱敏原文", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    home.setPermissions(null, "COMPUTER_X: denied token=abc");
    home.setEngineState(null, "COMPUTER_Y: down");
    expect(parent.textContent).toContain("状态查询失败，点「刷新」重试");
    expect(parent.textContent).toContain("引擎状态不可用");
    expect(parent.textContent).not.toContain("COMPUTER_X");
    home.setDeveloperMode(true);
    expect(parent.textContent).toContain("COMPUTER_X: denied token=***");
    expect(parent.textContent).toContain("COMPUTER_Y: down");
    home.setDeveloperMode(false);
    expect(parent.textContent).not.toContain("COMPUTER_Y");
    home.dispose();
  });

  test("sanitizeDiagnostic 去掉查询参数与凭据形态", () => {
    expect(sanitizeDiagnostic("see https://x.test/a?key=1&b=2 now")).toBe("see https://x.test/a?… now");
    expect(sanitizeDiagnostic("api_key=XYZ password: hunter2")).toBe("api_key=*** password: ***");
    // 带空格的引号值、多字段 Cookie 整段遮蔽
    expect(sanitizeDiagnostic('password: "hunter 2" ok')).toBe("password: *** ok");
    const cookie = sanitizeDiagnostic("Cookie: a=1; session_id=xyz; b=2\nnext line");
    expect(cookie).toBe("Cookie: ***\nnext line");
    // JSON 序列化的错误对象：带引号的键名
    expect(sanitizeDiagnostic('{"code":"X","token":"abc","password":"p w","note":"ok"}')).toBe('{"code":"X","token":***,"password":***,"note":"ok"}');
    // URL 中的账号密码
    expect(sanitizeDiagnostic("https://user:pass@host.test/path")).toBe("https://***@host.test/path");
  });

  test("信息卡打开时切换语言：焦点留在「收起」按钮上", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const home = mountComputerHome(parent, handlers(), INFO);
    buttonByText(parent, "关于插件")!.click();
    const collapse = buttonByText(parent, "收起")!;
    collapse.focus();
    setComputerLocale("en");
    home.applyLocale();
    expect(collapse.textContent).toBe("Collapse");
    expect(document.activeElement).toBe(collapse);
    expect(parent.textContent).toContain("About Computer Control");
    home.dispose();
    parent.remove();
  });
});

describe("交互反馈与设置", () => {
  test("异步入口进行中禁用并换文案，完成后恢复，进行中点击不重复调用", async () => {
    setComputerLocale("zh");
    let release!: () => void;
    let calls = 0;
    const parent = document.createElement("div");
    const home = mountComputerHome(
      parent,
      handlers({ onStop: () => { calls += 1; return new Promise<void>((r) => (release = r)); } }),
      INFO,
    );
    const stop = parent.querySelector(".cu-danger-btn") as HTMLButtonElement;
    stop.click();
    stop.click();
    expect(calls).toBe(1);
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe("正在停止…");
    release();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(stop.disabled).toBe(false);
    expect(stop.textContent).toBe("紧急停止");
    home.dispose();
  });

  test("审计刷新进行中显示刷新中并禁用", async () => {
    setComputerLocale("zh");
    let release!: () => void;
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers({ onRefreshTrace: () => new Promise<void>((r) => (release = r)) }), INFO);
    const refresh = buttonByText(parent, "刷新")!;
    refresh.click();
    expect(refresh.disabled).toBe(true);
    expect(refresh.textContent).toBe("刷新中…");
    release();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(refresh.textContent).toBe("刷新");
    home.dispose();
  });

  test("模型档位保存失败：界面恢复为之前已生效的值并说明", async () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers({ onSaveVlm: () => Promise.reject(new Error("disk")) }), INFO);
    home.setVlmReady("text-quality");
    const select = parent.querySelector("select")!;
    select.value = "text-default";
    select.dispatchEvent(new Event("change"));
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(select.value).toBe("text-quality");
    expect(parent.querySelector(".cu-field-status")!.textContent).toBe("保存失败，仍使用 高质量文本（推荐）");
    // 状态提示随语言切换重新渲染，不残留另一种语言
    setComputerLocale("en");
    home.applyLocale();
    expect(parent.querySelector(".cu-field-status")!.textContent).toBe("Save failed; still using High-quality text (recommended)");
    home.dispose();
  });

  test("已保存的档位读回前下拉禁用，读回后开放并显示该值", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    const select = parent.querySelector("select")!;
    const start = parent.querySelector(".cu-primary-btn") as HTMLButtonElement;
    const stop = parent.querySelector(".cu-danger-btn") as HTMLButtonElement;
    expect(select.disabled).toBe(true);
    expect(start.disabled).toBe(true);
    expect(stop.disabled).toBe(false); // 紧急停止始终可用
    home.setVlmReady("text-default");
    expect(select.disabled).toBe(false);
    expect(start.disabled).toBe(false);
    expect(select.value).toBe("text-default");
    home.setTaskRunning(true);
    expect(start.disabled).toBe(true);
    home.setTaskRunning(false);
    expect(start.disabled).toBe(false);
    home.dispose();
  });

  test("任务运行显示真实步骤与已用时间，结束后隐藏", () => {
    setComputerLocale("zh");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    home.setTaskRunning(true);
    const progress = parent.querySelector(".cu-progress") as HTMLElement;
    expect(progress.hidden).toBe(false);
    expect(progress.textContent).toMatch(/^正在准备，已用 \d+ 秒$/);
    home.setTaskProgress(3);
    expect(progress.textContent).toMatch(/^正在执行第 3 步，已用 \d+ 秒$/);
    home.setTaskRunning(false);
    expect(progress.hidden).toBe(true);
    home.dispose();
  });

  test("关于插件：信息卡说明平台暂不支持打开外部页面", () => {
    setComputerLocale("en");
    const parent = document.createElement("div");
    const home = mountComputerHome(parent, handlers(), INFO);
    buttonByText(parent, "About this plugin")!.click();
    expect(parent.textContent).toContain(`https://open.reai.com/apps/${manifest.appId}`);
    expect(parent.textContent).toContain(t("settings.aboutBlocked"));
    home.dispose();
  });
});

describe("整插件语言联动（MockHost）", () => {
  test("冷启动英文，Host 切到中文后原位更新、不重建 Surface", async () => {
    setComputerLocale("zh");
    const root = document.createElement("div");
    const host = new MockHost({ manifest, locale: "en", loadApp: () => import("../src/app"), createRoot: () => root });
    try {
      await host.installAndEnable();
      const surface = await host.openSurface("main");
      const start = buttonByText(root, "Start task")!;
      expect(start).toBeDefined();
      const input = root.querySelector("textarea")!;
      input.value = "keep me";
      host.setLocale("zh");
      await Bun.sleep(0);
      expect(root.contains(start)).toBe(true); // 同一节点原位改写，未重建
      expect(start.textContent).toBe("开始任务");
      expect(input.value).toBe("keep me");
      expect(surface.readyCount).toBe(1);
    } finally {
      await host.disable();
    }
  });

  test("首屏同步就绪：状态查询未返回时已 ready；卸载后迟到结果不再写回", async () => {
    setComputerLocale("zh");
    const { BRIDGE_GLOBAL_KEY } = await import("@reai/app-sdk/v1");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const key = BRIDGE_GLOBAL_KEY as unknown as symbol;
    const previous = g[key];
    const pendingCalls: Array<(value: unknown) => void> = [];
    g[key] = { request: () => new Promise((resolve) => pendingCalls.push(resolve)) };
    const root = document.createElement("div");
    const host = new MockHost({ manifest, locale: "zh", loadApp: () => import("../src/app"), createRoot: () => root });
    try {
      await host.installAndEnable();
      const surface = await host.openSurface("main");
      expect(surface.readyCount).toBe(1);
      expect(root.textContent).toContain("检测中…");
      expect(pendingCalls.length).toBeGreaterThanOrEqual(2);
      await host.disable();
      expect(root.childElementCount).toBe(0);
      for (const resolve of pendingCalls) resolve({ accessibility: true, screenRecording: true, stopped: false, heldButtons: [], trace: [] });
      await Bun.sleep(0);
      expect(root.childElementCount).toBe(0);
    } finally {
      g[key] = previous;
    }
  });

  test("挂载失败的 AppError userMessage 随 Host 语言", async () => {
    setComputerLocale("zh");
    const host = new MockHost({
      manifest,
      locale: "en",
      loadApp: () => import("../src/app"),
      createRoot: () => {
        const root = document.createElement("div");
        root.appendChild = () => {
          throw new Error("fixture-render-unavailable");
        };
        return root;
      },
    });
    try {
      await host.installAndEnable();
      const surface = await host.openSurface("main");
      expect(surface.failure?.code).toBe("com.reai.computer/HOME_MOUNT_FAILED");
      expect(surface.failure?.userMessage).toBe("Couldn't initialize the Computer Control home page");
    } finally {
      await host.disable();
    }
  });
});
