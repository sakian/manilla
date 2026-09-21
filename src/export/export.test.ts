import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import {
  checkInvariant,
  moveBetweenEnvelopes,
  openAccount,
  recordTransaction,
  unallocatedEnvelope,
} from '../ledger/ledger.ts';
import { setPlanned } from '../budget/budget.ts';
import { createTransferRule } from '../rules/rules.ts';
import { parseCsv, toRecords } from '../csv.ts';
import { eraseAllData, exportCsv, exportFilename, exportLedger, isCsvTable } from './export.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { credentials, users } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'taking the data out',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;

    before(async () => {
      db = await setupTestDb('export');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        externalAccountId: '1234567',
      });
    });

    after(async () => {
      await closeDb(db);
    });

    const aSplit = async () =>
      recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -10000,
        payeeRaw: 'SOBEYS #123, CALGARY',
        memo: 'weekly shop',
        note: 'for the barbecue',
        status: 'confirmed',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
      });

    test('the JSON export keeps a split attached to its transaction', async () => {
      await aSplit();
      const ledger = await exportLedger(db);

      assert.equal(ledger.counts.transactions, 1);
      assert.equal(ledger.counts.envelopeLines, 2);

      const [transaction] = ledger.transactions;
      assert.equal(transaction!.amountCents, -10000);
      assert.deepEqual(
        transaction!.lines.map((line) => [line.envelope, line.amountCents]),
        [
          ['Groceries', -6000],
          ['Gas', -4000],
        ],
      );
      assert.deepEqual(transaction!.externalIds, [{ kind: 'fitid', value: 'FIT-1' }]);
      assert.equal(transaction!.account, 'Chequing');
    });

    test('credentials are never exported', async () => {
      const [user] = await db.insert(users).values({ name: 'Me' }).returning({ id: users.id });
      await db.insert(credentials).values({
        id: 'credential-one',
        userId: user!.id,
        publicKey: 'a-public-key',
        counter: 0,
      });

      const json = JSON.stringify(await exportLedger(db));
      assert.equal(json.includes('a-public-key'), false);
      assert.equal(json.includes('credential-one'), false);
      assert.equal(
        Object.keys(await exportLedger(db)).some((key) => /credential|session|recovery/i.test(key)),
        false,
      );
    });

    test('the CSV flattens a split into one row per envelope, and survives a comma', async () => {
      await aSplit();
      const rows = toRecords(parseCsv(await exportCsv(db, 'transactions')));

      assert.equal(rows.length, 2, 'one row per envelope share');
      assert.equal(rows[0]!.payee, 'SOBEYS #123, CALGARY', 'the comma came back intact');
      assert.equal(rows[0]!.amount, '-100.00', 'the transaction total, on both rows');
      assert.equal(rows[1]!.amount, '-100.00');
      assert.equal(rows[0]!.note, 'for the barbecue', 'your notes leave with your data');
      assert.deepEqual(
        rows.map((row) => [row.envelope, row.envelopeAmount]).sort(),
        [
          ['Gas', '-40.00'],
          ['Groceries', '-60.00'],
        ],
      );
      assert.equal(rows[0]!.id, rows[1]!.id, 'and the shared id puts them back together');
    });

    test('an uncategorized transaction still exports, with no envelope', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -2500,
        payeeRaw: 'UNKNOWN',
      });

      const rows = toRecords(parseCsv(await exportCsv(db, 'transactions')));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.envelope, '');
      assert.equal(rows[0]!.status, 'pending_review');
    });

    test('amounts are decimal strings, not cents', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -4520,
        payeeRaw: 'SHELL',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -4520 }],
      });

      const rows = toRecords(parseCsv(await exportCsv(db, 'transactions')));
      assert.equal(rows[0]!.amount, '-45.20', 'a spreadsheet would read 4520 as dollars');
    });

    test('every table exports something readable', async () => {
      await aSplit();
      await setPlanned(db, env.gasId, 20000);
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.gasId,
        amountCents: 5000,
        date: '2026-09-01',
        kind: 'allocation',
      });
      await createTransferRule(db, { contains: 'TFR-TO C C', transferAccountId: chequing });

      for (const table of ['transactions', 'envelopes', 'accounts', 'moves', 'budget', 'rules']) {
        assert.ok(isCsvTable(table));
        const parsed = parseCsv(await exportCsv(db, table as 'transactions'));
        assert.ok(parsed.headers.length > 0, `${table} has headers`);
        assert.ok(parsed.rows.length > 0, `${table} has at least one row`);
      }
    });

    test('a rule exports as what it means, not as a pair of ids', async () => {
      await createTransferRule(db, { contains: 'TFR-TO C C', transferAccountId: chequing });
      const rows = toRecords(parseCsv(await exportCsv(db, 'rules')));

      assert.equal(rows[0]!.matches, 'TFR-TO C C');
      assert.equal(rows[0]!.transferTo, 'Chequing');
      assert.equal(rows[0]!.envelope, '');
    });

    test('the filename says what it is and when', () => {
      assert.equal(
        exportFilename('ledger', new Date('2026-09-19T12:00:00Z')),
        'manilla-ledger-2026-09-19',
      );
    });

    // -- erasing (NF-6) -----------------------------------------------------

    test('erasing removes the ledger and leaves the way in', async () => {
      const [user] = await db.insert(users).values({ name: 'Me' }).returning({ id: users.id });
      await db.insert(credentials).values({
        id: 'credential-one',
        userId: user!.id,
        publicKey: 'a-public-key',
        counter: 0,
      });
      await aSplit();
      await setPlanned(db, env.gasId, 20000);

      const before = await eraseAllData(db);
      assert.equal(before.transactions, 1);

      const after = await exportLedger(db);
      assert.equal(after.counts.transactions, 0);
      assert.equal(after.counts.envelopes, 1, 'only the income pool, as on a fresh install');
      assert.equal((await unallocatedEnvelope(db)).name, 'Available');
      assert.equal(after.counts.accounts, 0);
      assert.equal(after.counts.budgetLines, 0);

      assert.equal(
        (await db.select().from(credentials)).length,
        1,
        'the passkey survives: clearing your data is not locking yourself out',
      );
      assert.ok((await checkInvariant(db)).ok, 'and an empty ledger balances');
    });
  },
);
