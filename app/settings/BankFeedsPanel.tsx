'use client';

/**
 * Bank feeds (FR-15 to FR-20): connect a bank, say which account each of its
 * accounts is, see how fresh the data is, and disconnect.
 *
 * The bank's sign-in happens in Plaid's own window, opened from Plaid's script,
 * so the password never passes through Manilla. Manilla keeps only the token
 * that comes back, encrypted, and Disconnect revokes it at Plaid.
 */

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { displayDate } from '../../src/budget/month.ts';
import {
  createLinkTokenAction,
  linkBankAction,
  revokeBankAction,
  setFeedAccountAction,
  syncNowAction,
} from './bankActions.ts';

type PlaidHandler = { open(): void; destroy(): void };
type PlaidLink = {
  create(config: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (error: { display_message?: string | null; error_message?: string } | null) => void;
  }): PlaidHandler;
};

declare global {
  interface Window {
    Plaid?: PlaidLink;
  }
}

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

/** Plaid's script, loaded the first time it is wanted rather than on every visit to Settings. */
function loadPlaid(): Promise<PlaidLink> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PLAID_SCRIPT;
    script.onload = () => (window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid did not load')));
    script.onerror = () => reject(new Error("Plaid's sign-in window could not be loaded"));
    document.head.appendChild(script);
  });
}

export type BankConnectionView = {
  id: string;
  institutionName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastSyncedAt: string | null;
  accounts: {
    id: string;
    name: string;
    mask: string | null;
    /** What the picker shows: `ledger:account`, or empty when it is not brought in. */
    choice: string;
    /** The other ledger it feeds, when it is not the open one. */
    elsewhere: string | null;
    startDate: string | null;
    /** Holdings, not transactions: Plaid's sync does not cover them. */
    investment: boolean;
  }[];
};

