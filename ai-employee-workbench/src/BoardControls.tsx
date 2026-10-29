import { useState } from 'react';
import { Code2, History, RefreshCw, Save, Sparkles } from 'lucide-react';
import type { Board } from '../shared/types';
import { request, activeStatus, time } from './api';
import { Field, InlineError, Modal, Spinner } from './components';
import { useWorkbench } from './context';
import './board-controls.css';

interface Source { html: string; name: string; description: string; datasetIds: string[]; version: number }
interface Revision { version: number; name: string; description: string; createdAt: string; source: string }

export function BoardControls({ board, onRefresh }: { board: Board; onRefresh: () => void }) {
  const { state, base, mutate, notify } = useWorkbench();
  const [mode, setMode] = useState<'agent' | 'source' | 'history' | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [prompt, setPrompt] = useState('');
  const [expectedVersion, setExpectedVersion] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = state.runs.filter(r => r.kind === 'board' && r.boardId === board.id).at(-1);
  const running = run && activeStatus(run.status);
  async function open(next: 'agent' | 'source' | 'history') {
    setError(''); setBusy(true); setExpectedVersion(board.version || 1);
    try {
      if (next === 'source') {
        const value = await request<Source>(`${base}/boards/${board.id}/source`);
        setSource(value); setExpectedVersion(value.version);
      }
      if (next === 'history') setRevisions((await request<{ versions: Revision[] }>(`${base}/boards/${board.id}/versions`)).versions);
      setMode(next);
    } catch (err) { notify((err as Error).message, true); } finally { setBusy(false); }
  }
  async function save() {
    if (!source) return; setBusy(true); setError('');
    try {
      await mutate(`/boards/${board.id}/source`, { version: expectedVersion, html: source.html, name: source.name, description: source.description }, 'PUT');
      setMode(null); notify('新版已保存，预览与独立窗口会自动刷新');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function revise() {
    setBusy(true); setError('');
    try {
      await mutate(`/boards/${board.id}/update`, { version: expectedVersion, prompt });
      setMode(null); setPrompt(''); notify('修改任务已提交，完成后自动加载新版');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function restore(targetVersion: number) {
    setBusy(true); setError('');
    try {
      await mutate(`/boards/${board.id}/restore`, { version: expectedVersion, targetVersion });
      setMode(null); notify('已从历史版本恢复，并保存为新版本');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <>
    <div className="board-edit-toolbar">
      <span className="board-version">版本 {board.version || 1}</span>
      <button className="button subtle small" disabled={busy || !!running} onClick={() => void open('agent')}><Sparkles size={15} />让 Agent 修改</button>
      <button className="button subtle small" disabled={busy} onClick={() => void open('source')}><Code2 size={15} />编辑页面</button>
      <button className="button subtle small" disabled={busy} onClick={() => void open('history')}><History size={15} />版本历史</button>
      <button className="button subtle small" onClick={onRefresh}><RefreshCw size={15} />刷新预览</button>
      {running && <span className="board-update-status"><Spinner />正在修改，当前版本仍可使用</span>}
    </div>
    {run?.status === 'failed' || run?.status === 'superseded' ? <InlineError>{run.error}</InlineError> : null}
    {mode && <Modal title={mode === 'agent' ? '继续修改这个看板' : mode === 'source' ? '编辑看板页面' : '看板版本历史'} subtitle={`当前编辑基于版本 ${expectedVersion}；保存新版本时保留历史。`} onClose={() => { if (!busy) setMode(null); }}>
      {mode === 'agent' && <>
        <Field label="修改要求"><textarea rows={7} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：增加按客户筛选，把逾期应收放在最上面，并保留原有指标…" /></Field>
        <p className="form-hint">修改完成后自动生效；可随时从版本历史恢复。</p>
        <InlineError>{error}</InlineError>
        <div className="form-footer"><button className="button subtle" disabled={busy} onClick={() => setMode(null)}>取消</button><button className="button primary" disabled={busy || !prompt.trim()} onClick={() => void revise()}>{busy ? <Spinner /> : <Sparkles size={16} />}开始修改</button></div>
      </>}
      {mode === 'source' && source && <>
        <Field label="看板名称"><input value={source.name} onChange={e => setSource({ ...source, name: e.target.value })} /></Field>
        <Field label="用途说明"><input value={source.description} onChange={e => setSource({ ...source, description: e.target.value })} /></Field>
        <Field label="HTML / CSS / JavaScript"><textarea className="board-source-editor" spellCheck={false} rows={18} value={source.html} onChange={e => setSource({ ...source, html: e.target.value })} /></Field>
        <p className="form-hint">保存后保留原来的数据连接与访问范围。生成的页面仍在隔离预览中运行。</p>
        <InlineError>{error}</InlineError>
        <div className="form-footer"><button className="button subtle" disabled={busy} onClick={() => setMode(null)}>取消</button><button className="button primary" disabled={busy || !source.html.trim() || !source.name.trim()} onClick={() => void save()}>{busy ? <Spinner /> : <Save size={16} />}保存并更新</button></div>
      </>}
      {mode === 'history' && <>
        <div className="board-history-list">{[...revisions].sort((a,b) => b.version-a.version).map(item => <div className="board-history-item" key={item.version}><div><strong>版本 {item.version} · {item.name}</strong><small>{time(item.createdAt)} · {item.source === 'agent' ? 'Agent 修改' : item.source === 'restore' ? '历史恢复' : item.source === 'manual' ? '页面编辑' : '初始版本'}</small></div>{item.version === expectedVersion ? <span className="muted">当前版本</span> : <button className="button subtle small" disabled={busy} onClick={() => void restore(item.version)}>恢复此版</button>}</div>)}</div>
        {!revisions.length && <p className="muted">首次修改时将记录初始版本。</p>}
        <InlineError>{error}</InlineError>
      </>}
    </Modal>}
  </>;
}
