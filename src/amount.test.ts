import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmountError, centsFromInput, inputFromCents } from './amount.ts';

test('a blank box is zero, not an error', () => {
  assert.equal(centsFromInput(''), 0);
  assert.equal(centsFromInput('   '), 0);
});

test('what people type lands on the same cents an import would', () => {
  assert.equal(centsFromInput('45.20'), 4520);
  assert.equal(centsFromInput(' 45.2 '), 4520);
  assert.equal(centsFromInput('$1,234.50'), 123450);
  assert.equal(centsFromInput('1,234'), 123400, 'a comma before three digits is thousands');
  assert.equal(centsFromInput('-12.50'), -1250);
  assert.equal(centsFromInput('12'), 1200);
  // The case floats get wrong: 1234.56 * 100 is 123455.99999999999.
  assert.equal(centsFromInput('1234.56'), 123456);
});

test('what is not an amount is refused, saying what was typed', () => {
  for (const text of ['abc', '1e3', '--5', '-5-', '$']) {
    assert.throws(() => centsFromInput(text), AmountError, text);
  }
  assert.throws(() => centsFromInput('abc'), /"abc" is not an amount/);
});

test('an amount that could be read two ways is refused rather than guessed (#16)', () => {
  // "1.234" is a thousand in much of the world and $1.23 by the OFX rule. A form
  // used to save the second without saying so.
  for (const text of ['1.234', '12.345', '10.005']) {
    assert.throws(() => centsFromInput(text), AmountError, text);
  }
  assert.throws(() => centsFromInput('1.234'), /more than two digits after the point/);
});

test('what goes back into a box reads back as the same cents', () => {
  for (const cents of [0, 1, 99, 100, 4520, -1250, 123456, -100000001]) {
    assert.equal(centsFromInput(inputFromCents(cents)), cents, String(cents));
  }
  assert.equal(inputFromCents(123456), '1234.56', 'no symbol and no grouping in a field');
});
