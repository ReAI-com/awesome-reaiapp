import type { AppHttpClient } from "@reai/app-sdk/v1";
import { FilesError, parseProjectId } from "./adapter";

/** A Project the signed-in user can read, as listed by the plugin's own cloud connection. */
export interface CloudProject { id: string; name: string; description: string }
export interface CloudProjectLister { list(signal?: AbortSignal): Promise<CloudProject[]> }

/** Network endpoint id the Manifest must declare (oauth_app, GET /projects) before listing is offered. */
export const PROJECTS_ENDPOINT_ID = "wainao-projects";
export const PROJECTS_ORIGIN = "https://block2-api.wainao.chat";
const MAX_PROJECTS = 200;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (code: string): never => { throw new FilesError(code); };

/** True when the installed Manifest declares the oauth_app endpoint needed to list Projects. */
export function declaresProjectsEndpoint(manifest: unknown): boolean {
  if (!object(manifest) || typeof manifest.oauthAppId !== "string" || !manifest.oauthAppId.trim()) return false;
  const network = manifest.network;
  if (!object(network) || !Array.isArray(network.endpoints)) return false;
  return network.endpoints.some((endpoint) => object(endpoint) && endpoint.id === PROJECTS_ENDPOINT_ID
    && object(endpoint.auth) && endpoint.auth.mode === "oauth_app");
}

/**
 * `GET /projects` (wainao #1412, scope `projects:read`) through the Host network broker
 * with this plugin's own OAuth connection. The Host injects the credential; the plugin
 * never sees a token. Errors are reduced to stable codes for the UI.
 */
export function createProjectLister(http: Pick<AppHttpClient, "fetch">): CloudProjectLister {
  return {
    async list(signal) {
      let response: Response;
      try {
        response = await http.fetch(`${PROJECTS_ORIGIN}/projects`, { endpointId: PROJECTS_ENDPOINT_ID, method: "GET", signal });
      } catch (error) {
        const code = object(error) && typeof error.code === "string" ? error.code : "";
        // User has not allowed this plugin's network permission: retrying cannot help.
        if (/PERMISSION/.test(code)) fail("PROJECTS_PERMISSION_REQUIRED");
        if (/OAUTH|AUTH|LOGIN|CONSENT/.test(code)) fail("PROJECTS_NOT_CONNECTED");
        if (/ENDPOINT|NETWORK_.*DENIED/.test(code)) fail("PROJECTS_NOT_OFFERED");
        return fail("PROJECTS_UNREACHABLE");
      }
      let body: unknown = null;
      try { body = await response.json(); } catch { body = null; }
      if (response.status === 401) fail("PROJECTS_NOT_CONNECTED");
      if (response.status === 403) fail(object(body) && body.error === "insufficient_scope" ? "PROJECTS_SCOPE_MISSING" : "PROJECTS_NOT_CONNECTED");
      if (response.status === 404 || response.status === 405) fail("PROJECTS_NOT_OFFERED");
      if (!response.ok) fail("PROJECTS_UNREACHABLE");
      if (!object(body) || body.success !== true || !Array.isArray(body.data)) return fail("PROJECTS_INVALID");
      const projects: CloudProject[] = [];
      for (const item of body.data.slice(0, MAX_PROJECTS)) {
          if (!object(item) || typeof item.id !== "string" || typeof item.name !== "string") continue;
        const id = parseProjectId(item.id);
        if (!id || id !== item.id.toLowerCase()) continue;
        projects.push({ id, name: item.name.slice(0, 200) || item.id, description: typeof item.description === "string" ? item.description.slice(0, 300) : "" });
      }
      return projects.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
