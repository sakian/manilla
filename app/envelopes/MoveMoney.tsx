'use client';

/**
 * The two dialogs that move money between envelopes.
 *
 * `TransferDialog` is FR-34: any two envelopes, an amount, a date and a note.
 * `CoverDialog` is FR-35: an overspent envelope asks where the money should come
 * from, and the server proposes an answer that the user can edit before it is
 * applied. Both are here rather than on one screen because both the envelope list
 * and a single envelope's page need them.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useOverlay } from '../useOverlay.ts';
import { useRouter } from 'next/navigation';
import type { CoverPlan } from '../../src/envelopes/transfer.ts';
import { inputFromCents } from '../amount.ts';
import {
  archiveEnvelopeAction,
  coverAction,
  coverPlanAction,
  transferAction,
} from './actions.ts';

export type EnvelopeChoice = {
  id: string;
  name: string;
  groupName: string;
  balanceCents: number;
};

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export function TransferDialog({
  envelopes,
  fromEnvelopeId,
  onClose: closed,
}: {
  envelopes: EnvelopeChoice[];
  /** Pre-selected source, when the dialog was opened from one envelope's row. */
  fromEnvelopeId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const onClose = useOverlay(closed);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState(fromEnvelopeId ?? envelopes[0]?.id ?? '');
  const [to, setTo] = useState(
    envelopes.find((envelope) => envelope.id !== (fromEnvelopeId ?? envelopes[0]?.id))?.id ?? '',
  );
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');

  const submit = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await transferAction({
        fromEnvelopeId: from,
        toEnvelopeId: to,
        amount,
        date,
        note,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [amount, date, from, note, onClose, router, to]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>Move money between envelopes</strong>
        </div>

        <div className="dialog-body">
          <label className="field">
            <span>From</span>
            <select value={from} onChange={(event) => setFrom(event.target.value)}>
              {envelopes.map((envelope) => (
                <option key={envelope.id} value={envelope.id}>
                  {envelope.groupName} · {envelope.name} ({money(envelope.balanceCents)})
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>To</span>
            <select value={to} onChange={(event) => setTo(event.target.value)}>
              {envelopes
                .filter((envelope) => envelope.id !== from)
                .map((envelope) => (
                  <option key={envelope.id} value={envelope.id}>
                    {envelope.groupName} · {envelope.name} ({money(envelope.balanceCents)})
                  </option>
                ))}
            </select>
          </label>

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
            <span>Date</span>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>

          <label className="field">
            <span>Note</span>
            <input
              value={note}
              placeholder="Why the money moved"
              onChange={(event) => setNote(event.target.value)}
            />
          </label>

          <p className="muted">
            Moving money between envelopes changes no account balance: the money has not gone
            anywhere, only its assignment has.
          </p>
          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button
            className="primary"
            onClick={submit}
            disabled={pending || !from || !to || amount.trim() === ''}
          >
            {pending ? 'Moving…' : 'Move'}
          </button>
          <button onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export function CoverDialog({
  envelopeId,
  envelopeName,
  onClose: closed,
}: {
  envelopeId: string;
  envelopeName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const onClose = useOverlay(closed);
  const [pending, startTransition] = useTransition();
  const [plan, setPlan] = useState<CoverPlan | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void coverPlanAction(envelopeId).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPlan(result.plan);
      setAmounts(
        Object.fromEntries(
          result.plan.sources.map((source) => [
            source.envelopeId,
            source.proposedCents > 0 ? inputFromCents(source.proposedCents) : '',
          ]),
        ),
      );
    });
    return () => {
      live = false;
    };
  }, [envelopeId]);

  const submit = useCallback(() => {
    if (!plan) return;
    setError(null);
    startTransition(async () => {
      const result = await coverAction(
        envelopeId,
        plan.sources.map((source) => ({
          envelopeId: source.envelopeId,
          amount: amounts[source.envelopeId] ?? '',
        })),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [amounts, envelopeId, onClose, plan, router]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>Cover {envelopeName}</strong>
          {plan && <span className="money neg">{money(-plan.neededCents)}</span>}
        </div>

        <div className="dialog-body">
          {!plan && !error && <p className="muted">Working out where the money could come from…</p>}

          {plan && plan.neededCents === 0 && (
            <p className="muted">{envelopeName} is not overspent, so there is nothing to cover.</p>
          )}

          {plan && plan.neededCents > 0 && (
            <>
              <p className="muted">
                Available first, then the envelopes with the most room. Nothing proposed here would
                push another envelope negative - edit any of it before applying.
              </p>
              <div className="budget-table">
                <div className="budget-row head cover">
                  <span>From</span>
                  <span>Has</span>
                  <span>Take</span>
                </div>
                {plan.sources.map((source) => (
                  <div key={source.envelopeId} className="budget-row cover">
                    <span>
                      <span className="muted">{source.groupName}</span> {source.name}
                    </span>
                    <span className="money">{money(source.spareCents)}</span>
                    <span>
                      <input
                        className="amount"
                        inputMode="decimal"
                        value={amounts[source.envelopeId] ?? ''}
                        onChange={(event) =>
                          setAmounts((current) => ({
                            ...current,
                            [source.envelopeId]: event.target.value,
                          }))
                        }
                      />
                    </span>
                  </div>
                ))}
              </div>
              {plan.proposedCents < plan.neededCents && (
                <p className="budget-warning">
                  Even emptying every other envelope leaves {money(plan.neededCents - plan.proposedCents)}{' '}
                  uncovered. More income is the only thing that fixes that.
                </p>
              )}
            </>
          )}

          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button
            className="primary"
            onClick={submit}
            disabled={pending || !plan || plan.neededCents === 0}
          >
            {pending ? 'Moving…' : 'Cover it'}
          </button>
          <button onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Archiving an envelope that still holds money (FR-25).
 *
 * The requirement is that the balance moves first, and this is what makes that one
 * decision rather than two errands: it says how much is in the way, asks where it
 * should go, and the server does the move and the archive in one transaction.
 */
export function ArchiveDialog({
  envelopeId,
  envelopeName,
  balanceCents,
  envelopes,
  onClose: closed,
}: {
  envelopeId: string;
  envelopeName: string;
  balanceCents: number;
  envelopes: EnvelopeChoice[];
  onClose: () => void;
}) {
  const router = useRouter();
  const onClose = useOverlay(closed);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const others = envelopes.filter((envelope) => envelope.id !== envelopeId);
  const [target, setTarget] = useState(others[0]?.id ?? '');

  const needsDestination = balanceCents !== 0;

  const submit = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await archiveEnvelopeAction(
        envelopeId,
        needsDestination ? target : undefined,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [envelopeId, needsDestination, onClose, router, target]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>Archive {envelopeName}</strong>
          {needsDestination && <span className="money">{money(balanceCents)}</span>}
        </div>

        <div className="dialog-body">
          {needsDestination ? (
            <>
              <p className="muted">
                {envelopeName} {balanceCents > 0 ? 'holds' : 'is overspent by'}{' '}
                {money(Math.abs(balanceCents))}, and money cannot be archived out of sight - it
                would still count towards the total the dashboard checks. Say where it should go and
                both happen together.
              </p>
              <label className="field">
                <span>{balanceCents > 0 ? 'Move the balance to' : 'Cover it from'}</span>
                <select value={target} onChange={(event) => setTarget(event.target.value)}>
                  {others.map((envelope) => (
                    <option key={envelope.id} value={envelope.id}>
                      {envelope.groupName} · {envelope.name} ({money(envelope.balanceCents)})
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <p className="muted">
              Its history stays where it is; the envelope just leaves the dashboard and the pickers.
              You can restore it later.
            </p>
          )}
          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button
            className="primary"
            onClick={submit}
            disabled={pending || (needsDestination && !target)}
          >
            {pending ? 'Archiving…' : needsDestination ? 'Move it and archive' : 'Archive'}
          </button>
          <button onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
