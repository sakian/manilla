/**
 * The ledgers this account keeps, and opening another (#23).
 *
 * Read from the home database only. The home ledger is always first and is
 * not a row: it is the database in DATABASE_URL, named by an app setting. The
 * rest are rows in `ledgers`, in the order they were opened.
 */

import { asc, eq, sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.ts';
import { appSettings, ledgers as ledgersTable } from '../../db/schema.ts';
import {
  HOME_LEDGER_NAME_KEY,
  LedgerConfigError,
  MAX_LEDGERS,
  cleanLedgerName,
  databaseNameFor,
  databaseOf,
  type Ledger,
} from './config.ts';
import { prepareLedger } from './prepare.ts';

/** What the home ledger is called until someone names it. */
export const DEFAULT_HOME_LEDGER_NAME = 'Personal';

/** Every ledger, the home one first. */
export async function listLedgers(home: Database, homeDatabase: string): Promise<Ledger[]> {
  const [named] = await home
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, HOME_LEDGER_NAME_KEY));
  const rows = await home
    .select()
    .from(ledgersTable)
    .orderBy(asc(ledgersTable.position), asc(ledgersTable.createdAt));

  return [
    { key: homeDatabase, name: named?.value ?? DEFAULT_HOME_LEDGER_NAME, database: homeDatabase },
    ...rows.map((row) => ({ key: row.database, name: row.name, database: row.database })),
  ];
}

function assertNameFree(all: Ledger[], name: string, except?: string): void {
  const clash = all.find(
    (ledger) => ledger.key !== except && ledger.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new LedgerConfigError(`There is already a ledger called ${clash.name}.`);
}

/**
 * Open a new, empty ledger: create its database, bring it up to schema, and
 * list it. The database is made before the row, so a failure part way leaves
 * no ledger pointing at nothing; the next attempt skips the orphaned name,
 * because a database that already exists is never adopted.
 */
export async function openLedger(
  home: Database,
  homeUrl: string,
  homeDatabase: string,
  rawName: string,
): Promise<Ledger> {
  const name = cleanLedgerName(rawName);
  const all = await listLedgers(home, homeDatabase);
  if (all.length >= MAX_LEDGERS) {
    throw new LedgerConfigError(`An account can keep ${MAX_LEDGERS} ledgers, and this one has.`);
  }
  assertNameFree(all, name);

  const existing = await home.execute<{ datname: string }>(sql`select datname from pg_database`);
  const taken = new Set(existing.map((row) => row.datname));
  const database = databaseNameFor(homeDatabase, name, taken);

  const ledger: Ledger = { key: database, name, database };
  await prepareLedger(homeUrl, ledger);
  await home.insert(ledgersTable).values({ database, name, position: all.length });
  return ledger;
}

/**
 * Bring every ledger up to schema: the home one first, because the list of the
 * others is a table in it. Run at boot in production and by `npm run
 * db:migrate`. The first failure stops the rest, since serving one ledger
 * against a half-migrated other is how books end up half-written.
 */
export async function prepareEveryLedger(
  homeUrl: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  const homeDatabase = databaseOf(homeUrl);
  const home = createDb(homeUrl, { quiet: true });
  try {
    let all: Ledger[] = [{ key: homeDatabase, name: 'the home ledger', database: homeDatabase }];
    for (let index = 0; index < all.length; index += 1) {
      const ledger = all[index]!;
      try {
        await prepareLedger(homeUrl, ledger, log);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${ledger.name} (${ledger.database}) could not be brought up: ${message}`, {
          cause: error,
        });
      }
      if (index === 0) all = await listLedgers(home, homeDatabase);
    }
  } finally {
    await (home as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}

/** Rename any ledger, the home one included. Its database keeps its name. */
export async function renameLedger(
  home: Database,
  homeDatabase: string,
  key: string,
  rawName: string,
): Promise<void> {
  const name = cleanLedgerName(rawName);
  const all = await listLedgers(home, homeDatabase);
  if (!all.some((ledger) => ledger.key === key)) throw new LedgerConfigError('No such ledger.');
  assertNameFree(all, name, key);

  if (key === homeDatabase) {
    await home
      .insert(appSettings)
      .values({ key: HOME_LEDGER_NAME_KEY, value: name })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: name, updatedAt: new Date() } });
  } else {
    await home.update(ledgersTable).set({ name }).where(eq(ledgersTable.database, key));
  }
}
