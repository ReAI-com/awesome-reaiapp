import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  Bot,
  Braces,
  Database,
  Layers,
  MessageSquare,
  Plug,
  Settings2,
  Sparkles,
} from "lucide-react";
import type { AgentConfig, AgentId } from "../shared/types";
import { pretty, request } from "./api";
import { Field, InlineError, Modal, SectionHead, Spinner } from "./components";
import { useWorkbench } from "./context";

const meta: Record<
  AgentId,
  { name: string; description: string; icon: typeof Database }
> = {
  "agent-001": {
    name: "清洗专家",
    description: "识别资料、路由规范，将原件整理为可靠的结构化数据。",
    icon: Database,
  },
  "agent-002": {
    name: "看板设计师",
    description: "理解你的工作需求，生成连接真实数据的独立看板。",
    icon: Layers,
  },
  "agent-003": {
    name: "岗位专家",
    description: "依据岗位资料回答问题，生成交付候选并检查业务规则。",
    icon: MessageSquare,
  },
};
export function AgentsView() {
  const { state, oauthEnabled } = useWorkbench();
  const [editing, setEditing] = useState<AgentConfig | null>(null);
  return (
    <div className="view-page">
      <SectionHead
        title="Agent 配置"
        subtitle="三位各司其职的 Agent，由 Pi 执行；每位都可以独立配置。"
      />
      {oauthEnabled && <WainaoModels />}
      <div className="agent-config-list">
        {state.agents.map((agent) => {
          const info = meta[agent.agentId];
          return (
            <article className="agent-config-card" key={agent.agentId}>
              <div className={`agent-avatar ${agent.agentId}`}>
                <info.icon size={26} />
              </div>
              <div className="agent-config-copy">
                <span className="eyebrow">{agent.agentId.toUpperCase()}</span>
                <h3>{info.name}</h3>
                <p>{info.description}</p>
                <div className="agent-tags">
                  <span>
                    <Bot size={13} />
                    {agent.model || "尚未配置模型"}
                  </span>
                  <span>
                    <Plug size={13} />
                    {agent.harness}
                  </span>
                  <span>{agent.tools.length} 个工具</span>
                </div>
              </div>
              <button className="button" onClick={() => setEditing(agent)}>
                <Settings2 size={15} />
                配置
                <ArrowRight size={14} />
              </button>
            </article>
          );
        })}
      </div>
      <div className="settings-note">
        <Braces size={20} />
        <div>
          <b>配置按岗位保存，变更用于新任务</b>
          <p>
            连接凭据仅保存在服务端。工具、MCP 与 Skill 由该 Agent
            的配置决定，不继承其他项目的设置。
          </p>
        </div>
      </div>
      {editing && (
        <AgentEditor
          key={`${editing.workspaceId}:${editing.agentId}`}
          config={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

interface GatewayModel { id: string; name?: string; display_name?: string }
function WainaoModels() {
  const { mutate, notify, state } = useWorkbench();
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [model, setModel] = useState(state.agents.find(agent => agent.provider === 'wainao')?.model || '');
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  async function loadModels() {
    setLoading(true); setError('');
    try {
      const result = await request<{ data: GatewayModel[] }>('/api/auth/models');
      const options = result.data.filter(item => typeof item.id === 'string' && item.id);
      setModels(options); setLoaded(true);
      setModel(current => options.some(item => item.id === current) ? current : options[0]?.id || '');
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }
  async function connect() {
    if (!model) return;
    setConnecting(true); setError('');
    try { await mutate('/agents/wainao', { model }); notify('三位 Agent 已连接外脑模型，后续任务将使用你的授权'); }
    catch (err) { setError((err as Error).message); }
    finally { setConnecting(false); }
  }
  return <section className="wainao-models panel" aria-labelledby="wainao-models-title">
    <div className="wainao-models-heading"><span className="auth-lock"><Plug size={21} /></span><div><h2 id="wainao-models-title">使用外脑模型</h2><p>用当前外脑账号授权此岗位的后台任务，费用按该账号的默认 Team 计费。退出登录将断开授权。</p></div></div>
    <div className="wainao-models-controls">
      <button className="button subtle" disabled={loading || connecting} onClick={() => void loadModels()}>{loading ? <Spinner /> : <Plug size={15} />}{loaded ? '刷新可用模型' : '读取可用模型'}</button>
      {models.length > 0 && <><select aria-label="外脑可用模型" value={model} disabled={connecting || loading} onChange={event => setModel(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.name || item.display_name || item.id}{(item.name || item.display_name) && (item.name || item.display_name) !== item.id ? ` · ${item.id}` : ''}</option>)}</select><button className="button primary" disabled={!model || connecting || loading} onClick={() => void connect()}>{connecting ? <Spinner /> : <Sparkles size={15} />}连接三位 Agent</button></>}
    </div>
    {loaded && !models.length && !error && <p className="footnote">当前授权没有可用的对话模型，请在外脑检查模型权限。</p>}
    <InlineError>{error}</InlineError>
  </section>;
}

function AgentEditor({
  config,
  onClose,
}: {
  config: AgentConfig;
  onClose: () => void;
}) {
  const { mutate, notify } = useWorkbench();
  const [draft, setDraft] = useState<AgentConfig>({
    ...config,
    apiKey: "",
    parameters: { ...config.parameters },
  });
  const [mcp, setMcp] = useState(pretty(config.mcp || {}));
  const [skills, setSkills] = useState(config.skills.join("\n"));
  const [tools, setTools] = useState(config.tools.join("\n"));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"model" | "behavior" | "extensions">("model");
  const usesOAuth = config.provider === 'wainao';
  const update = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (
        !draft.provider.trim() ||
        !draft.model.trim() ||
        !draft.protocol.trim()
      ) {
        setTab("model");
        throw new Error("请填写 Provider、模型名称和协议。");
      }
      if (draft.baseUrl && !/^https?:\/\//.test(draft.baseUrl)) {
        setTab("model");
        throw new Error("API Base URL 需要以 http:// 或 https:// 开头。");
      }
      const parsedMcp = JSON.parse(mcp || "{}");
      if (
        !parsedMcp ||
        Array.isArray(parsedMcp) ||
        typeof parsedMcp !== "object"
      )
        throw new Error("MCP 配置必须是 JSON 对象。");
      await mutate(
        `/agents/${config.agentId}`,
        {
          ...draft,
          tools: tools
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          skills: skills
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          mcp: parsedMcp,
        },
        "PUT",
      );
      notify(`${meta[config.agentId].name}的配置已保存`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={`配置${meta[config.agentId].name}`}
      subtitle={`${config.agentId.toUpperCase()} · 当前配置版本 ${config.version}`}
      onClose={onClose}
      wide
    >
      <form onSubmit={save} noValidate>
        <div className="tab-strip" role="tablist" aria-label="Agent 配置分类">
          {(
            [
              { id: "model", label: "模型连接" },
              { id: "behavior", label: "提示词与工具" },
              { id: "extensions", label: "MCP 与 Skills" },
            ] as const
          ).map((item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? "selected" : ""}
              onClick={() => setTab(item.id)}
              key={item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div hidden={tab !== "model"}>
          <div className="form-grid">
            <Field label="Provider">
              <input
                required
                readOnly={usesOAuth}
                value={draft.provider}
                onChange={(e) => update("provider", e.target.value)}
                placeholder="例如：openai 或自定义名称"
              />
            </Field>
            <Field label="模型名称">
              <input
                required
                value={draft.model}
                onChange={(e) => update("model", e.target.value)}
                placeholder="服务提供商的模型 ID"
              />
            </Field>
            <Field label="协议">
              <input
                required
                list="protocol-options"
                readOnly={usesOAuth}
                value={draft.protocol}
                onChange={(e) => update("protocol", e.target.value)}
              />
              <datalist id="protocol-options">
                <option value="openai-completions" />
                <option value="openai-responses" />
                <option value="anthropic-messages" />
                <option value="google-generative-ai" />
              </datalist>
            </Field>
            <Field label="Harness">
              <select value="pi" disabled>
                <option value="pi">Pi</option>
              </select>
            </Field>
          </div>
          <Field
            label="API Base URL"
            hint="Anthropic 填服务根地址，不带 /v1；其他协议填写对应的兼容端点。"
          >
            <input
              type="url"
              readOnly={usesOAuth}
              value={draft.baseUrl}
              onChange={(e) => update("baseUrl", e.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </Field>
          {usesOAuth ? <p className="footnote">此 Agent 使用外脑 OAuth 授权，无需填写 API Key。可在上方读取模型目录并重新连接。</p> : <Field
            label="API Key"
            hint={
              config.hasApiKey
                ? "已保存密钥。留空保持原值，填写新值可替换。"
                : "密钥保存在本地，不会发送给生成的看板。"
            }
          >
            <input
              type="password"
              autoComplete="new-password"
              value={draft.apiKey || ""}
              onChange={(e) => update("apiKey", e.target.value)}
              placeholder={
                config.hasApiKey ? "已保存 · 留空保持" : "输入 API Key"
              }
            />
          </Field>}
          <div className="form-grid three">
            <Field label="Temperature">
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.parameters.temperature ?? ""}
                onChange={(e) =>
                  update("parameters", {
                    ...draft.parameters,
                    temperature:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
                placeholder="默认"
              />
            </Field>
            <Field label="最大输出 Tokens">
              <input
                type="number"
                min={1}
                step={1}
                value={draft.parameters.maxTokens ?? ""}
                onChange={(e) =>
                  update("parameters", {
                    ...draft.parameters,
                    maxTokens:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  })
                }
                placeholder="默认"
              />
            </Field>
            <Field label="思考等级">
              <select
                value={draft.parameters.thinkingLevel || "off"}
                onChange={(e) =>
                  update("parameters", {
                    ...draft.parameters,
                    thinkingLevel: e.target.value,
                  })
                }
              >
                {["off", "minimal", "low", "medium", "high", "xhigh"].map(
                  (value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ),
                )}
              </select>
            </Field>
          </div>
          <p className="footnote">
            参数是否可用取决于模型和协议；不支持的配置会明确报错。
          </p>
        </div>
        <div hidden={tab !== "behavior"}>
          <Field label="系统提示词">
            <textarea
              rows={10}
              value={draft.prompt}
              onChange={(e) => update("prompt", e.target.value)}
              placeholder="定义职责、回复方式和工作规则…"
            />
          </Field>
          <Field
            label="允许的工具"
            hint="每行一个。内置业务工具：read_schema、query_records、inspect_source（清洗时使用）。"
          >
            <textarea
              className="monospace"
              rows={5}
              value={tools}
              onChange={(e) => setTools(e.target.value)}
            />
          </Field>
        </div>
        <div hidden={tab !== "extensions"}>
          <Field
            label="MCP 配置（JSON）"
            hint={
              '支持 stdio 和 Streamable HTTP，例如 {"mcpServers":{"example":{"url":"https://example.com/mcp"}}}。工具白名单需包含 mcp__example__*；不继承全局配置。'
            }
          >
            <textarea
              className="monospace"
              rows={11}
              value={mcp}
              onChange={(e) => setMcp(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field
            label="Skills 文件或目录"
            hint="每行一个明确的本地路径，使用该 Agent 自己的 Skill 配置。"
          >
            <textarea
              className="monospace"
              rows={5}
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              placeholder="/absolute/path/to/skill/SKILL.md"
            />
          </Field>
        </div>
        <InlineError>{error}</InlineError>
        <div className="form-footer">
          <button type="button" className="button subtle" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? <Spinner /> : <CheckIcon />}保存配置
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CheckIcon() {
  return <Sparkles size={15} />;
}
