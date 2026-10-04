/**
 * One bank login feeding accounts in more than one ledger.
 *
 * A ledger is a database of its own and shares nothing (LG-2), so a connection
 * lives in each ledger that uses it: a copy holding the same Plaid Item and the
 * same encrypted token, with its own list of accounts, cursors and status.
 * Collecting a sync from two copies costs no second bank login - Plaid fetches
 * from the bank on its own schedule and a sync only collects what it has - and
 * one Item rather than two means Plaid signs in to the bank once, which is one
 * set of one-time codes, and one of Plaid's free connections rather than two.
 *
 * What keeps the copies agreeing:
 *  - an account is fed in one ledger at a time, so choosing it in one frees it
 *    in the others;
 *  - revoking revokes every copy, since Plaid forgets the login for all of them;
 *  - a sync, and signing in again, run every copy, so one press brings each
 *    ledger up to date and clears each one's lapsed login.
 */

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, bankConnections, bankFeedAccounts } from '../../db/schema.ts';
import { ConnectionError, forgetConnection, revokeConnection, setFeedAccount } from './connections.ts';
import type { PlaidCall } from './plaidClient.ts';
import { syncConnection, type SyncReport } from './run.ts';

export type LedgerHandle = { key: string; name: string; db: Database };

type ConnectionRow = typeof bankConnections.$inferSelect;

async function liveCopy(db: Database, itemId: string): Promise<ConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.itemId, itemId), isNull(bankConnections.revokedAt)));
  return row;
}

async function connectionOf(db: Database, connectionId: string): Promise<ConnectionRow> {
  const [row] = await db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  if (!row) throw new ConnectionError('No such connection');
  return row;
}

export type FedElsewhere = {
  ledgerKey: string;
  ledgerName: string;
  accountId: string;
  accountName: string;
  startDate: string | null;
};

/** Key for one bank account across ledgers: the login and the account within it. */
export const feedKey = (itemId: string, providerAccountId: string) => `${itemId}|${providerAccountId}`;

/** Bank accounts of these logins that another ledger feeds, by `feedKey`. */
export async function fedElsewhere(
  current: LedgerHandle,
  all: LedgerHandle[],
  itemIds: string[],
): Promise<Map<string, FedElsewhere>> {
  const found = new Map<string, FedElsewhere>();
  if (itemIds.length === 0) return found;
  for (const ledger of all) {
    if (ledger.key === current.key) continue;
    const rows = await ledger.db
      .select({
        itemId: bankConnections.itemId,
        providerAccountId: bankFeedAccounts.providerAccountId,
        accountId: accounts.id,
        accountName: accounts.name,
        startDate: bankFeedAccounts.startDate,
      })
      .from(bankFeedAccounts)
      .innerJoin(bankConnections, eq(bankConnections.id, bankFeedAccounts.connectionId))
      .innerJoin(accounts, eq(accounts.id, bankFeedAccounts.accountId))
      .where(and(inArray(bankConnections.itemId, itemIds), isNull(bankConnections.revokedAt)));
    for (const row of rows) {
      found.set(feedKey(row.itemId, row.providerAccountId), {
        ledgerKey: ledger.key,
        ledgerName: ledger.name,
        accountId: row.accountId,
        accountName: row.accountName,
        startDate: row.startDate,
      });
    }
  }
  return found;
}

/**
 * The connection's copy in `db`, made if there is none: the same login and
 * token, and every account it can see, none fed yet.
 */
