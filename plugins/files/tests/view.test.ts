import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import zh from "../assets/locales/zh.json";
import en from "../assets/locales/en.json";
import { FilesController } from "../src/controller";
import { SyntheticFiles } from "../src/fixtures";
import { createFilesView } from "../src/view";
import { FILES_STYLES } from "../src/styles";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => { document.body.replaceChildren(); document.head.replaceChildren(); });

async function mount(files: SyntheticFiles | null, locale = "en") {
  const root = document.createElement("div");
  document.body.append(root);
  const controller = new FilesController(files);
  const view = createFilesView(root, controller, { locale, pluginVersion: "1.1.0" });
  await controller.init();
  return { root, controller, view, files };
}
const action = (root: HTMLElement, key: string) => root.querySelector<HTMLButtonElement>(`[data-action="${key}"]`);
const settle = () => Bun.sleep(5);

describe("availability states", () => {
  test("not open / not authorized / no roots each explain the next step", async () => {
    const closed = new SyntheticFiles(); closed.failNext("listRoots", "HOST_CAPABILITY_NOT_AVAILABLE");
    let m = await mount(closed);
    expect(m.root.textContent).toContain("File access is not available yet");
    expect(m.root.textContent).not.toContain("Plugin 1.1.0");
    m.view.setDiagnostics({ developerMode: true });
    expect(m.root.textContent).toContain("Plugin 1.1.0");
    expect(action(m.root, "addRoot")!.disabled).toBeTrue();
    m.view.dispose();

    const denied = new SyntheticFiles(); denied.failNext("listRoots", "PLUGIN_PERMISSION_REQUIRED");
    m = await mount(denied);
    expect(m.root.textContent).toContain("Installed → Files → Permissions");
    expect(action(m.root, "recheck")).not.toBeNull();
    m.view.dispose();

    m = await mount(new SyntheticFiles(), "zh");
    expect(m.root.textContent).toContain("先选择一个文件夹");
    const choose = action(m.root, "chooseFolder")!;
    expect(choose.className).toContain("files-btn-primary");
    m.view.dispose();
  });

  test("a Host without cloud Projects keeps the slot visible but disabled", async () => {
    const files = new SyntheticFiles();
    (files as unknown as { attachCloudProject?: unknown }).attachCloudProject = undefined;
    const m = await mount(files);
    const cloud = m.root.querySelector<HTMLButtonElement>('[data-key="cloud"]')!;
    expect(cloud.disabled).toBeTrue();
    expect(cloud.textContent).toContain("Not available yet");
    m.view.dispose();
  });

  test("no native file input and no technical code outside developer mode", async () => {
    const files = new SyntheticFiles(); files.addRoot("R", { "a.txt": "x" });
    const m = await mount(files);
    files.failNext("stat", "RESOURCE_IO_FAILED");
    action(m.root, "refresh"); // ensure exists
    await m.controller.openEntry(m.controller.getSnapshot().items[0]!);
    expect(m.root.textContent).toContain("Reading or writing the file failed");
    expect(m.root.textContent).not.toContain("RESOURCE_IO_FAILED");
    m.view.setDiagnostics({ developerMode: true, hostVersion: "1.0.5" });
    expect(m.root.textContent).toContain("Error code RESOURCE_IO_FAILED");
    expect(m.root.textContent).toContain("ReAI 1.0.5");
    expect(m.root.querySelector('input[type="file"]')).toBeNull();
    m.view.dispose();
  });
});

