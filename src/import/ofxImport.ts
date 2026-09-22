/**
 * OFX/QFX import (FR-7, FR-9 to FR-14).
 *
 * Import is deliberately two-phase: `previewImport` decides what each row is
 * and changes nothing; `commitImport` writes only what the user accepted. That
 * split is what makes FR-9's preview honest and FR-13's undo meaningful.
 *
 * Deduplication rests on the bank's own FITID, which is unique per account. The
 * Phase 0 export showed why nothing weaker will do on its own: the real history
 * contained four identical $3.75 vending-machine charges on one day, so
 * date + amount + description cannot be treated as proof of a duplicate. Rows
 * that merely look alike are surfaced for a decision and never dropped silently.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  importBatches,
  transactionExternalIds,
  transactions,
  txnLines,
  suggestions as suggestionsTable,
} from '../../db/schema.ts';
import type { OfxStatement, OfxTransaction } from '../ofx/parse.ts';
import { bandOf } from '../categorize/pipeline.ts';
import { normalizePayee } from '../categorize/normalize.ts';
import { buildCategorizer } from '../categorize/fromDb.ts';
import { unallocatedEnvelope } from '../ledger/ledger.ts';
import { unmatchedTransferHalves } from '../transactions/manage.ts';
import { listTransferRules, matchTransferRule } from '../rules/rules.ts';
import { rememberAnswers } from '../ai/ai.ts';
import { AI_MODEL } from '../categorize/ai.ts';

/**
 * How far apart the two sides of one transfer may post. A payment leaving the
 * chequing account on Friday can reach the card on Monday, and the two
 * statements will not agree on the date.
 */
const TRANSFER_DATE_WINDOW_DAYS = 4;

/**
 * How far apart two records of one transaction can be dated. A bank statement
 * dates a row when it posted; a migrated history dates it when it was entered,
 * and the two were three days apart on a real pair that got in twice. A week
 * covers a weekend either side without reaching last month's bill.
 */
const LOOKALIKE_WINDOW_DAYS = 5;

/** Whole days between two `YYYY-MM-DD` dates, order-independent. */
function daysApart(left: string, right: string): number {
  const to = (date: string) => Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  return Math.abs(to(left) - to(right)) / 86_400_000;
}
import type { Suggestion } from '../categorize/types.ts';

export class ImportError extends Error {}

export type RowVerdict =
  /** Not seen before. */
  | 'new'
  /** The bank's own id is already on a transaction in this account. */
  | 'duplicate'
  /**
   * Same account, date, amount and payee as an existing transaction, but no
   * shared id. Could be a genuine repeat purchase, or the same transaction
   * arriving from a second source (MG-9). The user decides.
   */
  | 'possible_duplicate'
  /**
   * The other side of a transfer between the user's own accounts (FR-5). The
   * chequing statement calls it "Tfr-to C C" and the card statement calls it a
   * payment received; they are the same money, and importing it as a second
   * transaction would count the money twice. Matched on amount and a near date
   * rather than on the description, because the two banks never word it the
   * same way.
   */
  | 'transfer_half';

export type ImportRow = {
  index: number;
  transaction: OfxTransaction;
  verdict: RowVerdict;
  /** The transaction it matched, when there is one. */
  existingId?: string;
  reason: string;
  suggestion?: Suggestion;
  /**
   * Set when a standing rule says this payee is a transfer to another of the
   * user's accounts rather than spending (CA-2, FR-5). Committing it writes both
   * halves and no envelope line.
   */
  transferTo?: { accountId: string; name: string };
};

export type BalanceCheck = {
  statedCents: number;
  /** The day the statement says that balance was as of. */
  asOf?: string;
  /** Account balance after this import would be applied. */
  projectedCents: number;
  matches: boolean;
};

export type ImportPreview = {
  accountId: string;
  accountName: string;
  rows: ImportRow[];
  counts: Record<RowVerdict, number>;
  /** FR-14, when the file carries a ledger balance. */
  balanceCheck?: BalanceCheck;
  /** Why the AI layer did not run, or stopped part way (NF-10). */
  aiNote?: string;
};

/** FR-7: map the statement's account to a Manilla account, remembering it next time. */
export async function resolveAccount(
  db: Database,
  statement: OfxStatement,
): Promise<{ id: string; name: string } | undefined> {
  const [row] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.externalAccountId, statement.accountId))
    .limit(1);
  return row;
}

