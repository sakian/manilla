'use client';

/**
 * The AI layer's controls (NF-5, section 5).
 *
 * Everything the requirements ask to be visible is visible here: whether it is
 * on, exactly what gets sent, what it has cost this month, how much budget is
 * left, and whether its suggestions are any good. An AI feature whose cost and
 * accuracy are invisible is one you can only trust or distrust, never judge.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { AccuracyReport, AiUsageReport } from '../../src/ai/ai.ts';
import { clearAiCacheAction, setAiSettingsAction } from './actions.ts';

function dollars(milliCents: number): string {
  return `$${(milliCents / 100_000).toFixed(2)}`;
}

function percent(rate: number | null): string {
  return rate === null ? '–' : `${Math.round(rate * 100)}%`;
}

export default function AiPanel({
  enabled,
  budget,
  usage,
  accuracy,
  unknownMerchants,
  keyPresent,
}: {
  enabled: boolean;
  budget: number;
  usage: AiUsageReport;
  accuracy: AccuracyReport;
  unknownMerchants: number;
  keyPresent: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState(String(budget));

  const save = useCallback(
    (update: { enabled?: boolean; monthlyCallBudget?: number }) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const result = await setAiSettingsAction(update);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    },
    [router],
  );

  const clearCache = useCallback(() => {
    if (!window.confirm('Forget what the model has said, so it is asked again?')) return;
    startTransition(async () => {
      const result = await clearAiCacheAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNote(`Forgot ${result.removed} merchants.`);
      router.refresh();
    });
  }, [router]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Categorizing with AI</h3>
        <button
          className={enabled ? '' : 'primary'}
          onClick={() => save({ enabled: !enabled })}
          disabled={pending || (!enabled && !keyPresent)}
        >
          {enabled ? 'Turn it off' : 'Turn it on'}
        </button>
      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {!keyPresent && (
        <p className="budget-warning">
          No <code>ANTHROPIC_API_KEY</code> is set, so there is nothing to turn on. Add one to
          <code>.env</code> and restart.
        </p>
      )}

      <p className="muted">
        {enabled
          ? 'On. The model is asked only about merchants your own history cannot place, after rules and history have had their turn.'
          : 'Off. Rules and history still categorize everything they can; Phase 0 measured that at 62.8% accepted unchanged on its own.'}
      </p>

      <details className="disclosure">
        <summary className="muted">Exactly what is sent</summary>
        <ul>
          <li>The merchant name as your bank wrote it, tidied up</li>
          <li>The amount and the date</li>
          <li>Your envelope names, and a few merchants each already contains</li>
        </ul>
        <p className="muted">
          Never an account number, a balance, a person&rsquo;s name, or anything about you. One
          question per merchant, not per transaction, and the answer is kept so the same merchant is
          never asked about twice.
        </p>
      </details>

      <div className="row">
        <span>This month</span>
        <span className="muted">
          {usage.calls} {usage.calls === 1 ? 'call' : 'calls'} · {usage.transactions} merchants ·{' '}
          {dollars(usage.costMilliCents)}
          {usage.failedCalls > 0 && ` · ${usage.failedCalls} failed`}
        </span>
      </div>

      <div className="row">
        <span>Budget</span>
        <span className="allocation-actions">
          <input
            className="amount"
            inputMode="numeric"
            value={budgetInput}
            onChange={(event) => setBudgetInput(event.target.value)}
            onBlur={() => {
              const next = Number(budgetInput);
              if (Number.isSafeInteger(next) && next >= 0 && next !== budget) {
                save({ monthlyCallBudget: next });
              }
            }}
          />
          <span className="muted">calls a month · {usage.remaining} left</span>
        </span>
      </div>

      <div className="row">
        <span>Merchants already answered for</span>
        <span className="allocation-actions">
          <span className="muted">{usage.cachedMerchants}</span>
          {usage.cachedMerchants > 0 && (
            <button onClick={clearCache} disabled={pending}>
              Forget them
            </button>
          )}
        </span>
      </div>

      <div className="row">
        <span>Waiting merchants it has not seen</span>
        <span className="muted">
          {unknownMerchants} — about {Math.ceil(unknownMerchants / 25)}{' '}
          {Math.ceil(unknownMerchants / 25) === 1 ? 'call' : 'calls'} if you import now
        </span>
      </div>

      <h3>Are the suggestions any good?</h3>
      {accuracy.overall.decided === 0 ? (
        <p className="muted">
          Nothing confirmed yet. This fills in as you work through the review queue: it compares
          what was suggested against what you kept.
        </p>
      ) : (
        <>
          <div className="budget-table">
            <div className="budget-row report head">
              <span>Layer</span>
              <span>Accepted unchanged</span>
              <span>Of</span>
              <span />
            </div>
            {accuracy.layers.map((layer) => (
              <div key={layer.layer} className="budget-row report">
                <span>{layer.layer}</span>
                <span className="money">{percent(layer.rate)}</span>
                <span className="muted">{layer.decided}</span>
                <span />
              </div>
            ))}
            <div className="budget-row report total">
              <span>All layers</span>
              <span className="money">{percent(accuracy.overall.rate)}</span>
              <span className="muted">{accuracy.overall.decided}</span>
              <span />
            </div>
          </div>

          <p className="muted footnote">
            Phase 0 measured 62.8% from history alone and 72.4% with the model, on three held-out
            months of your real history. The auto-confirm band (0.95 and above) came out at 98.6%
            precision; here it is {percent(accuracy.highBandPrecision)} over{' '}
            {accuracy.highBandDecided} confirmed.
          </p>
        </>
      )}
    </section>
  );
}
