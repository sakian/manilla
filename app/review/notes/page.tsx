import { homeDb } from '../../../db/client.ts';
import { ledgerDb } from '../../ledger.ts';
import { listMembers } from '../../../src/auth/invites.ts';
import { conversations } from '../../../src/queue/handover.ts';
import { pendingCount } from '../../../src/queue/queue.ts';
import { displayDate } from '../../../src/budget/month.ts';
import { requireUser } from '../../auth.ts';
import { Money } from '../../Money.tsx';
import { ThreadWithButton } from '../../Thread.tsx';
import ReviewViewSwitch from '../ReviewViewSwitch.tsx';
import Link from 'next/link';
import { ClearNotes } from './ClearNotes.tsx';

export const dynamic = 'force-dynamic';

/**
 * What was said in handing rows over, and the replies (RQ-7), latest first.
 *
 * Its own page rather than part of the list, because a reply usually comes
 * with the review that takes the row off every list. A reply's notification
 * opens here.
 */
export default async function ReviewNotesPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser();
  // The ones put away, still there to look back at.
  const showCleared = (await props.searchParams).cleared === '1';
  const connection = await ledgerDb();
  const members = await listMembers(homeDb());
  const [threads, all, mine] = await Promise.all([
    conversations(connection, session.userId, { cleared: showCleared }),
    pendingCount(connection),
    pendingCount(connection, { handedTo: session.userId }),
  ]);
  const names = Object.fromEntries(members.map((member) => [member.id, member.name]));
  const who = (id: string | null) => (id === session.userId ? 'you' : id ? (names[id] ?? 'someone no longer a member') : 'someone');

  return (
    <>
      <div className="page-head">
        <h2>Review</h2>
        {members.length > 1 && <ReviewViewSwitch view="notes" mine={mine} all={all} />}
      </div>
      <div className="notes-bar">
        {showCleared ? (
          <Link href="/review/notes">Back to notes</Link>
        ) : (
          <>
            {threads.length > 0 && <ClearNotes transactionIds="all" label="Clear all" />}
            <Link href="/review/notes?cleared=1" className="muted">
              Cleared notes
            </Link>
          </>
        )}
      </div>
      {threads.length === 0 ? (
        <div className="empty">
          <p style={{ margin: 0, fontSize: 17 }}>{showCleared ? 'Nothing cleared.' : 'No notes to read.'}</p>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            {showCleared
              ? 'Notes you clear are kept here until someone writes in them again.'
              : 'A note left in handing transactions over, and the replies to it, come here. Clear them once read; a new reply brings one back.'}
          </p>
        </div>
      ) : (
        <div className="queue">
          {threads.map((thread) => (
            <div key={thread.id} className="queue-row note-row">
              <span className="queue-payee">{thread.payeeDisplay}</span>
              <Money cents={thread.amountCents} sign="incoming" />
              <span className="muted queue-meta">
                <span>{displayDate(thread.date)}</span>
                <span>{thread.accountName}</span>
                <span className="tag">
                  {thread.handedById ? `${who(thread.handedById)} → ` : 'for '}
                  {who(thread.handedToId)}
                </span>
                {thread.status === 'pending_review' ? (
                  <span className="tag warn">waiting</span>
                ) : (
                  <span>{thread.envelopeNames.join(', ') || 'reviewed'}</span>
                )}
              </span>
              <ThreadWithButton
                transactionId={thread.id}
                messages={thread.messages}
                people={{ me: session.userId, handedToId: thread.handedToId, handedById: thread.handedById, names }}
              />
              {!showCleared && (
                <div className="notes-done">
                  <ClearNotes transactionIds={[thread.id]} label="Done" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
