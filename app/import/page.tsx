import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { importHistory } from '../../src/import/ofxImport.ts';
import { requireUser } from '../auth.ts';
import ImportScreen from './ImportScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await requireUser();
  const connection = db();

  const [accounts, history] = await Promise.all([
    listAccounts(connection),
    importHistory(connection),
  ]);

  return (
    <ImportScreen
      accounts={accounts.map((account) => ({
        id: account.id,
        name: account.name,
        externalAccountId: account.externalAccountId,
      }))}
      history={history}
    />
  );
}
