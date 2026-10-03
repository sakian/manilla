import { ledgerDb } from '../ledger.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { envelopeBalances } from '../../src/ledger/ledger.ts';
import { requireUser } from '../auth.ts';
import MigrateScreen from './MigrateScreen.tsx';
import { reconcileData } from './reconcileData.ts';

export const dynamic = 'force-dynamic';

export default async function MigratePage() {
  await requireUser();
  const connection = await ledgerDb();

  const [envelopes, accounts, reconciliation] = await Promise.all([
    envelopeBalances(connection),
    listAccounts(connection),
    reconcileData(connection),
  ]);

  return (
    <MigrateScreen
      envelopes={envelopes.map((envelope) => ({
        id: envelope.envelopeId,
        name: envelope.name,
        groupName: envelope.groupName,
        isUnallocated: envelope.isUnallocated,
      }))}
      accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
      reconciliation={reconciliation}
    />
  );
}
