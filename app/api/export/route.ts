import { db } from '../../../db/client.ts';
import {
  CSV_TABLES,
  exportCsv,
  exportFilename,
  exportLedger,
  isCsvTable,
} from '../../../src/export/export.ts';
import { currentSession } from '../../auth.ts';

/**
 * Your data, out (NF-6).
 *
 * A route handler rather than a server action, because the answer is a file the
 * browser should save rather than a value a component renders.
 *
 * A request with no cookie at all is redirected by the proxy before it gets
 * here. This catches the other case - a cookie whose session has lapsed - and
 * refuses it outright, because a download that quietly saves the sign-in page as
 * a .json file is worse than an error.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  if (!(await currentSession())) {
    return new Response('Not signed in\n', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const url = new URL(request.url);
  const format = url.searchParams.get('format') ?? 'json';

  if (format === 'csv') {
    const table = url.searchParams.get('table') ?? 'transactions';
    if (!isCsvTable(table)) {
      return new Response(`Unknown table "${table}". One of: ${CSV_TABLES.join(', ')}\n`, {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(await exportCsv(db(), table), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFilename(table)}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  const ledger = await exportLedger(db());
  return new Response(JSON.stringify(ledger, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename('ledger')}.json"`,
      'cache-control': 'no-store',
    },
  });
}
