import MarkdownIt from "markdown-it";
import { element } from "./dom";

// Model output is untrusted. Never enable raw HTML or a custom HTML highlighter.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
const standardLinks = new MarkdownIt().linkify;
for (const scheme of ["http:", "https:"]) {
  markdown.linkify.add(scheme, {
    validate(text, position) {
      // Do not turn a rejected credential URL into a shorter, different URL.
      if (/^\/\/[^\s/?#<>()[\]，。；！？]*@/.test(text.slice(position))) return 0;
      return standardLinks.testSchemaAt(text, scheme, position);
    },
  });
}
export function isExternalWebUrl(value: string): boolean {
  if (value.length > 4096 || /[\s\u0000-\u001f\u007f]/u.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
markdown.validateLink = isExternalWebUrl;
// Rendering a reply must not fetch tracking images or local resources.
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index].content);
// The parser emits inline alignment styles for tables; plugin CSP requires CSS.
for (const type of ["th_open", "td_open"]) {
  markdown.renderer.rules[type] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    const alignment = String(token.attrGet("style") ?? "").match(/^text-align:(left|center|right)$/)?.[1];
    token.attrs = token.attrs?.filter(([name]) => name !== "style") ?? null;
    if (alignment) token.attrSet("class", `chat-align-${alignment}`);
    return renderer.renderToken(tokens, index, options);
  };
}

/**
 * 中日韩文字与全角标点。CommonMark 的「左右侧翼」规则假设词与词之间有空格：`**天气：**晴`
 * 里收尾的 `**` 前是标点、后是汉字，按原规则既不能开也不能关，整段 `**` 原样露出（负责人
 * rc.2.7 真机反馈）。模型的中文回答几乎都这样写（`**气温：**18℃`、`**《三体》**这本书`），
 * 所以侧翼判定里全角标点按普通字符看待，半角标点在另一侧紧挨 CJK 字符时放宽；两侧都不是
 * CJK 的英文写法判定不变。
 */
const CJK = /[\u{1100}-\u{11ff}\u{2e80}-\u{2fdf}\u{3000}-\u{303f}\u{3040}-\u{30ff}\u{3100}-\u{31ff}\u{3200}-\u{4dbf}\u{4e00}-\u{9fff}\u{a960}-\u{a97f}\u{ac00}-\u{d7ff}\u{f900}-\u{faff}\u{fe30}-\u{fe4f}\u{ff00}-\u{ffef}\u{20000}-\u{3134f}]/u;
const { isMdAsciiPunct, isPunctCharCode, isWhiteSpace } = markdown.utils;
class CjkFriendlyInlineState extends markdown.inline.State {
  override scanDelims(start: number, canSplitWord: boolean) {
    const scanned = super.scanDelims(start, canSplitWord);
    const marker = this.src.charCodeAt(start);
    let pos = start;
    while (pos < this.posMax && this.src.charCodeAt(pos) === marker) pos += 1;
    const last = start > 0 ? Array.from(this.src.slice(Math.max(0, start - 2), start)).at(-1)! : " ";
    const next = pos < this.posMax ? String.fromCodePoint(this.src.codePointAt(pos)!) : " ";
    const lastCode = last.codePointAt(0)!;
    const nextCode = next.codePointAt(0)!;
    const lastPunct = isMdAsciiPunct(lastCode) || isPunctCharCode(lastCode);
    const nextPunct = isMdAsciiPunct(nextCode) || isPunctCharCode(nextCode);
    const lastSpace = isWhiteSpace(lastCode);
    const nextSpace = isWhiteSpace(nextCode);
    // 全角标点按普通字符看待；半角标点只在另一侧紧挨 CJK 字符时放宽。
    const lastCjk = CJK.test(last);
    const nextCjk = CJK.test(next);
    // 两侧都不挨 CJK 时原样沿用 markdown-it 的判定（含孤立代理码元等边界），英文写法零变化。
    if (!lastCjk && !nextCjk) return scanned;
    const left = !nextSpace && (!nextPunct || nextCjk || lastSpace || lastPunct || lastCjk);
    const right = !lastSpace && (!lastPunct || lastCjk || nextSpace || nextPunct || nextCjk);
    return {
      ...scanned,
      can_open: left && (canSplitWord || !right || lastPunct),
      can_close: right && (canSplitWord || !left || nextPunct),
    };
  }
}
markdown.inline.State = CjkFriendlyInlineState;

export function renderMarkdownBubble(text: string, onOpenLink?: (url: string) => void): HTMLElement {
  const bubble = element("div", "chat-bubble chat-markdown");
  bubble.innerHTML = markdown.render(text).trim();
  for (const link of Array.from(bubble.querySelectorAll("a"))) {
    const url = link.getAttribute("href") ?? "";
    const label = link.textContent ?? "";
    if (onOpenLink && isExternalWebUrl(url)) {
      link.classList.add("chat-markdown-source");
      link.setAttribute("title", url);
      link.setAttribute("rel", "noopener noreferrer");
      if (label !== url) link.append(document.createTextNode(` (${url})`));
      // Keep plugin navigation inside its origin. Only the Host opens web links.
      link.addEventListener("click", (event) => { event.preventDefault(); onOpenLink(url); });
      link.addEventListener("auxclick", (event) => { event.preventDefault(); if (event.button === 1) onOpenLink(url); });
    } else {
      const source = element("span", "chat-markdown-source");
      source.append(...Array.from(link.childNodes));
      if (label !== url) source.append(document.createTextNode(` (${url})`));
      link.replaceWith(source);
    }
  }
  return bubble;
}

type MarkdownToken = ReturnType<typeof markdown.parse>[number];

function inlinePlainText(children: MarkdownToken[]): string {
  let out = "";
  const links: Array<{ href: string; start: number }> = [];
  for (const child of children) {
    if (child.type === "text" || child.type === "code_inline" || child.type === "image") out += child.content;
    else if (child.type === "softbreak" || child.type === "hardbreak") out += "\n";
    else if (child.type === "link_open") links.push({ href: String(child.attrGet("href") ?? ""), start: out.length });
    else if (child.type === "link_close") {
      // 与气泡里的来源写法一致：标签 (地址)；标签本身就是地址时不重复。
      const link = links.pop();
      if (link?.href && out.slice(link.start) !== link.href) out += ` (${link.href})`;
    }
  }
  return out;
}

/**
 * 同一套解析器投影出的纯文本：只显示纯文本的地方（历史摘要、Host 结果面板）不露 `**`、
 * `#`、列表与代码围栏符号。列表项换成「•」/「1.」，链接写成「标签 (地址)」，图片只留说明，
 * 不安全的链接保持原文（解析器不会把它当链接）。
 */
export function markdownToPlainText(text: string): string {
  const lines: string[] = [];
  const lists: Array<{ ordered: boolean; next: number }> = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/\s+$/, ""));
    line = "";
  };
  for (const token of markdown.parse(text, {})) {
    switch (token.type) {
      case "bullet_list_open": lists.push({ ordered: false, next: 1 }); break;
      case "ordered_list_open": lists.push({ ordered: true, next: Number(token.attrGet("start") ?? 1) || 1 }); break;
      case "bullet_list_close": case "ordered_list_close": lists.pop(); break;
      case "list_item_open": {
        flush();
        const list = lists.at(-1);
        line = "  ".repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : "• ");
        break;
      }
      case "th_open": case "td_open": if (line) line += " | "; break;
      case "inline": line += inlinePlainText(token.children ?? []); break;
      case "fence": case "code_block": flush(); lines.push(...token.content.replace(/\n$/, "").split("\n")); break;
      case "paragraph_close": case "heading_close": case "tr_close": case "hr": flush(); break;
      default: break;
    }
  }
  flush();
  return lines.join("\n");
}
