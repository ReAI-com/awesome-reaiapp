import { expect, test } from "bun:test";
import { defineApp, runApp, type HostBridge, type HostMessage, type SurfaceHandle } from "../src/v1/index";
import { validateSurfaceNavigation } from "../src/v1/navigation";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function harness() {
  const calls: Array<{ method: string; params: any }> = [];
  const notifications: string[] = [];
  let receive!: (message: HostMessage) => void;
  const bridge: HostBridge = {
    async request(method, params) { calls.push({ method, params }); return { accepted: true, revision: (params as any)?.revision } as never; },
    notify(method) { notifications.push(method); }, subscribe(handler) { receive = handler; return () => {}; },
  };
  return { calls, notifications, bridge, send: (message: HostMessage) => receive(message) };
}
const nav = { revision: 1, breadcrumbs: [{ key: "root", label: "Reader", command: { commandId: "reader.root" } }, { key: "detail", label: "Detail" }], back: { commandId: "reader.up", input: { folder: "books" } }, menu: [{ key: "settings", label: "Settings", command: { commandId: "reader.settings" }, disabled: true }] };
test("navigation JSON allows structured inputs and mirrors 8KiB/eight-level limits", () => {
  const input=(value:unknown)=>({...nav,back:{commandId:"reader.up",input:value}});
  expect(()=>validateSurfaceNavigation(input(undefined))).not.toThrow();
  expect(()=>validateSurfaceNavigation(input({a:1,b:2,c:3,d:4,e:{items:[null,true,"book"]}}))).not.toThrow();
  expect(()=>validateSurfaceNavigation(input("é".repeat(4096)))).toThrow();
  expect(()=>validateSurfaceNavigation(input("é".repeat(4095)))).not.toThrow();
  let nested:unknown=null;for(let i=0;i<7;i++)nested={child:nested};
  expect(()=>validateSurfaceNavigation(input(nested))).not.toThrow();
  expect(()=>validateSurfaceNavigation(input({child:nested}))).toThrow();
  const cycle:any={};cycle.self=cycle;expect(()=>validateSurfaceNavigation(input(cycle))).toThrow();
});
test("presentation before mount injects trusted binding; reuse updates it; disposed handle sends nothing", async () => {
  const h = harness(); let surface!: SurfaceHandle;
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { surface = s; s.ready(); }); } }), h.bridge);
  h.send({ type: "activate", runtimeSessionId: "rt" });
  h.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p1" });
  h.send({ type: "surface.mount", surfaceId: "main", surfaceMountId: "mount", root: {} }); await tick();
  expect(surface.navigation).toBeDefined(); await surface.navigation!.register(nav);
  expect(h.calls.at(-1)?.params).toMatchObject({ runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p1", revision: 1 });
  expect(h.calls.at(-1)?.params.requestId).toBeString();
  h.send({ type: "surface.presentation", runtimeSessionId: "old", surfaceMountId: "mount", presentationToken: "bad" });
  h.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p2" });
  await surface.navigation!.clear(2); expect(h.calls.at(-1)?.params.presentationToken).toBe("p2");
  const old = surface.navigation!; h.send({ type: "surface.unmount", surfaceMountId: "mount" });
  const count = h.calls.length; await expect(old.register(nav)).rejects.toMatchObject({ code: "SURFACE_SESSION_STALE" }); expect(h.calls.length).toBe(count);
  await running.dispose();
});
test("old Host has no optional navigation; malformed registrations never reach wire", async () => {
  const h = harness(); let surface!: SurfaceHandle;
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { surface = s; }); } }), h.bridge);
  h.send({ type: "activate", runtimeSessionId: "rt" }); h.send({ type: "surface.mount", surfaceId: "main", surfaceMountId: "mount", root: {} }); await tick();
  expect(surface.navigation).toBeUndefined();
  h.send({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p" });
  for (const bad of [{ ...nav, revision: 0 }, { ...nav, extra: "forged" }, { ...nav, breadcrumbs: [{ key: "x", label: "\u202eFake" }] }, { ...nav, breadcrumbs: [{ key: "x", label: "A", command: { commandId: "reader.root" } }] }, { ...nav, breadcrumbs: [{ key: "x", label: "A" }, { key: "x", label: "B" }] }, { ...nav, breadcrumbs: [{ key: "a", label: "Ancestor" }, { key: "b", label: "Current" }] }]) {
    const count = h.calls.length; await expect(surface.navigation!.register(bad as any)).rejects.toMatchObject({ code: "SURFACE_NAV_INVALID" }); expect(h.calls.length).toBe(count);
  }
  await expect(surface.navigation!.clear(Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ code: "SURFACE_NAV_INVALID" }); await running.dispose();
});
