import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createPreviewPort } from "../src/preview-port";
import { safeProbes } from "../src/probes";
import { mountProbeView, type ProbeView } from "../src/view";

let ownsDom = false;
beforeAll(() => {
  if (typeof document === "undefined") {
    // 探针会尝试加载脚本和 iframe；测试环境只需要「没加载成功」这个结果，关掉 happy-dom 的真实加载与报错。
    GlobalRegistrator.register({ settings: { disableJavaScriptFileLoading: true, disableIframePageLoading: true, handleDisabledFileLoadingAsSuccess: true } });
    ownsDom = true;
  }
});
afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

let view: ProbeView | undefined;
beforeEach(() => {
  view?.dispose();
  document.body.replaceChildren();
});

function mount(developerMode = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const navs: ({ key: string; label: string } | null)[] = [];
  const port = createPreviewPort({ delayMs: 0, developerMode, voiceInstalled: true });
  view = mountProbeView(root, { port, hostVersion: Promise.resolve("1.0.5"), reportNav: (nav) => navs.push(nav) });
  return { root, navs, port };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("能力探针界面", () => {
  test("总览显示四档数量，没有第二层标题栏", () => {
    const { root } = mount();
    expect(root.querySelectorAll(".cp-tile")).toHaveLength(4);
    expect(root.querySelector(".main-body")).not.toBeNull();
    expect(root.querySelector(".main-title")).toBeNull();
  });

  test("「全部测试」逐个运行安全探针并显示结果与进度后清空进度", async () => {
    const { root } = mount();
    const done = view!.runSafe();
    await tick();
    expect(root.textContent).toMatch(/第 \d+ 个 \/ 共 \d+ 个/);
    await done;
    expect(root.textContent).toContain(`成功`);
    view!.show("records");
    expect(root.querySelectorAll(".cp-log-row")).toHaveLength(safeProbes().length);
    const report = root.querySelector<HTMLTextAreaElement>("textarea[aria-label='测试报告 JSON']")!;
    expect(JSON.parse(report.value).results).toHaveLength(safeProbes().length);
  });

  test("外脑与需要批准的探针按钮是关的，并写明原因", () => {
    const { root } = mount();
    view!.show("cloud");
    expect(root.querySelectorAll("[data-probe] .cp-locked").length).toBeGreaterThan(5);
    expect(root.querySelector("[data-probe] button")).toBeNull();
    view!.show("gated");
    expect(root.textContent).toContain("APP_CAPABILITY_NOT_GRANTED");
  });

  test("诊断信息只在开发者模式显示", async () => {
    const { root, port } = mount(false);
    view!.show("permission");
    root.querySelector<HTMLButtonElement>("[data-probe='http-undeclared'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(root.querySelector("[data-probe='http-undeclared'] .cp-diag")).toBeNull();
    port.setDeveloperMode(true);
    expect(root.querySelector("[data-probe='http-undeclared'] .cp-diag")?.textContent).toContain("NETWORK_ENDPOINT_NOT_DECLARED");
  });

  test("设置页：底部依次是版本和关于插件，并上报面包屑", () => {
    const { root, navs } = mount();
    view!.toggleSettings();
    expect(navs.at(-1)).toEqual({ key: "settings", label: "设置" });
    const buttons = [...root.querySelectorAll(".cp-settings-footer button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["版本 0.1.0", "关于插件"]);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("查看版本 0.1.0 的更新日志");
    (buttons[0] as HTMLButtonElement).click();
    expect(root.querySelector(".cp-changelog")?.textContent).toContain("## 0.1.0");
    view!.toggleSettings();
    expect(view!.currentPage).toBe("overview");
    expect(navs.at(-1)).toBeNull();
  });

  test("声明式页面：示例被画出来，表单写入后数字跟着变；反例不画并列出问题", async () => {
    const { root } = mount();
    view!.show("page");
    await tick();
    const canvas = root.querySelector(".cp-spec-canvas")!;
    expect(canvas.querySelector(".cp-page-title")?.textContent).toBe("访客登记（示例）");
    const input = canvas.querySelector<HTMLInputElement>("input[name='name']")!;
    input.value = "小王";
    canvas.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(canvas.querySelector(".cp-page-metric-value")?.textContent).toBe("小王");
    const bad = [...root.querySelectorAll<HTMLButtonElement>(".cp-spec button")].find((button) => button.textContent === "反例：调用不存在的动作")!;
    bad.click();
    expect(root.querySelector(".cp-spec-problems")?.textContent).toContain("shell.exec");
    expect(canvas.querySelector(".cp-page-title")).toBeNull();
  });

  test("页面里没有内联 style 属性（Driver 的安全策略会拦）", async () => {
    const { root } = mount();
    for (const page of ["overview", "basic", "permission", "page", "cloud", "gated", "capabilities", "official", "records", "settings"] as const) {
      view!.show(page);
      await tick();
      expect(root.querySelector("[style]")).toBeNull();
    }
  });
});
