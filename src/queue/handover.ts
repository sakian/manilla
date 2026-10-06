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
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { notifyMembers, type PushOptions } from '../push/push.ts';
import { handOver, pendingCount } from './queue.ts';
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
}): { title: string; body: string } {
  const what = input.handed === 1 ? 'a transaction' : `${input.handed} transactions`;
  const where = input.ledger ? ` in ${input.ledger}` : '';
  const total =
    input.waiting > input.handed ? ` ${input.waiting} are waiting for you now.` : '';
  return { title: 'Manilla review', body: `${input.from} handed you ${what} to review${where}.${total}` };
}

/**
 * Where tapping the notification goes: the person's For me list, in the
 * ledger the rows are in when there is more than one, since their phone may
 * have another open.
 */
export function handoverPath(ledgerKey?: string): string {
  const list = '/review?view=mine';
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
    /** The open ledger when there is more than one, so the notification names it and opens it. */
    ledger?: { key: string; name: string };
  },
  options: PushOptions = {},
): Promise<{ handed: number; to: string; sent: Promise<number> }> {
  if (input.to === input.from.id) throw new HandoverError('Hand these to someone else; they are already yours to review.');
  const [member] = await home.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, input.to));
  if (!member) throw new HandoverError('That person is not a member of this household.');

  const handed = await handOver(ledger, input.ids, member.id);
  if (handed === 0) return { handed, to: member.name, sent: Promise.resolve(0) };

  const waiting = await pendingCount(ledger, { handedTo: member.id });
  const message = handoverMessage({
    from: input.from.name,
    handed,
    waiting,
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
