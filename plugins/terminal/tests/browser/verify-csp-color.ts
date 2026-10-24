// 手动运行的 CSP 取色验证（不进 CI：需要本机浏览器与 playwright-core）。
// 用法：先 bun run build，再
//   PLAYWRIGHT_CORE=<playwright-core 入口> [BROWSER=webkit] [APP_DIST=<构建目录>] bun tests/browser/verify-csp-color.ts <输出目录>
// 三种页面都带与宿主 bootstrap 相同的 CSP：
// - dom：只用 xterm DOM 渲染器，复现修复前的无色问题（预期无色）；
// - auto：插件实际使用的渲染选择（预期有色）；
// - app：加载构建产物 dist/app.js 的完整终端界面，分屏并开 19 个标签后切回第一个（预期有色、无上下文驱逐）。
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "tmp/csp-color");
const siteDir = join(outDir, "site");
mkdirSync(join(siteDir, "dist"), { recursive: true });
const root = resolve(import.meta.dir, "../..");

async function bundle(entry: string, out: string, external: string[] = []) {
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true, external });
  if (!built.success) throw new AggregateError(built.logs, `${entry} build failed`);
  writeFileSync(join(siteDir, out), await built.outputs[0]!.text());
}
await bundle(join(import.meta.dir, "csp-color.harness.ts"), "harness.js");
await bundle(join(import.meta.dir, "app-csp.harness.ts"), "app-harness.js", ["@reai/app-sdk/v1", "/dist/app.js"]);
await bundle(join(root, "node_modules/@reai/app-sdk/src/v1/index.ts"), "sdk.js");
copyFileSync(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(siteDir, "xterm.css"));
// APP_DIST 可指向旧版本的构建目录，用来对照修复前的整包表现。
const appDist = resolve(process.env.APP_DIST ?? join(root, "dist"));
copyFileSync(join(appDist, "app.js"), join(siteDir, "dist/app.js"));
copyFileSync(join(appDist, "app.css"), join(siteDir, "dist/app.css"));

// 与宿主 bootstrap 相同的样式与脚本限制：只放行本 origin 资源和 nonce。
const csp = "default-src 'none'; script-src 'self' 'nonce-csptest'; style-src 'self' 'nonce-csptest'; img-src 'self' data:; font-src 'self'; connect-src 'self'";
const page = (body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">${head}
<style nonce="csptest">html,body{margin:0;height:100%;background:#101010}#term{width:640px;height:160px;padding:8px}#app{width:900px;height:520px}</style>
</head><body>${body}</body></html>`;
writeFileSync(join(siteDir, "index.html"), page(`<div id="term"></div><script type="module" src="/harness.js"></script>`, `<link rel="stylesheet" href="/xterm.css">`));
writeFileSync(join(siteDir, "app.html"), page(
  `<div id="app"></div><script type="module" src="/app-harness.js"></script>`,
  `<script type="importmap" nonce="csptest">{"imports":{"@reai/app-sdk/v1":"/sdk.js"}}</script><link rel="stylesheet" href="/dist/app.css">`,
));

const server = Bun.serve({ port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(siteDir, path === "/" ? "index.html" : path.slice(1)));
  return file.size ? new Response(file) : new Response("not found", { status: 404 });
} });

// BROWSER=webkit 使用 Playwright 自带 WebKit（宿主 macOS 是 WKWebView）；默认用本机 Chrome。
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const browser = process.env.BROWSER === "webkit"
  ? await playwright.webkit.launch({ headless: !process.env.HEADED })
  : await playwright.chromium.launch({
    executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: !process.env.HEADED,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
const report: Record<string, unknown> = { csp, appDist, browser: `${process.env.BROWSER ?? "chrome"} ${browser.version()}` };
const cases = [
  { mode: "dom", url: "/?renderer=dom", selector: "#term", expectColor: false },
  { mode: "auto", url: "/?renderer=auto", selector: "#term", expectColor: true },
  { mode: "app", url: "/app.html", selector: "#app", expectColor: true },
] as const;
let failed = false;
for (const item of cases) {
  const tab = await browser.newPage({ viewport: { width: 940, height: 560 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const errors: string[] = [];
  tab.on("pageerror", (error: Error) => errors.push(String(error)));
  let evictions = 0;
  tab.on("console", (message: any) => {
    const text = message.text();
    if (/too many (active )?webgl contexts/i.test(text)) evictions += 1;
    if (/context/i.test(text)) errors.push(`console: ${text}`);
  });
  await tab.goto(`http://127.0.0.1:${server.port}${item.url}`);
  await tab.waitForFunction(() => (window as any).__cspColor, null, { timeout: 20000 });
  const state = await tab.evaluate(() => (window as any).__cspColor);
  const png = join(outDir, `${item.mode}.png`);
  await tab.locator(item.selector).screenshot({ path: png });
  const counts = await hueCounts(tab, png);
  // 整包模式逐个窗格截图取色：分屏后每个窗格都必须各自画出三种颜色。
  const panes: Array<Record<string, number>> = [];
  if (item.mode === "app") {
    const locators = await tab.locator(".terminal-pane").all();
    for (const [index, pane] of locators.entries()) {
      const panePng = join(outDir, `app-pane-${index + 1}.png`);
      await pane.screenshot({ path: panePng });
      panes.push(await hueCounts(tab, panePng));
    }
  }
  const colored = Object.values(counts).every((count) => count > 20)
    && (item.mode !== "app" || (panes.length === 2 && state.tabs === 19 && evictions === 0
      && panes.every((pane) => Object.values(pane).every((count) => count > 20))));
  if (colored !== item.expectColor) failed = true;
  const features = item.mode === "auto" ? await checkFeatures(tab) : undefined;
  if (features && !Object.values(features).every((feature) => feature.ok)) failed = true;
  report[item.mode] = { ...state, screenshot: png, colorPixels: counts, ...(panes.length ? { paneColorPixels: panes } : {}), webglEvictionWarnings: evictions, colored, expectColor: item.expectColor, features, errors };
  await tab.close();
}
await browser.close();

// 用浏览器自带解码按色相统计像素，主题配色不同也能判断红、绿、橙是否画出。
async function hueCounts(tab: any, png: string): Promise<Record<string, number>> {
  const bytes = Buffer.from(await Bun.file(png).arrayBuffer()).toString("base64");
  return tab.evaluate(async (data: string) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const result = { red: 0, green: 0, orange: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
      if (r > 200 && g >= 90 && g <= 170 && b < 60) result.orange += 1;
      else if (r - Math.max(g, b) > 80 && Math.abs(g - b) < 50) result.red += 1;
      else if (g - Math.max(r, b) > 50) result.green += 1;
    }
    return result;
  }, bytes);
}

