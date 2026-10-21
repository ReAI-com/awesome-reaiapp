/**
 * PageSpec v0 渲染器：只用 DOM API 按 JSON 造界面，按钮动作只走白名单，由插件代码执行。
 */
import { h } from "./dom";
import { describeError } from "./errors";
import type { Binding, PageAction, PageComponent, PageSpec } from "./page-spec";
import type { KvPort } from "./port";
import { OUTCOME_LABELS, type ProbeResult } from "./probes";

/** 页面动作自己的、可以直接给用户看的失败原因。 */
export class PageActionError extends Error {}

export interface PageEnv {
  kv: KvPort;
  /** Host 开发者模式：开着才显示错误码。 */
  developerMode(): boolean;
  runProbe(probeId: string): Promise<ProbeResult>;
  lastResult(probeId: string): ProbeResult | undefined;
  notify(title: string, body: string): Promise<void>;
}

export interface RenderedPage {
  refresh(): Promise<void>;
  dispose(): void;
}

function describeValue(value: unknown): string {
  if (value === undefined || value === null) return "（还没有）";
  if (typeof value === "string") return value || "（空）";
  return JSON.stringify(value);
}

export function renderPage(container: HTMLElement, spec: PageSpec, env: PageEnv): RenderedPage {
  const doc = container.ownerDocument;
  let disposed = false;
  const refreshers: (() => Promise<void>)[] = [];

  const readBinding = async (binding: Binding): Promise<{ text: string; items: string[] }> => {
    if (binding.source === "kv.value") {
      const value = await env.kv.get(binding.key);
      return { text: describeValue(value), items: Array.isArray(value) ? value.map(describeValue) : [describeValue(value)] };
    }
    if (binding.source === "kv.keys") {
      const keys = (await env.kv.keys()).filter((key) => key.startsWith("page.")).sort();
      return { text: `${keys.length} 个`, items: keys.length > 0 ? keys : ["（还没有）"] };
    }
    const result = env.lastResult(binding.probeId);
    const text = result ? `${OUTCOME_LABELS[result.outcome]}：${result.summary}` : "（还没测过）";
    return { text, items: [text] };
  };

  const runAction = async (action: PageAction, form?: HTMLFormElement): Promise<string> => {
    switch (action.type) {
      case "kv.set": {
        let value = action.value;
        if (action.fromField !== undefined) {
          // fromField 已按 id 规则校验过（小写字母、数字、短横线），可以直接拼进选择器。
          value = form?.querySelector<HTMLInputElement>(`input[name="${action.fromField}"]`)?.value.trim() ?? "";
          if (!value) throw new PageActionError("请先填写内容");
        }
        await env.kv.set(action.key, value);
        return "已保存";
      }
      case "kv.delete":
        await env.kv.delete(action.key);
        return "已清空";
      case "probe.run": {
        const result = await env.runProbe(action.probeId);
        return `${OUTCOME_LABELS[result.outcome]}：${result.summary}`;
      }
      case "notify.post":
        await env.notify(action.title, action.body);
        return "通知已交给 Driver";
    }
  };

  const actionControl = (button: HTMLButtonElement, status: HTMLElement, action: PageAction, label: string, form?: HTMLFormElement) => {
    let armed = false;
    let armTimer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const disarm = () => {
      armed = false;
      if (armTimer !== undefined) clearTimeout(armTimer);
      armTimer = undefined;
      if (!disposed && !busy) button.textContent = label;
    };
    const perform = async () => {
      if (busy) return;
      if (action.type === "notify.post" && !armed) {
        // 发通知要再点一次确认；5 秒内没确认就恢复原样。
        armed = true;
        button.textContent = "再点一次确认发送";
        armTimer = setTimeout(disarm, 5000);
        return;
      }
      disarm();
      busy = true;
      button.disabled = true;
      button.textContent = "进行中…";
      status.textContent = "";
      status.dataset.tone = "";
      try {
        status.textContent = await runAction(action, form);
        status.dataset.tone = "ok";
        await refresh();
      } catch (error) {
        if (error instanceof PageActionError) {
          status.textContent = error.message;
        } else {
          const { code } = describeError(error);
          status.textContent = env.developerMode() ? `操作失败（${code}）` : "操作失败，请稍后重试";
        }
        status.dataset.tone = "error";
      } finally {
        busy = false;
        if (!disposed) {
          button.disabled = false;
          button.textContent = label;
        }
      }
    };
    return perform;
  };

  const componentNode = (component: PageComponent): HTMLElement => {
    switch (component.kind) {
      case "text":
        return h(doc, "p", { className: "cp-page-text", text: component.text });
      case "metric": {
        const value = h(doc, "strong", { className: "cp-page-metric-value", text: "…" });
        refreshers.push(async () => { value.textContent = (await readBinding(component.bind)).text; });
        return h(doc, "div", { className: "cp-page-metric" }, h(doc, "span", { className: "cp-page-label", text: component.label }), value);
      }
      case "list": {
        const list = h(doc, "ul", { className: "cp-page-list" });
        refreshers.push(async () => {
          const { items } = await readBinding(component.bind);
          list.replaceChildren(...items.map((item) => h(doc, "li", { text: item })));
        });
        return h(doc, "div", { className: "cp-page-block" }, h(doc, "span", { className: "cp-page-label", text: component.label }), list);
      }
      case "button": {
        const button = h(doc, "button", { className: "cp-btn cp-btn--secondary", text: component.label, attrs: { type: "button" } });
        const status = h(doc, "span", { className: "cp-page-status", attrs: { role: "status" } });
        const perform = actionControl(button, status, component.action, component.label);
        button.addEventListener("click", () => void perform());
        return h(doc, "div", { className: "cp-page-row" }, button, status);
      }
      case "form": {
        const form = h(doc, "form", { className: "cp-page-form" });
        form.append(h(doc, "span", { className: "cp-page-label", text: component.label }));
        for (const field of component.fields) {
          const input = h(doc, "input", { className: "cp-input", attrs: { name: field.id, type: "text", maxlength: "200", "aria-label": field.label, placeholder: field.label } });
          form.append(h(doc, "label", { className: "cp-page-field" }, h(doc, "span", { text: field.label }), input));
        }
        const submit = h(doc, "button", { className: "cp-btn cp-btn--secondary", text: component.submitLabel, attrs: { type: "submit" } });
        const status = h(doc, "span", { className: "cp-page-status", attrs: { role: "status" } });
        const perform = actionControl(submit, status, component.action, component.submitLabel, form);
        form.addEventListener("submit", (event) => { event.preventDefault(); void perform(); });
        form.append(h(doc, "div", { className: "cp-page-row" }, submit, status));
        return form;
      }
    }
  };

  const page = h(doc, "section", { className: "cp-page-canvas", attrs: { "aria-label": spec.title } }, h(doc, "h3", { className: "cp-page-title", text: spec.title }));
  for (const component of spec.components) page.append(componentNode(component));
  container.replaceChildren(page);

  async function refresh(): Promise<void> {
    for (const refresher of refreshers) {
      if (disposed) return;
      try {
        await refresher();
      } catch {
        // 单个绑定读失败不影响其他组件；下一次刷新再试。
      }
    }
  }
  void refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}
