/**
 * Host 给的 Agent 失败码（2.14.2；V1.0 真机回归 00:40:06Z）：原样保留、不再包成 `AGENT_${kind}`；
 * Host 源码里的每个 AGENT_* 失败码都已登记并配一句固定人话（中英文）；主句优先级
 * Host 具体码 > 阶段码 / 上游码 > 兜底；没登记的码走兜底、导出只计个数，码本身留在展开区原文里。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import hostCodes from "../src/voice-host-error-codes.json";
import { AGENT_CODES_WITH_REASON, agentCodeReason, agentTurnFailureCode } from "../src/agent-failure-codes";
import { registeredErrorCode } from "../src/voice-error-codes";
import { collectErrorFields } from "../src/voice-error-fields";
import { constantReasonForCode, taskFailureLabel } from "../src/voice-failure-labels";
import { setVoiceLocale, t } from "../src/voice-i18n";
import { voiceRequestFailureMessage } from "../src/voice-user-errors";

beforeEach(() => setVoiceLocale("zh"));

const BUDGET = "AGENT_MODEL_BUDGET_EXCEEDED";
/** 与 app.ts 一样：插件错误的码取自 Host 失败，原始 failure 挂在 cause 上。 */
const turnFailure = (failure: { kind: string; code?: string; message?: string; stderr_tail?: string }) =>
  ({ code: agentTurnFailureCode(failure), cause: failure });

describe("失败码原样保留，不再按 kind 重新包装", () => {
  test("Host 给了码就原样用（登记与否都一样）；没给码或给的不是码的形态才按 kind 取 Host 自己的稳定码", () => {
    expect(agentTurnFailureCode({ kind: "engine", code: BUDGET })).toBe(BUDGET);
    expect(agentTurnFailureCode({ kind: "engine", code: "AGENT_TOOL_BUDGET_EXCEEDED" })).toBe("AGENT_TOOL_BUDGET_EXCEEDED");
    expect(agentTurnFailureCode({ kind: "engine", code: "AGENT_FUTURE_THING" })).toBe("AGENT_FUTURE_THING");
    expect(agentTurnFailureCode({ kind: "timeout", code: "AGENT_TIMEOUT" })).toBe("AGENT_TIMEOUT");
    expect(agentTurnFailureCode({ kind: "engine" })).toBe("AGENT_ENGINE");
    expect(agentTurnFailureCode({ kind: "timeout" })).toBe("AGENT_TIMEOUT");
    expect(agentTurnFailureCode({ kind: "killed" })).toBe("AGENT_KILLED");
    expect(agentTurnFailureCode({ kind: "engine", code: "引擎错误：请把合同发给王经理" })).toBe("AGENT_ENGINE");
    expect(agentTurnFailureCode({ kind: "engine", code: "   " })).toBe("AGENT_ENGINE");
    // 登记表里的小写交付枚举、浏览器异常名不是回合失败码：不借登记表混进来。
    expect(agentTurnFailureCode({ kind: "engine", code: "denied" })).toBe("AGENT_ENGINE");
    expect(agentTurnFailureCode({ kind: "timeout", code: "AbortError" })).toBe("AGENT_TIMEOUT");
  });
});

