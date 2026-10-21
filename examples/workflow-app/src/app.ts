import "./app.css";
import { defineApp } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { createRunClient } from "./run-client";
import { mountWorkflowView } from "./workflow-view";

const oauthClientId = manifest.oauthAppId.trim();
const configured = oauthClientId.length > 0 && oauthClientId !== "WORKFLOW_EXAMPLE_CLIENT_ID";

export default defineApp({
  async activate(ctx) {
    ctx.surfaces.register("main", surface => {
      const stop = mountWorkflowView(surface.root, createRunClient(ctx.http), ctx.locale, configured);
      surface.ready();
      return stop;
    });
  },
  async deactivate() {},
});
