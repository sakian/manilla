/**
 * `npm run db:migrate`: bring every ledger up to schema in development (#23).
 *
 * The same work the server does at boot in production (instrumentation.ts),
 * run by hand here because `next dev` restarts too often for a migration to
 * happen by accident. Creates the database of any ledger in MANILLA_LEDGERS
 * that does not have one yet.
 *
 * Generating a migration is still drizzle-kit (`npm run db:generate`); only
 * applying them moved here, since drizzle-kit knows one database.
 */

import { configuredLedgers } from '../src/ledgers/config.ts';
import { prepareLedgers } from '../src/ledgers/prepare.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d db`.');
  process.exit(1);
}

try {
  await prepareLedgers(url, configuredLedgers(), (line) => console.log(line));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
