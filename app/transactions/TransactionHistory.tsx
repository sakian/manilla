'use client';

import { useCallback, useState } from 'react';
import { transactionHistoryAction, type HistoryView } from './actions.ts';

/**
 * What has been changed on this transaction, and by whom (NF-2). Closed until
 * asked for, and only then fetched: most transactions are never changed, and
 * nobody opening one to fix a payee wants the trail in the way.
 */
export default function TransactionHistory({ transactionId }: { transactionId: string }) {
  const [history, setHistory] = useState<HistoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      if (!event.currentTarget.open || history) return;
      transactionHistoryAction(transactionId).then((result) => {
        if (result.ok) setHistory(result.history);
        else setError(result.error);
      });
    },
    [history, transactionId],
  );

  return (
    <details className="history" onToggle={load}>
      <summary>History</summary>
      {error && <p className="signin-error">{error}</p>}
      {!history && !error && <p className="muted">Looking…</p>}
      {history && history.length === 0 && (
        <p className="muted">Not changed since it was recorded.</p>
      )}
      {history && history.length > 0 && (
        <ol>
          {history.map((entry) => (
            <li key={entry.key}>
              <span className="muted">
                {entry.when} · {entry.who ?? 'not recorded who'}
              </span>
              <span>{entry.changes.join('; ')}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
