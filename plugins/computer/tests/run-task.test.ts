import { describe, expect, test } from "bun:test";
import { MAX_STEPS, runComputerTask, type TaskDeps } from "../src/agent-loop";

const SHOT = {
  mime: "image/png",
  dataBase64: "AAAA",
  width: 1024,
  height: 640,
  sourceWidth: 2048,
  sourceHeight: 1280,
  originX: 0,
  originY: 0,
};

/** 记录所有宿主调用的假依赖；replies 依次作为模型回复。 */
function fakeDeps(replies: string[], options: { failOn?: string } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let replyIndex = 0;
  const deps: TaskDeps = {
    computer: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === options.failOn) throw { code: "COMPUTER_STOPPED", message: "COMPUTER_STOPPED: 已紧急停止" };
      return method === "computer.screenshot" ? SHOT : {};
    }) as TaskDeps["computer"],
    ai: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      const text = replies[Math.min(replyIndex, replies.length - 1)];
      replyIndex += 1;
      return { text };
    }) as TaskDeps["ai"],
    sleep: async () => undefined,
  };
  return { deps, calls, methods: () => calls.map((call) => call.method) };
}

const CONFIG = { modelAlias: "text-quality" };

describe("runComputerTask", () => {
  test("中止任务不调用 computer.resume（不撤销紧急停止）", async () => {
    const { deps, methods } = fakeDeps(['{"action":"click","x":500,"y":500}']);
    let checks = 0;
    const result = await runComputerTask(
      CONFIG,
      "测试",
      { shouldAbort: () => ++checks > 2 },
      deps,
    );
    expect(result.status).toBe("aborted");
    expect(methods()).not.toContain("computer.resume");
    expect(methods()).not.toContain("computer.stop");
  });

  test("开始前已中止：不截图、不调模型", async () => {
    const { deps, calls } = fakeDeps(['{"action":"done"}']);
    const result = await runComputerTask(CONFIG, "测试", { shouldAbort: () => true }, deps);
    expect(result).toEqual({ status: "aborted", message: { key: "result.aborted" }, steps: 0 });
    expect(calls).toHaveLength(0);
  });

  test("模型思考期间中止：不执行这一步的动作", async () => {
    const { deps, methods } = fakeDeps(['{"action":"type","text":"不该输入"}']);
    let aborted = false;
    deps.ai = (async () => {
      aborted = true; // 模拟用户在等待模型回复时点了中止
      return { text: '{"action":"type","text":"不该输入"}' };
    }) as TaskDeps["ai"];
    const result = await runComputerTask(CONFIG, "测试", { shouldAbort: () => aborted }, deps);
    expect(result.status).toBe("aborted");
    expect(methods()).not.toContain("computer.text.type");
  });

  test("点击按截图覆盖的屏幕尺寸换算坐标", async () => {
    const { deps, calls } = fakeDeps([
      '{"action":"click","x":500,"y":500}',
      '{"action":"done","detail":"好了"}',
    ]);
    const result = await runComputerTask(CONFIG, "测试", {}, deps);
    expect(result).toEqual({ status: "done", message: { key: "result.done", params: { steps: 2 }, raw: "好了" }, steps: 2 });
    const click = calls.find((call) => call.method === "computer.mouse.click");
    expect(click?.params).toEqual({ x: 1024, y: 640, button: "left", double: false });
  });

  test("引擎拒绝执行（如已紧急停止）时立即停下", async () => {
    const { deps, methods } = fakeDeps(['{"action":"press","key":"enter"}'], {
      failOn: "computer.key.press",
    });
    const steps: boolean[] = [];
    const result = await runComputerTask(
      CONFIG,
      "测试",
      { onStep: (report) => steps.push(report.ok) },
      deps,
    );
    expect(result.status).toBe("error");
    expect(result.message).toEqual({ key: "cause.stopped", raw: "COMPUTER_STOPPED: 已紧急停止" });
    expect(steps).toEqual([false]);
    expect(methods().filter((m) => m === "computer.key.press")).toHaveLength(1);
  });

  test("模型回复不是动作 JSON 时停下，不执行任何操作", async () => {
    const { deps, methods } = fakeDeps(["我觉得应该点右上角"]);
    const result = await runComputerTask(CONFIG, "测试", {}, deps);
    expect(result.status).toBe("error");
    expect(methods().some((m) => m.startsWith("computer.mouse") || m.startsWith("computer.key"))).toBe(false);
  });

  test("达到步数上限后停止", async () => {
    const { deps, methods } = fakeDeps(['{"action":"scroll","dy":100}']);
    const result = await runComputerTask(CONFIG, "测试", {}, deps);
    expect(result.status).toBe("fail");
    expect(result.steps).toBe(MAX_STEPS);
    expect(methods().filter((m) => m === "computer.mouse.scroll")).toHaveLength(MAX_STEPS);
  });

  test("发给模型的是截图与任务，不含其他内容", async () => {
    const { deps, calls } = fakeDeps(['{"action":"done"}']);
    await runComputerTask(CONFIG, "给文件传输助手发消息", {}, deps);
    const request = calls.find((call) => call.method === "ai.text.generate")?.params as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(request.model).toBe("text-quality");
    const last = request.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(last).toEqual([
      { type: "text", text: "任务：给文件传输助手发消息" },
      { type: "image", mime: "image/png", dataBase64: "AAAA" },
    ]);
  });

  test("截图期间中止：不再调用模型", async () => {
    const { deps, methods } = fakeDeps(['{"action":"done"}']);
    let aborted = false;
    const realComputer = deps.computer;
    deps.computer = (async (method: string, params: unknown) => {
      if (method === "computer.screenshot") aborted = true;
      return realComputer(method as never, params);
    }) as TaskDeps["computer"];
    const result = await runComputerTask(CONFIG, "测试", { shouldAbort: () => aborted }, deps);
    expect(result).toEqual({ status: "aborted", message: { key: "result.aborted" }, steps: 0 });
    expect(methods()).not.toContain("ai.text.generate");
  });

  test("已中止时模型请求失败：报告中止而不是出错", async () => {
    const { deps } = fakeDeps([]);
    let aborted = false;
    deps.ai = (async () => {
      aborted = true;
      throw new Error("请求被取消");
    }) as TaskDeps["ai"];
    const result = await runComputerTask(CONFIG, "测试", { shouldAbort: () => aborted }, deps);
    expect(result.status).toBe("aborted");
  });

  test("紧急停止导致动作被拒：报告中止", async () => {
    const { deps } = fakeDeps(['{"action":"press","key":"enter"}'], {
      failOn: "computer.key.press",
    });
    let aborted = false;
    const realComputer = deps.computer;
    deps.computer = (async (method: string, params: unknown) => {
      if (method === "computer.key.press") aborted = true; // 用户按下紧急停止
      return realComputer(method as never, params);
    }) as TaskDeps["computer"];
    const result = await runComputerTask(CONFIG, "测试", { shouldAbort: () => aborted }, deps);
    expect(result.status).toBe("aborted");
  });

  test("最后一步执行时中止：报告中止而不是步数耗尽，且末步不再空等", async () => {
    const { deps, methods } = fakeDeps(['{"action":"scroll","dy":100}']);
    let sleeps = 0;
    deps.sleep = async () => {
      sleeps += 1;
    };
    const scrolls = () => methods().filter((m) => m === "computer.mouse.scroll").length;
    const result = await runComputerTask(
      CONFIG,
      "测试",
      { shouldAbort: () => scrolls() >= MAX_STEPS }, // 第 20 步动作执行时用户中止
      deps,
    );
    expect(result).toEqual({ status: "aborted", message: { key: "result.aborted" }, steps: MAX_STEPS });
    expect(sleeps).toBe(MAX_STEPS - 1);
  });
});
