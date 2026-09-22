'use client';

/**
 * The accounts screen (FR-1, FR-3).
 *
 * Deliberately the same screen as the envelopes one, in shape and in controls: a
 * heading with a row of buttons, categories as collapsible panels, two lines per
 * card, the whole card a link into it, and everything structural behind Edit.
 * They are the two halves of the same ledger and learning one should teach the
 * other.
 *
 * What is *not* here is transactions. Every list of transactions is the one
 * transactions screen with something filtered, so a card leads there with this
 * account applied. This screen answers "what have I got and what is in it".
 *
 * The opening balance is part of creating an account rather than an afterthought,
 * because it is an ordinary transaction landing in the income pool: get it wrong
 * and the two sides of the ledger disagree from the first day.
 *
 * The bank account number is shown but not editable (#10). It is what maps a
 * statement to an account on import (FR-7), so it is set once and then left
 * alone: changing it silently re-points every future statement.
 */

import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ACCOUNT_KINDS, accountKindLabel } from '../../src/accounts/manage.ts';
import type { AccountCategory } from '../../src/accounts/groups.ts';
import { Hint } from '../Hint.tsx';
import { Money } from '../Money.tsx';
import { centsFromInput } from '../amount.ts';
import {
  archiveAccountAction,
  archiveAccountGroupAction,
  createAccountAction,
  createAccountGroupAction,
  editAccountAction,
  moveAccountToGroupAction,
  nudgeAccountGroupAction,
  renameAccountGroupAction,
  unarchiveAccountAction,
  unarchiveAccountGroupAction,
} from './actions.ts';
import { displayDate } from '../../src/budget/month.ts';

type Result = { ok: true; message?: string } | { ok: false; error: string };

