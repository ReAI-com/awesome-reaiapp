import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createApp } from '../server/api.ts';
import type { AgentConfig, Dataset } from '../shared/types.ts';

const PUBLIC = 'https://maoding.example';
const API = 'https://oauth.example';
const ADMIN = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const SCOPE = 'profile:read model-gateway:invoke';
type Cookies = Map<string, string>;

async function fixture(t: TestContext, configured = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'maoding-public-'));
  let subject = ADMIN, serial = 0;
  const tokens = new Map<string, string>();
  const externalCalls: Array<{ url: string; init: RequestInit }> = [];
  const authFetch: typeof fetch = async (url, init = {}) => {
    const address = new URL(String(url));
    assert.equal(address.origin, API, 'OAuth credentials stay at the configured identity service');
    assert.equal(init.redirect, 'error');
    externalCalls.push({ url: address.href, init });
    if (address.pathname === '/oauth/token') {
      const accessToken = `wno-fixture-${++serial}`;
      tokens.set(accessToken, subject);
      return Response.json({ access_token: accessToken, refresh_token: `wno-rt-fixture-${serial}`, expires_in: 3600, token_type: 'Bearer', scope: SCOPE });
    }
    const bearer = new Headers(init.headers).get('Authorization')?.replace(/^Bearer /, '');
    if (address.pathname === '/oauth/userinfo') {
      const sub = tokens.get(bearer || ''); assert.ok(sub);
      return Response.json({ sub, name: 'OAuth 测试用户', display_name: 'OAuth 测试用户', email: null, scope: SCOPE, is_site_admin: false, is_real_team_admin: true });
    }
    if (address.pathname === '/api/model-gateway/v1/models') {
      assert.ok(tokens.has(bearer || ''));
      return Response.json({ object: 'list', data: [
        { id: 'available-chat', name: '可用模型', operations: [{ id: 'chat', availability: { available: true } }] },
        { id: 'unavailable-chat', operations: [{ id: 'chat', availability: { available: false } }] },
        { id: 'image-only', operations: [{ id: 'image', availability: { available: true } }] },
      ] });
    }
    if (address.pathname === '/oauth/revoke') return new Response(null, { status: 200 });
    throw new Error(`Unexpected fixture URL: ${address.pathname}`);
  };
  const runtime = createApp({ dataDir: root, authFetch, auth: { publicOrigin: PUBLIC, clientId: configured ? 'maoding-test-client' : '', apiBaseUrl: API, adminSubjects: [ADMIN], allowedSubjects: [MEMBER] } });
  const workspace = runtime.store.createWorkspace({ name: '隔离测试账套', role: '验证 OAuth 边界' });
  const agent = runtime.store.require<AgentConfig>('agents', 'agent-001', workspace.id);
  runtime.store.put('agents', { ...agent, apiKey: 'PRIVATE_OLD_KEY', mcp: { mcpServers: { example: { url: 'https://tool.example/mcp', headers: { Authorization: 'PRIVATE_MCP_TOKEN' }, env: { SECRET: 'PRIVATE_MCP_ENV' } } } } });
  const spec = runtime.store.list<{ id: string }>('specs', workspace.id)[0];
  const dataset: Dataset = { id: 'fixture-dataset', workspaceId: workspace.id, specId: spec.id, name: '财务记录', schema: { type: 'object', properties: { amount: { type: 'integer' } }, required: ['amount'], additionalProperties: false }, version: 1, createdAt: new Date().toISOString() };
  runtime.store.put('datasets', dataset);
  const record = runtime.store.createRecord(workspace.id, dataset.id, { amount: 500 });
  const board = await runtime.pipeline.boards.create(workspace.id, { name: '验证看板', prompt: '验证看板', datasetIds: [dataset.id], html: '<html><head><title>验证看板</title></head><body><h1>真实数据看板</h1></body></html>' });
  runtime.store.put('boards', { ...board, status: 'published' });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  async function request(route: string, init: RequestInit = {}, jar: Cookies = new Map()) {
    const headers = new Headers(init.headers);
    if (!headers.has('Host')) headers.set('Host', new URL(PUBLIC).host);
    if (!headers.has('X-Workbench-Request')) headers.set('X-Workbench-Request', '1');
    if (!headers.has('Cookie') && jar.size) headers.set('Cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
    // Core HTTP preserves an explicit virtual Host while connecting only to the local fixture.
    const prepared = new Request(address + route, { ...init, headers });
    const payload = init.body === undefined ? undefined : Buffer.from(await prepared.arrayBuffer());
    const response = await new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(address + route, { method: prepared.method, headers: Object.fromEntries(prepared.headers) }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () => {
          const received = new Headers();
          for (let i = 0; i < incoming.rawHeaders.length; i += 2) received.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
          resolve(new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: received }));
        });
        incoming.on('error', reject);
      });
      outgoing.on('error', reject); outgoing.end(payload);
    });
    for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split('='); if (value) jar.set(name, value); else jar.delete(name); }
    return response;
  }
  async function json(route: string, method = 'GET', body?: unknown, jar: Cookies = new Map(), extra: Record<string, string> = {}) {
    const response = await request(route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, jar);
    const value = await response.json() as any;
    return { response, value };
  }
  async function login(sub: string) {
    subject = sub;
    const jar = new Map<string, string>();
    const start = await request('/api/auth/login', {}, jar); assert.equal(start.status, 302);
    const redirect = new URL(start.headers.get('Location')!);
    const callback = await request(`/api/auth/callback?state=${redirect.searchParams.get('state')}&code=fixture-code`, {}, jar);
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('Location'), `${PUBLIC}/`);
    return jar;
  }
  return { root, runtime, workspace, dataset, record, board, request, json, login, externalCalls };
}

