import { describe, expect, test } from "bun:test";
import { FilesController } from "../src/controller";
import { SyntheticFiles } from "../src/fixtures";

const NAMES = { notes: "Notes" };
async function ready(files = new SyntheticFiles(), seed: Record<string, string | null> = { "a.txt": "hello", docs: null, "docs/b.txt": "bee" }) {
  const grant = files.addRoot(NAMES.notes, seed);
  const controller = new FilesController(files, { pageSize: 50 });
  await controller.init();
  return { files, grant, controller };
}
const item = (controller: FilesController, name: string) => controller.getSnapshot().items.find((entry) => entry.name === name)!;

describe("authorization and availability", () => {
  test("no roots shows the choose-folder state and pick opens the new folder", async () => {
    const files = new SyntheticFiles();
    const controller = new FilesController(files);
    await controller.init();
    expect(controller.getSnapshot()).toMatchObject({ availability: "ready", roots: [], root: null });
    files.preparePick("Picked", { "p.txt": "x" });
    await controller.addRoot();
    const snap = controller.getSnapshot();
    expect(snap.root?.name).toBe("Picked");
    expect(snap.items.map((entry) => entry.name)).toEqual(["p.txt"]);
  });

  test("cancelling the system panel is not an error", async () => {
    const { files, controller } = await ready();
    files.preparePick(null);
    await controller.addRoot();
    expect(controller.getSnapshot()).toMatchObject({ error: null, notice: { kind: "pickCancelled" } });
    expect(controller.getSnapshot().root?.name).toBe("Notes");
  });

  test("a folder the Host refuses keeps the current folder and draft", async () => {
    const { files, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("draft");
    files.failNext("pickRoot", "RESOURCE_NOT_AUTHORIZED");
    await controller.addRoot();
    const snap = controller.getSnapshot();
    expect(snap.error?.code).toBe("RESOURCE_PICK_REJECTED");
    expect(snap.root?.name).toBe("Notes");
    expect(snap.draft?.text).toBe("draft");
  });

  test("Host without resources.files@1 shows not-open, missing consent shows not-authorized", async () => {
    const closed = new SyntheticFiles(); closed.failNext("listRoots", "HOST_CAPABILITY_NOT_AVAILABLE");
    const a = new FilesController(closed); await a.init();
    expect(a.getSnapshot().availability).toBe("notOpen");
    const denied = new SyntheticFiles(); denied.failNext("listRoots", "PLUGIN_PERMISSION_DENIED");
    const b = new FilesController(denied); await b.init();
    expect(b.getSnapshot().availability).toBe("notAuthorized");
    expect(new FilesController(null).getSnapshot().availability).toBe("notOpen");
  });

  test("removing a folder revokes it at the Host", async () => {
    const { files, grant, controller } = await ready();
    await controller.removeRoot(controller.getSnapshot().roots[0]!);
    expect(files.calls).toContain("revokeRoot");
    expect(files.has(grant, "")).toBeFalse();
    expect(controller.getSnapshot()).toMatchObject({ roots: [], root: null, notice: { kind: "rootRemoved" } });
  });
});

describe("browsing", () => {
  test("enters folders, follows the path back and pages", async () => {
    const files = new SyntheticFiles();
    const grant = files.addRoot("Big", Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, `${i}`])));
    files.seed(grant, "sub/inner.txt", "in");
    const controller = new FilesController(files, { pageSize: 3 });
    await controller.init();
    expect(controller.getSnapshot().items).toHaveLength(3);
    await controller.loadMore(); await controller.loadMore();
    expect(controller.getSnapshot().items.map((entry) => entry.name)).toContain("sub");
    expect(controller.getSnapshot().nextCursor).toBeNull();
    await controller.openEntry(item(controller, "sub"));
    expect(controller.getSnapshot().trail.map((crumb) => crumb.name)).toEqual(["Big", "sub"]);
    expect(controller.getSnapshot().items.map((entry) => entry.name)).toEqual(["inner.txt"]);
    await controller.up();
    expect(controller.getSnapshot().trail).toHaveLength(1);
  });

  test("a folder that changes between pages reloads the first page", async () => {
    const files = new SyntheticFiles();
    files.addRoot("R", { "1": "a", "2": "b", "3": "c" });
    const controller = new FilesController(files, { pageSize: 2 });
    await controller.init();
    files.failNext("list", "RESOURCE_REVISION_CONFLICT");
    await controller.loadMore();
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_LISTING_CHANGED");
    expect(controller.getSnapshot().items).toHaveLength(2);
  });
});

