/**
 * Computer Use 演示循环：截图 → 云端视觉模型决策 → 引擎执行 → 循环。
 *
 * 这是第一版本的「大脑」：任务用自然语言描述，模型看屏幕输出结构化动作，
 * 引擎窄口执行。动作空间按 Anthropic computer use 的惯例设计——坐标一律
 * 0–1000 归一化（相对截图），由这里换算成屏幕像素（`origin + norm × size`），
 * 模型与平台分辨率解耦。
 *
 * 视觉决策走 Host 云通道 `ai.text.generate`（cloud.model.invoke@1）：凭据归
 * 登录账号，插件不接触任何 API key；模型按档位解析，请求带图时 Host 自动
 * 限定到支持视觉输入的候选。
 *
 * 安全边界都在引擎侧（紧急停止、速率上限、护栏），这里只做：步数上限、
 * 每步前检查中断、失败即停；中断不解除引擎停止位。
 */
import { computerCall, aiCall, type Screenshot } from "./computer-bridge";
import type { UiMessage } from "./computer-i18n";

/** 模型档位（ai.models.list 的 id），不是真实模型名。 */
export interface VlmConfig {
  modelAlias: string;
}

/** 视觉定位任务默认走高质量档。 */
export const DEFAULT_VLM_CONFIG: VlmConfig = {
  modelAlias: "text-quality",
};

/** 单步动作上限。微信发消息级别的小任务 20 步足够；失控循环靠它兜底。 */
export const MAX_STEPS = 20;

/**
 * 宿主 ai.text.generate 单次请求的消息条数上限（宿主 cloud MAX_MESSAGES）。
 * 历史最多保留到「上限 - 1」，给本轮带截图的 user 消息留位置。
 */
export const MAX_REQUEST_MESSAGES = 32;

/** 宿主 computer.mouse.scroll 按 i32 读取 dx/dy，越界会被当成 0。 */
const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

/** 每步执行后等 UI 响应的间隔。 */
const STEP_COOLDOWN_MS = 800;

