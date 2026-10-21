/**
 * 声明式页面 PageSpec v0（探针内的最小草案）。
 *
 * 插件页面不允许运行「运行时生成的 JS」，所以 Agent / 模型生成页面时只产出一份 JSON：
 * 组件 + 数据绑定 + 动作引用。插件包里预置的渲染器按这份 JSON 画界面，
 * 按钮能做的事只来自下面的白名单，由插件代码去调真实能力。
 *
 * 校验是严格的：多一个字段、引用白名单外的动作、超出预算，整份拒绝并说明原因。
 */

export type Binding =
  | { source: "kv.value"; key: string }
  | { source: "kv.keys" }
  | { source: "probe.result"; probeId: string };

export type PageAction =
  | { type: "kv.set"; key: string; value?: string; fromField?: string }
  | { type: "kv.delete"; key: string }
  | { type: "probe.run"; probeId: string }
  | { type: "notify.post"; title: string; body: string };

export interface FormField {
  id: string;
  label: string;
}

export type PageComponent =
  | { id: string; kind: "text"; text: string }
  | { id: string; kind: "metric"; label: string; bind: Binding }
  | { id: string; kind: "list"; label: string; bind: Binding }
  | { id: string; kind: "button"; label: string; action: PageAction }
  | { id: string; kind: "form"; label: string; fields: FormField[]; submitLabel: string; action: PageAction };

export interface PageSpec {
  schemaVersion: 0;
  title: string;
  components: PageComponent[];
}

export interface SpecProblem {
  path: string;
  reason: string;
}

export type SpecParseResult = { ok: true; spec: PageSpec } | { ok: false; problems: SpecProblem[] };

export const LIMITS = {
  jsonBytes: 16 * 1024,
  components: 20,
  textChars: 500,
  labelChars: 40,
  fields: 6,
} as const;