describe("browsing and editing", () => {
  test("lists entries, opens a folder, shows path and empty folder state", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "hi", empty: null });
    const m = await mount(files);
    const rows = [...m.root.querySelectorAll<HTMLButtonElement>(".files-row")];
    expect(rows.map((row) => row.querySelector(".files-row-name")!.textContent)).toEqual(["empty", "a.txt"]);
    rows[0]!.click(); await settle();
    expect(m.root.querySelector(".files-crumb-current")!.textContent).toBe("empty");
    expect(m.root.textContent).toContain("This folder is empty");
    expect(action(m.root, "up")!.disabled).toBeFalse();
    m.view.dispose();
  });

  test("edit → save enables only when dirty; conflict offers reload and save-as", async () => {
    const files = new SyntheticFiles(); const grant = files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "openText")!.click(); await settle();
    const editor = m.root.querySelector<HTMLTextAreaElement>("textarea.files-editor")!;
    expect(editor.value).toBe("hi");
    expect(action(m.root, "save")!.disabled).toBeTrue();
    editor.value = "mine"; editor.dispatchEvent(new Event("input"));
    expect(action(m.root, "save")!.disabled).toBeFalse();
    files.externalWrite(grant, "a.txt", "theirs");
    action(m.root, "save")!.click(); await settle();
    expect(m.root.querySelector("[data-conflict]")!.textContent).toContain("changed somewhere else");
    expect(action(m.root, "reload")).not.toBeNull();
    expect(action(m.root, "saveAs")).not.toBeNull();
    expect(m.root.querySelector<HTMLTextAreaElement>("textarea.files-editor")!.value).toBe("mine");
    m.view.dispose();
  });

  test("buttons switch to progress text and are disabled while busy", async () => {
    const files = new SyntheticFiles({ delayMs: 30 }); files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    action(m.root, "refresh")!.click();
    expect(action(m.root, "refresh")!.textContent).toContain("Reading folder");
    expect(action(m.root, "newFile")!.disabled).toBeTrue();
    await Bun.sleep(60);
    expect(action(m.root, "refresh")!.disabled).toBeFalse();
    m.view.dispose();
  });

  test("new file goes through a name dialog that rejects invalid names", async () => {
    const files = new SyntheticFiles(); const grant = files.addRoot("Notes", {});
    const m = await mount(files);
    action(m.root, "newFile")!.click();
    const input = m.root.querySelector<HTMLInputElement>(".files-input")!;
    expect(m.root.querySelector(".files-dialog-layer")!.hasAttribute("hidden")).toBeFalse();
    input.value = "../bad"; input.dispatchEvent(new Event("input"));
    expect(action(m.root, "confirmName")!.disabled).toBeTrue();
    input.value = "note.md"; input.dispatchEvent(new Event("input"));
    action(m.root, "confirmName")!.click(); await settle();
    expect(files.has(grant, "note.md")).toBeTrue();
    expect(m.root.textContent).toContain("Created “note.md”");
    m.view.dispose();
  });

  test("delete asks first and puts the safe choice first", async () => {
    const files = new SyntheticFiles(); const grant = files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "delete")!.click();
    const buttons = [...m.root.querySelectorAll<HTMLButtonElement>(".files-dialog .files-actions button")];
    expect(buttons[0]!.dataset.action).toBe("cancelDialog");
    expect(files.has(grant, "a.txt")).toBeTrue();
    action(m.root, "confirmDialog")!.click(); await settle();
    expect(files.has(grant, "a.txt")).toBeFalse();
    m.view.dispose();
  });

  test("revocation shows the recovered text panel", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files, "zh");
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "openText")!.click(); await settle();
    const editor = m.root.querySelector<HTMLTextAreaElement>("textarea.files-editor")!;
    editor.value = "未保存"; editor.dispatchEvent(new Event("input"));
    files.revoke();
    action(m.root, "save")!.click(); await settle(); await settle();
    const panel = m.root.querySelector("[data-recovered]")!;
    expect(panel.textContent).toContain("你有一段没保存的内容");
    expect(m.root.querySelector<HTMLTextAreaElement>(".files-recovered-text")!.value).toBe("未保存");
    expect(action(m.root, "saveRecovered")!.disabled).toBeTrue();
    expect(m.root.textContent).toContain("先选择一个文件夹");
    m.view.dispose();
    expect(m.root.textContent).toBe("");
  });
});

