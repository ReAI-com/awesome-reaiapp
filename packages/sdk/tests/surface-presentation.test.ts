import { expect, spyOn, test } from "bun:test";
import { defineApp, runApp, type HostBridge, type HostMessage, type SurfaceHandle } from "../src/v1/index";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function fixture(beforeMount = false) {
  let receive!: (message: HostMessage) => void;
  let surface!: SurfaceHandle;
  const bridge: HostBridge = {
    async request() { return {} as never; },
    notify() {},
    subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp(defineApp({ activate(ctx) {
    ctx.surfaces.register("main", handle => { surface = handle; handle.ready(); });
  } }), bridge);
  const present = (token: string, runtime = "rt", mount = "mount") => receive({
    type: "surface.presentation", runtimeSessionId: runtime, surfaceMountId: mount, presentationToken: token,
  });
  receive({ type: "activate", runtimeSessionId: "rt" });
  if (beforeMount) present("initial");
  receive({ type: "surface.mount", surfaceId: "main", surfaceMountId: "mount", root: {} });
  await tick();
  return { running, surface, present, unmount: () => receive({ type: "surface.unmount", surfaceMountId: "mount" }) };
}

test("hidden mount waits for valid new bindings; duplicate, malformed and foreign bindings do not notify", async () => {
  const f = await fixture();
  let count = 0;
  f.surface.onPresentationChange!(() => count++);
  expect(count).toBe(0);
  f.present("p1", "old");
  f.present("");
  f.present("bad token");
  f.present("p1", "rt", "another");
  expect(count).toBe(0);
  f.present("p1");
  f.present("p1");
  expect(count).toBe(1);
  f.present("p2");
  expect(count).toBe(2);
  f.unmount();
  f.present("p3");
  f.surface.onPresentationChange!(() => count++);
  expect(count).toBe(2);
  await f.running.dispose();
});

test("existing binding replays synchronously; equal handlers own independent subscriptions", async () => {
  const f = await fixture(true);
  let count = 0;
  const handler = () => count++;
  const first = f.surface.onPresentationChange!(handler);
  const second = f.surface.onPresentationChange!(handler);
  expect(count).toBe(2);
  first(); first();
  f.present("next");
  expect(count).toBe(3);
  second();
  f.present("last");
  expect(count).toBe(3);
  await f.running.dispose();
});

test("throwing callbacks are isolated on replay and later notifications", async () => {
  const f = await fixture(true);
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(() => f.surface.onPresentationChange!(() => { throw new Error("fixture"); })).not.toThrow();
    let count = 0;
    f.surface.onPresentationChange!(() => count++);
    f.present("next");
    expect(count).toBe(2);
    expect(errors).toHaveBeenCalledTimes(2);
  } finally { errors.mockRestore(); await f.running.dispose(); }
});

test("callback unsubscription and unmount prevent remaining callbacks", async () => {
  const f = await fixture();
  let removed = 0, afterUnmount = 0;
  let stop = () => {};
  f.surface.onPresentationChange!(() => stop());
  stop = f.surface.onPresentationChange!(() => removed++);
  f.surface.onPresentationChange!(() => f.unmount());
  f.surface.onPresentationChange!(() => afterUnmount++);
  f.present("first");
  expect(removed).toBe(0);
  expect(afterUnmount).toBe(0);
  await f.running.dispose();
});

test("reentrant replacement notifies the new binding and retires the old dispatch", async () => {
  const f = await fixture();
  let calls = 0, followers = 0;
  f.surface.onPresentationChange!(() => { if (++calls === 1) f.present("replacement"); });
  f.surface.onPresentationChange!(() => followers++);
  f.present("first");
  expect(calls).toBe(2);
  expect(followers).toBe(1);
  await f.running.dispose();
});

test("dispose during a callback prevents later notifications and late handle subscription", async () => {
  const f = await fixture();
  let count = 0;
  f.surface.onPresentationChange!(() => { void f.running.dispose(); });
  f.surface.onPresentationChange!(() => count++);
  f.present("first");
  f.present("second");
  f.surface.onPresentationChange!(() => count++);
  expect(count).toBe(0);
  await f.running.dispose();
});
