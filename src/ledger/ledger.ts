/**
 * The ledger: balances, and the rules that keep the two sides equal.
 *
 * Manilla's central invariant (section 9, FR-37) is that the sum of every
 * envelope balance equals the sum of every account balance. That holds only if
 * three things are true, and every write in this module enforces one of them:
 *
 *   1. A spending transaction's envelope lines sum exactly to its amount.
 *   2. An account transfer has no envelope lines, and its two halves sum to zero.
 *   3. An envelope move takes from one envelope exactly what it gives another.
 *
 * Money that enters the system with nowhere to go - an account's opening
 * balance - is written as an ordinary transaction whose line lands in the
 * unallocated envelope, so there is no special case to get wrong later.
 */

import { eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  envelopeGroups,
  envelopeMoves,
  envelopes,
  suggestions,
  transactionExternalIds,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { normalizePayee } from '../categorize/normalize.ts';

export class LedgerError extends Error {}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type AccountBalance = {
  accountId: string;
  name: string;
  kind: string;
  balanceCents: number;
};

/** Account balance is simply the sum of its transactions; opening balance is one of them. */
export async function accountBalances(db: Database): Promise<AccountBalance[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      name: accounts.name,
      kind: accounts.kind,
      balanceCents: sql<number>`coalesce(sum(${transactions.amountCents}), 0)::bigint`,
    })
    .from(accounts)
    .leftJoin(transactions, eq(transactions.accountId, accounts.id))
    .groupBy(accounts.id, accounts.name, accounts.kind, accounts.position)
    .orderBy(accounts.position, accounts.name);

  return rows.map((row) => ({ ...row, balanceCents: Number(row.balanceCents) }));
}

export type EnvelopeBalance = {
  envelopeId: string;
  name: string;
  groupId: string;
  groupName: string;
  isUnallocated: boolean;
  balanceCents: number;
  /** The part of that balance still awaiting review (RQ-4). */
  pendingCents: number;
};

/**
 * Envelope balance = its transaction lines, plus what has been moved in, minus
 * what has been moved out. Computed in one statement so it cannot drift from a
 * cached column.
 */
