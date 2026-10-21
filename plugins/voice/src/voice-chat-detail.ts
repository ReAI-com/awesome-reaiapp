import { type PreparedVoiceAttachment, type VoiceAttachmentTarget } from "./voice-attachment-input";
import { voiceAttachmentFormat } from "./voice-attachment-admission";
import "./voice-attachments.css";
import { VoiceAttachmentContentError, VOICE_TEXT_ATTACHMENT_POLICY, type VoiceTextAttachment, type VoiceAttachmentContentCode } from "./voice-attachment-content";
import { readVoiceDocumentAttachment } from "./voice-document-extraction";
import { confirmedVoiceAttachmentFormats, requireVoiceAttachmentAdmission } from "./voice-attachment-admission";
import { attachmentFormatsForVoiceCommand, voiceCommandAllowsAttachments } from "./voice-attachment-scene";
import { t, bindText, bindAttribute, type TextSource } from "./voice-i18n";
/**
 * 命令详情（Chat detail，A3-15/16 → R8「按 Agent 对话界面做」）。
 *
 * 结构与文案贴设计稿 `#taskChat`（design/VoiceType_UI_Designs.html）：页头是
 * emoji 头像 + 任务标题 + 角色（稿 chatAva / chatName / chatRole），中间是消息流，
 * 底部是 `[+][输入框][麦克风]` 输入坞。气泡 / 附件卡 / 输入坞三件来自共享包
 * `@reai/chat-ui`，本文件只管 Voice 的业务：会话聚合、页头身份推导、发送追问、
 * 定向听写。
 *
 * 从 voice-view.ts 拆出来单独成文件：它是 Voice 页里唯一按 Agent 对话形态长的
 * 一块，与列表 / 输入详情 / 段详情（另一条车道）互不相干，分开改互不踩。
 */
import {
  mountChatComposer,
  renderChatMessage,
  type ChatAttachment,
  type ChatComposer,
  type ChatMessage,
} from "@reai/chat-ui";
import type {
  VoiceAgentConversationRef,
  VoiceChatAttachment,
  VoiceChatMessage,
  VoiceCommandHistoryItem,
  VoiceCommandIdentity,
  VoiceViewState,
} from "./data";
import { BUILTIN_VOICE_COMMANDS } from "./voice-ai-contract";
import { conversationKey, conversationMembers } from "./agent-conversation";
import type { ResolvedAgentBackend } from "@reai/app-sdk/v1";
import type { VoiceErrorDetail } from "./data";
import { elapsedNode, errorDetailFrom, failureState, stepText, structuredToken, type VoiceDiagnosticDetail, type VoiceDiagnosticEntry } from "./voice-diagnostics";
import { mergeToolProgress, userWaitLabel } from "./voice-agent-presentation";
import { structuredCode } from "./voice-error-fields";
import { commandStepKey, interruptedLabel, stopActionLabel, stopFailedLabel } from "./voice-stop-copy";

/** 页头角色位：命令类型名（稿的 role 是 agent 身份，这里对应的就是「它是哪类命令」）。 */
const COMMAND_ROLE: Readonly<Record<string, string>> = {
  get [BUILTIN_VOICE_COMMANDS.transcribe]() { return t("chat.message1"); },
  get [BUILTIN_VOICE_COMMANDS.translate]() { return t("chat.message2"); },
  get [BUILTIN_VOICE_COMMANDS.agent]() { return t("chat.message3"); },
};

/** 页头 emoji 头像：按命令类型定，未知类型用麦克风。翻译 🌐、Agent 提问 ✨，两者不混用。 */
const COMMAND_AVATAR: Readonly<Record<string, string>> = {
  [BUILTIN_VOICE_COMMANDS.transcribe]: "📝",
  [BUILTIN_VOICE_COMMANDS.translate]: "🌐",
  [BUILTIN_VOICE_COMMANDS.agent]: "✨",
};

/**
 * 这条命令所在的会话：同一通用 Agent Session 的条目按时间正序排成一条流；
 * 迁移前只有 `dshSessionId` 的旧历史仍按旧 id 聚合。没有会话 id 时只有它自己。
 */
export function commandConversation(
  item: VoiceCommandHistoryItem,
  history: VoiceCommandHistoryItem[],
): VoiceCommandHistoryItem[] {
  // F04：同一段可见对话跨 Agent / 会话切换仍拼成一条流（conversationId 优先）。
  return conversationMembers(item, history);
}

/** 页头身份：条目自带的 identity 优先，否则由命令类型与这段会话的第一句话推出。 */
export function commandIdentity(
  item: VoiceCommandHistoryItem,
  conversation: VoiceCommandHistoryItem[],
): VoiceCommandIdentity {
  const explicit = conversation.find((entry) => entry.identity)?.identity ?? item.identity;
  if (explicit) return explicit;
  const first = conversation[0] ?? item;
  const commandId = first.commandId ?? item.commandId;
  const role = commandId !== undefined ? COMMAND_ROLE[commandId] : undefined;
  return {
    avatar: (commandId !== undefined ? COMMAND_AVATAR[commandId] : undefined) ?? "🎙️",
    title: first.transcript,
    role: item.status === "failed" ? t("chat.message4") : item.status === "running" ? t("chat.message5") : role ?? t("chat.message6"),
  };
}

/**
 * 一条历史条目展开成消息：自带 `messages` 就用它，否则从 transcript / reply 推。
 * 一条条目就是一个 Agent 回合：回合里的全部工具卡（含旧版每工具一张的卡）并成一条过程折叠。
 */
