/**
 * One sync of a bank connection (FR-16 to FR-19).
 *
 * Each linked account is fetched under its own cursor and taken through the
 * import (FR-17): matched against what is already here - a statement file's
 * rows included (FR-18) - categorized, and written as an import batch that
 * waits in the review queue and can be undone whole.
 *
 * Only posted transactions are imported. A pending charge is the bank's
 * provisional record - its amount can change when it posts, or it can vanish -
 * so it is left until it posts, and a posting is then an ordinary new row
 * (FR-19).
 *
 * What a person would have to decide is held rather than decided for them
 * (sync_held_rows), since nobody sees a sync's preview and its cursor moves on
 * regardless: a look-alike, an amount that had to be rounded, a change to a
 * transaction already imported, or one the bank no longer reports.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  bankConnections,
  bankFeedAccounts,
  syncHeldRows,
  transactionExternalIds,
  transactions,
} from '../../db/schema.ts';
import { formatCents } from '../money.ts';
import { commitImport, previewImport, type ImportPreview } from '../import/ofxImport.ts';
import type { OfxTransaction } from '../ofx/parse.ts';
import { PlaidDataError, type PlaidTransaction } from './plaid.ts';
import { PlaidApiError, syncTransactions, type PlaidCall } from './plaidClient.ts';
import { decryptSecret } from './secret.ts';

export type HeldReason = 'possible_duplicate' | 'rounded' | 'changed' | 'withdrawn';

export type AccountSyncReport = {
  feedAccountId: string;
  accountId: string;
  name: string;
  added: number;
  linked: number;
  held: number;
  /** Dated before the feed's start, so already here or before the account began. */
  earlier: number;
  /** Plaid is still gathering the bank's transactions; nothing came this time. */
  notReady: boolean;
  batchId?: string;
};

export type SyncReport = {
  connectionId: string;
  accounts: AccountSyncReport[];
  /** Why it stopped. Accounts synced before the failure keep what they got. */
  error?: { code: string; message: string };
};

type Held = {
  reason: HeldReason;
  externalId: string;
  date: string;
  amountCents: number;
  payeeRaw: string;
  transactionId?: string;
  detail: string;
};

/** A posted Plaid transaction as an import row: Plaid's id stands where a FITID would. */
function asImportRow(transaction: PlaidTransaction): OfxTransaction {
  return {
    fitId: transaction.id,
    type: transaction.amountCents < 0 ? 'DEBIT' : 'CREDIT',
    posted: transaction.date,
    amountCents: transaction.amountCents,
    name: transaction.description,
    warnings: transaction.warnings,
  };
}

function heldFrom(transaction: PlaidTransaction, reason: HeldReason, detail: string, transactionId?: string): Held {
  return {
    reason,
    externalId: transaction.id,
    date: transaction.date,
    amountCents: transaction.amountCents,
    payeeRaw: transaction.description,
    ...(transactionId ? { transactionId } : {}),
    detail,
  };
}

export async function syncConnection(
  db: Database,
  connectionId: string,
  deps: { call: PlaidCall; key: Buffer; account?: Database; now?: () => Date },
): Promise<SyncReport> {
  const now = deps.now ?? (() => new Date());
  const [connection] = await db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  if (!connection) throw new Error(`No such bank connection: ${connectionId}`);
  if (connection.revokedAt || !connection.accessToken) {
    return { connectionId, accounts: [], error: { code: 'REVOKED', message: 'This connection was revoked' } };
  }

  await db.update(bankConnections).set({ lastAttemptAt: now() }).where(eq(bankConnections.id, connectionId));
  const token = decryptSecret(connection.accessToken, deps.key);

  const feeds = await db
    .select()
    .from(bankFeedAccounts)
    .where(and(eq(bankFeedAccounts.connectionId, connectionId), isNotNull(bankFeedAccounts.accountId)));

  const report: SyncReport = { connectionId, accounts: [] };
  for (const feed of feeds) {
    try {
      report.accounts.push(await syncFeed(db, feed as typeof feed & { accountId: string }, token, deps));
    } catch (error) {
      if (!(error instanceof PlaidApiError || error instanceof PlaidDataError)) throw error;
      // The login, not the account, is what failed - ITEM_LOGIN_REQUIRED and
      // the like - so the other accounts on it would fail the same way. A
      // response that could not be read is kept the same way, so it shows on
      // the connection rather than only in a log.
      const code = error instanceof PlaidApiError ? error.code : 'UNREADABLE_RESPONSE';
      report.error = { code, message: error.message };
      await db
        .update(bankConnections)
        .set({ errorCode: code, errorMessage: error.message })
        .where(eq(bankConnections.id, connectionId));
      return report;
    }
  }

  // Not "synced" while Plaid is still gathering: the screen says how old the
  // data is, and there is none yet.
  const waiting = report.accounts.some((account) => account.notReady);
  await db
    .update(bankConnections)
    .set({ ...(waiting ? {} : { lastSyncedAt: now() }), errorCode: null, errorMessage: null })
    .where(eq(bankConnections.id, connectionId));
  return report;
}

