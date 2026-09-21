import { db } from '../db/client.ts';
import { budgetMonth, fundingFromBudget } from '../src/budget/budget.ts';
import { addMonths, currentMonth, monthLabel, shortMonthLabel } from '../src/budget/month.ts';
import { listEnvelopes } from '../src/envelopes/manage.ts';
import { attention } from '../src/notices/notices.ts';
import { requireUser } from './auth.ts';
import HomeScreen, { type MonthFigures } from './HomeScreen.tsx';
import { Notices } from './Notices.tsx';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireUser();
  const connection = db();
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
    };
  }

  return (
    <HomeScreen
      groups={groups}
      figures={figures}
      month={month}
      monthLabel={monthLabel(month)}
      lastMonthLabel={shortMonthLabel(addMonths(month, -1))}
      funding={fundingFromBudget(budget)}
      notices={<Notices report={report} />}
    />
  );
}
