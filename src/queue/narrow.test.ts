import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupEnvelopes, narrowEnvelopes } from './narrow.ts';

const envelopes = [
  { id: 'a', name: 'Groceries', groupName: 'Living' },
  { id: 'b', name: 'Insurance', groupName: 'Living' },
  { id: 'c', name: 'Fuel', groupName: 'Car' },
  { id: 'd', name: 'Insurance', groupName: 'Car' },
  { id: 'e', name: 'Café', groupName: 'Fun' },
];

const names = (groups: ReturnType<typeof narrowEnvelopes>) =>
  groups.map((group) => `${group.name}: ${group.envelopes.map((e) => e.id).join('')}`);

describe('narrowing the envelope picker', () => {
  test('envelopes are grouped under consecutive headings in the order given', () => {
    assert.deepEqual(names(groupEnvelopes(envelopes)), ['Living: ab', 'Car: cd', 'Fun: e']);
  });

  test('an empty or blank query is the whole list', () => {
    assert.deepEqual(narrowEnvelopes(envelopes, ''), groupEnvelopes(envelopes));
    assert.deepEqual(narrowEnvelopes(envelopes, '   '), groupEnvelopes(envelopes));
  });

  test('a query keeps matching envelopes under their headings and drops empty groups', () => {
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'insur')), ['Living: b', 'Car: d']);
  });

  test('every word must match, in the name or the category', () => {
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'car ins')), ['Car: d']);
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'car')), ['Car: cd']);
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'fuel ins')), []);
  });

  test('case and accents are ignored', () => {
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'CAFE')), ['Fun: e']);
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'café')), ['Fun: e']);
  });

  test('order is never re-ranked, so Enter takes what is at the top', () => {
    // "Fuel" matches more closely than "Groceries", but Living comes first.
    assert.deepEqual(names(narrowEnvelopes(envelopes, 'e')), [
      'Living: ab',
      'Car: cd',
      'Fun: e',
    ]);
  });
});
