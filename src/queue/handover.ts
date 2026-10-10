/**
 * Handing review to someone else (RQ-7).
 *
 * The usual sitting: whoever hears about new transactions goes through them,
 * and leaves a few for the other person to look at. Handing those over marks
 * them as theirs and tells that person alone, so a notification about review
 * on their phone always means "these are yours".
 *
 * There are no roles. Anyone can hand anything waiting to anyone else, and the
 * difference between a first and second reviewer is only in what each has
 * chosen: which view their review list opens on, and which notifications each
 * of their devices takes.
 *
 * A handover can carry a note - "were these for the trip?" - and whoever it
 * went to can answer on each row. Those are kept with the transaction, so the
 * answer outlives the review, and each one tells the person at the other end.
 * What was said never goes on a lock screen: the notification says that
 * someone wrote, and the words are in the app.
 */

import { and, desc, eq, exists, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, envelopes, transactionMessages, transactions, txnLines, users } from '../../db/schema.ts';
import { normalizePayee } from '../categorize/normalize.ts';
import { notifyMembers, type PushOptions } from '../push/push.ts';
import { handOver, pendingCount } from './queue.ts';
import { addMessage, cleanMessage, threadsFor, type Message } from '../transactions/thread.ts';
import { openInLedger } from '../safePath.ts';

export type ReviewView = 'all' | 'mine';

export class HandoverError extends Error {}

/** Which view this person's review list opens on. Kept in the home database, so it is theirs in every ledger. */
export async function reviewOpensOn(home: Database, userId: string): Promise<ReviewView> {
  const [row] = await home.select({ view: users.reviewOpensOn }).from(users).where(eq(users.id, userId));
  return row?.view ?? 'all';
}

export async function setReviewOpensOn(home: Database, userId: string, view: ReviewView): Promise<void> {
  if (view !== 'all' && view !== 'mine') throw new HandoverError('The review list opens on all or mine.');
  await home.update(users).set({ reviewOpensOn: view }).where(eq(users.id, userId));
}

/**
 * What the person handed to sees: who, how many, and how many wait for them in
 * all. A count and a first name, like every other notification, because a lock
 * screen is read by whoever holds the phone.
 */
export function handoverMessage(input: {
  from: string;
  handed: number;
  waiting: number;
  /** Named only when there is more than one, as the sync's notifications do. */
  ledger?: string;
  /** Said, but not quoted: the note is for the app. */
  withNote?: boolean;
}): { title: string; body: string } {
  const what = input.handed === 1 ? 'a transaction' : `${input.handed} transactions`;
  const where = input.ledger ? ` in ${input.ledger}` : '';
  const note = input.withNote ? ', with a note' : '';
  const total =
    input.waiting > input.handed ? ` ${input.waiting} are waiting for you now.` : '';
  return { title: 'Manilla review', body: `${input.from} handed you ${what} to review${where}${note}.${total}` };
}

/** What the other end of a handover sees when someone writes about it. */
export function replyMessage(input: {
  from: string;
  /** Whether the writer is the one who handed it over, or the one it went to. */
  handedIt: boolean;
  ledger?: string;
}): { title: string; body: string } {
  const where = input.ledger ? ` in ${input.ledger}` : '';
  return {
    title: 'Manilla review',
    body: input.handedIt
      ? `${input.from} wrote about a transaction they handed you${where}.`
      : `${input.from} replied about a transaction you handed over${where}.`,
  };
}

/**
 * Where tapping the notification goes: what was handed to the person, one
 * at a time with each one's thread, in the ledger the rows are in when there
 * is more than one, since their phone may have another open.
 */
export function handoverPath(ledgerKey?: string): string {
  const list = '/review/one?view=mine';
  return ledgerKey ? openInLedger(ledgerKey, list) : list;
}

/** Where a reply opens: every conversation, since the row may be reviewed and off the list. */
export function notesPath(ledgerKey?: string): string {
  const list = '/review/notes';
  return ledgerKey ? openInLedger(ledgerKey, list) : list;
}

/**
 * Hand rows to a member and tell them.
 *
 * The member is checked here, against the home database's list, because the
 * id comes from a form anyone signed in can post. Handing to yourself is
 * refused: it would notify you about your own decision.
 */
export async function handOverTo(
  ledger: Database,
  home: Database,
  input: {
    ids: string[];
    to: string;
    from: { id: string; name: string };
    /** For them, on every row handed. */
    note?: string;
    /** The open ledger when there is more than one, so the notification names it and opens it. */
    ledger?: { key: string; name: string };
  },
  options: PushOptions = {},
): Promise<{ handed: number; to: string; sent: Promise<number> }> {
  if (input.to === input.from.id) throw new HandoverError('Hand these to someone else; they are already yours to review.');
  const [member] = await home.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.to));
  if (!member) throw new HandoverError('That person is not a member of this household.');

  let note: string;
  try {
    note = cleanMessage(input.note ?? '');
  } catch (error) {
    throw new HandoverError((error as Error).message);
  }
  const handed = await handOver(ledger, input.ids, member.id, { note });
  if (handed === 0) return { handed, to: member.name, sent: Promise.resolve(0) };

  const waiting = await pendingCount(ledger, { handedTo: member.id });
  const message = handoverMessage({
    from: input.from.name,
    handed,
    waiting,
    withNote: note !== '',
    ...(input.ledger ? { ledger: input.ledger.name } : {}),
  });
  const { sent } = await notifyMembers(
    home,
    { kind: 'handed', only: member.id },
    { ...message, path: handoverPath(input.ledger?.key) },
    options,
  );
  return { handed, to: member.name, sent };
}

