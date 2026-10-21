import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import matrix from "@reai/app-contract/host-support-matrix.json";
import { buildCatalog, manifest, officialPluginRows, tierCounts, tierOf, usableByLocalPackage } from "../src/catalog";
import { CAPABILITY_TEXT, textFor } from "../src/capability-text";
import { CHANGELOG_TEXT } from "../src/release-notes";

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

  test("矩阵新增、还没写说明的能力有通用说明兜底，不会让界面空白", () => {
    expect(textFor("future.capability@9").title).toBe("future.capability@9");
    expect(textFor("future.capability@9").summary.length).toBeGreaterThan(0);
    // 当前矩阵里的能力至少大部分已有人话说明（缺的会在界面上显示通用说明）。
    const described = catalog.filter((entry) => entry.id in CAPABILITY_TEXT).length;
    expect(described / catalog.length).toBeGreaterThan(0.8);
  });

  test("四档数量与矩阵一致", () => {
    const counts = tierCounts(catalog);
    expect(counts.granted).toBe(matrix.hostCapabilities.granted.length);
    expect(counts.gated).toBe(matrix.hostCapabilities.grantGated.length);
    expect(counts.withheld).toBe(Object.keys(matrix.hostCapabilities.withheld).length);
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

  test("需要批准的能力带出审核清单里获批的插件；Bridge 方法来自矩阵", () => {
    expect(catalog.some((entry) => entry.tier === "gated" && entry.approvedApps.length > 0)).toBe(true);
    expect(catalog.find((entry) => entry.id === "http.fetch@1")?.methods).toContain("http.fetch");
  });

  test("插件仓对照：每个插件的能力都标了档位，受审能力标了是否有批准记录", () => {
    const rows = officialPluginRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const capability of row.capabilities) {
        if (capability.tier !== "gated") expect(capability.approved).toBe(true);
      }
    }
  });

  test("插件内显示的更新日志与 CHANGELOG.md 一致，且有当前版本", () => {
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    expect(CHANGELOG_TEXT).toBe(changelog);
    expect(changelog).toContain(`## ${manifest.version} ·`);
  });
});
