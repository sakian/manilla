/**
 * What people have written about a transaction, as a thread (RQ-7).
 *
 * Once a single note, which one person could only overwrite; now each thing
 * said is kept, in order and with who said it, so "were these for the trip?"
 * and "yes, the gas on the way" read as a question and its answer. The first
 * message plays the note's old part - the transactions list shows the latest,
 * and search matches any.
 *
 * Every write is in a database transaction, so the author is whoever is acting
 * (src/audit/actor.ts) and an edit or removal is in the audit trail. Only the
 * author may change or remove a message: the others in the household are
 * answering it.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { transactionMessages } from '../../db/schema.ts';
import { NOTE_LIMIT } from './limits.ts';

export type Message = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  at: Date;
  editedAt: Date | null;
};

export class ThreadError extends Error {}

/** As it is kept: trimmed, and refused when too long rather than cut. */
export function cleanMessage(text: string): string {
  const body = text.trim();
  if (body.length > NOTE_LIMIT) {
    throw new ThreadError(`Keep it to ${NOTE_LIMIT} characters; that is ${body.length}.`);
  }
  return body;
}

const asMessage = (row: typeof transactionMessages.$inferSelect): Message => ({
  id: row.id,
  authorId: row.authorId,
  authorName: row.authorName,
  body: row.body,
  at: row.createdAt,
  editedAt: row.editedAt,
});

/** Each transaction's thread, oldest first, for the ones that have one. */
export async function threadsFor(db: Database, ids: string[]): Promise<Map<string, Message[]>> {
  const found = new Map<string, Message[]>();
  if (ids.length === 0) return found;
  const rows = await db
    .select()
    .from(transactionMessages)
    .where(inArray(transactionMessages.transactionId, ids))
    .orderBy(asc(transactionMessages.createdAt), asc(transactionMessages.id));
  for (const row of rows) {
    const list = found.get(row.transactionId) ?? [];
    list.push(asMessage(row));
    found.set(row.transactionId, list);
  }
  return found;
}

export async function threadOf(db: Database, transactionId: string): Promise<Message[]> {
  return (await threadsFor(db, [transactionId])).get(transactionId) ?? [];
}

/** Add to the thread. Nothing to say is refused, not written as an empty message. */
export async function addMessage(db: Database, transactionId: string, text: string): Promise<Message> {
  const body = cleanMessage(text);
  if (!body) throw new ThreadError('Write something first.');
  const [row] = await db.transaction((tx) =>
    tx.insert(transactionMessages).values({ transactionId, body }).returning(),
  );
  return asMessage(row!);
}

/** Change your own message. Emptying it is removing it, which is its own step. */
export async function editMessage(db: Database, messageId: string, authorId: string, text: string): Promise<Message> {
  const body = cleanMessage(text);
  if (!body) throw new ThreadError('To take it back, remove it instead.');
  const [row] = await db.transaction((tx) =>
    tx
      .update(transactionMessages)
      .set({ body, editedAt: new Date() })
      .where(and(eq(transactionMessages.id, messageId), eq(transactionMessages.authorId, authorId)))
      .returning(),
  );
  if (!row) throw new ThreadError('Only whoever wrote that can change it.');
  return asMessage(row);
}

export async function removeMessage(db: Database, messageId: string, authorId: string): Promise<void> {
  const removed = await db.transaction((tx) =>
    tx
      .delete(transactionMessages)
      .where(and(eq(transactionMessages.id, messageId), eq(transactionMessages.authorId, authorId)))
      .returning({ id: transactionMessages.id }),
  );
  if (removed.length === 0) throw new ThreadError('Only whoever wrote that can remove it.');
}

/** Which transaction a message is in, so a change to it can be told about. */
export async function messageTransaction(db: Database, messageId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: transactionMessages.transactionId })
    .from(transactionMessages)
    .where(eq(transactionMessages.id, messageId));
  return row?.id;
}
