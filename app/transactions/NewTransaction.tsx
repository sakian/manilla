'use client';

/**
 * The "new transaction" button, on its own so it can sit in a screen's head row
 * with Import and the CSV rather than inside the list it adds to.
 *
 * It is a button and a dialog and nothing else; the list below re-reads itself
 * when the server action refreshes the route. Open-ness lives in the URL as
 * `?new=transaction`, so back closes it like anything else. Arriving from
 * another ledger with the other side of a transaction to enter, the draft rides
 * along in the same URL and fills the form (LG-6).
 */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useOverlay } from '../useOverlay.ts';
import TransactionForm, {
  type AccountChoice,
  type EnvelopeChoice,
  type OtherLedger,
} from './TransactionForm.tsx';
import { OTHER_SIDE_PARAMS, draftFrom } from '../../src/ledgers/otherSide.ts';
import { formatMoney } from '../../src/money.ts';
import { displayDate } from '../../src/budget/month.ts';

export default function NewTransaction({
  accounts,
  envelopes,
  defaultAccountId,
  ledgerName,
  otherLedgers,
}: {
  accounts: AccountChoice[];
  envelopes: EnvelopeChoice[];
  defaultAccountId?: string;
  ledgerName: string;
  otherLedgers: OtherLedger[];
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const draft = draftFrom((name) => params.get(name));

  /**
   * A draft arrives by a server action's redirect, so the router - not a
   * shallow history entry - put `new` in the URL, and only the router can take
   * it out: rewriting history underneath it, as `overlay.close` does, left the
   * refresh after saving to put the dialog straight back. Any filters the list
   * had stay.
   */
  const closeDraft = useCallback(() => {
    const kept = new URLSearchParams(params.toString());
    for (const name of ['new', ...OTHER_SIDE_PARAMS]) kept.delete(name);
    const query = kept.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);
  const overlay = useOverlay('new', OTHER_SIDE_PARAMS, draft ? closeDraft : undefined);
  const close = overlay.close;

  return (
    <>
      <button onClick={() => overlay.open('transaction')} disabled={accounts.length === 0}>
        New
      </button>
      {overlay.value && accounts.length === 0 && draft && (
        // A ledger opened a moment ago has nowhere to put money yet. Say what
        // was to be recorded, rather than a form that cannot be saved.
        <div className="picker-backdrop" onClick={close}>
          <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <strong>{ledgerName} has no accounts yet</strong>
            </div>
            <div className="dialog-body">
              <p>
                The other side to record here is {formatMoney(draft.amountCents)}{' '}
                {draft.direction === 'in' ? 'coming in' : 'going out'} on{' '}
                {displayDate(draft.date)}
                {draft.payee ? `, "${draft.payee}"` : ''}. Add the account it belongs to first.
              </p>
            </div>
            <div className="picker-foot dialog-foot">
              <a className="button-link" href="/accounts">
                Add an account
              </a>
              <button onClick={close}>Not now</button>
            </div>
          </div>
        </div>
      )}
      {overlay.value && accounts.length > 0 && (
        <TransactionForm
          // Arriving with a draft lands on this same page with the dialog still
          // open, so without a key React keeps the form that was just saved -
          // its "recorded" step and all - in place of the one to fill in.
          key={`${ledgerName}|${draft ? JSON.stringify(draft) : ''}`}
          accounts={accounts}
          envelopes={envelopes}
          {...(defaultAccountId ? { defaultAccountId } : {})}
          {...(draft ? { draft } : {})}
          ledgerName={ledgerName}
          otherLedgers={otherLedgers}
          onClose={close}
        />
      )}
    </>
  );
}
