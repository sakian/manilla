/**
 * Waiting for Postgres at boot.
 *
 * After a power cut Docker restarts every container at once and ignores
 * `depends_on`, so the app can reach Postgres while it is still replaying its
 * log and answering "the database system is starting up". Next runs
 * `register()` once: a failure there left the server up, serving nothing but
 * 500s until someone restarted it by hand. So a database that is not there yet
 * is waited for, and anything else still fails at once.
 */

/** Postgres classes and socket codes that mean "not yet", not "wrong". */
const NOT_YET = new Set([
  '57P03', // cannot_connect_now: starting up, or in recovery
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND', // the `db` name resolves only once its container is on the network
  'EAI_AGAIN',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT', // postgres.js
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
]);

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = error; at !== undefined && at !== null && chain.length < 10; at = (at as { cause?: unknown }).cause) {
    chain.push(at);
  }
  return chain;
}

/** Whether anything in the error's cause chain says the database is not up yet. */
export function databaseNotUpYet(error: unknown): boolean {
  return causes(error).some((at) => {
    const code = (at as { code?: unknown }).code;
    // Class 08 is connection exceptions.
    return typeof code === 'string' && (NOT_YET.has(code) || code.startsWith('08'));
  });
}

/**
 * The innermost message, which is the one that says what happened: drizzle's
 * own is "Failed query: …", and on its own sent the log reader nowhere.
 */
export function rootMessage(error: unknown): string {
  const chain = causes(error);
  const root = chain[chain.length - 1];
  return root instanceof Error ? root.message : String(root);
}

export interface WaitOptions {
  /** How long to keep trying. Two minutes covers a crash recovery with room to spare. */
  forMs?: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Run `attempt` until it succeeds, retrying only while the database is not up
 * yet, with backoff capped at ten seconds. The last error is rethrown.
 */
export async function retryWhileDatabaseStarts<T>(attempt: () => Promise<T>, options: WaitOptions = {}): Promise<T> {
  const {
    forMs = 120_000,
    log = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = options;
  const giveUpAt = now() + forMs;
  let delay = 1_000;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!databaseNotUpYet(error) || now() + delay > giveUpAt) throw error;
      log(`the database is not up yet (${rootMessage(error)}); trying again in ${delay / 1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }
}
