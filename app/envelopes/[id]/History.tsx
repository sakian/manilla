'use client';

/**
 * One envelope's history, and the one thing you can undo from it (VW-4, FR-30).
 *
 * Allocations used to be listed again on the budget screen with their own undo
 * button. They are listed here, on the envelope the money went into, so this is
 * where sending one back belongs - the alternative was two lists of the same
 * records, only one of which could act on them.
 *
 * Undo is offered on money allocated *into* this envelope, and nowhere else. A
 * negative allocation on an ordinary envelope is already a reversal, and
 * reversing a reversal would re-allocate, which is a confusing way to spell
 * "fund it again". The income pool shows the other side of every allocation, so
 * it offers nothing here at all.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { EnvelopeEvent } from '../../../src/envelopes/manage.ts';
import { Money } from '../../Money.tsx';
import { reverseAllocationAction } from '../../budget/actions.ts';

function shortDate(date: string): string {
  const [year, month, day] = date.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1]} ${Number(day)} ${year}`;
}

export default function History({
  events,
  month,
  isPool,
}: {
  events: EnvelopeEvent[];
  /** The month to refresh, since allocations are dated records (FR-30). */
  month: string;
  isPool: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const sendBack = useCallback(
    (moveId: string) => {
      setError(null);
      startTransition(async () => {
        const result = await reverseAllocationAction(moveId, month);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    },
    [month, router],
  );

  if (events.length === 0) return <p className="muted">Nothing has happened here yet.</p>;

  return (
    <>
      {error && <p className="signin-error">{error}</p>}

      {events.map((event) => {
        const undoable =
          !isPool && event.kind === 'allocation' && event.amountCents > 0;

        return (
          <div key={event.id} className="txn">
            <span className="muted txn-date">{shortDate(event.date)}</span>
            <span className="txn-payee">
              {event.description}
              {event.kind === 'allocation' && <span className="tag">allocation</span>}
              {event.kind === 'transfer' && <span className="tag">transfer</span>}
            </span>
            <span className="muted txn-env">
              {event.kind === 'transaction' ? event.accountName : ''}
              {event.pending && ' · pending review'}
            </span>
            <span className="allocation-actions">
              <Money cents={event.amountCents} />
              {undoable && (
                <button onClick={() => sendBack(event.moveId)} disabled={pending}>
                  Send back
                </button>
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