/** 本版能用的动作和数据来源。 */
export const ALLOWED_ACTIONS = ["kv.set", "kv.delete", "probe.run", "notify.post"] as const;
export const ALLOWED_SOURCES = ["kv.value", "kv.keys", "probe.result"] as const;
/** 认识、但要连上外脑才能用的动作 / 数据来源。 */
export const CLOUD_ONLY = ["data.list", "data.create", "files.list", "files.upload", "kb.search", "model.chat"] as const;

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const PAGE_KEY = /^page\.[a-z0-9][a-z0-9.-]{0,40}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Checker {
  readonly problems: SpecProblem[] = [];
  constructor(private readonly runnableProbes: ReadonlySet<string>) {}

  add(path: string, reason: string): void {
    this.problems.push({ path, reason });
  }

  only(value: Json, path: string, allowed: string[]): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add(`${path}.${key}`, `不认识的字段「${key}」，页面只能用规定的字段`);
    }
  }

  text(value: unknown, path: string, max: number): string {
    if (typeof value !== "string" || value.trim() === "") {
      this.add(path, "必须是非空文字");
      return "";
    }
    if ([...value].length > max) this.add(path, `太长了，最多 ${max} 个字`);
    return value;
  }

  key(value: unknown, path: string): string {
    if (typeof value !== "string" || !PAGE_KEY.test(value)) {
      this.add(path, "只能读写以 page. 开头的键（小写字母、数字、点、短横线），碰不到探针自己的数据");
      return "";
    }
    return value;
  }

  probe(value: unknown, path: string): string {
    if (typeof value !== "string" || !this.runnableProbes.has(value)) {
      this.add(path, "只能运行本版可用的安全探针（不会跳转页面、不会弹通知的那些）");
      return "";
    }
    return value;
  }

  binding(value: unknown, path: string): Binding | undefined {
    if (!isObject(value)) {
      this.add(path, "必须是一个对象");
      return undefined;
    }
    const source = value["source"];
    if (typeof source === "string" && (CLOUD_ONLY as readonly string[]).includes(source)) {
      this.add(`${path}.source`, `「${source}」要连上外脑才能用，本版没有开通`);
      return undefined;
    }
    if (source === "kv.value") {
      this.only(value, path, ["source", "key"]);
      return { source, key: this.key(value["key"], `${path}.key`) };
    }
    if (source === "kv.keys") {
      this.only(value, path, ["source"]);
      return { source };
    }
    if (source === "probe.result") {
      this.only(value, path, ["source", "probeId"]);
      return { source, probeId: this.probe(value["probeId"], `${path}.probeId`) };
    }
    this.add(`${path}.source`, `数据来源「${String(source)}」不在白名单里（可用：${ALLOWED_SOURCES.join("、")}）`);
    return undefined;
  }

  action(value: unknown, path: string, fieldIds: string[] = []): PageAction | undefined {
    if (!isObject(value)) {
      this.add(path, "必须是一个对象");
      return undefined;
    }
    const type = value["type"];
    if (typeof type === "string" && (CLOUD_ONLY as readonly string[]).includes(type)) {
      this.add(`${path}.type`, `「${type}」要连上外脑才能用，本版没有开通`);
      return undefined;
    }
    switch (type) {
      case "kv.set": {
        this.only(value, path, ["type", "key", "value", "fromField"]);
        const key = this.key(value["key"], `${path}.key`);
        const hasValue = value["value"] !== undefined;
        const hasField = value["fromField"] !== undefined;
        if (hasValue === hasField) this.add(path, "value 和 fromField 必须二选一");
        if (hasValue) {
          const text = this.text(value["value"], `${path}.value`, LIMITS.textChars);
          return { type, key, value: text };
        }
        const fromField = value["fromField"];
        if (typeof fromField !== "string" || !fieldIds.includes(fromField)) {
          this.add(`${path}.fromField`, "fromField 必须指向同一个表单里的输入框");
          return undefined;
        }
        return { type, key, fromField };
      }
      case "kv.delete":
        this.only(value, path, ["type", "key"]);
        return { type, key: this.key(value["key"], `${path}.key`) };
      case "probe.run":
        this.only(value, path, ["type", "probeId"]);
        return { type, probeId: this.probe(value["probeId"], `${path}.probeId`) };
      case "notify.post":
        this.only(value, path, ["type", "title", "body"]);
        return { type, title: this.text(value["title"], `${path}.title`, LIMITS.labelChars), body: this.text(value["body"], `${path}.body`, LIMITS.textChars) };
      default:
        this.add(`${path}.type`, `动作「${String(type)}」不在白名单里（可用：${ALLOWED_ACTIONS.join("、")}）`);
        return undefined;
    }
  }

  component(value: unknown, path: string, ids: Set<string>): PageComponent | undefined {
    if (!isObject(value)) {
      this.add(path, "必须是一个对象");
      return undefined;
    }
    const id = value["id"];
    if (typeof id !== "string" || !ID.test(id)) this.add(`${path}.id`, "id 只能是小写字母开头的字母、数字、短横线，最多 32 个字");
    else if (ids.has(id)) this.add(`${path}.id`, `id「${id}」重复了`);
    else ids.add(id);
    const safeId = typeof id === "string" ? id : "";
    switch (value["kind"]) {
      case "text":
        this.only(value, path, ["id", "kind", "text"]);
        return { id: safeId, kind: "text", text: this.text(value["text"], `${path}.text`, LIMITS.textChars) };
      case "metric":
      case "list": {
        this.only(value, path, ["id", "kind", "label", "bind"]);
        const label = this.text(value["label"], `${path}.label`, LIMITS.labelChars);
        const bind = this.binding(value["bind"], `${path}.bind`);
        return bind ? { id: safeId, kind: value["kind"], label, bind } : undefined;
      }
      case "button": {
        this.only(value, path, ["id", "kind", "label", "action"]);
        const label = this.text(value["label"], `${path}.label`, LIMITS.labelChars);
        const action = this.action(value["action"], `${path}.action`);
        return action ? { id: safeId, kind: "button", label, action } : undefined;
      }
      case "form": {
        this.only(value, path, ["id", "kind", "label", "fields", "submitLabel", "action"]);
        const label = this.text(value["label"], `${path}.label`, LIMITS.labelChars);
        const submitLabel = this.text(value["submitLabel"], `${path}.submitLabel`, LIMITS.labelChars);
        const rawFields = value["fields"];
        const fields: FormField[] = [];
        if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > LIMITS.fields) {
          this.add(`${path}.fields`, `必须有 1 到 ${LIMITS.fields} 个输入框`);
        } else {
          const fieldIds = new Set<string>();
          rawFields.forEach((raw, index) => {
            const at = `${path}.fields[${index}]`;
            if (!isObject(raw)) return this.add(at, "必须是一个对象");
            this.only(raw, at, ["id", "label"]);
            const fieldId = raw["id"];
            if (typeof fieldId !== "string" || !ID.test(fieldId) || fieldIds.has(fieldId)) return this.add(`${at}.id`, "输入框 id 无效或重复");
            fieldIds.add(fieldId);
            fields.push({ id: fieldId, label: this.text(raw["label"], `${at}.label`, LIMITS.labelChars) });
          });
        }
        const action = this.action(value["action"], `${path}.action`, fields.map((field) => field.id));
        return action ? { id: safeId, kind: "form", label, fields, submitLabel, action } : undefined;
      }
      default:
        this.add(`${path}.kind`, `组件类型「${String(value["kind"])}」不认识（可用：text、metric、list、button、form）`);
        return undefined;
    }
  }
}