function ago(iso: string | null): string {
  if (!iso) return 'not synced yet';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'synced just now';
  if (minutes < 90) return `synced ${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `synced ${hours} hours ago`;
  return `synced ${Math.round(hours / 24)} days ago`;
}

export default function BankFeedsPanel({
  connections,
  ledgers,
  missing,
}: {
  connections: BankConnectionView[];
  /**
   * Every ledger's accounts, the open one first. One bank login can hold
   * accounts that belong in different ledgers - personal and business - so
   * any of them can be chosen.
   */
  ledgers: { key: string; name: string; accounts: { id: string; name: string }[] }[];
  /** Settings that have to be in .env before a bank can be connected. */
  missing: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Open Plaid's window: for a new bank, or to sign in to one again. */
  const openPlaid = useCallback(
    (connectionId?: string) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const token = await createLinkTokenAction(connectionId);
        if (!token.ok) {
          setError(token.error);
          return;
        }
        let plaid: PlaidLink;
        try {
          plaid = await loadPlaid();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
          return;
        }
        await new Promise<void>((done) => {
          const handler = plaid.create({
            token: token.linkToken,
            onSuccess: (publicToken) => {
              handler.destroy();
              startTransition(async () => {
                if (connectionId) {
                  // Signing in again keeps the connection, so there is nothing
                  // to exchange; a sync is what shows it worked.
                  const synced = await syncNowAction(connectionId);
                  if (!synced.ok) setError(synced.error);
                  else if (synced.error) setError(synced.error.message);
                  else setNote(`Signed in again: ${synced.added} added for review.`);
                } else {
                  const linked = await linkBankAction(publicToken);
                  if (!linked.ok) setError(linked.error);
                  else setNote('Connected. Say which account each one is.');
                }
                router.refresh();
              });
              done();
            },
            onExit: (exit) => {
              handler.destroy();
              if (exit) setError(exit.display_message || exit.error_message || 'The bank sign-in stopped.');
              done();
            },
          });
          handler.open();
        });
      });
    },
    [router],
  );

  const setAccount = useCallback(
    (feedId: string, choice: string) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const result = await setFeedAccountAction(feedId, choice);
        if (!result.ok) setError(result.error);
        router.refresh();
      });
    },
    [router],
  );

  const syncNow = useCallback(
    (connectionId: string) => {
      setError(null);
      setNote(null);
      startTransition(async () => {
        const result = await syncNowAction(connectionId);
        if (!result.ok) {
          setError(result.error);
        } else if (result.error) {
          // A lapsed login is said in plain words beside the connection, with
          // the way to fix it; Plaid's own message is written for developers.
          if (result.error.code !== 'ITEM_LOGIN_REQUIRED') setError(result.error.message);
        } else {
          const parts = [
            `${result.added} added for review`,
            ...(result.linked > 0 ? [`${result.linked} already here`] : []),
            ...(result.held > 0 ? [`${result.held} held for you on the import screen`] : []),
            ...(result.earlier > 0 ? [`${result.earlier} from before the feed starts left out`] : []),
          ];
          setNote(`Synced: ${parts.join(', ')}.`);
        }
        router.refresh();
      });
    },
    [router],
  );

  const disconnect = useCallback(
    (connection: BankConnectionView) => {
      const name = connection.institutionName ?? 'this bank';
      if (
        !window.confirm(
          `Disconnect ${name}? Plaid forgets the login and nothing more comes in from it, ` +
            'in any ledger. What it already brought in stays.',
        )
      ) {
        return;
      }
      startTransition(async () => {
        const result = await revokeBankAction(connection.id);
        if (!result.ok) setError(result.error);
        else setNote(`Disconnected ${name}.`);
        router.refresh();
      });
    },
    [router],
  );

  return (
    <section className="panel" id="bank-feeds">
      <div className="panel-head">
        <h3>Bank feeds</h3>
        <button className="primary" onClick={() => openPlaid()} disabled={pending || missing.length > 0}>
          Connect a bank
        </button>
      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {missing.length > 0 && (
        <p className="budget-warning">
          Set {missing.map((name, i) => (
            <span key={name}>
              {i > 0 && (i === missing.length - 1 ? ' and ' : ', ')}
              <code>{name}</code>
            </span>
          ))}{' '}
          in <code>.env</code> and restart to connect a bank. <code>.env.example</code> says where each
          comes from.
        </p>
      )}

      <p className="muted">
        Posted transactions come in once a day, or when you press Sync now, and wait in the review
        queue like an import. You sign in to your bank in Plaid&rsquo;s window; Manilla never sees the
        password, only a token it keeps encrypted.
      </p>

      {connections.map((connection) => {
        const loginNeeded = connection.errorCode === 'ITEM_LOGIN_REQUIRED';
        return (
          <div key={connection.id} className="bank-connection">
            <div className="row device-row">
              <span>
                <strong>{connection.institutionName ?? 'Bank'}</strong>
                <span className="muted"> · {ago(connection.lastSyncedAt)}</span>
              </span>
              <span className="device-actions">
                <button onClick={() => syncNow(connection.id)} disabled={pending || loginNeeded}>
                  Sync now
                </button>
                <button onClick={() => disconnect(connection)} disabled={pending}>
                  Disconnect
                </button>
              </span>
            </div>

            {loginNeeded ? (
              <div className="budget-warning bank-login">
                <span>The bank wants you to sign in again before anything more comes in.</span>
                <button className="primary" onClick={() => openPlaid(connection.id)} disabled={pending}>
                  Sign in again
                </button>
              </div>
            ) : (
              connection.errorCode && (
                <p className="budget-warning">The last sync failed: {connection.errorMessage}</p>
              )
            )}

            {connection.accounts.map((feed) => (
              <label key={feed.id} className="row device-row bank-account">
                <span>
                  {feed.name}
                  {feed.mask && <span className="muted"> ··{feed.mask}</span>}
                  {feed.choice && (
                    <span className="muted">
                      {' '}
                      · {feed.startDate ? `from ${displayDate(feed.startDate)}` : 'its whole history'}
                      {feed.elsewhere && `, in ${feed.elsewhere}`}
                    </span>
                  )}
                </span>
                {feed.investment ? (
                  <span className="muted">investments come later</span>
                ) : (
                  <select
                    value={feed.choice}
                    onChange={(event) => setAccount(feed.id, event.target.value)}
                    disabled={pending}
                  >
                    <option value="">Not brought in</option>
                    {ledgers.length === 1
                      ? ledgers[0]!.accounts.map((account) => (
                          <option key={account.id} value={`${ledgers[0]!.key}:${account.id}`}>
                            {account.name}
                          </option>
                        ))
                      : ledgers.map((ledger) => (
                          <optgroup key={ledger.key} label={ledger.name}>
                            {ledger.accounts.map((account) => (
                              <option key={account.id} value={`${ledger.key}:${account.id}`}>
                                {account.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                  </select>
                )}
              </label>
            ))}
          </div>
        );
      })}
    </section>
  );
}
