// 把 CHANGELOG.md 同步成可打包的模块：设置页底部「版本」入口展示的就是这份内容。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
writeFileSync(
  resolve(root, "src/release-notes.ts"),
  `// 由 CHANGELOG.md 生成，修改日志后运行 bun run sync:notes。\nexport const CHANGELOG_TEXT = ${JSON.stringify(changelog)};\n`,
);
