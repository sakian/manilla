'use client';

/**
 * The standing rules, visible, editable and removable (CA-2).
 *
 * Until now a rule could only be created - from a correction in the review queue
 * - and never seen again. A rule that silently redirects money is exactly the
 * thing that should be inspectable, and a transfer rule redirects it hardest: it
 * decides a transaction is not spending at all.
 *
 * Editing matters for the same reason: a rule suggested from "DUNBAR DENTAL" may
 * be better as "DENTAL", and the only way to say so used to be forgetting it and
 * waiting to be asked again.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { ListedRule } from '../../src/rules/rules.ts';
import { centsFromInput, inputFromCents } from '../amount.ts';
import { deleteRuleAction, undismissRuleAction, updateRuleAction } from './actions.ts';

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

/** A blank box is no limit, which is not the same as a limit of zero. */
function limitFromInput(text: string): number | null {
  return text.trim() === '' ? null : Math.abs(centsFromInput(text));
}

type Draft = { contains: string; targetId: string; min: string; max: string };

function draftOf(rule: ListedRule): Draft {
  return {
    contains: rule.contains,
    targetId: rule.outcome.kind === 'envelope' ? rule.outcome.envelopeId : rule.outcome.accountId,
    min: rule.minCents === null ? '' : inputFromCents(rule.minCents),
    max: rule.maxCents === null ? '' : inputFromCents(rule.maxCents),
  };
}

export default function Rules({
  rules,
  declined,
  envelopes,
  accounts,
}: {
  rules: ListedRule[];
  /** Payees you said no to, by the key they would match on. */
  declined: string[];
  envelopes: { id: string; name: string; groupName: string }[];
  accounts: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: Draft } | null>(null);

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

  const save = useCallback(() => {
    if (!editing) return;
    setError(null);
    let minCents: number | null;
    let maxCents: number | null;
    try {
      minCents = limitFromInput(editing.draft.min);
      maxCents = limitFromInput(editing.draft.max);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return;
    }
    startTransition(async () => {
      const result = await updateRuleAction(editing.id, {
        contains: editing.draft.contains,
        targetId: editing.draft.targetId,
        minCents,
        maxCents,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(null);
      router.refresh();
    });
  }, [editing, router]);

  const askAgain = useCallback(
    (contains: string) => {
      setError(null);
      startTransition(async () => {
        const result = await undismissRuleAction(contains);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  const change = (patch: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

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

      {rules.map((rule) =>
        editing?.id === rule.id ? (
          <div key={rule.id} className="rule-edit">
            <label className="field">
              <span>Payee contains</span>
              <input
                value={editing.draft.contains}
                onChange={(event) => change({ contains: event.target.value })}
              />
            </label>
            <label className="field">
              <span>{rule.outcome.kind === 'envelope' ? 'Envelope' : 'Transfer to'}</span>
              <select
                value={editing.draft.targetId}
                onChange={(event) => change({ targetId: event.target.value })}
              >
                {rule.outcome.kind === 'envelope'
                  ? envelopes.map((envelope) => (
                      <option key={envelope.id} value={envelope.id}>
                        {envelope.groupName} · {envelope.name}
                      </option>
                    ))
                  : accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
              </select>
            </label>
            <label className="field">
              <span>Only from</span>
              <input
                className="amount"
                inputMode="decimal"
                placeholder="any"
                value={editing.draft.min}
                onChange={(event) => change({ min: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Up to</span>
              <input
                className="amount"
                inputMode="decimal"
                placeholder="any"
                value={editing.draft.max}
                onChange={(event) => change({ max: event.target.value })}
              />
            </label>
            <div className="signin-actions">
              <button className="primary" onClick={save} disabled={pending}>
                {pending ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
                disabled={pending}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
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
            <span className="allocation-actions">
              <button
                onClick={() => {
                  setError(null);
                  setEditing({ id: rule.id, draft: draftOf(rule) });
                }}
                disabled={pending}
              >
                Edit
              </button>
              <button onClick={() => remove(rule)} disabled={pending}>
                Forget
              </button>
            </span>
          </div>
        ),
      )}

      {rules.length > 0 && (
        <p className="muted footnote">
          A rule matches any payee containing its text, in capitals or not - &ldquo;DENTAL&rdquo;
          catches &ldquo;Dunbar Dental&rdquo;. Rules are the first thing consulted for a new
          transaction, before history and before the model, and the first that matches wins.
          Changing or forgetting one changes nothing already recorded.
        </p>
      )}

      {declined.length > 0 && (
        <details className="declined">
          <summary className="muted">
            {declined.length} suggestion{declined.length === 1 ? '' : 's'} you said no to
          </summary>
          <p className="muted">
            These are never suggested again unless you ask. Asking again puts one back in the list
            the next time it qualifies.
          </p>
          {declined.map((contains) => (
            <div key={contains} className="row">
              <code>{contains}</code>
              <span className="allocation-actions">
                <button onClick={() => askAgain(contains)} disabled={pending}>
                  Ask again
                </button>
              </span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
