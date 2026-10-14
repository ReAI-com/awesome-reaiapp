/** Keep developer templates inside the business view. Do not execute template code. */
const TAGS = new Set('DIV SECTION ARTICLE HEADER FOOTER H1 H2 H3 H4 P SPAN STRONG EM SMALL UL OL LI TABLE THEAD TBODY TR TH TD CAPTION BR HR'.split(' '));
const DROP = new Set('SCRIPT STYLE IFRAME OBJECT EMBED LINK META SVG MATH IMG AUDIO VIDEO FORM INPUT BUTTON TEXTAREA SELECT'.split(' '));
const PROPERTIES = new Set('color background-color font-size font-weight line-height letter-spacing text-align padding padding-top padding-bottom padding-left padding-right margin margin-top margin-bottom margin-left margin-right border border-color border-width border-style border-radius display gap grid-template-columns align-items justify-content max-width'.split(' '));
const encoder = new TextEncoder();
const cssName = '[a-zA-Z_][a-zA-Z0-9_-]*';
const cssClass = `\\.${cssName}`;
const cssCompound = `(?:[a-zA-Z][a-zA-Z0-9-]*(?:${cssClass})*|(?:${cssClass})+)`;
const cssSelector = new RegExp(`^${cssCompound}(?:(?:\\s*>\\s*|\\s+)${cssCompound})*$`);

export function renderSafeTemplate(container: HTMLElement, html: string, values: Record<string, string>, options?: {listIds:string[]}): void {
  if (encoder.encode(html).length > 16_384) throw new Error('页面模板不能超过 16 KiB');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const copy = (node: Node, parent: Node): void => {
    if (node.nodeType === 3) {
      const content = (node.textContent ?? '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '');
      parent.appendChild(document.createTextNode(content)); return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (DROP.has(element.tagName)) return;
    if (!TAGS.has(element.tagName)) { for (const child of Array.from(node.childNodes)) copy(child, parent); return; }
    const safe = document.createElement(element.tagName.toLowerCase());
    const cls = element.getAttribute('class');
    if (cls && /^[a-zA-Z0-9_ -]{1,128}$/.test(cls)) safe.className = cls;
    const binding=element.getAttribute('data-binding');
    if(element.tagName==='DIV'&&binding&&options?.listIds.includes(binding))safe.dataset.binding=binding;
    for (const child of Array.from(node.childNodes)) copy(child, safe);
    parent.appendChild(safe);
  };
  const fragment = document.createDocumentFragment();
  for (const node of Array.from(parsed.body.childNodes)) copy(node, fragment);
  container.replaceChildren(fragment);
}

/** Validate page markup without a browser. Only trusted components can fill list slots. */
export function validatePageMarkup(html:string,options:{scalarIds:string[];listIds:string[]}):void {
  if(encoder.encode(html).length>16_384)throw new Error('页面模板不能超过 16 KiB');
  const scalars=new Set(['company','role','jobTitle','recordCount','sourceCount','reportCount','updatedAt',...options.scalarIds]);
  const lists=new Set(options.listIds);const slots=new Map<string,number>();
  if(/<!--|<!|<\?|<[^>]*\{\{/i.test(html))throw new Error('页面模板不支持声明或属性数据变量');
  const tags=/<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  for(const tag of html.matchAll(tags)) {
    const name=tag[1]!.toUpperCase();const attrs=tag[2]!;
    if(!TAGS.has(name)||attrs.includes('{{'))throw new Error('页面标签或属性不在允许范围');
    if(tag[0].startsWith('</')) {if(attrs.trim())throw new Error('页面结束标签无效');continue;}
    const entries=new Map<string,string>();
    const rest=attrs.replace(/\s+([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(["'])(.*?)\2/g,(_all,key:string,_quote:string,value:string)=>{
      if(entries.has(key))throw new Error('页面属性重复');entries.set(key,value);return '';
    }).trim();
    if(rest&&rest!=='/')throw new Error('页面属性格式无效');
    for(const [key,value]of entries) {
      if(key==='class'&&/^[a-zA-Z0-9_ -]{1,128}$/.test(value))continue;
      if(key!=='data-binding'||name!=='DIV'||!lists.has(value))throw new Error('页面属性或数据插槽未声明');
      const after=html.slice(tag.index!+tag[0].length);
      if(!/^\s*<\/div\s*>/i.test(after))throw new Error('数据插槽必须是空 DIV');
      slots.set(value,(slots.get(value)??0)+1);
    }
  }
  const text=html.replace(tags,'');
  const remaining=text.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g,(_all,id:string)=>{
    if(!scalars.has(id))throw new Error('页面使用了未声明的数据变量');return '';
  });
  if(remaining.includes('{{')||remaining.includes('}}'))throw new Error('页面数据变量格式无效');
  for(const id of lists)if(slots.get(id)!==1)throw new Error('每个列表绑定必须对应一个数据插槽');
}

export function validateScopedCss(css: string): Array<{ selector: string; declarations: Array<[string, string]> }> {
  if (encoder.encode(css).length > 8_192) throw new Error('自定义 CSS 不能超过 8 KiB');
  if (/[@\\\x00-\x08\x0b\x0c\x0e-\x1f]|url\s*\(|expression\s*\(|\/\*/i.test(css)) throw new Error('CSS 含有不允许的外链、转义或 Host Token 覆盖');
  const rules: Array<{ selector: string; declarations: Array<[string, string]> }> = [];
  let remaining = css;
  while (remaining.trim()) {
    const match = /^\s*([^{}]+)\{([^{}]*)\}/.exec(remaining);
    if (!match) throw new Error('CSS 只支持普通选择器和样式声明');
    const selector = match[1]!.trim();
    if (selector.length > 160 || !selector.split(',').every(part=>cssSelector.test(part.trim()))) throw new Error('CSS 选择器不在允许范围');
    const declarations: Array<[string, string]> = [];
    for (const raw of match[2]!.split(';').filter(x => x.trim())) {
      const colon = raw.indexOf(':');
      const key = raw.slice(0, colon).trim().toLowerCase(); const value = raw.slice(colon + 1).trim();
      if (colon < 1 || !PROPERTIES.has(key) || !value || value.length > 160 || /[{}<>!]|(?:fixed|absolute|none|hidden)/i.test(value)) throw new Error(`CSS 属性不允许：${key}`);
      if (!/^[a-zA-Z0-9_#().,%\s\-]+$/.test(value)) throw new Error('CSS 值不在允许范围');
      declarations.push([key, value]);
    }
    rules.push({ selector, declarations }); remaining = remaining.slice(match[0].length);
  }
  return rules;
}

export function applyScopedCss(container: HTMLElement, css: string): () => void {
  const previous: Array<{ el: HTMLElement; key: string; value: string }> = [];
  for (const rule of validateScopedCss(css)) {
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(rule.selector))) {
      for (const [key, value] of rule.declarations) {
        previous.push({ el, key, value: el.style.getPropertyValue(key) });
        el.style.setProperty(key, value);
      }
    }
  }
  return () => { for (const entry of previous.reverse()) entry.el.style.setProperty(entry.key, entry.value); };
}
