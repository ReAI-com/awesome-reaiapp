/**
 * 探针清单：每个探针 = 一个按钮 = 对一项能力的一次真实调用。
 *
 * 档位：P0 本地开发包就能跑；P1 需要连上外脑（插件自己的 OAuth 应用）；P2 需要平台批准。
 * 本版只构建 P0，P1 / P2 只列出「会调什么、预期什么」，按钮保持关闭。
 */
import { checkBlobScript, checkEval, checkIframe, checkInlineScript, type CspCheckResult } from "./csp-check";
import { describeError, gateHint, isGateCode, scrub } from "./errors";
import type { ProbePort } from "./port";

export type Level = "P0" | "P1" | "P2";
export type ProbeSection = "basic" | "permission" | "page" | "cloud" | "gated";
/** safe：只读或只写本插件自己的测试数据；navigate：会切到 Driver 别的页面；notify：会弹系统通知。 */
export type Risk = "safe" | "navigate" | "notify";
/**
 * ok：按预期成功；blocked：被拦下（反例就是要它被拦，或者用户还没同意）；
 * unexpected：结果和预期不一样；failed：出错；waiting：需要你先做一步操作。
 */
export type Outcome = "ok" | "blocked" | "unexpected" | "failed" | "waiting";

export interface ProbeRun {
  outcome: Outcome;
  summary: string;
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
const ROUNDTRIP_KEY = "probe.roundtrip";
const OVERSIZE_KEY = "probe.oversize";
const KV_VALUE_LIMIT = 256 * 1024;

function failure(error: unknown, expectBlocked = false): ProbeRun {
  const { code, message } = describeError(error);
  if (expectBlocked) return { outcome: "blocked", summary: "按预期被拦下", code, detail: scrub(message) };
  if (isGateCode(code)) return { outcome: "blocked", summary: gateHint(code), code, detail: scrub(message) };
  return { outcome: "failed", summary: "调用出错", code, detail: scrub(message) };
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
      if (!result.executed) return { outcome: "blocked", summary: "被拦下，代码没有运行", detail };
      if (port.mode === "preview") {
        return { outcome: "unexpected", summary: "没被拦：现在是浏览器预览，没有 Driver 的页面限制", detail };
      }
      return { outcome: "unexpected", summary: "没被拦：代码运行了，和平台规则不一致，请把报告发给平台", detail };
    },
  };
}

const P1_REASON = "需要先连上外脑：在开放平台给插件建 OAuth 应用、把应用编号写进插件后重新打包（见 README「连接外脑」）";
const P2_REASON = "需要平台批准：本地开发包只要声明这项能力就会装不上（APP_CAPABILITY_NOT_GRANTED）";

function cloudProbe(id: string, title: string, what: string, capability: string, expect: string): ProbeDefinition {
  return { id, section: "cloud", level: "P1", title, what, expect, capability, risk: "safe", disabledReason: P1_REASON };
}

