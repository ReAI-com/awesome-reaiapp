import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DataRecord } from "../shared/types";
import { request, valueText, time } from "./api";
import { InlineError, Modal, Spinner } from "./components";
import { useWorkbench } from "./context";
import type { RecordCitation } from "./MarkdownContent";

export function resolveRecordCitation(records: DataRecord[], citation: RecordCitation, workspaceId: string) {
  return records.find(record => record.id === citation.id && record.version === citation.version && record.workspaceId === workspaceId);
}

export function RecordCitationDialog({ citation, onClose }: { citation: RecordCitation; onClose: () => void }) {
  const { state, base } = useWorkbench();
  const exactCurrent = resolveRecordCitation(state.records, citation, state.workspace.id);
  const [record, setRecord] = useState<DataRecord | undefined>(exactCurrent);
  const [loading, setLoading] = useState(!exactCurrent);
  const [error, setError] = useState("");
  useEffect(() => {
    if (exactCurrent) { setRecord(exactCurrent); setLoading(false); return; }
    let alive = true;
    setLoading(true); setError(""); setRecord(undefined);
    request<DataRecord[]>(`${base}/records/${encodeURIComponent(citation.id)}/history`).then(history => {
      if (alive) setRecord(resolveRecordCitation(history, citation, state.workspace.id));
    }).catch(error => { if (alive) setError(error.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [base, citation.id, citation.version, exactCurrent, state.workspace.id]);
  const dataset = state.datasets.find(item => item.id === record?.datasetId);
  const source = state.files.find(item => item.id === record?.sourceFileId);
  const current = state.records.find(item => item.id === citation.id);
  return createPortal(<Modal title="核对数据引用" subtitle={`记录 ${citation.id.slice(0, 8)} · 引用版本 v${citation.version}`} onClose={onClose} wide>
    {loading ? <div className="info-line"><Spinner />正在读取引用版本…</div> : error ? <InlineError>{error}</InlineError> : !record ? <div className="citation-missing" role="status"><b>未找到这条引用对应的记录版本</b><p>当前账套及保留历史中没有该版本，无法据此核对答复。请让岗位专家重新查询并提供有效引用。</p></div> : <>
      <div className="citation-summary">
        <span><small>数据表</small><b>{dataset?.name || "历史数据表"}</b></span>
        <span><small>来源</small><b>{source?.name || (record.sourceFileId ? "保留的原件引用" : "人工记录")}</b></span>
        <span><small>记录版本</small><b>v{record.version}{current?.version !== record.version ? " · 历史版本" : " · 当前版本"}</b></span>
        <span><small>更新时间</small><b>{time(record.updatedAt)}</b></span>
      </div>
      {current?.version !== record.version && <p className="citation-history-note">这里展示的是答复实际引用的历史版本{current ? `；当前记录已更新至 v${current.version}` : "；原记录已由新清洗结果替换"}。</p>}
      <dl className="citation-record-fields">{Object.entries(record.data).map(([key, value]) => <div key={key}><dt>{dataset?.schema.properties[key]?.title || key}</dt><dd>{valueText(value)}</dd></div>)}</dl>
      <details className="technical"><summary>来源标识</summary><dl className="citation-record-fields"><div><dt>记录 ID</dt><dd>{record.id}</dd></div>{record.sourceRevisionId && <div><dt>原件版本 ID</dt><dd>{record.sourceRevisionId}</dd></div>}{record.runId && <div><dt>清洗任务 ID</dt><dd>{record.runId}</dd></div>}</dl></details>
    </>}
  </Modal>, document.body);
}
