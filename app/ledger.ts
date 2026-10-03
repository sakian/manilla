import 'server-only';

/**
 * The ledger this request is looking at (#23).
 *
 * Everything about money goes through `ledgerDb()`; only sign-in uses
 * `homeDb()`. There is deliberately no plain `db()` any more: with two ledgers,
 * a call that did not say which one it meant would read the wrong books
 * without an error, so each call site now has to say.
 *
 * Which ledger is a cookie, read once per request (`cache`). The cookie only
 * selects among configured ledgers (`chooseLedger`), so a forged one can name
 * nothing that is not already listed - and every action still calls
 * `requireUser()` before any of this matters.
 */

import { cache } from 'react';
import { cookies } from 'next/headers';
import { connectionFor, type Database } from '../db/client.ts';
import { chooseLedger, configuredLedgers, type Ledger } from '../src/ledgers/config.ts';

export const LEDGER_COOKIE = 'manilla_ledger';

export const currentLedger = cache(async (): Promise<Ledger> => {
  const store = await cookies();
  return chooseLedger(configuredLedgers(), store.get(LEDGER_COOKIE)?.value);
});

/** The open ledger's name for a download's filename, when there is more than one. */
export async function ledgerForFilename(): Promise<string | undefined> {
  return configuredLedgers().length > 1 ? (await currentLedger()).name : undefined;
}

/** The current ledger's database. */
export async function ledgerDb(): Promise<Database> {
  return connectionFor((await currentLedger()).database);
}
