'use client';

/**
 * Which view your review list opens on (RQ-7).
 *
 * The one setting that makes someone a first or a second reviewer: whoever
 * goes through everything opens on All, and whoever only looks at what is left
 * for them opens on For me. Theirs alone, and the same in every ledger.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setReviewOpensOnAction } from './actions.ts';

const CHOICES = [
  ['all', 'Everything waiting'],
  ['mine', 'Handed to me'],
] as const;

export default function ReviewPanel({ current }: { current: 'all' | 'mine' }) {
  const router = useRouter();
  const [choice, setChoice] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const choose = (next: 'all' | 'mine') => {
    const was = choice;
    setChoice(next);
    setError(null);
    startTransition(async () => {
      const result = await setReviewOpensOnAction(next);
      if (!result.ok) {
        setChoice(was);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="panel">
      <h3>Review</h3>
      <p className="muted">
        What your review list shows when you open it. Choose Handed to me if you only look at what
        someone else leaves for you. You can switch to the other view on the list at any time.
      </p>
      <div className="segmented theme-choice" role="group" aria-label="Review list opens on">
        {CHOICES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={choice === value ? 'active' : ''}
            aria-pressed={choice === value}
            disabled={pending}
            onClick={() => choose(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="signin-error">{error}</p>}
    </section>
  );
}
