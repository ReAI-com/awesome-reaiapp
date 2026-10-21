/** 把 CHANGELOG.md 写进 src/release-notes.ts，设置页的「版本」入口在插件内显示它。改完日志后运行：bun run release-notes */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
writeFileSync(
  resolve(root, "src/release-notes.ts"),
  `// 由 scripts/sync-release-notes.ts 从 CHANGELOG.md 生成，不要手改。\nexport const CHANGELOG_TEXT = ${JSON.stringify(changelog)};\n`,
);
