import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ExcelJS from 'exceljs';
import { Store } from '../server/store.ts';
import { Sources } from '../server/sources.ts';
import type { SourceRevision } from '../shared/types.ts';

async function setup(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'employee-sources-'));
  const store = new Store(path.join(directory, 'app'));
  const workspace = store.createWorkspace({ name: '测试', role: '测试提取', directory: path.join(directory, 'workspace') });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, workspace, sources: new Sources(store) };
}

test('duplicate CSV headers fail explicitly rather than silently dropping a column', async t => {
  const { workspace, sources } = await setup(t);
  const file = await sources.upload(workspace.id, 'duplicate.csv', Buffer.from('item,amount,amount\nA,10,20\n'));
  await assert.rejects(sources.extract(workspace.id, file.id, file.revisionId), /重名字段/);
});

test('all XLSX sheets are retained including the valid __proto__ sheet name', async t => {
  const { workspace, sources } = await setup(t);
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('__proto__'); sheet.addRow(['amount']); sheet.addRow([42]);
  const file = await sources.upload(workspace.id, 'sheet.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  const data = JSON.parse(await sources.extract(workspace.id, file.id, file.revisionId));
  assert.deepEqual(data.__proto__, [['amount'], [42]]);
});

test('scan snapshots updates, skips symlinks, and retains prior originals after source deletion', async t => {
  const { directory, store, workspace, sources } = await setup(t);
  const source = path.join(workspace.directory, 'notes.txt'); await writeFile(source, 'first version');
  await writeFile(path.join(directory, 'outside.txt'), 'outside workspace');
  await symlink(path.join(directory, 'outside.txt'), path.join(workspace.directory, 'linked.txt'));
  const first = await sources.scan(workspace.id); assert.equal(first.imported.length, 1); assert.equal(first.skipped.length, 1);
  const original = first.imported[0]; await writeFile(source, 'second version');
  const second = await sources.scan(workspace.id); assert.equal(second.imported.length, 1);
  assert.equal(second.imported[0].id, original.id); assert.equal(second.imported[0].generation, original.generation + 1);
  const revision = store.require<SourceRevision>('revisions', original.revisionId, workspace.id);
  assert.equal(await readFile(revision.path, 'utf8'), 'first version');
  await unlink(source); await sources.scan(workspace.id);
  assert.equal(store.list('revisions', workspace.id).length, 2);
  assert.equal(store.require<{ revisionId: string }>('files', original.id, workspace.id).revisionId, second.imported[0].revisionId);
});

test('application snapshot directory cannot escape the workspace through a symlink', async t => {
  const { directory, workspace, sources } = await setup(t);
  await symlink(directory, path.join(workspace.directory, '.ai-employee'));
  await assert.rejects(sources.upload(workspace.id, 'sample.txt', Buffer.from('safe')), /符号链接/);
});