describe("review regressions: focus and unsaved drafts", () => {
  async function editing() {
    const files = new SyntheticFiles(); const grant = files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "openText")!.click(); await settle();
    const editor = m.root.querySelector<HTMLTextAreaElement>("textarea.files-editor")!;
    return { ...m, files, grant, editor };
  }

  test("typing keeps focus and caret in the editor", async () => {
    const { editor, root, view } = await editing();
    editor.focus();
    for (const text of ["h", "hi!", "hi!!"]) { editor.value = text; editor.setSelectionRange(text.length, text.length); editor.dispatchEvent(new Event("input")); }
    expect(document.activeElement).toBe(editor);
    expect(editor.selectionStart).toBe(4);
    expect(action(root, "save")!.disabled).toBeFalse();
    view.setLocale("zh");
    expect(document.activeElement).toBe(editor);
    view.dispose();
  });

  test("add folder, new file and import ask before dropping unsaved edits", async () => {
    const { editor, root, files, view, controller } = await editing();
    editor.value = "changed"; editor.dispatchEvent(new Event("input"));
    files.preparePick("Other", {});
    for (const key of ["addRoot", "newFile", "import"]) {
      action(root, key)!.click(); await settle();
      expect(root.querySelector('[role="alertdialog"]')!.textContent).toContain("Discard unsaved changes?");
      action(root, "cancelDialog")!.click(); await settle();
      expect(controller.getSnapshot().draft?.text).toBe("changed");
    }
    view.dispose();
  });

  test("closing a dialog returns focus to its trigger and Tab stays inside", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", {});
    const m = await mount(files);
    // Focus another control first: WKWebView does not move focus to a clicked button.
    action(m.root, "refresh")!.focus();
    action(m.root, "newFile")!.click();
    const layer = m.root.querySelector<HTMLElement>(".files-dialog-layer")!;
    const focusable = [...layer.querySelectorAll<HTMLElement>("input, button:not(:disabled)")];
    focusable.at(-1)!.focus();
    layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]!);
    layer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(layer.hidden).toBeTrue();
    expect((document.activeElement as HTMLElement).dataset.key).toBe("newFile");
    m.view.dispose();
  });

  test("a running copy can be cancelled from inside the chooser", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "x".repeat(400_000) }); const target = files.addRoot("T", {});
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "export")!.click(); await settle();
    m.root.querySelector<HTMLButtonElement>(`[data-key="chooserRoot:${target}"]`)!.click(); await settle();
    files.delayMs = 20;
    action(m.root, "copyHere")!.click(); await Bun.sleep(30);
    const cancel = m.root.querySelector<HTMLButtonElement>('.files-dialog [data-key="chooserCancel"]')!;
    expect(cancel.disabled).toBeFalse();
    cancel.click(); await Bun.sleep(200);
    expect(m.controller.getSnapshot().notice?.kind).toBe("cancelled");
    expect(files.has(target, "a.txt")).toBeFalse();
    m.view.dispose();
  });
});

describe("review round 2: dialogs", () => {
  test("switching language keeps the name input selection", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", {});
    const m = await mount(files);
    action(m.root, "newFile")!.click();
    const input = m.root.querySelector<HTMLInputElement>(".files-input")!;
    input.value = "abcdef"; input.dispatchEvent(new Event("input")); input.focus(); input.setSelectionRange(2, 4);
    m.view.setLocale("zh");
    const next = m.root.querySelector<HTMLInputElement>(".files-input")!;
    expect(document.activeElement).toBe(next);
    expect([next.value, next.selectionStart, next.selectionEnd]).toEqual(["abcdef", 2, 4]);
    m.view.dispose();
  });

  test("a long copy shows elapsed time inside the visible chooser", async () => {
    let now = Date.now();
    const realNow = Date.now; Date.now = () => now;
    try {
      const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "x".repeat(300_000) }); const target = files.addRoot("T", {});
      const m = await mount(files);
      m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
      action(m.root, "export")!.click(); await settle();
      m.root.querySelector<HTMLButtonElement>(`[data-key="chooserRoot:${target}"]`)!.click(); await settle();
      files.delayMs = 400;
      action(m.root, "copyHere")!.click();
      now += 3000; await Bun.sleep(300);
      expect(m.root.querySelector(".files-dialog")!.textContent).toMatch(/\d+s elapsed/);
      await m.controller.cancel(); files.delayMs = 0; await Bun.sleep(900);
      m.view.dispose();
    } finally { Date.now = realNow; }
  });
});

describe("review round 3: chained dialogs and chooser scroll", () => {
  test("discard → new-file name dialog → cancel returns focus to New file", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await settle();
    action(m.root, "openText")!.click(); await settle();
    const editor = m.root.querySelector<HTMLTextAreaElement>("textarea.files-editor")!;
    editor.value = "changed"; editor.dispatchEvent(new Event("input"));
    action(m.root, "newFile")!.click();
    action(m.root, "confirmDialog")!.click();
    expect(m.root.querySelector(".files-input")).not.toBeNull();
    action(m.root, "cancelDialog")!.click();
    expect((document.activeElement as HTMLElement).dataset.key).toBe("newFile");
    m.view.dispose();
  });

  test("the chooser list keeps its scroll across ticks and language switch", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", { "a.txt": "x" });
    const many = files.addRoot("Many", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, "y"])));
    const m = await mount(files);
    action(m.root, "import")!.click(); await settle();
    m.root.querySelector<HTMLButtonElement>(`[data-key="chooserRoot:${many}"]`)!.click(); await settle();
    const list = m.root.querySelector<HTMLElement>(".files-chooser-list")!;
    list.scrollTop = 250;
    m.view.setLocale("zh");
    expect(m.root.querySelector<HTMLElement>(".files-chooser-list")!.scrollTop).toBe(list.scrollTop);
    m.view.dispose();
  });
});

