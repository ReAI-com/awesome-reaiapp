import { afterEach, describe, expect, test } from "bun:test";
import { AgentComputer, ComputerError } from "../src/agent-computer";
import { STANDARD_MODIFIERS, VZ_MACOS_MODIFIERS } from "../src/keys";
import { RfbDisplayInput } from "../src/rfb-display";
import { FakeRfbServer } from "./fake-rfb-server";

let server: FakeRfbServer | null = null;
let computer: AgentComputer | null = null;
afterEach(async () => {
  computer?.close();
  computer = null;
  await server?.stop();
  server = null;
});

const caps = { unicodeText: true, physicalKeys: false, loginScreen: true };

async function setup(options: Partial<ConstructorParameters<typeof AgentComputer>[0]> = {}) {
  server = await FakeRfbServer.start({ width: 200, height: 100 });
  const port = server.port;
  computer = new AgentComputer({
    connectDisplay: () => RfbDisplayInput.connect({ host: "127.0.0.1", port }, caps, STANDARD_MODIFIERS),
    minEventIntervalMs: 0,
    ...options,
  });
  return { server, computer };
}

const waitFor = async (check: () => boolean, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("等待超时");
    await Bun.sleep(5);
  }
};

describe("停止位", () => {
  test("服务启动默认已停止，Agent 输入被拒，截图仍可用", async () => {
    const { computer } = await setup();
    expect(computer.stopped).toBe(true);
    await expect(computer.click({ x: 1, y: 1 }, "agent")).rejects.toMatchObject({ code: "STOPPED" });
    const shot = await computer.screenshot({}, "agent");
    expect([shot.sourceWidth, shot.sourceHeight]).toEqual([200, 100]);
  });

  test("恢复后可点击；再停止后又被拒", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.click({ x: 10, y: 20 }, "agent");
    await waitFor(() => server.events.length >= 3);
    expect(server.events.slice(0, 3)).toEqual([
      { type: "pointer", x: 10, y: 20, mask: 0 },
      { type: "pointer", x: 10, y: 20, mask: 1 },
      { type: "pointer", x: 10, y: 20, mask: 0 },
    ]);
    await computer.stop("agent");
    await expect(computer.click({ x: 10, y: 20 }, "agent")).rejects.toMatchObject({ code: "STOPPED" });
  });

  test("紧急停止打断进行中的长文本，且恢复后不继续旧操作", async () => {
    let gate: (() => void) | null = null;
    const { server, computer } = await setup({
      minEventIntervalMs: 1,
      sleep: () => new Promise<void>((resolve) => (gate = resolve)),
    });
    computer.resume("user");
    const typing = computer.typeText({ text: "abcdefghij" }, "agent");
    await waitFor(() => gate !== null);
    // 放行几个事件后紧急停止。
    for (let i = 0; i < 3; i += 1) {
      const release = gate!;
      gate = null;
      release();
      await waitFor(() => gate !== null);
    }
    await computer.stop("user");
    gate!();
    await expect(typing).rejects.toMatchObject({ code: "STOPPED" });
    await Bun.sleep(30); // 等停止时发出的抬键事件经 TCP 到达假服务端
    const sentBeforeResume = server.events.filter((event) => event.type === "key").length;
    expect(sentBeforeResume).toBeLessThan(20);
    computer.resume("user");
    await Bun.sleep(30);
    // 停止时按下未抬起的键会被内部抬起；恢复后没有任何新的旧操作事件。
    const keyEvents = server.events.filter((event) => event.type === "key");
    expect(keyEvents.length).toBe(sentBeforeResume);
    const downs = keyEvents.filter((event) => event.type === "key" && event.down).length;
    const ups = keyEvents.length - downs;
    expect(ups).toBe(downs);
  });

  test("紧急停止抬起按住的鼠标键", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.mouseDown({ x: 5, y: 6 }, "agent");
    expect(computer.state().heldButtons).toEqual(["left"]);
    await computer.stop("user");
    await waitFor(() => server.events.at(-1)?.type === "pointer" && (server.events.at(-1) as { mask: number }).mask === 0);
    expect(computer.state().heldButtons).toEqual([]);
  });

  test("断线重连不清除停止位", async () => {
    const { server, computer } = await setup();
    await computer.screenshot({}, "user");
    await computer.stop("user");
    server.dropConnections();
    await Bun.sleep(20);
    await computer.screenshot({}, "user");
    expect(server.connections).toBe(2);
    await expect(computer.keyPress({ key: "enter" }, "agent")).rejects.toMatchObject({ code: "STOPPED" });
  });

  test("新实例（服务重启）默认已停止", async () => {
    const { server } = await setup();
    const port = server.port;
    const restarted = new AgentComputer({
      connectDisplay: () => RfbDisplayInput.connect({ host: "127.0.0.1", port }, caps, STANDARD_MODIFIERS),
    });
    await expect(restarted.keyPress({ key: "a" }, "agent")).rejects.toMatchObject({ code: "STOPPED" });
    restarted.close();
  });
});

