import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { generateRestaurantV21 } from '../src/restaurant-v21/generator';

// Execute the generated page's actual closed-over runtime. The return statement
// belongs only to this test wrapper; the product exposes no debug API.
const baseHtml = readFileSync(new URL('../design/paradigm-v2.html', import.meta.url), 'utf8');
const expectedRoles = ['training', 'examiner', 'operations', 'vi', 'space', 'cost', 'supply', 'dispatch', 'organization', 'performance', 'hr', 'recruitment', 'legal', 'chairman', 'ceo', 'vp1', 'vp2'];
type Runtime = Record<string, any>;
const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map(window => window.happyDOM.close()));
});

function fixture() {
  const html = generateRestaurantV21(baseHtml);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => !/\btype\s*=\s*["'](?:application\/json|text\/plain)["']/i.test(match[1]))
    .map(match => match[2]).join('\n');
  const window = new Window({ url: 'http://127.0.0.1:4188/design/restaurant-v2.1.html', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } });
  windows.push(window);
  window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  let clock = 0, nextTimer = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const setTimer = (callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
    const id = ++nextTimer;
    timers.set(id, { due: clock + Math.max(0, Number(delay) || 0), callback: () => callback(...args) });
    return id;
  };
  const realm = window as any;
  realm.TextEncoder = TextEncoder;
  realm.TextDecoder = TextDecoder;
  realm.structuredClone = structuredClone;
  realm.setTimeout = setTimer;
  realm.clearTimeout = (id: number) => timers.delete(id);
  realm.setInterval = () => ++nextTimer;
  realm.clearInterval = () => {};
  realm.requestAnimationFrame = (callback: (at: number) => void) => setTimer(() => callback(clock), 16);
  realm.cancelAnimationFrame = realm.clearTimeout;
  const exported = 'S,ROLES,RS,role,switchRole,cTasks,cSelect,cSign,cResubmit,cReflow,serverSign,receiptStale,runExpired,dRun,organize,publish,addSource,buildProposal,setCurrentProposal,confirmProposal,validateProposal,proposalBoard,allBoards,bView,recList,metricValues,answerIx,drawerParts,srcStatusCell,ACT,render';
  const globals = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'CSS', 'FileReader', 'File', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'TextEncoder', 'TextDecoder', 'structuredClone'];
  const values = globals.map(name => name === 'window' ? window : name === 'getComputedStyle' ? window.getComputedStyle.bind(window) : realm[name]);
  const runtime = new Function(...globals, `${scripts}\nreturn {${exported}};`)(...values) as Runtime;
  function advance(ms: number) {
    const until = clock + ms;
    for (let count = 0; count < 10_000; count++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= until).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) { clock = until; return; }
      timers.delete(next[0]); clock = next[1].due; next[1].callback();
    }
    throw new Error('Generated page scheduled an unbounded timeout loop');
  }
  return { runtime, window, html, advance };
}

function useRole(runtime: Runtime, type: 'B' | 'C' | 'D') {
  const role = runtime.ROLES.find((item: any) => item.boards.some((board: any) => board.type === type));
  expect(role).toBeDefined(); runtime.switchRole(role.id);
  return { role, state: runtime.RS(), board: role.boards.find((board: any) => board.type === type) };
}

function selectFirst(runtime: Runtime) {
  const { role, state, board } = useRole(runtime, 'C');
  const task = board.tasks[0], delivery = state.c[task.id], candidate = delivery.cands[0];
  runtime.cSelect(task.id, candidate.ref);
  return { role, state, board, task, delivery, candidate, interaction: state.ix[delivery.ixId] };
}

