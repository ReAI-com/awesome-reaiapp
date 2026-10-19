import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { FolderTaskController, FOLDER_FILE_TOOLS, mountFolderTaskView, renderMarkdown, type FolderTaskDeps } from "../src/folder-task";
import { setLocale } from "../src/i18n";

const BACKEND = "pi" as const;

let ownsDom = false;
beforeAll(() => { if (typeof document === "undefined") { GlobalRegistrator.register(); ownsDom = true; } setLocale("zh"); });
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fail = (code: string) => Object.assign(new Error(code), { code });
const root = (name: string, grantRef = `g-${name}`) => ({ name, resource: { resource: { provider: "local", id: `r-${name}` } as never, grantRef } });

function fakeDeps(overrides: {
  listRoots?: () => Promise<unknown>;
  backends?: () => Promise<unknown>;
  pickRoot?: () => Promise<unknown>;
  wait?: () => Promise<unknown>;
  startTurn?: () => Promise<unknown>;
  storage?: Map<string, string>;
  storageSet?: () => Promise<void>;
  storageGet?: () => Promise<unknown>;
} = {}) {
  const calls: Array<{ method: string; input: any }> = [];
  let releaseWait: ((value: unknown) => void) | undefined;
  const deps: FolderTaskDeps = {
    backend: BACKEND,
    files: {
      async listRoots(input) { calls.push({ method: "listRoots", input }); return (overrides.listRoots?.() ?? Promise.resolve({ items: [root("docs")] })) as never; },
      async pickRoot(input) { calls.push({ method: "pickRoot", input }); return (overrides.pickRoot?.() ?? Promise.resolve({ root: root("picked") })) as never; },
    },
    agent: {
      async backends(input) { calls.push({ method: "backends", input }); return (overrides.backends?.() ?? Promise.resolve({ backends: [{ backend: BACKEND, available: true, detail: "" }] })) as never; },
      async createSession(config) { calls.push({ method: "createSession", input: config }); return { sessionId: `agent2-${calls.length}` }; },
      async startTurn(input) { calls.push({ method: "startTurn", input }); return (overrides.startTurn?.() ?? Promise.resolve({ sessionId: input.sessionId, turnId: "t1" })) as never; },
      async waitForTurn(input) {
        calls.push({ method: "waitForTurn", input });
        if (overrides.wait) return overrides.wait() as never;
        return new Promise((resolve) => { releaseWait = resolve; }) as never;
      },
      async cancel(input) { calls.push({ method: "cancel", input }); return { cancelled: true }; },
      async deleteSession(input) { calls.push({ method: "deleteSession", input }); return { deleted: true }; },
    },
    systemTasks: { async open(input) { calls.push({ method: "open", input }); return {}; } },
    // 模拟 Host 私有 KV：值经 JSON 往返（真实 Host 存的是 JSON），不共享对象引用。
    storage: overrides.storage ? {
      async get(key: string) { if (overrides.storageGet) return overrides.storageGet(); const raw = overrides.storage!.get(key); return raw === undefined ? undefined : JSON.parse(raw); },
      async set(key: string, value: unknown) { if (overrides.storageSet) await overrides.storageSet(); overrides.storage!.set(key, JSON.stringify(value)); },
      async delete(key: string) { overrides.storage!.delete(key); },
    } : undefined,
  };
  return { deps, calls, finish: (value: unknown) => releaseWait?.(value) };
}