export async function envelopeBalances(db: Database): Promise<EnvelopeBalance[]> {
  const rows = await db
    .select({
      envelopeId: envelopes.id,
      name: envelopes.name,
      groupId: envelopeGroups.id,
      groupName: envelopeGroups.name,
      isUnallocated: envelopes.isUnallocated,
      balanceCents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopes.id}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopes.id}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopes.id}), 0)
      )::bigint`,
      /*
       * How much of that balance is not settled yet.
       *
       * A suggestion the pipeline is sure enough about is applied on import, so
       * the envelope screen is worth reading before anything has been reviewed.
       * The price is that a balance can be part fact and part proposal, and a
       * figure that will not say which is a figure nobody can act on - so this
       * is the proposal's share, and the screens show it beside the total.
       */
      pendingCents: sql<string>`coalesce((
        select sum(l.amount_cents) from txn_lines l
        join transactions t on t.id = l.transaction_id
        where l.envelope_id = ${envelopes.id} and t.status = 'pending_review'
      ), 0)::bigint`,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .orderBy(envelopeGroups.position, envelopeGroups.name, envelopes.name);

  return rows.map((row) => ({
    ...row,
    balanceCents: Number(row.balanceCents),
    pendingCents: Number(row.pendingCents),
  }));
}

export type InvariantReport = {
  ok: boolean;
  accountTotalCents: number;
  envelopeTotalCents: number;
  /** Money in accounts not yet assigned to any envelope, i.e. awaiting review. */
  unassignedCents: number;
  /** Non-zero means corruption: a gap the unassigned total does not explain. */
  unexplainedCents: number;
};

/**
 * FR-37. Run after every write and surfaced on the dashboard.
 *
 * The two totals are *not* expected to match outright: a transaction that is
 * still in the review queue has no envelope line yet, and that money genuinely
 * is not assigned. So the real check is that the gap between the two sides is
 * exactly the amount sitting unassigned. Anything left over is a bug, and the
 * user needs to know before trusting a report.
 */
export async function checkInvariant(db: Database): Promise<InvariantReport> {
  const [totals] = await db
    .select({
      accountTotal: sql<string>`coalesce((select sum(amount_cents) from transactions), 0)::bigint`,
      envelopeTotal: sql<string>`coalesce((select sum(amount_cents) from txn_lines), 0)::bigint`,
      unassigned: sql<string>`coalesce((
        select sum(t.amount_cents) from transactions t
        where t.kind = 'spending'
          and not exists (select 1 from txn_lines l where l.transaction_id = t.id)
      ), 0)::bigint`,
    })
    .from(sql`(select 1) as t`);

  const accountTotalCents = Number(totals?.accountTotal ?? 0);
  const envelopeTotalCents = Number(totals?.envelopeTotal ?? 0);
  const unassignedCents = Number(totals?.unassigned ?? 0);
  const unexplainedCents = accountTotalCents - envelopeTotalCents - unassignedCents;

  return {
    ok: unexplainedCents === 0,
    accountTotalCents,
    envelopeTotalCents,
    unassignedCents,
    unexplainedCents,
  };
}

/** The single unallocated envelope that income lands in (FR-28). */
export async function unallocatedEnvelope(db: Database) {
  const [row] = await db.select().from(envelopes).where(eq(envelopes.isUnallocated, true)).limit(1);
  if (!row) {
    throw new LedgerError(
      'No unallocated envelope exists. Run the initial setup before recording money.',
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type NewTransactionLine = {
  envelopeId: string;
  amountCents: number;
};

export type NewTransaction = {
  accountId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amountCents: number;
  payeeRaw: string;
  memo?: string;
  checkNumber?: string;
  source?: 'manual' | 'file_import' | 'bank_sync' | 'goodbudget' | 'opening_balance';
  status?: 'pending_review' | 'confirmed';
  importBatchId?: string;
  /** Omit for an uncategorized transaction; it then contributes nothing to any envelope. */
  lines?: NewTransactionLine[];
  externalIds?: { kind: 'fitid' | 'aggregator' | 'goodbudget'; value: string }[];
};

/**
 * Record a spending transaction and its envelope lines atomically.
 *
 * An uncategorized transaction (no lines) is allowed and is the normal state
 * for something freshly imported that the review queue has not yet resolved.
 * It shows up in `checkInvariant` as a difference, which is correct: that money
 * genuinely is not assigned to an envelope yet.
 */
export async function recordTransaction(db: Database, input: NewTransaction): Promise<string> {
  const lines = input.lines ?? [];

  if (lines.length > 0) {
    const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
    if (total !== input.amountCents) {
      throw new LedgerError(
        `Split does not balance: lines sum to ${total} but the transaction is ${input.amountCents}`,
      );
    }
    if (lines.some((line) => line.amountCents === 0)) {
      throw new LedgerError('A split line cannot be zero; remove it instead');
    }
  }

  if (!Number.isSafeInteger(input.amountCents)) {
    throw new LedgerError(`Amount must be an integer number of cents, got ${input.amountCents}`);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(transactions)
      .values({
        accountId: input.accountId,
        date: input.date,
        amountCents: input.amountCents,
        payeeRaw: input.payeeRaw,
        payeeKey: normalizePayee(input.payeeRaw).key,
        memo: input.memo ?? null,
        checkNumber: input.checkNumber ?? null,
        kind: 'spending',
        status: input.status ?? 'pending_review',
        source: input.source ?? 'manual',
        importBatchId: input.importBatchId ?? null,
      })
      .returning({ id: transactions.id });

    const transactionId = row!.id;

    if (lines.length > 0) {
      await tx.insert(txnLines).values(
        lines.map((line) => ({
          transactionId,
          envelopeId: line.envelopeId,
          amountCents: line.amountCents,
        })),
      );
    }

    if (input.externalIds?.length) {
      await tx.insert(transactionExternalIds).values(
        input.externalIds.map((external) => ({
          transactionId,
          accountId: input.accountId,
          kind: external.kind,
          value: external.value,
        })),
      );
    }

    return transactionId;
  });
}

export type NewAccountTransfer = {
  fromAccountId: string;
  toAccountId: string;
  /** Positive. The debit and credit are derived from it. */
  amountCents: number;
  date: string;
  payeeRaw?: string;
};

/**
 * FR-5. Two linked transactions with no envelope lines, so the money leaves one
 * account and arrives in another without ever counting as spending or income.
 */
export async function recordAccountTransfer(
  db: Database,
  input: NewAccountTransfer,
): Promise<[string, string]> {
  if (input.amountCents <= 0) {
    throw new LedgerError('Transfer amount must be positive; direction comes from the accounts');
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new LedgerError('Cannot transfer an account to itself');
  }

  return db.transaction(async (tx) => {
    const pairId = crypto.randomUUID();
    const payeeRaw = input.payeeRaw ?? 'Account transfer';

    const rows = await tx
      .insert(transactions)
      .values([
        {
          accountId: input.fromAccountId,
          date: input.date,
          amountCents: -input.amountCents,
          payeeRaw,
          payeeKey: normalizePayee(payeeRaw).key,
          kind: 'account_transfer' as const,
          status: 'confirmed' as const,
          source: 'manual' as const,
          transferPairId: pairId,
        },
        {
          accountId: input.toAccountId,
          date: input.date,
          amountCents: input.amountCents,
          payeeRaw,
          payeeKey: normalizePayee(payeeRaw).key,
          kind: 'account_transfer' as const,
          status: 'confirmed' as const,
          source: 'manual' as const,
          transferPairId: pairId,
        },
      ])
      .returning({ id: transactions.id });

    return [rows[0]!.id, rows[1]!.id] as [string, string];
  });
}

export type NewEnvelopeMove = {
  fromEnvelopeId: string;
  toEnvelopeId: string;
  amountCents: number;
  date: string;
  kind: 'allocation' | 'transfer';
  note?: string;
};

/** FR-29, FR-34. One row moves money out of one envelope and into another. */
export async function moveBetweenEnvelopes(
  db: Database,
  input: NewEnvelopeMove,
): Promise<string> {
  if (input.amountCents <= 0) {
    throw new LedgerError('Move amount must be positive; direction comes from the envelopes');
  }
  if (input.fromEnvelopeId === input.toEnvelopeId) {
    throw new LedgerError('Cannot move money from an envelope to itself');
  }

  const [row] = await db
    .insert(envelopeMoves)
    .values({
      fromEnvelopeId: input.fromEnvelopeId,
      toEnvelopeId: input.toEnvelopeId,
      amountCents: input.amountCents,
      date: input.date,
      kind: input.kind,
      note: input.note ?? null,
    })
    .returning({ id: envelopeMoves.id });

  return row!.id;
}

export type NewAccount = {
  name: string;
  kind: 'chequing' | 'savings' | 'credit_card' | 'cash' | 'line_of_credit';
  openingBalanceCents?: number;
  /** Date the opening balance is as of. Defaults to today. */
  openingDate?: string;
  externalAccountId?: string;
  currency?: string;
};

/**
 * FR-1. The opening balance becomes a real transaction landing in the
 * unallocated envelope, which is what lets the invariant hold from the very
 * first account without a carve-out.
 */
export async function openAccount(db: Database, input: NewAccount): Promise<string> {
  const unallocated = input.openingBalanceCents ? await unallocatedEnvelope(db) : undefined;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(accounts)
      .values({
        name: input.name,
        kind: input.kind,
        currency: input.currency ?? 'CAD',
        externalAccountId: input.externalAccountId ?? null,
      })
      .returning({ id: accounts.id });

    const accountId = row!.id;

    if (input.openingBalanceCents && unallocated) {
      const date = input.openingDate ?? new Date().toISOString().slice(0, 10);
      const [opening] = await tx
        .insert(transactions)
        .values({
          accountId,
          date,
          amountCents: input.openingBalanceCents,
          payeeRaw: 'Opening balance',
          payeeKey: 'OPENING BALANCE',
          kind: 'spending',
          status: 'confirmed',
          source: 'opening_balance',
        })
        .returning({ id: transactions.id });

      await tx.insert(txnLines).values({
        transactionId: opening!.id,
        envelopeId: unallocated.id,
        amountCents: input.openingBalanceCents,
      });
    }

    return accountId;
  });
}

/**
 * Assign or reassign a transaction's envelopes, replacing any existing lines.
 * Used by the review queue for both confirming a suggestion and correcting it
 * (RQ-2, RQ-5).
 *
 * Two things happen here that used to live in the caller, and belong here because
 * every caller has to get them right:
 *
 * **An archived envelope is refused.** FR-25 will not let an envelope be archived
 * while it holds money, on the grounds that a balance you cannot see is a
 * difference nobody can find. That guarantee was resting on every picker
 * remembering to filter its list - true today, one stale page away from false,
 * and the ledger is where the rule belongs.
 *
 * **Confirming records what was accepted.** `suggestions.accepted_envelope_id` is
 * what makes the accuracy measure work (CA-9): it compares what was proposed
 * against what was kept. It was written by `confirmTransactions`, which the
 * review queue stopped calling when it moved to staging decisions and saving them
 * in one go - so confirmations quietly stopped being counted, and the number on
 * the settings page began going stale without saying so. Recording it alongside
 * the write that confirms is the version that cannot come apart again.
 */
export async function setTransactionEnvelopes(
  db: Database,
  transactionId: string,
  lines: NewTransactionLine[],
  options: { confirm?: boolean } = {},
): Promise<void> {
  const [transaction] = await db
    .select({ amountCents: transactions.amountCents, kind: transactions.kind })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (!transaction) throw new LedgerError(`No such transaction: ${transactionId}`);
  if (transaction.kind === 'account_transfer') {
    throw new LedgerError('An account transfer has no envelopes (FR-5)');
  }

  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (lines.length > 0 && total !== transaction.amountCents) {
    throw new LedgerError(
      `Split does not balance: lines sum to ${total} but the transaction is ${transaction.amountCents}`,
    );
  }

  if (lines.length > 0) {
    const wanted = [...new Set(lines.map((line) => line.envelopeId))];
    const found = await db
      .select({ id: envelopes.id, name: envelopes.name, archivedAt: envelopes.archivedAt })
      .from(envelopes)
      .where(inArray(envelopes.id, wanted));

    for (const id of wanted) {
      const envelope = found.find((row) => row.id === id);
      if (!envelope) throw new LedgerError(`No such envelope: ${id}`);
      if (envelope.archivedAt !== null) {
        throw new LedgerError(
          `${envelope.name} is archived, so money cannot be put into it. Restore it first, ` +
            'or choose another envelope.',
        );
      }
    }
  }

  await db.transaction(async (tx) => {
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
    await tx
      .update(transactions)
      .set({
        status: options.confirm ? 'confirmed' : undefined,
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, transactionId));

    if (options.confirm) {
      // A suggestion only ever proposes one envelope, so the first line is what
      // it is being compared against. A row with no suggestion has nothing to
      // update and this does nothing, which is correct.
      await tx
        .update(suggestions)
        .set({ acceptedEnvelopeId: lines[0]?.envelopeId ?? null })
        .where(eq(suggestions.transactionId, transactionId));
    }
  });
}
