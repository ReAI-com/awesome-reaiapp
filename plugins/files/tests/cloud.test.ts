import { describe, expect, test } from "bun:test";
import manifest from "../app.manifest.json";
import { CLOUD_HOST_MESSAGES, cloudErrorCode, parseProjectId } from "../src/adapter";
import { createProjectLister, declaresProjectsEndpoint, PROJECTS_ENDPOINT_ID, type CloudProjectLister } from "../src/cloud-projects";
import { FilesController } from "../src/controller";
import { SyntheticFiles } from "../src/fixtures";

const PID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const OTHER = "11111111-2222-4333-8444-555555555555";

async function setup(options: { projects?: CloudProjectLister | null; files?: SyntheticFiles; cloudFiles?: Record<string, string | null> } = {}) {
  const files = options.files ?? new SyntheticFiles();
  const local = files.addRoot("Notes", { "a.txt": "hello", "big.bin": "x".repeat(1_500_000) });
  files.addCloudProject(PID, "Team Docs", options.cloudFiles ?? { "readme.md": "# cloud", docs: null, "docs/plan.txt": "plan" });
  const controller = new FilesController(files, { pageSize: 50, projects: options.projects ?? null });
  await controller.init();
  return { files, local, controller };
}
const item = (controller: FilesController, name: string) => controller.getSnapshot().items.find((entry) => entry.name === name)!;
async function attached(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  await ctx.controller.attachCloud(PID);
  const grant = ctx.files.cloudGrant(PID)!;
  return { ...ctx, grant };
}

describe("connecting a cloud Project", () => {
  test("an ID attaches after Host confirmation and opens in the same root list", async () => {
    const { controller, files } = await setup();
    expect(controller.getSnapshot().cloudSupported).toBeTrue();
    controller.openCloudPicker();
    expect(controller.getSnapshot().cloudPicker?.listing).toBe("unavailable");
    await controller.attachCloud(PID);
    const snap = controller.getSnapshot();
    expect(snap.cloudPicker).toBeNull();
    expect(snap.notice).toEqual({ kind: "cloudAttached", name: "Team Docs" });
    expect(snap.roots.map((root) => [root.name, root.resource.resource.provider])).toEqual([["Notes", "local"], ["Team Docs", "cloud-project"]]);
    expect(snap.root?.name).toBe("Team Docs");
    expect(snap.items.map((entry) => entry.name)).toEqual(["docs", "readme.md"]);
    expect(files.calls).toContain("attachCloudProject");
  });

  test("a pasted link yields its Project ID; text without an ID never reaches the Host", async () => {
    expect(parseProjectId(`https://block2.wainao.chat/projects/${PID.toUpperCase()}/files?tab=1`)).toBe(PID);
    expect(parseProjectId(`  ${PID} `)).toBe(PID);
    // Host accepts only canonical RFC UUIDs (files/cloud.rs::validate_uuid).
    expect(parseProjectId("plain_id-1")).toBeNull();
    expect(parseProjectId("3f2a1b4c-5d6e-0f70-8a9b-0c1d2e3f4a5b")).toBeNull();
    expect(parseProjectId("3f2a1b4c-5d6e-4f70-7a9b-0c1d2e3f4a5b")).toBeNull();
    expect(parseProjectId(`x${PID}0`)).toBeNull();
    expect(parseProjectId("not a project")).toBeNull();
    expect(parseProjectId("https://example.com/")).toBeNull();
    const { controller, files } = await setup();
    await controller.attachCloud("hello world");
    expect(controller.getSnapshot().error).toMatchObject({ code: "CLOUD_PROJECT_ID_INVALID", operation: "attach" });
    expect(files.calls).not.toContain("attachCloudProject");
    await controller.attachCloud(`https://x.example/p/${PID}`);
    expect(controller.getSnapshot().root?.name).toBe("Team Docs");
  });

  test("declining in the Host dialog keeps everything as it was", async () => {
    const { controller, files } = await setup();
    controller.openCloudPicker();
    files.nextAttach = "deny";
    await controller.attachCloud(PID);
    const snap = controller.getSnapshot();
    expect(snap.notice?.kind).toBe("cloudDeclined");
    expect(snap.cloudPicker).toBeNull();
    expect(snap.roots.map((root) => root.name)).toEqual(["Notes"]);
    expect(snap.root?.name).toBe("Notes");
  });

  test("attaching the same Project twice returns the same root", async () => {
    const { controller, grant } = await attached();
    await controller.attachCloud(PID);
    const roots = controller.getSnapshot().roots.filter((root) => root.resource.resource.provider === "cloud-project");
    expect(roots.map((root) => root.resource.grantRef)).toEqual([grant]);
  });

  test("no plugin cloud connection: explained, local folder and draft untouched", async () => {
    const { controller, files } = await setup();
    await controller.openEntry(item(controller, "a.txt"));
    await controller.openText();
    controller.edit("draft");
    files.cloudConnected = false;
    controller.openCloudPicker();
    await controller.attachCloud(PID);
    const snap = controller.getSnapshot();
    expect(snap.error).toMatchObject({ code: "CLOUD_NOT_CONNECTED", operation: "attach" });
    expect(snap.availability).toBe("ready");
    expect(snap.root?.name).toBe("Notes");
    expect(snap.draft?.text).toBe("draft");
  });

  test("a Project the user cannot access is reported, not attached", async () => {
    const { controller } = await setup();
    await controller.attachCloud(OTHER);
    expect(controller.getSnapshot().error?.code).toBe("CLOUD_NOT_AUTHORIZED");
    expect(controller.getSnapshot().roots).toHaveLength(1);
  });

  test("an older Host without attach keeps local files working", async () => {
    const { controller, files } = await setup();
    files.failNext("attachCloudProject", "HOST_CAPABILITY_NOT_AVAILABLE");
    await controller.attachCloud(PID);
    const snap = controller.getSnapshot();
    expect(snap.error?.code).toBe("CLOUD_NOT_SUPPORTED");
    expect(snap.availability).toBe("ready");
    expect(snap.root?.name).toBe("Notes");
  });

  test("a client without attachCloudProject has no cloud entry", async () => {
    const files = new SyntheticFiles();
    (files as unknown as { attachCloudProject?: unknown }).attachCloudProject = undefined;
    files.addRoot("Notes", {});
    const controller = new FilesController(files);
    await controller.init();
    expect(controller.getSnapshot().cloudSupported).toBeFalse();
    controller.openCloudPicker();
    expect(controller.getSnapshot().cloudPicker).toBeNull();
  });

  test("cloud service not open / route missing during attach use the Host's meaning", async () => {
    const { controller, files } = await setup();
    files.failNext("attachCloudProject", "RESOURCE_UNAVAILABLE", CLOUD_HOST_MESSAGES.notOpen);
    await controller.attachCloud(PID);
    expect(controller.getSnapshot().error).toMatchObject({ code: "CLOUD_NOT_OPEN", detail: CLOUD_HOST_MESSAGES.notOpen });
    files.failNext("attachCloudProject", "RESOURCE_UNAVAILABLE", "云文件服务暂不可用（后台未提供该接口，http 404）");
    await controller.attachCloud(PID);
    expect(controller.getSnapshot().error?.code).toBe("CLOUD_ROUTE_MISSING");
  });
});

