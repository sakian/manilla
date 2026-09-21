/**
 * Categories of accounts (FR-1, FR-3).
 *
 * The same shape as envelope groups, for the same reason: a list of a dozen
 * accounts reads better under headings a household chose than under the fixed
 * kinds a bank statement needs. `kind` stays what it was - it tells the importer
 * and the balance arithmetic what an account *is* - and a group says where it
 * belongs.
 *
 * An account's group is nullable, unlike an envelope's. Accounts existed before
 * groups did, and inventing a group name for them would put words nobody chose on
 * the screen; they are listed under "No group" until they are given one.
 *
 * Accounts are alphabetical inside a group, groups keep a manual order - the same
 * division as envelopes, and for the same reason.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accountGroups, accounts, transactions } from '../../db/schema.ts';

export class AccountGroupError extends Error {}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new AccountGroupError('A category needs a name');
  if (trimmed.length > 80) throw new AccountGroupError('That name is too long (80 characters max)');
  return trimmed;
}

export type GroupedAccount = {
  id: string;
  name: string;
  kind: string;
  currency: string;
  externalAccountId: string | null;
  archivedAt: Date | null;
  balanceCents: number;
  transactionCount: number;
  lastActivity: string | null;
};

export type AccountCategory = {
  /** Null for the bucket holding accounts that have no group yet. */
  id: string | null;
  name: string;
  position: number;
  archivedAt: Date | null;
  accounts: GroupedAccount[];
};

/** The pseudo-group that ungrouped accounts appear under, always last. */
export const NO_GROUP = 'No group';

/**
 * Every account, under its category.
 *
 * One aggregating join rather than a query per account: Drizzle renders a column
 * reference unqualified in a single-table query, so a correlated subquery here
 * would bind to the inner table and silently return zero - the failure that cost
 * an afternoon the first time `listAccounts` was written.
 */
export async function listAccountCategories(
  db: Database,
  options: { includeArchived?: boolean } = {},
): Promise<AccountCategory[]> {
  const rows = await db
    .select({
      id: accounts.id,
      groupId: accounts.groupId,
      groupName: accountGroups.name,
      groupPosition: accountGroups.position,
      groupArchivedAt: accountGroups.archivedAt,
      name: accounts.name,
      kind: accounts.kind,
      currency: accounts.currency,
      externalAccountId: accounts.externalAccountId,
      archivedAt: accounts.archivedAt,
      balanceCents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
      transactionCount: sql<string>`count(${transactions.id})::bigint`,
      lastActivity: sql<string | null>`max(${transactions.date})`,
    })
    .from(accounts)
    .leftJoin(accountGroups, eq(accountGroups.id, accounts.groupId))
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .where(options.includeArchived ? sql`true` : isNull(accounts.archivedAt))
    .groupBy(
      accounts.id,
      accounts.groupId,
      accountGroups.name,
      accountGroups.position,
      accountGroups.archivedAt,
      accounts.name,
      accounts.kind,
      accounts.currency,
      accounts.externalAccountId,
      accounts.archivedAt,
    )
    .orderBy(asc(accountGroups.position), asc(accounts.name));

  // Empty groups matter: one just created has nothing in it, and an edit screen
  // that hides it gives you nowhere to move an account to.
  const empty = await db
    .select({
      id: accountGroups.id,
      name: accountGroups.name,
      position: accountGroups.position,
      archivedAt: accountGroups.archivedAt,
    })
    .from(accountGroups)
    .where(options.includeArchived ? sql`true` : isNull(accountGroups.archivedAt))
    .orderBy(asc(accountGroups.position), asc(accountGroups.name));

  const byGroup = new Map<string, AccountCategory>();
  for (const group of empty) {
    byGroup.set(group.id, { ...group, accounts: [] });
  }

  const ungrouped: AccountCategory = {
    id: null,
    name: NO_GROUP,
    // Sorted after every real group, whatever positions they hold.
    position: Number.MAX_SAFE_INTEGER,
    archivedAt: null,
    accounts: [],
  };

  for (const row of rows) {
    const account: GroupedAccount = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      currency: row.currency,
      externalAccountId: row.externalAccountId,
      archivedAt: row.archivedAt,
      balanceCents: Number(row.balanceCents),
      transactionCount: Number(row.transactionCount),
      lastActivity: row.lastActivity,
    };

    const group = row.groupId ? byGroup.get(row.groupId) : undefined;
    if (group) group.accounts.push(account);
    else ungrouped.accounts.push(account);
  }

  const categories = [...byGroup.values()].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name),
  );
  if (ungrouped.accounts.length > 0) categories.push(ungrouped);
  return categories;
}

export async function createAccountGroup(db: Database, name: string): Promise<string> {
  const clean = cleanName(name);

  const [last] = await db
    .select({ position: accountGroups.position })
    .from(accountGroups)
    .orderBy(sql`${accountGroups.position} desc`)
    .limit(1);

  const [row] = await db
    .insert(accountGroups)
    .values({ name: clean, position: (last?.position ?? -1) + 1 })
    .returning({ id: accountGroups.id });

  return row!.id;
}

export async function renameAccountGroup(
  db: Database,
  groupId: string,
  name: string,
): Promise<void> {
  await db
    .update(accountGroups)
    .set({ name: cleanName(name) })
    .where(eq(accountGroups.id, groupId));
}

/**
 * Archive a category. Its accounts are not archived with it - an account holds
 * real money and archiving one has its own rules (see `archiveAccount`) - so they
 * fall back to being ungrouped, where they stay visible and countable.
 */
export async function archiveAccountGroup(db: Database, groupId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(accounts).set({ groupId: null }).where(eq(accounts.groupId, groupId));
    await tx
      .update(accountGroups)
      .set({ archivedAt: new Date() })
      .where(eq(accountGroups.id, groupId));
  });
}

export async function unarchiveAccountGroup(db: Database, groupId: string): Promise<void> {
  await db.update(accountGroups).set({ archivedAt: null }).where(eq(accountGroups.id, groupId));
}

export async function reorderAccountGroups(db: Database, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(accountGroups).set({ position: index }).where(eq(accountGroups.id, id));
    }
  });
}

/** Move one category up or down among its live siblings, for an arrow button. */
export async function nudgeAccountGroup(
  db: Database,
  groupId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const siblings = await db
    .select({ id: accountGroups.id })
    .from(accountGroups)
    .where(isNull(accountGroups.archivedAt))
    .orderBy(asc(accountGroups.position), asc(accountGroups.name));

  const order = siblings.map((row) => row.id);
  const at = order.indexOf(groupId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at === -1 || to < 0 || to >= order.length) return;

  [order[at], order[to]] = [order[to]!, order[at]!];
  await reorderAccountGroups(db, order);
}

/** Put an account in a category, or pass null to take it out of one. */
export async function moveAccountToGroup(
  db: Database,
  accountId: string,
  groupId: string | null,
): Promise<void> {
  if (groupId !== null) {
    const [group] = await db
      .select({ id: accountGroups.id, archivedAt: accountGroups.archivedAt })
      .from(accountGroups)
      .where(eq(accountGroups.id, groupId))
      .limit(1);
    if (!group) throw new AccountGroupError(`No such category: ${groupId}`);
    if (group.archivedAt !== null) {
      throw new AccountGroupError('That category is archived. Restore it first.');
    }
  }

  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId)))
    .limit(1);
  if (!account) throw new AccountGroupError(`No such account: ${accountId}`);

  await db.update(accounts).set({ groupId }).where(eq(accounts.id, accountId));
}
