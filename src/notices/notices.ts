/**
 * What needs attention, as data (VW-3).
 *
 * Read once on the server and shown on every main screen, because "is anything
 * wrong" is not a question about the page you happen to be on. It is also why the
 * review queue no longer needs a place in the navigation: the thing that tells you
 * there is something to review is the way to it.
 *
 * Data, not markup, so the same figures can be a list on a screen, a line after
 * an import, or a test assertion without three versions of what counts.
 */

import { eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { budgetWarnings, getExpectedIncome, incomeReceived, suggestExpectedIncome } from '../budget/budget.ts';
import { currentMonth, monthEnd, monthStart, type MonthKey } from '../budget/month.ts';
import { budgetLines, envelopes } from '../../db/schema.ts';
import { checkInvariant } from '../ledger/ledger.ts';
import { pendingCount } from '../queue/queue.ts';
import { ruleSuggestionCount } from '../rules/rules.ts';

export type AttentionKind =
  /** The two sides of the ledger disagree, which should be impossible (FR-37). */
  | 'ledger_mismatch'
  /** More has been allocated to envelopes than has arrived. */
  | 'pool_overdrawn'
  /** At least one envelope has spent past what it holds. */
  | 'envelopes_overspent'
  /** Imported transactions are waiting to be categorized (RQ-1). */
  | 'awaiting_review'
  /** Income has arrived and is not in an envelope yet. */
  | 'unallocated'
  /** Nothing has been recorded yet, so the first thing to do is bring history in. */
  | 'nothing_recorded'
  /** FR-31: the monthly plan asks for more than the income there is to fund it. */
  | 'plan_exceeds_income'
  /**
   * CA-2: payees sorted the same way often enough that a rule would save the
   * work. Not raised by `attention` - finding them is too expensive to do on
   * every screen - but the settings page raises it where the suggestions are.
   */
  | 'rules_to_suggest';

export type Attention = {
  kind: AttentionKind;
  /** `bad` is broken, `warn` needs a decision, `info` is worth knowing. */
  severity: 'bad' | 'warn' | 'info';
  /** Whatever the notice is about, in cents, where that makes sense. */
  cents?: number;
  /** A second figure, where the notice compares two: planned against income. */
  againstCents?: number;
  count?: number;
};

export type AttentionReport = {
  month: MonthKey;
  notices: Attention[];
  /** For the places that only care whether anything is actually wrong. */
  anyBad: boolean;
};

/**
 * The three figures the notices need from the budget, in one query.
 *
 * This used to call `budgetMonth`, which is the right answer for the budget and
 * the wrong one here: it builds six correlated subqueries per envelope to
 * produce a screen's worth of figures, and the notices want a pool balance, a
 * count of overspends and a planned total. Since this runs on every main screen,
 * that was the heaviest thing on the page and it grew with the ledger.
 */
async function balancesForNotices(db: Database, month: MonthKey) {
  const [row] = await db
    .select({
      poolCents: sql<string>`coalesce(sum(balance) filter (where is_unallocated), 0)::bigint`,
      overspent: sql<string>`count(*) filter (where not is_unallocated and balance < 0)::int`,
      envelopeCount: sql<string>`count(*)::int`,
      plannedCents: sql<string>`coalesce(sum(planned) filter (where not is_unallocated), 0)::bigint`,
    })
    .from(
      db
        .select({
          isUnallocated: envelopes.isUnallocated,
          balance: sql<string>`(
            coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = envelopes.id), 0)
            + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = envelopes.id), 0)
            - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = envelopes.id), 0)
          )`.as('balance'),
          planned: sql<string>`coalesce((
            select bl.planned_cents from budget_lines bl
            where bl.envelope_id = envelopes.id and bl.month = ${monthStart(month)}
          ), (
            select bl.planned_cents from budget_lines bl
            where bl.envelope_id = envelopes.id and bl.month is null
          ), 0)`.as('planned'),
        })
        .from(envelopes)
        .where(isNull(envelopes.archivedAt))
        .as('live'),
    );

  return {
    poolCents: Number(row?.poolCents ?? 0),
    overspent: Number(row?.overspent ?? 0),
    envelopeCount: Number(row?.envelopeCount ?? 0),
    plannedCents: Number(row?.plannedCents ?? 0),
  };
}

export async function attention(
  db: Database,
  month: MonthKey = currentMonth(),
): Promise<AttentionReport> {
  const [balances, invariant, waiting, received, expected, average, suggestions] =
    await Promise.all([
      balancesForNotices(db, month),
      checkInvariant(db),
      pendingCount(db),
      incomeReceived(db, month),
      getExpectedIncome(db),
      suggestExpectedIncome(db, month),
      ruleSuggestionCount(db),
    ]);

  const notices: Attention[] = [];
  const overspent = balances.overspent;
  const pool = balances.poolCents;

  // A ledger that does not add up is the only thing here that means something is
  // broken rather than merely undecided. Uncategorized money is *not* that: the
  // invariant counts it, which is why it can be unassigned and still agree.
  if (!invariant.ok) {
    notices.push({ kind: 'ledger_mismatch', severity: 'bad', cents: invariant.unexplainedCents });
  }

  if (pool < 0) {
    notices.push({ kind: 'pool_overdrawn', severity: 'bad', cents: -pool });
  }

  if (overspent > 0) {
    notices.push({ kind: 'envelopes_overspent', severity: 'warn', count: overspent });
  }

  // The warning the budget screen used to carry. It belongs with the others now
  // that the plan is edited on the envelopes screen itself (FR-31).
  const exceeds = budgetWarnings({
    plannedTotalCents: balances.plannedCents,
    incomeReceivedCents: received,
    expectedIncomeCents: expected,
    averageIncomeCents: average,
    poolBalanceCents: pool,
  }).find((warning) => warning.kind === 'planned_exceeds_income');
  if (exceeds) {
    notices.push({
      kind: 'plan_exceeds_income',
      severity: 'warn',
      cents: exceeds.plannedCents,
      againstCents: exceeds.incomeCents,
    });
  }

  if (waiting > 0) {
    notices.push({ kind: 'awaiting_review', severity: 'info', count: waiting });
  }

  // Read from a cached count rather than found here: the search is a scan of
  // every confirmed line with an unindexable LIKE against the rules table, and
  // this runs on every main screen (see `ruleSuggestionCount`).
  if (suggestions > 0) {
    notices.push({ kind: 'rules_to_suggest', severity: 'info', count: suggestions });
  }

  if (pool > 0) {
    notices.push({ kind: 'unallocated', severity: 'info', cents: pool });
  }

  // An empty ledger is not a problem, it is a starting point, and saying where to
  // start is more use than an empty screen.
  if (
    balances.envelopeCount === 0 ||
    (invariant.accountTotalCents === 0 && invariant.envelopeTotalCents === 0)
  ) {
    notices.push({ kind: 'nothing_recorded', severity: 'info' });
  }

  return {
    month,
    notices,
    anyBad: notices.some((notice) => notice.severity === 'bad'),
  };
}
