import { WebglAddon } from "@xterm/addon-webgl";
import type { ITerminalAddon } from "@xterm/xterm";

// 宿主插件页的 CSP 只放行资源与 nonce 样式，xterm DOM 渲染器运行时注入的 <style>
// （ANSI 颜色类、字体、行尺寸）会被拦下。WebGL 渲染直接在画布上绘制颜色，不依赖注入样式；
// 不支持 WebGL2 或上下文多次重建失败时退回 DOM 渲染，保持原有行为。
export type TerminalRendererKind = "webgl" | "dom";

export interface WebglRendererAddon extends ITerminalAddon {
  onContextLoss(listener: () => void): { dispose(): void };
}

export interface TerminalRendererHost {
  readonly rows: number;
  loadAddon(addon: never): void;
  refresh(start: number, end: number): void;
}

export interface TerminalRendererOptions {
  createWebgl?: () => WebglRendererAddon;
  /** 上下文丢失后的重建次数上限（WebGL 稳定运行后清零），用完后停在 DOM 渲染。 */
  maxRestoreAttempts?: number;
  /** WebGL 稳定运行超过这段时间后再丢失上下文，重新计算失败次数。 */
  stableMs?: number;
  onChange?: (kind: TerminalRendererKind) => void;
  setTimer?: (run: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  now?: () => number;
}

export interface TerminalRendererHandle {
  readonly kind: TerminalRendererKind;
  /** 只停止重建；已加载的 WebGL 插件随 terminal.dispose() 一起释放。 */
  dispose(): void;
}

const RESTORE_DELAY_MS = 1000;

/** 必须在 terminal.open() 之后调用，WebGL 初始化失败才能在这里被捕获并降级。 */
export function attachTerminalRenderer(terminal: TerminalRendererHost, options: TerminalRendererOptions = {}): TerminalRendererHandle {
  const createWebgl = options.createWebgl ?? (() => new WebglAddon());
  const maxRestoreAttempts = options.maxRestoreAttempts ?? 3;
  const stableMs = options.stableMs ?? 60_000;
  const setTimer = options.setTimer ?? ((run, delay) => setTimeout(run, delay));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  let kind: TerminalRendererKind = "dom";
  let addon: WebglRendererAddon | null = null;
  let lossListener: { dispose(): void } | null = null;
  let timer: unknown = null;
  let failures = 0;
  let loadedAt = 0;
  let disposed = false;

  const setKind = (next: TerminalRendererKind) => {
    if (next === kind) return;
    kind = next;
    options.onChange?.(next);
  };

  const load = (): boolean => {
    let candidate: WebglRendererAddon | null = null;
    try {
      candidate = createWebgl();
      terminal.loadAddon(candidate as never);
    } catch {
      try { candidate?.dispose(); } catch { /* 插件未完成激活时释放失败可忽略 */ }
      return false;
    }
    addon = candidate;
    loadedAt = now();
    lossListener = candidate.onContextLoss(handleContextLoss);
    setKind("webgl");
    return true;
  };

  const restore = () => {
    timer = null;
    if (disposed) return;
    // 成功的重建也计入次数，避免上下文反复刚建即丢时无限重试；稳定运行后才清零。
    failures += 1;
    if (load()) terminal.refresh(0, terminal.rows - 1);
    else if (failures < maxRestoreAttempts) schedule();
  };

  const schedule = () => {
    timer = setTimer(restore, RESTORE_DELAY_MS * 2 ** Math.max(0, failures - 1));
  };

  function handleContextLoss() {
    lossListener?.dispose();
    lossListener = null;
    const lost = addon;
    addon = null;
    // 释放 WebGL 插件后 xterm 会自动换回 DOM 渲染器，先保证输出不中断。
    try { lost?.dispose(); } catch { /* 上下文已丢失时释放可能抛错 */ }
    setKind("dom");
    if (disposed) return;
    if (now() - loadedAt >= stableMs) failures = 0;
    if (failures < maxRestoreAttempts) schedule();
  }

  load();
  return {
    get kind() { return kind; },
    dispose() {
      disposed = true;
      lossListener?.dispose();
      lossListener = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
