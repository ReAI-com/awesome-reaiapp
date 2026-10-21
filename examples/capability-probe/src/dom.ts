/** 只用 DOM API 造元素：文字一律走 textContent，不拼 HTML 字符串。 */

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

/** 自绘线性图标：24 网格、线宽 2，跟 Host 图标并排时粗细一致。 */
const ICON_PATHS = {
  play: "M7 4.5v15l12-7.5z",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18 M6 6l12 12",
  alert: "M12 3 2 20h20z M12 10v4 M12 17v.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2",
  lock: "M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4",
  cloud: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z",
  grid: "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6h.01 M4 12h.01 M4 18h.01",
  layout: "M4 4h16v16H4z M4 9h16 M10 9v11",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6z M14 2v6h6",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
  home: "M3 11 12 3l9 8 M5 9.5V21h14V9.5",
  arrow: "m9 18 6-6-6-6",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function icon(doc: Document, name: IconName, className = "cp-icon"): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}
