/**
 * 编译期契约文件的读取：Manifest JSON Schema 与 Host 支持矩阵。
 *
 * 合同由独立的 `@reai/app-contract` 包携带；Host（Rust）与 CLI（TS）在仓库内
 * 对照同一份 `platform/contract` 源文件，CLI pack 后也不会回读 Driver 源码。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** CLI 用到的支持矩阵字段。 */
export interface SupportMatrix {
  matrixVersion: number;
  hostApi: string;
  profile: string;
  hostCapabilities: {
    granted: string[];
    /** 已实现但需按 appId 授予（Host 侧 capabilityGrants 数据层）；当前含官方窄能力。 */
    grantGated: string[];
    withheld: Record<string, string>;
  };
  pluginPermissions: {
    supported: Record<string, { subjectClass: string; bridgeMethods: string[] }>;
    withheld: Record<string, string>;
    /** 插件 Bridge 权限门禁的稳定错误码；与安装层 stableErrors 分域。 */
    stableErrors: string[];
  };
  runtime: {
    componentCount: { exactly: number };
    kinds: string[];
    protocols: string[];
    requiredMustBe: boolean;
    headlessMustBe: boolean;
    activationMustBe: string;
    /** C2：无需授予就放行的 activation 值（如 on-demand）。 */
    activationAllowed?: string[];
    /** C2：需授予 activation.<value>@1 才放行（如 startup）。 */
    activationGated?: string[];
    dependsOnMustBeEmpty: boolean;
    lifecycleHooks: string[];
  };
  contributes: {
    /** Declaration parser only; does not grant notifications.publish. */
    notificationScenes?: { supported: boolean; minHostApi: string };
    surfaces: { maxCount: number; allowedIds: string[]; allowedLocations: string[] };
    titlebarActions: {
      maxCount: number;
      allowedIcons: string[];
      allowedVariants: string[];
      maxLabelLength: number;
      maxTextLength: number;
      maxIntentBytes: number;
      maxIntentDepth: number;
    };
    titlebarStatus: {
      supported: boolean;
      allowedTones: string[];
      maxLabelLength: number;
    };
    /** C1-2：事件订阅合同——事件类型清单与 Host 同源。 */
    eventSubscriptions: { supported: boolean; events: string[] };
    /** C1-5：Action 上下文接受声明的合同；当前仅识别 recording，占位不等于生产能力已开放。 */
    acceptsActionContext: { supported: boolean; contextTypes: string[] };
    scheduledTasks: {
      supported: boolean;
      maxCountPerApp: number;
      minIntervalMs: number;
      maxIntervalMs: number;
    };
    /** C-AC：Agent 功能声明合同——限制与 runtime 白名单与 Host validator 同源。 */
    agentFeatures: {
      supported: boolean;
      maxCountPerApp: number;
      maxIdLength: number;
      maxNameLength: number;
      maxDescriptionLength: number;
      allowedRuntimes: string[];
      maxPromptTemplateLength: number;
      maxPromptParamsPerFeature: number;
      maxParamNameLength: number;
      maxParamDescriptionLength: number;
      maxToolBasePerFeature: number;
      minHostApi: string;
    };
  };
  fixedValues: Record<string, unknown>;
  limits: MatrixLimits;
  stableErrors: string[];
}

/**
 * 数值限额。逐个列出而不是 `Record<string, number>`：后者在开启
 * `noUncheckedIndexedAccess` 后每次取值都可能是 `undefined`，于是校验逻辑里会长出
 * 一堆 `?? 0` —— 而限额取到 0 恰好是最危险的默认值（什么都拦不住）。
 */
export interface MatrixLimits {
  bridgeMessageBytes: number;
  inflightRequestsPerRuntime: number;
  kvValueBytes: number;
  kvTotalBytesPerApp: number;
  activateTimeoutMs: number;
  surfaceReadyTimeoutMs: number;
  commandTimeoutMaxMs: number;
  serviceTimeoutMaxMs: number;
  serviceGlobalInflightMax: number;
  serviceCallerInflightMax: number;
  crashLoopWindowMs: number;
  crashLoopMaxRestarts: number;
  hiddenSurfaceReclaimMs: number;
  packageZipBytes: number;
  packageEntryCount: number;
  packageUncompressedBytes: number;
  packageSingleFileBytes: number;
  packageMaxCompressionRatio: number;
  packagePathDepth: number;
  /** C1-3 Tab 层实体限额：每插件 / 总量 / 每插件举旗上限。 */
  tabItemsPerApp: number;
  tabItemsTotal: number;
  tabItemsFlaggedPerApp: number;
  /** C-3b Action 层挂载限额：每插件 / 总量。 */
  actionItemsPerApp: number;
  actionItemsTotal: number;
  evidenceTtlMs: number;
  evidenceTotalBytes: number;
  networkInflightPerApp: number;
  networkRequestsPerMinute: number;
  networkRequestBytes: number;
  networkResponseBytes: number;
  networkTimeoutMaxMs: number;
  networkUploadBodyBytes: number;
  networkUploadChunkBytes: number;
  networkUploadInflightPerApp: number;
  networkUploadGlobalInflight: number;
  networkUploadIdleTimeoutMs: number;
  networkUploadAbsoluteTimeoutMs: number;
  networkUploadTimeoutMaxMs: number;
  networkRedirectMax: number;
}

const contractAsset = (subpath: string): string =>
  fileURLToPath(import.meta.resolve(`@reai/app-contract/${subpath}`));

/** Manifest v1.1 的 JSON Schema 路径。 */
export const SCHEMA_PATH = contractAsset("schemas/app-manifest-1.1.schema.json");
export const SKIN_SCHEMA_PATH = contractAsset("schemas/skin-v1.schema.json");
/** Host 支持矩阵路径。 */
export const MATRIX_PATH = contractAsset("host-support-matrix.json");

let schemaCache: unknown;
let skinSchemaCache: unknown;
let matrixCache: SupportMatrix | undefined;

export function loadSchema(): unknown {
  schemaCache ??= JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return schemaCache;
}

export function loadSkinSchema(): unknown {
  skinSchemaCache ??= JSON.parse(readFileSync(SKIN_SCHEMA_PATH, "utf8"));
  return skinSchemaCache;
}

export function loadSupportMatrix(): SupportMatrix {
  matrixCache ??= JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as SupportMatrix;
  return matrixCache;
}
