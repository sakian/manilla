/**
 * Test-database helper.
 *
 * Ledger tests run against a real Postgres, because the invariant they check is
 * enforced partly by the database and a mock would prove nothing. If no
 * database is reachable, the suite skips rather than fails, so `npm test` still
 * works on a machine without Docker running.
 */

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.ts';
import { envelopeGroups, envelopes } from '../../db/schema.ts';

const TEST_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://manilla:manilla@localhost:5433/manilla_test';

/** postgres.js keeps its socket open, so every throwaway connection must be closed. */
async function withAdmin<T>(run: (admin: Database) => Promise<T>): Promise<T> {
  const admin = createDb(TEST_URL.replace(/\/[^/]+$/, '/postgres'));
  try {
    return await run(admin);
  } finally {
    await closeDb(admin);
  }
}

export async function closeDb(db: Database): Promise<void> {
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
}

export async function databaseAvailable(): Promise<boolean> {
  try {
    return await withAdmin(async (admin) => {
      await admin.execute(sql`select 1`);
      return true;
    });
  } catch {
    return false;
  }
}

/** Create the test database if it does not exist, then bring it up to schema. */
export async function setupTestDb(): Promise<Database> {
  const name = TEST_URL.slice(TEST_URL.lastIndexOf('/') + 1);

  await withAdmin(async (admin) => {
    const existing = await admin.execute(sql`select 1 from pg_database where datname = ${name}`);
    if (existing.length === 0) {
      // Identifier cannot be parameterized; the name comes from our own config.
      await admin.execute(sql.raw(`create database "${name.replace(/"/g, '""')}"`));
    }
  });

  const db = createDb(TEST_URL);
  await migrate(db, { migrationsFolder: './db/migrations' });
  return db;
}

/**
 * Drizzle wraps driver errors, so the Postgres error code lives on `cause`
 * rather than in the message. Tests assert on the code.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error as { code?: string }).code;
}

/** Wipe every table between tests, leaving the schema in place. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(sql`
    truncate table
      txn_lines, suggestions, transaction_external_ids, transactions,
      envelope_moves, budget_lines, rules, import_batches,
      envelopes, envelope_groups, accounts,
      sessions, credentials, recovery_codes, users
    restart identity cascade
  `);
}

export type Fixture = {
  groupId: string;
  unallocatedId: string;
  gasId: string;
  groceriesId: string;
};

/** A minimal chart of envelopes: the unallocated pool plus two ordinary ones. */
export async function seedEnvelopes(db: Database): Promise<Fixture> {
  const [group] = await db
    .insert(envelopeGroups)
    .values({ name: 'Living', position: 0 })
    .returning({ id: envelopeGroups.id });

  const rows = await db
    .insert(envelopes)
    .values([
      { groupId: group!.id, name: 'Available', isUnallocated: true, position: 0 },
      { groupId: group!.id, name: 'Gas', position: 1 },
      { groupId: group!.id, name: 'Groceries', position: 2 },
    ])
    .returning({ id: envelopes.id, name: envelopes.name });

  const byName = new Map(rows.map((row) => [row.name, row.id]));
  return {
    groupId: group!.id,
    unallocatedId: byName.get('Available')!,
    gasId: byName.get('Gas')!,
    groceriesId: byName.get('Groceries')!,
  };
}