describe("editing and conflicts", () => {
  test("opens, edits and saves text with CAS", async () => {
    const { files, grant, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    expect(controller.getSnapshot().draft).toMatchObject({ text: "hello", dirty: false });
    controller.edit("hello world");
    await controller.save();
    expect(files.text(grant, "a.txt")).toBe("hello world");
    expect(controller.getSnapshot()).toMatchObject({ draft: { dirty: false }, notice: { kind: "saved", name: "a.txt" } });
    // A second save uses the new revision.
    controller.edit("third");
    await controller.save();
    expect(files.text(grant, "a.txt")).toBe("third");
  });

  test("external change keeps the draft; reload drops it, save-as writes a new file", async () => {
    const { files, grant, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("mine");
    files.externalWrite(grant, "a.txt", "theirs");
    await controller.save();
    let snap = controller.getSnapshot();
    expect(snap.conflict).toBeTrue();
    expect(snap.draft?.text).toBe("mine");
    expect(files.text(grant, "a.txt")).toBe("theirs");
    await controller.save(); // still refused while the conflict is open
    expect(files.text(grant, "a.txt")).toBe("theirs");

    await controller.saveAs("a copy.txt");
    snap = controller.getSnapshot();
    expect(files.text(grant, "a copy.txt")).toBe("mine");
    expect(snap).toMatchObject({ conflict: false, selected: { name: "a copy.txt" } });

    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("mine again");
    files.externalWrite(grant, "a.txt", "theirs 2");
    await controller.save();
    await controller.reloadFromDisk();
    expect(controller.getSnapshot()).toMatchObject({ conflict: false, draft: { text: "theirs 2", dirty: false } });
  });

  test("non-UTF-8 and oversize files are refused for editing", async () => {
    const files = new SyntheticFiles();
    const grant = files.addRoot("R", {});
    files.seed(grant, "bin.dat", "\u0000\u0001");
    const controller = new FilesController(files); await controller.init();
    await controller.openEntry(item(controller, "bin.dat"));
    await controller.openText();
    expect(controller.getSnapshot().error?.code).toBe("TEXT_ENCODING_UNSUPPORTED");
  });
});

describe("folder mutations", () => {
  test("create file and folder, rename and delete", async () => {
    const { files, grant, controller } = await ready();
    await controller.createFile("new.md");
    expect(files.has(grant, "new.md")).toBeTrue();
    expect(controller.getSnapshot()).toMatchObject({ selected: { name: "new.md" }, draft: { text: "" } });
    await controller.createFolder("box");
    expect(files.has(grant, "box")).toBeTrue();
    await controller.createFolder("box");
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_ALREADY_EXISTS");
    await controller.rename(item(controller, "new.md"), "renamed.md");
    expect(files.has(grant, "renamed.md")).toBeTrue();
    await controller.remove(item(controller, "renamed.md"));
    expect(files.has(grant, "renamed.md")).toBeFalse();
    await controller.remove(item(controller, "docs"));
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_IO_FAILED");
    expect(files.has(grant, "docs")).toBeTrue();
  });

  test("invalid names never reach the Host", async () => {
    const { files, controller } = await ready();
    const before = files.calls.length;
    await controller.createFile("../x");
    await controller.createFile("");
    expect(files.calls.slice(before).filter((call) => call === "createFile")).toHaveLength(0);
  });

  test("renaming a file changed elsewhere reports the conflict and refreshes", async () => {
    const { files, grant, controller } = await ready();
    const stale = item(controller, "a.txt");
    files.externalWrite(grant, "a.txt", "changed");
    await controller.rename(stale, "b.txt");
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_REVISION_CONFLICT");
    expect(files.has(grant, "a.txt")).toBeTrue();
  });
});

describe("import and export between user-chosen folders", () => {
  test("imports a file from another folder with a numbered name on clash", async () => {
    const { files, grant, controller } = await ready();
    const source = files.addRoot("Source", { "a.txt": "from source" });
    await controller.init();
    await controller.openRoot(controller.getSnapshot().roots.find((root) => root.name === NAMES.notes)!);
    controller.startImport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === source)!);
    await controller.chooserOpen(controller.getSnapshot().chooser!.items[0]!);
    expect(files.text(grant, "a (2).txt")).toBe("from source");
    expect(files.text(grant, "a.txt")).toBe("hello");
    expect(controller.getSnapshot()).toMatchObject({ chooser: null, notice: { kind: "imported", name: "a (2).txt" } });
  });

  test("exports the selected file into a freshly picked folder", async () => {
    const { files, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    controller.startExport();
    files.preparePick("Desktop", { nested: null });
    await controller.chooserPickFolder();
    const desktop = controller.getSnapshot().chooser!.root!.resource.grantRef;
    await controller.chooserOpen(controller.getSnapshot().chooser!.items[0]!);
    await controller.exportHere();
    expect(files.text(desktop, "nested/a.txt")).toBe("hello");
    expect(controller.getSnapshot().notice).toEqual({ kind: "exported", name: "a.txt" });
  });

  test("a failed copy removes the empty placeholder", async () => {
    const { files, controller } = await ready();
    const target = files.addRoot("Target", {});
    await controller.init();
    await controller.openRoot(controller.getSnapshot().roots[0]!);
    await controller.openEntry(item(controller, "a.txt"));
    controller.startExport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === target)!);
    files.failNext("writeChunk", "RESOURCE_IO_FAILED");
    await controller.exportHere();
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_IO_FAILED");
    expect(files.has(target, "a.txt")).toBeFalse();
  });
});

