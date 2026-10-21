/**
 * 插件审核基线的样例部分（自主项目 tests/plugin-contracts/plugin-review-baseline.plugin.test.ts 迁入）。
 *
 * 主项目审核候选目录登记的样例源码根经 fixtures/plugin-review-baseline.json 镜像；
 * 这里断言每个源码根都有 manifest 且 appId 一致。审核 / 发布状态是主项目事实，归 Host 半。
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import baseline from "./fixtures/plugin-review-baseline.json";
import { exampleFile, exampleManifest } from "./support/paths";

describe("插件审核基线（样例）", () => {
  test("审核候选登记的每个样例源码根都有 manifest，且 appId 一致", () => {
    expect(baseline.pluginCandidates.length).toBeGreaterThan(0);
    for (const { appId, slug } of baseline.pluginCandidates) {
      expect(existsSync(exampleFile(slug, "app.manifest.json")), slug).toBe(true);
      expect(exampleManifest<{ appId: string }>(slug).appId).toBe(appId);
    }
  });
});
