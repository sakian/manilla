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

import type { Database } from '../../db/client.ts';
import { budgetMonth } from '../budget/budget.ts';
import { currentMonth, type MonthKey } from '../budget/month.ts';
import { checkInvariant } from '../ledger/ledger.ts';
import { pendingCount } from '../queue/queue.ts';

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
  | 'plan_exceeds_income';

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

export async function attention(
  db: Database,
  month: MonthKey = currentMonth(),
): Promise<AttentionReport> {
  const [budget, invariant, waiting] = await Promise.all([
    budgetMonth(db, month),
    checkInvariant(db),
    pendingCount(db),
  ]);

  const notices: Attention[] = [];
  const fundable = budget.rows.filter((row) => !row.isUnallocated);
  const overspent = fundable.filter((row) => row.balanceCents < 0).length;
  const pool = budget.unallocated.balanceCents;

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
  const exceeds = budget.warnings.find((warning) => warning.kind === 'planned_exceeds_income');
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

  if (pool > 0) {
    notices.push({ kind: 'unallocated', severity: 'info', cents: pool });
  }

  // An empty ledger is not a problem, it is a starting point, and saying where to
  // start is more use than an empty screen.
  if (invariant.accountTotalCents === 0 && invariant.envelopeTotalCents === 0) {
    notices.push({ kind: 'nothing_recorded', severity: 'info' });
  }

  return {
    month,
    notices,
    anyBad: notices.some((notice) => notice.severity === 'bad'),
  };
}
