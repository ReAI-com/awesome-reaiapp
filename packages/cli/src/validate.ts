/**
 * Manifest 校验 —— 与 Host 的 Rust 校验器**同一套规则、同一套稳定错误码**。
 *
 * 两处实现是刻意的：App 开发者的机器上没有 Host，必须能离线拿到一模一样的结论；
 * Host 又不能信任任何客户端校验结果。防止两边漂的机制不是「小心点」，而是
 * `fixtures/manifests/` 下的共用正反样例——两侧跑同一批样例，得出的错误码集合必须
 * 一致，任何一边改了规则忘了同步，另一边的 fixture 测试立刻红。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "./json-schema";
import { loadSchema, loadSupportMatrix, type SupportMatrix } from "./assets";

/** Host 与 CLI 共读同一份管理审核 policy，避免能力白名单双份漂移。 */
const reviewPolicy = JSON.parse(
  readFileSync(
    fileURLToPath(import.meta.resolve("@reai/app-contract/capability-review-policy.seed.json")),
    "utf8",
  ),
) as {
  approvals: Array<{ appId: string; approvedHostCapabilities: string[] }>;
};
const REVIEW_APPROVED_APPS = Object.fromEntries(
  reviewPolicy.approvals.map((approval) => [
    approval.appId,
    approval.approvedHostCapabilities,
  ]),
) as Record<string, readonly string[]>;

function hasReviewApproval(appId: string, capability: string): boolean {
  return REVIEW_APPROVED_APPS[appId]?.includes(capability) ?? false;
}

/** 与 Rust `AppErrorCode` 一一对应的稳定错误码。 */
export type StableErrorCode =
  | "HOST_CAPABILITY_NOT_AVAILABLE"
  | "HOST_RUNTIME_KIND_NOT_SUPPORTED"
  | "HOST_API_INCOMPATIBLE"
  | "MANIFEST_SCHEMA_INVALID"
  | "MANIFEST_REFERENCE_INVALID"
  | "MANIFEST_DUPLICATE_ID"
  | "PACKAGE_PATH_UNSAFE"
  | "APP_CAPABILITY_NOT_GRANTED"
  | "APP_PERMISSION_UNSUPPORTED";

export interface Finding {
  code: StableErrorCode;
  pointer: string;
  detail: string;
}

type Json = Record<string, unknown>;

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const obj = (value: unknown): Json => (isObject(value) ? value : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let childDepth = 0;
    for (const child of value) childDepth = Math.max(childDepth, jsonDepth(child));
    return 1 + childDepth;
  }
  if (isObject(value)) {
    let childDepth = 0;
    for (const child of Object.values(value)) {
      childDepth = Math.max(childDepth, jsonDepth(child));
    }
    return 1 + childDepth;
  }
  return 0;
}

/**
 * Rust/JS 一致的保守 JSON 预算。
 *
 * 字符串按紧凑 JSON 的真实 UTF-8 字节计；数字统一按合法 JSON number 的最坏 24 bytes
 * 计费。这样 `1.0` 在 serde_json 与 JSON.parse/JSON.stringify 间不会因为词法丢失而让
 * 安装前 CLI 与 Host 在 4096 边界两边打架，同时预算永远不小于实际紧凑序列化结果。
 */
function jsonBudgetBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? 24 : Number.MAX_SAFE_INTEGER;
  if (typeof value === "string") {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  if (Array.isArray(value)) {
    return 2 + Math.max(0, value.length - 1)
      + value.reduce((total, child) => total + jsonBudgetBytes(child), 0);
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    return 2 + Math.max(0, entries.length - 1) + entries.reduce(
      (total, [key, child]) => total
        + new TextEncoder().encode(JSON.stringify(key)).byteLength
        + 1
        + jsonBudgetBytes(child),
      0,
    );
  }
  return Number.MAX_SAFE_INTEGER;
}

/** 从文件读并校验。 */
export function validateManifestFile(path: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return [
      {
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: "(文件)",
        detail: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  return validateManifest(parsed);
}

/** 校验一份已解析的 Manifest。空数组表示通过。 */
export function validateManifest(
  manifest: unknown,
  matrix: SupportMatrix = loadSupportMatrix(),
): Finding[] {
  const out: Finding[] = [];

  // 第一层：结构。schema 不过就没必要往下查语义了——后面每条规则都假定字段存在且类型正确。
  const schema = loadSchema();
  for (const violation of validateAgainstSchema(manifest, schema)) {
    if (notificationLengthFalsePositive(violation, manifest, schema)) continue;
    out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer: violation.pointer,
      detail: violation.message,
    });
  }
  if (out.length > 0 || !isObject(manifest)) return out;

  checkBasics(manifest, out);
  checkHostApi(manifest, matrix, out);
  if (str(manifest["packageType"]) === "skin") {
    checkSkinPackage(manifest, out);
    return out;
  }
  if (manifest["skin"] !== undefined) {
    out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: "skin", detail: "普通 App 不能声明 skin" });
  }
  checkCapabilities(manifest, matrix, out);
  checkPermissions(manifest, matrix, out);
  checkRejectedWhenNonEmpty(manifest, out);
  checkRequirements(manifest, out);
  checkFixedValues(manifest, matrix, out);
  checkNetwork(manifest, out);
  checkDualLayerCapabilities(manifest, out);
  checkRuntime(manifest, matrix, out);
  checkContributes(manifest, matrix, out);
  checkNotificationScenes(manifest, matrix, out);
  checkEventSubscriptions(manifest, matrix, out);
  checkAcceptsActionContext(manifest, matrix, out);
  checkAgentFeatures(manifest, matrix, out);
  checkReferences(manifest, out);
  checkUniqueIds(manifest, out);
  checkAppIntents(manifest, out);
  checkServices(manifest, matrix, out);

  return out;
}

function checkSkinPackage(m: Json, out: Finding[]): void {
  const skin = obj(m["skin"]);
  if (str(skin["apiVersion"]) !== "1") {
    out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: "skin.apiVersion", detail: "当前只支持 Skin API 1" });
  }
  if (str(skin["entry"]) !== "skin/skin.json") {
    out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: "skin.entry", detail: "Skin v1 入口必须是 skin/skin.json" });
  }
  const runtime = obj(m["runtime"]);
  const requires = obj(m["requires"]);
  const network = obj(m["network"]);
  const data = obj(m["data"]);
  const contributes = obj(m["contributes"]);
  const contributesNonEmpty = contributes["notificationScenes"] !== undefined || Object.values(contributes).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null,
  );
  const invalid: Array<[boolean, string]> = [
    [arr(runtime["components"]).length > 0, "runtime.components"],
    [arr(m["permissions"]).length > 0, "permissions"],
    [arr(network["endpoints"]).length > 0, "network.endpoints"],
    [arr(requires["hostCapabilities"]).length > 0, "requires.hostCapabilities"],
    [arr(requires["hardwareServices"]).length > 0, "requires.hardwareServices"],
    [arr(requires["appIntents"]).length > 0, "requires.appIntents"],
    [arr(requires["services"]).length > 0, "requires.services"],
    [arr(data["privateStores"]).length > 0, "data.privateStores"],
    [arr(data["imports"]).length > 0, "data.imports"],
    [arr(data["exports"]).length > 0, "data.exports"],
    [str(obj(m["billing"])["mode"]) !== "none", "billing.mode"],
    [m["oauthAppId"] !== undefined, "oauthAppId"],
    [contributesNonEmpty, "contributes"],
  ];
  for (const [present, pointer] of invalid) {
    if (present) out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer,
      detail: "skin 包不能申请运行时能力、权限、网络、数据或普通插件贡献",
    });
  }
}

