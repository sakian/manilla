/**
 * Work that must not overlap with itself.
 *
 * A sync can start four ways - the hourly check, a Plaid webhook, the Sync
 * button, signing in again - and two at once on one connection would read the
 * same cursor, import the same rows and collide on their bank ids. Queued, the
 * second finds the first's cursor and has nothing left to do.
 *
 * The queues live on globalThis because Next can load a module more than once
 * (instrumentation, a route, a server action), and a queue per copy is no queue.
 */

const QUEUES = Symbol.for('manilla.syncQueues');

/** Run `work` once everything queued before it under `key` has finished, failed or not. */
export function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const holder = globalThis as { [QUEUES]?: Map<string, Promise<void>> };
  const queues = (holder[QUEUES] ??= new Map());
  const run = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = run.then(
    () => {},
    () => {},
  );
  queues.set(key, settled);
  // An idle key costs nothing; a map of every connection ever synced would.
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
