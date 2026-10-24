// 浏览器验证夹具：在与宿主相同的 CSP 下打开 xterm，写入彩色输出供截图取色。
// renderer=dom 复现修复前的渲染路径；renderer=auto 走插件实际使用的渲染选择。
import { Terminal } from "@xterm/xterm";
import { attachTerminalRenderer } from "../../src/terminal-renderer";

const blocked: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => blocked.push(event.violatedDirective));
const params = new URLSearchParams(location.search);
const mode = params.get("renderer") === "dom" ? "dom" : "auto";
const terminal = new Terminal({
  fontFamily: "'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
  fontSize: 28,
  lineHeight: 1.2,
  allowTransparency: false,
  theme: { background: "#101010", foreground: "#d0d0d0", red: "#ff2020", green: "#20ff20" },
});
terminal.open(document.getElementById("term")!);
const renderer = mode === "auto" ? attachTerminalRenderer(terminal) : null;
terminal.write("\x1b[31mRED\x1b[32mGREEN\x1b[38;2;255;128;0mTRUE\x1b[0m\r\n", () => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    Object.assign(window, { __terminal: terminal, __renderer: renderer });
    (window as unknown as { __cspColor: unknown }).__cspColor = {
      mode,
      renderer: renderer?.kind ?? "dom",
      styleElements: document.querySelectorAll("#term style").length,
      blocked,
    };
  }));
});