export async function rememberAccountMapping(
  db: Database,
  accountId: string,
  externalAccountId: string,
): Promise<void> {
  await db
    .update(accounts)
    .set({ externalAccountId })
    .where(eq(accounts.id, accountId));
}

/**
 * Classify every row in the statement without writing anything.
 *
 * `categorize: false` skips suggestion generation, which keeps the preview fast
 * when the caller only wants the duplicate counts.
 */
export async function previewImport(
  db: Database,
  statement: OfxStatement,
  accountId: string,
  options: { categorize?: boolean; useAi?: boolean } = {},
): Promise<ImportPreview> {
  const [account] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new ImportError(`No such account: ${accountId}`);

  const incoming = statement.transactions;

  // Every FITID already known for this account.
  const fitIds = incoming.map((t) => t.fitId).filter(Boolean);
  const knownById = new Map<string, string>();
  if (fitIds.length > 0) {
    const rows = await db
      .select({
        value: transactionExternalIds.value,
        transactionId: transactionExternalIds.transactionId,
      })
      .from(transactionExternalIds)
      .where(
        and(
          eq(transactionExternalIds.accountId, accountId),
          eq(transactionExternalIds.kind, 'fitid'),
          inArray(transactionExternalIds.value, fitIds),
        ),
      );
    for (const row of rows) knownById.set(row.value, row.transactionId);
  }

  // Existing transactions a new row might be another record of: the same
  // amount and payee, dated close by. How close depends on where the existing
  // one came from:
  //
  //  - With no bank id - migrated, or typed in - it was dated when someone
  //    entered it, which can be days off the bank's posting date: within the
  //    window.
  //  - With a bank id, the bank dated it, so another record of it has the same
  //    date: that date only. Not "never", because a bank's id is not always
  //    stable - one bank's re-downloaded statement gave every transfer a new id
  //    while its purchases kept theirs - and not the window either, which would
  //    take last week's identical charge for this one.
  const lookAlikes = new Map<string, { id: string; date: string; banked: boolean }[]>();
  if (incoming.length > 0) {
    const rows = await db
      .select({
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        payeeKey: transactions.payeeKey,
        banked: sql<boolean>`exists (
          select 1 from ${transactionExternalIds} x
          where x.transaction_id = ${transactions.id} and x.kind = 'fitid'
        )`,
      })
      .from(transactions)
      .where(eq(transactions.accountId, accountId));

    for (const row of rows) {
      const key = `${Number(row.amountCents)}|${row.payeeKey}`;
      const candidate = { id: row.id, date: row.date, banked: row.banked };
      const list = lookAlikes.get(key);
      if (list) list.push(candidate);
      else lookAlikes.set(key, [candidate]);
    }
  }
  // Each existing row answers for one new row at most, so a file with four
  // identical charges is matched against four, not one four times.
  const claimedLookAlikes = new Set<string>();

  // Transfer halves in this account that have no bank id yet, so they are still
  // waiting for their own statement to arrive (FR-5).
  const waitingHalves = await unmatchedTransferHalves(db, accountId);
  const claimedHalves = new Set<string>();

  // Standing rules that say a payee is a transfer rather than spending (CA-2).
  const transferRules = await listTransferRules(db);
  const accountNames = new Map(
    (await db.select({ id: accounts.id, name: accounts.name }).from(accounts)).map((row) => [
      row.id,
      row.name,
    ]),
  );

  const rows: ImportRow[] = incoming.map((transaction, index) => {
    const { key: payeeKey } = normalizePayee(transaction.name || transaction.memo || '');

    const existingByFit = transaction.fitId ? knownById.get(transaction.fitId) : undefined;
    if (existingByFit) {
      return {
        index,
        transaction,
        verdict: 'duplicate',
        existingId: existingByFit,
        reason: `Already imported (bank id ${transaction.fitId})`,
      };
    }

    // The other side of a transfer already recorded here. Amount and a near date
    // are the only things the two statements agree on: the descriptions never
    // match, and the posting dates can differ by a day or two.
    const [half] = waitingHalves
      .filter(
        (candidate) =>
          !claimedHalves.has(candidate.id) &&
          candidate.amountCents === transaction.amountCents &&
          daysApart(candidate.date, transaction.posted) <= TRANSFER_DATE_WINDOW_DAYS,
      )
      // Nearest date wins, so a monthly payment of the same amount matches this
      // month's half rather than whichever was found first.
      .sort(
        (left, right) =>
          daysApart(left.date, transaction.posted) - daysApart(right.date, transaction.posted),
      );
    if (half) {
      claimedHalves.add(half.id);
      return {
        index,
        transaction,
        verdict: 'transfer_half',
        existingId: half.id,
        reason:
          `The other side of the transfer recorded as "${half.payeeRaw}" on ${half.date}. ` +
          'Linking attaches this statement\'s id to it rather than recording the money twice.',
      };
    }

    // Nearest date first, so this month's copy is matched rather than whichever
    // was found first.
    const [lookAlike] = (lookAlikes.get(`${transaction.amountCents}|${payeeKey}`) ?? [])
      .filter(
        (candidate) =>
          !claimedLookAlikes.has(candidate.id) &&
          daysApart(candidate.date, transaction.posted) <=
            (candidate.banked ? 0 : LOOKALIKE_WINDOW_DAYS),
      )
      .sort(
        (left, right) =>
          daysApart(left.date, transaction.posted) - daysApart(right.date, transaction.posted),
      );
    if (lookAlike) {
      claimedLookAlikes.add(lookAlike.id);
      const gap = daysApart(lookAlike.date, transaction.posted);
      return {
        index,
        transaction,
        verdict: 'possible_duplicate',
        existingId: lookAlike.id,
        reason:
          `Same amount and payee as a transaction ${
            gap === 0 ? 'on the same day' : `dated ${lookAlike.date}`
          } and no shared bank id. Could be a genuine repeat, or the same transaction ` +
          'recorded before - from another source, which dates things when they were entered, ' +
          'or from this bank under an id it has since changed.',
      };
    }

    const payeeRaw = transaction.name || transaction.memo || '';
    const rule = matchTransferRule(transferRules, {
      payeeRaw,
      amountCents: transaction.amountCents,
      accountId,
    });

    if (rule) {
      const name = accountNames.get(rule.transferAccountId) ?? 'another account';
      return {
        index,
        transaction,
        verdict: 'new',
        reason: `Your rule: "${rule.contains}" means a transfer to ${name}, not spending`,
        transferTo: { accountId: rule.transferAccountId, name },
      };
    }

    return { index, transaction, verdict: 'new', reason: 'Not seen before' };
  });

  let aiNote: string | undefined;

  if (options.categorize !== false) {
    const built = await buildCategorizer(db, { useAi: options.useAi });
    const { categorizer } = built;
    const fresh = rows.filter((row) => row.verdict === 'new' && !row.transferTo);
    const suggestions = await categorizer.suggestAll(
      fresh.map((row) => ({
        date: row.transaction.posted,
        payeeRaw: row.transaction.name || row.transaction.memo || '',
        amountCents: row.transaction.amountCents,
        account: accountId,
      })),
    );
    fresh.forEach((row, position) => {
      row.suggestion = suggestions[position];
    });

    // Remember what the model said, keyed by merchant, so the same merchant is
    // never paid for twice (section 5's cost controls).
    if (built.ai && built.ai.fresh.size > 0) {
      await rememberAnswers(db, built.ai.fresh, AI_MODEL);
    }
    aiNote = built.ai?.stopped ?? built.aiOff ?? undefined;

    // FR-28: income lands in the income pool and waits there to be allocated.
    // The categorizer is left alone for this on purpose - it is measured against
    // held-out history, and a rule about which envelope income belongs in is a
    // property of the app, not of how well the model predicts. History still wins
    // where it has an opinion: a refund at a known merchant belongs where that
    // merchant's spending goes, not in the pool.
    const unplacedIncome = fresh.filter(
      (row) => row.transaction.amountCents > 0 && !row.suggestion?.envelope,
    );
    if (unplacedIncome.length > 0) {
      const pool = await unallocatedEnvelope(db);
      for (const row of unplacedIncome) {
        row.suggestion = {
          envelope: pool.id,
          confidence: 1,
          layer: 'rule',
          reason: `Income, held in ${pool.name} until you allocate it`,
          alternatives: [],
        };
      }
    }
  }

  const counts: Record<RowVerdict, number> = {
    new: rows.filter((row) => row.verdict === 'new').length,
    duplicate: rows.filter((row) => row.verdict === 'duplicate').length,
    possible_duplicate: rows.filter((row) => row.verdict === 'possible_duplicate').length,
    transfer_half: rows.filter((row) => row.verdict === 'transfer_half').length,
  };

  let balanceCheck: BalanceCheck | undefined;
  if (statement.ledgerBalanceCents !== undefined) {
    const existingTotal = await accountTotal(db, accountId);
    const incomingTotal = rows
      .filter((row) => row.verdict === 'new')
      .reduce((sum, row) => sum + row.transaction.amountCents, 0);
    const projectedCents = existingTotal + incomingTotal;

    balanceCheck = {
      statedCents: statement.ledgerBalanceCents,
      ...(statement.ledgerBalanceAsOf ? { asOf: statement.ledgerBalanceAsOf } : {}),
      projectedCents,
      matches: projectedCents === statement.ledgerBalanceCents,
    };
  }

  return {
    accountId,
    accountName: account.name,
    rows,
    counts,
    balanceCheck,
    ...(aiNote ? { aiNote } : {}),
  };
}

