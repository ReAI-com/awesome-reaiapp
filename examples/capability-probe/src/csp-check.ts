/**
 * 页面脚本限制自检：在插件自己的页面里，主动尝试四种「运行时生成代码」的写法，
 * 看哪些被 Driver 的内容安全策略（CSP）拦下。
 *
 * 每种写法只做一件无害的事（给 window 设一个标记），检查完立刻清理。
 * 在 Driver 里，四项都应该被拦；在普通浏览器预览里没有这层限制，会显示「没被拦」。
 */

export type CspCheckId = "inline" | "eval" | "blob" | "iframe";

export interface CspCheckResult {
  id: CspCheckId;
  /** true = 代码真的跑起来了（没被拦）。 */
  executed: boolean;
  /** 浏览器报告的被违反的规则，例如 script-src。 */
  violations: string[];
  /** 抛出的错误名称（如 EvalError），没抛为空。 */
  error?: string;
}

type ProbeWindow = Window & { __cpProbeFlag?: string };

const WAIT_MS = 1500;

function watchViolations(doc: Document): { stop(): string[] } {
  const seen: string[] = [];
  const listener = (event: Event) => {
    const directive = (event as SecurityPolicyViolationEvent).effectiveDirective || (event as SecurityPolicyViolationEvent).violatedDirective;
    if (directive) seen.push(directive);
  };
  doc.addEventListener("securitypolicyviolation", listener);
  return {
    stop() {
      doc.removeEventListener("securitypolicyviolation", listener);
      return [...new Set(seen)];
    },
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function marker(): string {
  return `cp-${Math.random().toString(36).slice(2, 10)}`;
}

export async function checkInlineScript(doc: Document): Promise<CspCheckResult> {
  const win = doc.defaultView as ProbeWindow;
  const flag = marker();
  delete win.__cpProbeFlag;
  const watch = watchViolations(doc);
  const script = doc.createElement("script");
  script.textContent = `window.__cpProbeFlag = ${JSON.stringify(flag)};`;
  doc.head.append(script);
  script.remove();
  await wait(50);
  const executed = win.__cpProbeFlag === flag;
  delete win.__cpProbeFlag;
  return { id: "inline", executed, violations: watch.stop() };
}

export async function checkEval(doc: Document): Promise<CspCheckResult> {
  const watch = watchViolations(doc);
  try {
    const run = new Function("return 7;") as () => number;
    const executed = run() === 7;
    await wait(20);
    return { id: "eval", executed, violations: watch.stop() };
  } catch (error) {
    await wait(20);
    return { id: "eval", executed: false, violations: watch.stop(), error: error instanceof Error ? error.name : String(error) };
  }
}

export async function checkBlobScript(doc: Document, signal?: AbortSignal): Promise<CspCheckResult> {
  const win = doc.defaultView as ProbeWindow;
  const flag = marker();
  delete win.__cpProbeFlag;
  const watch = watchViolations(doc);
  const url = URL.createObjectURL(new Blob([`window.__cpProbeFlag = ${JSON.stringify(flag)};`], { type: "text/javascript" }));
  const script = doc.createElement("script");
  let error: string | undefined;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAIT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      script.addEventListener("load", done, { once: true });
      script.addEventListener("error", () => { error = "load-error"; done(); }, { once: true });
      signal?.addEventListener("abort", done, { once: true });
      script.src = url;
      doc.head.append(script);
    });
  } finally {
    script.remove();
    URL.revokeObjectURL(url);
  }
  const executed = win.__cpProbeFlag === flag;
  delete win.__cpProbeFlag;
  return { id: "blob", executed, violations: watch.stop(), ...(error ? { error } : {}) };
}

export async function checkIframe(doc: Document, signal?: AbortSignal): Promise<CspCheckResult> {
  const flag = marker();
  const watch = watchViolations(doc);
  const url = URL.createObjectURL(new Blob([`<!doctype html><body data-cp="${flag}"></body>`], { type: "text/html" }));
  const frame = doc.createElement("iframe");
  frame.className = "cp-hidden-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  let executed = false;
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAIT_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      frame.addEventListener("load", done, { once: true });
      signal?.addEventListener("abort", done, { once: true });
      frame.src = url;
      doc.body.append(frame);
    });
    try {
      executed = frame.contentDocument?.body?.getAttribute("data-cp") === flag;
    } catch {
      executed = false;
    }
  } finally {
    frame.remove();
    URL.revokeObjectURL(url);
  }
  return { id: "iframe", executed, violations: watch.stop() };
}