function gatedProbe(id: string, title: string, what: string, capability: string, expect: string): ProbeDefinition {
  return { id, section: "gated", level: "P2", title, what, expect, capability, risk: "safe", disabledReason: P2_REASON };
}

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
      const env = await port.environment();
      const locale = port.locale() === "en" ? "英文" : "中文";
      return { outcome: "ok", summary: `开发者模式：${env.developerMode ? "开" : "关"}；界面语言：${locale}` };
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
          if (!/BUSY|RATE|FREQUENT/.test(describeError(error).code)) throw error;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 2100);
            signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
          });
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
      try {
        const value = { nonce: Math.random().toString(36).slice(2), at: new Date().toISOString() };
        await port.kv.set(ROUNDTRIP_KEY, value);
        const back = (await port.kv.get(ROUNDTRIP_KEY)) as typeof value | undefined;
        if (!back || back.nonce !== value.nonce) return { outcome: "unexpected", summary: "读回的数据和写入的不一致" };
        const swapped = await port.kv.compareAndSet(ROUNDTRIP_KEY, back, { ...value, swapped: true });
        const keys = await port.kv.keys();
        await port.kv.delete(ROUNDTRIP_KEY);
        const gone = (await port.kv.get(ROUNDTRIP_KEY)) === undefined;
        if (!swapped || !keys.includes(ROUNDTRIP_KEY) || !gone) {
          return { outcome: "unexpected", summary: `部分步骤和预期不同：比较后再写 ${swapped ? "成功" : "失败"}，键列表${keys.includes(ROUNDTRIP_KEY) ? "包含" : "不含"}测试键，删除${gone ? "成功" : "后仍能读到"}` };
        }
        return { outcome: "ok", summary: "写入、读回、比较后再写、列键、删除都正常" };
      } catch (error) {
        return failure(error);
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
        return failure(error, true);
      }
      await port.kv.delete(OVERSIZE_KEY).catch(() => undefined);
      return { outcome: "unexpected", summary: "300 KB 的数据被接受了，和公开的 256 KB 上限不一致（已删除）" };
    },
  },
  {
    id: "kv-undeclared",
    section: "basic",
    level: "P0",
    title: "没声明的存储空间（反例）",
    what: "往清单里没声明的存储空间写一条数据",
    expect: "被拒绝（文档说未声明的 storeId 会被拒）",
    capability: "storage.kv@1",
    risk: "safe",
    async run({ port }) {
      const store = port.kvStore("undeclared-probe");
      try {
        await store.set("probe", 1);
      } catch (error) {
        return failure(error, true);
      }
      await store.delete("probe").catch(() => undefined);
      return { outcome: "unexpected", summary: "没被拒：Driver 目前不检查存储空间是否声明过（已删除测试数据）" };
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
          return { outcome: "waiting", summary: "还没被触发过：到 Driver「设备 → 键位」把一个键绑到「能力探针：测试按键」，按一下，再回来点这里" };
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
    what: "问一下 Voice 的文字服务「这个请求现在什么状态」，用的是一个不存在的请求号，不会开始录音",
    expect: "装了 Voice：返回「找不到这个请求」；没装：给出原因",
    capability: "apps.service@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const result = (await port.callService(VOICE_SERVICE_ID, "status", { requestId: `probe-${Math.random().toString(36).slice(2)}` }, signal)) as { phase?: unknown } | null;
        const phase = typeof result?.phase === "string" ? result.phase : "未知";
        return { outcome: "ok", summary: `Voice 服务可以调用（返回状态：${phase}）` };
      } catch (error) {
        const { code, message } = describeError(error);
        if (isGateCode(code) || /NOT_INSTALLED|UNAVAILABLE|NOT_FOUND|DISABLED|CONSENT/.test(code)) {
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
    expect: "Driver 切到权限设置页",
    capability: "system.tasks@1",
    risk: "navigate",
    async run({ port }) {
      try {
        const result = await port.openSystemTask("app-permissions");
        return { outcome: "ok", summary: "Driver 已接受，正在打开本插件的权限页", detail: `任务号 ${result.taskId}` };
      } catch (error) {
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
    async run({ port }) {
      try {
        await port.notify("能力探针", "这是一条测试通知，可以忽略。");
        return { outcome: "ok", summary: "已交给 Driver 发送，请看电脑右上角" };
      } catch (error) {
        return failure(error);
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
    expect: "被 Driver 拦下",
    capability: "http.fetch@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const response = await port.fetch("https://example.com/", { method: "GET", signal });
        return { outcome: "unexpected", summary: `没被拦：返回了 HTTP ${response.status}` };
      } catch (error) {
        return failure(error, true);
      }
    },
  },
  {
    id: "http-insecure",
    section: "permission",
    level: "P0",
    title: "访问不加密的 http 地址（反例）",
    what: "用 http:// 而不是 https:// 请求外脑健康检查",
    expect: "被 Driver 拦下（只允许 https）",
    capability: "http.fetch@1",
    risk: "safe",
    async run({ port, signal }) {
      try {
        const response = await port.fetch(HEALTH_URL.replace("https://", "http://"), { method: "GET", signal });
        return { outcome: "unexpected", summary: `没被拦：返回了 HTTP ${response.status}` };
      } catch (error) {
        return failure(error, true);
      }
    },
  },
  cspProbe("csp-inline", "页面里插入一段脚本", "往页面里插一个带代码的 <script> 标签", checkInlineScript),
  cspProbe("csp-eval", "把字符串当代码执行", "用 new Function 执行一段字符串代码", checkEval),
  cspProbe("csp-blob", "运行时生成脚本文件", "把代码打成一个临时文件再加载", checkBlobScript),
  cspProbe("csp-iframe", "页面里嵌一个网页", "用 iframe 嵌入一个运行时生成的网页", checkIframe),

  cloudProbe("cloud-userinfo", "读当前用户", "GET /oauth/userinfo", "profile:read", "返回用户编号和昵称，不返回邮箱"),
  cloudProbe("cloud-projects", "列出项目", "GET /projects", "projects:read", "返回能读的项目"),
  cloudProbe("cloud-files-list", "列出云端文件", "GET /storage/:项目/files", "project:files:read", "返回文件列表"),
  cloudProbe("cloud-files-upload", "上传文件到云端", "选一个文件，POST /storage/:项目/upload", "project:files:write", "上传成功；同内容再传一次，内容指纹相同"),
  cloudProbe("cloud-files-delete", "删除云端文件（反例）", "DELETE /storage/:项目/files/:文件", "project:files:write", "被拒（403），外脑没对插件开放删除"),
  cloudProbe("cloud-vfs", "云端目录接口（反例）", "GET /vfs/:项目/driver-v105/resources/root:<项目>", "project:files:read", "被拒或 503：统一文件接口的云端部分还没上线"),
  cloudProbe("cloud-kb", "知识库写入与搜索", "POST /projects/:项目/kb/nodes，再 POST …/kb/search", "project:kb:read + project:kb:write", "写入成功，搜得到"),
  cloudProbe("cloud-data", "数据表的行增删改", "GET …/collections，POST / PATCH / DELETE …/data", "project:data:read + project:data:write", "增、改、删、恢复都成功"),
  cloudProbe("cloud-collections", "新建数据表（反例）", "POST /projects/:项目/collections", "project:data:write", "被拒（401），外脑没对插件开放改表结构"),
  cloudProbe("cloud-workflow", "工作流新建、编辑、运行", "POST /documents → POST /documents/:id/edit → POST /runs → GET /runs/:id", "documents:write + flows:execute + runs:read", "跑通一个最小工作流"),
  cloudProbe("cloud-model", "调用大模型", "GET /api/model-gateway/v1/models，确认后 POST …/chat/completions", "model-gateway:invoke", "返回模型列表和一次回复（会消耗额度）"),
  cloudProbe("cloud-graph", "图谱（反例）", "GET /projects/:项目/graph/config", "—", "被拒（401），图谱只对网页登录开放"),

  gatedProbe("gated-agent", "Agent 会话", "建一个 Agent 会话并跑一轮（Pi / DSH / Codex 各一次）", "agent.session@2 + cloud.model.invoke@1", "三个引擎各回复一次"),
  gatedProbe("gated-model", "经 Driver 调用云端模型", "ctx.aiApi 列出模型", "cloud.model.invoke@1", "返回模型列表"),
  gatedProbe("gated-folder", "本地文件夹增删改查", "让用户选一个文件夹，列目录、读、新建、写、改名、删除", "resources.files@1", "每一步都成功；同时改同一文件会提示冲突"),
  gatedProbe("gated-cloud-folder", "云项目文件夹", "挂上一个外脑云项目当文件夹", "resources.files@1", "目前返回「云文件服务尚未开放」"),
  gatedProbe("gated-agent-folder", "Agent 在文件夹里干活", "把上面的文件夹交给 Agent，让它读一个文件、写一个新文件", "agent.session@2 + resources.files@1", "插件能读到 Agent 写的新文件；只读模式下 Agent 写入被拒"),
];

export function probeById(id: string): ProbeDefinition | undefined {
  return PROBES.find((probe) => probe.id === id);
}

/** 「全部测试」只跑不会离开页面、不会弹通知的 P0 探针。 */
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
