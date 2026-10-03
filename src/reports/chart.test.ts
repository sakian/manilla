import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, monthTicks, niceTicks } from './chart.ts';

test('days are counted by the calendar', () => {
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2, 'across a daylight-saving change');
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2, 'a leap day');
  assert.equal(daysBetween('2026-10-03', '2026-10-03'), 0);
});

test('the value axis steps by a round number and always shows zero', () => {
  assert.deepEqual(niceTicks(0, 38000), [0, 10000, 20000, 30000, 40000]);
  assert.deepEqual(niceTicks(12000, 38000), [0, 10000, 20000, 30000, 40000], 'zero even when the line is above it');
  assert.deepEqual(niceTicks(-15000, 25000), [-20000, -10000, 0, 10000, 20000, 30000].filter((v) => v >= -20000), 'either side of zero');
  assert.deepEqual(niceTicks(0, 0), [0]);
  for (const ticks of [niceTicks(0, 38000), niceTicks(-15000, 25000), niceTicks(-901, 77)]) {
    assert.ok(ticks.includes(0));
    assert.ok(ticks.length <= 7, String(ticks));
  }
});

test('the axis covers the line', () => {
  const ticks = niceTicks(-15000, 25000);
  assert.ok(ticks[0]! <= -15000 && ticks[ticks.length - 1]! >= 25000);
});

test('a year is labelled month by month, or thinned to fit', () => {
  const year = monthTicks('2025-10-01', '2026-09-30', 12);
  assert.equal(year.length, 12);
  assert.deepEqual(year.slice(0, 2), [
    { date: '2025-10-01', label: 'Oct 2025' },
    { date: '2025-11-01', label: 'Nov' },
  ]);
  const narrow = monthTicks('2025-10-01', '2026-09-30', 4);
  assert.deepEqual(narrow.map((tick) => tick.label), ['Oct 2025', 'Jan 2026', 'Apr', 'Jul'], 'quarters');
  assert.ok(
    year.every((tick) => !/^[A-Z][a-z]{2} \d{1,2}$/.test(tick.label)),
    'never "Oct 26", which reads as a day',
  );
});

test('a range starting mid-month labels only the months that start inside it', () => {
  assert.deepEqual(monthTicks('2026-09-15', '2026-10-03', 6).map((tick) => tick.date), ['2026-10-01']);
});

test('six years are labelled by January', () => {
  const ticks = monthTicks('2020-03-01', '2026-10-03', 6);
  assert.ok(ticks.length <= 6);
  assert.ok(ticks.every((tick) => tick.date.slice(5) === '01-01'));
});
