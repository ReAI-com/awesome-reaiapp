import { expect, test } from "bun:test";
import { defineApp, runApp, type HostBridge, type HostMessage, type SurfaceHandle } from "@reai/app-sdk/v1";
import { createVoiceSurfaceNavigation, type VoiceNavigationLabels } from "../src/voice-surface-navigation";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const labels: VoiceNavigationLabels = { root: "Voice", detail: "Input", translation: "Translation", chat: "Commands", context: "Recordings", settings: "Settings", events: "Events", models: "Models", audioSettings: "Audio settings" };
async function harness(presentation = true) {
  const calls: Array<{ method: string; params: any }> = [];
  let receive!: (message: HostMessage) => void;
  let block: (() => Promise<void>) | undefined;
  const bridge: HostBridge = {
    async request(method, params) { calls.push({ method, params }); await block?.(); return { accepted: true, revision: (params as any)?.revision } as never; },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  let surface!: SurfaceHandle;
  const running = runApp(defineApp({ activate(ctx) { ctx.surfaces.register("main", s => { surface = s; s.ready(); }); } }), bridge);
  receive({ type: "activate", runtimeSessionId: "rt" });
  if (presentation) receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p1" });
  receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "mount", root: {} }); await tick();
  return { calls, surface, running, receive, setBlock: (value?: () => Promise<void>) => { block = value; } };
}

test("all Voice pages use validated root/leaf paths; settings descendants return to settings", async () => {
  const h = await harness(); const nav = createVoiceSurfaceNavigation(h.surface, () => labels);
  try {
    for (const page of [null, "detail", "translation", "chat", "context", "settings", "events", "models"] as const) {
      await nav.publish(page);
      const input = h.calls.at(-1)!.params;
      expect(input.breadcrumbs.at(-1).command).toBeUndefined();
      expect(input.presentationToken).toBe("p1");
      expect(input.breadcrumbs.map((item: any) => item.key)).toEqual(page === null ? ["root"] : ["root", ...(["events", "models"].includes(page) ? ["settings"] : []), page]);
      expect(input.back?.commandId).toBe(page === null ? undefined : ["events", "models"].includes(page) ? "com.reai.voice.open-settings" : "com.reai.voice.back-to-root");
      expect(input.menu.every((item: any) => ["com.reai.voice.open-settings", "com.reai.voice.open-audio-settings"].includes(item.command.commandId))).toBeTrue();
    }
    const revisions = h.calls.map(call => call.params.revision);
    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  } finally { await nav.dispose(); await h.running.dispose(); }
});

test("locale publication resolves the current real adapter; stale queued pages are coalesced", async () => {
  const h = await harness(); let current = labels;
  const nav = createVoiceSurfaceNavigation(h.surface, () => current);
  await nav.publish("settings");
  h.receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "mount", presentationToken: "p2" });
  current = { ...labels, settings: "设置" }; await nav.publish("settings");
  expect(h.calls.at(-1)!.params).toMatchObject({ revision: 2, presentationToken: "p2", breadcrumbs: [{ key: "root", label: "Voice" }, { key: "settings", label: "设置" }] });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  h.setBlock(() => gate);
  const first = nav.publish("detail"); await tick();
  const obsolete = nav.publish("events"); const latest = nav.publish("models");
  release(); await Promise.all([first, obsolete, latest]);
  expect(h.calls.slice(-2).map(call => call.params.breadcrumbs.at(-1).key)).toEqual(["detail", "models"]);
  h.setBlock(); await nav.dispose(); await h.running.dispose();
});

test("close waits behind in-flight writes, clears once, suppresses late failures and publishes nothing later", async () => {
  const h = await harness(); let release!: () => void;
  h.setBlock(() => new Promise<void>((_, reject) => { release = () => reject(new Error("synthetic late failure")); }));
  const errors: unknown[] = []; const nav = createVoiceSurfaceNavigation(h.surface, () => labels, error => errors.push(error));
  const pending = nav.publish("detail"); await tick();
  const cleanup = nav.dispose(); const again = nav.dispose(); h.setBlock(); release();
  await Promise.all([pending, cleanup, again]);
  expect(errors).toHaveLength(0); expect(h.calls.map(call => call.method)).toEqual(["surface.navigation.register", "surface.navigation.clear"]);
  expect(h.calls.at(-1)!.params.revision).toBe(2);
  await nav.publish("settings"); expect(h.calls).toHaveLength(2); await h.running.dispose();
});

test("adapter absent keeps legacy reportNav; fresh mount has its own revision and binding", async () => {
  const h = await harness(false); const reports: unknown[] = [];
  const nav = createVoiceSurfaceNavigation({ ...h.surface, reportNav: value => reports.push(value) }, () => labels);
  await nav.publish("events"); await nav.publish(null); await nav.dispose();
  expect(reports).toEqual([{ key: "settings/events", label: "Events" }, null]); expect(h.calls).toHaveLength(0);
  await h.running.dispose();
  const next = await harness(); const nextNav = createVoiceSurfaceNavigation(next.surface, () => labels);
  await nextNav.publish(null); expect(next.calls[0].params.revision).toBe(1);
  await nextNav.dispose(); await next.running.dispose();
});
