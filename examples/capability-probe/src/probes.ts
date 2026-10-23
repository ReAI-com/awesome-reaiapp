/**
 * 探针清单：每个探针 = 一个按钮 = 对一项能力的一次真实调用。
 *
 * 档位：P0 本地开发包就能跑；P1 需要连上外脑（插件自己的 OAuth 应用）；P2 需要平台批准。
 * 本版只构建 P0，P1 / P2 只列出「会做什么、预期什么」，按钮保持关闭。
 */
import { checkBlobScript, checkEval, checkIframe, checkInlineScript, type CspCheckResult } from "./csp-check";
import { describeError, gateHint, isGateCode, scrub } from "./errors";
import type { ProbePort } from "./port";

export type Level = "P0" | "P1" | "P2";
export type ProbeSection = "basic" | "permission" | "page" | "cloud" | "gated";
/**
 * safe：只读，或只写本插件自己的测试数据并删掉；navigate：会切到 Driver 别的页面；
 * notify：会弹系统通知；wake：会启动另一个插件。只有 safe 进「全部测试」。
 */
export type Risk = "safe" | "navigate" | "notify" | "wake";
/**
 * ok：按预期成功；blocked：被拦下（反例按预期被拒，或者用户还没同意）；
 * unexpected：结果和预期不一样；failed：出错；waiting：需要你先做一步操作。
 */
export type Outcome = "ok" | "blocked" | "unexpected" | "failed" | "waiting";

export interface ProbeRun {
  outcome: Outcome;
  summary: string;
  /** 「被拦下」是不是这个测试想看到的结果（反例按预期被拒）。没同意权限的被拦下不算。 */
  expected?: boolean;
  code?: string;
  detail?: string;
}

export interface ProbeResult extends ProbeRun {
  probeId: string;
  startedAt: string;
  durationMs: number;
}

export interface ProbeContext {
  port: ProbePort;
  document: Document;
  signal: AbortSignal;
}

export interface ProbeDefinition {
  id: string;
  section: ProbeSection;
  level: Level;
  title: string;
  /** 这个按钮做了什么。 */
  what: string;
  /** 预期结果。 */
  expect: string;
  /** 对应的能力或权限 id；外脑探针写 scope。 */
  capability: string;
  risk: Risk;
  /** 本构建里不能跑的原因。 */
  disabledReason?: string;
  run?: (context: ProbeContext) => Promise<ProbeRun>;
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  ok: "成功",
  blocked: "被拦下",
  unexpected: "与预期不同",
  failed: "出错",
  waiting: "等你操作",
};

export const SECTION_LABELS: Record<ProbeSection, string> = {
  basic: "本机基础能力",
  permission: "需要你点同意的能力",
  page: "页面脚本限制",
  cloud: "外脑云端（未开通）",
  gated: "需要平台批准（本地包用不了）",
};

export const VOICE_SERVICE_ID = "com.reai.voice/request-text@1";
export const HEALTH_URL = "https://block2-api.wainao.chat/health";
export const PING_KEY = "probe.lastPing";
/** 「跳到 Driver 设置页」交给 Driver 的返回信息：用户点「返回」时 Driver 原样带回，探针据此确认跳转发生过。 */
export const NAVIGATE_RETURN_TAG = "capability-probe/system-task-open";
const OVERSIZE_KEY = "probe.oversize";
const KV_VALUE_LIMIT = 256 * 1024;

/** 等待可被取消；无论哪种结束都摘掉监听，避免在界面生命周期内越积越多。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 正常调用失败：没同意 / Host 没这项能力算「被拦下」，其他算「出错」。 */
function failure(error: unknown): ProbeRun {
  const { code, message } = describeError(error);
  if (isGateCode(code)) return { outcome: "blocked", summary: gateHint(code), code, detail: scrub(message) };
  return { outcome: "failed", summary: "调用出错", code, detail: scrub(message) };
}

/**
 * 反例失败：只有预期的错误码才算「按预期被拦下」。
 * 别的原因（没同意、限流、超时）照常分类，不能冒充「反例通过」。
 */
