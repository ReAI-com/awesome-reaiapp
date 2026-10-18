import type { KeyValueStore } from '@reai/app-sdk/v1';
/** Browser preview only. Host packages use the Host private store. */
export function createBrowserStore(appId: string): KeyValueStore {
  const prefix=`reai-demo:${appId}:`;
  const read = <T>(key:string): T | undefined => {const raw=localStorage.getItem(prefix+key);return raw===null?undefined:JSON.parse(raw) as T;};
  return {
    async get<T>(key:string){return read<T>(key);},
    async set(key,value){localStorage.setItem(prefix+key,JSON.stringify(value));},
    async compareAndSet(key,expected,value){
      if(!navigator.locks)throw new Error('当前浏览器缺少安全的并发存储能力，请使用支持 Web Locks 的浏览器');
      return navigator.locks.request(prefix+'commit',()=>{
        if(JSON.stringify(read(key))!==JSON.stringify(expected))return false;
        localStorage.setItem(prefix+key,JSON.stringify(value));return true;
      });
    },
    async delete(){throw new Error('Demo 不删除原始资料');},
    async keys(){return Object.keys(localStorage).filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length));},
  };
}
