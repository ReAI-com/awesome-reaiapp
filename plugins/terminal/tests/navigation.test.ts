import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { runApp, type HostBridge, type HostMessage } from "@reai/app-sdk/v1";
import app from "../src/app";
import manifest from "../app.manifest.json";
import { mock } from "bun:test";
class FakeTerminal {
  static strings = {};
  options = {}; cols = 80; rows = 24;
  loadAddon() {} open() {} write() {} focus() {} dispose() {} refresh() {}
  onData() { return { dispose() {} }; }
  onTitleChange() { return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
}
mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); document.body.replaceChildren(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); }
  throw new Error("Synthetic mount did not settle");
}
function host(withBinding = true, coldMethod?: string) {
  let releaseCold!: () => void;
  const cold = new Promise<void>(resolve => releaseCold = resolve);
  let coldStarted = false;
  const calls: Array<{method: string; params: any}> = [];
  const notices: Array<{method: string; params: any}> = [];
  let receive!: (message: HostMessage) => void;
  let locale: "zh" | "en" = "zh";
  let revision = 0;
  const pi = { runtime: { state: "ready", scope: "app-bundled" }, turns: [], sessions: [], settings: { defaultModel: "text-default", appOverrides: {} } };
  const dsh = { schemaVersion: 1, revision: 1, runtime: { state: "available", code: "ready", detail: "Synthetic", target: "test", dshVersion: "1", profileVersion: "1", workspace: "synthetic", components: [] }, sessions: [] };
  const bridge: HostBridge = {
    async request(method, params) {
      calls.push({method, params});
      if (method === coldMethod && !coldStarted) { coldStarted = true; await cold; }
      const p = params as any;
      if (method === "locale.get") return {runtimeSessionId: "rt", locale, revision} as never;
      if (method === "pi.management.snapshot") return structuredClone(pi) as never;
      if (method === "pi.management.models") return {models: [], settings: pi.settings, loggedIn: true} as never;
      if (method === "dsh.observe.snapshot") return structuredClone(dsh) as never;
      if (method === "dsh.observe.settings") return {selectedModel: "text-default", options: []} as never;
      if (method === "terminal.session.list") return [{id: "synthetic-pty", sequence: 0, cwd: "synthetic"}] as never;
      if (method === "terminal.session.attach") return {token: "attachment", replayBase64: "", truncated: false, sequence: 0} as never;
      if (method === "storage.get") return {value: undefined} as never;
      if (method.startsWith("surface.navigation.")) return {accepted: true, revision: p.revision} as never;
      return {} as never;
    },
    notify(method, params) { notices.push({method, params}); },
    subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp(app, bridge);
  receive({type: "activate", runtimeSessionId: "rt", locale: {locale, revision}});
  const root = document.createElement("div"); document.body.append(root);
  const mount = (id: string, target = root) => {
    if (withBinding) receive({type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: id, presentationToken: "p-"+id});
    receive({type: "surface.mount", surfaceId: "main", surfaceMountId: id, root: target});
  };
  mount("m1");
  cleanups.push(() => running.dispose());
  const navs = () => calls.filter(c => c.method === "surface.navigation.register").map(c=>c.params);
  return {root, calls, notices, navs, receive, mount, releaseCold, coldStarted: () => coldStarted,
    ready: () => until(()=>notices.some(n=>n.method === "surface.ready" || n.method === "surface.failed")),
    async invoke(commandId: string) {
      const correlationId = "call-"+notices.length;
      receive({type:"command.invoke", correlationId, commandId, input:{}, timeoutMs:3000});
      await until(()=>notices.some(n=>n.method==="command.settled" && n.params.correlationId===correlationId));
      return notices.find(n=>n.method==="command.settled" && n.params.correlationId===correlationId)!.params;
    },
    changeLocale() { locale="en"; receive({type:"locale.changed",runtimeSessionId:"rt",locale:{locale,revision:++revision}}); },
  };
}
test("real mount registers root, settings menu, independent back and clickable ancestor", async () => {
  const h = host(); await h.ready();
  expect(h.notices.filter(n=>n.method==="surface.failed"), JSON.stringify(h.notices)).toHaveLength(0);
  await until(()=>h.navs().length>0);
  const root = h.navs().at(-1)!;
  expect(root.breadcrumbs).toHaveLength(1);
  expect(root.breadcrumbs[0].command).toBeUndefined();
  expect(root.back).toBeUndefined();
  expect(root.menu[0].command.commandId).toBe("com.reai.terminal.open-settings");
  expect((await h.invoke(root.menu[0].command.commandId)).ok).toBe(true);
  await until(()=>h.navs().at(-1)?.breadcrumbs.length===2);
  const settings = h.navs().at(-1)!;
  expect(settings.breadcrumbs[0].command.commandId).toBe("com.reai.terminal.back-to-root");
  expect(settings.breadcrumbs[1].command).toBeUndefined();
  expect(settings.back.commandId).toBe("com.reai.terminal.back-to-root");
  expect(settings.menu).toEqual([]);
  expect(settings.revision).toBeGreaterThan(root.revision);
  h.changeLocale(); await tick(); await tick();
  expect(h.navs().at(-1)?.breadcrumbs[1].label).toBe("Settings");
  expect((await h.invoke(settings.back.commandId)).ok).toBe(true);
  await until(()=>h.navs().at(-1)?.breadcrumbs.length===1);
  const revisions = h.navs().map(n=>n.revision);
  expect(new Set(revisions).size).toBe(revisions.length);
  expect(revisions).toEqual([...revisions].sort((a,b)=>a-b));
  expect(h.root.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
});
test("missing presentation uses legacy reporting and visible content back without keyboard consumption", async () => {
  const h = host(false); await h.ready();
  await h.invoke("com.reai.terminal.open-settings");
  expect(h.navs()).toHaveLength(0);
  expect(h.notices.some(n=>n.method==="surface.nav" && n.params.nav?.key==="settings")).toBe(true);
  const back = h.root.querySelector<HTMLButtonElement>("[data-navigation-back]");
  expect(back?.hidden).toBe(false);
  const key = new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true,isComposing:true});
  back?.dispatchEvent(key); expect(key.defaultPrevented).toBe(false);
  back?.click(); await tick();
  expect(h.notices.filter(n=>n.method==="surface.nav").at(-1)?.params.nav).toBeNull();
});
test("unmount, old intents and remount do not overwrite current navigation", async () => {
  const h = host(); await h.ready(); await until(()=>h.navs().length>0);
  h.receive({type:"surface.unmount",surfaceMountId:"m1"}); await tick();
  const count = h.navs().length;
  h.receive({type:"surface.intent",surfaceMountId:"m1",intent:{source:"host.titlebarAction",actionId:"settings",payload:{type:"open-settings"}}});
  const other = document.createElement("div"); document.body.append(other); h.mount("m2",other);
  await until(()=>h.navs().length>count);
  expect(h.navs().at(-1)?.surfaceMountId).toBe("m2");
  expect(h.navs().find(n=>n.surfaceMountId==="m2")?.revision).toBe(1);
  expect(h.root.querySelector(".reai-surface-frame")).toBeNull();
});
test("candidate capability and commands are declared without changing persistent identity", () => {
  expect(manifest.requires.hostCapabilities).toContain("surface.navigation@1");
  expect(manifest.hostApi.range).toBe(">=1.25.0 <2.0.0");
  expect(manifest.contributes.commands.map(c=>c.id)).toContain("com.reai.terminal.back-to-root");
  expect(manifest.contributes.commands.map(c=>c.id)).toContain("com.reai.terminal.open-settings");
  expect(manifest.appId).toBe("com.reai.terminal");
});

