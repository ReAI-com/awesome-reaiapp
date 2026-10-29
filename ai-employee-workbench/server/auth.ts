import type { Express, Request, RequestHandler, Response } from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AuthConfig {
  publicOrigin: string;
  clientId: string;
  apiBaseUrl?: string;
  adminSubjects?: string[];
  allowedSubjects?: string[];
  allowSiteAdmins?: boolean;
  development?: boolean;
}

export interface AuthIdentity { sub: string; name: string; email: string | null; role: 'admin' | 'member' }
declare global { namespace Express { interface Request { identity?: AuthIdentity } } }

interface Grant {
  id: string;
  identity: AuthIdentity;
  siteAdmin: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
interface Session { subject: string; grantId: string; expiresAt: number }
interface PendingLogin { verifier: string; browserHash: string; expiresAt: number }
interface Vault { version: 1; grants: Record<string, Grant>; sessions: Record<string, Session> }
type Fetch = typeof globalThis.fetch;
type ErrorCode = 'not_configured' | 'invalid_state' | 'expired' | 'forbidden' | 'unauthorized' | 'access_denied' | 'oauth_failed';

const SESSION_COOKIE = '__Host-maoding-session';
const LOGIN_COOKIE = '__Host-maoding-oauth';
const SESSION_TTL = 24 * 60 * 60 * 1000;
const LOGIN_TTL = 10 * 60 * 1000;
const SCOPES = ['profile:read', 'model-gateway:invoke'];
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const safeString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const validSubject = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const validOpaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const equal = (a: string, b: string) => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };

class AuthFailure extends Error {
  remoteRevocationFailed = false;
  constructor(readonly code: ErrorCode, readonly status = 401) { super(code); }
}

function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('OAuth requires an HTTPS origin without a path');
  return url.origin;
}

function cookie(req: Request, name: string): string | undefined {
  const matches = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0].slice(name.length + 1);
  return validOpaque(value) ? value : undefined;
}