/** 解析并严格校验一份 PageSpec。`runnableProbes` 是页面可以触发的探针 id。 */
export function parsePageSpec(source: string, runnableProbes: ReadonlySet<string>): SpecParseResult {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > LIMITS.jsonBytes) return { ok: false, problems: [{ path: "$", reason: `整份太大了（${bytes} 字节），最多 ${LIMITS.jsonBytes} 字节` }] };
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return { ok: false, problems: [{ path: "$", reason: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }] };
  }
  const checker = new Checker(runnableProbes);
  if (!isObject(raw)) return { ok: false, problems: [{ path: "$", reason: "最外层必须是一个对象" }] };
  checker.only(raw, "$", ["schemaVersion", "title", "components"]);
  if (raw["schemaVersion"] !== 0) checker.add("$.schemaVersion", "schemaVersion 必须是 0");
  const title = checker.text(raw["title"], "$.title", LIMITS.labelChars);
  const components: PageComponent[] = [];
  const rawComponents = raw["components"];
  if (!Array.isArray(rawComponents) || rawComponents.length === 0) {
    checker.add("$.components", "至少要有一个组件");
  } else if (rawComponents.length > LIMITS.components) {
    checker.add("$.components", `组件太多了，最多 ${LIMITS.components} 个`);
  } else {
    const ids = new Set<string>();
    rawComponents.forEach((component, index) => {
      const parsed = checker.component(component, `$.components[${index}]`, ids);
      if (parsed) components.push(parsed);
    });
  }
  if (checker.problems.length > 0) return { ok: false, problems: checker.problems };
  return { ok: true, spec: { schemaVersion: 0, title, components } };
}

/** 预填的正例：一张「访客登记」小页面。 */
export const DEMO_SPEC = {
  schemaVersion: 0,
  title: "访客登记（示例）",
  components: [
    { id: "intro", kind: "text", text: "这张页面是一份 JSON，不含任何脚本。输入名字点保存，数据写进插件的本地存储，上面的数字会跟着变。" },
    { id: "last", kind: "metric", label: "最近登记", bind: { source: "kv.value", key: "page.visitor" } },
    { id: "keys", kind: "list", label: "页面保存过的键", bind: { source: "kv.keys" } },
    { id: "signup", kind: "form", label: "登记", fields: [{ id: "name", label: "名字" }], submitLabel: "保存", action: { type: "kv.set", key: "page.visitor", fromField: "name" } },
    { id: "clear", kind: "button", label: "清空登记", action: { type: "kv.delete", key: "page.visitor" } },
    { id: "check", kind: "button", label: "顺便测一下存储", action: { type: "probe.run", probeId: "kv-roundtrip" } },
    { id: "health", kind: "metric", label: "存储测试结果", bind: { source: "probe.result", probeId: "kv-roundtrip" } },
  ],
};

/** 预填的反例：每一份都应被拒，并说出原因。 */
export const BAD_SPECS: { label: string; spec: unknown }[] = [
  {
    label: "藏一段脚本",
    spec: { schemaVersion: 0, title: "反例", components: [{ id: "b", kind: "button", label: "点我", onClick: "alert(1)", action: { type: "kv.set", key: "page.x", value: "1" } }] },
  },
  {
    label: "调用不存在的动作",
    spec: { schemaVersion: 0, title: "反例", components: [{ id: "b", kind: "button", label: "执行命令", action: { type: "shell.exec", command: "rm -rf ~" } }] },
  },
  {
    label: "要用外脑数据",
    spec: { schemaVersion: 0, title: "反例", components: [{ id: "m", kind: "metric", label: "客户数", bind: { source: "data.list", collectionId: "clients" } }] },
  },
  {
    label: "改探针自己的数据",
    spec: { schemaVersion: 0, title: "反例", components: [{ id: "b", kind: "button", label: "改记录", action: { type: "kv.set", key: "probe.lastPing", value: "x" } }] },
  },
];
