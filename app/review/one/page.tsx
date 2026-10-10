import { homeDb } from '../../../db/client.ts';
import { ledgerDb } from '../../ledger.ts';
import { listMembers } from '../../../src/auth/invites.ts';
import { envelopeOptions, pendingTransactions } from '../../../src/queue/queue.ts';
import { requireUser } from '../../auth.ts';
import OneAtATime from './OneAtATime.tsx';

export const dynamic = 'force-dynamic';

/**
 * The review list one transaction at a time (RQ-7): For me unless All is
 * asked for, since what was handed over is what this is for.
 */
export default async function OneAtATimePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser();
  const params = await props.searchParams;
  const asked = Array.isArray(params.view) ? params.view[0] : params.view;
  const view: 'all' | 'mine' = asked === 'all' ? 'all' : 'mine';
  const connection = await ledgerDb();
  const [rows, envelopes, members] = await Promise.all([
    pendingTransactions(connection, view === 'mine' ? { handedTo: session.userId } : {}),
    envelopeOptions(connection),
    listMembers(homeDb()),
  ]);

  return (
    <>
      <div className="page-head">
        <h2>{view === 'mine' ? 'Handed to you' : 'Review'}</h2>
      </div>
      <OneAtATime
        rows={rows}
        envelopes={envelopes}
        me={session.userId}
        members={members.map((member) => ({ id: member.id, name: member.name }))}
        view={view}
      />
    </>
  );
}
