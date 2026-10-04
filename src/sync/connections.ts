/**
 * Linking, listing and revoking bank connections (FR-15, FR-20), and settling
 * what a sync held back.
 *
 * The bank login itself happens in Plaid's own window in the browser, so the
 * password never reaches Manilla. What comes back is a one-time public token,
 * exchanged here for the access token a sync uses, which is stored encrypted.
 */

import { and, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  bankConnections,
  bankFeedAccounts,
  syncHeldRows,
  transactionExternalIds,
  transactions,
} from '../../db/schema.ts';
import { commitImport, previewImport, type RowDecision } from '../import/ofxImport.ts';
import { parseJsonKeepingNumbers } from './plaid.ts';
import { PlaidApiError, type PlaidCall } from './plaidClient.ts';
import { encryptSecret } from './secret.ts';

export class ConnectionError extends Error {}

/** Every connection is Plaid's for now; the column says so for whatever comes next. */
const PROVIDER = 'plaid';

/** As much history as Plaid will give, so the first sync can meet the statements already here. */
const DAYS_REQUESTED = 730;

function json(text: string): Record<string, unknown> {
  return parseJsonKeepingNumbers(text) as Record<string, unknown>;
}

/**
 * A link token for Plaid's window: a new login, or, given a connection,
 * the same login again when the bank wants it (update mode). Signing in again
 * keeps the connection and its cursors; removing and re-adding one would start
 * over, and on Plaid's free plan spend one of its ten connections for good.
 */
export async function createLinkToken(
  db: Database,
  call: PlaidCall,
  options: { userId: string; connectionId?: string; decrypt?: (stored: string) => string },
): Promise<string> {
  let accessToken: string | undefined;
  if (options.connectionId) {
    const [connection] = await db
      .select()
      .from(bankConnections)
      .where(eq(bankConnections.id, options.connectionId));
    if (!connection?.accessToken || !options.decrypt) {
      throw new ConnectionError('That connection is not there to sign in to again');
    }
    accessToken = options.decrypt(connection.accessToken);
  }

  const response = json(
    await call('/link/token/create', {
      client_name: 'Manilla',
      language: 'en',
      country_codes: ['CA'],
      // Plaid's own id for whoever is linking. Never anything identifying.
      user: { client_user_id: options.userId },
      ...(accessToken
        ? { access_token: accessToken }
        : { products: ['transactions'], transactions: { days_requested: DAYS_REQUESTED } }),
    }),
  );
  if (typeof response.link_token !== 'string') throw new ConnectionError('Plaid sent no link token');
  return response.link_token;
}

/**
 * Turn what Plaid's window returned into a connection: exchange the public
 * token, store the access token encrypted, and list the accounts it can see,
 * none of them linked to a Manilla account yet.
 */
export async function linkConnection(
  db: Database,
  call: PlaidCall,
  publicToken: string,
  key: Buffer,
): Promise<string> {
  const exchanged = json(await call('/item/public_token/exchange', { public_token: publicToken }));
  const accessToken = exchanged.access_token;
  const itemId = exchanged.item_id;
  if (typeof accessToken !== 'string' || typeof itemId !== 'string') {
    throw new ConnectionError('Plaid did not return a connection');
  }

  const listed = json(await call('/accounts/get', { access_token: accessToken }));
  const item = listed.item as { institution_id?: string | null } | undefined;
  const institutionName = item?.institution_id ? await institutionNameOf(call, item.institution_id) : null;
  const seen = (listed.accounts as Record<string, unknown>[] | undefined) ?? [];

  return db.transaction(async (tx) => {
    const [connection] = await tx
      .insert(bankConnections)
      .values({
        provider: PROVIDER,
        itemId,
        institutionName,
        accessToken: encryptSecret(accessToken, key),
      })
      .returning({ id: bankConnections.id });
    if (seen.length > 0) {
      await tx.insert(bankFeedAccounts).values(
        seen.map((account) => ({
          connectionId: connection!.id,
          providerAccountId: String(account.account_id),
          name: String(account.name ?? 'Account'),
          mask: typeof account.mask === 'string' ? account.mask : null,
          type: typeof account.type === 'string' ? account.type : null,
          subtype: typeof account.subtype === 'string' ? account.subtype : null,
        })),
      );
    }
    return connection!.id;
  });
}

/** The bank's name, for the screen. A failure here is not worth failing the link over. */
async function institutionNameOf(call: PlaidCall, institutionId: string): Promise<string | null> {
  try {
    const found = json(
      await call('/institutions/get_by_id', { institution_id: institutionId, country_codes: ['CA', 'US'] }),
    );
    const institution = found.institution as { name?: string } | undefined;
    return institution?.name ?? null;
  } catch (error) {
    if (error instanceof PlaidApiError) return null;
    throw error;
  }
}

/**
 * Say which Manilla account a feed account is, or that it is none. Linking it
 * sets where the feed starts: the day of the account's latest statement row,
 * so what statements already brought in is not counted again, and the day
 * itself is still covered by matching each row against them (FR-18).
 */
