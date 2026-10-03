/**
 * `npm run db:migrate`: bring every ledger up to schema in development (#23).
 *
 * The same work the server does at boot in production (instrumentation.ts),
 * run by hand here because `next dev` restarts too often for a migration to
 * happen by accident: the home ledger first, then every ledger opened from
 * Settings, which it lists.
 *
 * Generating a migration is still drizzle-kit (`npm run db:generate`); only
 * applying them moved here, since drizzle-kit knows one database.
 */

import { prepareEveryLedger } from '../src/ledgers/registry.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.');
  process.exit(1);
}

try {
  await prepareEveryLedger(url, (line) => console.log(line));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