function checkBasics(m: Json, out: Finding[]): void {
  if (str(m["manifestVersion"]) !== "1.1") {
    out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer: "manifestVersion",
      detail: `只支持 "1.1"，收到 ${JSON.stringify(m["manifestVersion"])}`,
    });
  }
  for (const field of ["appId", "version", "publisherId", "name"]) {
    if (str(m[field]).trim() === "") {
      out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: field, detail: "不能为空" });
    }
  }
  checkIdentityShape(m, out);
}

/**
 * 一段身份标识：小写字母数字开头结尾，中间可含连字符。
 * 与 `schemas/app-manifest-1.1.schema.json` 的 appId pattern 同义，也与 Rust 侧
 * `check_identity_shape` 的 `segment_ok` 同义——三处必须一起改。
 */
function identitySegmentOk(seg: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(seg);
}

/**
 * `appId` 与 `privateStores[].id` 的**字面形状**。
 *
 * 这不是排版洁癖，是隔离边界的前提——两个值都会被**拼进复合标识**：
 *
 * - Host 的 KV 键是 `appId/storeId/key`。只要 `appId` 里能出现 `/`，
 *   `{app:"a", store:"b/c"}` 与 `{app:"a/b", store:"c"}` 就会落到同一个键上，
 *   而两份 Manifest 各自看都合法。
 * - 承载 App 的 WebView 标签由 `appId` 生成，生成时把非字母数字统一换成 `-`；
 *   那个映射只有在 appId 本身不含 `-` 时才是单射，而标签是 ACL、会话与挂载三处的键。
 *
 * ⚠️ 这条规则必须与 Rust 侧 `src-tauri/src/apps/validator.rs` 的 `check_identity_shape`
 * **保持一致**：两边共用 `fixtures/manifests/` 那批正反样例，一边改了另一边不改，
 * 反例测试会立刻红——那正是这批共享样例存在的意义。
 */
function checkIdentityShape(m: Json, out: Finding[]): void {
  // ⚠️ 校验**原件**，不校验 trim 过的副本——Host 侧拼 KV 键、生成 WebView 标签
  // 用的都是未 trim 的原始字段。「验副本、用原件」这种错位迟早会失配，
  // 而那种 bug 从现场完全看不出来。规则里本来就不允许空白，直接验原件即可。
  const appId = str(m["appId"]);
  // 全空白已由上面报过「不能为空」，这里不重复报同一件事
  if (appId.trim() !== "") {
    const segments = appId.split(".");
    if (segments.length < 2 || !segments.every(identitySegmentOk)) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: "appId",
        detail: `必须是反向域名（至少两段，每段由小写字母数字构成、中间可含连字符），收到 ${JSON.stringify(appId)}`,
      });
    }
  }

  const data = (m["data"] ?? {}) as Json;
  const stores = (data["privateStores"] ?? []) as Json[];
  stores.forEach((store, i) => {
    // 同上：验原件。storeId 是 KV 键的第二段。
    const id = str((store ?? {})["id"]);
    if (!identitySegmentOk(id)) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `data.privateStores[${i}].id`,
        detail: `必须由小写字母数字构成、中间可含连字符，且不能带点或斜杠，收到 ${JSON.stringify(id)}`,
      });
    }
  });
}

function checkHostApi(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const range = str(obj(m["hostApi"])["range"]).trim();
  if (range === "") {
    out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: "hostApi.range", detail: "不能为空" });
    return;
  }
  if (!satisfiesHostApiRange(matrix.hostApi, range)) {
    out.push({
      code: "HOST_API_INCOMPATIBLE",
      pointer: "hostApi.range",
      detail: `当前 Host API 是 ${matrix.hostApi}，range ${JSON.stringify(range)} 不覆盖它`,
    });
  }
}

export function satisfiesHostApiRange(hostApi: string, range: string): boolean {
  const host = parseVersion(hostApi);
  if (!host) return false;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => {
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;
    if ([match[2], match[3], match[4]].some((part) => part !== String(Number(part)))) {
      return false;
    }
    const target: [number, number, number] = [Number(match[2]), Number(match[3]), Number(match[4])];
    const compare = compareVersion(host, target);
    switch (match[1] ?? "=") {
      case ">=": return compare >= 0;
      case "<=": return compare <= 0;
      case ">": return compare > 0;
      case "<": return compare < 0;
      case "^": {
        if (compare < 0) return false;
        if (target[0] > 0) return host[0] === target[0];
        if (target[1] > 0) return host[0] === 0 && host[1] === target[1];
        return host[0] === 0 && host[1] === 0 && host[2] === target[2];
      }
      case "~":
        return compare >= 0 && host[0] === target[0] && host[1] === target[1];
      case "=":
        return compare === 0;
      default: return false;
    }
  });
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function checkCapabilities(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const appId = str(m["appId"]);
  const caps = arr(obj(m["requires"])["hostCapabilities"]);
  caps.forEach((cap, i) => {
    const name = str(cap);
    const pointer = `requires.hostCapabilities[${i}]`;
    if (matrix.hostCapabilities.granted.includes(name)) return;
    // grantGated：CLI 不知道 Host 侧的授予数据，一律按未授予报——开发者本地
    // 就看到自己的 Manifest 要求了特权能力，而不是装上才被拒。
    //
    // 审核候选例外：机器 policy 已登记的源码可以离线 build/pack；生产 Host 仍会
    // 用发布者、版本与最终包 SHA-256 重验，CLI 通过不等于获得运行授权。
    if (matrix.hostCapabilities.grantGated.includes(name)) {
      if (!hasReviewApproval(appId, name)) {
        out.push({
          code: "APP_CAPABILITY_NOT_GRANTED",
          pointer,
          detail: `${name} 已实现但需按 App 授予：该 appId 不在授予清单`,
        });
      }
      return;
    }
    const reason = matrix.hostCapabilities.withheld[name];
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer,
      detail: reason
        ? `${name} 首版不提供：${reason}`
        : `${name} 不是本 Host 认识的能力（拼写错误，或来自更高版本的规范）`,
    });
  });
}

function checkRejectedWhenNonEmpty(m: Json, out: Finding[]): void {
  const reject = (pointer: string, empty: boolean, why: string) => {
    if (!empty) out.push({ code: "HOST_CAPABILITY_NOT_AVAILABLE", pointer, detail: why });
  };
  const requires = obj(m["requires"]);
  const data = obj(m["data"]);

  reject(
    "requires.hardwareServices",
    arr(requires["hardwareServices"]).length === 0,
    "首版没有 Hardware Provider Registry，硬件绑定由用户在键位页手动指向插件 Command",
  );
  reject("data.imports", arr(data["imports"]).length === 0, "首版不做跨 App 数据共享");
  reject("data.exports", arr(data["exports"]).length === 0, "首版不做跨 App 数据共享");
  reject("data.migration", data["migration"] === undefined, "首版不做更新，因此没有迁移流程");
  reject(
    "contributes.recommendedBindings",
    arr(obj(m["contributes"])["recommendedBindings"]).length === 0,
    "插件只声明可绑定 Command，键位一律由用户在绑定页配置",
  );
}