export type AgentAction =
  | { action: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { action: "type"; text: string }
  | { action: "press"; key: string }
  | { action: "scroll"; dx?: number; dy?: number }
  | { action: "done"; detail?: string }
  | { action: "fail"; detail?: string };

export interface StepReport {
  step: number;
  thought?: string;
  action: AgentAction;
  ok: boolean;
  /** 失败原因：key 由界面按当前语言渲染，raw 为宿主或模型原文。 */
  error?: UiMessage;
}

export interface TaskCallbacks {
  onStep?: (report: StepReport) => void;
  /**
   * shouldAbort 在每步开始、截图返回、模型回复返回、动作失败及循环结束时轮询；
   * true 则停止循环并报告 aborted。
   * 中止**只停本插件的循环，绝不调用 computer.resume**：引擎停止位是用户主权，
   * 只能由用户在插件页点「恢复操控」解除，否则「先紧急停止、再中止任务」会
   * 悄悄撤销紧急停止。
   */
  shouldAbort?: () => boolean;
}

/** 循环依赖的宿主调用；默认走真实 bridge，测试可替换。 */
export interface TaskDeps {
  computer: typeof computerCall;
  ai: typeof aiCall;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: TaskDeps = {
  computer: computerCall,
  ai: aiCall,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const SYSTEM_PROMPT = `你是一个操作 macOS/Windows 电脑的 GUI Agent。你会收到一张屏幕截图（全屏或某个窗口）与一个任务目标，每轮回复**只输出一个 JSON 对象**，不要输出任何其他文字或代码块标记。

可用动作（坐标一律是 0–1000 的归一化值，相对截图左上角；x 向右、y 向下）：
- {"action":"click","x":123,"y":456} —— 单击坐标处（可加 "button":"right" 右键、"double":true 双击）
- {"action":"type","text":"要输入的文字"} —— 向当前焦点输入文字（先点击输入框再输入）
- {"action":"press","key":"enter"} —— 按键或组合键（enter / tab / escape / cmd+c / ctrl+a 等）
- {"action":"scroll","dy":300} —— 滚动（dy 正=向下，dx 正=向右，单位像素）
- {"action":"done","detail":"完成说明"} —— 任务已完成
- {"action":"fail","detail":"原因"} —— 无法完成（说明卡在哪一步）

规则：
1. 一次只做一个动作；下一轮会给你新的截图。
2. 点击要落在目标元素的可点击中心，不要贴边缘。
3. 输入框需要先点击获得焦点，再 type。
4. 判断任务确实完成才输出 done。
5. 除 JSON 外不要输出任何内容。`;

/** 从模型回复里提取第一个 JSON 对象（容错 ```json 包裹与前后闲话）。 */
export function parseActionReply(reply: string): { thought?: string; action: AgentAction } | null {
  const text = reply.replace(/```json/gi, "```").trim();
  const fenced = /```([\s\S]*?)```/.exec(text);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const action = toAgentAction(parsed);
      if (action) {
        const thought =
          typeof parsed.thought === "string" ? (parsed.thought as string) : undefined;
        return { thought, action };
      }
    } catch {
      // 试下一个候选。
    }
  }
  return null;
}

/**
 * 模型回复不可信：逐字段校验后重建动作，只保留已知字段，任何字段不合法即拒绝。
 * 坐标只接受有限数字或数字字符串；null / false / "" 经 Number() 会变成 0，
 * 不能被当成「点左上角」放行。
 */
function toAgentAction(raw: Record<string, unknown>): AgentAction | null {
  const detail = typeof raw.detail === "string" ? raw.detail : undefined;
  switch (raw.action) {
    case "click": {
      const x = toCoordinate(raw.x);
      const y = toCoordinate(raw.y);
      if (x === null || y === null) return null;
      if (raw.button !== undefined && raw.button !== "left" && raw.button !== "right") return null;
      if (raw.double !== undefined && typeof raw.double !== "boolean") return null;
      const action: AgentAction = { action: "click", x, y };
      if (raw.button !== undefined) action.button = raw.button;
      if (raw.double !== undefined) action.double = raw.double;
      return action;
    }
    case "type":
      return typeof raw.text === "string" && raw.text !== ""
        ? { action: "type", text: raw.text }
        : null;
    case "press":
      return typeof raw.key === "string" && raw.key.trim() !== ""
        ? { action: "press", key: raw.key.trim() }
        : null;
    case "scroll": {
      // 宿主按整数（i32）读取：这里统一取整并校验范围，执行、展示与回填历史都用归一化后的值。
      const dx = raw.dx === undefined ? 0 : toScrollDelta(raw.dx);
      const dy = raw.dy === undefined ? 0 : toScrollDelta(raw.dy);
      if (dx === null || dy === null || (dx === 0 && dy === 0)) return null;
      return { action: "scroll", dx, dy };
    }
    case "done":
    case "fail":
      return detail === undefined ? { action: raw.action } : { action: raw.action, detail };
    default:
      return null;
  }
}

function toScrollDelta(value: unknown): number | null {
  const parsed = toCoordinate(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  if (rounded < I32_MIN || rounded > I32_MAX) return null;
  return rounded === 0 ? 0 : rounded; // 归一化 -0
}

function toCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * 归一化坐标（0–1000）→ 屏幕坐标。
 *
 * ⚠️ 必须用 `sourceWidth`/`sourceHeight`（截图覆盖的屏幕区域），不能用
 * `width`/`height`（被 maxEdge 缩过的图像尺寸）。用后者等于把整块屏幕压成
 * maxEdge 见方：3840 宽的屏幕缩到 1024 后，模型说「正中」会落在左上角约
 * 1/4 处，右侧七成永远点不到。
 */
export function denormalize(
  shot: Pick<Screenshot, "originX" | "originY" | "sourceWidth" | "sourceHeight">,
  nx: number,
  ny: number,
): { x: number; y: number } {
  const clamp = (value: number) => Math.max(0, Math.min(1000, value)) / 1000;
  return {
    x: shot.originX + Math.round(clamp(nx) * shot.sourceWidth),
    y: shot.originY + Math.round(clamp(ny) * shot.sourceHeight),
  };
}

/**
 * 把任何抛出物归一成人能读的错误文案。
 *
 * 关键场景：宿主 bridge 的失败经 SDK `normalizeBridgeError` 归一为**普通对象**
 * `{code, userMessage, retryable}`（不是 Error），`String()` 会得到
 * "[object Object]"——不提取字段的话，权限拒绝这类真实原因会被完全吞掉。
 */
export function describeError(thrown: unknown): string {
  if (typeof thrown === "string") return thrown;
  if (thrown instanceof Error) return thrown.message || thrown.name;
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as Record<string, unknown>;
    for (const key of ["userMessage", "message", "detail"]) {
      if (typeof candidate[key] === "string" && candidate[key]) {
        const text = String(candidate[key]);
        const code = typeof candidate.code === "string" ? candidate.code : "";
        // 宿主错误串本身形如 "COMPUTER_X: 原因"，已带 code 时不再重复拼接。
        return code && !text.startsWith(code) ? `${text}（${code}）` : text;
      }
    }
    try {
      return JSON.stringify(thrown);
    } catch {
      return String(thrown);
    }
  }
  return String(thrown);
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
}

let invocationSeq = 0;

/** Host 云通道一次视觉决策调用（`ai.text.generate`，返回 `{invocationId, text}`）。 */
async function askVlm(
  ai: TaskDeps["ai"],
  config: VlmConfig,
  messages: ChatMessage[],
): Promise<string> {
  invocationSeq += 1;
  const invocationId = `cu-${Date.now().toString(36)}-${invocationSeq}`;
  const payload = await ai<{ text?: unknown }>("ai.text.generate", {
    invocationId,
    model: config.modelAlias,
    messages,
    stream: false,
    temperature: 0,
    maxOutputTokens: 1024,
  });
  if (typeof payload.text === "string" && payload.text) return payload.text;
  throw new EmptyReplyError();
}

class EmptyReplyError extends Error {
  constructor() {
    super("empty model reply");
    this.name = "EmptyReplyError";
  }
}

const ABORTED: UiMessage = { key: "result.aborted" };

export interface TaskResult {
  status: "done" | "fail" | "aborted" | "error";
  /** 结果说明：key 由界面按当前语言渲染；raw 为模型给出的 detail 或宿主原始错误。 */
  message: UiMessage;
  steps: number;
}

/** 宿主错误码（对象的 code 字段，或宿主错误串的 "COMPUTER_X:" 前缀）。 */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

export function errorCode(thrown: unknown): string | undefined {
  if (typeof thrown === "object" && thrown !== null && Object.hasOwn(thrown, "code")) {
    const code = (thrown as { code?: unknown }).code;
    if (typeof code === "string" && ERROR_CODE.test(code)) return code;
  }
  return /^([A-Z][A-Z0-9_]{2,63}):/.exec(describeError(thrown))?.[1];
}

/** 已知宿主错误码 → 本地化原因（Map 查表，不会命中原型链上的属性）。 */
const COMPUTER_CAUSES = new Map<string, string>([
  ["COMPUTER_PERMISSION_MISSING", "cause.permissionMissing"],
  ["COMPUTER_STOPPED", "cause.stopped"],
  ["COMPUTER_RATE_LIMITED", "cause.rateLimited"],
  ["COMPUTER_TARGET_REJECTED", "cause.targetRejected"],
  ["COMPUTER_PLUGIN_DISABLED", "cause.engineRejected"],
]);

/**
 * 失败原因：按宿主已知错误码给出本地化原因与恢复方法，原始错误放 raw（仅开发者模式展示）。
 * source 区分电脑引擎与云模型，未知错误码时给出对应的通用恢复方法。
 */
export function causeMessage(thrown: unknown, source: "computer" | "model"): UiMessage {
  const code = errorCode(thrown);
  const key = (code && COMPUTER_CAUSES.get(code)) || (source === "model" ? "cause.model" : "cause.unknown");
  return { key, raw: describeError(thrown) };
}

/** 宿主或模型调用失败时的结果消息。 */
function errorMessage(error: unknown, source: "computer" | "model"): UiMessage {
  if (error instanceof EmptyReplyError) return { key: "result.emptyReply" };
  return causeMessage(error, source);
}

/** 执行一个自然语言任务，返回终态。 */
export async function runComputerTask(
  config: VlmConfig,
  task: string,
  callbacks: TaskCallbacks = {},
  deps: TaskDeps = DEFAULT_DEPS,
): Promise<TaskResult> {
  const history: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `任务：${task}\n\n请观察这张屏幕截图，输出你的第一个动作 JSON。` },
      ],
    },
  ];

  // 每个异步等待之后都先看中止：用户中止（含紧急停止）的优先级高于随之而来的
  // 失败，界面应显示「已中止」而不是「出错」，也不再多发一次模型请求或动作。
  const aborted = () => callbacks.shouldAbort?.() ?? false;

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (aborted()) {
      return { status: "aborted", message: ABORTED, steps: step - 1 };
    }

    let shot: Screenshot;
    try {
      shot = await deps.computer<Screenshot>("computer.screenshot", { maxEdge: 1024 });
    } catch (error) {
      if (aborted()) return { status: "aborted", message: ABORTED, steps: step - 1 };
      return { status: "error", message: errorMessage(error, "computer"), steps: step - 1 };
    }
    if (aborted()) {
      return { status: "aborted", message: ABORTED, steps: step - 1 };
    }

    // Host 云通道的图片 part 合同：{type:"image", mime, dataBase64}
    //（Host 侧负责校验体积/魔数并转换成上游格式）。
    const userContent = [
      { type: "text", text: `任务：${task}` },
      { type: "image", mime: shot.mime, dataBase64: shot.dataBase64 },
    ];
    const askMessages: ChatMessage[] = [...history, { role: "user", content: userContent }];

    let reply: string;
    try {
      reply = await askVlm(deps.ai, config, askMessages);
    } catch (error) {
      if (aborted()) return { status: "aborted", message: ABORTED, steps: step - 1 };
      return { status: "error", message: errorMessage(error, "model"), steps: step - 1 };
    }
    // 模型思考期间用户可能已中止：不再解析、不再执行这一步。
    if (aborted()) {
      return { status: "aborted", message: ABORTED, steps: step - 1 };
    }

    const parsed = parseActionReply(reply);
    if (!parsed) {
      const invalid: UiMessage = { key: "result.invalidReply", raw: reply.slice(0, 200) };
      callbacks.onStep?.({ step, action: { action: "fail" }, ok: false, error: invalid });
      return { status: "error", message: invalid, steps: step };
    }
    const { action } = parsed;

    if (action.action === "done" || action.action === "fail") {
      callbacks.onStep?.({ step, thought: parsed.thought, action, ok: true });
      const detail = action.detail ?? parsed.thought;
      return {
        status: action.action === "done" ? "done" : "fail",
        message: {
          key: action.action === "done" ? "result.done" : "result.fail",
          params: { steps: step },
          ...(detail ? { raw: detail } : {}),
        },
        steps: step,
      };
    }

    let ok = true;
    let error: UiMessage | undefined;
    try {
      await executeAction(deps.computer, shot, action);
    } catch (cause) {
      ok = false;
      error = causeMessage(cause, "computer");
    }
    callbacks.onStep?.({ step, thought: parsed.thought, action, ok, error });
    if (!ok) {
      // 紧急停止会让引擎拒绝这一步：此时如实报告为中止。
      if (aborted()) return { status: "aborted", message: ABORTED, steps: step };
      return { status: "error", message: error!, steps: step };
    }

    // 把动作回填进历史（不带图片，控制上下文体积），下一轮附新截图。
    history.push({ role: "assistant", content: JSON.stringify(action) });
    history.push({
      role: "user",
      content: [{ type: "text", text: "已执行。这是新的截图，请输出下一个动作 JSON。" }],
    });
    // 历史最多「上限 - 1」条，给下一轮带截图的 user 消息留位置；始终保留 system 与首条
    // 任务说明，按「动作 + 回执」成对裁掉最早的历史，不留孤立的 assistant。
    while (history.length > MAX_REQUEST_MESSAGES - 1) {
      history.splice(2, 2);
    }

    if (step < MAX_STEPS) await deps.sleep(STEP_COOLDOWN_MS);
  }
  if (aborted()) return { status: "aborted", message: ABORTED, steps: MAX_STEPS };
  return { status: "fail", message: { key: "result.stepLimit", params: { max: MAX_STEPS } }, steps: MAX_STEPS };
}

async function executeAction(
  computer: TaskDeps["computer"],
  shot: Screenshot,
  action: AgentAction,
): Promise<void> {
  switch (action.action) {
    case "click": {
      const { x, y } = denormalize(shot, action.x, action.y);
      await computer("computer.mouse.click", {
        x,
        y,
        button: action.button ?? "left",
        double: action.double ?? false,
      });
      return;
    }
    case "type":
      await computer("computer.text.type", { text: action.text });
      return;
    case "press":
      await computer("computer.key.press", { key: action.key });
      return;
    case "scroll":
      await computer("computer.mouse.scroll", {
        dx: action.dx ?? 0,
        dy: action.dy ?? 0,
      });
      return;
    default:
      throw new Error(`unknown action: ${(action as { action: string }).action}`);
  }
}
