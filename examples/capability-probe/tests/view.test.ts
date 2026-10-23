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
  view = mountProbeView(root, { port, hostVersion: Promise.resolve({ ok: true as const, version: "1.0.5" }), reportNav: (nav) => navs.push(nav) });
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

  test("总览验收卡：跑完全部后列出没通过的项", async () => {
    const { root } = mount();
    expect(root.querySelector("[data-acceptance]")?.getAttribute("data-acceptance")).toBe("pending");
    await view!.runEverything();
    view!.show("overview");
    const card = root.querySelector(".cp-accept")!;
    // 预览里按键没被触发过（等你操作），存储空间检查默认没模拟，都应列为没通过。
    expect(card.textContent).toMatch(/通过 \d+ \/ \d+ 项/);
    expect(card.textContent).toContain("键盘按键触发命令");
    expect(card.querySelectorAll(".cp-accept-list li").length).toBeGreaterThan(0);
  });

  test("结果存进插件存储：界面卸载后重新挂载还能看到；清空后不再恢复", async () => {
    const { root, port } = mount();
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='kv-oversize'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    view!.dispose();
    const again = document.createElement("div");
    document.body.append(again);
    view = mountProbeView(again, { port, hostVersion: Promise.resolve({ ok: true as const, version: "1.0.5" }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(again.querySelector(".cp-accept")?.textContent).toContain("1 项是上次保存的结果");
    view.show("basic");
    expect(again.querySelector("[data-probe='kv-oversize'] .cp-result")?.textContent).toContain("按预期拦下");
    view.show("records");
    expect(JSON.parse(again.querySelector<HTMLTextAreaElement>("textarea[aria-label='测试报告 JSON']")!.value).results[0].restored).toBe(true);
    [...again.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "清空测试结果")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(again.querySelectorAll(".cp-log-row")).toHaveLength(0);
    view.dispose();
    const third = document.createElement("div");
    document.body.append(third);
    view = mountProbeView(third, { port, hostVersion: Promise.resolve({ ok: true as const, version: "1.0.5" }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(third.querySelector(".cp-accept")?.textContent).toContain("通过 0 / 17 项");
  });

  test("换了 Driver 版本后，上次保存的结果不再恢复", async () => {
    const { root, port } = mount();
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='kv-oversize'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    view!.dispose();
    const again = document.createElement("div");
    document.body.append(again);
    view = mountProbeView(again, { port, hostVersion: Promise.resolve({ ok: true as const, version: "2.0.0" }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    view.show("basic");
    expect(again.querySelector("[data-probe='kv-oversize'] .cp-result")).toBeNull();
  });

  test("恢复还没完成时先跑了一项：其他项的历史结果照样恢复", async () => {
    const { root, port } = mount();
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='kv-oversize'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    view!.dispose();
    let release: (value: { ok: true; version: string }) => void = () => undefined;
    const again = document.createElement("div");
    document.body.append(again);
    view = mountProbeView(again, { port, hostVersion: new Promise((resolve) => { release = resolve; }) });
    view.show("basic");
    again.querySelector<HTMLButtonElement>("[data-probe='env'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release({ ok: true, version: "1.0.5" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(again.querySelector("[data-probe='env'] .cp-result")).not.toBeNull();
    expect(again.querySelector("[data-probe='kv-oversize'] .cp-result")?.textContent).toContain("按预期拦下");
  });

  test("从权限页返回：Driver 的回执记为「跳到 Driver 设置页」成功，并保存下来", async () => {
    const { root, port } = mount();
    const handled = view!.handleIntent({ type: "system-task.return", taskId: "t1", target: "app-permissions", outcome: "succeeded", payload: { probe: "capability-probe/system-task-open", at: new Date().toISOString() } });
    expect(handled).toBe(true);
    expect(view!.handleIntent({ type: "host.titlebarAction" })).toBe(false);
    view!.show("basic");
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("回执");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saved = await port.kv.get("probe.savedResults") as { results: { probeId: string }[] };
    expect(saved.results.map((item) => item.probeId)).toContain("system-task-open");
  });

  test("先到的回执不会被晚到的「已接受」盖掉；清空后晚到的旧结果不再进界面和存储", async () => {
    const { root, port } = mount();
    let release: (value: { taskId: string }) => void = () => undefined;
    port.openSystemTask = (_target, value) => {
      const at = (value as { at: string }).at;
      view!.handleIntent({ type: "system-task.return", taskId: "t1", target: "app-permissions", outcome: "failed", payload: { probe: "capability-probe/system-task-open", at } });
      return new Promise((resolve) => { release = resolve; });
    };
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='system-task-open'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release({ taskId: "t1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("没打开成功");

    view!.show("records");
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "清空测试结果")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    view!.handleIntent({ type: "system-task.return", taskId: "t2", target: "app-permissions", outcome: "succeeded", payload: { probe: "capability-probe/system-task-open", at: new Date(Date.now() - 10_000).toISOString() } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(root.querySelectorAll(".cp-log-row")).toHaveLength(0);
    expect((await port.kv.get("probe.savedResults") as { results: unknown[] }).results).toEqual([]);
  });

  test("「已接受」先到、回执后到（同一毫秒）：最终保留回执；过渡状态不保存、不进记录", async () => {
    const { root, port } = mount();
    const at = new Date().toISOString();
    let release: (value: { taskId: string }) => void = () => undefined;
    port.openSystemTask = () => new Promise((resolve) => { release = resolve; });
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='system-task-open'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release({ taskId: "t1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("等你操作");
    expect(await port.kv.get("probe.savedResults")).toBeUndefined();
    const waitingStarted = (JSON.parse((view!.show("records"), root.querySelector<HTMLTextAreaElement>("textarea[aria-label='测试报告 JSON']")!.value)).results as { probeId: string; startedAt: string }[]).find((item) => item.probeId === "system-task-open")!.startedAt;
    expect(root.querySelectorAll(".cp-log-row")).toHaveLength(0);
    view!.handleIntent({ type: "system-task.return", taskId: "t1", target: "app-permissions", outcome: "succeeded", payload: { probe: "capability-probe/system-task-open", at: waitingStarted } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    view!.show("basic");
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("回执");
    const saved = await port.kv.get("probe.savedResults") as { results: { probeId: string; outcome: string }[]; log: unknown[] };
    expect(saved.results).toEqual([expect.objectContaining({ probeId: "system-task-open", outcome: "ok" })]);
    expect(saved.log).toHaveLength(1);
    void at;
  });

  test("新一次跳转在等回执时，上一次晚到的回执不会盖掉它；新一次的回执到了才更新", async () => {
    const { root } = mount();
    view!.show("basic");
    const button = () => root.querySelector<HTMLButtonElement>("[data-probe='system-task-open'] button")!;
    button().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const firstAt = new Date(Date.now() - 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 5));
    button().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("等你操作");
    view!.handleIntent({ type: "system-task.return", taskId: "t1", target: "app-permissions", outcome: "succeeded", payload: { probe: "capability-probe/system-task-open", at: firstAt } });
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("等你操作");
    view!.handleIntent({ type: "system-task.return", taskId: "t2", target: "app-permissions", outcome: "succeeded", payload: { probe: "capability-probe/system-task-open", at: new Date().toISOString() } });
    expect(root.querySelector("[data-probe='system-task-open'] .cp-result")?.textContent).toContain("回执");
  });

  test("读不到 Driver 版本时：这次的结果不保存，也不恢复任何历史结果", async () => {
    const port = createPreviewPort({ delayMs: 0 });
    const root = document.createElement("div");
    document.body.append(root);
    view = mountProbeView(root, { port, hostVersion: Promise.resolve({ ok: false as const, code: "X" }) });
    view.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='kv-oversize'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await port.kv.get("probe.savedResults")).toBeUndefined();
  });

  test("录一句话：开始 → 听写中 → 说完了 → 显示识别文字；取消也如实显示", async () => {
    const { root } = mount();
    view!.show("basic");
    const section = () => root.querySelector("[data-probe='voice-service'] .cp-manual")!;
    const click = (label: string) => [...section().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!.click();
    expect(section().textContent).toContain("不计入 17 项验收");
    click("开始听写");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(section().textContent).toContain("听写中");
    expect(section().textContent).toMatch(/请求号\d+:/);
    click("说完了");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(section().textContent).toContain("完成");
    expect(section().textContent).toContain("这是预览里的假识别结果");
    expect(section().textContent).toContain("润色后");
    view!.show("records");
    expect(root.querySelector<HTMLTextAreaElement>("textarea[aria-label='测试报告 JSON']")!.value).not.toContain("假识别结果");
    expect(root.querySelector(".cp-log")?.textContent ?? "").not.toContain("假识别结果");
    view!.show("basic");

    click("再录一次");
    await new Promise((resolve) => setTimeout(resolve, 20));
    click("取消");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(section().textContent).toContain("已取消");
  });

  test("外脑与需要批准的探针按钮是关的，并写明原因", () => {
    const { root } = mount();
    view!.show("cloud");
    expect(root.querySelectorAll("[data-probe] .cp-locked").length).toBeGreaterThan(5);
    expect(root.querySelector("[data-probe] button")).toBeNull();
    view!.show("gated");
    expect(root.textContent).toContain("需要平台批准");
    expect(root.textContent).not.toContain("APP_CAPABILITY_NOT_GRANTED");
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

  test("设置页：底部依次是版本和关于插件，并上报面包屑；面包屑返回回到原来的根页", () => {
    const { root, navs } = mount();
    view!.show("basic");
    view!.openSettings();
    expect(navs.at(-1)).toEqual({ key: "settings", label: "设置" });
    const buttons = [...root.querySelectorAll(".cp-settings-footer button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["版本 0.2.0", "关于插件"]);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("查看版本 0.2.0 的更新日志");
    (buttons[0] as HTMLButtonElement).click();
    expect(root.querySelector(".cp-changelog")?.textContent).toContain("## 0.2.0");
    // 标题栏「打开设置」总是打开设置页，不会因为再点一次就跑回首页。
    view!.openSettings();
    view!.openSettings();
    expect(view!.currentPage).toBe("settings");
    view!.backToRoot();
    expect(view!.currentPage).toBe("basic");
    expect(navs.at(-1)).toBeNull();
  });

  test("开发者模式关闭时，报告和设置页都不出现错误码", async () => {
    const { root, port } = mount(false);
    port.versionStatus = async () => { throw Object.assign(new Error("限频"), { code: "SYSTEM_TASK_RATE_LIMITED" }); };
    view!.show("permission");
    root.querySelector<HTMLButtonElement>("[data-probe='http-undeclared'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    view!.show("records");
    const report = root.querySelector<HTMLTextAreaElement>("textarea[aria-label='测试报告 JSON']")!;
    expect(report.value).not.toContain("NETWORK_ENDPOINT_NOT_DECLARED");
    expect(root.textContent).not.toContain("下载报告");
  });

  test("同一个测试在跑时，再点或从声明式页面触发都不会并发跑第二次", async () => {
    const { root, port } = mount();
    let calls = 0;
    const original = port.kv.set.bind(port.kv);
    port.kv.set = async (key, value) => { calls += key.startsWith("probe.roundtrip.") ? 1 : 0; await new Promise((resolve) => setTimeout(resolve, 20)); return original(key, value); };
    view!.show("basic");
    root.querySelector<HTMLButtonElement>("[data-probe='kv-roundtrip'] button")!.click();
    await tick();
    expect(root.querySelector<HTMLButtonElement>("[data-probe='kv-roundtrip'] button")!.disabled).toBe(true);
    view!.show("page");
    await tick();
    const check = [...root.querySelectorAll<HTMLButtonElement>(".cp-spec-canvas button")].find((button) => button.textContent === "顺便测一下存储")!;
    check.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    expect(root.querySelector(".cp-spec-canvas")?.textContent).toContain("正在运行");
  });

  test("声明式页面区域在探针结果更新时不被重建（编辑中的内容和光标保留）", async () => {
    const { root } = mount();
    view!.show("page");
    await tick();
    const editor = root.querySelector<HTMLTextAreaElement>(".cp-spec textarea")!;
    editor.value = "{ 正在编辑";
    editor.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>("[data-probe='csp-eval'] button")!.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(root.querySelector(".cp-spec textarea")).toBe(editor);
    expect(root.querySelector(".cp-section-summary")?.textContent).toContain("与预期不同");
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