test("cold mount retains one frame while busy, then becomes ready", async () => {
  const h = host(true, "terminal.session.list");
  await until(h.coldStarted);
  expect(h.root.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
  expect(h.root.querySelector("[data-navigation-content]")?.getAttribute("aria-busy")).toBe("true");
  h.releaseCold(); await h.ready();
  expect(h.root.querySelector("[data-navigation-content]")?.hasAttribute("aria-busy")).toBe(false);
});
test("late cold mount completion cannot replace a newer view", async () => {
  const h = host(true, "terminal.session.list"); await until(h.coldStarted);
  h.receive({type:"surface.unmount",surfaceMountId:"m1"});
  const other = document.createElement("div"); document.body.append(other); h.mount("m2",other);
  await h.ready(); h.releaseCold();
  for (let i=0;i<8;i++) await tick();
  expect(h.root.querySelector(".reai-surface-frame")).toBeNull();
  expect(other.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
  await h.invoke("com.reai.terminal.open-settings");
  await until(()=>h.navs().at(-1)?.breadcrumbs.length===2);
  expect(h.navs().at(-1)?.surfaceMountId).toBe("m2");
});
test("surface.escape@1：只在真关掉插件内弹层时消费 Esc，无弹层与 PTY 内的 Esc 原样放行", async () => {
  expect(manifest.requires.hostCapabilities).toContain("surface.escape@1");
  const h = host(); await h.ready();
  const press = (target: EventTarget) => {
    const key = new KeyboardEvent("keydown", {key: "Escape", bubbles: true, cancelable: true});
    target.dispatchEvent(key);
    return key.defaultPrevented;
  };
  const context = h.root.querySelector<HTMLElement>(".terminal-tab-context")!;
  const dialog = h.root.querySelector<HTMLElement>(".terminal-tab-name-dialog")!;
  // 没有弹层：不消费，交给 Host 单次 Esc 仲裁回退一层。
  expect(press(document.body)).toBe(false);
  // 打开的右键菜单：Esc 关掉它并消费，一次只退一层。
  context.hidden = false;
  expect(press(document.body)).toBe(true);
  expect(context.hidden).toBe(true);
  // 命名弹窗优先于菜单关闭。
  dialog.hidden = false; context.hidden = false;
  expect(press(document.body)).toBe(true);
  expect(dialog.hidden).toBe(true);
  expect(context.hidden).toBe(false);
  context.hidden = true;
  // PTY（.xterm）里的 Esc 属于 shell：即使有弹层也不处理。
  const xterm = document.createElement("div"); xterm.className = "xterm"; h.root.append(xterm);
  context.hidden = false;
  expect(press(xterm)).toBe(false);
  expect(context.hidden).toBe(false);
});