async function accountTotal(db: Database, accountId: string): Promise<number> {
  const rows = await db
    .select({ amountCents: transactions.amountCents })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  return rows.reduce((sum, row) => sum + Number(row.amountCents), 0);
}

/** What the user chose to do with each row of the preview. */
export type RowDecision =
  /** Create a new transaction. */
  | { action: 'add' }
  /** Leave it out entirely. */
  | { action: 'skip' }
  /**
   * Treat it as the existing transaction and attach the bank's id to it, so a
   * future import recognises it (MG-9).
   */
  | { action: 'link'; transactionId: string };

export type CommitResult = {
  batchId: string;
  added: number;
  linked: number;
  skipped: number;
};

/**
 * Write the accepted rows in one database transaction (NF-2). Re-running the
 * same file afterwards produces a preview with zero new rows, which is FR-11.
 */
export async function commitImport(
  db: Database,
  preview: ImportPreview,
  decisions: Map<number, RowDecision>,
  meta: { filename?: string } = {},
): Promise<CommitResult> {
  const defaultFor = (row: ImportRow): RowDecision => {
    if (row.verdict === 'new') return { action: 'add' };
    // A transfer half defaults to linking: the money is already recorded, and
    // what this statement adds is the bank's id for it.
    if (row.verdict === 'transfer_half' && row.existingId) {
      return { action: 'link', transactionId: row.existingId };
    }
    return { action: 'skip' };
  };

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(importBatches)
      .values({
        source: 'file_import',
        filename: meta.filename ?? null,
        accountId: preview.accountId,
        // A checkpoint needs its day; a balance with no date says nothing about
        // when the books agreed.
        ...(preview.balanceCheck?.asOf
          ? {
              statedBalanceCents: preview.balanceCheck.statedCents,
              statedBalanceAsOf: preview.balanceCheck.asOf,
            }
          : {}),
      })
      .returning({ id: importBatches.id });

    const batchId = batch!.id;
    let added = 0;
    let linked = 0;
    let skipped = 0;

    for (const row of preview.rows) {
      const decision = decisions.get(row.index) ?? defaultFor(row);

      if (decision.action === 'skip') {
        skipped += 1;
        continue;
      }

      if (decision.action === 'link') {
        if (row.transaction.fitId) {
          await tx
            .insert(transactionExternalIds)
            .values({
              transactionId: decision.transactionId,
              accountId: preview.accountId,
              kind: 'fitid',
              value: row.transaction.fitId,
            })
            .onConflictDoNothing();
        }
        linked += 1;
        continue;
      }

      const payeeRaw = row.transaction.name || row.transaction.memo || '(no description)';

      // A rule said this payee is money moving between the user's own accounts.
      // Both halves are written, no envelope line is created, and it does not
      // join the review queue: there is nothing left to decide (FR-5, CA-2).
      if (row.transferTo) {
        const pairId = crypto.randomUUID();
        const [outgoing] = await tx
          .insert(transactions)
          .values([
            {
              accountId: preview.accountId,
              date: row.transaction.posted,
              amountCents: row.transaction.amountCents,
              payeeRaw,
              payeeKey: normalizePayee(payeeRaw).key,
              memo: row.transaction.memo ?? null,
              kind: 'account_transfer' as const,
              status: 'confirmed' as const,
              source: 'file_import' as const,
              importBatchId: batchId,
              transferPairId: pairId,
            },
            {
              accountId: row.transferTo.accountId,
              date: row.transaction.posted,
              amountCents: -row.transaction.amountCents,
              payeeRaw,
              payeeKey: normalizePayee(payeeRaw).key,
              kind: 'account_transfer' as const,
              status: 'confirmed' as const,
              source: 'file_import' as const,
              importBatchId: batchId,
              transferPairId: pairId,
            },
          ])
          .returning({ id: transactions.id });

        if (row.transaction.fitId) {
          await tx.insert(transactionExternalIds).values({
            transactionId: outgoing!.id,
            accountId: preview.accountId,
            kind: 'fitid',
            value: row.transaction.fitId,
          });
        }

        added += 1;
        continue;
      }

      const [created] = await tx
        .insert(transactions)
        .values({
          accountId: preview.accountId,
          date: row.transaction.posted,
          amountCents: row.transaction.amountCents,
          payeeRaw,
          payeeKey: normalizePayee(payeeRaw).key,
          memo: row.transaction.memo ?? null,
          checkNumber: row.transaction.checkNumber ?? null,
          kind: 'spending',
          // FR-12: everything arrives awaiting review, however confident we are.
          status: 'pending_review',
          source: 'file_import',
          importBatchId: batchId,
        })
        .returning({ id: transactions.id });

      const transactionId = created!.id;

      if (row.transaction.fitId) {
        await tx.insert(transactionExternalIds).values({
          transactionId,
          accountId: preview.accountId,
          kind: 'fitid',
          value: row.transaction.fitId,
        });
      }

      const suggestion = row.suggestion;
      if (suggestion?.envelope) {
        await tx.insert(suggestionsTable).values({
          transactionId,
          envelopeId: suggestion.envelope,
          layer: suggestion.layer === 'none' ? 'history' : suggestion.layer,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
        });

        /*
         * A suggestion worth believing is applied straight away, so the envelope
         * screen is useful before anything has been reviewed (RQ-4);
         * `pending_review` is what marks it unconfirmed.
         *
         * Only from the medium band up. Below that the suggestion is a guess -
         * "67 of 482 past e-transfers went to Elementry" is 23% sure and was
         * moving $1,265 into an envelope on that basis. The proposal is still
         * recorded and still offered in the queue; what it no longer does is
         * quietly change a balance nobody has agreed to. Money on a row like
         * that is unassigned, which is a state the ledger already understands
         * and the dashboard already reports.
         */
        if (bandOf(suggestion.confidence) !== 'low') {
          await tx.insert(txnLines).values({
            transactionId,
            envelopeId: suggestion.envelope,
            amountCents: row.transaction.amountCents,
          });
        }
      }

      added += 1;
    }

    await tx
      .update(importBatches)
      .set({ addedCount: added, duplicateCount: skipped })
      .where(eq(importBatches.id, batchId));

    return { batchId, added, linked, skipped };
  });
}

