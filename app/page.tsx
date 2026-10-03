import { Suspense } from 'react';
import { ledgerDb } from './ledger.ts';
import { budgetMonth, fundingFromBudget } from '../src/budget/budget.ts';
import { addMonths, currentMonth, localToday, monthLabel, shortMonthLabel } from '../src/budget/month.ts';
import { monthPace } from '../src/budget/progress.ts';
import { listEnvelopes } from '../src/envelopes/manage.ts';
import { attention } from '../src/notices/notices.ts';
import { requireUser } from './auth.ts';
import HomeScreen, { type MonthFigures } from './HomeScreen.tsx';
import { Notices } from './Notices.tsx';
import TransactionsView from './transactions/TransactionsView.tsx';
import { PaneLoading } from './PaneLoading.tsx';

export const dynamic = 'force-dynamic';

export default async function Home(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const connection = await ledgerDb();
  const month = currentMonth();

  const [groups, budget, report] = await Promise.all([
    listEnvelopes(connection, { includeArchived: true }),
    budgetMonth(connection, month),
    attention(connection, month),
  ]);

  const figures: MonthFigures = {};
  for (const row of budget.rows) {
    figures[row.envelopeId] = {
      plannedCents: row.plannedCents,
      spentCents: row.spentCents,
      allocatedCents: row.allocatedCents,
      lastMonthSpentCents: row.lastMonthSpentCents,
      averageSpentCents: row.averageSpentCents,
      pendingCents: row.pendingCents,
    };
  }

  return (
    <HomeScreen
      groups={groups}
      figures={figures}
      month={month}
      // Worked out here, so the server and the browser draw the same marker.
      pace={monthPace(localToday())}
      monthLabel={monthLabel(month)}
      lastMonthLabel={shortMonthLabel(addMonths(month, -1))}
      funding={fundingFromBudget(budget)}
      notices={<Notices report={report} />}
      // Streamed, so the envelopes are not held up by the list beside them.
      pane={
        <Suspense fallback={<PaneLoading />}>
          <TransactionsView params={params} path="/" pane />
        </Suspense>
      }
    />
  );
}
