/**
 * The geometry of a time chart that is not about pixels: which values the axis
 * names, which months it labels, and how far along a date is. Kept apart from
 * the drawing so it can be tested, and so the drawing is only drawing.
 */

import { addMonths, monthOf, monthStart, type MonthKey } from '../budget/month.ts';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days from `from` to `to`, by the calendar - no timezone involved. */
export function daysBetween(from: string, to: string): number {
  const a = DAY.exec(from)!;
  const b = DAY.exec(to)!;
  const utc = (m: RegExpExecArray) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

/**
 * Round values for a value axis: a 1, 2 or 5 step, covering `min`..`max`, and
 * always including zero - for a balance, which side of zero it is on is the
 * first thing to read.
 */
export function niceTicks(min: number, max: number, most = 5): number[] {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (low === high) return [0];

  const rough = (high - low) / Math.max(1, most - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough)!;

  const ticks: number[] = [];
  for (let value = Math.floor(low / step) * step; value <= high + step * 1e-9; value += step) {
    ticks.push(Math.round(value));
    if (value >= high) break;
  }
  if (ticks[ticks.length - 1]! < high) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

/**
 * The months to label along the bottom: the first of each month inside the
 * range, every month or every second, third, sixth, twelfth - aligned to January,
 * so the labels land on the same months whatever the range - until no more than
 * `most` are left.
 *
 * A label is the month's name alone, with its year on the first and on each
 * January: "Oct 2026", "Nov", "Dec", "Jan 2027". Not "Oct 26", which beside a
 * date written "Oct 2" reads as the 26th of October.
 */
export function monthTicks(
  start: string,
  end: string,
  most: number,
): { date: string; label: string }[] {
  const months: MonthKey[] = [];
  for (let month = monthOf(start); month <= monthOf(end); month = addMonths(month, 1)) {
    if (monthStart(month) >= start) months.push(month);
  }
  const index = (month: MonthKey) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
  const every = (stride: number) => months.filter((month) => index(month) % stride === 0);
  const stride = [1, 2, 3, 6, 12, 24, 60, 120].find((each) => every(each).length <= most) ?? 240;
  return every(stride).map((month, at) => {
    const name = MONTH_NAMES[Number(month.slice(5)) - 1]!;
    const withYear = at === 0 || month.endsWith('-01');
    return { date: monthStart(month), label: withYear ? `${name} ${month.slice(0, 4)}` : name };
  });
}
