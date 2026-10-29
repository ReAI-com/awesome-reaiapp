import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, InMemoryCredentialStore, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';
import { McpClient, StdioTransport, StreamableHttpTransport } from '@earendil-works/pi-mcp';
import type { AgentConfig } from '../shared/types.ts';

export interface HarnessTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: any) => Promise<unknown>;
}

const PROTOCOLS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
const FORBIDDEN_TOOLS = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls', 'codemode', 'tool_search']);
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_MODEL_TURNS = 24;

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError');
}

function asObject(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, any>;
}

function matches(name: string, patterns: string[]) {
  return patterns.some(pattern => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name));
}

function httpUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label} 不是有效 URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label} 仅支持不含账号密码的 HTTP(S) URL`);
  return url;
}

function literalStrings(value: unknown, label: string): Record<string, string> {
  const entries = Object.entries(asObject(value ?? {}, label));
  for (const [key, item] of entries) {
    if (typeof item !== 'string' || item.startsWith('!') || /\$\{[^}]+\}/.test(item)) {
      throw new Error(`${label}.${key} 必须是显式字符串，不支持命令或环境变量展开`);
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

async function loadSkills(skills: string[], cwd: string) {
  if (skills.length > 20) throw new Error('单个 Agent 最多配置 20 个 Skill');
  let total = 0;
  const instructions: string[] = [];
  for (const configured of skills) {
    if (!configured.trim()) throw new Error('Skill 路径不能为空');
    const requested = path.resolve(cwd, configured);
    if (!path.isAbsolute(configured) && (path.relative(cwd, requested).startsWith('..') || path.isAbsolute(path.relative(cwd, requested)))) {
      throw new Error('相对 Skill 路径不能越出岗位工作目录；外部 Skill 请显式填写绝对路径');
    }
    const entry = await stat(requested);
    const filename = await realpath(entry.isDirectory() ? path.join(requested, 'SKILL.md') : requested);
    if (!path.isAbsolute(configured) && (path.relative(cwd, filename).startsWith(`..${path.sep}`) || path.relative(cwd, filename) === '..')) throw new Error('相对 Skill 路径不能通过符号链接越出岗位工作目录');
    const info = await stat(filename);
    if (!info.isFile() || !filename.endsWith('.md') || info.size > MAX_SKILL_BYTES) throw new Error('Skill 必须是小于 128 KiB 的 Markdown 文件');
    total += info.size;
    if (total > MAX_SKILL_BYTES) throw new Error('全部 Skill 指令合计不能超过 128 KiB');
    const content = await readFile(filename, 'utf8');
    if (content.includes('\0')) throw new Error('Skill 包含无效文本');
    instructions.push(`\n<explicit_skill source=${JSON.stringify(filename)}>\n${content}\n</explicit_skill>`);
  }
  return instructions.join('\n');
}

/** Only explicit MCP servers are connected. No global config, shell expansion or inherited secrets. */
async function connectMcp(config: AgentConfig, cwd: string, clients: McpClient[], signal?: AbortSignal): Promise<HarnessTool[]> {
  const root = asObject(config.mcp ?? {}, 'MCP 配置');
  const servers = root.mcpServers === undefined ? root : asObject(root.mcpServers, 'mcpServers');
  const result: HarnessTool[] = [];
  const normalizedNames = new Set<string>();
  for (const [name, raw] of Object.entries(servers)) {
    aborted(signal);
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`无效 MCP 服务名称：${name}`);
    const namespace = name.replaceAll('-', '_');
    if (normalizedNames.has(namespace)) throw new Error(`MCP 服务名称冲突：${name}`);
    normalizedNames.add(namespace);
    const server = asObject(raw, `MCP ${name}`);
    if (server.enabled === false) continue;
    if (server.oauth || server.auth) throw new Error(`MCP ${name} 暂不支持 OAuth / 继承 Pi 登录；请配置独立 headers`);
    if (server.exposure && !['direct', 'hidden'].includes(server.exposure)) throw new Error(`MCP ${name} 当前支持 direct / hidden 暴露方式`);
    if (server.exposure === 'hidden') continue;
    const timeout = server.timeout === undefined ? 30 : Number(server.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 300) throw new Error(`MCP ${name} timeout 必须在 0–300 秒之间`);
    const client = new McpClient({ name: 'ai-employee-workbench', version: '3.0.0', requestTimeoutMs: timeout * 1000 });
    clients.push(client);
    if (server.url) {
      if (server.command || (server.type && !['http', 'streamable-http'].includes(server.type))) throw new Error(`MCP ${name} HTTP 配置冲突`);
      const url = httpUrl(server.url, `MCP ${name} URL`);
      await client.connect(new StreamableHttpTransport({ url, headers: literalStrings(server.headers, `MCP ${name} headers`), openGetStream: false, reconnect: { maxRetries: 0 } }));
    } else {
      if (server.type && server.type !== 'stdio') throw new Error(`MCP ${name} 不支持该传输协议`);
      if (typeof server.command !== 'string' || !server.command.trim() || server.command.startsWith('!')) throw new Error(`MCP ${name} 需要独立 command`);
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg: unknown) => typeof arg !== 'string'))) throw new Error(`MCP ${name} args 必须是字符串数组`);
      await client.connect(new StdioTransport({ command: server.command, args: server.args, cwd: path.resolve(cwd, server.cwd ?? '.'), env: literalStrings(server.env, `MCP ${name} env`), inheritEnv: false, stderr: 'pipe' }));
    }
    aborted(signal);
    const names = new Set<string>();
    for (const tool of await client.listTools({ signal })) {
      const toolName = `mcp__${namespace}__${tool.name.replace(/[^A-Za-z0-9_]/g, '_')}`;
      if (names.has(toolName)) throw new Error(`MCP ${name} 工具名称冲突：${tool.name}`);
      names.add(toolName);
      const toolExposure = server.toolExposure ? asObject(server.toolExposure, `MCP ${name} toolExposure`) : {};
      const exposure = toolExposure[tool.name] ?? Object.entries(toolExposure).find(([pattern]) => matches(tool.name, [pattern]))?.[1];
      if (exposure && !['direct', 'hidden'].includes(exposure)) throw new Error(`MCP ${name} 工具暴露方式仅支持 direct / hidden`);
      if (exposure === 'hidden' || !matches(toolName, config.tools)) continue;
      result.push({
        name: toolName, description: tool.description ?? tool.name, parameters: tool.inputSchema,
        execute: async args => {
          aborted(signal);
          const output = await client.callTool(tool.name, args, { signal });
          if (output.isError) throw new Error(`MCP ${name}/${tool.name} 返回执行错误`);
          return output;
        },
      });
    }
  }
  return result;
}

export async function runPi(input: {
  config: AgentConfig; cwd: string; prompt: string; signal?: AbortSignal;
  onEvent?: (phase: string, message: string) => void; tools?: HarnessTool[];
}): Promise<string> {
  const { config, signal } = input;
  aborted(signal);
  if (config.harness !== 'pi') throw new Error('当前仅支持 pi harness');
  if (!PROTOCOLS.has(config.protocol)) throw new Error(`不支持的模型协议：${config.protocol}`);
  if (!config.provider?.trim() || !config.model?.trim()) throw new Error('请先配置 provider 和模型');
  if (!Array.isArray(config.tools) || config.tools.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_*.-]+$/.test(name) || FORBIDDEN_TOOLS.has(name))) throw new Error('工具白名单仅支持业务工具与 MCP 工具，不开放通用文件或 shell 工具');
  const parameters = config.parameters ?? {};
  if (Object.keys(parameters).some(key => !['temperature', 'maxTokens', 'thinkingLevel'].includes(key))) throw new Error('包含不支持的模型参数');
  if (parameters.temperature !== undefined && (!Number.isFinite(parameters.temperature) || parameters.temperature < 0 || parameters.temperature > 2)) throw new Error('temperature 必须在 0–2 之间');
  if (parameters.maxTokens !== undefined && (!Number.isSafeInteger(parameters.maxTokens) || parameters.maxTokens <= 0)) throw new Error('maxTokens 必须是正整数');
  const mcpSecrets = (value: unknown): string[] => !value || typeof value !== 'object' ? [] : Object.entries(value).flatMap(([key, child]) => ['headers', 'env'].includes(key) && child && typeof child === 'object' ? Object.values(child).filter((item): item is string => typeof item === 'string' && item.length > 3) : mcpSecrets(child));
  const secrets = [config.apiKey, ...mcpSecrets(config.mcp).flatMap(value => [value, value.replace(/^Bearer\s+/i, '')])].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const redact = (message: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[已隐藏]'), message);
  const emit = (phase: string, message: string) => input.onEvent?.(phase, redact(message));
  const cwd = await realpath(input.cwd);
  const skillInstructions = await loadSkills(config.skills ?? [], cwd);
  const runtimeRoot = path.join(cwd, '.runtime', 'pi');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const runDirectory = await mkdtemp(path.join(runtimeRoot, 'run-'));
  const clients: McpClient[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const stop = () => { void session?.abort(); for (const client of clients) void client.close(); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal });
    const known = config.provider === 'wainao' ? undefined : modelRuntime.getModel(config.provider, config.model) ?? modelRuntime.getModels().find(model => model.id === config.model && model.api === config.protocol);
    const endpoint = httpUrl(config.baseUrl?.trim() || known?.baseUrl || '', '模型 baseURL');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    const apiKey = config.apiKey?.trim() || (loopback ? 'local-not-required' : undefined);
    if (!apiKey) throw new Error('请先配置此 Agent 的 API Key；不会读取其他系统凭据');
    if (known && parameters.maxTokens !== undefined && parameters.maxTokens > known.maxTokens) throw new Error(`maxTokens 超出模型上限 ${known.maxTokens}`);
    const maxTokens = parameters.maxTokens ?? Math.min(known?.maxTokens ?? 8192, 8192);
    modelRuntime.registerProvider(config.provider, {
      api: config.protocol as Api, baseUrl: endpoint.toString().replace(/\/$/, ''),
      models: [{
        id: config.model, name: config.model, api: config.protocol as Api,
        reasoning: known?.reasoning ?? false, thinkingLevelMap: known?.thinkingLevelMap,
        input: ['text'], contextWindow: known?.contextWindow ?? 128000, maxTokens: known?.maxTokens ?? Math.max(maxTokens, 8192),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: known?.compat,
      }],
    });
    await modelRuntime.setRuntimeApiKey(config.provider, apiKey, { signal });
    const model = modelRuntime.getModel(config.provider, config.model)!;
    const thinkingLevel = parameters.thinkingLevel ?? 'off';
    if (!getSupportedThinkingLevels(model).includes(thinkingLevel as ModelThinkingLevel)) throw new Error(`模型 ${config.model} 不支持 thinkingLevel=${thinkingLevel}；未知自定义模型仅支持 off`);
    const mcpTools = await connectMcp(config, cwd, clients, signal);
    const available = [...(input.tools ?? []), ...mcpTools];
    const seen = new Set<string>();
    for (const tool of available) {
      if (FORBIDDEN_TOOLS.has(tool.name) || seen.has(tool.name) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tool.name)) throw new Error(`无效或重复业务工具：${tool.name}`);
      seen.add(tool.name);
    }
    for (const name of config.tools) {
      if (!available.some(tool => matches(tool.name, [name]))) throw new Error(`配置的工具不可用：${name}（MCP 工具使用 mcp__服务名__工具名）`);
    }
    const customTools: ToolDefinition[] = available.filter(tool => matches(tool.name, config.tools)).map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: asObject(tool.parameters, `${tool.name} 参数 Schema`) as ToolDefinition['parameters'],
      execute: async (_id, args, toolSignal) => {
        aborted(signal); aborted(toolSignal);
        const output = await tool.execute(args);
        aborted(signal); aborted(toolSignal);
        return { content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output ?? null) }], details: {} };
      },
    }));
    // This resource loader performs no filesystem discovery at all. Explicit Skill contents are
    // supplied above; Pi never reads ~/.pi, ~/.agents, AGENTS.md, or project extensions.
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => `${config.prompt}\n${skillInstructions}`, getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    ({ session } = await createAgentSession({
      cwd: runDirectory, agentDir: runDirectory, modelRuntime, model,
      thinkingLevel: thinkingLevel as ModelThinkingLevel, customTools, tools: customTools.map(tool => tool.name), noTools: 'builtin',
      resourceLoader, sessionManager: SessionManager.inMemory(runDirectory),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 }, defaultTools: [], transport: 'sse', cacheWarming: 'off' }),
    }));
    let modelTurns = 0;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (selected, context, options) => {
      aborted(signal);
      if (++modelTurns > MAX_MODEL_TURNS) throw new Error(`Agent 超过 ${MAX_MODEL_TURNS} 次模型调用，已停止`);
      return stream(selected, context, { ...options, apiKey, env: {}, maxTokens, temperature: parameters.temperature, maxRetries: 0, timeoutMs: 120000, cacheRetention: 'none',
        onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
          const changed = await options?.onPayload?.(payload, payloadModel);
          const body = (changed ?? payload) as Record<string, any>;
          const actualTemperature = config.protocol === 'google-generative-ai' ? body.config?.temperature ?? body.generationConfig?.temperature : body.temperature;
          if (parameters.temperature !== undefined && actualTemperature !== parameters.temperature) throw new Error('当前模型或协议不支持设置的 temperature，已拒绝静默忽略');
          const actualMax = config.protocol === 'google-generative-ai' ? body.config?.maxOutputTokens ?? body.generationConfig?.maxOutputTokens : body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
          if (actualMax !== maxTokens) throw new Error(`当前模型或协议不能原样应用 maxTokens=${maxTokens}，请调整参数`);
          return changed;
        },
      });
    };
    session.subscribe(event => {
      if (event.type === 'tool_execution_start') emit('tool', `调用 ${event.toolName}`);
      else if (event.type === 'tool_execution_end') emit('tool', `${event.toolName} ${event.isError ? '失败' : '完成'}`);
      else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') emit('text', event.assistantMessageEvent.delta);
    });
    aborted(signal);
    emit('model', `Pi · ${config.provider}/${config.model} · ${config.protocol}`);
    // No extensions or prompt templates are registered; user text remains literal input.
    await session.prompt(input.prompt, { expandPromptTemplates: false });
    aborted(signal);
    const last = [...session.messages].reverse().find(message => message.role === 'assistant');
    if (last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted')) throw new Error(last.errorMessage || '模型执行失败');
    // A length stop means the reply was cut at maxTokens; downstream JSON parsing would
    // only produce a misleading generic error, so fail here with the actionable cause.
    if (last?.role === 'assistant' && last.stopReason === 'length') throw new Error(`模型输出达到最大 Tokens 上限（maxTokens=${maxTokens}）被截断；请在 Agent 设置中提高「最大输出 Tokens」或精简需求后重试`);
    const text = session.getLastAssistantText();
    if (!text?.trim()) throw new Error('模型未返回有效文本结果');
    emit('complete', 'Agent 执行完成');
    return text;
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw new DOMException('任务已取消', 'AbortError');
    const message = redact(error instanceof Error ? error.message : String(error));
    // A dropped SSE body surfaces as a bare "terminated"/"fetch failed" from undici or
    // "Connection error." from the client SDK; translate so run logs explain the cause.
    if (/^(terminated|fetch failed|connection error\.?)$/i.test(message.trim())) throw new Error(`模型连接中断（${message}）；长输出可能超过上游流式时限，请换用更快的模型或精简需求后重试`);
    throw new Error(message);
  } finally {
    signal?.removeEventListener('abort', stop);
    session?.dispose();
    await Promise.allSettled(clients.map(client => client.close()));
    await rm(runDirectory, { recursive: true, force: true });
  }
}
