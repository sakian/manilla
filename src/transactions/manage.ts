/**
 * Entering, correcting and removing transactions by hand (FR-2, FR-4, FR-5).
 *
 * Everything else in Manilla reads the ledger; this is where a person writes to
 * it directly - cash spending the bank never sees, a correction to something an
 * import got wrong, a transfer between two of your own accounts.
 *
 * The rules that make it safe are the ledger's, not new ones:
 *
 *  - a spending transaction's lines must sum to its amount (FR-4), so changing
 *    the amount of an unsplit transaction carries its single line along, and
 *    changing the amount of a split one refuses until the caller says how the
 *    split is meant to fall;
 *  - an account transfer has no envelope lines and its two halves net to zero
 *    (FR-5), so both halves are always written, edited and deleted together;
 *  - deleting is real deletion, and it takes the bank's id with it. That is the
 *    honest behaviour: the row is gone, and a later import of the same statement
 *    will offer it again as new, because as far as the bank is concerned it still
 *    happened.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  envelopes,
  transactionExternalIds,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { normalizePayee } from '../categorize/normalize.ts';
import { LedgerError, recordAccountTransfer, recordTransaction } from '../ledger/ledger.ts';
import { localToday } from '../budget/month.ts';

export class TransactionError extends Error {}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function assertDate(date: string): string {
  if (!DAY.test(date)) {
    throw new TransactionError(`Not a calendar date (YYYY-MM-DD): ${date}`);
  }
  return date;
}

function assertCents(amountCents: number, what = 'Amount'): number {
  if (!Number.isSafeInteger(amountCents)) {
    throw new TransactionError(`${what} must be a whole number of cents, got ${amountCents}`);
  }
  return amountCents;
}

function assertPayee(payeeRaw: string): string {
  const trimmed = payeeRaw.trim();
  if (trimmed.length === 0) throw new TransactionError('A transaction needs a description');
  if (trimmed.length > 200) throw new TransactionError('That description is too long');
  return trimmed;
}

// ---------------------------------------------------------------------------
// Reading one transaction
// ---------------------------------------------------------------------------

export type TransactionLine = {
  envelopeId: string;
  envelopeName: string;
  amountCents: number;
};

export type TransactionDetail = {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  amountCents: number;
  payeeRaw: string;
  memo: string | null;
  checkNumber: string | null;
  kind: 'spending' | 'account_transfer';
  status: 'pending_review' | 'confirmed';
  source: string;
  transferPairId: string | null;
  lines: TransactionLine[];
  /** True when it arrived from a file or a sync rather than being typed. */
  imported: boolean;
};

