import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.ts';
import { envelopes } from '../../db/schema.ts';
import { eraseAllData } from '../export/export.ts';
import { closeDb, databaseAvailable, setupTestDb, testServerUrl, truncateAll } from '../ledger/testdb.ts';
import { LedgerConfigError, MAX_LEDGERS, urlFor } from './config.ts';
import { listLedgers, openLedger, prepareEveryLedger, renameLedger } from './registry.ts';

const available = await databaseAvailable();

describe(
  'opening ledgers from the app',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    // setupTestDb('registry') is the home ledger; the ledgers it opens are
    // databases this test creates and drops.
    const HOME_DB = `${new URL(testServerUrl).pathname.slice(1)}_registry`;
    const homeUrl = urlFor(testServerUrl, HOME_DB);
    let home: Database;
    let admin: Database;

    const dropOpened = async () => {
      const rows = await admin.execute<{ datname: string }>(
        sql`select datname from pg_database where datname like ${`${HOME_DB}_ledger_%`}`,
      );
      for (const row of rows) {
        await admin.execute(sql.raw(`drop database "${row.datname}" with (force)`));
      }
    };

    before(async () => {
      home = await setupTestDb('registry');
      admin = createDb(urlFor(testServerUrl, 'postgres'));
    });

    beforeEach(async () => {
      await truncateAll(home);
      await dropOpened();
    });

    after(async () => {
      await dropOpened();
      await closeDb(admin);
      await closeDb(home);
    });

    test('with none opened there is one ledger, the home one', async () => {
      assert.deepEqual(await listLedgers(home, HOME_DB), [
        { key: HOME_DB, name: 'Personal', database: HOME_DB },
      ]);
    });

    test('opening one makes its database, ready to use, and lists it', async () => {
      const opened = await openLedger(home, homeUrl, HOME_DB, ' Business ');
      assert.deepEqual(opened, {
        key: `${HOME_DB}_ledger_business`,
        name: 'Business',
        database: `${HOME_DB}_ledger_business`,
      });
      assert.deepEqual(
        (await listLedgers(home, HOME_DB)).map((ledger) => ledger.name),
        ['Personal', 'Business'],
      );

      const ledger = createDb(urlFor(testServerUrl, opened.database));
      try {
        const pools = (await ledger.select().from(envelopes)).filter((row) => row.isUnallocated);
        assert.equal(pools.length, 1, 'it opens with its income pool, like a fresh install');
      } finally {
        await closeDb(ledger);
      }
    });

    test(`${MAX_LEDGERS} in all, the home one included`, async () => {
      for (const name of ['Business', 'Rental', 'Kids']) await openLedger(home, homeUrl, HOME_DB, name);
      await assert.rejects(
        openLedger(home, homeUrl, HOME_DB, 'One more'),
        (error: unknown) => error instanceof LedgerConfigError && /4 ledgers/.test(error.message),
      );
    });

    test('two ledgers cannot share a name, whatever the case', async () => {
      await openLedger(home, homeUrl, HOME_DB, 'Business');
      await assert.rejects(openLedger(home, homeUrl, HOME_DB, 'business'), /already a ledger called/);
      await assert.rejects(openLedger(home, homeUrl, HOME_DB, 'PERSONAL'), /already a ledger called/);
    });

    test('a database already on the server is never taken over', async () => {
      // Left behind by an attempt that failed after creating it, say.
      await admin.execute(sql.raw(`create database "${HOME_DB}_ledger_business"`));
      const opened = await openLedger(home, homeUrl, HOME_DB, 'Business');
      assert.equal(opened.database, `${HOME_DB}_ledger_business_2`);
    });

    test('any ledger can be renamed, the home one too, and its database stays put', async () => {
      const opened = await openLedger(home, homeUrl, HOME_DB, 'Business');
      await renameLedger(home, HOME_DB, opened.key, 'Studio');
      await renameLedger(home, HOME_DB, HOME_DB, 'Household');
      assert.deepEqual(await listLedgers(home, HOME_DB), [
        { key: HOME_DB, name: 'Household', database: HOME_DB },
        { key: opened.key, name: 'Studio', database: opened.database },
      ]);
      await assert.rejects(renameLedger(home, HOME_DB, opened.key, 'household'), /already/);
      await assert.rejects(renameLedger(home, HOME_DB, 'postgres', 'Mine'), /No such ledger/);
    });

    test("erasing the home ledger's money keeps the other ledgers, and its name", async () => {
      await openLedger(home, homeUrl, HOME_DB, 'Business');
      await renameLedger(home, HOME_DB, HOME_DB, 'Household');
      await eraseAllData(home);
      assert.deepEqual(
        (await listLedgers(home, HOME_DB)).map((ledger) => ledger.name),
        ['Household', 'Business'],
      );
    });

    test('preparing every ledger reaches the ones opened, home first', async () => {
      await openLedger(home, homeUrl, HOME_DB, 'Business');
      const lines: string[] = [];
      await prepareEveryLedger(homeUrl, (line) => lines.push(line));
      assert.deepEqual(
        lines.filter((line) => line.endsWith('up to schema')),
        [`the home ledger (${HOME_DB}) is up to schema`, `Business (${HOME_DB}_ledger_business) is up to schema`],
      );
    });

    test('a ledger that cannot be brought up is named', async () => {
      const unreachable = homeUrl.replace(/:\d+\//, ':1/');
      await assert.rejects(prepareEveryLedger(unreachable), /^Error: the home ledger \(.+\) could not be brought up/);
    });
  },
);
