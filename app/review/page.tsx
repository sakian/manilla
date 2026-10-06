import Link from 'next/link';
import { ledgerDb } from '../ledger.ts';
import { listAccounts } from '../../src/accounts/manage.ts';
import {
  envelopeOptions,
  pendingCount,
  pendingTransactions,
  transferCandidates,
} from '../../src/queue/queue.ts';
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
  const connection = await ledgerDb();

  // `?batch=` is what an import lands on: the same screen, looking only at what
  // just arrived. Everything else waiting is one link away.
  const [rows, everything, envelopes, accounts, transfers] = await Promise.all([
    pendingTransactions(connection, batch ? { importBatchId: batch } : {}),
    batch ? pendingCount(connection) : Promise.resolve(0),
    envelopeOptions(connection),
    listAccounts(connection),
    transferCandidates(connection, batch ? { importBatchId: batch } : {}),
  ]);

  return (
    <>
      <div className="page-head">
        <h2>
          Review{' '}
          <Hint label="How reviewing works">
            Imported transactions wait here until you choose an envelope for each one. When Manilla
            is very sure of the envelope, it fills it in for you. Otherwise the row starts empty,
            and Manilla&rsquo;s best guess is offered at the top of the list of envelopes. Your
            choices are not saved until you press Save, so if you stop halfway, nothing has changed.
            The exception is marking a transaction as not spending. That is saved straight away, and
            both sides of the transfer are recorded.
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
        transfers={transfers}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
      />
    </>
  );
}
