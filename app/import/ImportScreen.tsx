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
 * look-alikes are left alone, and a row that is the other half of a transfer or
 * something entered ahead is linked to it, which attaches the bank's id to the
 * existing row so the next import recognises it (MG-9). Every one of those
 * matches is listed, and any of them can be refused and the row added as its
 * own: a match on amount and date is a proposal, not a fact.
 */

import { useCallback, useRef, useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Hint } from '../Hint.tsx';
import { Money } from '../Money.tsx';
import {
  commitImportAction,
  previewImportAction,
  revertImportAction,
  type PreviewRow,
} from './actions.ts';
import type { ImportRecord } from '../../src/import/ofxImport.ts';
import { formatMoney } from '../../src/money.ts';
import { displayDate, displayInstant } from '../../src/budget/month.ts';

type Decision = 'add' | 'skip' | 'link';

type Preview = {
  accountId: string;
  accountName: string;
  statementAccountId: string;
  rows: PreviewRow[];
  counts: {
    new: number;
    same_entry: number;
    duplicate: number;
    possible_duplicate: number;
    transfer_half: number;
    entered_ahead: number;
  };
  balance?: { statedCents: number; projectedCents: number; matches: boolean; asOf?: string };
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
  /** Matches a person said are not the same: row index to the id it matched. */
  refused?: Record<number, string>;
  error?: string;
};

/**
 * What each row does. A transfer half links, because the money is already
 * recorded on both accounts and what this statement adds is the bank's id for
 * it (FR-5). Something entered ahead links for the same reason: it was recorded
 * by hand before the bank had it. So does a row the bank feed brought in first
 * (FR-18). A refused match is added as its own.
 */
function decisionOf(row: PreviewRow, refused: Record<number, string> = {}): Decision {
  if (row.verdict === 'new') return 'add';
  if (row.existingId && refused[row.index] === row.existingId) return 'add';
  if (
    (row.verdict === 'same_entry' || row.verdict === 'transfer_half' || row.verdict === 'entered_ahead') &&
    row.existingId
  ) {
    return 'link';
  }
  return 'skip';
}

/** Rows a statement writes, and how many of those go to the queue. */
function tallyOf(statement: Statement): { writes: number; reviews: number } {
  const decisions = statement.preview!.rows.map((row) => decisionOf(row, statement.refused));
  return {
    writes: decisions.filter((decision) => decision !== 'skip').length,
    // A linked row keeps the envelope it already had, so only added rows are
    // left to review.
    reviews: decisions.filter((decision) => decision === 'add').length,
  };
}

