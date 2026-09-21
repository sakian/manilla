import { db } from '../../../db/client.ts';
import { toCsv } from '../../../src/csv.ts';
import { exportFilename } from '../../../src/export/export.ts';
import { searchTransactions } from '../../../src/transactions/search.ts';
import { currentSession } from '../../auth.ts';
import { readQuery } from '../../../src/transactions/urlQuery.ts';

/**
 * The current search, as CSV.
 *
 * Reads the filters with the same `readQuery` the page uses, so the download is
 * the search that was on screen rather than a second guess at it. Every match is
 * written, not the page that was being looked at - a CSV of rows 51 to 100 is
 * nobody's idea of an export.
 */

export const dynamic = 'force-dynamic';

/** Enough for a decade of one household's transactions; a real answer, not a page. */
const EVERYTHING = 100_000;

export async function GET(request: Request): Promise<Response> {
  if (!(await currentSession())) {
    return new Response('Not signed in\n', { status: 401 });
  }

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const query = readQuery(params, { pageSize: EVERYTHING });

  const found = await searchTransactions(db(), { ...query, limit: EVERYTHING, offset: 0 });
  const amount = (cents: number) => (cents / 100).toFixed(2);

  const csv = toCsv(
    found.rows.map((row) => ({
      date: row.date,
      payee: row.payeeRaw,
      amount: amount(row.amountCents),
      account: row.accountName,
      // A split lands in several envelopes; they are listed rather than one
      // chosen, and the per-envelope shares are the reports' CSV (RP-5, RP-6).
      envelopes: row.envelopeNames.join('; '),
      status: row.status,
      kind: row.kind,
      memo: row.memo ?? '',
      checkNumber: row.checkNumber ?? '',
    })),
    ['date', 'payee', 'amount', 'account', 'envelopes', 'status', 'kind', 'memo', 'checkNumber'],
  );

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename('search')}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
