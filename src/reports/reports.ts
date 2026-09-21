/**
 * Reports (RP-1, RP-2, RP-5, RP-6).
 *
 * Spending is read from `txn_lines`, never from transactions, and that single
 * choice is what makes RP-5 true rather than something to remember:
 *
 *  - a transfer between your own accounts has no envelope lines at all, so it
 *    cannot appear in a spending report however it is summed (FR-5);
 *  - an envelope-to-envelope move is not a transaction, so it is not here
 *    either (FR-36);
 *  - a split is already stored as one line per envelope, so every envelope is
 *    counted at its own share without anything having to divide it.
 *
 * Two things are excluded on purpose. An account's opening balance is not
 * spending, it is where the account started. And money arriving in the income
 * pool is income; only money genuinely spent *out* of the pool counts, which is
 * the same rule the budget screen uses so the two never disagree.
 *
 * Amounts come back as positive numbers for money spent, because "spent -412.50"
 * reads as a refund to everyone except a programmer.
 */

import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, envelopeGroups, envelopes, transactions, txnLines } from '../../db/schema.ts';
import { addMonths, monthEnd, monthOf, monthStart, type MonthKey } from '../budget/month.ts';

export type Period = { from: string; to: string };

/** The rule shared by every report here, so none of them can drift from another. */
const spendingLines = (from: string, to: string) =>
  and(
    gte(transactions.date, from),
    lte(transactions.date, to),
    sql`${transactions.source} <> 'opening_balance'`,
    // Income landing in the pool is not spending; money spent out of it is.
    sql`(${txnLines.amountCents} < 0 or not ${envelopes.isUnallocated})`,
  );

export type EnvelopeSpending = {
  envelopeId: string;
  name: string;
  groupId: string;
  groupName: string;
  spentCents: number;
  transactionCount: number;
};

export type GroupSpending = {
  groupId: string;
  name: string;
  spentCents: number;
  envelopes: EnvelopeSpending[];
};

export type SpendingReport = {
  period: Period;
  groups: GroupSpending[];
  totalCents: number;
  /** Envelopes that saw nothing in the period are left out rather than listed as zero. */
  envelopeCount: number;
};

