import test from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../server/calculator.ts';

test('calculate returns exact integer sums and first-minus-rest differences, including financial cents', () => {
  assert.deepEqual(calculate({ operation: 'subtract', operands: [4800000, 3628000] }), { operation: 'subtract', operands: [4800000, 3628000], result: 1172000 });
  assert.equal(calculate({ operation: 'subtract', operands: [3000000, 2400000, 600000] }).result, 0);
  assert.equal(calculate({ operation: 'subtract', operands: [0, -4, 1] }).result, 3);
  assert.equal(calculate({ operation: 'sum', operands: [0, -3, 5] }).result, 2);
  assert.equal(calculate({ operation: 'sum', operands: Array(200).fill(1) }).result, 200);
  for (const boundary of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
    assert.equal(calculate({ operation: 'sum', operands: [boundary] }).result, boundary);
    assert.equal(calculate({ operation: 'subtract', operands: [boundary, 0] }).result, boundary);
  }
});

test('calculate rejects malformed inputs, noninteger operands and unsupported operations without coercion', () => {
  for (const input of [null, undefined, [], '1+2', { operation: 'multiply', operands: [1, 2] }, { operation: 'sum' }, { operation: 'sum', operands: '1,2' }, { operation: 'sum', operands: [] }, { operation: 'sum', operands: new Array(2) }, { operation: 'sum', operands: Array(201).fill(0) }, { operation: 'subtract', operands: [1] }]) {
    assert.throws(() => calculate(input), /calculate/);
  }
  for (const invalid of [0.01, '100', null, undefined, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, 1n]) {
    assert.throws(() => calculate({ operation: 'sum', operands: [invalid] }), /安全整数/);
  }
});

test('calculate rejects unsafe intermediate arithmetic even when later operands would restore a safe result', () => {
  for (const [operation, operands] of [
    ['sum', [Number.MAX_SAFE_INTEGER, 1]],
    ['sum', [Number.MAX_SAFE_INTEGER, 1, -1]],
    ['sum', [Number.MIN_SAFE_INTEGER, -1, 1]],
    ['subtract', [Number.MAX_SAFE_INTEGER, -1, 1]],
    ['subtract', [Number.MIN_SAFE_INTEGER, 1, -1]],
  ] as const) assert.throws(() => calculate({ operation, operands }), /中间值或结果/);
});
