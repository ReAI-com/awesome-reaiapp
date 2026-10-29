import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { Store } from './store.ts';
import { Sources, MAX_FILE_SIZE, failure } from './sources.ts';
import { Pipeline } from './pipeline.ts';
import { boardVersion, publicBoard } from './boards.ts';
import { AutoCleaner } from './auto-cleaner.ts';
import { registerFinanceApi } from './finance-api.ts';
import { createAuth, type AuthConfig } from './auth.ts';
import { gatewayBase, resolveWainaoConfig, wainaoModels } from './wainao.ts';
import type { AgentConfig, AgentId, AgentRun, Board, CleaningSpec, DataRecord, Dataset, Deliverable, JsonSchema, SourceFile } from '../shared/types.ts';

const now = () => new Date().toISOString();
const text = (value: unknown, name: string, max = 20000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw failure(`${name}不能为空，且不能超过 ${max} 字符`); return value.trim(); };
const safeJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
const safeHtml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const equalToken = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

export function createApp(options: { dataDir: string; auth?: AuthConfig; authFetch?: typeof fetch }) {
  const dataDir = path.resolve(options.dataDir);
  const publicOrigin = options.auth?.publicOrigin;
  const auth = options.auth ? createAuth({ dataDir, config: options.auth, fetch: options.authFetch }) : undefined;
  const managementOrigin = (req: Request) => publicOrigin || `http://${req.headers.host}`;
  const store = new Store(dataDir); const sources = new Sources(store);
  const pipeline = new Pipeline(store, sources, dataDir, undefined, config => resolveWainaoConfig(config, auth, options.auth?.apiBaseUrl));
  const autoCleaner = new AutoCleaner(store, pipeline);
  const scan = async (workspaceId: string) => { const result = await sources.scan(workspaceId); return { ...result, autoQueued: autoCleaner.enqueue(workspaceId) }; };
  const app = express(); app.disable('x-powered-by'); app.enable('case sensitive routing'); app.enable('strict routing');
  const reflows = new Map<string, Promise<{ file: SourceFile; run?: AgentRun }>>();
  app.use((req, res, next) => {
    const host = req.hostname;
    if (publicOrigin ? req.headers.host !== new URL(publicOrigin).host : host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return res.status(403).json({ error: '请求主机不被允许' });
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    // The trusted parent constrains navigation of generated sandboxed frames.
    res.setHeader('Content-Security-Policy', "frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'maoding' }));
  // Board REST requests use a scoped capability, never the workspace administration API.
  app.use('/board-api/:boardId', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type'); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const boardId = (req.params as Record<string, string>).boardId;
    const board = store.listWorkspaces().flatMap(w => store.list<Board>('boards', w.id)).find(b => b.id === boardId);
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    if (!board || !equalToken(board.token, token)) return res.status(403).json({ error: '看板访问凭据无效' });
    res.locals.board = board; next();
  });
  app.get('/board-api/:boardId/schema', (_req, res) => {
    const board: Board = res.locals.board;
    res.json(store.list<Dataset>('datasets', board.workspaceId).filter(d => board.datasetIds.includes(d.id)));
  });
  app.get('/board-api/:boardId/version', (_req, res) => {
    const board: Board = res.locals.board;
    res.json({ version: boardVersion(board), updatedAt: board.updatedAt || board.createdAt });
  });
  app.get('/board-api/:boardId/records', (req, res) => {
    const board: Board = res.locals.board; const datasetId = String(req.query.datasetId || '');
    if (!board.datasetIds.includes(datasetId)) throw failure('该看板未绑定此数据表', 403);
    const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0)); const limit = Math.min(500, Math.max(1, Math.trunc(Number(req.query.limit) || 100)));
    const records = store.list<DataRecord>('records', board.workspaceId).filter(r => r.datasetId === datasetId);
    res.json({ records: records.slice(offset, offset + limit), total: records.length, offset, limit });
  });
  app.post('/board-api/:boardId/records', (req, res) => {
    const board: Board = res.locals.board;
    if (board.status !== 'published') throw failure('预览中的看板不可修改数据，请先确认添加', 403);
    if (!board.datasetIds.includes(req.body.datasetId)) throw failure('该看板未绑定此数据表', 403);
    res.status(201).json(store.createRecord(board.workspaceId, req.body.datasetId, req.body.data));
  });
  app.post('/board-api/:boardId/records/:recordId', (req, res) => {
    const board: Board = res.locals.board;
    if (board.status !== 'published') throw failure('预览中的看板不可修改数据，请先确认添加', 403);
    const record = store.require<DataRecord>('records', String(req.params.recordId), board.workspaceId);
    if (!board.datasetIds.includes(record.datasetId)) throw failure('该看板未绑定此数据表', 403);
    res.json(store.reviseRecord(board.workspaceId, record.id, req.body.version, req.body.data));
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    if (origin && origin !== managementOrigin(req)) return res.status(403).json({ error: '不允许跨来源访问工作区管理接口' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-workbench-request'] !== '1') return res.status(403).json({ error: '缺少本地工作台请求标记' });
    next();
  });
  if (auth) {
    auth.register(app);
    app.use('/api', auth.requireUser);
    app.get('/api/auth/models', auth.requireAdmin, async (_req, res) => res.json(await wainaoModels(auth, res.locals.identity.sub, options.auth?.apiBaseUrl, options.authFetch)));
    app.use('/api', (req, res, next) => {
      const adminRoute = /^\/workspaces\/[^/]+\/runs\/[^/]+\/review$/.test(req.path)
        || req.path === '/workspaces' && req.method === 'POST'
        || /^\/workspaces\/[^/]+\/(agents|specs)(\/|$)/.test(req.path)
        || /^\/workspaces\/[^/]+\/(automation|scan|datasets)(\/|$)/.test(req.path)
        || req.method !== 'GET' && /^\/workspaces\/[^/]+\/(records|finance)(\/|$)/.test(req.path);
      return adminRoute ? auth.requireAdmin(req, res, next) : next();
    });
    app.post('/api/workspaces/:wid/agents/wainao', async (req, res) => {
      const wid = String(req.params.wid); store.getWorkspace(wid);
      const model = text(req.body.model, '模型', 200);
      const catalog = await wainaoModels(auth, res.locals.identity.sub, options.auth?.apiBaseUrl, options.authFetch);
      if (!catalog.data.some(item => item.id === model)) throw failure('该模型当前不可用于文本对话');
      for (const agent of store.list<AgentConfig>('agents', wid)) store.put('agents', { ...agent, version: agent.version + 1, provider: 'wainao', model, protocol: 'openai-completions', baseUrl: gatewayBase(options.auth?.apiBaseUrl), apiKey: undefined, oauthSubject: res.locals.identity.sub, parameters: { maxTokens: agent.agentId === 'agent-002' ? 16384 : 8192, thinkingLevel: 'off' } });
      res.json({ connected: true, model });
    });
  } else app.get('/api/auth/session', (_req, res) => res.json({ enabled: false, configured: false, user: null }));
  app.get('/api/bootstrap', (_req, res) => res.json({ version: '3.0.0', workspaces: store.listWorkspaces(), runtime: { harness: 'pi', version: '1.4.0' } }));
  app.post('/api/workspaces', (req, res) => {
    const name = text(req.body.name, '工作区名称', 100); const role = text(req.body.role, '岗位描述', 3000);
    const directory = req.body.directory?.trim();
    if (publicOrigin && directory) throw failure('线上工作区使用服务器内的独立目录，请直接上传文件');
    if (directory && (!path.isAbsolute(directory) || directory === path.parse(directory).root)) throw failure('请选择具体的本地绝对目录');
    res.status(201).json({ workspace: store.createWorkspace({ name, role, directory: directory || undefined }) });
  });
  app.get('/api/workspaces/:wid/state', (req, res) => {
    const state = store.state(String(req.params.wid));
    if (auth && res.locals.identity.role !== 'admin') { state.agents = []; state.specs = []; }
    res.json(state);
  });
  app.post('/api/workspaces/:wid/scan', async (req, res) => res.json(await scan(String(req.params.wid))));
  app.post('/api/workspaces/:wid/automation', (req, res) => {
    if (typeof req.body.autoClean !== 'boolean') throw failure('autoClean 必须是布尔值');
    const wid = String(req.params.wid); const workspace = store.updateWorkspace(wid, { autoClean: req.body.autoClean });
    res.json({ workspace, autoQueued: autoCleaner.enqueue(wid) });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE, files: 20 } });
  app.post('/api/workspaces/:wid/uploads', upload.array('files', 20), async (req, res) => {
    const files = req.files as Express.Multer.File[]; if (!files?.length) throw failure('请选择上传文件');
    const imported: SourceFile[] = [];
    for (const file of files) imported.push(await sources.upload(String(req.params.wid), Buffer.from(file.originalname, 'latin1').toString('utf8'), file.buffer));
    res.status(201).json({ files: imported, autoQueued: autoCleaner.enqueue(String(req.params.wid)) });
  });
  app.get('/api/workspaces/:wid/files/:fid/history', (req, res) => {
    const wid = String(req.params.wid), fid = String(req.params.fid); store.require('files', fid, wid);
    res.json({ events: store.list<{ fileId: string }>('fileEvents', wid).filter(e => e.fileId === fid), revisions: store.list<{ fileId: string; path: string }>('revisions', wid).filter(r => r.fileId === fid).map(({ path: _path, ...revision }) => revision) });
  });
  app.post('/api/workspaces/:wid/files/:fid/clean', (req, res) => res.status(202).json({ run: pipeline.clean(String(req.params.wid), String(req.params.fid)) }));
  app.post('/api/workspaces/:wid/runs/:rid/cancel', (req, res) => res.json({ run: pipeline.cancel(String(req.params.wid), String(req.params.rid)) }));
  app.post('/api/workspaces/:wid/runs/:rid/review', (req, res) => res.json(pipeline.review(String(req.params.wid), String(req.params.rid), req.body.records, req.body.replaceManual === true)));
  const ajv = new Ajv({ strict: false });
  const specBody = (body: Record<string, unknown>) => {
    const schema = body.schema as JsonSchema | undefined;
    if (schema) { if (schema.type !== 'object' || !schema.properties || !Object.keys(schema.properties).length) throw failure('Schema 必须是包含字段的 object'); try { ajv.compile(schema); } catch { throw failure('Schema 定义无效'); } }
    return { name: text(body.name, '规范名称', 100), description: String(body.description || '').slice(0, 2000), match: String(body.match || '*').slice(0, 2000), prompt: text(body.prompt, '清洗提示词'), ...(schema ? { schema } : {}) };
  };
  app.post('/api/workspaces/:wid/specs', (req, res) => res.status(201).json(store.put('specs', { id: randomUUID(), workspaceId: String(req.params.wid), ...specBody(req.body), version: 1, createdAt: now() })));
  app.put('/api/workspaces/:wid/specs/:sid', (req, res) => {
    const wid = String(req.params.wid); const old = store.require<CleaningSpec>('specs', String(req.params.sid), wid);
    if (req.body.version !== old.version) throw failure('规范已被更新，请刷新后再保存', 409);
    const next = { id: old.id, workspaceId: wid, ...specBody(req.body), version: old.version + 1, createdAt: old.createdAt };
    store.put('specVersions', { ...old, id: `${old.id}:v${old.version}`, specId: old.id });
    store.put('specVersions', { ...next, id: `${next.id}:v${next.version}`, specId: next.id });
    store.put('specs', next);
    // Any routing rule change may change the selected spec; conservatively mark all completed inputs stale.
    for (const file of store.list<SourceFile>('files', wid)) if (file.cleanedRevisionId) sources.setState({ ...file, generation: file.generation + 1 }, '有更新');
    res.json(next);
  });
  app.put('/api/workspaces/:wid/agents/:aid', (req, res) => {
    const wid = String(req.params.wid), aid = String(req.params.aid) as AgentId;
    const old = store.require<AgentConfig>('agents', aid, wid); const body = req.body as AgentConfig;
    if (body.version !== undefined && body.version !== old.version) throw failure('Agent 配置已更新，请刷新后再保存', 409);
    if (body.harness !== 'pi') throw failure('首版仅支持 Pi harness');
    if (!Array.isArray(body.tools) || !body.tools.every(t => typeof t === 'string') || !Array.isArray(body.skills) || !body.skills.every(t => typeof t === 'string')) throw failure('tools 和 skills 必须是字符串数组');
    if (!body.mcp || typeof body.mcp !== 'object' || Array.isArray(body.mcp)) throw failure('MCP 配置必须是 JSON 对象');
    if (body.baseUrl) { const url = new URL(body.baseUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw failure('模型地址必须是 HTTP(S) 地址且不包含用户名密码'); }
    const parameters = body.parameters || {};
    if (parameters.temperature !== undefined && (!Number.isFinite(parameters.temperature) || parameters.temperature < 0 || parameters.temperature > 2)) throw failure('temperature 应在 0 到 2 之间');
    if (parameters.maxTokens !== undefined && (!Number.isInteger(parameters.maxTokens) || parameters.maxTokens < 1 || parameters.maxTokens > 200000)) throw failure('maxTokens 必须是 1–200000 的整数');
    const next: AgentConfig = { agentId: aid, workspaceId: wid, version: old.version + 1, harness: 'pi', provider: String(body.provider || '').slice(0, 100), model: String(body.model || '').slice(0, 200), protocol: String(body.protocol || 'openai-completions'), baseUrl: String(body.baseUrl || ''), apiKey: typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : old.apiKey, parameters, prompt: text(body.prompt, '系统提示词', 50000), tools: body.tools, mcp: body.mcp, skills: body.skills };
    if (next.provider === 'wainao') {
      if (!auth || !old.oauthSubject) throw failure('请先通过外脑模型目录连接当前岗位');
      next.oauthSubject = old.oauthSubject; next.apiKey = undefined; next.baseUrl = gatewayBase(options.auth?.apiBaseUrl); next.protocol = 'openai-completions';
    }
    store.put('agents', next); const { apiKey, ...publicConfig } = next; res.json({ ...publicConfig, hasApiKey: !!apiKey });
  });
  app.get('/api/workspaces/:wid/datasets/:did/schema', (req, res) => { const wid = String(req.params.wid), did = String(req.params.did); res.json({ dataset: store.require('datasets', did, wid), sql: store.datasetTable(wid, did) }); });
  app.get('/api/workspaces/:wid/records/:rid/history', (req, res) => res.json(store.history(String(req.params.rid), String(req.params.wid))));
  app.post('/api/workspaces/:wid/records/:rid', (req, res) => res.json(store.reviseRecord(String(req.params.wid), String(req.params.rid), req.body.version, req.body.data)));
  app.post('/api/workspaces/:wid/records', (req, res) => res.status(201).json(store.createRecord(String(req.params.wid), String(req.body.datasetId), req.body.data)));
  app.post('/api/workspaces/:wid/chat', (req, res) => res.status(202).json({ run: pipeline.chat(String(req.params.wid), text(req.body.message, '问题')) }));
  app.post('/api/workspaces/:wid/boards/generate', (req, res) => res.status(202).json({ run: pipeline.board(String(req.params.wid), text(req.body.prompt, '看板需求')) }));
  app.get('/api/workspaces/:wid/boards/:bid/source', async (req, res) => res.json(await pipeline.boards.source(String(req.params.wid), String(req.params.bid))));
  app.put('/api/workspaces/:wid/boards/:bid/source', async (req, res) => {
    const board = await pipeline.boards.save(String(req.params.wid), String(req.params.bid), { version: req.body.version, html: req.body.html, name: req.body.name, description: req.body.description });
    res.json({ board: publicBoard(board), version: boardVersion(board) });
  });
  app.get('/api/workspaces/:wid/boards/:bid/versions', (req, res) => res.json({ versions: pipeline.boards.versions(String(req.params.wid), String(req.params.bid)) }));
  app.post('/api/workspaces/:wid/boards/:bid/restore', async (req, res) => {
    const board = await pipeline.boards.restore(String(req.params.wid), String(req.params.bid), req.body.version, req.body.targetVersion);
    res.json({ board: publicBoard(board), version: boardVersion(board) });
  });
  app.post('/api/workspaces/:wid/boards/:bid/update', (req, res) => res.status(202).json({ run: pipeline.board(String(req.params.wid), text(req.body.prompt, '看板修改需求'), { boardId: String(req.params.bid), version: req.body.version }) }));
  app.post('/api/workspaces/:wid/boards/:bid/publish', (req, res) => {
    const board = store.require<Board>('boards', String(req.params.bid), String(req.params.wid));
    res.json(store.put('boards', { ...board, status: 'published' }));
  });
  app.get('/api/workspaces/:wid/boards/:bid/preview', async (req, res) => {
    const board = store.require<Board>('boards', String(req.params.bid), String(req.params.wid));
    res.vary('Sec-Fetch-Dest');
    if (req.headers['sec-fetch-dest'] !== 'iframe') {
      // Generated HTML is never the top-level document. Its trusted parent must
      // retain frame-src so the sandbox cannot navigate itself to an external sink.
      const nonce = randomBytes(24).toString('base64');
      const previewPath = `/api/workspaces/${encodeURIComponent(board.workspaceId)}/boards/${encodeURIComponent(board.id)}/preview`;
      const version = boardVersion(board);
      res.setHeader('Content-Security-Policy', `default-src 'none'; frame-src 'self'; frame-ancestors 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'`);
      return res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeHtml(board.name)} · 铆钉</title><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;background:#f7f8f5;color:#25352f;font:14px "Avenir Next","PingFang SC",sans-serif;display:flex;flex-direction:column;height:100dvh}header{height:48px;flex-shrink:0;display:flex;align-items:center;gap:16px;padding:0 20px;border-bottom:1px solid #e6eae5;background:#fff}a{color:#204b3e;text-decoration:none;font-weight:600}h1{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}small{margin-left:auto;color:#7d8781;white-space:nowrap}iframe{display:block;border:0;flex:1;width:100%;min-height:0}</style></head><body><header><a href="/">铆钉</a><h1>${safeHtml(board.name)}</h1><small>独立看板</small></header><iframe id="board-preview" title="${safeHtml(board.name)}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${safeHtml(previewPath)}?v=${version}"></iframe><script nonce="${nonce}">(()=>{const frame=document.getElementById('board-preview'),boardId=${safeJson(board.id)},previewPath=${safeJson(previewPath)};let activeVersion=${version};addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data||event.data.type!=='maoding-board-update'||event.data.boardId!==boardId||!Number.isSafeInteger(event.data.version)||event.data.version<=activeVersion)return;activeVersion=event.data.version;frame.src=previewPath+'?v='+activeVersion})})();</script></body></html>`);
    }
    const html = await pipeline.boards.html(board); const origin = managementOrigin(req);
    const bootstrap = `<script>\nwindow.employee=(()=>{const base=${safeJson(origin + '/board-api/' + board.id)},token=${safeJson(board.token)},activeVersion=${boardVersion(board)};async function call(route,body){const r=await fetch(base+route,{method:body?'POST':'GET',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const x=await r.json();if(!r.ok)throw Error(x.error||'请求失败');return x}let checking=false,reloading=false;const timer=setInterval(async()=>{if(checking||reloading)return;checking=true;try{const next=await call('/version');if(Number.isSafeInteger(next.version)&&next.version>activeVersion){reloading=true;if(parent!==window)parent.postMessage({type:'maoding-board-update',boardId:${safeJson(board.id)},version:next.version},'*');else location.reload()}}catch{}finally{checking=false}},3000);addEventListener('pagehide',()=>clearInterval(timer),{once:true});return Object.freeze({schema:()=>call('/schema'),records:(datasetId,offset=0,limit=100)=>call('/records?'+new URLSearchParams({datasetId,offset,limit})),create:(datasetId,data)=>call('/records',{datasetId,data}),revise:(id,version,data)=>call('/records/'+encodeURIComponent(id),{version,data}),version:()=>call('/version')})})();\n</script>`;
    const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src ${origin}; frame-src 'none'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
    res.setHeader('Content-Security-Policy', csp);
    res.type('html').send(html.replace(/<head([^>]*)>/i, `<head$1>${bootstrap}`).replace(!/<head[\s>]/i.test(html) ? /<html([^>]*)>/i : /NEVER_MATCH_PLACEHOLDER_4f2a/, `<html$1><head>${bootstrap}</head>`));
  });
  app.post('/api/workspaces/:wid/deliverables', (req, res) => res.status(202).json({ run: pipeline.deliverable(String(req.params.wid), text(req.body.prompt, '交付需求'), req.body.title) }));
  app.post('/api/workspaces/:wid/deliverables/:did/select', (req, res) => {
    const item = store.require<Deliverable>('deliverables', String(req.params.did), String(req.params.wid));
    res.json(item.status !== 'candidate' ? item : store.put('deliverables', { ...item, status: 'selected', selectedAt: now() }));
  });
  app.post('/api/workspaces/:wid/deliverables/:did/sign', (req, res) => {
    const item = store.require<Deliverable>('deliverables', String(req.params.did), String(req.params.wid));
    const signature = text(req.body.signature, '签字人', 100);
    if (item.status === 'candidate') throw failure('请先选定候选，再签字');
    if (item.status === 'signed') { if (item.signature !== signature) throw failure('该候选已经由其他签字信息确认', 409); return res.json(item); }
    res.json(store.put('deliverables', { ...item, status: 'signed', signature, signedAt: now() }));
  });
  app.post('/api/workspaces/:wid/deliverables/:did/reflow', async (req, res) => {
    const wid = String(req.params.wid); const item = store.require<Deliverable>('deliverables', String(req.params.did), wid);
    if (item.status !== 'signed') throw failure('请先选定并签字，再回流为新资料');
    const key = `${wid}/${item.id}`;
    const pending = reflows.get(key); if (pending) return res.json(await pending);
    const operation = (async () => {
      const existing = store.list<SourceFile & { derivedFrom?: string }>('files', wid).find(f => f.derivedFrom === item.id);
      if (existing) return { file: existing, run: store.list<AgentRun>('runs', wid).find(run => run.fileId === existing.id) };
      const file = await sources.upload(wid, `${item.title.replaceAll('/', '-')}.json`, Buffer.from(JSON.stringify({ title: item.title, content: item.content, candidateId: item.id, candidateVersion: item.version, inputVersions: item.inputVersions }), 'utf8'));
      const derived = store.put('files', { ...file, derivedFrom: item.id });
      return { file: derived, run: pipeline.clean(wid, file.id) };
    })();
    reflows.set(key, operation);
    try { res.status(201).json(await operation); } finally { if (reflows.get(key) === operation) reflows.delete(key); }
  });
  app.post('/api/workspaces/:wid/checks', (req, res) => res.status(202).json({ run: pipeline.check(String(req.params.wid), text(req.body.name || '岗位规则检查', '检查名称', 100), text(req.body.rule, '检查规则')) }));
  registerFinanceApi(app, store);
  app.use(['/api', '/board-api'], (_req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof multer.MulterError ? 413 : Number(error.status) || 500;
    res.status(status).json({ error: error instanceof multer.MulterError ? '上传超过限制：单个文件最大30 MB，每次最多20个文件' : error.message || '本地服务错误' });
  });
  // A crashed process cannot leave a persistent task claiming to be active.
  for (const workspace of store.listWorkspaces()) for (const run of store.list<AgentRun>('runs', workspace.id)) if (['queued', 'running'].includes(run.status)) {
    store.put('runs', { ...run, status: 'interrupted', error: '服务上次退出时任务未完成，可重新运行', updatedAt: now() });
    if (run.fileId) { const file = store.get<SourceFile>('files', run.fileId, workspace.id); if (file && file.generation === run.generation) store.put('files', { ...file, error: '清洗已中断，请重试' }); }
  }
  for (const workspace of store.listWorkspaces()) autoCleaner.enqueue(workspace.id);
  return { app, store, sources, pipeline, scan, autoCleaner, close: async () => { autoCleaner.stop(); await pipeline.close(); await autoCleaner.idle(); store.close(); auth?.close(); } };
}
