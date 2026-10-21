import { defineApp, type AppContext } from "@reai/app-sdk/v1";
import { MockHost } from "@reai/app-test/v1";
import manifest from "../app.manifest.json";
import { createDataClient, type DataClient } from "../src/data-client";
import { mountDataView } from "../src/data-view";
import { createDataFixture, fixtureActor } from "./data-fixture";

export async function fixtureDevice(fixture: ReturnType<typeof createDataFixture>, actor = fixtureActor(), createRoot?: () => HTMLElement) {
  let client!: DataClient; let context!: AppContext;
  const host = new MockHost({ manifest, createRoot, loadApp: async () => ({ default: defineApp({ activate(ctx) {
    context = ctx; client = createDataClient(ctx.http);
    ctx.surfaces.register("main", surface => {
      const stop = createRoot ? mountDataView(surface.root, client, ctx.locale, true) : undefined;
      surface.ready(); return stop;
    });
  }, deactivate() {} }) }), networkHandler: fixture.handler(actor) });
  await host.installAndEnable();
  return { host, client, context, stop: () => host.disable() };
}
