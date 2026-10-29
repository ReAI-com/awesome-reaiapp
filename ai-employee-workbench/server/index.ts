import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { createApp } from './api.ts';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 4317);
const publicOrigin = process.env.EMPLOYEE_PUBLIC_ORIGIN;
const subjects = (value?: string) => value?.split(',').map(item => item.trim()).filter(Boolean) || [];
const host = process.env.EMPLOYEE_HOST || '127.0.0.1';
if (!publicOrigin && host !== '127.0.0.1' && host !== '::1') throw new Error('非本机监听必须配置 HTTPS 来源与 OAuth');
const runtime = createApp({ dataDir: process.env.EMPLOYEE_DATA_DIR || path.join(project, '.data'), ...(publicOrigin ? { auth: {
  publicOrigin, clientId: process.env.WAINAO_OAUTH_CLIENT_ID || '', apiBaseUrl: process.env.WAINAO_API_BASE_URL,
  adminSubjects: subjects(process.env.WAINAO_ADMIN_SUBJECTS), allowedSubjects: subjects(process.env.WAINAO_ALLOWED_SUBJECTS),
  allowSiteAdmins: process.env.WAINAO_ALLOW_SITE_ADMINS === 'true', development: process.env.WAINAO_OAUTH_DEVELOPMENT === 'true',
} } : {}) });
const server = createServer(runtime.app);
let closeVite: (() => Promise<void>) | undefined;
if (process.argv.includes('--production')) {
  runtime.app.use(express.static(path.join(project, 'dist')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(path.join(project, 'dist', 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ root: project, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  runtime.app.use(vite.middlewares); closeVite = () => vite.close();
}
server.listen(port, host, () => console.log(`铆钉 · ${publicOrigin || `http://127.0.0.1:${port}`}`));
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
// Periodic scans detect new/updated source files. Scans never modify the user's source files.
const timer = setInterval(() => { for (const workspace of runtime.store.listWorkspaces()) runtime.scan(workspace.id).catch(() => {}); }, 15000);
timer.unref();
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; clearInterval(timer); server.close(); await closeVite?.(); await runtime.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
