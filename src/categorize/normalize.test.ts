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

test('real TD descriptors collapse to one merchant', () => {
  // Every case here comes from a real bank export.
  assert.equal(key('GRNDBRDG ENR L9R7K7'), key('GRNDBRDG ENR A5Z7A2'), 'postal codes are branch noise');
  assert.equal(key('GRNDBRDG ENR L9R7K7'), 'GRNDBRDG ENR');
  assert.equal(key('COSTCO WHOLESAL   _F'), key('COSTCO WHOLESAL'), 'the _F foreign-currency marker');
  assert.equal(key('EQUITABLE LIFE   INS'), 'EQUITABLE LIFE INS', 'padded spacing collapses');
  assert.equal(key('UR001 TFR-FR 9876543'), key('HI174 TFR-FR 9876543'), 'transfer reference prefixes');
  assert.equal(key('UR125 TFR-TO C/C'), key('LM265 TFR-TO C/C'));
});

test('e-transfer masks do not fork the payee', () => {
  // The mask differs on every transfer; without stripping it, each one looks
  // like a merchant never seen before.
  assert.equal(key('SEND E-TFR ***UpZ'), key('SEND E-TFR ***r9y'));
  assert.equal(key('SEND E-TFR ***UpZ'), 'SEND E-TFR');
});

test('mixed letter-and-digit reference codes are dropped', () => {
  assert.equal(key('Spotify P4549d89f1'), 'SPOTIFY');
  assert.equal(key('AMZN Mktp CA*5Q1RN4GA0'), 'AMZN MKTP');
  assert.equal(key('Spotify P4549d89f1'), key('Spotify P1747'), 'both forms reach one merchant');
});

test('short alphanumerics that are part of a name survive', () => {
  assert.equal(key('A1 STEAKHOUSE'), 'A1 STEAKHOUSE');
  assert.equal(key('7-ELEVEN'), '7-ELEVEN');
  assert.equal(key('SAVE ON FOODS 2024'), 'SAVE ON FOODS', 'a bare 4-digit store number still goes');
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
