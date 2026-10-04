'use client';

/**
 * Sync, from any screen (FR-16): every bank connected to the open ledger, in
 * one press. Shown only once a bank is connected.
 *
 * The button is its own report - Syncing…, then a word or two about what came
 * - because the topbar has no room for more, and the screen under it refreshes
 * with the rest: the count to review, what was held, the lists.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { syncAllAction } from './settings/bankActions.ts';

/** How long the result stays on the button before it is a button again. */
const SHOW_RESULT_MS = 6000;

export function SyncButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ label: string; detail: string; settings?: boolean } | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), SHOW_RESULT_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const sync = useCallback(() => {
    setResult(null);
    startTransition(async () => {
      const outcome = await syncAllAction();
      if (!outcome.ok) {
        setResult({ label: 'Sync failed', detail: outcome.error, settings: true });
      } else if (outcome.loginNeeded) {
        setResult({ label: 'Sign in needed', detail: 'The bank wants you to sign in again', settings: true });
      } else if (outcome.stopped) {
        setResult({ label: 'Sync failed', detail: 'Settings → Bank feeds says why', settings: true });
      } else {
        const parts = [
          outcome.added > 0 ? `${outcome.added} new` : '',
          outcome.held > 0 ? `${outcome.held} held` : '',
        ].filter(Boolean);
        const label =
          parts.length > 0 ? parts.join(', ') : outcome.notReady > 0 ? 'Not ready yet' : 'Nothing new';
        const detail =
          outcome.notReady > 0
            ? 'Plaid is still gathering the bank’s transactions; try again in a few minutes'
            : `${outcome.added} added for review${outcome.held > 0 ? `, ${outcome.held} held on the import screen` : ''}`;
        setResult({ label, detail });
      }
      router.refresh();
    });
  }, [router]);

  if (result?.settings) {
    return (
      <Link href="/settings/ledgers#bank-feeds" className="button-link sync-button" title={result.detail} role="status">
        {result.label}
      </Link>
    );
  }

  return (
    <button
      type="button"
      className="button-link sync-button"
      onClick={sync}
      disabled={pending}
      title={result?.detail ?? 'Bring in what your bank has posted'}
      aria-live="polite"
    >
      {pending ? 'Syncing…' : (result?.label ?? 'Sync')}
    </button>
  );
}