function checkRequirements(m: Json, out: Finding[]): void {
  const requirements = arr(m["requirements"]);
  if (requirements.length === 0) return;
  if (str(m["requirementsVersion"]) !== "1.2") {
    out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer: "requirementsVersion",
      detail: "非空 requirements 必须显式声明 requirementsVersion=\"1.2\"",
    });
  }

  const components = new Set(arr(obj(m["runtime"])["components"]).map((item) => str(obj(item)["id"])));
  const capabilities = new Set(arr(obj(m["requires"])["hostCapabilities"]).map(str));
  const platforms = new Set(arr(m["targets"]).map((item) => str(obj(item)["platform"])));
  const ids = new Set<string>();
  const edges = new Set<string>();

  requirements.forEach((raw, index) => {
    const requirement = obj(raw);
    const at = (field: string) => `requirements[${index}].${field}`;
    const id = str(requirement["id"]);
    if (ids.has(id)) {
      out.push({ code: "MANIFEST_DUPLICATE_ID", pointer: at("id"), detail: `requirement id ${JSON.stringify(id)} 重复` });
    }
    ids.add(id);
    if (!components.has(str(requirement["componentId"]))) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: at("componentId"),
        detail: `componentId ${JSON.stringify(requirement["componentId"])} 不存在`,
      });
    }
    arr(requirement["requiredFor"]).forEach((rawReference, requiredForIndex) => {
      const reference = str(rawReference);
      const capability = reference.startsWith("capability:") ? reference.slice("capability:".length) : "";
      if (capability === "" || !capabilities.has(capability)) {
        out.push({
          code: "MANIFEST_REFERENCE_INVALID",
          pointer: `${at("requiredFor")}[${requiredForIndex}]`,
          detail: capability === ""
            ? "requiredFor 只接受 capability:<id>"
            : `capability ${JSON.stringify(capability)} 未在 requires.hostCapabilities 声明`,
        });
      }
    });
    arr(requirement["platforms"]).forEach((rawPlatform, platformIndex) => {
      const platform = str(rawPlatform);
      if (!platforms.has(platform)) {
        out.push({
          code: "MANIFEST_REFERENCE_INVALID",
          pointer: `${at("platforms")}[${platformIndex}]`,
          detail: `platform ${JSON.stringify(platform)} 不在 targets 中`,
        });
      }
    });
    const constraint = str(obj(requirement["version"])["constraint"]);
    if (!validVersionRequirement(constraint)) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: at("version.constraint"),
        detail: `无效 SemVer 约束 ${JSON.stringify(constraint)}`,
      });
    }
    const provision = obj(requirement["provision"]);
    const edge = `${str(requirement["componentId"])}\u0000${str(provision["resourceId"])}`;
    if (edges.has(edge)) {
      out.push({
        code: "MANIFEST_DUPLICATE_ID",
        pointer: at("provision.resourceId"),
        detail: "同一 component 不能重复声明同一 resourceId",
      });
    }
    edges.add(edge);
  });
}

function validVersionRequirement(range: string): boolean {
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => {
    const match = token.match(
      /^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    );
    return match !== null
      && [match[2], match[3], match[4]].every((part) => part === String(Number(part)));
  });
}

/**
 * 双层能力的交叉校验。
 *
 * `cloud.model.invoke@1` / `cloud.workflow.invoke@1` / `voice.deliver@1` 在
 * `hostCapabilities`（平台放行）与 `permissions`（用户同意）里各要声明一次。
 * 没有这条规则，只声明一半的插件能通过打包、装得上，**运行时才炸**——而那时
 * 报错指向的是 Host，插件开发者查不到自己身上。
 *
 * 与「声明 network.endpoints 就必须声明 http.fetch@1」是同一条既有范式。
 */
const DUAL_LAYER_CAPABILITIES = [
  "cloud.model.invoke@1",
  "cloud.workflow.invoke@1",
  "voice.deliver@1",
  "voice.context@1",
  "agent.session@1",
  "agent.session@2",
  "local.terminal.exec@1",
  "agent.dsh-observe@1",
  "terminal.session@1",
  // v1.0.5 开放的 grantGated 平台服务：平台批准与同名用户同意必须成对声明。
  "audio.capture@1",
  "tasks.present@1",
  "notifications.publish@1",
  "resources.files@1",
] as const;

function checkDualLayerCapabilities(m: Json, out: Finding[]): void {
  const capabilities = arr(obj(m["requires"])["hostCapabilities"]).map(str);
  const permissions = arr(m["permissions"]).map((raw) => str(obj(raw)["id"]));
  for (const id of DUAL_LAYER_CAPABILITIES) {
    const hasCapability = capabilities.includes(id);
    const hasPermission = permissions.includes(id);
    if (hasCapability && !hasPermission) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: "permissions",
        detail: `声明 requires.hostCapabilities 的 ${id} 时必须同时声明同名用户权限`,
      });
    }
    if (hasPermission && !hasCapability) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: "requires.hostCapabilities",
        detail: `声明 ${id} 用户权限时必须同时声明同名平台能力`,
      });
    }
  }
}

function checkNetwork(m: Json, out: Finding[]): void {
  const endpoints = arr(obj(m["network"])["endpoints"]);
  const permissions = arr(m["permissions"]).map((raw) => str(obj(raw)["id"]));
  if (endpoints.length > 0 && !permissions.includes("http.fetch@1")) {
    out.push({
      code: "MANIFEST_REFERENCE_INVALID",
      pointer: "permissions",
      detail: "声明 network.endpoints 时必须同时声明 http.fetch@1 用户权限",
    });
  }
  const componentIds = new Set(
    arr(obj(m["runtime"])["components"]).map((raw) => str(obj(raw)["id"])),
  );
  endpoints.forEach((raw, index) => {
    const endpoint = obj(raw);
    const at = (field: string) => `network.endpoints[${index}].${field}`;
    if (str(obj(endpoint["auth"])["mode"]) === "oauth_app" && str(m["oauthAppId"]) === "") {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: "oauthAppId",
        detail: "oauth_app endpoint 必须同时声明 oauthAppId",
      });
    }
    if (!componentIds.has(str(endpoint["componentId"]))) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: at("componentId"),
        detail: `componentId ${JSON.stringify(endpoint["componentId"])} 未声明`,
      });
    }
    if (
      endpoint["owner"] === "user_configured" ||
      endpoint["userConfiguredOrigins"] !== undefined ||
      endpoint["providerMode"] === "user_configurable"
    ) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: at(
          endpoint["owner"] === "user_configured"
            ? "owner"
            : endpoint["providerMode"] === "user_configurable"
              ? "providerMode"
              : "userConfiguredOrigins",
        ),
        detail: "当前 Host 尚未实现用户自定义 origin 授权",
      });
    }
    const categories = arr(endpoint["dataCategories"]).map(str);
    if (categories.includes("none") && categories.length !== 1) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: at("dataCategories"),
        detail: "none 不能与其他数据类别同时声明",
      });
    }
    const retention = obj(endpoint["retention"]);
    const retentionMode = str(retention["mode"]);
    if (["none", "session"].includes(retentionMode)) {
      if (retention["maxDays"] !== undefined || retention["policyUrl"] !== undefined) {
        out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: at("retention"), detail: "none/session 留存不能带 maxDays 或 policyUrl" });
      }
    } else if (retentionMode === "fixed" && retention["maxDays"] === undefined) {
      out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: at("retention.maxDays"), detail: "fixed 留存必须声明 maxDays" });
    } else if (retentionMode === "provider_policy") {
      let policyOk = false;
      try { policyOk = new URL(str(retention["policyUrl"])).protocol === "https:"; } catch { policyOk = false; }
      if (retention["maxDays"] === undefined || !policyOk) {
        out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: at("retention"), detail: "provider_policy 必须声明 maxDays 与 HTTPS policyUrl" });
      }
    }

    arr(endpoint["origins"]).forEach((value, originIndex) => {
      const text = str(value);
      let valid = false;
      try {
        const url = new URL(text);
        valid = url.protocol === "https:" && url.username === "" && url.password === "" &&
          url.pathname === "/" && url.search === "" && url.hash === "" &&
          url.hostname.toLowerCase() !== "localhost" && !/^\[?[0-9a-f:.]+\]?$/i.test(url.hostname) &&
          text === url.origin;
      } catch { valid = false; }
      if (!valid) {
        out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: `${at("origins")}[${originIndex}]`, detail: `正式 endpoint 必须是精确 HTTPS 域名 origin，收到 ${JSON.stringify(text)}` });
      }
    });
    arr(endpoint["pathPrefixes"]).forEach((value, pathIndex) => {
      const path = str(value);
      const lower = path.toLowerCase();
      if (!path.startsWith("/") || path.includes("\\") || path.split("/").includes("..") || ["%2e", "%2f", "%5c"].some((item) => lower.includes(item))) {
        out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: `${at("pathPrefixes")}[${pathIndex}]`, detail: `path prefix 不安全: ${JSON.stringify(path)}` });
      }
    });
  });
}

