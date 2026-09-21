'use client';

/**
 * The import screen (FR-7 to FR-14).
 *
 * Three states, in the order the pipeline works in: pick files, look at what
 * each would do, commit them. The middle one is the point - Phase 0 found four identical
 * $3.75 charges on one day in the real history, so a row that merely looks like
 * one already here is a question, never an answer.
 *
 * Defaults do the obvious thing: new rows are added, exact duplicates and
 * look-alikes are left alone. Every row can be overridden, and a look-alike can
 * be linked to the transaction it matches, which attaches the bank's id to the
 * existing row so the next import recognises it (MG-9).
 */

import { useCallback, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Hint } from '../Hint.tsx';
import {
  commitImportAction,
  previewImportAction,
  revertImportAction,
  type PreviewRow,
} from './actions.ts';
import type { ImportRecord } from '../../src/import/ofxImport.ts';
import { formatMoney } from '../../src/money.ts';

type Decision = 'add' | 'skip' | 'link';

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

/**
 * One chosen file, from reading through to imported. Several can be chosen at
 * once - a chequing and a card statement, or a few months exported separately -
 * and each stays its own import, so each can still be undone on its own (FR-13).
 */
type Statement = {
  key: string;
  filename: string;
  text: string;
  state: 'reading' | 'needs_account' | 'ready' | 'failed' | 'imported';
  preview?: Preview;
  /** The bank's number for an account Manilla has not met (FR-7). */
  unmapped?: string;
  /** Set when a person picked the account, so the mapping is remembered. */
  pickedAccount?: string;
  error?: string;
};

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