async function syncFeed(
  db: Database,
  feed: typeof bankFeedAccounts.$inferSelect & { accountId: string },
  token: string,
  deps: { call: PlaidCall; account?: Database },
): Promise<AccountSyncReport> {
  const result = await syncTransactions(deps.call, token, feed.cursor ?? undefined, {
    accountId: feed.providerAccountId,
  });
  if (result.notReady) {
    return {
      feedAccountId: feed.id,
      accountId: feed.accountId,
      name: feed.name,
      added: 0,
      linked: 0,
      held: 0,
      earlier: 0,
      notReady: true,
    };
  }

  const posted = result.added.filter((t) => !t.pending);
  const added = posted.filter((t) => !feed.startDate || t.date >= feed.startDate);
  const modified = result.modified.filter((t) => !t.pending);

  // Which of the changed and removed ids are transactions already here. A
  // removal of anything else is a pending charge that was never imported.
  const touched = [...modified.map((t) => t.id), ...result.removed.map((r) => r.id)];
  const known = new Map<string, { id: string; date: string; amountCents: number; payeeRaw: string }>();
  if (touched.length > 0) {
    const rows = await db
      .select({
        value: transactionExternalIds.value,
        id: transactions.id,
        date: transactions.date,
        amountCents: transactions.amountCents,
        payeeRaw: transactions.payeeRaw,
      })
      .from(transactionExternalIds)
      .innerJoin(transactions, eq(transactions.id, transactionExternalIds.transactionId))
      .where(
        and(
          eq(transactionExternalIds.accountId, feed.accountId),
          eq(transactionExternalIds.kind, 'aggregator'),
          inArray(transactionExternalIds.value, touched),
        ),
      );
    for (const row of rows) known.set(row.value, { ...row, amountCents: Number(row.amountCents) });
  }

  const held: Held[] = [];
  const toImport: PlaidTransaction[] = [];

  // A change to one never seen is just a transaction arriving late.
  for (const transaction of [...added, ...modified.filter((t) => !known.has(t.id))]) {
    if (transaction.warnings.length > 0) {
      held.push(heldFrom(transaction, 'rounded', transaction.warnings.join('; ')));
    } else {
      toImport.push(transaction);
    }
  }

  for (const transaction of modified) {
    const existing = known.get(transaction.id);
    // A new description or merchant name on the same money changes nothing a
    // person decided, so only the amount and the date are worth asking about.
    if (!existing || (existing.amountCents === transaction.amountCents && existing.date === transaction.date)) {
      continue;
    }
    held.push(
      heldFrom(
        transaction,
        'changed',
        `The bank now has this as ${formatCents(transaction.amountCents)} on ${transaction.date}; ` +
          `here it is ${formatCents(existing.amountCents)} on ${existing.date}.`,
        existing.id,
      ),
    );
  }

  for (const removal of result.removed) {
    const existing = known.get(removal.id);
    if (!existing) continue;
    held.push({
      reason: 'withdrawn',
      externalId: removal.id,
      date: existing.date,
      amountCents: existing.amountCents,
      payeeRaw: existing.payeeRaw,
      transactionId: existing.id,
      detail: 'The bank no longer reports this transaction.',
    });
  }

  let preview: ImportPreview | undefined;
  if (toImport.length > 0) {
    preview = await previewImport(
      db,
      { transactions: toImport.map(asImportRow) },
      feed.accountId,
      { source: 'bank_sync', ...(deps.account ? { account: deps.account } : {}) },
    );
    // A look-alike is left out by default; here that would lose it for good.
    for (const row of preview.rows) {
      if (row.verdict !== 'possible_duplicate') continue;
      held.push(heldFrom(toImport[row.index]!, 'possible_duplicate', row.reason, row.existingId));
    }
  }
  const writes = preview?.rows.some((row) => row.verdict !== 'duplicate' && row.verdict !== 'possible_duplicate');

  return db.transaction(async (tx) => {
    const committed = preview && writes ? await commitImport(tx, preview, new Map()) : undefined;

    // A row still waiting from an earlier sync is not asked about twice: the
    // bank resending a look-alike, or changing one again, is the same question.
    const waiting = new Set(
      held.length === 0
        ? []
        : (
            await tx
              .select({ externalId: syncHeldRows.externalId, reason: syncHeldRows.reason })
              .from(syncHeldRows)
              .where(
                and(
                  eq(syncHeldRows.feedAccountId, feed.id),
                  isNull(syncHeldRows.resolvedAt),
                  inArray(syncHeldRows.externalId, held.map((row) => row.externalId)),
                ),
              )
          ).map((row) => `${row.reason}|${row.externalId}`),
    );
    const fresh = held.filter((row) => !waiting.has(`${row.reason}|${row.externalId}`));
    if (fresh.length > 0) {
      await tx.insert(syncHeldRows).values(
        fresh.map((row) => ({ ...row, feedAccountId: feed.id, accountId: feed.accountId })),
      );
    }
    await tx.update(bankFeedAccounts).set({ cursor: result.cursor }).where(eq(bankFeedAccounts.id, feed.id));

    return {
      feedAccountId: feed.id,
      accountId: feed.accountId,
      name: feed.name,
      added: committed?.added ?? 0,
      linked: committed?.linked ?? 0,
      held: fresh.length,
      earlier: posted.length - added.length,
      notReady: false,
      ...(committed ? { batchId: committed.batchId } : {}),
    };
  });
}