describe("竞态与故障", () => {
  test("检查通过后、发送前被紧急停止：不再发送", async () => {
    let trigger: (() => void) | null = null;
    const { server, computer } = await setup({
      // now() 在 beforeEvent 检查之后调用，借它在「检查后、发送前」插入一次紧急停止。
      now: () => {
        const fire = trigger;
        trigger = null;
        fire?.();
        return Date.now();
      },
    });
    computer.resume("user");
    await computer.screenshot({}, "user");
    trigger = () => void computer.stop("user");
    await expect(computer.keyPress({ key: "a" }, "agent")).rejects.toMatchObject({ code: "STOPPED" });
    await Bun.sleep(20);
    expect(server.events.filter((e) => e.type === "key" && e.down)).toEqual([]);
  });

  test("限速发生在按下与抬起之间：自动抬起，不卡键", async () => {
    const { server, computer } = await setup({ maxEventsPerMinute: 3 });
    computer.resume("user");
    await expect(computer.keyPress({ key: "cmd+shift+a" }, "agent")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await Bun.sleep(20);
    const downs = server.events.filter((e) => e.type === "key" && e.down).length;
    const ups = server.events.filter((e) => e.type === "key" && !e.down).length;
    expect(downs).toBe(3);
    expect(ups).toBe(3);
    expect(computer.state().heldButtons).toEqual([]);
  });

  test("断线后排队中的操作被取消，新操作重连后正常", async () => {
    let gate: (() => void) | null = null;
    const { server, computer } = await setup({
      minEventIntervalMs: 1,
      sleep: () => new Promise<void>((resolve) => (gate = resolve)),
    });
    computer.resume("user");
    await computer.screenshot({}, "user");
    const first = computer.typeText({ text: "abc" }, "agent");
    const queued = computer.typeText({ text: "def" }, "agent");
    await waitFor(() => gate !== null);
    server.dropConnections();
    await Bun.sleep(30);
    gate!();
    await expect(first).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    await expect(queued).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    const before = server.connections;
    const shot = await computer.screenshot({}, "user");
    expect(shot.sourceWidth).toBe(200);
    expect(server.connections).toBe(before + 1);
  });

  test("连接途中 close()：迟到的连接被丢弃", async () => {
    server = await FakeRfbServer.start();
    const port = server.port;
    let release!: () => void;
    let created: RfbDisplayInput | null = null;
    computer = new AgentComputer({
      connectDisplay: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        created = await RfbDisplayInput.connect({ host: "127.0.0.1", port }, caps, STANDARD_MODIFIERS);
        return created;
      },
    });
    const pending = computer.screenshot({}, "user");
    await waitFor(() => release !== undefined);
    computer.close();
    release();
    await expect(pending).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    await waitFor(() => created!.closed); // socket 关闭是异步完成的
  });

  /** 把长计时器压缩成立即触发，并保证无论测试结果如何都还原。 */
  async function withFastTimers(threshold: number, body: () => Promise<void>) {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, ms && ms >= threshold ? 1 : ms)) as typeof setTimeout;
    try {
      await body();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  }

  function vzComputer(port: number, setClipboard: (text: string, signal: AbortSignal) => Promise<void>) {
    return new AgentComputer({
      connectDisplay: () =>
        RfbDisplayInput.connect({ host: "127.0.0.1", port }, { unicodeText: false, physicalKeys: true, loginScreen: true }, VZ_MACOS_MODIFIERS),
      textHelper: { setClipboard },
      minEventIntervalMs: 0,
    });
  }

  test("客体辅助调用超时：经 signal 取消后才放行队列", async () => {
    server = await FakeRfbServer.start();
    let cancelled = false;
    computer = vzComputer(server.port, (_text, signal) =>
      new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("aborted"));
        }),
      ),
    );
    computer.resume("user");
    await computer.screenshot({}, "user");
    await withFastTimers(15_000, async () => {
      await expect(computer!.typeText({ text: "中文" }, "agent")).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
    });
    expect(cancelled).toBe(true);
    await computer.keyPress({ key: "a" }, "agent");
  });

  test("紧急停止会中止进行中的辅助调用", async () => {
    server = await FakeRfbServer.start();
    let cancelled = false;
    let started = false;
    computer = vzComputer(server.port, (_text, signal) =>
      new Promise<void>((_, reject) => {
        started = true;
        signal.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("aborted"));
        });
      }),
    );
    computer.resume("user");
    const typing = computer.typeText({ text: "中文" }, "agent");
    await waitFor(() => started);
    await computer.stop("user");
    await expect(typing).rejects.toMatchObject({ code: "STOPPED" });
    expect(cancelled).toBe(true);
  });

  test("辅助调用不响应取消：报错并停用剪贴板通道", async () => {
    server = await FakeRfbServer.start();
    computer = vzComputer(server.port, () => new Promise<void>(() => undefined));
    computer.resume("user");
    await computer.screenshot({}, "user"); // 先建立连接，避免加速计时器压缩握手超时
    await withFastTimers(5_000, async () => {
      await expect(computer!.typeText({ text: "中文" }, "agent")).rejects.toMatchObject({ code: "INTERNAL" });
    });
    await expect(computer.typeText({ text: "再来" }, "agent")).rejects.toMatchObject({ code: "UNSUPPORTED_ON_VM" });
    await computer.typeText({ text: "ascii ok" }, "agent");
  });
});

