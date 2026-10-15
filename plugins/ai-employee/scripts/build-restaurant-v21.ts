import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { generateRestaurantV21 } from '../src/restaurant-v21/generator';

const root = new URL('../', import.meta.url);
const base = await readFile(new URL('design/paradigm-v2.html', root), 'utf8');
const target = new URL('design/restaurant-v2.1.html', root);
await writeFile(target, generateRestaurantV21(base));
console.log(`Generated ${fileURLToPath(target)}`);
