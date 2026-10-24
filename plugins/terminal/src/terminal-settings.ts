import { createTerminalMessages, type TerminalMessages } from "./terminal-i18n";
import {
  BUILTIN_TERMINAL_SCHEMES,
  importTerminalColorScheme,
  type TerminalColorSchemeV1,
} from "./terminal-theme";
import {
  DEFAULT_TERMINAL_PREFERENCES,
  resolvedTerminalScheme,
  type TerminalCursorStyle,
  type TerminalPreferences,
  type TerminalPreferencesStore,
} from "./terminal-preferences";

export interface TerminalSettingsView {
  dispose(): void;
}

export interface TerminalPluginInfo {
  appId: string;
  version: string;
  changelogText: string;
}

/** 从完整日志里取出当前安装版本那一节；找不到时返回 null，不拿别的版本冒充。 */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+(\S+)/.exec(line)?.[1] === version);
  if (start === -1) return null;
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines.slice(start, next === -1 ? lines.length : next).join("\n").trim();
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function mountTerminalSettings(
  root: HTMLElement,
  store: TerminalPreferencesStore,
  messages: TerminalMessages = createTerminalMessages(),
  info?: TerminalPluginInfo,
): TerminalSettingsView {
  root.innerHTML = `
    <main class="plugin-main-frame terminal-settings-page">
      <div class="main-body terminal-settings-body">
        <div class="terminal-settings-intro">
          <div><h1><span data-i18n="settingsTitle"></span></h1><p><span data-i18n="settingsHint"></span></p></div>
        </div>
        <div class="terminal-settings-page-sections">
          <section><div class="slbl"><span data-i18n="appearance"></span></div><div class="scard">
            <div class="terminal-settings-theme-block">
              <div class="terminal-setting-label"><span><span data-i18n="scheme"></span></span><span data-selected-scheme></span></div>
              <div class="terminal-theme-grid" role="radiogroup" data-i18n-aria-label="schemeAria" aria-label=""></div>
            </div>
            <div class="row"><div class="rl"><div class="rt"><span data-i18n="follow"></span></div><div class="terminal-row-sub"><span data-i18n="followHint"></span></div></div><button class="terminal-mini-toggle" data-follow type="button" role="switch" data-i18n-aria-label="follow" aria-label=""><i></i></button></div>
            <button class="row terminal-import-row" data-import type="button"><div class="rl"><div class="rt"><span data-i18n="import"></span></div><div class="terminal-row-sub"><span data-i18n="importHint"></span></div></div><span class="rv">JSON</span><span class="chev">›</span></button>
            <input data-theme-file type="file" accept="application/json,.json" hidden />
          </div></section>
          <section><div class="slbl"><span data-i18n="display"></span></div><div class="scard">
            <div class="row"><div class="rl"><div class="rt"><span data-i18n="font"></span></div></div><div class="terminal-stepper"><button data-font="down" type="button" data-i18n-aria-label="fontDown" aria-label="">−</button><output data-font-size></output><button data-font="up" type="button" data-i18n-aria-label="fontUp" aria-label="">＋</button></div></div>
            <div class="row"><div class="rl"><div class="rt"><span data-i18n="cursor"></span></div></div><div class="terminal-cursor-options" role="radiogroup" data-i18n-aria-label="cursorAria" aria-label=""></div></div>
            <div class="row"><div class="rl"><div class="rt"><span data-i18n="blink"></span></div></div><button class="terminal-mini-toggle" data-blink type="button" role="switch" data-i18n-aria-label="blink" aria-label=""><i></i></button></div>
            <label class="row"><div class="rl"><div class="rt"><span data-i18n="scrollback"></span></div><div class="terminal-row-sub"><span data-i18n="scrollbackHint"></span></div></div><select class="terminal-setting-select" data-scrollback data-i18n-aria-label="scrollback" aria-label=""><option value="1000" data-i18n="lines" data-i18n-params='{"count": "1,000"}'></option><option value="5000" data-i18n="lines" data-i18n-params='{"count": "5,000"}'></option><option value="10000" data-i18n="lines" data-i18n-params='{"count": "10,000"}'></option><option value="50000" data-i18n="lines" data-i18n-params='{"count": "50,000"}'></option><option value="100000" data-i18n="lines" data-i18n-params='{"count": "100,000"}'></option></select></label>
          </div></section>
          <section><div class="slbl"><span data-i18n="reset"></span></div><div class="scard"><div class="row"><div class="rl"><div class="rt"><span data-i18n="resetTitle"></span></div><div class="terminal-row-sub"><span data-i18n="resetHint"></span></div></div><button class="terminal-reset" data-reset type="button"><span data-i18n="restore"></span></button></div></div></section>
        </div>
        <p class="terminal-settings-feedback" role="status" hidden></p>
        <footer class="terminal-settings-footer" data-plugin-info hidden>
          <button class="terminal-link-btn" data-info="changelog" type="button" aria-expanded="false"></button>
          <button class="terminal-link-btn" data-info="about" type="button" aria-expanded="false" data-i18n="about"></button>
        </footer>
        <section class="scard terminal-info-card" data-info-card hidden>
          <div class="terminal-info-head"><h2 data-info-title></h2><button class="terminal-link-btn" data-info-close type="button" data-i18n="collapse"></button></div>
          <div class="terminal-info-body" data-info-body></div>
        </section>
      </div>
    </main>`;

  const grid = root.querySelector<HTMLElement>(".terminal-theme-grid")!;
  const selectedName = root.querySelector<HTMLElement>("[data-selected-scheme]")!;
  const follow = root.querySelector<HTMLButtonElement>("[data-follow]")!;
  const blink = root.querySelector<HTMLButtonElement>("[data-blink]")!;
  const fontOutput = root.querySelector<HTMLOutputElement>("[data-font-size]")!;
  const scrollback = root.querySelector<HTMLSelectElement>("[data-scrollback]")!;
  const cursorOptions = root.querySelector<HTMLElement>(".terminal-cursor-options")!;
  const fileInput = root.querySelector<HTMLInputElement>("[data-theme-file]")!;
  const feedback = root.querySelector<HTMLElement>(".terminal-settings-feedback")!;
  let disposed = false;
  let feedbackMessage: (() => string) | undefined;

  let request = 0;
  const notify = (message: () => string, error = false) => {
    feedbackMessage = message;
    feedback.textContent = message();
    feedback.classList.toggle("error", error);
    feedback.hidden = false;
  };

  const save = async (next: TerminalPreferences, message: () => string) => {
    const ticket = ++request;
    feedbackMessage = undefined;
    feedback.textContent = "";
    feedback.hidden = true;
    try {
      await store.save(next);
      if (!disposed && ticket === request) notify(message);
    } catch (cause) {
      if (!disposed && ticket === request) notify(() => messages.t("saveFailed", { error: String(cause) }), true);
    }
  };

  const patch = (value: Partial<TerminalPreferences>, message: () => string) =>
    void save({ ...store.value, ...value }, message);

  const selectScheme = (scheme: TerminalColorSchemeV1) => {
    const current = store.value;
    if (current.followAppTheme) {
      patch(scheme.appearance === "light"
        ? { lightSchemeId: scheme.id }
        : { darkSchemeId: scheme.id }, () => messages.t("applied", { name: scheme.name, appearance: messages.t(scheme.appearance) }));
    } else {
      patch({ schemeId: scheme.id }, () => messages.t("switched", { name: scheme.name }));
    }
  };

  const render = (preferences: TerminalPreferences) => {
    const selected = resolvedTerminalScheme(preferences);
    selectedName.textContent = selected.name;
    grid.replaceChildren();
    for (const scheme of [...BUILTIN_TERMINAL_SCHEMES, ...preferences.customSchemes]) {
      const button = document.createElement("button");
      button.className = "terminal-theme-card";
      button.classList.toggle("active", scheme.id === selected.id);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", scheme.id === selected.id ? "true" : "false");
      button.style.setProperty("--scheme-bg", scheme.colors.background);
      button.style.setProperty("--scheme-fg", scheme.colors.foreground);
      button.style.setProperty("--scheme-accent", scheme.colors.blue);
      button.style.setProperty("--scheme-ok", scheme.colors.green);
      button.innerHTML = '<span class="terminal-theme-preview"><i></i><i></i><i></i></span><span class="terminal-theme-name"></span>';
      button.querySelector<HTMLElement>(".terminal-theme-name")!.textContent = scheme.name;
      button.onclick = () => selectScheme(scheme);
      grid.append(button);
    }
    follow.classList.toggle("on", preferences.followAppTheme);
    follow.setAttribute("aria-checked", preferences.followAppTheme ? "true" : "false");
    blink.classList.toggle("on", preferences.cursorBlink);
    blink.setAttribute("aria-checked", preferences.cursorBlink ? "true" : "false");
    fontOutput.textContent = `${preferences.fontSize} px`;
    root.querySelectorAll<HTMLButtonElement>("[data-font]").forEach((button) => {
      button.disabled = button.dataset.font === "down" ? preferences.fontSize <= 9 : preferences.fontSize >= 24;
    });
    scrollback.value = String(preferences.scrollback);
    cursorOptions.replaceChildren();
    for (const choice of [
      { id: "block" as const, label: "block" },
      { id: "bar" as const, label: "bar" },
      { id: "underline" as const, label: "underline" },
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      messages.text(button, choice.label);
      button.classList.toggle("active", preferences.cursorStyle === choice.id);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", preferences.cursorStyle === choice.id ? "true" : "false");
      button.onclick = () => patch({ cursorStyle: choice.id }, () => messages.t("cursorSaved"));
      cursorOptions.append(button);
    }
  };

  follow.onclick = () => patch({ followAppTheme: !store.value.followAppTheme }, () => messages.t("followSaved"));
  blink.onclick = () => patch({ cursorBlink: !store.value.cursorBlink }, () => messages.t("blinkSaved"));
  root.querySelectorAll<HTMLButtonElement>("[data-font]").forEach((button) => {
    button.onclick = () => {
      const delta = button.dataset.font === "down" ? -1 : 1;
      patch({ fontSize: store.value.fontSize + delta }, () => messages.t("fontSaved"));
    };
  });
  scrollback.onchange = () => patch({ scrollback: Number(scrollback.value) }, () => messages.t("scrollbackSaved"));
  root.querySelector<HTMLButtonElement>("[data-reset]")!.onclick = () =>
    void save(clone(DEFAULT_TERMINAL_PREFERENCES), () => messages.t("resetSaved"));
  root.querySelector<HTMLButtonElement>("[data-import]")!.onclick = () => fileInput.click();
  fileInput.onchange = () => void (async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const content = await file.text();
      if (disposed) return;
      const current = store.value;
      const imported = importTerminalColorScheme(content, current.customSchemes, "copy");
      if (!imported.ok) return notify(() => messages.t(imported.error, imported.params), true);
      await save({
        ...current,
        customSchemes: imported.schemes,
        schemeId: current.followAppTheme ? current.schemeId : imported.scheme.id,
        ...(current.followAppTheme && imported.scheme.appearance === "light"
          ? { lightSchemeId: imported.scheme.id }
          : {}),
        ...(current.followAppTheme && imported.scheme.appearance === "dark"
          ? { darkSchemeId: imported.scheme.id }
          : {}),
      }, () => messages.t("imported", { name: imported.scheme.name }));
    } catch (cause) {
      !disposed && notify(() => messages.t("importFailed", { error: String(cause) }), true);
    }
  })();

  // 版本 / 关于插件（规范 docs/plugin-settings-and-release-notes-v1.md §1），版本取自安装包 Manifest。
  const footer = root.querySelector<HTMLElement>("[data-plugin-info]")!;
  const versionButton = root.querySelector<HTMLButtonElement>('[data-info="changelog"]')!;
  const aboutButton = root.querySelector<HTMLButtonElement>('[data-info="about"]')!;
  const infoCard = root.querySelector<HTMLElement>("[data-info-card]")!;
  const infoTitle = root.querySelector<HTMLElement>("[data-info-title]")!;
  const infoBody = root.querySelector<HTMLElement>("[data-info-body]")!;
  let infoKind: "changelog" | "about" | null = null;
  const pluginName = () => messages.t("metadataName");
  const renderInfo = () => {
    if (!info) return;
    footer.hidden = false;
    versionButton.textContent = messages.t("version", { version: info.version });
    versionButton.setAttribute("aria-label", messages.t("versionLabel", { version: info.version }));
    aboutButton.setAttribute("aria-label", messages.t("aboutLabel", { name: pluginName() }));
    versionButton.setAttribute("aria-expanded", String(infoKind === "changelog"));
    aboutButton.setAttribute("aria-expanded", String(infoKind === "about"));
    infoCard.hidden = infoKind === null;
    if (!infoKind) return infoBody.replaceChildren();
    const paragraph = (text: string) => {
      const node = document.createElement("p");
      node.className = "terminal-info-note";
      node.textContent = text;
      return node;
    };
    if (infoKind === "changelog") {
      infoTitle.textContent = messages.t("changelogTitle", { version: info.version });
      const section = changelogSection(info.changelogText, info.version);
      const body = document.createElement("pre");
      body.className = "terminal-changelog";
      body.textContent = section ?? messages.t("changelogMissing", { version: info.version });
      infoBody.replaceChildren(body, ...(section ? [paragraph(messages.t("changelogLanguageNote"))] : []));
      return;
    }
    infoTitle.textContent = messages.t("aboutTitle", { name: pluginName() });
    const list = document.createElement("dl");
    list.className = "terminal-about";
    for (const [term, value] of [
      [messages.t("aboutPlugin"), pluginName()],
      [messages.t("aboutVersion"), info.version],
      [messages.t("aboutAppId"), info.appId],
      [messages.t("aboutDetail"), `https://open.reai.com/apps/${encodeURIComponent(info.appId)}`],
    ]) {
      const dt = document.createElement("dt");
      dt.textContent = term!;
      const dd = document.createElement("dd");
      dd.textContent = value!;
      list.append(dt, dd);
    }
    infoBody.replaceChildren(list, paragraph(messages.t("aboutBlocked")));
  };
  const showInfo = (kind: "changelog" | "about") => {
    infoKind = infoKind === kind ? null : kind;
    renderInfo();
    if (infoKind) infoCard.scrollIntoView?.({ block: "nearest" });
  };
  versionButton.onclick = () => showInfo("changelog");
  aboutButton.onclick = () => showInfo("about");
  root.querySelector<HTMLButtonElement>("[data-info-close]")!.onclick = () => {
    const opener = infoKind === "about" ? aboutButton : versionButton;
    infoKind = null;
    renderInfo();
    opener.focus();
  };
  renderInfo();

  const unsubscribe = store.subscribe(render);
  render(store.value);
  const stopLocale = messages.subscribe(() => {
    messages.update(root);
    renderInfo();
    if (feedbackMessage) feedback.textContent = feedbackMessage();
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      stopLocale();
      root.replaceChildren();
    },
  };
}
