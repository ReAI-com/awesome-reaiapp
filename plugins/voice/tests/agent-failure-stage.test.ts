/**
 * Agent 失败按 Host 阶段细化（2.14.2；Host #956 的 `stderr_tail` / `message` 前缀）：
 * 只读前缀、得到登记表内的阶段码 / i32 退出码 / 登记过的上游码；前缀之后的原文不清洗、不导出；
 * 解析结果按出身登记，外部同形对象不被信任。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AGENT_STAGE_CODES, agentFailureStageOf, isAgentFailureStage, parseAgentFailureStage } from "../src/agent-failure-stage";
import { agentStageReason, agentUpstreamReason } from "../src/agent-failure-copy";
import { setVoiceLocale } from "../src/voice-i18n";

beforeEach(() => setVoiceLocale("zh"));

/** Host 源码（DSH 引擎服务 `agents/dsh/service.rs`）测试里的真实样例形态。 */
const HOST_SAMPLES: Array<[string, Record<string, unknown>]> = [
  ["DSH_ENGINE_EXITED（退出码 1）：Error: failed to apply loader entry 2f7edb5b", { agentStage: "DSH_ENGINE_EXITED", exitCode: 1 }],
  ["引擎错误：DSH_ENGINE_EXITED（退出码 1）：Error: failed to apply", { agentStage: "DSH_ENGINE_EXITED", exitCode: 1 }],
  ["DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：Error: xxx", { agentStage: "DSH_ENGINE_EXITED", exitCode: 1, upstreamCode: "AI_RATE_LIMITED" }],
  ["DSH_ENGINE_EXITED（退出码 2）：missing REAI_DSH_MODEL_BASE", { agentStage: "DSH_ENGINE_EXITED", exitCode: 2 }],
  ["DSH_ENGINE_EXITED（进程被终止：signal: 9 (SIGKILL)）：Error: x", { agentStage: "DSH_ENGINE_EXITED" }],
  ["DSH_ENGINE_EMPTY_REPLY（正常退出但没有回复）：引擎没有输出错误信息", { agentStage: "DSH_ENGINE_EMPTY_REPLY" }],
  ["DSH_ENGINE_SPAWN_FAILED：启动 DSH 引擎失败：No such file or directory (os error 2)", { agentStage: "DSH_ENGINE_SPAWN_FAILED" }],
  ["DSH_ENGINE_SETUP_FAILED（写入任务帧失败）：引擎没有输出错误信息", { agentStage: "DSH_ENGINE_SETUP_FAILED" }],
  ["DSH_ENGINE_WAIT_FAILED（等待进程退出失败：No child processes (os error 10)）：x", { agentStage: "DSH_ENGINE_WAIT_FAILED" }],
  // Host 在前缀收尾的 `：` 之后带运行包标签 `dsh <版本> · `，前缀文法不变。
  ["引擎错误：DSH_ENGINE_EXITED（退出码 1）：dsh 0.1.5-rc.2 · UNSUPPORTED_SCHEMA：DSH 拒绝了 Host 下发的工具 schema（reai-host-bridge），7 处：不支持的关键字 schema.properties.command.minLength", { agentStage: "DSH_ENGINE_EXITED", exitCode: 1 }],
  ["DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：dsh 0.1.1-rc.2.2 · Error: xxx", { agentStage: "DSH_ENGINE_EXITED", exitCode: 1, upstreamCode: "AI_RATE_LIMITED" }],
  ["DSH_ENGINE_SPAWN_FAILED：dsh 0.1.5-rc.2 · 启动 DSH 引擎失败：No such file or directory (os error 2)", { agentStage: "DSH_ENGINE_SPAWN_FAILED" }],
];

