/**
 * Account management (FR-1, FR-3).
 *
 * An account's opening balance is not a column here either: `openAccount` writes
 * it as an ordinary transaction landing in the income pool, so the invariant in
 * FR-37 holds from the first account with no special case. This module adds the
 * editing and archiving around that.
 *
 * Archiving refuses while money is left in the account, for the same reason
 * FR-25 refuses for envelopes: the balance still counts towards the total the
 * dashboard checks, and an account you cannot see is a difference you cannot
 * explain. Closing an account in real life means moving the money out first, and
 * recording that transfer is what makes the books match.
 */

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, transactions } from '../../db/schema.ts';
import { openAccount, type NewAccount } from '../ledger/ledger.ts';
import { searchTransactions } from '../transactions/search.ts';

export class AccountError extends Error {}

export const ACCOUNT_KINDS = [
  'chequing',
  'savings',
  'credit_card',
  'cash',
  'line_of_credit',
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/** How a kind reads on screen. */
export function accountKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}

export type ManagedAccount = {
  id: string;
  name: string;
  kind: string;
  currency: string;
  /** The bank's own account number, which is how a statement finds this account (FR-7). */
  externalAccountId: string | null;
  position: number;
  archivedAt: Date | null;
  balanceCents: number;
  transactionCount: number;
  /** Most recent transaction date, or null when nothing has been recorded. */
  lastActivity: string | null;
};

export async function listAccounts(
  db: Database,
  options: { includeArchived?: boolean } = {},
): Promise<ManagedAccount[]> {
  // Aggregated through a join rather than correlated subqueries. Drizzle renders
  // a column reference unqualified when the query has only one table, so
  // `where t.account_id = ${accounts.id}` becomes `where t.account_id = "id"`,
  // which Postgres happily resolves against `transactions.id` instead of the
  // account - a query that runs, returns zero, and tells you nothing is wrong.
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      kind: accounts.kind,
      currency: accounts.currency,
      externalAccountId: accounts.externalAccountId,
      position: accounts.position,
      archivedAt: accounts.archivedAt,
      balanceCents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
      transactionCount: sql<string>`count(${transactions.id})::bigint`,
      lastActivity: sql<string | null>`max(${transactions.date})`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .where(options.includeArchived ? sql`true` : isNull(accounts.archivedAt))
    .groupBy(
      accounts.id,
      accounts.name,
      accounts.kind,
      accounts.currency,
      accounts.externalAccountId,
      accounts.position,
      accounts.archivedAt,
    )
    .orderBy(asc(accounts.position), asc(accounts.name));

  return rows.map((row) => ({
    ...row,
    balanceCents: Number(row.balanceCents),
    transactionCount: Number(row.transactionCount),
  }));
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new AccountError('An account needs a name');
  if (trimmed.length > 80) throw new AccountError('That name is too long (80 characters max)');
  return trimmed;
}

/**
 * The account number is stored exactly as the bank writes it, because that is
 * what an OFX file carries and what it is matched against. Blank means "not
 * mapped yet", which is null rather than an empty string so the unique index
 * does not treat two unmapped accounts as a clash.
 */
function cleanExternalId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export type CreateAccount = {
  name: string;
  kind: AccountKind;
  openingBalanceCents?: number;
  openingDate?: string;
  externalAccountId?: string | null;
  currency?: string;
};

export async function createAccount(db: Database, input: CreateAccount): Promise<string> {
  const name = cleanName(input.name);
  if (!isAccountKind(input.kind)) throw new AccountError(`Not an account kind: ${input.kind}`);

  const opening = input.openingBalanceCents ?? 0;
  if (!Number.isSafeInteger(opening)) {
    throw new AccountError(`Opening balance must be a whole number of cents, got ${opening}`);
  }

  const externalAccountId = cleanExternalId(input.externalAccountId);
  if (externalAccountId) await assertExternalIdFree(db, externalAccountId);

  const account: NewAccount = {
    name,
    kind: input.kind,
    openingBalanceCents: opening,
    ...(input.openingDate ? { openingDate: input.openingDate } : {}),
    ...(externalAccountId ? { externalAccountId } : {}),
    ...(input.currency ? { currency: input.currency } : {}),
  };

  // Taken before the insert, or the new account's own default position of 0
  // would be the maximum it is measured against.
  const [last] = await db
    .select({ position: accounts.position })
    .from(accounts)
    .orderBy(desc(accounts.position))
    .limit(1);

  const id = await openAccount(db, account);

  await db
    .update(accounts)
    .set({ position: (last?.position ?? -1) + 1 })
    .where(eq(accounts.id, id));

  return id;
}

