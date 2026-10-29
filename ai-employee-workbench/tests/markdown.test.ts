import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent, safeMarkdownUrl, parseRecordCitation } from '../src/MarkdownContent.tsx';
import { resolveRecordCitation } from '../src/RecordCitationDialog.tsx';
import type { DataRecord } from '../shared/types.ts';

const row: DataRecord = {
  id: '2f01d4a2-5ac2-49d2-b6d7-13a1d6375d80', workspaceId: 'workspace-a', datasetId: 'bank',
  version: 2, data: { transaction_id: 'T001', amount_fen: 12345 }, manual: false,
  createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
};
const render = (content: string, records: DataRecord[] = []) => renderToStaticMarkup(createElement(MarkdownContent, { content, records, onCitation: () => {} }));

test('expert Markdown renders GFM structure with scrollable tables and readable code', () => {
  const html = render('# 财务摘要\n\n**已核对**，净流入。\n\n- 收款\n- 付款\n\n> 金额单位：元\n\n| 项目 | 金额 |\n| --- | ---: |\n| 净流入 | 11,720 |\n\n```json\n{"currency":"CNY"}\n```\n\n- [x] 已核对');
  assert.match(html, /<h1>财务摘要<\/h1>/);
  assert.match(html, /<strong>已核对<\/strong>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /class="markdown-table-scroll" role="region" aria-label="回答中的表格"/);
  assert.match(html, /<table>/);
  assert.match(html, /<pre tabindex="0"><code class="language-json">/);
  assert.match(html, /type="checkbox" disabled="" checked=""/);
});

test('expert Markdown never executes raw HTML or loads images and rejects unsafe navigation', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://tracker.invalid"></iframe>\n\n<img src="https://tracker.invalid/pixel" onerror="alert(1)">\n\n![远程图片](https://tracker.invalid/pixel)\n\n[危险](javascript:alert%281%29) [文件](file:///etc/passwd) [数据](data:text/html,evil) [文档](https://example.org/docs)');
  assert.doesNotMatch(html, /<(script|iframe|img)\b/i);
  assert.doesNotMatch(html, /href="(?:javascript|file|data):/i);
  assert.doesNotMatch(html, /(?:href|src)="https:\/\/tracker/);
  assert.match(html, /\[图片：远程图片\]/);
  assert.match(html, /href="https:\/\/example.org\/docs" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/);
  for (const url of ['javascript:alert(1)', 'data:text/html,evil', 'file:///secret', ' https://example.org', 'https://user:secret@example.org/', '/api/workspaces']) assert.equal(safeMarkdownUrl(url), '');
});

test('record citations become scoped version controls while code and existing links stay literal', () => {
  const citation = `[记录:${row.id} v2]`;
  const oldCitation = `[记录:${row.id} v1]`;
  const html = render(`已确认 ${citation}；历史 ${oldCitation}；缺失 [记录:not-found v3]。\n\n\`${citation}\`\n\n\`\`\`text\n${citation}\n\`\`\`\n\n[${citation}](https://example.org)`, [row]);
  assert.equal((html.match(/class="record-citation"/g) || []).length, 3);
  assert.match(html, /aria-label="查看引用 T001 · v2"/);
  assert.match(html, /aria-label="查看引用 2f01d4a2 · v1"/);
  assert.match(html, /aria-label="查看引用 not-foun · v3"/);
  assert.match(html, /<code>\[记录:/);
  assert.deepEqual(parseRecordCitation(`#record:${row.id}:2`), { id: row.id, version: 2 });
  assert.equal(parseRecordCitation('#record:x:9007199254740992'), undefined);
  assert.equal(parseRecordCitation('#record:x:0'), undefined);
});

test('citation lookup preserves exact historical versions and never substitutes another workspace', () => {
  const old: DataRecord = { ...row, version: 1, data: { transaction_id: 'ORIGINAL', amount_fen: 100 } };
  const citation = { id: row.id, version: 1 };
  assert.equal(resolveRecordCitation([old, row], citation, 'workspace-a'), old);
  assert.equal(resolveRecordCitation([row], citation, 'workspace-a'), undefined);
  assert.equal(resolveRecordCitation([old], citation, 'workspace-b'), undefined);
  assert.equal(resolveRecordCitation([old], { id: 'missing', version: 1 }, 'workspace-a'), undefined);
});
