import { expect, test } from 'bun:test';
import { runApp, type AppContext, type HostBridge, type HostMessage } from '../src/v1/index';
const tick = () => new Promise(r => setTimeout(r, 0));
const METHODS = ['notifications.publish', 'notifications.history.list', 'notifications.history.markRead'];
const descriptor = (available = true, methods = METHODS, mount = 'mt') => ({ notificationPublish: { runtimeSessionId: 'rt', surfaceMountId: mount,
  platformCapabilities: { version: 1, capabilities: { 'notifications.publish@1': { version: 1, available, methods } } } } });
function harness(snapshot: unknown) {
  let receive!: (m: HostMessage) => void; let ctx!: AppContext;
  const calls: Array<{ method: string; params: unknown }> = [];
  const h = { snapshot, deferred: undefined as undefined | Promise<unknown> };
  const bridge: HostBridge = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'environment.get') return h.snapshot as never;
      if (h.deferred) return await h.deferred as never;
      if (method === 'notifications.publish') return { notificationId: 'n-1', stored: true, requestedLevel: 'system', effectiveLevel: 'in_app', systemDelivery: 'not-requested', reason: 'system-unavailable' } as never;
      if (method === 'notifications.history.list') return { items: [], nextCursor: null } as never;
      return null as never;
    }, notify() {}, subscribe(handler) { receive = handler; return () => {}; },
  };
  const running = runApp({ activate(c) { ctx = c; c.surfaces.register('main', s => s.ready()); } }, bridge);
  const send = (m: HostMessage) => receive(m);
  send({ type: 'activate', runtimeSessionId: 'rt' }); send({ type: 'surface.mount', surfaceMountId: 'mt', surfaceId: 'main', root: {} });
  return { h, calls, send, running, get ctx() { return ctx; } };
}
const publish = { requestId: 'r', sceneKey: 'done', requestedLevel: 'system' as const, title: '完成', body: '去看看' };

test('old, withheld and incomplete Host descriptors reject without any notification request', async () => {
  for (const snapshot of [undefined, {}, descriptor(false), descriptor(true, METHODS.slice(1))]) {
    const h = harness(snapshot); await tick();
    await expect(h.ctx.notifications.publish(publish)).rejects.toMatchObject({ code: 'HOST_CAPABILITY_NOT_AVAILABLE' });
    expect(h.calls.some(c => METHODS.includes(c.method))).toBe(false); await h.running.dispose();
  }
});
test('descriptor for another mount is stale; current descriptor forwards the exact payload', async () => {
  const stale = harness(descriptor(true, METHODS, 'other')); await tick();
  await expect(stale.ctx.notifications.listHistory({ requestId: 'l' })).rejects.toMatchObject({ code: 'NOTIFICATION_SOURCE_STALE' });
  await stale.running.dispose();
  const h = harness(descriptor()); await tick();
  const receipt = await h.ctx.notifications.publish(publish);
  expect(receipt).toMatchObject({ effectiveLevel: 'in_app', reason: 'system-unavailable' });
  await h.ctx.notifications.listHistory({ requestId: 'l', pageSize: 5 });
  await h.ctx.notifications.markRead({ requestId: 'm', notificationIds: ['n-1'] });
  expect(h.calls.filter(c => METHODS.includes(c.method)).map(c => [c.method, c.params])).toEqual([
    ['notifications.publish', publish], ['notifications.history.list', { requestId: 'l', pageSize: 5 }],
    ['notifications.history.markRead', { requestId: 'm', notificationIds: ['n-1'] }],
  ]);
  await h.running.dispose();
});
test('unmount during publish drops the late receipt', async () => {
  const h = harness(descriptor()); await tick(); let resolve!: (v: unknown) => void;
  h.h.deferred = new Promise(r => resolve = r);
  const pending = h.ctx.notifications.publish(publish); await tick(); await tick();
  h.send({ type: 'surface.unmount', surfaceMountId: 'mt' } as HostMessage);
  resolve({ notificationId: 'late' });
  await expect(pending).rejects.toMatchObject({ code: 'NOTIFICATION_SOURCE_STALE' });
  await h.running.dispose();
});
