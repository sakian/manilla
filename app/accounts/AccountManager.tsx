'use client';

/**
 * Account management (FR-1).
 *
 * The opening balance is part of creating an account rather than an afterthought,
 * because it is an ordinary transaction that lands in the income pool - get it
 * wrong and the two sides of the ledger disagree from the first day.
 *
 * The bank account number is on this screen too: it is what maps an OFX statement
 * to an account on import (FR-7), and the only place it can be corrected.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ACCOUNT_KINDS,
  accountKindLabel,
  type ManagedAccount,
} from '../../src/accounts/manage.ts';
import { Money } from '../Money.tsx';
import {
  archiveAccountAction,
  createAccountAction,
  editAccountAction,
  unarchiveAccountAction,
} from './actions.ts';

type Result = { ok: true; message?: string } | { ok: false; error: string };

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export default function AccountManager({
  accounts,
  selectedId,
}: {
  accounts: ManagedAccount[];
  selectedId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('chequing');
  const [openingBalance, setOpeningBalance] = useState('0.00');
  const [openingDate, setOpeningDate] = useState(today());
  const [externalAccountId, setExternalAccountId] = useState('');

  const run = useCallback(
    (work: () => Promise<Result>) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const result = await work();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNote(result.message ?? null);
        router.refresh();
      });
    },
    [router],
  );

  const add = useCallback(() => {
    run(async () => {
      const result = await createAccountAction({
        name,
        kind,
        openingBalance,
        openingDate,
        externalAccountId,
      });
      if (result.ok) {
        setAdding(false);
        setName('');
        setOpeningBalance('0.00');
        setExternalAccountId('');
      }
      return result;
    });
  }, [externalAccountId, kind, name, openingBalance, openingDate, run]);

  const live = accounts.filter((account) => account.archivedAt === null);
  const archived = accounts.filter((account) => account.archivedAt !== null);
  const total = live.reduce((sum, account) => sum + account.balanceCents, 0);

  return (
    <>
      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      <section className="panel">
        <div className="panel-head">
          <h3>Accounts</h3>
          <button className="primary" onClick={() => setAdding((open) => !open)} disabled={pending}>
            {adding ? 'Cancel' : 'Add an account'}
          </button>
        </div>

        {live.length === 0 && !adding && <p className="muted">No accounts yet.</p>}

        {live.map((account) => (
          <div key={account.id} className="envelope-row">
            <span className="envelope-name">
              <Link href={`/accounts?account=${account.id}`}>
                {selectedId === account.id ? <strong>{account.name}</strong> : account.name}
              </Link>
              <span className="muted"> · {accountKindLabel(account.kind)}</span>
            </span>

            <span className="envelope-figures muted">
              {account.externalAccountId
                ? `no. ${account.externalAccountId}`
                : 'no bank number yet'}
              {account.lastActivity && ` · last ${account.lastActivity}`}
            </span>

            <Money cents={account.balanceCents} />

            <span className="envelope-actions">
              <button
                onClick={() => {
                  const next = window.prompt('Rename account', account.name);
                  if (next !== null && next.trim() !== account.name) {
                    run(() => editAccountAction(account.id, { name: next }));
                  }
                }}
                disabled={pending}
              >
                Rename
              </button>
              <button
                onClick={() => {
                  const next = window.prompt(
                    'The account number exactly as your bank export states it (OFX ACCTID). ' +
                      'Blank to unmap.',
                    account.externalAccountId ?? '',
                  );
                  if (next !== null) {
                    run(() => editAccountAction(account.id, { externalAccountId: next }));
                  }
                }}
                disabled={pending}
              >
                Bank number
              </button>
              <button onClick={() => run(() => archiveAccountAction(account.id))} disabled={pending}>
                Archive
              </button>
            </span>
          </div>
        ))}

        {live.length > 0 && (
          <div className="row total">
            <span>Total</span>
            <Money cents={total} />
          </div>
        )}

        {adding && (
          <div className="new-account">
            <label className="field">
              <span>Name</span>
              <input
                value={name}
                placeholder="Main Chequing"
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Kind</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)}>
                {ACCOUNT_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {accountKindLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Opening balance</span>
              <input
                className="amount"
                inputMode="decimal"
                value={openingBalance}
                onChange={(event) => setOpeningBalance(event.target.value)}
              />
            </label>

            <label className="field">
              <span>As of</span>
              <input
                type="date"
                value={openingDate}
                onChange={(event) => setOpeningDate(event.target.value)}
              />
            </label>

            <label className="field">
              <span>Bank account number</span>
              <input
                value={externalAccountId}
                placeholder="Optional, from your OFX export"
                onChange={(event) => setExternalAccountId(event.target.value)}
              />
            </label>

            <p className="muted">
              The opening balance is recorded as a transaction landing in the income pool, so the
              envelope and account totals agree from the start. A credit card starts negative.
            </p>

            <div className="signin-actions">
              <button
                className="primary"
                onClick={add}
                disabled={pending || name.trim().length === 0}
              >
                {pending ? 'Adding…' : 'Add account'}
              </button>
            </div>
          </div>
        )}
      </section>

      {archived.length > 0 && (
        <details className="panel group-panel">
          <summary>
            <span className="group-summary">
              <span className="group-name">Archived</span>
              <span className="muted">{archived.length}</span>
            </span>
          </summary>
          {archived.map((account) => (
            <div key={account.id} className="row">
              <span>
                {account.name} <span className="muted">· {accountKindLabel(account.kind)}</span>
              </span>
              <button
                onClick={() => run(() => unarchiveAccountAction(account.id))}
                disabled={pending}
              >
                Restore
              </button>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