export async function setFeedAccount(
  db: Database,
  feedAccountId: string,
  accountId: string | null,
): Promise<{ startDate: string | null }> {
  if (accountId) {
    const [feed] = await db.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.id, feedAccountId));
    if (feed?.type === 'investment') {
      throw new ConnectionError("An investment account's holdings are not transactions a sync can bring in yet");
    }
    const [taken] = await db
      .select({ id: bankFeedAccounts.id, name: bankFeedAccounts.name })
      .from(bankFeedAccounts)
      .where(eq(bankFeedAccounts.accountId, accountId));
    if (taken && taken.id !== feedAccountId) {
      throw new ConnectionError(
        `That account is already fed by "${taken.name}"; two feeds would bring in every transaction twice`,
      );
    }
  }

  const startDate = accountId ? await latestStatementDate(db, accountId) : null;
  await db
    .update(bankFeedAccounts)
    // A new account means a new history: start from nothing.
    .set({ accountId, startDate, cursor: null })
    .where(eq(bankFeedAccounts.id, feedAccountId));
  return { startDate };
}

/** The date of the account's latest transaction that came with a bank id. */
async function latestStatementDate(db: Database, accountId: string): Promise<string | null> {
  const [row] = await db
    .select({ latest: max(transactions.date) })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        sql`exists (
          select 1 from ${transactionExternalIds} x
          where x.transaction_id = ${transactions.id} and x.kind = 'fitid'
        )`,
      ),
    );
  return row?.latest ?? null;
}

/**
 * Revoke a connection (FR-20): Plaid forgets the login - which is also what
 * stops it being billed - and the token is erased here. What it imported stays,
 * like any import; its accounts are freed to be linked to another feed.
 */
export async function revokeConnection(
  db: Database,
  call: PlaidCall,
  connectionId: string,
  decrypt: (stored: string) => string,
): Promise<void> {
  const [connection] = await db.select().from(bankConnections).where(eq(bankConnections.id, connectionId));
  if (!connection) throw new ConnectionError('No such connection');
  if (connection.accessToken) {
    try {
      await call('/item/remove', { access_token: decrypt(connection.accessToken) });
    } catch (error) {
      // Already gone at Plaid's end is the outcome wanted.
      if (!(error instanceof PlaidApiError && error.code === 'ITEM_NOT_FOUND')) throw error;
    }
  }
  await forgetConnection(db, connectionId);
}

/**
 * Erase a connection's token and free its accounts, without telling Plaid:
 * for a copy in another ledger of a login already revoked (see shared.ts).
 */
export async function forgetConnection(db: Database, connectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(bankConnections)
      .set({ accessToken: null, revokedAt: new Date() })
      .where(eq(bankConnections.id, connectionId));
    await tx
      .update(bankFeedAccounts)
      .set({ accountId: null, cursor: null })
      .where(eq(bankFeedAccounts.connectionId, connectionId));
  });
}

export type ConnectionSummary = {
  id: string;
  /** Plaid's id for the login, which is what a copy in another ledger shares. */
  itemId: string;
  institutionName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  lastSyncedAt: Date | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  accounts: {
    id: string;
    providerAccountId: string;
    name: string;
    mask: string | null;
    type: string | null;
    subtype: string | null;
    accountId: string | null;
    accountName: string | null;
    startDate: string | null;
  }[];
};

/** Every connection that has not been revoked, with its accounts. */
export async function listConnections(db: Database): Promise<ConnectionSummary[]> {
  const connections = await db
    .select()
    .from(bankConnections)
    .where(isNull(bankConnections.revokedAt))
    .orderBy(bankConnections.createdAt);
  if (connections.length === 0) return [];

  const feeds = await db
    .select({
      id: bankFeedAccounts.id,
      connectionId: bankFeedAccounts.connectionId,
      providerAccountId: bankFeedAccounts.providerAccountId,
      name: bankFeedAccounts.name,
      mask: bankFeedAccounts.mask,
      type: bankFeedAccounts.type,
      subtype: bankFeedAccounts.subtype,
      accountId: bankFeedAccounts.accountId,
      accountName: accounts.name,
      startDate: bankFeedAccounts.startDate,
    })
    .from(bankFeedAccounts)
    .leftJoin(accounts, eq(accounts.id, bankFeedAccounts.accountId))
    .where(inArray(bankFeedAccounts.connectionId, connections.map((c) => c.id)))
    .orderBy(bankFeedAccounts.name);

  return connections.map((connection) => ({
    id: connection.id,
    itemId: connection.itemId,
    institutionName: connection.institutionName,
    errorCode: connection.errorCode,
    errorMessage: connection.errorMessage,
    lastSyncedAt: connection.lastSyncedAt,
    lastAttemptAt: connection.lastAttemptAt,
    createdAt: connection.createdAt,
    accounts: feeds
      .filter((feed) => feed.connectionId === connection.id)
      .map(({ connectionId: _, ...feed }) => feed),
  }));
}

