'use client';

/**
 * Moving money between Available and the envelopes (FR-29, FR-30).
 *
 * Its own component because the action belongs next to the envelopes it fills,
 * not on a separate planning screen: you decide while looking at what the
 * envelopes hold.
 *
 * Four things shape it.
 *
 * **Nothing is written until Apply.** Every figure here is arithmetic in the
 * browser, including what Available would be left with, so a whole month's
 * split can be worked out and changed and worked out again without the books
 * passing through a state nobody chose. One server call writes the lot.
 *
 * **Add, or set a target - per envelope.** "Another fifty into Groceries" and
 * "make Savings two hundred" are both natural, and a month is usually a mix of
 * the two: top up the regulars, decide a figure for the one you are thinking
 * about. A single switch for the whole dialog forced one language on every row.
 * Setting a target needs the current balance to subtract from, which is why a
 * funding line carries it.
 *
 * **Amounts can be negative.** Taking a hundred out of Groceries and putting it
 * into Savings is one decision, and it belongs in one sitting rather than split
 * across two screens with the books half-changed in between.
 *
 * **Every envelope is listed, planned or not.** A plan is what funding proposes,
 * not what it permits. Rows left alone write nothing.
 *
 * Applying with Available overdrawn is allowed - FR-24 lets a balance go
 * negative, and refusing would strand someone who knows income arrives tomorrow.
 * It says so plainly first, and the home screen keeps saying so afterwards.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { FundingPlan } from '../../src/budget/budget.ts';
import { AmountError, centsFromInput, inputFromCents } from '../amount.ts';
import { Hint } from '../Hint.tsx';
import { fundEnvelopesAction } from './actions.ts';
import { formatMoney } from '../../src/money.ts';

type Mode = 'add' | 'target';

/**
 * What a row's typed value means, in cents moved out of Available.
 *
 * An empty field is "leave this alone", in both modes. It matters most in target
 * mode: read literally, a cleared box says "set this envelope to zero", which
 * would empty it - and clearing a field is what anyone does before typing. So a
 * blank moves nothing, and emptying an envelope deliberately means typing a 0.
 */
function moveFor(mode: Mode, typed: string, balanceCents: number): number {
  if (typed.trim() === '') return 0;
  const value = centsFromInput(typed);
  return mode === 'add' ? value : value - balanceCents;
}

