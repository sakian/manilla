/**
 * A waiting row that is a second record of a transaction already here (FR-18).
 *
 * The importer links the same bank entry arriving from a second source
 * (`same_entry`) and the other side of a transfer (`transfer_half`), but only
 * on what it can see: amount, date and wording. When those disagree more than
 * it allows, the second record comes in as new, and reviewing it as spending
 * would count the money twice. So review offers the match a person can see
 * and the importer couldn't.
 *
 * Offered, never applied, like a transfer pairing: two equal amounts in one
 * account a few days apart can just as well be two purchases.
 */

import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.ts';
import { transactionExternalIds, transactionMessages, transactions } from '../../db/schema.ts';

export class DuplicateError extends Error {}

export type DuplicateCandidate = {
  /** The waiting row this is about. */
  transactionId: string;
  /** The transaction already here that it looks like a second record of. */
  existingId: string;
  existingDate: string;
  existingPayee: string;
  existingIsTransfer: boolean;
};

/** How far apart two records of one entry may be dated: a card's posting lags its purchase. */
const DUPLICATE_WINDOW_DAYS = 6;

/**
 * Two records that each carry an id of the same kind came from the same
 * source as two separate entries, so they are two transactions, not one. Ex:
 * two $78.35 Amazon charges on one day, both from the bank feed.
 */
const sharesIdKind = (left: SQL, right: SQL) => sql`exists (
  select 1 from transaction_external_ids a
  join transaction_external_ids b on b.kind = a.kind
  where a.transaction_id = ${left} and b.transaction_id = ${right}
)`;

export async function duplicateCandidates(
  db: Database,
  options: { importBatchId?: string } = {},
): Promise<DuplicateCandidate[]> {
  const existing = alias(transactions, 'existing');

  const rows = await db
    .select({
      transactionId: transactions.id,
      existingId: existing.id,
      existingDate: existing.date,
      existingPayee: existing.payeeRaw,
      existingKind: existing.kind,
      existingStatus: existing.status,
      gap: sql<number>`abs(${existing.date} - ${transactions.date})`,
    })
    .from(transactions)
    .innerJoin(
      existing,
      and(
        eq(existing.accountId, transactions.accountId),
        eq(existing.amountCents, transactions.amountCents),
        sql`${existing.id} <> ${transactions.id}`,
        sql`abs(${existing.date} - ${transactions.date}) <= ${DUPLICATE_WINDOW_DAYS}`,
        sql`not ${sharesIdKind(sql`"transactions"."id"`, sql`"existing"."id"`)}`,
      )!,
    )
    .where(
      and(
        eq(transactions.status, 'pending_review'),
        eq(transactions.kind, 'spending'),
        sql`${transactions.amountCents} <> 0`,
        ...(options.importBatchId ? [eq(transactions.importBatchId, options.importBatchId)] : []),
      ),
    )
    .orderBy(asc(transactions.id))
    .limit(500);

  // One per row: a reviewed transaction before another waiting one, since
  // that's the record someone has already vouched for, then the nearest date.
  const best = new Map<string, (typeof rows)[number]>();
  const rank = (row: (typeof rows)[number]) => [row.existingStatus === 'confirmed' ? 0 : 1, Number(row.gap)];
  for (const row of rows) {
    const current = best.get(row.transactionId);
    const [status, gap] = rank(row);
    const [currentStatus, currentGap] = current ? rank(current) : [Infinity, Infinity];
    if (status! < currentStatus! || (status === currentStatus && gap! < currentGap!)) {
      best.set(row.transactionId, row);
    }
  }

  return [...best.values()].map((row) => ({
    transactionId: row.transactionId,
    existingId: row.existingId,
    existingDate: row.existingDate,
    existingPayee: row.existingPayee,
    existingIsTransfer: row.existingKind === 'account_transfer',
  }));
}

/**
 * Fold a waiting row into the transaction it's a second record of.
 *
 * Its bank ids move to the one kept, so neither source brings it in again, and
 * so does anything written about it. Then it's deleted: it was never money of
 * its own, and the audit trail records who removed it (NF-2). The kept
 * transaction is left as it is, envelope and all.
 */
export async function mergeDuplicate(
  db: Database,
  duplicateId: string,
  keepId: string,
): Promise<void> {
  if (duplicateId === keepId) throw new DuplicateError('A transaction is not a duplicate of itself');

  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      status: transactions.status,
    })
    .from(transactions)
    .where(inArray(transactions.id, [duplicateId, keepId]));

  const duplicate = rows.find((row) => row.id === duplicateId);
  const keep = rows.find((row) => row.id === keepId);
  if (!duplicate || !keep) throw new DuplicateError('Both transactions have to exist to merge them');
  if (duplicate.status !== 'pending_review') {
    throw new DuplicateError('Only a transaction still waiting for review can be merged away');
  }
  if (duplicate.accountId !== keep.accountId) {
    throw new DuplicateError('Two records of one transaction are in the same account');
  }
  if (Number(duplicate.amountCents) !== Number(keep.amountCents)) {
    throw new DuplicateError('Two records of one transaction have the same amount');
  }

  await db.transaction(async (tx) => {
    const [clash] = await tx.execute<{ clash: boolean }>(
      sql`select ${sharesIdKind(sql`${duplicateId}::uuid`, sql`${keepId}::uuid`)} as clash`,
    );
    if (clash?.clash) {
      throw new DuplicateError(
        'Both came from the same source as separate entries, so they are two transactions',
      );
    }

    await tx
      .update(transactionExternalIds)
      .set({ transactionId: keepId })
      .where(eq(transactionExternalIds.transactionId, duplicateId));
    await tx
      .update(transactionMessages)
      .set({ transactionId: keepId })
      .where(eq(transactionMessages.transactionId, duplicateId));
    await tx.delete(transactions).where(eq(transactions.id, duplicateId));
  });
}
