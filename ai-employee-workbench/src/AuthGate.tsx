import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CircleAlert, LockKeyhole, ShieldCheck } from 'lucide-react';
import { request, RequestError } from './api';
import { Spinner } from './components';

export interface AuthSession {
  enabled: boolean;
  configured: boolean;
  development?: boolean;
  user: { sub: string; name: string | null; email: string | null; role: 'admin' | 'member' } | null;
}

export async function readAuthSession(hostname: string): Promise<AuthSession> {
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  try {
    const result = await request<AuthSession>('/api/auth/session');
    if (!result || typeof result.enabled !== 'boolean' || typeof result.configured !== 'boolean' ||
      (!local && !result.enabled) || (result.user !== null && (!result.user || typeof result.user.sub !== 'string' ||
        !['admin', 'member'].includes(result.user.role)))) throw new Error('登录服务返回了无效状态');
    return result;
  }
  catch (error) {
    // Allow the pre-OAuth local service while its already-running backend is in use.
    if (local && error instanceof RequestError && error.status === 404) {
      return { enabled: false, configured: false, user: null };
    }
    throw error;
  }
}

const errors: Record<string, string> = {
  access_denied: '你取消了授权，或当前账号没有铆钉的访问权限。',
  forbidden: '当前外脑账号没有铆钉的访问权限，请联系管理员。',
  unauthorized: '当前外脑账号没有铆钉的访问权限，请联系管理员。',
  invalid_state: '登录请求已过期或无法验证，请重新登录。',
  expired: '登录请求已过期，请重新登录。',
  oauth_failed: '暂时无法完成外脑登录，请重试。',
  not_configured: '登录服务正在配置中，请稍后再试。',
};

export function AuthGate({ children }: { children: (session: AuthSession, logout: () => Promise<void>) => ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [error, setError] = useState('');
  const [logoutNotice, setLogoutNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [callbackError] = useState(() => {
    const query = new URLSearchParams(location.search);
    const code = query.get('auth_error');
    if (!code) return '';
    query.delete('auth_error');
    const suffix = query.toString();
    history.replaceState(null, '', `${location.pathname}${suffix ? `?${suffix}` : ''}${location.hash}`);
    return errors[code] || '暂时无法完成登录，请重试或联系管理员。';
  });
  const load = useCallback(async () => {
    try {
      setSession(await readAuthSession(location.hostname));
      setError('');
    } catch {
      setSession(null);
      setError('无法连接登录服务，请检查连接后重试。');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const expire = () => { setSession(current => current?.enabled ? { ...current, user: null } : current); void load(); };
    window.addEventListener('workbench:unauthorized', expire);
    return () => window.removeEventListener('workbench:unauthorized', expire);
  }, [load]);
  async function logout() {
    const result = await request<{ ok: boolean; revoked: boolean }>('/api/auth/logout', { method: 'POST' });
    setLogoutNotice(result.revoked === false ? '你已退出铆钉。外脑端的授权撤销暂未确认，可前往外脑管理已授权应用。' : '');
    setSession(current => current ? { ...current, user: null } : null);
    await load();
  }
  if (session && (!session.enabled || session.user)) return children(session, logout);
  return <main className="auth-page">
    <div className="auth-wordmark"><span className="brand-logo" aria-hidden="true"><i /><i /><i /></span><b>铆钉</b><span>AI 员工工作台</span></div>
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="auth-lock"><LockKeyhole size={25} /></span>
      <p className="eyebrow">YOUR WORK, CONNECTED</p>
      <h1 id="auth-title">让每一步工作，<br /><span>都有可靠的依据。</span></h1>
      <p className="auth-intro">登录后进入你的岗位工作区，继续整理资料、核验账目，与岗位专家协作。</p>
      {(error || callbackError) && <div className="auth-error" role="alert"><CircleAlert size={17} /><span>{error || callbackError}</span></div>}
      {logoutNotice && <p className="auth-intro" role="status">{logoutNotice}</p>}
      {loading ? <p className="auth-loading" role="status"><Spinner />正在连接登录服务…</p>
        : error ? <button className="button primary large auth-action" onClick={() => { setLoading(true); void load(); }}>重新连接<ArrowRight size={17} /></button>
          : session?.configured ? <a className="button primary large auth-action" href="/api/auth/login">使用外脑登录<ArrowRight size={17} /></a>
            : <div className="auth-pending" role="status"><b>登录服务配置中</b><p>工作台暂未开放，请等待管理员完成外脑应用接入。</p></div>}
      {session?.development && <p className="auth-development">当前为开发验证模式，仅有此应用开发资格的账号可授权登录。</p>}
      <p className="auth-trust"><ShieldCheck size={16} />身份由外脑验证，工作区权限由铆钉管理员分配。</p>
    </section>
    <div className="auth-footnote">铆钉 · AI 员工工作台 3.0</div>
  </main>;
}