/** FR-13: undo a whole import. */
export async function revertImport(db: Database, batchId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.importBatchId, batchId));

    if (rows.length > 0) {
      // Lines, external ids and suggestions cascade from the transaction.
      await tx.delete(transactions).where(eq(transactions.importBatchId, batchId));
    }

    await tx
      .update(importBatches)
      .set({ revertedAt: new Date() })
      .where(eq(importBatches.id, batchId));

    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// The import log (FR-13)
// ---------------------------------------------------------------------------

export type ImportRecord = {
  id: string;
  filename: string | null;
  accountName: string | null;
  addedCount: number;
  duplicateCount: number;
  createdAt: Date;
  revertedAt: Date | null;
  /** How many of its transactions are still here, so undo can say what it will do. */
  remaining: number;
};

/** What has been imported, newest first, with an honest count of what survives. */
export async function importHistory(
  db: Database,
  options: { limit?: number } = {},
): Promise<ImportRecord[]> {
  const rows = await db
    .select({
      id: importBatches.id,
      filename: importBatches.filename,
      accountName: accounts.name,
      addedCount: importBatches.addedCount,
      duplicateCount: importBatches.duplicateCount,
      createdAt: importBatches.createdAt,
      revertedAt: importBatches.revertedAt,
      remaining: sql<string>`count(${transactions.id})`,
    })
    .from(importBatches)
    .leftJoin(accounts, eq(accounts.id, importBatches.accountId))
    .leftJoin(transactions, eq(transactions.importBatchId, importBatches.id))
    .groupBy(
      importBatches.id,
      importBatches.filename,
      accounts.name,
      importBatches.addedCount,
      importBatches.duplicateCount,
      importBatches.createdAt,
      importBatches.revertedAt,
    )
    .orderBy(desc(importBatches.createdAt))
    .limit(options.limit ?? 20);

  return rows.map((row) => ({ ...row, remaining: Number(row.remaining) }));
}