describe("review round 4: focus after an async confirm", () => {
  test("a failed delete returns focus to the delete button once idle", async () => {
    const files = new SyntheticFiles({ delayMs: 5 }); files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await Bun.sleep(30);
    action(m.root, "delete")!.click();
    files.failNext("delete", "RESOURCE_IO_FAILED");
    action(m.root, "confirmDialog")!.click(); await Bun.sleep(40);
    expect(m.controller.getSnapshot().error?.code).toBe("RESOURCE_IO_FAILED");
    expect((document.activeElement as HTMLElement).dataset.key).toBe("delete");
    m.view.dispose();
  });

  test("failed new-file and rename return focus to their trigger once idle", async () => {
    const files = new SyntheticFiles({ delayMs: 5 }); files.addRoot("Notes", { "a.txt": "hi" });
    const m = await mount(files);
    for (const [trigger, method] of [["newFile", "createFile"], ["rename", "rename"]] as const) {
      if (trigger === "rename") { m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await Bun.sleep(30); }
      action(m.root, trigger)!.click();
      const input = m.root.querySelector<HTMLInputElement>(".files-input")!;
      input.value = "z.txt"; input.dispatchEvent(new Event("input"));
      files.failNext(method, "RESOURCE_IO_FAILED");
      action(m.root, "confirmName")!.click(); await Bun.sleep(40);
      expect(m.controller.getSnapshot().error?.code).toBe("RESOURCE_IO_FAILED");
      expect((document.activeElement as HTMLElement).dataset.key).toBe(trigger);
    }
    m.view.dispose();
  });

  test("a successful delete moves focus to the next control instead of BODY", async () => {
    const files = new SyntheticFiles({ delayMs: 5 }); files.addRoot("Notes", { "a.txt": "hi", "b.txt": "b" });
    const m = await mount(files);
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await Bun.sleep(30);
    action(m.root, "delete")!.click();
    action(m.root, "confirmDialog")!.click(); await Bun.sleep(60);
    expect(document.activeElement).not.toBe(document.body);
    m.view.dispose();
  });
});

const PID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
function type(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event("input")); }
async function cloudMount(locale = "en", setup?: (files: SyntheticFiles) => void) {
  const files = new SyntheticFiles();
  files.addRoot("Notes", { "a.txt": "hi" });
  files.addCloudProject(PID, "Team Docs", { "readme.md": "# cloud" });
  setup?.(files);
  return await mount(files, locale);
}

