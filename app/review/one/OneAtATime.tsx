'use client';

/**
 * Going through waiting transactions one at a time (RQ-7).
 *
 * What someone hands over usually comes with a question, and the list's cards
 * are built for going down many quickly, not for reading one closely with its
 * thread. Here each transaction has the screen: everything the bank said, who
 * handed it over, what has been written, the suggestion - and two ways on,
 * confirming an envelope or answering.
 *
 * Unlike the list, a confirmation is saved as it is made. One at a time is
 * the sitting you stop halfway through, and what was decided before stopping
 * should stand. Splitting and "not spending" stay in the list, which has the
 * room for them.
 */

import Link from 'next/link';
import { useCallback, useMemo, useState, useTransition } from 'react';
import type { EnvelopeOption, QueueRow } from '../../../src/queue/queue.ts';
import type { Message } from '../../../src/transactions/thread.ts';
import { displayDate } from '../../../src/budget/month.ts';
import { saveReviewAction } from '../../actions.ts';
import { Money } from '../../Money.tsx';
import EnvelopeChoices from '../../EnvelopeChoices.tsx';
import { useOverlay } from '../../useOverlay.ts';
import { Thread, threadPrompt, type ThreadPeople } from '../../Thread.tsx';
import { confidenceOf, saysMore } from '../ReviewQueue.tsx';

type Outcome = { saved: true } | { saved: false; error: string };