export default function AccountManager({
  categories,
  notices,
}: {
  categories: AccountCategory[];
  notices?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newGroup, setNewGroup] = useState('');

  // The new-account form.
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('chequing');
  const [openingBalance, setOpeningBalance] = useState('');
  const [openingDate, setOpeningDate] = useState('');
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

  // "No group" is not a category anyone made, so it only earns a panel while it
  // holds a live account. It was showing empty whenever its only accounts were
  // archived, since those are listed below instead. Choosing it for an account
  // is the picker's own "No category", which does not depend on this list.
  const live = useMemo(
    () =>
      categories.filter(
        (category) =>
          category.archivedAt === null &&
          (category.id !== null ||
            category.accounts.some((account) => account.archivedAt === null)),
      ),
    [categories],
  );
  const archivedGroups = categories.filter((category) => category.archivedAt !== null);
  const archivedAccounts = categories.flatMap((category) =>
    category.accounts.filter((account) => account.archivedAt !== null),
  );

  /** Where an account can be moved. The empty value is "no category" (FR-3). */
  const destinations = useMemo(
    () => live.filter((category) => category.id !== null),
    [live],
  );

  const total = live
    .flatMap((category) => category.accounts)
    .filter((account) => account.archivedAt === null)
    .reduce((sum, account) => sum + account.balanceCents, 0);

  const create = useCallback(() => {
    run(async () => {
      const result = await createAccountAction({
        name,
        kind,
        openingBalance,
        ...(openingDate ? { openingDate } : {}),
        ...(externalAccountId ? { externalAccountId } : {}),
      });
      if (result.ok) {
        setAdding(false);
        setName('');
        setOpeningBalance('');
        setOpeningDate('');
        setExternalAccountId('');
      }
      return result;
    });
  }, [externalAccountId, kind, name, openingBalance, openingDate, run]);

  return (
    <>
      {notices}

      <div className="page-head">
        <div className="month-head">
          <h2>
            Accounts{' '}
            <Hint label="What this screen shows">
              Real money, as the bank sees it, under categories you choose. Tap an account for its
              transactions. Edit lets you rename categories, reorder them, move accounts between them
              and archive what you no longer use — an account has to be emptied before it can be
              archived, because a hidden balance is a difference nobody can find.
            </Hint>
          </h2>
          <div className="head-actions">
            <Link href="/import" className="button-link head-button">
              Import
            </Link>
            <button
              onClick={() => setEditing(!editing)}
              disabled={pending}
              aria-pressed={editing}
              className={editing ? 'active' : ''}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          </div>
        </div>
      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {live.map((category, index) => {
        const accounts = category.accounts.filter((account) => account.archivedAt === null);

        return (
          <details key={category.id ?? 'none'} className="panel group-panel" open>
            <summary>
              <span className="group-summary">
                <span className="group-name">{category.name}</span>
                {category.id !== null && (
                  <Link
                  className="group-open"
                  href={`/transactions?acctgroup=${category.id}`}
                  onClick={(event) => event.stopPropagation()}
                >
                    transactions
                  </Link>
                )}
              </span>
            </summary>

            {/* The ungrouped bucket is not a real category, so it has no tools. */}
            {editing && category.id !== null && (
              <div className="group-tools">
                <button
                  onClick={() => run(() => nudgeAccountGroupAction(category.id!, 'up'))}
                  disabled={pending || index === 0}
                  title="Move this category up"
                >
                  ↑
                </button>
                <button
                  onClick={() => run(() => nudgeAccountGroupAction(category.id!, 'down'))}
                  disabled={pending || index === live.length - 1}
                  title="Move this category down"
                >
                  ↓
                </button>
                <button
                  onClick={() => {
                    const next = window.prompt('Rename category', category.name);
                    if (next !== null && next.trim() !== category.name) {
                      run(() => renameAccountGroupAction(category.id!, next));
                    }
                  }}
                  disabled={pending}
                >
                  Rename category
                </button>
                <button
                  onClick={() => run(() => archiveAccountGroupAction(category.id!))}
                  disabled={pending}
                >
                  Archive category
                </button>
              </div>
            )}

            {accounts.length === 0 && (
              <p className="muted">
                Nothing in this category yet{editing ? '' : '.'}
                {editing && ' — move an account here from another one.'}
              </p>
            )}

            {accounts.map((account) => (
              <div
                key={account.id}
                className={`envelope-row${editing ? ' editing' : ''}`}
              >
                <span className="envelope-name">
                  <Link
                    href={`/transactions?account=${account.id}`}
                    className="envelope-open"
                  >
                    {account.name}
                  </Link>
                  <span className="tag">{accountKindLabel(account.kind)}</span>
                  {editing && (
                    <button
                      className="rename-inline"
                      onClick={() => {
                        const next = window.prompt('Rename account', account.name);
                        if (next !== null && next.trim() !== account.name) {
                          run(() => editAccountAction(account.id, { name: next }));
                        }
                      }}
                      disabled={pending}
                      title={`Rename ${account.name}`}
                    >
                      Rename
                    </button>
                  )}
                </span>

                <Money cents={account.balanceCents} />

                <span className="envelope-figures muted">
                  {/* The number a bank statement names this account by (FR-7).
                      Written as "NO. not mapped", which read as a refusal
                      rather than as a statement never having been imported. */}
                  <span
                    className="figure"
                    title="The account number in this account's bank statements. The first statement imported for it sets it, and later ones are matched to this account by it."
                  >
                    {account.externalAccountId ? (
                      <>
                        <span className="figure-label">acct no.</span>
                        {account.externalAccountId}
                      </>
                    ) : (
                      'no statement imported yet'
                    )}
                  </span>
                  <span className="figure">
                    <span className="figure-label">last</span>
                    {account.lastActivity ? displayDate(account.lastActivity) : 'nothing yet'}
                  </span>
                </span>

                <span className="envelope-actions">
                  {editing && (
                    <>
                      <label className="group-move">
                        <span className="figure-label">category</span>
                        <select
                          value={
                            live.find((c) => c.accounts.some((a) => a.id === account.id))?.id ?? ''
                          }
                          aria-label={`Category for ${account.name}`}
                          disabled={pending}
                          onChange={(event) =>
                            run(() => moveAccountToGroupAction(account.id, event.target.value))
                          }
                        >
                          <option value="">No category</option>
                          {destinations.map((choice) => (
                            <option key={choice.id} value={choice.id!}>
                              {choice.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        onClick={() => run(() => archiveAccountAction(account.id))}
                        disabled={pending}
                      >
                        Archive
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </details>
        );
      })}

      <p className="muted footnote total-line">
        Across every account: <Money cents={total} />
      </p>

      {editing && (
        <section className="panel">
          <div className="panel-head">
            <h3>New category</h3>
            <button onClick={() => setAdding(!adding)} disabled={pending}>
              {adding ? 'Cancel' : 'New account'}
            </button>
          </div>
          <div className="add-device">
            <input
              value={newGroup}
              placeholder="e.g. Day to day"
              onChange={(event) => setNewGroup(event.target.value)}
            />
            <button
              onClick={() => {
                const value = newGroup;
                setNewGroup('');
                run(() => createAccountGroupAction(value));
              }}
              disabled={pending || newGroup.trim() === ''}
            >
              Add category
            </button>
          </div>
        </section>
      )}

      {editing && adding && (
        <section className="panel">
          <h3>New account</h3>
          <div className="new-account">
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
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
              <span>Balance today</span>
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={openingBalance}
                onChange={(event) => setOpeningBalance(event.target.value)}
              />
            </label>
            <label className="field">
              <span>As at</span>
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
                placeholder="as your statement writes it"
                onChange={(event) => setExternalAccountId(event.target.value)}
              />
            </label>
            <p className="muted">
              The opening balance is recorded as a transaction into the income pool, so both sides of
              the ledger agree from the first day (FR-37).
            </p>
            <button
              className="primary"
              onClick={create}
              disabled={pending || name.trim() === '' || !isAmount(openingBalance)}
            >
              Add account
            </button>
          </div>
        </section>
      )}

      {editing && (archivedAccounts.length > 0 || archivedGroups.length > 0) && (
        <details className="panel group-panel">
          <summary>
            <span className="group-summary">
              <span className="group-name">Archived</span>
              <span className="muted">
                {archivedAccounts.length} account{archivedAccounts.length === 1 ? '' : 's'}
                {archivedGroups.length > 0 && `, ${archivedGroups.length} categor`}
                {archivedGroups.length === 1 ? 'y' : archivedGroups.length > 1 ? 'ies' : ''}
              </span>
            </span>
          </summary>
          {archivedAccounts.map((account) => (
            <div key={account.id} className="row">
              <span>{account.name}</span>
              <button
                onClick={() => run(() => unarchiveAccountAction(account.id))}
                disabled={pending}
              >
                Restore
              </button>
            </div>
          ))}
          {archivedGroups.map((category) => (
            <div key={category.id} className="row">
              <span>{category.name} (category)</span>
              <button
                onClick={() => run(() => unarchiveAccountGroupAction(category.id!))}
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

/** A blank balance is zero; anything else has to parse before the button lights. */
function isAmount(text: string): boolean {
  if (text.trim() === '') return true;
  try {
    centsFromInput(text);
    return true;
  } catch {
    return false;
  }
}
