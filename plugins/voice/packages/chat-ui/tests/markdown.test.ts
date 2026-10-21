import { beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { markdownToPlainText, renderMarkdownBubble } from "../src/markdown";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
});

describe("AI Markdown replies", () => {
  test("Chinese weather response renders headings, strong text and nested lists", () => {
    const bubble = renderMarkdownBubble("## 杭州天气\n\n- **当前温度**：约27°C\n- 未来天气\n  - 周一：晴\n\n> 以实时天气为准\n\n第一行\n第二行");
    expect(bubble.querySelector("h2")?.textContent).toBe("杭州天气");
    expect(bubble.querySelector("strong")?.textContent).toBe("当前温度");
    expect(bubble.querySelector("li ul li")?.textContent).toBe("周一：晴");
    expect(bubble.querySelector("blockquote")?.textContent).toContain("以实时天气为准");
    expect(bubble.querySelector("p br")).not.toBeNull();
  });

  test("code preserves whitespace and tables use CSP-compatible alignment classes", () => {
    const bubble = renderMarkdownBubble('```html\n  <script>example()</script>\n```\n\n| 天气 | 温度 |\n| :--- | ---: |\n| 多云 | 27°C |');
    expect(bubble.querySelector("pre code")?.textContent).toBe("  <script>example()</script>\n");
    expect(bubble.querySelector("script")).toBeNull();
    expect(bubble.querySelectorAll("th")).toHaveLength(2);
    expect(bubble.querySelector("td.chat-align-right")?.textContent).toBe("27°C");
    expect(bubble.querySelector("[style]")).toBeNull();
  });

  test("HTML stays literal and images cannot load remote or local resources", () => {
    const text = '<img src=x onerror="alert(1)">\n<script>alert(1)</script>\n\n![远程图](https://example.com/tracker.png)\n![本地图](file:///tmp/private.png)';
    const bubble = renderMarkdownBubble(text);
    expect(bubble.querySelector("img, script, iframe, object, svg, [onerror]")).toBeNull();
    expect(bubble.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(bubble.textContent).toContain("远程图");
    expect(bubble.textContent).toContain("本地图");
  });

  test("sources remain readable without a Host link handler", () => {
    const bubble = renderMarkdownBubble('[天气来源](https://example.com/weather?a=1&b=2)');
    expect(bubble.querySelector("a")).toBeNull();
    expect(bubble.querySelector(".chat-markdown-source")?.textContent).toBe("天气来源 (https://example.com/weather?a=1&b=2)");
    for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/private", "//example.com", "&#106;avascript:alert(1)"]) {
      const unsafe = renderMarkdownBubble(`[危险](${url})`);
      expect(unsafe.querySelector("a, .chat-markdown-source")).toBeNull();
    }
  });

  test("Markdown and bare source URLs request the Host opener only after a click", () => {
    const opened: string[] = [];
    const bubble = renderMarkdownBubble('[天气来源](https://example.com/weather?a=1&b=2)\n\nhttps://example.org/source\n\n`https://example.net/code`', (url) => opened.push(url));
    expect(opened).toEqual([]);
    const links = bubble.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com/weather?a=1&b=2");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    links[0]!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com/weather?a=1&b=2"]);
    links[1]!.click();
    expect(opened).toHaveLength(2);
  });

  test("bare URLs allow at signs after the authority and Chinese text with an email", () => {
    for (const text of ["https://medium.com/@name/post", "https://example.com/?email=a@b", "来源 https://a.com/x，作者邮箱 a@b.com"]) {
      const bubble = renderMarkdownBubble(text, () => undefined);
      expect(bubble.querySelector("a"), text).not.toBeNull();
    }
  });

  test("source links reject non-web schemes, credentials and invalid web URLs", () => {
    for (const url of ["mailto:a@example.com", "ftp://example.com/a", "file:///tmp/private", "data:text/html,test", "javascript:alert(1)", "//example.com/a", "https://user:pass@example.com/a", "https://"]) {
      const opened: string[] = [];
      const bubble = renderMarkdownBubble(`[来源](${url})`, (value) => opened.push(value));
      expect(bubble.querySelector("a") === null, url).toBe(true);
      expect(opened).toEqual([]);
    }
  });

  test("partial streamed content can be rendered again without losing its text", () => {
    expect(renderMarkdownBubble("**当前温度").textContent).toContain("当前温度");
    expect(renderMarkdownBubble("**当前温度**：27°C").querySelector("strong")?.textContent).toBe("当前温度");
    expect(renderMarkdownBubble("```ts\n  const x = 1").querySelector("code")?.textContent).toContain("  const x = 1");
  });

  test("中文标点紧贴在加粗里时仍按加粗渲染（rc.2.7 真机反馈：** 原样露出）", () => {
    const cases: Array<[string, string]> = [
      ["**天气：**晴转多云", "天气："],
      ["结论：**明天会下雨。**请带伞", "明天会下雨。"],
      ["气温为**“25度”**左右", "“25度”"],
      ["**北京（Beijing）**是首都", "北京（Beijing）"],
      ["推荐：**《三体》**这本书", "《三体》"],
      ["- **气温：**18~26℃\n- **风力：**3级", "气温："],
      ["**注意：**Mac 用户先授权", "注意："],
    ];
    for (const [text, strong] of cases) {
      const bubble = renderMarkdownBubble(text);
      expect(bubble.querySelector("strong")?.textContent, text).toBe(strong);
      expect(bubble.textContent, text).not.toContain("**");
    }
    // 英文与算式的既有判定不变：两侧都不是 CJK 时不放宽。
    expect(renderMarkdownBubble("a **(b)**c").querySelector("strong")).toBeNull();
    expect(renderMarkdownBubble("3 * 4 and 5*6").querySelector("em")).toBeNull();
    expect(renderMarkdownBubble("中文_变量_名").querySelector("em")).toBeNull();
  });

  test("纯文本投影去掉 Markdown 符号，列表、链接与代码可读", () => {
    const text = "## 明天天气\n\n**天气：**多云转晴\n\n- **气温：**18~26℃\n- 风力 `3级`\n  1. 上午\n  2. 下午\n\n> 以实时为准\n\n[来源](https://example.com/w) · [危险](javascript:alert(1)) ![图](https://x.test/a.png)\n\n```\n  code\n```\n\n| 城市 | 天气 |\n| --- | --- |\n| 北京 | 晴 |";
    expect(markdownToPlainText(text)).toBe([
      "明天天气",
      "天气：多云转晴",
      "• 气温：18~26℃",
      "• 风力 3级",
      "  1. 上午",
      "  2. 下午",
      "以实时为准",
      "来源 (https://example.com/w) · [危险](javascript:alert(1)) 图",
      "  code",
      "城市 | 天气",
      "北京 | 晴",
    ].join("\n"));
    expect(markdownToPlainText("第一行\n第二行")).toBe("第一行\n第二行");
    expect(markdownToPlainText("<b>原样</b> & 符号")).toBe("<b>原样</b> & 符号");
    expect(markdownToPlainText("")).toBe("");
  });
});
