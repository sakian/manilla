import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatCents } from './money.ts';

test('plain decimals', () => {
  assert.equal(parseAmount('45.20').cents, 4520);
  assert.equal(parseAmount('-45.20').cents, -4520);
  assert.equal(parseAmount('0.01').cents, 1);
  assert.equal(parseAmount('3200').cents, 320000);
  assert.equal(parseAmount('3200.00').cents, 320000);
});

test('the float trap', () => {
  // 0.1 + 0.2 in floats is 0.30000000000000004; in cents it is exact.
  assert.equal(parseAmount('0.10').cents + parseAmount('0.20').cents, 30);
  // 1234.56 * 100 in floating point is 123455.99999999999.
  assert.equal(parseAmount('1234.56').cents, 123456);
  assert.equal(parseAmount('8.87').cents, 887);
});

test('thousands separators', () => {
  assert.equal(parseAmount('1,204.55').cents, 120455);
  assert.equal(parseAmount('-1,204.55').cents, -120455);
  assert.equal(parseAmount('1,234').cents, 123400, 'comma + 3 digits reads as thousands');
  assert.equal(parseAmount('1.234,56').cents, 123456, 'european: rightmost separator wins');
});

test('sign styles', () => {
  assert.equal(parseAmount('45.20-').cents, -4520, 'trailing sign');
  assert.equal(parseAmount('(45.20)').cents, -4520, 'accounting parentheses');
  assert.equal(parseAmount('+45.20').cents, 4520);
  assert.throws(() => parseAmount('-45.20-'), /Two signs/);
});

test('noise and currency symbols', () => {
  assert.equal(parseAmount(' $1,204.55 ').cents, 120455);
  assert.equal(parseAmount('1 204.55').cents, 120455);
});

test('ambiguity is reported, not hidden', () => {
  const ambiguous = parseAmount('1.234');
  assert.equal(ambiguous.cents, 123);
  assert.match(ambiguous.warning ?? '', /thousands separator/);

  const overPrecise = parseAmount('10.005');
  assert.equal(overPrecise.cents, 1001, 'rounds half up');
  assert.match(overPrecise.warning ?? '', /rounded to cents/);

  assert.equal(parseAmount('45.20').warning, undefined, 'unambiguous input is silent');
});

test('rejects garbage', () => {
  assert.throws(() => parseAmount(''));
  assert.throws(() => parseAmount('abc'));
  assert.throws(() => parseAmount('--'));
});

test('formatCents round-trips', () => {
  for (const text of ['0.00', '-45.20', '3200.00', '0.01', '-0.09']) {
    assert.equal(formatCents(parseAmount(text).cents), text);
  }
});