function checkPermissions(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const seen = new Set<string>();
  for (const [index, raw] of arr(m["permissions"]).entries()) {
    const permission = obj(raw);
    const id = str(permission["id"]);
    if (seen.has(id)) {
      out.push({
        code: "MANIFEST_DUPLICATE_ID",
        pointer: `permissions[${index}].id`,
        detail: `permission id ${JSON.stringify(id)} 重复`,
      });
    }
    seen.add(id);
    if (!matrix.pluginPermissions.supported[id]) {
      const reason = matrix.pluginPermissions.withheld[id];
      out.push({
        code: "APP_PERMISSION_UNSUPPORTED",
        pointer: `permissions[${index}].id`,
        detail: reason ? `${id} 当前暂不开放：${reason}` : `${id} 不是本 Host 认识的插件权限`,
      });
    }
  }
}

function checkFixedValues(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const fixed = matrix.fixedValues;

  const requirementsVersion = m["requirementsVersion"];
  if (requirementsVersion !== undefined && !["1.1", "1.2"].includes(str(requirementsVersion))) {
    out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer: "requirementsVersion",
      detail: `只支持 \"1.1\" 或 \"1.2\"，收到 ${JSON.stringify(requirementsVersion)}`,
    });
  }

  const policyVersion = obj(m["network"])["policyVersion"] ?? 1;
  if (policyVersion !== fixed["network.policyVersion"]) {
    out.push({
      code: "MANIFEST_SCHEMA_INVALID",
      pointer: "network.policyVersion",
      detail: `必须是 ${fixed["network.policyVersion"]}，收到 ${policyVersion}`,
    });
  }

  const billingMode = obj(m["billing"])["mode"] ?? "none";
  if (billingMode !== fixed["billing.mode"]) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "billing.mode",
      detail: `首版没有 Billing，必须是 ${JSON.stringify(fixed["billing.mode"])}，收到 ${JSON.stringify(billingMode)}`,
    });
  }
}

function checkRuntime(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const r = matrix.runtime;
  const components = arr(obj(m["runtime"])["components"]);

  if (components.length !== r.componentCount.exactly) {
    out.push({
      code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
      pointer: "runtime.components",
      detail: `首版只支持恰好 ${r.componentCount.exactly} 个组件，收到 ${components.length}`,
    });
  }

  const declaredTargets = new Set(arr(m["targets"]).map((t) => str(obj(t)["platform"])));

  components.forEach((raw, i) => {
    const c = obj(raw);
    const at = (field: string) => `runtime.components[${i}].${field}`;

    if (!r.kinds.includes(str(c["kind"]))) {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("kind"),
        detail: `首版只支持 ${JSON.stringify(r.kinds)}，收到 ${JSON.stringify(c["kind"])}`,
      });
    }
    if (!r.protocols.includes(str(c["protocol"]))) {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("protocol"),
        detail: `首版只支持 ${JSON.stringify(r.protocols)}，收到 ${JSON.stringify(c["protocol"])}`,
      });
    }
    if (c["required"] !== r.requiredMustBe) {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("required"),
        detail: `首版唯一组件必须 required=${r.requiredMustBe}`,
      });
    }
    if (c["headless"] !== r.headlessMustBe) {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("headless"),
        detail: `首版不支持无界面组件，headless 必须是 ${r.headlessMustBe}`,
      });
    }
    // C2 activation 两档门控（与 Host validator 同语义，plan §2.9）：
    // - activationAllowed 内：无需授予
    // - activationGated 内：机器审核 policy 批准的 App 可用，否则报需授予
    // - 都不在：HostRuntimeKindNotSupported
    // 两档清单都缺失时回退 legacy activationMustBe 单值检查。
    const allowed = r.activationAllowed ?? [];
    const gated = r.activationGated ?? [];
    const activation = str(c["activation"]);
    if (allowed.length === 0 && gated.length === 0) {
      if (activation !== r.activationMustBe) {
        out.push({
          code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
          pointer: at("activation"),
          detail: `首版只支持 ${JSON.stringify(r.activationMustBe)}，收到 ${JSON.stringify(activation)}`,
        });
      }
    } else if (allowed.includes(activation)) {
      // 全放开
    } else if (gated.includes(activation)) {
      const appId = str(m["appId"]);
      if (!hasReviewApproval(appId, `activation.${activation}@1`)) {
        out.push({
          code: "APP_CAPABILITY_NOT_GRANTED",
          pointer: at("activation"),
          detail: `${appId} 需授权 activation.${activation}@1`,
        });
      }
    } else {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("activation"),
        detail: `首版只支持 ${JSON.stringify(allowed)}（gated ${JSON.stringify(gated)}），收到 ${JSON.stringify(activation)}`,
      });
    }
    if (r.dependsOnMustBeEmpty && arr(c["dependsOn"]).length > 0) {
      out.push({
        code: "HOST_RUNTIME_KIND_NOT_SUPPORTED",
        pointer: at("dependsOn"),
        detail: "首版只有单组件，不存在组件间依赖",
      });
    }

    const entry = c["entry"];
    const serviceRef = c["serviceRef"];
    if (entry !== undefined && serviceRef !== undefined) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: at("entry"),
        detail: "entry 与 serviceRef 不能并存：前者是包内代码，后者是远端服务",
      });
    } else if (entry === undefined) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: at("entry"),
        detail: "web-surface 组件必须声明包内 entry",
      });
    } else {
      checkEntryPath(str(entry), at("entry"), out);
    }

    if (Array.isArray(c["platforms"])) {
      c["platforms"].forEach((p, j) => {
        if (!declaredTargets.has(str(p))) {
          out.push({
            code: "MANIFEST_REFERENCE_INVALID",
            pointer: `runtime.components[${i}].platforms[${j}]`,
            detail: `${JSON.stringify(p)} 不在顶层 targets 里；platforms 必须是 targets 的子集`,
          });
        }
      });
    }

    const lifecycle = c["lifecycle"];
    if (lifecycle === undefined) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: at("lifecycle"),
        detail: "web-surface 组件必须声明 lifecycle",
      });
    } else {
      for (const field of ["activate", "deactivate"] as const) {
        const hook = str(obj(lifecycle)[field]);
        if (!r.lifecycleHooks.includes(hook)) {
          out.push({
            code: "MANIFEST_SCHEMA_INVALID",
            pointer: at(`lifecycle.${field}`),
            detail: `未知 hook ${JSON.stringify(hook)}，支持的是 ${JSON.stringify(r.lifecycleHooks)}`,
          });
        }
      }
    }
  });
}

