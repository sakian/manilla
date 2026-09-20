import { db } from '../../db/client.ts';
import { localToday } from '../../src/budget/month.ts';
import {
  monthlyTrend,
  periodPreset,
  spendingByEnvelope,
  transactionsInPeriod,
  type Period,
} from '../../src/reports/reports.ts';
import { requireUser } from '../auth.ts';
import ReportScreen from './ReportScreen.tsx';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The period from the query string, or the preset it names. */
function readPeriod(params: Record<string, string | string[] | undefined>, today: string): Period {
  const from = one(params.from);
  const to = one(params.to);
  if (from && to && DAY.test(from) && DAY.test(to)) return { from, to };
  return periodPreset(one(params.preset) ?? 'this-month', today);
}

export default async function ReportsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const today = localToday();
  const period = readPeriod(params, today);
  const envelopeId = one(params.envelope);
  const connection = db();

  const [spending, trend, drilldown] = await Promise.all([
    spendingByEnvelope(connection, period),
    monthlyTrend(connection, period, { limit: 12 }),
    envelopeId
      ? transactionsInPeriod(connection, period, { envelopeId, limit: 200 })
      : Promise.resolve([]),
  ]);

  return (
    <ReportScreen
      period={period}
      preset={one(params.preset) ?? null}
      spending={spending}
      trend={trend}
      drilldown={drilldown}
      drilldownEnvelopeId={envelopeId ?? null}
    />
  );
}
