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
  /**
   * 窗格不可见（切到其他标签）时释放 WebGL 上下文。浏览器对同一页面的 WebGL 上下文数有上限
   * （WebKit 为 16），后台窗格一直占着会把可见窗格的上下文挤掉。
   */
  suspend(): void;
  /** 窗格重新可见时重新获取 WebGL，并重置重建次数；未挂起时不做任何事。 */
  resume(): void;
  /** 只停止重建；已加载的 WebGL 插件随 terminal.dispose() 一起释放。 */
  dispose(): void;
}

const RESTORE_DELAY_MS = 1000;

/** addon-webgl 0.19 没有公开上下文；按内部字段读取，读不到时只是退回等待回收。 */
function webglContext(addon: WebglRendererAddon | null): WebGL2RenderingContext | undefined {
  const gl = (addon as { _renderer?: { _gl?: unknown } } | null)?._renderer?._gl;
  return gl && typeof (gl as WebGL2RenderingContext).getExtension === "function" ? gl as WebGL2RenderingContext : undefined;
}

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
  let suspended = false;
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

  const cancelRestore = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const release = (freeContext = false) => {
    lossListener?.dispose();
    lossListener = null;
    const current = addon;
    addon = null;
    // 插件释放时不主动交还上下文，要等垃圾回收；挂起时显式交还，名额才能立刻给可见窗格用。
    if (freeContext) {
      try { webglContext(current)?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 交还失败时等待回收 */ }
    }
    // 释放 WebGL 插件后 xterm 会自动换回 DOM 渲染器，先保证输出不中断。
    try { current?.dispose(); } catch { /* 上下文已丢失时释放可能抛错 */ }
    setKind("dom");
  };

  const restore = () => {
    timer = null;
    if (disposed || suspended) return;
    // 成功的重建也计入次数，避免上下文反复刚建即丢时无限重试；稳定运行后才清零。
    failures += 1;
    if (load()) terminal.refresh(0, terminal.rows - 1);
    else if (failures < maxRestoreAttempts) schedule();
  };

  const schedule = () => {
    timer = setTimer(restore, RESTORE_DELAY_MS * 2 ** Math.max(0, failures - 1));
  };

  function handleContextLoss() {
    release();
    if (disposed || suspended) return;
    if (now() - loadedAt >= stableMs) failures = 0;
    if (failures < maxRestoreAttempts) schedule();
  }

  load();
  return {
    get kind() { return kind; },
    suspend() {
      if (disposed || suspended) return;
      suspended = true;
      cancelRestore();
      release(true);
    },
    resume() {
      if (disposed || !suspended) return;
      suspended = false;
      failures = 0;
      if (load()) terminal.refresh(0, terminal.rows - 1);
    },
    dispose() {
      disposed = true;
      lossListener?.dispose();
      lossListener = null;
      cancelRestore();
    },
  };
}
