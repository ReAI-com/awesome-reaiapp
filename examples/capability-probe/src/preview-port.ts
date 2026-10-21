/**
 * 浏览器预览与测试用的假 Host：只有内存数据，不发任何网络请求。
 * 不会被打进插件安装包（安装包入口是 src/app.ts）。
 */
import type { SystemTaskVersionStatus } from "@reai/app-sdk/v1";
import type { KvPort, ProbePort } from "./port";

export interface PreviewOptions {
  developerMode?: boolean;
  /** 模拟用户还没同意的权限。 */
  deniedPermissions?: Set<string>;
  voiceInstalled?: boolean;
  /** 模拟 Driver 检查未声明的存储空间（真实行为未核实）。 */
  rejectUndeclaredStore?: boolean;
  delayMs?: number;
  /** 模拟旧版 Driver 的宽松网络档：不检查声明，也放行 http。默认按当前 Driver 的严格档。 */
  lenientNetwork?: boolean;
}

/** 与 Voice 插件相同的请求号规则：`<毫秒时间>:<UUIDv4>`。 */
const VOICE_REQUEST_ID = /^(\d{1,16}):[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

const KV_VALUE_LIMIT = 256 * 1024;

function bridgeError(code: string, message: string): Error & { code: string; userMessage: string } {
  return Object.assign(new Error(message), { code, userMessage: message });
}

export function createPreviewPort(options: PreviewOptions = {}): ProbePort & { setDeveloperMode(value: boolean): void } {
  const stores = new Map<string, Map<string, unknown>>();
  const listeners = new Set<(value: { developerMode: boolean }) => void>();
  let developerMode = options.developerMode ?? true;
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 120));
  const denied = (permission: string) => options.deniedPermissions?.has(permission) === true;

  const kvStore = (storeId: string): KvPort => {
    const declared = storeId === "probe";
    const data = stores.get(storeId) ?? new Map<string, unknown>();
    stores.set(storeId, data);
    const guard = () => {
      if (!declared && options.rejectUndeclaredStore) throw bridgeError("STORAGE_NOT_DECLARED", "存储空间没有在清单里声明");
    };
    return {
      async get(key) { await delay(); guard(); return structuredClone(data.get(key)); },
      async set(key, value) {
        await delay();
        guard();
        if (JSON.stringify(value).length > KV_VALUE_LIMIT) throw bridgeError("STORAGE_QUOTA_EXCEEDED", "单条数据超过 256 KiB");
        data.set(key, structuredClone(value));
      },
      async compareAndSet(key, expected, value) {
        await delay();
        guard();
        if (JSON.stringify(data.get(key)) !== JSON.stringify(expected)) return false;
        data.set(key, structuredClone(value));
        return true;
      },
      async delete(key) { await delay(); guard(); data.delete(key); },
      async keys() { await delay(); guard(); return [...data.keys()]; },
    };
  };

  const versionStatus: SystemTaskVersionStatus = {
    firmware: { currentVersion: "1.59", latestVersion: "1.59", updateAvailable: false, connected: true, connectionType: "usb" },
    app: { currentVersion: "预览", latestVersion: null, updateAvailable: false, installable: false, blockedReason: "development-build" },
    checkedAt: null,
    source: "unavailable",
  };

  return {
    mode: "preview",
    async environment() { return { developerMode }; },
    onEnvironmentChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    setDeveloperMode(value) {
      developerMode = value;
      for (const listener of listeners) listener({ developerMode });
    },
    locale: () => "zh",
    kv: kvStore("probe"),
    kvStore,
    async versionStatus() { await delay(); return structuredClone(versionStatus); },
    async openSystemTask() { await delay(); return { taskId: "preview-task" }; },
    async accountStatus() {
      await delay();
      if (denied("account.status@1")) throw bridgeError("PLUGIN_PERMISSION_DENIED", "用户拒绝了 account.status@1");
      return { enabled: true, loggedIn: true };
    },
    async notify() {
      await delay();
      if (denied("os.notification.post@1")) throw bridgeError("PLUGIN_PERMISSION_REQUIRED", "需要用户允许 os.notification.post@1");
      return { queued: true as const };
    },
    async fetch(url) {
      await delay();
      if (denied("http.fetch@1")) throw bridgeError("PLUGIN_PERMISSION_REQUIRED", "需要用户允许 http.fetch@1");
      const parsed = new URL(url);
      if (options.lenientNetwork) return { status: 200, text: "预览假数据：宽松网络档放行了这个请求" };
      // 与 Driver 一致：先按清单匹配地址。清单只收 https，所以 http 地址在这一步就按「没声明」拦下。
      if (parsed.origin !== "https://block2-api.wainao.chat" || !parsed.pathname.startsWith("/health")) {
        throw bridgeError("NETWORK_ENDPOINT_NOT_DECLARED", "URL origin 未在 Manifest 中申报");
      }
      return { status: 200, text: "{\"status\":\"ok\",\"note\":\"预览假数据，没有真的访问网络\"}" };
    },
    async callService(serviceId, _method, input) {
      await delay();
      if (!options.voiceInstalled) throw bridgeError("SERVICE_PROVIDER_UNAVAILABLE", `${serviceId} 未安装或未启用`);
      const requestId = (input as { requestId?: unknown } | null)?.requestId;
      if (typeof requestId !== "string" || !VOICE_REQUEST_ID.test(requestId)) throw bridgeError("VOICE_REQUEST_INVALID", "请求号格式不对");
      return { requestId: "preview", phase: "not_found", revision: 0, captureStarted: false, pcmReceived: false };
    },
  };
}
