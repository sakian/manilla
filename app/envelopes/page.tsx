import { db } from '../../db/client.ts';
import { budgetMonth } from '../../src/budget/budget.ts';
import { currentMonth, monthLabel } from '../../src/budget/month.ts';
import { listEnvelopes } from '../../src/envelopes/manage.ts';
import { requireUser } from '../auth.ts';
import EnvelopeManager, { type MonthFigures } from './EnvelopeManager.tsx';

export const dynamic = 'force-dynamic';

export default async function EnvelopesPage() {
  await requireUser();
  const connection = db();
  const month = currentMonth();

  // Two reads with two jobs: the structure, archived envelopes included, and this
  // month's figures for the live ones.
  const [groups, budget] = await Promise.all([
    listEnvelopes(connection, { includeArchived: true }),
    budgetMonth(connection, month),
  ]);

  const figures: MonthFigures = {};
  for (const row of budget.rows) {
    figures[row.envelopeId] = {
      plannedCents: row.plannedCents,
      spentCents: row.spentCents,
      allocatedCents: row.allocatedCents,
    };
  }

  return (
    <EnvelopeManager groups={groups} figures={figures} monthLabel={monthLabel(month)} />
  );
}
