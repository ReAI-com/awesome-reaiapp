import { beforeAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { KeyValueStore, LocaleClient, LocaleSnapshot, TerminalSessionClient } from "@reai/app-sdk/v1";
import { createTerminalMessages } from "../src/terminal-i18n";
import { mountTerminalSettings } from "../src/terminal-settings";
import { TerminalPreferencesStore } from "../src/terminal-preferences";
import { importTerminalColorScheme } from "../src/terminal-theme";

beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
afterEach(() => document.body.replaceChildren());
function locale(initial = "zh") {
  let current = initial;
  const callbacks = new Set<(value: LocaleSnapshot) => void>();
  const snapshot = () => ({ locale: current, revision: 1 } as LocaleSnapshot);
  return {
    client: { getSnapshot: snapshot, onChange(fn: (value: LocaleSnapshot) => void) { callbacks.add(fn); fn(snapshot()); return () => callbacks.delete(fn); } } as LocaleClient,
    set(value: string) { current = value; for (const callback of callbacks) callback(snapshot()); },
    count: () => callbacks.size,
  };
}
function store(set: (key: string, value: unknown) => Promise<void> = async () => {}) {
  return new TerminalPreferencesStore({ get: async () => undefined, set } as unknown as KeyValueStore);
}
function root() { const node = document.createElement("div"); document.body.append(node); return node; }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("real settings nodes preserve focus, scroll and preference writes across locale changes", async () => {
  const language = locale(); const node = root(); let writes = 0;
  const preferences = store(async () => { writes++; });
  const view = mountTerminalSettings(node, preferences, createTerminalMessages(language.client));
  const button = node.querySelector<HTMLButtonElement>('[data-font="up"]')!;
  const body = node.querySelector<HTMLElement>('.main-body')!;
  button.click(); await settle();
  expect(node.textContent).toContain("字体大小已更新");
  const cursor = node.querySelector<HTMLButtonElement>('.terminal-cursor-options button')!;
  cursor.focus(); body.scrollTop = 72;
  for (const next of ["en", "en", "zh", "en"]) language.set(next);
  expect(node.querySelector('[data-font="up"]')).toBe(button);
  expect(document.activeElement === cursor).toBe(true);
  expect(body.scrollTop).toBe(72);
  expect(node.textContent).toContain("Font size updated");
  expect(button.getAttribute('aria-label')).toBe("Increase terminal font size");
  expect(preferences.value.fontSize).toBe(12);
  expect(writes).toBe(1);
  expect(node.textContent).not.toMatch(/[\u3400-\u9fff]/);
  view.dispose(); expect(language.count()).toBe(0);
});

test("pending saves use the current locale and stale completions cannot overwrite a newer result", async () => {
  const language = locale(); const node = root();
  let finish!: () => void;
  let count = 0;
  const preferences = store(async () => { if (++count === 1) await new Promise<void>(resolve => finish = resolve); else throw Error("disk offline"); });
  const view = mountTerminalSettings(node, preferences, createTerminalMessages(language.client));
  const button = node.querySelector<HTMLButtonElement>('[data-font="up"]')!;
  button.click(); await settle(); button.click(); language.set("en"); finish(); await settle();
  expect(node.textContent).toContain("Could not save: Error: disk offline");
  expect(node.textContent).not.toContain("Font size updated");
  language.set("zh");
  expect(node.textContent).toContain("保存失败：Error: disk offline");
  expect(count).toBe(2);
  view.dispose();
});

test("a new pending save clears the previous success", async () => {
  const node = root(); let count = 0; let finish!: () => void;
  const view = mountTerminalSettings(node, store(async () => {
    if (++count === 2) await new Promise<void>(resolve => finish = resolve);
  }));
  const button = node.querySelector<HTMLButtonElement>('[data-font="up"]')!;
  button.click(); await settle(); expect(node.textContent).toContain("字体大小已更新");
  button.click(); await settle();
  expect(node.querySelector<HTMLElement>('[role="status"]')!.hidden).toBe(true);
  expect(node.textContent).not.toContain("字体大小已更新");
  finish(); await settle(); expect(node.textContent).toContain("字体大小已更新");
  view.dispose();
});

test("a delayed theme import retains preferences changed while reading the file", async () => {
  const { BUILTIN_TERMINAL_SCHEMES } = await import("../src/terminal-theme");
  const node = root(); const preferences = store();
  const view = mountTerminalSettings(node, preferences);
  const file = new File([""], "theme.json"); let finish!: (content: string) => void;
  file.text = () => new Promise(resolve => finish = resolve);
  const input = node.querySelector<HTMLInputElement>('[data-theme-file]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change"));
  node.querySelector<HTMLButtonElement>('[data-font="up"]')!.click(); await settle();
  finish(JSON.stringify({ ...BUILTIN_TERMINAL_SCHEMES[0], id: "custom-import", name: "My theme" }));
  await settle();
  expect(preferences.value.fontSize).toBe(12);
  expect(preferences.value.customSchemes.some(scheme => scheme.id === "custom-import")).toBe(true);
  view.dispose();
});

test("late save completion cannot update an unmounted view", async () => {
  const language = locale(); const node = root(); let finish!: () => void;
  const view = mountTerminalSettings(node, store(async () => new Promise<void>(resolve => finish = resolve)), createTerminalMessages(language.client));
  node.querySelector<HTMLButtonElement>('[data-font="up"]')!.click(); await settle();
  view.dispose(); finish(); await settle(); language.set("en");
  expect(node.childNodes.length).toBe(0); expect(language.count()).toBe(0);
});

test("messages fall back to English; imported names and errors remain literal text", () => {
  const language = locale("ja"); const messages = createTerminalMessages(language.client);
  expect(messages.t("settingsTitle")).toBe("Terminal settings");
  const node = root(); messages.text(node, "imported", { name: "<img src=x>{font}" });
  expect(node.textContent).toBe("Imported <img src=x>{font}"); expect(node.children.length).toBe(0);
  const error = importTerminalColorScheme("not json", [], "copy");
  expect(error.ok).toBe(false);
  if (!error.ok) expect(messages.t(error.error, error.params)).toBe("Invalid JSON");
  expect(createTerminalMessages().t("settingsTitle")).toBe("终端设置");
});

// Only xterm rendering is substituted: the actual workspace, naming, locale and
// lifecycle logic runs against a counted Host session client.
mock.module("@xterm/xterm", () => ({ Terminal: class {
  static strings = { promptLabel: "", tooMuchOutput: "" };
  textarea?: HTMLTextAreaElement;
  options: Record<string, unknown>; rows = 24; cols = 80;
  constructor(options: Record<string, unknown>) { this.options = options; }
  loadAddon() {} onData() { return { dispose() {} }; } onTitleChange() { return { dispose() {} }; }
  open(host: HTMLElement) { const input = document.createElement("textarea"); input.className = "xterm-test-input"; this.textarea = input; host.append(input); }
  write() {} writeln() {} dispose() {} focus() {} reset() {} clear() {}
} }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

test("workspace locale changes retain Shell input and naming draft without creating or resizing sessions", async () => {
  const { mountTerminalWorkspace } = await import("../src/terminal-workspace");
  const language = locale("en"); const node = root();
  const calls: string[] = [];
  const client = {
    async list() { calls.push("list"); return [{ id: "existing", sequence: 1, cwd: "/tmp/用户" }]; },
    async attach() { calls.push("attach"); return { token: "attachment", replayBase64: "", truncated: false }; },
    async detach() { calls.push("detach"); }, async resize() { calls.push("resize"); },
    async create() { calls.push("create"); throw Error("must not create"); },
  } as unknown as TerminalSessionClient;
  const view = await mountTerminalWorkspace(node, client, store(), createTerminalMessages(language.client));
  await settle();
  const input = node.querySelector<HTMLTextAreaElement>(".xterm-test-input")!;
  input.value = "echo 保留输入"; input.focus(); input.setSelectionRange(2, 5);
  const before = [...calls]; language.set("zh"); language.set("en");
  expect(node.querySelector(".xterm-test-input")).toBe(input);
  expect(input.getAttribute("aria-label")).toBe("Terminal input");
  expect(input.value).toBe("echo 保留输入"); expect(document.activeElement === input).toBe(true);
  expect(input.selectionStart).toBe(2); expect(calls).toEqual(before);
  expect(node.querySelector(".terminal-tab-name")!.textContent).toBe("Recovered");
  node.querySelector<HTMLButtonElement>(".terminal-tab-add")!.click(); await settle();
  const draft = node.querySelector<HTMLInputElement>(".terminal-tab-name-dialog input")!;
  draft.value = "我的 <draft>"; draft.focus(); draft.setSelectionRange(3, 6);
  language.set("zh"); language.set("en");
  expect(draft.value).toBe("我的 <draft>"); expect(document.activeElement === draft).toBe(true);
  expect(draft.selectionStart).toBe(3); expect(calls).toEqual(before);
  expect(node.querySelector(".terminal-tab-name-dialog h2")!.textContent).toBe("New terminal tab");
  node.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
  node.querySelector<HTMLElement>('.terminal-tab')!.dispatchEvent(new MouseEvent("dblclick"));
  expect(node.querySelector<HTMLButtonElement>('.terminal-tab-name-dialog button.primary')!.textContent).toBe("Save");
  language.set("zh");
  expect(node.querySelector<HTMLButtonElement>('.terminal-tab-name-dialog button.primary')!.textContent).toBe("保存");
  await view.dispose(); expect(language.count()).toBe(0);
});

test("failed workspace startup releases preferences and partial DOM", async () => {
  const { mountTerminalWorkspace } = await import("../src/terminal-workspace");
  const node = root(); const preferences = store();
  const subscribe = preferences.subscribe.bind(preferences);
  let subscriptions = 0;
  preferences.subscribe = (callback) => {
    subscriptions++;
    const stop = subscribe(callback);
    return () => { subscriptions--; stop(); };
  };
  const client = { list: async () => { throw Error("Synthetic startup failure"); } } as unknown as TerminalSessionClient;
  await expect(mountTerminalWorkspace(node, client, preferences)).rejects.toThrow("Synthetic startup failure");
  expect(subscriptions).toBe(0);
  expect(node.childNodes.length).toBe(0);
});