export default function FundEnvelopes({
  month,
  label,
  funding,
  onClose,
}: {
  month: string;
  label: string;
  funding: FundingPlan;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Every row starts on "add", holding its planned monthly amount. */
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      funding.lines.map((line) => [line.envelopeId, inputFromCents(line.proposedCents)]),
    ),
  );

  const modeOf = useCallback((envelopeId: string) => modes[envelopeId] ?? 'add', [modes]);

  /**
   * Toggling a row changes what its figure means and leaves the figure alone.
   *
   * Re-seeding it seemed tidier - "50" as an addition is not "50" as a target -
   * but it threw away something typed on purpose, and the "moves" column already
   * says what the row will do under the new reading. Changing the meaning is the
   * point of the toggle; changing the number too is the toggle deciding for you.
   */
  const toggleMode = useCallback((envelopeId: string) => {
    setModes((current) => ({
      ...current,
      [envelopeId]: (current[envelopeId] ?? 'add') === 'add' ? 'target' : 'add',
    }));
  }, []);

  /** What each row would move, and what is unreadable, in one pass. */
  const moves = useMemo(() => {
    const byEnvelope = new Map<string, number>();
    const bad: string[] = [];
    let total = 0;

    for (const line of funding.lines) {
      const typed = amounts[line.envelopeId] ?? '';
      try {
        const cents = moveFor(modeOf(line.envelopeId), typed, line.balanceCents);
        byEnvelope.set(line.envelopeId, cents);
        total += cents;
      } catch {
        // Half-typed is not an error yet, but it must not be counted either.
        bad.push(line.name);
      }
    }

    return { byEnvelope, total, bad };
  }, [amounts, funding.lines, modeOf]);

  const availableAfter = funding.availableCents - moves.total;
  const touched = [...moves.byEnvelope.values()].filter((cents) => cents !== 0).length;

  const apply = useCallback(() => {
    setError(null);

    let lines: { envelopeId: string; amount: string }[];
    try {
      lines = funding.lines.map((line) => ({
        envelopeId: line.envelopeId,
        // Sent as an amount to move whichever way it was typed, so the server
        // never has to know which language the dialog was in.
        amount: inputFromCents(
          moveFor(modeOf(line.envelopeId), amounts[line.envelopeId] ?? '0', line.balanceCents),
        ),
      }));
    } catch (problem) {
      setError(
        problem instanceof AmountError
          ? problem.message
          : 'One of those amounts could not be read.',
      );
      return;
    }

    startTransition(async () => {
      const result = await fundEnvelopesAction(month, lines);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
      router.refresh();
    });
  }, [amounts, funding.lines, modeOf, month, onClose, router]);

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker dialog fund-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <strong>Fund envelopes · {label}</strong>
          <Hint label="How funding works">
            Money out of Available and into the envelopes. Every figure here is worked out in your
            browser — nothing moves until you press Apply. Each row starts at its planned monthly
            amount, and at nothing when it has no plan; what the envelope has already had this month
            sits beside it, so funding twice is visible before you do it. Choose <em>add</em> to put
            an amount in, or <em>set to</em> to name the balance you want and let Manilla work out
            the difference. Either can be negative, which takes money back out and returns it to
            Available.
          </Hint>
        </div>

        <div className="fund-summary">
          <span className="figure">
            <span className="figure-label">Available now</span>
            <span className="money">{formatMoney(funding.availableCents)}</span>
          </span>
          <span className="figure">
            <span className="figure-label">Moving</span>
            <span className="money">{formatMoney(moves.total)}</span>
          </span>
          <span className="figure strong">
            <span className="figure-label">Available after</span>
            <span className={`money${availableAfter < 0 ? ' neg' : ''}`}>
              {formatMoney(availableAfter)}
            </span>
          </span>
        </div>

        <div className="dialog-body">
          {availableAfter < 0 && (
            <p className="budget-warning">
              That leaves Available {formatMoney(-availableAfter)} overdrawn — more allocated to envelopes
              than has actually arrived. You can apply it, and the home screen will keep saying so
              until income covers it.
            </p>
          )}

          {moves.bad.length > 0 && (
            <p className="budget-warning">
              {moves.bad.length === 1
                ? `The amount for ${moves.bad[0]} cannot be read, so it is not counted above.`
                : `${moves.bad.length} amounts cannot be read, so they are not counted above.`}
            </p>
          )}

          <div className="budget-table">
            <div className="budget-row fund head">
              <span>Envelope</span>
              <span>Planned</span>
              <span>Balance</span>
              <span>Add or set</span>
              <span>Moves</span>
            </div>

            {funding.lines.map((line) => {
              const moved = moves.byEnvelope.get(line.envelopeId) ?? 0;
              const mode = modeOf(line.envelopeId);
              return (
                <div key={line.envelopeId} className="budget-row fund">
                  <span className="plan-name">
                    <span className="muted">{line.groupName}</span> {line.name}
                  </span>

                  <span className="figure">
                    <span className="figure-label">planned</span>
                    <span className="money">{formatMoney(line.plannedCents)}</span>
                  </span>

                  <span className="figure">
                    <span className="figure-label">balance</span>
                    <span className={`money${line.balanceCents < 0 ? ' neg' : ''}`}>
                      {formatMoney(line.balanceCents)}
                    </span>
                  </span>

                  <span className="figure amount-entry">
                    {/* One narrow control that says which of two things the box
                        beside it means. A select sized itself to its widest
                        option and pushed the row off a phone. */}
                    <button
                      type="button"
                      className="mode-toggle"
                      aria-pressed={mode === 'target'}
                      aria-label={
                        mode === 'add'
                          ? `${line.name}: adding to the balance. Press to set the balance instead.`
                          : `${line.name}: setting the balance. Press to add to it instead.`
                      }
                      title={mode === 'add' ? 'Adding to the balance' : 'Setting the balance'}
                      disabled={pending}
                      onClick={() => toggleMode(line.envelopeId)}
                    >
                      {mode === 'add' ? 'add' : 'set'}
                    </button>
                    <input
                      className="amount"
                      inputMode="decimal"
                      aria-label={
                        mode === 'add'
                          ? `Amount to add to ${line.name}`
                          : `Balance to set ${line.name} to`
                      }
                      value={amounts[line.envelopeId] ?? ''}
                      disabled={pending}
                      onChange={(event) =>
                        setAmounts((current) => ({
                          ...current,
                          [line.envelopeId]: event.target.value,
                        }))
                      }
                    />
                  </span>

                  {/* What this row will actually do, which in target mode is not
                      the number typed into it. */}
                  <span className="figure">
                    <span className="figure-label">moves</span>
                    <span className={`money${moved < 0 ? ' neg' : moved > 0 ? ' pos' : ' muted'}`}>
                      {moved === 0 ? '–' : formatMoney(moved)}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {error && <p className="signin-error">{error}</p>}
        </div>

        <div className="picker-foot dialog-foot">
          <button className="primary" onClick={apply} disabled={pending || touched === 0}>
            {pending
              ? 'Moving…'
              : touched === 0
                ? 'Nothing to move'
                : `Apply to ${touched} envelope${touched === 1 ? '' : 's'}`}
          </button>
          <button onClick={onClose} disabled={pending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
