/**
 * Sessions (NF-3).
 *
 * The cookie carries a random 256-bit token; the database stores only its
 * SHA-256 hash, as the primary key. So a copy of the database - a backup on a
 * disk, a dump in a terminal - does not hand anybody a live session, and a lookup
 * is still a single indexed read. The token is high-entropy and random, so a
 * plain hash is right here: there is no password to slow an attacker down over.
 *
 * Two timeouts, because NF-3 asks for session timeouts and one is not enough:
 *
 *  - an **idle timeout**, extended each time the session is used, so a laptop
 *    left open at the kitchen table stops being a way in overnight;
 *  - an **absolute cap** from when the session was created, which no amount of
 *    activity extends, so a stolen cookie has a definite end.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq, lt, or } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { sessions, users } from '../../db/schema.ts';
import { SESSION_COOKIE } from './cookie.ts';

export { SESSION_COOKIE };

/** Idle timeout: how long a session survives without being used. */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** Absolute cap: how long a session can live at all, however busy. */
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Only extend the idle timeout when it has run down past halfway. Extending on
 * every request would write to the database on every page view for no gain.
 */
const EXTEND_WHEN_REMAINING_BELOW_MS = IDLE_TIMEOUT_MS / 2;

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The stored form of a token. Never reversible, always the same length. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export type CreatedSession = {
  token: string;
  expiresAt: Date;
};

export async function createSession(
  db: Database,
  userId: string,
  now: Date = new Date(),
): Promise<CreatedSession> {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + IDLE_TIMEOUT_MS);

  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    expiresAt,
    createdAt: now,
  });

  // Sweep on the way in. `verifySession` drops a lapsed row when it meets one,
  // which covers every session anybody comes back to - but a session that is
  // never used again is never met, so without this the table only grows. Signing
  // in is the right moment: rare, already writing here, and nobody is waiting on
  // a page render for it.
  await purgeExpiredSessions(db, now);

  return { token, expiresAt };
}

export type ActiveSession = {
  userId: string;
  userName: string;
  /** When the session will lapse if it is not used again. */
  expiresAt: Date;
  /** When it ends regardless of use. */
  endsAt: Date;
};

/**
 * Verify a session token and, as a side effect, keep a live session alive.
 *
 * Returns null for anything that is not a currently valid session, and deletes
 * the row when it has lapsed, so expired sessions do not accumulate for the sake
 * of a cleanup job that might never run.
 */
export async function verifySession(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<ActiveSession | null> {
  if (!token) return null;

  const id = hashToken(token);
  const [row] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      userName: users.name,
      expiresAt: sessions.expiresAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .limit(1);

  if (!row) return null;

  const endsAt = new Date(row.createdAt.getTime() + ABSOLUTE_TIMEOUT_MS);

  if (row.expiresAt <= now || endsAt <= now) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  let expiresAt = row.expiresAt;
  if (expiresAt.getTime() - now.getTime() < EXTEND_WHEN_REMAINING_BELOW_MS) {
    // Never extend past the absolute cap: the cap is the point.
    const extended = new Date(Math.min(now.getTime() + IDLE_TIMEOUT_MS, endsAt.getTime()));
    await db.update(sessions).set({ expiresAt: extended }).where(eq(sessions.id, id));
    expiresAt = extended;
  }

  return { userId: row.userId, userName: row.userName, expiresAt, endsAt };
}

export async function destroySession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

/** Sign out everywhere, for a lost device. */
export async function destroyAllSessions(db: Database, userId: string): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return removed.length;
}

/**
 * Housekeeping: everything lapsed or past its absolute end, gone.
 *
 * Called on every sign-in (see `createSession`), which is often enough for a
 * table that gains a row per device per fortnight and rare enough to cost
 * nothing. `verifySession` also drops a row the moment it finds it expired, so
 * this only ever collects the sessions nobody came back to.
 */
export async function purgeExpiredSessions(db: Database, now: Date = new Date()): Promise<number> {
  const bornBefore = new Date(now.getTime() - ABSOLUTE_TIMEOUT_MS);
  const removed = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now), lt(sessions.createdAt, bornBefore)))
    .returning({ id: sessions.id });
  return removed.length;
}
