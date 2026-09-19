/**
 * Budget months as plain strings.
 *
 * A budget month is `YYYY-MM`, and its bounds are `YYYY-MM-DD`. This follows the
 * same rule as the OFX parser and the `date` columns: a calendar month is not an
 * instant, and turning it into a `Date` invites a timezone to move a transaction
 * into the month before or after - which, in a budgeting app, silently moves
 * money between budgets.
 *
 * The only place a real clock is read is `currentMonth`, and it takes the day as
 * an argument so tests never depend on when they run.
 */

export type MonthKey = string;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class MonthError extends Error {}

export function assertMonth(month: string): MonthKey {
  if (!MONTH.test(month)) throw new MonthError(`Not a budget month (YYYY-MM): ${month}`);
  return month;
}

/** The month a calendar date falls in. */
export function monthOf(date: string): MonthKey {
  if (!DAY.test(date)) throw new MonthError(`Not a calendar date (YYYY-MM-DD): ${date}`);
  return date.slice(0, 7);
}

/** Today's month. Pass `today` in tests; the default reads the local clock. */
export function currentMonth(today: string = localToday()): MonthKey {
  return monthOf(today);
}

/**
 * The local calendar date, not the UTC one. `toISOString()` would hand back
 * yesterday for anyone west of Greenwich for most of the evening.
 */
export function localToday(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthStart(month: MonthKey): string {
  return `${assertMonth(month)}-01`;
}

/** Last day of the month, leap years included. */
export function monthEnd(month: MonthKey): string {
  assertMonth(month);
  const [year, index] = month.split('-').map(Number) as [number, number];
  // Day 0 of the next month is the last day of this one, and `Date.UTC` keeps
  // the arithmetic away from any local timezone.
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

export function addMonths(month: MonthKey, delta: number): MonthKey {
  assertMonth(month);
  const [year, index] = month.split('-').map(Number) as [number, number];
  const zeroBased = year * 12 + (index - 1) + delta;
  const outYear = Math.floor(zeroBased / 12);
  const outMonth = zeroBased - outYear * 12 + 1;
  return `${String(outYear).padStart(4, '0')}-${String(outMonth).padStart(2, '0')}`;
}

/** Human form for a heading: `2026-09` becomes `September 2026`. */
export function monthLabel(month: MonthKey): string {
  assertMonth(month);
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const [year, index] = month.split('-');
  return `${names[Number(index) - 1]} ${year}`;
}

/**
 * The date to stamp on money moved for a given budget month.
 *
 * Funding September's envelopes on the 19th of September is dated the 19th. But
 * funding a month you are not standing in - catching up on August, or getting
 * ahead on October - is dated inside that month, because an allocation dated
 * outside the month it funds would report against the wrong one.
 */
export function dateWithin(month: MonthKey, today: string = localToday()): string {
  if (monthOf(today) === assertMonth(month)) return today;
  return today > monthEnd(month) ? monthEnd(month) : monthStart(month);
}
