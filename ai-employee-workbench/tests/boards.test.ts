import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/api.ts';
import type { Board, BoardRevision, Dataset } from '../shared/types.ts';

const html = (label: string) => `<!doctype html><html lang="zh"><head><title>${label}</title></head><body><h1>${label}</h1><script>employee.schema().then(console.log)</script></body></html>`;
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'workbench-boards-'));
  const app = createApp({ dataDir: root });
  const workspace = app.store.createWorkspace({ name: '看板测试', role: '测试看板更新' });
  const other = app.store.createWorkspace({ name: '其他岗位', role: '隔离验收' });
  const spec = app.store.list<{ id: string }>('specs', workspace.id)[0];
  const dataset: Dataset = { id: 'board-dataset', workspaceId: workspace.id, specId: spec.id, name: '测试表', schema: { type: 'object', properties: { amount: { type: 'integer' } }, required: ['amount'], additionalProperties: false }, version: 1, createdAt: new Date().toISOString() };
  app.store.put('datasets', dataset);
  const directory = path.join(root, 'boards', workspace.id, 'legacy-board'); await mkdir(directory, { recursive: true });
  const htmlPath = path.join(directory, 'index.html'); await writeFile(htmlPath, html('原版'));
  const board: Board = { id: 'legacy-board', workspaceId: workspace.id, name: '原版看板', description: '原始说明', prompt: '初始需求', status: 'published', htmlPath, token: 'local-board-test-token', datasetIds: [dataset.id], createdAt: new Date().toISOString() };
  app.store.put('boards', board);
  const server = app.app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const base = `/api/workspaces/${workspace.id}/boards/${board.id}`;
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  async function request(route: string, method = 'GET', body?: unknown, expected = 200, headers: Record<string, string> = {}) {
    const res = await fetch(origin + route, { method, headers: { 'X-Workbench-Request': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await res.json(); assert.equal(res.status, expected, JSON.stringify(result)); return result;
  }
  return { ...app, root, origin, base, board, workspace, other, request };
}

test('legacy board editing preserves immutable history, restores by append, and serves scoped hot-update metadata', async t => {
  const f = await setup(t);
  const initial = await f.request(`${f.base}/source`);
  assert.equal(initial.version, 1); assert.equal(initial.html, html('原版'));
  assert.deepEqual(Object.keys(initial).sort(), ['datasetIds', 'description', 'html', 'name', 'version']);
  const saved = await f.request(`${f.base}/source`, 'PUT', { version: 1, html: html('第二版'), name: '新版看板' });
  assert.equal(saved.version, 2); assert.equal(saved.board.id, f.board.id); assert.equal(saved.board.status, 'published');
  assert.equal(saved.board.token, undefined); assert.equal(saved.board.htmlPath, undefined);
  const revisions = f.store.list<BoardRevision>('boardVersions', f.workspace.id);
  assert.equal(revisions.length, 2);
  assert.equal(await readFile(revisions.find(r => r.version === 1)!.htmlPath, 'utf8'), html('原版'));
  assert.throws(() => f.store.put('boardVersions', { ...revisions[0], name: '覆盖历史' }), /只增不改/);
  const history = await f.request(`${f.base}/versions`);
  assert.deepEqual(history.versions.map((r: any) => r.version), [2, 1]);
  assert.doesNotMatch(JSON.stringify(history), /htmlPath|token|workspaceId/);
  const preview = await fetch(f.origin + f.base + '/preview', { headers: { 'Sec-Fetch-Dest': 'iframe' } }); const markup = await preview.text();
  assert.match(markup, /第二版/); assert.match(markup, /activeVersion=2/); assert.match(markup, /location\.reload\(\)/); assert.match(markup, /,3000\)/);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  assert.match(preview.headers.get('content-security-policy')!, /sandbox allow-scripts/);
  assert.doesNotMatch(preview.headers.get('content-security-policy')!, /allow-same-origin/);
  const auth = { Authorization: `Bearer ${f.board.token}` };
  await f.request(`/board-api/${f.board.id}/version`, 'GET', undefined, 403);
  const live = await f.request(`/board-api/${f.board.id}/version`, 'GET', undefined, 200, auth);
  assert.equal(live.version, 2); assert.deepEqual(Object.keys(live).sort(), ['updatedAt', 'version']);
  const restored = await f.request(`${f.base}/restore`, 'POST', { version: 2, targetVersion: 1 });
  assert.equal(restored.version, 3); assert.equal((await f.request(`${f.base}/source`)).html, html('原版'));
  assert.deepEqual((await f.request(`${f.base}/versions`)).versions.map((r: any) => r.version), [3, 2, 1]);
  assert.equal(f.store.require<Board>('boards', f.board.id, f.workspace.id).token, f.board.token);
});

test('concurrent and stale saves cannot overwrite a winning version; routes keep workspace and file boundaries', async t => {
  const f = await setup(t);
  const updates = await Promise.all(['甲', '乙'].map(label => fetch(f.origin + f.base + '/source', { method: 'PUT', headers: { 'X-Workbench-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, html: html(label) }) })));
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  const source = await f.request(`${f.base}/source`); assert.equal(source.version, 2);
  assert.equal((await f.request(`${f.base}/versions`)).versions.length, 2);
  await f.request(`${f.base}/source`, 'PUT', { version: 1, html: html('过期') }, 409);
  await f.request(`${f.base}/source`, 'PUT', { version: 2, html: '<p>无完整HTML</p>' }, 400);
  await f.request(`${f.base}/source`, 'PUT', { version: 2, html: `<html>${'中'.repeat(300_000)}</html>` }, 400);
  const foreign = `/api/workspaces/${f.other.id}/boards/${f.board.id}`;
  await f.request(`${foreign}/source`, 'GET', undefined, 404);
  await f.request(`${foreign}/source`, 'PUT', { version: 2, html: html('跨岗位') }, 404);
  await f.request(`${foreign}/versions`, 'GET', undefined, 404);
  await f.request(`${foreign}/restore`, 'POST', { version: 2, targetVersion: 1 }, 404);
  await f.request(`${foreign}/update`, 'POST', { version: 2, prompt: '跨岗位修改' }, 404);
  await f.request(`${f.base}/restore`, 'POST', { version: 2, targetVersion: 99 }, 404);
  const before = f.store.require<Board>('boards', f.board.id, f.workspace.id);
  await f.request(`${f.base}/source`, 'PUT', { version: 2, html: html('第三版'), htmlPath: '/etc/passwd', datasetIds: ['foreign-dataset'] });
  const after = f.store.require<Board>('boards', f.board.id, f.workspace.id);
  assert.deepEqual(after.datasetIds, before.datasetIds); assert.ok(after.htmlPath.startsWith(path.join(f.root, 'boards')));
});

test('real Pi board update is version-bound: a late result is superseded, then a fresh update keeps board identity', async t => {
  const f = await setup(t);
  let resume: (() => void) | undefined, arrived: (() => void) | undefined, paused = true;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw), rawContent = payload.messages.at(-1).content;
    const content = typeof rawContent === 'string' ? rawContent : rawContent.map((part: any) => part.text || '').join('\n');
    assert.match(content, /<previous-html>/); assert.match(content, /原版|人工抢先/);
    if (paused) { arrived?.(); await gate; }
    const output = JSON.stringify({ name: 'Agent修改版', description: '修改完成', datasetIds: ['board-dataset'], html: html('Agent结果') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'board-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'board-fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(async () => { resume?.(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const agent = (await f.request(`/api/workspaces/${f.workspace.id}/state`)).agents.find((a: any) => a.agentId === 'agent-002');
  await f.request(`/api/workspaces/${f.workspace.id}/agents/agent-002`, 'PUT', { ...agent, provider: 'board-test', model: 'board-test', baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, parameters: { thinkingLevel: 'off', maxTokens: 4096 } });
  const pending = await f.request(`${f.base}/update`, 'POST', { version: 1, prompt: '改成新的布局' }, 202);
  assert.equal(pending.run.boardId, f.board.id);
  await arrival;
  await f.request(`${f.base}/source`, 'PUT', { version: 1, html: html('人工抢先') });
  paused = false; resume?.(); await f.pipeline.idle();
  let state = await f.request(`/api/workspaces/${f.workspace.id}/state`);
  assert.equal(state.runs.find((r: any) => r.id === pending.run.id).status, 'superseded');
  assert.equal((await f.request(`${f.base}/source`)).html, html('人工抢先'));
  const current = await f.request(`${f.base}/update`, 'POST', { version: 2, prompt: '在当前版本上继续修改' }, 202);
  await f.pipeline.idle(); state = await f.request(`/api/workspaces/${f.workspace.id}/state`);
  const run = state.runs.find((r: any) => r.id === current.run.id);
  assert.equal(run.status, 'succeeded', run.error); assert.deepEqual(run.result, { boardId: f.board.id, boardVersion: 3 });
  assert.equal(state.boards.length, 1); assert.equal(state.boards[0].status, 'published');
  assert.equal((await f.request(`${f.base}/source`)).html, html('Agent结果'));
});
