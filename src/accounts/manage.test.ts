import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import {
  checkInvariant,
  recordAccountTransfer,
  recordTransaction,
} from '../ledger/ledger.ts';
import {
  AccountError,
  accountTransactions,
  archiveAccount,
  createAccount,
  editAccount,
  isAccountKind,
  listAccounts,
  unarchiveAccount,
} from './manage.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';

const available = await databaseAvailable();

describe(
  'account management',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;

    before(async () => {
      db = await setupTestDb('accounts');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
    });

    after(async () => {
      await closeDb(db);
    });

    test('a new account with an opening balance keeps the two ledgers equal (FR-1)', async () => {
      const id = await createAccount(db, {
        name: 'Main Chequing',
        kind: 'chequing',
        openingBalanceCents: 421550,
        openingDate: '2026-09-01',
      });

      const [account] = await listAccounts(db);
      assert.equal(account!.id, id);
      assert.equal(account!.balanceCents, 421550);
      assert.equal(account!.transactionCount, 1, 'the opening balance is an ordinary transaction');
      assert.equal(account!.lastActivity, '2026-09-01');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an account with no opening balance starts empty', async () => {
      await createAccount(db, { name: 'Cash', kind: 'cash' });
      const [account] = await listAccounts(db);
      assert.equal(account!.balanceCents, 0);
      assert.equal(account!.transactionCount, 0);
      assert.equal(account!.lastActivity, null);
    });

    test('names are trimmed and a blank one is refused', async () => {
      await createAccount(db, { name: '  Savings  ', kind: 'savings' });
      const [account] = await listAccounts(db);
      assert.equal(account!.name, 'Savings');
      await assert.rejects(() => createAccount(db, { name: '  ', kind: 'savings' }), AccountError);
    });

    test('every kind in the schema is accepted, and nothing else', async () => {
      for (const kind of ['chequing', 'savings', 'credit_card', 'cash', 'line_of_credit']) {
        assert.ok(isAccountKind(kind));
      }
      assert.equal(isAccountKind('brokerage'), false);
      await assert.rejects(
        () => createAccount(db, { name: 'Broker', kind: 'brokerage' as never }),
        AccountError,
      );
    });

    test('the bank account number can be set, changed and cleared', async () => {
      const id = await createAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        externalAccountId: '  1234567  ',
      });
      assert.equal((await listAccounts(db))[0]!.externalAccountId, '1234567', 'trimmed');

      await editAccount(db, id, { externalAccountId: '7654321' });
      assert.equal((await listAccounts(db))[0]!.externalAccountId, '7654321');

      await editAccount(db, id, { externalAccountId: '' });
      assert.equal(
        (await listAccounts(db))[0]!.externalAccountId,
        null,
        'blank means unmapped, not an empty string',
      );
    });

    test('two accounts cannot share a bank account number', async () => {
      await createAccount(db, { name: 'Chequing', kind: 'chequing', externalAccountId: '1234567' });
      await assert.rejects(
        () =>
          createAccount(db, { name: 'Savings', kind: 'savings', externalAccountId: '1234567' }),
        (error: unknown) => {
          assert.ok(error instanceof AccountError);
          assert.match(error.message, /Chequing already uses/);
          return true;
        },
      );
    });

    test('two unmapped accounts are fine', async () => {
      await createAccount(db, { name: 'Cash', kind: 'cash' });
      await createAccount(db, { name: 'Wallet', kind: 'cash' });
      assert.equal((await listAccounts(db)).length, 2);
    });

    test('an account can be renamed and its kind corrected', async () => {
      const id = await createAccount(db, { name: 'Visa', kind: 'chequing' });
      await editAccount(db, id, { name: 'Visa Infinite', kind: 'credit_card' });

      const [account] = await listAccounts(db);
      assert.equal(account!.name, 'Visa Infinite');
      assert.equal(account!.kind, 'credit_card');
    });

    test('an emptied account archives and leaves the live list', async () => {
      const chequing = await createAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 10000,
        openingDate: '2026-09-01',
      });
      const savings = await createAccount(db, { name: 'Savings', kind: 'savings' });

      await recordAccountTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 10000,
        date: '2026-09-19',
      });

      await archiveAccount(db, chequing);

      const live = await listAccounts(db);
      assert.deepEqual(live.map((account) => account.name), ['Savings']);

      const all = await listAccounts(db, { includeArchived: true });
      assert.equal(all.length, 2);
      assert.ok(all.find((account) => account.id === chequing)!.archivedAt);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an account with money in it refuses to archive, and says how much', async () => {
      const id = await createAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 421550,
        openingDate: '2026-09-01',
      });

      await assert.rejects(
        () => archiveAccount(db, id),
        (error: unknown) => {
          assert.ok(error instanceof AccountError);
          assert.match(error.message, /\$4215\.50/);
          return true;
        },
      );
      assert.equal((await listAccounts(db)).length, 1, 'still live');
    });

    test('an account with unreviewed transactions refuses to archive', async () => {
      const id = await createAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId: id,
        date: '2026-09-19',
        amountCents: 0,
        payeeRaw: 'ZERO DOLLAR AUTH',
      });

      await assert.rejects(
        () => archiveAccount(db, id),
        (error: unknown) => {
          assert.ok(error instanceof AccountError);
          assert.match(error.message, /awaiting review/);
          return true;
        },
      );
    });

    test('archiving is reversible', async () => {
      const id = await createAccount(db, { name: 'Cash', kind: 'cash' });
      await archiveAccount(db, id);
      assert.equal((await listAccounts(db)).length, 0);
      await unarchiveAccount(db, id);
      assert.equal((await listAccounts(db)).length, 1);
    });

    test('a split transaction is listed once, with both envelopes', async () => {
      const id = await createAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId: id,
        date: '2026-09-19',
        amountCents: -10000,
        payeeRaw: 'COSTCO',
        status: 'confirmed',
        lines: [
          { envelopeId: env.gasId, amountCents: -4000 },
          { envelopeId: env.groceriesId, amountCents: -6000 },
        ],
      });

      const rows = await accountTransactions(db, id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.amountCents, -10000);
      assert.deepEqual([...rows[0]!.envelopeNames].sort(), ['Gas', 'Groceries']);
    });

    test('an uncategorized transaction lists no envelope rather than vanishing', async () => {
      const id = await createAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId: id,
        date: '2026-09-19',
        amountCents: -2500,
        payeeRaw: 'UNKNOWN MERCHANT',
      });

      const rows = await accountTransactions(db, id);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0]!.envelopeNames, []);
      assert.equal(rows[0]!.status, 'pending_review');
    });
  },
);
