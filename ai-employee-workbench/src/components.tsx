import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  LoaderCircle,
  X,
} from "lucide-react";
import type { AgentRun } from "../shared/types";
import { activeStatus, pretty, time } from "./api";
import { useWorkbench } from "./context";

export function Spinner() {
  return <LoaderCircle className="spin" size={16} aria-hidden="true" />;
}
export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon || <ArrowUpRight size={25} />}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_review: "待确认",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  superseded: "已有新版本",
  interrupted: "已中断",
  draft: "待确认",
  published: "已添加",
  candidate: "候选",
  selected: "已选定",
  signed: "已签字",
  passed: "通过",
  insufficient_evidence: "证据不足",
};
export function Badge({
  value,
  children,
}: {
  value: string;
  children?: ReactNode;
}) {
  const tone = [
    "succeeded",
    "passed",
    "published",
    "signed",
    "清洗完成",
    "更新完成",
  ].includes(value)
    ? "success"
    : ["failed", "interrupted"].includes(value)
      ? "error"
      : [
            "running",
            "queued",
            "上传中",
            "开始清洗",
            "清洗中",
            "更新中",
          ].includes(value)
        ? "active"
        : [
              "waiting_review",
              "draft",
              "有更新",
              "insufficient_evidence",
            ].includes(value)
          ? "warn"
          : "neutral";
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-dot" />
      {children || statusLabels[value] || value}
    </span>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const firstInput = [
      ...(el?.querySelectorAll<HTMLElement>("input, textarea, select") || []),
    ].find((item) => item.getClientRects().length > 0);
    (firstInput || el?.querySelector<HTMLElement>("button"))?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab" && el) {
        const all = [
          ...el.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
          ),
        ].filter((item) => item.getClientRects().length > 0);
        if (!all.length) return;
        if (event.shiftKey && document.activeElement === all[0]) {
          event.preventDefault();
          all.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === all.at(-1)) {
          event.preventDefault();
          all[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="关闭弹窗"
          >
            <X size={20} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
      </div>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function InlineError({ children }: { children?: ReactNode }) {
  return children ? (
    <div className="inline-error" role="alert">
      <CircleAlert size={16} />
      <span>{children}</span>
    </div>
  ) : null;
}
export function SectionHead({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function RunDetail({
  run,
  onClose,
}: {
  run: AgentRun;
  onClose: () => void;
}) {
  const { state, mutate, notify } = useWorkbench();
  const current = state.runs.find((item) => item.id === run.id) || run;
  return (
    <Modal
      title="任务运行记录"
      subtitle={`${current.agentId.toUpperCase()} · ${time(current.createdAt)}`}
      onClose={onClose}
      wide
    >
      <div className="between">
        <Badge value={current.status} />
        {activeStatus(current.status) && (
          <button
            className="button subtle"
            onClick={() =>
              void mutate(`/runs/${current.id}/cancel`).catch((e) =>
                notify(e.message, true),
              )
            }
          >
            取消任务
          </button>
        )}
      </div>
      {current.error && <InlineError>{current.error}</InlineError>}
      {current.status === "waiting_review" && (
        <CleaningReview key={current.id} run={current} />
      )}
      <ol className="run-timeline">
        {current.events.map((event, index) => (
          <li key={`${event.time}-${index}`}>
            <span className="timeline-dot">
              {index === current.events.length - 1 &&
              ["running", "queued"].includes(current.status) ? (
                <Spinner />
              ) : (
                <Check size={12} />
              )}
            </span>
            <div>
              <div className="between">
                <b>{event.phase}</b>
                <time>{time(event.time)}</time>
              </div>
              <p>{event.message}</p>
            </div>
          </li>
        ))}
      </ol>
      {!current.events.length && (
        <p className="muted">任务已登记，等待执行。</p>
      )}
      <details className="technical">
        <summary>任务标识</summary>
        <code>{current.id}</code>
      </details>
    </Modal>
  );
}

function CleaningReview({ run }: { run: AgentRun }) {
  const { mutate, notify, canAdmin } = useWorkbench();
  const result = run.result as
    | {
        kind?: string;
        proposal?: { records?: unknown[]; schema?: unknown };
        issues?: string[];
        hasManual?: boolean;
      }
    | undefined;
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState(
    pretty(result?.proposal?.records || []),
  );
  const [replaceManual, setReplaceManual] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (result?.kind !== "cleaning-review")
    return <p className="muted">任务正在等待复核。</p>;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const parsed = JSON.parse(records);
      if (!Array.isArray(parsed)) throw new Error("清洗记录必须是 JSON 数组。");
      await mutate(`/runs/${run.id}/review`, {
        records: parsed,
        replaceManual,
      });
      notify("复核结果已提交");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="review-panel">
      <div className="info-line">
        <CircleAlert size={17} />
        <span>清洗结果需要确认后才能发布，现有数据保持可用。</span>
      </div>
      {result.issues?.length ? (
        <ul className="review-issues">
          {result.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {!canAdmin ? <p className="muted">请由铆钉管理员复核并发布这些记录。</p> : !open ? (
        <button className="button primary" onClick={() => setOpen(true)}>
          复核清洗结果
        </button>
      ) : (
        <form onSubmit={submit}>
          <Field label="本次清洗记录（JSON 数组）">
            <textarea
              className="monospace"
              rows={13}
              value={records}
              onChange={(event) => setRecords(event.target.value)}
              required
            />
          </Field>
          {!!result.proposal?.schema && (
            <details className="technical">
              <summary>对照 Schema</summary>
              <pre className="code-block">{pretty(result.proposal.schema)}</pre>
            </details>
          )}
          {result.hasManual && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={replaceManual}
                onChange={(event) => setReplaceManual(event.target.checked)}
              />
              <span>用本次结果更新当前记录，保留人工修订历史</span>
            </label>
          )}
          <InlineError>{error}</InlineError>
          <div className="form-footer">
            <button
              className="button primary"
              disabled={saving || (!!result.hasManual && !replaceManual)}
            >
              {saving && <Spinner />}确认并发布
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