export default function OneAtATime({
  rows: loaded,
  envelopes,
  me,
  members,
  view,
}: {
  rows: QueueRow[];
  envelopes: EnvelopeOption[];
  me: string;
  members: { id: string; name: string }[];
  view: 'all' | 'mine';
}) {
  // The sitting's list as it opened. Saving refreshes the page, which drops
  // what was just confirmed from what the server sends; counting from that
  // would move "3 of 7" under the reader's eyes and lose their place.
  const [rows] = useState(loaded);
  const [at, setAt] = useState(0);
  /** What happened to each row this sitting. */
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  /** The envelope chosen for each row, where it differs from the suggestion. */
  const [chosen, setChosen] = useState<Record<string, { envelopeId: string; createRule: boolean }>>({});
  const [threads, setThreads] = useState<Record<string, Message[]>>({});
  const [writing, setWriting] = useState(false);
  const [saving, startSaving] = useTransition();
  const overlay = useOverlay('pick');

  const names = useMemo(() => Object.fromEntries(members.map((member) => [member.id, member.name])), [members]);
  const envelopeById = useMemo(() => new Map(envelopes.map((envelope) => [envelope.id, envelope])), [envelopes]);
  const list = view === 'mine' ? '/review?view=mine' : '/review?view=all';

  const saved = rows.filter((row) => outcomes[row.id]?.saved).length;
  const row = rows[at];

  /** On to the next one nothing has been done with, wrapping round to any skipped. */
  const next = useCallback(
    (from: number, done: Record<string, Outcome>) => {
      for (let step = 1; step <= rows.length; step += 1) {
        const index = (from + step) % rows.length;
        if (!done[rows[index]!.id]) return index;
      }
      return rows.length;
    },
    [rows],
  );

  const go = (index: number) => {
    setWriting(false);
    setAt(index);
  };

  if (rows.length === 0) {
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>
          {view === 'mine' ? 'Nothing handed to you.' : 'Nothing to review.'}
        </p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          <Link href={list}>Back to the list</Link>
        </p>
      </div>
    );
  }

  if (!row) {
    const left = rows.length - saved;
    return (
      <div className="empty">
        <p style={{ margin: 0, fontSize: 17 }}>
          {left === 0 ? 'That was all of them.' : `Through them all. ${left} still waiting.`}
        </p>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {saved === 1 ? 'One confirmed' : `${saved} confirmed`} this time.{' '}
          {left > 0 && (
            <button className="link-button" onClick={() => go(next(-1, outcomes))}>
              Go round again
            </button>
          )}{' '}
          <Link href={list}>Back to the list</Link>
        </p>
      </div>
    );
  }

  const outcome = outcomes[row.id];
  const pick = chosen[row.id];
  const envelopeId = pick?.envelopeId ?? row.envelopeId;
  const envelope = envelopeId ? envelopeById.get(envelopeId) : undefined;
  const confidence = confidenceOf(row);
  const messages = threads[row.id] ?? row.messages;
  const people: ThreadPeople = { me, handedToId: row.handedToId, handedById: row.handedById, names };
  const handedBy = row.handedById && row.handedById !== me ? names[row.handedById] : undefined;

  const confirm = () => {
    if (!envelopeId) return;
    startSaving(async () => {
      const result = await saveReviewAction([
        { transactionId: row.id, envelopeId, ...(pick?.createRule ? { createRule: true } : {}) },
      ]);
      const failed = result.failed[0];
      const done: Record<string, Outcome> = {
        ...outcomes,
        [row.id]: failed ? { saved: false, error: failed.error } : { saved: true },
      };
      setOutcomes(done);
      // Someone else's answer stands and is said; anything else is shown here
      // to try again rather than skipped past unread.
      if (!failed || failed.alreadyReviewed) go(next(at, done));
    });
  };

  return (
    <div className="one">
      <div className="one-progress muted">
        <span>
          {at + 1} of {rows.length}
          {saved > 0 && ` · ${saved} confirmed`}
        </span>
        <Link href={list}>Back to the list</Link>
      </div>

      {outcome && !outcome.saved && <p className="signin-error">{outcome.error}</p>}

      <div className="one-card">
        <div className="one-head">
          <strong className="one-payee">{row.payeeDisplay}</strong>
          <Money cents={row.amountCents} sign="incoming" />
        </div>
        <dl className="one-facts">
          {saysMore(row) && (
            <>
              <dt>The bank wrote</dt>
              <dd>{row.payeeRaw}</dd>
            </>
          )}
          {row.memo && (
            <>
              <dt>Memo</dt>
              <dd>{row.memo}</dd>
            </>
          )}
          <dt>Date</dt>
          <dd>
            {displayDate(row.date)}
            {row.ageDays > 14 && <span className="tag warn">{row.ageDays} days</span>}
          </dd>
          <dt>Account</dt>
          <dd>{row.accountName}</dd>
          {handedBy && (
            <>
              <dt>Handed over by</dt>
              <dd>{handedBy}</dd>
            </>
          )}
        </dl>

        <div className="one-thread">
          <Thread
            key={row.id}
            transactionId={row.id}
            messages={messages}
            setMessages={(update) => setThreads((current) => ({ ...current, [row.id]: update(current[row.id] ?? row.messages) }))}
            people={people}
            writing={writing}
            onDoneWriting={() => setWriting(false)}
          />
          {!writing && (
            <button className="link-button" onClick={() => setWriting(true)}>
              {threadPrompt(messages, people)}
            </button>
          )}
        </div>

        <div className="one-decide">
          <button className={`envelope-pick${envelope ? ' chosen' : ''}`} onClick={() => overlay.open(row.id)} disabled={saving}>
            {envelope ? (
              <>
                <span className="envelope-pick-group">{envelope.groupName}</span> {envelope.name}
              </>
            ) : (
              'Choose an envelope'
            )}
          </button>
          {envelope && !pick && (
            <span className={`band ${confidence.tone}`} title={row.reason ?? undefined}>
              {confidence.label}
              {confidence.detail && ` ${confidence.detail}`}
            </span>
          )}
        </div>
      </div>

      <div className="queue-save one-actions">
        <button onClick={() => go(at === 0 ? rows.length - 1 : at - 1)} disabled={saving}>
          Previous
        </button>
        <button onClick={() => go(next(at, outcomes))} disabled={saving}>
          Skip
        </button>
        <button className="primary" onClick={confirm} disabled={saving || !envelope || outcome?.saved}>
          {outcome?.saved ? 'Confirmed' : saving ? 'Saving…' : 'Confirm'}
        </button>
      </div>
      <p className="muted footnote">
        To split it or mark it as not spending, use <Link href={list}>the list</Link>.
      </p>

      {overlay.value === row.id && (
        <div className="picker-backdrop" onClick={overlay.close}>
          <div className="picker" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{row.payeeDisplay}</strong>
              <Money cents={row.amountCents} sign="incoming" />
            </div>
            <EnvelopeChoices
              envelopes={envelopes}
              activeId={envelopeId}
              onChoose={(id, createRule) => {
                setChosen((current) => ({ ...current, [row.id]: { envelopeId: id, createRule } }));
                overlay.close();
              }}
            >
              {null}
            </EnvelopeChoices>
            <div className="picker-foot muted">
              Hold <kbd>shift</kbd> while choosing to always use it for this payee
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
