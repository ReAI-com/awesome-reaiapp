import { describe, expect, test } from 'bun:test';
import { ROLES } from '../src/showcase/catalog';
import { MockStore } from '../src/showcase/state';
import { renderVisual } from '../src/showcase/visuals';
import type { Board, Priority, VisualKind } from '../src/showcase/types';

// Source: the customer's 18-row requirement spreadsheet; no private links or original prose are included.
const priorityByRequirement: Record<number, Priority> = {
  1: 'P0', 2: 'P0', 3: 'P0', 4: 'P1', 5: 'P0', 6: 'P1', 7: 'P3', 8: 'P3',
  9: 'P1', 10: 'P2', 11: 'P1', 12: 'P1', 13: 'P1', 14: 'P3', 15: 'P1', 16: 'P2', 17: 'P2', 18: 'P2',
};
const store = () => new MockStore(ROLES, { getItem: () => null, setItem: () => {} });

describe('complete AI employee showcase catalog', () => {
  test('17 unique employee entries cover each of the 18 original requirements exactly once', () => {
    expect(ROLES).toHaveLength(17);
    expect(new Set(ROLES.map(role => role.id)).size).toBe(17);
    expect(ROLES.flatMap(role => role.requirementIds).sort((a, b) => a - b)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(ROLES.filter(role => role.requirementIds.length > 1)).toHaveLength(1);
    expect(ROLES.find(role => role.requirementIds.includes(9))?.requirementIds).toEqual([9, 10]);
  });
  test('original priorities remain visible, including both organizational development priorities', () => {
    for (const role of ROLES) {
      const expected = [...new Set(role.requirementIds.map(id => priorityByRequirement[id]))];
      expect(role.priorities ?? [role.priority]).toEqual(expected);
      expect(role.priority).toBe(expected[0]);
    }
    const organization = ROLES.find(role => role.requirementIds.includes(9))!;
    expect(organization.priorities).toEqual(['P1', 'P2']);
    expect(organization.boards.some(board => board.requirementIds?.includes(9) && board.priority === 'P1')).toBe(true);
    expect(organization.boards.some(board => board.requirementIds?.includes(10) && board.priority === 'P2')).toBe(true);
  });
  test('every task opens a real dedicated board and all roles include multiple populated work views', () => {
    const reserved = new Set(['sources', 'records', 'tasks', 'reports', 'settings', 'upload', 'about', 'proposal', 'detail']);
    for (const role of ROLES) {
      expect(role.boards.length).toBeGreaterThanOrEqual(2);
      expect(role.tasks.length).toBeGreaterThan(0);
      expect(role.taskBoardIds).toHaveLength(role.tasks.length);
      for (const target of role.taskBoardIds!) expect(role.boards.some(board => board.id === target)).toBe(true);
      for (const board of role.boards) {
        expect(reserved.has(board.id)).toBe(false);
        expect(board.rows.length).toBeGreaterThan(0);
        expect(board.metrics.length).toBeGreaterThan(0);
        expect(board.columns.length).toBeGreaterThan(0);
      }
    }
  });
  test('deep requirement groups are present rather than replaced by a generic task', () => {
    const byRequirement = (id: number) => ROLES.find(role => role.requirementIds.includes(id))!;
    expect(byRequirement(3).tasks).toHaveLength(6);
    expect(byRequirement(7).tasks.length).toBeGreaterThanOrEqual(4);
    for (const chain of ['库存', '到货', '异常', '新品']) expect(byRequirement(7).tasks.join(' ')).toContain(chain);
    expect(byRequirement(12).tasks).toHaveLength(7);
    expect(byRequirement(13).tasks).toHaveLength(17);
    expect(byRequirement(14).tasks).toHaveLength(16);
  });
  test('every seeded source, row, chart and task target satisfies the persisted-state contract', () => {
    const state = store();
    expect(state.warning).toBeNull();
    for (const role of ROLES) {
      const sources = state.getSources(role.id); const boards = state.getBoards(role.id);
      expect(new Set(sources.map(source => source.id)).size).toBe(sources.length);
      expect(new Set(boards.map(board => board.id)).size).toBe(boards.length);
      for (const board of boards) {
        expect(new Set(board.rows.map(row => row.id)).size).toBe(board.rows.length);
        for (const row of board.rows) {
          expect(row.cells).toHaveLength(board.columns.length);
          expect(sources.some(source => source.id === row.sourceId)).toBe(true);
          expect(state.getRow(role.id, board.id, row.id)).toMatchObject({ revision: 1, cells: row.cells });
        }
        if (board.chart) {
          expect(board.chart.values).toHaveLength(board.chart.labels.length);
          expect(board.chart.values.every(value => Number.isFinite(value))).toBe(true);
          if (board.chart.secondary) expect(board.chart.secondary).toHaveLength(board.chart.labels.length);
        }
      }
    }
  });
  test('every board has a safe visual without fake media, external resources or non-finite graph dimensions', () => {
    for (const role of ROLES) for (const board of role.boards) {
      const html = renderVisual(board);
      expect(html).toContain(`board-visual kind-${board.kind}`);
      expect(html).not.toMatch(/<button|<script|<iframe|<video|<audio|NaN|Infinity|https?:\/\//);
    }
    const percentageBoard = ROLES.find(role => role.requirementIds.includes(10))!.boards.find(board => board.id === 'cost-diagnosis')!;
    const percentageHtml = renderVisual(percentageBoard);
    expect(percentageHtml).toContain('8.4%');
    expect(percentageHtml).toContain('7.6%');
    expect(percentageHtml).not.toContain('¥');
    expect(percentageHtml).not.toContain('列示项目小计');
  });
  test('all 16 visual variants escape arbitrary user text and do not inject executable HTML', () => {
    const kinds: VisualKind[] = ['calendar', 'video', 'inspection', 'design', 'floorplan', 'cost', 'inventory', 'route', 'org', 'performance', 'people', 'recruitment', 'legal', 'executive', 'scope', 'bars'];
    const dangerous = '<img src=x onerror="alert(1)">';
    const template = ROLES[0]!.boards[0]!;
    for (const kind of kinds) {
      const candidate: Board = { ...template, kind, title: dangerous, subtitle: dangerous, columns: template.columns.map(() => dangerous), rows: [{ id: 'tainted', cells: template.columns.map(() => dangerous), detail: dangerous, sourceId: template.rows[0]!.sourceId }], chart: { labels: [dangerous], values: [1] } };
      const html = renderVisual(candidate);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('onerror="');
      expect(html).toContain('board-visual');
      expect(html).toContain('&lt;');
    }
  });
  test('calendar visuals retain each board’s real mock date or cycle instead of inventing a shared week', () => {
    const training = ROLES.find(role => role.id === 'training')!.boards.find(board => board.id === 'training-calendar')!;
    const trainingHtml = renderVisual(training);
    for (const date of ['10.12 09:00–10:30', '10.13 14:00–15:00', '10.14 09:00–10:00', '10.16 15:00–16:00']) expect(trainingHtml).toContain(date);
    const submissions = ROLES.find(role => role.id === 'performance')!.boards.find(board => board.id === 'submissions')!;
    const performanceHtml = renderVisual(submissions);
    expect(performanceHtml).toContain('9月周期 / 10月7日24:00');
    expect(performanceHtml).not.toContain('10.12');
    const arrivals = ROLES.find(role => role.id === 'supply')!.boards.find(board => board.id === 'arrivals')!;
    const arrivalHtml = renderVisual(arrivals);
    for (const date of ['10月11日 08:00', '10月10日 14:00', '10月09日 07:00', '时点待确认']) expect(arrivalHtml).toContain(date);
    expect(arrivalHtml).not.toContain('10.12');
    const hr = ROLES.find(role => role.id === 'hr')!.boards.find(board => board.kind === 'calendar')!;
    const hrHtml = renderVisual(hr);
    for (const cycle of ['每周一整理上周门店入职', '每月考勤月报', '每日']) expect(hrHtml).toContain(cycle);
    expect(hrHtml).not.toContain('10.12');
  });
  test('scope and cost visuals preserve the board domain and avoid applying unrelated default semantics', () => {
    const organization = ROLES.find(role => role.id === 'organization')!;
    const approvals = organization.boards.find(board => board.id === 'approvals')!;
    const scopeHtml = renderVisual(approvals);
    expect(scopeHtml).toContain(approvals.subtitle);
    expect(scopeHtml).toContain('从原节点续办，不重置整条流程');
    expect(scopeHtml).not.toContain('人设');
    const budget = ROLES.find(role => role.id === 'cost')!.boards.find(board => board.id === 'cost-budget')!;
    expect(renderVisual(budget)).toContain('¥ 200,220');
    const fee = ROLES.find(role => role.id === 'recruitment')!.boards.find(board => board.id === 'expenses')!;
    expect(renderVisual(fee)).toContain('¥ 1,200');
    expect(renderVisual(fee)).not.toContain('列示项目小计');
    const generic = { ...approvals, kind: 'cost' as const, chart: { labels: ['资料缺项', '待确认'], values: [2, 2] } };
    expect(renderVisual(generic)).not.toContain('¥');
  });
});