function tallyOf(preview: Preview): number {
  return preview.rows.filter((row) => defaultDecision(row) !== 'skip').length;
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

  const [statements, setStatements] = useState<Statement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  /**
   * A file whose account number is already mapped never reaches a picker - it
   * is recognised and used (FR-7). When one does, the likeliest answer is an
   * account that has no bank number yet, since a mapped one already belongs to a
   * different statement.
   */
  const [choices, setChoices] = useState<Record<string, string>>({});
  const likeliestFor = (bankNumber: string) => proposed[bankNumber] ?? '';

  const update = (key: string, patch: Partial<Statement>) =>
    setStatements((current) =>
      current.map((statement) => (statement.key === key ? { ...statement, ...patch } : statement)),
    );

  const reset = useCallback(() => {
    setStatements([]);
    setChoices({});
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  /** One file's preview. Its own call, so one unreadable file spoils nothing else. */
  const previewOne = async (statement: Statement, accountId?: string) => {
    const result = await previewImportAction(statement.text, accountId);
    if (!result.ok) {
      if ('needsAccount' in result) {
        update(statement.key, { state: 'needs_account', unmapped: result.statementAccountId });
      } else {
        update(statement.key, { state: 'failed', error: result.error });
      }
      return;
    }
    update(statement.key, {
      state: 'ready',
      ...(accountId ? { pickedAccount: accountId } : {}),
      preview: {
        accountId: result.accountId,
        accountName: result.accountName,
        statementAccountId: result.statementAccountId,
        rows: result.rows,
        counts: result.counts,
        ...(result.balance ? { balance: result.balance } : {}),
        ...(result.aiNote ? { aiNote: result.aiNote } : {}),
        warnings: result.warnings,
      },
    });
  };

  const onFiles = async (chosen: FileList) => {
    setError(null);
    setNote(null);
    const read: Statement[] = await Promise.all(
      [...chosen].map(async (file, index) => ({
        key: `${index}:${file.name}`,
        filename: file.name,
        text: await file.text(),
        state: 'reading' as const,
      })),
    );
    setStatements(read);
    startTransition(async () => {
      // In turn rather than all at once: each preview may ask the model about
      // merchants it has not seen, and the monthly budget is counted per call.
      for (const statement of read) await previewOne(statement);
    });
  };

  /**
   * The account a person picked, for every file from that bank account - two
   * months of the same card should not ask twice.
   */
  const applyAccount = (bankNumber: string) => {
    const accountId = choices[bankNumber] ?? likeliestFor(bankNumber);
    if (!accountId) return;
    setChoices((current) => ({ ...current, [bankNumber]: accountId }));
    const waiting = statements.filter(
      (statement) => statement.state === 'needs_account' && statement.unmapped === bankNumber,
    );
    startTransition(async () => {
      for (const statement of waiting) {
        update(statement.key, { state: 'reading' });
        await previewOne(statement, accountId);
      }
    });
  };

  const ready = statements.filter((statement) => statement.state === 'ready');
  const unanswered = statements.filter((statement) => statement.state === 'needs_account');
  const total = ready.reduce((sum, statement) => sum + tallyOf(statement.preview!), 0);
  const sharedAccount =
    new Set(ready.map((statement) => statement.preview!.accountId)).size < ready.length;

  const commit = useCallback(() => {
    if (ready.length === 0) return;
    setError(null);

    startTransition(async () => {
      const batches: { batchId: string; added: number }[] = [];
      let linked = 0;
      let skipped = 0;

      // In turn, each against what the one before wrote: two statements for
      // one account that overlap are matched by the bank's ids as they land, so
      // the rows they share are added once (FR-10).
      for (const statement of ready) {
        const result = await commitImportAction(statement.text, statement.preview!.accountId, [], {
          filename: statement.filename,
          rememberMapping: statement.pickedAccount !== undefined,
        });
        if (!result.ok) {
          update(statement.key, { state: 'failed', error: result.error });
          setError(`${statement.filename}: ${result.error}`);
          router.refresh();
          return;
        }
        update(statement.key, { state: 'imported' });
        batches.push({ batchId: result.batchId, added: result.added });
        linked += result.linked;
        skipped += result.skipped;
      }

      reset();
      // Straight to the queue, looking only at what just arrived when that is
      // one import. Deciding where these went is the rest of importing them.
      const withNew = batches.filter((batch) => batch.added > 0);
      if (withNew.length === 1) {
        router.push(`/review?batch=${withNew[0]!.batchId}`);
        return;
      }
      if (withNew.length > 1) {
        router.push('/review');
        return;
      }
      setNote(
        linked > 0 || skipped > 0
          ? `Nothing new. Linked ${linked}, skipped ${skipped}.`
          : 'Nothing new in those files.',
      );
      router.refresh();
    });
  }, [ready, reset, router]);

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

  // One picker per bank number, however many files carry it.
  const unmappedNumbers = [...new Set(unanswered.map((statement) => statement.unmapped!))];

  // Each picker starts on an account no other statement here has been given or
  // offered - two bank numbers are two accounts - preferring one with no bank
  // number yet.
  const proposed: Record<string, string> = {};
  const taken = new Set(Object.values(choices));
  for (const bankNumber of unmappedNumbers) {
    if (choices[bankNumber]) continue;
    const free = accounts.filter((account) => !taken.has(account.id));
    const pick = free.find((account) => !account.externalAccountId)?.id ?? free[0]?.id;
    if (pick) {
      proposed[bankNumber] = pick;
      taken.add(pick);
    }
  }

  return (
    <>
      {notices}

      <div className="page-head">
        <h2>
          Import statements{' '}
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

      {statements.length === 0 && (
        <section className="panel">
          <h3>Choose statements</h3>
          <p className="muted">
            One file or several - a statement per account, or a few months at a time. Each is
            checked on its own before anything is written.
          </p>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".ofx,.qfx,.OFX,.QFX,application/x-ofx,text/plain"
            disabled={pending}
            onChange={(event) => {
              const chosen = event.target.files;
              if (chosen && chosen.length > 0) void onFiles(chosen);
            }}
          />
        </section>
      )}

      {unmappedNumbers.map((bankNumber) => {
        const files = unanswered.filter((statement) => statement.unmapped === bankNumber);
        return (
          <section key={bankNumber} className="panel account-question">
            <h3>Which account is this?</h3>
            <p className="muted">
              {files.map((statement) => statement.filename).join(', ')}{' '}
              {files.length === 1 ? 'is' : 'are'} for bank account <code>{bankNumber}</code>, which
              is not mapped to anything here yet. Pick the account it belongs to and it will be
              remembered for next time (FR-7).
            </p>
            <label className="field">
              <span>Account</span>
              <select
                value={choices[bankNumber] ?? likeliestFor(bankNumber)}
                onChange={(event) =>
                  setChoices((current) => ({ ...current, [bankNumber]: event.target.value }))
                }
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
                onClick={() => applyAccount(bankNumber)}
                disabled={pending || !(choices[bankNumber] ?? likeliestFor(bankNumber))}
              >
                Use this account
              </button>
            </div>
          </section>
        );
      })}

      {statements
        .filter((statement) => statement.state !== 'needs_account')
        .map((statement) => (
          <StatementCard key={statement.key} statement={statement} />
        ))}

      {statements.length > 0 && (
        <>
          {sharedAccount && (
            <p className="muted footnote">
              Some of these are for the same account. They are imported one after another, so
              anything they have in common is added once.
            </p>
          )}
          {unanswered.length > 0 && (
            <p className="muted">
              Choose an account above for{' '}
              {unanswered.length === 1 ? 'the statement' : `the ${unanswered.length} statements`}{' '}
              Manilla does not recognise{ready.length > 0 ? ', or import the rest without it' : ''}.
            </p>
          )}
          <div className="signin-actions import-actions">
            {ready.length > 0 && (
              <button className="primary" onClick={commit} disabled={pending || total === 0}>
                {pending
                  ? 'Working…'
                  : ready.length === 1
                    ? `Import ${total} and review ${total}`
                    : sharedAccount
                      ? // Rows two files share are only known once the first is in.
                        `Import ${ready.length} statements`
                      : `Import ${ready.length} statements and review ${total}`}
              </button>
            )}
            <button onClick={reset} disabled={pending}>
              Choose different files
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

/** What one file would do, or why it cannot. */
function StatementCard({ statement }: { statement: Statement }) {
  const { preview } = statement;
  return (
    <section className="panel statement">
      <div className="panel-head">
        <h3>{statement.filename}</h3>
        {statement.state === 'reading' && <span className="muted">Reading it…</span>}
        {statement.state === 'imported' && <span className="tag">imported</span>}
      </div>

      {statement.state === 'failed' && <p className="signin-error">{statement.error}</p>}

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
              {formatMoney(preview.balance.statedCents - preview.balance.projectedCents)}: the statement
              says {formatMoney(preview.balance.statedCents)}, this leaves{' '}
              {formatMoney(preview.balance.projectedCents)}.{' '}
              <Hint label="What a balance difference means">
                Usually history from before this file is missing (FR-14). On a first import,
                setting the account&rsquo;s opening balance{' '}
                {formatMoney(preview.balance.statedCents - preview.balance.projectedCents)} higher, as of
                the day before the earliest row here, makes the two agree. The import works either
                way; the check is only telling you what it sees.
              </Hint>
            </p>
          )}

          {/*
            There is no per-row table. Deciding add-or-skip on each of two hundred
            rows before knowing where any of them belong is a review, and the
            review queue is the screen for that - this one only has to say what is
            in the file and whether it has seen it before.
          */}
          {preview.counts.possible_duplicate > 0 && (
            <p className="muted footnote">
              {preview.counts.possible_duplicate} row
              {preview.counts.possible_duplicate === 1 ? '' : 's'} match something already here
              closely enough to look like a repeat, and will be left out.
            </p>
          )}
        </>
      )}
    </section>
  );
}
