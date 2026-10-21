import { resolve } from "node:path";
import { createDataFixture, fixtureActor } from "../tests/data-fixture";

const directory = resolve(import.meta.dir, "../../..", ".artifacts/project-data-app/preview");
const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "preview.ts")], outdir: directory, target: "browser" });
if (!build.success) throw new Error(build.logs.join("\n"));
// Host 主题色的本地快照（只含颜色值），仅供预览使用。
const themeTokens = await Bun.file(resolve(import.meta.dir, "../tests/fixtures/theme-tokens.json")).json() as { light: Record<string, string>; dark: Record<string, string> };
const theme = (dark = false) => dark ? themeTokens.dark : themeTokens.light;
const fixture = createDataFixture(); const actor = fixtureActor(); let delay = 350;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/tokens/")) return Response.json(theme(url.pathname.endsWith("dark")));
  if (url.pathname.startsWith("/fixture-state/") && request.method === "POST") {
    const action = url.pathname.split("/").at(-1)!;
    actor.scopes = new Set(action === "deny" ? [] : ["project:data:read", "project:data:write"]); delay = action === "slow" ? 1500 : 350;
    return Response.json({ ok: true });
  }
  if (url.pathname.startsWith("/fixture/projects/")) {
    await Bun.sleep(delay);
    const response = await fixture.handler(actor)({ request: { url: "https://block2-api.wainao.chat" + url.pathname.replace("/fixture", "") + url.search, method: request.method, headers: {} }, body: await request.blob(), signal: request.signal });
    if (!("status" in response)) return Response.json({ error: "fixture_error" }, { status: 500 });
    return new Response(Buffer.from(response.bodyBase64 ?? "", "base64"), { status: response.status, headers: response.headers });
  }
  if (["/preview.js", "/preview.css"].includes(url.pathname)) return new Response(Bun.file(resolve(directory, url.pathname.slice(1))));
  if (url.pathname !== "/") return new Response("Not found", { status: 404 });
  const variables = Object.entries(theme()).map(([key, value]) => `--${key}:${value}`).join(";");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/preview.css"><style>:root{${variables};--reai-plugin-titlebar-safe-top:44px}body{margin:0;background:var(--bg);color:var(--text-primary);font:13px system-ui}#controls{padding:8px;display:flex;flex-wrap:wrap;gap:8px}#root{height:calc(100vh - 100px)}</style></head><body><aside id="controls">LOCAL FIXTURE ONLY <select id="theme" aria-label="Theme"><option>light</option><option>dark</option></select><select id="language" aria-label="Language"><option>en</option><option>zh</option></select><button data-fixture="allow">Fixture allow</button><button data-fixture="deny">Fixture scope denial</button><button data-fixture="slow">Fixture slow</button></aside><div id="root"></div><script type="module" src="/preview.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
} });
console.log(`Project data example fixture preview: ${server.url}`);
