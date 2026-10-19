import { defineApp } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import { createProjectLister, declaresProjectsEndpoint } from "./cloud-projects";
import { FilesController } from "./controller";
import { createFilesView } from "./view";

/**
 * Production entry: the controller talks only to `ctx.resourceFiles` (`resources.files@1`).
 * The Host re-checks platform approval and user consent on every call; the SDK runtime
 * discards results that arrive after this mount or runtime was replaced.
 */
export default defineApp({
  activate(ctx) {
    ctx.surfaces.register("main", (surface) => {
      // Projects are listed only when this package declares its own oauth_app endpoint for
      // GET /projects; otherwise the cloud panel offers "enter a Project ID / paste a link".
      const projects = declaresProjectsEndpoint(manifest) && ctx.http ? createProjectLister(ctx.http) : null;
      const controller = new FilesController(ctx.resourceFiles ?? null, { projects });
      const view = createFilesView(surface.root, controller, {
        locale: ctx.locale?.getSnapshot().locale ?? "zh",
        pluginVersion: manifest.version,
      });
      const stopLocale = ctx.locale?.onChange(({ locale }) => view.setLocale(locale));
      let disposed = false;
      // Technical codes and versions are shown only in Host developer mode (design §6.0).
      const stopEnvironment = ctx.environment?.onChange?.(({ developerMode }) => view.setDiagnostics({ developerMode }));
      void ctx.environment?.get?.().then(({ developerMode }) => { if (!disposed) view.setDiagnostics({ developerMode }); }).catch(() => undefined);
      void ctx.systemTasks?.getVersionStatus?.()
        .then((status) => { if (!disposed) view.setDiagnostics({ hostVersion: status.app.currentVersion }); })
        .catch((error: unknown) => {
          const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "no code";
          if (!disposed) view.setDiagnostics({ hostVersion: `unavailable (${code})` });
        });
      surface.ready();
      void controller.init();
      return () => {
        disposed = true;
        stopLocale?.();
        stopEnvironment?.();
        controller.dispose();
        view.dispose();
      };
    });
  },
});
