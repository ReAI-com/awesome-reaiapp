import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  CircleAlert,
  FileCheck2,
  FileOutput,
  LayoutDashboard,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  SquareArrowOutUpRight,
  Undo2,
} from "lucide-react";
import type { Board, Deliverable } from "../shared/types";
import { activeStatus, time } from "./api";
import {
  Badge,
  Empty,
  Field,
  InlineError,
  Modal,
  SectionHead,
  Spinner,
} from "./components";
import { useWorkbench } from "./context";
import { BoardControls } from './BoardControls';
import { MarkdownContent } from './MarkdownContent';

export function BoardsView({ boardId }: { boardId?: string }) {
  const { state, base, mutate, notify, navigate, refresh } = useWorkbench();
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const preview = useRef<HTMLIFrameElement>(null);
  const board = state.boards.find((item) => item.id === boardId);
  useEffect(() => {
    if (!board) return;
    let refreshing = false;
    const updated = (event: MessageEvent) => {
      // Sandboxed boards have an opaque origin; bind messages to this exact frame.
      if (!preview.current || event.source !== preview.current.contentWindow || !event.data ||
        event.data.type !== 'maoding-board-update' || event.data.boardId !== board.id ||
        !Number.isSafeInteger(event.data.version) || event.data.version <= (board.version || 1) || refreshing) return;
      refreshing = true;
      void refresh().catch(error => notify(error.message, true)).finally(() => { refreshing = false; });
    };
    window.addEventListener('message', updated);
    return () => window.removeEventListener('message', updated);
  }, [board?.id, board?.version, refresh, notify]);
  const runs = state.runs
    .filter((r) => r.kind === "board")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = runs.some((r) => activeStatus(r.status));
  async function generate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("/boards/generate", { prompt });
      setCreating(false);
      setPrompt("");
      notify("看板生成任务已提交，可在运行记录中查看进度");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function publish(item: Board) {
    setBusy(true);
    try {
      await mutate(`/boards/${item.id}/publish`);
      notify("看板已加入侧栏");
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`view-page ${board ? "board-page" : ""}`}>
      <SectionHead
        title={board ? board.name : "主题看板"}
        subtitle={
          board
            ? board.description
            : "每个看板，都是为当前岗位生成的独立工作界面。"
        }
        action={
          board ? (
            <div className="button-group">
              <a className="button subtle" href={`${base}/boards/${board.id}/preview`} target="_blank" rel="noopener noreferrer" title="作为独立 WebApp 打开">
                <SquareArrowOutUpRight size={15} />独立打开
              </a>
              <button
                className="button subtle"
                onClick={() => navigate("boards")}
              >
                全部看板
              </button>
              {board.status === "draft" && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void publish(board)}
                >
                  {busy ? <Spinner /> : <Check size={16} />}确认添加
                </button>
              )}
            </div>
          ) : (
            <button
              className="button primary"
              onClick={() => setCreating(true)}
            >
              <Plus size={16} />
              生成看板
            </button>
          )
        }
      />
      {board ? (
        <>
          <div
            className={`board-preview-note ${board.status === "draft" ? "draft" : ""}`}
          >
            <Badge value={board.status} />
            <span>
              {board.status === "draft"
                ? "先确认界面与数据，再将看板加入工作区。"
                : "读取当前工作区的已发布数据。"}
            </span>
          </div>
          <BoardControls key={board.id} board={board} onRefresh={() => setPreviewRefresh(value => value + 1)} />
          <div className="browser-frame">
            <div className="browser-bar">
              <span />
              <span />
              <span />
              <code>{board.name}</code>
              <Braces size={14} />
            </div>
            <iframe
              ref={preview}
              key={`${board.id}:${board.version || 1}:${previewRefresh}`}
              className="board-frame"
              title={`${board.name} 看板预览`}
              src={`${base}/boards/${board.id}/preview?v=${board.version || 1}`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </div>
        </>
      ) : (
        <>
          {running && (
            <div className="info-line">
              <Spinner />
              <span>Agent-002 正在生成看板，完成后会出现在下方。</span>
              <button className="text-button" onClick={() => navigate("runs")}>
                查看进度
                <ArrowRight size={13} />
              </button>
            </div>
          )}
          {runs[0]?.status === "failed" && (
            <InlineError>
              {runs[0].error || "最近一次看板生成失败，请查看运行记录后重试。"}
            </InlineError>
          )}
          {state.boards.length ? (
            <div className="board-grid">
              {state.boards.map((item, index) => (
                <button
                  className="board-card"
                  key={item.id}
                  onClick={() => navigate(`board:${item.id}`)}
                >
                  <div className={`board-art theme-${index % 3}`}>
                    <div className="mini-sidebar" />
                    <div className="mini-layout">
                      <div />
                      <div />
                      <div className="mini-chart">
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                    <span className="board-art-icon">
                      <SquareArrowOutUpRight size={19} />
                    </span>
                  </div>
                  <div className="board-card-copy">
                    <div className="between">
                      <h3>{item.name}</h3>
                      <Badge value={item.status} />
                    </div>
                    <p>{item.description || item.prompt}</p>
                    <div className="between">
                      <small>{time(item.createdAt)}</small>
                      <ArrowRight size={17} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            !running && (
              <Empty
                icon={<LayoutDashboard size={29} />}
                title="把你想看的，变成一个看板"
                description="例如“按月份查看销售收入，并列出尚未回款的订单”。Agent 会根据当前数据生成界面。"
                action={
                  <button
                    className="button primary"
                    onClick={() => setCreating(true)}
                  >
                    <Sparkles size={16} />
                    创建第一个看板
                  </button>
                }
              />
            )
          )}
        </>
      )}
      {creating && (
        <Modal
          title="让 Agent 生成看板"
          subtitle="描述看板的用途、展示内容和需要的操作。"
          onClose={() => setCreating(false)}
        >
          <form onSubmit={generate}>
            <Field label="看板需求">
              <textarea
                rows={7}
                required
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="我想看一个按月份汇总的收支看板，包含收入、支出和净额，也能展开查看对应记录…"
              />
            </Field>
            <p className="form-hint">
              <DatabaseMark />
              当前可用：{state.datasets.length} 个数据表，{state.records.length}{" "}
              条已发布记录。
            </p>
            <InlineError>{error}</InlineError>
            <div className="form-footer">
              <button
                type="button"
                className="button subtle"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button
                className="button primary"
                disabled={busy || !prompt.trim()}
              >
                {busy ? <Spinner /> : <Sparkles size={16} />}开始生成
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function DatabaseMark() {
  return <Braces size={15} />;
}

function inputStale(
  versions: { id: string; version: number }[],
  records: { id: string; version: number }[],
) {
  return versions.length !== records.length || versions.some(
    (version) =>
      records.find((r) => r.id === version.id)?.version !== version.version,
  );
}
export function DeliverablesView() {
  const { state, mutate, notify, navigate } = useWorkbench();
  const [creating, setCreating] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [signing, setSigning] = useState<Deliverable | null>(null);
  const [signature, setSignature] = useState("");
  const [signError, setSignError] = useState("");
  const current = state.deliverables.find((d) => d.id === selected);
  const latestRun = state.runs
    .filter((r) => r.kind === "deliverable")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  async function generate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("/deliverables", { title, prompt });
      setCreating(false);
      setPrompt("");
      setTitle("");
      notify("交付物生成任务已提交");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(path: string, message: string, body?: unknown) {
    setBusy(true);
    try {
      await mutate(path, body);
      notify(message);
    } catch (err) {
      notify((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function sign(e: FormEvent) {
    e.preventDefault();
    if (!signing) return;
    setBusy(true);
    setSignError("");
    try {
      await mutate(`/deliverables/${signing.id}/sign`, { signature });
      setSigning(null);
      setSignature("");
      notify("签字回执已保存");
    } catch (err) {
      setSignError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-page">
      <SectionHead
        title="交付台"
        subtitle="从数据生成候选，由你选定和签字，留下完整的交付记录。"
        action={
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            生成交付物
          </button>
        }
      />
      {latestRun && activeStatus(latestRun.status) && (
        <div className="info-line">
          <Spinner />
          正在生成交付候选…
          <button className="text-button" onClick={() => navigate("runs")}>
            查看进度
          </button>
        </div>
      )}
      {latestRun?.status === "failed" && (
        <InlineError>{latestRun.error}</InlineError>
      )}
      {state.deliverables.length ? (
        <div className="deliverable-grid">
          {[...state.deliverables].reverse().map((item) => (
            <button
              className="deliverable-card"
              key={item.id}
              onClick={() => setSelected(item.id)}
            >
              <div className="between">
                <FileOutput size={23} />
                <Badge value={item.status} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.content.slice(0, 160)}</p>
              {inputStale(item.inputVersions, state.records) && (
                <span className="stale-note">
                  <CircleAlert size={13} />
                  输入数据已更新
                </span>
              )}
              <div className="spec-footer">
                <small>{time(item.createdAt)}</small>
                <span>
                  查看候选
                  <ArrowRight size={14} />
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          icon={<FileOutput size={27} />}
          title="下一份成果，从可靠数据出发"
          description="生成简报、报告或方案；确认候选后签字，也可以将内容回流为新的资料。"
        />
      )}
      {creating && (
        <Modal title="生成交付物" onClose={() => setCreating(false)}>
          <form onSubmit={generate}>
            <Field label="标题">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：本月经营简报"
              />
            </Field>
            <Field label="交付要求">
              <textarea
                required
                rows={7}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="说明用途、面向谁、需要哪些分析以及输出格式…"
              />
            </Field>
            <InlineError>{error}</InlineError>
            <div className="form-footer">
              <button
                type="button"
                className="button subtle"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner /> : <Sparkles size={16} />}生成候选
              </button>
            </div>
          </form>
        </Modal>
      )}
      {current && !signing && (
        <Modal
          title={current.title}
          subtitle={`候选版本 ${current.version} · ${time(current.createdAt)}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="between">
            <Badge value={current.status} />
            <span className="muted">
              引用 {current.inputVersions.length} 条数据
            </span>
          </div>
          {inputStale(current.inputVersions, state.records) && (
            <div className="info-line warn">
              <CircleAlert size={17} />
              输入数据已更新，此候选与签字仍基于生成时的版本。
            </div>
          )}
          <div className="document-content"><MarkdownContent content={current.content} records={state.records} /></div>
          {current.signedAt && (
            <div className="signature-receipt">
              <FileCheck2 size={19} />
              <div>
                <b>{current.signature}</b>
                <p>已签字 · {time(current.signedAt)}</p>
              </div>
            </div>
          )}
          <details className="technical">
            <summary>查看输入数据版本</summary>
            <ul>
              {current.inputVersions.map((version) => (
                <li key={version.id}>
                  <code>{version.id}</code> · v{version.version}
                </li>
              ))}
            </ul>
          </details>
          <div className="form-footer">
            {current.status === "candidate" && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void action(
                    `/deliverables/${current.id}/select`,
                    "已选定此候选",
                  )
                }
              >
                <Check size={16} />
                选定此候选
              </button>
            )}
            {current.status === "selected" && (
              <button
                className="button primary"
                onClick={() => {
                  setSigning(current);
                  setSignError("");
                }}
              >
                签字确认
              </button>
            )}
            {current.status === "signed" && (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void action(
                    `/deliverables/${current.id}/reflow`,
                    "已保存为新资料，可在资料库继续清洗",
                  )
                }
              >
                <Undo2 size={16} />
                回流为新资料
              </button>
            )}
          </div>
        </Modal>
      )}
      {signing && (
        <Modal
          title="签字确认交付物"
          subtitle={signing.title}
          onClose={() => setSigning(null)}
        >
          <form onSubmit={sign}>
            <p className="muted">
              签字将绑定当前候选版本和输入数据版本，并保存确认时间。
            </p>
            <Field label="签字人">
              <input
                required
                value={signature}
                onChange={(e) => setSignature(e.target.value)}
                placeholder="输入你的姓名"
              />
            </Field>
            <InlineError>{signError}</InlineError>
            <div className="form-footer">
              <button
                type="button"
                className="button subtle"
                onClick={() => setSigning(null)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy && <Spinner />}确认签字
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function ChecksView() {
  const { state, mutate, navigate, notify } = useWorkbench();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [rule, setRule] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latestRun = state.runs
    .filter((r) => r.kind === "check")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate("/checks", { name, rule });
      setCreating(false);
      notify("检查任务已提交");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-page">
      <SectionHead
        title="规则检查"
        subtitle="按明确规则检查当前数据，每次结论都保留输入版本与证据。"
        action={
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            发起检查
          </button>
        }
      />
      {latestRun && activeStatus(latestRun.status) && (
        <div className="info-line">
          <Spinner />
          正在依据规则检查数据…
          <button className="text-button" onClick={() => navigate("runs")}>
            查看进度
          </button>
        </div>
      )}
      {latestRun?.status === "failed" && (
        <InlineError>
          {latestRun.error || "检查执行失败，没有生成业务结论。"}
        </InlineError>
      )}
      {state.checks.length ? (
        <div className="check-list">
          {[...state.checks].reverse().map((item) => (
            <article className="panel check-card" key={item.id}>
              <div className="between">
                <div className="check-title">
                  <span className="check-icon">
                    <ShieldCheck size={22} />
                  </span>
                  <div>
                    <h3>{item.name}</h3>
                    <small>
                      {time(item.createdAt)} · 规则版本 {item.ruleVersion}
                    </small>
                  </div>
                </div>
                <Badge value={item.outcome}>
                  {item.outcome === "failed" ? "业务未通过" : undefined}
                </Badge>
              </div>
              <p className="check-rule">{item.rule}</p>
              {(inputStale(item.inputVersions, state.records) || state.checkRules?.some(rule => rule.name === item.name && rule.version > item.ruleVersion)) && (
                <div className="stale-note">
                  <CircleAlert size={14} />
                  输入或规则已更新，需要重新检查。
                </div>
              )}
              <ul className="finding-list">
                {item.findings.map((finding, index) => (
                  <li key={index}>
                    <span className="finding-bullet" />
                    <div>
                      <p>{finding.message}</p>
                      {finding.recordIds.length > 0 && (
                        <small>证据记录：{finding.recordIds.join("、")}</small>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <details className="technical">
                <summary>检查依据 · {item.inputVersions.length} 条数据</summary>
                {item.inputVersions.map((v) => (
                  <p key={v.id}>
                    <code>{v.id}</code> · v{v.version}
                  </p>
                ))}
              </details>
              <button
                className="text-button"
                onClick={() => {
                  setName(item.name);
                  setRule(item.rule);
                  setCreating(true);
                }}
              >
                用当前数据重新检查
                <ArrowRight size={14} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          icon={<ShieldCheck size={29} />}
          title="把岗位规则，变成可复核的检查"
          description="写下合规、完整性或业务标准，让 Agent 对当前数据逐项核验。"
        />
      )}
      {creating && (
        <Modal
          title="发起规则检查"
          subtitle="检查会冻结当前输入版本，业务未通过与执行失败分别记录。"
          onClose={() => setCreating(false)}
        >
          <form onSubmit={check}>
            <Field label="检查名称">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：订单数据完整性检查"
              />
            </Field>
            <Field label="检查规则">
              <textarea
                required
                rows={8}
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                placeholder="明确检查对象、通过条件、需要的证据，以及证据不足时应如何判断…"
              />
            </Field>
            <InlineError>{error}</InlineError>
            <div className="form-footer">
              <button
                type="button"
                className="button subtle"
                onClick={() => setCreating(false)}
              >
                取消
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? <Spinner /> : <ShieldCheck size={16} />}开始检查
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
