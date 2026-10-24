import { expect, test } from "bun:test";
import { attachTerminalRenderer, type WebglRendererAddon } from "../src/terminal-renderer";

class FakeAddon implements WebglRendererAddon {
  disposed = false;
  private lost: Array<() => void> = [];
  activate() {}
  onContextLoss(listener: () => void) {
    this.lost.push(listener);
    return { dispose: () => { this.lost = this.lost.filter((item) => item !== listener); } };
  }
  loseContext() { for (const listener of [...this.lost]) listener(); }
  dispose() { this.disposed = true; }
}

function fakeTerminal(failLoad = 0) {
  let failures = failLoad;
  const loaded: FakeAddon[] = [];
  const refreshes: number[] = [];
  return {
    rows: 24,
    loaded,
    refreshes,
    loadAddon(addon: FakeAddon) {
      if (failures > 0) { failures -= 1; throw new Error("WebGL2 not supported"); }
      loaded.push(addon);
    },
    refresh(start: number, end: number) { refreshes.push(end - start); },
  };
}

function manualTimers() {
  const queue: Array<{ run: () => void; delay: number }> = [];
  return {
    queue,
    setTimer: (run: () => void, delay: number) => { const entry = { run, delay }; queue.push(entry); return entry; },
    clearTimer: (entry: unknown) => { const index = queue.indexOf(entry as never); if (index >= 0) queue.splice(index, 1); },
    flush() { for (const entry of queue.splice(0)) entry.run(); },
  };
}

test("WebGL 可用时使用 WebGL 渲染", () => {
  const terminal = fakeTerminal();
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => new FakeAddon() });
  expect(handle.kind).toBe("webgl");
  expect(terminal.loaded).toHaveLength(1);
});

test("WebGL 创建失败时保持 DOM 渲染", () => {
  const terminal = fakeTerminal();
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => { throw new Error("no webgl"); } });
  expect(handle.kind).toBe("dom");
});

test("加载 WebGL 失败时释放插件并回到 DOM", () => {
  const terminal = fakeTerminal(1);
  const created: FakeAddon[] = [];
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => { const addon = new FakeAddon(); created.push(addon); return addon; } });
  expect(handle.kind).toBe("dom");
  expect(created[0]!.disposed).toBe(true);
});

test("上下文丢失后释放 WebGL，稍后重建并重绘", () => {
  const terminal = fakeTerminal();
  const timers = manualTimers();
  const changes: string[] = [];
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => new FakeAddon(), ...timers, onChange: (kind) => changes.push(kind) });
  const first = terminal.loaded[0]!;
  first.loseContext();
  expect(first.disposed).toBe(true);
  expect(handle.kind).toBe("dom");
  timers.flush();
  expect(handle.kind).toBe("webgl");
  expect(terminal.loaded).toHaveLength(2);
  expect(terminal.refreshes.at(-1)).toBe(23);
  expect(changes).toEqual(["webgl", "dom", "webgl"]);
});

test("重建连续失败达到上限后停在 DOM，不再重试", () => {
  const terminal = fakeTerminal();
  const timers = manualTimers();
  let attempts = 0;
  const handle = attachTerminalRenderer(terminal, {
    createWebgl: () => { attempts += 1; if (attempts > 1) throw new Error("context unavailable"); return new FakeAddon(); },
    maxRestoreAttempts: 2,
    ...timers,
  });
  terminal.loaded[0]!.loseContext();
  timers.flush();
  timers.flush();
  timers.flush();
  expect(attempts).toBe(3);
  expect(timers.queue).toHaveLength(0);
  expect(handle.kind).toBe("dom");
});

test("上下文刚重建就反复丢失时不会无限重试", () => {
  const terminal = fakeTerminal();
  const timers = manualTimers();
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => new FakeAddon(), maxRestoreAttempts: 2, ...timers });
  for (let round = 0; round < 5; round += 1) {
    terminal.loaded.at(-1)!.loseContext();
    timers.flush();
  }
  expect(terminal.loaded).toHaveLength(3);
  expect(timers.queue).toHaveLength(0);
  expect(handle.kind).toBe("dom");
});

test("WebGL 稳定运行后再丢失上下文会重新获得重建机会", () => {
  const terminal = fakeTerminal();
  const timers = manualTimers();
  let clock = 0;
  attachTerminalRenderer(terminal, { createWebgl: () => new FakeAddon(), maxRestoreAttempts: 1, stableMs: 100, now: () => clock, ...timers });
  for (let round = 0; round < 3; round += 1) {
    clock += 1000;
    terminal.loaded.at(-1)!.loseContext();
    timers.flush();
  }
  expect(terminal.loaded).toHaveLength(4);
});

test("释放句柄会取消待执行的重建，且不重复释放终端持有的插件", () => {
  const terminal = fakeTerminal();
  const timers = manualTimers();
  const handle = attachTerminalRenderer(terminal, { createWebgl: () => new FakeAddon(), ...timers });
  const addon = terminal.loaded[0]!;
  handle.dispose();
  expect(addon.disposed).toBe(false);
  addon.loseContext();
  expect(timers.queue).toHaveLength(0);
  timers.flush();
  expect(terminal.loaded).toHaveLength(1);
});