/** RP-1: what was spent, per envelope and rolled up per group. */
export async function spendingByEnvelope(
  db: Database,
  period: Period,
): Promise<SpendingReport> {
  const rows = await db
    .select({
      envelopeId: envelopes.id,
      name: envelopes.name,
      groupId: envelopeGroups.id,
      groupName: envelopeGroups.name,
      groupPosition: envelopeGroups.position,
      position: envelopes.position,
      spentCents: sql<string>`(-sum(${txnLines.amountCents}))::bigint`,
      transactionCount: sql<string>`count(distinct ${txnLines.transactionId})::bigint`,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(transactions.id, txnLines.transactionId))
    .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
    .innerJoin(envelopeGroups, eq(envelopeGroups.id, envelopes.groupId))
    .where(spendingLines(period.from, period.to))
    .groupBy(
      envelopes.id,
      envelopes.name,
      envelopes.position,
      envelopeGroups.id,
      envelopeGroups.name,
      envelopeGroups.position,
    )
    .orderBy(asc(envelopeGroups.position), asc(envelopes.name));

  const groups = new Map<string, GroupSpending>();
  let totalCents = 0;

  for (const row of rows) {
    const spentCents = Number(row.spentCents);
    totalCents += spentCents;

    const group = groups.get(row.groupId) ?? {
      groupId: row.groupId,
      name: row.groupName,
      spentCents: 0,
      envelopes: [],
    };
    group.spentCents += spentCents;
    group.envelopes.push({
      envelopeId: row.envelopeId,
      name: row.name,
      groupId: row.groupId,
      groupName: row.groupName,
      spentCents,
      transactionCount: Number(row.transactionCount),
    });
    groups.set(row.groupId, group);
  }

  return {
    period,
    groups: [...groups.values()],
    totalCents,
    envelopeCount: rows.length,
  };
}

export type TrendRow = {
  envelopeId: string;
  name: string;
  groupName: string;
  /** One figure per month, in the same order as `months`. */
  byMonth: number[];
  totalCents: number;
};

export type TrendReport = {
  months: MonthKey[];
  rows: TrendRow[];
  totalsByMonth: number[];
  totalCents: number;
};

/**
 * RP-2: monthly spending per envelope, over any number of months.
 *
 * Every month in the range appears even if nothing happened in it, because a gap
 * in a trend is information and a missing column is a lie about the shape.
 */
export async function monthlyTrend(
  db: Database,
  period: Period,
  options: { envelopeIds?: string[]; limit?: number } = {},
): Promise<TrendReport> {
  const months = monthsBetween(period.from, period.to);
  const index = new Map(months.map((month, at) => [month, at]));

  const rows = await db
    .select({
      envelopeId: envelopes.id,
      name: envelopes.name,
      groupName: envelopeGroups.name,
      month: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
      spentCents: sql<string>`(-sum(${txnLines.amountCents}))::bigint`,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(transactions.id, txnLines.transactionId))
    .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
    .innerJoin(envelopeGroups, eq(envelopeGroups.id, envelopes.groupId))
    .where(
      options.envelopeIds && options.envelopeIds.length > 0
        ? and(spendingLines(period.from, period.to), inArray(envelopes.id, options.envelopeIds))
        : spendingLines(period.from, period.to),
    )
    .groupBy(envelopes.id, envelopes.name, envelopeGroups.name, sql`to_char(${transactions.date}, 'YYYY-MM')`);

  const byEnvelope = new Map<string, TrendRow>();
  for (const row of rows) {
    const at = index.get(row.month);
    if (at === undefined) continue;

    const existing = byEnvelope.get(row.envelopeId) ?? {
      envelopeId: row.envelopeId,
      name: row.name,
      groupName: row.groupName,
      byMonth: months.map(() => 0),
      totalCents: 0,
    };

    const spentCents = Number(row.spentCents);
    existing.byMonth[at] = spentCents;
    existing.totalCents += spentCents;
    byEnvelope.set(row.envelopeId, existing);
  }

  // Busiest first, since a trend table with fifty rows is read from the top.
  const ordered = [...byEnvelope.values()].sort((left, right) => right.totalCents - left.totalCents);
  const kept = options.limit ? ordered.slice(0, options.limit) : ordered;

  const totalsByMonth = months.map((_, at) =>
    ordered.reduce((sum, row) => sum + (row.byMonth[at] ?? 0), 0),
  );

  return {
    months,
    rows: kept,
    totalsByMonth,
    totalCents: totalsByMonth.reduce((sum, cents) => sum + cents, 0),
  };
}

export type ReportTransaction = {
  id: string;
  date: string;
  payeeRaw: string;
  account: string;
  envelope: string;
  /** This envelope's share, which is the whole amount unless it was split. */
  shareCents: number;
  amountCents: number;
  status: string;
};

/** RP-1's drill-down: what made up a figure in the report. */
export async function transactionsInPeriod(
  db: Database,
  period: Period,
  options: { envelopeId?: string; limit?: number } = {},
): Promise<ReportTransaction[]> {
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      account: accounts.name,
      envelope: envelopes.name,
      shareCents: txnLines.amountCents,
      amountCents: transactions.amountCents,
      status: transactions.status,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(transactions.id, txnLines.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
    .where(
      options.envelopeId
        ? and(spendingLines(period.from, period.to), eq(txnLines.envelopeId, options.envelopeId))
        : spendingLines(period.from, period.to),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(options.limit ?? 500);

  return rows.map((row) => ({
    ...row,
    shareCents: Number(row.shareCents),
    amountCents: Number(row.amountCents),
  }));
}

/** Every month touched by a period, in order. */
export function monthsBetween(from: string, to: string): MonthKey[] {
  const first = monthOf(from);
  const last = monthOf(to);
  const months: MonthKey[] = [];

  let cursor = first;
  // A range the wrong way round yields nothing rather than looping for ever.
  for (let guard = 0; cursor <= last && guard < 600; guard += 1) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** Named ranges, so the common questions need no date arithmetic. */
export function periodPreset(name: string, today: string): Period {
  const month = monthOf(today);

  switch (name) {
    case 'this-month':
      return { from: monthStart(month), to: monthEnd(month) };
    case 'last-month': {
      const previous = addMonths(month, -1);
      return { from: monthStart(previous), to: monthEnd(previous) };
    }
    case 'this-year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` };
    case 'last-12-months':
      return { from: monthStart(addMonths(month, -11)), to: monthEnd(month) };
    case 'all-time':
      return { from: '1970-01-01', to: '2999-12-31' };
    default:
      return { from: monthStart(month), to: monthEnd(month) };
  }
}
