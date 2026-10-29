/** Integration tests use the real Pi 1.4 SDK against loopback HTTP fixtures, never a paid model. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPi } from '../server/harness.ts';
import type { AgentConfig } from '../shared/types.ts';

async function workspace(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), 'employee-pi-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse, json: any) => void | Promise<void>) {
  const service = createServer(async (req, res) => {
    try { await handle(req, res, await body(req)); }
    catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); });
  return `http://127.0.0.1:${(service.address() as { port: number }).port}`;
}

function completion(res: ServerResponse, delta: Record<string, unknown>, finish = 'stop') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  chunk({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
  chunk({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  res.end('data: [DONE]\n\n');
}

function protocolCompletion(res: ServerResponse, protocol: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (data: Record<string, unknown>) => res.write(`event: ${data.type ?? 'message'}\ndata: ${JSON.stringify(data)}\n\n`);
  if (protocol === 'anthropic-messages') {
    send({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '协议已运行' } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    send({ type: 'message_stop' });
  } else if (protocol === 'google-generative-ai') {
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '协议已运行' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 } })}\n\n`);
  } else {
    const item = { id: 'msg_fixture', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '协议已运行', annotations: [] }] };
    send({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '协议已运行' });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } });
  }
  res.end();
}

function config(baseUrl: string, changes: Partial<AgentConfig> = {}): AgentConfig {
  return { agentId: 'agent-001', workspaceId: 'workspace-test', version: 1, harness: 'pi', provider: 'local-fixture', model: 'fixture-model', protocol: 'openai-completions', baseUrl: `${baseUrl}/v1`, prompt: '你是独立的清洗 Agent。', parameters: { temperature: 0.25, maxTokens: 512, thinkingLevel: 'off' }, tools: [], mcp: {}, skills: [], ...changes };
}

test('real Pi sends model, protocol, exact parameters and explicit prompt/Skill; no project discovery', async t => {
  const cwd = await workspace(t);
  await mkdir(path.join(cwd, 'skills', 'clean'), { recursive: true });
  await writeFile(path.join(cwd, 'skills', 'clean', 'SKILL.md'), '---\nname: clean\ndescription: 清洗规范\n---\n金额统一为人民币元。');
  await writeFile(path.join(cwd, 'AGENTS.md'), 'UNRELATED_PROJECT_INSTRUCTION_MUST_NOT_LOAD');
  let request: any;
  let requestUrl = '';
  let authorization: string | undefined;
  const url = await server(t, (req, res, json) => { request = json; requestUrl = req.url!; authorization = req.headers.authorization; completion(res, { content: '{"amount":125}' }); });
  const events: string[] = [];
  const result = await runPi({ cwd, config: config(url, { skills: ['skills/clean'], apiKey: 'explicit-fixture-key' }), prompt: '清洗金额 125 元', onEvent: phase => events.push(phase) });
  assert.equal(result, '{"amount":125}');
  assert.equal(requestUrl, '/v1/chat/completions');
  assert.equal(request.model, 'fixture-model');
  assert.equal(request.temperature, 0.25);
  assert.equal(request.max_tokens ?? request.max_completion_tokens, 512);
  assert.equal(authorization, 'Bearer explicit-fixture-key');
  assert.match(JSON.stringify(request.messages), /你是独立的清洗 Agent/);
  assert.match(JSON.stringify(request.messages), /金额统一为人民币元/);
  assert.doesNotMatch(JSON.stringify(request.messages), /UNRELATED_PROJECT_INSTRUCTION/);
  assert.equal(request.tools?.length ?? 0, 0);
  assert.ok(events.includes('text'));
  assert.ok(events.includes('complete'));
  assert.deepEqual(await readdir(path.join(cwd, '.runtime', 'pi')), []);
});

test('real Pi validates and executes an allowlisted business tool, then includes its result in the next model request', async t => {
  const cwd = await workspace(t);
  const requests: any[] = [];
  const url = await server(t, (_req, res, json) => {
    requests.push(json);
    if (requests.length === 1) completion(res, { tool_calls: [{ index: 0, id: 'call_query', type: 'function', function: { name: 'query_records', arguments: '{"limit":2}' } }] }, 'tool_calls');
    else completion(res, { content: '共有两条记录。' });
  });
  let args: any;
  let deniedCalled = false;
  const result = await runPi({ cwd, config: config(url, { tools: ['query_records'] }), prompt: '查询 B 的记录', tools: [
    { name: 'query_records', description: '查询 B', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['limit'], additionalProperties: false }, execute: async input => { args = input; return [{ id: 'B1' }, { id: 'B2' }]; } },
    { name: 'delete_records', description: '删除 B', parameters: { type: 'object' }, execute: async () => { deniedCalled = true; return {}; } },
  ] });
  assert.equal(result, '共有两条记录。');
  assert.deepEqual(args, { limit: 2 });
  assert.equal(deniedCalled, false);
  assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name), ['query_records']);
  assert.ok(requests[1].messages.some((message: any) => message.role === 'tool' && message.content.includes('B1')));
});

for (const protocol of ['openai-responses', 'anthropic-messages', 'google-generative-ai']) {
  test(`real Pi applies ${protocol} wire protocol and parameters`, async t => {
    const cwd = await workspace(t);
    let sent: any;
    let requestUrl = '';
    const url = await server(t, (req, res, json) => { sent = json; requestUrl = req.url!; protocolCompletion(res, protocol); });
    assert.equal(await runPi({ cwd, config: config(url, { protocol, ...(protocol === 'anthropic-messages' ? { baseUrl: url } : {}) }), prompt: '验证协议' }), '协议已运行');
    if (protocol === 'google-generative-ai') {
      assert.equal(sent.generationConfig.temperature, 0.25);
      assert.equal(sent.generationConfig.maxOutputTokens, 512);
      assert.match(requestUrl, /streamGenerateContent/);
    } else {
      assert.equal(sent.temperature, 0.25);
      assert.equal(sent.max_tokens ?? sent.max_output_tokens, 512);
      assert.equal(new URL(requestUrl, url).pathname, protocol === 'anthropic-messages' ? '/v1/messages' : '/v1/responses');
    }
  });
}

test('supported thinkingLevel is sent to a Responses model without silent clamping', async t => {
  const cwd = await workspace(t);
  let sent: any;
  const url = await server(t, (_req, res, json) => { sent = json; protocolCompletion(res, 'openai-responses'); });
  const selected = config(url, { provider: 'openai', model: 'gpt-5.4', protocol: 'openai-responses', parameters: { maxTokens: 512, thinkingLevel: 'high' } });
  assert.equal(await runPi({ cwd, config: selected, prompt: '分析' }), '协议已运行');
  assert.equal(sent.reasoning.effort, 'high');
});

test('explicit MCP streamable HTTP server connects and its allowlisted tool executes through real Pi', async t => {
  const cwd = await workspace(t);
  let mcpArgs: unknown;
  let mcpAuth: string | undefined;
  const mcp = await server(t, (req, res, json) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    mcpAuth = req.headers.authorization;
    if (json.id === undefined) { res.writeHead(202); res.end(); return; }
    let result: unknown;
    if (json.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-mcp-fixture', version: '1' } };
    else if (json.method === 'tools/list') result = { tools: [{ name: 'lookup', description: 'Read a B fact', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] };
    else if (json.method === 'tools/call') { mcpArgs = json.params; result = { content: [{ type: 'text', text: 'MCP_FACT_42' }] }; }
    else { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: json.id, result }));
  });
  let count = 0;
  const url = await server(t, (_req, res, json) => {
    if (++count === 1) {
      assert.deepEqual(json.tools.map((tool: any) => tool.function.name), ['mcp__facts__lookup']);
      completion(res, { tool_calls: [{ index: 0, id: 'mcp_call', type: 'function', function: { name: 'mcp__facts__lookup', arguments: '{"id":"B42"}' } }] }, 'tool_calls');
    } else {
      assert.match(JSON.stringify(json.messages), /MCP_FACT_42/);
      completion(res, { content: '查到 B42。' });
    }
  });
  const result = await runPi({ cwd, config: config(url, { tools: ['mcp__facts__*'], mcp: { mcpServers: { facts: { url: `${mcp}/mcp`, headers: { Authorization: 'Bearer fixture-mcp-token' } } } } }), prompt: '查找 B42' });
  assert.equal(result, '查到 B42。');
  assert.equal(mcpAuth, 'Bearer fixture-mcp-token');
  assert.deepEqual(mcpArgs, { name: 'lookup', arguments: { id: 'B42' } });
});

test('explicit MCP stdio uses only supplied environment and closes its process after the run', async t => {
  const cwd = await workspace(t);
  const filename = path.join(cwd, 'mcp-fixture.mjs');
  await writeFile(filename, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1' } };
  else if (message.method === 'tools/list') result = { tools: [{ name: 'identity', inputSchema: { type: 'object', properties: {} } }] };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ explicit: process.env.EXPLICIT_FIXTURE_VALUE, inherited: process.env.EMPLOYEE_HARNESS_FIXTURE_LEAK ?? null, pid: process.pid }) }] };
  else return;
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`);
  const previous = process.env.EMPLOYEE_HARNESS_FIXTURE_LEAK;
  process.env.EMPLOYEE_HARNESS_FIXTURE_LEAK = 'should-not-be-inherited';
  t.after(() => { if (previous === undefined) delete process.env.EMPLOYEE_HARNESS_FIXTURE_LEAK; else process.env.EMPLOYEE_HARNESS_FIXTURE_LEAK = previous; });
  let calls = 0;
  let identity: any;
  const url = await server(t, (_req, res, json) => {
    if (++calls === 1) completion(res, { tool_calls: [{ index: 0, id: 'stdio_call', type: 'function', function: { name: 'mcp__local__identity', arguments: '{}' } }] }, 'tool_calls');
    else {
      const toolResult = json.messages.find((message: any) => message.role === 'tool');
      identity = JSON.parse(JSON.parse(toolResult.content).content[0].text);
      completion(res, { content: 'stdio 已运行' });
    }
  });
  assert.equal(await runPi({ cwd, config: config(url, { tools: ['mcp__local__identity'], mcp: { local: { command: process.execPath, args: [filename], env: { EXPLICIT_FIXTURE_VALUE: 'configured' } } } }), prompt: '调用工具' }), 'stdio 已运行');
  assert.equal(identity.explicit, 'configured');
  assert.equal(identity.inherited, null);
  assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
});

test('plain JSON Schema rejects invalid model tool arguments before the business function executes', async t => {
  const cwd = await workspace(t);
  let calls = 0;
  let executed = false;
  const url = await server(t, (_req, res, json) => {
    if (++calls === 1) completion(res, { tool_calls: [{ index: 0, id: 'invalid_args', type: 'function', function: { name: 'query_records', arguments: '{"limit":-1}' } }] }, 'tool_calls');
    else { assert.match(JSON.stringify(json.messages), /validation|minimum|greater/i); completion(res, { content: '参数不合法，未执行。' }); }
  });
  await runPi({ cwd, config: config(url, { tools: ['query_records'] }), prompt: '测试参数验证', tools: [{ name: 'query_records', description: '读取 B', parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1 } }, required: ['limit'] }, execute: async () => { executed = true; return {}; } }] });
  assert.equal(executed, false);
});

test('in-flight model request can be cancelled', async t => {
  const cwd = await workspace(t);
  let arrived!: () => void;
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const url = await server(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); arrived(); });
  const controller = new AbortController();
  const task = runPi({ cwd, config: config(url), prompt: '等待', signal: controller.signal });
  await reached;
  controller.abort();
  await assert.rejects(task, error => error instanceof Error && error.name === 'AbortError');
});

test('provider failures are surfaced and API keys are redacted', async t => {
  const cwd = await workspace(t);
  const key = 'secret-error-fixture';
  const url = await server(t, (_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Invalid ${key}`, type: 'authentication_error' } })); });
  await assert.rejects(runPi({ cwd, config: config(url, { apiKey: key }), prompt: '测试错误' }), error => error instanceof Error && error.message.includes('[已隐藏]') && !error.message.includes(key));
});

test('finish_reason length is rejected as truncation instead of returning cut text', async t => {
  const cwd = await workspace(t);
  const url = await server(t, (_req, res) => completion(res, { content: '{"name":"截断的看板' }, 'length'));
  await assert.rejects(runPi({ cwd, config: config(url), prompt: '生成看板' }), /maxTokens=512.*截断/s);
});

test('a dropped model stream reports a connection interruption instead of a bare terminated', async t => {
  const cwd = await workspace(t);
  const url = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: '{"na' }, finish_reason: null }] })}\n\n`);
    res.socket?.destroy();
  });
  await assert.rejects(runPi({ cwd, config: config(url), prompt: '生成看板' }), /连接中断/);
});

test('missing external credentials and unsupported configuration fail explicitly without contacting a model', async t => {
  const cwd = await workspace(t);
  await assert.rejects(runPi({ cwd, config: config('https://models.example.invalid'), prompt: 'x' }), /API Key/);
  await assert.rejects(runPi({ cwd, config: config('http://127.0.0.1:1', { parameters: { thinkingLevel: 'high' } }), prompt: 'x' }), /不支持 thinkingLevel/);
  await assert.rejects(runPi({ cwd, config: config('http://127.0.0.1:1', { tools: ['bash'] }), prompt: 'x' }), /白名单/);
  await assert.rejects(runPi({ cwd, config: config('http://127.0.0.1:1', { protocol: 'not-a-protocol' }), prompt: 'x' }), /协议/);
  await assert.rejects(runPi({ cwd, config: config('http://127.0.0.1:1', { mcp: { local: { url: 'http://127.0.0.1:2', headers: { Authorization: '!read-secret' } } } }), prompt: 'x' }), /不支持命令/);
});
