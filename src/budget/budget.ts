/**
 * The monthly budget and income allocation (FR-27 to FR-31).
 *
 * Three decisions shape this module:
 *
 *  1. **A budget is a plan, an allocation is a fact.** `budget_lines` hold what
 *     you intend each envelope to receive; `envelope_moves` hold what it actually
 *     received, dated. Changing the plan in December therefore cannot rewrite
 *     what happened in August, which is what FR-30 is asking for.
 *  2. **Funding is idempotent.** A funding run proposes the *remainder* between
 *     the plan and what the month has already received, so funding twice does
 *     not double-fill, and funding per paycheque works without arithmetic in the
 *     user's head (open question 8).
 *  3. **Reversal is a contra entry, never a delete.** Undoing an allocation
 *     writes the opposite move rather than removing the record, so the envelope's
 *     history still shows what happened (NF-2).
 *
 * Sign convention, inherited from the ledger: money out is negative, money in is
 * positive. `spentCents` and `incomeCents` are reported as positive numbers,
 * because "spent -412.50" reads as a refund to everyone except a programmer.
 */

import { and, desc, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.ts';
import {
  appSettings,
  budgetLines,
  envelopeGroups,
  envelopeMoves,
  envelopes,
  transactions,
} from '../../db/schema.ts';
import { LedgerError, moveBetweenEnvelopes, unallocatedEnvelope } from '../ledger/ledger.ts';
import {
  addMonths,
  assertMonth,
  currentMonth,
  dateWithin,
  localToday,
  monthEnd,
  monthStart,
  type MonthKey,
} from './month.ts';

export class BudgetError extends Error {}

export const EXPECTED_INCOME_KEY = 'expected_monthly_income_cents';

/** The window both the income average and each envelope's average are taken over. */
export const MONTHS_AVERAGED = 12;

/** How many complete months the income average looks back over (#4). */
export const INCOME_MONTHS_AVERAGED = 6;

// ---------------------------------------------------------------------------
// Reading the month
// ---------------------------------------------------------------------------

export type BudgetRow = {
  envelopeId: string;
  name: string;
  groupId: string;
  groupName: string;
  isUnallocated: boolean;
  /** FR-27: the month's own amount if one was set, otherwise the standing default. */
  plannedCents: number;
  /** True when a month-specific row set it rather than the default (FR-32). */
  plannedIsOverride: boolean;
  /** The standing default, shown so an override is visibly an override. */
  defaultPlannedCents: number;
  /** Current balance, carry-over included (FR-23). */
  balanceCents: number;
  /** Net spending in this month, as a positive number. Refunds reduce it. */
  spentCents: number;
  /** Net allocated into this envelope during this month, reversals subtracted. */
  allocatedCents: number;
  /** Net spending in the month before this one, as a positive number. */
  lastMonthSpentCents: number;
  /**
   * Average monthly spending over the twelve complete months before this one.
   *
   * Divided by twelve, not by the months that saw activity: a quarterly bill
   * genuinely does cost a twelfth of its yearly total every month, and that is
   * the figure a monthly plan has to cover. An envelope younger than a year
   * therefore reads low, which is honest - there is not a year of it to average.
   */
  averageSpentCents: number;
};

export type BudgetWarning =
  /** FR-31: the plan asks for more than the income there is to fund it. */
  | {
      kind: 'planned_exceeds_income';
      plannedCents: number;
      incomeCents: number;
      /**
       * Which figure the plan was measured against: what the user stated, the
       * measured average of recent months, or what has arrived so far.
       */
      basis: 'expected' | 'average' | 'received';
    }
  /** FR-31: income has arrived and is still sitting in the pool. */
  | { kind: 'income_unallocated'; cents: number }
  /** The pool has been funded past what is in it, so the pool itself is negative. */
  | { kind: 'pool_overdrawn'; cents: number };

export type BudgetMonth = {
  month: MonthKey;
  rows: BudgetRow[];
  /** The income pool. Also present in `rows`, where it is shown separately. */
  unallocated: BudgetRow;
  plannedTotalCents: number;
  allocatedTotalCents: number;
  /** Income that actually arrived in this month. */
  incomeReceivedCents: number;
  /** What the user says to expect each month, or null if they have not said. */
  expectedIncomeCents: number | null;
  /**
   * Average income over the last complete months (INCOME_MONTHS_AVERAGED), or
   * null when there is not a complete month of history to average.
   *
   * This is measured, not typed, and it is what the plan is measured against
   * unless an explicit expectation was stored: six months of real deposits is a
   * better answer to "what do you earn a month" than a number anyone would sit
   * down and enter, and it cannot go stale.
   */
  suggestedIncomeCents: number | null;
  warnings: BudgetWarning[];
};

/**
 * Everything the budget screen needs for one month, in one pass.
 *
 * Archived envelopes are left out: they cannot be funded, and a budget row for
 * something you have retired is noise. An archived envelope still holding money
 * is impossible by FR-25.
 */
export async function budgetMonth(
  db: Database,
  month: MonthKey = currentMonth(),
  options: { today?: string } = {},
): Promise<BudgetMonth> {
  assertMonth(month);
  const from = monthStart(month);
  const to = monthEnd(month);

  // The year before this month, and the single month before it, for the two
  // history figures every row carries (#7).
  const previous = addMonths(month, -1);
  const lastMonthFrom = monthStart(previous);
  const lastMonthTo = monthEnd(previous);
  const yearFrom = monthStart(addMonths(month, -12));
  const yearTo = lastMonthTo;

  const rows = await db
    .select({
      envelopeId: envelopes.id,
      name: envelopes.name,
      groupId: envelopeGroups.id,
      groupName: envelopeGroups.name,
      isUnallocated: envelopes.isUnallocated,
      plannedForMonth: sql<string | null>`(
        select bl.planned_cents from budget_lines bl
        where bl.envelope_id = ${envelopes.id} and bl.month = ${from}
      )::bigint`,
      plannedDefault: sql<string | null>`(
        select bl.planned_cents from budget_lines bl
        where bl.envelope_id = ${envelopes.id} and bl.month is null
      )::bigint`,
      balanceCents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopes.id}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopes.id}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopes.id}), 0)
      )::bigint`,
      spentCents: sql<string>`coalesce((
        select -sum(l.amount_cents) from txn_lines l
        join transactions t on t.id = l.transaction_id
        where l.envelope_id = ${envelopes.id}
          and t.date between ${from} and ${to}
          and t.source <> 'opening_balance'
          -- Money coming back to an ordinary envelope is a refund, and reduces
          -- what it spent. Money arriving in the income pool is income, which is
          -- not spending at all and is reported as incomeReceivedCents instead.
          and (l.amount_cents < 0 or not ${envelopes.isUnallocated})
      ), 0)::bigint`,
      allocatedCents: sql<string>`(
        coalesce((
          select sum(m.amount_cents) from envelope_moves m
          where m.to_envelope_id = ${envelopes.id} and m.kind = 'allocation'
            and m.date between ${from} and ${to}
        ), 0)
        - coalesce((
          select sum(m.amount_cents) from envelope_moves m
          where m.from_envelope_id = ${envelopes.id} and m.kind = 'allocation'
            and m.date between ${from} and ${to}
        ), 0)
      )::bigint`,
      // The same spending rule as the month's own figure, over two other windows.
      lastMonthSpentCents: sql<string>`coalesce((
        select -sum(l.amount_cents) from txn_lines l
        join transactions t on t.id = l.transaction_id
        where l.envelope_id = ${envelopes.id}
          and t.date between ${lastMonthFrom} and ${lastMonthTo}
          and t.source <> 'opening_balance'
          and (l.amount_cents < 0 or not ${envelopes.isUnallocated})
      ), 0)::bigint`,
      yearSpentCents: sql<string>`coalesce((
        select -sum(l.amount_cents) from txn_lines l
        join transactions t on t.id = l.transaction_id
        where l.envelope_id = ${envelopes.id}
          and t.date between ${yearFrom} and ${yearTo}
          and t.source <> 'opening_balance'
          and (l.amount_cents < 0 or not ${envelopes.isUnallocated})
      ), 0)::bigint`,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .where(isNull(envelopes.archivedAt))
    .orderBy(envelopeGroups.position, envelopeGroups.name, envelopes.position, envelopes.name);

  const budgetRows: BudgetRow[] = rows.map((row) => {
    const override = row.plannedForMonth === null ? null : Number(row.plannedForMonth);
    const fallback = row.plannedDefault === null ? 0 : Number(row.plannedDefault);
    return {
      envelopeId: row.envelopeId,
      name: row.name,
      groupId: row.groupId,
      groupName: row.groupName,
      isUnallocated: row.isUnallocated,
      plannedCents: override ?? fallback,
      plannedIsOverride: override !== null,
      defaultPlannedCents: fallback,
      balanceCents: Number(row.balanceCents),
      spentCents: Number(row.spentCents),
      allocatedCents: Number(row.allocatedCents),
      lastMonthSpentCents: Number(row.lastMonthSpentCents),
      averageSpentCents: Math.round(Number(row.yearSpentCents) / MONTHS_AVERAGED),
    };
  });

  const unallocated = budgetRows.find((row) => row.isUnallocated);
  if (!unallocated) {
    throw new BudgetError(
      'No unallocated envelope exists, so there is nowhere for income to land. Run the initial setup.',
    );
  }

  // The pool is not budgeted for: money is not planned *into* it, it arrives.
  const fundable = budgetRows.filter((row) => !row.isUnallocated);
  const plannedTotalCents = fundable.reduce((sum, row) => sum + row.plannedCents, 0);
  const allocatedTotalCents = fundable.reduce((sum, row) => sum + row.allocatedCents, 0);

  const [incomeReceivedCents, expectedIncomeCents, suggestedIncomeCents] = await Promise.all([
    incomeReceived(db, month),
    getExpectedIncome(db),
    suggestExpectedIncome(db, month, options.today),
  ]);

  return {
    month,
    rows: budgetRows,
    unallocated,
    plannedTotalCents,
    allocatedTotalCents,
    incomeReceivedCents,
    expectedIncomeCents,
    suggestedIncomeCents,
    warnings: budgetWarnings({
      plannedTotalCents,
      incomeReceivedCents,
      expectedIncomeCents,
      averageIncomeCents: suggestedIncomeCents,
      poolBalanceCents: unallocated.balanceCents,
    }),
  };
}

/**
 * FR-31, as data rather than sentences, so the screen decides how to phrase it.
 *
 * The plan is measured against expected income when the user has told us what to
 * expect, and against income actually received when they have not - warning that
 * a plan exceeds what has arrived by the 3rd of the month would cry wolf every
 * month.
 */
export function budgetWarnings(input: {
  plannedTotalCents: number;
  incomeReceivedCents: number;
  expectedIncomeCents: number | null;
  /** The measured average, used when nothing was stated. */
  averageIncomeCents?: number | null;
  poolBalanceCents: number;
}): BudgetWarning[] {
  const warnings: BudgetWarning[] = [];

  // Preference order: what the user stated, then what recent months measured,
  // then what has actually arrived. The last is the weakest basis - warning that
  // a plan exceeds income on the 3rd of the month would cry wolf every month -
  // so it is only reached when there is no history to average.
  const stated = input.expectedIncomeCents;
  const average = input.averageIncomeCents ?? null;
  const basis = stated !== null ? 'expected' : average !== null ? 'average' : 'received';
  const incomeCents = stated ?? average ?? input.incomeReceivedCents;

  if (input.plannedTotalCents > incomeCents) {
    warnings.push({
      kind: 'planned_exceeds_income',
      plannedCents: input.plannedTotalCents,
      incomeCents,
      basis,
    });
  }

  if (input.poolBalanceCents > 0) {
    warnings.push({ kind: 'income_unallocated', cents: input.poolBalanceCents });
  } else if (input.poolBalanceCents < 0) {
    warnings.push({ kind: 'pool_overdrawn', cents: -input.poolBalanceCents });
  }

  return warnings;
}

/**
 * Income that arrived in a month: money in, excluding account transfers (FR-5)
 * and opening balances, which are neither income nor spending.
 */
export async function incomeReceived(db: Database, month: MonthKey): Promise<number> {
  const [row] = await db
    .select({
      cents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.kind, 'spending'),
        sql`${transactions.source} <> 'opening_balance'`,
        sql`${transactions.amountCents} > 0`,
        gte(transactions.date, monthStart(month)),
        lte(transactions.date, monthEnd(month)),
      ),
    );
  return Number(row?.cents ?? 0);
}

// ---------------------------------------------------------------------------
// Expected income (FR-27)
// ---------------------------------------------------------------------------

export async function getExpectedIncome(db: Database): Promise<number | null> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, EXPECTED_INCOME_KEY))
    .limit(1);
  if (!row) return null;
  const cents = Number(row.value);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Pass null to clear it, which puts the screen back on income received. */
export async function setExpectedIncome(db: Database, cents: number | null): Promise<void> {
  if (cents === null) {
    await db.delete(appSettings).where(eq(appSettings.key, EXPECTED_INCOME_KEY));
    return;
  }
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new BudgetError(`Expected income must be a whole number of cents, got ${cents}`);
  }
  await db
    .insert(appSettings)
    .values({ key: EXPECTED_INCOME_KEY, value: String(cents) })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: String(cents), updatedAt: new Date() },
    });
}

/**
 * What income to expect each month, averaged over the six complete months before
 * this one. Complete months only: a partial current month would drag the average
 * down and make it look like a pay cut.
 *
 * Six rather than three, because two-weekly pay puts three paycheques into some
 * months and two into others, and a short window turns that rhythm into a
 * wobble. Months with no income at all are left out of the average rather than
 * counted as zero, so a gap between jobs does not permanently halve the figure.
 *
 * Returns null when there is no income history to average, which is the honest
 * answer in the first weeks of use.
 */
export async function suggestExpectedIncome(
  db: Database,
  month: MonthKey = currentMonth(),
  today: string = localToday(),
): Promise<number | null> {
  const months = Array.from({ length: INCOME_MONTHS_AVERAGED }, (_, back) =>
    addMonths(month, -(back + 1)),
  ).filter((candidate) => monthEnd(candidate) < today);
  if (months.length === 0) return null;

  const totals = await Promise.all(months.map((candidate) => incomeReceived(db, candidate)));
  const earning = totals.filter((cents) => cents > 0);
  if (earning.length === 0) return null;

  return Math.round(earning.reduce((sum, cents) => sum + cents, 0) / earning.length);
}

// ---------------------------------------------------------------------------
// Setting the plan (FR-27, FR-32)
// ---------------------------------------------------------------------------

/**
 * Set an envelope's planned monthly amount.
 *
 * With no `month`, this writes the standing default that applies to every month.
 * With a `month`, it writes an override for that month alone (FR-32), leaving the
 * default untouched.
 *
 * A default of zero is stored as no row at all, because "no plan" and "a plan of
 * zero" mean the same thing for a default and the absence reads more clearly in
 * the table. A month override of zero is a real statement - "not this month" -
 * so it is stored.
 */
export async function setPlanned(
  db: Database,
  envelopeId: string,
  plannedCents: number,
  options: { month?: MonthKey } = {},
): Promise<void> {
  if (!Number.isSafeInteger(plannedCents) || plannedCents < 0) {
    throw new BudgetError(`Planned amount must be a whole number of cents, got ${plannedCents}`);
  }

  const [envelope] = await db
    .select({ id: envelopes.id, isUnallocated: envelopes.isUnallocated })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!envelope) throw new BudgetError(`No such envelope: ${envelopeId}`);
  if (envelope.isUnallocated) {
    throw new BudgetError(
      'The income pool is not budgeted for: income arrives in it and is allocated out of it (FR-28).',
    );
  }

  const month = options.month ? monthStart(options.month) : null;

  if (month === null && plannedCents === 0) {
    await db
      .delete(budgetLines)
      .where(and(eq(budgetLines.envelopeId, envelopeId), isNull(budgetLines.month)));
    return;
  }

  await db
    .insert(budgetLines)
    .values({ envelopeId, month, plannedCents })
    .onConflictDoUpdate({
      target: [budgetLines.envelopeId, budgetLines.month],
      set: { plannedCents },
    });
}

/** Drop a month's override so the envelope falls back to the default (FR-32). */
export async function clearMonthOverride(
  db: Database,
  envelopeId: string,
  month: MonthKey,
): Promise<void> {
  await db
    .delete(budgetLines)
    .where(and(eq(budgetLines.envelopeId, envelopeId), eq(budgetLines.month, monthStart(month))));
}

// ---------------------------------------------------------------------------
// Funding the envelopes (FR-29, FR-30)
// ---------------------------------------------------------------------------

export type FundingLine = {
  envelopeId: string;
  name: string;
  groupName: string;
  plannedCents: number;
  /** Net allocated into it already this month. */
  alreadyAllocatedCents: number;
  /** What this run would move: the remainder of the plan, never negative. */
  proposedCents: number;
};

export type FundingPlan = {
  month: MonthKey;
  lines: FundingLine[];
  totalCents: number;
  /** What is in the pool right now. */
  availableCents: number;
  /** How far the proposal exceeds the pool, or zero. */
  shortfallCents: number;
};

/**
 * FR-29's preview: what a one-click fund would do, computed and shown before
 * anything is written.
 *
 * Each line proposes the plan *minus what the month already received*, so an
 * envelope funded by hand earlier in the month is topped up rather than filled
 * twice, and an envelope already at its plan proposes nothing.
 */
export async function planFunding(
  db: Database,
  month: MonthKey = currentMonth(),
  options: { today?: string } = {},
): Promise<FundingPlan> {
  return fundingFromBudget(await budgetMonth(db, month, options));
}

/**
 * The same proposal, derived from a month already read.
 *
 * Pure, so the budget screen can read the month once and show both the table and
 * the funding preview from it rather than asking the database the same question
 * twice (NF-8).
 */
export function fundingFromBudget(budget: BudgetMonth): FundingPlan {
  const lines: FundingLine[] = budget.rows
    .filter((row) => !row.isUnallocated && row.plannedCents > 0)
    .map((row) => ({
      envelopeId: row.envelopeId,
      name: row.name,
      groupName: row.groupName,
      plannedCents: row.plannedCents,
      alreadyAllocatedCents: row.allocatedCents,
      proposedCents: Math.max(0, row.plannedCents - row.allocatedCents),
    }));

  const totalCents = lines.reduce((sum, line) => sum + line.proposedCents, 0);
  const availableCents = budget.unallocated.balanceCents;

  return {
    month: budget.month,
    lines,
    totalCents,
    availableCents,
    shortfallCents: Math.max(0, totalCents - availableCents),
  };
}

export type FundingResult = {
  month: MonthKey;
  date: string;
  moves: number;
  totalCents: number;
  /** The pool's balance once the moves are applied. */
  availableCents: number;
};

/**
 * Apply a funding run: one allocation move per envelope, out of the income pool
 * (FR-29, FR-30).
 *
 * The amounts are the caller's, not the plan's, because FR-29 requires the
 * preview to be editable before it is applied - the plan is a proposal, and what
 * the user adjusted is what gets written.
 *
 * Over-funding the pool is allowed and reported, not blocked: FR-24 lets a
 * balance go negative and FR-31 asks for a warning, and refusing here would
 * strand someone who knows income is arriving tomorrow.
 */
export async function fundEnvelopes(
  db: Database,
  month: MonthKey,
  amounts: { envelopeId: string; amountCents: number }[],
  options: { today?: string; note?: string } = {},
): Promise<FundingResult> {
  assertMonth(month);

  const lines = amounts.filter((line) => line.amountCents !== 0);
  for (const line of lines) {
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 0) {
      throw new BudgetError(
        `Funding amount must be a whole number of cents and not negative, got ${line.amountCents}`,
      );
    }
  }

  const pool = await unallocatedEnvelope(db);
  if (lines.some((line) => line.envelopeId === pool.id)) {
    throw new BudgetError('Cannot fund the income pool from itself');
  }

  const date = dateWithin(month, options.today ?? localToday());
  const note = options.note ?? `Monthly funding for ${month}`;

  if (lines.length === 0) {
    const balance = await envelopeBalance(db, pool.id);
    return { month, date, moves: 0, totalCents: 0, availableCents: balance };
  }

  await db.transaction(async (tx) => {
    const live = await tx
      .select({ id: envelopes.id, archivedAt: envelopes.archivedAt })
      .from(envelopes);
    const known = new Map(live.map((row) => [row.id, row.archivedAt]));

    for (const line of lines) {
      if (!known.has(line.envelopeId)) {
        throw new BudgetError(`No such envelope: ${line.envelopeId}`);
      }
      if (known.get(line.envelopeId) !== null) {
        throw new BudgetError(`Envelope ${line.envelopeId} is archived and cannot be funded`);
      }
    }

    await tx.insert(envelopeMoves).values(
      lines.map((line) => ({
        fromEnvelopeId: pool.id,
        toEnvelopeId: line.envelopeId,
        amountCents: line.amountCents,
        date,
        kind: 'allocation' as const,
        note,
      })),
    );
  });

  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  return {
    month,
    date,
    moves: lines.length,
    totalCents,
    availableCents: await envelopeBalance(db, pool.id),
  };
}

export type AllocationRecord = {
  id: string;
  envelopeId: string;
  envelopeName: string;
  amountCents: number;
  date: string;
  note: string | null;
  /** True when this row is money going back to the pool, i.e. a reversal. */
  isReversal: boolean;
};

/** This month's allocation records, newest first, reversals included (FR-30). */
export async function monthAllocations(
  db: Database,
  month: MonthKey,
): Promise<AllocationRecord[]> {
  const pool = await unallocatedEnvelope(db);

  // Both envelope names come from joins on the same table under two aliases.
  // Correlated subqueries would also work here, but only by luck: Drizzle leaves
  // a column reference unqualified in a single-table query, and an unqualified
  // name that happens to exist in the subquery's own table binds there instead.
  const source = alias(envelopes, 'source_envelope');
  const destination = alias(envelopes, 'destination_envelope');

  const rows = await db
    .select({
      id: envelopeMoves.id,
      fromEnvelopeId: envelopeMoves.fromEnvelopeId,
      toEnvelopeId: envelopeMoves.toEnvelopeId,
      amountCents: envelopeMoves.amountCents,
      date: envelopeMoves.date,
      note: envelopeMoves.note,
      fromName: source.name,
      toName: destination.name,
    })
    .from(envelopeMoves)
    .innerJoin(source, eq(source.id, envelopeMoves.fromEnvelopeId))
    .innerJoin(destination, eq(destination.id, envelopeMoves.toEnvelopeId))
    .where(
      and(
        eq(envelopeMoves.kind, 'allocation'),
        gte(envelopeMoves.date, monthStart(month)),
        lte(envelopeMoves.date, monthEnd(month)),
        or(
          eq(envelopeMoves.fromEnvelopeId, pool.id),
          eq(envelopeMoves.toEnvelopeId, pool.id),
        ),
      ),
    )
    .orderBy(desc(envelopeMoves.date), desc(envelopeMoves.createdAt));

  return rows.map((row) => {
    const isReversal = row.toEnvelopeId === pool.id;
    return {
      id: row.id,
      envelopeId: isReversal ? row.fromEnvelopeId : row.toEnvelopeId,
      envelopeName: isReversal ? row.fromName : row.toName,
      amountCents: Number(row.amountCents),
      date: row.date,
      note: row.note,
      isReversal,
    };
  });
}

/**
 * FR-30's "reversible": undo one allocation by writing its opposite.
 *
 * Deleting the row would be simpler and wrong. The money moved; the record of it
 * moving is part of the envelope's history, and NF-2 asks for an audit trail
 * rather than a tidy table.
 */
export async function reverseAllocation(db: Database, moveId: string): Promise<string> {
  const [move] = await db
    .select()
    .from(envelopeMoves)
    .where(eq(envelopeMoves.id, moveId))
    .limit(1);

  if (!move) throw new BudgetError(`No such envelope move: ${moveId}`);
  if (move.kind !== 'allocation') {
    throw new BudgetError('Only an allocation is reversed here; use a transfer to move money back');
  }

  return moveBetweenEnvelopes(db, {
    fromEnvelopeId: move.toEnvelopeId,
    toEnvelopeId: move.fromEnvelopeId,
    amountCents: Number(move.amountCents),
    date: move.date,
    kind: 'allocation',
    note: `Reversal of ${move.note ?? 'an allocation'}`,
  });
}

/** Undo a whole month's funding in one step. Returns the number of reversals. */
export async function reverseMonthFunding(db: Database, month: MonthKey): Promise<number> {
  const records = await monthAllocations(db, month);
  const outstanding = netByEnvelope(records);

  let reversed = 0;
  const pool = await unallocatedEnvelope(db);
  const date = records[0]?.date ?? monthStart(month);

  for (const [envelopeId, cents] of outstanding) {
    if (cents <= 0) continue;
    await moveBetweenEnvelopes(db, {
      fromEnvelopeId: envelopeId,
      toEnvelopeId: pool.id,
      amountCents: cents,
      date,
      kind: 'allocation',
      note: `Reversal of monthly funding for ${month}`,
    });
    reversed += 1;
  }

  return reversed;
}

/** Net allocation per envelope, so an already-reversed line is not reversed twice. */
function netByEnvelope(records: AllocationRecord[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const record of records) {
    const signed = record.isReversal ? -record.amountCents : record.amountCents;
    net.set(record.envelopeId, (net.get(record.envelopeId) ?? 0) + signed);
  }
  return net;
}

async function envelopeBalance(db: Database, envelopeId: string): Promise<number> {
  const [row] = await db
    .select({
      cents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopeId}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopeId}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopeId}), 0)
      )::bigint`,
    })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);

  if (!row) throw new LedgerError(`No such envelope: ${envelopeId}`);
  return Number(row.cents);
}

export { envelopeBalance };
