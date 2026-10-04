/**
 * Database client.
 *
 * `postgres.js` is configured to hand back money and dates in the forms the
 * domain layer expects: bigint cents as JS numbers (safe to about 90 trillion
 * cents), and `date` columns as plain `YYYY-MM-DD` strings rather than `Date`
 * objects, which is the same rule the OFX parser follows and for the same
 * reason - a calendar day must not drift across a timezone boundary.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';
import { databaseOf, urlFor } from '../src/ledgers/config.ts';
import { actorSetting } from '../src/audit/actor.ts';

const DATE_OID = 1082;

export function createConnection(
  url = process.env.DATABASE_URL,
  options: { quiet?: boolean } = {},
) {
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.',
    );
  }

  return postgres(url, {
    // Return DATE as the literal string Postgres stores, with no Date parsing.
    types: {
      date: {
        to: DATE_OID,
        from: [DATE_OID],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
    // Migrations re-run on every start, and each run has Postgres say that the
    // schema it would create "already exists, skipping".
    ...(options.quiet ? { onnotice: () => {} } : {}),
  });
}

export type Database = ReturnType<typeof createDb>;

export function createDb(url?: string, options: { quiet?: boolean } = {}) {
  const db = drizzle(createConnection(url, options), { schema });

  // Every transaction says who it is for, so the audit trigger can (NF-2,
  // src/audit/actor.ts). `true` makes the setting end with the transaction;
  // a nested `tx.transaction` is a savepoint inside it and inherits it.
  const transaction = db.transaction.bind(db);
  db.transaction = ((work, config) =>
    transaction(async (tx) => {
      const actor = actorSetting();
      if (actor) await tx.execute(sql`select set_config('manilla.actor', ${actor}, true)`);
      return work(tx);
    }, config)) as typeof db.transaction;

  return db;
}

/** One pool per database for the life of the process. Tests make their own. */
const pools = new Map<string, Database>();

/**
 * The database in DATABASE_URL: sign-in lives here, and so does the first
 * ledger. Only sign-in should reach for it by this name - money is read
 * through the current ledger (`ledgerDb()` in app/ledger.ts), which is this
 * same database only when that is the ledger being looked at.
 */
export function homeDb(): Database {
  return connectionFor(databaseOf(requireUrl()));
}

/** A ledger's database by name, on the same server as DATABASE_URL. */
export function connectionFor(database: string): Database {
  let pool = pools.get(database);
  if (!pool) {
    pool = createDb(urlFor(requireUrl(), database));
    pools.set(database, pool);
  }
  return pool;
}

function requireUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.',
    );
  }
  return url;
}
