/**
 * An envelope's balance over a period, for drawing (VW-4, #4).
 *
 * The balance is the one figure that carries over month to month (FR-23), so
 * its shape over a year says what a list of transactions does not: an envelope
 * slowly draining, one quietly accumulating, one that spikes every February.
 *
 * It changes on particular days and holds between them, so it comes back as a
 * step: the balance going into the period, then the balance at the end of each
 * day something changed, then where it stands at the end. Read from the same
 * records as every other balance - lines, and moves in and out - so the last
 * point is the envelope's balance, not an estimate of it.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { addMonths, monthEnd, monthOf, type MonthKey } from '../budget/month.ts';
import type { Period } from './reports.ts';

export type BalancePoint = { date: string; balanceCents: number };

export type BalanceSeries = {
  /** Where the line starts: the period's start, or the envelope's first activity if later. */
  start: string;
  /** Where it ends: the period's end, or today if that is sooner. */
  end: string;
  /** The balance going in, then after each day with a change, then at the end. */
  points: BalancePoint[];
};

/**
 * The step series from a balance going in and each day's net change.
 *
 * A pure function so the arithmetic is tested without a database; `changes`
 * must be in date order, one per day, all within `start`..`end`.
 */
export function toSeries(
  openingCents: number,
  changes: { date: string; cents: number }[],
  start: string,
  end: string,
): BalanceSeries {
  const points: BalancePoint[] = [{ date: start, balanceCents: openingCents }];
  let balance = openingCents;
  for (const change of changes) {
    balance += change.cents;
    points.push({ date: change.date, balanceCents: balance });
  }
  if (points[points.length - 1]!.date < end) points.push({ date: end, balanceCents: balance });
  return { start, end, points };
}

/** The balance at the end of each month the series covers - its table view. */
export function monthEndBalances(series: BalanceSeries): { month: MonthKey; balanceCents: number }[] {
  const rows: { month: MonthKey; balanceCents: number }[] = [];
  let at = 0;
  let balance = series.points[0]?.balanceCents ?? 0;
  for (let month = monthOf(series.start); month <= monthOf(series.end); month = addMonths(month, 1)) {
    const last = monthEnd(month) < series.end ? monthEnd(month) : series.end;
    while (at < series.points.length && series.points[at]!.date <= last) {
      balance = series.points[at]!.balanceCents;
      at += 1;
    }
    rows.push({ month, balanceCents: balance });
  }
  return rows;
}

export async function envelopeBalanceSeries(
  db: Database,
  envelopeId: string,
  period: Period,
  today: string,
): Promise<BalanceSeries> {
  const to = period.to < today ? period.to : today;

  // Every change to the envelope, as one signed amount per row: its lines, the
  // moves into it, and the moves out of it negated.
  const changes = sql`
    select t.date, l.amount_cents as cents
      from txn_lines l join transactions t on t.id = l.transaction_id
      where l.envelope_id = ${envelopeId}
    union all
    select m.date, m.amount_cents from envelope_moves m where m.to_envelope_id = ${envelopeId}
    union all
    select m.date, -m.amount_cents from envelope_moves m where m.from_envelope_id = ${envelopeId}
  `;

  const [opening, daily] = await Promise.all([
    db.execute<{ cents: string; first: string | null }>(sql`
      select coalesce(sum(cents) filter (where date < ${period.from}::date), 0)::bigint as cents,
             min(date)::text as first
      from (${changes}) c
    `),
    db.execute<{ date: string; cents: string }>(sql`
      select date::text as date, sum(cents)::bigint as cents
      from (${changes}) c
      where date >= ${period.from}::date and date <= ${to}::date
      group by date
      having sum(cents) <> 0
      order by date
    `),
  ]);

  const openingCents = Number(opening[0]?.cents ?? 0);
  const first = opening[0]?.first ?? null;
  // "All time" starts in 1970; a line flat at zero for fifty years says nothing,
  // so an envelope with nothing before the period starts where its history does.
  const start = openingCents === 0 && first && first > period.from && first <= to ? first : period.from;

  return toSeries(
    openingCents,
    daily.map((row) => ({ date: row.date, cents: Number(row.cents) })),
    start,
    to < start ? start : to,
  );
}
