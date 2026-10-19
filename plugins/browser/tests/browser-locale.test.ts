/**
 * 语言包与视图双语回归：
 * - zh/en 资源同键同插值（严格结构一致性在 reai-app-i18n validate 再守一道）；
 * - t() 插值、未知语言回退英文、缺键告警返回键名；
 * - 真实视图双语 DOM、原位更新（节点/焦点保留）、错误前缀保留原始详情；
 * - 挂载失败与 bridge 缺失两类受控错误随语言翻译。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import { setBrowserLocale, t } from "../src/browser-i18n";
import { browserCall } from "../src/browser-bridge";
import {
  applyBrowserHomeLocale,
  mountBrowserHome,
  refreshBrowserHome,
  type BrowserHomeHandlers,
} from "../src/browser-view";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    GlobalRegistrator.register();
    ownsDom = true;
  }
});
afterAll(() => {
  setBrowserLocale("zh");
  if (ownsDom) GlobalRegistrator.unregister();
});

function leafPaths(value: unknown, prefix = ""): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: prefix, text: value }];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

const noOPHandlers: BrowserHomeHandlers = {
  onOpenDrawer: () => undefined,
  onNewTab: () => undefined,
  onRefresh: () => undefined,
  onSelectTab: () => undefined,
  onCloseTab: () => undefined,
};

describe("语言资源结构", () => {
  test("zh 与 en 叶子路径与插值变量一一对应", () => {
    const zhLeaves = leafPaths(zh);
    const enLeaves = leafPaths(en);
    expect(enLeaves.map((leaf) => leaf.path)).toEqual(zhLeaves.map((leaf) => leaf.path));
    for (const zhLeaf of zhLeaves) {
      const enLeaf = enLeaves.find((candidate) => candidate.path === zhLeaf.path)!;
      expect(placeholders(enLeaf.text)).toEqual(placeholders(zhLeaf.text));
      expect(zhLeaf.text.length).toBeGreaterThan(0);
    }
  });

  test("manifest 的 i18n 声明只引用存在的资源键", () => {
    const messages = manifest.i18n?.messages ?? [];
    expect(messages.length).toBeGreaterThan(0);
    const zhTable = zh as Record<string, unknown>;
    for (const message of messages) {
      let value: unknown = zhTable;
      for (const part of message.key.split(".")) {
        value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
      }
      expect([message.key, typeof value === "string"]).toEqual([message.key, true]);
    }
  });
});

describe("t() 行为", () => {
  test("插值参数按普通文本替换", () => {
    setBrowserLocale("zh");
    expect(t("tabs.titleFallback", { tabId: 7 })).toBe("标签 7");
    setBrowserLocale("en");
    expect(t("tabs.titleFallback", { tabId: 7 })).toBe("Tab 7");
  });

  test("未知语言回退英文", () => {
    setBrowserLocale("fr");
    expect(t("home.openBrowser")).toBe("Open Browser");
  });

  test("缺键回退英文资源，仍缺返回键名", () => {
    setBrowserLocale("zh");
    expect(t("tabs.empty")).toBe("还没有打开的标签。");
    expect(t("not.a.real.key")).toBe("not.a.real.key");
  });
});

describe("真实视图双语 DOM", () => {
  test("首屏随当前语言渲染，切换原位更新并保留节点与焦点", () => {
    setBrowserLocale("zh");
    const parent = document.createElement("div");
    document.body.append(parent);
    try {
    const home = mountBrowserHome(parent, noOPHandlers);
    expect(home.introEl.textContent).toBe("Agent 的网页操作会以半屏抽屉呈现；引擎只放行 https。");
    expect(home.openBtn.textContent).toBe("打开浏览器");
    expect(home.refreshBtn.textContent).toBe("刷新");

    refreshBrowserHome(home, {
      tabs: [
        { tabId: 1, url: "https://example.com/", title: "Example Domain", loading: false, openedByAgent: false },
        { tabId: 2, url: "", title: "", loading: true, openedByAgent: true },
      ],
      activeTabId: 1,
      agentTabId: 2,
    });
    const rows = Array.from(home.listEl.querySelectorAll<HTMLElement>(".rb-tab"));
    expect(rows[0]!.textContent).toContain("Example Domain");
    expect(rows[1]!.querySelector<HTMLElement>(".rb-tab-title")!.textContent).toBe("标签 2");
    const workBadge = rows[1]!.querySelector<HTMLElement>(".rb-tab-badge.work")!;
    expect(workBadge.textContent).toBe("工作标签");
    const close = rows[0]!.querySelector<HTMLElement>(".rb-tab-close")!;
    expect(close.getAttribute("title")).toBe("关闭标签");
    expect(close.getAttribute("aria-label")).toBe("关闭标签");

    const focused = rows[1]!.querySelector<HTMLButtonElement>(".rb-tab-select")!;
    focused.focus();
    setBrowserLocale("en");
    applyBrowserHomeLocale(home);
    const rowsAfter = Array.from(home.listEl.querySelectorAll<HTMLElement>(".rb-tab"));
    expect(rowsAfter[0]).toBe(rows[0]);
    expect(rowsAfter[1]).toBe(rows[1]);
    expect(home.introEl.textContent).toBe("Agent web actions appear in a half-screen drawer; the engine allows https only.");
    expect(home.openBtn.textContent).toBe("Open Browser");
    expect(home.newTabBtn.textContent).toBe("New Tab");
    expect(home.linksTitleEl.textContent).toBe("Quick Links");
    expect(home.tabsTitleEl.firstChild?.textContent).toBe("Open Tabs");
    expect(home.refreshBtn.textContent).toBe("Refresh");
    expect(rowsAfter[0]!.textContent).toContain("Example Domain");
    expect(rowsAfter[1]!.querySelector<HTMLElement>(".rb-tab-title")!.textContent).toBe("Tab 2");
    expect(rowsAfter[1]!.querySelector<HTMLElement>(".rb-tab-badge")!.textContent).toBe("Agent");
    expect(rowsAfter[1]!.querySelector<HTMLElement>(".rb-tab-badge.work")!.textContent).toBe("Working tab");
    expect(rowsAfter[0]!.querySelector<HTMLElement>(".rb-tab-close")!.getAttribute("title")).toBe("Close tab");
    expect(rowsAfter[0]!.classList.contains("active")).toBe(true);
    expect(document.activeElement).toBe(focused);

    // 重复应用同一语言幂等；未知语言回退英文。
    applyBrowserHomeLocale(home);
    setBrowserLocale("fr");
    applyBrowserHomeLocale(home);
    expect(home.openBtn.textContent).toBe("Open Browser");
    expect(rowsAfter[1]!.querySelector<HTMLElement>(".rb-tab-title")!.textContent).toBe("Tab 2");
    } finally {
      parent.remove();
    }
  });

  test("空态与失败态跟随语言，普通模式隐藏原始详情", () => {
    setBrowserLocale("zh");
    const parent = document.createElement("div");
    const home = mountBrowserHome(parent, noOPHandlers);
    refreshBrowserHome(home, { tabs: [], activeTabId: null, agentTabId: null });
    expect(home.statusEl.textContent).toBe("还没有打开的标签。");
    refreshBrowserHome(home, null, "engine-offline-原始诊断");
    expect(home.statusEl.textContent).toBe("浏览器暂时无法连接，请刷新重试。");
    expect(home.statusEl.classList.contains("error")).toBe(true);
    setBrowserLocale("en");
    applyBrowserHomeLocale(home);
    expect(home.statusEl.textContent).toBe("Cannot connect to Browser. Refresh to retry.");
    refreshBrowserHome(home, { tabs: [], activeTabId: null, agentTabId: null });
    expect(home.statusEl.textContent).toBe("No tabs are open yet.");
    expect(home.statusEl.classList.contains("error")).toBe(false);
  });
});

describe("受控错误随语言", () => {
  test("bridge 缺失错误使用当前语言文案", () => {
    setBrowserLocale("en");
    expect(browserCall("browser.state").catch((cause: { userMessage: string }) => cause.userMessage)).resolves.toBe(
      "Cannot connect to Browser. Open the plugin again.",
    );
    setBrowserLocale("zh");
    expect(browserCall("browser.state").catch((cause: { userMessage: string }) => cause.userMessage)).resolves.toBe(
      "暂时无法连接浏览器，请重新打开插件。",
    );
  });

  test("挂载失败的 AppError userMessage 随 Host 语言且保留原因", async () => {
    setBrowserLocale("zh");
    const host = new MockHost({
      manifest,
      locale: "en",
      loadApp: () => import("../src/app"),
      createRoot: () => {
        const root = document.createElement("div");
        root.append = () => {
          throw new Error("fixture-render-unavailable");
        };
        return root;
      },
    });
    try {
      await host.installAndEnable();
      const surface = await host.openSurface("main");
      expect(surface.failCount).toBe(1);
      expect(surface.failure?.code).toBe("com.reai.browser/HOME_MOUNT_FAILED");
      expect(surface.failure?.userMessage).toBe("Could not open the Browser home");
      expect(surface.failure?.diagnostic).toContain("fixture-render-unavailable");
    } finally {
      await host.disable();
    }
  });
});

describe("资源文件本体", () => {
  test("两个语言文件都是严格 UTF-8 JSON", () => {
    const root = join(import.meta.dir, "..");
    for (const name of ["zh.json", "en.json"]) {
      const bytes = readFileSync(join(root, "assets/locales", name));
      // 逐字节 fatal 解码：任何非法 UTF-8 序列都会抛错。
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // 重复键在 JSON.parse 里会被静默覆盖，语法与重复键的严格检查
      // 由 reai-app-i18n validate 负责；这里至少守住可解析。
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });
});