test('public management fails closed for anonymous sessions, invalid Host, Origin and missing CSRF marker', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bootstrap')).status, 401);
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/state`)).status, 401);
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/boards/${f.board.id}/preview`)).status, 401);
  assert.equal((await f.request('/api/auth/session', { headers: { Host: 'attacker.example', 'X-Forwarded-Host': 'maoding.example' } })).status, 403);
  assert.equal((await f.request('/api/auth/session', { headers: { Host: 'maoding.example:443' } })).status, 403);
  const admin = await f.login(ADMIN);
  const bootstrap = await f.json('/api/bootstrap', 'GET', undefined, admin); assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.value.workspaces[0].id, f.workspace.id);
  assert.match(bootstrap.response.headers.get('content-security-policy')!, /frame-src 'self';/);
  assert.match(bootstrap.response.headers.get('content-security-policy')!, /frame-ancestors 'self';/);
  for (const origin of ['https://attacker.example', 'http://maoding.example', 'null']) {
    assert.equal((await f.request('/api/bootstrap', { headers: { Origin: origin } }, admin)).status, 403);
  }
  assert.equal((await f.request('/api/bootstrap', { headers: { Origin: PUBLIC, 'X-Forwarded-Proto': 'http' } }, admin)).status, 200);
  const payload = JSON.stringify({ name: '新工作区', role: '测试' });
  assert.equal((await f.request('/api/workspaces', { method: 'POST', body: payload, headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '' } }, admin)).status, 403);
  const pathAttempt = await f.json('/api/workspaces', 'POST', { name: '禁止主机目录', role: '测试', directory: '/etc' }, admin);
  assert.equal(pathAttempt.response.status, 400);
  assert.equal(f.runtime.store.listWorkspaces().length, 1);
});

test('member cannot edit administrative resources or bypass guards by route casing; state omits configuration secrets', async t => {
  const f = await fixture(t); const member = await f.login(MEMBER);
  const base = `/api/workspaces/${f.workspace.id}`;
  const state = await f.json(`${base}/state`, 'GET', undefined, member);
  assert.equal(state.response.status, 200); assert.deepEqual(state.value.agents, []); assert.deepEqual(state.value.specs, []);
  assert.doesNotMatch(JSON.stringify(state.value), /PRIVATE_OLD_KEY|PRIVATE_MCP_TOKEN|PRIVATE_MCP_ENV/);
  const routes: Array<[string, string]> = [
    ['/api/workspaces', 'POST'], [`${base}/agents/agent-001`, 'PUT'], [`${base}/agents/wainao`, 'POST'],
    [`${base}/specs`, 'POST'], [`${base}/automation`, 'POST'], [`${base}/scan`, 'POST'],
    [`${base}/datasets/${f.dataset.id}/schema`, 'GET'], [`${base}/records/${f.record.id}`, 'POST'],
    [`${base}/records`, 'POST'], [`${base}/finance/setup`, 'POST'], [`${base}/finance/confirm`, 'POST'],
    [`${base}/finance/reporting`, 'POST'], [`${base}/runs/not-a-run/review`, 'POST'], ['/api/auth/models', 'GET'],
  ];
  for (const [route, method] of routes) {
    const result = await f.json(route, method, method === 'GET' ? undefined : {}, member);
    assert.equal(result.response.status, 403, `${method} ${route}: ${JSON.stringify(result.value)}`);
  }
  const old = f.runtime.store.require<AgentConfig>('agents', 'agent-001', f.workspace.id);
  for (const route of [`/api/WORKSPACES/${f.workspace.id}/AGENTS/agent-001`, `${base}/Agents/agent-001`]) {
    const result = await f.json(route, 'PUT', { ...old, prompt: '权限绕过', mcp: {} }, member);
    assert.ok([403, 404].includes(result.response.status), `casing cannot bypass admin authorization: ${result.response.status}`);
  }
  for (const route of ['/api/workspaces/', `${base}/runs/not-a-run/review/`]) {
    const result = await f.json(route, 'POST', { name: '尾斜杠绕过', role: '不得创建', records: [] }, member);
    assert.ok([403, 404].includes(result.response.status), `trailing slash cannot bypass admin authorization: ${result.response.status}`);
  }
  assert.equal(f.runtime.store.listWorkspaces().length, 1);
  assert.equal(f.runtime.store.require<AgentConfig>('agents', 'agent-001', f.workspace.id).prompt, old.prompt);
  const form = new FormData(); form.append('files', new Blob(['amount\n10\n'], { type: 'text/csv' }), 'member-upload.csv');
  assert.equal((await f.request(`${base}/uploads`, { method: 'POST', body: form }, member)).status, 201);
});

