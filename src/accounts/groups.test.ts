import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { createAccount } from './manage.ts';
import {
  AccountGroupError,
  NO_GROUP,
  archiveAccountGroup,
  createAccountGroup,
  listAccountCategories,
  moveAccountToGroup,
  nudgeAccountGroup,
  renameAccountGroup,
  unarchiveAccountGroup,
} from './groups.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
} from '../ledger/testdb.ts';

const available = await databaseAvailable();

describe(
  'categories of accounts',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('account_groups');
    });

    beforeEach(async () => {
      await truncateAll(db);
      await seedEnvelopes(db);
    });

    after(async () => {
      await closeDb(db);
    });

    const names = async () =>
      (await listAccountCategories(db)).map((category) => [
        category.name,
        category.accounts.map((account) => account.name),
      ]);

    test('an account with no category is listed last, under its own heading', async () => {
      await createAccount(db, { name: 'Main Chequing', kind: 'chequing' });
      const day = await createAccountGroup(db, 'Day to day');
      const visa = await createAccount(db, { name: 'Visa', kind: 'credit_card' });
      await moveAccountToGroup(db, visa, day);

      assert.deepEqual(await names(), [
        ['Day to day', ['Visa']],
        [NO_GROUP, ['Main Chequing']],
      ]);
    });

    test('an empty category is still listed, so there is somewhere to move to', async () => {
      await createAccountGroup(db, 'Long term');
      assert.deepEqual(await names(), [['Long term', []]]);
    });

    test('accounts are alphabetical inside a category, categories keep their order', async () => {
      const first = await createAccountGroup(db, 'Zeroth');
      const second = await createAccountGroup(db, 'Alphabetically first');

      for (const [name, group] of [
        ['Visa', first],
        ['Chequing', first],
        ['TFSA', second],
      ] as const) {
        const id = await createAccount(db, { name, kind: 'chequing' });
        await moveAccountToGroup(db, id, group);
      }

      assert.deepEqual(await names(), [
        ['Zeroth', ['Chequing', 'Visa']],
        ['Alphabetically first', ['TFSA']],
      ]);
    });

    test('nudging a category swaps it with its neighbour and stops at the ends', async () => {
      const first = await createAccountGroup(db, 'First');
      const second = await createAccountGroup(db, 'Second');

      await nudgeAccountGroup(db, second, 'up');
      assert.deepEqual((await listAccountCategories(db)).map((c) => c.name), ['Second', 'First']);

      await nudgeAccountGroup(db, second, 'up');
      assert.deepEqual(
        (await listAccountCategories(db)).map((c) => c.name),
        ['Second', 'First'],
        'already at the top: a no-op, not an error',
      );
      assert.ok(first);
    });

    test('a category carries each account balance and last activity', async () => {
      const group = await createAccountGroup(db, 'Day to day');
      const id = await createAccount(db, {
        name: 'Main Chequing',
        kind: 'chequing',
        openingBalanceCents: 421550,
        openingDate: '2026-09-01',
      });
      await moveAccountToGroup(db, id, group);
      await recordTransaction(db, {
        accountId: id,
        date: '2026-09-18',
        amountCents: -6250,
        payeeRaw: 'PETRO CANADA',
        source: 'file_import',
      });

      const [category] = await listAccountCategories(db);
      const account = category!.accounts[0]!;
      assert.equal(account.balanceCents, 421550 - 6250);
      assert.equal(account.transactionCount, 2, 'the opening balance is a transaction too');
      assert.equal(account.lastActivity, '2026-09-18');
    });

    test('archiving a category leaves its accounts alone, ungrouped', async () => {
      const group = await createAccountGroup(db, 'Day to day');
      const id = await createAccount(db, {
        name: 'Main Chequing',
        kind: 'chequing',
        openingBalanceCents: 100000,
      });
      await moveAccountToGroup(db, id, group);

      await archiveAccountGroup(db, group);

      // An account holds real money; archiving its heading must not hide it.
      assert.deepEqual(await names(), [[NO_GROUP, ['Main Chequing']]]);
      const [ungrouped] = await listAccountCategories(db);
      assert.equal(ungrouped!.accounts[0]!.balanceCents, 100000);

      await unarchiveAccountGroup(db, group);
      assert.deepEqual(await names(), [['Day to day', []], [NO_GROUP, ['Main Chequing']]]);
    });

    test('an account can be taken out of a category again', async () => {
      const group = await createAccountGroup(db, 'Day to day');
      const id = await createAccount(db, { name: 'Visa', kind: 'credit_card' });

      await moveAccountToGroup(db, id, group);
      await moveAccountToGroup(db, id, null);

      assert.deepEqual(await names(), [['Day to day', []], [NO_GROUP, ['Visa']]]);
    });

    test('an archived or unknown category is refused as a destination', async () => {
      const group = await createAccountGroup(db, 'Day to day');
      const id = await createAccount(db, { name: 'Visa', kind: 'credit_card' });
      await archiveAccountGroup(db, group);

      await assert.rejects(() => moveAccountToGroup(db, id, group), AccountGroupError);
      await assert.rejects(
        () => moveAccountToGroup(db, id, '00000000-0000-0000-0000-000000000000'),
        AccountGroupError,
      );
    });

    test('a blank or overlong category name is refused', async () => {
      await assert.rejects(() => createAccountGroup(db, '   '), AccountGroupError);
      await assert.rejects(() => createAccountGroup(db, 'x'.repeat(81)), AccountGroupError);

      const group = await createAccountGroup(db, 'Fine');
      await assert.rejects(() => renameAccountGroup(db, group, ''), AccountGroupError);
    });

    test('archived accounts are left out unless asked for', async () => {
      const { archiveAccount } = await import('./manage.ts');
      const group = await createAccountGroup(db, 'Day to day');
      const id = await openAccount(db, { name: 'Old Card', kind: 'credit_card' });
      await moveAccountToGroup(db, id, group);
      await archiveAccount(db, id);

      assert.deepEqual(await names(), [['Day to day', []]]);

      const withArchived = await listAccountCategories(db, { includeArchived: true });
      assert.deepEqual(
        withArchived.flatMap((category) => category.accounts.map((a) => a.name)),
        ['Old Card'],
      );
    });
  },
);
