/**
 * Envelope and group management (FR-21 to FR-25).
 *
 * The rule worth stating out loud is FR-25: an envelope holding money cannot be
 * archived. Archiving is not deleting - the history stays - but an archived
 * envelope disappears from the dashboard, and money that is invisible is money
 * that breaks the central invariant in the only way that matters, quietly. So
 * archiving either finds the envelope empty, or is told where the balance should
 * go, and moves it first in the same database transaction.
 *
 * Nothing here deletes an envelope. A deletion would orphan transaction lines
 * and rewrite past reports; archiving is the honest form of "I am done with
 * this".
 */

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  envelopeGroups,
  envelopeMoves,
  envelopes,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { envelopeBalance } from '../budget/budget.ts';
import { localToday } from '../budget/month.ts';

export class EnvelopeError extends Error {}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ManagedEnvelope = {
  id: string;
  name: string;
  groupId: string;
  groupName: string;
  position: number;
  carryOver: boolean;
  isUnallocated: boolean;
  archivedAt: Date | null;
  balanceCents: number;
};

export type ManagedGroup = {
  id: string;
  name: string;
  position: number;
  archivedAt: Date | null;
  envelopes: ManagedEnvelope[];
};

/** Every envelope, grouped, for the management screen. */
export async function listEnvelopes(
  db: Database,
  options: { includeArchived?: boolean } = {},
): Promise<ManagedGroup[]> {
  const rows = await db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      groupId: envelopeGroups.id,
      groupName: envelopeGroups.name,
      position: envelopes.position,
      carryOver: envelopes.carryOver,
      isUnallocated: envelopes.isUnallocated,
      archivedAt: envelopes.archivedAt,
      balanceCents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopes.id}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopes.id}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopes.id}), 0)
      )::bigint`,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .orderBy(
      asc(envelopeGroups.position),
      asc(envelopeGroups.name),
      asc(envelopes.position),
      asc(envelopes.name),
    );

  const groups = new Map<string, ManagedGroup>();
  const allGroups = await db
    .select()
    .from(envelopeGroups)
    .orderBy(asc(envelopeGroups.position), asc(envelopeGroups.name));

  for (const group of allGroups) {
    if (!options.includeArchived && group.archivedAt !== null) continue;
    groups.set(group.id, {
      id: group.id,
      name: group.name,
      position: group.position,
      archivedAt: group.archivedAt,
      envelopes: [],
    });
  }

  for (const row of rows) {
    if (!options.includeArchived && row.archivedAt !== null) continue;
    const group = groups.get(row.groupId);
    if (!group) continue;
    group.envelopes.push({
      id: row.id,
      name: row.name,
      groupId: row.groupId,
      groupName: row.groupName,
      position: row.position,
      carryOver: row.carryOver,
      isUnallocated: row.isUnallocated,
      archivedAt: row.archivedAt,
      balanceCents: Number(row.balanceCents),
    });
  }

  return [...groups.values()];
}

export type EnvelopeEvent =
  | {
      kind: 'transaction';
      id: string;
      date: string;
      description: string;
      amountCents: number;
      pending: boolean;
      accountName: string;
      transactionId: string;
    }
  | {
      kind: 'allocation' | 'transfer';
      id: string;
      date: string;
      description: string;
      amountCents: number;
      pending: false;
    };

/**
 * One envelope's history: its spending, the money allocated into it, and the
 * transfers either way (VW-4). Newest first, because that is the end you look at.
 */
export async function envelopeHistory(
  db: Database,
  envelopeId: string,
  options: { limit?: number } = {},
): Promise<EnvelopeEvent[]> {
  const limit = options.limit ?? 100;

  const spending = await db
    .select({
      id: txnLines.id,
      transactionId: transactions.id,
      amountCents: txnLines.amountCents,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      status: transactions.status,
      accountName: accounts.name,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(transactions.id, txnLines.transactionId))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(eq(txnLines.envelopeId, envelopeId))
    .orderBy(desc(transactions.date), desc(transactions.createdAt))
    .limit(limit);

  // The same table twice, under two aliases, rather than correlated subqueries:
  // Drizzle leaves column references unqualified in a single-table query, and an
  // unqualified name that also exists inside the subquery binds there instead.
  const source = alias(envelopes, 'source_envelope');
  const destination = alias(envelopes, 'destination_envelope');

  const moves = await db
    .select({
      id: envelopeMoves.id,
      date: envelopeMoves.date,
      amountCents: envelopeMoves.amountCents,
      kind: envelopeMoves.kind,
      note: envelopeMoves.note,
      fromEnvelopeId: envelopeMoves.fromEnvelopeId,
      fromName: source.name,
      toName: destination.name,
    })
    .from(envelopeMoves)
    .innerJoin(source, eq(source.id, envelopeMoves.fromEnvelopeId))
    .innerJoin(destination, eq(destination.id, envelopeMoves.toEnvelopeId))
    .where(
      or(
        eq(envelopeMoves.toEnvelopeId, envelopeId),
        eq(envelopeMoves.fromEnvelopeId, envelopeId),
      ),
    )
    .orderBy(desc(envelopeMoves.date), desc(envelopeMoves.createdAt))
    .limit(limit);

  const events: EnvelopeEvent[] = [
    ...spending.map(
      (row): EnvelopeEvent => ({
        kind: 'transaction',
        id: `line-${row.id}`,
        transactionId: row.transactionId,
        date: row.date,
        description: row.payeeRaw,
        amountCents: Number(row.amountCents),
        pending: row.status === 'pending_review',
        accountName: row.accountName,
      }),
    ),
    ...moves.map((row): EnvelopeEvent => {
      const incoming = row.fromEnvelopeId !== envelopeId;
      const other = incoming ? row.fromName : row.toName;
      return {
        kind: row.kind,
        id: `move-${row.id}`,
        date: row.date,
        description: row.note ?? (incoming ? `Moved in from ${other}` : `Moved out to ${other}`),
        amountCents: incoming ? Number(row.amountCents) : -Number(row.amountCents),
        pending: false,
      };
    }),
  ];

  return events
    .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

function cleanName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new EnvelopeError(`${what} needs a name`);
  if (trimmed.length > 80) throw new EnvelopeError(`${what} name is too long (80 characters max)`);
  return trimmed;
}

export async function createGroup(db: Database, name: string): Promise<string> {
  const clean = cleanName(name, 'A group');
  const [last] = await db
    .select({ position: envelopeGroups.position })
    .from(envelopeGroups)
    .orderBy(sql`${envelopeGroups.position} desc`)
    .limit(1);

  const [row] = await db
    .insert(envelopeGroups)
    .values({ name: clean, position: (last?.position ?? -1) + 1 })
    .returning({ id: envelopeGroups.id });

  return row!.id;
}

export async function renameGroup(db: Database, groupId: string, name: string): Promise<void> {
  const clean = cleanName(name, 'A group');
  const result = await db
    .update(envelopeGroups)
    .set({ name: clean })
    .where(eq(envelopeGroups.id, groupId))
    .returning({ id: envelopeGroups.id });
  if (result.length === 0) throw new EnvelopeError(`No such group: ${groupId}`);
}

/**
 * A group is archived only once it is empty of live envelopes, because archiving
 * a group with envelopes in it would hide their balances without the FR-25 check
 * ever running.
 */
export async function archiveGroup(db: Database, groupId: string): Promise<void> {
  const live = await db
    .select({ id: envelopes.id, name: envelopes.name })
    .from(envelopes)
    .where(and(eq(envelopes.groupId, groupId), isNull(envelopes.archivedAt)));

  if (live.length > 0) {
    throw new EnvelopeError(
      `This group still holds ${live.length} live envelope${live.length === 1 ? '' : 's'} ` +
        `(${live.map((row) => row.name).join(', ')}). Archive or move them first.`,
    );
  }

  await db
    .update(envelopeGroups)
    .set({ archivedAt: new Date() })
    .where(eq(envelopeGroups.id, groupId));
}

export async function unarchiveGroup(db: Database, groupId: string): Promise<void> {
  await db.update(envelopeGroups).set({ archivedAt: null }).where(eq(envelopeGroups.id, groupId));
}

/** Positions come from the order of the array, so the caller states the order it wants. */
export async function reorderGroups(db: Database, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(envelopeGroups).set({ position: index }).where(eq(envelopeGroups.id, id));
    }
  });
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export type NewEnvelope = {
  groupId: string;
  name: string;
  /** FR-23: on by default, as in GoodBudget. */
  carryOver?: boolean;
};

export async function createEnvelope(db: Database, input: NewEnvelope): Promise<string> {
  const name = cleanName(input.name, 'An envelope');

  const [group] = await db
    .select({ id: envelopeGroups.id, archivedAt: envelopeGroups.archivedAt })
    .from(envelopeGroups)
    .where(eq(envelopeGroups.id, input.groupId))
    .limit(1);
  if (!group) throw new EnvelopeError(`No such group: ${input.groupId}`);
  if (group.archivedAt !== null) {
    throw new EnvelopeError('That group is archived. Restore it before adding envelopes to it.');
  }

  const [last] = await db
    .select({ position: envelopes.position })
    .from(envelopes)
    .where(eq(envelopes.groupId, input.groupId))
    .orderBy(sql`${envelopes.position} desc`)
    .limit(1);

  const [row] = await db
    .insert(envelopes)
    .values({
      groupId: input.groupId,
      name,
      position: (last?.position ?? -1) + 1,
      carryOver: input.carryOver ?? true,
    })
    .returning({ id: envelopes.id });

  return row!.id;
}

export type EnvelopeEdit = {
  name?: string;
  groupId?: string;
  carryOver?: boolean;
};

export async function editEnvelope(
  db: Database,
  envelopeId: string,
  edit: EnvelopeEdit,
): Promise<void> {
  const [envelope] = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!envelope) throw new EnvelopeError(`No such envelope: ${envelopeId}`);

  const changes: Record<string, unknown> = {};
  if (edit.name !== undefined) changes.name = cleanName(edit.name, 'An envelope');
  if (edit.carryOver !== undefined) changes.carryOver = edit.carryOver;

  if (edit.groupId !== undefined && edit.groupId !== envelope.groupId) {
    const [group] = await db
      .select({ id: envelopeGroups.id, archivedAt: envelopeGroups.archivedAt })
      .from(envelopeGroups)
      .where(eq(envelopeGroups.id, edit.groupId))
      .limit(1);
    if (!group) throw new EnvelopeError(`No such group: ${edit.groupId}`);
    if (group.archivedAt !== null) throw new EnvelopeError('That group is archived.');
    changes.groupId = edit.groupId;

    const [last] = await db
      .select({ position: envelopes.position })
      .from(envelopes)
      .where(eq(envelopes.groupId, edit.groupId))
      .orderBy(sql`${envelopes.position} desc`)
      .limit(1);
    changes.position = (last?.position ?? -1) + 1;
  }

  if (Object.keys(changes).length === 0) return;
  await db.update(envelopes).set(changes).where(eq(envelopes.id, envelopeId));
}

export type ArchiveOptions = {
  /** Where a leftover balance should go. Required when the balance is not zero. */
  moveBalanceTo?: string;
  /** Date to stamp on the balance-clearing move. Defaults to today. */
  today?: string;
};

/**
 * FR-25. Archiving an envelope with money in it either moves the money where the
 * caller says, or refuses and says how much is in the way.
 *
 * A negative balance counts too: archiving an overspent envelope would hide a
 * debt, and the same rule - move it somewhere real first - applies.
 */
export async function archiveEnvelope(
  db: Database,
  envelopeId: string,
  options: ArchiveOptions = {},
): Promise<void> {
  const [envelope] = await db
    .select()
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!envelope) throw new EnvelopeError(`No such envelope: ${envelopeId}`);
  if (envelope.archivedAt !== null) return;

  if (envelope.isUnallocated) {
    throw new EnvelopeError(
      'The income pool cannot be archived: it is where income lands and allocations come from (FR-28).',
    );
  }

  const balanceCents = await envelopeBalance(db, envelopeId);

  if (balanceCents !== 0 && options.moveBalanceTo === undefined) {
    const amount = (Math.abs(balanceCents) / 100).toFixed(2);
    throw new EnvelopeError(
      balanceCents > 0
        ? `${envelope.name} still holds $${amount}. Move that balance to another envelope first (FR-25).`
        : `${envelope.name} is overspent by $${amount}. Cover it from another envelope first (FR-25).`,
    );
  }

  const destination = options.moveBalanceTo;
  const date = options.today ?? localToday();

  await db.transaction(async (tx) => {
    if (balanceCents !== 0 && destination !== undefined) {
      if (destination === envelopeId) {
        throw new EnvelopeError('The balance has to go somewhere else');
      }
      const [target] = await tx
        .select({ id: envelopes.id, archivedAt: envelopes.archivedAt })
        .from(envelopes)
        .where(eq(envelopes.id, destination))
        .limit(1);
      if (!target) throw new EnvelopeError(`No such envelope: ${destination}`);
      if (target.archivedAt !== null) {
        throw new EnvelopeError('The balance cannot be moved into an archived envelope');
      }

      // A positive balance moves out; a negative one is covered from the target.
      await tx.insert(envelopeMoves).values(
        balanceCents > 0
          ? {
              fromEnvelopeId: envelopeId,
              toEnvelopeId: destination,
              amountCents: balanceCents,
              date,
              kind: 'transfer' as const,
              note: `Emptied on archiving ${envelope.name}`,
            }
          : {
              fromEnvelopeId: destination,
              toEnvelopeId: envelopeId,
              amountCents: -balanceCents,
              date,
              kind: 'transfer' as const,
              note: `Covered overspend on archiving ${envelope.name}`,
            },
      );
    }

    await tx.update(envelopes).set({ archivedAt: new Date() }).where(eq(envelopes.id, envelopeId));
  });
}

export async function unarchiveEnvelope(db: Database, envelopeId: string): Promise<void> {
  const [envelope] = await db
    .select({ id: envelopes.id, groupId: envelopes.groupId })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!envelope) throw new EnvelopeError(`No such envelope: ${envelopeId}`);

  const [group] = await db
    .select({ archivedAt: envelopeGroups.archivedAt })
    .from(envelopeGroups)
    .where(eq(envelopeGroups.id, envelope.groupId))
    .limit(1);
  if (!group || group.archivedAt !== null) {
    throw new EnvelopeError('Restore the envelope group first, or move the envelope to a live one.');
  }

  await db.update(envelopes).set({ archivedAt: null }).where(eq(envelopes.id, envelopeId));
}

/** Set the order within a group from the order of the array (FR-21). */
export async function reorderEnvelopes(
  db: Database,
  groupId: string,
  orderedIds: string[],
): Promise<void> {
  const inGroup = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(eq(envelopes.groupId, groupId));
  const known = new Set(inGroup.map((row) => row.id));

  for (const id of orderedIds) {
    if (!known.has(id)) throw new EnvelopeError(`Envelope ${id} is not in that group`);
  }

  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(envelopes).set({ position: index }).where(eq(envelopes.id, id));
    }
  });
}

/** Move one envelope up or down among its live siblings, for an arrow button. */
export async function nudgeEnvelope(
  db: Database,
  envelopeId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const [envelope] = await db
    .select({ groupId: envelopes.groupId })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!envelope) throw new EnvelopeError(`No such envelope: ${envelopeId}`);

  const siblings = await db
    .select({ id: envelopes.id })
    .from(envelopes)
    .where(and(eq(envelopes.groupId, envelope.groupId), isNull(envelopes.archivedAt)))
    .orderBy(asc(envelopes.position), asc(envelopes.name));

  const order = siblings.map((row) => row.id);
  const at = order.indexOf(envelopeId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at === -1 || to < 0 || to >= order.length) return;

  [order[at], order[to]] = [order[to]!, order[at]!];
  await reorderEnvelopes(db, envelope.groupId, order);
}
