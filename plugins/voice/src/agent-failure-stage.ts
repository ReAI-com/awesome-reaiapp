import { registeredErrorCode } from "./voice-error-codes";

/**
 * Agent 回合失败的 Host 阶段（Host #956）：envelope 的 `code` 仍是 `AGENT_ENGINE`，阶段只写在
 * `stderr_tail` / `message` 的**开头**，形如 `DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: …`
 * （`message` 前面还有一个「引擎错误：」）。这里只读这段前缀，得到三个结构化字段；前缀之后的原文一个字都不碰
 * ——不清洗、不截取、不导出，照旧只作为内存原文给 Voice 页用户主动展开时看（§6.0 白名单做法）。
 */

/**
 * 阶段码登记表：Host 源码（DSH 引擎服务 `agents/dsh/service.rs`）的 `ENGINE_*` 阶段常量（#956 起）。
 * Pi / Codex 的引擎失败没有同类前缀。Host 新增阶段时在此补登（仓库合同 `voice-agent-failure-codes` 对照 Host 源码，
 * 两边不一致就变红）；没登记的阶段不认，按「没有阶段」处理。
 */
export const AGENT_STAGE_CODES = [
  "DSH_ENGINE_SPAWN_FAILED",
  "DSH_ENGINE_SETUP_FAILED",
  "DSH_ENGINE_EXITED",
  "DSH_ENGINE_EMPTY_REPLY",
  "DSH_ENGINE_WAIT_FAILED",
] as const;
export type AgentStageCode = (typeof AGENT_STAGE_CODES)[number];
const STAGES: ReadonlySet<string> = new Set(AGENT_STAGE_CODES);

export interface AgentFailureStage {
  readonly agentStage: AgentStageCode;
  /** 引擎进程的退出码（Host 取 `ExitStatus::code()`，即 i32）；被信号终止等没有退出码时缺席。 */
  readonly exitCode?: number;
  /** 方括号里 Host 补带的码中第一个登记过的（`voice-error-codes` 登记表）；都没登记就缺席。 */
  readonly upstreamCode?: string;
}

/**
 * 界面状态 / 落盘条目里的同名字段（普通对象，不带出身）：只用于渲染诊断，渲染与落盘时逐值按登记表 / 范围
 * 再过一遍（`agentFailureFields`）；主句映射不收它，只收本模块解析出的对象。
 */
export interface AgentFailureFields {
  agentStage?: string;
  exitCode?: number;
  upstreamCode?: string;
}

/** 普通对象逐值接收：阶段码不在登记表就整组不收；退出码越界、上游码没登记就只丢那一项。 */
export function agentFailureFields(value: unknown): { agentStage: AgentStageCode; exitCode?: number; upstreamCode?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const source = value as { agentStage?: unknown; exitCode?: unknown; upstreamCode?: unknown };
  const agentStage = agentStageCode(source.agentStage);
  if (!agentStage) return undefined;
  const exitCode = agentExitCode(source.exitCode);
  const upstreamCode = registeredErrorCode(source.upstreamCode);
  return { agentStage, ...(exitCode !== undefined ? { exitCode } : {}), ...(upstreamCode ? { upstreamCode } : {}) };
}

/** 按**出身**登记：只有本模块解析出的对象在表里，外部同形对象（形状可以伪造）不算。 */
const PARSED = new WeakSet<object>();
function sealed(stage: AgentFailureStage): AgentFailureStage {
  const frozen = Object.freeze(stage);
  PARSED.add(frozen);
  return frozen;
}

export function isAgentFailureStage(value: unknown): value is AgentFailureStage {
  return typeof value === "object" && value !== null && PARSED.has(value);
}

/** 阶段码按值查登记表。 */
export function agentStageCode(value: unknown): AgentStageCode | undefined {
  return typeof value === "string" && STAGES.has(value) ? value as AgentStageCode : undefined;
}

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
/** 退出码只收 i32 范围内的整数（与 Host 的类型一致），其余一律丢弃。 */
export function agentExitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX ? value : undefined;
}

const MESSAGE_LEAD = "引擎错误：";
const STAGE_TOKEN = /^[A-Z][A-Z0-9_]{0,63}/;
/** Host `exit_label`：`退出码 N`，N 是规范十进制（无前导零、无正号）。 */
const EXIT_REASON = /^退出码 (0|-?[1-9]\d{0,9})$/;
/** Host 阶段原因上界 120 字、补码区上界 300 字；这里留余量，超出就不当前缀读。 */
const MAX_REASON_CHARS = 200;
const MAX_CODES_CHARS = 400;

/**
 * 只读前缀：`[引擎错误：]阶段码[（原因）][［码 码…］]：`。阶段码必须在登记表里且紧跟 `（` / `［` / `：`；
 * 退出码只从紧跟阶段码的 `（退出码 N）` 取；上游码只从紧跟其后、以 `］：` 收尾的方括号取。
 * 退出码或上游码不合文法就只丢那一项；原因段本身找不到收尾（或超长）时，后面的方括号也定位不了，
 * 只保留阶段码。不猜、不改写原文。
 */
export function parseAgentFailureStage(text: unknown): AgentFailureStage | undefined {
  if (typeof text !== "string") return undefined;
  let rest = text.startsWith(MESSAGE_LEAD) ? text.slice(MESSAGE_LEAD.length) : text;
  const agentStage = agentStageCode(STAGE_TOKEN.exec(rest)?.[0]);
  if (!agentStage) return undefined;
  rest = rest.slice(agentStage.length);
  if (!/^[（［：]/.test(rest)) return undefined;
  let exitCode: number | undefined;
  if (rest.startsWith("（")) {
    const close = rest.indexOf("）");
    if (close < 0 || close > MAX_REASON_CHARS) return sealed({ agentStage });
    const reason = EXIT_REASON.exec(rest.slice(1, close));
    exitCode = agentExitCode(reason ? Number(reason[1]) : undefined);
    rest = rest.slice(close + 1);
  }
  let upstreamCode: string | undefined;
  if (rest.startsWith("［")) {
    const close = rest.indexOf("］");
    if (close > 0 && close <= MAX_CODES_CHARS && rest[close + 1] === "：") {
      upstreamCode = rest.slice(1, close).split(" ").map(registeredErrorCode).find((code) => code !== undefined);
    }
  }
  return sealed({ agentStage, ...(exitCode !== undefined ? { exitCode } : {}), ...(upstreamCode ? { upstreamCode } : {}) });
}

const MAX_DEPTH = 4;
/**
 * 失败链上 Agent 引擎失败（`kind: "engine"`）的阶段：先读 `stderr_tail`，读不出再读 `message`。
 * 只从这两个原文字段的前缀解析；对象上自带的 `agentStage` / `exitCode` 之类同名字段一律不认。
 */
export function agentFailureStageOf(cause: unknown): AgentFailureStage | undefined {
  let current = cause;
  for (let depth = 0; depth <= MAX_DEPTH && typeof current === "object" && current !== null; depth += 1) {
    const source = current as { kind?: unknown; stderr_tail?: unknown; message?: unknown; cause?: unknown };
    if (source.kind === "engine") {
      const parsed = parseAgentFailureStage(source.stderr_tail) ?? parseAgentFailureStage(source.message);
      if (parsed) return parsed;
    }
    current = source.cause;
  }
  return undefined;
}