function setCookie(res: Response, name: string, value: string, ttl: number) {
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`);
}

function tokenData(value: unknown): { accessToken: string; refreshToken: string; expiresAt: number } {
  if (!record(value) || value.token_type !== 'Bearer'
    || !safeString(value.access_token, 16_384) || !/^wno-(?!rt-)[A-Za-z0-9._~-]+$/.test(value.access_token)
    || !safeString(value.refresh_token, 16_384) || !/^wno-rt-[A-Za-z0-9._~-]+$/.test(value.refresh_token)
    || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) <= 0 || Number(value.expires_in) > 366 * 86400
    || typeof value.scope !== 'string' || !SCOPES.every(scope => (value.scope as string).split(/\s+/).includes(scope))) throw new AuthFailure('oauth_failed', 502);
  return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + Number(value.expires_in) * 1000 };
}

function validVault(value: unknown): value is Vault {
  if (!record(value) || value.version !== 1 || !record(value.grants) || !record(value.sessions)) return false;
  for (const [sub, grant] of Object.entries(value.grants)) {
    if (!validSubject(sub) || !record(grant) || !validOpaque(grant.id) || !record(grant.identity)
      || grant.identity.sub !== sub || !safeString(grant.identity.name, 256)
      || !(grant.identity.email === null || safeString(grant.identity.email, 320))
      || !['admin', 'member'].includes(String(grant.identity.role)) || typeof grant.siteAdmin !== 'boolean'
      || !safeString(grant.accessToken, 16_384) || !safeString(grant.refreshToken, 16_384) || !finiteTime(grant.expiresAt)) return false;
  }
  return Object.entries(value.sessions).every(([key, session]) => /^[a-f0-9]{64}$/.test(key) && record(session)
    && validSubject(session.subject) && validOpaque(session.grantId) && finiteTime(session.expiresAt));
}

/** Single-process BFF: browser cookies contain opaque handles; OAuth grants never leave this module. */
export function createAuth(options: { dataDir: string; config: AuthConfig; fetch?: Fetch }) {
  const config = options.config;
  const publicOrigin = origin(config.publicOrigin);
  const apiBase = origin(config.apiBaseUrl || 'https://block2-api.wainao.chat');
  const configured = () => typeof config.clientId === 'string' && /^[A-Za-z0-9._~-]{8,128}$/.test(config.clientId);
  const request = options.fetch || globalThis.fetch;
  const directory = path.join(path.resolve(options.dataDir), 'auth');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const keyPath = path.join(directory, 'key');
  const vaultPath = path.join(directory, 'grants.enc');
  if (!existsSync(keyPath)) {
    // A missing key must not silently replace the key for an existing vault.
    if (existsSync(vaultPath)) throw new Error('OAuth encryption key is missing');
    try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  chmodSync(keyPath, 0o600);
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('OAuth encryption key is invalid');
  const aad = Buffer.from(`maoding-oauth-v1\n${publicOrigin}\n${apiBase}\n${config.clientId}`);
  let state: Vault = { version: 1, grants: {}, sessions: {} };
  if (existsSync(vaultPath) && configured()) {
    try {
      const envelope: unknown = JSON.parse(readFileSync(vaultPath, 'utf8'));
      if (!record(envelope) || envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
      const decoded: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      if (!validVault(decoded)) throw new Error();
      state = decoded;
      chmodSync(vaultPath, 0o600);
    } catch { throw new Error('OAuth encrypted state is invalid or belongs to another configuration'); }
  }
  let closed = false;
  const pending = new Map<string, PendingLogin>();
  const refreshes = new Map<string, Promise<Grant>>();

  function persist() {
    if (closed) throw new AuthFailure('unauthorized');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    const contents = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
    const temporary = `${vaultPath}.${opaque()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, contents); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, vaultPath);
    } catch {
      // A failed durable write must not leave a successful in-memory login or logout.
      closed = true;
      state = { version: 1, grants: {}, sessions: {} };
      throw new AuthFailure('oauth_failed', 503);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  function role(sub: string, siteAdmin: boolean): AuthIdentity['role'] | null {
    if (!configured() || closed) return null;
    if (config.adminSubjects?.includes(sub) || (config.allowSiteAdmins === true && siteAdmin)) return 'admin';
    return config.allowedSubjects?.includes(sub) ? 'member' : null;
  }

  function discard(sub: string, grantId: string) {
    if (state.grants[sub]?.id !== grantId) return;
    delete state.grants[sub];
    for (const [id, session] of Object.entries(state.sessions)) if (session.subject === sub && session.grantId === grantId) delete state.sessions[id];
    persist();
  }

  async function remote(endpoint: string, init: RequestInit): Promise<unknown> {
    let response: globalThis.Response;
    try { response = await request(`${apiBase}${endpoint}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store' }); }
    catch { throw new AuthFailure('oauth_failed', 503); }
    if (!response.ok) throw new AuthFailure(response.status === 400 || response.status === 401 ? 'unauthorized' : 'oauth_failed', response.status === 400 || response.status === 401 ? 401 : 503);
    try { return await response.json(); } catch { throw new AuthFailure('oauth_failed', 502); }
  }

  async function exchange(parameters: Record<string, string>) {
    return tokenData(await remote('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters) }));
  }

  async function revoke(refreshToken: string): Promise<boolean> {
    try {
      const response = await request(`${apiBase}/oauth/revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId }) });
      return response.ok;
    } catch { return false; }
  }

  async function identify(accessToken: string): Promise<{ identity: AuthIdentity; siteAdmin: boolean }> {
    const value = await remote('/oauth/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!record(value) || !validSubject(value.sub)
      || !(value.email === null || safeString(value.email, 320))
      || (value.display_name !== null && value.display_name !== undefined && !safeString(value.display_name, 256))
      || (value.name !== null && value.name !== undefined && !safeString(value.name, 256))
      || (value.is_site_admin !== undefined && typeof value.is_site_admin !== 'boolean')
      || typeof value.scope !== 'string' || !value.scope.split(/\s+/).includes('profile:read')) throw new AuthFailure('oauth_failed', 502);
    const siteAdmin = value.is_site_admin === true;
    const userRole = role(value.sub, siteAdmin);
    if (!userRole) throw new AuthFailure('forbidden', 403);
    return { identity: { sub: value.sub, name: String(value.display_name || value.name || '外脑用户'), email: value.email as string | null, role: userRole }, siteAdmin };
  }

  async function fresh(sub: string): Promise<Grant> {
    const grant = Object.hasOwn(state.grants, sub) ? state.grants[sub] : undefined;
    if (!grant || !role(sub, grant.siteAdmin)) throw new AuthFailure('unauthorized');
    if (grant.expiresAt > Date.now() + 30_000) return grant;
    const existing = refreshes.get(sub);
    if (existing) return existing;
    const work = (async () => {
      let tokens: Awaited<ReturnType<typeof exchange>> | undefined;
      try {
        tokens = await exchange({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: config.clientId });
        const identified = await identify(tokens.accessToken);
        if (identified.identity.sub !== sub) throw new AuthFailure('unauthorized');
        if (closed || state.grants[sub]?.id !== grant.id) throw new AuthFailure('unauthorized');
        const replacement: Grant = { ...grant, ...tokens, ...identified };
        state.grants[sub] = replacement; persist();
        return replacement;
      } catch (error) {
        const issue = error instanceof AuthFailure ? error : new AuthFailure('oauth_failed', 503);
        if (tokens && !await revoke(tokens.refreshToken)) issue.remoteRevocationFailed = true;
        // Even a timeout/malformed response may follow successful upstream rotation: never replay it.
        if (!closed) discard(sub, grant.id);
        throw issue;
      }
    })();
    refreshes.set(sub, work);
    try { return await work; } finally { if (refreshes.get(sub) === work) refreshes.delete(sub); }
  }

  async function session(req: Request): Promise<AuthIdentity | null> {
    delete req.identity;
    if (!configured() || closed) return null;
    const raw = cookie(req, SESSION_COOKIE);
    const entry = raw ? state.sessions[hash(raw)] : undefined;
    if (!entry || entry.expiresAt <= Date.now()) return null;
    const grant = state.grants[entry.subject];
    if (!grant || grant.id !== entry.grantId || !role(entry.subject, grant.siteAdmin)) return null;
    try {
      const latest = await fresh(entry.subject);
      // A logout may have removed this session while token refresh awaited the provider.
      if (!state.sessions[hash(raw!)] || latest.id !== entry.grantId) return null;
      const userRole = role(entry.subject, latest.siteAdmin);
      if (!userRole) return null;
      return req.identity = { ...latest.identity, role: userRole };
    } catch (error) { if (error instanceof AuthFailure && ['unauthorized', 'forbidden'].includes(error.code)) return null; throw error; }
  }

  function failure(res: Response, error: unknown) {
    const issue = error instanceof AuthFailure ? error : new AuthFailure('oauth_failed', 503);
    res.status(issue.status).json({ error: issue.code });
  }

  const requireUser: RequestHandler = async (req, res, next) => {
    try {
      if (!configured()) throw new AuthFailure('not_configured', 503);
      const identity = await session(req);
      if (!identity) throw new AuthFailure('unauthorized');
      res.locals.identity = identity; next();
    } catch (error) { failure(res, error); }
  };
  const requireAdmin: RequestHandler = async (req, res, next) => {
    try {
      if (!configured()) throw new AuthFailure('not_configured', 503);
      const identity = await session(req);
      if (!identity) throw new AuthFailure('unauthorized');
      res.locals.identity = identity;
      if (identity.role !== 'admin') throw new AuthFailure('forbidden', 403);
      next();
    } catch (error) { failure(res, error); }
  };

  function register(app: Express): void {
    app.use('/api/auth', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
    app.get('/api/auth/session', async (req, res) => {
      try { res.json({ enabled: true, configured: configured(), ...(config.development ? { development: true } : {}), user: await session(req) }); }
      catch (error) { failure(res, error); }
    });
    app.get('/api/auth/login', (_req, res) => {
      if (!configured() || closed) return failure(res, new AuthFailure('not_configured', 503));
      for (const [id, login] of pending) if (login.expiresAt <= Date.now()) pending.delete(id);
      if (pending.size >= 1000) return failure(res, new AuthFailure('oauth_failed', 429));
      const stateToken = opaque(), browser = opaque(), verifier = opaque();
      pending.set(hash(stateToken), { browserHash: hash(browser), verifier, expiresAt: Date.now() + LOGIN_TTL });
      const url = new URL('/oauth/authorize', apiBase);
      url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: `${publicOrigin}/api/auth/callback`, scope: SCOPES.join(' '), state: stateToken, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(config.development ? { development: '1' } : {}) }).toString();
      setCookie(res, LOGIN_COOKIE, browser, LOGIN_TTL); res.redirect(302, url.href);
    });
    app.get('/api/auth/callback', async (req, res) => {
      let tokens: Awaited<ReturnType<typeof exchange>> | undefined;
      try {
        if (!configured() || closed) throw new AuthFailure('not_configured', 503);
        const stateToken = req.query.state;
        const browser = cookie(req, LOGIN_COOKIE);
        const login = validOpaque(stateToken) ? pending.get(hash(stateToken)) : undefined;
        if (!login || !browser || !equal(login.browserHash, hash(browser))) throw new AuthFailure('invalid_state', 400);
        pending.delete(hash(stateToken as string));
        setCookie(res, LOGIN_COOKIE, '', 0);
        if (login.expiresAt <= Date.now()) throw new AuthFailure('expired', 400);
        if (req.query.error !== undefined) throw new AuthFailure(req.query.error === 'access_denied' ? 'access_denied' : 'oauth_failed', 400);
        if (!safeString(req.query.code, 4096)) throw new AuthFailure('oauth_failed', 400);
        tokens = await exchange({ grant_type: 'authorization_code', code: req.query.code, client_id: config.clientId, redirect_uri: `${publicOrigin}/api/auth/callback`, code_verifier: login.verifier });
        const identified = await identify(tokens.accessToken);
        if (closed) throw new AuthFailure('unauthorized');
        const sub = identified.identity.sub, grantId = opaque(), rawSession = opaque();
        // A fresh login supersedes the old grant; its sessions cannot accidentally use the new credentials.
        for (const [id, entry] of Object.entries(state.sessions)) if (entry.subject === sub || entry.expiresAt <= Date.now()) delete state.sessions[id];
        state.grants[sub] = { id: grantId, ...tokens, ...identified };
        state.sessions[hash(rawSession)] = { subject: sub, grantId, expiresAt: Date.now() + SESSION_TTL };
        persist();
        setCookie(res, SESSION_COOKIE, rawSession, SESSION_TTL); res.redirect(302, `${publicOrigin}/`);
      } catch (error) {
        if (tokens) await revoke(tokens.refreshToken);
        const code = error instanceof AuthFailure ? error.code : 'oauth_failed';
        res.redirect(302, `${publicOrigin}/?auth_error=${code}`);
      }
    });
    app.post('/api/auth/logout', async (req, res) => {
      // Defense in depth when this router is mounted outside the workbench's CSRF middleware.
      if (req.headers.origin !== publicOrigin) return failure(res, new AuthFailure('forbidden', 403));
      const raw = cookie(req, SESSION_COOKIE), entry = raw ? state.sessions[hash(raw)] : undefined;
      const grant = entry ? state.grants[entry.subject] : undefined;
      setCookie(res, SESSION_COOKIE, '', 0); setCookie(res, LOGIN_COOKIE, '', 0);
      try {
        if (entry && grant?.id === entry.grantId) {
          discard(entry.subject, grant.id);
          const inFlight = refreshes.get(entry.subject);
          let rotationRevoked = true;
          if (inFlight) await inFlight.catch(error => { rotationRevoked = !(error instanceof AuthFailure && error.remoteRevocationFailed); });
          const revoked = await revoke(grant.refreshToken) && rotationRevoked;
          return res.json({ ok: true, revoked });
        }
        res.json({ ok: true, revoked: true });
      } catch (error) { failure(res, error); }
    });
  }

  return {
    register, requireUser, requireAdmin, session,
    async tokenForSubject(sub: string): Promise<string> {
      if (!configured()) throw new AuthFailure('not_configured', 503);
      const grant = await fresh(sub);
      if (!role(sub, grant.siteAdmin) || state.grants[sub]?.id !== grant.id) throw new AuthFailure('unauthorized');
      return grant.accessToken;
    },
    close(): void { closed = true; pending.clear(); key.fill(0); },
  };
}
