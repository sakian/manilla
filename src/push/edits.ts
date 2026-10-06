/**
 * Telling the rest of the household about changes to transactions.
 *
 * Two kinds, each a switch of its own and off until someone turns it on. Review
 * activity is someone else working through what waits for review, which is how
 * the person who handed transactions over (RQ-7) hears that they have been
 * dealt with. Changes to reviewed transactions are later corrections to what
 * was already settled, which fewer people will want.
 *
 * One notification per save, however many transactions it touched, and never
 * to the person who made it. Names and counts only, like every other
 * notification, because a lock screen is read by whoever holds the phone.
 */

import { inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { transactions } from '../../db/schema.ts';
import { notifyMembers, type PushOptions } from './push.ts';
import { openInLedger } from '../safePath.ts';

export type EditNotice =
  | { kind: 'review'; action: 'reviewed' | 'changed' | 'deleted'; count: number }
  | { kind: 'changes'; action: 'changed' | 'deleted' | 'sent back'; count: number };

const TITLES = { review: 'Manilla review activity', changes: 'Manilla changes' } as const;

/** What the others read: who did what to how many, and where when there is more than one ledger. */
export function editMessage(
  who: string,
  notice: EditNotice,
  ledger?: string,
): { title: string; body: string } {
  const many = notice.count > 1;
  const where = ledger ? ` in ${ledger}` : '';
  let what: string;
  if (notice.kind === 'review') {
    const them = many ? `${notice.count} transactions` : 'a transaction';
    what =
      notice.action === 'reviewed'
        ? `reviewed ${them}`
        : `${notice.action} ${them} waiting for review`;
  } else {
    const them = many ? `${notice.count} reviewed transactions` : 'a reviewed transaction';
    what = notice.action === 'sent back' ? `sent ${them} back to review` : `${notice.action} ${them}`;
  }
  return { title: TITLES[notice.kind], body: `${who} ${what}${where}.` };
}

/**
 * Tell everyone but the person who did it, on the devices that asked.
 * Nothing for nothing: a save that changed no transaction says so to nobody.
 */
export async function tellAboutEdit(
  home: Database,
  input: {
    actor: { id: string; name: string };
    notice: EditNotice;
    /** The open ledger when there is more than one: named, and opened by a tap. */
    ledger?: { key: string; name: string };
  },
  options: PushOptions = {},
): Promise<{ sent: Promise<number> }> {
  if (input.notice.count <= 0) return { sent: Promise.resolve(0) };
  const message = editMessage(input.actor.name, input.notice, input.ledger?.name);
  return notifyMembers(
    home,
    { kind: input.notice.kind, except: input.actor.id },
    { ...message, path: input.ledger ? openInLedger(input.ledger.key, '/transactions') : '/transactions' },
    options,
  );
}

/**
 * How many of these transactions are waiting for review, and how many were
 * reviewed already, read before a change so the change can be told to the
 * right people afterwards.
 */
export async function reviewStates(
  db: Database,
  ids: string[],
): Promise<{ waiting: number; reviewed: number }> {
  if (ids.length === 0) return { waiting: 0, reviewed: 0 };
  const rows = await db
    .select({ status: transactions.status })
    .from(transactions)
    .where(inArray(transactions.id, ids));
  const waiting = rows.filter((row) => row.status === 'pending_review').length;
  return { waiting, reviewed: rows.length - waiting };
}
