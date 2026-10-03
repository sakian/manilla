import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { transactions } from '../../db/schema.ts';
import { openAccount } from '../ledger/ledger.ts';
import { addMonths } from '../budget/month.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { dismissInsight, isJump, jumpShare, unusualCharges } from './insights.ts';

test('a jump is measured against the usual charge', () => {
  assert.equal(Math.round(jumpShare(16200, 10000) * 100), 62);
  assert.equal(jumpShare(5000, 0), 0);
});

test('only a steady payee charging well above its usual is a jump', () => {
  const steady = { charges: 12, meanCents: 10000, stddevCents: 800 };
  assert.equal(isJump({ ...steady, cents: 16200 }), true);
  assert.equal(isJump({ ...steady, cents: 12500 }), false, '25% above is within reason');
  assert.equal(isJump({ ...steady, charges: 3, cents: 16200 }), false, 'three charges are not a habit');
  assert.equal(isJump({ ...steady, stddevCents: 4000, cents: 16200 }), false, 'a payee that varies this much has no usual');
  assert.equal(isJump({ charges: 12, meanCents: 300, stddevCents: 10, cents: 600 }), false, '$3 becoming $6 is not news');
});

const available = await databaseAvailable();

describe(
  'unusual charges',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let chequing: string;
    const today = '2026-10-15';

    before(async () => {
      db = await setupTestDb('insights');
    });

    beforeEach(async () => {
      await truncateAll(db);
      await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const charge = async (payee: string, date: string, cents: number) => {
      const [row] = await db
        .insert(transactions)
        .values({
          accountId: chequing,
          date,
          amountCents: -cents,
          payeeRaw: payee,
          payeeKey: payee.toUpperCase(),
          kind: 'spending',
          status: 'confirmed',
          source: 'file_import',
        })
        .returning({ id: transactions.id });
      return row!.id;
    };

    /** A year of monthly charges before `today`'s month, the 10th of each. */
    const year = async (payee: string, amounts: (month: number) => number) => {
      for (let month = 1; month <= 12; month++) {
        await charge(payee, `${addMonths('2026-10', -month)}-10`, amounts(month));
      }
    };

    /** Enough small, varied spending that a "usual size of charge" exists. */
    const background = async () => {
      for (let day = 0; day < 60; day++) {
        const date = `${addMonths('2026-10', -(1 + (day % 11)))}-${String(1 + (day % 27)).padStart(2, '0')}`;
        await charge(`SHOP ${day % 7}`, date, 1500 + ((day * 37) % 6000));
      }
    };

    test('a steady bill well above its usual is found, with the figures to say so', async () => {
      await year('CITY WATER', (month) => 10000 + (month % 3) * 300);
      const id = await charge('CITY WATER', '2026-10-08', 16500);

      const [found, ...rest] = await unusualCharges(db, { today });
      assert.equal(rest.length, 0);
      assert.equal(found!.kind, 'charge_jumped');
      assert.equal(found!.transactionId, id);
      assert.equal(found!.cents, 16500);
      assert.equal(found!.charges, 12);
      assert.equal(found!.kind === 'charge_jumped' && found!.usualCents, 10300);
    });

    test('a bill at its usual, or a payee that always varies, says nothing', async () => {
      await year('CITY WATER', () => 10000);
      await charge('CITY WATER', '2026-10-08', 10400);
      await year('GROCER', (month) => 8000 + (month % 4) * 6000);
      await charge('GROCER', '2026-10-09', 22000);

      assert.deepEqual(await unusualCharges(db, { today }), []);
    });

    test('a jump more than a month ago is no longer news', async () => {
      await year('CITY WATER', () => 10000);
      await charge('CITY WATER', '2026-09-10', 16500);
      // The year above already holds a September charge; this second one is the jump.
      assert.deepEqual(await unusualCharges(db, { today: '2026-10-15' }), []);
    });

    test('a large first charge from a new payee is found; a small one is not', async () => {
      await background();
      const big = await charge('ACME HOLDINGS', '2026-10-12', 45000);
      await charge('NEW CAFE', '2026-10-13', 1800);

      const found = await unusualCharges(db, { today });
      assert.deepEqual(
        found.map((insight) => [insight.kind, insight.transactionId]),
        [['large_new_payee', big]],
      );
      assert.ok(found[0]!.kind === 'large_new_payee' && found[0]!.thresholdCents < 45000);
    });

    test('a large charge from a payee seen before is not "new"', async () => {
      await background();
      await charge('ACME HOLDINGS', '2026-03-01', 2000);
      await charge('ACME HOLDINGS', '2026-10-12', 45000);
      assert.deepEqual(await unusualCharges(db, { today }), []);
    });

    test('with too little history there is no usual to be large against', async () => {
      await charge('SHOP', '2026-09-01', 1500);
      await charge('ACME HOLDINGS', '2026-10-12', 45000);
      assert.deepEqual(await unusualCharges(db, { today }), []);
    });

    test('one payee is one finding, however many times it charged', async () => {
      await year('CITY WATER', () => 10000);
      await charge('CITY WATER', '2026-10-02', 16500);
      const latest = await charge('CITY WATER', '2026-10-09', 17000);

      const found = await unusualCharges(db, { today });
      assert.deepEqual(found.map((insight) => insight.transactionId), [latest]);
    });

    test('saying it was expected puts it away for good', async () => {
      await year('CITY WATER', () => 10000);
      const id = await charge('CITY WATER', '2026-10-08', 16500);
      await dismissInsight(db, id);
      await dismissInsight(db, id);
      assert.deepEqual(await unusualCharges(db, { today }), []);
    });

    test('money coming in and transfers are not charges', async () => {
      await year('CITY WATER', () => 10000);
      await db.insert(transactions).values({
        accountId: chequing,
        date: '2026-10-08',
        amountCents: 16500,
        payeeRaw: 'CITY WATER',
        payeeKey: 'CITY WATER',
        kind: 'spending',
        status: 'confirmed',
        source: 'file_import',
      });
      assert.deepEqual(await unusualCharges(db, { today }), []);
    });
  },
);
