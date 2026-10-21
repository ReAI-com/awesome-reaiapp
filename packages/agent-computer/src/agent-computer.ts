/**
 * Agent 电脑的安全线：所有输入都经过这里。
 *
 * - 停止位：服务启动时默认「已停止」，只有用户 resume 才接受 Agent 输入；
 *   重连不清除停止位。
 * - 串行队列：一次只执行一个操作；复合操作（长文本、拖拽、双击）拆成底层事件，
 *   每个事件前检查停止位与代次，紧急停止可以打断正在执行的操作。
 * - 紧急停止：置停止位 → 代次加一（排队与进行中的操作全部作废）→ 通过内部
 *   通道抬起按住的鼠标键与按键。恢复不会继续旧操作。
 * - 速率：底层事件之间有最小间隔，并有每分钟事件上限，长文本无法绕过。
 * - 审计：每个操作一条记录，文字输入只记长度不记内容。
 */
import { encodePng, fitToMaxEdge } from "./image";
import { charKeysym, parseCombo, usKeyStroke } from "./keys";
import type { DisplayFactory, DisplayInput, Frame, GuestTextHelper } from "./types";

export type ErrorCode =
  | "STOPPED"
  | "INVALID_ARGUMENT"
  | "RATE_LIMITED"
  | "DISPLAY_UNAVAILABLE"
  | "UNSUPPORTED_ON_VM"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL";

export class ComputerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerError";
  }
}

export type Source = "agent" | "user";

export interface AuditEntry {
  id: string;
  action: string;
  summary: string;
  source: Source;
  ok: boolean;
  error?: string;
  atMs: number;
}

