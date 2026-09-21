'use client';

/**
 * The "new transaction" button, on its own so it can sit in a screen's head row
 * with Import and the CSV rather than inside the list it adds to.
 *
 * It is a button and a dialog and nothing else; the list below re-reads itself
 * when the server action refreshes the route.
 */

import { useState } from 'react';
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
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)} disabled={accounts.length === 0}>
        New
      </button>
      {open && (
        <TransactionForm
          accounts={accounts}
          envelopes={envelopes}
          {...(defaultAccountId ? { defaultAccountId } : {})}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
