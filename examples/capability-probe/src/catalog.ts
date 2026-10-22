/**
 * 能力目录：把 Host 支持矩阵、平台审核清单和本插件的 Manifest 合成一张表。
 *
 * 三份数据都在构建时打进包里，所以这里描述的是「打包这一刻的合同」，不是对当前
 * 运行中 Driver 的实时查询。实际能不能用，以探针按钮的真实调用结果为准。
 */
import matrixJson from "@reai/app-contract/host-support-matrix.json";
import policyJson from "@reai/app-contract/capability-review-policy.seed.json";
import manifestJson from "../app.manifest.json";
import { textFor, type CapabilityGroup } from "./capability-text";
import { OFFICIAL_PLUGINS_SNAPSHOT } from "./generated/official-plugins";

/** 本地开发包视角的四档。 */
export type Tier = "granted" | "permission" | "gated" | "withheld";

export const TIER_LABELS: Record<Tier, string> = {
  granted: "免审",
  permission: "需要用户同意",
  gated: "需要平台批准",
  withheld: "暂未开放",
};

export interface CapabilityEntry {
  id: string;
  tier: Tier;
  group: CapabilityGroup;
  title: string;
  summary: string;
  /** 这项能力对应的 Bridge 方法；矩阵没有列出时为空。 */
  methods: string[];
  /** 除平台档位外，是否还需要用户在「已安装 → 权限」里点同意。 */
  needsUserConsent: boolean;
  /** 平台审核清单里批准过这项能力的插件。 */
  approvedApps: string[];
  /** 本插件 Manifest 是否声明了它。 */
  declaredHere: boolean;
  /** 暂未开放的原因（矩阵原文）。 */
  withheldReason?: string;
}

interface MatrixShape {
  hostApi: string;
  hostCapabilities: {
    granted: string[];
    grantGated: string[];
    withheld: Record<string, string>;
    methods?: Record<string, string[]>;
  };
  pluginPermissions: { supported: Record<string, { bridgeMethods?: string[] }> };
}

interface PolicyShape {
  approvals: { appId: string; version: string; approvedHostCapabilities: string[] }[];
}

interface ManifestShape {
  appId: string;
  version: string;
  name: string;
  hostApi: { range: string };
  requires: { hostCapabilities: string[] };
  permissions: { id: string }[];
}

const matrix = matrixJson as unknown as MatrixShape;
const policy = policyJson as unknown as PolicyShape;
export const manifest = manifestJson as unknown as ManifestShape;

export const PLUGIN_VERSION = manifest.version;
export const PLUGIN_APP_ID = manifest.appId;
export const CONTRACT_HOST_API = matrix.hostApi;

export function tierOf(id: string): Tier | undefined {
  const caps = matrix.hostCapabilities;
  if (caps.grantGated.includes(id)) return "gated";
  if (id in caps.withheld) return "withheld";
  if (caps.granted.includes(id)) return "granted";
  if (id in matrix.pluginPermissions.supported) return "permission";
  return undefined;
}

function approvalsByCapability(): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const approval of policy.approvals) {
    for (const capability of approval.approvedHostCapabilities) {
      const apps = result.get(capability) ?? new Set<string>();
      apps.add(approval.appId);
      result.set(capability, apps);
    }
  }
  return new Map([...result].map(([key, apps]) => [key, [...apps].sort()]));
}

/** 全部能力，按「免审 → 需同意 → 需批准 → 暂未开放」再按 id 排序。 */
export function buildCatalog(): CapabilityEntry[] {
  const caps = matrix.hostCapabilities;
  const permissions = matrix.pluginPermissions.supported;
  const approvals = approvalsByCapability();
  const declared = new Set([
    ...manifest.requires.hostCapabilities,
    ...manifest.permissions.map((permission) => permission.id),
  ]);
  const ids = new Set([
    ...caps.granted,
    ...caps.grantGated,
    ...Object.keys(caps.withheld),
    ...Object.keys(permissions),
  ]);
  const order: Tier[] = ["granted", "permission", "gated", "withheld"];
  const entries: CapabilityEntry[] = [];
  for (const id of ids) {
    const tier = tierOf(id);
    if (!tier) continue;
    const text = textFor(id);
    entries.push({
      id,
      tier,
      group: text.group,
      title: text.title,
      summary: text.summary,
      methods: permissions[id]?.bridgeMethods ?? caps.methods?.[id] ?? [],
      needsUserConsent: id in permissions,
      approvedApps: approvals.get(id) ?? [],
      declaredHere: declared.has(id),
      ...(tier === "withheld" ? { withheldReason: caps.withheld[id] } : {}),
    });
  }
  return entries.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.id.localeCompare(b.id));
}

export function tierCounts(entries: CapabilityEntry[]): Record<Tier, number> {
  const counts: Record<Tier, number> = { granted: 0, permission: 0, gated: 0, withheld: 0 };
  for (const entry of entries) counts[entry.tier] += 1;
  return counts;
}

/** 本地开发包能否声明并使用这项能力。 */
export function usableByLocalPackage(tier: Tier): boolean {
  return tier === "granted" || tier === "permission";
}

export interface OfficialPluginRow {
  slug: string;
  appId: string;
  name: string;
  version: string;
  capabilities: { id: string; tier: Tier | undefined; approved: boolean }[];
}

/** 官方插件对照：插件仓快照里每个插件声明了什么、审核清单批准了什么。 */
export function officialPluginRows(): OfficialPluginRow[] {
  const approvedByApp = new Map<string, Set<string>>();
  for (const approval of policy.approvals) {
    const set = approvedByApp.get(approval.appId) ?? new Set<string>();
    for (const capability of approval.approvedHostCapabilities) set.add(capability);
    approvedByApp.set(approval.appId, set);
  }
  return OFFICIAL_PLUGINS_SNAPSHOT.plugins.map((plugin) => ({
    slug: plugin.slug,
    appId: plugin.appId,
    name: plugin.name,
    version: plugin.version,
    capabilities: [...new Set([...plugin.capabilities, ...plugin.permissions])].sort().map((id) => {
      const tier = tierOf(id);
      return { id, tier, approved: tier === "gated" ? approvedByApp.get(plugin.appId)?.has(id) === true : true };
    }),
  }));
}