function checkEntryPath(entry: string, pointer: string, out: Finding[]): void {
  let why: string | undefined;
  if (entry.trim() === "") why = "不能为空";
  else if (entry.startsWith("/") || entry.includes(":"))
    why = "必须是包内相对路径，不能是绝对路径或带 scheme";
  else if (entry.split("/").includes("..")) why = "不能包含 .. 路径段";
  else if (entry === "__host" || entry.startsWith("__host/")) why = "__host/ 是 Host 保留命名空间";
  else if (entry.includes("\\")) why = "路径分隔符统一用 /，不要用反斜杠";

  if (why) {
    out.push({
      code: "PACKAGE_PATH_UNSAFE",
      pointer,
      detail: `${JSON.stringify(entry)} ${why}`,
    });
  }
}

// The frozen notification text limits count Unicode codepoints like the Rust Host.
// The unchanged general schema interpreter counts UTF-16. Remove only a proven
// false length finding for these exact three fields; all other findings survive.
function notificationLengthFalsePositive(
  violation: { pointer: string; message: string }, manifest: unknown, schema: unknown,
): boolean {
  const match = /^contributes\.notificationScenes\[(0|[1-9]\d*)\]\.(label|description|trigger)$/.exec(violation.pointer);
  if (!match || !isObject(manifest)) return false;
  const value = obj(arr(obj(manifest["contributes"])["notificationScenes"])[Number(match[1])])[match[2]!];
  if (typeof value !== "string") return false;
  const contributesSchema = obj(obj(obj(schema)["properties"])["contributes"]);
  const scenesSchema = obj(obj(contributesSchema["properties"])["notificationScenes"]);
  const fieldSchema = obj(obj(obj(scenesSchema["items"])["properties"])[match[2]!]);
  if (fieldSchema["type"] !== "string") return false;
  const length = Array.from(value).length;
  const min = fieldSchema["minLength"], max = fieldSchema["maxLength"];
  return (typeof min === "number" && violation.message === `长度至少 ${min}` && length >= min)
    || (typeof max === "number" && violation.message === `长度最多 ${max}` && length <= max);
}

function checkNotificationScenes(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  if (contributes["notificationScenes"] === undefined) return;
  const support = matrix.contributes.notificationScenes;
  if (!support?.supported) {
    out.push({ code: "HOST_CAPABILITY_NOT_AVAILABLE", pointer: "contributes.notificationScenes", detail: "当前 Host 不支持通知场景声明" });
    return;
  }
  const floor = hostApiRangeFloor(str(obj(m["hostApi"])["range"]));
  if (floor === null || compareVersions(floor, support.minHostApi) < 0) {
    out.push({ code: "HOST_API_INCOMPATIBLE", pointer: "hostApi.range", detail: `声明 notificationScenes（包括空列表）要求 Host API ${support.minHostApi} 以上` });
  }
  const keys = new Set<string>();
  for (const [i, raw] of arr(contributes["notificationScenes"]).entries()) {
    const scene = obj(raw), key = str(scene["key"]);
    const textInvalid = ["label", "description", "trigger"].some(field => {
      const text = str(scene[field]);
      // Scalar values only. A valid surrogate pair is one Array.from element;
      // an unpaired surrogate remains in D800-DFFF and serde_json rejects it.
      return text.trim().length === 0 || Array.from(text).some(char => {
        const point = char.codePointAt(0)!;
        return point <= 0x1f || (point >= 0x7f && point <= 0x9f)
          || point === 0x61c || (point >= 0x200b && point <= 0x200f)
          || (point >= 0x202a && point <= 0x202e) || (point >= 0x2060 && point <= 0x2069)
          || point === 0xfeff || (point >= 0xd800 && point <= 0xdfff);
      });
    });
    if (key === "legacy.post" || keys.has(key) || textInvalid
      || (scene["defaultLevel"] === "system" && scene["maxLevel"] === "in_app")) {
      out.push({ code: "MANIFEST_SCHEMA_INVALID", pointer: `contributes.notificationScenes[${i}]`, detail: "通知场景必须唯一、纯文本且默认深度不得超过最大深度" });
    }
    keys.add(key);
  }
}