test('board REST uses its own scoped bearer without OAuth cookies and HTTPS preview remains sandboxed', async t => {
  const f = await fixture(t); const member = await f.login(MEMBER);
  const route = `/board-api/${f.board.id}`;
  assert.equal((await f.request(`${route}/schema`, {}, member)).status, 403, 'an OAuth cookie is not a board bearer');
  assert.equal((await f.request(`${route}/schema`, { headers: { Authorization: 'Bearer incorrect' } })).status, 403);
  const bearer = { Authorization: `Bearer ${f.board.token}`, Origin: 'null' };
  const records = await f.json(`${route}/records?datasetId=${f.dataset.id}`, 'GET', undefined, undefined, bearer);
  assert.equal(records.response.status, 200); assert.equal(records.value.records[0].data.amount, 500);
  assert.equal(records.response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await f.request(`${route}/records?datasetId=foreign-table`, { headers: bearer })).status, 403);
  const created = await f.json(`${route}/records`, 'POST', { datasetId: f.dataset.id, data: { amount: 200 } }, undefined, bearer);
  assert.equal(created.response.status, 201);
  const preview = await f.request(`/api/workspaces/${f.workspace.id}/boards/${f.board.id}/preview`, { headers: { 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'attacker.example', 'Sec-Fetch-Dest': 'iframe' } }, member);
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'no-store');
  const csp = preview.headers.get('content-security-policy')!;
  assert.match(csp, /connect-src https:\/\/maoding\.example;/); assert.match(csp, /sandbox allow-scripts/); assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors 'self';/);
  const html = await preview.text();
  assert.match(html, new RegExp(`${PUBLIC}/board-api/${f.board.id}`));
  assert.match(html, /credentials:'omit'/); assert.match(html, /maoding-board-update/); assert.match(html, /parent!==window/);
  assert.doesNotMatch(html, /http:\/\/maoding|attacker\.example|wno-fixture|PRIVATE_OLD_KEY|PRIVATE_MCP_TOKEN/);
});

