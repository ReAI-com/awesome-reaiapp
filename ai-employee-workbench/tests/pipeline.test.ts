import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentJson } from '../server/pipeline.ts';

test('parseAgentJson accepts plain and fenced JSON payloads', () => {
  assert.deepEqual(parseAgentJson('{"specId":"spec-a","reason":"r"}'), { specId: 'spec-a', reason: 'r' });
  assert.deepEqual(parseAgentJson('```json\n{"records":[]}\n```'), { records: [] });
});

test('parseAgentJson failure includes the truncation hint and output snippets', () => {
  const output = '{"name":"看板","html":"<!doctype html>…'.padEnd(600, 'x');
  assert.throws(() => parseAgentJson(output), (error: Error & { statusCode?: number }) =>
    error.message.includes('最大 Tokens 上限')
    && error.message.includes('{"name":"看板","html":"<!doctype html>…'.slice(0, 30))
    && error.message.includes('…'.padEnd(120, 'x').slice(0, 20)));
  assert.throws(() => parseAgentJson('前置说明 {"a":1}'), /输出开头/);
});