function checkContributes(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  const s = matrix.contributes.surfaces;
  const surfaces = arr(contributes["surfaces"]);

  if (surfaces.length > s.maxCount) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.surfaces",
      detail: `首版最多 ${s.maxCount} 个 Surface，收到 ${surfaces.length}`,
    });
  }
  surfaces.forEach((raw, i) => {
    const surface = obj(raw);
    if (!s.allowedIds.includes(str(surface["id"]))) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: `contributes.surfaces[${i}].id`,
        detail: `首版只支持 ${JSON.stringify(s.allowedIds)}，收到 ${JSON.stringify(surface["id"])}`,
      });
    }
    if (!s.allowedLocations.includes(str(surface["location"]))) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: `contributes.surfaces[${i}].location`,
        detail: `首版只支持 ${JSON.stringify(s.allowedLocations)}，收到 ${JSON.stringify(surface["location"])}`,
      });
    }
  });

  const titlebar = matrix.contributes.titlebarActions;
  const titlebarActions = arr(contributes["titlebarActions"]);
  if (titlebarActions.length > titlebar.maxCount) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.titlebarActions",
      detail: `标题栏动作最多 ${titlebar.maxCount} 个，收到 ${titlebarActions.length}`,
    });
  }
  titlebarActions.forEach((raw, i) => {
    const action = obj(raw);
    const icon = str(action["icon"]);
    const text = str(action["text"]);
    const label = str(action["label"]);
    const id = str(action["id"]);
    const variant = action["variant"] === undefined ? "default" : str(action["variant"]);
    if (id.trim() === "") {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].id`,
        detail: "id 不能为空或只含空白",
      });
    }
    if (label.trim() === "") {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].label`,
        detail: "label 不能为空或只含空白",
      });
    }
    if (action["icon"] !== undefined && icon.trim() === "") {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].icon`,
        detail: "icon 声明后不能为空或只含空白",
      });
    }
    if (action["text"] !== undefined && text.trim() === "") {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].text`,
        detail: "text 声明后不能为空或只含空白",
      });
    }
    if (icon.trim() === "" && text.trim() === "") {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}]`,
        detail: "icon 与 text 至少声明一个",
      });
    }
    if (icon !== "" && !titlebar.allowedIcons.includes(icon)) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: `contributes.titlebarActions[${i}].icon`,
        detail: `未知标题栏图标 ${JSON.stringify(icon)}`,
      });
    }
    if (!titlebar.allowedVariants.includes(variant)) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: `contributes.titlebarActions[${i}].variant`,
        detail: `未知标题栏按钮样式 ${JSON.stringify(variant)}`,
      });
    }
    if (Array.from(label).length > titlebar.maxLabelLength) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].label`,
        detail: `label 最多 ${titlebar.maxLabelLength} 字符`,
      });
    }
    if (Array.from(text).length > titlebar.maxTextLength) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].text`,
        detail: `text 最多 ${titlebar.maxTextLength} 字符`,
      });
    }
    const intent = action["intent"];
    const intentBytes = jsonBudgetBytes(intent);
    if (intentBytes > titlebar.maxIntentBytes) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].intent`,
        detail: `intent UTF-8 JSON 最多 ${titlebar.maxIntentBytes} bytes，收到 ${intentBytes}`,
      });
    }
    const intentDepth = jsonDepth(intent);
    if (intentDepth > titlebar.maxIntentDepth) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.titlebarActions[${i}].intent`,
        detail: `intent JSON 最多嵌套 ${titlebar.maxIntentDepth} 层，收到 ${intentDepth}`,
      });
    }
  });

  const titlebarStatus = obj(contributes["titlebarStatus"]);
  const hasTitlebarStatus = contributes["titlebarStatus"] !== undefined;
  if (hasTitlebarStatus) {
    const support = matrix.contributes.titlebarStatus;
    const label = str(titlebarStatus["label"]);
    const tone = str(titlebarStatus["tone"]);
    if (!support.supported) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: "contributes.titlebarStatus",
        detail: "本版本 Host 不支持标题栏状态",
      });
    }
    if (label.trim() === "" || Array.from(label).length > support.maxLabelLength) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: "contributes.titlebarStatus.label",
        detail: `状态文案必须为 1-${support.maxLabelLength} 个字符`,
      });
    }
    if (!support.allowedTones.includes(tone)) {
      out.push({
        code: "HOST_CAPABILITY_NOT_AVAILABLE",
        pointer: "contributes.titlebarStatus.tone",
        detail: `未知标题栏状态 tone ${JSON.stringify(tone)}`,
      });
    }
  }

  if (
    (titlebarActions.length > 0 || hasTitlebarStatus) &&
    !arr(obj(m["requires"])["hostCapabilities"]).includes("titlebar.action@1")
  ) {
    out.push({
      code: "MANIFEST_REFERENCE_INVALID",
      pointer: hasTitlebarStatus && titlebarActions.length === 0
        ? "contributes.titlebarStatus"
        : "contributes.titlebarActions",
      detail: "声明标题栏状态或动作必须同时声明 titlebar.action@1",
    });
  }

  const scheduledSupport = matrix.contributes.scheduledTasks;
  const scheduledTasks = arr(contributes["scheduledTasks"]);
  if (!scheduledSupport.supported && scheduledTasks.length > 0) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.scheduledTasks",
      detail: "本版本 Host 不支持定时任务",
    });
  }
  if (scheduledTasks.length > scheduledSupport.maxCountPerApp) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.scheduledTasks",
      detail: `每个 App 最多 ${scheduledSupport.maxCountPerApp} 个定时任务，收到 ${scheduledTasks.length}`,
    });
  }
  scheduledTasks.forEach((raw, i) => {
    const task = obj(raw);
    for (const field of ["id", "title", "commandId"] as const) {
      if (str(task[field]).trim() === "") {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.scheduledTasks[${i}].${field}`,
          detail: "不能为空或只含空白",
        });
      }
    }
    const interval = typeof task["intervalMs"] === "number" ? task["intervalMs"] : 0;
    if (
      interval < scheduledSupport.minIntervalMs
      || interval > scheduledSupport.maxIntervalMs
    ) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.scheduledTasks[${i}].intervalMs`,
        detail: `必须在 ${scheduledSupport.minIntervalMs}..=${scheduledSupport.maxIntervalMs} 之间，收到 ${interval}`,
      });
    }
  });

  arr(contributes["commands"]).forEach((raw, i) => {
    const c = obj(raw);
    const timeout = typeof c["timeoutMs"] === "number" ? c["timeoutMs"] : 0;
    if (timeout === 0 || timeout > matrix.limits.commandTimeoutMaxMs) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.commands[${i}].timeoutMs`,
        detail: `必须在 1..=${matrix.limits.commandTimeoutMaxMs} 之间，收到 ${timeout}`,
      });
    }
    if (arr(c["callers"]).length === 0) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.commands[${i}].callers`,
        detail: "不能为空：没有调用方的 Command 永远不会被触发",
      });
    }
  });
}

/** C1-2：订阅的事件类型必须在矩阵清单里（未知 = schema 非法，与 Rust 同码）。 */
function checkEventSubscriptions(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const known = new Set(matrix.contributes.eventSubscriptions.events);
  arr(obj(m["contributes"])["eventSubscriptions"]).forEach((raw, i) => {
    arr(obj(raw)["events"]).forEach((e, j) => {
      const name = str(e);
      if (!known.has(name)) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.eventSubscriptions[${i}].events[${j}]`,
          detail: `未知事件类型 ${JSON.stringify(name)}，本版本 Host 只认识 ${JSON.stringify([...known])}`,
        });
      }
    });
  });
}

