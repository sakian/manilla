'use client';

/**
 * The transaction list, and the way into editing one (FR-2, VW-5).
 *
 * A row opens the form. Its details - the envelope split in particular - are
 * fetched when the row is opened rather than for every row in the list, because
 * the list is the thing that has to stay quick with ten years of history behind
 * it (NF-8).
 */

import { useCallback, useState, useTransition } from 'react';
import type { AccountTransaction } from '../../src/accounts/manage.ts';
import { Money } from '../Money.tsx';
import { transactionDetailAction } from './actions.ts';
import TransactionForm, {
  type AccountChoice,
  type EditingTransaction,
  type EnvelopeChoice,
} from './TransactionForm.tsx';

export default function TransactionList({
  rows,
  accounts,
  envelopes,
  defaultAccountId,
  showAccount,
  heading,
}: {
  rows: AccountTransaction[];
  accounts: AccountChoice[];
  envelopes: EnvelopeChoice[];
  defaultAccountId?: string;
  /** The account column is noise when the list is already one account's. */
  showAccount?: boolean;
  /** What the list is, when it is not simply the recent ones - search results, say. */
  heading?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingTransaction | null>(null);
  const [creating, setCreating] = useState(false);

  const open = useCallback((transactionId: string) => {
    setError(null);
    startTransition(async () => {
      const result = await transactionDetailAction(transactionId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(result.transaction);
    });
  }, []);

  return (
    <>
      <div className="panel-head">
        <h3>{heading ?? (showAccount ? 'Recent transactions' : 'Transactions')}</h3>
        <button
          className="primary"
          onClick={() => setCreating(true)}
          disabled={pending || accounts.length === 0}
        >
          New transaction
        </button>
      </div>

      {error && <p className="signin-error">{error}</p>}

      {rows.length === 0 && (
        <p className="muted">
          {heading
            ? 'Nothing matches those filters.'
            : 'Nothing recorded yet. Import a statement, or enter something by hand.'}
        </p>
      )}

      {rows.map((row) => (
        <button
          key={row.id}
          className="txn txn-button"
          onClick={() => open(row.id)}
          disabled={pending}
        >
          <span className="muted txn-date">{row.date}</span>
          <span className="txn-payee">
            {row.payeeRaw}
            {row.kind === 'account_transfer' && <span className="tag">transfer</span>}
          </span>
          <span className="muted txn-env">
            {row.kind === 'account_transfer'
              ? showAccount
                ? row.accountName
                : ''
              : row.envelopeNames.length > 0
                ? row.envelopeNames.join(', ')
                : 'uncategorized'}
            {row.status === 'pending_review' && ' · pending'}
            {showAccount && row.kind !== 'account_transfer' && ` · ${row.accountName}`}
          </span>
          <Money cents={row.amountCents} />
        </button>
      ))}

      {(creating || editing) && (
        <TransactionForm
          accounts={accounts}
          envelopes={envelopes}
          {...(editing ? { editing } : {})}
          {...(defaultAccountId ? { defaultAccountId } : {})}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
