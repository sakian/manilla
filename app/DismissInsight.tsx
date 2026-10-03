'use client';

/**
 * "That was expected" on an unusual-charge notice (AI-6, in part). A notice that
 * cannot be put away stops being read, and these are the one kind of notice
 * that is about a single charge rather than a state of the books.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { dismissInsightAction } from './actions.ts';

export function DismissInsight({ transactionId, payee }: { transactionId: string; payee: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="notice-action"
      disabled={pending}
      aria-label={`The charge from ${payee} was expected; stop mentioning it`}
      onClick={() =>
        startTransition(async () => {
          await dismissInsightAction(transactionId);
          router.refresh();
        })
      }
    >
      Expected
    </button>
  );
}