describe('Restaurant v2.1 executes the main v2 runtime with restaurant role data', () => {
  test('all 17 roles and every configured theme render through the generated page', () => {
    const { runtime, window, html } = fixture();
    expect(runtime.ROLES.map((role: any) => role.id).sort()).toEqual([...expectedRoles].sort());
    expect(new Set(runtime.ROLES.map((role: any) => role.id)).size).toBe(17);
    expect(html).toContain('餐饮');
    expect(window.document.querySelectorAll('#content .restaurant-role')).toHaveLength(17);
    for (const href of ['/design/paradigm-v2.html', '/showcase.html#/', '/preview.html']) {
      expect(window.document.querySelector(`#content .restaurant-compare a[href="${href}"]`)).not.toBeNull();
    }
    for (const role of runtime.ROLES) {
      runtime.switchRole(role.id);
      runtime.ACT.go('dashboard');
      expect(runtime.RS().records.length).toBeGreaterThan(0);
      expect(window.document.querySelector('#content')?.textContent).toContain('工作台');
      for (const board of role.boards) {
        runtime.ACT.go('board:' + board.id);
        expect(window.document.querySelector('#content')?.textContent).toContain(board.title);
        expect(window.document.querySelector('#content')?.textContent).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  test('actual uploads preserve bounded bytes and text without manufacturing business records', () => {
    const { runtime, advance } = fixture();
    const { state } = useRole(runtime, 'B');
    const text = '名称,人数\n真实选择的未知格式,\n' + '原始内容'.repeat(500);
    const bytes = new TextEncoder().encode(text);
    const beforeSources = state.sources.length, beforeRecords = state.records.length;
    const source = runtime.addSource('待复核训练.csv', { bytes, size: bytes.length, origin: 'upload' });
    expect(state.sources).toHaveLength(beforeSources + 1);
    const duplicate = runtime.addSource('同内容不同名称.csv', { bytes, size: bytes.length, origin: 'upload' });
    expect(duplicate).toBe(source); expect(state.sources).toHaveLength(beforeSources + 1);
    expect(source.bytes).toEqual(bytes); expect(source.bytes).not.toBe(bytes);
    expect(source.text).toBe(text); expect(source.preview.length).toBeLessThan(text.length);
    expect(source.st).toBe('unsup'); expect(source.yields).toEqual([]); expect(source.auto).toBeUndefined();
    runtime.organize(source.id); runtime.publish(source.id); advance(700);
    expect(state.records).toHaveLength(beforeRecords);
    expect(state.review).toBeNull();
    const large = runtime.addSource('超过上限.csv', { size: 8 * 1024 * 1024 + 1, lastModified: 123, origin: 'upload' });
    expect(large.bytes).toBeNull(); expect(large.text).toBe(''); expect(large.fpBasis).toBe('meta');
    expect(large.unsupWhy).toContain('未保存'); expect(large.yields).toEqual([]);
    for (const view of ['staff', 'lead', 'admin', 'dev']) {
      runtime.S.view = view;
      const metadataStatus = runtime.srcStatusCell(large, true);
      const metadataDrawer = runtime.drawerParts({ kind: 'src', id: large.id });
      expect(metadataStatus).toContain('原件未保存');
      expect(metadataStatus).not.toContain('这类文件只保存原件');
      expect(metadataDrawer.body).toContain('未保存文件内容');
      expect(metadataDrawer.body).not.toContain('这类文件只保存原件');
      const bytesStatus = runtime.srcStatusCell(source, true);
      const bytesDrawer = runtime.drawerParts({ kind: 'src', id: source.id });
      expect(bytesDrawer.body).toContain('原始字节已保留在本页内存');
      expect(bytesStatus + bytesDrawer.body).not.toMatch(/原件未保存|未保存文件内容|未保存原件内容/);
    }
  });

  test('unresolved built-in sample issues block the whole batch and confirmation publishes once', () => {
    const { runtime, advance } = fixture();
    const { state } = useRole(runtime, 'B');
    const source = state.sources.find((item: any) => item.st === 'issue' && item.yields.length);
    expect(source).toBeDefined(); expect(source.issues.length).toBeGreaterThan(0);
    const beforeRecords = state.records.length, preview = source.preview;
    runtime.organize(source.id); runtime.publish(source.id); advance(700);
    expect(state.records).toHaveLength(beforeRecords);
    source.issues.forEach((issue: any) => { issue.excluded = true; });
    runtime.publish(source.id); advance(700);
    expect(source.yields.length).toBeGreaterThan(0);
    expect(state.records).toHaveLength(beforeRecords + source.yields.length);
    const published = state.records.slice(beforeRecords);
    expect(published.every((record: any) => record.src === source.id && record.origin === 'i' && record.rule)).toBe(true);
    runtime.publish(source.id); advance(700);
    expect(state.records).toHaveLength(beforeRecords + source.yields.length);
    expect(source.preview).toBe(preview);
    expect(published.every((record: any) => record.history[0].values)).toBe(true);
  });

  test('record edits compare expected versions and preserve a rejected stale edit', () => {
    const { runtime, advance } = fixture();
    const { role, state } = useRole(runtime, 'B');
    const record = state.records[0]; state.conflictShown = true;
    runtime.ACT['open-rec'](record.id); runtime.ACT['rec-edit'](record.id);
    const field = state.edit.field;
    const original = record.values[field], expected = record.v;
    const originalHistory = structuredClone(record.history);
    state.edit.value = role.fields.find((f: any[]) => f[0] === field)[3]?.find((option: string) => option !== original) ?? '人工更正值';
    const requested = state.edit.value;
    runtime.ACT['rec-save'](record.id);
    record.v += 1;
    advance(700);
    expect(state.edit.conflict).toBe(true); expect(record.values[field]).toBe(original);
    expect(record.v).toBe(expected + 1);
    runtime.ACT['rec-refresh'](record.id); runtime.ACT['rec-save'](record.id); advance(700);
    expect(record.v).toBe(expected + 2); expect(record.values[field]).toBe(requested);
    expect(record.history.at(-1).v).toBe(record.v); expect(state.edit).toBeNull();
    expect(record.history.slice(0, originalHistory.length)).toEqual(originalHistory);
    expect(record.history.at(-1).values[field]).toBe(requested);
  });

  test('delivery selection, signing, idempotent replay and derived-source review use the real runtime', () => {
    const { runtime, advance } = fixture();
    const { state, task, delivery, candidate, interaction } = selectFirst(runtime);
    expect(interaction.state).toBe('pending');
    runtime.answerIx(interaction.id, 'sign');
    expect(interaction.state).toBe('answered'); expect(delivery.receipt).toBeNull();
    advance(1000);
    const receipt = delivery.receipt;
    expect(receipt.cand).toBe(candidate.ref); expect(receipt.inputs).toEqual(candidate.inputs);
    runtime.cSign(task.id, candidate.ref, null); advance(1000);
    expect(delivery.receipt).toBe(receipt); expect(Object.keys(state.server.sign)).toHaveLength(1);
    const saved = state.server.sign[receipt.key];
    const replay = runtime.serverSign(state, delivery, saved.req);
    expect(replay.receipt).toBe(receipt);
    expect(runtime.serverSign(state, delivery, { ...saved.req, signer: '不同签字者' })).toEqual({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED' });
    const recordCount = state.records.length, sourceCount = state.sources.length;
    runtime.cReflow(task.id);
    expect(state.sources).toHaveLength(sourceCount + 1); expect(state.records).toHaveLength(recordCount);
    const derived = state.sources.at(-1);
    expect(derived.origin).toBe('derived'); expect(derived.derivedFrom).toBe(candidate.ref);
    expect(JSON.parse(derived.preview).content).toBe(candidate.body);
    runtime.cReflow(task.id); expect(state.sources).toHaveLength(sourceCount + 1);
    advance(1500); runtime.organize(derived.id); runtime.publish(derived.id); advance(700);
    const record = state.records.at(-1);
    expect(record.origin).toBe('r'); expect(record.src).toBe(derived.id); expect(record.reflowCand).toBe(candidate.ref);
    expect(record.values.content).toBe(candidate.body);
    const filled = Object.entries(record.values).filter(([, value]) => value !== '' && value != null).map(([key]) => key);
    expect(filled.every(key => ['item', 'topic', 'state', 'content'].includes(key))).toBe(true);
  });

  test('lost signing receipts recover the original request and never sign twice', () => {
    const { runtime, advance } = fixture();
    const { state, task, delivery, interaction } = selectFirst(runtime);
    delivery.lostNext = true;
    runtime.answerIx(interaction.id, 'sign'); advance(1000);
    const request: any = Object.values(delivery.requests)[0];
    expect(request.status).toBe('lost'); expect(delivery.receipt).toBeNull();
    const original = state.server.sign[request.key].receipt;
    runtime.cResubmit(task.id, request.key); advance(800);
    expect(request.status).toBe('done'); expect(delivery.receipt).toBe(original);
    expect(request.recovered).toBe(true); expect(Object.keys(state.server.sign)).toHaveLength(1);
    expect(interaction.state).toBe('answered');
  });

  test('old signed versions are retained after input changes and cannot silently reflow', () => {
    const { runtime, advance } = fixture();
    const { state, task, delivery, candidate, interaction } = selectFirst(runtime);
    runtime.answerIx(interaction.id, 'sign'); advance(1000);
    const receipt = delivery.receipt, body = candidate.body, count = state.sources.length;
    runtime.ACT['c-tool-input'](task.id);
    expect(runtime.receiptStale(delivery)).toBe(true); expect(delivery.receipt).toBe(receipt);
    expect(delivery.versions[candidate.ref].body).toBe(body);
    runtime.cReflow(task.id); expect(state.sources).toHaveLength(count);
    runtime.ACT['c-regen'](task.id);
    expect(delivery.versions[candidate.ref].body).toBe(body);
    expect(delivery.cands[0].ref).not.toBe(candidate.ref);
  });

  test('a first signature rejects inputs changed after generation instead of blessing a stale candidate', () => {
    const { runtime, advance } = fixture();
    const { state, delivery, candidate, interaction } = selectFirst(runtime);
    const id = candidate.inputs[0].split('@v')[0];
    state.records.find((record: any) => record.id === id).v += 1;
    runtime.answerIx(interaction.id, 'sign'); advance(1000);
    const request: any = Object.values(delivery.requests)[0];
    expect(request.status).toBe('rejected'); expect(request.code).toBe('INPUT_CHANGED');
    expect(delivery.receipt).toBeNull(); expect(Object.keys(state.server.sign)).toHaveLength(0);
    expect(interaction.state).toBe('answered');
  });

  test('checks freeze rule and whole-dataset versions at start and expose stale results', () => {
    const { runtime, advance } = fixture();
    const { role, state } = useRole(runtime, 'D');
    const board = role.boards.find((board: any) => board.type === 'D' && board.rules.some((rule: any) => rule.tgt.k === 'own'));
    expect(board).toBeDefined();
    const check = state.d[board.id], record = state.records[0], previous = record.v;
    const originalValues = structuredClone(record.values);
    const rule = board.rules[0], previousRule = check.ruleVer[rule.id];
    runtime.dRun(board.id); record.v += 1;
    record.values[role.fields[0][0]] = '检查发起后修改的值';
    check.ruleVer[rule.id] += 1; advance(1900);
    const run = check.runs[0];
    expect(run.ruleVers[rule.id]).toBe(previousRule); expect(run.read.members[record.id]).toBe(previous);
    expect(run.read.values[record.id]).toEqual(originalValues);
    expect(runtime.runExpired(run, check, state)).toContain('更新');
    check.ruleVer[rule.id] = previousRule; record.v = previous;
    expect(runtime.runExpired(run, check, state)).toBe('');
    state.records.push({ ...record, id: record.id + '-new' });
    expect(runtime.runExpired(run, check, state)).toContain('集合');
    state.records.pop(); expect(runtime.runExpired(run, check, state)).toBe('');
  });

  test('business failure, runtime error and missing evidence remain distinct check outcomes', () => {
    const { runtime } = fixture();
    const outcomes = new Set<string>();
    for (const role of runtime.ROLES) {
      runtime.switchRole(role.id);
      for (const check of Object.values(runtime.RS().d) as any[]) {
        for (const run of check.runs) for (const result of run.results) outcomes.add(result.outcome);
      }
    }
    expect([...outcomes].sort()).toEqual(['error', 'fail', 'insufficient', 'pass']);
  });

  test('proposal previews are inert and unknown fields, actions and stale profiles cannot add boards', () => {
    const { runtime, window, advance } = fixture(); useRole(runtime, 'B');
    const state = runtime.RS();
    for (const [variant, code] of [['field', 'UNKNOWN_FIELD'], ['action', 'UNKNOWN_ACTION']]) {
      const proposal = runtime.buildProposal('新增一个「主题记录」看板', variant);
      expect(proposal.err.code).toBe(code);
      runtime.setCurrentProposal(state, proposal); runtime.confirmProposal(proposal.id); advance(700);
      expect(state.custom).toHaveLength(0);
    }
    const proposal = runtime.buildProposal('新增一个「主题记录」看板', 'ok');
    runtime.setCurrentProposal(state, proposal);
    const preview = window.document.createElement('div'); preview.innerHTML = runtime.bView(runtime.proposalBoard(proposal), { preview: true });
    expect(preview.querySelectorAll('[data-act="open-rec"]')).toHaveLength(0);
    expect(preview.querySelectorAll('button[disabled]').length).toBeGreaterThan(0);
    expect(state.custom).toHaveLength(0);
    runtime.confirmProposal(proposal.id); state.profileVersion += 1; advance(700);
    expect(state.adjust.commits[proposal.id].state).toBe('failed');
    expect(state.adjust.commits[proposal.id].err.code).toBe('PROPOSAL_EXPIRED'); expect(state.custom).toHaveLength(0);
  });

  test('confirmed proposals are idempotent definitions bound to live B rather than record snapshots', () => {
    const { runtime, advance } = fixture(); useRole(runtime, 'B');
    const state = runtime.RS(), proposal = runtime.buildProposal('新增一个「实时记录」看板', 'ok');
    runtime.setCurrentProposal(state, proposal); runtime.confirmProposal(proposal.id); advance(700);
    runtime.confirmProposal(proposal.id); advance(700);
    expect(state.custom).toHaveLength(1);
    const board = state.custom[0]; expect(board.rows).toBeUndefined();
    const countMetric = board.metrics.findIndex((metric: any) => metric.op === 'count');
    const count = runtime.metricValues(board.metrics, runtime.recList())[countMetric];
    const added = { ...state.records[0], id: state.records[0].id + '-live', values: { ...state.records[0].values } };
    state.records.push(added);
    expect(runtime.metricValues(board.metrics, runtime.recList())[countMetric]).toBe(count + 1);
    expect(runtime.bView(board)).toContain('data-id="' + added.id + '"');
  });

  test('disabled trusted actions block board and Agent signing and answered interactions do not rewind', () => {
    const { runtime, advance } = fixture();
    const { state, board, task, delivery, candidate, interaction } = selectFirst(runtime);
    state.enabled[board.id].delete('sign-candidate');
    runtime.ACT['c-sign'](task.id, null, candidate.ref); runtime.answerIx(interaction.id, 'sign'); advance(1000);
    expect(Object.keys(delivery.requests)).toHaveLength(0); expect(interaction.state).toBe('pending');
    state.enabled[board.id].add('sign-candidate');
    runtime.answerIx(interaction.id, 'sign'); advance(1000); expect(interaction.state).toBe('answered');
    const answer = interaction.answer;
    runtime.answerIx(interaction.id, 'later'); expect(interaction.answer).toBe(answer);
    runtime.cSelect(task.id, candidate.ref); const old = state.ix[delivery.ixId];
    runtime.ACT['c-regen'](task.id); runtime.answerIx(old.id, 'sign');
    expect(old.state).toBe('expired');
  });

  test('late signing acceptance stays in the original role and is safely recoverable after switching', () => {
    const { runtime, advance } = fixture();
    const { role, state, task, delivery, interaction } = selectFirst(runtime);
    runtime.answerIx(interaction.id, 'sign');
    const another = runtime.ROLES.find((item: any) => item.id !== role.id);
    runtime.switchRole(another.id);
    const next = runtime.RS(); next.draft = '另一岗位未发送草稿';
    const messages = next.messages.length;
    advance(1000);
    const request: any = Object.values(delivery.requests)[0];
    expect(request.status).toBe('lost'); expect(state.server.sign[request.key]).toBeDefined();
    expect(next.draft).toBe('另一岗位未发送草稿'); expect(next.messages).toHaveLength(messages);
    expect(runtime.S.ignoredLate).toBeGreaterThan(0);
    runtime.switchRole(role.id); runtime.cResubmit(task.id, request.key); advance(800);
    expect(delivery.receipt).toBe(state.server.sign[request.key].receipt); expect(Object.keys(state.server.sign)).toHaveLength(1);
  });
});
