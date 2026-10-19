import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { runApp, type HostBridge, type HostMessage } from "@reai/app-sdk/v1";
import app from "../src/app";
import manifest from "../app.manifest.json";

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
const RESOURCE_METHODS = ["resources.roots.list", "resources.roots.pick", "resources.roots.revoke", "resources.list", "resources.stat", "resources.read", "resources.write.start", "resources.write.chunk", "resources.write.commit", "resources.cancel", "resources.mkdir", "resources.rename", "resources.move", "resources.delete", "resources.createFile"];
function host(withBinding = true, coldMethod?: string, folder = false) {
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
      if (folder && method === "environment.get") return {developerMode: false, resourceFiles: {runtimeSessionId: "rt", surfaceMountId: "m1", platformCapabilities: {version: 1, capabilities: {"resources.files@1": {version: 1, available: true, methods: RESOURCE_METHODS}}}}} as never;
      if (folder && method === "resources.roots.list") return {items: [{name: "docs", resource: {resource: {provider: "local", id: "r1"}, grantRef: "g1"}}]} as never;
      if (folder && method === "agent.v2.backends.list") return {backends: [{backend: "pi", available: true, detail: ""}, {backend: "dsh", available: true, detail: ""}]} as never;
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
  expect(h.notices.filter(n=>n.method==="surface.failed")).toHaveLength(0);
  await until(()=>h.navs().length>0);
  const root = h.navs().at(-1)!;
  expect(root.breadcrumbs).toHaveLength(1);
  expect(root.breadcrumbs[0].command).toBeUndefined();
  expect(root.back).toBeUndefined();
  expect(root.menu[0].command.commandId).toBe("com.reai.pi-agent.open-settings");
  expect((await h.invoke(root.menu[0].command.commandId)).ok).toBe(true);
  await until(()=>h.navs().at(-1)?.breadcrumbs.length===2);
  const settings = h.navs().at(-1)!;
  expect(settings.breadcrumbs[0].command.commandId).toBe("com.reai.pi-agent.back-to-root");
  expect(settings.breadcrumbs[1].command).toBeUndefined();
  expect(settings.back.commandId).toBe("com.reai.pi-agent.back-to-root");
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
  await h.invoke("com.reai.pi-agent.open-settings");
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
  expect(manifest.contributes.commands.map(c=>c.id)).toContain("com.reai.pi-agent.back-to-root");
  expect(manifest.contributes.commands.map(c=>c.id)).toContain("com.reai.pi-agent.open-settings");
  expect(manifest.appId).toBe("com.reai.pi-agent");
});

test("cold mount retains one frame while busy, then becomes ready", async () => {
  const h = host(true, "pi.management.snapshot");
  await until(h.coldStarted);
  expect(h.root.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
  expect(h.root.querySelector("[data-navigation-content]")?.getAttribute("aria-busy")).toBe("true");
  h.releaseCold(); await h.ready();
  expect(h.root.querySelector("[data-navigation-content]")?.hasAttribute("aria-busy")).toBe(false);
});
test("late cold mount completion cannot replace a newer view", async () => {
  const h = host(true, "pi.management.snapshot"); await until(h.coldStarted);
  h.receive({type:"surface.unmount",surfaceMountId:"m1"});
  const other = document.createElement("div"); document.body.append(other); h.mount("m2",other);
  await h.ready(); h.releaseCold();
  for (let i=0;i<8;i++) await tick();
  expect(h.root.querySelector(".reai-surface-frame")).toBeNull();
  expect(other.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
  await h.invoke("com.reai.pi-agent.open-settings");
  await until(()=>h.navs().at(-1)?.breadcrumbs.length===2);
  expect(h.navs().at(-1)?.surfaceMountId).toBe("m2");
});

test("能力不可用时菜单保持旧样（只有设置），能力可用时出现『在文件夹中运行』子页并可返回", async () => {
  const legacy = host(); await legacy.ready();
  for (let i = 0; i < 6; i++) await tick();
  expect(legacy.navs().at(-1)!.menu.map((item: any) => item.key)).toEqual(["settings"]);

  const h = host(true, undefined, true); await h.ready();
  await until(() => h.navs().at(-1)?.menu?.some((item: any) => item.key === "folder"));
  const root = h.navs().at(-1)!;
  const entry = root.menu.find((item: any) => item.key === "folder");
  expect(entry.command.commandId).toBe(manifest.contributes.commands.find(c => c.id.endsWith("open-folder-task"))!.id);
  expect((await h.invoke(entry.command.commandId)).ok).toBe(true);
  await until(() => h.navs().at(-1)?.breadcrumbs.length === 2);
  const page = h.navs().at(-1)!;
  expect(page.breadcrumbs[1].key).toBe("folder");
  expect(page.back.commandId).toBe("com.reai.pi-agent.back-to-root");
  expect(h.root.querySelector<HTMLElement>("[data-folder-task-host]")!.hidden).toBe(false);
  expect(h.root.querySelector<HTMLElement>("[data-folder-main-host]")!.hidden).toBe(true);
  expect(h.root.querySelectorAll(".reai-surface-frame")).toHaveLength(1);
  expect((await h.invoke(page.back.commandId)).ok).toBe(true);
  await until(() => h.navs().at(-1)?.breadcrumbs.length === 1);
  expect(h.root.querySelector<HTMLElement>("[data-folder-task-host]")!.hidden).toBe(true);
  expect(h.root.querySelector<HTMLElement>("[data-folder-main-host]")!.hidden).toBe(false);
});
test("清单声明 Esc、文件夹与 Agent 能力，可选权限不影响原功能", () => {
  for (const cap of ["surface.escape@1", "agent.session@2", "cloud.model.invoke@1", "resources.files@1", "system.tasks@1"]) {
    expect(manifest.requires.hostCapabilities).toContain(cap);
  }
  for (const id of ["agent.session@2", "cloud.model.invoke@1", "resources.files@1"]) {
    expect(manifest.permissions.find(p => p.id === id)?.required).toBe(false);
  }
});
