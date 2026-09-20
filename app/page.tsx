import { db } from '../db/client.ts';
import { budgetMonth, fundingFromBudget } from '../src/budget/budget.ts';
import { currentMonth, monthLabel } from '../src/budget/month.ts';
import { listEnvelopes } from '../src/envelopes/manage.ts';
import { checkInvariant } from '../src/ledger/ledger.ts';
import { pendingCount } from '../src/queue/queue.ts';
import { requireUser } from './auth.ts';
import HomeScreen, { type Headline, type MonthFigures } from './HomeScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireUser();
  const connection = db();
  const month = currentMonth();

  // Three reads with three jobs: the structure with archived envelopes included,
  // this month's figures for the live ones, and the two checks the headline
  // needs. `budgetMonth` already carries every balance, plan and spend figure,
  // so nothing here asks the same question twice.
  const [groups, budget, invariant, waiting] = await Promise.all([
    listEnvelopes(connection, { includeArchived: true }),
    budgetMonth(connection, month),
    checkInvariant(connection),
    pendingCount(connection),
  ]);

  if (groups.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>Nothing here yet.</p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Run <code>npm run seed</code> to create a starting set of envelopes and an account.
        </p>
      </div>
    );
  }

  const figures: MonthFigures = {};
  for (const row of budget.rows) {
    figures[row.envelopeId] = {
      plannedCents: row.plannedCents,
      spentCents: row.spentCents,
      allocatedCents: row.allocatedCents,
      lastMonthSpentCents: row.lastMonthSpentCents,
      averageSpentCents: row.averageSpentCents,
    };
  }

  const headline: Headline = {
    waiting,
    unallocatedCents: budget.unallocated.balanceCents,
    overspentCount: budget.rows.filter(
      (row) => !row.isUnallocated && row.balanceCents < 0,
    ).length,
    invariantOk: invariant.ok,
    unexplainedCents: invariant.unexplainedCents,
    unassignedCents: invariant.unassignedCents,
  };

  return (
    <HomeScreen
      groups={groups}
      figures={figures}
      month={month}
      monthLabel={monthLabel(month)}
      funding={fundingFromBudget(budget)}
      allocatedCents={budget.allocatedTotalCents}
      headline={headline}
    />
  );
}
