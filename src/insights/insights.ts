/**
 * Charges that look out of the ordinary, found by arithmetic (AI-1, AI-2, #11).
 *
 * Section 6.3's rule is that code does the arithmetic and detection, and a model
 * at most explains it. This is the first step of it with no model at all: two
 * checks against your own history, each stating what it found and the numbers
 * behind it, worded by a template in app/Notices.tsx.
 *
 * Both are shown among the notices, which run on every main screen and show
 * nothing when nothing is wrong - that emptiness is how you know there is
 * nothing to do. So both are narrow on purpose, and look only at the last month:
 *
 *  - **A regular charge that jumped.** A payee that has charged you at least four
 *    times in the year before, in amounts that barely vary - a utility, an
 *    insurer, a subscription - now charging well over its usual. Variable
 *    payees like a grocery store are left out by the variation test, because a
 *    big shop is not news.
 *  - **A large first charge.** A payee never seen before, charging more than
 *    almost anything else you spent in the year. A small new merchant is not
 *    news either.
 *
 * Saying "that was expected" dismisses one for good, by transaction.
 */

import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { appSettings } from '../../db/schema.ts';
import { addDays, localToday } from '../budget/month.ts';

/** How far back a charge is still news. */
export const RECENT_DAYS = 31;

/** A regular payee: charges in the year before, at least this many. */
export const REGULAR_MIN_CHARGES = 4;
/** ...varying by no more than this share of their average (standard deviation / mean). */
export const REGULAR_MAX_VARIATION = 0.25;
/** A jump: above the usual by more than this share... */
export const JUMP_SHARE = 0.3;
/** ...and by at least this much, so $3 becoming $4 is not a finding. */
export const JUMP_MIN_CENTS = 1_000;

/** A large charge: above this share of a year's charges... */
export const LARGE_PERCENTILE = 0.95;
/** ...and at least this much. */
export const LARGE_MIN_CENTS = 10_000;
/** A year with fewer charges than this has no "usual" worth comparing against. */
export const LARGE_MIN_HISTORY = 50;

/**
 * At most this many at once. A safety valve rather than a filter: past one
 * finding per payee, more than a handful in a month means something else is
 * wrong - an import read twice, say - and a wall of notices would bury it.
 */
export const MOST_SHOWN = 5;

export type Insight =
  | {
      kind: 'charge_jumped';
      transactionId: string;
      payee: string;
      date: string;
      cents: number;
      /** The payee's average charge over the year before this one. */
      usualCents: number;
      /** How many charges that average is over. */
      charges: number;
    }
  | {
      kind: 'large_new_payee';
      transactionId: string;
      payee: string;
      date: string;
      cents: number;
      /** What 95% of the year's charges were below. */
      thresholdCents: number;
    };

/** A charge is above its usual by this share: 0.62 for "62% above". */
export function jumpShare(cents: number, usualCents: number): number {
  return usualCents > 0 ? cents / usualCents - 1 : 0;
}

/** Whether a regular payee's charge is far enough above its usual to say so. */
export function isJump(charge: {
  cents: number;
  charges: number;
  meanCents: number;
  stddevCents: number;
}): boolean {
  const { cents, charges, meanCents, stddevCents } = charge;
  if (charges < REGULAR_MIN_CHARGES || meanCents <= 0) return false;
  if (stddevCents / meanCents > REGULAR_MAX_VARIATION) return false;
  return jumpShare(cents, meanCents) > JUMP_SHARE && cents - meanCents >= JUMP_MIN_CENTS;
}

const DISMISSED_KEY = 'dismissed_insights';
/** Kept to the most recent, since a dismissed charge older than a month is never shown again anyway. */
const DISMISSED_KEPT = 200;