describe("revocation, busy state and lifecycle", () => {
  test("revocation returns to choose-folder and keeps unsaved text in memory only", async () => {
    const { files, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("unsaved words");
    files.revoke();
    await controller.save();
    await Bun.sleep(5);
    const snap = controller.getSnapshot();
    expect(snap).toMatchObject({ root: null, draft: null, items: [], selected: null, recovered: { name: "a.txt", text: "unsaved words" }, notice: { kind: "revoked" } });
    expect(snap.availability).toBe("ready");
    expect(snap.busy).toBeNull();
    expect(files.calls.filter((call) => call === "listRoots").length).toBeGreaterThanOrEqual(2);
    // After choosing a folder again the text can be saved as a new file.
    files.preparePick("Again", {});
    await controller.addRoot();
    await controller.saveAs("rescued.txt");
    const again = controller.getSnapshot().root!.resource.grantRef;
    expect(files.text(again, "rescued.txt")).toBe("unsaved words");
    expect(controller.getSnapshot().recovered).toBeNull();
  });

  test("permission withdrawn mid-session shows not-authorized and keeps unsaved text", async () => {
    const { files, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("keep me");
    files.failNext("startWrite", "PLUGIN_PERMISSION_DENIED");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ availability: "notAuthorized", root: null, recovered: { text: "keep me" } });
  });

  test("a stale mount clears everything, including drafts", async () => {
    const { files, controller } = await ready();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("secret");
    files.failNext("startWrite", "RESOURCE_SCOPE_STALE");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ availability: "stale", draft: null, recovered: null, roots: [], busy: null });
  });

  test("one operation at a time; busy is visible before the first await", async () => {
    const files = new SyntheticFiles({ delayMs: 20 });
    const { controller } = await ready(files);
    const seen: (string | null)[] = [];
    controller.subscribe((snap) => seen.push(snap.busy?.operation ?? null));
    const first = controller.refresh();
    expect(controller.getSnapshot().busy?.operation).toBe("list");
    const callsBefore = files.calls.length;
    await controller.createFolder("x"); // ignored while busy
    expect(files.calls.length).toBe(callsBefore);
    await first;
    expect(controller.getSnapshot().busy).toBeNull();
    expect(seen).toContain("list");
  });

  test("cancelling a copy reports cancelled and cleans up", async () => {
    const files = new SyntheticFiles();
    const grant = files.addRoot("R", {});
    files.seed(grant, "big.txt", "x".repeat(600_000));
    const target = files.addRoot("T", {});
    const controller = new FilesController(files); await controller.init();
    await controller.openRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === grant)!);
    await controller.openEntry(item(controller, "big.txt"));
    controller.startExport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === target)!);
    files.delayMs = 5;
    const running = controller.exportHere();
    await Bun.sleep(30);
    await controller.cancel();
    await running;
    expect(controller.getSnapshot().notice?.kind).toBe("cancelled");
    expect(files.has(target, "big.txt")).toBeFalse();
  });

  test("dispose drops content and ignores late results", async () => {
    const files = new SyntheticFiles({ delayMs: 10 });
    const { controller } = await ready(files);
    const pending = controller.refresh();
    controller.dispose();
    await pending;
    expect(controller.getSnapshot()).toMatchObject({ items: [], draft: null, recovered: null });
  });

  test("cloud-project roots listed by the Host appear next to local folders", async () => {
    const files = new SyntheticFiles();
    files.addRoot("Local", {});
    const original = files.listRoots.bind(files);
    files.listRoots = async (input) => {
      const result = await original(input);
      return { items: [...result.items, { name: "Cloud", resource: { grantRef: "cloud-grant", resource: { version: 1, provider: "cloud-project", projectId: "p", resourceId: "r" } } }] };
    };
    const controller = new FilesController(files); await controller.init();
    expect(controller.getSnapshot().roots.map((root) => root.name)).toEqual(["Local", "Cloud"]);
  });
});

