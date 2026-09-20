'use client';

/**
 * Turning the plan into dated allocations (FR-29, FR-30).
 *
 * Its own component because the action belongs next to the envelopes it fills,
 * not on a separate planning screen: you decide to fund while looking at what
 * the envelopes hold. The preview is the important part - every row proposes
 * what is *left* of its plan for the month, so funding twice does not fill
 * twice, and every figure can be edited before anything is written.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FundingPlan } from '../../src/budget/budget.ts';
import { centsFromInput, inputFromCents } from '../amount.ts';
import { fundEnvelopesAction, reverseMonthFundingAction } from './actions.ts';

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

export default function FundEnvelopes({
  month,
  label,
  funding,
  allocatedCents,
  onClose,
}: {
  month: string;
  label: string;
  funding: FundingPlan;
  /** Net allocated this month, so a month already funded can be sent back (FR-30). */
  allocatedCents: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /** The editable copy of the preview, keyed by envelope. */
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      funding.lines.map((line) => [line.envelopeId, inputFromCents(line.proposedCents)]),
    ),
  );

  const totalCents = useMemo(() => {
    let total = 0;
    for (const line of funding.lines) {
      try {
        total += centsFromInput(amounts[line.envelopeId] ?? '0');
      } catch {
        // A half-typed amount is not worth an error while they are still typing;
        // the server refuses it if it is still nonsense when applied.
      }
    }
    return total;
  }, [amounts, funding.lines]);

  const sendMonthBack = useCallback(() => {
    if (
      !window.confirm(
        `Send every allocation for ${label} back to Available? Each one is reversed by an ` +
          'opposite entry, so the history still shows what happened.',
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await reverseMonthFundingAction(month);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [label, month, onClose, router]);

  const apply = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await fundEnvelopesAction(
        month,
        funding.lines.map((line) => ({
          envelopeId: line.envelopeId,
          amount: amounts[line.envelopeId] ?? '0',
        })),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [amounts, funding.lines, month, onClose, router]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog fund-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>Fund envelopes · {label}</strong>
        </div>

        <div className="dialog-body">
          <p className="muted">
            Each row proposes what is left of its plan for this month, so funding twice does not
            fill twice. Edit anything before applying.
          </p>

          <div className="budget-table">
            <div className="budget-row fund head">
              <span>Envelope</span>
              <span>Planned</span>
              <span>Already</span>
              <span>Move now</span>
            </div>
            {funding.lines.map((line) => (
              <div key={line.envelopeId} className="budget-row fund">
                <span>
                  <span className="muted">{line.groupName}</span> {line.name}
                </span>
                <span className="money" data-label="Planned">
                  {money(line.plannedCents)}
                </span>
                <span className="money" data-label="Already">
                  {money(line.alreadyAllocatedCents)}
                </span>
                <span>
                  <input
                    className="amount"
                    inputMode="decimal"
                    aria-label={`Move to ${line.name}`}
                    value={amounts[line.envelopeId] ?? ''}
                    onChange={(event) =>
                      setAmounts((current) => ({
                        ...current,
                        [line.envelopeId]: event.target.value,
                      }))
                    }
                  />
                </span>
              </div>
            ))}
            <div className="budget-row fund total">
              <span>Total</span>
              <span />
              <span />
              <span className="money">{money(totalCents)}</span>
            </div>
          </div>

          {totalCents > funding.availableCents && (
            <p className="budget-warning">
              That is {money(totalCents - funding.availableCents)} more than Available holds.
              Applying it anyway leaves Available overdrawn, which this screen will say.
            </p>
          )}

          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button className="primary" onClick={apply} disabled={pending}>
            {pending ? 'Moving…' : `Apply ${money(totalCents)}`}
          </button>
          {allocatedCents !== 0 && (
            <button onClick={sendMonthBack} disabled={pending}>
              Send {label} back
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
