'use client';

/**
 * Taking your data out, and clearing it (NF-6).
 *
 * The exports are plain links, because a download is a navigation and the server
 * sets the filename. The erase is deliberately the opposite of convenient: it is
 * behind a disclosure, it asks for a phrase to be typed, and it says exactly what
 * survives.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { eraseEverythingAction } from './actions.ts';

const CSV_TABLES: { table: string; label: string }[] = [
  { table: 'transactions', label: 'Transactions' },
  { table: 'envelopes', label: 'Envelopes' },
  { table: 'accounts', label: 'Accounts' },
  { table: 'moves', label: 'Envelope moves' },
  { table: 'budget', label: 'Budget' },
  { table: 'rules', label: 'Rules' },
];

const PHRASE = 'erase everything';

export default function DataPanel({ counts }: { counts: { transactions: number; envelopes: number } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const erase = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const result = await eraseEverythingAction(typed);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone(`Removed ${result.removed.transactions} transactions. Your passkeys are untouched.`);
      setTyped('');
      router.refresh();
    });
  }, [router, typed]);

  return (
    <section className="panel">
      <h3>Your data</h3>
      <p className="muted">
        {counts.transactions.toLocaleString()} transaction{counts.transactions === 1 ? '' : 's'}{' '}
        across {counts.envelopes} envelope{counts.envelopes === 1 ? '' : 's'}. Everything here is
        yours to take at any time; nothing is locked in (NF-6).
      </p>

      {/* Each explanation sits above the buttons it is about. It used to be one
          footnote under the JSON button, pulled up into it by .footnote's
          negative margin and reading as a caption for the CSVs below (#19). */}
      <p className="muted">
        As JSON, which keeps the structure - each transaction with its envelope shares and the bank
        ids it has collected:
      </p>

      <div className="export-links">
        <a className="button-link" href="/api/export?format=json" download>
          Download everything as JSON
        </a>
      </div>

      <p className="muted">Or as CSVs, flat and one file per thing, for a spreadsheet:</p>

      <div className="export-links">
        {CSV_TABLES.map((item) => (
          <a
            key={item.table}
            className="button-link"
            href={`/api/export?format=csv&table=${item.table}`}
            download
          >
            {item.label}
          </a>
        ))}
      </div>

      <p className="muted footnote">
        Passkeys, sessions and recovery codes are never in an export. They are credentials, not
        records of your money.
      </p>

      <details className="danger">
        <summary className="muted">Erase everything</summary>
        <p className="muted">
          Removes every transaction, envelope, account, budget and rule. Your passkeys and this
          session survive, so you are not locked out of an app you are still using. There is no undo
          - restore from a backup, or re-import.
        </p>

        {done ? (
          <p className="queue-note">{done}</p>
        ) : (
          <>
            <label className="field">
              <span>
                Type <code>{PHRASE}</code> to confirm
              </span>
              <input value={typed} onChange={(event) => setTyped(event.target.value)} />
            </label>
            {error && <p className="signin-error">{error}</p>}
            <div className="signin-actions">
              <button onClick={erase} disabled={pending || typed !== PHRASE}>
                {pending ? 'Erasing…' : 'Erase everything'}
              </button>
            </div>
          </>
        )}
      </details>
    </section>
  );
}