/** C1-5：接受的上下文类型必须在矩阵清单里（未知 = schema 非法，与 Rust 同码）。 */
function checkAcceptsActionContext(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const known = new Set(matrix.contributes.acceptsActionContext.contextTypes);
  arr(obj(m["contributes"])["acceptsActionContext"]).forEach((raw, i) => {
    arr(obj(raw)["contextTypes"]).forEach((e, j) => {
      const name = str(e);
      if (!known.has(name)) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.acceptsActionContext[${i}].contextTypes[${j}]`,
          detail: `未知上下文类型 ${JSON.stringify(name)}，本版本 Host 只认识 ${JSON.stringify([...known])}`,
        });
      }
    });
  });
}

/**
 * C-AC：Agent 功能声明（与 Rust validator 同码）。模板槽位必须逐个登记；
 * 声明功能必须同时声明 agent.session@2。
 */
function checkAgentFeatures(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const support = matrix.contributes.agentFeatures;
  const features = arr(obj(m["contributes"])["agentFeatures"]);
  if (!support.supported && features.length > 0) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.agentFeatures",
      detail: "本版本 Host 不支持 Agent 功能声明",
    });
  }
  if (
    features.length > 0
    && !arr(obj(m["requires"])["hostCapabilities"]).some((c) => str(c) === "agent.session@2")
  ) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.agentFeatures",
      detail: "声明 Agent 功能必须同时声明 agent.session@2",
    });
  }
  // 声明 agentFeatures 的包装进不认识该字段的旧 Host 会被整包拒装（deny_unknown_fields），
  // range 下界必须达到矩阵登记的最低 Host API（与 Rust host_api_range_floor 同语义）。
  if (features.length > 0) {
    const range = str(obj(m["hostApi"])["range"]).trim();
    const floor = hostApiRangeFloor(range);
    if (floor === null || compareVersions(floor, support.minHostApi) < 0) {
      out.push({
        code: "HOST_API_INCOMPATIBLE",
        pointer: "hostApi.range",
        detail: `声明 agentFeatures 的插件必须兼容 Host API ${support.minHostApi} 以上（range 下界 ${JSON.stringify(range)} 不够），否则旧 Host 会因未知字段整包拒装`,
      });
    }
  }
  if (features.length > support.maxCountPerApp) {
    out.push({
      code: "HOST_CAPABILITY_NOT_AVAILABLE",
      pointer: "contributes.agentFeatures",
      detail: `每个 App 最多 ${support.maxCountPerApp} 个 Agent 功能，收到 ${features.length}`,
    });
  }
  features.forEach((raw, i) => {
    const feature = obj(raw);
    const pointer = (field: string) => `contributes.agentFeatures[${i}].${field}`;
    const id = str(feature["id"]);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || id.length > support.maxIdLength) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("id"),
        detail: `功能 id 必须匹配 ^[a-z][a-z0-9-]*$ 且不超过 ${support.maxIdLength} 字节（与 featureRef 的引用域一致），收到 ${JSON.stringify(id)}`,
      });
    }
    const name = str(feature["name"]);
    if (name.trim() === "" || [...name].length > support.maxNameLength) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("name"),
        detail: `必须是 1..=${support.maxNameLength} 个字符的展示名，收到 ${JSON.stringify(name)}`,
      });
    }
    const description = feature["description"] === undefined ? "" : str(feature["description"]);
    if (
      feature["description"] !== undefined
      && (description.trim() === "" || [...description].length > support.maxDescriptionLength)
    ) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("description"),
        detail: `必须是 1..=${support.maxDescriptionLength} 个字符的说明，不能只含空白`,
      });
    }
    if (
      feature["runtime"] !== undefined
      && !support.allowedRuntimes.includes(str(feature["runtime"]))
    ) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("runtime"),
        detail: `未知运行时 ${JSON.stringify(str(feature["runtime"]))}，本版本 Host 只认识 ${JSON.stringify(support.allowedRuntimes)}`,
      });
    }
    const params = arr(feature["promptParams"]);
    if (params.length > support.maxPromptParamsPerFeature) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("promptParams"),
        detail: `每个功能最多 ${support.maxPromptParamsPerFeature} 个参数槽，收到 ${params.length}`,
      });
    }
    const declared = new Set<string>();
    params.forEach((paramRaw, j) => {
      const param = obj(paramRaw);
      const paramName = str(param["name"]);
      if (paramName.trim() === "" || Buffer.byteLength(paramName, "utf8") > support.maxParamNameLength) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.agentFeatures[${i}].promptParams[${j}].name`,
          detail: `参数名必须非空且不超过 ${support.maxParamNameLength} 字节`,
        });
      }
      // 模板槽位只认英文标识符；登记一个永远匹配不上的名字等于死配置。
      if (paramName !== "" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(paramName)) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.agentFeatures[${i}].promptParams[${j}].name`,
          detail: `参数名 ${JSON.stringify(paramName)} 必须匹配 ^[A-Za-z][A-Za-z0-9_]*$，否则模板槽位永远无法引用它`,
        });
      }
      const paramDescription = param["description"] === undefined ? "" : str(param["description"]);
      if (
        param["description"] !== undefined
        && (paramDescription.trim() === "" || [...paramDescription].length > support.maxParamDescriptionLength)
      ) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.agentFeatures[${i}].promptParams[${j}].description`,
          detail: `必须是 1..=${support.maxParamDescriptionLength} 个字符的说明，不能只含空白`,
        });
      }
      if (declared.has(paramName)) {
        out.push({
          code: "MANIFEST_DUPLICATE_ID",
          pointer: `contributes.agentFeatures[${i}].promptParams[${j}].name`,
          detail: `参数名 ${JSON.stringify(paramName)} 在同一功能内重复`,
        });
      }
      declared.add(paramName);
    });
    const template = feature["promptTemplate"] === undefined ? "" : str(feature["promptTemplate"]);
    if (feature["promptTemplate"] !== undefined) {
      if (template === "" || Buffer.byteLength(template, "utf8") > support.maxPromptTemplateLength) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: pointer("promptTemplate"),
          detail: `默认提示词模板必须为 1..=${support.maxPromptTemplateLength} 字节（UTF-8）且不能为空`,
        });
      } else {
        for (const slot of scanPromptSlots(template)) {
          if (slot.kind === "ok") {
            if (!declared.has(slot.name)) {
              out.push({
                code: "MANIFEST_SCHEMA_INVALID",
                pointer: pointer("promptTemplate"),
                detail: `模板槽位 {${slot.name}} 没有在 promptParams 里登记；未登记的槽位无法被运行时注入，也不能悄悄丢给用户`,
              });
            }
          } else {
            out.push({
              code: "MANIFEST_SCHEMA_INVALID",
              pointer: pointer("promptTemplate"),
              detail: `模板里有不完整的槽位语法 ${JSON.stringify(slot.raw)}；槽位写作 {paramName}，当前版本不支持字面大括号`,
            });
          }
        }
      }
    }
    const toolBase = arr(feature["toolBase"]);
    if (toolBase.length > support.maxToolBasePerFeature) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: pointer("toolBase"),
        detail: `工具基集最多 ${support.maxToolBasePerFeature} 项，收到 ${toolBase.length}`,
      });
    }
    const toolRefs = new Set<string>();
    toolBase.forEach((toolRaw, j) => {
      const toolRef = str(toolRaw);
      if (toolRef.trim() === "") {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.agentFeatures[${i}].toolBase[${j}]`,
          detail: "工具 ref 不能为空或只含空白",
        });
      }
      if (toolRefs.has(toolRef)) {
        out.push({
          code: "MANIFEST_DUPLICATE_ID",
          pointer: `contributes.agentFeatures[${i}].toolBase[${j}]`,
          detail: `工具 ref ${JSON.stringify(toolRef)} 重复`,
        });
      }
      toolRefs.add(toolRef);
    });
  });
}


/** 精确、caret、tilde、`>=` / `>` 的最高下界，与 Rust host_api_range_floor 同语义。 */
function hostApiRangeFloor(range: string): string | null {
  let floor: string | null = null;
  for (const token of range.trim().split(/\s+/)) {
    // 与 satisfiesHostApiRange 一样，只接受完整三段稳定数字，不剥离 prerelease。
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(token);
    if (!match) return null;
    const parts = match.slice(2);
    if (parts.some((part) => part !== String(Number(part)))) return null;
    if (match[1] === "<" || match[1] === "<=") continue;
    const version = parts.join(".");
    if (floor === null || compareVersions(version, floor) > 0) floor = version;
  }
  return floor;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/** 与 Rust `scan_prompt_slots` 同一语义：`{name}` 槽位，语法不完整返回 raw。 */
function scanPromptSlots(template: string): Array<{ kind: "ok"; name: string } | { kind: "bad"; raw: string }> {
  const slots: Array<{ kind: "ok"; name: string } | { kind: "bad"; raw: string }> = [];
  let rest = template;
  while (true) {
    const open = rest.indexOf("{");
    if (open === -1) break;
    const after = rest.slice(open + 1);
    const close = after.indexOf("}");
    if (close === -1) {
      slots.push({ kind: "bad", raw: rest.slice(open) });
      break;
    }
    const name = after.slice(0, close);
    const valid = name !== "" && /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
    slots.push(valid ? { kind: "ok", name } : { kind: "bad", raw: rest.slice(open, open + close + 2) });
    rest = after.slice(close + 1);
  }
  return slots;
}

function checkReferences(m: Json, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  const componentIds = new Set(
    arr(obj(m["runtime"])["components"]).map((c) => str(obj(c)["id"])),
  );
  const surfaceIds = new Set(arr(contributes["surfaces"]).map((s) => str(obj(s)["id"])));

  const checkComponent = (pointer: string, id: string) => {
    if (!componentIds.has(id)) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer,
        detail: `componentId ${JSON.stringify(id)} 没有对应的 runtime.components 声明`,
      });
    }
  };

  for (const [kind, list] of [
    ["surfaces", arr(contributes["surfaces"])],
    ["commands", arr(contributes["commands"])],
    ["intents", arr(contributes["intents"])],
    ["services", arr(contributes["services"])],
  ] as const) {
    list.forEach((raw, i) => {
      checkComponent(`contributes.${kind}[${i}].componentId`, str(obj(raw)["componentId"]));
    });
  }

  const checkOpens = (pointer: string, opens: string) => {
    const [prefix, id] = splitOnce(opens, ":");
    if (prefix === "surface" && id !== undefined && surfaceIds.has(id)) return;
    if (prefix === "surface" && id !== undefined) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer,
        detail: `opens 指向的 surface ${JSON.stringify(id)} 未声明`,
      });
      return;
    }
    out.push({
      code: "MANIFEST_REFERENCE_INVALID",
      pointer,
      detail: `opens 只支持 "surface:<id>" 形式，收到 ${JSON.stringify(opens)}`,
    });
  };

  // C1-3：tabItems 是单对象不是数组——声明了就要校验 componentId 引用。
  if (contributes["tabItems"] !== undefined) {
    checkComponent("contributes.tabItems.componentId", str(obj(contributes["tabItems"])["componentId"]));
  }
  // C-3b：actionItems 同形（声明「能把运行时条目挂进 Action 层」）。
  if (contributes["actionItems"] !== undefined) {
    checkComponent("contributes.actionItems.componentId", str(obj(contributes["actionItems"])["componentId"]));
  }
  arr(contributes["eventSubscriptions"]).forEach((raw, i) => {
    checkComponent(`contributes.eventSubscriptions[${i}].componentId`, str(obj(raw)["componentId"]));
  });
  arr(contributes["acceptsActionContext"]).forEach((raw, i) => {
    checkComponent(`contributes.acceptsActionContext[${i}].componentId`, str(obj(raw)["componentId"]));
  });

  const commands = arr(contributes["commands"]).map(obj);
  arr(contributes["scheduledTasks"]).forEach((raw, i) => {
    const task = obj(raw);
    const commandId = str(task["commandId"]);
    const command = commands.find((item) => str(item["id"]) === commandId);
    if (!command) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: `contributes.scheduledTasks[${i}].commandId`,
        detail: `commandId ${JSON.stringify(commandId)} 没有对应的 Command 声明`,
      });
    } else if (!arr(command["callers"]).includes("host")) {
      out.push({
        code: "MANIFEST_REFERENCE_INVALID",
        pointer: `contributes.scheduledTasks[${i}].commandId`,
        detail: `Command ${JSON.stringify(commandId)} 必须允许 host 调用`,
      });
    }
  });

  arr(contributes["sidebarItems"]).forEach((raw, i) => {
    checkOpens(`contributes.sidebarItems[${i}].opens`, str(obj(raw)["opens"]));
  });
  arr(contributes["intents"]).forEach((raw, i) => {
    const opens = obj(raw)["opens"];
    if (opens !== undefined) checkOpens(`contributes.intents[${i}].opens`, str(opens));
  });
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const index = value.indexOf(sep);
  if (index < 0) return [value, undefined];
  return [value.slice(0, index), value.slice(index + sep.length)];
}

function checkUniqueIds(m: Json, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  for (const kind of ["surfaces", "sidebarItems", "commands", "intents", "services", "titlebarActions", "scheduledTasks", "agentFeatures"] as const) {
    const seen = new Set<string>();
    for (const raw of arr(contributes[kind])) {
      const id = str(obj(raw)["id"]);
      if (seen.has(id)) {
        out.push({
          code: "MANIFEST_DUPLICATE_ID",
          pointer: `contributes.${kind}`,
          detail: `id ${JSON.stringify(id)} 重复`,
        });
      }
      seen.add(id);
    }
  }
  arr(contributes["services"]).forEach((raw, i) => {
    const seenMethods = new Set<string>();
    for (const methodRaw of arr(obj(raw)["methods"])) {
      const id = str(obj(methodRaw)["id"]);
      if (seenMethods.has(id)) {
        out.push({
          code: "MANIFEST_DUPLICATE_ID",
          pointer: `contributes.services[${i}].methods`,
          detail: `method id ${JSON.stringify(id)} 重复`,
        });
      }
      seenMethods.add(id);
    }
  });

  const seenComponents = new Set<string>();
  for (const raw of arr(obj(m["runtime"])["components"])) {
    const id = str(obj(raw)["id"]);
    if (seenComponents.has(id)) {
      out.push({
        code: "MANIFEST_DUPLICATE_ID",
        pointer: "runtime.components",
        detail: `组件 id ${JSON.stringify(id)} 重复`,
      });
    }
    seenComponents.add(id);
  }

  const seenEndpoints = new Set<string>();
  for (const [index, raw] of arr(obj(m["network"])["endpoints"]).entries()) {
    const id = str(obj(raw)["id"]);
    if (seenEndpoints.has(id)) {
      out.push({
        code: "MANIFEST_DUPLICATE_ID",
        pointer: `network.endpoints[${index}].id`,
        detail: `network endpoint id ${JSON.stringify(id)} 重复`,
      });
    }
    seenEndpoints.add(id);
  }
}

function checkAppIntents(m: Json, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  const own = new Set<string>([
    ...arr(contributes["commands"]).map((c) => `command:${str(obj(c)["id"])}`),
    ...arr(contributes["surfaces"]).map((s) => `surface:${str(obj(s)["id"])}`),
    ...arr(contributes["intents"]).map((i) => `intent:${str(obj(i)["id"])}`),
    ...arr(contributes["sidebarItems"]).map((s) => `sidebarItem:${str(obj(s)["id"])}`),
  ]);

  arr(obj(m["requires"])["appIntents"]).forEach((raw, i) => {
    const req = obj(raw);
    const requiredFor = arr(req["requiredFor"]).map(str);
    if (req["required"] === true && requiredFor.length === 0) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `requires.appIntents[${i}].requiredFor`,
        detail: "required=true 时必须写明缺目标会禁用哪些 contribution，否则 Host 无从判断",
      });
    }
    requiredFor.forEach((r, j) => {
      if (!own.has(r)) {
        out.push({
          code: "MANIFEST_REFERENCE_INVALID",
          pointer: `requires.appIntents[${i}].requiredFor[${j}]`,
          detail: `${JSON.stringify(r)} 不是本 App 声明过的 contribution（形如 command:<id>）`,
        });
      }
    });
  });
}

function checkServices(m: Json, matrix: SupportMatrix, out: Finding[]): void {
  const contributes = obj(m["contributes"]);
  const own = new Set<string>([
    ...arr(contributes["commands"]).map((c) => `command:${str(obj(c)["id"])}`),
    ...arr(contributes["surfaces"]).map((s) => `surface:${str(obj(s)["id"])}`),
    ...arr(contributes["services"]).map((s) => `service:${str(obj(s)["id"])}`),
  ]);
  arr(contributes["services"]).forEach((raw, i) => {
    const service = obj(raw);
    if (arr(service["methods"]).length === 0) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `contributes.services[${i}].methods`,
        detail: "service 至少声明一个 method",
      });
    }
    arr(service["methods"]).forEach((methodRaw, j) => {
      const method = obj(methodRaw);
      const timeout = typeof method["timeoutMs"] === "number" ? method["timeoutMs"] : 0;
      if (timeout === 0 || timeout > matrix.limits.serviceTimeoutMaxMs) {
        out.push({
          code: "MANIFEST_SCHEMA_INVALID",
          pointer: `contributes.services[${i}].methods[${j}].timeoutMs`,
          detail: `必须在 1..=${matrix.limits.serviceTimeoutMaxMs} 之间，收到 ${timeout}`,
        });
      }
    });
  });
  arr(obj(m["requires"])["services"]).forEach((raw, i) => {
    const requirement = obj(raw);
    const requiredFor = arr(requirement["requiredFor"]).map(str);
    if (requirement["required"] === true && requiredFor.length === 0) {
      out.push({
        code: "MANIFEST_SCHEMA_INVALID",
        pointer: `requires.services[${i}].requiredFor`,
        detail: "required=true 时必须写明缺 Provider 会禁用哪些 contribution",
      });
    }
    requiredFor.forEach((target, j) => {
      if (!own.has(target)) {
        out.push({
          code: "MANIFEST_REFERENCE_INVALID",
          pointer: `requires.services[${i}].requiredFor[${j}]`,
          detail: `${JSON.stringify(target)} 不是本 App 声明过的 contribution`,
        });
      }
    });
  });
}
