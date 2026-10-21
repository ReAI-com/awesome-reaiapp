/**
 * TBC 挂点的样例部分（自主项目 tests/plugin-contracts/tbc-markers.plugin.test.ts 迁入）。
 *
 * 主项目 Host 临时 TBC 注册表里需要样例自己挂出的 id，必须真的出现在对应样例的视图源码里；
 * Host 标题栏动作 → TBC id 映射引用的动作也必须真的被样例声明。注册表本身归 Host 半。
 */
import { describe, expect, test } from "bun:test";

import mounts from "./fixtures/tbc-plugin-mounts.json";
import { exampleManifest, readExample } from "./support/paths";

describe("TBC 插件挂点（样例）", () => {
  test("每条样例挂点都出现在对应视图源码里，且 appId 与 Host 匹配一致", () => {
    expect(mounts.inlineMounts.length).toBeGreaterThan(0);
    for (const mount of mounts.inlineMounts) {
      expect(readExample(mount.slug, mount.file)).toContain(mount.id);
      expect(exampleManifest(mount.slug).appId).toBe(mount.appId);
    }
  });

  test("Host 标题栏动作映射引用的动作都由样例 Manifest 声明", () => {
    for (const mount of mounts.titlebarActionMounts) {
      const manifest = exampleManifest(mount.slug);
      expect(manifest.appId).toBe(mount.appId);
      expect((manifest.contributes?.titlebarActions ?? []).map((action: { id: string }) => action.id))
        .toContain(mount.actionId);
    }
  });
});
