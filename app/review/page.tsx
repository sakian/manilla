import { db } from '../../db/client.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import { envelopeOptions, pendingTransactions } from '../../src/queue/queue.ts';
import { requireUser } from '../auth.ts';
import { Hint } from '../Hint.tsx';
import ReviewQueue from './ReviewQueue.tsx';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  await requireUser();
  const connection = db();
  const [rows, envelopes, accounts] = await Promise.all([
    pendingTransactions(connection),
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
      </div>
      <ReviewQueue
        rows={rows}
        envelopes={envelopes}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
      />
    </>
  );
}
