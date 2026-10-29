import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Copy,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import { activeStatus, time } from "./api";
import { Spinner } from "./components";
import { useWorkbench } from "./context";
import { MarkdownContent, type RecordCitation } from "./MarkdownContent";
import { RecordCitationDialog } from "./RecordCitationDialog";

export function ChatPanel({
  draft,
  setDraft,
  onClose,
}: {
  draft: string;
  setDraft: (value: string) => void;
  onClose: () => void;
}) {
  const { state, mutate, notify, navigate, canAdmin } = useWorkbench();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [citation, setCitation] = useState<RecordCitation | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const chatRun = state.runs
    .filter((run) => run.kind === "chat")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const running = chatRun && activeStatus(chatRun.status);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [state.messages.length, running]);
  async function send() {
    const message = draft.trim();
    if (!message || sending || running) return;
    setSending(true);
    setError("");
    try {
      await mutate("/chat", { message });
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <aside id="job-expert-panel" className="chat-panel" aria-label="岗位专家对话">
      <div className="chat-header">
        <div className="chat-agent-mark">
          <Sparkles size={18} />
        </div>
        <div>
          <h2>岗位专家</h2>
          <small>AGENT-003 · {state.workspace.name}</small>
        </div>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="收起岗位专家"
        >
          <X size={18} />
        </button>
      </div>
      <div className="chat-context">
        <BookOpen size={14} />
        <span>基于当前岗位的 {state.records.length} 条已发布数据</span>
      </div>
      <div className="chat-messages">
        {!state.messages.length && (
          <div className="chat-welcome">
            <div className="assistant-symbol">
              <Sparkles size={24} />
            </div>
            <h3>
              随时一起，
              <br />
              把工作往前推。
            </h3>
            <p>我会结合当前岗位的资料回答问题，并说明数据的依据。</p>
            <div className="chat-suggestions">
              {[
                "梳理当前数据中的重点",
                "有哪些需要我关注的问题？",
                "根据现有资料给出下一步建议",
              ].map((text) => (
                <button key={text} onClick={() => setDraft(text)}>
                  {text}
                  <ArrowUp size={14} />
                </button>
              ))}
            </div>
          </div>
        )}
        {state.messages.map((message) => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <div className="message-author">
              {message.role === "assistant" ? (
                <>
                  <Sparkles size={13} />
                  岗位专家
                </>
              ) : (
                <>你</>
              )}
              <time>{time(message.createdAt)}</time>
            </div>
            <div className="message-content">
              {message.role === "assistant" ? <MarkdownContent content={message.content} records={state.records} onCitation={setCitation} /> : message.content}
            </div>
            {message.role === "assistant" && <button type="button" className="message-copy" aria-label="复制这条回答" onClick={async () => {
              try { await navigator.clipboard.writeText(message.content); notify("回答已复制为 Markdown"); }
              catch { notify("无法自动复制，请选择回答文字后复制", true); }
            }}><Copy size={12} />复制回答</button>}
          </div>
        ))}
        {running && (
          <div className="chat-running">
            <Spinner />
            <span>{chatRun.events.at(-1)?.phase || "正在处理问题"}</span>
            <button
              className="text-button"
              onClick={() =>
                void mutate(`/runs/${chatRun.id}/cancel`).catch((e) =>
                  notify(e.message, true),
                )
              }
            >
              停止
            </button>
          </div>
        )}
        {chatRun?.status === "failed" && (
          <div className="chat-error">
            {chatRun.error || "本次回复未完成。"}
            <button className="text-button" onClick={() => navigate("runs")}>
              查看运行记录
            </button>
          </div>
        )}
        {error && (
          <div className="chat-error" role="alert">
            {error}
          </div>
        )}
        <div ref={bottom} />
      </div>
      {citation && <RecordCitationDialog key={`${citation.id}:${citation.version}`} citation={citation} onClose={() => setCitation(null)} />}
      <div className="chat-composer">
        <div className="composer-input">
          <textarea
            aria-label="向岗位专家提问"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="问问你的岗位专家…"
            rows={3}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-actions">
            {canAdmin && <button
              className="icon-button"
              title="配置岗位专家"
              aria-label="配置岗位专家"
              onClick={() => navigate("agents")}
            >
              <Settings2 size={15} />
            </button>}
            <span>Shift ↵ 换行</span>
            <button
              className="send-button"
              disabled={!draft.trim() || sending || !!running}
              onClick={() => void send()}
              aria-label="发送问题"
            >
              {sending ? <Spinner /> : <ArrowUp size={17} />}
            </button>
          </div>
        </div>
        <p>结论请结合引用与业务事实核对。</p>
      </div>
    </aside>
  );
}
