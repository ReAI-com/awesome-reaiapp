import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHost } from "@reai/app-test/v1";
import type { HostMessage } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { DEFAULT_SETTINGS, SOURCE_MIGRATION_KEY, SOURCE_SELECTION_KEY } from "../src/data";

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("actual Voice mount publishes SDK navigation and real ancestor/back commands; settings toggles and remounts cleanly", async () => {
  const host = new MockHost({ manifest: structuredClone(manifest) as never, loadApp: () => import("../src/app"), createRoot: () => { const root = document.createElement("div"); document.body.append(root); return root; } });
  const storage = (host as unknown as { storage: Map<string, unknown> }).storage;
  for (const [key, value] of Object.entries({ settings: DEFAULT_SETTINGS, "recognition-engine-choice-v1": "local", [SOURCE_MIGRATION_KEY]: 1, [SOURCE_SELECTION_KEY]: 2 })) storage.set(`com.reai.voice/voice-state/${key}`, structuredClone(value));
  const calls: Array<{ method: string; params: any }> = [];
  const request = host.bridge.request;
  host.bridge.request = async (method, params, options) => {
    if (method.startsWith("surface.navigation.")) { calls.push({ method, params }); return { accepted: true, revision: (params as any).revision } as never; }
    return request(method, params, options);
  };
  // MockHost lacks presentation delivery. Inject that trusted Host message through its
  // public bridge subscription, so production Voice receives the real SDK adapter.
  const subscribe = host.bridge.subscribe; let runtimeSessionId = "";
  host.bridge.subscribe = handler => subscribe(message => {
    if (message.type === "activate") runtimeSessionId = message.runtimeSessionId;
    if (message.type === "surface.mount") handler({ type: "surface.presentation", runtimeSessionId, surfaceMountId: message.surfaceMountId, presentationToken: `synthetic-${message.surfaceMountId}` } as HostMessage);
    handler(message);
  });
  await host.installAndEnable(); const surface = await host.openSurface("main");
  try {
    await tick(); expect(calls.at(-1)!.params.breadcrumbs.map((item: any) => item.key)).toEqual(["root"]);
    await host.invokeCommand("com.reai.voice.open-settings"); await tick();
    surface.root!.querySelector<HTMLButtonElement>(".voice-events-entry")!.click(); await tick();
    const events = calls.at(-1)!.params;
    expect(events.breadcrumbs.map((item: any) => item.key)).toEqual(["root", "settings", "events"]);
    expect(events.back).toEqual({ commandId: "com.reai.voice.open-settings" });
    await host.invokeCommand(events.back.commandId); await tick(); expect(surface.root!.querySelector(".voice-settings-view")).not.toBeNull();
    await host.sendIntent(surface.surfaceMountId, { source: "host.titlebarAction", actionId: "settings", payload: { type: "open-settings" } }); await tick();
    expect(calls.at(-1)!.params.breadcrumbs).toHaveLength(1);
    await host.invokeCommand("com.reai.voice.open-settings"); host.setLocale("en"); await tick();
    expect(calls.at(-1)!.params.breadcrumbs.at(-1).label).toBe("Settings");
    await host.invokeCommand("com.reai.voice.back-to-root"); await tick();
    expect(calls.at(-1)!.params.breadcrumbs).toHaveLength(1);
  } finally { await host.unmountSurface(surface.surfaceMountId); await tick(); }
  const firstCount = calls.length;
  host.setLocale("zh"); await tick(); expect(calls).toHaveLength(firstCount);
  const next = await host.openSurface("main"); await tick();
  expect(calls.at(-1)!.params).toMatchObject({ revision: 1, surfaceMountId: next.surfaceMountId, presentationToken: `synthetic-${next.surfaceMountId}` });
  await host.unmountSurface(next.surfaceMountId); await host.disable();
});
