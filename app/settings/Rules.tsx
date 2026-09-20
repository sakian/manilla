'use client';

/**
 * The standing rules, visible and removable (CA-2).
 *
 * Until now a rule could only be created - from a correction in the review queue
 * - and never seen again. A rule that silently redirects money is exactly the
 * thing that should be inspectable, and a transfer rule redirects it hardest: it
 * decides a transaction is not spending at all.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ListedRule } from '../../src/rules/rules.ts';
import { deleteRuleAction } from './actions.ts';

function money(cents: number): string {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function conditions(rule: ListedRule): string {
  const parts: string[] = [];
  if (rule.onlyAccountName) parts.push(`on ${rule.onlyAccountName}`);
  if (rule.minCents !== null && rule.maxCents !== null) {
    parts.push(`between ${money(rule.minCents)} and ${money(rule.maxCents)}`);
  } else if (rule.minCents !== null) {
    parts.push(`over ${money(rule.minCents)}`);
  } else if (rule.maxCents !== null) {
    parts.push(`under ${money(rule.maxCents)}`);
  }
  return parts.join(', ');
}

export default function Rules({ rules }: { rules: ListedRule[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = useCallback(
    (rule: ListedRule) => {
      if (!window.confirm(`Forget the rule for "${rule.contains}"?`)) return;
      startTransition(async () => {
        const result = await deleteRuleAction(rule.id);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  return (
    <section className="panel">
      <h3>Rules</h3>
      {error && <p className="signin-error">{error}</p>}

      {rules.length === 0 && (
        <p className="muted">
          None yet. They are made in the review queue: correct a suggestion and tick &ldquo;always
          use this envelope&rdquo;, or mark something as a transfer and tick &ldquo;always treat it
          as one&rdquo;.
        </p>
      )}

      {rules.map((rule) => (
        <div key={rule.id} className="row">
          <span>
            <code>{rule.contains}</code>
            <span className="muted">
              {' → '}
              {rule.outcome.kind === 'envelope'
                ? rule.outcome.name
                : `transfer to ${rule.outcome.name}`}
              {conditions(rule) && ` · ${conditions(rule)}`}
            </span>
            {rule.outcome.kind === 'transfer' && <span className="tag">not spending</span>}
          </span>
          <button onClick={() => remove(rule)} disabled={pending}>
            Forget
          </button>
        </div>
      ))}

      {rules.length > 0 && (
        <p className="muted footnote">
          Rules are the first thing consulted for a new transaction, before history and before the
          model. Forgetting one changes nothing that has already been recorded.
        </p>
      )}
    </section>
  );
}
