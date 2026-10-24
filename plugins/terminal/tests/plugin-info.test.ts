import { afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import type { KeyValueStore, LocaleClient, LocaleSnapshot } from "@reai/app-sdk/v1";
import manifest from "../app.manifest.json";
import pkg from "../package.json";
import { CHANGELOG_TEXT } from "../src/release-notes";
import { createTerminalMessages } from "../src/terminal-i18n";
import { changelogSection, mountTerminalSettings } from "../src/terminal-settings";
import { TerminalPreferencesStore } from "../src/terminal-preferences";

beforeAll(() => { if (typeof document === "undefined") GlobalRegistrator.register(); });
afterEach(() => document.body.replaceChildren());

function locale(initial = "zh") {
  let current = initial;
  const callbacks = new Set<(value: LocaleSnapshot) => void>();
  const snapshot = () => ({ locale: current, revision: 1 } as LocaleSnapshot);
  return {
    client: { getSnapshot: snapshot, onChange(fn: (value: LocaleSnapshot) => void) { callbacks.add(fn); fn(snapshot()); return () => callbacks.delete(fn); } } as LocaleClient,
    set(value: string) { current = value; for (const callback of callbacks) callback(snapshot()); },
  };
}

function mount(version = manifest.version, language = locale()) {
  const node = document.createElement("div");
  document.body.append(node);
  const store = new TerminalPreferencesStore({ get: async () => undefined, set: async () => {} } as unknown as KeyValueStore);
  const view = mountTerminalSettings(node, store, createTerminalMessages(language.client), { appId: manifest.appId, version, changelogText: CHANGELOG_TEXT });
  return { node, view, language };
}

test("版本号、package.json 与打包进界面的更新日志保持一致", () => {
  expect(pkg.version).toBe(manifest.version);
  expect(CHANGELOG_TEXT).toBe(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));
  expect(changelogSection(CHANGELOG_TEXT, manifest.version)).toContain(`## ${manifest.version}`);
});

test("设置页底部先显示版本再显示关于插件，点击展开对应内容", () => {
  const { node, view, language } = mount();
  const buttons = [...node.querySelectorAll<HTMLButtonElement>("[data-plugin-info] button")];
  expect(buttons.map((button) => button.textContent)).toEqual([`版本 ${manifest.version}`, "关于插件"]);
  expect(buttons[0]!.getAttribute("aria-label")).toBe(`查看版本 ${manifest.version} 的更新日志`);
  expect(buttons[1]!.getAttribute("aria-label")).toBe("关于 终端");
  buttons[0]!.click();
  expect(node.querySelector(".terminal-changelog")?.textContent).toContain("终端里的彩色输出恢复正常");
  buttons[1]!.click();
  expect(node.querySelector(".terminal-about")?.textContent).toContain("https://open.reai.com/apps/com.reai.terminal");
  language.set("en");
  expect(buttons[0]!.textContent).toBe(`Version ${manifest.version}`);
  expect(node.querySelector("[data-info-title]")?.textContent).toBe("About Terminal");
  node.querySelector<HTMLButtonElement>("[data-info-close]")!.click();
  expect(node.querySelector<HTMLElement>("[data-info-card]")!.hidden).toBe(true);
  expect(document.activeElement).toBe(buttons[1]!);
  view.dispose();
});

test("找不到当前版本的日志时明确说明，不拿别的版本冒充", () => {
  const { node, view } = mount("9.9.9");
  node.querySelector<HTMLButtonElement>('[data-info="changelog"]')!.click();
  expect(node.querySelector(".terminal-changelog")?.textContent).toBe("此版本（9.9.9）的更新日志尚未发布。");
  view.dispose();
});
