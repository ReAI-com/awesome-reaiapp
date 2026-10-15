import { describe, expect, test } from 'bun:test';
import { MockStore, SHOWCASE_STORAGE_KEY } from '../src/showcase/state';
import type { Board, Role, StorageLike } from '../src/showcase/types';

class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
const baseBoard = (): Board => ({ id: 'overview', title: '岗位看板', subtitle: '演示', kind: 'bars', metrics: [], columns: ['事项', '状态'], rows: [{ id: 'first', cells: ['示例事项', '待复核'], detail: '仅演示数据', sourceId: 'source-one' }], actions: ['查看资料'] });
const fixtureRoles = (): Role[] => Array.from({ length: 17 }, (_, i) => ({ id: `role-${i}`, name: `岗位 ${i}`, job: 'AI 员工', department: '示例部门', priority: 'P1', accent: '#b9302b', icon: 'users', summary: '演示', requirementIds: [i + 1], tasks: ['复核'], boards: [baseBoard()], sources: [{ id: 'source-one', name: '示例原始资料', type: '文本摘要', collectedAt: '2026-10-09', origin: '虚构验收数据', content: '原始内容：待复核' }], prompts: [], rules: ['只能模拟'] }));
const customBoard = (): Board => ({ ...baseBoard(), id: 'custom-check', title: '新增核对看板' });

