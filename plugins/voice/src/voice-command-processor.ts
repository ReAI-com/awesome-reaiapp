import { t } from "./voice-i18n";
import { VoiceAppError } from "./voice-app-error";

/** 处理器自己的失败：插件固定文案，普通模式也能原样显示。 */
function commandProcessorError(key: "message1" | "message2" | "message3"): VoiceAppError {
  return new VoiceAppError({
    code: "com.reai.voice/VOICE_COMMAND_FAILED",
    get userMessage() {
      if (key === "message1") return t("commandProcessor.message1");
      if (key === "message2") return t("commandProcessor.message2");
      return t("commandProcessor.message3");
    },
    retryable: key !== "message1",
  }, undefined, { constantMessage: true });
}
/**
 * Voice Command 的运行编排：合同 `VoiceCommandProcessorPort` 的实现。
 *
 * ## 为什么数据源是注入的
 *
 * 底层通道已裁决：只走 `cloud.workflow.invoke@1`（flowApi），自建的
 * `voice.command.run-stream` 已移除。但 flowApi 的 `flow.event` 有序透传尚未实现，
 * 所以本层暂时没有真实数据源接入（app.ts 先走一次性 `voiceCommand.run`）。
 * 编排逻辑——两段式确认、取消、事件到结果的收敛——与通道无关，「怎么拿到事件」
 * 是一个注入口；flowApi 透传落地后写一个 flowApi opener 接上即可，这一层不动。
 *
 * 这也是它能脱离网络单测的原因。
 */

import {
  BUILTIN_VOICE_COMMANDS,
  type VoiceCommandDefinition,
  type VoiceCommandEvent,
  type VoiceCommandPlan,
  type VoiceCommandRequest,
  type VoiceCommandResult,
  type VoiceCommandRun,
} from "./voice-ai-contract";
import { mapRawEvent, type RawStreamEvent } from "./voice-command-runtime";

/**
 * 打开一条底层事件流。
 *
 * 实现方负责鉴权、超时、取消——那些都在 Host 侧，插件碰不到 token 与端点。
 */
export interface StreamOpener {
  (
    inputs: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): AsyncIterable<RawStreamEvent>;
}

export interface ProcessorDeps {
  openStream: StreamOpener;
  /** 单调时钟，测试注入假的。 */
  now: () => number;
  newId: () => string;
}

/** 简单的异步队列：事件推进来，消费者按顺序拿走。 */
class EventQueue {
  private readonly buffer: VoiceCommandEvent[] = [];
  private readonly waiters: ((value: IteratorResult<VoiceCommandEvent>) => void)[] = [];
  private done = false;

  push(event: VoiceCommandEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.buffer.push(event);
  }

  close(): void {
    this.done = true;
    // 唤醒所有还在等的消费者，否则 for-await 会永远挂着。
    while (this.waiters.length) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  iterator(onAbandon: () => void): AsyncIterableIterator<VoiceCommandEvent> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<VoiceCommandEvent>> {
        // 先取 buffer 再看 done：close 之后残留的事件仍要读完才结束。
        const buffered = self.buffer.shift();
        if (buffered) return Promise.resolve({ value: buffered, done: false });
        if (self.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => self.waiters.push(resolve));
      },
      // `for await` 提前 break 时由运行时调用。没有它，消费者走了而底层流照跑到底，
      // 事件全堆在 buffer 里、AbortSignal 从头到尾没被触发。
      return(): Promise<IteratorResult<VoiceCommandEvent>> {
        onAbandon();
        self.close();
        self.buffer.length = 0;
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/**
 * Agent 命令的计划从哪来。
 *
 * 后端在 Release 流式通道里**屏蔽了 `wait_for_input`**，所以"停下来等确认"不能靠
 * 它——改成两次 run：第一次跑到生成计划就结束，把计划作为一个 block 的输出带回来；
 * 用户确认后再发第二次执行。两次 HTTP run 对上层是一次逻辑 run，由这里串起来。
 */
const PLAN_BLOCK_ID = "plan";

function extractPlan(raw: RawStreamEvent): VoiceCommandPlan | null {
  if (raw.event !== "block_complete") return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload.blockId !== PLAN_BLOCK_ID) return null;
  const output = payload.output;
  if (typeof output !== "object" || output === null) return null;
  const candidate = output as Record<string, unknown>;
  const title = candidate.title;
  const steps = candidate.steps;
  // 解析不出就**直接失败**，绝不编一个计划出来让用户去确认。
  if (typeof title !== "string" || !Array.isArray(steps)) return null;
  const usableSteps = steps.filter((step): step is string => typeof step === "string");
  // 只有标题、没有一条步骤明细的"计划"同样不能推给用户 —— 那是让人在不知道自己
  // 授权了什么的情况下点确认，和编一个计划是同一种问题。
  if (usableSteps.length === 0) return null;
  return {
    title,
    steps: usableSteps,
    // 会产生外部副作用的命令，确认必须是真实动作，不是超时默认值。
    autoStartMs: null,
  };
}

function needsPlanConfirmation(command: VoiceCommandDefinition): boolean {
  return (
    command.id === BUILTIN_VOICE_COMMANDS.agent &&
    command.delivery.kind === "panel" &&
    command.delivery.autoStartMs === null
  );
}

export function createProcessor(deps: ProcessorDeps) {
  return {
    async start(
      request: VoiceCommandRequest,
      options?: { signal?: AbortSignal },
    ): Promise<VoiceCommandRun> {
      const runId = deps.newId();
      const startedAt = deps.now();
      const queue = new EventQueue();
      const controller = new AbortController();
      options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });

      let sequence = 0;
      const ctx = {
        runId,
        commandId: request.command.id,
        nextSequence: () => ++sequence,
        elapsedMs: () => deps.now() - startedAt,
      };

      let resolveResult: (value: VoiceCommandResult) => void = () => {};
      let rejectResult: (reason: unknown) => void = () => {};
      const result = new Promise<VoiceCommandResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });

