import { db } from '../../../db/client.ts';
import { toCsv } from '../../../src/csv.ts';
import { exportFilename } from '../../../src/export/export.ts';
import {
  monthlyTrend,
  spendingByEnvelope,
  transactionsInPeriod,
} from '../../../src/reports/reports.ts';
import { currentSession } from '../../auth.ts';

/**
 * RP-6: any report, as CSV.
 *
 * The same functions the screen reads from, so a downloaded report and the one
 * on screen can never disagree - which they would within a week if this built
 * its own queries.
 */

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request): Promise<Response> {
  if (!(await currentSession())) {
    return new Response('Not signed in\n', { status: 401 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) {
    return new Response('Give a from and to date as YYYY-MM-DD\n', { status: 400 });
  }

  const period = { from, to };
  const report = url.searchParams.get('report') ?? 'spending';
  const amount = (cents: number) => (cents / 100).toFixed(2);
  let csv: string;
  let name: string;

  if (report === 'trend') {
    const trend = await monthlyTrend(db(), period);
    csv = toCsv(
      trend.rows.map((row) => ({
        envelope: row.name,
        group: row.groupName,
        ...Object.fromEntries(trend.months.map((month, at) => [month, amount(row.byMonth[at] ?? 0)])),
        total: amount(row.totalCents),
      })),
      ['envelope', 'group', ...trend.months, 'total'],
    );
    name = 'trend';
  } else if (report === 'transactions') {
    const envelopeId = url.searchParams.get('envelope');
    const rows = await transactionsInPeriod(db(), period, {
      ...(envelopeId ? { envelopeId } : {}),
      limit: 100000,
    });
    csv = toCsv(
      rows.map((row) => ({
        date: row.date,
        payee: row.payeeRaw,
        account: row.account,
        envelope: row.envelope,
        envelopeShare: amount(row.shareCents),
        transactionTotal: amount(row.amountCents),
        status: row.status,
      })),
      ['date', 'payee', 'account', 'envelope', 'envelopeShare', 'transactionTotal', 'status'],
    );
    name = 'transactions';
  } else {
    const spending = await spendingByEnvelope(db(), period);
    csv = toCsv(
      spending.groups.flatMap((group) =>
        group.envelopes.map((envelope) => ({
          group: group.name,
          envelope: envelope.name,
          spent: amount(envelope.spentCents),
          transactions: envelope.transactionCount,
        })),
      ),
      ['group', 'envelope', 'spent', 'transactions'],
    );
    name = 'spending';
  }

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename(`${name}-${from}-to-${to}`)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
