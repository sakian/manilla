'use client';

/**
 * Putting Notes conversations away (RQ-7). Without it the list only grew, and
 * a list where the new reply sits among every old one is a list nobody reads.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { clearConversationsAction } from '../../actions.ts';

export function ClearNotes({ transactionIds, label }: { transactionIds: string[] | 'all'; label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await clearConversationsAction(transactionIds);
          router.refresh();
        })
      }
    >
      {label}
    </button>
  );
}