describe("listing Projects with the plugin's own connection", () => {
  test("listed Projects are offered; a listing failure still allows manual entry", async () => {
    let fail = false;
    const lister: CloudProjectLister = { async list() { if (fail) throw Object.assign(new Error("x"), { code: "PROJECTS_SCOPE_MISSING" }); return [{ id: PID, name: "Team Docs", description: "shared" }]; } };
    const { controller } = await setup({ projects: lister });
    controller.openCloudPicker();
    await Bun.sleep(1);
    expect(controller.getSnapshot().cloudPicker).toMatchObject({ listing: "ready", projects: [{ id: PID, name: "Team Docs" }] });
    fail = true;
    await controller.loadProjects();
    expect(controller.getSnapshot().cloudPicker).toMatchObject({ listing: "failed", listError: "PROJECTS_SCOPE_MISSING", projects: [] });
    await controller.attachCloud(PID);
    expect(controller.getSnapshot().root?.name).toBe("Team Docs");
  });

  test("GET /projects responses map to stable codes and never leak tokens", async () => {
    const calls: { url: string; init: RequestInit & { endpointId?: string } }[] = [];
    const respond = (status: number, body: unknown) => ({ async fetch(url: RequestInfo | URL, init?: RequestInit & { endpointId?: string }) { calls.push({ url: String(url), init: init ?? {} }); return new Response(JSON.stringify(body), { status }); } });
    const ok = await createProjectLister(respond(200, { success: true, data: [{ id: OTHER, name: "B" }, { id: PID, name: "A", description: "d" }, { id: "bad id!", name: "x" }, { name: "noid" }] })).list();
    expect(ok).toEqual([{ id: PID, name: "A", description: "d" }, { id: OTHER, name: "B", description: "" }]);
    expect(calls[0]!.url).toBe("https://block2-api.wainao.chat/projects");
    expect(calls[0]!.init).toMatchObject({ endpointId: PROJECTS_ENDPOINT_ID, method: "GET" });
    expect(JSON.stringify(calls[0]!.init.headers ?? {})).not.toMatch(/authorization/i);
    const code = async (http: Parameters<typeof createProjectLister>[0]) => { try { await createProjectLister(http).list(); return "ok"; } catch (error) { return (error as { code: string }).code; } };
    expect(await code(respond(401, { error: "unauthorized" }))).toBe("PROJECTS_NOT_CONNECTED");
    expect(await code(respond(403, { error: "insufficient_scope" }))).toBe("PROJECTS_SCOPE_MISSING");
    expect(await code(respond(404, {}))).toBe("PROJECTS_NOT_OFFERED");
    expect(await code(respond(500, {}))).toBe("PROJECTS_UNREACHABLE");
    expect(await code(respond(200, { data: "nope" }))).toBe("PROJECTS_INVALID");
    expect(await code({ async fetch() { throw Object.assign(new Error("x"), { code: "NETWORK_ENDPOINT_UNDECLARED" }); } })).toBe("PROJECTS_NOT_OFFERED");
    expect(await code({ async fetch() { throw new Error("offline"); } })).toBe("PROJECTS_UNREACHABLE");
    expect(await code({ async fetch() { throw Object.assign(new Error("x"), { code: "PLUGIN_OAUTH_NOT_CONNECTED" }); } })).toBe("PROJECTS_NOT_CONNECTED");
    for (const permission of ["NETWORK_PERMISSION_REQUIRED", "PLUGIN_PERMISSION_DENIED", "PLUGIN_PERMISSION_REQUIRED"]) {
      expect(await code({ async fetch() { throw Object.assign(new Error("x"), { code: permission }); } })).toBe("PROJECTS_PERMISSION_REQUIRED");
    }
  });

  test("this package does not declare the Projects endpoint yet (no OAuth client registered)", () => {
    expect(declaresProjectsEndpoint(manifest)).toBeFalse();
    const patched = { ...manifest, oauthAppId: "abcdefghijklmnopqrstuvwxyz012345", network: { policyVersion: 1, endpoints: [{ id: PROJECTS_ENDPOINT_ID, auth: { mode: "oauth_app" } }] } };
    expect(declaresProjectsEndpoint(patched)).toBeTrue();
    expect(declaresProjectsEndpoint({ ...patched, oauthAppId: "" })).toBeFalse();
  });
});

