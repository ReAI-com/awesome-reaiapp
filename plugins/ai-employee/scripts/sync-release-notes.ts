import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const changelog=readFileSync(resolve(root,'CHANGELOG.md'),'utf8');
writeFileSync(resolve(root,'src/release-notes.ts'),`// Generated from CHANGELOG.md. Run the release-note sync after editing that file.\nexport const CHANGELOG_TEXT = ${JSON.stringify(changelog)};\n`);
