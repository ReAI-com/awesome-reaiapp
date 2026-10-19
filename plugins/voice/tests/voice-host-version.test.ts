/** Host 版本读取状态机：共享在途请求、只缓存成功、限频间隔、本地超时与晚到隔离（方案 2.2）。 */
import { expect, test } from "bun:test";
import type { SystemTaskVersionStatus } from "@reai/app-sdk/v1";
import { HostVersionReader } from "../src/voice-host-version";
import { hostVersionLabel, type VoiceHostVersion } from "../src/voice-diagnostics";
import { setVoiceLocale } from "../src/voice-i18n";

const status = (version: string) => ({
  firmware: { updateAvailable: false, connected: false },
  app: { currentVersion: version, updateAvailable: false, installable: false },
  source: "unavailable",
}) as SystemTaskVersionStatus;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function reader(read: () => Promise<SystemTaskVersionStatus>, options: { timeoutMs?: number; clock?: { now: number } } = {}) {
  const published: VoiceHostVersion[] = [];
  const clock = options.clock ?? { now: 1_000 };
  let calls = 0;
  const instance = new HostVersionReader({
    read: () => { calls += 1; return read(); },
    publish: (value) => published.push(value),
    now: () => clock.now,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { instance, published, clock, calls: () => calls };
}

test("并发两次只发一次请求，成功后缓存不再读", async () => {
  const pending = deferred<SystemTaskVersionStatus>();
  const { instance, calls, clock } = reader(() => pending.promise);
  const first = instance.request();
  const second = instance.request();
  expect(calls()).toBe(1);
  expect(instance.current.state).toBe("loading");
  pending.resolve(status("1.0.0-rc.1"));
  expect(await first).toEqual({ state: "ready", version: "1.0.0-rc.1" });
  expect(await second).toEqual({ state: "ready", version: "1.0.0-rc.1" });
  clock.now += 60_000;
  await instance.request();
  expect(calls()).toBe(1);
});

test("真实拒绝保留码与原文；2.5 秒内不重发，之后可重试", async () => {
  let fail = true;
  const { instance, calls, clock } = reader(async () => {
    if (fail) throw { code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED", message: "只有用户当前正在查看的插件界面可以打开系统任务" };
    return status("1.0.0");
  });
  const rejected = await instance.request();
  expect(rejected.state).toBe("rejected");
  expect(rejected.code).toBe("SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED");
  // 只留错误码：Host 的原因原文不进诊断（§6.0 白名单）。
  expect(Object.keys(rejected).sort()).toEqual(["code", "state"]);
  clock.now += 1_000;
  await instance.request();
  expect(calls()).toBe(1);
  fail = false;
  clock.now += 2_000;
  expect(await instance.request()).toEqual({ state: "ready", version: "1.0.0" });
  expect(calls()).toBe(2);
});

test("本地超时：返回的 Promise 按时结算为 timeout，晚到的成功仍然采用", async () => {
  const pending = deferred<SystemTaskVersionStatus>();
  const { instance } = reader(() => pending.promise, { timeoutMs: 10 });
  // Host 不返回时调用方也要按时拿到结果（挂载处据此安排重试）。
  expect(await instance.request()).toEqual({ state: "timeout" });
  pending.resolve(status("1.0.1"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(instance.current).toEqual({ state: "ready", version: "1.0.1" });
});

test("A 超时后发起 B：A 晚到的失败不改写 B 的等待，B 超时后仍能再发 C", async () => {
  const first = deferred<SystemTaskVersionStatus>();
  const second = deferred<SystemTaskVersionStatus>();
  const calls = [first, second, deferred<SystemTaskVersionStatus>()];
  let index = 0;
  const clock = { now: 1_000 };
  const { instance, calls: count } = reader(() => calls[index++]!.promise, { timeoutMs: 10, clock });
  expect(await instance.request()).toEqual({ state: "timeout" });
  clock.now += 3_000;
  const b = instance.request();
  expect(instance.current.state).toBe("loading");
  first.reject({ code: "SYSTEM_TASK_RATE_LIMITED", message: "too fast" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  expect(instance.current.state).toBe("loading");
  expect(await b).toEqual({ state: "timeout" });
  clock.now += 3_000;
  instance.request();
  expect(count()).toBe(3);
});

test("dispose 结算正在等待的调用方", async () => {
  const pending = deferred<SystemTaskVersionStatus>();
  const { instance } = reader(() => pending.promise, { timeoutMs: 60_000 });
  const waiting = instance.request();
  instance.dispose();
  expect((await waiting).state).toBe("loading");
});

test("ensure 复用在途请求，最多等待给定时长", async () => {
  const pending = deferred<SystemTaskVersionStatus>();
  const { instance, calls } = reader(() => pending.promise);
  instance.request();
  const started = Date.now();
  const waited = await instance.ensure(20);
  expect(Date.now() - started).toBeLessThan(500);
  expect(waited.state).toBe("loading");
  expect(calls()).toBe(1);
  pending.resolve(status("2.0.0"));
  expect(await instance.ensure(1_000)).toEqual({ state: "ready", version: "2.0.0" });
  expect(calls()).toBe(1);
});

test("dispose 之后的晚到结果不再发布", async () => {
  const pending = deferred<SystemTaskVersionStatus>();
  const { instance, published } = reader(() => pending.promise);
  instance.request();
  instance.dispose();
  pending.resolve(status("9.9.9"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(published.map((value) => value.state)).toEqual(["loading"]);
});

test("版本号不截断：超过 64 字符的合法版本完整保留；非法的长版本写「格式不符」，不会截成另一个合法版本", async () => {
  setVoiceLocale("zh");
  const long = `1.2.3-rc.1+${"a".repeat(60)}`;
  const valid = await reader(async () => status(long)).instance.request();
  expect(valid).toEqual({ state: "ready", version: long });
  expect(hostVersionLabel(valid)).toBe(long);
  const invalid = await reader(async () => status(`1.2.3+${"b".repeat(80)}`)).instance.request();
  expect(hostVersionLabel(invalid)).toBe("App 返回的版本号格式不符，已省略");
});

async function waitForVersionState(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  expect(check()).toBe(true);
}

test("visible refresh is bounded, coalesces intents, retains rejection then caches success", async () => {
  let visible = false, calls = 0;
  const instance = new HostVersionReader({
    read: async () => { calls++; if (!visible) throw { code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" }; return status("1.0.0-rc.2.17"); },
    publish: () => {}, minIntervalMs: 5, timeoutMs: 20,
  });
  instance.refreshOnVisible(); instance.refreshOnVisible();
  await waitForVersionState(() => calls === 2 && instance.current.state === "rejected");
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(calls).toBe(2);
  expect(instance.current).toEqual({state:"rejected",code:"SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED"});
  visible = true;
  instance.refreshOnVisible(); instance.refreshOnVisible();
  await waitForVersionState(() => instance.current.state === "ready");
  expect(calls).toBe(3);
  expect(instance.current).toEqual({state:"ready",version:"1.0.0-rc.2.17"});
  instance.refreshOnVisible();
  await waitForVersionState(() => instance.current.state === "ready");
  expect(calls).toBe(3);
  instance.dispose();
});

test("visible intent during last hidden rejection is not lost", async () => {
  const lastHidden = deferred<SystemTaskVersionStatus>();
  let calls = 0;
  const instance = new HostVersionReader({
    read: () => { calls++; return calls === 1 ? Promise.reject({code:"SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED"}) : calls === 2 ? lastHidden.promise : Promise.resolve(status("1.0.0")); },
    publish: () => {}, minIntervalMs: 5, timeoutMs: 100,
  });
  instance.refreshOnVisible();
  await waitForVersionState(() => calls === 2);
  expect(calls).toBe(2);
  instance.refreshOnVisible();
  lastHidden.reject({code:"SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED"});
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toBe(3);
  expect(instance.current.state).toBe("ready");
  instance.dispose();
});

test("unmount cancellation prevents queued retry and disposal discards late success", async () => {
  let calls=0;
  const pending=deferred<SystemTaskVersionStatus>();
  const published: VoiceHostVersion[]=[];
  const instance=new HostVersionReader({read:()=>{calls++;return pending.promise;},publish:value=>published.push(value),minIntervalMs:5,timeoutMs:100});
  const cancel=instance.refreshOnVisible();
  await waitForVersionState(() => calls === 1);
  expect(calls).toBe(1);
  cancel(); instance.dispose();
  pending.resolve(status("1.0.0"));
  await new Promise(resolve=>setTimeout(resolve,30));
  expect(calls).toBe(1);
  expect(published.some(value=>value.state==="ready")).toBe(false);
});


test("unmounting one Surface does not cancel another visible Surface's refresh", async () => {
  const hidden = deferred<SystemTaskVersionStatus>();
  let calls = 0;
  const instance = new HostVersionReader({read: () => ++calls === 1 ? hidden.promise : Promise.resolve(status("1.0.0")), publish: () => {}, minIntervalMs: 5, timeoutMs: 100});
  const scopeA = {}, scopeB = {};
  const cancelA = instance.refreshOnVisible(scopeA);
  await waitForVersionState(() => calls === 1);
  instance.refreshOnVisible(scopeB);
  cancelA();
  hidden.reject({code:"SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED"});
  await waitForVersionState(() => instance.current.state === "ready");
  expect(calls).toBe(2);
  instance.dispose();
});


test("rate-limited timer wakeup does not consume a real refresh attempt", async () => {
  let now = 0, calls = 0;
  const instance = new HostVersionReader({
    read: async () => { calls++; throw { code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" }; },
    publish: () => {}, now: () => now, minIntervalMs: 5, timeoutMs: 20,
  });
  try {
    instance.refreshOnVisible();
    await waitForVersionState(() => calls === 1);
    // Wall timers fire while the admission clock stays before the interval.
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    now = 10;
    await waitForVersionState(() => calls === 2);
    now = 20;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toBe(2); // Two actual reads exhaust the budget; no polling.
  } finally { instance.dispose(); }
});

test("default admission interval is exactly 2500ms on the reader's own clock", async () => {
  let now = 1_000, calls = 0;
  const instance = new HostVersionReader({
    read: async () => { calls++; throw { code: "SYSTEM_TASK_VISIBLE_SURFACE_REQUIRED" }; },
    publish: () => {}, now: () => now, timeoutMs: 20,
  });
  try {
    await instance.request();
    expect(calls).toBe(1);
    now += 2_499;
    await instance.request();
    expect(calls).toBe(1);
    now += 1;
    await instance.request();
    expect(calls).toBe(2);
  } finally { instance.dispose(); }
});