/** Rows that matched something already here, which a person can refuse. */
function matchesOf(preview: Preview): PreviewRow[] {
  return preview.rows.filter((row) => row.existingId && row.matched);
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
  const total = ready.reduce((sum, statement) => sum + tallyOf(statement).writes, 0);
  const reviews = ready.reduce((sum, statement) => sum + tallyOf(statement).reviews, 0);
  const sharedAccount =
    new Set(ready.map((statement) => statement.preview!.accountId)).size < ready.length;
  // A statement with nothing new still states a dated balance worth keeping as
  // a checkpoint - which is how old statements fill in the account's history.
  const balancesOnly =
    total === 0 && ready.some((statement) => statement.preview!.balance?.asOf !== undefined);

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
        const refusals = Object.entries(statement.refused ?? {}).map(([index, existingId]) => ({
          index: Number(index),
          existingId,
        }));
        const result = await commitImportAction(
          statement.text,
          statement.preview!.accountId,
          refusals,
          {
            filename: statement.filename,
            rememberMapping: statement.pickedAccount !== undefined,
          },
        );
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
        `Nothing new${linked > 0 ? `; linked ${linked}` : ''}. Any balance the statements stated ` +
          'is kept, and shows on the account’s transactions.',
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
          <StatementCard
            key={statement.key}
            statement={statement}
            disabled={pending}
            onRefuse={(row, refuse) => {
              const refused = { ...statement.refused };
              if (refuse) refused[row.index] = row.existingId!;
              else delete refused[row.index];
              update(statement.key, { refused });
            }}
          />
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
              <button
                className="primary"
                onClick={commit}
                disabled={pending || (total === 0 && !balancesOnly)}
              >
                {pending
                  ? 'Working…'
                  : balancesOnly
                    ? `Nothing new - record the statement balance${ready.length === 1 ? '' : 's'}`
                    : ready.length === 1
                    ? `Import ${total}${reviews > 0 ? ` and review ${reviews}` : ''}`
                    : sharedAccount
                      ? // Rows two files share are only known once the first is in.
                        `Import ${ready.length} statements`
                      : `Import ${ready.length} statements${
                          reviews > 0 ? ` and review ${reviews}` : ''
                        }`}
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
                  {displayInstant(batch.createdAt)}
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

/** What a match does by default, in the words of the row it matched. */
function matchVerb(row: PreviewRow): string {
  if (row.verdict === 'same_entry') return 'Linked to the bank feed’s ';
  if (row.verdict === 'entered_ahead') return 'Linked to your entry ';
  if (row.verdict === 'transfer_half') return 'Linked to the transfer ';
  return 'Left out: looks like ';
}

/** What one file would do, or why it cannot. */
function StatementCard({
  statement,
  disabled,
  onRefuse,
}: {
  statement: Statement;
  disabled: boolean;
  onRefuse: (row: PreviewRow, refuse: boolean) => void;
}) {
  const { preview } = statement;
  const matches = preview ? matchesOf(preview) : [];
  const isRefused = (row: PreviewRow) => statement.refused?.[row.index] === row.existingId;

  // The server projected the balance from the default decisions; a refused
  // match is added, so its money is in the account too.
  const balance = preview?.balance && {
    ...preview.balance,
    projectedCents:
      preview.balance.projectedCents +
      matches.filter(isRefused).reduce((sum, row) => sum + row.amountCents, 0),
  };
  const balanceOff = balance ? balance.statedCents - balance.projectedCents : 0;

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
            {preview.counts.same_entry > 0 && (
              <div className="callout">
                <strong>{preview.counts.same_entry}</strong> already here from the bank feed
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
            {preview.counts.entered_ahead > 0 && (
              <div className="callout">
                <strong>{preview.counts.entered_ahead}</strong> you entered already
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

          {balance && balanceOff !== 0 && (
            <p className="budget-warning">
              Balance off by {formatMoney(balanceOff)}: the statement says{' '}
              {formatMoney(balance.statedCents)}, this leaves {formatMoney(balance.projectedCents)}.{' '}
              <Hint label="What a balance difference means">
                Usually history from before this file is missing (FR-14). On a first import,
                setting the account&rsquo;s opening balance {formatMoney(balanceOff)} higher, as of
                the day before the earliest row here, makes the two agree. The import works either
                way; the check is only telling you what it sees.
              </Hint>
            </p>
          )}

          {/*
            There is no table of every row. Deciding add-or-skip on each of two
            hundred rows before knowing where any of them belong is a review, and
            the review queue is the screen for that. Matches are the exception:
            whether a row is the same money as something already here is a
            question only this screen can ask, so those are listed. A first
            import after a migration can match hundreds, so a long list starts
            folded.
          */}
          {matches.length > 0 && (
            <details className="import-matches" open={matches.length <= 10}>
              <summary>
                {matches.length} {matches.length === 1 ? 'row matches' : 'rows match'} something
                already here
              </summary>
              <p className="muted footnote">
                A linked row adds the bank&rsquo;s id to what you have, rather than recording the
                money twice; a look-alike is left out. If one is a different transaction, tick it
                and it is added as its own.
              </p>
              {matches.map((row) => (
                <label key={row.index} className="import-match">
                  <span className="import-match-text">
                    <span>
                      {displayDate(row.date)} · {row.payee} ·{' '}
                      {/* In the checkbox's label, where a button would be a second control. */}
                      <Money cents={row.amountCents} copy={false} />
                    </span>
                    <span className="muted">
                      {isRefused(row) ? 'Will be added as its own, not ' : matchVerb(row)}
                      &ldquo;{row.matched!.payee}&rdquo;, {displayDate(row.matched!.date)}
                    </span>
                  </span>
                  <span className="import-match-choice">
                    <input
                      type="checkbox"
                      checked={isRefused(row)}
                      disabled={disabled || statement.state !== 'ready'}
                      onChange={(event) => onRefuse(row, event.target.checked)}
                    />
                    Not the same
                  </span>
                </label>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
