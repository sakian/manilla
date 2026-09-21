'use client';

/**
 * Rules Manilla noticed, and is asking about (CA-2).
 *
 * Nothing here is written until it is accepted. A rule fires before the history
 * layer looks at anything, so one written on your behalf would keep being wrong
 * where history would have drifted towards the truth - which is why the app
 * learns without them and only ever asks.
 *
 * Declining sticks. A shop you deliberately sort two ways will go on looking like
 * a rule for ever, and being asked about it every month is worse than not being
 * asked at all.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SuggestedRule } from '../../src/rules/rules.ts';
import { acceptRuleAction, dismissRuleAction } from './actions.ts';

export default function RuleSuggestions({
  suggestions,
  total,
  capped,
}: {
  suggestions: SuggestedRule[];
  /** Every suggestion waiting, of which `suggestions` is the first page. */
  total: number;
  /** The total stops counting at a ceiling, so it may be more. */
  capped: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Hidden the moment they are answered, so the list shortens as you go. */
  const [answered, setAnswered] = useState<string[]>([]);

  const run = useCallback(
    (contains: string, work: () => Promise<{ ok: boolean; error?: string }>) => {
      setError(null);
      setAnswered((current) => [...current, contains]);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error ?? 'That did not work.');
          setAnswered((current) => current.filter((item) => item !== contains));
          return;
        }
        router.refresh();
      });
    },
    [router],
  );

  const left = suggestions.filter((rule) => !answered.includes(rule.contains));
  if (left.length === 0) return null;
  // Answers hidden here but not yet refreshed are still in the stored total.
  const waiting = Math.max(total - (suggestions.length - left.length), left.length);

  return (
    <section className="panel" id="rules">
      <div className="panel-head">
        <h3>Rules Manilla could write</h3>
        {/* The list is the top twenty, and answering one brings the next up from
            below - which looks like a glitch unless the screen says more are
            waiting. */}
        <span className="muted">
          {waiting > left.length
            ? `${left.length} shown of ${waiting}${capped ? '+' : ''} noticed`
            : `${left.length} noticed`}
        </span>
      </div>

      <p className="muted">
        Each of these is a payee you have sorted the same way every time. A rule would do it for
        you from now on. Nothing is written unless you say so.
      </p>

      {error && <p className="signin-error">{error}</p>}

      {left.map((rule) => (
        <div key={rule.contains} className="rule-suggestion">
          <span className="rule-says">
            <strong>{rule.display}</strong> → {rule.envelopeName}
            <span className="muted"> · {rule.uses} times, always</span>
          </span>
          <span className="allocation-actions">
            <button
              className="primary"
              disabled={pending}
              onClick={() => run(rule.contains, () => acceptRuleAction(rule.contains, rule.envelopeId))}
            >
              Add it
            </button>
            <button
              disabled={pending}
              onClick={() => run(rule.contains, () => dismissRuleAction(rule.contains))}
            >
              No
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