export async function dismissedInsights(db: Database): Promise<string[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, DISMISSED_KEY))
    .limit(1);
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** "That was expected": this charge is not mentioned again. */
export async function dismissInsight(db: Database, transactionId: string): Promise<void> {
  const already = await dismissedInsights(db);
  if (already.includes(transactionId)) return;
  const value = JSON.stringify([...already, transactionId].slice(-DISMISSED_KEPT));
  await db
    .insert(appSettings)
    .values({ key: DISMISSED_KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Spending, as these checks mean it: money out on an ordinary transaction, not a
 * transfer between your own accounts and not an opening balance.
 */
const SPENDING = sql`t.kind = 'spending' and t.amount_cents < 0 and t.source <> 'opening_balance' and t.payee_key <> ''`;

/**
 * The charges worth a look, newest first. `today` is for tests; the default is
 * the local calendar day.
 */
export async function unusualCharges(
  db: Database,
  options: { today?: string } = {},
): Promise<Insight[]> {
  const today = options.today ?? localToday();
  const since = addDays(today, -(RECENT_DAYS - 1));

  const [jumps, large, dismissed] = await Promise.all([
    // Each recent charge against the same payee's charges in the year before it.
    // A lateral join, so the history is read only for the month's few charges,
    // through the payee index, rather than for every transaction there is.
    db.execute<{
      id: string;
      key: string;
      payee: string;
      date: string;
      cents: string;
      charges: string;
      mean: string | null;
      stddev: string | null;
    }>(sql`
      select t.id, t.payee_key as key, t.payee_raw as payee, t.date::text as date,
             -t.amount_cents as cents, h.charges, h.mean, h.stddev
      from transactions t
      cross join lateral (
        select count(*) as charges,
               avg(-p.amount_cents) as mean,
               coalesce(stddev_pop(-p.amount_cents), 0) as stddev
        from transactions p
        where p.payee_key = t.payee_key
          and p.kind = 'spending' and p.amount_cents < 0 and p.source <> 'opening_balance'
          and p.date < t.date and p.date >= t.date - 365
      ) h
      where ${SPENDING} and t.date between ${since}::date and ${today}::date
        and h.charges >= ${REGULAR_MIN_CHARGES}
    `),
    // A first charge from a payee, against the size of everything spent in the
    // year: the 95th percentile, read once.
    db.execute<{ id: string; key: string; payee: string; date: string; cents: string; threshold: string }>(sql`
      with year as (
        select percentile_cont(${LARGE_PERCENTILE}) within group (order by -t.amount_cents) as threshold,
               count(*) as charges
        from transactions t
        where ${SPENDING} and t.date > ${today}::date - 365 and t.date <= ${today}::date
      )
      select t.id, t.payee_key as key, t.payee_raw as payee, t.date::text as date,
             -t.amount_cents as cents, year.threshold
      from transactions t, year
      where ${SPENDING} and t.date between ${since}::date and ${today}::date
        and year.charges >= ${LARGE_MIN_HISTORY}
        and -t.amount_cents > year.threshold
        and -t.amount_cents >= ${LARGE_MIN_CENTS}
        and not exists (
          select 1 from transactions e
          where e.payee_key = t.payee_key and e.id <> t.id and e.date < t.date
        )
    `),
    dismissedInsights(db),
  ]);

  const skip = new Set(dismissed);
  const found: (Insight & { key: string })[] = [];

  for (const row of jumps) {
    const charge = {
      cents: Number(row.cents),
      charges: Number(row.charges),
      meanCents: Number(row.mean ?? 0),
      stddevCents: Number(row.stddev ?? 0),
    };
    if (skip.has(row.id) || !isJump(charge)) continue;
    found.push({
      kind: 'charge_jumped',
      key: row.key,
      transactionId: row.id,
      payee: row.payee,
      date: row.date,
      cents: charge.cents,
      usualCents: Math.round(charge.meanCents),
      charges: charge.charges,
    });
  }

  for (const row of large) {
    if (skip.has(row.id)) continue;
    found.push({
      kind: 'large_new_payee',
      key: row.key,
      transactionId: row.id,
      payee: row.payee,
      date: row.date,
      cents: Number(row.cents),
      thresholdCents: Math.round(Number(row.threshold)),
    });
  }

  // One per payee - the most recent - since three high water bills in a month
  // are one thing to look into, not three.
  const byPayee = new Map<string, Insight>();
  for (const { key, ...insight } of found.sort((left, right) => right.date.localeCompare(left.date))) {
    if (!byPayee.has(key)) byPayee.set(key, insight);
  }
  return [...byPayee.values()].slice(0, MOST_SHOWN);
}
