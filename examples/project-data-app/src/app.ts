import "./app.css";
import { defineApp } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { createDataClient } from "./data-client";
import { mountDataView } from "./data-view";
const configured = manifest.oauthAppId !== "PROJECT_DATA_EXAMPLE_CLIENT_ID" && manifest.oauthAppId.trim().length >= 8;
export default defineApp({
  activate(ctx) {
    ctx.surfaces.register("main", surface => {
      const stop = mountDataView(surface.root, createDataClient(ctx.http), ctx.locale, configured); surface.ready(); return stop;
    });
  },
  deactivate() {},
});
