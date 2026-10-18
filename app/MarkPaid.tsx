'use client';

/**
 * "Paid" on a card payment notice (FR-38), for a payment made at the bank that
 * has not come through to the ledger yet. It covers this statement only.
 */

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { markPaymentMadeAction } from './accounts/actions.ts';

export function MarkPaid({ accountId, name }: { accountId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="notice-action"
      disabled={pending}
      aria-label={`${name} is paid for this statement; stop reminding`}
      onClick={() =>
        startTransition(async () => {
          await markPaymentMadeAction(accountId, true);
          router.refresh();
        })
      }
    >
      Paid
    </button>
  );
}
