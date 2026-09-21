/**
 * The review queue (RQ-1 to RQ-6).
 *
 * Phase 0 measured that only about 16% of transactions can be auto-confirmed
 * safely and roughly 28% of suggestions need correcting, so nearly everything
 * passes under the user's eye. That makes this screen the most important one in
 * the app, and speed its main design goal: every row arrives with a suggestion
 * already applied, and confirming or changing it is meant to be one keystroke.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  envelopeGroups,
  envelopes,
  rules,
  suggestions,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { bandOf, type Band } from '../categorize/pipeline.ts';
import { normalizePayee } from '../categorize/normalize.ts';
import { setTransactionEnvelopes } from '../ledger/ledger.ts';

export type QueueRow = {
  id: string;
  date: string;
  payeeRaw: string;
  payeeDisplay: string;
  amountCents: number;
  accountName: string;
  memo: string | null;
  envelopeId: string | null;
  envelopeName: string | null;
  confidence: number | null;
  reason: string | null;
  band: Band | null;
  /** Days the row has been waiting, for the age indicator (RQ-6). */
  ageDays: number;
};

export type EnvelopeOption = {
  id: string;
  name: string;
  groupName: string;
};

/**
 * Everything awaiting review, newest first (RQ-1).
 *
 * `importBatchId` narrows it to one import, which is what the screen after an
 * import shows: the same queue, looking only at what just arrived.
 */
export async function pendingTransactions(
  db: Database,
  options: { limit?: number; importBatchId?: string } = {},
): Promise<QueueRow[]> {
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      amountCents: transactions.amountCents,
      memo: transactions.memo,
      accountName: accounts.name,
      createdAt: transactions.createdAt,
      envelopeId: txnLines.envelopeId,
      envelopeName: envelopes.name,
      confidence: suggestions.confidence,
      reason: suggestions.reason,
    })
    .from(transactions)
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .leftJoin(txnLines, eq(txnLines.transactionId, transactions.id))
    .leftJoin(envelopes, eq(txnLines.envelopeId, envelopes.id))
    .leftJoin(suggestions, eq(suggestions.transactionId, transactions.id))
    .where(
      and(
        eq(transactions.status, 'pending_review'),
        eq(transactions.kind, 'spending'),
        ...(options.importBatchId
          ? [eq(transactions.importBatchId, options.importBatchId)]
          : []),
      ),
    )
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(options.limit ?? 200);

  const today = Date.now();

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    payeeRaw: row.payeeRaw,
    payeeDisplay: normalizePayee(row.payeeRaw).display,
    amountCents: Number(row.amountCents),
    accountName: row.accountName,
    memo: row.memo,
    envelopeId: row.envelopeId,
    envelopeName: row.envelopeName,
    confidence: row.confidence,
    reason: row.reason,
    band: row.confidence === null ? null : bandOf(row.confidence),
    ageDays: Math.floor((today - row.createdAt.getTime()) / 86_400_000),
  }));
}