describe("Host 的每个 Agent 失败码都已登记并有一句人话", () => {
  // 插件原来就专门处理的码（取消 / 超时 / 会话失效 / 默认 Agent 不可用 / 结果过期）与 kind 级通用码，沿用原文案。
  const HANDLED = ["AGENT_BACKEND_UNAVAILABLE", "AGENT_CANCELLED", "AGENT_ENGINE", "AGENT_KILLED", "AGENT_RESULT_EXPIRED",
    "AGENT_SESSION_NOT_FOUND", "AGENT_TIMEOUT"];

  test("Host 快照里的 AGENT_* 码 = 有人话的码 + 插件原有专门处理的码，且都在登记表里", () => {
    const host = hostCodes.codes.filter((code) => code.startsWith("AGENT_"));
    expect([...host].sort()).toEqual([...AGENT_CODES_WITH_REASON, ...HANDLED].sort());
    for (const code of AGENT_CODES_WITH_REASON) expect(registeredErrorCode(code)).toBe(code);
  });

  test("每一类的代表码都落到那一类的精确文案与短句（换类或改文案就变红）", () => {
    const cases: Array<[string, string, string]> = [
      ["AGENT_MODEL_BUDGET_EXCEEDED", "这次任务已达到模型调用次数上限，请缩小问题后再试。", "已达模型调用次数上限"],
      ["AGENT_TOOL_BUDGET_EXCEEDED", "这次任务已达到工具调用次数上限，请缩小问题后再试。", "已达工具调用次数上限"],
      ["AGENT_QUEUE_FULL", "Agent 正在处理别的请求，请稍后再试。", "Agent 正忙"],
      ["AGENT_INPUT_TOO_LARGE", "这次的内容超出了 Agent 能处理的大小，请缩短后再试。", "内容超出大小上限"],
      ["AGENT_RESULT_INVALID", "Agent 收到或返回的数据无效，请重新发送。", "数据无效"],
      ["AGENT_SESSION_CLOSED", "这段 Agent 对话已失效或被中断，请重新发送。", "对话已失效"],
      ["AGENT_WORKER_OWNER_STALE", "这次任务的归属已变化，请重新发送。", "任务归属已变化"],
      ["AGENT_WORKER_UNAVAILABLE", "任务执行入口暂不可用，请稍后重试。", "任务暂不可执行"],
      ["AGENT_RUNTIME_FAILED", "Agent 运行组件不可用，请在 Driver「已安装」中检查运行组件后重试。", "运行组件不可用"],
      ["AGENT_PREFERENCE_INVALID", "Agent 设置无效、不受支持或刚刚变化，请检查 Agent 设置后重试。", "Agent 设置无效"],
      ["AGENT_TOOL_NOT_GRANTED", "Agent 调用工具失败，请重新发送；反复出现时请检查扩展权限。", "工具调用失败"],
      ["AGENT_EXEC_FAILED", "Agent 执行命令失败，请检查工作目录与权限设置后重试。", "命令执行失败"],
      ["AGENT_APPROVAL_DENIED", "需要你确认的操作被拒绝、已过期或已失效，请重新发送。", "确认未通过"],
      ["AGENT_WORKSPACE_IO_FAILED", "Agent 无法使用这次的工作目录，请检查目录与授权后重试。", "工作目录不可用"],
      ["AGENT_STORAGE_FULL", "Agent 没能保存会话数据，请检查磁盘空间后重试。", "保存失败"],
    ];
    for (const [code, reason, label] of cases) {
      expect(agentCodeReason(code)).toBe(reason);
      expect(taskFailureLabel({ code })).toBe(label);
      expect(constantReasonForCode(code)).toBe(label);
    }
  });

  test("Worker 两个码保留真实语义，英文原因与短句精确匹配", () => {
    setVoiceLocale("en");
    const cases = [
      ["AGENT_WORKER_OWNER_STALE", "The owner of this task has changed. Send it again.", "Task owner changed"],
      ["AGENT_WORKER_UNAVAILABLE", "Task execution is temporarily unavailable. Try again a little later.", "Task execution unavailable"],
    ];
    for (const [code, reason, label] of cases) {
      expect(agentTurnFailureCode({ kind: "engine", code })).toBe(code);
      expect(collectErrorFields({ code, message: "SYNTHETIC_PRIVATE_PAYLOAD" }).code).toBe(code);
      expect(agentCodeReason(code)).toBe(reason);
      expect(taskFailureLabel({ code })).toBe(label);
      expect(constantReasonForCode(code)).toBe(label);
    }
  });

  test("每一句都有中英文，不是兜底文案；短句同样齐全", () => {
    for (const locale of ["zh", "en"] as const) {
      setVoiceLocale(locale);
      for (const code of AGENT_CODES_WITH_REASON) {
        const reason = agentCodeReason(code)!;
        expect(reason).not.toMatch(/^errors\./);
        expect(reason).not.toBe(t("errors.message1"));
        expect(taskFailureLabel({ code })).not.toMatch(/^errors\./);
      }
    }
  });
});

