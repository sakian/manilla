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

import { useCallback, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Hint } from '../Hint.tsx';
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
  aiNote?: string;
};

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString()}.${String(abs % 100).padStart(2, '0')}`;
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
  notices,
}: {
  accounts: { id: string; name: string; externalAccountId: string | null }[];
  history: ImportRecord[];
  /** What needs attention, so what an import just created is reachable from here. */
  notices?: ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /** Set when the statement is for a bank account Manilla has not met (FR-7). */
  const [needsAccount, setNeedsAccount] = useState<string | null>(null);
  /**
   * A file whose account number is already mapped never reaches this control - it
   * is recognised and used (FR-7). When one does, the likeliest answer is an
   * account that has no bank number yet, since a mapped one already belongs to a
   * different statement.
   */
  const [chosenAccount, setChosenAccount] = useState(
    () =>
      accounts.find((account) => !account.externalAccountId)?.id ?? accounts[0]?.id ?? '',
  );

  const reset = useCallback(() => {
    setLoaded(null);
    setPreview(null);
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
        ...(result.aiNote ? { aiNote: result.aiNote } : {}),
        warnings: result.warnings,
      });
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

  /**
   * What each row will do, with nothing to override it. A new row is added, one
   * the bank id already claims is linked, and anything that looks like a repeat
   * is left out - which is what the counts above say, so there is nothing here a
   * person has to decide before the review queue.
   */
  const decisionFor = useCallback((row: PreviewRow): Decision => defaultDecision(row), []);

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

      reset();
      // Straight to the queue, looking only at what just arrived. Deciding where
      // these went is the rest of importing them, and it is the same screen - so
      // it should be the same screen, not a summary of one.
      if (result.added > 0) {
        router.push(`/review?batch=${result.batchId}`);
        return;
      }
      setNote(
        result.linked > 0 || result.skipped > 0
          ? `Nothing new. Linked ${result.linked}, skipped ${result.skipped}.`
          : 'Nothing new in that file.',
      );
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
      {notices}

      <div className="page-head">
        <h2>
          Import a statement{' '}
          <Hint label="How importing works">
            OFX or QFX, as your bank exports it. The account is recognised from the file where it
            can be, and remembered when you pick one. Every row is matched against what is already
            here, so importing a statement twice adds nothing. Nothing is written until you press
            Import, everything imported lands in the review queue with a suggested envelope already
            applied, and a whole import can be undone in one step afterwards.
          </Hint>
        </h2>
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

          {preview.aiNote && (
            <p className="muted footnote">
              {preview.aiNote} Rules and history still ran, so these suggestions are the ones they
              could make on their own.
            </p>
          )}

          {preview.balance && !preview.balance.matches && (
            <p className="budget-warning">
              Balance off by{' '}
              {money(preview.balance.statedCents - preview.balance.projectedCents)}: the statement
              says {money(preview.balance.statedCents)}, this leaves{' '}
              {money(preview.balance.projectedCents)}.{' '}
              <Hint label="What a balance difference means">
                Usually history from before this file is missing (FR-14). On a first import,
                setting the account&rsquo;s opening balance{' '}
                {money(preview.balance.statedCents - preview.balance.projectedCents)} higher, as of
                the day before the earliest row here, makes the two agree. The import works either
                way; the check is only telling you what it sees.
              </Hint>
            </p>
          )}

          {/*
            The per-row table went. Deciding add-or-skip on each of two hundred
            rows before knowing where any of them belong is a review, and the
            review queue is the screen for that - this one only has to say what is
            in the file and whether it has seen it before. A row that looks like a
            repeat is skipped by default; the queue is where anything is judged.
          */}
          {preview.counts.possible_duplicate > 0 && (
            <p className="muted footnote">
              {preview.counts.possible_duplicate} row
              {preview.counts.possible_duplicate === 1 ? '' : 's'} match something already here
              closely enough to look like a repeat, and will be left out.
            </p>
          )}

          <div className="signin-actions">
            <button
              className="primary"
              onClick={commit}
              disabled={pending || tally.add + tally.link === 0}
            >
              {pending
                ? 'Importing…'
                : `Import ${tally.add + tally.link} and review ${tally.add + tally.link}`}
            </button>
            <button onClick={reset} disabled={pending}>
              Choose a different file
            </button>
          </div>
        </>
      )}

      {history.length > 0 && (
        <section className="panel">
          <h3>
            Previous imports{' '}
            <Hint label="What undoing an import does">
              Undoing removes the transactions that import created (FR-13). Anything you have since
              edited by hand goes with them.
            </Hint>
          </h3>
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

        </section>
      )}

    </>
  );
}
