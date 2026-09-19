'use client';

/**
 * The budget screen (FR-27 to FR-31).
 *
 * The shape of the screen follows the shape of the requirement: a plan you edit
 * (FR-27), measured against the income there is to fund it (FR-31), with one
 * action that turns the plan into dated allocations after showing you exactly
 * what it will do (FR-29, FR-30).
 *
 * Every amount shown is computed on the server from cents. Nothing here does
 * arithmetic on money except to total up what is already in the preview, and even
 * that total is re-derived on the server before anything is written.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type {
  AllocationRecord,
  BudgetMonth,
  BudgetRow,
  FundingPlan,
} from '../../src/budget/budget.ts';
import { Money } from '../Money.tsx';
import { centsFromInput, inputFromCents } from '../amount.ts';
import {
  fundEnvelopesAction,
  reverseAllocationAction,
  reverseMonthFundingAction,
  setExpectedIncomeAction,
  setPlannedAction,
} from './actions.ts';

function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1]} ${Number(day)}`;
}

function warningText(warning: BudgetMonth['warnings'][number]): string {
  switch (warning.kind) {
    case 'planned_exceeds_income':
      return warning.basis === 'expected'
        ? `The plan asks for ${money(warning.plannedCents)}, more than the ${money(
            warning.incomeCents,
          )} you expect each month.`
        : `The plan asks for ${money(warning.plannedCents)}, and ${money(
            warning.incomeCents,
          )} has arrived so far.`;
    case 'income_unallocated':
      return `${money(warning.cents)} of income is still unallocated.`;
    case 'pool_overdrawn':
      return `Available is ${money(warning.cents)} overdrawn: more has been allocated than arrived.`;
  }
}

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

export default function BudgetScreen({
  budget,
  funding,
  allocations,
  label,
  previousMonth,
  nextMonth,
  thisMonth,
}: {
  budget: BudgetMonth;
  funding: FundingPlan;
  allocations: AllocationRecord[];
  label: string;
  previousMonth: string;
  nextMonth: string;
  thisMonth: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  /** The editable copy of the funding preview, keyed by envelope. */
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const openPreview = useCallback(() => {
    setAmounts(
      Object.fromEntries(
        funding.lines.map((line) => [line.envelopeId, inputFromCents(line.proposedCents)]),
      ),
    );
    setPreviewOpen(true);
    setError(null);
    setNote(null);
  }, [funding.lines]);

  const previewTotalCents = useMemo(() => {
    let total = 0;
    for (const line of funding.lines) {
      try {
        total += centsFromInput(amounts[line.envelopeId] ?? '0');
      } catch {
        // A half-typed amount is not worth an error while they are still typing;
        // the server refuses it if it is still nonsense at apply time.
      }
    }
    return total;
  }, [amounts, funding.lines]);

  const run = useCallback(
    (work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) => {
      setError(null);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNote(result.message ?? null);
        router.refresh();
      });
    },
    [router],
  );

  const savePlanned = useCallback(
    (row: BudgetRow, value: string) => {
      if (value.trim() === inputFromCents(row.plannedCents)) return;
      run(() => setPlannedAction(row.envelopeId, value));
    },
    [run],
  );

  const applyFunding = useCallback(() => {
    run(async () => {
      const result = await fundEnvelopesAction(
        budget.month,
        funding.lines.map((line) => ({
          envelopeId: line.envelopeId,
          amount: amounts[line.envelopeId] ?? '0',
        })),
      );
      if (result.ok) setPreviewOpen(false);
      return result;
    });
  }, [amounts, budget.month, funding.lines, run]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, BudgetRow[]>();
    for (const row of budget.rows) {
      if (row.isUnallocated) continue;
      const list = byGroup.get(row.groupName) ?? [];
      list.push(row);
      byGroup.set(row.groupName, list);
    }
    return [...byGroup.entries()];
  }, [budget.rows]);

  const leftToAllocate = budget.unallocated.balanceCents;

  return (
    <>
      <div className="page-head">
        <div className="month-head">
          <h2>Budget · {label}</h2>
          <div className="month-nav">
            <Link href={`/budget?month=${previousMonth}`}>← {previousMonth}</Link>
            {budget.month !== thisMonth && <Link href={`/budget?month=${thisMonth}`}>This month</Link>}
            <Link href={`/budget?month=${nextMonth}`}>{nextMonth} →</Link>
          </div>
        </div>
        <p className="muted">
          The plan is what each envelope should receive each month. Funding turns it into dated
          allocations out of Available, and every one of them can be sent back.
        </p>
      </div>

      <div className="callouts">
        <div className="callout">
          Planned <strong>{money(budget.plannedTotalCents)}</strong>
        </div>
        <div className="callout">
          Allocated this month <strong>{money(budget.allocatedTotalCents)}</strong>
        </div>
        <div className="callout">
          Income received <strong>{money(budget.incomeReceivedCents)}</strong>
        </div>
        <div className={`callout${leftToAllocate < 0 ? ' bad' : ''}`}>
          Available <strong>{money(leftToAllocate)}</strong>
        </div>
      </div>

      {budget.warnings.map((warning) => (
        <p
          key={warning.kind}
          className={`budget-warning${warning.kind === 'pool_overdrawn' ? ' bad' : ''}`}
        >
          {warningText(warning)}
        </p>
      ))}

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      <section className="panel">
        <h3>Expected income</h3>
        <div className="expected-income">
          <label className="field inline">
            <span>Each month</span>
            <input
              defaultValue={
                budget.expectedIncomeCents === null ? '' : inputFromCents(budget.expectedIncomeCents)
              }
              placeholder={
                budget.suggestedIncomeCents === null
                  ? 'e.g. 7250.00'
                  : inputFromCents(budget.suggestedIncomeCents)
              }
              inputMode="decimal"
              onBlur={(event) => run(() => setExpectedIncomeAction(event.target.value))}
            />
          </label>
          <p className="muted">
            {budget.expectedIncomeCents === null
              ? budget.suggestedIncomeCents === null
                ? 'Leave it blank and the plan is measured against income that has actually arrived.'
                : `The last three complete months averaged ${money(
                    budget.suggestedIncomeCents,
                  )}. Leave it blank to measure the plan against income as it arrives.`
              : 'The plan is measured against this. Clear the field to go back to income received.'}
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Fund envelopes</h3>
          {!previewOpen && (
            <button className="primary" onClick={openPreview} disabled={pending || funding.lines.length === 0}>
              Fund {money(funding.totalCents)}
            </button>
          )}
        </div>

        {funding.lines.length === 0 && (
          <p className="muted">
            No envelope has a planned amount yet. Set one below and funding will have something to
            move.
          </p>
        )}

        {!previewOpen && funding.lines.length > 0 && (
          <p className="muted">
            {funding.totalCents === 0
              ? 'Every envelope has already received its planned amount for this month.'
              : `Would move ${money(funding.totalCents)} out of Available, which holds ${money(
                  funding.availableCents,
                )}.`}
          </p>
        )}

        {previewOpen && (
          <>
            <p className="muted">
              Edit anything before applying. Each row proposes what is left of its plan for this
              month, so funding twice does not fill twice.
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
                  <span className="money">{money(line.plannedCents)}</span>
                  <span className="money">{money(line.alreadyAllocatedCents)}</span>
                  <span>
                    <input
                      className="amount"
                      inputMode="decimal"
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
                <span className="money">{money(previewTotalCents)}</span>
              </div>
            </div>
            {previewTotalCents > funding.availableCents && (
              <p className="budget-warning">
                That is {money(previewTotalCents - funding.availableCents)} more than Available
                holds. Applying it anyway leaves Available overdrawn, which the dashboard will say.
              </p>
            )}
            <div className="signin-actions">
              <button className="primary" onClick={applyFunding} disabled={pending}>
                {pending ? 'Moving…' : `Apply ${money(previewTotalCents)}`}
              </button>
              <button onClick={() => setPreviewOpen(false)} disabled={pending}>
                Cancel
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h3>The plan</h3>
        <div className="budget-table">
          <div className="budget-row head">
            <span>Envelope</span>
            <span>Planned</span>
            <span>Allocated</span>
            <span>Spent</span>
            <span>Balance</span>
          </div>
          {groups.map(([groupName, rows]) => (
            <div key={groupName}>
              <div className="budget-group">
                <span>{groupName}</span>
                <span className="money">
                  {money(rows.reduce((sum, row) => sum + row.plannedCents, 0))}
                </span>
              </div>
              {rows.map((row) => (
                <div key={row.envelopeId} className="budget-row">
                  <span>
                    <Link href={`/envelopes/${row.envelopeId}`}>{row.name}</Link>
                    {row.plannedIsOverride && (
                      <span className="tag" title={`Default is ${money(row.defaultPlannedCents)}`}>
                        this month only
                      </span>
                    )}
                  </span>
                  <span>
                    <input
                      className="amount"
                      inputMode="decimal"
                      defaultValue={inputFromCents(row.plannedCents)}
                      onBlur={(event) => savePlanned(row, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                    />
                  </span>
                  <span className="money">{money(row.allocatedCents)}</span>
                  <span className="money">{money(row.spentCents)}</span>
                  <span>
                    <Money cents={row.balanceCents} />
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className="budget-row total">
            <span>Total</span>
            <span className="money">{money(budget.plannedTotalCents)}</span>
            <span className="money">{money(budget.allocatedTotalCents)}</span>
            <span />
            <span />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>Allocations this month</h3>
          {allocations.length > 0 && (
            <button
              onClick={() => run(() => reverseMonthFundingAction(budget.month))}
              disabled={pending}
            >
              Send it all back
            </button>
          )}
        </div>
        {allocations.length === 0 && (
          <p className="muted">Nothing has been allocated for {label} yet.</p>
        )}
        {allocations.map((record) => (
          <div key={record.id} className="row">
            <span>
              <span className="muted">{shortDate(record.date)}</span> {record.envelopeName}
              {record.isReversal && <span className="tag">sent back</span>}
            </span>
            <span className="allocation-actions">
              <Money cents={record.isReversal ? -record.amountCents : record.amountCents} />
              {!record.isReversal && (
                <button
                  onClick={() => run(() => reverseAllocationAction(record.id, budget.month))}
                  disabled={pending}
                >
                  Undo
                </button>
              )}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