describe("cloud root uses the same UI as local folders", () => {
  test("browse, open, edit and save a cloud file", async () => {
    const { controller, files, grant } = await attached();
    await controller.openEntry(item(controller, "docs"));
    expect(controller.getSnapshot().trail.map((crumb) => crumb.name)).toEqual(["Team Docs", "docs"]);
    await controller.openEntry(item(controller, "plan.txt"));
    await controller.openText();
    controller.edit("new plan");
    await controller.save();
    expect(controller.getSnapshot().notice?.kind).toBe("saved");
    expect(files.text(grant, "docs/plan.txt")).toBe("new plan");
    expect(controller.getSnapshot().selected?.resource.provider).toBe("cloud-project");
  });

  test("a CAS conflict keeps the draft; reload or save-as both work", async () => {
    const { controller, files, grant } = await attached();
    await controller.openEntry(item(controller, "readme.md"));
    await controller.openText();
    controller.edit("mine");
    files.externalWrite(grant, "readme.md", "theirs");
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, draft: { text: "mine", dirty: true } });
    expect(files.text(grant, "readme.md")).toBe("theirs");
    await controller.saveAs("mine.md");
    expect(files.text(grant, "mine.md")).toBe("mine");
    await controller.openEntry(item(controller, "readme.md"));
    await controller.openText();
    controller.edit("again");
    files.externalWrite(grant, "readme.md", "theirs 2");
    await controller.save();
    await controller.reloadFromDisk();
    expect(controller.getSnapshot().draft).toMatchObject({ text: "theirs 2", dirty: false });
  });

  test("create, rename and delete in a cloud Project", async () => {
    const { controller, files, grant } = await attached();
    await controller.createFile("n.txt");
    await controller.createFolder("folder");
    expect(files.has(grant, "n.txt") && files.has(grant, "folder")).toBeTrue();
    await controller.rename(item(controller, "n.txt"), "m.txt");
    expect(files.has(grant, "m.txt")).toBeTrue();
    await controller.remove(item(controller, "m.txt"));
    expect(files.has(grant, "m.txt")).toBeFalse();
    expect(controller.getSnapshot().error).toBeNull();
  });

  test("upload from a local folder (>1 MiB) reports progress across chunks", async () => {
    const { controller, files, grant } = await attached();
    const seen: number[] = [];
    controller.subscribe((snap) => { if (snap.busy?.progress) seen.push(snap.busy.progress.done); });
    controller.startImport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.name === "Notes")!);
    const big = controller.getSnapshot().chooser!.items.find((entry) => entry.name === "big.bin")!;
    await controller.chooserOpen(big);
    expect(controller.getSnapshot().notice).toEqual({ kind: "imported", name: "big.bin" });
    expect(files.text(grant, "big.bin")?.length).toBe(1_500_000);
    expect(seen.length).toBeGreaterThan(4);
    expect(seen.at(-1)).toBe(1_500_000);
  });

  test("cancelling an upload removes the empty cloud placeholder", async () => {
    const files = new SyntheticFiles({ delayMs: 5 });
    const { controller, grant } = await attached({ files });
    controller.startImport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.name === "Notes")!);
    const big = controller.getSnapshot().chooser!.items.find((entry) => entry.name === "big.bin")!;
    const running = controller.chooserOpen(big);
    await Bun.sleep(30);
    expect(controller.getSnapshot().busy?.cancellable).toBeTrue();
    await controller.cancel();
    await running;
    expect(controller.getSnapshot().notice?.kind).toBe("cancelled");
    expect(files.has(grant, "big.bin")).toBeFalse();
    expect(files.openTransfers()).toBe(0);
  });

  test("download a cloud file into a local folder", async () => {
    const { controller, files, local } = await attached();
    await controller.openEntry(item(controller, "readme.md"));
    controller.startExport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.name === "Notes")!);
    await controller.exportHere();
    expect(controller.getSnapshot().notice).toEqual({ kind: "exported", name: "readme.md" });
    expect(files.text(local, "readme.md")).toBe("# cloud");
  });

  test("disconnecting a cloud Project revokes only that root", async () => {
    const { controller, grant } = await attached();
    await controller.removeRoot(controller.getSnapshot().roots.find((root) => root.resource.grantRef === grant)!);
    const snap = controller.getSnapshot();
    expect(snap.roots.map((root) => root.name)).toEqual(["Notes"]);
    expect(snap.root).toBeNull();
    expect(snap.notice).toEqual({ kind: "rootRemoved", name: "Team Docs" });
  });
});