type Rgb = readonly [number, number, number];
// 在页面里执行一步操作，等两帧后截图，按指定颜色统计像素。
async function step(tab: any, name: string, action: string, targets: Record<string, Rgb>) {
  await tab.evaluate(async (source: string) => {
    const terminal = (window as any).__terminal;
    await new Promise<void>((done) => {
      const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => done()));
      const result = new Function("terminal", "finish", source)(terminal, finish);
      if (result !== "async") finish();
    });
  }, action);
  const png = join(outDir, `feature-${name}.png`);
  await tab.locator("#term").screenshot({ path: png });
  const bytes = Buffer.from(await Bun.file(png).arrayBuffer()).toString("base64");
  const counts: Record<string, number> = await tab.evaluate(async ({ data, targets }: { data: string; targets: Record<string, Rgb> }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    const result: Record<string, number> = {};
    for (const [key, [r, g, b]] of Object.entries(targets)) {
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i]! - r) + Math.abs(pixels[i + 1]! - g) + Math.abs(pixels[i + 2]! - b) < 60) count += 1;
      }
      result[key] = count;
    }
    return result;
  }, { data: bytes, targets });
  return { screenshot: png, counts };
}

// WebGL 下逐项确认现有功能：主题切换、下划线、选区、字号、光标样式、尺寸变化。
async function checkFeatures(tab: any) {
  const write = (text: string) => `terminal.write(${JSON.stringify(text)}, finish); return "async";`;
  const blue: Rgb = [32, 96, 255], orange: Rgb = [255, 128, 0], fg: Rgb = [208, 208, 208], magenta: Rgb = [255, 0, 255], cyan: Rgb = [0, 255, 255];
  const results: Record<string, { ok: boolean; detail: unknown }> = {};
  const theme = await step(tab, "theme", `terminal.options.theme = { ...terminal.options.theme, red: "#2060ff" }; terminal.clear(); ${write("\x1b[2J\x1b[H\x1b[31mBLUE\x1b[0m")}`, { blue });
  results.themeSwitch = { ok: theme.counts.blue! > 20, detail: theme };
  // 256 色：前景 38;5;21 为 (0,0,255)，背景 48;5;46 为 (0,255,0)。
  const palette = await step(tab, "palette-256", write("\x1b[2J\x1b[H\x1b[38;5;21mPALETTE\x1b[0m \x1b[48;5;46m      \x1b[0m"), { fg256: [0, 0, 255], bg256: [0, 255, 0] });
  results.palette256 = { ok: palette.counts.fg256! > 20 && palette.counts.bg256! > 100, detail: palette };
  const underline = await step(tab, "underline", write("\x1b[2J\x1b[H\x1b[4m          \x1b[0m"), { fg });
  results.underline = { ok: underline.counts.fg! > 20, detail: underline };
  const selection = await step(tab, "selection", `terminal.options.theme = { ...terminal.options.theme, selectionBackground: "#ff00ff" }; terminal.write("\x1b[2J\x1b[HSELECT ME", () => { terminal.selectAll(); finish(); }); return "async";`, { magenta });
  results.selection = { ok: selection.counts.magenta! > 100, detail: selection };
  const large = await step(tab, "font-large", `terminal.clearSelection(); ${write("\x1b[2J\x1b[H\x1b[38;2;255;128;0mTRUECOLOR\x1b[0m")}`, { orange });
  const small = await step(tab, "font-small", `terminal.options.fontSize = 14; ${write("\x1b[2J\x1b[H\x1b[38;2;255;128;0mTRUECOLOR\x1b[0m")}`, { orange });
  results.fontSize = { ok: small.counts.orange! > 20 && small.counts.orange! < large.counts.orange! * 0.6, detail: { large, small } };
  const block = await step(tab, "cursor-block", `terminal.options.theme = { ...terminal.options.theme, cursor: "#00ffff" }; terminal.options.cursorBlink = false; terminal.options.cursorStyle = "block"; terminal.focus(); ${write("\x1b[2J\x1b[H")}`, { cyan });
  const bar = await step(tab, "cursor-bar", `terminal.options.cursorStyle = "bar"; terminal.focus(); ${write("")}`, { cyan });
  results.cursorStyle = { ok: block.counts.cyan! > 20 && bar.counts.cyan! > 0 && bar.counts.cyan! < block.counts.cyan!, detail: { block, bar } };
  const before = await tab.evaluate(() => (window as any).__terminal.element.querySelector("canvas")?.width ?? 0);
  const resized = await step(tab, "resize", `terminal.resize(20, 3); ${write("\x1b[2J\x1b[H\x1b[38;2;255;128;0mTRUE\x1b[0m")}`, { orange });
  const after = await tab.evaluate(() => (window as any).__terminal.element.querySelector("canvas")?.width ?? 0);
  results.resize = { ok: after > 0 && after < before && resized.counts.orange! > 20, detail: { canvasWidthBefore: before, canvasWidthAfter: after, resized } };
  // 主动让 WebGL 上下文丢失：xterm 先等浏览器约 3 秒自行恢复，仍未恢复才通知插件；
  // 插件应先退回 DOM，约 1 秒后换新画布重建 WebGL 并继续出色。
  const lossTrigger = await tab.evaluate(() => {
    const canvases = [...(window as any).__terminal.element.querySelectorAll("canvas")] as HTMLCanvasElement[];
    const gl = canvases.map((canvas) => canvas.getContext("webgl2")).find(Boolean);
    const extension = gl?.getExtension("WEBGL_lose_context");
    extension?.loseContext();
    return { canvases: canvases.length, context: Boolean(gl), extension: Boolean(extension) };
  });
  const lost = await tab.waitForFunction(() => (window as any).__renderer.kind === "dom", null, { timeout: 8000 }).then(() => "dom", () => "webgl");
  await tab.waitForFunction(() => (window as any).__renderer.kind === "webgl", null, { timeout: 8000 }).catch(() => undefined);
  const restored = await step(tab, "context-restored", write("\x1b[2J\x1b[H\x1b[38;2;255;128;0mTRUE\x1b[0m"), { orange });
  const restoredKind = await tab.evaluate(() => (window as any).__renderer.kind);
  results.contextLoss = { ok: lost === "dom" && restoredKind === "webgl" && restored.counts.orange! > 20, detail: { lossTrigger, afterLoss: lost, afterRestore: restoredKind, restored } };
  for (const result of Object.values(results)) result.ok = Boolean(result.ok);
  return results;
}
server.stop(true);
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed) { console.error("取色结果与预期不符：dom 应无色，auto 与 app 应同时出现红、绿、橙"); process.exit(1); }