function itemMessages(item: VoiceCommandHistoryItem, developerMode: boolean): ChatMessage[] {
  if (item.messages && item.messages.length > 0) {
    return mergeToolProgress(item.messages.map(toChatMessage), item.status, developerMode);
  }
  const createdAt = Date.parse(item.createdAt);
  const messages: ChatMessage[] = [{ from: "user", text: item.transcript, at: createdAt }];
  // 回答的时间读运行时长：这条命令真的跑了那么久才回来。
  const repliedAt = createdAt + (item.durationMs ?? 0);
  if (item.status === "completed") {
    if (item.reply) messages.push({ from: "ai", text: item.reply, at: repliedAt });
    // 回退条目（errorCode + userMessage，reply 是原话）：补一条说明，把「为什么回答
    // 就是原话」讲清楚，别让人以为 Agent 只会复读。
    if (item.userMessage) messages.push({ from: "ai", format: "plain", text: item.userMessage, at: repliedAt });
  } else if (item.status === "failed") {
    messages.push({ from: "ai", format: "plain", get text() {
      return item.userMessage
        ?? (item.errorCode === "VOICE_COMMAND_INTERRUPTED" ? interruptedLabel(item.commandId) : t("chat.message4"));
    }, at: repliedAt });
  }
  // running：不画失败气泡（曾把运行中画成「执行失败」）；在做什么由消息流末尾的运行状态行说清。
  return messages;
}

function toChatAttachment(attachment: VoiceChatAttachment): ChatAttachment | undefined {
  if (attachment.kind === "file" && attachment.name !== undefined) {
    return { kind: "file", icon: attachment.icon, name: attachment.name, meta: attachment.meta };
  }
  if (attachment.kind === "image" && attachment.alt !== undefined) {
    return { kind: "image", alt: attachment.alt };
  }
  if (attachment.kind === "audio" && attachment.durationMs !== undefined) {
    return { kind: "audio", durationMs: attachment.durationMs, waveform: attachment.waveform };
  }
  return undefined;
}

function toChatMessage(message: VoiceChatMessage): ChatMessage {
  const attachments = (message.attachments ?? [])
    .map(toChatAttachment)
    .filter((attachment): attachment is ChatAttachment => attachment !== undefined);
  return {
    from: message.from,
    text: message.text,
    at: message.at,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(message.card ? { card: message.card } : {}),
    ...(message.runtime ? { runtime: message.runtime } : {}),
    ...(message.channel ? { channel: message.channel } : {}),
    ...(message.usage ? { usage: { ...message.usage } } : {}),
    ...(message.totalTokens !== undefined ? { totalTokens: message.totalTokens } : {}),
  };
}

/** 整段会话的消息流（给渲染与测试同一个口径）。 */
export function commandMessages(conversation: VoiceCommandHistoryItem[]): ChatMessage[] {
  return conversation.flatMap(item => itemMessages(item, true));
}

export interface VoiceChatDetailDeps {
  /** Confirmed cached format admission; missing means no attachment entry. */
  attachmentFormats?(): readonly import("./voice-attachment-admission").VoiceAttachmentFormat[];
  getState(): VoiceViewState;
  getSelectedId(): string | undefined;
  setSelectedId(id: string): void;
  /** 对话页是不是当前页（异步回来时人可能已经走了）。 */
  isActive(): boolean;
  render(): void;
  actions: {
    onOpenSourceLink?(url: string): Promise<void>;
    onPrepareAttachments?(conversation?: VoiceAgentConversationRef): Promise<VoiceAttachmentTarget>;
    onUploadAttachment?(file: File, target: VoiceAttachmentTarget, signal: AbortSignal): Promise<PreparedVoiceAttachment>;
    onReleaseAttachment?(file: PreparedVoiceAttachment): Promise<void>;
    onSendCommandFollowUp(text: string, conversation?: VoiceAgentConversationRef, attachments?: readonly PreparedVoiceAttachment[]): Promise<string>;
    onCancelCommand?(taskId: string): Promise<void>;
    onRefreshConversationBackends?(): Promise<void>;
    onChangeConversationBackend?(itemId: string, backend: ResolvedAgentBackend | "auto"): Promise<void>;
    onRetryAgentRequest?(taskId: string): Promise<string>;
    onDictateDraft(): Promise<
      { phase: "listening"; sessionId?: string }
      | {
        phase: "idle";
        transcript: string;
        sessionId?: string;
        outcome?: "recognized" | "cancelled";
      }
    >;
    onDictationResultConsumed(sessionId: string): Promise<void>;
    onDictateCancel(): Promise<void>;
    onInstallBrowserWebAccessAndRetry(item: VoiceCommandHistoryItem): Promise<void>;
  };
  /** 旧 Host 降级的页内返回钮；新 Host 上返回 null。 */
  legacyBackButton(): HTMLButtonElement | null;
  /** §6.0 诊断：与 Voice 页其他区域同一套 store、Host 版本与计时。 */
  diagnostics: {
    block(key: string, entry: VoiceDiagnosticEntry): HTMLElement;
    error(key: string, detail: VoiceErrorDetail | undefined, extra?: Partial<VoiceDiagnosticEntry>): HTMLElement;
    since(key: string, knownStartMs?: number): Pick<VoiceDiagnosticEntry, "sinceMs" | "sinceObserved">;
  };
  /** 页内 DOM 小工具（与 voice-view 同一套，避免两份）。 */
  el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K];
  textEl<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string): HTMLElementTagNameMap[K];
}

