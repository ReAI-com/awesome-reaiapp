import { expect, test } from "bun:test";
import { runApp, PLATFORM_CONTRACTS, type AppContext, type HostBridge, type HostMessage } from "../src/v1/index";

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const methods = PLATFORM_CONTRACTS.capabilities["resources.files@1"].methods;
const descriptor = (mount = "mount", available = true, list: readonly string[] = methods) => ({
  resourceFiles: { runtimeSessionId: "runtime", surfaceMountId: mount,
    platformCapabilities: { version: 1, capabilities: { "resources.files@1": { version: 1, available, methods: list } } } },
});
const target = { resource: { version: 1 as const, provider: "local" as const, workspaceId: "w", relativePath: "a.txt" }, grantRef: "g" };
const mutation = { requestId: "r", target, expectedRevision: "rev", idempotencyKey: "k" };
// Client method -> exact wire method and a representative payload.
const calls: Array<[keyof AppContext["resourceFiles"], string, unknown]> = [
  ["listRoots", "resources.roots.list", { requestId: "r" }],
  ["pickRoot", "resources.roots.pick", { requestId: "r" }],
  ["attachCloudProject", "resources.roots.attach", { requestId: "r", projectId: "11111111-1111-4111-8111-111111111111" }],
  ["revokeRoot", "resources.roots.revoke", { requestId: "r", grantRef: "g" }],
  ["list", "resources.list", { requestId: "r", target, pageSize: 10 }],
  ["stat", "resources.stat", { requestId: "r", target }],
  ["read", "resources.read", { requestId: "r", target, expectedRevision: "rev", offset: 0, maxBytes: 4 }],
  ["startWrite", "resources.write.start", { ...mutation, sizeBytes: 4 }],
  ["writeChunk", "resources.write.chunk", { requestId: "r", transferId: "t", offset: 0, bodyBase64: "AAAAAA==" }],
  ["commitWrite", "resources.write.commit", { ...mutation, transferId: "t", sha256: "a".repeat(64) }],
  ["cancel", "resources.cancel", { requestId: "r", transferId: "t" }],
  ["mkdir", "resources.mkdir", { ...mutation, name: "d" }],
  ["rename", "resources.rename", { ...mutation, name: "b.txt" }],
  ["move", "resources.move", { ...mutation, destination: target, expectedDestinationRevision: "rev2", name: "b.txt" }],
  ["delete", "resources.delete", mutation],
  ["createFile", "resources.createFile", { ...mutation, name: "c.txt" }],
];

function harness(snapshot: unknown = descriptor()) {
  let receive!: (m: HostMessage) => void;
  let context!: AppContext;
  const wire: { method: string; params: unknown }[] = [];
  const state: { snapshot: unknown; intercept?: (method: string, input: unknown) => Promise<unknown> } = { snapshot };
  const bridge: HostBridge = {
    async request(method, input) {
      wire.push({ method, params: input });
      if (state.intercept) return await state.intercept(method, input) as never;
      return (method === "environment.get" ? state.snapshot : { ok: method }) as never;
    },
    notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp({ activate(ctx) { context = ctx; ctx.surfaces.register("main", surface => surface.ready()); } }, bridge);
  receive({ type: "activate", runtimeSessionId: "runtime" });
  receive({ type: "surface.mount", surfaceMountId: "mount", surfaceId: "main", root: {} });
  return { wire, state, running, get ctx() { return context; } };
}
const invoke = (ctx: AppContext, name: keyof AppContext["resourceFiles"], input: unknown) =>
  (ctx.resourceFiles[name] as (p: unknown) => Promise<unknown>)(input);

test("every client method maps to its contract method with the exact payload", async () => {
  expect(new Set(calls.map(c => c[1]))).toEqual(new Set(methods));
  const h = harness(); await tick();
  for (const [name, method, input] of calls) expect(await invoke(h.ctx, name, input)).toEqual({ ok: method });
  expect(h.wire.filter(c => c.method.startsWith("resources."))).toEqual(calls.map(([, method, params]) => ({ method, params })));
  expect(h.wire.filter(c => c.method === "environment.get").length).toBe(calls.length);
  await h.running.dispose();
});

test("missing, withheld, incomplete and foreign-binding descriptors fail closed before any resource call", async () => {
  for (const snapshot of [undefined, {}, descriptor("mount", false), descriptor("mount", true, methods.filter(m => m !== "resources.roots.pick"))]) {
    const h = harness(snapshot); h.state.snapshot = snapshot; await tick();
    for (const [name, , input] of calls) await expect(invoke(h.ctx, name, input)).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE" });
    expect(h.wire.some(c => c.method.startsWith("resources."))).toBe(false);
    await h.running.dispose();
  }
  const h = harness(descriptor("other-mount")); await tick();
  await expect(h.ctx.resourceFiles.listRoots({ requestId: "r" })).rejects.toMatchObject({ code: "RESOURCE_SCOPE_STALE" });
  await expect(h.ctx.resourceFiles.stat(null as never)).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  expect(h.wire.some(c => c.method.startsWith("resources."))).toBe(false);
  await h.running.dispose();
});

test("Host error codes pass through and late results after unmount are discarded", async () => {
  const h = harness(); await tick();
  h.state.intercept = async (method) => {
    if (method === "environment.get") return h.state.snapshot;
    throw { code: "RESOURCE_REVISION_CONFLICT", message: "changed" };
  };
  await expect(h.ctx.resourceFiles.stat({ requestId: "r", target })).rejects.toMatchObject({ code: "RESOURCE_REVISION_CONFLICT" });
  let release!: () => void;
  h.state.intercept = async (method) => {
    if (method === "environment.get") return h.state.snapshot;
    await new Promise<void>(resolve => { release = resolve; });
    return { resource: target.resource, kind: "file" };
  };
  const pending = h.ctx.resourceFiles.stat({ requestId: "late", target });
  await tick(); await tick();
  await h.running.dispose();
  release();
  await expect(pending).rejects.toMatchObject({ code: "RESOURCE_SCOPE_STALE" });
});

test("a late Host rejection after unmount is reported as stale, not as the old error", async () => {
  const h = harness(); await tick();
  let reject!: (e: unknown) => void;
  h.state.intercept = async (method) => {
    if (method === "environment.get") return h.state.snapshot;
    return await new Promise((_, r) => { reject = r; });
  };
  const pending = h.ctx.resourceFiles.read({ requestId: "late", target, expectedRevision: "rev", offset: 0, maxBytes: 1 });
  await tick(); await tick();
  await h.running.dispose();
  reject({ code: "RESOURCE_REVISION_CONFLICT", message: "old" });
  await expect(pending).rejects.toMatchObject({ code: "RESOURCE_SCOPE_STALE" });
});

test("a Host that predates resources.roots.attach still serves local files; attach alone is unavailable", async () => {
  const before = methods.filter(m => m !== "resources.roots.attach");
  const h = harness(descriptor("mount", true, before)); await tick();
  expect(await h.ctx.resourceFiles.listRoots({ requestId: "r" }) as unknown).toEqual({ ok: "resources.roots.list" });
  await expect(h.ctx.resourceFiles.attachCloudProject({ requestId: "r", projectId: "p" })).rejects.toMatchObject({ code: "HOST_CAPABILITY_NOT_AVAILABLE" });
  expect(h.wire.some(c => c.method === "resources.roots.attach")).toBe(false);
  await h.running.dispose();
});
