import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envelopeProgress, monthPace } from './progress.ts';

test('the pace is the share of the month gone by the end of today', () => {
  assert.equal(monthPace('2026-09-10'), 10 / 30);
  assert.equal(monthPace('2026-02-14'), 14 / 28);
  assert.equal(monthPace('2028-02-14'), 14 / 29, 'a leap year has a longer February');
  assert.equal(monthPace('2026-10-31'), 1);
});

test('the bar is what was spent out of what the envelope had this month', () => {
  // $120 spent, $280 left: it had $400, and is 30% through it.
  assert.deepEqual(envelopeProgress({ spentCents: 12000, balanceCents: 28000 }, 0.5), {
    share: 0.3,
    availableCents: 40000,
    overspent: false,
    ahead: false,
  });
});

test('spending well ahead of the month is called out', () => {
  // 80% gone by the 10th of a 30-day month.
  const early = envelopeProgress({ spentCents: 32000, balanceCents: 8000 }, 10 / 30)!;
  assert.equal(early.ahead, true);
  // The same spending on the 25th is on track.
  assert.equal(envelopeProgress({ spentCents: 32000, balanceCents: 8000 }, 25 / 30)!.ahead, false);
});

test('a little ahead of the month is not worth a colour', () => {
  // 40% spent at a third of the month: within the margin.
  assert.equal(envelopeProgress({ spentCents: 4000, balanceCents: 6000 }, 1 / 3)!.ahead, false);
});

test('a bill paid in full early is done, not ahead', () => {
  const rent = envelopeProgress({ spentCents: 150000, balanceCents: 0 }, 1 / 30)!;
  assert.equal(rent.share, 1);
  assert.equal(rent.ahead, false);
  assert.equal(rent.overspent, false);
});

test('overspent fills the bar and says so', () => {
  const over = envelopeProgress({ spentCents: 12000, balanceCents: -2000 }, 0.5)!;
  assert.equal(over.share, 1);
  assert.equal(over.overspent, true);
  assert.equal(over.ahead, false, 'overspent is its own, stronger, signal');

  // Overspent with nothing funded at all.
  const unfunded = envelopeProgress({ spentCents: 5000, balanceCents: -5000 }, 0.5)!;
  assert.deepEqual([unfunded.share, unfunded.overspent], [1, true]);
});

test('an envelope that had nothing and spent nothing draws no bar', () => {
  assert.equal(envelopeProgress({ spentCents: 0, balanceCents: 0 }, 0.5), null);
});

test('money held but not yet spent draws no bar, so the 3rd of the month is not a row of empty tracks', () => {
  assert.equal(envelopeProgress({ spentCents: 0, balanceCents: 50000 }, 0.1), null);
});

test('refunds beyond spending are nothing spent, and draw no bar', () => {
  assert.equal(envelopeProgress({ spentCents: -2000, balanceCents: 12000 }, 0.5), null);
});

test('overspent with nothing spent this month - moved out, say - still says so', () => {
  const moved = envelopeProgress({ spentCents: 0, balanceCents: -3000 }, 0.5)!;
  assert.deepEqual([moved.share, moved.overspent], [1, true]);
});
