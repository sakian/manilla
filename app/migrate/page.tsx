import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { envelopeBalances } from '../../src/ledger/ledger.ts';
import { requireUser } from '../auth.ts';
import MigrateScreen from './MigrateScreen.tsx';

export const dynamic = 'force-dynamic';

export default async function MigratePage() {
  await requireUser();
  const connection = db();

  const [envelopes, accounts] = await Promise.all([
    envelopeBalances(connection),
    listAccounts(connection),
  ]);

  return (
    <MigrateScreen
      envelopes={envelopes.map((envelope) => ({
        id: envelope.envelopeId,
        name: envelope.name,
        groupName: envelope.groupName,
        isUnallocated: envelope.isUnallocated,
        balanceCents: envelope.balanceCents,
      }))}
      accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
    />
  );
}
