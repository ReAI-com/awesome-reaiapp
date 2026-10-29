// Read-only acceptance check for the synthetic finance demo. Never reads model credentials.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [workspaceId, origin = 'http://127.0.0.1:4317'] = process.argv.slice(2);
if (!workspaceId) throw new Error('Usage: node examples/finance/verify.mjs <workspaceId> [local origin]');
const url = new URL(origin);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Verification only connects to a local workbench');
const expected = JSON.parse(await readFile(new URL('./expected.json', import.meta.url), 'utf8'));
const response = await fetch(`${url.origin}/api/workspaces/${encodeURIComponent(workspaceId)}/state`);
assert(response.ok, `Workspace response ${response.status}`);
const state = await response.json();
assert.equal(state.datasets.length, 2, 'Two independently inferred schemas');
assert(state.specs.every(s => !s.schema), 'Cleaning specifications must not contain a prefilled schema');
for (const d of state.datasets) {
  assert.equal(d.schema.type, 'object');
  assert.equal(d.schema.additionalProperties, false);
  assert.equal(d.schema.properties.amount_fen.type, 'integer');
  assert(Object.values(d.schema.properties).every(p => typeof p.type === 'string'));
}
const transactions = state.records.filter(r => 'transaction_id' in r.data);
const invoices = state.records.filter(r => 'invoice_date' in r.data);
assert.equal(transactions.length, expected.counts.bank_transactions);
assert.equal(invoices.length, expected.counts.invoices);
assert.equal(state.records.length, transactions.length + invoices.length);
for (const row of state.records) {
  assert(row.sourceFileId && row.sourceRevisionId && row.runId && !row.manual, 'Published rows must retain automatic cleaning provenance');
  assert.equal(row.data.currency, expected.currency);
  assert(Number.isSafeInteger(row.data.amount_fen));
  assert(state.files.some(f => f.id === row.sourceFileId && f.cleanedRevisionId === row.sourceRevisionId));
}
for (const item of expected.transactions) {
  const row = transactions.find(r => r.data.transaction_id === item.transaction_id);
  assert(row, `Missing ${item.transaction_id}`);
  for (const [field, value] of Object.entries(item)) assert.deepEqual(row.data[field], value, `${item.transaction_id}.${field}`);
}
const cash = transactions.filter(r => r.data.transaction_date >= expected.cash_period.from && r.data.transaction_date <= expected.cash_period.to);
const sum = rows => rows.reduce((total, row) => total + row.data.amount_fen, 0);
const metrics = { cash_receipts: sum(cash.filter(r => r.data.direction === 'receipt')), cash_payments: sum(cash.filter(r => r.data.direction === 'payment')) };
metrics.net_cash_flow = metrics.cash_receipts - metrics.cash_payments;
metrics.invoiced_amount = sum(invoices.filter(r => r.data.invoice_date <= expected.as_of));
metrics.receivables_outstanding = 0; metrics.receivables_overdue = 0;
for (const item of expected.invoices) {
  const row = invoices.find(r => r.data.invoice_id === item.invoice_id);
  assert(row, `Missing ${item.invoice_id}`);
  for (const field of ['invoice_id', 'customer', 'invoice_date', 'due_date', 'amount_fen', 'source_row']) assert.deepEqual(row.data[field], item[field], `${item.invoice_id}.${field}`);
  const receipts = transactions.filter(r => r.data.direction === 'receipt' && r.data.invoice_id === item.invoice_id && r.data.transaction_date <= expected.as_of && r.data.currency === row.data.currency);
  const collected = sum(receipts), outstanding = row.data.amount_fen - collected;
  assert.equal(collected, item.collected_fen); assert.equal(outstanding, item.outstanding_fen);
  assert.deepEqual(receipts.map(r => r.data.transaction_id).sort(), [...item.receipt_ids].sort());
  const overdue = row.data.due_date < expected.as_of ? Math.max(0, outstanding) : 0;
  assert.equal(overdue, item.overdue_fen);
  metrics.receivables_outstanding += Math.max(0, outstanding); metrics.receivables_overdue += overdue;
}
assert.deepEqual(metrics, expected.metrics_fen);
assert(state.files.every(f => ['清洗完成', '更新完成'].includes(f.state) && !f.error));
console.log(JSON.stringify({ passed: true, records: state.records.length, schemas: state.datasets.length, asOf: expected.as_of, metricsYuan: Object.fromEntries(Object.entries(metrics).map(([k,v]) => [k,v/100])) }, null, 2));
