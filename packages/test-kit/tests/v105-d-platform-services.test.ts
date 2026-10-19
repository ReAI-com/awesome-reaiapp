import { expect, test } from "bun:test";
import { defineApp, type AppContext } from "@reai/app-sdk/v1";
import { MockHost, type MockPlatformServicesFixture } from "../src/v1/index";

const CAPS = ["audio.capture@1", "tasks.present@1", "notifications.publish@1"];
const scenes = [
  { key: "task.lifecycle", label: "任务", description: "任务完成", trigger: "任务终态", format: "text", defaultLevel: "in_app", maxLevel: "system" },
  { key: "digest", label: "摘要", description: "摘要就绪", trigger: "摘要生成", format: "text", defaultLevel: "in_app", maxLevel: "in_app" },
] as const;

async function setup(fixture?: MockPlatformServicesFixture, declare = CAPS, permissions = CAPS) {
  let ctx!: AppContext;
  const manifest = {
    appId: "org.example.approved",
    contributes: { surfaces: [{ id: "main" }], notificationScenes: scenes.map(s => ({ ...s })) },
    requires: { hostCapabilities: [...declare] },
    permissions: permissions.map(id => ({ id })),
  };
  const host = new MockHost({ manifest, ...(fixture ? { platformServices: fixture } : {}),
    loadApp: async () => ({ default: defineApp({ activate(c) { ctx = c; c.surfaces.register("main", s => s.ready()); } }) }) });
  await host.installAndEnable();
  await host.openSurface("main");
  return { host, ctx };
}
const approved = (extra: Partial<MockPlatformServicesFixture> = {}): MockPlatformServicesFixture => ({
  approvals: [...CAPS], taskEntities: ["agent2-session-1"], notificationDecision: "granted", ...extra,
});
const rejects = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ code });

test("old Host without the services fails closed before any request", async () => {
  const { host, ctx } = await setup();
  await rejects(ctx.audioCapture.acquire({ requestId: "a", purpose: "listen" }), "HOST_CAPABILITY_NOT_AVAILABLE");
  await rejects(ctx.tasks.present({ requestId: "t", entityId: "agent2-session-1", title: "x" }), "HOST_CAPABILITY_NOT_AVAILABLE");
  await rejects(ctx.notifications.publish({ requestId: "n", sceneKey: "digest", requestedLevel: "in_app", title: "t", body: "b" }), "HOST_CAPABILITY_NOT_AVAILABLE");
  await host.disable();
});

test("unapproved plugins get the domain not-granted codes through the SDK", async () => {
  const { host, ctx } = await setup({ approvals: [] });
  await rejects(ctx.audioCapture.acquire({ requestId: "a", purpose: "listen" }), "AUDIO_NOT_GRANTED");
  await rejects(ctx.tasks.present({ requestId: "t", entityId: "agent2-session-1", title: "x" }), "TASK_NOT_GRANTED");
  await rejects(ctx.notifications.publish({ requestId: "n", sceneKey: "digest", requestedLevel: "in_app", title: "t", body: "b" }), "HOST_CAPABILITY_NOT_AVAILABLE");
  await host.disable();
});

test("approval without user consent is rejected with the same-name permission codes", async () => {
  const { host, ctx } = await setup(approved({ decisions: { "audio.capture@1": "pending", "tasks.present@1": "denied", "notifications.publish@1": "pending" } }));
  await rejects(ctx.audioCapture.acquire({ requestId: "a", purpose: "p" }), "AUDIO_PERMISSION_REQUIRED");
  await rejects(ctx.tasks.present({ requestId: "t", entityId: "agent2-session-1", title: "x" }), "TASK_PERMISSION_DENIED");
  await rejects(ctx.notifications.publish({ requestId: "n", sceneKey: "digest", requestedLevel: "in_app", title: "t", body: "b" }), "NOTIFICATION_PERMISSION_REQUIRED");
  await host.disable();
});

