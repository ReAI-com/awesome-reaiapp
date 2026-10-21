import { describe, expect, test } from "bun:test";
import matrix from "@reai/app-contract/host-support-matrix.json";
import { buildCatalog, manifest, officialPluginRows, tierCounts, tierOf, usableByLocalPackage } from "../src/catalog";
import { CAPABILITY_TEXT } from "../src/capability-text";
import { CHANGELOG_TEXT } from "../src/release-notes";
import { readFileSync } from "node:fs";

describe("能力目录", () => {
  const catalog = buildCatalog();

  test("覆盖支持矩阵里的每一项能力和用户权限", () => {
    const ids = new Set([
      ...matrix.hostCapabilities.granted,
      ...matrix.hostCapabilities.grantGated,
      ...Object.keys(matrix.hostCapabilities.withheld),
      ...Object.keys(matrix.pluginPermissions.supported),
    ]);
    expect(new Set(catalog.map((entry) => entry.id))).toEqual(ids);
  });

  test("每一项都有人话说明（矩阵新增能力时提醒补文案）", () => {
    const missing = catalog.filter((entry) => !(entry.id in CAPABILITY_TEXT)).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  test("四档数量与矩阵一致", () => {
    const counts = tierCounts(catalog);
    expect(counts.granted).toBe(matrix.hostCapabilities.granted.length);
    expect(counts.gated).toBe(matrix.hostCapabilities.grantGated.length);
    expect(counts.withheld).toBe(Object.keys(matrix.hostCapabilities.withheld).length);
    expect(counts.permission).toBeGreaterThanOrEqual(3);
    for (const id of ["account.status@1", "os.notification.post@1", "http.fetch@1"]) expect(tierOf(id)).toBe("permission");
  });

  test("本插件只声明本地开发包能用的能力，否则装不上", () => {
    const declared = [...manifest.requires.hostCapabilities, ...manifest.permissions.map((permission) => permission.id)];
    for (const id of declared) {
      const tier = tierOf(id);
      expect(tier === undefined ? id : usableByLocalPackage(tier) ? "ok" : `${id}:${tier}`).toBe("ok");
    }
    expect(catalog.filter((entry) => entry.declaredHere).map((entry) => entry.id).sort()).toEqual([...declared].sort());
  });

  test("需要批准的能力列出审核清单里获批的插件", () => {
    const resources = catalog.find((entry) => entry.id === "resources.files@1");
    expect(resources?.tier).toBe("gated");
    expect(resources?.approvedApps).toContain("com.reai.files");
    expect(catalog.find((entry) => entry.id === "http.fetch@1")?.methods).toContain("http.fetch");
  });

  test("官方插件对照把没有批准记录的受审能力标出来", () => {
    const rows = officialPluginRows();
    expect(rows.length).toBeGreaterThan(10);
    const files = rows.find((row) => row.appId === "com.reai.files");
    expect(files?.capabilities.find((capability) => capability.id === "resources.files@1")).toEqual({ id: "resources.files@1", tier: "gated", approved: true });
  });

  test("插件内显示的更新日志与 CHANGELOG.md 一致，且有当前版本", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(CHANGELOG_TEXT).toBe(changelog);
    expect(changelog).toContain(`## ${manifest.version} ·`);
  });
});