export interface AgentComputerOptions {
  connectDisplay: DisplayFactory;
  /** 键盘打不出的文字（中文、emoji）改走客体剪贴板粘贴。 */
  textHelper?: GuestTextHelper;
  /** 底层事件最小间隔（毫秒）。 */
  minEventIntervalMs?: number;
  /** 每分钟底层事件上限。 */
  maxEventsPerMinute?: number;
  /** 单次文字输入的最大字符数。 */
  maxTextLength?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const BUTTONS = { left: 1, middle: 2, right: 4 } as const;
type ButtonName = keyof typeof BUTTONS;
const WHEEL = { up: 8, down: 16, left: 32, right: 64 } as const;
/** 一格滚轮约等于多少像素（与现有 computer.mouse.scroll 的像素语义对齐）。 */
const PIXELS_PER_NOTCH = 40;
const MAX_NOTCHES = 50;
const AUDIT_LIMIT = 200;
const SHIFT = 0xffe1;
/** 客体辅助调用（如写剪贴板）的超时，避免挂起阻塞整个输入队列。 */
const HELPER_TIMEOUT_MS = 15_000;
/** 中止后等待辅助调用结束的宽限期。 */
const HELPER_ABORT_GRACE_MS = 5_000;
const HELPER_STUCK = "客体辅助调用无法取消";
/** 排队中的输入操作上限，防止请求积压拖垮服务（包括紧急停止接口的响应）。 */
const MAX_PENDING_OPS = 32;

export class AgentComputer {
  private stoppedFlag = true;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private display: DisplayInput | null = null;
  private connecting: Promise<DisplayInput> | null = null;
  /** 连接代次：断线或 close() 时加一，旧连接上排队的操作全部作废，迟到的连接被丢弃。 */
  private connectionEpoch = 0;
  /** 进行中的客体辅助调用；紧急停止时一并中止。 */
  private helperAbort: AbortController | null = null;
  /** 辅助调用曾经无法取消：停用剪贴板通道，避免旧调用迟到写入后被误粘贴。 */
  private helperBroken = false;
  private pendingOps = 0;
  /** 已发出的底层输入事件计数：截图只与「之间没有新输入」的请求共享。 */
  private inputSeq = 0;
  /** 进行中的截图；同一帧按 maxEdge 只编码一次。 */
  private capturing: { seq: number; frame: Promise<Frame>; encoded: Map<number, Promise<ScreenshotResult>> } | null = null;
  private heldButtons = 0;
  private heldKeys = new Set<number>();
  private cursor = { x: 0, y: 0 };
  private eventTimes: number[] = [];
  private lastEventAt = 0;
  private audit: AuditEntry[] = [];
  private auditSeq = 0;
  private readonly minInterval: number;
  private readonly maxPerMinute: number;
  private readonly maxText: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: AgentComputerOptions) {
    this.minInterval = options.minEventIntervalMs ?? 8;
    this.maxPerMinute = options.maxEventsPerMinute ?? 6000;
    this.maxText = options.maxTextLength ?? 2000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get stopped() {
    return this.stoppedFlag;
  }

  state() {
    const held: string[] = [];
    for (const [name, bit] of Object.entries(BUTTONS)) if (this.heldButtons & bit) held.push(name);
    return { stopped: this.stoppedFlag, heldButtons: held, trace: [...this.audit].reverse() };
  }

  async stop(source: Source) {
    this.stoppedFlag = true;
    this.generation += 1;
    this.helperAbort?.abort();
    await this.releaseHeld();
    this.record("stop", "紧急停止：拒绝后续输入并抬起按住的按键", source, true);
  }

  resume(source: Source) {
    this.stoppedFlag = false;
    this.record("resume", "恢复操控", source, true);
  }

  async displaySize() {
    const display = await this.ensureDisplay();
    return { width: display.width, height: display.height };
  }

  async screenshot(params: { maxEdge?: unknown }, source: Source) {
    const maxEdge = params.maxEdge === undefined ? undefined : positiveInt(params.maxEdge, "maxEdge");
    try {
      const capture = await this.currentCapture();
      const key = maxEdge ?? 0;
      let encoded = capture.encoded.get(key);
      if (!encoded) {
        encoded = capture.frame.then((frame) => encodeScreenshot(frame, maxEdge));
        capture.encoded.set(key, encoded);
      }
      const result = await encoded;
      this.record("screenshot", `截图 ${result.width}×${result.height}`, source, true);
      return result;
    } catch (error) {
      this.record("screenshot", "截图", source, false, error);
      throw toComputerError(error);
    }
  }

  /**
   * 共享进行中的抓取，前提是它开始之后没有新的输入事件；否则等它结束再抓新帧，
   * 避免把操作之前的画面当成操作之后的结果。
   */
  private async currentCapture() {
    for (;;) {
      const current = this.capturing;
      if (current && current.seq === this.inputSeq) return current;
      if (current) {
        await current.frame.catch(() => undefined);
        continue;
      }
      const entry = {
        seq: this.inputSeq,
        frame: (async () => (await this.ensureDisplay()).capture())(),
        encoded: new Map<number, Promise<ScreenshotResult>>(),
      };
      this.capturing = entry;
      entry.frame
        .catch(() => undefined)
        .finally(() => {
          if (this.capturing === entry) this.capturing = null;
        });
      return entry;
    }
  }

  move(params: { x?: unknown; y?: unknown }, source: Source) {
    return this.run("mouse.move", source, async (ctx) => {
      const { x, y } = ctx.point(params.x, params.y);
      ctx.summary(`移动到 (${x}, ${y})`);
      await ctx.pointer(x, y, this.heldButtons);
    });
  }

  click(params: { x?: unknown; y?: unknown; button?: unknown; double?: unknown }, source: Source) {
    return this.run("mouse.click", source, async (ctx) => {
      const { x, y } = ctx.point(params.x, params.y);
      const bit = BUTTONS[buttonName(params.button)];
      const double = optionalBool(params.double, "double");
      ctx.summary(`${double ? "双击" : "点击"} (${x}, ${y})${bit === BUTTONS.left ? "" : ` ${buttonName(params.button)}`}`);
      await ctx.pointer(x, y, 0);
      for (let i = 0; i < (double ? 2 : 1); i += 1) {
        await ctx.pointer(x, y, bit);
        await ctx.pointer(x, y, 0);
      }
    });
  }

  drag(params: { fromX?: unknown; fromY?: unknown; toX?: unknown; toY?: unknown; button?: unknown }, source: Source) {
    return this.run("mouse.drag", source, async (ctx) => {
      const from = ctx.point(params.fromX, params.fromY);
      const to = ctx.point(params.toX, params.toY);
      const bit = BUTTONS[buttonName(params.button)];
      ctx.summary(`拖拽 (${from.x}, ${from.y}) → (${to.x}, ${to.y})`);
      await ctx.pointer(from.x, from.y, 0);
      await ctx.pointer(from.x, from.y, bit);
      const steps = 10;
      for (let i = 1; i <= steps; i += 1) {
        await ctx.pointer(
          Math.round(from.x + ((to.x - from.x) * i) / steps),
          Math.round(from.y + ((to.y - from.y) * i) / steps),
          bit,
        );
      }
      await ctx.pointer(to.x, to.y, 0);
    });
  }

  scroll(params: { dx?: unknown; dy?: unknown; x?: unknown; y?: unknown }, source: Source) {
    return this.run("mouse.scroll", source, async (ctx) => {
      const dx = optionalNumber(params.dx, "dx") ?? 0;
      const dy = optionalNumber(params.dy, "dy") ?? 0;
      if (dx === 0 && dy === 0) throw new ComputerError("INVALID_ARGUMENT", "dx 与 dy 不能同时为 0");
      const at = params.x === undefined && params.y === undefined ? this.cursor : ctx.point(params.x, params.y);
      ctx.summary(`滚动 dx=${dx} dy=${dy}`);
      const notches = (pixels: number) => Math.min(MAX_NOTCHES, Math.max(1, Math.round(Math.abs(pixels) / PIXELS_PER_NOTCH)));
      const wheel = async (bit: number, count: number) => {
        for (let i = 0; i < count; i += 1) {
          await ctx.pointer(at.x, at.y, this.heldButtons | bit);
          await ctx.pointer(at.x, at.y, this.heldButtons);
        }
      };
      if (dy) await wheel(dy > 0 ? WHEEL.down : WHEEL.up, notches(dy));
      if (dx) await wheel(dx > 0 ? WHEEL.right : WHEEL.left, notches(dx));
    });
  }

  mouseDown(params: { x?: unknown; y?: unknown; button?: unknown }, source: Source) {
    return this.run("mouse.down", source, async (ctx) => {
      const at = params.x === undefined && params.y === undefined ? this.cursor : ctx.point(params.x, params.y);
      const name = buttonName(params.button);
      ctx.summary(`按下 ${name}`);
      await ctx.pointer(at.x, at.y, this.heldButtons | BUTTONS[name]);
    });
  }

  mouseUp(params: { x?: unknown; y?: unknown; button?: unknown }, source: Source) {
    return this.run("mouse.up", source, async (ctx) => {
      const at = params.x === undefined && params.y === undefined ? this.cursor : ctx.point(params.x, params.y);
      const name = buttonName(params.button);
      ctx.summary(`抬起 ${name}`);
      await ctx.pointer(at.x, at.y, this.heldButtons & ~BUTTONS[name]);
    });
  }

  keyPress(params: { key?: unknown }, source: Source) {
    return this.run("key.press", source, async (ctx, display) => {
      if (typeof params.key !== "string") throw new ComputerError("INVALID_ARGUMENT", "key 必须是字符串");
      let combo: ReturnType<typeof parseCombo>;
      try {
        combo = parseCombo(params.key, display.modifiers);
      } catch (error) {
        throw new ComputerError("INVALID_ARGUMENT", (error as Error).message);
      }
      ctx.summary(`按键 ${params.key.toLowerCase()}`);
      for (const modifier of combo.modifiers) await ctx.key(modifier, true);
      await ctx.key(combo.key, true);
      await ctx.key(combo.key, false);
      for (const modifier of [...combo.modifiers].reverse()) await ctx.key(modifier, false);
    });
  }

  typeText(params: { text?: unknown }, source: Source) {
    // 入队前校验，超长请求不进入队列。
    const text = params.text;
    if (typeof text !== "string" || text === "") {
      return this.reject("text.type", source, new ComputerError("INVALID_ARGUMENT", "text 必须是非空字符串"));
    }
    if (text.length > this.maxText * 2 || [...text].length > this.maxText) {
      return this.reject("text.type", source, new ComputerError("INVALID_ARGUMENT", `单次输入不能超过 ${this.maxText} 个字符`));
    }
    const chars = [...text];
    return this.run("text.type", source, async (ctx, display) => {
      const strokes = chars.map((char) => usKeyStroke(char));
      const keyboardOnly = strokes.every((stroke) => stroke !== null);

      if (keyboardOnly || display.capabilities.unicodeText) {
        ctx.summary(`输入 ${chars.length} 个字符`);
        for (let i = 0; i < chars.length; i += 1) {
          const stroke = strokes[i];
          if (stroke && display.capabilities.physicalKeys) {
            if (stroke.shift) await ctx.key(SHIFT, true);
            await ctx.key(stroke.keysym, true);
            await ctx.key(stroke.keysym, false);
            if (stroke.shift) await ctx.key(SHIFT, false);
          } else {
            const keysym = charKeysym(chars[i]!);
            await ctx.key(keysym, true);
            await ctx.key(keysym, false);
          }
        }
        return;
      }

      // 键盘打不出的文字：写进客体剪贴板再粘贴，整段一次完成，内容不经过宿主剪贴板。
      if (!this.options.textHelper) {
        throw new ComputerError("UNSUPPORTED_ON_VM", "当前显示通道不支持输入非 ASCII 文字");
      }
      if (this.helperBroken) {
        throw new ComputerError("UNSUPPORTED_ON_VM", "剪贴板输入通道曾无法取消，已停用，重启服务后恢复");
      }
      ctx.summary(`粘贴输入 ${chars.length} 个字符`);
      await ctx.guard((signal) => this.options.textHelper!.setClipboard(text, signal));
      const paste = parseCombo("cmd+v", display.modifiers);
      for (const modifier of paste.modifiers) await ctx.key(modifier, true);
      await ctx.key(paste.key, true);
      await ctx.key(paste.key, false);
      for (const modifier of [...paste.modifiers].reverse()) await ctx.key(modifier, false);
    });
  }

  /** 串行执行一个输入操作；所有底层事件都经 ctx 发出以接受停止与速率检查。 */
  private run(
    action: string,
    source: Source,
    body: (ctx: OpContext, display: DisplayInput) => Promise<void>,
  ): Promise<{ ok: true }> {
    if (this.stoppedFlag) {
      return this.reject(action, source, new ComputerError("STOPPED", "电脑操控已紧急停止，需要用户恢复后才能继续"));
    }
    if (this.pendingOps >= MAX_PENDING_OPS) {
      return this.reject(action, source, new ComputerError("RATE_LIMITED", `排队中的操作已达上限 ${MAX_PENDING_OPS}`));
    }
    this.pendingOps += 1;
    const generation = this.generation;
    const epoch = this.connectionEpoch;
    const task = this.queue.then(async () => {
      let summary = action;
      try {
        this.assertLive(generation);
        const display = await this.ensureDisplay(epoch);
        // 发送前在同一同步段里再查一次：await 之后、发送之前可能已被紧急停止或断线。
        const live = () => {
          this.assertLive(generation);
          this.assertConnection(epoch, display);
        };
        const ctx: OpContext = {
          summary: (text) => {
            summary = text;
          },
          point: (x, y) => point(x, y, display.width, display.height),
          pointer: async (x, y, mask) => {
            await this.beforeEvent(generation);
            live();
            this.inputSeq += 1;
            display.pointer(x, y, mask);
            this.cursor = { x, y };
            this.heldButtons = mask & (BUTTONS.left | BUTTONS.middle | BUTTONS.right);
          },
          key: async (keysym, down) => {
            await this.beforeEvent(generation);
            live();
            this.inputSeq += 1;
            display.key(keysym, down);
            if (down) this.heldKeys.add(keysym);
            else this.heldKeys.delete(keysym);
          },
          guard: async (work) => {
            live();
            const controller = new AbortController();
            this.helperAbort = controller;
            const timer = setTimeout(() => controller.abort(), HELPER_TIMEOUT_MS);
            try {
              // 等辅助调用真正结束（含被中止后的结算），确认旧调用不会迟到写入，再放行后续操作。
              await settleAfterAbort(work(controller.signal), controller.signal);
            } catch (error) {
              if (error instanceof ComputerError && error.message === HELPER_STUCK) this.helperBroken = true;
              throw error;
            } finally {
              clearTimeout(timer);
              if (this.helperAbort === controller) this.helperAbort = null;
            }
            if (controller.signal.aborted && !this.stoppedFlag) {
              throw new ComputerError("DISPLAY_UNAVAILABLE", "客体辅助调用超时");
            }
            live();
          },
        };
        await body(ctx, display);
        this.record(action, summary, source, true);
        return { ok: true as const };
      } catch (error) {
        // 任何失败（限速、断线、停止、参数）都经内部通道抬起本操作按下的键，避免卡键。
        await this.releaseHeld();
        const normalized = toComputerError(error);
        this.record(action, summary, source, false, normalized);
        throw normalized;
      }
    });
    const settled = task.finally(() => {
      this.pendingOps -= 1;
    });
    this.queue = settled.catch(() => undefined);
    return settled;
  }

  private reject(action: string, source: Source, error: ComputerError): Promise<never> {
    this.record(action, action, source, false, error);
    return Promise.reject(error);
  }

  private assertConnection(epoch: number, display: DisplayInput) {
    if (epoch !== this.connectionEpoch || display.closed) {
      throw new ComputerError("DISPLAY_UNAVAILABLE", "显示连接已中断，排队中的操作已取消");
    }
  }

  private assertLive(generation: number) {
    if (this.stoppedFlag || generation !== this.generation) {
      throw new ComputerError("STOPPED", "电脑操控已紧急停止，操作已中断");
    }
  }

  private async beforeEvent(generation: number) {
    this.assertLive(generation);
    const wait = this.lastEventAt + this.minInterval - this.now();
    if (wait > 0) {
      await this.sleep(wait);
      this.assertLive(generation);
    }
    const now = this.now();
    this.eventTimes = this.eventTimes.filter((at) => now - at < 60_000);
    if (this.eventTimes.length >= this.maxPerMinute) {
      throw new ComputerError("RATE_LIMITED", `输入过快：每分钟最多 ${this.maxPerMinute} 个底层事件`);
    }
    this.eventTimes.push(now);
    this.lastEventAt = now;
  }

  /** 内部释放通道：不受停止位约束，只做抬起。 */
  private async releaseHeld() {
    const display = this.display;
    if (display && !display.closed) {
      try {
        if (this.heldKeys.size || this.heldButtons) this.inputSeq += 1;
        for (const keysym of this.heldKeys) display.key(keysym, false);
        if (this.heldButtons) display.pointer(this.cursor.x, this.cursor.y, 0);
      } catch {
        // 连接已断：服务端会随连接一起丢弃按键状态。
      }
    }
    this.heldKeys.clear();
    this.heldButtons = 0;
  }

  private async ensureDisplay(expectedEpoch?: number): Promise<DisplayInput> {
    if (this.display && this.display.closed) {
      // 发现断线：作废旧连接上排队的操作，之后只处理新提交的输入。
      this.display = null;
      this.connectionEpoch += 1;
    }
    if (expectedEpoch !== undefined && expectedEpoch !== this.connectionEpoch) {
      throw new ComputerError("DISPLAY_UNAVAILABLE", "显示连接已中断，排队中的操作已取消");
    }
    if (this.display) return this.display;
    if (!this.connecting) {
      const epoch = this.connectionEpoch;
      this.connecting = (async () => {
        try {
          let display: DisplayInput;
          try {
            display = await this.options.connectDisplay();
          } catch (error) {
            throw new ComputerError("DISPLAY_UNAVAILABLE", `无法连接 Agent 电脑的显示：${(error as Error).message}`);
          }
          if (epoch !== this.connectionEpoch) {
            // close() 发生在连接途中：丢弃迟到的连接，不写回实例状态。
            display.close();
            throw new ComputerError("DISPLAY_UNAVAILABLE", "显示连接已关闭");
          }
          this.display = display;
          // 新连接上先把可能残留的按键抬起，但不清除停止位、不重放任何操作。
          await this.releaseHeld();
          return display;
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  close() {
    this.connectionEpoch += 1;
    this.display?.close();
    this.display = null;
  }

  private record(action: string, summary: string, source: Source, ok: boolean, error?: unknown) {
    this.auditSeq += 1;
    const entry: AuditEntry = { id: `a${this.auditSeq}`, action, summary, source, ok, atMs: this.now() };
    if (error) entry.error = toComputerError(error).message;
    this.audit.push(entry);
    if (this.audit.length > AUDIT_LIMIT) this.audit.splice(0, this.audit.length - AUDIT_LIMIT);
  }
}

export interface ScreenshotResult {
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
  originX: number;
  originY: number;
}

function encodeScreenshot(frame: Frame, maxEdge: number | undefined): ScreenshotResult {
  const scaled = fitToMaxEdge(frame, maxEdge);
  return {
    mime: "image/png",
    dataBase64: encodePng(scaled).toString("base64"),
    width: scaled.width,
    height: scaled.height,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    originX: 0,
    originY: 0,
  };
}

interface OpContext {
  summary(text: string): void;
  point(x: unknown, y: unknown): { x: number; y: number };
  pointer(x: number, y: number, mask: number): Promise<void>;
  key(keysym: number, down: boolean): Promise<void>;
  /** 非输入事件的异步步骤（如写客体剪贴板），前后各检查一次停止位；超时或停止时经 signal 取消。 */
  guard(work: (signal: AbortSignal) => Promise<void>): Promise<void>;
}

/**
 * 等待辅助调用结算。中止后再给它一小段时间结束；仍不结束说明实现没有遵守取消约定，
 * 此时报错而不是继续放行（旧调用仍可能迟到写入）。
 */
async function settleAfterAbort(work: Promise<void>, signal: AbortSignal): Promise<void> {
  const settled = work.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const abortGrace = new Promise<"stuck">((resolve) => {
    const arm = () => setTimeout(() => resolve("stuck"), HELPER_ABORT_GRACE_MS);
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
  const result = await Promise.race([settled, abortGrace]);
  if (result === "stuck") throw new ComputerError("INTERNAL", HELPER_STUCK);
  if (!result.ok && !signal.aborted) throw result.error;
}

export function toComputerError(error: unknown): ComputerError {
  if (error instanceof ComputerError) return error;
  return new ComputerError("INTERNAL", error instanceof Error ? error.message : String(error));
}

function point(x: unknown, y: unknown, width: number, height: number) {
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ComputerError("INVALID_ARGUMENT", "坐标必须是有限数字");
  }
  const rx = Math.round(x);
  const ry = Math.round(y);
  if (rx < 0 || ry < 0 || rx >= width || ry >= height) {
    throw new ComputerError("INVALID_ARGUMENT", `坐标 (${rx}, ${ry}) 超出屏幕范围 ${width}×${height}`);
  }
  return { x: rx, y: ry };
}

function buttonName(value: unknown): ButtonName {
  if (value === undefined) return "left";
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new ComputerError("INVALID_ARGUMENT", "button 只能是 left / middle / right");
}

function optionalBool(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ComputerError("INVALID_ARGUMENT", `${name} 必须是布尔值`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerError("INVALID_ARGUMENT", `${name} 必须是有限数字`);
  }
  return value;
}

function positiveInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ComputerError("INVALID_ARGUMENT", `${name} 必须是正整数`);
  }
  return value;
}