describe("cloud Projects", () => {
  test("the cloud entry opens a panel with manual ID entry when Projects cannot be listed", async () => {
    const m = await cloudMount();
    const cloud = action(m.root, "cloud")!;
    expect(cloud.disabled).toBeFalse();
    expect(cloud.textContent).toContain("Connect cloud Project");
    cloud.click(); await settle();
    const panel = m.root.querySelector(".files-cloud-picker")!;
    expect(panel.textContent).toContain("cannot be listed automatically");
    const connect = action(m.root, "attachCloud")!;
    expect(connect.disabled).toBeTrue();
    const input = m.root.querySelector<HTMLInputElement>('[data-key="cloudInput"]')!;
    type(input, "no id here");
    expect(m.root.querySelector<HTMLElement>(".files-cloud-manual .files-field-error")!.hidden).toBeFalse();
    type(input, `https://block2.wainao.chat/projects/${PID}`);
    expect(connect.disabled).toBeFalse();
    connect.click(); await Bun.sleep(20);
    expect(m.root.querySelector(".files-cloud-picker")).toBeNull();
    const chip = m.root.querySelector<HTMLButtonElement>(".files-chip.is-active .files-chip-main")!;
    expect(chip.textContent).toContain("Team Docs");
    expect(m.root.textContent).toContain("Connected cloud Project “Team Docs”");
    expect(action(m.root, "import")!.textContent).toContain("Upload from a folder");
    m.root.querySelector<HTMLButtonElement>(".files-row")!.click(); await Bun.sleep(20);
    expect(action(m.root, "export")!.textContent).toContain("Download to folder");
    action(m.root, "delete")!.click(); await settle();
    expect(m.root.textContent).toContain("deleted from the cloud Project");
    m.view.dispose();
  });

  test("listed Projects connect with one click; a failed list keeps manual entry and a retry", async () => {
    const files = new SyntheticFiles(); files.addRoot("Notes", {}); files.addCloudProject(PID, "Team Docs", {});
    const root = document.createElement("div"); document.body.append(root);
    let fail = true;
    const controller = new FilesController(files, { projects: { async list() { if (fail) throw Object.assign(new Error("x"), { code: "PROJECTS_NOT_CONNECTED" }); return [{ id: PID, name: "Team Docs", description: "Shared docs" }]; } } });
    const view = createFilesView(root, controller, { locale: "zh", pluginVersion: "1.2.0" });
    await controller.init();
    action(root, "cloud")!.click(); await settle();
    expect(root.textContent).toContain("插件还没有连接你的云端账号");
    expect(root.querySelector('[data-key="cloudInput"]')).not.toBeNull();
    fail = false;
    action(root, "retryProjects")!.click(); await settle();
    const project = root.querySelector<HTMLButtonElement>(`[data-key="project:${PID}"]`)!;
    expect(project.textContent).toContain("Shared docs");
    project.click(); await Bun.sleep(20);
    expect(controller.getSnapshot().root?.name).toBe("Team Docs");
    view.dispose();
  });

  test("connecting keeps keyboard focus inside the panel and errors are announced", async () => {
    const files = new SyntheticFiles({ delayMs: 15 }); files.addRoot("Notes", {}); files.addCloudProject(PID, "Team Docs", {});
    files.cloudConnected = false;
    const m = await mount(files);
    action(m.root, "cloud")!.click(); await settle();
    type(m.root.querySelector<HTMLInputElement>('[data-key="cloudInput"]')!, PID);
    const connect = action(m.root, "attachCloud")!;
    connect.focus(); connect.click(); await settle();
    const layer = m.root.querySelector(".files-dialog-layer")!;
    expect(layer.contains(document.activeElement)).toBeTrue();
    expect(m.root.querySelector('.files-cloud-picker [role="status"]')).not.toBeNull();
    await Bun.sleep(40);
    expect(layer.contains(document.activeElement)).toBeTrue();
    expect(m.root.querySelector('.files-cloud-picker [role="alert"]')!.textContent).toContain("not connected to your cloud account");
    m.view.dispose();
  });

  test("attach errors show inside the panel; Escape closes it", async () => {
    const m = await cloudMount("zh", (files) => { files.cloudConnected = false; });
    action(m.root, "cloud")!.click(); await settle();
    type(m.root.querySelector<HTMLInputElement>('[data-key="cloudInput"]')!, PID);
    action(m.root, "attachCloud")!.click(); await Bun.sleep(20);
    const panel = m.root.querySelector(".files-cloud-picker")!;
    expect(panel.textContent).toContain("插件还没有连接你的云端账号");
    expect(panel.textContent).not.toContain("RESOURCE_NOT_AUTHORIZED");
    m.view.setDiagnostics({ developerMode: true });
    expect(m.root.querySelector(".files-cloud-picker")!.textContent).toContain("CLOUD_NOT_CONNECTED");
    m.root.querySelector(".files-dialog-layer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(m.root.querySelector(".files-cloud-picker")).toBeNull();
    m.view.dispose();
  });

  test("not open, unknown outcome (with refresh) and account switch are explained", async () => {
    const m = await cloudMount("zh");
    await m.controller.attachCloud(PID);
    m.files!.failNext("list", "RESOURCE_UNAVAILABLE", "云文件服务尚未开放");
    await m.controller.refresh();
    expect(m.root.textContent).toContain("云文件服务尚未开放");
    m.files!.failNext("list", "RESOURCE_CANCELLED", "请求已中止，云端是否已生效未知，请重新查询后再继续");
    await m.controller.refresh();
    expect(m.root.textContent).toContain("云端是否已经生效未知");
    const refresh = action(m.root, "errorRefresh")!;
    refresh.click(); await Bun.sleep(20);
    expect(m.controller.getSnapshot().error).toBeNull();
    m.files!.failNext("list", "RESOURCE_SCOPE_STALE", "插件界面或账号已变化，请重试");
    await m.controller.refresh();
    expect(m.root.textContent).toContain("页面已失效");
    m.view.dispose();
  });
});

describe("i18n and styles", () => {
  test("zh and en have the same keys", () => {
    const keys = (value: unknown, prefix = ""): string[] => typeof value === "object" && value
      ? Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key)) : [prefix];
    expect(keys(zh).sort()).toEqual(keys(en).sort());
  });

  test("styles use Host tokens and stay narrow-window safe", () => {
    expect(FILES_STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(FILES_STYLES).toContain("@media (max-width:640px)");
    expect(FILES_STYLES).not.toContain("position:fixed");
  });
});
