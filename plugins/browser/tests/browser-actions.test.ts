import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { AppError, BRIDGE_GLOBAL_KEY, type AppContext, type SurfaceHandle } from "@reai/app-sdk/v1";
import app from "../src/app";
import { browserCall } from "../src/browser-bridge";

beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
const globalBridge = globalThis as unknown as Record<string, unknown>;
const previousBridge = globalBridge[BRIDGE_GLOBAL_KEY];
afterEach(() => { globalBridge[BRIDGE_GLOBAL_KEY] = previousBridge; document.body.replaceChildren(); });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const empty = { tabs: [], activeTabId: null, agentTabId: null };

async function mount(request: (method: string, params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>) {
  let mountHandler: ((surface: SurfaceHandle) => unknown) | undefined;
  let environmentListener: ((value: { developerMode: boolean }) => void) | undefined;
  const ctx = {
    commands: { register: () => undefined },
    surfaces: { register: (_id: string, handler: typeof mountHandler) => { mountHandler = handler; } },
    locale: { getSnapshot: () => ({ locale: "zh" }), onChange: () => () => undefined },
    environment: { get: async () => ({ developerMode: false }), onChange: (fn: typeof environmentListener) => { environmentListener = fn; return () => { environmentListener = undefined; }; } },
    systemTasks: { getVersionStatus: async () => ({ app: { currentVersion: "1.0.5" } }) },
  } as unknown as AppContext;
  await app.activate!(ctx);
  globalBridge[BRIDGE_GLOBAL_KEY] = { request };
  const root = document.createElement("div"); document.body.append(root);
  const cleanup = await mountHandler!({ root, ready: () => undefined, fail: (e: unknown) => { throw e; }, onIntent: () => () => undefined } as unknown as SurfaceHandle);
  return { root, cleanup: cleanup as () => void, environment: (developerMode: boolean) => environmentListener?.({ developerMode }) };
}

test("bridge 缺失返回带稳定代码的 AppError", async () => {
  delete globalBridge[BRIDGE_GLOBAL_KEY];
  const error = await browserCall("browser.state").catch(e => e);
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe("com.reai.browser/BRIDGE_UNAVAILABLE");
});

test("bridge 转交取消 signal，已取消的请求不发送", async () => {
  const signal = new AbortController(); let seen: AbortSignal | undefined; let calls = 0;
  globalBridge[BRIDGE_GLOBAL_KEY] = { request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => { calls++; seen = options?.signal; return {}; } };
  await browserCall("browser.panel.open", {}, { signal: signal.signal });
  expect(seen).toBe(signal.signal);
  signal.abort();
  await expect(browserCall("browser.panel.open", {}, { signal: signal.signal })).rejects.toBeDefined();
  expect(calls).toBe(1);
});

test("新建失败保留真实终态，重复点击只请求一次，刷新后恢复", async () => {
  let rejectNew: ((error: unknown) => void) | undefined; let newCalls = 0;
  const view = await mount(async method => {
    if (method === "browser.tab.new") { newCalls++; return await new Promise((_resolve, reject) => { rejectNew = reject; }); }
    return empty;
  });
  await tick();
  const button = view.root.querySelector<HTMLButtonElement>(".rb-btn:not(.primary)")!;
  button.click(); button.dispatchEvent(new Event("click"));
  expect(button.disabled).toBe(true);
  expect(button.textContent).toContain("正在");
  expect(newCalls).toBe(1);
  rejectNew!(new Error("ENGINE_TIMEOUT secret-internal-detail")); await tick();
  const status = view.root.querySelector<HTMLElement>(".rb-status")!;
  expect(status.classList.contains("error")).toBe(true);
  expect(status.textContent).toContain("超时");
  expect(status.textContent).not.toContain("secret-internal-detail");
  view.root.querySelector<HTMLButtonElement>(".rb-refresh")!.click(); await tick();
  expect(status.classList.contains("error")).toBe(false);
  view.cleanup();
});

test("开发者模式关闭立即隐藏诊断，真实标题仍可见", async () => {
  const view = await mount(async method => {
    if (method === "browser.state") return { tabs: [{ tabId: 1, title: "ENGINE_TIMEOUT 是文章标题", url: "https://example.com", loading: false, openedByAgent: false }], activeTabId: 1, agentTabId: null };
    throw new Error("ENGINE_TIMEOUT credential=secret");
  });
  await tick(); view.root.querySelector<HTMLButtonElement>(".rb-btn.primary")!.click(); await tick();
  expect(view.root.textContent).toContain("ENGINE_TIMEOUT 是文章标题");
  view.environment(true); await tick();
  const diagnostic = view.root.querySelector<HTMLElement>(".rb-diagnostic")!;
  expect(diagnostic.hidden).toBe(false);
  expect(diagnostic.textContent).toContain("ENGINE_TIMEOUT");
  expect(diagnostic.textContent).not.toContain("credential=secret");
  view.environment(false);
  expect(diagnostic.hidden).toBe(true);
  expect(diagnostic.textContent).toBe("");
  view.cleanup();
});

test("卸载取消在途操作，迟到结果不再写 DOM", async () => {
  let resolveNew: ((value: unknown) => void) | undefined; let operationSignal: AbortSignal | undefined;
  const view = await mount(async (method, _params, options) => {
    if (method === "browser.tab.new") { operationSignal = options?.signal; return await new Promise(resolve => { resolveNew = resolve; }); }
    return empty;
  });
  await tick(); view.root.querySelector<HTMLButtonElement>(".rb-btn:not(.primary)")!.click();
  view.cleanup();
  expect(operationSignal?.aborted).toBe(true);
  resolveNew!({}); await tick();
  expect(view.root.children.length).toBe(0);
});

 test("初次状态请求超过一秒显示真实用时，卸载立即取消", async () => {
  let resolveState: ((value: unknown) => void) | undefined; let signal: AbortSignal | undefined;
  const view = await mount(async (_method, _params, options) => {
    signal = options?.signal;
    return await new Promise(resolve => { resolveState = resolve; });
  });
  expect(view.root.querySelector(".rb-status")?.textContent).toContain("正在读取");
  expect(view.root.querySelector<HTMLElement>(".rb-progress")?.hidden).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(view.root.querySelector(".rb-status")?.textContent).toContain("已用 1 秒");
  expect(view.root.querySelector<HTMLElement>(".rb-progress")?.hidden).toBe(false);
  expect(view.root.textContent).not.toContain("%");
  view.cleanup(); expect(signal?.aborted).toBe(true);
  resolveState!(empty); await tick(); expect(view.root.children.length).toBe(0);
});

 test("真实注册的 Command 将 invocation signal 传给 Host", async () => {
  let command: ((invocation: { signal: AbortSignal }) => Promise<unknown>) | undefined;
  await app.activate!({ commands: { register: (_id: string, handler: typeof command) => { command = handler; } }, surfaces: { register: () => undefined } } as unknown as AppContext);
  const controller = new AbortController(); let seen: AbortSignal | undefined;
  globalBridge[BRIDGE_GLOBAL_KEY] = { request: async (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => { seen = options?.signal; return {}; } };
  expect(await command!({ signal: controller.signal })).toEqual({ status: "ok" });
  expect(seen).toBe(controller.signal);
});
