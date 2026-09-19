import { db } from '../../db/client.ts';
import {
  budgetMonth,
  fundingFromBudget,
  monthAllocations,
} from '../../src/budget/budget.ts';
import { addMonths, currentMonth, monthLabel } from '../../src/budget/month.ts';
import { requireUser } from '../auth.ts';
import BudgetScreen from './BudgetScreen.tsx';

export const dynamic = 'force-dynamic';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function pickMonth(value: string | string[] | undefined): string {
  const month = Array.isArray(value) ? value[0] : value;
  return month && MONTH.test(month) ? month : currentMonth();
}

export default async function BudgetPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const searchParams = await props.searchParams;
  const month = pickMonth(searchParams.month);
  const connection = db();

  // The month is read once; the funding preview is derived from it rather than
  // asking the same questions again.
  const budget = await budgetMonth(connection, month);
  const allocations = await monthAllocations(connection, month);
  const funding = fundingFromBudget(budget);

  return (
    <BudgetScreen
      budget={budget}
      funding={funding}
      allocations={allocations}
      label={monthLabel(month)}
      previousMonth={addMonths(month, -1)}
      nextMonth={addMonths(month, 1)}
      thisMonth={currentMonth()}
    />
  );
}
