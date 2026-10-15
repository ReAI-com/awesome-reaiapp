export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type VisualKind = 'calendar' | 'video' | 'inspection' | 'design' | 'floorplan' | 'cost' | 'inventory' | 'route' | 'org' | 'performance' | 'people' | 'recruitment' | 'legal' | 'executive' | 'scope' | 'bars';
export interface Metric { label: string; value: string; unit?: string; hint?: string }
export interface RecordRow { id: string; cells: string[]; detail: string; sourceId: string }
export interface Board {
  id: string; title: string; subtitle: string; kind: VisualKind; metrics: Metric[];
  columns: string[]; rows: RecordRow[]; actions: string[]; steps?: string[];
  chart?: { labels: string[]; values: number[]; secondary?: number[] };
  notices?: string[]; priority?: Priority; requirementIds?: number[];
}
export interface Source { id: string; name: string; type: string; collectedAt: string; origin: string; content: string }
export interface Role {
  id: string; name: string; job: string; department: string; priority: Priority; priorities?: Priority[];
  accent: string; icon: string; summary: string; requirementIds: number[]; scopeNote?: string;
  tasks: string[]; taskBoardIds?: string[]; boards: Board[]; sources: Source[]; prompts: string[]; rules: string[];
}
export interface ChatLink { boardId: string; rowId?: string; sourceId?: string; label?: string }
export interface ChatMessage { id: string; who: 'user' | 'agent'; text: string; at: string; links?: ChatLink[] }
export interface RowRevision { revision: number; cells: string[]; reason: string; at: string }
export interface StoreRow extends RecordRow { revision: number; history: RowRevision[] }
export interface Proposal {
  type: 'board' | 'operation'; title: string; description: string; boardId: string; rowId?: string; board?: Board;
}
export interface DemoReport { id: string; title: string; body: string; boardId: string; at: string }
export interface RoleSettings { company: string; scope: string; tone: string; ruleNotes: string; developerMode: boolean }
export interface RoleSession {
  draft: string; agentOpen: boolean; messages: ChatMessage[]; boards: Board[]; sources: Source[];
  edits: Record<string, { cells: string[]; history: RowRevision[] }>; proposal: Proposal | null;
  settings: RoleSettings; reports: DemoReport[];
}
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