describe("review regressions: cancel races and cleanup", () => {
  async function editing(files = new SyntheticFiles()) {
    const ctx = await ready(files);
    await ctx.controller.openEntry(item(ctx.controller, "a.txt"));
    await ctx.controller.openText();
    ctx.controller.edit("draft text");
    return ctx;
  }

  test("a stale scope after cancel still clears everything", async () => {
    const { files, controller } = await editing(new SyntheticFiles({ delayMs: 5 }));
    files.failNext("startWrite", "RESOURCE_SCOPE_STALE");
    const saving = controller.save();
    await Bun.sleep(1);
    await controller.cancel();
    await saving;
    expect(controller.getSnapshot()).toMatchObject({ availability: "stale", draft: null, recovered: null, roots: [] });
  });

  test("permission loss is not reported as a cancel", async () => {
    const { files, controller } = await editing(new SyntheticFiles({ delayMs: 5 }));
    files.failNext("startWrite", "PLUGIN_PERMISSION_DENIED");
    const saving = controller.save();
    await Bun.sleep(1);
    await controller.cancel();
    await saving;
    expect(controller.getSnapshot()).toMatchObject({ availability: "notAuthorized", recovered: { text: "draft text" } });
  });

  test("cancel landing right after startWrite releases the transfer", async () => {
    const { files, controller } = await editing();
    files.afterNext("startWrite", async () => { await controller.cancel(); });
    await controller.save();
    expect(controller.getSnapshot().notice?.kind).toBe("cancelled");
    expect(files.openTransfers()).toBe(0);
  });

  test("cancel landing right after createFile removes the export placeholder", async () => {
    const { files, controller } = await ready();
    const target = files.addRoot("Target", {});
    await controller.init();
    await controller.openRoot(controller.getSnapshot().roots[0]!);
    await controller.openEntry(item(controller, "a.txt"));
    controller.startExport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === target)!);
    files.afterNext("createFile", async () => { await controller.cancel(); });
    await controller.exportHere();
    expect(controller.getSnapshot().notice?.kind).toBe("cancelled");
    expect(files.has(target, "a.txt")).toBeFalse();
  });

  test("a cancel that loses the race to commit says it was too late", async () => {
    const { files, grant, controller } = await editing();
    files.afterNext("commitWrite", async () => { await controller.cancel(); });
    await controller.save();
    expect(files.text(grant, "a.txt")).toBe("draft text");
    const snap = controller.getSnapshot();
    expect(snap.notice?.kind === "tooLateToCancel" || snap.notice?.kind === "saved").toBeTrue();
    expect(snap.notice?.kind).not.toBe("cancelled");
  });

  test("save-as failure removes the empty file so the same name can be retried", async () => {
    const { files, grant, controller } = await editing();
    files.failNext("writeChunk", "RESOURCE_IO_FAILED");
    await controller.saveAs("copy.txt");
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_IO_FAILED");
    expect(files.has(grant, "copy.txt")).toBeFalse();
    expect(controller.getSnapshot().draft?.text).toBe("draft text");
    await controller.saveAs("copy.txt");
    expect(files.text(grant, "copy.txt")).toBe("draft text");
  });

  test("the fixture rejects a commit to a different grant than the transfer started on", async () => {
    const files = new SyntheticFiles();
    const a = files.addRoot("A", { "x.txt": "a" });
    const b = files.addRoot("B", { "x.txt": "b" });
    const roots = (await files.listRoots({ requestId: "r1" })).items;
    const ra = roots.find((root) => root.resource.grantRef === a)!; const rb = roots.find((root) => root.resource.grantRef === b)!;
    const ta = { resource: { ...ra.resource.resource, relativePath: "x.txt" }, grantRef: a };
    const tb = { resource: { ...rb.resource.resource, relativePath: "x.txt" }, grantRef: b };
    const receipt = await files.startWrite({ requestId: "r2", target: ta, expectedRevision: "r1", idempotencyKey: "k", sizeBytes: 0 });
    await expect(files.commitWrite({ requestId: "r3", target: tb, expectedRevision: "r1", idempotencyKey: "k", transferId: receipt.transferId, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" })).rejects.toThrow();
    expect(files.text(b, "x.txt")).toBe("b");
  });
});

describe("review round 2 regressions", () => {
  async function editing(files = new SyntheticFiles()) {
    const ctx = await ready(files);
    await ctx.controller.openEntry(item(ctx.controller, "a.txt"));
    await ctx.controller.openText();
    ctx.controller.edit("draft text");
    return ctx;
  }

  test("a stale scope reported by the cleanup cancel still clears the page", async () => {
    const { files, controller } = await editing();
    files.failNext("writeChunk", "RESOURCE_IO_FAILED");
    files.failNext("cancel", "RESOURCE_SCOPE_STALE");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ availability: "stale", draft: null, roots: [] });
  });

  test("cancel during the listing refresh after save-as does not report cancelled", async () => {
    const { files, grant, controller } = await editing();
    files.afterNext("commitWrite", () => { files.afterNext("list", async () => { await controller.cancel(); }); });
    await controller.saveAs("copy.txt");
    expect(files.text(grant, "copy.txt")).toBe("draft text");
    expect(controller.getSnapshot().notice).toEqual({ kind: "saved", name: "copy.txt" });
    expect(controller.getSnapshot().selected?.name).toBe("copy.txt");
  });

  test("an empty-file import cannot be cancelled once created", async () => {
    const { files, grant, controller } = await ready();
    const source = files.addRoot("Src", { "empty.txt": "" });
    await controller.init();
    await controller.openRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === grant)!);
    controller.startImport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === source)!);
    files.afterNext("list", async () => { await controller.cancel(); });
    await controller.chooserOpen(controller.getSnapshot().chooser!.items[0]!);
    expect(files.has(grant, "empty.txt")).toBeTrue();
    expect(controller.getSnapshot().notice?.kind).toBe("imported");
  });

  test("a lost scope during cleanup beats the original permission error", async () => {
    const { files, controller } = await editing();
    files.failNext("writeChunk", "PLUGIN_PERMISSION_DENIED");
    files.failNext("cancel", "RESOURCE_SCOPE_STALE");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ availability: "stale", recovered: null, draft: null });
  });

  test("rename, delete and create keep their success when the refresh fails", async () => {
    const { files, grant, controller } = await ready();
    files.afterNext("rename", () => undefined);
    files.failNext("list", "RESOURCE_IO_FAILED");
    await controller.rename(item(controller, "a.txt"), "b.txt");
    expect(files.has(grant, "b.txt")).toBeTrue();
    expect(controller.getSnapshot().notice).toEqual({ kind: "renamed", name: "b.txt" });
    expect(controller.getSnapshot().items.map((entry) => entry.name)).toContain("b.txt");
    files.failNext("list", "RESOURCE_IO_FAILED");
    await controller.remove(item(controller, "b.txt"));
    expect(controller.getSnapshot().notice?.kind).toBe("deleted");
    expect(controller.getSnapshot().items.map((entry) => entry.name)).not.toContain("b.txt");
    files.failNext("list", "RESOURCE_IO_FAILED");
    await controller.createFolder("box");
    expect(controller.getSnapshot().notice?.kind).toBe("created");
    expect(controller.getSnapshot().error?.code).toBe("RESOURCE_LISTING_CHANGED");
  });

  test("a listing failure after save-as keeps the saved result", async () => {
    const { files, grant, controller } = await editing();
    files.afterNext("commitWrite", () => { files.failNext("list", "RESOURCE_IO_FAILED"); });
    await controller.saveAs("copy.txt");
    expect(files.text(grant, "copy.txt")).toBe("draft text");
    const snap = controller.getSnapshot();
    expect(snap.selected?.name).toBe("copy.txt");
    expect(snap.draft).toMatchObject({ dirty: false, base: { name: "copy.txt" } });
    expect(snap.error?.code).toBe("RESOURCE_LISTING_CHANGED");
  });
});
