import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MonthError,
  addMonths,
  dateWithin,
  localToday,
  monthEnd,
  monthLabel,
  monthOf,
  monthStart,
} from './month.ts';

describe('budget months', () => {
  test('a month is the first seven characters of a date, not a parsed one', () => {
    assert.equal(monthOf('2026-09-19'), '2026-09');
    assert.equal(monthOf('2026-01-01'), '2026-01');
    assert.equal(monthOf('2026-12-31'), '2026-12');
  });

  test('a malformed date is refused rather than coerced', () => {
    assert.throws(() => monthOf('2026-9-19'), MonthError);
    assert.throws(() => monthOf('19/09/2026'), MonthError);
    assert.throws(() => monthOf('2026-13-01'), MonthError);
    assert.throws(() => monthStart('2026-13'), MonthError);
  });

  test('month bounds handle month lengths and leap years', () => {
    assert.equal(monthStart('2026-02'), '2026-02-01');
    assert.equal(monthEnd('2026-02'), '2026-02-28');
    assert.equal(monthEnd('2024-02'), '2024-02-29', 'a leap February has 29 days');
    assert.equal(monthEnd('2026-04'), '2026-04-30');
    assert.equal(monthEnd('2026-12'), '2026-12-31');
  });

  test('month arithmetic crosses year boundaries', () => {
    assert.equal(addMonths('2026-09', 1), '2026-10');
    assert.equal(addMonths('2026-12', 1), '2027-01');
    assert.equal(addMonths('2026-01', -1), '2025-12');
    assert.equal(addMonths('2026-09', -13), '2025-08');
    assert.equal(addMonths('2026-09', 0), '2026-09');
  });

  test('today is the local calendar day, not the UTC one', () => {
    // 11pm on the 19th, six hours behind UTC, is still the 19th locally even
    // though `toISOString()` would already say the 20th.
    const lateEvening = new Date(2026, 8, 19, 23, 30, 0);
    assert.equal(localToday(lateEvening), '2026-09-19');
  });

  test('money moved for a month is dated inside that month', () => {
    // Standing in the month: today's date.
    assert.equal(dateWithin('2026-09', '2026-09-19'), '2026-09-19');
    // Catching up on a past month: its last day, not today.
    assert.equal(dateWithin('2026-08', '2026-09-19'), '2026-08-31');
    // Getting ahead: its first day.
    assert.equal(dateWithin('2026-10', '2026-09-19'), '2026-10-01');
  });

  test('a month has a readable label', () => {
    assert.equal(monthLabel('2026-09'), 'September 2026');
    assert.equal(monthLabel('2026-01'), 'January 2026');
  });
});

test('days move across months, years and a leap day without a timezone', async () => {
  const { addDays } = await import('./month.ts');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.throws(() => addDays('2026-3-1', 1));
});

test('dates read the way people write them, this year without the year', async () => {
  const { displayDate } = await import('./month.ts');
  const today = '2026-09-21';
  assert.equal(displayDate('2026-09-18', today), 'Sept 18');
  assert.equal(displayDate('2026-06-03', today), 'June 3');
  assert.equal(displayDate('2025-12-31', today), 'Dec 31, 2025');
  assert.equal(displayDate('2027-01-01', today), 'Jan 1, 2027');
  // Something that is not a date is shown as it came rather than mangled.
  assert.equal(displayDate('soon', today), 'soon');
});