// ---------------------------------------------------------------------------
// Balance checkpoints (FR-14)
// ---------------------------------------------------------------------------

export type BalanceCheckpoint = {
  /** The day the statement's balance was as of. */
  asOf: string;
  /** What the bank said the account held. */
  statedCents: number;
  /** What the ledger says it held at the end of that day. */
  ledgerCents: number;
  /** Ledger less bank: zero when they agree. */
  differenceCents: number;
  /**
   * How much the difference moved since the checkpoint before this one. Non-zero
   * means something between those two days is wrong, which is what narrows a
   * search from "somewhere in six years" to "somewhere in these few weeks".
   */
  changeCents: number | null;
  /** The earlier checkpoint's day, so the window can be opened as a filter. */
  previousAsOf: string | null;
};

/**
 * Every balance a statement has stated for this account, against the ledger's
 * balance on the same day, oldest first.
 *
 * Every statement imported leaves one, including a statement imported again
 * that added nothing - which is how old files can fill in history. Undoing an
 * import does not remove its checkpoint: what the bank said is still what it
 * said. The same day and figure stated twice is one checkpoint.
 */
export async function balanceCheckpoints(
  db: Database,
  accountId: string,
): Promise<BalanceCheckpoint[]> {
  const rows = await db.execute<{ as_of: string; stated: string; ledger: string }>(sql`
    select distinct on (b.stated_balance_as_of, b.stated_balance_cents)
      b.stated_balance_as_of::text as as_of,
      b.stated_balance_cents as stated,
      coalesce((
        select sum(t.amount_cents) from transactions t
        where t.account_id = ${accountId} and t.date <= b.stated_balance_as_of
      ), 0) as ledger
    from import_batches b
    where b.account_id = ${accountId}
      and b.stated_balance_cents is not null
      and b.stated_balance_as_of is not null
    order by b.stated_balance_as_of, b.stated_balance_cents
  `);

  let previous: { asOf: string; differenceCents: number } | null = null;
  return rows.map((row) => {
    const statedCents = Number(row.stated);
    const ledgerCents = Number(row.ledger);
    const differenceCents = ledgerCents - statedCents;
    const checkpoint: BalanceCheckpoint = {
      asOf: row.as_of,
      statedCents,
      ledgerCents,
      differenceCents,
      changeCents: previous ? differenceCents - previous.differenceCents : null,
      previousAsOf: previous?.asOf ?? null,
    };
    previous = { asOf: row.as_of, differenceCents };
    return checkpoint;
  });
}

