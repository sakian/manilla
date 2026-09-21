import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { importHistory } from '../../src/import/ofxImport.ts';
import { attention } from '../../src/notices/notices.ts';
import { requireUser } from '../auth.ts';
import ImportScreen from './ImportScreen.tsx';
import { Notices } from '../Notices.tsx';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  const connection = db();

  const [accounts, history, report] = await Promise.all([
    listAccounts(connection),
    importHistory(connection),
    attention(connection),
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
    />
  );
}
