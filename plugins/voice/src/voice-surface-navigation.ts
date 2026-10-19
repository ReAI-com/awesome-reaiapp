import type { SurfaceHandle, SurfaceNavigation, SurfaceNavigationInput } from "@reai/app-sdk/v1";
import { diagnosticLogFields } from "./voice-error-fields";

export type VoiceNavigationPage = "detail" | "translation" | "chat" | "context" | "settings" | "events" | "models";
export type VoiceNavigationLabels = Record<VoiceNavigationPage | "root" | "audioSettings", string>;
const rootCommand = { commandId: "com.reai.voice.back-to-root" };
const settingsCommand = { commandId: "com.reai.voice.open-settings" };

/** One controller per mount. The public adapter owns runtime/presentation authority. */
export function createVoiceSurfaceNavigation(
  surface: SurfaceHandle,
  labels: () => VoiceNavigationLabels,
  onError: (cause: unknown) => void = cause => console.warn("[voice] navigation failed", diagnosticLogFields(cause)),
) {
  let revision = 0;
  let disposed = false;
  let chain = Promise.resolve();
  let registeredAdapter: SurfaceNavigation | undefined;
  let cleanup: Promise<void> | undefined;
  return {
    publish(page: VoiceNavigationPage | null): Promise<void> {
      if (disposed) return chain;
      const requestedRevision = ++revision;
      const names = labels();
      const inSettings = page === "events" || page === "models";
      if (!surface.navigation) {
        try { surface.reportNav?.(page ? { key: inSettings ? `settings/${page}` : page, label: names[page] } : null); }
        catch (cause) { try { onError(cause); } catch { /* Nonfatal reporting. */ } }
        return chain;
      }
      const breadcrumbs: Array<SurfaceNavigationInput["breadcrumbs"][number]> = [{ key: "root", label: names.root, ...(page ? { command: rootCommand } : {}) }];
      if (inSettings) breadcrumbs.push({ key: "settings", label: names.settings, command: settingsCommand });
      if (page) breadcrumbs.push({ key: page, label: names[page] });
      const input: SurfaceNavigationInput = {
        revision: requestedRevision, breadcrumbs,
        ...(page ? { back: inSettings ? settingsCommand : rootCommand } : {}),
        menu: [
          ...((page === "settings" || inSettings) ? [] : [{ key: "settings", label: names.settings, command: settingsCommand }]),
          { key: "audio-settings", label: names.audioSettings, command: { commandId: "com.reai.voice.open-audio-settings" } },
        ],
      };
      chain = chain.then(async () => {
        if (disposed || requestedRevision !== revision) return;
        // Resolve again at execution, since Host can replace the presentation binding.
        const adapter = surface.navigation;
        if (adapter) {
          registeredAdapter = adapter;
          await adapter.register(input);
        } else {
          surface.reportNav?.(page ? { key: inSettings ? `settings/${page}` : page, label: names[page] } : null);
        }
      }).catch(cause => { if (!disposed) { try { onError(cause); } catch { /* Reporting cannot break later publications. */ } } });
      return chain;
    },
    dispose(): Promise<void> {
      if (cleanup) return cleanup;
      disposed = true;
      const clearRevision = ++revision;
      // Clear after the in-flight write, once. SDK rejects an already retired binding.
      cleanup = chain.then(async () => { await registeredAdapter?.clear(clearRevision); }).catch(() => {});
      return cleanup;
    },
  };
}
