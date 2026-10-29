import type { AgentConfig, AgentRun, SourceFile } from '../shared/types.ts';
import type { Pipeline } from './pipeline.ts';
import type { Store } from './store.ts';

/** A single local queue bounds automatic model concurrency; failures await an explicit retry. */
export class AutoCleaner {
  private queue: { workspaceId: string; fileId: string; generation: number; key: string }[] = [];
  private pending = new Set<string>();
  private execution?: Promise<void>;
  private stopped = false;
  private wake?: () => void;
  constructor(private store: Store, private pipeline: Pipeline) {}

  enqueue(workspaceId: string) {
    if (this.stopped || !this.store.getWorkspace(workspaceId).autoClean) return 0;
    const agent = this.store.list<AgentConfig>('agents', workspaceId).find(a => a.agentId === 'agent-001');
    if (!agent?.provider || !agent.model) return 0;
    let added = 0;
    for (const file of this.store.list<SourceFile>('files', workspaceId)) {
      if (!file.revisionId || file.error || !['上传完成', '有更新'].includes(file.state)) continue;
      const key = `${workspaceId}/${file.id}/${file.generation}`;
      if (this.pending.has(key)) continue;
      this.pending.add(key); this.queue.push({ workspaceId, fileId: file.id, generation: file.generation, key }); added++;
    }
    if (!this.execution && this.queue.length) {
      this.execution = this.drain().finally(() => { this.execution = undefined; });
    }
    return added;
  }

  private async drain() {
    while (!this.stopped && this.queue.length) {
      const entry = this.queue.shift()!;
      let limited = false;
      try {
        const file = this.store.get<SourceFile>('files', entry.fileId, entry.workspaceId);
        if (!this.store.getWorkspace(entry.workspaceId).autoClean || !file || file.generation !== entry.generation || file.error || !['上传完成', '有更新'].includes(file.state)) continue;
        const run = this.pipeline.clean(entry.workspaceId, entry.fileId);
        await this.pipeline.idle();
        const completed = this.store.get<AgentRun>('runs', run.id, entry.workspaceId);
        limited = completed?.status === 'failed' && /429|1302|rate.limit/i.test(completed.error || '');
      } catch (error) {
        const file = this.store.get<SourceFile>('files', entry.fileId, entry.workspaceId);
        if (file && file.generation === entry.generation) this.store.put('files', { ...file, error: (error as Error).message || '自动清洗未启动，请检查规范后重试' });
      } finally { this.pending.delete(entry.key); }
      if (limited && this.queue.length && !this.stopped) await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = undefined; resolve(); }, 60_000);
        this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
      });
    }
  }

  stop() { this.stopped = true; this.queue = []; this.wake?.(); }
  async idle() { await this.execution; }
}