describe("能力检测与回退", () => {
  test("Host 未开放文件能力（旧 Host / 未获批）→ 不可用，入口隐藏", async () => {
    for (const code of ["HOST_CAPABILITY_NOT_AVAILABLE", "BRIDGE_UNKNOWN_METHOD", "RESOURCE_NOT_AUTHORIZED"]) {
      const { deps } = fakeDeps({ listRoots: () => Promise.reject(fail(code)) });
      const controller = new FolderTaskController(deps);
      expect(await controller.probe()).toBe("unavailable");
    }
  });
  test("Agent 能力未获批 → 不可用；不能被另一项的『未同意』遮住", async () => {
    const { deps } = fakeDeps({
      listRoots: () => Promise.reject(fail("PLUGIN_PERMISSION_REQUIRED")),
      backends: () => Promise.reject(fail("AGENT_SESSION_NOT_GRANTED")),
    });
    expect(await new FolderTaskController(deps).probe()).toBe("unavailable");
  });
  test("SDK 缺少方法（更旧的 Host）→ 不可用且不发请求", async () => {
    const controller = new FolderTaskController({ backend: BACKEND });
    expect(await controller.probe()).toBe("unavailable");
  });
  test("已获批但用户未同意 → 入口保留并引导去权限页", async () => {
    for (const code of ["PLUGIN_PERMISSION_REQUIRED", "AGENT_SESSION_PERMISSION_DENIED"]) {
      const { deps, calls } = fakeDeps({ backends: () => Promise.reject(fail(code)) });
      const controller = new FolderTaskController(deps);
      expect(await controller.probe()).toBe("notAuthorized");
      await controller.openPermissions();
      expect(calls.at(-1)).toEqual({ method: "open", input: { target: "app-permissions" } });
    }
  });
  test("运行组件未授权给本插件 → 不能发送，可跳转到运行组件页", async () => {
    const { deps, calls } = fakeDeps({ backends: () => Promise.resolve({ backends: [{ backend: BACKEND, available: false, downloadRequired: true, detail: "" }] }) });
    const controller = new FolderTaskController(deps);
    expect(await controller.probe()).toBe("ready");
    expect(controller.snapshot.runtime).toBe("downloadRequired");
    controller.selectRoot("g-docs");
    expect(await controller.send("hi")).toBe(false);
    await controller.openRuntimeSetup();
    expect(calls.at(-1)).toEqual({ method: "open", input: { target: "app-managed-resources" } });
  });
});

