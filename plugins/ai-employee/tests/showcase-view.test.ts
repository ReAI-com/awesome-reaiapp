import { afterEach, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { Showcase } from '../src/showcase/view';
import { ROLES } from '../src/showcase/catalog';
import { MockStore } from '../src/showcase/state';
import type { StorageLike } from '../src/showcase/types';

if (typeof document === 'undefined') GlobalRegistrator.register();

class BrowserStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => { document.body.replaceChildren(); });

function fixture(path = '/') {
  location.hash = path;
  const root = document.createElement('div');
  document.body.append(root);
  const storage = new BrowserStorage();
  const store = new MockStore(ROLES, storage);
  const view = new Showcase(root, ROLES, store);
  view.mount();
  return { root, store, storage, view };
}

function navigate(path: string) {
  location.hash = path;
  window.dispatchEvent(new Event('hashchange'));
}

function element<T extends Element = HTMLElement>(root: HTMLElement, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Expected UI element: ${selector}`);
  return found;
}

function click(root: HTMLElement, selector: string) {
  element<HTMLElement>(root, selector).click();
  // The mock DOM schedules a real hash event asynchronously; routing assertions
  // deliberately dispatch the event after a user navigation changes the hash.
  window.dispatchEvent(new Event('hashchange'));
}

function input(root: HTMLElement, selector: string, value: string) {
  const field = element<HTMLInputElement | HTMLTextAreaElement>(root, selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function select(root: HTMLElement, selector: string, value: string) {
  const field = element<HTMLSelectElement>(root, selector);
  field.value = value;
  field.dispatchEvent(new Event('change', { bubbles: true }));
  window.dispatchEvent(new Event('hashchange'));
}

function submit(root: HTMLElement, selector: string) {
  element<HTMLFormElement>(root, selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  window.dispatchEvent(new Event('hashchange'));
}

describe('AI employee showcase UI discussion flows', () => {
  test('home contains 17 roles, searches real task text, and retains organization in both original priority filters', () => {
    const { root } = fixture();
    expect(root.querySelectorAll('.employee-card')).toHaveLength(17);
    input(root, '#home-search', '迎宾');
    expect(root.querySelectorAll('.employee-card').length).toBeGreaterThan(0);
    expect(root.querySelector('.employee-card[href="#/role/operations"]')).not.toBeNull();
    input(root, '#home-search', '没有这个岗位关键词');
    expect(root.querySelectorAll('.employee-card')).toHaveLength(0);
    expect(root.querySelector('.empty')?.textContent).toContain('没有匹配');
    input(root, '#home-search', '');
    for (const priority of ['P1', 'P2']) {
      select(root, '#priority-filter', priority);
      const expected = ROLES.filter(role => (role.priorities ?? [role.priority]).includes(priority as 'P1' | 'P2'));
      expect(root.querySelectorAll('.employee-card')).toHaveLength(expected.length);
      expect(root.querySelector('.employee-card[href="#/role/organization"]')).not.toBeNull();
    }
  });

  test('every role and every dedicated board can be opened from real UI navigation', () => {
    const { root } = fixture();
    for (const role of ROLES) {
      navigate(`/role/${role.id}`);
      expect(root.querySelector('.sidebar-role strong')?.textContent).toBe(role.job);
      expect(root.querySelectorAll('.board-nav [data-page]')).toHaveLength(role.boards.length);
      for (const board of role.boards) {
        click(root, `.board-nav [data-page="${board.id}"]`);
        expect(root.querySelector('.work-content .page-heading h1')?.textContent).toBe(board.title);
        expect(root.querySelectorAll('.data-panel tbody tr')).toHaveLength(board.rows.length);
        expect(root.querySelector('.work-content')?.textContent).not.toContain('NaN');
        expect(root.querySelector('.work-content')?.textContent).not.toContain('Infinity');
      }
    }
  });

  test('plus only prefills; submitting proposes a board and confirmation adds it to this role', () => {
    const { root, store } = fixture('/role/training');
    const count = store.getBoards('training').length;
    click(root, '[data-action="add-board"]');
    expect(element<HTMLTextAreaElement>(root, '#agent-draft').value).toContain('新增一个看板');
    expect(store.session('training').messages).toHaveLength(0);
    expect(store.session('training').proposal).toBeNull();
    expect(store.getBoards('training')).toHaveLength(count);
    input(root, '#agent-draft', '新增一个「本周跟进」看板');
    submit(root, '#chat-form');
    expect(store.session('training').messages).toHaveLength(2);
    const proposal = store.session('training').proposal!;
    expect(proposal.type).toBe('board');
    expect(proposal.title).toBe('本周跟进');
    expect(store.getBoards('training')).toHaveLength(count);
    click(root, '[data-page="proposal"]');
    expect(root.querySelector('.proposal-panel')?.textContent).toContain('待人工确认');
    expect(root.querySelector('.proposal-panel [data-record]')).toBeNull();
    expect(root.querySelector('.proposal-panel')?.textContent).toContain('快照');
    click(root, '[data-action="confirm-proposal"]');
    expect(store.session('training').proposal).toBeNull();
    expect(store.getBoards('training')).toHaveLength(count + 1);
    expect(store.getBoards('cost')).toHaveLength(ROLES.find(role => role.id === 'cost')!.boards.length);
    expect(root.querySelector('.work-content .page-heading h1')?.textContent).toBe('本周跟进');
    navigate('/');
    const total = ROLES.reduce((sum, role) => sum + role.boards.length, 0) + 1;
    expect(root.querySelectorAll('.summary-numbers strong')[2]?.textContent).toBe(String(total));
    expect(root.querySelector('[href="#/role/training"] .mini-preview-meta')?.textContent).toContain(`${count + 1} 个看板`);
  });

  test('Agent source and record references open in the left area without losing the conversation', () => {
    const { root, store } = fixture('/role/training');
    input(root, '#agent-draft', '核对资料');
    submit(root, '#chat-form');
    const first = store.getBoards('training')[0];
    click(root, `.message-links [data-chat-row="${first.rows[0].id}"]`);
    expect(root.querySelector('#record-form')?.getAttribute('data-row')).toBe(first.rows[0].id);
    expect(root.querySelectorAll('.chat-message')).toHaveLength(2);
    click(root, '.message-links [data-chat-source]');
    const source = store.getSources('training').find(item => item.id === first.rows[0].sourceId)!;
    expect(root.querySelector('.source-reader pre')?.textContent).toBe(source.content);
    expect(root.querySelectorAll('.chat-message')).toHaveLength(2);
    expect(root.querySelector('.agent-panel')).not.toBeNull();
  });

  test('saving a discussion from a source reference page retains the original nonfirst board association', () => {
    const { root, store } = fixture('/role/training/training-resources');
    const role = ROLES.find(item => item.id === 'training')!, board = role.boards[1];
    expect(board.id).toBe('training-resources');
    input(root, '#agent-draft', '核对当前资源资料');
    submit(root, '#chat-form');
    expect(store.session('training').messages.at(-1)?.links?.[0].boardId).toBe(board.id);
    click(root, '.message-links [data-chat-source]');
    expect(root.querySelector('.source-reader pre')).not.toBeNull();
    click(root, '[data-action="save-report"]');
    const reports = store.session('training').reports;
    expect(reports).toHaveLength(1);
    expect(reports[0].boardId).toBe(board.id);
    expect(reports[0].boardId).not.toBe(role.boards[0].id);
    expect(reports[0].title).toContain(board.title);
    expect(reports[0].body).toContain(board.title);
    expect(root.querySelector('.report h2')?.textContent).toContain(board.title);
    click(root, `.report [data-page="${board.id}"]`);
    expect(root.querySelector('.work-content .page-heading h1')?.textContent).toBe(board.title);
  });

  test('closing, switching roles and reopening preserve the same role conversation and unsent draft', () => {
    const { root, store } = fixture('/role/training');
    input(root, '#agent-draft', '核对培训资料');
    submit(root, '#chat-form');
    input(root, '#agent-draft', '下一步尚未发送');
    click(root, '.agent-head [data-action="toggle-agent"]');
    expect(root.querySelector('.agent-panel')).toBeNull();
    expect(store.session('training').messages).toHaveLength(2);
    click(root, '.sidebar [data-action="toggle-agent"]');
    expect(element<HTMLTextAreaElement>(root, '#agent-draft').value).toBe('下一步尚未发送');
    expect(root.querySelectorAll('.chat-message')).toHaveLength(2);
    select(root, '#role-switch', 'cost');
    expect(store.session('cost').messages).toHaveLength(0);
    expect(element<HTMLTextAreaElement>(root, '#agent-draft').value).toBe('');
    select(root, '#role-switch', 'training');
    expect(element<HTMLTextAreaElement>(root, '#agent-draft').value).toBe('下一步尚未发送');
    expect(root.querySelectorAll('.chat-message')).toHaveLength(2);
  });

  test('record revision saves the standard record and history while its original source remains unchanged', () => {
    const { root, store } = fixture('/role/training');
    const board = store.getBoards('training')[0], row = board.rows[0];
    const originals = store.getSources('training');
    click(root, `[data-record="${board.id}~${row.id}"]`);
    input(root, '[name="cell-0"]', '补充说明后的培训课程');
    input(root, '[name="reason"]', '核对演示需求后补充课程说明');
    submit(root, '#record-form');
    const saved = store.getRow('training', board.id, row.id);
    expect(saved.cells[0]).toBe('补充说明后的培训课程');
    expect(saved.revision).toBe(2);
    expect(saved.history[0].cells).toEqual(row.cells);
    expect(saved.history[1].reason).toBe('核对演示需求后补充课程说明');
    expect(store.getSources('training')).toEqual(originals);
    expect(root.querySelector('.revision')?.textContent).toContain('V2');
  });

  test('budget starts at the independently computed amount and temporary trial changes do not alter standard records', () => {
    const { root, store } = fixture('/role/cost/cost-budget');
    const board = store.getBoards('cost').find(item => item.id === 'cost-budget')!;
    const before = structuredClone(board.rows);
    expect(root.querySelector('#cost-total')?.textContent).toBe('200,220 元');
    input(root, '[data-calc="qty"][data-index="0"]', '192');
    expect(root.querySelector('[data-subtotal="0"]')?.textContent).toBe('30,336 元');
    expect(root.querySelector('#cost-total')?.textContent).toBe('202,116 元');
    expect(store.getBoards('cost').find(item => item.id === board.id)!.rows).toEqual(before);
    input(root, '[data-calc="price"][data-index="0"]', '');
    expect(root.querySelector('#cost-total')?.textContent).toContain('无法合计');
    expect(root.querySelector('[data-subtotal="0"]')?.textContent).toContain('有效非负数');
  });

  test('zero daily consumption cannot create an infinite inventory estimate after user input', () => {
    const { root, store } = fixture('/role/supply/inventory');
    const before = store.getBoards('supply').find(item => item.id === 'inventory')!.rows[0].cells;
    input(root, '[data-stock="daily"][data-index="0"]', '0');
    expect(root.querySelector('[data-stock-output="0"]')?.textContent).toContain('无法估算');
    expect(root.querySelector('.inventory-calculator')?.textContent).not.toContain('Infinity');
    expect(store.getBoards('supply').find(item => item.id === 'inventory')!.rows[0].cells).toEqual(before);
  });

  test('a saved zero-consumption record is already shown as not estimable when the board first renders', () => {
    const { root, store } = fixture('/role/supply/inventory');
    const board = store.getBoards('supply').find(item => item.id === 'inventory')!, row = board.rows[0];
    const cells = [...row.cells]; cells[2] = '0';
    store.updateRow('supply', board.id, row.id, cells, '日均用量待重新核定');
    navigate('/role/supply/inventory');
    expect(root.querySelector('[data-stock-output="0"]')?.textContent).toContain('无法估算');
    expect(root.querySelector('.inventory-calculator')?.textContent).not.toContain('Infinity');
    expect(root.querySelector('.inventory-calculator')?.textContent).not.toContain('NaN');
  });

  test('a saved budget quantity change updates row subtotal, summary and trial amount consistently', () => {
    const { root, store } = fixture('/role/cost/cost-budget');
    const board = store.getBoards('cost').find(item => item.id === 'cost-budget')!, row = board.rows[0];
    const originals = store.getSources('cost');
    click(root, `[data-record="${board.id}~${row.id}"]`);
    expect(element<HTMLInputElement>(root, '[name="cell-4"]').readOnly).toBe(true);
    expect(root.querySelector('.detail-panel')?.textContent).toContain('初始采集说明');
    input(root, '[name="cell-1"]', '192');
    input(root, '[name="reason"]', '核对演示面积后调整为192平方米');
    submit(root, '#record-form');
    expect(store.getRow('cost', board.id, row.id).cells[4]).toBe('30336');
    click(root, `[data-page="${board.id}"]`);
    expect(root.querySelector('.metrics .metric strong')?.textContent).toBe('202,116');
    expect(root.querySelector('#cost-total')?.textContent).toBe('202,116 元');
    expect(root.querySelector('.data-panel tbody tr')?.textContent).toContain('30336');
    expect(store.getSources('cost')).toEqual(originals);
    input(root, '#agent-draft', '核对当前数量和小计');
    submit(root, '#chat-form');
    expect(store.session('cost').messages.at(-1)?.text).toMatch(/192.*30336/);
  });

  test('a saved inventory daily-use change updates coverage, shortage count and trial display', () => {
    const { root, store } = fixture('/role/supply/inventory');
    const board = store.getBoards('supply').find(item => item.id === 'inventory')!, row = board.rows[0];
    const originals = store.getSources('supply');
    click(root, `[data-record="${board.id}~${row.id}"]`);
    expect(element<HTMLInputElement>(root, '[name="cell-4"]').readOnly).toBe(true);
    input(root, '[name="cell-2"]', '200');
    input(root, '[name="reason"]', '演示日均用量调整为200kg');
    submit(root, '#record-form');
    expect(store.getRow('supply', board.id, row.id).cells[4]).toBe('2.5');
    click(root, `[data-page="${board.id}"]`);
    expect(root.querySelector('[data-stock-output="0"]')?.textContent).toBe('现存 2.5 天 · 含在途 3.5 天');
    expect(root.querySelectorAll('.metrics .metric strong')[1]?.textContent).toBe('3');
    expect(root.querySelectorAll('.metrics .metric strong')[2]?.textContent).toContain('3.5');
    expect(root.querySelector('.data-panel tbody tr')?.textContent).toContain('2.5');
    expect(store.getSources('supply')).toEqual(originals);
  });

  test('saved nonnumeric or blank budget drivers do not render NaN or silently treat missing quantities as zero', () => {
    const { root, store } = fixture('/role/cost/cost-budget');
    const board = store.getBoards('cost').find(item => item.id === 'cost-budget')!, row = board.rows[0];
    for (const quantity of ['未知', '']) {
      const cells = [...row.cells]; cells[1] = quantity;
      store.updateRow('cost', board.id, row.id, cells, '缺工程量时保留待核对');
      navigate('/role/cost/cost-budget');
      expect(root.querySelector('.metrics .metric strong')?.textContent).toBe('待核对');
      expect(root.querySelector('#cost-total')?.textContent).toContain('无法合计');
      expect(root.querySelector('.work-content')?.textContent).not.toContain('NaN');
      expect(root.querySelector('.work-content')?.textContent).not.toContain('Infinity');
    }
  });

  test('saved nonnumeric inventory drivers are visibly not estimable on the initial render', () => {
    const { root, store } = fixture('/role/supply/inventory');
    const board = store.getBoards('supply').find(item => item.id === 'inventory')!, row = board.rows[0];
    const cells = [...row.cells]; cells[2] = '缺日均';
    store.updateRow('supply', board.id, row.id, cells, '基础数据缺失');
    navigate('/role/supply/inventory');
    expect(root.querySelector('[data-stock-output="0"]')?.textContent).toContain('无法估算');
    expect(root.querySelectorAll('.metrics .metric strong')[1]?.textContent).toBe('待核对');
    expect(root.querySelector('.work-content')?.textContent).not.toContain('NaN');
    expect(root.querySelector('.work-content')?.textContent).not.toContain('Infinity');
  });

  test('HR routine reports remain separate from generated work reports', () => {
    const { root } = fixture('/role/hr');
    const board = ROLES.find(role => role.id === 'hr')!.boards.find(item => item.title === '例行报表与推送')!;
    expect(board.id).not.toBe('reports');
    click(root, `.board-nav [data-page="${board.id}"]`);
    expect(root.querySelector('.work-content .page-heading h1')?.textContent).toBe('例行报表与推送');
    expect(root.querySelectorAll('.data-panel tbody tr')).toHaveLength(board.rows.length);
    click(root, '.sidebar [data-page="reports"]');
    expect(root.querySelector('.work-content .page-heading h1')?.textContent).toBe('工作报告');
    expect(root.querySelector('.work-content')?.textContent).toContain('还没有报告');
  });

  test('homepage identifies only CAD and the four executive entries as scope concepts', () => {
    const { root } = fixture();
    const cards = Array.from(root.querySelectorAll('.employee-card'));
    expect(cards.filter(card => card.querySelector('.card-foot')?.textContent?.includes('概念方案'))).toHaveLength(5);
    expect(root.querySelector('[href="#/role/training"] .card-foot')?.textContent).toContain('岗位任务');
    expect(root.querySelector('[href="#/role/space"] .card-foot')?.textContent).toContain('概念方案');
  });

  test('user-controlled record and chat text remain inert rather than becoming HTML elements', () => {
    const { root, store } = fixture('/role/training');
    const board = store.getBoards('training')[0], row = board.rows[0];
    const cells = [...row.cells]; cells[0] = '<img src=x onerror="window.injected=true">';
    store.updateRow('training', board.id, row.id, cells, '验证文本展示');
    navigate(`/role/training/${board.id}`);
    expect(root.querySelector('.data-panel img')).toBeNull();
    expect(root.querySelector('.data-panel')?.textContent).toContain('<img src=x');
    input(root, '#agent-draft', '<script>window.injected=true</script>');
    submit(root, '#chat-form');
    expect(root.querySelector('.agent-panel script')).toBeNull();
    expect(root.querySelector('.chat-message.user')?.textContent).toContain('<script>');
  });
});
