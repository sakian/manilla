'use client';

/**
 * One dialog for entering and correcting transactions (FR-2, FR-4, FR-5).
 *
 * Amounts are typed as positive numbers with an "out" or "in" toggle rather than
 * as signed figures. It is how people say it, and it removes the single easiest
 * way to enter a month backwards.
 *
 * The split rows carry the same direction as the transaction, and the dialog
 * keeps a running "left to assign" figure - the FR-4 rule is that the parts sum
 * to the whole, so the arithmetic belongs on screen rather than in an error
 * message after the fact.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { centsFromInput, inputFromCents } from '../amount.ts';
import {
  createTransactionAction,
  createTransferAction,
  deleteTransactionAction,
  deleteTransferAction,
  sendBackToReviewAction,
  updateTransactionAction,
  updateTransferAction,
  type Direction,
} from './actions.ts';
import { formatMoney } from '../../src/money.ts';

export type AccountChoice = { id: string; name: string };
export type EnvelopeChoice = { id: string; name: string; groupName: string };

export type EditingTransaction = {
  id: string;
  accountId: string;
  date: string;
  amountCents: number;
  payeeRaw: string;
  memo: string | null;
  kind: 'spending' | 'account_transfer';
  status: 'pending_review' | 'confirmed';
  transferPairId: string | null;
  source: string;
  lines: { envelopeId: string; amountCents: number }[];
};

type LineDraft = { envelopeId: string; amount: string };

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export default function TransactionForm({
  accounts,
  envelopes,
  editing,
  defaultAccountId,
  onClose,
}: {
  accounts: AccountChoice[];
  envelopes: EnvelopeChoice[];
  /** Absent when entering something new. */
  editing?: EditingTransaction;
  defaultAccountId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isTransfer = editing?.kind === 'account_transfer';
  const [mode, setMode] = useState<'spending' | 'transfer'>(
    isTransfer ? 'transfer' : 'spending',
  );

  const [accountId, setAccountId] = useState(
    editing?.accountId ?? defaultAccountId ?? accounts[0]?.id ?? '',
  );
  const [toAccountId, setToAccountId] = useState(
    accounts.find((account) => account.id !== (editing?.accountId ?? accounts[0]?.id))?.id ?? '',
  );
  const [date, setDate] = useState(editing?.date ?? today());
  const [direction, setDirection] = useState<Direction>(
    editing && editing.amountCents > 0 ? 'in' : 'out',
  );
  const [amount, setAmount] = useState(
    editing ? inputFromCents(Math.abs(editing.amountCents)) : '',
  );
  const [payeeRaw, setPayeeRaw] = useState(editing?.payeeRaw ?? '');
  const [memo, setMemo] = useState(editing?.memo ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    editing && editing.lines.length > 0
      ? editing.lines.map((line) => ({
          envelopeId: line.envelopeId,
          amount: inputFromCents(Math.abs(line.amountCents)),
        }))
      : [{ envelopeId: '', amount: '' }],
  );

  /**
   * A transfer edit addresses the pair, never one half, so the two halves cannot
   * drift apart (FR-5).
   */
  const transferPairId = editing?.transferPairId ?? null;

  const totalCents = useMemo(() => {
    try {
      return centsFromInput(amount);
    } catch {
      return 0;
    }
  }, [amount]);

  const assignedCents = useMemo(() => {
    let total = 0;
    for (const line of lines) {
      if (!line.envelopeId || line.amount.trim() === '') continue;
      try {
        total += centsFromInput(line.amount);
      } catch {
        // Still being typed; the server has the last word either way.
      }
    }
    return total;
  }, [lines]);

  const usable = lines.filter((line) => line.envelopeId && line.amount.trim() !== '');
  const leftToAssign = totalCents - assignedCents;

  const run = useCallback(
    (work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) => {
      setError(null);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        onClose();
        router.refresh();
      });
    },
    [onClose, router],
  );

  const save = useCallback(() => {
    if (mode === 'transfer') {
      const fields = {
        fromAccountId: accountId,
        toAccountId,
        amount,
        date,
        ...(payeeRaw.trim() ? { payeeRaw } : {}),
      };
      run(() =>
        transferPairId ? updateTransferAction(transferPairId, fields) : createTransferAction(fields),
      );
      return;
    }

    const fields = {
      accountId,
      date,
      direction,
      amount,
      payeeRaw,
      memo,
      lines: usable,
    };
    run(() =>
      editing ? updateTransactionAction(editing.id, fields) : createTransactionAction(fields),
    );
  }, [
    accountId,
    amount,
    date,
    direction,
    editing,
    memo,
    mode,
    payeeRaw,
    run,
    toAccountId,
    transferPairId,
    usable,
  ]);

  const remove = useCallback(() => {
    if (!editing) return;
    const what =
      editing.kind === 'account_transfer'
        ? 'Delete this transfer? Both halves go.'
        : 'Delete this transaction?';
    if (!window.confirm(what)) return;

    run(() =>
      transferPairId
        ? deleteTransferAction(transferPairId)
        : deleteTransactionAction(editing.id),
    );
  }, [editing, run, transferPairId]);

  const sendBack = useCallback(() => {
    if (!editing) return;
    const what =
      editing.kind === 'account_transfer'
        ? 'Undo this transfer pairing? The bank row goes back to the review queue, and the other ' +
          'half goes with it or is removed if it never came from a statement.'
        : 'Send this back to the review queue? Its envelope is cleared so it can be categorized ' +
          'again. Nothing is deleted.';
    if (!window.confirm(what)) return;

    run(() => sendBackToReviewAction(editing.id));
  }, [editing, run]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>{editing ? 'Edit transaction' : 'New transaction'}</strong>
          {editing?.source === 'file_import' && <span className="tag">imported</span>}
        </div>

        <div className="dialog-body">
          {!editing && (
            <div className="segmented">
              <button
                className={mode === 'spending' ? 'active' : ''}
                onClick={() => setMode('spending')}
              >
                Spending or income
              </button>
              <button
                className={mode === 'transfer' ? 'active' : ''}
                onClick={() => setMode('transfer')}
              >
                Between my accounts
              </button>
            </div>
          )}

          <label className="field">
            <span>{mode === 'transfer' ? 'From account' : 'Account'}</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>

          {mode === 'transfer' && (
            <label className="field">
              <span>To account</span>
              <select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
                {accounts
                  .filter((account) => account.id !== accountId)
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
              </select>
            </label>
          )}

          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>

          {mode === 'spending' && (
            <div className="segmented">
              <button
                className={direction === 'out' ? 'active' : ''}
                onClick={() => setDirection('out')}
              >
                Money out
              </button>
              <button
                className={direction === 'in' ? 'active' : ''}
                onClick={() => setDirection('in')}
              >
                Money in
              </button>
            </div>
          )}

          <label className="field">
            <span>Amount</span>
            <input
              className="amount"
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>

          <label className="field">
            <span>{mode === 'transfer' ? 'Description' : 'Payee or description'}</span>
            <input
              value={payeeRaw}
              placeholder={mode === 'transfer' ? 'Optional' : 'Where the money went'}
              onChange={(event) => setPayeeRaw(event.target.value)}
            />
          </label>

          {mode === 'spending' && (
            <>
              <label className="field">
                <span>Note</span>
                <input
                  value={memo}
                  placeholder="Optional"
                  onChange={(event) => setMemo(event.target.value)}
                />
              </label>

              <div className="field">
                <span>Envelopes</span>
                {lines.map((line, index) => (
                  <div key={index} className="split-row">
                    <select
                      value={line.envelopeId}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((row, at) =>
                            at === index ? { ...row, envelopeId: event.target.value } : row,
                          ),
                        )
                      }
                    >
                      <option value="">Leave for the review queue</option>
                      {envelopes.map((envelope) => (
                        <option key={envelope.id} value={envelope.id}>
                          {envelope.groupName} · {envelope.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className="amount"
                      inputMode="decimal"
                      value={line.amount}
                      placeholder={index === 0 ? inputFromCents(totalCents) : '0.00'}
                      onChange={(event) =>
                        setLines((current) =>
                          current.map((row, at) =>
                            at === index ? { ...row, amount: event.target.value } : row,
                          ),
                        )
                      }
                    />
                    {lines.length > 1 && (
                      <button
                        onClick={() =>
                          setLines((current) => current.filter((_, at) => at !== index))
                        }
                        title="Remove this part"
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}

                <div className="split-foot">
                  <button
                    onClick={() =>
                      setLines((current) => [
                        ...current,
                        {
                          envelopeId: '',
                          // The obvious next amount is whatever is still unassigned.
                          amount: leftToAssign > 0 ? inputFromCents(leftToAssign) : '',
                        },
                      ])
                    }
                  >
                    Split across another envelope
                  </button>
                  {usable.length > 0 && (
                    <span className={leftToAssign === 0 ? 'muted' : 'split-short'}>
                      {leftToAssign === 0
                        ? 'All assigned'
                        : `${formatMoney(leftToAssign)} left to assign`}
                    </span>
                  )}
                </div>
              </div>

              {usable.length === 0 && (
                <p className="muted">
                  With no envelope chosen this lands in the review queue, where it still counts
                  against the account.
                </p>
              )}
            </>
          )}

          {mode === 'transfer' && (
            <p className="muted">
              Money moving between your own accounts is neither spending nor income, so no envelope
              changes (FR-5).
            </p>
          )}

          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button
            className="primary"
            onClick={save}
            disabled={
              pending ||
              amount.trim() === '' ||
              (mode === 'transfer' ? !toAccountId : payeeRaw.trim() === '')
            }
          >
            {pending ? 'Saving…' : editing ? 'Save' : 'Record it'}
          </button>
          {/* Nothing to take back on a row that is already waiting, or on an
              opening balance nobody categorized (#9). */}
          {editing &&
            editing.source !== 'opening_balance' &&
            !(editing.kind === 'spending' && editing.status === 'pending_review') && (
              <button onClick={sendBack} disabled={pending}>
                {editing.kind === 'account_transfer' ? 'Not a transfer' : 'Back to review'}
              </button>
            )}
          {editing && (
            <button onClick={remove} disabled={pending}>
              Delete
            </button>
          )}
          <button onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