describe("输入", () => {
  test("组合键按顺序按下、逆序抬起", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.keyPress({ key: "cmd+shift+a" }, "agent");
    await waitFor(() => server.events.length === 6);
    expect(server.events.map((event) => (event.type === "key" ? [event.keysym, event.down] : null))).toEqual([
      [0xffeb, true],
      [0xffe1, true],
      [0x61, true],
      [0x61, false],
      [0xffe1, false],
      [0xffeb, false],
    ]);
  });

  test("中文按 Unicode keysym 发送", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.typeText({ text: "你好\n" }, "agent");
    await waitFor(() => server.events.length === 6);
    expect(server.events.filter((e) => e.type === "key" && e.down).map((e) => (e as { keysym: number }).keysym)).toEqual([
      0x01004f60, 0x0100597d, 0xff0d,
    ]);
  });

  test("显示通道不支持 Unicode 时拒绝中文，不发半截", async () => {
    server = await FakeRfbServer.start();
    const port = server.port;
    computer = new AgentComputer({
      connectDisplay: () => RfbDisplayInput.connect({ host: "127.0.0.1", port }, { unicodeText: false, physicalKeys: true, loginScreen: true }, VZ_MACOS_MODIFIERS),
      minEventIntervalMs: 0,
    });
    computer.resume("user");
    await expect(computer.typeText({ text: "ab中" }, "agent")).rejects.toMatchObject({ code: "UNSUPPORTED_ON_VM" });
    await Bun.sleep(20);
    expect(server.events).toEqual([]);
  });

  test("物理键通道：大写与符号补 Shift，组合键用 VZ 修饰键映射", async () => {
    server = await FakeRfbServer.start();
    const port = server.port;
    computer = new AgentComputer({
      connectDisplay: () =>
        RfbDisplayInput.connect({ host: "127.0.0.1", port }, { unicodeText: false, physicalKeys: true, loginScreen: true }, VZ_MACOS_MODIFIERS),
      minEventIntervalMs: 0,
    });
    computer.resume("user");
    await computer.typeText({ text: "aA!" }, "agent");
    await computer.keyPress({ key: "cmd+c" }, "agent");
    await waitFor(() => server!.events.length === 14);
    const keys = server.events.map((e) => (e.type === "key" ? `${e.down ? "+" : "-"}${e.keysym.toString(16)}` : ""));
    expect(keys).toEqual([
      "+61", "-61",
      "+ffe1", "+61", "-61", "-ffe1",
      "+ffe1", "+31", "-31", "-ffe1",
      "+ffe9", "+63", "-63", "-ffe9",
    ]);
  });

  test("键盘打不出的文字：写客体剪贴板后按 Cmd+V", async () => {
    server = await FakeRfbServer.start();
    const port = server.port;
    const pasted: string[] = [];
    computer = new AgentComputer({
      connectDisplay: () =>
        RfbDisplayInput.connect({ host: "127.0.0.1", port }, { unicodeText: false, physicalKeys: true, loginScreen: true }, VZ_MACOS_MODIFIERS),
      textHelper: { setClipboard: async (text) => void pasted.push(text) },
      minEventIntervalMs: 0,
    });
    computer.resume("user");
    await computer.typeText({ text: "你好 Agent😀" }, "agent");
    expect(pasted).toEqual(["你好 Agent😀"]);
    await waitFor(() => server!.events.length === 4);
    expect(server.events.map((e) => (e.type === "key" ? [e.keysym, e.down] : null))).toEqual([
      [0xffe9, true], [0x76, true], [0x76, false], [0xffe9, false],
    ]);
    expect(computer.state().trace[0]).toMatchObject({ summary: "粘贴输入 9 个字符", ok: true });
  });

  test("写剪贴板期间紧急停止：不再按粘贴键", async () => {
    server = await FakeRfbServer.start();
    const port = server.port;
    let release!: () => void;
    computer = new AgentComputer({
      connectDisplay: () =>
        RfbDisplayInput.connect({ host: "127.0.0.1", port }, { unicodeText: false, physicalKeys: true, loginScreen: true }, VZ_MACOS_MODIFIERS),
      textHelper: { setClipboard: () => new Promise<void>((resolve) => (release = resolve)) },
      minEventIntervalMs: 0,
    });
    computer.resume("user");
    const typing = computer.typeText({ text: "中文" }, "agent");
    await waitFor(() => release !== undefined);
    await computer.stop("user");
    release();
    await expect(typing).rejects.toMatchObject({ code: "STOPPED" });
    await Bun.sleep(20);
    expect(server.events).toEqual([]);
  });

  test("滚动按像素换算滚轮格数", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.scroll({ dy: 120, x: 50, y: 50 }, "agent");
    await waitFor(() => server.events.length === 6);
    expect(server.events.filter((e) => e.type === "pointer" && e.mask === 16)).toHaveLength(3);
  });

  test("拖拽：按下、插值移动、抬起", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.drag({ fromX: 0, fromY: 0, toX: 100, toY: 50 }, "agent");
    await waitFor(() => server.events.length === 13);
    expect(server.events[1]).toEqual({ type: "pointer", x: 0, y: 0, mask: 1 });
    expect(server.events.at(-1)).toEqual({ type: "pointer", x: 100, y: 50, mask: 0 });
  });

  test("参数校验：越界坐标、非法按钮、空文字、未知按键", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await expect(computer.click({ x: 200, y: 0 }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(computer.click({ x: "1", y: 0 }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(computer.click({ x: 1, y: 1, button: "side" }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(computer.typeText({ text: "" }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(computer.keyPress({ key: "hyper+x" }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(computer.scroll({}, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await Bun.sleep(20);
    expect(server.events).toEqual([]);
  });

  test("速率上限按底层事件计，长文本不能绕过", async () => {
    const { computer } = await setup({ maxEventsPerMinute: 10 });
    computer.resume("user");
    await expect(computer.typeText({ text: "abcdefghij" }, "agent")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("单次文字长度上限", async () => {
    const { computer } = await setup({ maxTextLength: 5 });
    computer.resume("user");
    await expect(computer.typeText({ text: "123456" }, "agent")).rejects.toBeInstanceOf(ComputerError);
  });
});

describe("积压保护", () => {
  test("排队操作超过上限：新请求被拒", async () => {
    const gates: Array<() => void> = [];
    const { computer } = await setup({
      minEventIntervalMs: 1,
      sleep: () => new Promise<void>((resolve) => gates.push(resolve)),
    });
    computer.resume("user");
    const pending = Array.from({ length: 32 }, () => computer.keyPress({ key: "a" }, "agent").catch(() => undefined));
    await expect(computer.keyPress({ key: "b" }, "agent")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await computer.stop("user");
    for (const release of gates) release();
    await Promise.all(pending);
  });

  test("超长文字入队前就被拒，不占队列", async () => {
    const { computer } = await setup({ maxTextLength: 5 });
    computer.resume("user");
    await expect(computer.typeText({ text: "x".repeat(100) }, "agent")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await computer.keyPress({ key: "a" }, "agent");
  });

  test("抓取进行中发生了输入：之后的截图不复用旧画面，重新抓取", async () => {
    const { server, computer } = await setup();
    computer.resume("user");
    await computer.screenshot({}, "user");
    server.frameDelayMs = 80;
    const before = server.frameRequests;
    const first = computer.screenshot({}, "agent");
    await Bun.sleep(10);
    await computer.keyPress({ key: "a" }, "agent");
    const second = computer.screenshot({}, "agent");
    await Promise.all([first, second]);
    expect(server.frameRequests - before).toBe(2);
  });

  test("并发截图共享同一次抓取", async () => {
    const { server, computer } = await setup();
    await computer.screenshot({}, "user");
    const before = server.frameRequests;
    await Promise.all([computer.screenshot({}, "agent"), computer.screenshot({}, "agent"), computer.screenshot({}, "agent")]);
    expect(server.frameRequests - before).toBe(1);
  });
});

describe("截图与审计", () => {
  test("maxEdge 缩小编码尺寸，sourceWidth 保持屏幕尺寸", async () => {
    const { computer } = await setup();
    const shot = await computer.screenshot({ maxEdge: 100 }, "agent");
    expect(shot).toMatchObject({ mime: "image/png", width: 100, height: 50, sourceWidth: 200, sourceHeight: 100, originX: 0, originY: 0 });
    expect(Buffer.from(shot.dataBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  test("审计倒序、记录来源，文字输入不记内容", async () => {
    const { computer } = await setup();
    computer.resume("user");
    await computer.typeText({ text: "secret-token" }, "agent");
    const trace = computer.state().trace;
    expect(trace[0]).toMatchObject({ action: "text.type", source: "agent", ok: true, summary: "输入 12 个字符" });
    expect(trace[1]).toMatchObject({ action: "resume", source: "user" });
    expect(JSON.stringify(trace)).not.toContain("secret-token");
  });

  test("显示连不上报 DISPLAY_UNAVAILABLE", async () => {
    computer = new AgentComputer({ connectDisplay: () => RfbDisplayInput.connect({ host: "127.0.0.1", port: 1 }, caps, STANDARD_MODIFIERS) });
    await expect(computer.screenshot({}, "agent")).rejects.toMatchObject({ code: "DISPLAY_UNAVAILABLE" });
  });
});
