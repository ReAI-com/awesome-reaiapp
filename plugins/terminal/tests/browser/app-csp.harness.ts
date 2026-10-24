// 整包验证夹具：在 CSP 页面里加载构建产物 dist/app.js，用模拟宿主挂载终端界面，
// 由 terminal.session.attach 回放一段彩色输出。
import { runApp, type HostBridge, type HostMessage } from "@reai/app-sdk/v1";

const COLORED = "\x1b[31mRED\x1b[32mGREEN\x1b[38;2;255;128;0mTRUE\x1b[0m\r\n";
const blocked: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => blocked.push(event.violatedDirective));
const { default: app } = await import("/dist/app.js" as string);
let receive!: (message: HostMessage) => void;
let created = 0;
// sessions=N：宿主恢复 N 个已有会话，插件会把它们放进同一个标签（检查单标签窗格过多时的名额分配）。
const restored = Math.max(1, Number(new URLSearchParams(location.search).get("sessions") ?? 1));
const bridge: HostBridge = {
  async request(method) {
    if (method === "locale.get") return { runtimeSessionId: "rt", locale: "zh", revision: 0 } as never;
    if (method === "terminal.session.list") return Array.from({ length: restored }, (_, index) => ({ id: index ? `csp-pty-r${index}` : "csp-pty", sequence: 0, cwd: "~" })) as never;
    if (method === "terminal.session.create") return { id: `csp-pty-${++created}`, sequence: 0, cwd: "~" } as never;
    if (method === "terminal.session.attach") return { token: "t", replayBase64: btoa(COLORED), truncated: false, sequence: 0 } as never;
    if (method === "storage.get") return { value: undefined } as never;
    if (method.startsWith("surface.navigation.")) return { accepted: true } as never;
    return {} as never;
  },
  notify(method) {
    if (method === "surface.ready") setTimeout(() => void (restored > 1 ? wait(1500).then(report) : split()), 800);
  },
  subscribe(handler) { receive = handler; return () => {}; },
};
runApp(app, bridge);
receive({ type: "activate", runtimeSessionId: "rt", locale: { locale: "zh", revision: 0 } } as HostMessage);
receive({ type: "surface.presentation", runtimeSessionId: "rt", surfaceMountId: "m1", presentationToken: "p" } as HostMessage);
receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "m1", root: document.getElementById("app")! } as HostMessage);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

// 分屏后两个窗格都应各自用 WebGL 画出彩色输出；再新建 18 个标签（共 20 个会话，超过 WebKit
// 每页 16 个 WebGL 上下文的上限）后切回第一个标签，后台标签必须交还上下文，不能把可见窗格挤成无色。
async function split() {
  document.querySelector<HTMLButtonElement>('[data-split="horizontal"]')?.click();
  await wait(1200);
  for (let index = 0; index < 18; index += 1) {
    document.querySelector<HTMLButtonElement>(".terminal-tab-add")?.click();
    await wait(50);
    document.querySelector<HTMLButtonElement>(".terminal-tab-name-dialog button.primary")?.click();
    await wait(400);
  }
  document.querySelector<HTMLButtonElement>(".terminal-tab-main")?.click();
  await wait(1500);
  report();
}

function report() {
  (window as unknown as { __cspColor: unknown }).__cspColor = {
    mode: "app",
    renderer: document.querySelector(".xterm canvas") ? "webgl" : "dom",
    panes: document.querySelectorAll(".terminal-pane .xterm").length,
    expandedPanes: document.querySelectorAll(".terminal-pane:not(.is-compact) .xterm").length,
    webglPanes: [...document.querySelectorAll(".terminal-pane")].filter((pane) => pane.querySelector(".xterm canvas")).length,
    tabs: document.querySelectorAll(".terminal-tab-main").length,
    styleElements: document.querySelectorAll(".xterm style").length,
    blocked,
  };
}