test("a task registered before notification consent never notifies; later tasks do", async () => {
  const fixture = approved({ notificationDecision: "pending", notificationLevels: { "task.lifecycle": "system" }, systemNotifications: "granted" });
  const { host, ctx } = await setup(fixture);
  const early = await ctx.tasks.present({ requestId: "t1", entityId: "agent2-session-1", title: "早" });
  fixture.notificationDecision = "granted";
  expect(await ctx.notifications.publish({ requestId: "n1", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b", taskId: early.taskId }))
    .toMatchObject({ stored: false, effectiveLevel: "off" });
  const later = await ctx.tasks.present({ requestId: "t2", entityId: "agent2-session-1", title: "晚" });
  expect(await ctx.notifications.publish({ requestId: "n2", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b", taskId: later.taskId }))
    .toMatchObject({ stored: true, effectiveLevel: "system", systemDelivery: "queued" });
  await host.disable();
});

test("approved plugin: audio consumer, owned task and result continue back to its own session", async () => {
  const { host, ctx } = await setup(approved());
  const consumer = await ctx.audioCapture.acquire({ requestId: "a", purpose: "listen" });
  expect(consumer.owner.appId).toBe("org.example.approved");
  expect((await ctx.audioCapture.status({ requestId: "s", consumerId: consumer.consumerId })).consumerId).toBe(consumer.consumerId);
  await ctx.audioCapture.release({ requestId: "r", consumerId: consumer.consumerId });

  await rejects(ctx.tasks.present({ requestId: "t0", entityId: "someone-else", title: "x" }), "TASK_SOURCE_STALE");
  const task = await ctx.tasks.present({ requestId: "t1", entityId: "agent2-session-1", title: "整理" });
  expect(task.source).toEqual({ appId: "org.example.approved", accountGeneration: "mock-account", entityId: "agent2-session-1" });
  await ctx.tasks.progress({ requestId: "t2", taskId: task.taskId, stage: "读取" });
  await ctx.tasks.finish({ requestId: "t3", taskId: task.taskId, outcome: "completed" });
  const result = await ctx.tasks.presentResult({ requestId: "r1", entityId: "agent2-session-1", taskId: task.taskId, title: "完成", body: "结果", deferred: true });
  expect(await ctx.tasks.continueResult({ requestId: "r2", resultId: result.resultId, panelToken: result.panelToken })).toEqual({ opened: true, acknowledged: true });
  expect(host.platformServices!.continued).toEqual([{ appId: "org.example.approved", entityId: "agent2-session-1" }]);
  await rejects(ctx.tasks.continueResult({ requestId: "r3", resultId: result.resultId, panelToken: result.panelToken }), "TASK_RESULT_STALE");
  await host.disable();
});

test("notifications: depth, downgrade receipt, dedupe, own history and mark read", async () => {
  const { host, ctx } = await setup(approved({ now: () => 1000, notificationLevels: { "task.lifecycle": "system" } }));
  const limited = await ctx.notifications.publish({ requestId: "n1", sceneKey: "digest", requestedLevel: "system", title: "摘要", body: "已就绪" });
  expect(limited).toMatchObject({ stored: true, effectiveLevel: "in_app", systemDelivery: "not-requested", reason: "scene-limited" });
  const degraded = await ctx.notifications.publish({ requestId: "n2", sceneKey: "task.lifecycle", requestedLevel: "system", title: "完成", body: "去看看", dedupeKey: "d1" });
  expect(degraded).toMatchObject({ stored: true, effectiveLevel: "in_app", systemDelivery: "not-requested", reason: "system-unavailable" });
  const again = await ctx.notifications.publish({ requestId: "n3", sceneKey: "task.lifecycle", requestedLevel: "system", title: "完成", body: "去看看", dedupeKey: "d1" });
  expect(again).toMatchObject({ notificationId: degraded.notificationId, reason: "deduplicated" });
  await rejects(ctx.notifications.publish({ requestId: "n4", sceneKey: "task.lifecycle", requestedLevel: "system", title: "不同", body: "内容", dedupeKey: "d1" }), "NOTIFICATION_PAYLOAD_INVALID");
  await rejects(ctx.notifications.publish({ requestId: "n5", sceneKey: "undeclared", requestedLevel: "in_app", title: "t", body: "b" }), "NOTIFICATION_SCENE_UNDECLARED");
  const page = await ctx.notifications.listHistory({ requestId: "h1" });
  expect(page.items.map(i => i.notificationId)).toEqual([degraded.notificationId!, limited.notificationId!]);
  expect(page.items.every(i => i.readAtMs === null && i.source.appId === "org.example.approved")).toBe(true);
  await ctx.notifications.markRead({ requestId: "h2", notificationIds: [limited.notificationId!] });
  expect((await ctx.notifications.listHistory({ requestId: "h3", pageSize: 1 })).nextCursor).toBe(degraded.notificationId);
  const read = await ctx.notifications.listHistory({ requestId: "h4" });
  expect(read.items.find(i => i.notificationId === limited.notificationId)?.readAtMs).toBe(1000);
  await host.disable();
});

test("system-approved delivery is queued; user-denied notifications fail closed", async () => {
  const granted = await setup(approved({ systemNotifications: "granted", notificationLevels: { "task.lifecycle": "system" } }));
  expect(await granted.ctx.notifications.publish({ requestId: "n", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b" }))
    .toMatchObject({ effectiveLevel: "system", systemDelivery: "queued" });
  await granted.host.disable();
  const denied = await setup(approved({ notificationDecision: "denied" }));
  await rejects(denied.ctx.notifications.publish({ requestId: "n", sceneKey: "digest", requestedLevel: "in_app", title: "t", body: "b" }), "NOTIFICATION_PERMISSION_DENIED");
  await denied.host.disable();
});

test("lowering task.lifecycle later also lowers notifications linked to an existing task", async () => {
  const fixture = approved({ notificationLevels: { "task.lifecycle": "system", digest: "in_app" }, systemNotifications: "granted" });
  const { host, ctx } = await setup(fixture);
  const task = await ctx.tasks.present({ requestId: "t", entityId: "agent2-session-1", title: "x" });
  fixture.notificationLevels = { "task.lifecycle": "off", digest: "in_app" };
  expect(await ctx.notifications.publish({ requestId: "n", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b", taskId: task.taskId }))
    .toMatchObject({ stored: false, effectiveLevel: "off" });
  fixture.notificationLevels = { "task.lifecycle": "system", digest: "in_app" };
  // A publish alone does not shrink the task: restoring the scene allows it again.
  expect(await ctx.notifications.publish({ requestId: "n2", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b", taskId: task.taskId }))
    .toMatchObject({ stored: true, effectiveLevel: "system" });
  // A task update while lowered shrinks the task permanently (monotonic provenance).
  fixture.notificationLevels = { "task.lifecycle": "off", digest: "in_app" };
  await ctx.tasks.progress({ requestId: "p", taskId: task.taskId, stage: "读取" });
  fixture.notificationLevels = { "task.lifecycle": "system", digest: "in_app" };
  expect(await ctx.notifications.publish({ requestId: "n3", sceneKey: "task.lifecycle", requestedLevel: "system", title: "t", body: "b", taskId: task.taskId }))
    .toMatchObject({ stored: false, effectiveLevel: "off" });
  await host.disable();
});
