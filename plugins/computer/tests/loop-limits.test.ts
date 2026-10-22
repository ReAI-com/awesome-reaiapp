/**
 * 对照宿主真实接口的边界：
 * - ai.text.generate 单次最多 32 条消息（宿主 cloud MAX_MESSAGES）；
 * - computer.mouse.scroll 按 i32 读取 dx/dy，小数与越界会被宿主当成 0；
 * - 宿主错误串已带 code 前缀时不重复拼接。
 */
import { describe, expect, test } from "bun:test";
import { MAX_REQUEST_MESSAGES, MAX_STEPS, causeMessage, describeError, errorCode, parseActionReply, runComputerTask, type TaskDeps } from "../src/agent-loop";

const SHOT = { mime: "image/jpeg", dataBase64: "AAAA", width: 10, height: 10, sourceWidth: 100, sourceHeight: 100, originX: 0, originY: 0 };

describe("消息条数上限", () => {
  test(`跑满 ${MAX_STEPS} 步，每次请求都不超过 ${MAX_REQUEST_MESSAGES} 条，且保留 system 与任务说明`, async () => {
    const sizes: number[] = [];
    const deps: TaskDeps = {
      computer: (async (method: string) => (method === "computer.screenshot" ? SHOT : {})) as TaskDeps["computer"],
      ai: (async (_method: string, params: unknown) => {
        const messages = (params as { messages: Array<{ role: string; content: unknown }> }).messages;
        sizes.push(messages.length);
        expect(messages[0]!.role).toBe("system");
        expect(messages[1]!.role).toBe("user");
        expect(JSON.stringify(messages[1]!.content)).toContain("第一个动作");
        // 不能出现孤立的 assistant：system、任务说明之后应是 assistant / user 交替，末尾为本轮 user。
        for (let i = 2; i < messages.length - 1; i += 2) {
          expect(messages[i]!.role).toBe("assistant");
          expect(messages[i + 1]!.role).toBe("user");
        }
        expect(messages.at(-1)!.role).toBe("user");
        return { text: '{"action":"scroll","dy":100}' };
      }) as TaskDeps["ai"],
      sleep: async () => undefined,
    };
    const result = await runComputerTask({ modelAlias: "text-quality" }, "测试", {}, deps);
    expect(result.status).toBe("fail");
    expect(sizes).toHaveLength(MAX_STEPS);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_REQUEST_MESSAGES);
    expect(sizes[15]).toBeLessThanOrEqual(MAX_REQUEST_MESSAGES); // 原先第 16 步是 33 条
  });
});

describe("滚动参数归一化", () => {
  test("小数四舍五入为整数", () => {
    expect(parseActionReply('{"action":"scroll","dy":2.5,"dx":-1.4}')?.action).toEqual({ action: "scroll", dx: -1, dy: 3 });
  });

  test("取整后双零被拒绝，避免宿主报错", () => {
    expect(parseActionReply('{"action":"scroll","dy":0.4}')).toBeNull();
    expect(parseActionReply('{"action":"scroll","dx":-0.2,"dy":0.3}')).toBeNull();
  });

  test("超出 i32 范围被拒绝，不会被宿主静默当成 0", () => {
    expect(parseActionReply('{"action":"scroll","dy":2147483647.6}')).toBeNull();
    expect(parseActionReply('{"action":"scroll","dy":-2147483649}')).toBeNull();
    expect(parseActionReply('{"action":"scroll","dy":2147483647}')?.action).toEqual({ action: "scroll", dx: 0, dy: 2147483647 });
  });

  test("执行时发给宿主的是整数", async () => {
    const sent: unknown[] = [];
    let first = true;
    const deps: TaskDeps = {
      computer: (async (method: string, params: unknown) => {
        if (method === "computer.mouse.scroll") sent.push(params);
        return method === "computer.screenshot" ? SHOT : {};
      }) as TaskDeps["computer"],
      ai: (async () => {
        const text = first ? '{"action":"scroll","dy":120.7}' : '{"action":"done"}';
        first = false;
        return { text };
      }) as TaskDeps["ai"],
      sleep: async () => undefined,
    };
    await runComputerTask({ modelAlias: "text-quality" }, "测试", {}, deps);
    expect(sent).toEqual([{ dx: 0, dy: 121 }]);
  });
});

describe("describeError", () => {
  test("宿主错误串已带 code 前缀时不重复拼接", () => {
    expect(describeError({ code: "COMPUTER_STOPPED", message: "COMPUTER_STOPPED: 已紧急停止" })).toBe("COMPUTER_STOPPED: 已紧急停止");
  });

  test("没有前缀时仍补上 code", () => {
    expect(describeError({ code: "X", userMessage: "失败" })).toBe("失败（X）");
  });
});

describe("失败原因按宿主错误码本地化", () => {
  test("对象 code 与错误串前缀都能识别", () => {
    expect(errorCode({ code: "COMPUTER_RATE_LIMITED", message: "x" })).toBe("COMPUTER_RATE_LIMITED");
    expect(errorCode(new Error("COMPUTER_TARGET_REJECTED: 前台是密码管理器"))).toBe("COMPUTER_TARGET_REJECTED");
    expect(errorCode(new Error("普通错误"))).toBeUndefined();
  });

  test("已知码给出具体原因与恢复方法，原文保留在 raw", () => {
    expect(causeMessage({ code: "COMPUTER_PERMISSION_MISSING", message: "COMPUTER_PERMISSION_MISSING: 缺屏幕录制" }, "computer")).toEqual({
      key: "cause.permissionMissing",
      raw: "COMPUTER_PERMISSION_MISSING: 缺屏幕录制",
    });
    expect(causeMessage(new Error("COMPUTER_STOPPED: 已停止"), "computer").key).toBe("cause.stopped");
  });

  test("错误码只认自有属性与合法格式，原型链属性名不会命中", () => {
    expect(errorCode({ code: "toString" })).toBeUndefined();
    expect(errorCode({ code: "constructor" })).toBeUndefined();
    expect(causeMessage({ code: "__proto__" }, "computer").key).toBe("cause.unknown");
    expect(errorCode(Object.create({ code: "COMPUTER_STOPPED" }))).toBeUndefined();
  });

  test("未知错误按来源给出通用恢复方法", () => {
    expect(causeMessage({ code: "AI_UNAUTHENTICATED", message: "need login" }, "model").key).toBe("cause.model");
    expect(causeMessage(new Error("boom"), "computer").key).toBe("cause.unknown");
  });

  test("模型调用失败的任务结果给出云模型的恢复方法", async () => {
    const deps: TaskDeps = {
      computer: (async () => SHOT) as TaskDeps["computer"],
      ai: (async () => {
        throw { code: "AI_MODEL_UNAVAILABLE", message: "no vision model" };
      }) as TaskDeps["ai"],
      sleep: async () => undefined,
    };
    const result = await runComputerTask({ modelAlias: "text-quality" }, "测试", {}, deps);
    expect(result.message).toEqual({ key: "cause.model", raw: "no vision model（AI_MODEL_UNAVAILABLE）" });
  });
});