describe("主句：Host 具体码 > 阶段码 / 上游码 > 兜底", () => {
  test("预算码：原样保留并显示对应人话（中英文，各用途），胶囊与「原因（按错误码）」同样认得", () => {
    const failure = turnFailure({ kind: "engine", code: BUDGET, message: "这次任务已达到模型调用次数上限，尚未完成。请缩小问题后再试。",
      stderr_tail: BUDGET });
    expect(failure.code).toBe(BUDGET);
    expect(collectErrorFields(failure).code).toBe(BUDGET);
    expect(voiceRequestFailureMessage("reply", failure)).toBe("这次任务已达到模型调用次数上限，请缩小问题后再试。你的内容已保存。");
    expect(voiceRequestFailureMessage("translation", failure)).toBe("这次任务已达到模型调用次数上限，请缩小问题后再试。原始内容已保存。");
    expect(voiceRequestFailureMessage("summary", failure)).toBe("这次任务已达到模型调用次数上限，请缩小问题后再试。原始记录已保存。");
    expect(taskFailureLabel(failure)).toBe("已达模型调用次数上限");
    expect(constantReasonForCode(BUDGET)).toBe("已达模型调用次数上限");
    setVoiceLocale("en");
    expect(voiceRequestFailureMessage("reply", failure))
      .toBe("This task reached the limit on model calls. Narrow the request and try again. Your content is saved.");
  });

  test("Host 具体码压过阶段码与方括号上游码；没有具体码时才按阶段说", () => {
    const tail = "DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: x";
    expect(voiceRequestFailureMessage("reply", turnFailure({ kind: "engine", code: "AGENT_RUNTIME_FAILED", stderr_tail: tail })))
      .toBe("Agent 运行组件不可用，请在 Driver「已安装」中检查运行组件后重试。你的内容已保存。");
    expect(voiceRequestFailureMessage("reply", turnFailure({ kind: "engine", code: "AGENT_ENGINE", stderr_tail: tail })))
      .toBe("上游模型限流。你的内容已保存，请稍后重新发送。");
  });

  test("阶段前缀方括号里是 Host 的 Agent 失败码时，按那一类说人话（主句与胶囊）", () => {
    const failure = turnFailure({ kind: "engine", code: "AGENT_ENGINE",
      stderr_tail: "DSH_ENGINE_EXITED（退出码 1）［AGENT_MODEL_BUDGET_EXCEEDED］：Error: x" });
    expect(voiceRequestFailureMessage("reply", failure)).toBe("这次任务已达到模型调用次数上限，请缩小问题后再试。你的内容已保存。");
    expect(taskFailureLabel(failure)).toBe("已达模型调用次数上限");
  });

  test("未登记的码：走兜底主句，码不导出只计一次个数，原样留在展开区原文里；也不改写成 AGENT_ENGINE", () => {
    const failure = turnFailure({ kind: "engine", code: "AGENT_FUTURE_THING", stderr_tail: "Error: legacy crash" });
    expect(failure.code).toBe("AGENT_FUTURE_THING");
    expect(voiceRequestFailureMessage("reply", failure)).toBe("暂时无法生成回复。你的内容已保存，请稍后重新发送。");
    const fields = collectErrorFields(failure);
    expect(fields.code).toBeUndefined();
    expect(fields.omittedCodes).toBe(1);
    expect(fields.raw).toContain("code: AGENT_FUTURE_THING");
    expect(taskFailureLabel(failure)).toBe(t("app.incompleteOpenForDetails"));
  });
});