describe('AI employee showcase state', () => {
  test('all 17 roles isolate edits, proposals, conversations, settings and sources', () => {
    const store = new MockStore(fixtureRoles(), new MemoryStorage());
    store.updateRow('role-0', 'overview', 'first', ['岗位 0 新事项', '已复核'], '用户演示修订');
    store.addMessage('role-0', 'user', '岗位 0 的问题');
    store.setDraft('role-0', '岗位 0 草稿');
    store.updateSettings('role-0', { scope: '岗位 0 范围' });
    store.propose('role-0', { type: 'board', title: '新增核对看板', description: '待用户确认', boardId: 'custom-check', board: customBoard() });
    for (let i = 1; i < 17; i++) {
      expect(store.getRow(`role-${i}`, 'overview', 'first').cells).toEqual(['示例事项', '待复核']);
      expect(store.session(`role-${i}`).messages).toEqual([]);
      expect(store.session(`role-${i}`).draft).toBe('');
      expect(store.session(`role-${i}`).proposal).toBeNull();
      expect(store.session(`role-${i}`).settings.scope).not.toBe('岗位 0 范围');
    }
  });
  test('editing keeps the original source and every row revision immutable through returned values', () => {
    const roles = fixtureRoles(); const store = new MockStore(roles, new MemoryStorage());
    const original = store.getSources('role-0');
    store.updateRow('role-0', 'overview', 'first', ['示例事项', '已复核'], '第一次修订');
    store.updateRow('role-0', 'overview', 'first', ['修订后的事项', '已复核'], '第二次修订');
    const row = store.getRow('role-0', 'overview', 'first');
    expect(row.revision).toBe(3);
    expect(row.history.map(entry => entry.cells)).toEqual([['示例事项', '待复核'], ['示例事项', '已复核'], ['修订后的事项', '已复核']]);
    row.cells[0] = '绕过修订'; row.history[0]!.cells[0] = '篡改历史';
    original[0]!.content = '篡改来源';
    store.session('role-0').settings.company = '篡改设置';
    store.getBoards('role-0')[0]!.rows[0]!.cells[0] = '篡改看板';
    expect(store.getRow('role-0', 'overview', 'first').cells[0]).toBe('修订后的事项');
    expect(store.getRow('role-0', 'overview', 'first').history[0]!.cells[0]).toBe('示例事项');
    expect(store.getSources('role-0')[0]!.content).toBe('原始内容：待复核');
    expect(roles[0]!.boards[0]!.rows[0]!.cells[0]).toBe('示例事项');
  });
  test('a new board exists only after confirmation, and its definition is cloned', () => {
    const storage = new MemoryStorage(); const store = new MockStore(fixtureRoles(), storage);
    const board = customBoard();
    store.propose('role-0', { type: 'board', title: board.title, description: '演示建议', boardId: board.id, board });
    board.rows[0]!.cells[0] = '外部篡改';
    expect(store.getBoards('role-0')).toHaveLength(1);
    expect(new MockStore(fixtureRoles(), storage).session('role-0').proposal?.board?.rows[0]?.cells[0]).toBe('示例事项');
    const confirmed = store.confirmProposal('role-0');
    expect(confirmed.type).toBe('board');
    expect(store.getBoards('role-0')).toHaveLength(2);
    expect(store.session('role-0').proposal).toBeNull();
    expect(store.getBoards('role-1')).toHaveLength(1);
    expect(() => store.confirmProposal('role-0')).toThrow();
  });
  test('closing and reopening Agent plus a browser reload preserves role-specific working state', () => {
    const storage = new MemoryStorage(); const first = new MockStore(fixtureRoles(), storage);
    first.setDraft('role-0', '继续核对这个事项');
    first.addMessage('role-0', 'user', '看一下待办');
    first.addMessage('role-0', 'agent', '找到一个演示待办', [{ boardId: 'overview', rowId: 'first', sourceId: 'source-one', label: '原始资料' }]);
    first.setAgentOpen('role-0', false); first.setAgentOpen('role-0', true);
    first.updateRow('role-0', 'overview', 'first', ['事项', '完成（演示）'], '人工确认');
    first.appendSource('role-0', { id: 'upload-one', name: '演示.xlsx', type: '上传元信息', collectedAt: '2026-10-09', origin: '当前浏览器；未保留文件原件', content: '文件名：演示.xlsx；大小：24 KB；仅记录元信息' });
    first.updateSettings('role-0', { developerMode: true, tone: '简洁' });
    first.saveReport('role-0', '核对演示报告', '仅供界面讨论', 'overview');
    const restored = new MockStore(fixtureRoles(), storage);
    expect(restored.warning).toBeNull();
    expect(restored.session('role-0')).toEqual(first.session('role-0'));
    expect(restored.getRow('role-0', 'overview', 'first').revision).toBe(2);
    expect(restored.getSources('role-0')).toHaveLength(2);
    expect(restored.session('role-1').messages).toEqual([]);
    expect([...storage.values.keys()]).toEqual([SHOWCASE_STORAGE_KEY]);
  });
  test('references must resolve inside their role, and conflicting source or board identities are rejected', () => {
    const store = new MockStore(fixtureRoles(), new MemoryStorage());
    store.propose('role-0', { type: 'board', title: '核对', description: '待确认', boardId: 'custom-check', board: customBoard() }); store.confirmProposal('role-0');
    expect(() => store.addMessage('role-1', 'agent', '越界引用', [{ boardId: 'custom-check' }])).toThrow();
    expect(() => store.propose('role-1', { type: 'operation', title: '操作', description: '演示', boardId: 'custom-check' })).toThrow();
    expect(() => store.appendSource('role-0', store.getSources('role-0')[0]!)).toThrow();
    expect(() => store.propose('role-0', { type: 'board', title: '重复', description: '演示', boardId: 'overview', board: baseBoard() })).toThrow();
    expect(() => store.updateRow('role-0', 'overview', 'missing', ['事项', '状态'], '修订')).toThrow();
    expect(() => store.updateRow('role-0', 'overview', 'first', ['列数错误'], '修订')).toThrow();
    expect(() => store.session('missing')).toThrow();
  });
  test('all nine fixed routes reject board proposals and previously stored route collisions without overwriting storage', () => {
    const storage = new MemoryStorage(); const store = new MockStore(fixtureRoles(), storage);
    store.setDraft('role-0', '原来的会话草稿'); const before = store.session('role-0');
    const valid = storage.getItem(SHOWCASE_STORAGE_KEY)!;
    for (const reserved of ['sources', 'records', 'tasks', 'reports', 'settings', 'upload', 'about', 'proposal', 'detail']) {
      const occupied = { ...customBoard(), id: reserved };
      const invalidSeeds = fixtureRoles(); invalidSeeds[0]!.boards = [occupied];
      expect(() => new MockStore(invalidSeeds, new MemoryStorage())).toThrow('固定入口');
      expect(() => store.propose('role-0', { type: 'board', title: '保留入口碰撞', description: '测试路由边界', boardId: reserved, board: occupied })).toThrow('固定入口');
      expect(store.session('role-0')).toEqual(before);
      const parsed = JSON.parse(valid); parsed.roles['role-0'].boards.push(occupied);
      const damaged = JSON.stringify(parsed); storage.setItem(SHOWCASE_STORAGE_KEY, damaged);
      let writes = 0;
      const spyStorage: StorageLike = { getItem: key => storage.getItem(key), setItem(key, value) { writes++; storage.setItem(key, value); } };
      const restored = new MockStore(fixtureRoles(), spyStorage);
      expect(restored.warning).toContain('内存');
      expect(restored.getBoards('role-0')).toHaveLength(1);
      restored.setDraft('role-0', '内存中的新草稿');
      expect(restored.session('role-0').draft).toBe('内存中的新草稿');
      expect(storage.getItem(SHOWCASE_STORAGE_KEY)).toBe(damaged);
      expect(writes).toBe(0);
    }
  });
  test('malformed, unknown-version, wrong-type and excessive stored data warn and recover clean defaults', () => {
    const storage = new MemoryStorage(); new MockStore(fixtureRoles(), storage).setDraft('role-0', '已保存');
    const valid = storage.getItem(SHOWCASE_STORAGE_KEY)!;
    const cases: string[] = ['{broken', JSON.stringify({ version: 99, roles: {} })];
    for (const mutate of [
      (value: any) => { value.roles['role-0'].agentOpen = 'true'; },
      (value: any) => { value.roles['role-0'].draft = 'a'.repeat(20001); },
      (value: any) => { value.roles['role-0'].messages = Array.from({ length: 201 }, () => ({ id: 'm', who: 'user', text: '演示', at: 'now' })); },
      (value: any) => { value.roles['role-0'].settings.password = 'must-not-load'; },
      (value: any) => { value.roles['role-0'].boards = [{ ...customBoard(), html: '<script>alert(1)</script>' }]; },
    ]) { const parsed = JSON.parse(valid); mutate(parsed); cases.push(JSON.stringify(parsed)); }
    for (const raw of cases) {
      storage.setItem(SHOWCASE_STORAGE_KEY, raw);
      const store = new MockStore(fixtureRoles(), storage);
      expect(store.warning).toBeTruthy();
      expect(store.session('role-0').draft).toBe('');
      expect(store.getBoards('role-0')).toHaveLength(1);
      expect(storage.getItem(SHOWCASE_STORAGE_KEY)).toBe(raw);
    }
  });
  test('storage read or quota failures remain visible and preserve the current in-memory session', () => {
    const unavailable: StorageLike = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
    const store = new MockStore(fixtureRoles(), unavailable);
    expect(store.warning).toContain('内存');
    store.setDraft('role-0', '本次演示草稿');
    store.addMessage('role-0', 'user', '浏览器拒绝存储');
    expect(store.warning).toContain('内存');
    expect(store.session('role-0').draft).toBe('本次演示草稿');
    expect(store.session('role-0').messages).toHaveLength(1);
  });
  test('a temporary quota failure can recover without losing the in-memory edits', () => {
    const storage = new MemoryStorage(); let blocked = true;
    const recovering: StorageLike = { getItem: key => storage.getItem(key), setItem(key, value) { if (blocked) throw new Error('QuotaExceededError'); storage.setItem(key, value); } };
    const store = new MockStore(fixtureRoles(), recovering);
    store.updateRow('role-0', 'overview', 'first', ['本地修订', '待复核'], '存储失败时修订');
    expect(store.warning).toContain('内存');
    blocked = false; store.setDraft('role-0', '继续工作');
    expect(store.warning).toBeNull();
    const restored = new MockStore(fixtureRoles(), storage);
    expect(restored.getRow('role-0', 'overview', 'first').cells).toEqual(['本地修订', '待复核']);
    expect(restored.session('role-0').draft).toBe('继续工作');
  });
  test('stored history tampering, unrelated references and duplicate identifiers are rejected on reload', () => {
    const storage = new MemoryStorage(); const first = new MockStore(fixtureRoles(), storage);
    first.updateRow('role-0', 'overview', 'first', ['修订', '已复核'], '演示');
    first.addMessage('role-0', 'agent', '查看记录', [{ boardId: 'overview', rowId: 'first' }]);
    const valid = storage.getItem(SHOWCASE_STORAGE_KEY)!;
    for (const mutate of [
      (value: any) => { value.roles['role-0'].edits['overview/first'].history[0].cells[0] = '篡改原始记录'; },
      (value: any) => { value.roles['role-0'].edits['overview/first'].history[1].revision = 8; },
      (value: any) => { value.roles['role-0'].messages[0].links[0].rowId = 'other-role-row'; },
      (value: any) => { value.roles['role-0'].sources.push(fixtureRoles()[0]!.sources[0]); },
      (value: any) => { value.roles['role-0'].boards.push({ ...customBoard(), rows: [{ ...customBoard().rows[0], sourceId: 'not-in-this-role' }] }); },
    ]) {
      const parsed = JSON.parse(valid); mutate(parsed); storage.setItem(SHOWCASE_STORAGE_KEY, JSON.stringify(parsed));
      const restored = new MockStore(fixtureRoles(), storage);
      expect(restored.warning).toBeTruthy();
      expect(restored.getRow('role-0', 'overview', 'first').revision).toBe(1);
      expect(restored.session('role-0').messages).toHaveLength(0);
    }
  });
  test('an operation confirmation returns its scoped target without inventing an external action', () => {
    const store = new MockStore(fixtureRoles(), new MemoryStorage()); const original = store.getSources('role-0');
    store.propose('role-0', { type: 'operation', title: '确认演示操作', description: '仅确认本地操作范围', boardId: 'overview', rowId: 'first' });
    expect(store.confirmProposal('role-0')).toMatchObject({ type: 'operation', boardId: 'overview', rowId: 'first' });
    expect(store.session('role-0').proposal).toBeNull();
    expect(store.getSources('role-0')).toEqual(original);
    expect(store.getBoards('role-0')).toHaveLength(1);
  });
  test('oversized new inputs and arbitrary board execution fields never partially mutate the session', () => {
    const store = new MockStore(fixtureRoles(), new MemoryStorage()); const before = store.session('role-0');
    expect(() => store.setDraft('role-0', 'a'.repeat(20001))).toThrow();
    expect(() => store.addMessage('role-0', 'user', 'a'.repeat(20001))).toThrow();
    expect(() => store.propose('role-0', { type: 'board', title: '恶意看板', description: '测试', boardId: 'custom-check', board: { ...customBoard(), html: '<script>alert(1)</script>' } as Board })).toThrow();
    expect(() => store.appendSource('role-0', { ...store.getSources('role-0')[0]!, id: 'new', bytes: '原文件内容' } as any)).toThrow();
    expect(store.session('role-0')).toEqual(before);
  });
});
