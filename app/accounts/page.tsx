import { Suspense } from 'react';
import { ledgerDb } from '../ledger.ts';
import { listAccountCategories } from '../../src/accounts/groups.ts';
import { cardPayments } from '../../src/accounts/bills.ts';
import { attention } from '../../src/notices/notices.ts';
import { diskUsedShare } from '../../src/system/disk.ts';
import { aiKeyRejectedSince } from '../../src/ai/ai.ts';
import { homeDb } from '../../db/client.ts';
import { requireUser, reviewViewer } from '../auth.ts';
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
  const session = await requireUser();
  const params = await props.searchParams;
  const connection = await ledgerDb();

  const [categories, payments, report] = await Promise.all([
    listAccountCategories(connection, { includeArchived: true }),
    cardPayments(connection),
    attention(connection, undefined, {
      diskUsage: diskUsedShare,
      aiKeyRejectedSince: () => aiKeyRejectedSince(homeDb()),
      viewer: await reviewViewer(session),
    }),
  ]);

  return (
    <AccountManager
      categories={categories}
      payments={payments}
      notices={<Notices report={report} />}
      pane={
        <Suspense fallback={<PaneLoading />}>
          <TransactionsView params={params} path="/accounts" pane />
        </Suspense>
      }
    />
  );
}
