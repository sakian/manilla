'use client';

/**
 * The transaction list, and the way into editing one (FR-2, VW-5).
 *
 * A row opens the form, and which row is open lives in the URL as `?txn=<id>`
 * (see `useOverlay`). So the phone's back button closes the detail instead of
 * leaving the list, and an open transaction is a thing you can link to.
 *
 * Its details - the envelope split in particular - are fetched when the row is
 * opened rather than for every row in the list, because the list is the thing
 * that has to stay quick with ten years of history behind it (NF-8).
 */

import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import type { AccountTransaction } from '../../src/accounts/manage.ts';
import type { EnvelopeActivityRow, EnvelopeMoveRow } from '../../src/envelopes/activity.ts';
import { Money } from '../Money.tsx';
import { useOverlay } from '../useOverlay.ts';
import { transactionDetailAction } from './actions.ts';
import TransactionForm, {
  type AccountChoice,
  type EditingTransaction,
  type EnvelopeChoice,
} from './TransactionForm.tsx';

export default function TransactionList({
  rows,
  history,
  historyEnvelopeId,
  accounts,
  envelopes,
  defaultAccountId,
  showAccount,
  heading,
}: {
  rows: AccountTransaction[];
  /**
   * One envelope's whole history - fills and transfers among its transactions,
   * each with the envelope's balance after it - shown instead of `rows`.
   */
  history?: EnvelopeActivityRow[];
  /** Where a move leads: the envelope's own screen, where one can be undone. */
  historyEnvelopeId?: string;
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
  const overlay = useOverlay('txn');
  const openId = overlay.value;

  /**
   * The URL says which row is open; this fetches what it needs to show.
   *
   * Reading it here rather than on the server keeps opening a dialog a shallow
   * navigation - no round trip for the page, only for the one transaction.
   */
  useEffect(() => {
    if (!openId) {
      setEditing(null);
      return;
    }
    let current = true;
    setError(null);
    startTransition(async () => {
      const result = await transactionDetailAction(openId);
      if (!current) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(result.transaction);
    });
    return () => {
      current = false;
    };
  }, [openId]);

  return (
    <>
      <div className="panel-head">
        <h3>{heading ?? (showAccount ? 'Recent transactions' : 'Transactions')}</h3>
      </div>

      {error && <p className="signin-error">{error}</p>}

      {rows.length === 0 && (
        <p className="muted">
          {heading
            ? 'Nothing matches those filters.'
            : 'Nothing recorded yet. Import a statement, or enter something by hand.'}
        </p>
      )}

      {history
        ? history.map((entry) =>
            entry.type === 'transaction' ? (
              <TransactionRow
                key={entry.transaction.id}
                row={entry.transaction}
                shareCents={entry.shareCents}
                balance={{
                  cents: entry.balanceAfterCents,
                  title: "The envelope's balance after this transaction",
                }}
                showAccount={showAccount}
                disabled={pending}
                onOpen={() => overlay.open(entry.transaction.id)}
              />
            ) : (
              <MoveRow
                key={entry.move.id}
                move={entry.move}
                balanceAfterCents={entry.balanceAfterCents}
                href={historyEnvelopeId ? `/envelopes/${historyEnvelopeId}` : undefined}
              />
            ),
          )
        : rows.map((row) => (
            <TransactionRow
              key={row.id}
              row={row}
              {...(row.balanceAfterCents !== undefined
                ? {
                    balance: {
                      cents: row.balanceAfterCents,
                      title: "The account's balance after this transaction",
                    },
                  }
                : {})}
              showAccount={showAccount}
              disabled={pending}
              onOpen={() => overlay.open(row.id)}
            />
          ))}

      {openId && editing && editing.id === openId && (
        <TransactionForm
          accounts={accounts}
          envelopes={envelopes}
          editing={editing}
          {...(defaultAccountId ? { defaultAccountId } : {})}
          onClose={overlay.close}
        />
      )}
    </>
  );
}

function TransactionRow({
  row,
  shareCents,
  balance,
  showAccount,
  disabled,
  onOpen,
}: {
  row: AccountTransaction;
  /** In an envelope's history, the envelope's part of it - what its balance moved by. */
  shareCents?: number;
  balance?: { cents: number; title: string };
  showAccount?: boolean | undefined;
  disabled: boolean;
  onOpen: () => void;
}) {
  const partOf = shareCents !== undefined && shareCents !== row.amountCents;
  return (
    <button
      className={`txn txn-button${row.status === 'pending_review' ? ' unreviewed' : ''}${
        balance ? ' with-balance' : ''
      }`}
      onClick={onOpen}
      disabled={disabled}
    >
      <span className="txn-payee">
        {row.payeeRaw}
        {row.kind === 'account_transfer' && <span className="tag">transfer</span>}
      </span>
      <Money cents={shareCents ?? row.amountCents} />
      {/* Date and where it went share one line as flex children, not as two
          grid cells: a long envelope name squeezed the date's column to
          nothing and the nowrap date spilled over the top of it. */}
      <span className="muted txn-meta">
        <span className="txn-date">{row.date}</span>
        <span className="txn-env">
          {partOf && (
            <>
              part of <Money cents={row.amountCents} plain /> ·{' '}
            </>
          )}
          {row.kind === 'account_transfer'
            ? showAccount
              ? row.accountName
              : 'transfer'
            : row.envelopeNames.length > 0
              ? row.envelopeNames.join(', ')
              : 'uncategorized'}
          {row.status === 'pending_review' && ' · not reviewed'}
          {showAccount && row.kind !== 'account_transfer' && ` · ${row.accountName}`}
        </span>
      </span>
      {/* The balance once this row is counted, under the amount the way a
          statement prints it, so the day it went wrong can be found by
          reading down the list. */}
      {balance && (
        <span className="txn-balance" title={balance.title}>
          <Money cents={balance.cents} />
        </span>
      )}
      {row.note && <span className="txn-note">{row.note}</span>}
    </button>
  );
}

/**
 * A fill, a transfer or an adjustment in an envelope's history. Not a
 * transaction - no account, nothing to edit - so it leads to the envelope's
 * own screen, where a move can be sent back.
 */
function MoveRow({
  move,
  balanceAfterCents,
  href,
}: {
  move: EnvelopeMoveRow;
  balanceAfterCents: number;
  href?: string | undefined;
}) {
  const coming = move.amountCents > 0;
  const what = move.otherIsPool
    ? coming
      ? 'Filled'
      : 'Returned to Available'
    : coming
      ? `From ${move.otherEnvelopeName}`
      : `To ${move.otherEnvelopeName}`;
  const body = (
    <>
      <span className="txn-payee">
        {what}
        <span className="tag">{move.otherIsPool ? 'fill' : 'transfer'}</span>
      </span>
      <Money cents={move.amountCents} />
      <span className="muted txn-meta">
        <span className="txn-date">{move.date}</span>
        {move.note && <span className="txn-env">{move.note}</span>}
      </span>
      <span className="txn-balance" title="The envelope's balance after this">
        <Money cents={balanceAfterCents} />
      </span>
    </>
  );
  return href ? (
    <Link href={href} className="txn txn-move with-balance">
      {body}
    </Link>
  ) : (
    <div className="txn txn-move with-balance">{body}</div>
  );
}
