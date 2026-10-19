import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Separate browser-only fixture entry. This module is never an installed runtime entry.
const root = join(import.meta.dir, "..");
const out = join(root, ".preview");
await mkdir(out, { recursive: true });
const result = await Bun.build({ entrypoints: [join(root, "src/preview.ts")], outdir: out, target: "browser", format: "esm" });
if (!result.success) throw new Error(result.logs.map(String).join("\n"));
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Files synthetic preview</title></head><body><div id="fixture-controls"></div><div id="app"></div><script type="module" src="/preview.js"></script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (path === "/preview.js") return new Response(Bun.file(join(out, "preview.js")), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Synthetic data only: http://127.0.0.1:${server.port}/`);
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
process.on("SIGINT", () => { server.stop(true); process.exit(0); });