export interface VoiceChatDetail {
  /** 把对话页挂到 shell 上；选中条目已不在时返回 false（调用方回列表）。 */
  mount(shell: HTMLElement): boolean;
  /** 离开对话页 / 换一条时的收口：草稿、原地错误、续接观察窗、在途的听写。 */
  reset(): void;
  /** 每次状态更新后调用（在 render 之前）：把追问落地的新条目接过来。 */
  onStateChanged(next: VoiceViewState): void;
  /**
   * 下一次挂载对话页后把光标放进输入框末尾。用户在结果面板点「继续」、在胶囊 / 通知里
   * 点「打开会话」时，Host 已把窗口和键盘焦点交给本插件，这里接着让输入框能直接打字。
   * 调用顺序：先 reset（它会清掉这个标记），再调这里，再渲染。
   */
  focusComposerOnNextMount(): void;
}

export function createVoiceChatDetail(deps: VoiceChatDetailDeps): VoiceChatDetail {
  const { el, textEl } = deps;
  const translatedRole = (item: VoiceCommandHistoryItem, conversation: VoiceCommandHistoryItem[]) => {
    const node = el("div", "chat-who-role");
    bindText(node, () => commandIdentity(item, conversation).role);
    return node;
  };
  /** 输入坞状态：草稿、发送中、原地错误、续接观察窗。 */
  let draft = "";
  let sending = false;
  type DraftFile = { name: string; controller: AbortController; value?: PreparedVoiceAttachment; error?: VoiceAttachmentContentCode };
  let draftFiles: DraftFile[] = [];
  let attachmentOwner: string | undefined;
  let preparingAttachments=false;
  let viewGeneration=0;
  let attachmentEpoch=0;
  let admissionLoading=false;
  let admissionReadOwner: string | undefined;
  let attachmentTarget: VoiceAttachmentTarget | undefined;
  const attachmentOwnerKey=()=>{const item=currentItem();return item?JSON.stringify({id:item.id,choices:deps.getState().conversationOptions?.[conversationKey(item)]??null,session:item.agentSessionId??null}):undefined;};
  let attachmentError = false;
  const formatsForCurrentScene = () => attachmentFormatsForVoiceCommand(currentItem()?.commandId,
    () => attachmentTarget?.formats ?? deps.attachmentFormats?.() ?? confirmedVoiceAttachmentFormats());
  const clearDraftAttachments = () => {
    attachmentEpoch++;
    preparingAttachments=false;
    for (const file of draftFiles) {file.controller.abort();if(file.value)void deps.actions.onReleaseAttachment?.(file.value);}
    attachmentTarget=undefined;
    draftFiles = [];
    if (attachmentError) inlineError = undefined;
    attachmentError = false;
  };
  const attachmentMessage = (cause: unknown) => t(`chat.attachments.errors.${cause instanceof VoiceAttachmentContentError ? cause.code : "VOICE_ATTACHMENT_READ_FAILED"}`);
  const sameTarget = (left: VoiceAttachmentTarget | undefined, right: VoiceAttachmentTarget | undefined) =>
    left === right || Boolean(left && right && left.ownerKey === right.ownerKey && left.sessionId === right.sessionId
      && left.admission.opaqueBinding === right.admission.opaqueBinding && left.admission.revision === right.admission.revision);
  // Only the owned local capability snapshot is read here; no file bytes or model request.
  const refreshAdmission = () => {
    if (!deps.actions.onPrepareAttachments || admissionLoading || sending || draftFiles.length || preparingAttachments
      || !voiceCommandAllowsAttachments(currentItem()?.commandId) || deps.getState().commandPhase !== "idle"
      || deps.getState().phase !== "idle" || deps.getState().dictationPhase !== "idle") return;
    const owner=attachmentOwnerKey();
    if (admissionReadOwner === owner) return;
    const generation=viewGeneration;const selected=deps.getSelectedId();
    admissionLoading=true;admissionReadOwner=owner;
    void deps.actions.onPrepareAttachments(conversationRef(currentItem())).then(target => {
      if (generation!==viewGeneration || !deps.isActive() || deps.getSelectedId()!==selected
        || !voiceCommandAllowsAttachments(currentItem()?.commandId)) return;
      attachmentTarget=target;attachmentOwner=attachmentOwnerKey();admissionReadOwner=attachmentOwner;
    }).catch(() => {
      // An unconfirmed or disabled capability keeps the entry hidden; plain text stays usable.
    }).finally(() => {
      if (generation!==viewGeneration) return;
      admissionLoading=false;admissionReadOwner=attachmentOwnerKey();deps.render();
    });
  };
  const pickFiles = async (files: File[]) => {
    if (!voiceCommandAllowsAttachments(currentItem()?.commandId) || preparingAttachments) return;
    const selectedOn=deps.getSelectedId();const generation=viewGeneration;const epoch=attachmentEpoch;const owner=attachmentOwnerKey();
    const stillCurrent=()=>generation===viewGeneration && epoch===attachmentEpoch && owner===attachmentOwnerKey()
      && deps.isActive() && deps.getSelectedId()===selectedOn && voiceCommandAllowsAttachments(currentItem()?.commandId);
    if (draftFiles.length + files.length > VOICE_TEXT_ATTACHMENT_POLICY.maxAttachments) {
      attachmentError=true;inlineError=()=>t("chat.attachments.errors.VOICE_ATTACHMENT_COUNT_EXCEEDED");deps.render();return;
    }
    if (deps.actions.onPrepareAttachments) {
      preparingAttachments=true;deps.render();
      try {
        const target=await deps.actions.onPrepareAttachments(conversationRef(currentItem()));
        if (!stillCurrent()) return;
        if (draftFiles.length && !sameTarget(attachmentTarget,target)) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
        attachmentTarget=target;
      } catch(cause) { if(stillCurrent()){attachmentError=true;inlineError=()=>attachmentMessage(cause);} return; }
      finally { if(stillCurrent()){preparingAttachments=false;deps.render();} }
    }
    if (!stillCurrent()) return;
    const selectedTarget=attachmentTarget;
    const entries=files.map(file=>({name:file.name,controller:new AbortController()} as DraftFile));
    draftFiles.push(...entries);inlineError=undefined;deps.render();
    await Promise.all(entries.map(async(entry,index)=>{
      try {
        const original=files[index]!;
        requireVoiceAttachmentAdmission(original,formatsForCurrentScene());
        const format=voiceAttachmentFormat(original);
        const value:PreparedVoiceAttachment=format==="image" && selectedTarget && deps.actions.onUploadAttachment
          ? await deps.actions.onUploadAttachment(original,selectedTarget,entry.controller.signal)
          : {...await readVoiceDocumentAttachment(original,{signal:entry.controller.signal}),...(selectedTarget?{target:selectedTarget,mode:format==="pdf"?"pdf-text" as const:format==="xlsx"||format==="xls"?"spreadsheet-text" as const:"text" as const}:{})};
        if (!stillCurrent() || !sameTarget(selectedTarget,attachmentTarget) || entry.controller.signal.aborted || !draftFiles.includes(entry)) {
          void deps.actions.onReleaseAttachment?.(value);
          if (stillCurrent() && draftFiles.includes(entry)) throw new VoiceAttachmentContentError("VOICE_ATTACHMENT_MODEL_UNCONFIRMED");
          return;
        }
        try { requireVoiceAttachmentAdmission(original,formatsForCurrentScene()); }
        catch(cause){void deps.actions.onReleaseAttachment?.(value);throw cause;}
        entry.value=value;
      } catch(cause) { if(!entry.controller.signal.aborted && stillCurrent()) entry.error=cause instanceof VoiceAttachmentContentError?cause.code:"VOICE_ATTACHMENT_READ_FAILED"; }
    }));
    if(stillCurrent() && entries.some(entry=>draftFiles.includes(entry))) deps.render();
  };
  const cancellingTasks = new Set<string>();
  let sourceOpenPending = false;
  let lastSourceOpenedAt = 0;
  let inlineError: TextSource | undefined;
  let inlineErrorDetail: VoiceErrorDetail | undefined;
  /** 原地失败：主句 + 同一份 cause 的诊断（步骤、真实码、原文）。 */
  const setInlineFailure = (step: string, cause: unknown, fallback: TextSource) => {
    inlineError = readableFailure(cause, fallback);
    inlineErrorDetail = errorDetailFrom(step, cause);
  };
  /**
   * 输入坞发出一条后续后记下当时已知的命令历史 id 集合；命令运行时是单例，
   * 处理期间起不了第二条，所以完成时新出现的条目必然是这次发送落下的那条
   * （失败也落条目）。视图据此把对话页切到新条目上——用户刚发的那句话和
   * 它的回答要出现在眼前，而不是留在身后列表里让人自己去找。
   * 用 id 集合而不是时间戳比较：不依赖任何一边的时钟。
   */
  let followUpTaskId: string | undefined;
  /** 听写请求在途（起跑 / 收工的 IPC 还没回来）：防连点。 */
  let dictating = false;
  /** 听写起跑时所在的条目：转写回来只落回它自己的输入框。 */
  let dictationOn: string | undefined;
  /** 听写落字后重渲染一次会换掉输入框；标记一下，挂完把焦点和光标放回末尾。 */
  let focusComposerAfterRender = false;
  let composer: ChatComposer | undefined;
  /** View 重渲染会重建 DOM；按任务保留用户展开的操作明细。 */
  const expandedToolGroups = new Set<string>();
  /** 这条命令的联网调用明细（只列失败 / 未结束的）：进诊断「对象状态」。 */
  const toolDetails = (entry: VoiceCommandHistoryItem): VoiceDiagnosticDetail[] => {
    const calls = (entry.messages ?? []).flatMap((message) => message.card?.kind === "tool-group" ? message.card.calls : []);
    return calls
      .filter((call) => call.status === "failed" || call.status === "unknown" || call.status === "running")
      .map((call, index) => ({
        label: () => t("diagnostics.detail.toolCall", { index: index + 1 }),
        // 只放结构化值：工具名、状态、合文法的码、耗时。
        tokens: () => [call.tool, call.status, structuredCode(call.errorCode),
          call.durationMs !== undefined ? `${(call.durationMs / 1000).toFixed(1)}s` : undefined]
          .filter((token) => token !== undefined),
      }));
  };

  /** 运行中 / 失败 / 带码回退的诊断行；已完成且没有错误码的条目没有。 */
  const entryDiagnostics = (entry: VoiceCommandHistoryItem): HTMLElement | undefined => {
    const createdAt = Date.parse(entry.createdAt);
    if (entry.status === "running") {
      const running = (entry.messages ?? [])
        .flatMap((message) => message.card?.kind === "tool-group" ? message.card.calls : [])
        .filter((call) => call.status === "running").at(-1);
      const line = el("div", "chat-run-status");
      line.setAttribute("role", "status");
      line.append(deps.diagnostics.block(`chat-running:${entry.id}`, {
        state: "waiting",
        step: () => running
          ? t("diagnostics.step.toolRunning", { step: stepText(commandStepKey(entry.commandId)), tool: structuredToken(running.tool) })
          : stepText(commandStepKey(entry.commandId)),
        ...deps.diagnostics.since(`chat:${entry.id}`, Number.isFinite(createdAt) ? createdAt : undefined),
        details: toolDetails(entry),
      }));
      return line;
    }
    if (entry.status !== "failed" && !entry.errorCode) return undefined;
    const at = entry.failedAt ?? entry.failureDetectedAt;
    const endMs = entry.failedAt ? Date.parse(entry.failedAt) : Number.NaN;
    return deps.diagnostics.block(`chat-failed:${entry.id}`, {
      state: failureState(entry.errorCode),
      step: () => stepText(commandStepKey(entry.commandId)),
      ...(entry.errorCode ? { code: entry.errorCode } : {}),
      ...(entry.errorSource ? { source: entry.errorSource } : {}),
      ...(entry.errorHttpStatus !== undefined ? { httpStatus: entry.errorHttpStatus } : {}),
      ...(entry.errorRawLength ? { rawLength: entry.errorRawLength } : {}),
      ...(entry.errorOmittedCodes ? { omittedCodes: entry.errorOmittedCodes } : {}),
      // Agent 引擎阶段 / 退出码 / 上游码（落盘的结构化字段，渲染与复制时再逐值校验）。
      ...(entry.errorAgentStage ? { agentFailure: { agentStage: entry.errorAgentStage, exitCode: entry.errorExitCode,
        upstreamCode: entry.errorUpstreamCode } } : {}),
      // 原文只在本次运行的内存表里（界面主动展开）；落盘条目只有字符数。
      ...(deps.getState().failureRaw?.[`command:${entry.id}`] ? { raw: deps.getState().failureRaw![`command:${entry.id}`] } : {}),
      rawNote: "notRecorded",
      ...(at ? { at, atKind: entry.failedAt ? "occurred" as const : "detected" as const } : {}),
      ...(Number.isFinite(createdAt) && Number.isFinite(endMs) ? { sinceMs: createdAt, endMs } : {}),
      details: toolDetails(entry),
    });
  };

  const currentItem = (): VoiceCommandHistoryItem | undefined => {
    const id = deps.getSelectedId();
    return deps.getState().commandHistory.find((entry) => entry.id === id);
  };

  const mount = (shell: HTMLElement): boolean => {
    const state = deps.getState();
    const item = currentItem();
    if (!item) return false;
    const taskAttachmentScene = voiceCommandAllowsAttachments(item.commandId);
    if (!taskAttachmentScene || attachmentOwner !== attachmentOwnerKey()) clearDraftAttachments();
    attachmentOwner = taskAttachmentScene ? attachmentOwnerKey() : undefined;
    if(taskAttachmentScene) refreshAdmission();
    const conversation = commandConversation(item, state.commandHistory);
    const identity = commandIdentity(item, conversation);

    const view = el("main", "main-body chat-view");
    const header = el("header", "chat-header");
    const headerMain = el("div", "chat-hdr-main");
    const who = el("div", "chat-who");
    const avatar = textEl("div", "chat-who-ava is-emoji", identity.avatar);
    avatar.setAttribute("aria-hidden", "true");
    const whoText = el("div", "chat-who-text");
    whoText.append(
      textEl("div", "chat-who-name", identity.title),
      translatedRole(item, conversation),
    );
    who.append(avatar, whoText);
    headerMain.append(who);
    // B5-14：chat 页内返回钮撤除——返回由 Host 面包屑承载；acts 保留占位。
    const acts = el("div", "chat-hdr-acts");
    const legacyBack = deps.legacyBackButton();
    if (legacyBack) acts.append(legacyBack);
    const runningTask = conversation.find((entry) => entry.status === "running");
    if (runningTask && deps.actions.onCancelCommand) {
      const stop = textEl("button", "dev-btn chat-cancel", "");
      // 翻译条目说「停止翻译」（按内置命令 ID 判断，#944 口径），其余说「停止回答」。
      bindText(stop, () => cancellingTasks.has(runningTask.id) ? t("chat.stoppingAnswer") : stopActionLabel(runningTask.commandId));
      stop.type = "button";
      stop.disabled = cancellingTasks.has(runningTask.id);
      stop.addEventListener("click", () => {
        if (cancellingTasks.has(runningTask.id)) return;
        cancellingTasks.add(runningTask.id);
        const selectedOn = deps.getSelectedId();
        inlineError = undefined;
        deps.render();
        void deps.actions.onCancelCommand!(runningTask.id).catch((cause: unknown) => {
          if (deps.isActive() && deps.getSelectedId() === selectedOn) {
            setInlineFailure("stop", cause, () => stopFailedLabel(runningTask.commandId));
          }
        }).finally(() => {
          cancellingTasks.delete(runningTask.id);
          if (deps.isActive()) deps.render();
        });
      });
      acts.append(stop);
    }
    header.append(headerMain, acts);

    const msgs = el("div", "chat-msgs");
    for (const entry of conversation) {
      const entryStatus = entryDiagnostics(entry);
      const startedMs = Date.parse(entry.createdAt);
      for (const message of itemMessages(entry, state.developerMode)) {
        msgs.append(renderChatMessage(message, {
          onOpenLink: (url) => {
            if (sourceOpenPending || Date.now() - lastSourceOpenedAt < 750) return;
            sourceOpenPending = true;
            void Promise.resolve().then(() => deps.actions.onOpenSourceLink
              ? deps.actions.onOpenSourceLink(url)
              : Promise.reject({ code: "EXTERNAL_LINK_UNAVAILABLE", userMessage: t("chat.openSourceUnavailable") })).then(() => {
                lastSourceOpenedAt = Date.now();
                if (!deps.isActive() || deps.getSelectedId() !== item.id || inlineErrorDetail?.step !== "openSource") return;
                inlineError = undefined;
                inlineErrorDetail = undefined;
                deps.render();
              }).catch((cause: unknown) => {
                if (!deps.isActive() || deps.getSelectedId() !== item.id) return;
                setInlineFailure("openSource", cause, () => t("chat.openSourceFailed"));
                deps.render();
              }).finally(() => { sourceOpenPending = false; });
          },
          developerMode: state.developerMode,
          toolGroupExpanded: expandedToolGroups.has(entry.id),
          // 运行中的过程折叠：右侧是每秒就地刷新的已用时间（与 §6.0 活动行同一计时节点）。
          renderToolGroupMeta: (card) => card.status === "running" && entry.status === "running" && Number.isFinite(startedMs)
            ? elapsedNode({ sinceMs: startedMs })
            : undefined,
          toolGroupOmittedLabel: (count) => t("chat.olderWebOperationsOmitted", { value0: count }),
          onToolGroupExpandedChange: (expanded) => {
            if (expanded) expandedToolGroups.add(entry.id);
            else expandedToolGroups.delete(entry.id);
          },
          onCardAction: () => {
            inlineError = undefined;
            void deps.actions.onInstallBrowserWebAccessAndRetry(item).catch((cause: unknown) => {
              if (!deps.isActive() || deps.getSelectedId() !== item.id) return;
              setInlineFailure("installBrowser", cause, () => t("chat.message7"));
              deps.render();
            });
          },
        }));
      }
      // §6.0：运行中说清在做什么、已用多久；失败 / 带码回退给出码、原文与诊断（放在这条的消息之后）。
      if (entryStatus) msgs.append(entryStatus);
    }
    const recoverable = [...conversation].reverse().find(entry => entry.errorCode === "AGENT_RECEIPT_UNKNOWN");
    const nonTaskFileRecovery = recoverable && !voiceCommandAllowsAttachments(recoverable.commandId)
      && recoverable.messages?.find(message => message.from === "user")?.attachments?.some(file => file.kind === "file");
    if (recoverable && !nonTaskFileRecovery && deps.actions.onRetryAgentRequest) {
      const retry = textEl("button", "dev-btn chat-retry-request", "");
      retry.type = "button";
      bindText(retry, () => t(sending ? "chat.recoveringRequest" : "chat.retryOriginalRequest"));
      retry.disabled = sending || Boolean(runningTask) || state.commandPhase !== "idle";
      retry.addEventListener("click", () => {
        if (sending) return;
        sending = true;
        inlineError = undefined;
        const selectedOn = deps.getSelectedId();
        deps.render();
        void deps.actions.onRetryAgentRequest!(recoverable.id).then(taskId => {
          if (!deps.isActive() || deps.getSelectedId() !== selectedOn) return;
          followUpTaskId = taskId;
          if (deps.getState().commandHistory.some(item => item.id === taskId)) {
            deps.setSelectedId(taskId); followUpTaskId = undefined;
          }
        }).catch((cause: unknown) => {
          if (deps.isActive() && deps.getSelectedId() === selectedOn) {
            setInlineFailure("recover", cause, () => t("chat.requestRecoveryUnavailable"));
          }
        }).finally(() => { sending = false; if (deps.isActive()) deps.render(); });
      });
      msgs.append(retry);
      if (sending) {
        msgs.append(deps.diagnostics.block(`chat-recover:${recoverable.id}`, {
          state: "waiting",
          step: () => stepText("recover"),
          ...deps.diagnostics.since(`chat-recover:${recoverable.id}`),
          code: recoverable.errorCode,
        }));
      }
    }
    view.append(header, msgs);

    // 发送 / 听写失败在输入坞上方原地讲清楚——离开了对话页去列表的状态卡，用户看不见。
    if (inlineError) {
      const errorLine = el("div", "inline-error chat-send-error");
      const errorSource = inlineError;
      bindText(errorLine, errorSource);
      // role=alert：读屏器当场播报，不用人去摸这块区域。
      errorLine.setAttribute("role", "alert");
      view.append(errorLine);
      view.append(deps.diagnostics.error(`chat-inline:${inlineErrorDetail?.step ?? ""}:${inlineErrorDetail?.at ?? ""}`,
        inlineErrorDetail));
    }

    const listening = state.dictationPhase === "listening";
    const busy =
      sending ||
      runningTask !== undefined ||
      state.commandPhase !== "idle" ||
      state.phase !== "idle" ||
      state.activeMode !== undefined;
    // 命令对话输入坞只保留发送与听写；Agent 配置沿用设置页与存量会话选择。
    // 回合在等你拍板（例如启用浏览器插件以联网）：写明在等什么、已等多久；Host 期间不计超时。
    // 入口就在本页：安装卡片的「一键安装并继续」。越界确认另有下面的审批提示，不重复。
    const waits = (state.agentWaits ?? []).filter((wait) => wait.reason !== "scope_approval"
      && conversation.some((entry) => entry.id === wait.taskId));
    if (waits.length) {
      const first = waits[0];
      const status = textEl("p", "chat-approval-status", "");
      status.setAttribute("role", "status");
      bindText(status, () => {
        const label = userWaitLabel(first.reason, first.label);
        return label ? t("chat.userWait", { label }) : t("chat.userWaitGeneric");
      });
      view.append(status);
      const key = `chat-wait:${first.taskId}:${first.waitId}`;
      view.append(deps.diagnostics.block(key, {
        state: "waiting",
        step: () => stepText("userWait"),
        ...deps.diagnostics.since(key, first.startedAt),
        details: waits.map((wait) => ({
          label: () => t("diagnostics.detail.userWait"),
          tokens: () => [wait.waitId, structuredToken(wait.reason)],
        })),
      }));
    }
    // F03：本对话有越界审批等待时提示去 Host 弹窗决定；这里没有也不会有批准按钮。
    const pending = (state.agentApprovals ?? []).filter((approval) => approval.status === "pending" && conversation.some((entry) => entry.id === approval.turnId || entry.runId === approval.turnId));
    if (pending.length) {
      const status = textEl("p", "chat-approval-status", "");
      status.setAttribute("role", "status");
      bindText(status, () => t("chat.waitingHostApproval"));
      view.append(status);
      const first = pending[0];
      view.append(deps.diagnostics.block(`chat-approval:${first.id}`, {
        state: "waiting",
        step: () => stepText("approval"),
        ...deps.diagnostics.since(`chat-approval:${first.id}`, first.createdMs),
        details: pending.map((approval, index) => ({
          label: () => t("diagnostics.detail.approval", { index: index + 1 }),
          tokens: () => [approval.id, approval.status,
            // expiresMs=0 表示不过期（等你拍板不设上限），不能显示成 1970 年。
            Number.isFinite(approval.expiresMs) && approval.expiresMs > 0 ? new Date(approval.expiresMs).toISOString() : undefined],
        })),
      }));
    }
    const attachmentBlocked = preparingAttachments || draftFiles.some(file => !file.value || file.error);
    let picker: HTMLInputElement | undefined;
    if (taskAttachmentScene) {
    picker = el("input", "chat-file-picker");
    picker.type = "file";
    picker.multiple = true;
    picker.hidden = true;
    picker.addEventListener("change", () => {
      const files = Array.from(picker!.files ?? []);
      picker!.value = ""; // Selecting the same file after a failure must fire again.
      if (files.length) void pickFiles(files);
    });
    view.append(picker);
    }
    if (draftFiles.length) {
      const strip = el("div", "chat-draft-files");
      strip.setAttribute("aria-live", "polite");
      for (const file of draftFiles) {
        const card = el("div", "chat-draft-file");
        card.append(textEl("span", "chat-draft-file-name", file.name));
        const status = textEl("span", "chat-draft-file-status", "");
        bindText(status, () => file.error ? t(`chat.attachments.errors.${file.error}`) : t(file.value ? "chat.attachments.ready" : "chat.attachments.reading"));
        const remove = textEl("button", "chat-draft-file-remove", "");
        remove.type = "button";
        bindAttribute(remove, "aria-label", () => t("chat.attachments.removeNamed", { name: file.name }));
        bindText(remove, () => t("chat.attachments.remove"));
        remove.disabled = busy;
        remove.addEventListener("click", () => { file.controller.abort(); if(file.value)void deps.actions.onReleaseAttachment?.(file.value); draftFiles = draftFiles.filter(entry => entry !== file); deps.render(); });
        card.append(status, remove); strip.append(card);
      }
      view.append(strip);
    }
    composer?.dispose();
    composer = mountChatComposer(view, {
      // 文案逐字取自设计稿 :3787。
      placeholder: () => t("chat.message8"),
      draft,
      disabled: busy || attachmentBlocked || state.dictationPhase !== "idle",
      onDraftChange: (value) => {
        // 只记草稿不重渲染：整页重渲染会换掉输入节点，打字焦点就没了。
        draft = value;
      },
      onSend: submit,
      mic: {
        state: listening ? "listening" : busy || state.dictationPhase === "recognizing" ? "busy" : "idle",
        disabled: busy || dictating || state.dictationPhase === "recognizing",
        labels: { idle: () => t("chat.message9"), listening: () => t("chat.message10"), busy: () => t("chat.message11") },
        onToggle: toggleDictation,
      },
      onAttach: taskAttachmentScene ? () => { if (!busy && state.dictationPhase === "idle" && voiceCommandAllowsAttachments(currentItem()?.commandId)) picker?.click(); } : undefined,
      hideAttach: !taskAttachmentScene || formatsForCurrentScene().length === 0,
    });
    shell.append(view);
    // 对话流落在最底部：看的是「最后说了什么」，不是「最初说了什么」（同稿 openChat）。
    msgs.scrollTop = msgs.scrollHeight;
    if (focusComposerAfterRender) {
      focusComposerAfterRender = false;
      composer.focus();
      const end = composer.input.value.length;
      try {
        composer.input.setSelectionRange(end, end);
      } catch {
        /* 只是把光标挪到末尾。 */
      }
    }
    return true;
  };

  /**
   * 「发送」走命令工作流起一次新的 Agent 命令（`onSendCommandFollowUp`），带上当前
   * 条目的通用 Agent Session，因此会话上下文真实续接；旧历史没有 session 时由运行时新建。
   */
  const submit = (text: string) => {
    const state = deps.getState();
    if (draftFiles.some(file => !file.value || file.error) || sending || state.commandPhase !== "idle" || state.dictationPhase !== "idle") return;
    // 发送是异步的（getStatus 是真实 IPC）：回来的时候人可能已经不在这场对话里，
    // 草稿、错误、观察窗都只属于发出它的那一条。
    const sentOn = deps.getSelectedId();
    const sentOwner=attachmentOwnerKey();const sentGeneration=viewGeneration;
    const sentDraftFiles = draftFiles;
    const sentFiles = sentDraftFiles.map(file => file.value!);
    try {
      for (const file of sentFiles) requireVoiceAttachmentAdmission({ name: file.name, type: file.mimeType }, formatsForCurrentScene());
    } catch (cause) {
      attachmentError = true;
      inlineError = () => attachmentMessage(cause); deps.render(); return;
    }
    sending = true;
    // Detached in-flight files belong to this admission, not later view navigation.
    draftFiles = [];
    inlineError = undefined;
    draft = "";
    deps.render();
    deps.actions
      .onSendCommandFollowUp(text, conversationRef(currentItem()), sentFiles)
      .then((taskId) => {
        // State delivery may select the next history row before this promise resolves.
        if (draftFiles === sentDraftFiles) draftFiles = [];
        // 命令已起跑：只等待这个 taskId，后台运行与后来命令不会串台。
        if (!deps.isActive() || deps.getSelectedId() !== sentOn) return;
        followUpTaskId = taskId;
        const landed = deps.getState().commandHistory.find((entry) => entry.id === taskId);
        if (landed) {
          deps.setSelectedId(landed.id);
          followUpTaskId = undefined;
        }
      })
      .catch((cause: unknown) => {
        if (sentGeneration!==viewGeneration || sentOwner!==attachmentOwnerKey() || !deps.isActive() || deps.getSelectedId() !== sentOn) {
          for(const file of sentFiles) void deps.actions.onReleaseAttachment?.(file);
          return;
        }
        // 发不出去就把草稿还回去：可重试的失败不该让人重打整句话。
        draft = text;
        if (!draftFiles.length) draftFiles = sentDraftFiles;
        if (cause instanceof VoiceAttachmentContentError) inlineError = () => attachmentMessage(cause);
        else setInlineFailure("followUp", cause, () => t("chat.message13"));
      })
      .finally(() => {
        if(sentGeneration!==viewGeneration)return;
        sending = false;
        deps.render();
      });
  };

  /**
   * 麦克风 = 定向听写：说的话**有且只**落进当前输入框，不起命令、不写进别的应用。
   * 第一次点起跑（返回 listening），第二次点收工（返回 transcript）。
   */
  const toggleDictation = () => {
    if (dictating) return;
    dictating = true;
    dictationOn = deps.getSelectedId();
    deps.actions
      .onDictateDraft()
      .then(async (result) => {
        if (result.phase !== "idle") return;
        try {
          if (result.outcome === "cancelled") {
            inlineError = undefined;
            return;
          }
          if (!deps.isActive() || deps.getSelectedId() !== dictationOn) return;
          if (!result.transcript) {
            inlineError = () => t("chat.message14");
            // 没听清不是异常，没有错误码；诊断如实写「无」。
            inlineErrorDetail = { step: "dictate", at: new Date().toISOString() };
            return;
          }
          if (composer) {
            composer.appendDraft(result.transcript);
          } else {
            draft = joinDraft(draft, result.transcript);
          }
          inlineError = undefined;
          focusComposerAfterRender = true;
        } finally {
          // 识别服务只负责返回结果；目标是否还在、文本是否为空，都由调用方在这里
          // 明确消费或丢弃，然后按 session 结算那一颗胶囊。
          if (result.sessionId) {
            await deps.actions.onDictationResultConsumed(result.sessionId).catch(() => undefined);
          }
        }
      })
      .catch((cause: unknown) => {
        if (!deps.isActive() || deps.getSelectedId() !== dictationOn) return;
        setInlineFailure("dictate", cause, () => t("chat.message15"));
      })
      .finally(() => {
        dictating = false;
        dictationOn = undefined;
        // listening 帧往往先于 promise 收敛到达，不补一次渲染的话这颗麦克风会停在
        // 禁用态等下一次无关更新。
        deps.render();
      });
  };

  const reset = () => {
    viewGeneration++;sending=false;admissionLoading=false;admissionReadOwner=undefined;
    clearDraftAttachments();
    attachmentOwner = undefined;
    draft = "";
    expandedToolGroups.clear();
    inlineError = undefined;
    followUpTaskId = undefined;
    focusComposerAfterRender = false;
    composer?.dispose();
    composer = undefined;
    // 人走了，正在听的那场听写没有落点了：取消，别让它在别的页面里收工落字。
    if (dictating || deps.getState().dictationPhase !== "idle") {
      dictationOn = undefined;
      void deps.actions.onDictateCancel().catch(() => undefined);
    }
  };

  /**
   * 输入坞发出后续后，只在这次运行的 taskId 落地时切过去。长任务释放中央 owner 后
   * 可以启动另一条命令，因此不能再用“第一个新 id”猜归属。
   */
  const onStateChanged = (next: VoiceViewState) => {
    if (!deps.isActive() || followUpTaskId === undefined) return;
    const landed = next.commandHistory.find((entry) => entry.id === followUpTaskId);
    if (landed) {
      deps.setSelectedId(landed.id);
      inlineError = undefined;
      followUpTaskId = undefined;
    }
  };

  const focusComposerOnNextMount = () => {
    focusComposerAfterRender = true;
  };

  return { mount, reset, onStateChanged, focusComposerOnNextMount };
}

function conversationRef(item: VoiceCommandHistoryItem | undefined): VoiceAgentConversationRef | undefined {
  if (!item) return undefined;
  if (item.agentSessionId) return { agentSessionId: item.agentSessionId, conversationId: conversationKey(item) };
  if (item.dshSessionId) return { dshSessionId: item.dshSessionId, conversationId: conversationKey(item) };
  return { conversationId: conversationKey(item) };
}

function joinDraft(current: string, text: string): string {
  const needsSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(text);
  return current + (needsSpace ? " " : "") + text;
}

/** 原地错误文案：优先取 App 层写好的人话（AppError.userMessage）。 */
function readableFailure(cause: unknown, fallback: TextSource): TextSource {
  const source = cause && typeof cause === "object"
    ? (cause as { userMessage?: unknown; message?: unknown })
    : undefined;
  return () => {
  const text = typeof source?.userMessage === "string"
    ? source.userMessage
    : typeof source?.message === "string"
      ? source.message
      : "";
  return text || fallback;
  };
}
