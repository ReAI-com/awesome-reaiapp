/**
 * 浏览器预览入口：假 Host + 本机主题色，用来看界面和交互。
 * 不进插件安装包；这里的结果不能当作真实 Driver 的验收结论。
 */
import { createPreviewPort } from "./preview-port";
import { mountProbeView, type ProbeView } from "./view";
import "./styles.css";

const root = document.querySelector<HTMLElement>("#app")!;
const controls = document.querySelector<HTMLElement>("#fixture-controls")!;
const params = new URLSearchParams(location.search);
let dark = params.get("theme") === "dark";
let deny = params.get("deny") === "1";
let developerMode = params.get("dev") !== "0";

// 与 Driver 内置 Aura 主题同值；装进 Driver 后由 Host 注入真实 Token。
const tokens: Record<string, [string, string]> = {
  accent: ["#5c5ce0", "#7b7bf7"], "accent-glow": ["rgba(92,92,224,.22)", "rgba(123,123,247,.3)"], "accent-soft": ["rgba(92,92,224,.07)", "rgba(123,123,247,.1)"],
  alert: ["#ff3b30", "#ff5a4e"], "alert-line": ["rgba(255,59,48,.32)", "rgba(255,90,78,.42)"], "alert-soft": ["rgba(255,59,48,.07)", "rgba(255,90,78,.15)"],
  bg: ["#f4f3f9", "#0e0e1a"], bound: ["#1f9d55", "#3ecf7a"], "bound-line": ["rgba(31,157,85,.34)", "rgba(62,207,122,.4)"], "bound-soft": ["rgba(31,157,85,.1)", "rgba(62,207,122,.14)"],
  "cap-text": ["#ededf5", "#ededf5"], "card-bg": ["rgba(255,255,255,.8)", "rgba(26,26,46,.8)"], "card-border": ["rgba(92,92,224,.1)", "rgba(123,123,247,.12)"],
  divider: ["rgba(92,92,224,.08)", "rgba(123,123,247,.1)"], "text-primary": ["#1c1c2e", "#ededf5"], "text-secondary": ["#6b6b80", "#9494a8"], "text-tertiary": ["#a5a5b8", "#505068"],
  warn: ["#b3701a", "#f0a94c"], "warn-line": ["rgba(179,112,26,.3)", "rgba(240,169,76,.4)"], "warn-soft": ["rgba(179,112,26,.09)", "rgba(240,169,76,.14)"],
};

function applyTheme(): void {
  for (const [name, values] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${name}`, values[dark ? 1 : 0]);
  document.documentElement.style.setProperty("--reai-plugin-titlebar-safe-top", "44px");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

const shell = document.createElement("style");
shell.textContent = "body{display:flex;flex-direction:column}#fixture-controls{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:var(--bg);color:var(--text-primary);font:12px/20px system-ui;border-bottom:1px solid var(--divider)}#fixture-controls strong{flex:1 0 100%}#fixture-controls button{padding:4px 8px;min-height:32px;border:1px solid var(--card-border);border-radius:6px}#app{flex:1;min-height:0;position:relative}";
document.head.append(shell);

let view: ProbeView | undefined;
let port = createPreviewPort();

function mount(): void {
  view?.dispose();
  port = createPreviewPort({ developerMode, deniedPermissions: deny ? new Set(["account.status@1", "os.notification.post@1", "http.fetch@1"]) : new Set(), voiceInstalled: true });
  view = mountProbeView(root, { port, hostVersion: Promise.resolve({ ok: true as const, version: "预览（不是真实 Driver）" }) });
}

function control(label: string, run: () => void): void {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", run);
  controls.append(button);
}

const title = document.createElement("strong");
title.textContent = "浏览器预览 · 假数据 · 没有 Driver 的权限和页面限制";
controls.append(title);
control("切换明暗", () => { dark = !dark; applyTheme(); });
control("切换开发者模式", () => { developerMode = !developerMode; port.setDeveloperMode(developerMode); });
control("切换「用户拒绝权限」", () => { deny = !deny; mount(); });
control("模拟标题栏「全部测试」", () => void view?.runSafe());
control("模拟标题栏「设置」", () => view?.openSettings());
control("模拟面包屑返回首页", () => view?.backToRoot());

applyTheme();
mount();
const page = params.get("page");
if (page) view?.show(page as Parameters<ProbeView["show"]>[0]);
