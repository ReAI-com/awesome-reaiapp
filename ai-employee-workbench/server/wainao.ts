import type { AgentConfig } from '../shared/types.ts';
import { failure } from './sources.ts';

export const WAINAO_API_BASE = 'https://block2-api.wainao.chat';
type Credentials = { tokenForSubject(sub: string): Promise<string> };
export function gatewayBase(apiBase = WAINAO_API_BASE) {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure('外脑 API 地址必须是 HTTPS 来源');
  return `${url.origin}/api/model-gateway/v1`;
}
export async function wainaoModels(auth: Credentials, sub: string, apiBase?: string, request = fetch) {
  const token = await auth.tokenForSubject(sub);
  const response = await request(`${gatewayBase(apiBase)}/models?task=all`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw failure(response.status === 403 ? '外脑授权缺少模型网关权限，请重新登录授权' : '外脑模型目录暂时不可用', 502);
  const catalog = await response.json() as { data?: unknown[] };
  if (!Array.isArray(catalog.data)) throw failure('外脑模型目录格式无效', 502);
  return { data: catalog.data.flatMap((raw: any) => {
    if (typeof raw?.id !== 'string' || !Array.isArray(raw.operations) || !raw.operations.some((op: any) => op?.id === 'chat' && op.availability?.available === true)) return [];
    return [{ id: raw.id, name: typeof raw.name === 'string' ? raw.name : raw.id }];
  }) };
}
/** Resolve only at invocation; OAuth tokens never enter Agent settings or routing snapshots. */
export async function resolveWainaoConfig(config: AgentConfig, auth?: Credentials, apiBase?: string): Promise<AgentConfig> {
  if (config.provider !== 'wainao') return config;
  if (!auth || !config.oauthSubject) throw failure('请先登录外脑，并为当前岗位连接模型');
  return { ...config, baseUrl: gatewayBase(apiBase), protocol: 'openai-completions', apiKey: await auth.tokenForSubject(config.oauthSubject) };
}