export async function transactionDetail(
  db: Database,
  transactionId: string,
): Promise<TransactionDetail | undefined> {
  const [row] = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      accountName: accounts.name,
      date: transactions.date,
      amountCents: transactions.amountCents,
      payeeRaw: transactions.payeeRaw,
      memo: transactions.memo,
      checkNumber: transactions.checkNumber,
      kind: transactions.kind,
      status: transactions.status,
      source: transactions.source,
      transferPairId: transactions.transferPairId,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (!row) return undefined;

  const lines = await db
    .select({
      envelopeId: txnLines.envelopeId,
      envelopeName: envelopes.name,
      amountCents: txnLines.amountCents,
    })
    .from(txnLines)
    .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
    .where(eq(txnLines.transactionId, transactionId));

  return {
    ...row,
    amountCents: Number(row.amountCents),
    lines: lines.map((line) => ({ ...line, amountCents: Number(line.amountCents) })),
    imported: row.source === 'file_import' || row.source === 'bank_sync',
  };
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export type NewManualTransaction = {
  accountId: string;
  /** `YYYY-MM-DD`. Defaults to today. */
  date?: string;
  /** Negative for money out, positive for money in. */
  amountCents: number;
  payeeRaw: string;
  memo?: string;
  checkNumber?: string;
  /** One line, or several for a split (FR-4). Omit to leave it for the queue. */
  lines?: { envelopeId: string; amountCents: number }[];
};

/**
 * FR-2. A transaction typed in by hand.
 *
 * It is confirmed when the envelopes are given, because the person entering it
 * has just said where the money goes - there is nothing left to review. Entered
 * without envelopes, it joins the queue like an import would.
 */
export async function createManualTransaction(
  db: Database,
  input: NewManualTransaction,
): Promise<string> {
  const lines = input.lines ?? [];
  assertCents(input.amountCents);
  if (input.amountCents === 0) {
    throw new TransactionError('A transaction of zero would have nothing to record');
  }

  await assertLinesBalance(db, lines, input.amountCents);

  return recordTransaction(db, {
    accountId: input.accountId,
    date: assertDate(input.date ?? localToday()),
    amountCents: input.amountCents,
    payeeRaw: assertPayee(input.payeeRaw),
    ...(input.memo?.trim() ? { memo: input.memo.trim() } : {}),
    ...(input.checkNumber?.trim() ? { checkNumber: input.checkNumber.trim() } : {}),
    source: 'manual',
    status: lines.length > 0 ? 'confirmed' : 'pending_review',
    ...(lines.length > 0 ? { lines } : {}),
  });
}

/** Shared by create and edit: the FR-4 rule, with readable failures. */
async function assertLinesBalance(
  db: Database,
  lines: { envelopeId: string; amountCents: number }[],
  amountCents: number,
): Promise<void> {
  if (lines.length === 0) return;

  for (const line of lines) {
    assertCents(line.amountCents, 'A split amount');
    if (line.amountCents === 0) {
      throw new TransactionError('A split line of zero does nothing; remove it instead');
    }
  }

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (total !== amountCents) {
    const short = amountCents - total;
    throw new TransactionError(
      `The split does not add up: the parts come to ${format(total)} but the transaction is ` +
        `${format(amountCents)}, leaving ${format(short)} unaccounted for.`,
    );
  }

  const ids = [...new Set(lines.map((line) => line.envelopeId))];
  const live = await db
    .select({ id: envelopes.id, archivedAt: envelopes.archivedAt })
    .from(envelopes)
    .where(inArray(envelopes.id, ids));

  for (const id of ids) {
    const found = live.find((row) => row.id === id);
    if (!found) throw new TransactionError(`No such envelope: ${id}`);
    if (found.archivedAt !== null) {
      throw new TransactionError('An archived envelope cannot take a share of a transaction');
    }
  }
}

function format(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export type TransactionEdit = {
  accountId?: string;
  date?: string;
  amountCents?: number;
  payeeRaw?: string;
  memo?: string | null;
  checkNumber?: string | null;
  /** Replaces the envelope split outright. Pass [] to make it uncategorized. */
  lines?: { envelopeId: string; amountCents: number }[];
  status?: 'pending_review' | 'confirmed';
};

/**
 * FR-2 and RQ-5: correct a transaction after the fact.
 *
 * Changing the amount of an unsplit transaction moves its single line with it,
 * because that is the only reading of the instruction that keeps the books
 * balanced. Changing the amount of a *split* transaction is refused unless the
 * new split comes with it: there is no honest way to guess which part of a split
 * the extra four dollars belongs to.
 */
export async function updateTransaction(
  db: Database,
  transactionId: string,
  edit: TransactionEdit,
): Promise<void> {
  const existing = await transactionDetail(db, transactionId);
  if (!existing) throw new TransactionError(`No such transaction: ${transactionId}`);

  if (existing.kind === 'account_transfer') {
    throw new TransactionError(
      'This is one half of an account transfer. Edit the transfer itself, so both halves stay ' +
        'in step (FR-5).',
    );
  }

  const amountCents =
    edit.amountCents === undefined ? existing.amountCents : assertCents(edit.amountCents);
  if (amountCents === 0) {
    throw new TransactionError('A transaction of zero would have nothing to record');
  }

  let lines = edit.lines;
  if (lines === undefined && amountCents !== existing.amountCents) {
    if (existing.lines.length > 1) {
      throw new TransactionError(
        'This transaction is split across several envelopes, so changing the amount needs the ' +
          'new split as well.',
      );
    }
    // One line, or none: carry it along.
    lines = existing.lines.map((line) => ({ envelopeId: line.envelopeId, amountCents }));
  }

  if (lines !== undefined) await assertLinesBalance(db, lines, amountCents);

  if (edit.accountId !== undefined) {
    const [account] = await db
      .select({ id: accounts.id, archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(eq(accounts.id, edit.accountId))
      .limit(1);
    if (!account) throw new TransactionError(`No such account: ${edit.accountId}`);
    if (account.archivedAt !== null) {
      throw new TransactionError('That account is archived');
    }
  }

  await db.transaction(async (tx) => {
    const changes: Record<string, unknown> = { updatedAt: new Date() };

    if (edit.accountId !== undefined) changes.accountId = edit.accountId;
    if (edit.date !== undefined) changes.date = assertDate(edit.date);
    if (edit.amountCents !== undefined) changes.amountCents = amountCents;
    if (edit.payeeRaw !== undefined) {
      const payeeRaw = assertPayee(edit.payeeRaw);
      changes.payeeRaw = payeeRaw;
      // The normalized key is what history and rules match on, so it is
      // recomputed rather than left describing the old description (CA-1).
      changes.payeeKey = normalizePayee(payeeRaw).key;
    }
    if (edit.memo !== undefined) changes.memo = edit.memo?.trim() ? edit.memo.trim() : null;
    if (edit.checkNumber !== undefined) {
      changes.checkNumber = edit.checkNumber?.trim() ? edit.checkNumber.trim() : null;
    }
    if (edit.status !== undefined) changes.status = edit.status;

    await tx.update(transactions).set(changes).where(eq(transactions.id, transactionId));

    if (lines !== undefined) {
      await tx.delete(txnLines).where(eq(txnLines.transactionId, transactionId));
      if (lines.length > 0) {
        await tx.insert(txnLines).values(
          lines.map((line) => ({
            transactionId,
            envelopeId: line.envelopeId,
            amountCents: line.amountCents,
          })),
        );
      }
    }

    // An account the transaction has moved to must still be one the external ids
    // are scoped to, or a re-import would not recognise it.
    if (edit.accountId !== undefined) {
      await tx
        .update(transactionExternalIds)
        .set({ accountId: edit.accountId })
        .where(eq(transactionExternalIds.transactionId, transactionId));
    }
  });
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

export type DeleteResult = {
  /** How many rows went: one, or two for a transfer pair. */
  removed: number;
  /** Bank ids that went with them, so the caller can say a re-import will return it. */
  externalIds: number;
};

export async function deleteTransaction(
  db: Database,
  transactionId: string,
): Promise<DeleteResult> {
  const existing = await transactionDetail(db, transactionId);
  if (!existing) throw new TransactionError(`No such transaction: ${transactionId}`);

  if (existing.kind === 'account_transfer') {
    if (!existing.transferPairId) {
      throw new LedgerError('An account transfer with no pair id is corrupt; not deleting it');
    }
    return deleteTransfer(db, existing.transferPairId);
  }

  if (existing.source === 'opening_balance') {
    throw new TransactionError(
      "This is the account's opening balance. Change the amount instead, or archive the account - " +
        'deleting it would leave the account starting from a figure nobody chose.',
    );
  }

  return db.transaction(async (tx) => {
    const ids = await tx
      .select({ value: transactionExternalIds.value })
      .from(transactionExternalIds)
      .where(eq(transactionExternalIds.transactionId, transactionId));

    // Lines, external ids and the suggestion all cascade from the transaction.
    await tx.delete(transactions).where(eq(transactions.id, transactionId));

    return { removed: 1, externalIds: ids.length };
  });
}

/** FR-5: both halves go together, or the books stop balancing. */
export async function deleteTransfer(db: Database, pairId: string): Promise<DeleteResult> {
  return db.transaction(async (tx) => {
    const halves = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.transferPairId, pairId));

    if (halves.length === 0) throw new TransactionError(`No such transfer: ${pairId}`);

    await tx.delete(transactions).where(eq(transactions.transferPairId, pairId));
    return { removed: halves.length, externalIds: 0 };
  });
}

// ---------------------------------------------------------------------------
// Account transfers (FR-5)
// ---------------------------------------------------------------------------

export type NewTransfer = {
  fromAccountId: string;
  toAccountId: string;
  /** Positive; the direction comes from the two accounts. */
  amountCents: number;
  date?: string;
  payeeRaw?: string;
};

/** Returns the pair id linking the two halves. */
export async function createTransfer(db: Database, input: NewTransfer): Promise<string> {
  assertCents(input.amountCents);
  if (input.amountCents <= 0) {
    throw new TransactionError('A transfer needs an amount above zero');
  }

  const live = await db
    .select({ id: accounts.id, name: accounts.name, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(inArray(accounts.id, [input.fromAccountId, input.toAccountId]));

  for (const id of [input.fromAccountId, input.toAccountId]) {
    const found = live.find((row) => row.id === id);
    if (!found) throw new TransactionError(`No such account: ${id}`);
    if (found.archivedAt !== null) {
      throw new TransactionError(`${found.name} is archived, so money cannot move through it`);
    }
  }

  const [from, to] = await Promise.all([
    nameOf(db, input.fromAccountId),
    nameOf(db, input.toAccountId),
  ]);

  const [firstHalf] = await recordAccountTransfer(db, {
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountCents: input.amountCents,
    date: assertDate(input.date ?? localToday()),
    payeeRaw: input.payeeRaw?.trim() || `Transfer: ${from} to ${to}`,
  });

  // The pair id, not either half: it is what editing and deleting address, since
  // both halves always move together.
  const [row] = await db
    .select({ transferPairId: transactions.transferPairId })
    .from(transactions)
    .where(eq(transactions.id, firstHalf))
    .limit(1);

  if (!row?.transferPairId) throw new LedgerError('Transfer was written without a pair id');
  return row.transferPairId;
}

async function nameOf(db: Database, accountId: string): Promise<string> {
  const [row] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.name ?? 'an account';
}

export type TransferDetail = {
  pairId: string;
  fromAccountId: string;
  toAccountId: string;
  amountCents: number;
  date: string;
  payeeRaw: string;
};

export async function transferDetail(
  db: Database,
  pairId: string,
): Promise<TransferDetail | undefined> {
  const halves = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountCents: transactions.amountCents,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
    })
    .from(transactions)
    .where(eq(transactions.transferPairId, pairId));

  const out = halves.find((half) => Number(half.amountCents) < 0);
  const into = halves.find((half) => Number(half.amountCents) > 0);
  if (!out || !into) return undefined;

  return {
    pairId,
    fromAccountId: out.accountId,
    toAccountId: into.accountId,
    amountCents: Math.abs(Number(out.amountCents)),
    date: out.date,
    payeeRaw: out.payeeRaw,
  };
}

export type TransferEdit = {
  fromAccountId?: string;
  toAccountId?: string;
  amountCents?: number;
  date?: string;
  payeeRaw?: string;
};

/** Both halves move together, so the pair still nets to zero (FR-5). */
export async function updateTransfer(
  db: Database,
  pairId: string,
  edit: TransferEdit,
): Promise<void> {
  const existing = await transferDetail(db, pairId);
  if (!existing) throw new TransactionError(`No such transfer: ${pairId}`);

  const amountCents =
    edit.amountCents === undefined ? existing.amountCents : assertCents(edit.amountCents);
  if (amountCents <= 0) throw new TransactionError('A transfer needs an amount above zero');

  const fromAccountId = edit.fromAccountId ?? existing.fromAccountId;
  const toAccountId = edit.toAccountId ?? existing.toAccountId;
  if (fromAccountId === toAccountId) {
    throw new TransactionError('A transfer needs two different accounts');
  }

  const date = assertDate(edit.date ?? existing.date);
  const payeeRaw = assertPayee(edit.payeeRaw ?? existing.payeeRaw);

  await db.transaction(async (tx) => {
    await tx
      .update(transactions)
      .set({
        accountId: fromAccountId,
        amountCents: -amountCents,
        date,
        payeeRaw,
        payeeKey: normalizePayee(payeeRaw).key,
        updatedAt: new Date(),
      })
      .where(
        and(eq(transactions.transferPairId, pairId), sql`${transactions.amountCents} < 0`),
      );

    await tx
      .update(transactions)
      .set({
        accountId: toAccountId,
        amountCents,
        date,
        payeeRaw,
        payeeKey: normalizePayee(payeeRaw).key,
        updatedAt: new Date(),
      })
      .where(
        and(eq(transactions.transferPairId, pairId), sql`${transactions.amountCents} > 0`),
      );
  });
}
