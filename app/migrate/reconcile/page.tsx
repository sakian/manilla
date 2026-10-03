import Link from 'next/link';
import { ledgerDb } from '../../ledger.ts';
import { requireUser } from '../../auth.ts';
import { ReconcileBalances } from '../ReconcileBalances.tsx';
import { reconcileData } from '../reconcileData.ts';

export const dynamic = 'force-dynamic';

/**
 * MG-7 on a page of its own. The wizard offers it the moment a migration is
 * in, but the old app's balances are often something to go and look up, and
 * leaving the wizard used to mean there was no way back to it.
 */
export default async function ReconcilePage() {
  await requireUser();
  const data = await reconcileData(await ledgerDb());

  return (
    <>
      <div className="page-head">
        <h2>Reconcile a migration</h2>
      </div>
      {data ? (
        <ReconcileBalances data={data} />
      ) : (
        <section className="panel">
          <p className="muted">
            There is no migrated history to reconcile. <Link href="/migrate">Bring one in</Link>{' '}
            first.
          </p>
        </section>
      )}
    </>
  );
}