describe("文件夹会话", () => {
  test("选择文件夹后以 resource 工作区、本插件引擎与当前档位建会话", async () => {
    const { deps, calls, finish } = fakeDeps();
    const controller = new FolderTaskController(deps);
    await controller.probe();
    await controller.pick();
    expect(controller.snapshot.root?.name).toBe("picked");
    controller.setMode("plan");
    expect(await controller.send("列出这个文件夹")).toBe(true);
    await tick(); await tick();
    const create = calls.find((call) => call.method === "createSession")!.input;
    expect(create).toMatchObject({
      schemaVersion: 2, runtime: BACKEND, memory: "session", mode: "plan",
      workspace: { kind: "resource", root: root("picked").resource },
    });
    expect(create.tools.map((tool: { ref: string }) => tool.ref)).toEqual([...FOLDER_FILE_TOOLS]);
    expect(create.tools.map((tool: { ref: string }) => tool.ref)).not.toContain("command");
    expect(calls.find((call) => call.method === "startTurn")!.input).toMatchObject({ text: "列出这个文件夹", taskPresentation: "caller" });
    expect(controller.snapshot.running).toBe(true);
    finish({ status: "completed", content: [{ type: "text", text: "README.md" }] });
    await controller.whenIdle();
    expect(controller.snapshot.running).toBe(false);
    expect(controller.snapshot.messages.map((message) => [message.role, message.text])).toEqual([["user", "列出这个文件夹"], ["assistant", "README.md"]]);
  });
  test("运行中不能换文件夹 / 换档；停止会取消真实回合", async () => {
    const { deps, calls, finish } = fakeDeps();
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("写 notes.txt");
    await tick(); await tick();
    controller.setMode("yolo");
    controller.newConversation();
    expect(controller.snapshot.mode).toBe("chat");
    expect(controller.snapshot.messages).toHaveLength(1);
    await controller.stop();
    expect(calls.find((call) => call.method === "cancel")?.input).toEqual({ sessionId: expect.any(String), turnId: "t1" });
    finish({ status: "cancelled" });
    await controller.whenIdle();
    expect(controller.snapshot.messages.at(-1)?.role).toBe("notice");
  });
  test("受理回执到达前点停止：回执一到立即取消真实回合", async () => {
    let ack!: (value: unknown) => void;
    const { deps, calls, finish } = fakeDeps({ startTurn: () => new Promise((resolve) => { ack = resolve; }) });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("long");
    await tick(); await tick();
    await controller.stop();
    expect(calls.filter((call) => call.method === "cancel")).toHaveLength(0);
    ack({ sessionId: "agent2-x", turnId: "late-turn" });
    await tick(); await tick();
    expect(calls.find((call) => call.method === "cancel")?.input).toMatchObject({ turnId: "late-turn" });
    finish({ status: "cancelled" });
    await controller.whenIdle();
    expect(controller.snapshot.running).toBe(false);
  });
  test("换档会丢弃旧会话并删除，下一条消息新建会话", async () => {
    const { deps, calls } = fakeDeps({ wait: () => Promise.resolve({ status: "completed", content: [{ type: "text", text: "ok" }] }) });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("one"); await controller.whenIdle();
    const first = calls.filter((call) => call.method === "createSession").length;
    controller.setMode("yolo");
    await tick(); await tick();
    expect(calls.some((call) => call.method === "deleteSession")).toBe(true);
    await controller.send("two"); await controller.whenIdle();
    expect(calls.filter((call) => call.method === "createSession").length).toBe(first + 1);
    expect(calls.filter((call) => call.method === "createSession").at(-1)!.input.mode).toBe("yolo");
  });
  test("界面卸载不假装取消：重开后恢复对话与在跑回合，仍可停止", async () => {
    const storage = new Map<string, string>();
    const first = fakeDeps({ storage });
    const before = new FolderTaskController(first.deps);
    await before.probe();
    before.selectRoot("g-docs");
    await before.send("long task");
    await tick(); await tick();
    before.dispose();
    await tick();
    expect(first.calls.some((call) => call.method === "cancel" || call.method === "deleteSession")).toBe(false);
    first.finish({ status: "completed", content: [{ type: "text", text: "late" }] });
    await before.whenIdle();
    expect(before.snapshot.messages.some((message) => message.text === "late")).toBe(false);

    const second = fakeDeps({ storage });
    const after = new FolderTaskController(second.deps);
    await after.probe();
    for (let i = 0; i < 4; i++) await tick();
    expect(after.snapshot.root?.name).toBe("docs");
    expect(after.snapshot.running).toBe(true);
    expect(after.snapshot.messages[0]).toEqual({ role: "user", text: "long task" });
    await after.stop();
    expect(second.calls.find((call) => call.method === "cancel")?.input).toMatchObject({ turnId: "t1" });
    second.finish({ status: "cancelled" });
    await after.whenIdle();
    expect(after.snapshot.running).toBe(false);
    // 续聊沿用原会话，不再新建。
    expect(second.calls.some((call) => call.method === "createSession")).toBe(false);
  });
  test("回执前关闭界面：重开后不自动重放，用户「重新查询」才按原幂等键提交，之后可停止", async () => {
    const storage = new Map<string, string>();
    let ack!: (value: unknown) => void;
    const first = fakeDeps({ storage, startTurn: () => new Promise((resolve) => { ack = resolve; }) });
    const before = new FolderTaskController(first.deps);
    await before.probe(); await before.whenIdle();
    before.selectRoot("g-docs");
    await before.send("写 notes.txt");
    for (let i = 0; i < 4; i++) await tick();
    const sent = first.calls.find((call) => call.method === "startTurn")!.input;
    before.dispose();
    ack({ sessionId: sent.sessionId, turnId: "t-original" });
    await tick();

    const second = fakeDeps({ storage, startTurn: () => Promise.resolve({ sessionId: sent.sessionId, turnId: "t-original" }) });
    const after = new FolderTaskController(second.deps);
    await after.probe(); await after.whenIdle();
    expect(second.calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(after.snapshot.stalled).toBe(true);
    expect(after.snapshot.messages.at(-1)?.role).toBe("notice");
    const requery = after.requery();
    for (let i = 0; i < 3; i++) await tick();
    expect(second.calls.find((call) => call.method === "startTurn")!.input).toMatchObject({ sessionId: sent.sessionId, idempotencyKey: sent.idempotencyKey, text: "写 notes.txt" });
    expect(second.calls.some((call) => call.method === "createSession")).toBe(false);
    await after.stop();
    expect(second.calls.find((call) => call.method === "cancel")?.input).toEqual({ sessionId: sent.sessionId, turnId: "t-original" });
    second.finish({ status: "cancelled" });
    await requery;
    expect(after.snapshot.running).toBe(false);
  });
  test("重开后状态未知的请求点「停止」= 删除 Host 会话放弃，不为取消而重新提交", async () => {
    const storage = new Map<string, string>();
    storage.set("conversation", JSON.stringify({ v: 2, grantRef: "g-docs", mode: "yolo", sessionId: "s-old", pending: { idempotencyKey: "k", text: "rm", dispatched: true }, turn: null, stopRequested: false, messages: [] }));
    const { deps, calls } = fakeDeps({ storage });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    expect(controller.snapshot.stalled).toBe(true);
    await controller.stop();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    // 可能已在 Host 上跑：必须确认删除会话（Host 删除即取消其回合），不能只清本地记录。
    expect(calls.find((call) => call.method === "deleteSession")?.input).toEqual({ sessionId: "s-old" });
    expect(controller.snapshot.stalled).toBe(false);
    for (let i = 0; i < 3; i++) await tick();
    expect(storage.has("conversation")).toBe(false);
  });
  test("查询进度失败不等于任务结束：保留回合，可重新查询或停止", async () => {
    let attempt = 0;
    let release!: (value: unknown) => void;
    const { deps, calls } = fakeDeps({
      wait: () => ++attempt === 1 ? Promise.reject(fail("AGENT_WAIT_TIMEOUT")) : new Promise((resolve) => { release = resolve; }),
    });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("long"); await controller.whenIdle();
    expect(controller.snapshot.stalled).toBe(true);
    expect(controller.snapshot.running).toBe(false);
    expect(await controller.send("another")).toBe(false);
    controller.setMode("yolo");
    expect(controller.snapshot.mode).toBe("chat");
    const requery = controller.requery();
    await tick();
    expect(controller.snapshot.running).toBe(true);
    expect(controller.snapshot.stalled).toBe(false);
    await controller.stop();
    expect(calls.find((call) => call.method === "cancel")?.input).toMatchObject({ turnId: "t1" });
    release({ status: "cancelled" });
    await requery;
    expect(controller.snapshot.running).toBe(false);
    expect(controller.snapshot.messages.at(-1)?.role).toBe("notice");
  });
  test("建会话回执前停止：不再发起回合", async () => {
    let created!: (value: unknown) => void;
    const { deps, calls } = fakeDeps();
    deps.agent!.createSession = (config) => { calls.push({ method: "createSession", input: config }); return new Promise((resolve) => { created = resolve as never; }); };
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("hi");
    await tick();
    await controller.stop();
    created({ sessionId: "agent2-s" });
    await controller.whenIdle();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(controller.snapshot.running).toBe(false);
  });
  test("关键记录写不进 Host KV（如超限被拒）→ 不发送，提示稍后再试", async () => {
    const storage = new Map<string, string>();
    const { deps, calls } = fakeDeps({ storage, storageSet: () => Promise.reject(fail("STORAGE_QUOTA")) });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    await controller.send("big"); await controller.whenIdle();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(controller.snapshot.running).toBe(false);
    expect(controller.snapshot.messages.at(-1)?.role).toBe("error");
  });
  test("超长历史按字节裁剪后仍能落盘", async () => {
    const storage = new Map<string, string>();
    const { deps, calls } = fakeDeps({ storage, wait: () => Promise.resolve({ status: "completed", content: [{ type: "text", text: "x".repeat(7_900) }] }) });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    for (let i = 0; i < 30; i++) { await controller.send("汉".repeat(7_000)); await controller.whenIdle(); }
    const raw = [...storage.values()][0]!;
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(192 * 1024 + 64);
    expect(calls.filter((call) => call.method === "startTurn")).toHaveLength(30);
  });
  test("受理回执失败（任务可能已在跑）→ 保留原幂等键，重新查询按原 key 取回", async () => {
    let attempt = 0;
    const { deps, calls, finish } = fakeDeps({
      startTurn: () => ++attempt === 1 ? Promise.reject(fail("AGENT_STORAGE_FAILED")) : Promise.resolve({ sessionId: "s", turnId: "t-back" }),
    });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    await controller.send("write"); await controller.whenIdle();
    expect(controller.snapshot.stalled).toBe(true);
    const requery = controller.requery();
    await tick(); await tick();
    const starts = calls.filter((call) => call.method === "startTurn").map((call) => call.input);
    expect(starts).toHaveLength(2);
    expect(starts[1].idempotencyKey).toBe(starts[0].idempotencyKey);
    finish({ status: "completed", content: [{ type: "text", text: "done" }] });
    await requery;
    expect(controller.snapshot.messages.at(-1)).toEqual({ role: "assistant", text: "done" });
  });
  test("恢复读取期间锁住操作：迟到的记录不会覆盖用户的新选择", async () => {
    const storage = new Map<string, string>();
    storage.set("conversation", JSON.stringify({ v: 2, grantRef: "g-docs", mode: "yolo", sessionId: "old", pending: null, turn: { sessionId: "old", turnId: "t-old" }, stopRequested: false, messages: [] }));
    let releaseGet!: () => void;
    const { deps, calls } = fakeDeps({ storage, storageGet: () => new Promise((resolve) => { releaseGet = () => resolve(JSON.parse(storage.get("conversation")!)); }) });
    deps.files!.listRoots = async () => ({ items: [root("docs"), root("other")] });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-other");
    await controller.pick();
    expect(controller.snapshot.root).toBeNull();
    expect(calls.some((call) => call.method === "pickRoot")).toBe(false);
    releaseGet();
    for (let i = 0; i < 4; i++) await tick();
    expect(controller.snapshot.root?.name).toBe("docs");
    expect(controller.snapshot.mode).toBe("yolo");
  });
  test("落盘期间点停止：不发起回合；停止意图跨关闭保留", async () => {
    const storage = new Map<string, string>();
    let releaseSet: (() => void) | undefined;
    let block = false;
    const { deps, calls } = fakeDeps({ storage, storageSet: () => block ? new Promise((resolve) => { releaseSet = resolve; }) : Promise.resolve() });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    block = true;
    await controller.send("x");
    for (let i = 0; i < 3; i++) await tick();
    block = false;
    const stopping = controller.stop();
    releaseSet?.();
    await stopping; await controller.whenIdle();
    for (let i = 0; i < 3; i++) await tick();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(controller.snapshot.running).toBe(false);
  });
  test("回执前点停止后关闭：重开后只清理，不重放请求", async () => {
    const storage = new Map<string, string>();
    const first = fakeDeps({ storage, startTurn: () => new Promise(() => {}) });
    const before = new FolderTaskController(first.deps);
    await before.probe(); await before.whenIdle();
    before.selectRoot("g-docs");
    await before.send("x");
    for (let i = 0; i < 4; i++) await tick();
    await before.stop();
    for (let i = 0; i < 2; i++) await tick();
    before.dispose();
    const second = fakeDeps({ storage });
    const after = new FolderTaskController(second.deps);
    await after.probe(); await after.whenIdle();
    expect(second.calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(second.calls.some((call) => call.method === "deleteSession")).toBe(true);
    expect(after.snapshot.running).toBe(false);
    expect(storage.has("conversation")).toBe(false);
  });
  test("并发「重试停止」只跑一次清理；清理完成后新发送不受迟到结果影响", async () => {
    const storage = new Map<string, string>();
    let writes = 0;
    let writesOk = false;
    let release: (() => void) | undefined;
    const { deps, calls, finish } = fakeDeps({ storage, storageSet: () => {
      writes++;
      if (writes === 1) return new Promise((resolve) => { release = resolve; });
      return writesOk ? Promise.resolve() : Promise.reject(fail("STORAGE_UNAVAILABLE"));
    } });
    let deletes = 0;
    let releaseDelete: (() => void) | undefined;
    deps.agent!.deleteSession = async (input) => {
      calls.push({ method: "deleteSession", input });
      if (++deletes === 1) throw fail("AGENT_STORAGE_FAILED");
      await new Promise<void>((resolve) => { releaseDelete = resolve; });
      return { deleted: true };
    };
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    await controller.send("x");
    for (let i = 0; i < 3; i++) await tick();
    const stopping = controller.stop();
    release?.();
    await stopping; await controller.whenIdle();
    for (let i = 0; i < 4; i++) await tick();
    expect(controller.snapshot.cleanupFailed).toBe(true);
    const retryA = controller.stop();
    const retryB = controller.stop();
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.filter((call) => call.method === "deleteSession")).toHaveLength(2);
    releaseDelete?.();
    await Promise.all([retryA, retryB]);
    expect(controller.snapshot.cleanupFailed).toBe(false);
    writesOk = true;
    expect(await controller.send("new")).toBe(true);
    for (let i = 0; i < 4; i++) await tick();
    expect(controller.snapshot.running).toBe(true);
    finish({ status: "completed", content: [{ type: "text", text: "ok" }] });
    await controller.whenIdle();
    expect(controller.snapshot.messages.at(-1)).toEqual({ role: "assistant", text: "ok" });
  });
  test("恢复读取失败：不删旧记录、锁住会话操作，重试读取成功后恢复", async () => {
    const storage = new Map<string, string>();
    const record = { v: 2, grantRef: "g-docs", mode: "plan", sessionId: "old", pending: null, turn: null, stopRequested: false, messages: [{ role: "user", text: "旧消息" }] };
    storage.set("conversation", JSON.stringify(record));
    let failGet = true;
    const { deps, calls } = fakeDeps({ storage, storageGet: () => failGet ? Promise.reject(fail("STORAGE_UNAVAILABLE")) : Promise.resolve(JSON.parse(storage.get("conversation")!)) });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    expect(controller.snapshot.restoreFailed).toBe(true);
    expect(storage.has("conversation")).toBe(true);
    controller.selectRoot("g-docs");
    expect(await controller.send("新消息")).toBe(false);
    expect(calls.some((call) => call.method === "createSession")).toBe(false);
    failGet = false;
    await controller.retryRestore();
    expect(controller.snapshot.restoreFailed).toBe(false);
    expect(controller.snapshot.mode).toBe("plan");
    expect(controller.snapshot.messages[0]).toEqual({ role: "user", text: "旧消息" });
  });
  test("已落盘未发出的请求被停止、但清理写入失败 → 删除 Host 会话，重开也无法执行", async () => {
    const storage = new Map<string, string>();
    let writes = 0;
    let release: (() => void) | undefined;
    const { deps, calls } = fakeDeps({ storage, storageSet: () => {
      writes++;
      if (writes === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.reject(fail("STORAGE_UNAVAILABLE"));
    } });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    await controller.send("x");
    for (let i = 0; i < 3; i++) await tick();
    const stopping = controller.stop();
    release?.();
    await stopping; await controller.whenIdle();
    for (let i = 0; i < 4; i++) await tick();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    expect(calls.some((call) => call.method === "deleteSession")).toBe(true);
    expect(controller.snapshot.running).toBe(false);
  });
  test("未发出的请求停止时 KV 清理与删除会话都失败 → 不显示已停止，锁住并可重试停止", async () => {
    const storage = new Map<string, string>();
    let writes = 0;
    let release: (() => void) | undefined;
    const { deps, calls } = fakeDeps({ storage, storageSet: () => {
      writes++;
      if (writes === 1) return new Promise((resolve) => { release = resolve; });
      return Promise.reject(fail("STORAGE_UNAVAILABLE"));
    } });
    let deleteFails = true;
    deps.agent!.deleteSession = async (input) => { calls.push({ method: "deleteSession", input }); if (deleteFails) throw fail("AGENT_STORAGE_FAILED"); return { deleted: true }; };
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    await controller.send("x");
    for (let i = 0; i < 3; i++) await tick();
    const stopping = controller.stop();
    release?.();
    await stopping; await controller.whenIdle();
    for (let i = 0; i < 4; i++) await tick();
    expect(controller.snapshot.cleanupFailed).toBe(true);
    expect(controller.snapshot.messages.some((message) => message.role === "notice")).toBe(false);
    expect(await controller.send("y")).toBe(false);
    await controller.requery();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    deleteFails = false;
    await controller.stop();
    expect(controller.snapshot.cleanupFailed).toBe(false);
    expect(controller.snapshot.messages.at(-1)?.role).toBe("notice");
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
  });
  test("停止时尚未发出的请求：重开后只清理，绝不补发", async () => {
    const storage = new Map<string, string>();
    storage.set("conversation", JSON.stringify({ v: 2, grantRef: "g-docs", mode: "yolo", sessionId: "s-old", pending: { idempotencyKey: "k", text: "rm", dispatched: false }, turn: null, stopRequested: true, messages: [] }));
    const { deps, calls } = fakeDeps({ storage });
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    expect(calls.some((call) => call.method === "startTurn")).toBe(false);
    // 读回的 pending 不能证明没发出：同样确认删除 Host 会话。
    expect(calls.find((call) => call.method === "deleteSession")?.input).toEqual({ sessionId: "s-old" });
    expect(controller.snapshot.running).toBe(false);
    for (let i = 0; i < 3; i++) await tick();
    expect(storage.has("conversation")).toBe(false);
  });
  test("持久化的 dispatched:false 不可信：重开后停止仍删除 Host 会话；删除失败则保持未确认", async () => {
    const storage = new Map<string, string>();
    storage.set("conversation", JSON.stringify({ v: 2, grantRef: "g-docs", mode: "yolo", sessionId: "s-x", pending: { idempotencyKey: "k", text: "rm", dispatched: false }, turn: null, stopRequested: false, messages: [] }));
    const { deps, calls } = fakeDeps({ storage });
    deps.agent!.deleteSession = async (input) => { calls.push({ method: "deleteSession", input }); throw fail("AGENT_STORAGE_FAILED"); };
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    expect(controller.snapshot.stalled).toBe(true);
    await controller.stop();
    expect(calls.some((call) => call.method === "deleteSession")).toBe(true);
    expect(controller.snapshot.cleanupFailed).toBe(true);
    expect(controller.snapshot.messages.some((message) => message.text.includes("已停止") || message.role === "notice" && message.text === "已停止。")).toBe(false);
    for (let i = 0; i < 3; i++) await tick();
    const kept = JSON.parse(storage.get("conversation")!);
    expect(kept).toMatchObject({ sessionId: "s-x", pending: { idempotencyKey: "k", text: "rm", dispatched: true }, stopRequested: true });
  });
  test("超过 64 KB 的指令不发出，输入保留可修改", async () => {
    const { deps, calls } = fakeDeps();
    const controller = new FolderTaskController(deps);
    await controller.probe(); await controller.whenIdle();
    controller.selectRoot("g-docs");
    expect(await controller.send("a".repeat(64 * 1024 + 1))).toBe(false);
    expect(calls.some((call) => call.method === "createSession")).toBe(false);
    expect(controller.snapshot.running).toBe(false);
    expect(controller.snapshot.messages.at(-1)?.role).toBe("error");
  });
  test("迟到的旧探测结果不会覆盖最新状态，也不会把页面卡在运行中", async () => {
    let failOld!: (error: unknown) => void;
    let round = 0;
    const { deps } = fakeDeps({
      listRoots: () => ++round === 1 ? new Promise((_, reject) => { failOld = reject; }) : Promise.resolve({ items: [root("docs")] }),
      wait: () => Promise.resolve({ status: "completed", content: [{ type: "text", text: "ok" }] }),
    });
    const controller = new FolderTaskController(deps);
    const old = controller.probe();
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("hi");
    failOld(fail("HOST_CAPABILITY_NOT_AVAILABLE"));
    await old;
    await controller.whenIdle();
    expect(controller.snapshot.availability).toBe("ready");
    expect(controller.snapshot.running).toBe(false);
    expect(await controller.send("again")).toBe(true);
  });
  test("文件夹授权被撤回 → 清掉该文件夹并提示重选", async () => {
    const { deps } = fakeDeps({ startTurn: () => Promise.reject(fail("AGENT_WORKSPACE_NOT_AUTHORIZED")) });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("read"); await controller.whenIdle();
    expect(controller.snapshot.root).toBeNull();
    expect(controller.snapshot.roots).toEqual([]);
    expect(controller.snapshot.running).toBe(false);
  });
  test("模型调用未同意 → 转为需要允许", async () => {
    const { deps } = fakeDeps({ startTurn: () => Promise.reject(fail("AI_PERMISSION_REQUIRED")) });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    controller.selectRoot("g-docs");
    await controller.send("read"); await controller.whenIdle();
    expect(controller.snapshot.availability).toBe("notAuthorized");
    expect(controller.snapshot.running).toBe(false);
  });
  test("系统目录被拒 → 提示换一个，已有文件夹不受影响", async () => {
    const { deps } = fakeDeps({ pickRoot: () => Promise.reject(fail("RESOURCE_NOT_AUTHORIZED")) });
    const controller = new FolderTaskController(deps);
    await controller.probe();
    await controller.pick();
    expect(controller.snapshot.availability).toBe("ready");
    expect(controller.snapshot.roots).toHaveLength(1);
    expect(controller.snapshot.messages.at(-1)?.role).toBe("error");
  });
});

describe("AI 回复 Markdown", () => {
  test("渲染常见结构，关闭原始 HTML、图片与危险链接", () => {
    const html = renderMarkdown("**天气：**晴\n\n- 一\n- 二\n\n```\ncode  x\n```\n<script>alert(1)</script>\n![x](https://e.com/a.png) [ok](https://a.com) [bad](javascript:alert(1))");
    expect(html).toContain("<strong>");
    expect(html).toContain("<li>");
    expect(html).toContain("<pre><code>code  x");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("(https://a.com)");
  });
});

describe("视图", () => {
  test("输入框常驻：状态变化不冲掉正在输入的文字；三档为单选组", async () => {
    const { deps } = fakeDeps();
    const controller = new FolderTaskController(deps);
    const host = document.createElement("div");
    document.body.append(host);
    const view = mountFolderTaskView(host, controller, "Agent");
    await controller.probe();
    controller.selectRoot("g-docs");
    const input = host.querySelector<HTMLTextAreaElement>("[data-ft-input]")!;
    input.value = "草稿";
    controller.setMode("plan");
    expect(host.querySelector<HTMLTextAreaElement>("[data-ft-input]")).toBe(input);
    expect(input.value).toBe("草稿");
    const modes = host.querySelectorAll<HTMLButtonElement>("[data-ft-mode]");
    expect(Array.from(modes).map((button) => button.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(host.querySelector(".plugin-main-frame")).not.toBeNull();
    view.destroy();
    controller.dispose();
    expect(host.childElementCount).toBe(0);
  });
  test("发送受理后清空刚发出的文字；回合期间写的新草稿在回合结束后保留", async () => {
    const { deps, finish } = fakeDeps();
    const controller = new FolderTaskController(deps);
    const host = document.createElement("div");
    const view = mountFolderTaskView(host, controller, "Agent");
    await controller.probe();
    controller.selectRoot("g-docs");
    const input = host.querySelector<HTMLTextAreaElement>("[data-ft-input]")!;
    input.value = "第一条";
    host.querySelector<HTMLFormElement>("[data-ft-composer]")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick(); await tick();
    expect(input.value).toBe("");
    input.value = "下一条草稿";
    finish({ status: "completed", content: [{ type: "text", text: "**好**" }] });
    await controller.whenIdle(); await tick();
    expect(input.value).toBe("下一条草稿");
    expect(host.querySelector(".ft-msg.assistant .ft-markdown strong")?.textContent).toBe("好");
    expect(host.querySelector(".ft-msg.user .ft-msg-text")?.innerHTML).toBe("第一条");
    view.destroy();
  });
  test("清理结束后视图立即解锁（按钮不再置灰）", async () => {
    const storage = new Map<string, string>();
    storage.set("conversation", JSON.stringify({ v: 2, grantRef: "g-docs", mode: "chat", sessionId: "s-old", pending: { idempotencyKey: "k", text: "x", dispatched: true }, turn: null, stopRequested: false, messages: [] }));
    const { deps } = fakeDeps({ storage });
    const controller = new FolderTaskController(deps);
    const host = document.createElement("div");
    const view = mountFolderTaskView(host, controller, "Agent");
    await controller.probe(); await controller.whenIdle();
    await controller.stop();
    await tick();
    expect(controller.locked).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-ft-pick]")!.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>("[data-ft-send]")!.disabled).toBe(false);
    view.destroy();
  });
  test("不可用时只显示说明，不出现文件夹与输入区", async () => {
    const controller = new FolderTaskController({ backend: BACKEND });
    const host = document.createElement("div");
    const view = mountFolderTaskView(host, controller, "Agent");
    await controller.probe();
    expect(host.querySelector<HTMLElement>("[data-ft-workspace]")!.hidden).toBe(true);
    expect(host.querySelector<HTMLElement>("[data-ft-status]")!.hidden).toBe(false);
    view.destroy();
  });
});