describe("前缀解析：只取阶段码 / 退出码 / 方括号上游码", () => {
  test("Host 各阶段的真实形态都解析得出；`引擎错误：` 开头的 message 同样认", () => {
    for (const [text, expected] of HOST_SAMPLES) expect({ ...parseAgentFailureStage(text) }).toEqual(expected);
    expect(new Set(HOST_SAMPLES.map(([text]) => parseAgentFailureStage(text)!.agentStage))).toEqual(new Set(AGENT_STAGE_CODES));
  });

  test("登记表外的阶段码、不在开头、不跟 （ ［ ： 的一律丢弃", () => {
    for (const text of [
      "DSH_ENGINE_EXPLODED（退出码 1）：Error: x", "PI_ENGINE_EXITED（退出码 1）：x", "AGENT_ENGINE（退出码 1）：x",
      "Error: DSH_ENGINE_EXITED（退出码 1）：x", " DSH_ENGINE_EXITED（退出码 1）：x", "DSH_ENGINE_EXITED_X（退出码 1）：x",
      "DSH_ENGINE_EXITED: exit 1", "DSH_ENGINE_EXITED (退出码 1)：x", "dsh_engine_exited（退出码 1）：x", "引擎错误：引擎错误：DSH_ENGINE_EXITED：x",
    ]) expect(parseAgentFailureStage(text)).toBeUndefined();
    for (const value of [undefined, null, 1, {}, ["DSH_ENGINE_EXITED：x"]]) expect(parseAgentFailureStage(value)).toBeUndefined();
  });

  test("退出码只收 i32 范围内的规范整数：越界、前导零、正号、小数、-0 都只丢退出码，阶段保留", () => {
    const exit = (value: string) => parseAgentFailureStage(`DSH_ENGINE_EXITED（退出码 ${value}）：x`);
    expect(exit("2147483647")?.exitCode).toBe(2147483647);
    expect(exit("-2147483648")?.exitCode).toBe(-2147483648);
    expect(exit("0")?.exitCode).toBe(0);
    for (const value of ["2147483648", "-2147483649", "99999999999", "01", "+1", "1.5", "-0", "1e3", "１", "1 ", "0x1"]) {
      const parsed = exit(value);
      expect(parsed?.agentStage).toBe("DSH_ENGINE_EXITED");
      expect(parsed && "exitCode" in parsed).toBeFalse();
    }
  });

  test("上游码只取方括号里第一个登记过的；没登记的、方括号后面不是 ： 的都丢弃", () => {
    const upstream = (codes: string, tail = "：x") => parseAgentFailureStage(`DSH_ENGINE_EXITED（退出码 1）［${codes}］${tail}`)?.upstreamCode;
    expect(upstream("AI_RATE_LIMITED")).toBe("AI_RATE_LIMITED");
    expect(upstream("PRIVATE_ACCOUNT_DATA AI_PAYMENT_REQUIRED AI_RATE_LIMITED")).toBe("AI_PAYMENT_REQUIRED");
    for (const codes of ["PRIVATE_ACCOUNT_DATA", ("ghp_" + "A".repeat(36)), "AI_TIMEOUT_SECRET", "", "13800138000"]) {
      expect(upstream(codes)).toBeUndefined();
    }
    expect(upstream("AI_RATE_LIMITED", " Error: x")).toBeUndefined();
    expect(parseAgentFailureStage("DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED：x")?.upstreamCode).toBeUndefined();
    // 没有原因段也认方括号。
    expect(parseAgentFailureStage("DSH_ENGINE_SPAWN_FAILED［AI_RATE_LIMITED］：x")?.upstreamCode).toBe("AI_RATE_LIMITED");
  });

  test("原因段找不到收尾或超长：后面的方括号定位不了，只保留阶段码", () => {
    expect({ ...parseAgentFailureStage("DSH_ENGINE_EXITED（退出码 1［AI_RATE_LIMITED］：x") }).toEqual({ agentStage: "DSH_ENGINE_EXITED" });
    expect({ ...parseAgentFailureStage(`DSH_ENGINE_EXITED（${"x".repeat(201)}）［AI_RATE_LIMITED］：x`) })
      .toEqual({ agentStage: "DSH_ENGINE_EXITED" });
  });

  test("解析器不依赖 i18n：它被错误字段采集层引用，反向依赖会让 voice-i18n → voice-error-fields → 解析器成环", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/agent-failure-stage.ts"), "utf8");
    expect(source).not.toMatch(/from "\.\/voice-i18n"/);
    expect(source).not.toMatch(/\bt\(/);
  });

  test("失败链上只认 kind: engine 的 Agent 失败；stderr_tail 优先，读不出再读 message", () => {
    const tail = "DSH_ENGINE_EXITED（退出码 3）：Error: x";
    expect(agentFailureStageOf({ code: "AGENT_ENGINE", cause: { kind: "engine", stderr_tail: tail } })?.exitCode).toBe(3);
    expect(agentFailureStageOf({ kind: "engine", stderr_tail: "legacy tail", message: `引擎错误：${tail}` })?.exitCode).toBe(3);
    expect(agentFailureStageOf({ kind: "engine", stderr_tail: "DSH_ENGINE_EXITED（退出码 4）：x", message: `引擎错误：${tail}` })?.exitCode).toBe(4);
    expect(agentFailureStageOf({ kind: "timeout", stderr_tail: tail })).toBeUndefined();
    expect(agentFailureStageOf({ code: "AGENT_ENGINE", stderr_tail: tail, message: tail })).toBeUndefined();
    expect(agentFailureStageOf(tail)).toBeUndefined();
  });
});

describe("按出身登记：外部同形对象不被信任", () => {
  test("解析结果冻结并登记；字段相同的普通对象不算", () => {
    const parsed = parseAgentFailureStage("DSH_ENGINE_EXITED（退出码 1）［AI_RATE_LIMITED］：x")!;
    expect(isAgentFailureStage(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed)).toBeTrue();
    const forged = { agentStage: "DSH_ENGINE_EXITED", exitCode: 1, upstreamCode: "AI_RATE_LIMITED" };
    expect(isAgentFailureStage(forged)).toBeFalse();
    expect(isAgentFailureStage({ ...parsed })).toBeFalse();
    expect(agentStageReason(forged)).toBeUndefined();
    expect(agentUpstreamReason(forged)).toBeUndefined();
    expect(agentStageReason(parsed)).toBe("Agent 引擎启动后异常退出（退出码 1）。");
    expect(agentUpstreamReason(parsed)).toEqual({ reason: "上游模型限流。", later: true });
  });

  test("错误对象上自带的 agentStage / exitCode 同名字段不认，只从原文前缀解析", () => {
    const forged = { kind: "engine", agentStage: "DSH_ENGINE_EXITED", exitCode: 7, upstreamCode: "AI_RATE_LIMITED",
      agentFailure: { agentStage: "DSH_ENGINE_EXITED", exitCode: 7 }, stderr_tail: "upstream failed" };
    expect(agentFailureStageOf(forged)).toBeUndefined();
    expect(agentFailureStageOf({ code: "AGENT_ENGINE", cause: forged })).toBeUndefined();
  });
});
