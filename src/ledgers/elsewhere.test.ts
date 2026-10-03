import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { openAccount } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import type { Ledger } from './config.ts';
import { mappedElsewhere } from './elsewhere.ts';

const available = await databaseAvailable();

describe(
  'a bank account another ledger already has',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let personal: Database;
    let business: Database;
    const ledgers: Ledger[] = [
      { key: 'personal', name: 'Personal', database: 'personal' },
      { key: 'business', name: 'Business', database: 'business' },
    ];
    const connectionFor = (database: string) => (database === 'personal' ? personal : business);

    before(async () => {
      personal = await setupTestDb('elsewhere_personal');
      business = await setupTestDb('elsewhere_business');
      await truncateAll(personal);
      await truncateAll(business);
      await openAccount(business, {
        name: 'Business Chequing',
        kind: 'chequing',
        externalAccountId: '7654321',
      });
      await openAccount(personal, { name: 'Joint', kind: 'chequing', externalAccountId: '1234567' });
    });

    after(async () => {
      await closeDb(personal);
      await closeDb(business);
    });

    test("is found, with the ledger and the account it is there", async () => {
      const found = await mappedElsewhere(ledgers, ledgers[0]!, '7654321', connectionFor);
      assert.deepEqual(
        found.map((where) => [where.ledger.name, where.accountName]),
        [['Business', 'Business Chequing']],
      );
    });

    test('the open ledger is not "elsewhere", and an unknown number is nowhere', async () => {
      assert.deepEqual(await mappedElsewhere(ledgers, ledgers[1]!, '7654321', connectionFor), []);
      assert.deepEqual(await mappedElsewhere(ledgers, ledgers[0]!, '0000000', connectionFor), []);
    });

    test('with one ledger there is nowhere else to look', async () => {
      assert.deepEqual(await mappedElsewhere([ledgers[0]!], ledgers[0]!, '7654321', connectionFor), []);
    });
  },
);
