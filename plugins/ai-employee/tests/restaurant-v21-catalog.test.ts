import { describe, expect, test } from 'bun:test';
import { OPERATIONS_ROLES } from '../src/showcase/roles-operations';
import { PEOPLE_ROLES } from '../src/showcase/roles-people';
import { LEADERSHIP_ROLES } from '../src/showcase/roles-leadership';
import { COVERAGE, RESTAURANT_ROLES, THEME_GROUPS } from '../src/restaurant-v21/catalog';

const legacy = [...OPERATIONS_ROLES, ...PEOPLE_ROLES, ...LEADERSHIP_ROLES];

describe('restaurant v2.1 catalog', () => {
  test('retains 17 roles, all 18 demand IDs, 83 old boards, 58 themes and 332 initial records', () => {
    expect(RESTAURANT_ROLES).toHaveLength(17);
    expect(new Set(RESTAURANT_ROLES.flatMap(r => r.requirementIds)).size).toBe(18);
    expect(RESTAURANT_ROLES.reduce((sum, r) => sum + r.boards.length, 0)).toBe(58);
    expect(RESTAURANT_ROLES.reduce((sum, r) => sum + r.rows.length, 0)).toBe(332);
    expect(COVERAGE).toHaveLength(83);
    expect(THEME_GROUPS).toHaveLength(17);
  });

  test('preserves each original column label, cell, detail and correct source exactly once', () => {
    for (const old of legacy) {
      const role = RESTAURANT_ROLES.find(r => r.id === old.id)!;
      const fieldKeys = role.fields.map(f => f[0]);
      for (const oldBoard of old.boards) {
        const matches = role.boards.flatMap(theme => theme.sections.filter(s => s.oldBoardId === oldBoard.id));
        expect(matches).toHaveLength(1);
        const section = matches[0];
        expect(section.labels).toEqual(oldBoard.columns);
        expect(section.cols[0]).toBe('item');
        expect(section.cols.at(-1)).toBe('state');
        expect(section.cols).toHaveLength(oldBoard.columns.length);
        const initial = role.rows.map((row, index) => ({ row, index })).filter(({ row }) => row[fieldKeys.indexOf('topic')] === section.topic);
        expect(initial).toHaveLength(oldBoard.rows.length);
        for (let k = 0; k < oldBoard.rows.length; k++) {
          const row = initial[k].row;
          expect(section.cols.map(key => row[fieldKeys.indexOf(key)])).toEqual(oldBoard.rows[k].cells);
          expect(row[fieldKeys.indexOf('details')]).toBe(oldBoard.rows[k].detail);
          const sourceIndex = role.rowsSourceIndices[initial[k].index];
          expect(sourceIndex).toBe(old.sources.findIndex(s => s.id === oldBoard.rows[k].sourceId));
          expect(role.sources[sourceIndex].preview).toContain(old.sources[sourceIndex].content);
          expect(row.slice(-2)).toEqual(['i', 1]);
        }
      }
    }
  });

  test('has no row/field misalignment or invisible enum states and keeps field order compatible with v2 editing', () => {
    for (const role of RESTAURANT_ROLES) {
      expect(role.fields.slice(0, 3).map(f => f[0])).toEqual(['item', 'state', 'topic']);
      expect(role.fields[0][2]).toBe('t');
      expect(role.fields[1][2]).toBe('s');
      expect(role.sem).toEqual({ group: 'topic', metric: null, agg: null, owner: null, unit: '' });
      expect(new Set(role.fields.map(f => f[0])).size).toBe(role.fields.length);
      expect(role.rowsSourceIndices).toHaveLength(role.rows.length);
      for (const row of role.rows) {
        expect(row).toHaveLength(role.fields.length + 2);
        expect(role.fields[1][3]).toContain(String(row[1]));
        expect(role.fields[2][3]).toContain(String(row[2]));
      }
    }
  });

  test('reserves explicit reflow fields without rewriting initial record content', () => {
    for (const role of RESTAURANT_ROLES) {
      const content = role.fields.findIndex(field => field[0] === 'content');
      expect(content).toBeGreaterThan(0);
      expect(role.rows.every(row => row[content] === '')).toBe(true);
      expect(role.fields[1][3]).toContain('回流待复核');
      expect(role.fields[2][3]).toContain('交付回流');
    }
  });

  test('provides every role with B, C and D themes and only v2 known actions/types', () => {
    const actions = new Set(['open-record', 'select-candidate', 'sign-candidate', 'reflow-to-b', 'run-check', 'escalate-issue']);
    for (const role of RESTAURANT_ROLES) {
      expect(role.boards.length >= 3 && role.boards.length <= 4).toBe(true);
      for (const type of ['B', 'C', 'D']) expect(role.boards.some(b => b.type === type)).toBe(true);
      expect(new Set(role.boards.map(b => b.id)).size).toBe(role.boards.length);
      for (const board of role.boards) {
        expect(board.sections.length).toBeGreaterThan(0);
        expect(board.actions.every(action => actions.has(action))).toBe(true);
        for (const section of board.sections) expect(section.cols.every(key => role.fields.some(f => f[0] === key))).toBe(true);
      }
    }
  });

  test('binds C candidates to business-specific tasks and valid role-global input indices', () => {
    for (const role of RESTAURANT_ROLES) {
      for (const board of role.boards.filter(b => b.type === 'C')) {
        expect(board.tasks!.length).toBeGreaterThan(0);
        for (const task of board.tasks!) {
          expect(task.need).toContain('演示');
          expect(task.inputs.length).toBeGreaterThan(0);
          expect(task.inputs.every(i => Number.isInteger(i) && i >= 0 && i < role.rows.length)).toBe(true);
          expect(task.cands.length).toBeGreaterThanOrEqual(2);
          expect(new Set(task.cands.map(c => c[0])).size).toBe(task.cands.length);
          expect(task.cands.every(c => c[0].length > 3 && c[1].length > 25)).toBe(true);
        }
      }
    }
    expect(RESTAURANT_ROLES.find(r => r.id === 'training')!.boards.flatMap(b => b.tasks ?? []).map(t => t.cands).flat(2).join(' ')).toContain('10月15日');
    expect(RESTAURANT_ROLES.find(r => r.id === 'cost')!.boards.flatMap(b => b.tasks ?? []).map(t => t.cands).flat(2).join(' ')).toContain('200,220');
  });

  test('keeps D rules distinct from clearly labeled mock runs and binds evidence to valid records', () => {
    const outcomes = new Set(['pass', 'fail', 'error', 'insufficient']);
    for (const role of RESTAURANT_ROLES) {
      for (const board of role.boards.filter(b => b.type === 'D')) {
        expect(board.rules!.length).toBeGreaterThan(0);
        expect(board.runs!.length).toBeGreaterThan(0);
        const ruleIds = new Set(board.rules!.map(r => r.id));
        for (const run of board.runs!) for (const result of run.results) {
          expect(ruleIds.has(result[0])).toBe(true);
          expect(outcomes.has(result[1])).toBe(true);
          expect(result[3]).toContain('样例');
          expect(result[4] === null || (Number.isInteger(result[4]) && result[4] >= 0 && result[4] < role.rows.length)).toBe(true);
        }
      }
    }
  });

  test('retains all legacy task mappings, per-board priorities and both organization demand priorities', () => {
    for (const old of legacy) {
      const role = RESTAURANT_ROLES.find(r => r.id === old.id)!;
      expect(role.requirementIds).toEqual(old.requirementIds);
      expect(role.legacyTasks.map(t => t.task)).toEqual(old.tasks);
      for (const task of role.legacyTasks) {
        const board = role.boards.find(b => b.id === task.themeId)!;
        expect(board.sections.some(s => s.oldBoardId === task.oldBoardId)).toBe(true);
      }
      for (const section of role.boards.flatMap(b => b.sections)) {
        const oldBoard = old.boards.find(b => b.id === section.oldBoardId)!;
        expect(section.requirementIds).toEqual(oldBoard.requirementIds ?? old.requirementIds);
        expect(section.priority).toBe(oldBoard.priority ?? old.priority);
      }
    }
    const org = RESTAURANT_ROLES.find(r => r.id === 'organization')!;
    expect(org.requirementIds).toEqual([9, 10]);
    expect(org.priorities).toEqual(['P1', 'P2']);
  });

  test('preserves all raw mock sources and adds clearly separate unpublished ready/issue sample rows', () => {
    for (const old of legacy) {
      const role = RESTAURANT_ROLES.find(r => r.id === old.id)!;
      expect(role.sources.length).toBe(old.sources.length + 2);
      for (let i = 0; i < old.sources.length; i++) {
        expect(role.sources[i].name).toBe(old.sources[i].name);
        expect(role.sources[i].st).toBe('done');
        expect(role.sources[i].preview).toContain(old.sources[i].content);
      }
      const extra = role.sources.slice(old.sources.length);
      expect(extra.map(s => s.st)).toEqual(['ready', 'issue']);
      expect(extra.every(s => /额外|新增/.test(s.preview) && s.yields?.every(row => row.length === role.fields.length))).toBe(true);
      expect(extra[1].issues!.length).toBeGreaterThan(0);
      expect(role.rowsSourceIndices.every(i => i < old.sources.length)).toBe(true);
    }
  });

  test('keeps CAD and all four digital doubles explicitly provisional, without fabricating vice-president divisions', () => {
    for (const id of ['space', 'chairman', 'ceo', 'vp1', 'vp2']) {
      const role = RESTAURANT_ROLES.find(r => r.id === id)!;
      expect(role.scopeUncertain).toBe(true);
      expect(role.scopeNote).toContain('待确认');
      expect(role.boards.flatMap(b => b.tasks ?? []).every(t => /待确认|讨论/.test(t.need))).toBe(true);
    }
    for (const id of ['vp1', 'vp2']) {
      const role = RESTAURANT_ROLES.find(r => r.id === id)!;
      expect(role.scopeNote).not.toMatch(/分管营运|分管财务/);
      expect(role.boards.filter(b => b.type === 'D').flatMap(b => b.runs ?? []).flatMap(run => run.results).every(result => result[1] === 'insufficient')).toBe(true);
    }
  });

  test('exports serializable self-contained config and does not mutate legacy seeds', () => {
    const copied = JSON.parse(JSON.stringify(RESTAURANT_ROLES));
    expect(copied).toHaveLength(17);
    expect(legacy.reduce((sum, r) => sum + r.boards.reduce((n, b) => n + b.rows.length, 0), 0)).toBe(332);
    expect(legacy.every(r => r.boards.every(b => b.rows.every(row => row.cells.length === b.columns.length)))).toBe(true);
  });
});
