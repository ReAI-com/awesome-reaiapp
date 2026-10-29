/** Full HTTP workflows use real Pi SDK + loopback model fixtures. They do not measure model quality. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/api.ts';

const schema = { type: 'object', properties: { item: { type: 'string', title: '项目' }, amount: { type: 'number', title: '金额' } }, required: ['item', 'amount'], additionalProperties: false };

function sendModel(res: ServerResponse, content: string | object, tool: boolean | { name: string; arguments: object } = false) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const invocation = tool === true ? { name: 'query_records', arguments: {} } : tool;
  const delta = invocation ? { tool_calls: [{ index: 0, id: 'business_tool', type: 'function', function: { name: invocation.name, arguments: JSON.stringify(invocation.arguments) } }] } : { content: typeof content === 'string' ? content : JSON.stringify(content) };
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ id: 'api-fixture', object: 'chat.completion.chunk', created: 1, model: 'api-fixture', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
  send({ id: 'api-fixture', object: 'chat.completion.chunk', created: 1, model: 'api-fixture', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } });
  res.end('data: [DONE]\n\n');
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'employee-api-test-'));
  let workbench = createApp({ dataDir: path.join(root, 'state') });
  let pauseNextClean = false;
  let cleanArrived: (() => void) | undefined;
  let continueClean: (() => void) | undefined;
  const model = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const prompt = body.messages.filter((message: any) => message.role === 'user').map((message: any) => typeof message.content === 'string' ? message.content : message.content.map((part: any) => part.text || '').join('\n')).join('\n');
      if (prompt.includes('你是清洗Agent-001')) {
        const source = JSON.parse(prompt.match(/<source-data>\n([\s\S]*?)\n<\/source-data>/)![1]);
        const records = Array.isArray(source) ? source.map(row => ({ item: row.item, amount: Number(row.amount) })) : [{ item: source.title, amount: 0 }];
        if (pauseNextClean) { pauseNextClean = false; await new Promise<void>(resolve => { continueClean = resolve; cleanArrived?.(); }); }
        sendModel(res, { name: '费用记录', schema, records, issues: [] });
      } else if (prompt.includes('你是生成看板Agent-002')) {
        const datasets = JSON.parse(prompt.match(/已发布数据库结构：([^\n]+)\n用户需求/)![1]);
        sendModel(res, { name: '费用看板', description: '通过 REST 显示费用', datasetIds: [datasets[0].id], html: '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>费用看板</title></head><body><main id="data"></main><script>employee.schema().then(async tables=>{const result=await employee.records(tables[0].id);document.getElementById("data").textContent=JSON.stringify(result.records)}).catch(error=>{document.getElementById("data").textContent=error.message})</script></body></html>' });
      } else if (prompt.includes('整数计算工具验收')) {
        const enabled = body.tools?.some((tool: any) => tool.function.name === 'calculate');
        const result = body.messages.findLast((message: any) => message.role === 'tool');
        if (!enabled) sendModel(res, '未开放 calculate');
        else if (!result) sendModel(res, {}, { name: 'calculate', arguments: { operation: 'subtract', operands: [4800000, 3628000] } });
        else sendModel(res, JSON.parse(result.content));
      } else if (prompt.includes('岗位专家Agent-003')) {
        const tool = body.messages.findLast((message: any) => message.role === 'tool');
        if (!tool) sendModel(res, {}, true);
        else { const records = JSON.parse(tool.content).records; sendModel(res, records.length ? `已查证 ${records.length} 条记录。[记录:${records[0].id} v${records[0].version}]` : '当前 B 没有记录。'); }
      } else if (prompt.includes('根据冻结的B记录生成交付物候选')) {
        const records = JSON.parse(prompt.match(/冻结数据：([^\n]+)$/)![1]);
        sendModel(res, { title: '费用报告', content: `基于 ${records.length} 条冻结记录生成的测试报告。` });
      } else if (prompt.includes('执行规则检查D')) {
        const records = JSON.parse(prompt.match(/冻结数据：([^\n]+)$/)![1]);
        sendModel(res, { outcome: records.every((r: any) => r.data.amount >= 0) ? 'passed' : 'failed', findings: records.map((record: any) => ({ message: record.data.amount >= 0 ? '金额非负' : '存在负数', recordIds: [record.id] })) });
      } else throw new Error(`Unknown fixture workflow: ${prompt.slice(0, 60)}`);
    } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
  let http = workbench.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.on('listening', resolve));
  let base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => {
    continueClean?.();
    await workbench.close();
    http.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => http.close(() => resolve())), new Promise<void>(resolve => model.close(() => resolve()))]);
    await rm(root, { recursive: true, force: true });
  });
  const request = async (route: string, method = 'GET', payload?: unknown, expected: number | number[] = 200, extraHeaders: Record<string, string> = {}) => {
    const multipart = payload instanceof FormData;
    const response = await fetch(base + route, { method, headers: { 'X-Workbench-Request': '1', ...(payload !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders }, body: payload === undefined ? undefined : multipart ? payload : JSON.stringify(payload) });
    const value = await response.json() as any;
    assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${method} ${route}: status ${response.status}, expected ${expected}: ${JSON.stringify(value)}`);
    return value;
  };
  const state = (wid: string) => request(`/api/workspaces/${wid}/state`);
  const configure = async (wid: string) => {
    for (const agent of (await state(wid)).agents) await request(`/api/workspaces/${wid}/agents/${agent.agentId}`, 'PUT', { ...agent, provider: 'api-fixture', model: 'api-fixture', baseUrl: modelUrl, apiKey: 'local-model-test-only', parameters: { maxTokens: 2048, temperature: 0.1, thinkingLevel: 'off' } });
  };
  const upload = async (wid: string, name: string, text: string) => {
    const form = new FormData(); form.append('files', new Blob([text], { type: 'text/csv' }), name);
    return (await request(`/api/workspaces/${wid}/uploads`, 'POST', form, 201)).files[0];
  };
  const clean = async (wid: string, fid: string) => {
    const { run } = await request(`/api/workspaces/${wid}/files/${fid}/clean`, 'POST', {}, 202);
    await workbench.pipeline.idle();
    return (await state(wid)).runs.find((item: any) => item.id === run.id);
  };
  const restart = async () => {
    await workbench.close(); http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    workbench = createApp({ dataDir: path.join(root, 'state') });
    http = workbench.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => http.on('listening', resolve));
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  };
  return { get pipeline() { return workbench.pipeline; }, get base() { return base; }, root, request, state, configure, upload, clean, restart, pauseClean: () => { pauseNextClean = true; return new Promise<void>(resolve => { cleanArrived = resolve; }); }, resumeClean: () => continueClean?.() };
}

test('HTTP A→B, independent board REST, expert, C signing/reflow and D audit complete with real Pi loopback fixtures', async t => {
  const f = await fixture(t);
  const { workspace } = await f.request('/api/workspaces', 'POST', { name: '财务岗', role: '检查日常费用' }, 201);
  const wid = workspace.id;
  await f.configure(wid);
  const file = await f.upload(wid, '费用.csv', 'item,amount\n办公用品,12.5\n交通,8\n');
  assert.equal(file.state, '上传完成');
  assert.match(await readFile(file.sourcePath, 'utf8'), /办公用品/);
  const run = await f.clean(wid, file.id);
  assert.equal(run.status, 'succeeded', run.error);
  let state = await f.state(wid);
  assert.equal(state.files[0].state, '清洗完成');
  assert.deepEqual(state.records.map((record: any) => record.data.amount), [12.5, 8]);
  assert.ok(state.records.every((record: any) => record.sourceFileId === file.id && record.sourceRevisionId === file.revisionId));
  assert.doesNotMatch(JSON.stringify(state.agents), /local-model-test-only/);
  const did = state.datasets[0].id;
  const admin = await f.request(`/api/workspaces/${wid}/datasets/${did}/schema`);
  assert.deepEqual(admin.sql.columns.map((column: any) => column.field), ['item', 'amount']);
  const history = await f.request(`/api/workspaces/${wid}/files/${file.id}/history`);
  assert.deepEqual(history.events.map((event: any) => event.state), ['上传', '上传中', '上传完成', '开始清洗', '清洗中', '清洗完成']);
  const { run: boardRun } = await f.request(`/api/workspaces/${wid}/boards/generate`, 'POST', { prompt: '按项目查看费用并支持修订' }, 202);
  await f.pipeline.idle();
  state = await f.state(wid);
  assert.equal(state.runs.find((run: any) => run.id === boardRun.id).status, 'succeeded', JSON.stringify(state.runs));
  const board = state.boards[0];
  assert.equal(board.status, 'draft');
  const preview = await fetch(`${f.base}/api/workspaces/${wid}/boards/${board.id}/preview`, { headers: { "Sec-Fetch-Dest": "iframe" } });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('Content-Security-Policy')!, /sandbox allow-scripts/);
  assert.doesNotMatch(preview.headers.get('Content-Security-Policy')!, /allow-same-origin/);
  const html = await preview.text();
  assert.match(html, /window\.employee=/);
  assert.match(html, /费用看板/);
  const auth = { Authorization: `Bearer ${board.token}` };
  await f.request(`/board-api/${board.id}/schema`, 'GET', undefined, 403);
  await f.request(`/board-api/${board.id}/records`, 'POST', { datasetId: did, data: { item: '新费用', amount: 5 } }, 403, auth);
  const draftRead = await f.request(`/board-api/${board.id}/records?datasetId=${did}&limit=1`, 'GET', undefined, 200, auth);
  assert.equal(draftRead.total, 2); assert.equal(draftRead.records.length, 1);
  await f.request(`/api/workspaces/${wid}/boards/${board.id}/publish`, 'POST', {});
  const added = await f.request(`/board-api/${board.id}/records`, 'POST', { datasetId: did, data: { item: '新费用', amount: 5 } }, 201, auth);
  assert.equal(added.manual, true);
  const revised = await f.request(`/board-api/${board.id}/records/${added.id}`, 'POST', { version: added.version, data: { item: '新费用', amount: 6 } }, 200, auth);
  assert.equal(revised.version, 2);
  await f.request(`/board-api/${board.id}/records/${added.id}`, 'POST', { version: 1, data: { item: '旧写入', amount: 1 } }, 409, auth);
  await f.request(`/board-api/${board.id}/records`, 'POST', { datasetId: did, data: { item: '坏数据', amount: '非数字' } }, 400, auth);
  await f.request(`/board-api/${board.id}/records?datasetId=foreign-dataset`, 'GET', undefined, 403, auth);
  const { workspace: other } = await f.request('/api/workspaces', 'POST', { name: '其他岗', role: '其他岗位' }, 201);
  await f.request(`/api/workspaces/${other.id}/records/${added.id}`, 'POST', { version: 2, data: { item: '跨岗位', amount: 2 } }, 404);
  await f.request(`/api/workspaces/${wid}/state`, 'GET', undefined, 403, { Origin: 'null' });
  await f.request(`/api/workspaces/${wid}/chat`, 'POST', { message: '有哪些费用？请引用来源。' }, 202);
  await f.pipeline.idle();
  state = await f.state(wid);
  assert.match(state.messages.at(-1).content, /已查证 3 条记录/);
  assert.match(state.messages.at(-1).content, new RegExp(`记录:${state.records[0].id} v1`));
  await f.request(`/api/workspaces/${wid}/deliverables`, 'POST', { prompt: '生成费用汇总报告', title: '签字报告' }, 202);
  await f.pipeline.idle();
  state = await f.state(wid);
  const candidate = state.deliverables[0];
  assert.equal(candidate.status, 'candidate'); assert.equal(candidate.inputVersions.length, 3);
  await f.request(`/api/workspaces/${wid}/deliverables/${candidate.id}/sign`, 'POST', { signature: '测试签字人' }, 400);
  await f.request(`/api/workspaces/${wid}/deliverables/${candidate.id}/select`, 'POST', {});
  const signed = await f.request(`/api/workspaces/${wid}/deliverables/${candidate.id}/sign`, 'POST', { signature: '测试签字人' });
  assert.equal(signed.status, 'signed');
  await f.request(`/api/workspaces/${wid}/checks`, 'POST', { name: '金额检查', rule: '金额必须非负' }, 202);
  await f.pipeline.idle();
  state = await f.state(wid);
  assert.equal(state.checks[0].outcome, 'passed');
  assert.equal(state.checks[0].inputVersions.length, 3); assert.equal(state.checks[0].ruleVersion, 1);
  const reflowRoute = `/api/workspaces/${wid}/deliverables/${candidate.id}/reflow`;
  const [reflow, concurrentReflow] = await Promise.all([
    f.request(reflowRoute, 'POST', {}, [200, 201]), f.request(reflowRoute, 'POST', {}, [200, 201]),
  ]);
  assert.equal(concurrentReflow.file.id, reflow.file.id);
  assert.equal(concurrentReflow.run.id, reflow.run.id);
  await f.pipeline.idle();
  assert.notEqual(reflow.file.id, file.id);
  state = await f.state(wid);
  assert.ok(state.files.some((entry: any) => entry.id === reflow.file.id));
  assert.ok(state.records.some((record: any) => record.sourceFileId === reflow.file.id));
  assert.equal(state.deliverables[0].status, 'signed');
  assert.equal(state.files.length, 2);
  const counts = { files: state.files.length, records: state.records.length, runs: state.runs.length };
  const retry = await f.request(reflowRoute, 'POST', {}, [200, 201]);
  assert.equal(retry.file.id, reflow.file.id); assert.equal(retry.run.id, reflow.run.id);
  await f.pipeline.idle(); state = await f.state(wid);
  assert.deepEqual({ files: state.files.length, records: state.records.length, runs: state.runs.length }, counts);
});

test('directory updates preserve last B until a current clean succeeds; stale in-flight results cannot overwrite', async t => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'source'); await mkdir(directory);
  const source = path.join(directory, 'ledger.csv'); await writeFile(source, 'item,amount\n版本一,10\n');
  const { workspace } = await f.request('/api/workspaces', 'POST', { name: '扫描岗', role: '扫描指定目录', directory }, 201);
  const wid = workspace.id; await f.configure(wid);
  const scan = await f.request(`/api/workspaces/${wid}/scan`, 'POST', {});
  const file = scan.imported[0];
  assert.equal((await f.clean(wid, file.id)).status, 'succeeded');
  await writeFile(source, 'item,amount\n版本二,20\n');
  await f.request(`/api/workspaces/${wid}/scan`, 'POST', {});
  assert.equal((await f.state(wid)).files[0].state, '有更新');
  const arrived = f.pauseClean();
  const { run } = await f.request(`/api/workspaces/${wid}/files/${file.id}/clean`, 'POST', {}, 202);
  await arrived;
  assert.equal((await f.state(wid)).files[0].state, '更新中');
  await writeFile(source, 'item,amount\n版本三,30\n');
  await f.request(`/api/workspaces/${wid}/scan`, 'POST', {});
  f.resumeClean(); await f.pipeline.idle();
  let state = await f.state(wid);
  assert.equal(state.runs.find((candidate: any) => candidate.id === run.id).status, 'superseded');
  assert.equal(state.records[0].data.amount, 10);
  assert.equal(state.files[0].state, '有更新');
  assert.equal((await f.clean(wid, file.id)).status, 'succeeded');
  state = await f.state(wid);
  assert.equal(state.records.length, 1); assert.equal(state.records[0].data.amount, 30);
  assert.equal(state.files[0].state, '更新完成');
  const history = await f.request(`/api/workspaces/${wid}/files/${file.id}/history`);
  assert.equal(history.revisions.length, 3);
});

test('unconfigured Agent fails without fake B data; management mutations require the local request header', async t => {
  const f = await fixture(t);
  const blocked = await fetch(`${f.base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bad', role: 'bad' }) });
  assert.equal(blocked.status, 403);
  const { workspace } = await f.request('/api/workspaces', 'POST', { name: '未配置', role: '测试失败行为' }, 201);
  const file = await f.upload(workspace.id, 'input.csv', 'item,amount\n测试,1\n');
  const run = await f.clean(workspace.id, file.id);
  assert.equal(run.status, 'failed'); assert.match(run.error, /配置/);
  const state = await f.state(workspace.id);
  assert.equal(state.records.length, 0); assert.equal(state.datasets.length, 0);
  assert.ok(state.files[0].error); assert.equal(state.files[0].cleanedRevisionId, undefined);
});

test('calculate is absent by default and executes through real Pi tool calls only when explicitly enabled', async t => {
  const f = await fixture(t);
  const { workspace } = await f.request('/api/workspaces', 'POST', { name: '整数计算岗', role: '验证财务整数计算工具' }, 201);
  const wid = workspace.id;
  await f.configure(wid);
  assert.ok((await f.state(wid)).agents.every((agent: any) => !agent.tools.includes('calculate')));
  await f.request(`/api/workspaces/${wid}/chat`, 'POST', { message: '整数计算工具验收' }, 202);
  await f.pipeline.idle();
  let state = await f.state(wid);
  assert.equal(state.messages.at(-1).content, '未开放 calculate');
  const expert = state.agents.find((agent: any) => agent.agentId === 'agent-003');
  await f.request(`/api/workspaces/${wid}/agents/agent-003`, 'PUT', { ...expert, tools: [...expert.tools, 'calculate'] });
  const { run } = await f.request(`/api/workspaces/${wid}/chat`, 'POST', { message: '整数计算工具验收：4800000分减3628000分' }, 202);
  await f.pipeline.idle();
  state = await f.state(wid);
  assert.equal(state.runs.find((candidate: any) => candidate.id === run.id).status, 'succeeded');
  assert.deepEqual(JSON.parse(state.messages.at(-1).content), { operation: 'subtract', operands: [4800000, 3628000], result: 1172000 });
});

test('manual source-record review survives restart, requires explicit confirmation and retains both historical versions', async t => {
  const f = await fixture(t);
  const { workspace } = await f.request('/api/workspaces', 'POST', { name: '复核岗', role: '复核人工修订与清洗差异' }, 201);
  const wid = workspace.id; await f.configure(wid);
  const file = await f.upload(wid, 'review.csv', 'item,amount\n原始费用,10\n');
  assert.equal((await f.clean(wid, file.id)).status, 'succeeded');
  const original = (await f.state(wid)).records[0];
  const manual = await f.request(`/api/workspaces/${wid}/records/${original.id}`, 'POST', { version: original.version, data: { item: '人工校准', amount: 99 } });
  assert.equal(manual.version, 2);
  const run = await f.clean(wid, file.id);
  assert.equal(run.status, 'waiting_review', run.error);
  assert.equal(run.result.hasManual, true);
  assert.equal((await f.state(wid)).records[0].data.amount, 99);
  const payload = { records: run.result.proposal.records, replaceManual: false };
  await f.request(`/api/workspaces/${wid}/runs/${run.id}/review`, 'POST', payload, 400);
  assert.equal((await f.state(wid)).records[0].data.amount, 99);
  await f.restart();
  const restored = (await f.state(wid)).runs.find((item: any) => item.id === run.id);
  assert.equal(restored.status, 'waiting_review');
  assert.deepEqual(restored.result.proposal.records, payload.records);
  const accepted = await f.request(`/api/workspaces/${wid}/runs/${run.id}/review`, 'POST', { ...payload, replaceManual: true });
  assert.equal(accepted.records[0].data.amount, 10);
  assert.notEqual(accepted.records[0].id, original.id);
  const state = await f.state(wid);
  assert.equal(state.runs.find((item: any) => item.id === run.id).status, 'succeeded');
  assert.equal(state.files[0].state, '更新完成');
  const history = await f.request(`/api/workspaces/${wid}/records/${original.id}/history`);
  assert.deepEqual(history.map((record: any) => ({ version: record.version, amount: record.data.amount })), [{ version: 1, amount: 10 }, { version: 2, amount: 99 }]);
  assert.equal(history[1].historyReason, 'reviewed_cleaning_replaced');
});
