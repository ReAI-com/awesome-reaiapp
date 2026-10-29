import { useRef, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Braces,
  CircleCheck,
  Database,
  File,
  FileText,
  FolderOpen,
  History,
  ListFilter,
  Play,
  Plus,
  Search,
  Settings2,
  Upload,
  Workflow,
} from "lucide-react";
import type {
  AgentRun,
  CleaningSpec,
  DataRecord,
  JsonSchema,
} from "../shared/types";
import {
  activeStatus,
  bytes,
  pretty,
  request,
  time,
  uploadFiles,
  valueText,
} from "./api";
import {
  Badge,
  Empty,
  Field,
  InlineError,
  Modal,
  RunDetail,
  SectionHead,
  Spinner,
} from "./components";
import { useWorkbench } from "./context";

export function Overview() {
  const { state, navigate, canAdmin, oauthEnabled } = useWorkbench();
  const clean = state.files.filter((f) =>
    ["清洗完成", "更新完成"].includes(f.state),
  ).length;
  const active = state.runs.filter((r) => activeStatus(r.status));
  const configured = state.agents.some((a) => a.model);
  return (
    <div className="view-page overview">
      <div className="overview-intro">
        <div>
          <span className="eyebrow">{oauthEnabled ? 'YOUR WORKSPACE' : 'YOUR LOCAL WORKSPACE'}</span>
          <h1>
            工作有据，
            <br />
            <span>协作有序。</span>
          </h1>
          <p>
            {state.workspace.role ||
              "从原始资料到可靠数据，再到每一份工作成果。"}
          </p>
          <button className="button primary" onClick={() => navigate("files")}>
            <Upload size={16} />
            添加工作资料
            <ArrowRight size={16} />
          </button>
        </div>
        <div className="flow-illustration" aria-hidden="true">
          <div className="flow-orbit outer" />
          <div className="flow-orbit inner" />
          <div className="flow-node source">
            <FileText size={23} />
            <span>资料</span>
          </div>
          <div className="flow-node core">
            <Database size={30} />
            <span>可靠的数据</span>
          </div>
          <div className="flow-node output">
            <CircleCheck size={23} />
            <span>成果</span>
          </div>
          <span className="flow-dot one" />
          <span className="flow-dot two" />
          <div className="flow-caption">有来源 · 有版本 · 可追溯</div>
        </div>
      </div>
      <div className="stats-strip">
        {[
          {
            label: "工作资料",
            number: state.files.length,
            sub: `${clean} 份已完成清洗`,
            icon: FileText,
            target: "files",
          },
          {
            label: "结构化记录",
            number: state.records.length,
            sub: `${state.datasets.length} 个数据表`,
            icon: Database,
            target: canAdmin ? "data" : "finance",
          },
          {
            label: "主题看板",
            number: state.boards.filter((b) => b.status === "published").length,
            sub: `${state.boards.filter((b) => b.status === "draft").length} 个待确认`,
            icon: Braces,
            target: "boards",
          },
          {
            label: "正在执行",
            number: active.length,
            sub: "岗位 Agent 的当前任务",
            icon: Workflow,
            target: "runs",
          },
        ].map((item) => (
          <button
            className="stat-item"
            key={item.label}
            onClick={() => navigate(item.target)}
          >
            <div className="stat-label">
              <item.icon size={16} />
              {item.label}
            </div>
            <strong>
              {item.number}
              <span>↗</span>
            </strong>
            <small>{item.sub}</small>
          </button>
        ))}
      </div>
      {!configured && canAdmin && (
        <div className="setup-note">
          <Settings2 size={19} />
          <div>
            <b>让你的第一位 AI 员工开始工作</b>
            <p>{canAdmin ? '配置模型和连接信息后，即可清洗资料、生成看板和咨询岗位专家。' : '请联系管理员配置模型，随后即可清洗资料、生成看板和咨询岗位专家。'}</p>
          </div>
          {canAdmin && <button className="button subtle" onClick={() => navigate("agents")}>
            配置 Agent
            <ArrowRight size={14} />
          </button>}
        </div>
      )}
      <div className="overview-grid">
        <section className="panel">
          <SectionHead
            title="最近的资料"
            action={
              <button className="text-button" onClick={() => navigate("files")}>
                查看全部
                <ArrowRight size={14} />
              </button>
            }
          />
          {state.files.length ? (
            <div className="recent-list">
              {[...state.files]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5)
                .map((file) => (
                  <button
                    className="recent-item"
                    key={file.id}
                    onClick={() => navigate("files")}
                  >
                    <span className="file-icon">
                      <FileText size={18} />
                    </span>
                    <div>
                      <b>{file.name}</b>
                      <small>
                        {bytes(file.size)} · {time(file.updatedAt)}
                      </small>
                    </div>
                    <Badge value={file.error ? 'failed' : state.runs.filter(run => run.fileId === file.id).at(-1)?.status === 'waiting_review' ? 'waiting_review' : file.state} />
                  </button>
                ))}
            </div>
          ) : (
            <Empty
              icon={<FolderOpen size={25} />}
              title="这里还没有工作资料"
              description="上传文件，或从工作目录读取。"
              action={
                <button
                  className="text-button"
                  onClick={() => navigate("files")}
                >
                  添加第一份资料
                  <ArrowRight size={14} />
                </button>
              }
            />
          )}
        </section>
        <section className="panel">
          <SectionHead title="工作路径" subtitle="每一步都有清楚的来处与去向" />
          <div className="journey-list">
            {[
              {
                n: "01",
                title: "归集资料",
                text: "上传原件，保存每次更新。",
                icon: FolderOpen,
                view: "files",
              },
              {
                n: "02",
                title: "整理成可用的数据",
                text: "按岗位规范清洗，核验后入库。",
                icon: Database,
                view: canAdmin ? "specs" : "files",
              },
              {
                n: "03",
                title: "让数据参与工作",
                text: "创建看板、生成交付物、检查规则。",
                icon: Workflow,
                view: "boards",
              },
            ].map((item) => (
              <button key={item.n} onClick={() => navigate(item.view)}>
                <span className="journey-number">{item.n}</span>
                <div>
                  <b>{item.title}</b>
                  <p>{item.text}</p>
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function FilesView() {
  const { state, base, mutate, refresh, notify, canAdmin, oauthEnabled } = useWorkbench();
  const fileInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [drag, setDrag] = useState(false);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [history, setHistory] = useState<{
    name: string;
    value: unknown;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  async function upload(files: File[]) {
    if (!files.length || uploading) return;
    setUploading(true);
    setProgress(0);
    try {
      await uploadFiles(`${base}/uploads`, files, setProgress);
      await refresh();
      notify(`已保存 ${files.length} 份资料${state.workspace.autoClean ? '，将自动识别规范并清洗入库' : ''}`);
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function scan() {
    setScanning(true);
    try {
      await mutate("/scan");
      notify("工作目录已扫描，文件列表已更新");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setScanning(false);
    }
  }
  async function clean(id: string) {
    setPending(id);
    try {
      await mutate(`/files/${id}/clean`);
      notify("清洗任务已提交");
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setPending(null);
    }
  }
  const filtered = state.files.filter((file) =>
    file.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="view-page">
      <SectionHead
        title="资料库"
        subtitle="原始文件始终保留，清洗与更新都有记录。"
        action={
          <button
            className="button primary"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? <Spinner /> : <Upload size={16} />}上传文件
          </button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label="上传工作资料"
        onChange={(e) => void upload(Array.from(e.target.files || []))}
      />
      <div className="directory-card">
        <span className="folder-icon">
          <FolderOpen size={23} />
        </span>
        <div>
          <small>{oauthEnabled ? '服务器工作目录' : '当前工作目录'}</small>
          <code title={state.workspace.directory}>
            {state.workspace.directory}
          </code>
        </div>
        {canAdmin && <button
          className="button subtle"
          onClick={() => void scan()}
          disabled={scanning}
        >
          {scanning ? <Spinner /> : <ArrowDownToLine size={15} />}
          {scanning ? "扫描中" : "扫描目录"}
        </button>}
      </div>
      <div className="info-line">
        <Workflow size={17} />
        <div><b>{state.workspace.autoClean ? '自动归集已开启' : '上传后手动清洗'}</b><p className="form-hint">开启后，新上传或目录中更新的文件会按规范自动清洗；异常进入运行记录与待复核，不覆盖已发布数据。</p></div>
        {canAdmin && <button className="button subtle small" role="switch" aria-label="上传后自动清洗" aria-checked={!!state.workspace.autoClean} onClick={() => void mutate('/automation', { autoClean: !state.workspace.autoClean }).then(() => notify(state.workspace.autoClean ? '已关闭自动清洗' : '已开启自动清洗')).catch(err => notify(err.message, true))}>{state.workspace.autoClean ? '关闭自动清洗' : '开启自动清洗'}</button>}
      </div>
      <div
        className={`drop-zone ${drag ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void upload(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={23} />
        <div>
          <b>
            {uploading
              ? progress < 100
                ? `上传中 · ${progress}%`
                : "文件已传输，正在保存原件…"
              : "拖入文件，开始整理"}
          </b>
          <p>
            {uploading
              ? "正在将文件保存到当前工作目录"
              : "或点击右上角上传文件 · 文本、表格、Word 和有文本的 PDF 可自动清洗"}
          </p>
        </div>
        {uploading && (
          <progress max={100} value={progress} aria-label="上传进度" />
        )}
      </div>
      <div className="table-toolbar">
        <label className="search-input">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="查找资料…"
            aria-label="查找资料"
          />
        </label>
        <span className="muted">{filtered.length} 份资料</span>
      </div>
      {filtered.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>文件名称</th>
                <th>清洗状态</th>
                <th>最近更新</th>
                <th className="align-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((file) => {
                const latestRun = state.runs
                  .filter((r) => r.fileId === file.id)
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                const running = latestRun && activeStatus(latestRun.status);
                const failed =
                  latestRun &&
                  ["failed", "cancelled", "interrupted", "superseded"].includes(
                    latestRun.status,
                  );
                return (
                  <tr key={file.id}>
                    <td>
                      <div className="file-cell">
                        <span className="file-icon">
                          <FileText size={19} />
                        </span>
                        <div>
                          <b>{file.name}</b>
                          <small>
                            {bytes(file.size)}
                            {file.cleanedRevisionId === file.revisionId &&
                            ["清洗完成", "更新完成"].includes(file.state)
                              ? " · 已清洗"
                              : ""}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="status-stack">
                        <Badge value={file.state} />
                        {failed && <Badge value={latestRun.status} />}
                        {latestRun?.status === "waiting_review" && (
                          <Badge value="waiting_review" />
                        )}
                        {file.error && (
                          <span className="file-error" title={file.error}>
                            {file.error}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="muted nowrap">{time(file.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="button small"
                          disabled={!!running || pending === file.id}
                          onClick={() => void clean(file.id)}
                        >
                          {pending === file.id ? (
                            <Spinner />
                          ) : (
                            <Play size={13} />
                          )}
                          {running
                            ? "处理中"
                            : failed
                              ? "重试清洗"
                              : file.state === "有更新"
                                ? "更新数据"
                                : "清洗"}
                        </button>
                        {latestRun && (
                          <button
                            className="icon-button"
                            aria-label={`查看 ${file.name} 的运行记录`}
                            title="运行记录"
                            onClick={() => setRun(latestRun)}
                          >
                            <Workflow size={16} />
                          </button>
                        )}
                        <button
                          className="icon-button"
                          aria-label={`查看 ${file.name} 的版本历史`}
                          title="版本历史"
                          onClick={() =>
                            void request(`${base}/files/${file.id}/history`)
                              .then((value) =>
                                setHistory({ name: file.name, value }),
                              )
                              .catch((e) => notify(e.message, true))
                          }
                        >
                          <History size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          icon={<File size={27} />}
          title={query ? "没有找到匹配资料" : "工作资料将出现在这里"}
          description={
            query
              ? "试试其他关键词。"
              : "上传后的原件会保存到工作目录，完成清洗后就能用于看板和岗位问答。"
          }
        />
      )}
      {run && <RunDetail run={run} onClose={() => setRun(null)} />}
      {history && (
        <Modal
          title="原件版本历史"
          subtitle={history.name}
          onClose={() => setHistory(null)}
          wide
        >
          <pre className="code-block">{pretty(history.value)}</pre>
        </Modal>
      )}
    </div>
  );
}

export function SpecsView() {
  const { state } = useWorkbench();
  const [editing, setEditing] = useState<CleaningSpec | "new" | null>(null);
  return (
    <div className="view-page">
      <SectionHead
        title="清洗规范"
        subtitle="告诉清洗 Agent 如何识别资料、整理字段和核验结果。"
        action={
          <button className="button primary" onClick={() => setEditing("new")}>
            <Plus size={16} />
            新增规范
          </button>
        }
      />
      <div className="info-line">
        <Workflow size={17} />
        <span>
          清洗 Agent 根据文件内容和匹配条件路由规范；未定义 Schema
          时，在清洗过程中自动生成。
        </span>
      </div>
      {state.specs.length ? (
        <div className="spec-grid">
          {state.specs.map((spec, index) => (
            <article className="spec-card" key={spec.id}>
              <div className="between">
                <span className="spec-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="version-label">版本 {spec.version}</span>
              </div>
              <h3>{spec.name}</h3>
              <p>{spec.description || "通用的结构化数据清洗规范"}</p>
              <div className="spec-rule">
                <ListFilter size={15} />
                <span>{spec.match || "由 Agent 根据内容匹配"}</span>
              </div>
              <div className="spec-footer">
                <span>
                  <Braces size={14} />
                  {spec.schema
                    ? `${Object.keys(spec.schema.properties).length} 个字段`
                    : "自动定义结构"}
                </span>
                <button
                  className="text-button"
                  onClick={() => setEditing(spec)}
                >
                  编辑规范
                  <ArrowRight size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<Workflow size={25} />}
          title="为岗位定义第一条清洗规范"
          description="将业务要求写成提示词，Agent 会按规范完成资料清洗。"
          action={
            <button className="button" onClick={() => setEditing("new")}>
              新增规范
            </button>
          }
        />
      )}
      {editing && (
        <SpecEditor
          spec={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function SpecEditor({
  spec,
  onClose,
}: {
  spec?: CleaningSpec;
  onClose: () => void;
}) {
  const { mutate, notify } = useWorkbench();
  const [name, setName] = useState(spec?.name || "");
  const [description, setDescription] = useState(spec?.description || "");
  const [match, setMatch] = useState(spec?.match || "");
  const [prompt, setPrompt] = useState(spec?.prompt || "");
  const [schema, setSchema] = useState(spec?.schema ? pretty(spec.schema) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const parsed = schema.trim()
        ? (JSON.parse(schema) as JsonSchema)
        : undefined;
      if (parsed && (parsed.type !== "object" || !parsed.properties))
        throw new Error('Schema 需要 type: "object" 和 properties 字段。');
      await mutate(
        spec ? `/specs/${spec.id}` : "/specs",
        {
          name,
          description,
          match,
          prompt,
          schema: parsed,
          ...(spec ? { version: spec.version } : {}),
        },
        spec ? "PUT" : "POST",
      );
      notify("清洗规范已保存");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={spec ? "编辑清洗规范" : "新增清洗规范"}
      subtitle="规范修改会生成新版本，历史清洗记录保持可追溯。"
      onClose={onClose}
      wide
    >
      <form onSubmit={save}>
        <div className="form-grid">
          <Field label="规范名称">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：销售订单清洗"
            />
          </Field>
          <Field label="匹配条件">
            <input
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              placeholder="例如：包含订单、客户或销售金额的表格"
            />
          </Field>
        </div>
        <Field label="用途说明">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这条规范处理什么资料"
          />
        </Field>
        <Field label="清洗提示词">
          <textarea
            required
            rows={7}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="说明字段含义、单位、格式、去重规则，以及遇到缺失数据时的处理方式…"
          />
        </Field>
        <details className="schema-editor" open={!!spec?.schema}>
          <summary>
            <Braces size={16} />
            数据库 Schema（可选）
          </summary>
          <p className="muted">
            留空时由 Agent 自动定义；也可以填写 JSON Schema 明确字段和必填规则。
          </p>
          <textarea
            className="monospace"
            rows={10}
            aria-label="清洗 Schema JSON"
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            placeholder={
              '{\n  "type": "object",\n  "properties": { "name": { "type": "string" } },\n  "required": ["name"]\n}'
            }
          />
        </details>
        <InlineError>{error}</InlineError>
        <div className="form-footer">
          <button type="button" className="button subtle" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <Spinner />}保存规范
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DatabaseView() {
  const { state, base, notify } = useWorkbench();
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [schema, setSchema] = useState(false);
  const [editing, setEditing] = useState<DataRecord | null>(null);
  const [history, setHistory] = useState<unknown>(null);
  const dataset =
    state.datasets.find((d) => d.id === selected) || state.datasets[0];
  const records = state.records.filter(
    (r) =>
      r.datasetId === dataset?.id &&
      JSON.stringify(r.data).toLowerCase().includes(query.toLowerCase()),
  );
  const columns = dataset ? Object.entries(dataset.schema.properties) : [];
  return (
    <div className="view-page">
      <SectionHead
        title="结构化数据库"
        subtitle="查看已发布的数据表、字段结构与可追溯的记录版本。"
        action={
          dataset && (
            <button className="button" onClick={() => setSchema(true)}>
              <Braces size={16} />
              查看 Schema
            </button>
          )
        }
      />
      {!state.datasets.length ? (
        <Empty
          icon={<Database size={27} />}
          title="等待第一批结构化数据"
          description="完成资料清洗后，数据表会自动出现在这里。"
        />
      ) : (
        <>
          <div className="table-toolbar">
            <select
              className="dataset-select"
              aria-label="选择数据表"
              value={dataset?.id}
              onChange={(e) => {
                setSelected(e.target.value);
                setQuery("");
              }}
            >
              {state.datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · v{d.version}
                </option>
              ))}
            </select>
            <label className="search-input">
              <Search size={16} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索结构化记录"
                placeholder="搜索记录…"
              />
            </label>
            <span className="muted">{records.length} 条</span>
          </div>
          <div className="table-wrap data-table">
            <table>
              <thead>
                <tr>
                  {columns.map(([key, field]) => (
                    <th key={key}>
                      <span>{field.title || key}</span>
                      <small>{field.type}</small>
                    </th>
                  ))}
                  <th>版本</th>
                  <th>来源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    {columns.map(([key]) => (
                      <td key={key} title={valueText(record.data[key])}>
                        {valueText(record.data[key])}
                      </td>
                    ))}
                    <td className="monospace">
                      v{record.version}
                      {record.manual && (
                        <span className="manual-dot" title="人工修订" />
                      )}
                    </td>
                    <td>
                      {state.files.find((f) => f.id === record.sourceFileId)
                        ?.name || "人工录入"}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          onClick={() => setEditing(record)}
                        >
                          修订
                        </button>
                        <button
                          className="icon-button"
                          aria-label="查看记录历史"
                          onClick={() =>
                            void request(`${base}/records/${record.id}/history`)
                              .then(setHistory)
                              .catch((e) => notify(e.message, true))
                          }
                        >
                          <History size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!records.length && <Empty title="暂无匹配记录" />}
          </div>
          <p className="footnote">
            修改生成新版本并保留原始来源。清洗更新遇到人工修订时，不会静默覆盖。
          </p>
        </>
      )}
      {schema && dataset && (
        <Modal
          title={`${dataset.name} · Schema`}
          subtitle={`数据结构版本 ${dataset.version}`}
          onClose={() => setSchema(false)}
          wide
        >
          <pre className="code-block">{pretty(dataset.schema)}</pre>
        </Modal>
      )}
      {editing && (
        <RecordEditor record={editing} onClose={() => setEditing(null)} />
      )}
      {!!history && (
        <Modal title="记录修订历史" onClose={() => setHistory(null)} wide>
          <pre className="code-block">{pretty(history)}</pre>
        </Modal>
      )}
    </div>
  );
}

function RecordEditor({
  record,
  onClose,
}: {
  record: DataRecord;
  onClose: () => void;
}) {
  const { mutate, notify } = useWorkbench();
  const [data, setData] = useState(pretty(record.data));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await mutate(`/records/${record.id}`, {
        version: record.version,
        data: JSON.parse(data),
      });
      notify("已保存新的数据版本");
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="修订数据记录"
      subtitle={`基于版本 ${record.version} 修改，原版本会保留。`}
      onClose={onClose}
      wide
    >
      <form onSubmit={save}>
        <Field label="记录内容（JSON）">
          <textarea
            className="monospace"
            rows={16}
            value={data}
            onChange={(e) => setData(e.target.value)}
            required
          />
        </Field>
        <InlineError>{error}</InlineError>
        <div className="form-footer">
          <button type="button" className="button subtle" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={saving}>
            {saving && <Spinner />}保存新版本
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RunsView() {
  const { state } = useWorkbench();
  const [selected, setSelected] = useState<AgentRun | null>(null);
  const kind: Record<string, string> = {
    clean: "资料清洗",
    board: "看板生成",
    chat: "岗位问答",
    deliverable: "交付物生成",
    check: "规则检查",
  };
  return (
    <div className="view-page">
      <SectionHead
        title="运行记录"
        subtitle="查看 Agent 的真实执行步骤、结果与恢复信息。"
      />
      {state.runs.length ? (
        <div className="panel run-list">
          {[...state.runs]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((run) => (
              <button key={run.id} onClick={() => setSelected(run)}>
                <span
                  className={`run-icon ${run.status === "failed" ? "error" : ""}`}
                >
                  {activeStatus(run.status) ? (
                    <Spinner />
                  ) : (
                    <Workflow size={19} />
                  )}
                </span>
                <div>
                  <b>{kind[run.kind] || run.kind}</b>
                  <p>
                    {state.files.find((f) => f.id === run.fileId)?.name ||
                      run.events.at(-1)?.message ||
                      run.agentId}
                  </p>
                  <small>
                    {time(run.createdAt)} · {run.agentId.toUpperCase()}
                  </small>
                </div>
                <Badge value={run.status} />
                <ArrowRight size={16} />
              </button>
            ))}
        </div>
      ) : (
        <Empty
          icon={<Workflow size={27} />}
          title="还没有运行记录"
          description="上传资料并发起清洗，或让 Agent 帮你完成一项工作。"
        />
      )}
      {selected && (
        <RunDetail run={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