export type StatementMismatch = {
  accountId: string;
  accountName: string;
  asOf: string;
  /** Ledger less bank, on the day of the account's latest statement. */
  differenceCents: number;
};

/**
 * Live accounts whose latest statement disagrees with the ledger on its day.
 *
 * Only the latest: an old gap that has since closed is history, and the account's
 * own list shows every checkpoint. One query for every account, since this runs
 * with the notices on every main screen.
 */
export async function statementMismatches(db: Database): Promise<StatementMismatch[]> {
  const rows = await db.execute<{
    account_id: string;
    name: string;
    as_of: string;
    stated: string;
    ledger: string;
  }>(sql`
    select latest.account_id, latest.name, latest.as_of, latest.stated,
      coalesce((
        select sum(t.amount_cents) from transactions t
        where t.account_id = latest.account_id and t.date <= latest.as_of::date
      ), 0) as ledger
    from (
      select distinct on (b.account_id)
        b.account_id, a.name, b.stated_balance_as_of::text as as_of,
        b.stated_balance_cents as stated
      from import_batches b
      join accounts a on a.id = b.account_id
      where b.stated_balance_cents is not null
        and b.stated_balance_as_of is not null
        and a.archived_at is null
      order by b.account_id, b.stated_balance_as_of desc, b.created_at desc
    ) latest
  `);

  return rows
    .map((row) => ({
      accountId: row.account_id,
      accountName: row.name,
      asOf: row.as_of,
      differenceCents: Number(row.ledger) - Number(row.stated),
    }))
    .filter((row) => row.differenceCents !== 0)
    .sort((left, right) => left.accountName.localeCompare(right.accountName));
}
