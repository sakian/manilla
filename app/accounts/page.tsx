import { Suspense } from 'react';
import { ledgerDb } from '../ledger.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { attention } from '../../src/notices/notices.ts';
import { requireUser } from '../auth.ts';
import { Notices } from '../Notices.tsx';
import AccountManager from './AccountManager.tsx';
import TransactionsView from '../transactions/TransactionsView.tsx';
import { PaneLoading } from '../PaneLoading.tsx';

/**
 * Accounts (FR-1, FR-3), and on a wide screen the transactions of the one chosen
 * beside them (#35, see `Split`).
 */

export const dynamic = 'force-dynamic';

export default async function AccountsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const connection = await ledgerDb();

  const [categories, report] = await Promise.all([
    listAccountCategories(connection, { includeArchived: true }),
    attention(connection),
  ]);

  return (
    <AccountManager
      categories={categories}
      notices={<Notices report={report} />}
      pane={
        <Suspense fallback={<PaneLoading />}>
          <TransactionsView params={params} path="/accounts" pane />
        </Suspense>
      }
    />
  );
}
