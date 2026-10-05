import { connectionFor } from '../../../db/client.ts';
import { allLedgers, currentLedger, ledgerDb } from '../../ledger.ts';
import { requireUser } from '../../auth.ts';
import { MAX_LEDGERS } from '../../../src/ledgers/config.ts';
import { listAccounts } from '../../../src/accounts/manage.ts';
import { listConnections, unsyncable } from '../../../src/sync/connections.ts';
import { fedElsewhere, feedKey } from '../../../src/sync/shared.ts';
import SettingsHead from '../SettingsHead.tsx';
import LedgersPanel from '../LedgersPanel.tsx';
import BankFeedsPanel from '../BankFeedsPanel.tsx';

export const dynamic = 'force-dynamic';

export default async function LedgerSettings() {
  await requireUser();
  const connection = await ledgerDb();
  const [ledgers, current, accountChoices, bankConnections] = await Promise.all([
    allLedgers(),
    currentLedger(),
    listAccounts(connection),
    listConnections(connection),
  ]);

  // A bank login can feed accounts in any ledger, so the bank feeds panel
  // offers every ledger's accounts and says which ledger each one feeds.
  const handles = ledgers.map((ledger) => ({
    key: ledger.key,
    name: ledger.name,
    db: ledger.key === current.key ? connection : connectionFor(ledger.database),
  }));
  const [ledgerAccounts, elsewhere] = await Promise.all([
    Promise.all(
      handles.map(async (ledger) => ({
        key: ledger.key,
        name: ledger.name,
        accounts: (ledger.key === current.key ? accountChoices : await listAccounts(ledger.db)).map(
          ({ id, name }) => ({ id, name }),
        ),
      })),
    ),
    fedElsewhere(
      handles.find((ledger) => ledger.key === current.key)!,
      handles,
      bankConnections.map((bank) => bank.itemId),
    ),
  ]);
  const openFirst = [
    ...ledgerAccounts.filter((ledger) => ledger.key === current.key),
    ...ledgerAccounts.filter((ledger) => ledger.key !== current.key),
  ];

  return (
    <>
      <SettingsHead slug="ledgers" />

      <LedgersPanel ledgers={ledgers} currentKey={current.key} max={MAX_LEDGERS} />

      <BankFeedsPanel
        connections={bankConnections.map((bank) => ({
          id: bank.id,
          institutionName: bank.institutionName,
          errorCode: bank.errorCode,
          errorMessage: bank.errorMessage,
          lastSyncedAt: bank.lastSyncedAt?.toISOString() ?? null,
          accounts: bank.accounts.map(({ id, providerAccountId, name, mask, type, subtype, accountId, startDate }) => {
            const other = elsewhere.get(feedKey(bank.itemId, providerAccountId));
            return {
              id,
              name,
              mask,
              choice: accountId
                ? `${current.key}:${accountId}`
                : other
                  ? `${other.ledgerKey}:${other.accountId}`
                  : '',
              elsewhere: !accountId && other ? other.ledgerName : null,
              startDate: accountId ? startDate : (other?.startDate ?? null),
              unsyncable: unsyncable(type, subtype),
            };
          }),
        }))}
        ledgers={openFirst}
        missing={['PLAID_CLIENT_ID', 'PLAID_SECRET', 'MANILLA_SECRET_KEY'].filter((name) => !process.env[name])}
      />
    </>
  );
}
