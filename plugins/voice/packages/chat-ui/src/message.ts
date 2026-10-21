import { t, bindAttribute } from "./i18n";
import { chatGlobe, chatIcon, element, textElement } from "./dom";
import { renderMarkdownBubble } from "./markdown";
import { CHAT_WAVEFORM_BARS, type ChatAttachment, type ChatMessage, type ChatStatusCard } from "./model";

/**
 * 稿的时间戳是 `2:47 PM` 短格式（TASKS[].chat.msgs[].ts），固定 12 小时制、不带秒。
 * 故意不跟系统 locale：中文系统下 `toLocaleTimeString()` 会变成 `14:47`，与稿
 * 对不上；稿是唯一视觉事实源。
 */
export function formatChatTime(at: ChatMessage["at"]): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** 语音气泡右侧的时长：稿写 `0:42`，分钟不补零、秒补两位。 */
export function formatClipDuration(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 没给波形时按时长做稳定种子生成：同一条每次打开一模一样。
 * 高度区间对稿 `3 + Math.random() * 14`（3–17px）。
 */
export function stableWaveform(seed: number, bars = CHAT_WAVEFORM_BARS): number[] {
  let state = (Math.floor(Math.abs(seed)) % 2147483647) + 1;
  const heights: number[] = [];
  for (let index = 0; index < bars; index += 1) {
    // Park–Miller 最小标准乘同余：够用、无依赖、跨平台结果一致。
    state = (state * 16807) % 2147483647;
    heights.push(3 + Math.round((state / 2147483647) * 14));
  }
  return heights;
}

export interface ChatAttachmentOptions {
  onOpenLink?(url: string): void;
  developerMode?: boolean;
  /**
   * 语音气泡的播放回调。缺省时播放键仍按稿画出来但 disabled——没有音频来源的
   * 播放键不能是一扇点了没反应的门。
   */
  onPlayAudio?(attachment: Extract<ChatAttachment, { kind: "audio" }>): void;
  onCardAction?(card: Extract<ChatStatusCard, { kind: "capability-required" }>): void;
  toolGroupExpanded?: boolean;
  onToolGroupExpandedChange?(expanded: boolean): void;
  toolGroupOmittedLabel?(count: number): string;
  /** 摘要行右侧的活节点（例如每秒刷新的已用时间）；返回 undefined 时用卡片自带的 `meta`。 */
  renderToolGroupMeta?(card: Extract<ChatStatusCard, { kind: "tool-group" }>): Node | undefined;
}

type ToolStatus = "running" | "completed" | "failed" | "unknown";

/** 状态图标：联网 / 网页类用地球仪（只在运行中转动），其余是转圈 / 对勾 / ! / ?。 */
function statusIcon(status: ToolStatus, icon: "globe" | undefined, size: number): HTMLElement {
  const box = element("span", "chat-status-icon");
  box.setAttribute("aria-hidden", "true");
  if (icon === "globe") {
    box.dataset.icon = "globe";
    box.append(chatGlobe(size, status === "running"));
  } else if (status === "running") {
    box.dataset.icon = "loader";
    box.append(chatIcon("loader", 11));
  } else if (status === "completed") box.append(chatIcon("check", 11));
  else box.textContent = status === "failed" ? "!" : "?";
  return box;
}

function renderToolCalls(card: Extract<ChatStatusCard, { kind: "tool-group" }>, options: ChatAttachmentOptions, list: HTMLElement): void {
  list.replaceChildren();
  for (const call of card.calls) {
    const row = element("li", "chat-status-call");
    row.dataset.status = call.status;
    row.append(statusIcon(call.status, call.icon, 13), textElement("span", "chat-status-call-name", () => call.label || call.tool));
    const durationMs = typeof call.durationMs === "number" && Number.isFinite(call.durationMs) && call.durationMs >= 0
      ? call.durationMs
      : undefined;
    if (durationMs !== undefined) {
      row.append(textElement("span", "chat-status-call-duration", () => `${(durationMs / 1000).toFixed(1)}s`));
    }
    if (call.errorLabel) row.append(textElement("span", "chat-status-call-error", () => call.errorLabel!));
    list.append(row);
  }
  const omitted = card.omittedCalls ?? 0;
  if (omitted > 0) {
    list.append(textElement("li", "chat-status-call omitted", () =>
      options.toolGroupOmittedLabel?.(omitted) ?? `${omitted} earlier operations hidden`));
  }
}

function renderStatusCard(card: ChatStatusCard, options: ChatAttachmentOptions): HTMLElement {
  const shell = element("div", `chat-status-card ${card.kind}`);
  shell.dataset.kind = card.kind;
  if (card.kind === "tool") {
    shell.dataset.status = card.status;
    // 旧版每工具一张的卡只可能是联网搜索 / 网页读取：同样换成地球仪。
    shell.append(statusIcon(card.status, "globe", 14), textElement("span", "chat-status-label", () => card.label));
    return shell;
  }
  if (card.kind === "tool-group") {
    shell.dataset.status = card.status;
    // 摘要行（稿 .voice-process summary）：图标 + 在做 / 做了什么 + 右侧补充 + 展开箭头。
    const expandable = card.calls.length > 0 || (card.omittedCalls ?? 0) > 0;
    const head = expandable ? element("button", "chat-status-head chat-status-toggle") : element("div", "chat-status-head");
    head.append(statusIcon(card.status, card.icon, 14), textElement("span", "chat-status-label", () => card.label));
    const meta = options.renderToolGroupMeta?.(card)
      ?? (card.meta ? textElement("span", "", () => card.meta ?? "") : undefined);
    if (meta) {
      const slot = element("span", "chat-status-meta");
      slot.append(meta);
      head.append(slot);
    }
    shell.append(head);
    if (!(head instanceof HTMLButtonElement)) return shell;
    head.type = "button";
    const chevron = element("span", "chat-status-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.append(chatIcon("chevronDown", 13));
    head.append(chevron);
    // 折叠是默认：回合结束后也保持折叠，只有用户点开才展开（展开态由消费方跨重渲染保存）。
    const details = element("ul", "chat-status-calls");
    const expanded = options.toolGroupExpanded ?? false;
    head.setAttribute("aria-expanded", String(expanded));
    renderToolCalls(card, options, details);
    if (!expanded) details.setAttribute("hidden", "");
    head.addEventListener("click", () => {
      const expanding = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(expanding));
      options.onToolGroupExpandedChange?.(expanding);
      if (expanding) {
        renderToolCalls(card, options, details);
        details.removeAttribute("hidden");
      } else {
        details.setAttribute("hidden", "");
      }
    });
    shell.append(details);
    return shell;
  }
  shell.append(
    textElement("div", "chat-status-title", () => card.title),
    textElement("div", "chat-status-detail", () => card.detail),
  );
  if (card.kind === "capability-required") {
    const action = textElement("button", "chat-status-action", () => card.actionLabel);
    action.type = "button";
    action.addEventListener("click", () => options.onCardAction?.(card));
    shell.append(action);
  }
  return shell;
}

/** 附件卡：稿 `cardHTML`，外层 `.chat-card`，里层按类型 file / img / audio。 */
export function renderChatAttachment(
  attachment: ChatAttachment,
  options: ChatAttachmentOptions = {},
): HTMLElement {
  const card = element("div", "chat-card");
  card.dataset.kind = attachment.kind;
  if (attachment.kind === "file") {
    const file = element("div", "chat-card-file");
    const icon = textElement("div", "chat-card-icon", attachment.icon ?? "📄");
    icon.setAttribute("aria-hidden", "true");
    const info = element("div", "chat-card-info");
    info.append(textElement("div", "chat-card-name", attachment.name));
    if (attachment.meta) info.append(textElement("div", "chat-card-meta", attachment.meta));
    file.append(icon, info);
    card.append(file);
    return card;
  }
  if (attachment.kind === "image") {
    const image = textElement("div", "chat-card-img", attachment.alt);
    image.setAttribute("role", "img");
    image.setAttribute("aria-label", attachment.alt);
    card.append(image);
    return card;
  }
  const audio = element("div", "chat-card-audio");
  const play = element("button", "chat-card-play");
  play.type = "button";
  play.append(chatIcon("play", 10, true));
  const duration = formatClipDuration(attachment.durationMs);
  bindAttribute(play, "aria-label", () => t("chatUi.message8", { duration }));
  bindAttribute(play, "title", () => t(options.onPlayAudio ? "chatUi.message6" : "chatUi.message7"));
  if (options.onPlayAudio) {
    const onPlay = options.onPlayAudio;
    play.addEventListener("click", () => onPlay(attachment));
  } else {
    play.disabled = true;
  }
  const wave = element("div", "chat-card-wave");
  wave.setAttribute("aria-hidden", "true");
  const heights = attachment.waveform?.length
    ? attachment.waveform
    : stableWaveform(attachment.durationMs);
  for (const height of heights.slice(0, CHAT_WAVEFORM_BARS)) {
    const bar = element("i");
    // CSSOM 赋值，不写内联 style 属性：插件 WebView 的 CSP `style-src` 没有
    // 'unsafe-inline'，`<i style="…">` 会被整个丢掉（voice 插件 R10 实锤过）。
    bar.style.height = `${Math.max(1, Math.round(height))}px`;
    wave.append(bar);
  }
  audio.append(play, wave, textElement("span", "chat-card-dur", duration));
  card.append(audio);
  return card;
}

/**
 * 一条消息：稿 `renderMsg` —— `.chat-msg.from-user|from-ai` 内依次是气泡（有文本才画）、
 * 附件卡、时间戳。没有头像：稿的 Voice 命令详情就没有（与 Agent stream 不同）。
 */
export function renderChatMessage(
  message: ChatMessage,
  options: ChatAttachmentOptions = {},
): HTMLElement {
  const row = element("div", `chat-msg from-${message.from}`);
  if (message.text) row.append(message.from === "ai" && message.format !== "plain"
    ? renderMarkdownBubble(message.text, options.onOpenLink)
    : textElement("div", "chat-bubble", () => message.text));
  for (const attachment of message.attachments ?? []) {
    row.append(renderChatAttachment(attachment, options));
  }
  if (message.card) row.append(renderStatusCard(message.card, options));
  const timestamp = textElement("div", "chat-ts", formatChatTime(message.at));
  if (options.developerMode && message.from === "ai" && message.runtime) {
    const meta = element("span", "chat-devmeta");
    const runtime = textElement("span", "chat-dev-chip", message.runtime);
    runtime.title = "Agent runtime";
    meta.append(runtime);
    if (message.channel === "external-brain") {
      meta.append(textElement("span", "chat-dev-chip", message.channel));
    }
    // 卡片/附件型回复只标运行内核；tokens 只属于有正文的 AI 回复。
    const counts = message.usage;
    if (message.text && counts?.complete === true
      && [counts.inputTokens, counts.outputTokens, counts.totalTokens].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      && counts.inputTokens! + counts.outputTokens! === counts.totalTokens) {
      const usage = textElement("span", "chat-dev-chip tok", `${counts.totalTokens} tok`);
      usage.title = "Tokens used by this response";
      meta.append(usage);
    }
    timestamp.append(meta);
  }
  row.append(timestamp);
  return row;
}
