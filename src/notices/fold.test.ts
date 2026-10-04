import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldNotices } from './fold.ts';
import type { AttentionKind } from './notices.ts';

const notice = (kind: AttentionKind, severity: 'bad' | 'warn' | 'info') => ({ kind, severity });
const kinds = (list: { kind: string }[]) => list.map((item) => item.kind);

test('the review queue stays up front and the other alerts fold, ranked', () => {
  const { shown, folded } = foldNotices([
    notice('rules_to_suggest', 'info'),
    notice('awaiting_review', 'info'),
    notice('envelopes_overspent', 'warn'),
    notice('sync_held', 'warn'),
  ]);
  assert.deepEqual(kinds(shown), ['awaiting_review']);
  assert.deepEqual(kinds(folded), ['envelopes_overspent', 'sync_held', 'rules_to_suggest']);
});

test('nothing bad is ever folded (FR-37)', () => {
  const { shown, folded } = foldNotices([
    notice('awaiting_review', 'info'),
    notice('ledger_mismatch', 'bad'),
    notice('pool_overdrawn', 'bad'),
    notice('envelopes_overspent', 'warn'),
    notice('unallocated', 'info'),
  ]);
  assert.deepEqual(kinds(shown), ['ledger_mismatch', 'pool_overdrawn', 'awaiting_review']);
  assert.deepEqual(kinds(folded), ['envelopes_overspent', 'unallocated']);
});

test('a single alert is shown rather than folded under a count', () => {
  const { shown, folded } = foldNotices([
    notice('awaiting_review', 'info'),
    notice('envelopes_overspent', 'warn'),
  ]);
  assert.deepEqual(kinds(shown), ['envelopes_overspent', 'awaiting_review']);
  assert.deepEqual(folded, []);
});

test('with nothing to review and nothing broken, the alerts are one line', () => {
  const { shown, folded } = foldNotices([
    notice('envelopes_overspent', 'warn'),
    notice('statement_mismatch', 'warn'),
  ]);
  assert.deepEqual(shown, []);
  assert.equal(folded.length, 2);
});
