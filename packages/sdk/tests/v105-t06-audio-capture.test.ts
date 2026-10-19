import { expect, test } from 'bun:test';
import { runApp, type AppContext, type HostBridge, type HostMessage } from '../src/v1/index';
const tick = () => new Promise(r => setTimeout(r, 0));
function harness(snapshot: unknown) {
 let receive!: (m: HostMessage) => void; let ctx!: AppContext;
 const calls: Array<{method: string; params: unknown}> = [];
 const h = { snapshot, deferred: undefined as undefined | Promise<unknown> };
 const bridge: HostBridge = {
  async request(method, params) {
   calls.push({method, params});
   if (method === 'environment.get') return h.snapshot as never;
   return (h.deferred ? await h.deferred : method === 'audio.consumers.release' ? null : {consumerId: 'consumer-1', owner: {appId: 'app.a', accountGeneration: '0'}, route: {source: 'system'}}) as never;
  }, notify() {}, subscribe(handler) {receive=handler; return () => {};}
 };
 const running = runApp({activate(c) {ctx=c; c.surfaces.register('main', s=>s.ready());}},bridge);
 const send=(m:HostMessage)=>receive(m);
 send({type:'activate',runtimeSessionId:'rt'}); send({type:'surface.mount',surfaceMountId:'mt',surfaceId:'main',root:{}});
 return {h,calls,send,running,get ctx() {return ctx;}};
}
const descriptor=(available=true,methods=['audio.consumers.acquire','audio.consumers.release','audio.consumers.status'])=>({audioCapture:{runtimeSessionId:'rt',surfaceMountId:'mt',platformCapabilities:{version:1,capabilities:{'audio.capture@1':{version:1,available,methods}}}}});
test('old, withheld and incomplete Host descriptors reject without any audio request',async()=>{
 for(const snapshot of [undefined,{},descriptor(false),descriptor(true,[])]) {
  const h=harness(snapshot);await tick();expect(h.ctx.audioCapture).toBeDefined();
  await expect(h.ctx.audioCapture.acquire({requestId:'a',purpose:'speech'})).rejects.toMatchObject({code:'HOST_CAPABILITY_NOT_AVAILABLE'});
  expect(h.calls.some(c=>c.method.startsWith('audio.'))).toBe(false);await h.running.dispose();
 }
});
test('current Host descriptor forwards exact frozen payload; release after revocation cleans own receipt',async()=>{
 const h=harness(descriptor());await tick();
 await h.ctx.audioCapture.acquire({requestId:'a',purpose:'speech'});
 await h.ctx.audioCapture.status({requestId:'s',consumerId:'consumer-1'});
 expect(h.calls.filter(c=>c.method.startsWith('audio.')).map(c=>c.params)).toEqual([{requestId:'a',purpose:'speech'},{requestId:'s',consumerId:'consumer-1'}]);
 h.h.snapshot=descriptor(false);
 await h.ctx.audioCapture.release({requestId:'r',consumerId:'consumer-1'});
 expect(h.calls.at(-1)?.method).toBe('audio.consumers.release');await h.running.dispose();
});
test('unmount during acquire rejects its late receipt and next mount cannot release it',async()=>{
 const h=harness(descriptor());await tick();let resolve!: (v:unknown)=>void;
 h.h.deferred=new Promise(r=>resolve=r);
 const p=h.ctx.audioCapture.acquire({requestId:'a',purpose:'speech'});await tick();
 h.send({type:'surface.unmount',surfaceMountId:'mt'});
 h.send({type:'surface.mount',surfaceMountId:'mt2',surfaceId:'main',root:{}});await tick();
 resolve({consumerId:'consumer-1'});
 await expect(p).rejects.toMatchObject({code:'AUDIO_CONSUMER_STALE'});
 h.h.deferred=undefined;h.h.snapshot=descriptor(false);await expect(h.ctx.audioCapture.release({requestId:'r',consumerId:'consumer-1'})).rejects.toMatchObject({code:'AUDIO_CONSUMER_STALE'});
 await h.running.dispose();
});
