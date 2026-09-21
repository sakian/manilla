/**
 * Moving money between envelopes (FR-34), and covering an overspend (FR-35).
 *
 * A transfer touches no account: the money has not gone anywhere, only its
 * assignment changed. That is why it is an `envelope_moves` row and never a
 * transaction, and why FR-36 can keep it out of spending reports by kind alone.
 *
 * FR-35's "cover this" exists because overspending is normal and the fix is
 * always the same tedious arithmetic: find envelopes with room, decide how much
 * to take from each. The suggestion does that arithmetic and still requires a
 * confirmation, because which envelope loses out is a judgement, not a
 * calculation.
 */

import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { envelopeGroups, envelopeMoves, envelopes } from '../../db/schema.ts';
import { moveBetweenEnvelopes } from '../ledger/ledger.ts';
import { localToday } from '../budget/month.ts';

export class TransferError extends Error {}

export type NewTransfer = {
  fromEnvelopeId: string;
  toEnvelopeId: string;
  amountCents: number;
  /** Defaults to today. */
  date?: string;
  note?: string;
};

/** FR-34: move money between any two envelopes, with an amount, date and note. */
export async function transferBetweenEnvelopes(
  db: Database,
  input: NewTransfer,
): Promise<string> {
  if (!Number.isSafeInteger(input.amountCents)) {
    throw new TransferError(`Amount must be a whole number of cents, got ${input.amountCents}`);
  }
  if (input.amountCents <= 0) {
    throw new TransferError('Amount must be more than zero; the direction is the two envelopes');
  }

  const live = await db
    .select({ id: envelopes.id, name: envelopes.name, archivedAt: envelopes.archivedAt })
    .from(envelopes)
    .where(inArray(envelopes.id, [input.fromEnvelopeId, input.toEnvelopeId]));

  for (const id of [input.fromEnvelopeId, input.toEnvelopeId]) {
    const found = live.find((row) => row.id === id);
    if (!found) throw new TransferError(`No such envelope: ${id}`);
    if (found.archivedAt !== null) {
      throw new TransferError(`${found.name} is archived, so money cannot be moved through it`);
    }
  }

  return moveBetweenEnvelopes(db, {
    fromEnvelopeId: input.fromEnvelopeId,
    toEnvelopeId: input.toEnvelopeId,
    amountCents: input.amountCents,
    date: input.date ?? localToday(),
    kind: 'transfer',
    note: input.note?.trim() ? input.note.trim() : undefined,
  });
}

export type CoverSource = {
  envelopeId: string;
  name: string;
  groupName: string;
  /** What this envelope could give without going negative itself. */
  spareCents: number;
  isUnallocated: boolean;
  /** What the suggestion proposes taking from here. */
  proposedCents: number;
};

export type CoverPlan = {
  envelopeId: string;
  name: string;
  /** How far below zero the envelope is. Zero when there is nothing to cover. */
  neededCents: number;
  sources: CoverSource[];
  /** Total the proposal covers, which is less than `neededCents` if there is not enough. */
  proposedCents: number;
};

/**
 * FR-35. Suggest where the money to cover an overspent envelope could come from.
 *
 * The income pool comes first, because unallocated money is the source that costs
 * no other plan anything. After that, the fullest envelopes, on the grounds that
 * the envelope with the most room is the least likely to be short later. Every
 * proposed amount is capped at what that envelope actually has, so accepting the
 * suggestion cannot push a second envelope negative to rescue the first.
 */
