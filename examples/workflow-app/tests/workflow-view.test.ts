import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LocaleClient, LocaleSnapshot } from "@reai/app-sdk/v1";
import { mountWorkflowView } from "../src/workflow-view";
import { WorkflowError, type RunClient } from "../src/run-client";
GlobalRegistrator.register();
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(stop => stop()); document.body.replaceChildren(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const root = () => { const node = document.createElement("div"); document.body.append(node); return node; };
const button = (node: HTMLElement, action: string) => node.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
const fill = (node: HTMLElement) => { node.querySelector<HTMLInputElement>('[data-field="document"]')!.value = "document-a"; };
const client = (patch: Partial<RunClient> = {}): RunClient => ({ create: async () => ({ runId: "run-1" }), read: async () => ({ id: "run-1", status: "running", data: {} }), resume: async () => ({ ok: true, initialSequence: 1 }), cancel: async () => ({ ok: true, status: "cancelling" }), ...patch });
describe("Surface-owned workflow UI", () => {
  test("idle无请求，unknown create固定输入/requestId重试，禁止双击", async () => {
    const node = root(); const calls: Array<unknown[]> = []; let resolve: (value: { runId: string }) => void = () => {};
    const api = client({ create: async (...args) => { calls.push(args); if (calls.length === 1) throw new WorkflowError("NETWORK_TIMEOUT", 0, true); return new Promise(done => { resolve = done; }); } });
    cleanup.push(mountWorkflowView(node, api)); expect(calls.length).toBe(0); fill(node);
    button(node,"start").click(); await tick(); expect(node.textContent).toContain("结果未知");
    expect(node.querySelector<HTMLInputElement>('[data-field="document"]')!.disabled).toBe(true);
    button(node,"start").click(); button(node,"start").click(); await tick(); expect(calls.length).toBe(2);
    expect(calls[0]!.slice(0,3)).toEqual(calls[1]!.slice(0,3));
    resolve({ runId: "run-1" }); await tick(); expect(button(node,"start").disabled).toBe(true);
  });
  test("取消受理不称终止，手动read终态，JSON只写文本", async () => {
    const node = root(); let terminal = false;
    cleanup.push(mountWorkflowView(node, client({ read: async () => ({ id: "run-1", status: terminal ? "cancelled" : "success", data: { output: { value: '<img src=x onerror="alert(1)">' } } }) }))); fill(node);
    button(node,"start").click(); await tick(); button(node,"cancel").click(); await tick();
    expect(node.querySelector('[role="status"]')!.textContent).toContain("已受理取消");
    button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(false);
    expect(node.querySelector("img")).toBeNull(); terminal = true;
    button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(true);
    expect(node.textContent).toContain("运行已取消");
  });
  test("继续或取消结果未知时禁止再次继续，读取确认成功后才恢复", async () => {
    const node = root(); let resumes = 0; let readFails = true;
    cleanup.push(mountWorkflowView(node, client({
      read: async () => { if (readFails) throw new WorkflowError("NETWORK_TIMEOUT", 0, true); return { id: "run-1", status: "interrupted", data: {} }; },
      resume: async () => { resumes++; throw new WorkflowError("NETWORK_TIMEOUT", 0, true); },
      cancel: async () => { throw new WorkflowError("NETWORK_TIMEOUT", 0, true); },
    }))); fill(node);
    button(node,"start").click(); await tick();
    readFails = false; button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(false);
    button(node,"resume").click(); await tick(); expect(resumes).toBe(1); expect(node.textContent).toContain("结果未知");
    expect(button(node,"resume").disabled).toBe(true);
    button(node,"resume").click(); await tick(); expect(resumes).toBe(1);
    readFails = true; button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(true);
    readFails = false; button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(false);
    button(node,"cancel").click(); await tick(); expect(button(node,"resume").disabled).toBe(true);
    button(node,"refresh").click(); await tick(); expect(button(node,"resume").disabled).toBe(false);
  });
  test("卸载abort HTTP并忽略迟到create，不自动取消云run/不遗留locale监听", async () => {
    const node = root(); let signal: AbortSignal | undefined; let resolve: (value: { runId: string }) => void = () => {}; let cancelled = 0; let listeners = 0;
    const locale: LocaleClient = { getSnapshot: () => ({ locale: "en", revision: 0 }), onChange: callback => { listeners++; callback({ locale:"en", revision:0 }); return () => { listeners--; }; } };
    const stop = mountWorkflowView(node, client({ create: async (...args) => { signal = args[3]; return new Promise(done => { resolve = done; }); }, cancel: async () => { cancelled++; return { ok:true, status:"cancelling" }; } }), locale);
    fill(node); button(node,"start").click(); await tick(); stop(); expect(signal?.aborted).toBe(true); expect(listeners).toBe(0);
    resolve({ runId:"late-run" }); await tick(); expect(node.childElementCount).toBe(0); expect(cancelled).toBe(0);
  });
  test("live locale更新不重建run，scope拒绝可修正输入，无后台重试", async () => {
    const node = root(); let callback: (snapshot: LocaleSnapshot) => void = () => {}; let count=0;
    const locale: LocaleClient = { getSnapshot:()=>({locale:"zh",revision:0}), onChange:handler=> { callback=handler; return ()=>{}; } };
    cleanup.push(mountWorkflowView(node,client({ create:async()=>{ count++; throw new WorkflowError("insufficient_scope",403); } }),locale)); fill(node);
    button(node,"start").click(); await tick(); callback({locale:"en",revision:1});
    expect(button(node,"start").textContent).toBe("Create run"); expect(node.textContent).toContain("insufficient_scope"); expect(count).toBe(1);
  });
});
