/**
 * 生成「官方插件对照」快照：读取插件仓 plugins/<slug>/app.manifest.json，
 * 只保留名称、版本和声明的能力，写到 src/generated/official-plugins.ts。
 *
 * 插件运行时读不到别的插件装没装、声明了什么（平台没有这类接口），
 * 所以对照表只能是构建时的静态快照。插件仓有变化后重跑：bun run snapshot
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginsRoot = resolve(here, "../../../plugins");
const out = resolve(here, "../src/generated/official-plugins.ts");

interface Manifest {
  appId: string;
  name: string;
  version: string;
  requires?: { hostCapabilities?: string[] };
  permissions?: { id: string }[];
}

const plugins = readdirSync(pluginsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsRoot, entry.name, "app.manifest.json")))
  .map((entry) => {
    const manifest = JSON.parse(readFileSync(join(pluginsRoot, entry.name, "app.manifest.json"), "utf8")) as Manifest;
    return {
      slug: entry.name,
      appId: manifest.appId,
      name: manifest.name,
      version: manifest.version,
      capabilities: [...(manifest.requires?.hostCapabilities ?? [])].sort(),
      permissions: (manifest.permissions ?? []).map((permission) => permission.id).sort(),
    };
  })
  .sort((a, b) => a.slug.localeCompare(b.slug));

const date = process.env.SNAPSHOT_DATE ?? new Date().toISOString().slice(0, 10);
const body = {
  generatedOn: date,
  source: "awesome-reaiapp plugins/*/app.manifest.json",
  plugins,
};
writeFileSync(
  out,
  `// 由 scripts/snapshot-official-plugins.ts 生成，不要手改。重新生成：bun run snapshot\n` +
    `export const OFFICIAL_PLUGINS_SNAPSHOT = ${JSON.stringify(body, null, 2)} as const;\n`,
);
console.log(`已写入 ${plugins.length} 个插件 → src/generated/official-plugins.ts`);
