/**
 * 探针与 Host 之间的窄接口。
 *
 * 真实运行时由 `createHostPort` 包住 SDK 的 `AppContext`；浏览器预览和测试用假的实现。
 * 探针只依赖这里列出的方法，这样每个按钮到底调了 Host 的哪一项能力一目了然。
 */
import type { AppContext, SystemTaskTarget, SystemTaskVersionStatus } from "@reai/app-sdk/v1";

export interface KvPort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  compareAndSet(key: string, expected: unknown, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface HttpResult {
  status: number;
  text: string;
}

export interface ProbePort {
  /** "host" = 运行在 Driver 里；"preview" = 浏览器预览的假数据。 */
  readonly mode: "host" | "preview";
  environment(): Promise<{ developerMode: boolean }>;
  onEnvironmentChange(handler: (value: { developerMode: boolean }) => void): () => void;
  locale(): string;
  /** 已在 Manifest 声明的私有存储。 */
  kv: KvPort;
  /** 按 storeId 取存储；用来验证「未声明的 storeId 会不会被拒」。 */
  kvStore(storeId: string): KvPort;
  versionStatus(): Promise<SystemTaskVersionStatus>;
  /** returnIntent 会在用户从系统页点「返回」时原样带回（system-task.return 的 payload）。 */
  openSystemTask(target: SystemTaskTarget, returnIntent?: unknown): Promise<{ taskId: string }>;
  accountStatus(): Promise<{ enabled: boolean; loggedIn: boolean }>;
  notify(title: string, body: string): Promise<{ queued: true }>;
  fetch(url: string, init: { endpointId?: string; method: string; signal?: AbortSignal; body?: string | FormData; headers?: Record<string, string> }): Promise<HttpResult>;
  callService(serviceId: string, method: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export const PROBE_STORE_ID = "probe";

function kvFrom(ctx: AppContext, storeId: string): KvPort {
  const store = ctx.storage.private(storeId);
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    compareAndSet: (key, expected, value) => store.compareAndSet(key, expected, value),
    delete: (key) => store.delete(key),
    keys: () => store.keys(),
  };
}

export function createHostPort(ctx: AppContext): ProbePort {
  return {
    mode: "host",
    environment: () => ctx.environment.get(),
    onEnvironmentChange: (handler) => ctx.environment.onChange(handler),
    locale: () => ctx.locale.getSnapshot().locale,
    kv: kvFrom(ctx, PROBE_STORE_ID),
    kvStore: (storeId) => kvFrom(ctx, storeId),
    versionStatus: () => ctx.systemTasks.getVersionStatus(),
    openSystemTask: async (target, returnIntent) => {
      const result = await ctx.systemTasks.open({ target, ...(returnIntent === undefined ? {} : { returnIntent }) });
      return { taskId: result.taskId };
    },
    accountStatus: () => ctx.account.status(),
    notify: (title, body) => ctx.notifications.post({ title, body }),
    fetch: async (url, init) => {
      const response = await ctx.http.fetch(url, {
        method: init.method,
        ...(init.endpointId ? { endpointId: init.endpointId } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.headers ? { headers: init.headers } : {}),
      });
      return { status: response.status, text: await response.text() };
    },
    callService: (serviceId, method, input, signal) =>
      ctx.services.call(serviceId, method, input, signal ? { signal } : undefined),
  };
}
