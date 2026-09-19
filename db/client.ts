/**
 * Database client.
 *
 * `postgres.js` is configured to hand back money and dates in the forms the
 * domain layer expects: bigint cents as JS numbers (safe to about 90 trillion
 * cents), and `date` columns as plain `YYYY-MM-DD` strings rather than `Date`
 * objects, which is the same rule the OFX parser follows and for the same
 * reason - a calendar day must not drift across a timezone boundary.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

const DATE_OID = 1082;

export function createConnection(url = process.env.DATABASE_URL) {
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
  });
}

export type Database = ReturnType<typeof createDb>;

export function createDb(url?: string) {
  return drizzle(createConnection(url), { schema });
}

let shared: Database | undefined;

/** Process-wide connection for the running app. Tests make their own. */
export function db(): Database {
  shared ??= createDb();
  return shared;
}