      // 两段式确认：第一段跑出计划后停下来等这个 promise。
      //
      // ⚠️ 它**必须**也响应取消。只由 confirmPlan 唤醒的话，「弹出计划面板 → 用户
      // 按 Esc 走人」会让 pump 永远停在这里：result 永久 pending，闭包与队列全部驻留。
      // 而那正是最常见的取消场景。
      let resolveConfirm: ((by: "user" | "auto_start") => void) | null = null;
      const confirmed: Promise<"user" | "auto_start"> = new Promise((resolve, reject) => {
        resolveConfirm = resolve;
        if (controller.signal.aborted) {
          reject(commandProcessorError("message1"));
          return;
        }
        controller.signal.addEventListener(
          "abort",
          () => reject(commandProcessorError("message1")),
          { once: true },
        );
      });
      // 单段命令根本不会 await 它，而取消照样会 reject —— 不挂空处理就是一条
      // 未捕获拒绝，在严格运行时会直接把进程带走。
      confirmed.catch(() => {});

      const transcript = request.input.kind === "transcript" ? request.input.transcript.text : "";
      let answer = "";
      let polished = "";

      const pump = async () => {
        try {
          const wantsPlan = needsPlanConfirmation(request.command);
          const firstPhase = wantsPlan ? "plan" : "execute";
          let planned: VoiceCommandPlan | null = null;

          for await (const raw of deps.openStream(
            { commandId: request.command.id, text: transcript, phase: firstPhase },
            { signal: controller.signal },
          )) {
            const plan = wantsPlan ? extractPlan(raw) : null;
            if (plan) {
              planned = plan;
              queue.push({ ...baseOf(ctx), type: "plan.proposed", plan });
              continue;
            }
            const mapped = mapRawEvent(raw, ctx);
            if (mapped) {
              collect(mapped);
              queue.push(mapped);
            }
          }

          if (wantsPlan) {
            if (!planned) {
              // 第一段没能形成可确认的计划：如实失败，用户什么都没授权，重试无风险。
              throw commandProcessorError("message2");
            }
            const by = await confirmed;
            queue.push({ ...baseOf(ctx), type: "plan.confirmed", by });

            for await (const raw of deps.openStream(
              {
                commandId: request.command.id,
                text: transcript,
                phase: "execute",
                plan: planned,
              },
              { signal: controller.signal },
            )) {
              const mapped = mapRawEvent(raw, ctx);
              if (mapped) {
                collect(mapped);
                queue.push(mapped);
              }
            }
          }

          // ⚠️ 兜底到原文只对**纯转写**成立（它要的就是原文）。
          // 翻译和 Agent 有后续步骤，工作流一个 chunk 都没发时（端点 outputs 没把
          // 中间 block 声明为输出就会这样，见计划 §2.1）返回原文等于把失败包装成
          // 成功——用户说中文期望英文，拿到中文，系统还说"已写入"。
          // 取消过就一定不能报成功。底层适配器若不尊重 signal（换一条通道就可能
          // 如此），流会照跑到底 —— 那时"取消了却返回成功结果"，比不让取消更糟。
          if (controller.signal.aborted) {
            throw commandProcessorError("message1");
          }
          const deliverable = answer || polished;
          if (!deliverable && request.command.steps.length > 0) {
            throw commandProcessorError("message3");
          }
          const polishedText = polished || transcript;
          resolveResult({
            runId,
            commandId: request.command.id,
            text: deliverable || transcript,
            originalText: transcript,
            trace: {
              polishedText,
              // 没收到润色稿时不能说"润色改变了内容"——那会让界面显示一个
              // 两边一模一样的前后对比。
              polishChanged: polished !== "" && polished !== transcript,
            },
            citations: [],
          });
        } catch (cause) {
          rejectResult(cause);
        } finally {
          queue.close();
        }
      };

      function collect(event: VoiceCommandEvent): void {
        if (event.type === "output.delta" && event.channel === "answer") answer += event.delta;
        if (event.type === "output.delta" && event.channel === "transcript") polished += event.delta;
      }

      void pump();

      return {
        runId,
        events: queue.iterator(() => controller.abort()),
        result,
        async cancel() {
          controller.abort();
          queue.push({ ...baseOf(ctx), type: "run.cancelled", reason: "user" });
          queue.close();
        },
        async confirmPlan(by) {
          // 第二段失败与第一段语义不同：用户已经授权过，外部副作用可能发生了一半，
          // 所以调用方**绝不能**自动重试。这里只负责放行。
          resolveConfirm?.(by);
        },
      };
    },
  };
}

function baseOf(ctx: {
  runId: string;
  nextSequence: () => number;
  elapsedMs: () => number;
}): { runId: string; sequence: number; elapsedMs: number } {
  return { runId: ctx.runId, sequence: ctx.nextSequence(), elapsedMs: ctx.elapsedMs() };
}
