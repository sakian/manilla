'use client';

/**
 * Making migrated balances match the old app's (MG-7).
 *
 * Shown at the end of the wizard, where the income pool is at its largest and
 * least explained, and on a page of its own so it can be finished later, once
 * the old app's figures have been looked up.
 *
 * The differences on screen are worked out here so they can be read as they are
 * typed, but they are not what gets written: the figures go to the server, which
 * works the differences out again from the balances it holds at that moment.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { centsFromInput, inputFromCents } from '../../src/amount.ts';
import { Money } from '../Money.tsx';
import { displayDate } from '../../src/budget/month.ts';
import { applyReconciliationAction } from './actions.ts';

export type ReconcileData = {
  /** The last day the export covers: balances are compared as of it. */
  asOf: string;
  envelopes: { id: string; name: string; groupName: string; computedCents: number }[];
  accounts: { id: string; name: string; computedCents: number }[];
};

/** What was typed as cents, or null for blank, or undefined when it is not an amount. */
function typedCents(text: string | undefined): number | null | undefined {
  if (text === undefined || text.trim() === '') return null;
  try {
    return centsFromInput(text);
  } catch {
    return undefined;
  }
}

export function ReconcileBalances({ data, fills }: { data: ReconcileData; fills?: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expected, setExpected] = useState<Record<string, string>>({});
  const [reconciled, setReconciled] = useState<number | null>(null);

  const apply = useCallback(() => {
    setError(null);
    const figures: Record<string, number> = {};
    for (const envelope of data.envelopes) {
      const typed = expected[envelope.id];
      if (typed === undefined || typed.trim() === '') continue;
      try {
        figures[envelope.id] = centsFromInput(typed);
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : `"${typed}" is not an amount`);
        return;
      }
    }

    startTransition(async () => {
      const applied = await applyReconciliationAction(figures);
      if (!applied.ok) {
        setError(applied.error);
        return;
      }
      setReconciled(applied.written);
      // The envelopes now match, so their figures have done their job; what was
      // typed against the accounts is still being read.
      setExpected((current) => {
        const kept = { ...current };
        for (const envelope of data.envelopes) delete kept[envelope.id];
        return kept;
      });
      router.refresh();
    });
  }, [data.envelopes, expected, router]);

  const field = (id: string, computedCents: number, label: string) => {
    const cents = typedCents(expected[id]);
    return (
      <>
        <input
          className="amount"
          inputMode="decimal"
          aria-label={`What your old app shows for ${label}`}
          placeholder={inputFromCents(computedCents)}
          value={expected[id] ?? ''}
          onChange={(event) => setExpected((current) => ({ ...current, [id]: event.target.value }))}
        />
        <span className="reconcile-diff">
          {cents === undefined ? (
            <span className="neg">?</span>
          ) : cents === null ? null : cents === computedCents ? (
            <span className="muted">matches</span>
          ) : (
            <Money cents={cents - computedCents} copy={false} />
          )}
        </span>
      </>
    );
  };

  const date = displayDate(data.asOf);

  return (
    <>
      <section className="panel">
        <h3>Reconcile the envelopes (MG-7)</h3>
        <p className="muted">
          {fills
            ? 'Envelopes whose fills came across should already match your old app. Any other '
            : 'Every '}
          envelope is short by whatever was filled into it over the years, because the full export
          does not record that. Type what your old app showed for each one on {date}, the last day
          in the export, and the difference is written as an adjustment out of the income pool on
          that day — visible in the envelope&rsquo;s history, not a number from nowhere. Leave one
          blank to skip it.
        </p>

        {error && <p className="signin-error">{error}</p>}
        {reconciled !== null && (
          <p className="queue-note">
            {reconciled === 0
              ? 'Nothing needed adjusting.'
              : `${reconciled} ${reconciled === 1 ? 'envelope' : 'envelopes'} adjusted.`}{' '}
            Envelopes and accounts should still agree, and the income pool holds whatever is left
            over.
          </p>
        )}

        <div className="map-table">
          <div className="map-row reconcile map-head">
            <span>Envelope · here on {date}</span>
            <span>Old app</span>
            <span className="reconcile-diff">Difference</span>
          </div>
          {data.envelopes.map((envelope) => (
            <div key={envelope.id} className="map-row reconcile">
              <span className="map-name">
                <span className="muted">{envelope.groupName}</span> {envelope.name}
                <span className="reconcile-here">
                  <span className="muted"> · </span>
                  <Money cents={envelope.computedCents} copy={false} />
                </span>
              </span>
              {field(envelope.id, envelope.computedCents, envelope.name)}
            </div>
          ))}
        </div>
        <div className="signin-actions">
          <button className="primary" onClick={apply} disabled={pending}>
            {pending ? 'Adjusting…' : 'Make the balances match'}
          </button>
        </div>
      </section>

      {data.accounts.length > 0 && (
        <section className="panel">
          <h3>Check the accounts</h3>
          <p className="muted">
            Accounts rebuild exactly from the export, so these should match what your old app
            showed on {date}. Nothing is written here: an account that differs is missing
            transactions, and the fix is to bring them in rather than cover the gap.
          </p>
          <div className="map-table">
            <div className="map-row reconcile map-head">
              <span>Account · here on {date}</span>
              <span>Old app</span>
              <span className="reconcile-diff">Difference</span>
            </div>
            {data.accounts.map((account) => (
              <div key={account.id} className="map-row reconcile">
                <span className="map-name">
                  {account.name}
                  <span className="reconcile-here">
                    <span className="muted"> · </span>
                    <Money cents={account.computedCents} copy={false} />
                  </span>
                </span>
                {field(account.id, account.computedCents, account.name)}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
