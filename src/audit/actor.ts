/**
 * Who is changing the books, for the audit trail (NF-2).
 *
 * The trail is written by a database trigger, which cannot know who is signed
 * in. So the person travels with the work instead: a server action marks itself
 * with `actAs(await requireUser())`, a scheduled job with `runAs(...)`, and every
 * transaction the database layer opens (db/client.ts) hands that to Postgres as
 * `manilla.actor`, local to the transaction. The trigger copies it onto each
 * row it writes. Nothing else needs to know.
 *
 * Local to the transaction is the point: connections are pooled, and a setting
 * that outlived its transaction would put one person's name on the next
 * person's change.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** `id` is null for work nobody signed in did, like the nightly bank sync. */
export type Actor = { id: string | null; name: string };

const store = new AsyncLocalStorage<Actor>();

/**
 * Mark the rest of this server action as done by the signed-in member, and
 * hand the session back so the call reads `actAs(await requireUser())`.
 *
 * Synchronous on purpose: called in the action's own frame, `enterWith` covers
 * everything the action goes on to await, and nothing outside it. That holds
 * only after the action has awaited something - before its first `await` an
 * async function is still running in its caller's frame, and would mark the
 * caller too. Awaiting `requireUser()` inside the call is what guarantees it.
 */
export function actAs<S extends { userId: string; userName: string }>(session: S): S {
  store.enterWith({ id: session.userId, name: session.userName });
  return session;
}

/** Run work as someone, for jobs that start outside any request. */
export function runAs<T>(actor: Actor, work: () => T): T {
  return store.run(actor, work);
}

export function currentActor(): Actor | undefined {
  return store.getStore();
}

/** What `manilla.actor` is set to: the trigger reads it back as jsonb. */
export function actorSetting(actor: Actor | undefined = currentActor()): string | null {
  return actor ? JSON.stringify({ id: actor.id, name: actor.name.slice(0, 60) }) : null;
}
