'use client';

/**
 * The "new transaction" button, on its own so it can sit in a screen's head row
 * with Import and the CSV rather than inside the list it adds to.
 *
 * It is a button and a dialog and nothing else; the list below re-reads itself
 * when the server action refreshes the route. Open-ness lives in the URL as
 * `?new=transaction`, so back closes it like anything else.
 */

import { useOverlay } from '../useOverlay.ts';
import TransactionForm, {
  type AccountChoice,
  type EnvelopeChoice,
} from './TransactionForm.tsx';

export default function NewTransaction({
  accounts,
  envelopes,
  defaultAccountId,
}: {
  accounts: AccountChoice[];
  envelopes: EnvelopeChoice[];
  defaultAccountId?: string;
}) {
  const overlay = useOverlay('new');

  return (
    <>
      <button onClick={() => overlay.open('transaction')} disabled={accounts.length === 0}>
        New
      </button>
      {overlay.value && (
        <TransactionForm
          accounts={accounts}
          envelopes={envelopes}
          {...(defaultAccountId ? { defaultAccountId } : {})}
          onClose={overlay.close}
        />
      )}
    </>
  );
}
