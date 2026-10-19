/** Loopback-only synthetic harness. Never imported by the installed app entry. */
import { FilesController } from "./controller";
import { SyntheticFiles } from "./fixtures";
import { createFilesView } from "./view";

const root = document.querySelector<HTMLElement>("#app")!;
const controls = document.querySelector<HTMLElement>("#fixture-controls")!;
let locale = "zh";
let dark = false;
let developerMode = false;
let files: SyntheticFiles;
let controller: FilesController;
let view: ReturnType<typeof createFilesView>;
let mainGrant = "";
let listProjects = true;
const PREVIEW_PROJECT = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";

// Standalone preview supplies the same Aura color values; installed UI uses Host tokens.
const tokens: Record<string, [string, string]> = {
  bg: ["#f4f3f9", "#0e0e1a"], accent: ["#5c5ce0", "#7b7bf7"],
  "accent-soft": ["rgba(92,92,224,.07)", "rgba(123,123,247,.1)"],
  "text-primary": ["#1c1c2e", "#ededf5"], "text-secondary": ["#6b6b80", "#9494a8"],
  "card-bg": ["rgba(255,255,255,.8)", "rgba(26,26,46,.8)"], "card-border": ["rgba(92,92,224,.1)", "rgba(123,123,247,.12)"],
  divider: ["rgba(92,92,224,.08)", "rgba(123,123,247,.1)"],
  "warn-line": ["rgba(179,112,26,.3)", "rgba(240,169,76,.4)"], "warn-soft": ["rgba(179,112,26,.09)", "rgba(240,169,76,.14)"],
  "alert-line": ["rgba(255,59,48,.32)", "rgba(255,90,78,.42)"], "alert-soft": ["rgba(255,59,48,.07)", "rgba(255,90,78,.15)"],
  "bound-line": ["rgba(31,157,85,.34)", "rgba(62,207,122,.4)"], "bound-soft": ["rgba(31,157,85,.1)", "rgba(62,207,122,.14)"],
};
function theme() {
  for (const [name, values] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${name}`, values[dark ? 1 : 0]);
  document.documentElement.style.setProperty("--reai-plugin-titlebar-safe-top", "44px");
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
theme();
const style = document.createElement("style");
style.textContent = `body{display:flex;flex-direction:column}#fixture-controls{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:8px;background:var(--bg);color:var(--text-primary);font:12px/20px system-ui}#fixture-controls strong{flex:1 0 100%}#fixture-controls button{font:inherit;padding:4px 8px;min-height:32px;border:1px solid var(--card-border);border-radius:6px;background:var(--card-bg);color:inherit}#app{flex:1;min-height:0;position:relative}`;
document.head.append(style);
const title = document.createElement("strong");
title.textContent = "SYNTHETIC DATA ONLY · fixture controls · no Host authorization";
controls.append(title);
function action(label: string, perform: () => void | Promise<void>) {
  const button = document.createElement("button"); button.type = "button"; button.textContent = label;
  button.addEventListener("click", () => { void Promise.resolve(perform()).catch(() => undefined); });
  controls.append(button);
}
function mount(mode: "ready" | "empty" | "notOpen" | "notAuthorized" = "ready") {
  view?.dispose(); controller?.dispose();
  files = new SyntheticFiles();
  if (mode === "ready") {
    mainGrant = files.addRoot("Notes", { "README.md": "# Synthetic notes\n\nOnly generated data.\n", "todo.txt": "buy milk\n", drafts: null, "drafts/idea.txt": "an idea\n" });
    files.addRoot("Downloads", { "report.csv": "a,b\n1,2\n" });
  }
  files.addCloudProject(PREVIEW_PROJECT, "Team Docs (synthetic)", { "readme.md": "# Synthetic cloud project\n", specs: null, "specs/plan.txt": "plan\n" });
  if (mode === "notOpen") files.failNext("listRoots", "HOST_CAPABILITY_NOT_AVAILABLE");
  if (mode === "notAuthorized") files.failNext("listRoots", "PLUGIN_PERMISSION_REQUIRED");
  const projects = listProjects ? { async list() { await new Promise((resolve) => setTimeout(resolve, files.delayMs)); return [{ id: PREVIEW_PROJECT, name: "Team Docs (synthetic)", description: "Synthetic project" }]; } } : null;
  controller = new FilesController(files, { pageSize: 50, projects });
  view = createFilesView(root, controller, { locale, pluginVersion: "preview" });
  view.setDiagnostics({ developerMode, hostVersion: "preview" });
  void controller.init();
}
action("Reset", () => mount());
action("Empty roots", () => mount("empty"));
action("Not open", () => mount("notOpen"));
action("Not authorized", () => mount("notAuthorized"));
action("中文 / English", () => { locale = locale === "zh" ? "en" : "zh"; view.setLocale(locale); });
action("Light / Dark", () => { dark = !dark; theme(); });
action("Developer mode", () => { developerMode = !developerMode; view.setDiagnostics({ developerMode }); });
action("Slow calls", () => { files.delayMs = files.delayMs ? 0 : 1200; });
action("External edit of selected", () => {
  const selected = controller.getSnapshot().selected;
  if (selected?.resource.provider === "local") files.externalWrite(mainGrant, selected.resource.relativePath, "changed elsewhere\n");
});
action("Revoke all", () => files.revoke());
action("Cloud: list projects on/off", () => { listProjects = !listProjects; mount(); });
action("Cloud: no plugin connection", () => { files.cloudConnected = !files.cloudConnected; });
action("Cloud: next attach declined", () => { files.nextAttach = "deny"; });
action("Cloud: next list not open", () => files.failNext("list", "RESOURCE_UNAVAILABLE", "云文件服务尚未开放"));
action("Cloud: next list route missing", () => files.failNext("list", "RESOURCE_UNAVAILABLE", "云文件服务暂不可用（后台未提供该接口，http 404）"));
action("Cloud: next commit outcome unknown", () => files.failNext("commitWrite", "RESOURCE_CANCELLED", "请求已中止，云端是否已生效未知，请重新查询后再继续"));
action("Account switched (next list)", () => files.failNext("list", "RESOURCE_SCOPE_STALE", "插件界面或账号已变化，请重试"));
action("Next pick: new folder", () => files.preparePick("Picked folder", { "picked.txt": "from picked folder\n" }));
action("Next pick: cancel", () => files.preparePick(null));
mount();
window.addEventListener("pagehide", () => { view.dispose(); controller.dispose(); });
