import Link from 'next/link';
import { homeDb } from '../../db/client.ts';
import { ledgerDb } from '../ledger.ts';
import { listMembers } from '../../src/auth/invites.ts';
import { reviewOpensOn } from '../../src/queue/handover.ts';
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
import ReviewViewSwitch from './ReviewViewSwitch.tsx';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f-]{36}$/i;

export default async function ReviewPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser();
  const params = await props.searchParams;
  const asked = Array.isArray(params.batch) ? params.batch[0] : params.batch;
  const batch = asked && UUID.test(asked) ? asked : undefined;
  const connection = await ledgerDb();
  const members = await listMembers(homeDb());

  // RQ-7: For me is what was handed to you, All is everything waiting. Which
  // one opens is each person's own choice; with nobody to hand anything to,
  // there is only All.
  const shared = members.length > 1 && !batch;
  const askedView = Array.isArray(params.view) ? params.view[0] : params.view;
  const view: 'all' | 'mine' = !shared
    ? 'all'
    : askedView === 'all' || askedView === 'mine'
      ? askedView
      : await reviewOpensOn(homeDb(), session.userId);

  // `?batch=` is what an import lands on: the same screen, looking only at what
  // just arrived. Everything else waiting is one link away.
  const [rows, everything, mine, envelopes, accounts, transfers] = await Promise.all([
    pendingTransactions(
      connection,
      batch ? { importBatchId: batch } : view === 'mine' ? { handedTo: session.userId } : {},
    ),
    batch || shared ? pendingCount(connection) : Promise.resolve(0),
    shared ? pendingCount(connection, { handedTo: session.userId }) : Promise.resolve(0),
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
            both sides of the transfer are recorded. To leave some for someone else, press Hand
            over, tick the ones you want them to look at and choose who. They are told, and the
            transactions appear under For me on their list. Anyone can still review them from All.
            Which view the list opens on is up to each person, under Settings and then You.
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
        {shared && <ReviewViewSwitch view={view} mine={mine} all={everything} />}
      </div>
      <ReviewQueue
        key={view}
        rows={rows}
        envelopes={envelopes}
        transfers={transfers}
        accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
        me={session.userId}
        members={members.map((member) => ({ id: member.id, name: member.name }))}
        view={view}
      />
    </>
  );
}