async function assertExternalIdFree(
  db: Database,
  externalAccountId: string,
  exceptId?: string,
): Promise<void> {
  const [clash] = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.externalAccountId, externalAccountId))
    .limit(1);

  if (clash && clash.id !== exceptId) {
    throw new AccountError(
      `${clash.name} already uses that account number. Two accounts cannot share one, ` +
        'or an imported statement would not know which it belongs to.',
    );
  }
}

export type AccountEdit = {
  name?: string;
  kind?: AccountKind;
  /** Pass null or an empty string to unmap the bank account number. */
  externalAccountId?: string | null;
};

export async function editAccount(
  db: Database,
  accountId: string,
  edit: AccountEdit,
): Promise<void> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new AccountError(`No such account: ${accountId}`);

  const changes: Record<string, unknown> = {};
  if (edit.name !== undefined) changes.name = cleanName(edit.name);
  if (edit.kind !== undefined) {
    if (!isAccountKind(edit.kind)) throw new AccountError(`Not an account kind: ${edit.kind}`);
    changes.kind = edit.kind;
  }
  if (edit.externalAccountId !== undefined) {
    const next = cleanExternalId(edit.externalAccountId);
    if (next) await assertExternalIdFree(db, next, accountId);
    changes.externalAccountId = next ?? null;
  }

  if (Object.keys(changes).length === 0) return;
  await db.update(accounts).set(changes).where(eq(accounts.id, accountId));
}

export async function accountBalanceCents(db: Database, accountId: string): Promise<number> {
  const [row] = await db
    .select({
      cents: sql<string>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId));
  return Number(row?.cents ?? 0);
}

/**
 * Archive an account. Refused while it still holds money, because that balance
 * keeps counting towards the total in FR-37 whether the account is on screen or
 * not, and a hidden balance is exactly the kind of difference nobody can find.
 */
export async function archiveAccount(db: Database, accountId: string): Promise<void> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new AccountError(`No such account: ${accountId}`);
  if (account.archivedAt !== null) return;

  const balanceCents = await accountBalanceCents(db, accountId);
  if (balanceCents !== 0) {
    const amount = (Math.abs(balanceCents) / 100).toFixed(2);
    throw new AccountError(
      `${account.name} still has $${amount} in it. Record the transfer that emptied it first, ` +
        'so envelope and account totals still agree (FR-37).',
    );
  }

  const pending = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.accountId, accountId), eq(transactions.status, 'pending_review')))
    .limit(1);
  if (pending.length > 0) {
    throw new AccountError(
      `${account.name} still has transactions awaiting review. Clear the queue first.`,
    );
  }

  await db.update(accounts).set({ archivedAt: new Date() }).where(eq(accounts.id, accountId));
}

export async function unarchiveAccount(db: Database, accountId: string): Promise<void> {
  await db.update(accounts).set({ archivedAt: null }).where(eq(accounts.id, accountId));
}

export async function reorderAccounts(db: Database, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(accounts).set({ position: index }).where(eq(accounts.id, id));
    }
  });
}

/**
 * One transaction as a list shows it. The shape the transaction list renders,
 * and a subset of what {@link searchTransactions} returns, so the two views
 * cannot disagree about what a row is.
 */
export type AccountTransaction = {
  id: string;
  date: string;
  payeeRaw: string;
  amountCents: number;
  status: string;
  kind: string;
  memo: string | null;
  accountId: string;
  accountName: string;
  envelopeNames: string[];
};

/**
 * One account's transactions, newest first, with the envelopes they landed in
 * (VW-5).
 *
 * Delegates to the search query rather than running its own, because "this
 * account's transactions" is exactly that query with the account pinned, and
 * two implementations of it would eventually disagree about splits, transfers
 * or ordering.
 */
export async function accountTransactions(
  db: Database,
  accountId: string,
  options: { limit?: number } = {},
): Promise<AccountTransaction[]> {
  const found = await searchTransactions(db, {
    accountIds: [accountId],
    ...(options.limit ? { limit: options.limit } : {}),
  });
  return found.rows;
}

/** The most recent transactions across every account, for the accounts screen. */
export async function recentTransactions(
  db: Database,
  options: { limit?: number } = {},
): Promise<AccountTransaction[]> {
  const found = await searchTransactions(db, options.limit ? { limit: options.limit } : {});
  return found.rows;
}
