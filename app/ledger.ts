import 'server-only';

/**
 * The ledger this request is looking at (LG-1).
 *
 * Everything about money goes through `ledgerDb()`; only sign-in uses
 * `homeDb()`. There is deliberately no plain `db()` any more: with two ledgers,
 * a call that did not say which one it meant would read the wrong books
 * without an error, so each call site now has to say.
 *
 * Which ledger is a cookie, read once per request (`cache`). The cookie only
 * selects among the ledgers listed in the home database (`chooseLedger`), so a
 * forged one can name nothing that is not already a ledger - and every action
 * still calls `requireUser()` before any of this matters.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { connectionFor, homeDb, type Database } from '../db/client.ts';
import { chooseLedger, databaseOf, type Ledger } from '../src/ledgers/config.ts';
import { listLedgers } from '../src/ledgers/registry.ts';
import { authConfig } from '../src/auth/config.ts';

export const LEDGER_COOKIE = 'manilla_ledger';

/** The home database's name: the home ledger's key. */
export function homeDatabase(): string {
  return databaseOf(process.env.DATABASE_URL ?? '');
}

/** Every ledger, the home one first - read from the home database, once a request. */
export const allLedgers = cache(async (): Promise<Ledger[]> => listLedgers(homeDb(), homeDatabase()));

export const currentLedger = cache(async (): Promise<Ledger> => {
  const store = await cookies();
  return chooseLedger(await allLedgers(), store.get(LEDGER_COOKIE)?.value);
});

/** The open ledger's name for a download's filename, when there is more than one. */
export async function ledgerForFilename(): Promise<string | undefined> {
  return (await allLedgers()).length > 1 ? (await currentLedger()).name : undefined;
}

/**
 * Make `key` the open ledger for this browser. Only from a server action, and
 * only with a key already checked against `allLedgers()`.
 */
export async function rememberLedger(key: string): Promise<void> {
  const store = await cookies();
  store.set(LEDGER_COOKIE, key, {
    httpOnly: true,
    secure: authConfig().origin.startsWith('https:'),
    sameSite: 'lax',
    path: '/',
    // A preference, not a credential: it outlives sessions so signing in again
    // opens the ledger last used.
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** The current ledger's database. */
export async function ledgerDb(): Promise<Database> {
  return connectionFor((await currentLedger()).database);
}
