import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, type AuthConfig } from '../server/auth.ts';

const SUBJECT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const PUBLIC = 'https://maoding.example';
const CLIENT = 'maoding-public-client';
const SCOPE = 'profile:read model-gateway:invoke';
const SESSION_COOKIE = '__Host-maoding-session';

async function fixture(t: TestContext, configuration: Partial<AuthConfig> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'maoding-auth-'));
  const config: AuthConfig = { publicOrigin: PUBLIC, clientId: CLIENT, apiBaseUrl: 'https://oauth.example', adminSubjects: [SUBJECT], ...configuration };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const profile: Record<string, unknown> = { sub: SUBJECT, display_name: '财务测试员', name: '财务测试员', email: 'finance@example.com', scope: SCOPE, is_site_admin: false, is_real_team_admin: false };
  const requests: Array<{ url: URL; init: RequestInit; form: URLSearchParams }> = [];
  const consumed = new Set<string>();
  let serial = 0;
  let rejectRefresh = false, rejectUserinfo = false, rejectRevoke = false;
  let tokenMutation: ((value: Record<string, unknown>) => unknown) | undefined;
  let pauseRefresh: (() => Promise<void>) | undefined;
  const fetchMock: typeof fetch = async (url, init = {}) => {
    const address = new URL(String(url)), form = new URLSearchParams(String(init.body || ''));
    requests.push({ url: address, init, form });
    assert.equal(init.redirect, 'error', 'credential requests must not follow redirects');
    if (address.pathname === '/oauth/token') {
      if (form.get('grant_type') === 'refresh_token') {
        const token = form.get('refresh_token')!;
        if (rejectRefresh || consumed.has(token)) return Response.json({ error: 'invalid_grant', access_token: 'PRIVATE_PROVIDER_ERROR' }, { status: 400 });
        consumed.add(token);
        if (pauseRefresh) await pauseRefresh();
      }
      serial++;
      const value = { access_token: `wno-access-${serial}`, token_type: 'Bearer', refresh_token: `wno-rt-refresh-${serial}`, expires_in: 3600, scope: SCOPE };
      return Response.json(tokenMutation ? tokenMutation(value) : value);
    }
    if (address.pathname === '/oauth/userinfo') return rejectUserinfo ? Response.json({ error: 'PRIVATE_PROVIDER_ERROR' }, { status: 401 }) : Response.json(profile);
    if (address.pathname === '/oauth/revoke') return Response.json({}, { status: rejectRevoke ? 503 : 200 });
    throw new Error(`Unexpected test endpoint ${address.pathname}`);
  };
  let auth = createAuth({ dataDir: directory, config, fetch: fetchMock });
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let base = '';
  let markLogout!: () => void;
  const logoutStarted = new Promise<void>(resolve => { markLogout = resolve; });
  function application() {
    const app = express();
    app.use((req, _res, next) => { if (req.path === '/api/auth/logout') markLogout(); next(); });
    auth.register(app);
    app.get('/user', auth.requireUser, (req, res) => res.json({ request: req.identity, locals: res.locals.identity }));
    app.get('/admin', auth.requireAdmin, (_req, res) => res.json(res.locals.identity));
    return app;
  }
  async function listen() {
    server = application().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.on('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  await listen();
  async function shutdown() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  t.after(async () => { auth.close(); await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const cookies = new Map<string, string>();
  async function request(route: string, init: RequestInit = {}, jar = cookies) {
    const headers = new Headers(init.headers);
    if (!headers.has('Cookie')) headers.set('Cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
    const response = await fetch(base + route, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [name, value] = cookie.split(';')[0].split('=');
      if (value) jar.set(name, value); else jar.delete(name);
    }
    return response;
  }
  async function begin(jar = cookies) {
    const response = await request('/api/auth/login', {}, jar);
    assert.equal(response.status, 302);
    return { response, authorize: new URL(response.headers.get('Location')!) };
  }
  async function callback(authorize: URL, jar = cookies, extra = '') {
    return request(`/api/auth/callback?state=${authorize.searchParams.get('state')}&code=test-code${extra}`, {}, jar);
  }
  async function login() { const { authorize } = await begin(); const response = await callback(authorize); assert.equal(response.headers.get('Location'), `${PUBLIC}/`); return response; }
  return {
    directory, config, profile, requests, cookies, request, begin, callback, login, logoutStarted,
    get auth() { return auth; },
    advance(ms: number) { now += ms; },
    rejectRefresh() { rejectRefresh = true; }, rejectUserinfo() { rejectUserinfo = true; }, rejectRevoke() { rejectRevoke = true; },
    mutateToken(fn: (value: Record<string, unknown>) => unknown) { tokenMutation = fn; },
    holdRefresh() {
      let entered!: () => void, release!: () => void;
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      pauseRefresh = () => { entered(); return held; };
      return { arrived, release };
    },
    async restart() { auth.close(); await shutdown(); auth = createAuth({ dataDir: directory, config, fetch: fetchMock }); await listen(); },
  };
}

test('unconfigured OAuth fails closed while session status remains readable', async t => {
  const f = await fixture(t, { clientId: '' });
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), { enabled: true, configured: false, user: null });
  for (const route of ['/api/auth/login', '/user', '/admin']) assert.equal((await f.request(route)).status, 503);
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /not_configured/);
  assert.equal(f.requests.length, 0);
});

test('PKCE login binds state to the browser, consumes it once and creates a secure opaque session', async t => {
  const f = await fixture(t, { development: true });
  const { response, authorize } = await f.begin();
  assert.equal(authorize.origin, 'https://oauth.example');
  assert.equal(authorize.pathname, '/oauth/authorize');
  assert.equal(authorize.searchParams.get('scope'), SCOPE);
  assert.equal(authorize.searchParams.get('development'), '1');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC}/api/auth/callback`);
  assert.match(response.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=Lax/);
  const wrongBrowser = await f.callback(authorize, new Map());
  assert.equal(wrongBrowser.headers.get('Location'), `${PUBLIC}/?auth_error=invalid_state`);
  assert.equal(f.requests.length, 0);
  const callback = await f.callback(authorize);
  assert.equal(callback.headers.get('Location'), `${PUBLIC}/`);
  assert.equal((await f.callback(authorize)).headers.get('Location'), `${PUBLIC}/?auth_error=invalid_state`);
  const exchange = f.requests.find(item => item.url.pathname === '/oauth/token')!;
  assert.equal(exchange.form.get('client_secret'), null);
  assert.equal(createHash('sha256').update(exchange.form.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
  assert.match(String((exchange.init.headers as Record<string, string>)['Content-Type']), /application\/x-www-form-urlencoded/);
  const identity = { sub: SUBJECT, name: '财务测试员', email: 'finance@example.com', role: 'admin' };
  assert.deepEqual(await (await f.request('/user')).json(), { request: identity, locals: identity });
  assert.deepEqual(await (await f.request('/admin')).json(), identity);
  assert.match(f.cookies.get(SESSION_COOKIE)!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request('/user', { headers: { Cookie: `${SESSION_COOKIE}=${f.cookies.get(SESSION_COOKIE)}; ${SESSION_COOKIE}=${f.cookies.get(SESSION_COOKIE)}` } })).status, 401);
});

test('expired or denied authorization never exchanges a code and only redirects to the configured root', async t => {
  const f = await fixture(t);
  const first = await f.begin();
  f.advance(10 * 60 * 1000 + 1);
  assert.equal((await f.callback(first.authorize)).headers.get('Location'), `${PUBLIC}/?auth_error=expired`);
  const second = await f.begin();
  assert.equal((await f.callback(second.authorize, f.cookies, '&error=access_denied&returnTo=https://evil.example')).headers.get('Location'), `${PUBLIC}/?auth_error=access_denied`);
  assert.equal(f.requests.length, 0);
});

test('default deny ignores team administration; member and site administrator privileges are explicit', async t => {
  const f = await fixture(t, { adminSubjects: [], allowedSubjects: [] });
  f.profile.is_real_team_admin = true;
  const first = await f.begin();
  assert.equal((await f.callback(first.authorize)).headers.get('Location'), `${PUBLIC}/?auth_error=forbidden`);
  assert.equal(f.cookies.has(SESSION_COOKIE), false);
  assert.equal(f.requests.filter(item => item.url.pathname === '/oauth/revoke').length, 1);
  f.config.allowedSubjects = [SUBJECT];
  await f.login();
  assert.equal((await f.request('/user')).status, 200);
  assert.equal((await f.request('/admin')).status, 403);
  f.config.allowedSubjects = [];
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  assert.equal((await f.request('/user')).status, 401);
  f.profile.is_site_admin = true;
  f.config.allowSiteAdmins = true;
  await f.login();
  assert.equal((await f.request('/admin')).status, 200);
  f.config.allowSiteAdmins = false;
  assert.equal((await f.request('/admin')).status, 401);
});

test('OAuth response schemas are validated without reflecting provider credentials or error text', async t => {
  const f = await fixture(t);
  f.mutateToken(value => ({ ...value, expires_in: '3600', access_token: 'PRIVATE_PROVIDER_ERROR' }));
  const first = await f.begin();
  const badToken = await f.callback(first.authorize);
  assert.equal(badToken.headers.get('Location'), `${PUBLIC}/?auth_error=oauth_failed`);
  assert.doesNotMatch(await badToken.text(), /PRIVATE_PROVIDER_ERROR/);
  f.mutateToken(value => value);
  f.profile.sub = '__proto__';
  const second = await f.begin();
  assert.equal((await f.callback(second.authorize)).headers.get('Location'), `${PUBLIC}/?auth_error=oauth_failed`);
  assert.equal((await f.request('/user')).status, 401);
  f.profile.sub = SUBJECT; f.profile.is_site_admin = 'true';
  const third = await f.begin();
  assert.equal((await f.callback(third.authorize)).headers.get('Location'), `${PUBLIC}/?auth_error=oauth_failed`);
});

test('grants and sessions survive restart only in authenticated encrypted storage with private file modes', async t => {
  const f = await fixture(t);
  await f.login();
  const encrypted = await readFile(path.join(f.directory, 'auth/grants.enc'), 'utf8');
  assert.doesNotMatch(encrypted, /wno-|finance@example|财务测试员/);
  assert.equal((await stat(path.join(f.directory, 'auth/key'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.directory, 'auth/grants.enc'))).mode & 0o777, 0o600);
  await f.restart();
  assert.equal((await f.request('/user')).status, 200);
  assert.equal(await f.auth.tokenForSubject(SUBJECT), 'wno-access-1');
  f.config.clientId = '';
  await f.restart();
  assert.deepEqual(await (await f.request('/api/auth/session')).json(), { enabled: true, configured: false, user: null });
});

test('tampered encrypted state fails closed instead of silently creating a fresh store', async t => {
  const f = await fixture(t);
  await f.login();
  const filename = path.join(f.directory, 'auth/grants.enc');
  const envelope = JSON.parse(await readFile(filename, 'utf8'));
  envelope.tag = Buffer.alloc(16).toString('base64');
  await writeFile(filename, JSON.stringify(envelope));
  assert.throws(() => createAuth({ dataDir: f.directory, config: f.config }), /encrypted state is invalid/);
});

test('concurrent refresh is single-flight, rotates persistently, and never replays an old refresh token', async t => {
  const f = await fixture(t);
  await f.login();
  f.advance(3600 * 1000);
  const held = f.holdRefresh();
  const requests = Array.from({ length: 12 }, () => f.auth.tokenForSubject(SUBJECT));
  await held.arrived;
  held.release();
  assert.deepEqual(await Promise.all(requests), Array(12).fill('wno-access-2'));
  assert.equal(f.requests.filter(item => item.form.get('grant_type') === 'refresh_token').length, 1);
  await f.restart();
  f.advance(3600 * 1000);
  assert.equal(await f.auth.tokenForSubject(SUBJECT), 'wno-access-3');
  assert.deepEqual(f.requests.filter(item => item.form.get('grant_type') === 'refresh_token').map(item => item.form.get('refresh_token')), ['wno-rt-refresh-1', 'wno-rt-refresh-2']);
});

test('invalid refresh and an unverified rotated response invalidate the grant instead of replaying it', async t => {
  const f = await fixture(t);
  await f.login();
  f.advance(3600 * 1000);
  f.rejectRefresh();
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  const count = f.requests.length;
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  assert.equal(f.requests.length, count);
  assert.equal((await f.request('/user')).status, 401);
  await f.restart();
  assert.equal((await f.request('/user')).status, 401);
});

test('malformed refresh success cannot replay a refresh token the provider may have consumed', async t => {
  const f = await fixture(t);
  await f.login();
  f.advance(3600 * 1000);
  f.mutateToken(value => ({ ...value, expires_in: null }));
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /oauth_failed/);
  const count = f.requests.length;
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  assert.equal(f.requests.length, count);
});

test('refresh revalidates subject identity and cannot switch to a different allowed user', async t => {
  const f = await fixture(t, { adminSubjects: [SUBJECT, OTHER] });
  await f.login();
  f.advance(3600 * 1000);
  f.profile.sub = OTHER;
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  assert.equal((await f.request('/user')).status, 401);
  assert.ok(f.requests.some(item => item.url.pathname === '/oauth/revoke' && item.form.get('token') === 'wno-rt-refresh-2'));
});

test('logout requires the same origin, removes local access despite revoke failure, and persists that removal', async t => {
  const f = await fixture(t);
  await f.login();
  const saved = new Map(f.cookies);
  assert.equal((await f.request('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/user')).status, 200);
  f.rejectRevoke();
  const response = await f.request('/api/auth/logout', { method: 'POST', headers: { Origin: PUBLIC } });
  assert.deepEqual(await response.json(), { ok: true, revoked: false });
  assert.equal((await f.request('/user', {}, saved)).status, 401);
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  await f.restart();
  assert.equal((await f.request('/user', {}, saved)).status, 401);
});

test('logout racing a refresh cannot resurrect sessions or rotated grants', async t => {
  const f = await fixture(t);
  await f.login();
  f.advance(3600 * 1000);
  const held = f.holdRefresh();
  const token = f.auth.tokenForSubject(SUBJECT);
  const rejected = assert.rejects(token, /unauthorized/);
  await held.arrived;
  const logout = f.request('/api/auth/logout', { method: 'POST', headers: { Origin: PUBLIC } });
  await f.logoutStarted;
  held.release();
  await rejected;
  assert.equal((await logout).status, 200);
  await assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  assert.ok(f.requests.some(item => item.url.pathname === '/oauth/revoke' && item.form.get('token') === 'wno-rt-refresh-2'));
  await f.restart();
  assert.equal((await f.request('/user')).status, 401);
});

test('logout reports a failed revoke of the concurrently rotated token', async t => {
  const f = await fixture(t);
  await f.login();
  f.advance(3600 * 1000);
  const held = f.holdRefresh();
  const rejected = assert.rejects(f.auth.tokenForSubject(SUBJECT), /unauthorized/);
  await held.arrived;
  f.rejectRevoke();
  const logout = f.request('/api/auth/logout', { method: 'POST', headers: { Origin: PUBLIC } });
  await f.logoutStarted;
  held.release();
  await rejected;
  assert.deepEqual(await (await logout).json(), { ok: true, revoked: false });
  assert.equal((await f.request('/user')).status, 401);
});
