'use client';

/**
 * The ledgers this account keeps, and opening another (LG-2).
 *
 * Always here, even with one ledger: the header only names ledgers once there
 * is a choice to make, so this is where the first second one comes from.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Ledger } from '../../src/ledgers/config.ts';
import { openLedgerAction, renameLedgerAction } from './actions.ts';

export default function LedgersPanel({
  ledgers,
  currentKey,
  max,
}: {
  ledgers: Ledger[];
  currentKey: string;
  max: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  const full = ledgers.length >= max;

  const open = () => {
    setError(null);
    startTransition(async () => {
      const result = await openLedgerAction(newName);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNewName('');
      // Into the new ledger, which is empty and waiting to be set up.
      router.push('/');
      router.refresh();
    });
  };

  const rename = () => {
    if (!renaming) return;
    setError(null);
    startTransition(async () => {
      const result = await renameLedgerAction(renaming.key, renaming.name);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRenaming(null);
      router.refresh();
    });
  };

  return (
    <section className="panel" id="ledgers">
      <h3>Ledgers</h3>
      <p className="muted">
        Separate books - business and household, say - behind this one sign-in. Each has its own
        accounts, envelopes and history, and nothing moves between them: money that crosses from
        one to the other is entered on both sides. Each is backed up on its own.
      </p>

      {error && <p className="signin-error">{error}</p>}

      <div className="ledger-list">
        {ledgers.map((ledger, index) => (
          <div key={ledger.key} className={`ledger-row ledger-tone-${index % max}`}>
            {renaming?.key === ledger.key ? (
              <form
                className="ledger-rename"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename();
                }}
              >
                <input
                  aria-label={`New name for ${ledger.name}`}
                  value={renaming.name}
                  maxLength={40}
                  autoFocus
                  onChange={(event) => setRenaming({ key: ledger.key, name: event.target.value })}
                />
                <button type="submit" className="primary" disabled={pending}>
                  Save
                </button>
                <button type="button" onClick={() => setRenaming(null)} disabled={pending}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="ledger-row-name">
                  <span className="ledger-dot" aria-hidden="true" />
                  {ledger.name}
                  {ledger.key === currentKey && ledgers.length > 1 && (
                    <span className="tag">open</span>
                  )}
                </span>
                <button
                  className="link-button"
                  onClick={() => setRenaming({ key: ledger.key, name: ledger.name })}
                  disabled={pending}
                >
                  Rename
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {full ? (
        <p className="muted footnote">
          That is the most: an account keeps {max} ledgers. One cannot be closed from here, because
          closing it would take its money with it.
        </p>
      ) : (
        <form
          className="ledger-open"
          onSubmit={(event) => {
            event.preventDefault();
            open();
          }}
        >
          <label className="field">
            <span>Open a new ledger</span>
            <input
              value={newName}
              maxLength={40}
              placeholder="Business"
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <button type="submit" className="primary" disabled={pending || newName.trim() === ''}>
            {pending ? 'Opening…' : 'Open it'}
          </button>
        </form>
      )}
    </section>
  );
}
