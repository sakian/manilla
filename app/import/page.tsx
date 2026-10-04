import { ledgerDb } from '../ledger.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { importHistory } from '../../src/import/ofxImport.ts';
import { attention } from '../../src/notices/notices.ts';
import { diskUsedShare } from '../../src/system/disk.ts';
import { listHeld } from '../../src/sync/connections.ts';
import HeldRows from './HeldRows.tsx';
import { requireUser } from '../auth.ts';
import ImportScreen from './ImportScreen.tsx';
import { Notices } from '../Notices.tsx';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  const connection = await ledgerDb();

  const [accounts, history, report, held] = await Promise.all([
    listAccounts(connection),
    importHistory(connection),
    attention(connection, undefined, { diskUsage: diskUsedShare }),
    listHeld(connection),
  ]);

  return (
    <ImportScreen
      accounts={accounts.map((account) => ({
        id: account.id,
        name: account.name,
        externalAccountId: account.externalAccountId,
      }))}
      history={history}
      // Refreshed after every commit, so the count of things to review - and the
      // way to them - appears the moment an import lands.
      notices={<Notices report={report} />}
      held={
        <HeldRows
          rows={held.map((row) => ({
            id: row.id,
            reason: row.reason,
            date: row.date,
            amountCents: row.amountCents,
            payeeRaw: row.payeeRaw,
            accountName: row.accountName,
            transactionId: row.transactionId,
            detail: row.detail,
            ...(row.here ? { here: row.here } : {}),
          }))}
        />
      }
    />
  );
}