test('direct board documents use a trusted token-free wrapper with nonce scripts and source-bound hot updates', async t => {
  const f = await fixture(t); const member = await f.login(MEMBER);
  const previewPath = `/api/workspaces/${f.workspace.id}/boards/${f.board.id}/preview`;
  const unsafeName = '</title><script>alert("name")</script>';
  f.runtime.store.put('boards', { ...f.board, name: unsafeName });
  for (const destination of [undefined, 'document', 'empty', 'image']) {
    const response = await f.request(previewPath, { headers: destination ? { 'Sec-Fetch-Dest': destination } : {} }, member);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('vary')!, /Sec-Fetch-Dest/i);
    const csp = response.headers.get('content-security-policy')!;
    assert.match(csp, /default-src 'none';/); assert.match(csp, /frame-src 'self';/); assert.match(csp, /frame-ancestors 'self';/);
    assert.doesNotMatch(csp, /unsafe-inline|(?:^|;)\s*sandbox(?:\s|;|$)/);
    const html = await response.text();
    assert.ok(!html.includes(f.board.token), 'trusted parent must never hold the board bearer');
    assert.doesNotMatch(html, /window\.employee|真实数据看板|<script>alert/);
    assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
    assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
    assert.ok(html.includes(`src="${previewPath}?v=1"`));
    const nonce = html.match(/<script nonce="([A-Za-z0-9+/=]+)">([\s\S]*?)<\/script>/)!;
    assert.ok(nonce); assert.ok(csp.includes(`script-src 'nonce-${nonce[1]}'`)); assert.ok(csp.includes(`style-src 'nonce-${nonce[1]}'`));
    assert.doesNotMatch(nonce[2], /location\.reload|location\.href|window\.employee/);
    const frame = { contentWindow: {}, src: `${previewPath}?v=1` };
    let listener: (event: { source: object; data: unknown }) => void = () => { throw new Error('missing listener'); };
    runInNewContext(nonce[2], { document: { getElementById(id: string) { assert.equal(id, 'board-preview'); return frame; } }, addEventListener(type: string, handler: typeof listener) { assert.equal(type, 'message'); listener = handler; } });
    const data = { type: 'maoding-board-update', boardId: f.board.id, version: 2 };
    listener({ source: {}, data }); assert.equal(frame.src, `${previewPath}?v=1`);
    listener({ source: frame.contentWindow, data: { ...data, boardId: 'foreign' } }); assert.equal(frame.src, `${previewPath}?v=1`);
    listener({ source: frame.contentWindow, data: { ...data, version: 1.5 } }); assert.equal(frame.src, `${previewPath}?v=1`);
    listener({ source: frame.contentWindow, data }); assert.equal(frame.src, `${previewPath}?v=2`);
    listener({ source: frame.contentWindow, data: { ...data, version: 1 } }); assert.equal(frame.src, `${previewPath}?v=2`);
  }
});

test('OAuth model connection uses validated catalog, clears stored keys and pins invocation endpoint despite edited base URL', async t => {
  const f = await fixture(t); const admin = await f.login(ADMIN);
  const base = `/api/workspaces/${f.workspace.id}`;
  const catalog = await f.json('/api/auth/models', 'GET', undefined, admin);
  assert.equal(catalog.response.status, 200); assert.deepEqual(catalog.value.data, [{ id: 'available-chat', name: '可用模型' }]);
  assert.equal((await f.json(`${base}/agents/wainao`, 'POST', { model: 'unavailable-chat' }, admin)).response.status, 400);
  assert.equal((await f.json(`${base}/agents/wainao`, 'POST', { model: 'available-chat' }, admin)).response.status, 200);
  for (const agent of f.runtime.store.list<AgentConfig>('agents', f.workspace.id)) {
    assert.equal(agent.provider, 'wainao'); assert.equal(agent.apiKey, undefined); assert.equal(agent.oauthSubject, ADMIN);
    assert.equal(agent.baseUrl, `${API}/api/model-gateway/v1`);
  }
  const old = f.runtime.store.require<AgentConfig>('agents', 'agent-001', f.workspace.id);
  const changed = await f.json(`${base}/agents/agent-001`, 'PUT', { ...old, baseUrl: 'https://attacker.example/v1', protocol: 'anthropic-messages', apiKey: 'ATTACKER_SUPPLIED_KEY', oauthSubject: MEMBER }, admin);
  assert.equal(changed.response.status, 200);
  const actual = f.runtime.store.require<AgentConfig>('agents', 'agent-001', f.workspace.id);
  assert.equal(actual.baseUrl, `${API}/api/model-gateway/v1`); assert.equal(actual.protocol, 'openai-completions');
  assert.equal(actual.oauthSubject, ADMIN); assert.equal(actual.apiKey, undefined);
  const db = JSON.stringify(f.runtime.store.db.prepare('SELECT payload FROM entities').all());
  assert.doesNotMatch(db, /wno-fixture|wno-rt-fixture|ATTACKER_SUPPLIED_KEY|PRIVATE_OLD_KEY/);
  const vault = await readFile(path.join(f.root, 'auth', 'grants.enc'), 'utf8');
  assert.doesNotMatch(vault, /wno-fixture|wno-rt-fixture/);
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: { Origin: PUBLIC } }, admin);
  assert.equal(logout.status, 200); assert.equal((await f.request('/api/bootstrap', {}, admin)).status, 401);
});

test('public deployment without a registered OAuth client cannot expose existing financial data', async t => {
  const f = await fixture(t, false);
  const session = await f.json('/api/auth/session');
  assert.deepEqual(session.value, { enabled: true, configured: false, user: null });
  assert.equal((await f.request('/api/bootstrap')).status, 503);
  assert.equal((await f.request(`/api/workspaces/${f.workspace.id}/state`)).status, 503);
  assert.equal((await f.request('/api/auth/login')).status, 503);
  assert.equal(f.externalCalls.length, 0);
});
