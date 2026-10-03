/**
 * Bring every ledger's database into being and up to schema (#23).
 *
 * When a ledger is opened from Settings, and for every ledger at boot in
 * production and in `npm run db:migrate` (`prepareEveryLedger` in registry.ts):
 * its database is created if it does not exist, migrated, and given the income
 * pool every budget screen needs (#21).
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.ts';
import { ensureIncomePool } from '../ledger/ledger.ts';
import { refreshRuleSuggestionCount } from '../rules/rules.ts';
import { urlFor, type Ledger } from './config.ts';

async function close(db: Database): Promise<void> {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}

/** Create the database if it is missing. Returns whether it had to be. */
async function ensureDatabase(homeUrl: string, database: string): Promise<boolean> {
  // `postgres` is always there, and is not a ledger, so it can stand outside
  // the database being created.
  const admin = createDb(urlFor(homeUrl, 'postgres'), { quiet: true });
  try {
    const found = await admin.execute(sql`select 1 from pg_database where datname = ${database}`);
    if (found.length > 0) return false;
    // An identifier cannot be a parameter. The name has already passed
    // `parseLedgers`, which allows only lowercase letters, digits and _.
    await admin.execute(sql.raw(`create database "${database.replace(/"/g, '""')}"`));
    return true;
  } finally {
    await close(admin);
  }
}

export async function prepareLedger(
  homeUrl: string,
  ledger: Ledger,
  log: (line: string) => void = () => {},
): Promise<void> {
  if (await ensureDatabase(homeUrl, ledger.database)) {
    log(`created the database for ${ledger.name} (${ledger.database})`);
  }

  const db = createDb(urlFor(homeUrl, ledger.database), { quiet: true });
  try {
    await migrate(db, { migrationsFolder: './db/migrations' });
    await ensureIncomePool(db);

    // The count behind "N rules Manilla could write" is stored, and a deploy
    // can change the answer without any action to redo it - raising the
    // threshold left a count of 24 pointing at a page with none. A wrong count
    // is not worth refusing to start over.
    try {
      await refreshRuleSuggestionCount(db);
    } catch (error) {
      log(`could not recount rule suggestions for ${ledger.name}: ${String(error)}`);
    }
    log(`${ledger.name} (${ledger.database}) is up to schema`);
  } finally {
    await close(db);
  }
}