/**
 * Write in a transaction's thread, and, when it was handed over, tell whoever
 * is at the other end of the handover.
 *
 * Whoever handed it hears from anyone else who writes, and when they write
 * themselves it goes to the person they handed it to, so a reply to a reply
 * reaches back. A row reviewed since still counts: the question is often
 * answered by reviewing it. A row never handed over has nobody in particular
 * to tell, and says so, so the caller can tell the household as it would of
 * any other change.
 */
export async function writeAbout(
  ledger: Database,
  home: Database,
  input: {
    transactionId: string;
    body: string;
    from: { id: string; name: string };
    ledger?: { key: string; name: string };
  },
  options: PushOptions = {},
): Promise<{ message: Message; status: 'pending_review' | 'confirmed'; handed: boolean; sent: Promise<number> }> {
  const [row] = await ledger
    .select({ status: transactions.status, handedToId: transactions.handedToId, handedById: transactions.handedById })
    .from(transactions)
    .where(eq(transactions.id, input.transactionId));
  if (!row) throw new HandoverError('That transaction is no longer there.');

  const message = await addMessage(ledger, input.transactionId, input.body);
  const handed = row.handedToId !== null;
  const handedIt = row.handedById === input.from.id;
  const to = handedIt ? row.handedToId : row.handedById;
  if (!handed || !to || to === input.from.id) {
    return { message, status: row.status, handed, sent: Promise.resolve(0) };
  }
  const { sent } = await notifyMembers(
    home,
    { kind: 'handed', only: to },
    {
      ...replyMessage({ from: input.from.name, handedIt, ...(input.ledger ? { ledger: input.ledger.name } : {}) }),
      path: notesPath(input.ledger?.key),
    },
    options,
  );
  return { message, status: row.status, handed, sent };
}

export type Conversation = {
  id: string;
  date: string;
  payeeDisplay: string;
  amountCents: number;
  accountName: string;
  status: 'pending_review' | 'confirmed';
  envelopeNames: string[];
  handedToId: string | null;
  handedById: string | null;
  messages: Message[];
};

/**
 * Every handed-over row someone has written about that this person is part
 * of - handed it, was handed it, or wrote about it - with the latest
 * conversation first. Reviewed rows stay, since that is when the answer
 * usually comes.
 */
export async function conversations(
  db: Database,
  userId: string,
  options: { limit?: number } = {},
): Promise<Conversation[]> {
  const latest = sql<Date>`(select max(${transactionMessages.createdAt}) from ${transactionMessages} where ${transactionMessages.transactionId} = ${transactions.id})`;
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      amountCents: transactions.amountCents,
      accountName: accounts.name,
      status: transactions.status,
      handedToId: transactions.handedToId,
      handedById: transactions.handedById,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        // Handed over, and written about: a note on a row nobody handed is the
        // household's, and is on the transactions screen.
        sql`${transactions.handedToId} is not null`,
        exists(
          db.select({ one: sql`1` }).from(transactionMessages).where(eq(transactionMessages.transactionId, transactions.id)),
        ),
        or(
          eq(transactions.handedToId, userId),
          eq(transactions.handedById, userId),
          exists(
            db
              .select({ one: sql`1` })
              .from(transactionMessages)
              .where(and(eq(transactionMessages.transactionId, transactions.id), eq(transactionMessages.authorId, userId))),
          ),
        ),
      ),
    )
    .orderBy(desc(latest), desc(transactions.id))
    .limit(options.limit ?? 50);

  const ids = rows.map((row) => row.id);
  const [messages, lines] = await Promise.all([
    threadsFor(db, ids),
    ids.length
      ? db
          .select({ transactionId: txnLines.transactionId, name: envelopes.name })
          .from(txnLines)
          .innerJoin(envelopes, eq(envelopes.id, txnLines.envelopeId))
          .where(inArray(txnLines.transactionId, ids))
      : Promise.resolve([]),
  ]);
  const names = new Map<string, string[]>();
  for (const line of lines) names.set(line.transactionId, [...(names.get(line.transactionId) ?? []), line.name]);

  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    payeeDisplay: normalizePayee(row.payeeRaw).display,
    amountCents: Number(row.amountCents),
    accountName: row.accountName,
    status: row.status,
    envelopeNames: names.get(row.id) ?? [],
    handedToId: row.handedToId,
    handedById: row.handedById,
    messages: messages.get(row.id) ?? [],
  }));
}
