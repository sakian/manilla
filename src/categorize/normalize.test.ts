import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayee } from './normalize.ts';

const key = (raw: string) => normalizePayee(raw).key;

test('store numbers and cities collapse to one merchant', () => {
  assert.equal(key('SHELL #4471 CALGARY AB'), 'SHELL');
  assert.equal(key('SHELL #2280'), 'SHELL');
  assert.equal(key('PETRO-CANADA 12345'), 'PETRO-CANADA');
  assert.equal(key('SAFEWAY #212'), 'SAFEWAY');
});

test('the same merchant through different channels shares a key', () => {
  const expected = 'TIM HORTONS';
  for (const raw of [
    'TIM HORTONS #4521',
    'POS PURCHASE TIM HORTONS #4521',
    'INTERAC PURCHASE TIM HORTONS 4521 AB',
    'VISA DEBIT PURCHASE TIM HORTONS #0099 CALGARY AB',
  ]) {
    assert.equal(key(raw), expected, raw);
  }
});

test('payment processor prefixes are unwrapped', () => {
  assert.equal(key('SQ *BLUE DOOR COFFEE'), 'BLUE DOOR COFFEE');
  assert.equal(key('TST* THE COPPER POT'), 'THE COPPER POT');
  assert.equal(key('AMZN Mktp CA*1A2B3C'), 'AMZN MKTP');
});

test('domains and hyphenated names keep their shape', () => {
  assert.equal(key('NETFLIX.COM'), 'NETFLIX.COM');
  assert.equal(key('PETRO-CANADA'), 'PETRO-CANADA');
});

test('embedded dates and reference numbers are dropped', () => {
  assert.equal(key('EPCOR WATER 09/03'), 'EPCOR WATER');
  assert.equal(key('CITY POWER 887766554'), 'CITY POWER');
});

test('reference codes glued to letters are dropped', () => {
  // No word boundary sits between "P" and the digits, so a plain \d{4,} misses these.
  assert.equal(key('SPOTIFY P1747'), 'SPOTIFY');
  assert.equal(key('SPOTIFY P6703'), 'SPOTIFY');
  assert.equal(key('TELUS MOBILITY REF00912'), 'TELUS MOBILITY');
  assert.equal(key('GOODLIFE FITNESS 4471AB'), 'GOODLIFE FITNESS');
});

test('short alphanumerics that are part of a name survive', () => {
  assert.equal(key('A1 STEAKHOUSE'), 'A1 STEAKHOUSE');
  assert.equal(key('7-ELEVEN'), '7-ELEVEN');
});

test('trailing courtesies are dropped', () => {
  assert.equal(key('PAYMENT - THANK YOU'), 'PAYMENT');
});

test('a merchant named after a city keeps its name', () => {
  assert.equal(key('CALGARY CO-OP #41'), 'CALGARY CO-OP');
  assert.equal(key('LONDON DRUGS 8812'), 'LONDON DRUGS');
});

test('normalization is idempotent', () => {
  for (const raw of ['SHELL #4471 CALGARY AB', 'SQ *BLUE DOOR COFFEE', 'NETFLIX.COM']) {
    assert.equal(key(key(raw)), key(raw), raw);
  }
});

test('a description that is entirely noise still yields a key', () => {
  assert.notEqual(key('#12345'), '');
  assert.notEqual(key('POS PURCHASE'), '');
});

test('display form is readable', () => {
  assert.equal(normalizePayee('SHELL #4471').display, 'Shell');
  assert.equal(normalizePayee('NETFLIX.COM').display, 'NETFLIX.COM');
});
