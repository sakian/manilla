import { db } from '../../db/client.ts';
import { budgetMonth } from '../../src/budget/budget.ts';
import { addMonths, currentMonth, monthLabel, shortMonthLabel } from '../../src/budget/month.ts';
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

  const budget = await budgetMonth(connection, month);
  const previousMonth = addMonths(month, -1);

  return (
    <BudgetScreen
      budget={budget}
      label={monthLabel(month)}
      previousMonth={previousMonth}
      previousLabel={shortMonthLabel(previousMonth)}
      nextMonth={addMonths(month, 1)}
      thisMonth={currentMonth()}
    />
  );
}
