import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../db/client.ts';
import { envelopes } from '../../db/schema.ts';
import { closeDb, databaseAvailable, testServerUrl } from '../ledger/testdb.ts';
import { urlFor } from './config.ts';
import { prepareLedger } from './prepare.ts';

const available = await databaseAvailable();

// Its own database, created and dropped here: the point is a ledger that does
// not exist until it is prepared.
const LEDGER = { key: 'manilla_test_new_ledger', name: 'Business', database: 'manilla_test_new_ledger' };

describe(
  'preparing a ledger',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let admin: Database;

    const drop = () =>
      admin.execute(sql.raw(`drop database if exists "${LEDGER.database}" with (force)`));

    before(async () => {
      admin = createDb(urlFor(testServerUrl, 'postgres'));
      await drop();
    });

    after(async () => {
      await drop();
      await closeDb(admin);
    });

    test('a ledger with no database gets one, up to schema, with its income pool', async () => {
      const lines: string[] = [];
      await prepareLedger(testServerUrl, LEDGER, (line) => lines.push(line));
      assert.match(lines.join('\n'), /created the database for Business/);

      const ledger = createDb(urlFor(testServerUrl, LEDGER.database));
      try {
        const pools = (await ledger.select().from(envelopes)).filter((row) => row.isUnallocated);
        assert.equal(pools.length, 1, 'every budget screen needs the pool (#21)');
      } finally {
        await closeDb(ledger);
      }
    });

    test('preparing again changes nothing and creates nothing', async () => {
      const lines: string[] = [];
      await prepareLedger(testServerUrl, LEDGER, (line) => lines.push(line));
      assert.doesNotMatch(lines.join('\n'), /created/);
      assert.match(lines.join('\n'), /up to schema/);
    });
  },
);
