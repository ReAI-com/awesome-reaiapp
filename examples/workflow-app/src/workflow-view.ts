import type { LocaleClient } from "@reai/app-sdk/v1";
import { createMessages } from "./i18n";
import { WorkflowError, type RunClient, type RunStatus } from "./run-client";

/** One mounted Surface owns its requests; unmount aborts HTTP only, never a paid cloud run. */
export function mountWorkflowView(root: HTMLElement, client: RunClient, locale?: LocaleClient, configured = true) {
  const doc = root.ownerDocument;
  const messages = createMessages(locale);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, key?: string) => {
    const node = doc.createElement(tag); if (key) node.dataset.i18n = key; return node;
  };
  const frame = el("section"); frame.className = "plugin-main-frame";
  const page = el("main"); page.className = "main-body";
  const note = el("p", configured ? "help" : "configure"); note.className = "workflow-note";
  const form = el("div"); form.className = "workflow-card";
  function field(key: string, name: string, multiline = false) {
    const label = el("label", key); label.htmlFor = `workflow-${name}`;
    const input = multiline ? el("textarea") : el("input"); input.id = label.htmlFor; input.dataset.field = name;
    input.spellcheck = false; input.setAttribute("autocomplete", "off");
    form.append(label, input); return input;
  }
  const documentId = field("document", "document");
  const inputs = field("inputs", "inputs", true); inputs.value = '{"text":""}';
  const start = el("button", "start"); start.dataset.action = "start"; start.className = "primary";
  const progress = el("p"); progress.setAttribute("role", "status"); progress.setAttribute("aria-live", "polite"); progress.dataset.workflowStatus = "idle";
  const identity = el("p"); identity.className = "workflow-identity";
  const controls = el("div"); controls.className = "workflow-controls";
  const refresh = el("button", "refresh"); refresh.dataset.action = "refresh";
  const cancel = el("button", "cancel"); cancel.dataset.action = "cancel";
  controls.append(start, refresh, cancel);
  const askKey = field("askKey", "ask-key"); const answer = field("answer", "answer", true);
  const resume = el("button", "resume"); resume.dataset.action = "resume";
  const continuationNote = el("p", "askHelp"); continuationNote.className = "workflow-note";
  const resultLabel = el("label", "result"); resultLabel.htmlFor = "workflow-result";
  const result = el("pre"); result.id = resultLabel.htmlFor; result.dataset.workflowResult = ""; result.tabIndex = 0;
  form.append(controls, progress, identity, continuationNote, resume, resultLabel, result);
  page.append(note, form); frame.append(page); root.replaceChildren(frame);

  let disposed = false;
  let controller: AbortController | undefined;
  let runId = "";
  let status: RunStatus | "idle" = "idle";
  let notice: "idle" | "busy" | "created" | "read" | "resumed" | "cancelling" | "cancelled" | "terminal" | "uncertain" | "failed" = "idle";
  let errorCode = "";
  // A resume/cancel whose outcome is unknown may already have been accepted: block another resume until a successful read confirms the run state.
  let mutationUnconfirmed = false;
  const requestId = crypto.randomUUID();
  let creation: { documentId: string; inputs: Record<string, unknown> } | undefined;
  const render = () => {
    if (disposed) return;
    for (const node of Array.from(root.querySelectorAll<HTMLElement>("[data-i18n]"))) node.textContent = messages.t(node.dataset.i18n as Parameters<typeof messages.t>[0]);
    start.textContent = messages.t(creation && !runId ? "retry" : "start");
    progress.textContent = `${messages.t(notice)}${errorCode ? ` · ${errorCode}` : ""}`;
    progress.dataset.workflowStatus = notice;
    identity.textContent = `${messages.t("request")}: ${requestId}${runId ? `\nRun: ${runId} · ${messages.t(status)}` : ""}`;
    start.disabled = !configured || !!controller || !!runId;
    documentId.disabled = inputs.disabled = !!creation || !!controller || !configured;
    refresh.disabled = cancel.disabled = !configured || !!controller || !runId;
    resume.disabled = !configured || !!controller || !runId || mutationUnconfirmed || !["success", "interrupted"].includes(status);
    askKey.disabled = answer.disabled = !!controller || !configured;
    root.setAttribute("aria-busy", String(!!controller));
  };
  async function act(action: "start" | "refresh" | "resume" | "cancel") {
    if (disposed || controller || !configured) return;
    const abort = new AbortController(); controller = abort; notice = "busy"; errorCode = ""; render();
    try {
      if (action === "start") {
        if (!creation) {
          const value: unknown = JSON.parse(inputs.value);
          if (!value || typeof value !== "object" || Array.isArray(value) || !documentId.value.trim()) throw new WorkflowError("WORKFLOW_INPUT_INVALID");
          creation = { documentId: documentId.value.trim(), inputs: value as Record<string, unknown> };
        }
        const response = await client.create(creation.documentId, creation.inputs, requestId, abort.signal);
        if (disposed) return; runId = response.runId; status = "running"; notice = "created";
      } else if (action === "refresh") {
        const response = await client.read(runId, abort.signal);
        if (disposed) return; status = response.status; notice = "read"; mutationUnconfirmed = false;
        // Structured workflow output is JSON, never injected HTML or executable Markdown.
        result.textContent = JSON.stringify(response.data.output ?? null, null, 2);
      } else if (action === "resume") {
        await client.resume(runId, askKey.value.trim(), answer.value, abort.signal);
        if (disposed) return; status = "running"; notice = "resumed"; result.textContent = "";
      } else {
        const response = await client.cancel(runId, abort.signal);
        if (disposed) return;
        notice = response.status === "cancelling" ? "cancelling" : response.status === "cancelled" ? "cancelled" : "terminal";
        if (response.status !== "cancelling") status = response.status as RunStatus;
      }
    } catch (error) {
      if (disposed) return;
      errorCode = error instanceof WorkflowError ? error.code : "WORKFLOW_INPUT_INVALID";
      notice = error instanceof WorkflowError && error.uncertain ? "uncertain" : "failed";
      // A deterministic rejected create has no accepted run: inputs can be corrected with the same request key.
      if (action === "start" && notice === "failed") creation = undefined;
      if ((action === "resume" || action === "cancel") && notice === "uncertain") mutationUnconfirmed = true;
    } finally { if (!disposed) { controller = undefined; render(); } }
  }
  const buttons = [start, refresh, resume, cancel];
  const handlers = buttons.map(button => () => { void act(button.dataset.action as Parameters<typeof act>[0]); });
  buttons.forEach((button, i) => button.addEventListener("click", handlers[i]!));
  render(); const stopLocale = messages.subscribe(render);
  return () => {
    disposed = true; controller?.abort(); stopLocale();
    buttons.forEach((button, i) => button.removeEventListener("click", handlers[i]!));
    root.removeAttribute("aria-busy"); root.replaceChildren();
  };
}
