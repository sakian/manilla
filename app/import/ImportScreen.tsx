'use client';

/**
 * The import screen (FR-7 to FR-14).
 *
 * Three states, in the order the pipeline works in: pick a file, look at what it
 * would do, commit it. The middle one is the point - Phase 0 found four identical
 * $3.75 charges on one day in the real history, so a row that merely looks like
 * one already here is a question, never an answer.
 *
 * Defaults do the obvious thing: new rows are added, exact duplicates and
 * look-alikes are left alone. Every row can be overridden, and a look-alike can
 * be linked to the transaction it matches, which attaches the bank's id to the
 * existing row so the next import recognises it (MG-9).
 */

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  commitImportAction,
  previewImportAction,
  revertImportAction,
  type PreviewRow,
} from './actions.ts';
import type { ImportRecord } from '../../src/import/ofxImport.ts';

type Decision = 'add' | 'skip' | 'link';

type Loaded = {
  filename: string;
  text: string;
};

type Preview = {
  accountId: string;
  accountName: string;
  statementAccountId: string;
  rows: PreviewRow[];
  counts: {
    new: number;
    duplicate: number;
    possible_duplicate: number;
    transfer_half: number;
  };
  balance?: { statedCents: number; projectedCents: number; matches: boolean };
  warnings: string[];
};

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
}