describe("cloud states", () => {
  test("service not open / route missing while browsing", async () => {
    const { controller, files } = await attached();
    files.failNext("list", "RESOURCE_UNAVAILABLE", CLOUD_HOST_MESSAGES.notOpen);
    await controller.refresh();
    expect(controller.getSnapshot().error?.code).toBe("CLOUD_NOT_OPEN");
    files.failNext("list", "RESOURCE_UNAVAILABLE", "云文件服务暂不可用（后台未提供该接口，http 405）");
    await controller.refresh();
    expect(controller.getSnapshot().error?.code).toBe("CLOUD_ROUTE_MISSING");
    await controller.refresh();
    expect(controller.getSnapshot().error).toBeNull();
  });

  test("withdrawn access keeps unsaved text and explains it", async () => {
    const { controller, files } = await attached();
    await controller.openEntry(item(controller, "readme.md"));
    await controller.openText();
    controller.edit("unsaved cloud text");
    files.failNext("startWrite", "RESOURCE_NOT_AUTHORIZED", "插件没有访问该云项目或文件的权限（project acl）");
    await controller.save();
    const snap = controller.getSnapshot();
    expect(snap.error?.code).toBe("CLOUD_NOT_AUTHORIZED");
    expect(snap.recovered).toEqual({ name: "readme.md", text: "unsaved cloud text" });
    expect(snap.root).toBeNull();
  });

  test("plugin cloud connection lost mid-session is shown as not connected", async () => {
    const { controller, files } = await attached();
    files.failNext("list", "RESOURCE_NOT_AUTHORIZED", CLOUD_HOST_MESSAGES.notConnected);
    await controller.refresh();
    expect(controller.getSnapshot().error?.code).toBe("CLOUD_NOT_CONNECTED");
  });

  test("an unknown outcome is never reported as cancelled and offers a refresh", async () => {
    const { controller, files, grant } = await attached();
    await controller.openEntry(item(controller, "readme.md"));
    await controller.openText();
    controller.edit("maybe saved");
    files.failNext("commitWrite", "RESOURCE_CANCELLED", "请求已中止，云端是否已生效未知，请重新查询后再继续");
    await controller.save();
    const snap = controller.getSnapshot();
    expect(snap.error?.code).toBe("CLOUD_OUTCOME_UNKNOWN");
    expect(snap.notice?.kind).not.toBe("cancelled");
    expect(snap.draft).toMatchObject({ text: "maybe saved", dirty: true });
    expect(files.has(grant, "readme.md")).toBeTrue();
    await controller.refresh();
    expect(controller.getSnapshot().error).toBeNull();
  });

  test("a user cancel the Host cannot confirm is reported as unknown, never as cancelled", async () => {
    const files = new SyntheticFiles({ delayMs: 5 });
    const { controller } = await attached({ files });
    controller.startImport();
    await controller.chooserOpenRoot(controller.getSnapshot().roots.find((root) => root.name === "Notes")!);
    const big = controller.getSnapshot().chooser!.items.find((entry) => entry.name === "big.bin")!;
    const running = controller.chooserOpen(big);
    // 等到传输真正开始（第一块已发出，控制器已持有 transferId）再取消；
    // 固定 sleep 在负载下可能早于 startWrite 完成，取消就退化成“上传前取消”。
    for (const deadline = Date.now() + 5_000; !files.calls.includes("writeChunk"); await Bun.sleep(1)) {
      if (Date.now() > deadline) throw new Error("upload never started");
    }
    files.failNext("cancel", "RESOURCE_CANCELLED", "请求已中止，云端是否已生效未知，请重新查询后再继续");
    await controller.cancel();
    await running;
    const snap = controller.getSnapshot();
    expect(snap.error?.code).toBe("CLOUD_OUTCOME_UNKNOWN");
    expect(snap.notice?.kind).not.toBe("cancelled");
  });

  for (const [fatal, expected] of [["RESOURCE_SCOPE_STALE", "stale"], ["PLUGIN_PERMISSION_DENIED", "notAuthorized"], ["HOST_CAPABILITY_NOT_AVAILABLE", "notOpen"]] as const) {
    test(`losing ${fatal} still wins when the cleanup cancel reports an unknown outcome`, async () => {
      const { controller, files } = await attached();
      await controller.openEntry(item(controller, "readme.md"));
      await controller.openText();
      controller.edit("dirty");
      files.failNext("writeChunk", fatal);
      files.failNext("cancel", "RESOURCE_CANCELLED", "请求已中止，云端是否已生效未知，请重新查询后再继续");
      await controller.save();
      const snap = controller.getSnapshot();
      expect(snap.availability).toBe(expected);
      expect(snap.root).toBeNull();
      expect(snap.items).toEqual([]);
    });
  }

  test("the reason for lost cloud access survives the automatic root re-read", async () => {
    const { controller, files } = await attached();
    files.failNext("list", "RESOURCE_NOT_AUTHORIZED", "插件没有访问该云项目或文件的权限（project acl）");
    await controller.refresh();
    await Bun.sleep(20);
    const snap = controller.getSnapshot();
    expect(snap.busy).toBeNull();
    expect(snap.error?.code).toBe("CLOUD_NOT_AUTHORIZED");
    expect(snap.roots.length).toBe(2);
  });

  test("account switch (scope stale) clears the page", async () => {
    const { controller, files } = await attached();
    files.failNext("list", "RESOURCE_SCOPE_STALE", "插件界面或账号已变化，请重试");
    await controller.refresh();
    const snap = controller.getSnapshot();
    expect(snap.availability).toBe("stale");
    expect(snap.roots).toEqual([]);
    expect(snap.cloudSupported).toBeTrue();
  });

  test("local Host errors are never mistaken for cloud ones", () => {
    expect(cloudErrorCode("RESOURCE_NOT_AUTHORIZED", "folder revoked")).toBeNull();
    expect(cloudErrorCode("RESOURCE_UNAVAILABLE", "")).toBeNull();
    expect(cloudErrorCode("RESOURCE_IO_FAILED", CLOUD_HOST_MESSAGES.unreachable)).toBe("CLOUD_UNREACHABLE");
  });
});
