import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generateRestaurantV21 } from '../src/restaurant-v21/generator';

const base = readFileSync(new URL('../design/paradigm-v2.html', import.meta.url), 'utf8');

test('the committed standalone restaurant page is reproducible from the unchanged v2 source', () => {
  const generated = readFileSync(new URL('../design/restaurant-v2.1.html', import.meta.url), 'utf8');
  expect(generated).toBe(generateRestaurantV21(base));
  expect(generateRestaurantV21(base)).toBe(generateRestaurantV21(base));
});

test('source drift fails generation instead of silently shipping an incomplete restaurant page', () => {
  expect(() => generateRestaurantV21(base.replace('const ROLES = [', 'const RENAMED_ROLES = ['))).toThrow('expected one anchor');
  expect(() => generateRestaurantV21(base + '<title>AI 员工范式 v2 · 交互设计稿</title>')).toThrow('expected one anchor');
});