function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[Number(month) - 1]} ${Number(day)}`;
}

/**
 * What each row does if nobody touches it. A transfer half links, because the
 * money is already recorded on both accounts and what this statement adds is
 * the bank's id for it (FR-5).
 */
function defaultDecision(row: PreviewRow): Decision {
  if (row.verdict === 'new') return 'add';
  if (row.verdict === 'transfer_half' && row.existingId) return 'link';
  return 'skip';
}

export default function ImportScreen({
  accounts,
  history,
}: {
  accounts: { id: string; name: string; externalAccountId: string | null }[];
  history: ImportRecord[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Set when the statement is for a bank account Manilla has not met (FR-7). */
  const [needsAccount, setNeedsAccount] = useState<string | null>(null);
  const [chosenAccount, setChosenAccount] = useState(accounts[0]?.id ?? '');

  const reset = useCallback(() => {
    setLoaded(null);
    setPreview(null);
    setDecisions({});
    setNeedsAccount(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const runPreview = useCallback((file: Loaded, accountId?: string) => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await previewImportAction(file.text, accountId);

      if (!result.ok) {
        if ('needsAccount' in result) {
          setNeedsAccount(result.statementAccountId);
          setError(null);
          return;
        }
        setError(result.error);
        return;
      }

      setNeedsAccount(null);
      setPreview({
        accountId: result.accountId,
        accountName: result.accountName,
        statementAccountId: result.statementAccountId,
        rows: result.rows,
        counts: result.counts,
        ...(result.balance ? { balance: result.balance } : {}),
        warnings: result.warnings,
      });
      setDecisions({});
    });
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      const text = await file.text();
      const next = { filename: file.name, text };
      setLoaded(next);
      runPreview(next);
    },
    [runPreview],
  );

  const decisionFor = useCallback(
    (row: PreviewRow): Decision => decisions[row.index] ?? defaultDecision(row),
    [decisions],
  );

  const tally = useMemo(() => {
    if (!preview) return { add: 0, link: 0, skip: 0 };
    let add = 0;
    let link = 0;
    let skip = 0;
    for (const row of preview.rows) {
      const decision = decisionFor(row);
      if (decision === 'add') add += 1;
      else if (decision === 'link') link += 1;
      else skip += 1;
    }
    return { add, link, skip };
  }, [preview, decisionFor]);

  const commit = useCallback(() => {
    if (!loaded || !preview) return;
    setError(null);

    startTransition(async () => {
      const changed = preview.rows
        .map((row) => {
          const decision = decisionFor(row);
          if (decision === defaultDecision(row)) return null;
          return {
            index: row.index,
            action: decision,
            ...(decision === 'link' && row.existingId ? { transactionId: row.existingId } : {}),
          };
        })
        .filter((decision): decision is NonNullable<typeof decision> => decision !== null);

      const result = await commitImportAction(loaded.text, preview.accountId, changed, {
        filename: loaded.filename,
        rememberMapping: needsAccount !== null || chosenAccount === preview.accountId,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setNote(
        `Imported ${result.added} ${result.added === 1 ? 'transaction' : 'transactions'}` +
          (result.linked > 0 ? `, linked ${result.linked}` : '') +
          (result.skipped > 0 ? `, skipped ${result.skipped}` : '') +
          '. They are waiting in the review queue.',
      );
      reset();
      router.refresh();
    });
  }, [chosenAccount, decisionFor, loaded, needsAccount, preview, reset, router]);

  const undo = useCallback(
    (batch: ImportRecord) => {
      if (
        !window.confirm(
          `Undo this import? ${batch.remaining} ${
            batch.remaining === 1 ? 'transaction' : 'transactions'
          } will be removed, along with any envelopes you have since assigned to them.`,
        )
      ) {
        return;
      }
      setError(null);
      startTransition(async () => {
        const result = await revertImportAction(batch.id);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setNote(`Removed ${result.removed}.`);
        router.refresh();
      });
    },
    [router],
  );

  return (
    <>
      <div className="page-head">
        <h2>Import a statement</h2>
        <p className="muted">
          OFX or QFX, as your bank exports it. Nothing is written until you have seen what it would
          do.
        </p>
      </div>

      {error && <p className="signin-error">{error}</p>}
      {note && <p className="queue-note">{note}</p>}

      {!preview && (
        <section className="panel">
          <h3>Choose a file</h3>
          <input
            ref={fileRef}
            type="file"
            accept=".ofx,.qfx,.OFX,.QFX,application/x-ofx,text/plain"
            disabled={pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onFile(file);
            }}
          />

          {needsAccount && loaded && (
            <div className="new-account">
              <p className="muted">
                This statement is for bank account <code>{needsAccount}</code>, which is not mapped
                to anything here yet. Pick the account it belongs to and it will be remembered for
                next time (FR-7).
              </p>
              <label className="field">
                <span>Account</span>
                <select
                  value={chosenAccount}
                  onChange={(event) => setChosenAccount(event.target.value)}
                >
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                      {account.externalAccountId ? ` (currently ${account.externalAccountId})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="signin-actions">
                <button
                  className="primary"
                  onClick={() => runPreview(loaded, chosenAccount)}
                  disabled={pending || !chosenAccount}
                >
                  Use this account
                </button>
              </div>
            </div>
          )}

          {pending && <p className="muted">Reading it…</p>}
        </section>
      )}

      {preview && (
        <>
          <div className="callouts">
            <div className="callout">
              <strong>{preview.counts.new}</strong> new
            </div>
            {preview.counts.duplicate > 0 && (
              <div className="callout">
                <strong>{preview.counts.duplicate}</strong> already imported
              </div>
            )}
            {preview.counts.possible_duplicate > 0 && (
              <div className="callout warn">
                <strong>{preview.counts.possible_duplicate}</strong> look like duplicates
              </div>
            )}
            {preview.counts.transfer_half > 0 && (
              <div className="callout">
                <strong>{preview.counts.transfer_half}</strong> the other half of a transfer
              </div>
            )}
            <div className="callout">into {preview.accountName}</div>
          </div>

          {preview.warnings.map((warning) => (
            <p key={warning} className="budget-warning">
              {warning}
            </p>
          ))}

          {preview.balance && (
            <p className={`budget-warning${preview.balance.matches ? ' ok' : ''}`}>
              {preview.balance.matches ? (
                <>
                  The statement says the account holds {money(preview.balance.statedCents)}, and it
                  will once this is applied.
                </>
              ) : (
                <>
                  The statement says the account holds {money(preview.balance.statedCents)}, but
                  applying this leaves it at {money(preview.balance.projectedCents)} - a difference
                  of {money(preview.balance.statedCents - preview.balance.projectedCents)}. That
                  usually means history from before this file is missing (FR-14). On a first
                  import, setting the account's opening balance{' '}
                  {money(preview.balance.statedCents - preview.balance.projectedCents)} higher, as
                  of the day before the earliest row here, makes the two agree. The import works
                  either way; the check is only telling you what it sees.
                </>
              )}
            </p>
          )}

          <section className="panel">
            <div className="panel-head">
              <h3>What this would do</h3>
              <span className="muted">
                add {tally.add} · link {tally.link} · skip {tally.skip}
              </span>
            </div>

            <div className="import-table">
              {preview.rows.map((row) => {
                const decision = decisionFor(row);
                return (
                  <div key={row.index} className={`import-row ${row.verdict}`}>
                    <span className="muted txn-date">{shortDate(row.date)}</span>

                    <span className="import-payee">
                      <span className="queue-name">{row.payee}</span>
                      <span className="queue-sub muted">{row.reason}</span>
                    </span>

                    <span className={`money ${row.amountCents < 0 ? 'neg' : 'pos'}`}>
                      {money(row.amountCents)}
                    </span>

                    <span className="import-envelope">
                      {row.transferToName ? (
                        <span className="chip">transfer to {row.transferToName}</span>
                      ) : row.envelopeName ? (
                        <span className={`chip band-${row.band ?? 'low'}`}>{row.envelopeName}</span>
                      ) : (
                        <span className="chip none">Uncategorized</span>
                      )}
                    </span>

                    <span className="import-actions">
                      {(['add', 'skip'] as const).map((option) => (
                        <button
                          key={option}
                          className={decision === option ? 'active' : ''}
                          onClick={() =>
                            setDecisions((current) => ({ ...current, [row.index]: option }))
                          }
                          disabled={pending}
                        >
                          {option}
                        </button>
                      ))}
                      {row.existingId && (
                        <button
                          className={decision === 'link' ? 'active' : ''}
                          onClick={() =>
                            setDecisions((current) => ({ ...current, [row.index]: 'link' }))
                          }
                          disabled={pending}
                          title="Treat it as the transaction already here, and attach the bank id to it"
                        >
                          link
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="signin-actions">
            <button className="primary" onClick={commit} disabled={pending || tally.add + tally.link === 0}>
              {pending ? 'Importing…' : `Import ${tally.add + tally.link}`}
            </button>
            <button onClick={reset} disabled={pending}>
              Choose a different file
            </button>
          </div>
        </>
      )}

      {history.length > 0 && (
        <section className="panel">
          <h3>Previous imports</h3>
          {history.map((batch) => (
            <div key={batch.id} className="row">
              <span>
                {batch.filename ?? 'a statement'}
                <span className="muted">
                  {' '}
                  · {batch.accountName ?? 'unknown account'} ·{' '}
                  {new Date(batch.createdAt).toLocaleDateString()}
                </span>
                {batch.revertedAt && <span className="tag">undone</span>}
              </span>
              <span className="allocation-actions">
                <span className="muted">
                  {batch.addedCount} added
                  {batch.remaining !== batch.addedCount && `, ${batch.remaining} left`}
                </span>
                {batch.remaining > 0 && (
                  <button onClick={() => undo(batch)} disabled={pending}>
                    Undo
                  </button>
                )}
              </span>
            </div>
          ))}
          <p className="muted footnote">
            Undoing removes the transactions that import created (FR-13). Anything you have since
            edited by hand goes with them.
          </p>
        </section>
      )}

      {!preview && (
        <p className="muted footnote">
          Everything imported arrives in the <Link href="/review">review queue</Link> with a
          suggested envelope already applied, so the dashboard is accurate before you have finished
          reviewing.
        </p>
      )}
    </>
  );
}