export async function pendingCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::bigint` })
    .from(transactions)
    .where(and(eq(transactions.status, 'pending_review'), eq(transactions.kind, 'spending')));
  return Number(row?.count ?? 0);
}

/** Envelope picker options, grouped and ordered as the user arranged them. */
export async function envelopeOptions(db: Database): Promise<EnvelopeOption[]> {
  const rows = await db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      groupName: envelopeGroups.name,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .where(sql`${envelopes.archivedAt} is null`)
    .orderBy(envelopeGroups.position, envelopeGroups.name, envelopes.name);

  return rows;
}

/**
 * Confirm rows as they stand (RQ-2). A row with no envelope cannot be
 * confirmed: confirming would assert an answer nobody has given.
 */
export async function confirmTransactions(db: Database, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  const assigned = await db
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(txnLines, eq(txnLines.transactionId, transactions.id))
    .where(inArray(transactions.id, ids));

  const confirmable = [...new Set(assigned.map((row) => row.id))];
  if (confirmable.length === 0) return 0;

  await db
    .update(transactions)
    .set({ status: 'confirmed', updatedAt: new Date() })
    .where(inArray(transactions.id, confirmable));

  // Record what was accepted, so suggestion accuracy stays measurable.
  // A split has several lines; the first is enough here, because a suggestion
  // only ever proposes a single envelope.
  await db
    .update(suggestions)
    .set({
      acceptedEnvelopeId: sql`(
        select l.envelope_id from txn_lines l
        where l.transaction_id = ${suggestions.transactionId}
        limit 1
      )`,
    })
    .where(inArray(suggestions.transactionId, confirmable));

  return confirmable.length;
}

/**
 * Every pending row whose suggestion is in the auto-confirmable band.
 *
 * No screen calls this: the queue asks you to look at each row rather than
 * offering to settle a batch unseen, which is what the measurement actually
 * supports - 0.95 auto-confirms about 16% of transactions, so a bulk button was
 * always going to leave most of the work still to do. It stays because "which of
 * these would a machine bet on" is a question the accuracy report may want.
 */
export async function highConfidenceIds(db: Database): Promise<string[]> {
  const rows = await pendingTransactions(db, { limit: 1000 });
  return rows.filter((row) => row.band === 'high' && row.envelopeId).map((row) => row.id);
}

export type ReviewDecision = {
  transactionId: string;
  envelopeId: string;
  /** CA-2: turn this decision into a standing rule for the payee. */
  createRule?: boolean;
};

export type ReviewResult = {
  confirmed: number;
  /** Rows that could not be saved, so a partial save is reported rather than hidden. */
  failed: { transactionId: string; error: string }[];
};

/**
 * Save a sitting's worth of decisions (RQ-2, RQ-3, RQ-5).
 *
 * The queue is a staging area: you go down the list marking rows, and nothing is
 * written until you save. That is a different bargain from confirming each row as
 * you touch it - you can change your mind about the fourth one after seeing the
 * ninth, and a half-finished sitting leaves the ledger exactly as it was.
 *
 * Each decision is applied on its own rather than inside one transaction, and
 * whatever fails is named. One row failing - an envelope archived in another tab,
 * say - should not throw away twelve good decisions, and silently succeeding at
 * eleven of twelve would be worse than either.
 */
export async function saveReview(
  db: Database,
  decisions: ReviewDecision[],
): Promise<ReviewResult> {
  const failed: ReviewResult['failed'] = [];
  let confirmed = 0;

  for (const decision of decisions) {
    try {
      await recategorize(db, {
        transactionId: decision.transactionId,
        envelopeId: decision.envelopeId,
        confirm: true,
        ...(decision.createRule ? { createRule: true } : {}),
      });
      confirmed += 1;
    } catch (error) {
      failed.push({
        transactionId: decision.transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { confirmed, failed };
}

export type Recategorization = {
  transactionId: string;
  envelopeId: string;
  confirm?: boolean;
  /** CA-2: turn this correction into a standing rule in one click. */
  createRule?: boolean;
};

/** Change a row's envelope, optionally confirming and learning from it (RQ-3, RQ-5). */
export async function recategorize(db: Database, input: Recategorization): Promise<void> {
  const [transaction] = await db
    .select({ amountCents: transactions.amountCents, payeeKey: transactions.payeeKey })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .limit(1);

  if (!transaction) throw new Error(`No such transaction: ${input.transactionId}`);

  await setTransactionEnvelopes(
    db,
    input.transactionId,
    [{ envelopeId: input.envelopeId, amountCents: Number(transaction.amountCents) }],
    { confirm: input.confirm ?? true },
  );

  if (input.createRule && transaction.payeeKey) {
    await db
      .insert(rules)
      .values({ contains: transaction.payeeKey, envelopeId: input.envelopeId })
      .onConflictDoNothing();
  }
}

/** Split one transaction across several envelopes (FR-4). */
export async function splitTransaction(
  db: Database,
  transactionId: string,
  parts: { envelopeId: string; amountCents: number }[],
  options: { confirm?: boolean } = {},
): Promise<void> {
  await setTransactionEnvelopes(db, transactionId, parts, {
    confirm: options.confirm ?? true,
  });
}