export async function coverPlan(db: Database, envelopeId: string): Promise<CoverPlan> {
  const rows = await db
    .select({
      envelopeId: envelopes.id,
      name: envelopes.name,
      groupName: envelopeGroups.name,
      isUnallocated: envelopes.isUnallocated,
      balanceCents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopes.id}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopes.id}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopes.id}), 0)
      )::bigint`,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .where(isNull(envelopes.archivedAt))
    .orderBy(asc(envelopeGroups.position), asc(envelopes.name));

  const target = rows.find((row) => row.envelopeId === envelopeId);
  if (!target) throw new TransferError(`No such envelope: ${envelopeId}`);

  const neededCents = Math.max(0, -Number(target.balanceCents));

  const candidates = rows
    .filter((row) => row.envelopeId !== envelopeId && Number(row.balanceCents) > 0)
    .map((row) => ({
      envelopeId: row.envelopeId,
      name: row.name,
      groupName: row.groupName,
      isUnallocated: row.isUnallocated,
      spareCents: Number(row.balanceCents),
      proposedCents: 0,
    }))
    // The pool first, then whoever has the most room.
    .sort((left, right) => {
      if (left.isUnallocated !== right.isUnallocated) return left.isUnallocated ? -1 : 1;
      return right.spareCents - left.spareCents;
    });

  let outstanding = neededCents;
  for (const candidate of candidates) {
    if (outstanding === 0) break;
    candidate.proposedCents = Math.min(candidate.spareCents, outstanding);
    outstanding -= candidate.proposedCents;
  }

  return {
    envelopeId,
    name: target.name,
    neededCents,
    sources: candidates,
    proposedCents: neededCents - outstanding,
  };
}

/**
 * Apply a cover: one transfer per source, all or nothing.
 *
 * The caller passes the amounts, not just the envelope, because the suggestion is
 * editable - taking $40 from Dates rather than the $63.18 proposed is a perfectly
 * reasonable answer.
 */
export async function coverFrom(
  db: Database,
  envelopeId: string,
  sources: { envelopeId: string; amountCents: number }[],
  options: { date?: string } = {},
): Promise<number> {
  const lines = sources.filter((source) => source.amountCents > 0);
  if (lines.length === 0) return 0;

  const [target] = await db
    .select({ name: envelopes.name })
    .from(envelopes)
    .where(eq(envelopes.id, envelopeId))
    .limit(1);
  if (!target) throw new TransferError(`No such envelope: ${envelopeId}`);

  const date = options.date ?? localToday();

  await db.transaction(async (tx) => {
    for (const line of lines) {
      if (line.envelopeId === envelopeId) {
        throw new TransferError('An envelope cannot cover itself');
      }
      if (!Number.isSafeInteger(line.amountCents)) {
        throw new TransferError(`Amount must be a whole number of cents, got ${line.amountCents}`);
      }
      await tx.insert(envelopeMoves).values({
        fromEnvelopeId: line.envelopeId,
        toEnvelopeId: envelopeId,
        amountCents: line.amountCents,
        date,
        kind: 'transfer',
        note: `Covering ${target.name}`,
      });
    }
  });

  return lines.length;
}

/** Live envelopes other than one, for a transfer picker. */
export async function transferOptions(
  db: Database,
  exceptEnvelopeId?: string,
): Promise<{ id: string; name: string; groupName: string; balanceCents: number }[]> {
  const rows = await db
    .select({
      id: envelopes.id,
      name: envelopes.name,
      groupName: envelopeGroups.name,
      balanceCents: sql<string>`(
        coalesce((select sum(l.amount_cents) from txn_lines l where l.envelope_id = ${envelopes.id}), 0)
        + coalesce((select sum(m.amount_cents) from envelope_moves m where m.to_envelope_id = ${envelopes.id}), 0)
        - coalesce((select sum(m.amount_cents) from envelope_moves m where m.from_envelope_id = ${envelopes.id}), 0)
      )::bigint`,
    })
    .from(envelopes)
    .innerJoin(envelopeGroups, eq(envelopes.groupId, envelopeGroups.id))
    .where(
      exceptEnvelopeId
        ? and(isNull(envelopes.archivedAt), ne(envelopes.id, exceptEnvelopeId))
        : isNull(envelopes.archivedAt),
    )
    .orderBy(asc(envelopeGroups.position), asc(envelopes.name));

  return rows.map((row) => ({ ...row, balanceCents: Number(row.balanceCents) }));
}
