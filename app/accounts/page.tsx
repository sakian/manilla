import Link from 'next/link';
import { db } from '../../db/client.ts';
import {
  accountTransactions,
  listAccounts,
  recentTransactions,
} from '../../src/accounts/manage.ts';
import { transferOptions } from '../../src/envelopes/transfer.ts';
import { requireUser } from '../auth.ts';
import TransactionList from '../transactions/TransactionList.tsx';
import AccountManager from './AccountManager.tsx';

export const dynamic = 'force-dynamic';

export default async function AccountsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const searchParams = await props.searchParams;
  const requested = Array.isArray(searchParams.account)
    ? searchParams.account[0]
    : searchParams.account;
  const connection = db();

  const managed = await listAccounts(connection, { includeArchived: true });
  const selected = managed.find((account) => account.id === requested) ?? null;

  const [rows, envelopes] = await Promise.all([
    selected
      ? accountTransactions(connection, selected.id, { limit: 100 })
      : recentTransactions(connection, { limit: 60 }),
    transferOptions(connection),
  ]);

  const live = managed
    .filter((account) => account.archivedAt === null)
    .map((account) => ({ id: account.id, name: account.name }));

  return (
    <>
      <div className="page-head">
        <h2>Accounts</h2>
        <p className="muted">Real money, as the bank sees it.</p>
      </div>

      <AccountManager accounts={managed} selectedId={selected?.id ?? null} />

      <section className="panel">
        {selected && (
          <p className="muted">
            Showing {selected.name}.{' '}
            <Link href="/accounts">Show every account</Link>
          </p>
        )}
        <TransactionList
          rows={rows}
          accounts={live}
          envelopes={envelopes.map((envelope) => ({
            id: envelope.id,
            name: envelope.name,
            groupName: envelope.groupName,
          }))}
          {...(selected ? { defaultAccountId: selected.id } : {})}
          showAccount={!selected}
        />
      </section>
    </>
  );
}
