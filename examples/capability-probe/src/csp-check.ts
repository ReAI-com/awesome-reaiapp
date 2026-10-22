/**
 * 页面脚本限制自检：在插件自己的页面里，主动尝试四种「运行时生成代码」的写法，
 * 看哪些被 Driver 的内容安全策略（CSP）拦下。只检测，不尝试绕过。
 *
 * 每种写法只做一件无害的事（给 window 设一个本次独有的标记），检查完立刻清理。
 * 在 Driver 里，四项都应该被拦；在普通浏览器预览里没有这层限制，会显示「没被拦」。
 */

export type CspCheckId = "inline" | "eval" | "blob" | "iframe";

export interface CspCheckResult {
  id: CspCheckId;
  /** true = 代码真的跑起来了（没被拦）。 */
  executed: boolean;
  /** 浏览器报告的被违反的规则，例如 script-src。并发运行时可能混入同时段的其他检查。 */
  violations: string[];
  /** 抛出的错误名称（如 EvalError），没抛为空。 */
  error?: string;
}

type ProbeWindow = Record<string, unknown>;

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

/** 等加载结束、超时或取消，三者先到为准；结束后摘掉全部监听。 */
function waitFor(target: EventTarget, events: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const finish = (reason: string) => {
      clearTimeout(timer);
      for (const name of events) target.removeEventListener(name, handlers[name]!);
      signal?.removeEventListener("abort", onAbort);
      resolve(reason);
    };
    const handlers: Record<string, () => void> = {};
    for (const name of events) {
      handlers[name] = () => finish(name);
      target.addEventListener(name, handlers[name]!);
    }
    const onAbort = () => finish("abort");
    const timer = setTimeout(() => finish("timeout"), WAIT_MS);
    signal?.addEventListener("abort", onAbort);
  });
}

function marker(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `__cpProbe_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function checkInlineScript(doc: Document): Promise<CspCheckResult> {
  const win = doc.defaultView as unknown as ProbeWindow;
  const flag = marker();
  const watch = watchViolations(doc);
  const script = doc.createElement("script");
  script.textContent = `window[${JSON.stringify(flag)}] = true;`;
  doc.head.append(script);
  script.remove();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const executed = win[flag] === true;
  delete win[flag];
  return { id: "inline", executed, violations: watch.stop() };
}

export async function checkEval(doc: Document): Promise<CspCheckResult> {
  const watch = watchViolations(doc);
  try {
    const run = new Function("return 7;") as () => number;
    const executed = run() === 7;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: "eval", executed, violations: watch.stop() };
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: "eval", executed: false, violations: watch.stop(), error: error instanceof Error ? error.name : String(error) };
  }
}

export async function checkBlobScript(doc: Document, signal?: AbortSignal): Promise<CspCheckResult> {
  const win = doc.defaultView as unknown as ProbeWindow;
  const flag = marker();
  const watch = watchViolations(doc);
  const url = URL.createObjectURL(new Blob([`window[${JSON.stringify(flag)}] = true;`], { type: "text/javascript" }));
  const script = doc.createElement("script");
  let reason = "";
  try {
    const done = waitFor(script, ["load", "error"], signal);
    script.src = url;
    doc.head.append(script);
    reason = await done;
  } finally {
    script.remove();
    URL.revokeObjectURL(url);
  }
  const executed = win[flag] === true;
  delete win[flag];
  return { id: "blob", executed, violations: watch.stop(), ...(reason === "error" ? { error: "load-error" } : {}) };
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
    const done = waitFor(frame, ["load"], signal);
    frame.src = url;
    doc.body.append(frame);
    await done;
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
