/**
 * Sign-in activity: who changed the ways in, and who tried a way in that did
 * not work (NF-3).
 *
 * Each of these is something a member would want to know about even when they
 * did not do it - most of all then. So every one is kept, each member is shown
 * the ones since they last looked, and an optional webhook (MANILLA_ALERT_URL)
 * carries them to a phone as they happen, for the one that matters at 3am: a
 * recovery code that somebody is guessing at.
 *
 * Plain sign-ins with a passkey are not here. They are what is supposed to
 * happen, and a list of them would bury the rest.
 */

import { and, desc, eq, gt, inArray, ne, or, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { securityEvents, users } from '../../db/schema.ts';
import { push } from '../notify.ts';

export type ActivityKind = NonNullable<(typeof securityEvents.$inferInsert)['kind']>;

type Person = { id: string; name: string };

export type ActivityInput = {
  kind: ActivityKind;
  subject?: Person | null;
  actor?: Person | null;
  detail?: string | null;
  source?: string | null;
  at?: Date;
};

export type Activity = {
  id: string;
  at: Date;
  kind: ActivityKind;
  subjectId: string | null;
  subjectName: string | null;
  actorId: string | null;
  actorName: string | null;
  detail: string | null;
  source: string | null;
};

/** Seen by everyone, including whoever they concern: a code is the thing a thief uses. */
const ALWAYS_SHOWN: ActivityKind[] = ['recovery_code_used', 'recovery_code_failed'];

/**
 * Keep an event, and send it on if a webhook is set and `alert` allows.
 *
 * The webhook is never awaited and never fails the action that raised it: a
 * notification service being down is no reason to refuse a sign-in.
 */
export async function recordActivity(
  db: Database,
  event: ActivityInput,
  options: { alert?: boolean; alertUrl?: string } = {},
): Promise<void> {
  const [row] = await db
    .insert(securityEvents)
    .values({
      kind: event.kind,
      subjectId: event.subject?.id ?? null,
      subjectName: event.subject?.name ?? null,
      actorId: event.actor?.id ?? null,
      actorName: event.actor?.name ?? null,
      detail: event.detail?.slice(0, 100) ?? null,
      source: event.source?.slice(0, 160) ?? null,
      ...(event.at ? { at: event.at } : {}),
    })
    .returning();

  const url = options.alertUrl ?? process.env.MANILLA_ALERT_URL;
  // Names and nothing else: no amounts, no addresses.
  if (url && options.alert !== false) {
    void push(url, `Manilla: ${describeActivity(row!)}`, { title: 'Manilla sign-in' });
  }
}

export async function personOf(db: Database, userId: string): Promise<Person | null> {
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId));
  return row ?? null;
}

export async function recentActivity(db: Database, limit = 20): Promise<Activity[]> {
  return db.select().from(securityEvents).orderBy(desc(securityEvents.at)).limit(limit);
}

/**
 * What this member has not seen: since they last looked (or joined), and not
 * of their own doing - except the recovery-code events, which they see
 * whoever's they were.
 */
export async function unseenActivity(db: Database, userId: string): Promise<Activity[]> {
  // Compared in the database, where both sides are timestamps; a member who no
  // longer exists has no "since", and so sees nothing.
  const since = sql`(select coalesce(${users.securitySeenAt}, ${users.createdAt}) from ${users} where ${users.id} = ${userId})`;

  return db
    .select()
    .from(securityEvents)
    .where(
      and(
        gt(securityEvents.at, since),
        or(
          inArray(securityEvents.kind, ALWAYS_SHOWN),
          isNull(securityEvents.actorId),
          ne(securityEvents.actorId, userId),
        ),
      ),
    )
    .orderBy(desc(securityEvents.at));
}

export async function markActivitySeen(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.update(users).set({ securitySeenAt: now }).where(eq(users.id, userId));
}

/**
 * One line, for a list, a notice, or a phone. A notice leaves out where it came
 * from, to stay one line; the list in Settings has it.
 */
export function describeActivity(event: Activity, options: { source?: boolean } = {}): string {
  const actor = event.actorName ?? 'Someone';
  const subject = event.subjectName ?? 'someone';
  const detail = event.detail ? ` "${event.detail}"` : '';
  const from = event.source && options.source !== false ? `, from ${event.source}` : '';
  const forOther = event.subjectId && event.subjectId !== event.actorId ? ` for ${subject}` : '';

  switch (event.kind) {
    case 'passkey_added':
      return `${actor} added a passkey${detail}${forOther}`;
    case 'passkey_removed':
      return `${actor} removed the passkey${detail}${forOther}`;
    case 'recovery_code_used':
      return `${event.subjectName ?? 'Someone'} signed in with a recovery code${from}`;
    case 'recovery_code_failed':
      return `A recovery code that did not match was tried${from}`;
    case 'recovery_codes_replaced':
      return `${actor} made a new set of recovery codes`;
    case 'invite_created':
      return `${actor} invited ${event.detail ?? 'someone'}`;
    case 'invite_withdrawn':
      return `${actor} withdrew the invitation for ${event.detail ?? 'someone'}`;
    case 'member_joined':
      return `${event.subjectName ?? 'Someone'} joined${event.detail ? `, invited by ${event.detail}` : ''}${from}`;
    case 'member_removed':
      return `${actor} removed ${subject}`;
  }
}

/**
 * The unseen list as a notice: the newest line, and how many more. Failed
 * codes are counted together, since ten of them are one thing happening.
 */
export function summarizeUnseen(events: Activity[]): { text: string; urgent: boolean } | null {
  if (events.length === 0) return null;
  const failures = events.filter((event) => event.kind === 'recovery_code_failed').length;
  const others = events.filter((event) => event.kind !== 'recovery_code_failed');
  const urgent = failures > 0 || others.some((event) => event.kind === 'recovery_code_used');

  const parts: string[] = [];
  if (others.length > 0) {
    const more = others.length - 1;
    parts.push(
      describeActivity(others[0]!, { source: false }) + (more > 0 ? ` and ${more} more` : ''),
    );
  }
  if (failures > 0) {
    parts.push(
      failures === 1
        ? 'a recovery code that did not match was tried'
        : `${failures} recovery codes that did not match were tried`,
    );
  }
  const text = parts.join('; ');
  return { text: text.charAt(0).toUpperCase() + text.slice(1), urgent };
}
