'use client';

/**
 * What the bank feed held back for a person (sync_held_rows).
 *
 * A statement's matches are decided on its preview, before anything is
 * written. A sync has no preview, so what it would have had to ask about waits
 * here instead: listed with the import screen's matches because they are the
 * same question.
 */

import Link from 'next/link';
import { useCallback, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { displayDate } from '../../src/budget/month.ts';
import { Money } from '../Money.tsx';
import { resolveHeldAction } from '../settings/bankActions.ts';

export type HeldView = {
  id: string;
  reason: string;
  date: string;
  amountCents: number;
  payeeRaw: string;
  accountName: string;
  transactionId: string | null;
  detail: string;
  /** The transaction here it matched or changes, as it stands now. */
  here?: { payeeRaw: string; date: string; amountCents: number };
};

/** What the sync is asking, in a sentence, from what it held and what is here. */
function question(row: HeldView): ReactNode {
  const here = row.here;
  switch (row.reason) {
    case 'possible_duplicate':
      return here ? (
        <>
          Looks like &ldquo;{here.payeeRaw}&rdquo; on {displayDate(here.date)}, already in {row.accountName},
          with no bank id in common.
        </>
      ) : (
        `Looks like a transaction already in ${row.accountName}.`
      );
    case 'changed':
      return here ? (
        <>
          The bank changed this after it came in: here it is <Money cents={here.amountCents} plain copy={false} /> on{' '}
          {displayDate(here.date)}.
        </>
      ) : (
        'The bank changed this after it came in.'
      );
    case 'withdrawn':
      return `The bank no longer reports this one from ${row.accountName}. If it was reversed, delete it here too.`;
    case 'rounded':
      // The sync's own words, which carry the amount exactly as the bank sent it.
      return `${row.detail}. In ${row.accountName}.`;
    default:
      return row.detail;
  }
}

export default function HeldRows({ rows }: { rows: HeldView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const settle = useCallback(
    (id: string, action: 'add' | 'link' | 'dismiss') => {
      setError(null);
      startTransition(async () => {
        const result = await resolveHeldAction(id, action);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  if (rows.length === 0) return null;

  return (
    <section className="panel" id="held">
      <h3>Held back from the bank feed</h3>
      <p className="muted">
        A sync adds what is clear-cut and keeps these for you, rather than guessing. Nothing here is in
        your accounts until you add it.
      </p>
      {error && <p className="signin-error">{error}</p>}

      {rows.map((row) => (
        <div key={row.id} className="import-match held-row">
          <span className="import-match-text">
            <span>
              {displayDate(row.date)} · {row.payeeRaw} · <Money cents={row.amountCents} />
            </span>
            <span className="muted">{question(row)}</span>
          </span>
          <span className="device-actions">
            {row.reason === 'possible_duplicate' && (
              <>
                {row.transactionId && (
                  <button onClick={() => settle(row.id, 'link')} disabled={pending}>
                    Same one
                  </button>
                )}
                <button onClick={() => settle(row.id, 'add')} disabled={pending}>
                  Add it
                </button>
              </>
            )}
            {row.reason === 'rounded' && (
              <>
                <button onClick={() => settle(row.id, 'add')} disabled={pending}>
                  Add it
                </button>
                <button onClick={() => settle(row.id, 'dismiss')} disabled={pending}>
                  Leave out
                </button>
              </>
            )}
            {(row.reason === 'changed' || row.reason === 'withdrawn') && (
              <>
                {row.transactionId && (
                  <Link href={`/transactions?txn=${row.transactionId}`} className="button-link">
                    Open it
                  </Link>
                )}
                <button onClick={() => settle(row.id, 'dismiss')} disabled={pending}>
                  Keep as is
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}