function expectedRejection(error: unknown, expected: (code: string) => boolean, reason: string): ProbeRun {
  const { code, message } = describeError(error);
  if (expected(code)) return { outcome: "blocked", expected: true, summary: `按预期被拦下：${reason}`, code, detail: scrub(message) };
  if (isGateCode(code)) return { outcome: "blocked", summary: `没测到：${gateHint(code)}`, code, detail: scrub(message) };
  return { outcome: "failed", summary: "被拒了，但原因不是预期的那一个", code, detail: scrub(message) };
}

/** 反例意外写入成功后清理测试数据；清理失败时如实说明，不能声称已删除。 */
async function cleanupNote(remove: () => Promise<void>): Promise<string> {
  try {
    await remove();
    return "已删除测试数据";
  } catch {
    return "测试数据没删掉，可能仍有残留";
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Voice 只接受 `<毫秒时间>:<UUIDv4>` 形式的请求号。 */
export function voiceRequestId(now = Date.now()): string {
  const uuid = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : (() => {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    })();
  return `${now}:${uuid}`;
}

function cspProbe(id: string, title: string, what: string, check: (doc: Document, signal?: AbortSignal) => Promise<CspCheckResult>): ProbeDefinition {
  return {
    id,
    section: "page",
    level: "P0",
    title,
    what,
    expect: "在 Driver 里被拦下，代码没有运行",
    capability: "surface.main@1",
    risk: "safe",
    async run({ port, document, signal }) {
      const result = await check(document, signal);
      const rules = result.violations.length > 0 ? `浏览器报告违反的规则：${result.violations.join("、")}` : "浏览器没有报告违规事件";
      const detail = [rules, result.error ? `错误：${result.error}` : ""].filter(Boolean).join("；");
      // 等加载时超时或被取消：代码没跑，但也说明不了是被 Driver 拦下的，不能算通过。
      if (!result.executed && result.settled !== "done") {
        return { outcome: "waiting", summary: result.settled === "abort" ? "没测完：界面关掉了，请再测一次" : "没测完：等了 1.5 秒还没有结果，请再测一次", detail };
      }
      if (!result.executed) return { outcome: "blocked", expected: true, summary: "被拦下，代码没有运行", detail };
      if (port.mode === "preview") {
        return { outcome: "unexpected", summary: "没被拦：现在是浏览器预览，没有 Driver 的页面限制", detail };
      }
      return { outcome: "unexpected", summary: "没被拦：代码运行了，和平台规则不一致，请把报告发给平台", detail };
    },
  };
}

const P1_REASON = "需要先连上外脑：给插件建 OAuth 应用、把应用编号写进插件后重新打包（见 README「连接外脑」）";
const P2_REASON = "需要平台批准：本地开发包只要声明这项能力就会装不上";

function cloudProbe(id: string, title: string, what: string, capability: string, expect: string): ProbeDefinition {
  return { id, section: "cloud", level: "P1", title, what, expect, capability, risk: "safe", disabledReason: P1_REASON };
}

function gatedProbe(id: string, title: string, what: string, capability: string, expect: string): ProbeDefinition {
  return { id, section: "gated", level: "P2", title, what, expect, capability, risk: "safe", disabledReason: P2_REASON };
}

const UNDECLARED_NETWORK = new Set(["NETWORK_ENDPOINT_NOT_DECLARED", "NETWORK_PATH_DENIED", "NETWORK_METHOD_DENIED"]);
const INSECURE_NETWORK = new Set(["NETWORK_SCHEME_DENIED", "NETWORK_ENDPOINT_NOT_DECLARED"]);
const LENIENT_NOTE = "当前 Driver 对本地包一律按严格网络规则检查，没被拦说明这个 Driver 版本较旧（旧版开发者模式会放宽网络检查），请更新 Driver 后再测。";

export const PROBES: ProbeDefinition[] = [
  {
    id: "env",
    section: "basic",
    level: "P0",
    title: "运行环境",
    what: "读取 Driver 的开发者模式开关和界面语言",
    expect: "返回开关状态和语言",
    capability: "environment.get",
    risk: "safe",
    async run({ port }) {
      try {
        const env = await port.environment();
        const locale = port.locale() === "en" ? "英文" : "中文";
        return { outcome: "ok", summary: `开发者模式：${env.developerMode ? "开" : "关"}；界面语言：${locale}` };
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    id: "host-version",
    section: "basic",
    level: "P0",
    title: "Driver 与固件版本",
    what: "读取当前 Driver 版本、最新版本和键盘固件版本",
    expect: "返回版本号",
    capability: "system.tasks@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        let status;
        try {
          status = await port.versionStatus();
        } catch (error) {
          // Driver 限制同一界面 2 秒内只查一次（打开插件时已经查过一次）；等一下再试一次。
          if (describeError(error).code !== "SYSTEM_TASK_RATE_LIMITED") throw error;
          await sleep(2100, signal);
          if (signal.aborted) return { outcome: "waiting", summary: "界面已关闭，没有再查" };
          status = await port.versionStatus();
        }
        const firmware = status.firmware.connected
          ? `固件 ${status.firmware.currentVersion ?? "未知"}（${status.firmware.connectionType === "ble" ? "蓝牙" : "USB"} 已连接）`
          : "键盘未连接";
        const update = status.app.updateAvailable ? `，可更新到 ${status.app.latestVersion ?? "新版本"}` : "";
        return { outcome: "ok", summary: `Driver ${status.app.currentVersion}${update}；${firmware}` };
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    id: "kv-roundtrip",
    section: "basic",
    level: "P0",
    title: "本地存储读写",
    what: "写入一条测试数据，读回，做一次「比较后再写」，列出键，最后删掉",
    expect: "每一步都成功，测试数据不留痕",
    capability: "storage.kv@1",
    risk: "safe",
    async run({ port }) {
      // 每次用自己的键，并发运行也互不干扰；无论成败最后都删掉。
      const key = `probe.roundtrip.${nonce()}`;
      try {
        const value = { nonce: nonce(), at: new Date().toISOString() };
        await port.kv.set(key, value);
        const back = (await port.kv.get(key)) as typeof value | undefined;
        if (!back || back.nonce !== value.nonce) return { outcome: "unexpected", summary: "读回的数据和写入的不一致" };
        const swapped = await port.kv.compareAndSet(key, back, { ...value, swapped: true });
        const keys = await port.kv.keys();
        await port.kv.delete(key);
        const gone = (await port.kv.get(key)) === undefined;
        if (!swapped || !keys.includes(key) || !gone) {
          return { outcome: "unexpected", summary: `部分步骤和预期不同：比较后再写 ${swapped ? "成功" : "失败"}，键列表${keys.includes(key) ? "包含" : "不含"}测试键，删除${gone ? "成功" : "后仍能读到"}` };
        }
        return { outcome: "ok", summary: "写入、读回、比较后再写、列键、删除都正常" };
      } catch (error) {
        return failure(error);
      } finally {
        await port.kv.delete(key).catch(() => undefined);
      }
    },
  },
  {
    id: "kv-oversize",
    section: "basic",
    level: "P0",
    title: "超大数据会被拒（反例）",
    what: "尝试写入一条 300 KB 的数据（单条上限 256 KB）",
    expect: "被拒绝",
    capability: "storage.kv@1",
    risk: "safe",
    async run({ port }) {
      try {
        await port.kv.set(OVERSIZE_KEY, "x".repeat(KV_VALUE_LIMIT + 44 * 1024));
      } catch (error) {
        return expectedRejection(error, (code) => code === "STORAGE_QUOTA_EXCEEDED", "单条超过 256 KB");
      }
      const cleanup = await cleanupNote(() => port.kv.delete(OVERSIZE_KEY));
      return { outcome: "unexpected", summary: `300 KB 的数据被接受了，和公开的 256 KB 上限不一致（${cleanup}）` };
    },
  },
  {
    id: "kv-undeclared",
    section: "basic",
    level: "P0",
    title: "没声明的存储空间（反例）",
    what: "往清单里没声明的存储空间写一条数据",
    expect: "被拒绝（只能用清单 data.privateStores 里声明过的存储空间）",
    capability: "storage.kv@1",
    risk: "safe",
    async run({ port }) {
      const store = port.kvStore("undeclared-probe");
      try {
        await store.set("probe", 1);
      } catch (error) {
        return expectedRejection(error, (code) => code === "STORAGE_NOT_DECLARED", "存储空间没有声明");
      }
      const cleanup = await cleanupNote(() => store.delete("probe"));
      return { outcome: "unexpected", summary: `没被拒：这个 Driver 版本还不检查存储空间是否声明过，请更新 Driver（${cleanup}）` };
    },
  },
  {
    id: "command-ping",
    section: "basic",
    level: "P0",
    title: "键盘按键触发命令",
    what: "查看「能力探针：测试按键」这个命令最近一次被触发的记录",
    expect: "绑定按键并按一下后，这里显示触发时间",
    capability: "commands@1",
    risk: "safe",
    async run({ port }) {
      try {
        const last = (await port.kv.get(PING_KEY)) as { at?: string; count?: number } | undefined;
        if (!last?.at) {
          return { outcome: "waiting", summary: "还没被触发过：到 Driver「设备 → 键位映射」点一个键，在「插件动作」里选「能力探针：测试按键」，按一下这个键（或点绑定抽屉里的「测试」），再回来点这里。注意拨杆当前所在的那一档如果给这个键单独配了别的动作，按下去会执行那个动作，不会触发探针" };
        }
        return { outcome: "ok", summary: `最近一次在 ${formatTime(last.at)} 被触发，累计 ${last.count ?? 1} 次` };
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    id: "voice-service",
    section: "basic",
    level: "P0",
    title: "调用 Voice 插件的服务",
    what: "问 Voice 的文字服务「一个刚编出来的请求现在什么状态」，不会开始录音；Voice 没在运行时会被唤醒",
    expect: "装了 Voice：服务能应答（「找不到这个请求」也算能应答）；没装或没同意：给出原因",
    capability: "apps.service@1",
    risk: "wake",
    async run({ port, signal }) {
      try {
        const result = (await port.callService(VOICE_SERVICE_ID, "status", { requestId: voiceRequestId() }, signal)) as { phase?: unknown } | null;
        const phase = typeof result?.phase === "string" ? result.phase : "未知";
        return { outcome: "ok", summary: `Voice 服务能应答（返回状态：${phase === "not_found" ? "找不到这个请求，符合预期" : phase}）` };
      } catch (error) {
        const { code, message } = describeError(error);
        // Voice 的错误码到调用方这里可能带上 `com.reai.voice/` 前缀。
        const voiceCode = code.replace(/^com\.reai\.voice\//, "");
        if (voiceCode.startsWith("VOICE_REQUEST_")) {
          return { outcome: "ok", summary: "Voice 服务能应答（它拒绝了这个测试请求，说明服务在线）", code, detail: scrub(message) };
        }
        if (code === "SERVICE_PROVIDER_UNAVAILABLE" || isGateCode(code) || /CONSENT|DEPENDENCY|NOT_INSTALLED/.test(code)) {
          return { outcome: "blocked", summary: "Voice 服务现在调不了：可能没装、没启用，或你还没同意这个依赖", code, detail: scrub(message) };
        }
        return { outcome: "failed", summary: "调用出错", code, detail: scrub(message) };
      }
    },
  },
  {
    id: "system-task-open",
    section: "basic",
    level: "P0",
    title: "跳到 Driver 设置页",
    what: "请 Driver 打开「本插件的权限设置」页面（会离开当前页面）",
    expect: "Driver 切到权限设置页；点 Driver 右上角的「返回」回到探针，收到 Driver 的回执才算通过",
    capability: "system.tasks@1",
    risk: "navigate",
    async run({ port }) {
      // 跳转成功时 Driver 会关掉探针页面，这次调用的回执来不及回来；
      // 真正的确认是用户从权限页点「返回」时 Driver 带回的 system-task.return（见 systemTaskReturnResult）。
      try {
        const result = await port.openSystemTask("app-permissions", { probe: NAVIGATE_RETURN_TAG, at: new Date().toISOString() });
        // Driver 只是接受了请求，还不能证明跳过去了：等用户从权限页点「返回」、Driver 带回回执才算通过。
        return { outcome: "waiting", summary: "Driver 已接受，正在打开本插件的权限页；到那边点右上角「返回」回到探针，收到回执才算通过", detail: `任务号 ${result.taskId}` };
      } catch (error) {
        // Driver 同一时间只开一个系统任务：上一次跳转没点「返回」或「关闭」就回来，它还挂着，新的会被拒。
        const { code, message } = describeError(error);
        if (code === "SYSTEM_TASK_RETURN_PENDING" || code === "SYSTEM_TASK_BUSY") {
          return { outcome: "waiting", summary: "上一次跳转还没结束：点 Driver 右上角状态条里的「返回」（或「关闭」）把它结束掉，再测一次", code, detail: scrub(message) };
        }
        return failure(error);
      }
    },
  },
  {
    id: "account",
    section: "permission",
    level: "P0",
    title: "是否已登录外脑",
    what: "读取「账户功能开没开、有没有登录」",
    expect: "同意前被拦下；同意后返回两个开关",
    capability: "account.status@1",
    risk: "safe",
    async run({ port }) {
      try {
        const status = await port.accountStatus();
        return { outcome: "ok", summary: `账户功能：${status.enabled ? "已开启" : "未开启"}；登录状态：${status.loggedIn ? "已登录" : "未登录"}` };
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    id: "notify",
    section: "permission",
    level: "P0",
    title: "发一条系统通知",
    what: "发送标题为「能力探针」的测试通知",
    expect: "同意前被拦下；同意后电脑右上角出现通知",
    capability: "os.notification.post@1",
    risk: "notify",
    async run({ port, signal }) {
      const post = () => port.notify("能力探针", "这是一条测试通知，可以忽略。");
      try {
        await post();
        return { outcome: "ok", summary: "已交给 Driver 发送，请看电脑右上角" };
      } catch (error) {
        // Driver 偶尔没能把通知交给系统（它发通知时 macOS 主线程正忙）；隔一会儿重试一次，并如实写明。
        if (describeError(error).code !== "NOTIFICATION_ENQUEUE_FAILED") return failure(error);
        await sleep(1500, signal);
        if (signal.aborted) return failure(error);
        try {
          await post();
          return { outcome: "ok", summary: "第一次 Driver 没能把通知交给系统，隔 1.5 秒重试成功，请看电脑右上角", code: "NOTIFICATION_ENQUEUE_FAILED", detail: "第一次失败后重试成功；这是 Driver 侧的偶发问题，值得报告给平台" };
        } catch (retryError) {
          const run = failure(retryError);
          return { ...run, summary: `Driver 两次都没能把通知交给系统：${run.summary}` };
        }
      }
    },
  },
  {
    id: "http-health",
    section: "permission",
    level: "P0",
    title: "经 Driver 访问外脑",
    what: `请求外脑公开的健康检查地址 ${HEALTH_URL}（不带任何身份）`,
    expect: "同意前被拦下；同意后返回 HTTP 200",
    capability: "http.fetch@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const response = await port.fetch(HEALTH_URL, { endpointId: "wainao-health", method: "GET", signal });
        const ok = response.status >= 200 && response.status < 300;
        return {
          outcome: ok ? "ok" : "unexpected",
          summary: ok ? `外脑服务在线（HTTP ${response.status}）` : `外脑返回 HTTP ${response.status}`,
          detail: scrub(response.text, 300),
        };
      } catch (error) {
        return failure(error);
      }
    },
  },
  {
    id: "http-undeclared",
    section: "permission",
    level: "P0",
    title: "访问没声明的网址（反例）",
    what: "请求清单里没声明的 https://example.com/",
    expect: "被 Driver 拦下（只放行清单里声明过的地址）",
    capability: "http.fetch@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const response = await port.fetch("https://example.com/", { method: "GET", signal });
        return { outcome: "unexpected", summary: `没被拦：返回了 HTTP ${response.status}。${LENIENT_NOTE}` };
      } catch (error) {
        return expectedRejection(error, (code) => UNDECLARED_NETWORK.has(code), "地址没有在清单里声明");
      }
    },
  },
  {
    id: "http-insecure",
    section: "permission",
    level: "P0",
    title: "访问不加密的 http 地址（反例）",
    what: "用 http:// 而不是 https:// 请求外脑健康检查",
    expect: "被 Driver 拦下。清单只能声明 https 地址（安装时检查），所以 http 地址会按「没声明」拦下",
    capability: "http.fetch@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const response = await port.fetch(HEALTH_URL.replace("https://", "http://"), { method: "GET", signal });
        return { outcome: "unexpected", summary: `没被拦：返回了 HTTP ${response.status}。${LENIENT_NOTE}` };
      } catch (error) {
        const reason = describeError(error).code === "NETWORK_SCHEME_DENIED" ? "只允许 https" : "http 地址不能写进清单，按没声明的地址拦下";
        return expectedRejection(error, (code) => INSECURE_NETWORK.has(code), reason);
      }
    },
  },
  cspProbe("csp-inline", "页面里插入一段脚本", "往页面里插一个带代码的 <script> 标签", checkInlineScript),
  cspProbe("csp-eval", "把字符串当代码执行", "用 new Function 执行一段字符串代码", checkEval),
  cspProbe("csp-blob", "运行时生成脚本文件", "把代码打成一个临时文件再加载", checkBlobScript),
  cspProbe("csp-iframe", "页面里嵌一个网页", "用 iframe 嵌入一个运行时生成的网页", checkIframe),

  cloudProbe("cloud-userinfo", "读当前用户", "读取当前用户的编号和昵称（/oauth/userinfo）", "profile:read", "返回用户编号和昵称，不返回邮箱"),
  cloudProbe("cloud-projects", "列出项目", "列出当前用户能读的项目", "projects:read", "返回项目列表"),
  cloudProbe("cloud-files-list", "列出云端文件", "列出测试项目里的文件", "project:files:read", "返回文件列表"),
  cloudProbe("cloud-files-upload", "上传文件到云端", "选一个文件上传到测试项目", "project:files:write", "上传成功；同一内容再传一次，内容指纹相同"),
  cloudProbe("cloud-files-delete", "删除云端文件（反例）", "尝试删除刚上传的文件", "project:files:write", "预期被拒：外脑目前没对插件开放删除"),
  cloudProbe("cloud-folder", "云端文件夹（反例）", "尝试在测试项目里建文件夹、改名、移动", "project:files:write", "预期被拒或提示服务未开放：统一文件接口的云端部分还没上线"),
  cloudProbe("cloud-kb", "知识库写入与搜索", "写一条知识库内容，再搜索它", "project:kb:read + project:kb:write", "写入成功，搜得到"),
  cloudProbe("cloud-data", "数据表的行增删改", "读数据表，增、改、删、恢复一行", "project:data:read + project:data:write", "每一步都成功"),
  cloudProbe("cloud-collections", "新建数据表（反例）", "尝试新建一张数据表", "project:data:write", "预期被拒：外脑目前没对插件开放改表结构"),
  cloudProbe("cloud-workflow", "工作流新建、编辑、运行", "新建一个最小工作流，编辑它，跑一次并读结果", "documents:write + flows:execute + runs:read", "跑通一个最小工作流"),
  cloudProbe("cloud-model", "调用大模型", "列出模型，确认后发一次对话", "model-gateway:invoke", "返回模型列表和一次回复（会消耗额度）"),
  cloudProbe("cloud-graph", "图谱（反例）", "尝试读取项目图谱", "—", "预期被拒：外脑目前没对插件开放图谱"),

  gatedProbe("gated-agent", "Agent 会话", "建一个 Agent 会话并跑一轮（Pi / DSH / Codex 各一次）", "agent.session@2 + cloud.model.invoke@1", "三个引擎各回复一次"),
  gatedProbe("gated-model", "经 Driver 调用云端模型", "经 Driver 列出模型", "cloud.model.invoke@1", "返回模型列表"),
  gatedProbe("gated-folder", "本地文件夹增删改查", "让用户选一个文件夹，列目录、读、新建、写、改名、删除", "resources.files@1", "每一步都成功；同时改同一文件会提示冲突"),
  gatedProbe("gated-cloud-folder", "云项目文件夹", "挂上一个外脑云项目当文件夹", "resources.files@1", "能列出和读写；如果云端服务还没开放，会如实提示"),
  gatedProbe("gated-agent-folder", "Agent 在文件夹里干活", "把上面的文件夹交给 Agent，让它读一个文件、写一个新文件", "agent.session@2 + resources.files@1", "插件能读到 Agent 写的新文件；只读模式下 Agent 写入被拒"),
];

/** 验收口径：成功，或者反例按预期被拦下，才算「通过」。没同意、等你操作、出错、与预期不同都不算。 */
export function passed(result: Pick<ProbeRun, "outcome" | "expected">): boolean {
  return result.outcome === "ok" || (result.outcome === "blocked" && result.expected === true);
}

/** 本版能实际运行的全部探针（含会跳页面、弹通知、启动 Voice 的）。 */
export function runnableProbes(): ProbeDefinition[] {
  return PROBES.filter((probe) => probe.run && !probe.disabledReason);
}

/**
 * 「跑完全部」的顺序：先跑安全的，再跑弹通知、启动 Voice 的，最后跑会离开页面的。
 * 这样跳走之前，其他结果都已经出来了。
 */
export function acceptanceOrder(): ProbeDefinition[] {
  const rank: Record<Risk, number> = { safe: 0, notify: 1, wake: 2, navigate: 3 };
  return runnableProbes().map((probe, index) => ({ probe, index })).sort((a, b) => rank[a.probe.risk] - rank[b.probe.risk] || a.index - b.index).map(({ probe }) => probe);
}

/** 界面和报告里显示的结果类别：把「按预期被拦下」和「没同意被拦下」分开。 */
export type Verdict = "ok" | "expected" | "blocked" | "unexpected" | "failed" | "waiting";

export const VERDICT_LABELS: Record<Verdict, string> = {
  ok: "成功",
  expected: "按预期拦下",
  blocked: "被拦下",
  unexpected: "与预期不同",
  failed: "出错",
  waiting: "等你操作",
};

export const VERDICT_ORDER: Verdict[] = ["ok", "expected", "blocked", "unexpected", "failed", "waiting"];

export function verdictOf(result: Pick<ProbeRun, "outcome" | "expected">): Verdict {
  return result.outcome === "blocked" && result.expected === true ? "expected" : result.outcome;
}

/**
 * Driver 从系统页返回时投递的 system-task.return：只认本探针发起的「本插件权限页」任务。
 * succeeded / cancelled 都说明 Driver 确实打开了权限页、用户又回来了；failed 说明打开失败。
 */
export function systemTaskReturnResult(intent: unknown, now = Date.now()): ProbeResult | undefined {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return undefined;
  const v = intent as { type?: unknown; taskId?: unknown; target?: unknown; outcome?: unknown; payload?: unknown };
  if (v.type !== "system-task.return" || v.target !== "app-permissions" || typeof v.taskId !== "string") return undefined;
  const payload = v.payload as { probe?: unknown; at?: unknown } | undefined;
  if (!payload || payload.probe !== NAVIGATE_RETURN_TAG || typeof payload.at !== "string") return undefined;
  const started = Date.parse(payload.at);
  if (Number.isNaN(started) || started > now + 60_000) return undefined;
  const base = { probeId: "system-task-open", startedAt: payload.at, durationMs: Math.max(0, now - started), detail: `任务号 ${v.taskId.slice(0, 80)}` };
  if (v.outcome === "succeeded" || v.outcome === "cancelled") {
    return { ...base, outcome: "ok", summary: "Driver 打开了本插件的权限页，你点「返回」后它带回了回执" };
  }
  if (v.outcome === "failed") return { ...base, outcome: "failed", summary: "Driver 回执说权限页没打开成功" };
  return undefined;
}

export function probeById(id: string): ProbeDefinition | undefined {
  return PROBES.find((probe) => probe.id === id);
}

/** 「全部测试」只跑不会离开页面、不会弹通知、不会启动别的插件的 P0 探针。 */
export function safeProbes(): ProbeDefinition[] {
  return PROBES.filter((probe) => probe.run && !probe.disabledReason && probe.risk === "safe");
}

export async function runProbe(probe: ProbeDefinition, context: ProbeContext): Promise<ProbeResult> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let run: ProbeRun;
  if (!probe.run || probe.disabledReason) {
    run = { outcome: "waiting", summary: probe.disabledReason ?? "这个探针没有可执行的步骤" };
  } else {
    try {
      run = await probe.run(context);
    } catch (error) {
      run = failure(error);
    }
  }
  return { probeId: probe.id, startedAt, durationMs: Date.now() - started, ...run };
}
