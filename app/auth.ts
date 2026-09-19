import 'server-only';

/**
 * The server-side gate (NF-3).
 *
 * Every page and every server action goes through `requireUser` before it reads
 * or writes anything. The `proxy.ts` check in front of it is a convenience - it
 * redirects a signed-out browser before a page renders - but it only looks at
 * whether a cookie is present, because it runs on every request including
 * prefetches. The check that actually decides is this one, next to the data.
 *
 * `cache` makes it once per request: a page and the three server components under
 * it share one session lookup.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '../db/client.ts';
import { authConfig } from '../src/auth/config.ts';
import {
  ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE,
  createSession,
  destroySession,
  verifySession,
  type ActiveSession,
} from '../src/auth/session.ts';
import { setupState } from '../src/auth/passkeys.ts';

export const currentSession = cache(async (): Promise<ActiveSession | null> => {
  const store = await cookies();
  return verifySession(db(), store.get(SESSION_COOKIE)?.value);
});

/** Redirects to the sign-in page rather than returning null. */
export async function requireUser(): Promise<ActiveSession> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * Issue a session cookie.
 *
 * The cookie is set to expire at the absolute cap rather than the idle timeout,
 * so the server stays the only authority on when a session has gone idle - a
 * browser holding a cookie a little too long is harmless, because the next
 * request finds no session and lands on the sign-in page.
 */
export async function startSession(userId: string): Promise<void> {
  const { token } = await createSession(db(), userId);
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: authConfig().origin.startsWith('https:'),
    sameSite: 'lax',
    path: '/',
    expires: new Date(Date.now() + ABSOLUTE_TIMEOUT_MS),
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  await destroySession(db(), store.get(SESSION_COOKIE)?.value);
  store.delete(SESSION_COOKIE);
}

/** Whether this Manilla has anybody registered yet, for the sign-in page. */
export async function needsSetup(): Promise<boolean> {
  return (await setupState(db())).needsSetup;
}