async function ensureCopy(db: Database, source: ConnectionRow, sourceDb: Database): Promise<string> {
  const feeds = await sourceDb
    .select()
    .from(bankFeedAccounts)
    .where(eq(bankFeedAccounts.connectionId, source.id));

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bankConnections).where(eq(bankConnections.itemId, source.itemId));
    if (existing?.revokedAt) {
      // An Item revoked at Plaid never comes back, so a revoked copy beside a
      // live one means the two have disagreed; better said than papered over.
      throw new ConnectionError('That ledger has this connection marked as disconnected; connect the bank again there');
    }
    const copyId =
      existing?.id ??
      (
        await tx
          .insert(bankConnections)
          .values({
            provider: source.provider,
            itemId: source.itemId,
            institutionName: source.institutionName,
            accessToken: source.accessToken,
            errorCode: source.errorCode,
            errorMessage: source.errorMessage,
          })
          .returning({ id: bankConnections.id })
      )[0]!.id;
    if (feeds.length > 0) {
      await tx
        .insert(bankFeedAccounts)
        .values(
          feeds.map((feed) => ({
            connectionId: copyId,
            providerAccountId: feed.providerAccountId,
            name: feed.name,
            mask: feed.mask,
            type: feed.type,
            subtype: feed.subtype,
          })),
        )
        .onConflictDoNothing();
    }
    return copyId;
  });
}

/**
 * Feed a bank account into an account in any ledger, or into none. It is
 * freed in every other ledger first: two ledgers feeding one bank account would
 * each import every transaction.
 */
export async function chooseFeedAccount(
  all: LedgerHandle[],
  from: LedgerHandle,
  feedAccountId: string,
  target: { ledgerKey: string; accountId: string } | null,
): Promise<{ startDate: string | null }> {
  const [feed] = await from.db.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.id, feedAccountId));
  if (!feed) throw new ConnectionError('No such bank account');
  const connection = await connectionOf(from.db, feed.connectionId);
  const into = target ? all.find((ledger) => ledger.key === target.ledgerKey) : undefined;
  if (target && !into) throw new ConnectionError('No such ledger');

  for (const ledger of all) {
    if (ledger.key === into?.key) continue;
    const copy = ledger.key === from.key ? connection : await liveCopy(ledger.db, connection.itemId);
    if (!copy) continue;
    const fed = await ledger.db
      .select({ id: bankFeedAccounts.id })
      .from(bankFeedAccounts)
      .where(
        and(
          eq(bankFeedAccounts.connectionId, copy.id),
          eq(bankFeedAccounts.providerAccountId, feed.providerAccountId),
          isNotNull(bankFeedAccounts.accountId),
        ),
      );
    for (const row of fed) await setFeedAccount(ledger.db, row.id, null);
  }

  if (!target || !into) return { startDate: null };

  const copyId = into.key === from.key ? connection.id : await ensureCopy(into.db, connection, from.db);
  const [copyFeed] = await into.db
    .select({ id: bankFeedAccounts.id })
    .from(bankFeedAccounts)
    .where(and(eq(bankFeedAccounts.connectionId, copyId), eq(bankFeedAccounts.providerAccountId, feed.providerAccountId)));
  return setFeedAccount(into.db, copyFeed!.id, target.accountId);
}

/** Revoke the login at Plaid once, then forget every copy of it. */
export async function revokeEverywhere(
  all: LedgerHandle[],
  from: LedgerHandle,
  connectionId: string,
  call: PlaidCall,
  decrypt: (stored: string) => string,
): Promise<void> {
  const { itemId } = await connectionOf(from.db, connectionId);
  await revokeConnection(from.db, call, connectionId, decrypt);
  for (const ledger of all) {
    if (ledger.key === from.key) continue;
    const copy = await liveCopy(ledger.db, itemId);
    if (copy) await forgetConnection(ledger.db, copy.id);
  }
}

/** Sync every ledger's copy of a login: Sync now, and after signing in again. */
export async function syncEverywhere(
  all: LedgerHandle[],
  from: LedgerHandle,
  connectionId: string,
  deps: { call: PlaidCall; key: Buffer; account?: Database },
): Promise<{ ledger: LedgerHandle; report: SyncReport }[]> {
  const { itemId } = await connectionOf(from.db, connectionId);
  const reports: { ledger: LedgerHandle; report: SyncReport }[] = [];
  for (const ledger of all) {
    const copy = ledger.key === from.key ? { id: connectionId } : await liveCopy(ledger.db, itemId);
    if (copy) reports.push({ ledger, report: await syncConnection(ledger.db, copy.id, deps) });
  }
  return reports;
}