/**
 * What the notices need: banks waiting for their login, and how many held
 * rows wait for a decision. Two small queries, since this runs on every main
 * screen.
 */
export async function bankAttention(
  db: Database,
): Promise<{ loginNeeded: (string | null)[]; held: number }> {
  const [waiting, [held]] = await Promise.all([
    db
      .select({ institutionName: bankConnections.institutionName })
      .from(bankConnections)
      .where(and(isNull(bankConnections.revokedAt), eq(bankConnections.errorCode, 'ITEM_LOGIN_REQUIRED'))),
    db.select({ count: sql<number>`count(*)::int` }).from(syncHeldRows).where(isNull(syncHeldRows.resolvedAt)),
  ]);
  return { loginNeeded: waiting.map((row) => row.institutionName), held: Number(held?.count ?? 0) };
}

export type HeldRow = typeof syncHeldRows.$inferSelect & {
  accountName: string;
  /** The transaction here it matched or changes, as it stands now. */
  here?: { payeeRaw: string; date: string; amountCents: number };
};

/** What syncs held back and nobody has settled, newest first. */
export async function listHeld(db: Database): Promise<HeldRow[]> {
  const rows = await db
    .select({
      held: syncHeldRows,
      accountName: accounts.name,
      herePayee: transactions.payeeRaw,
      hereDate: transactions.date,
      hereAmount: transactions.amountCents,
    })
    .from(syncHeldRows)
    .innerJoin(accounts, eq(accounts.id, syncHeldRows.accountId))
    .leftJoin(transactions, eq(transactions.id, syncHeldRows.transactionId))
    .where(isNull(syncHeldRows.resolvedAt))
    .orderBy(desc(syncHeldRows.createdAt), desc(syncHeldRows.date));
  return rows.map((row) => ({
    ...row.held,
    amountCents: Number(row.held.amountCents),
    accountName: row.accountName,
    ...(row.herePayee !== null && row.hereDate !== null && row.hereAmount !== null
      ? { here: { payeeRaw: row.herePayee, date: row.hereDate, amountCents: Number(row.hereAmount) } }
      : {}),
  }));
}

/**
 * Settle a held row.
 *
 *   add      import it as its own transaction: a look-alike that is a genuine
 *            repeat, or a rounded amount accepted as rounded.
 *   link     a look-alike that is the transaction it matched: attach the
 *            feed's id to that one, so the feed recognises it from now on.
 *   dismiss  leave things as they are: a change or a withdrawal looked at and
 *            not acted on, or handled by editing the transaction itself.
 */
export async function resolveHeld(
  db: Database,
  heldId: string,
  action: 'add' | 'link' | 'dismiss',
): Promise<void> {
  const [held] = await db
    .select()
    .from(syncHeldRows)
    .where(and(eq(syncHeldRows.id, heldId), isNull(syncHeldRows.resolvedAt)));
  if (!held) throw new ConnectionError('That has already been settled');

  if (action === 'link') {
    if (held.reason !== 'possible_duplicate' || !held.transactionId) {
      throw new ConnectionError('Only a look-alike can be linked to what it matched');
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(transactionExternalIds)
        .values({
          transactionId: held.transactionId!,
          accountId: held.accountId,
          kind: 'aggregator',
          value: held.externalId,
        })
        .onConflictDoNothing();
      await tx.update(syncHeldRows).set({ resolvedAt: new Date() }).where(eq(syncHeldRows.id, heldId));
    });
    return;
  }

  if (action === 'add') {
    if (held.reason !== 'possible_duplicate' && held.reason !== 'rounded') {
      throw new ConnectionError('Only a look-alike or a rounded amount can be added');
    }
    const preview = await previewImport(
      db,
      {
        transactions: [
          {
            fitId: held.externalId,
            type: held.amountCents < 0 ? 'DEBIT' : 'CREDIT',
            posted: held.date,
            amountCents: Number(held.amountCents),
            name: held.payeeRaw,
            warnings: [],
          },
        ],
      },
      held.accountId,
      { source: 'bank_sync' },
    );
    const row = preview.rows[0]!;
    if (row.verdict === 'duplicate') {
      throw new ConnectionError('The feed has brought this in since; there is nothing to add');
    }
    // A person has looked at it, so a look-alike is added as asked; anything
    // else takes the import's own default.
    const decisions = new Map<number, RowDecision>(
      row.verdict === 'possible_duplicate' ? [[row.index, { action: 'add' }]] : [],
    );
    await db.transaction(async (tx) => {
      await commitImport(tx, preview, decisions);
      await tx.update(syncHeldRows).set({ resolvedAt: new Date() }).where(eq(syncHeldRows.id, heldId));
    });
    return;
  }

  await db.update(syncHeldRows).set({ resolvedAt: new Date() }).where(eq(syncHeldRows.id, heldId));
}
