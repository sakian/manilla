import Link from 'next/link';
import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { envelopeOptions, pendingCount, pendingTransactions } from '../../src/queue/queue.ts';
import { requireUser } from '../auth.ts';
import { Hint } from '../Hint.tsx';
import ReviewQueue from './ReviewQueue.tsx';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export default async function ReviewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const params = await props.searchParams;
  const asked = Array.isArray(params.batch) ? params.batch[0] : params.batch;
  const batch = asked && UUID.test(asked) ? asked : undefined;
  const connection = db();

  // `?batch=` is what an import lands on: the same screen, looking only at what
  // just arrived. Everything else waiting is one link away.
  const [rows, everything, envelopes, accounts] = await Promise.all([
    pendingTransactions(connection, batch ? { importBatchId: batch } : {}),
    batch ? pendingCount(connection) : Promise.resolve(0),
    envelopeOptions(connection),
    listAccounts(connection),
  ]);

  return (
    <>
      <div className="page-head">
        <h2>
          Review{' '}
          <Hint label="How reviewing works">
            Imported transactions wait here until you say where they came out of. A suggestion is
            filled in only where the pipeline is confident enough to bet on it; below that the row
            starts empty and offers its guess for you to accept or ignore. Choosing an envelope
            marks the row, and nothing is written until you press Save — so a sitting you abandon
            halfway leaves the ledger exactly as it was. Marking something as not spending is the
            exception: that writes both halves of a transfer straight away.
          </Hint>
        </h2>
        {batch && (
          <p className="muted">
            What the import just brought in.{' '}
            {everything > rows.length && (
              <Link href="/review">
                Review everything waiting ({everything.toLocaleString()})
              </Link>
            )}
          </p>
        )}
      </div>
      <ReviewQueue
        rows={rows}
        envelopes={envelopes}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
      />
    </>
  );
}
