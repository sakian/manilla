'use client';

/**
 * The budget screen (FR-27, FR-31, FR-32).
 *
 * One question: what should each envelope get each month, and is that a number
 * the household can actually stand behind? So the plan sits next to what the
 * envelope actually cost - last month, and averaged over a year - because a
 * planned figure with no history beside it is a guess, and the history is what
 * turns it into a decision.
 *
 * Funding moved to the home screen, where the envelopes being filled are on
 * screen. Allocations moved out too: an envelope's own page already lists every
 * move into and out of it, and a second list of the same records here was one
 * more place for them to disagree.
 *
 * Expected income is shown, not typed. Six months of real deposits answers "what
 * do you earn a month" better than a figure anyone would sit down and enter, and
 * it cannot go stale.
 *
 * Every figure carries its label on every row, not only in a header. On a phone
 * the header row is off screen by the time you have scrolled to Groceries, and a
 * column of unlabelled money is unreadable.
 */

import { useCallback, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { BudgetMonth, BudgetRow } from '../../src/budget/budget.ts';
import { Money } from '../Money.tsx';
import { inputFromCents } from '../amount.ts';
import { setPlannedAction } from './actions.ts';

function warningText(warning: BudgetMonth['warnings'][number]): string {
  switch (warning.kind) {
    case 'planned_exceeds_income': {
      const asked = money(warning.plannedCents);
      const income = money(warning.incomeCents);
      if (warning.basis === 'expected') {
        return `The plan asks for ${asked}, more than the ${income} you expect each month.`;
      }
      if (warning.basis === 'average') {
        return `The plan asks for ${asked} a month, and the last six months averaged ${income}.`;
      }
      return `The plan asks for ${asked}, and ${income} has arrived so far.`;
    }
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
  label,
  previousMonth,
  previousLabel,
  nextMonth,
  thisMonth,
}: {
  budget: BudgetMonth;
  label: string;
  previousMonth: string;
  /** Named rather than numbered, so "spent in Aug 26" reads as a month. */
  previousLabel: string;
  nextMonth: string;
  thisMonth: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (work: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>) => {
      setError(null);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    },
    [router],
  );

  const savePlanned = useCallback(
    (row: BudgetRow, value: string) => {
      // Blurring a field nobody touched should not be a write and a refresh.
      if (value.trim() === inputFromCents(row.plannedCents)) return;
      run(() => setPlannedAction(row.envelopeId, value));
    },
    [run],
  );

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

  const averageTotalCents = budget.rows
    .filter((row) => !row.isUnallocated)
    .reduce((sum, row) => sum + row.averageSpentCents, 0);

  return (
    <>
      <div className="page-head">
        <div className="month-head">
          <h2>Budget · {label}</h2>
          <div className="month-nav">
            <Link href={`/budget?month=${previousMonth}`}>← {previousMonth}</Link>
            {budget.month !== thisMonth && (
              <Link href={`/budget?month=${thisMonth}`}>This month</Link>
            )}
            <Link href={`/budget?month=${nextMonth}`}>{nextMonth} →</Link>
          </div>
        </div>
        <p className="muted">
          What each envelope should receive each month, next to what it actually cost. Filling the
          envelopes happens on the <Link href="/">home screen</Link>.
        </p>
      </div>

      <div className="callouts">
        <div className="callout">
          Planned <strong>{money(budget.plannedTotalCents)}</strong>
        </div>
        <div className="callout">
          Usually spent <strong>{money(averageTotalCents)}</strong>
        </div>
        <div className="callout">
          {budget.suggestedIncomeCents === null ? (
            <>
              Income this month <strong>{money(budget.incomeReceivedCents)}</strong>
            </>
          ) : (
            <>
              Income a month <strong>{money(budget.suggestedIncomeCents)}</strong>
            </>
          )}
        </div>
        <div className={`callout${budget.unallocated.balanceCents < 0 ? ' bad' : ''}`}>
          Available <strong>{money(budget.unallocated.balanceCents)}</strong>
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

      <section className="panel">
        <div className="budget-table">
          {/* The header names the columns on a wide screen; every cell also
              carries its own label, which is what a phone actually shows. */}
          <div className="budget-row plan head">
            <span>Envelope</span>
            <span>Planned</span>
            <span>Avg/mo</span>
            <span>{previousLabel}</span>
            <span>This month</span>
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
                <div key={row.envelopeId} className="budget-row plan">
                  <span className="plan-name">
                    <Link href={`/envelopes/${row.envelopeId}`}>{row.name}</Link>
                    {row.plannedIsOverride && (
                      <span className="tag" title={`Default is ${money(row.defaultPlannedCents)}`}>
                        this month only
                      </span>
                    )}
                  </span>
                  <span className="figure">
                    <span className="figure-label">planned</span>
                    <input
                      className="amount"
                      inputMode="decimal"
                      aria-label={`Planned each month for ${row.name}`}
                      defaultValue={inputFromCents(row.plannedCents)}
                      onBlur={(event) => savePlanned(row, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                      }}
                      disabled={pending}
                    />
                  </span>
                  <span className="figure">
                    <span className="figure-label">avg/mo</span>
                    <span className="money">{money(row.averageSpentCents)}</span>
                  </span>
                  <span className="figure">
                    <span className="figure-label">{previousLabel}</span>
                    <span className="money">{money(row.lastMonthSpentCents)}</span>
                  </span>
                  <span className="figure">
                    <span className="figure-label">this month</span>
                    <span className="money">{money(row.spentCents)}</span>
                  </span>
                  <span className="figure">
                    <span className="figure-label">balance</span>
                    <Money cents={row.balanceCents} />
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className="budget-row plan total">
            <span>Total</span>
            <span className="figure">
              <span className="figure-label">planned</span>
              <span className="money">{money(budget.plannedTotalCents)}</span>
            </span>
            <span className="figure">
              <span className="figure-label">avg/mo</span>
              <span className="money">{money(averageTotalCents)}</span>
            </span>
            <span />
            <span />
            <span />
          </div>
        </div>

        <p className="muted footnote">
          Avg/mo is this envelope&rsquo;s spending over the twelve months before {label}, divided by
          twelve — so a bill that arrives once a year still shows what it costs a month. An envelope
          younger than a year reads low, because there is not a year of it to average.
        </p>
      </section>
    </>
  );
}
