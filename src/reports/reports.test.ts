import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import {
  moveBetweenEnvelopes,
  openAccount,
  recordAccountTransfer,
  recordTransaction,
} from '../ledger/ledger.ts';
import {
  monthlyTrend,
  monthsBetween,
  periodPreset,
  spendingByEnvelope,
  transactionsInPeriod,
} from './reports.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';

describe('report periods', () => {
  test('a range covers every month it touches, in order', () => {
    assert.deepEqual(monthsBetween('2026-07-15', '2026-10-02'), [
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
  });

  test('a single month is one month, and a backwards range is none', () => {
    assert.deepEqual(monthsBetween('2026-09-01', '2026-09-30'), ['2026-09']);
    assert.deepEqual(monthsBetween('2026-09-30', '2026-08-01'), []);
  });

  test('a range crosses a year end', () => {
    assert.deepEqual(monthsBetween('2025-12-01', '2026-02-28'), ['2025-12', '2026-01', '2026-02']);
  });

  test('the presets mean what they say', () => {
    assert.deepEqual(periodPreset('this-month', '2026-09-19'), {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    assert.deepEqual(periodPreset('last-month', '2026-01-15'), {
      from: '2025-12-01',
      to: '2025-12-31',
    });
    assert.deepEqual(periodPreset('this-year', '2026-09-19'), {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    assert.deepEqual(periodPreset('last-12-months', '2026-09-19'), {
      from: '2025-10-01',
      to: '2026-09-30',
    });
  });
});

const available = await databaseAvailable();

describe(
  'spending reports',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;
    let savings: string;

    before(async () => {
      db = await setupTestDb('reports');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      savings = await openAccount(db, { name: 'Savings', kind: 'savings' });
    });

    after(async () => {
      await closeDb(db);
    });

    const spend = (envelopeId: string, cents: number, date: string, payee = 'SHELL') =>
      recordTransaction(db, {
        accountId: chequing,
        date,
        amountCents: -cents,
        payeeRaw: payee,
        status: 'confirmed',
        lines: [{ envelopeId, amountCents: -cents }],
      });

    const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' };

    test('spending is summed per envelope and rolled up per group', async () => {
      await spend(env.gasId, 4520, '2026-09-03');
      await spend(env.gasId, 5100, '2026-09-17');
      await spend(env.groceriesId, 12245, '2026-09-05');

      const report = await spendingByEnvelope(db, SEPTEMBER);
      assert.equal(report.totalCents, 21865);

      const [group] = report.groups;
      assert.equal(group!.name, 'Living');
      assert.equal(group!.spentCents, 21865);

      const gas = group!.envelopes.find((row) => row.name === 'Gas')!;
      assert.equal(gas.spentCents, 9620);
      assert.equal(gas.transactionCount, 2);
    });

    test('only the period asked for is counted', async () => {
      await spend(env.gasId, 5000, '2026-08-31');
      await spend(env.gasId, 6000, '2026-09-01');
      await spend(env.gasId, 7000, '2026-10-01');

      const report = await spendingByEnvelope(db, SEPTEMBER);
      assert.equal(report.totalCents, 6000, 'the boundaries are inclusive and exact');
    });

    test('a split is counted at each envelope its share went to (RP-5)', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-05',
        amountCents: -10000,
        payeeRaw: 'COSTCO',
        status: 'confirmed',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });

      const report = await spendingByEnvelope(db, SEPTEMBER);
      const envelopes = report.groups[0]!.envelopes;
      assert.equal(envelopes.find((row) => row.name === 'Groceries')!.spentCents, 6000);
      assert.equal(envelopes.find((row) => row.name === 'Gas')!.spentCents, 4000);
      assert.equal(report.totalCents, 10000, 'and counted once overall');
    });

    test('a transfer between accounts never appears (RP-5, FR-5)', async () => {
      await recordAccountTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 50000,
        date: '2026-09-10',
      });

      const report = await spendingByEnvelope(db, SEPTEMBER);
      assert.equal(report.totalCents, 0);
      assert.deepEqual(report.groups, []);
    });

    test('an envelope-to-envelope move never appears either (FR-36)', async () => {
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.groceriesId,
        toEnvelopeId: env.gasId,
        amountCents: 15000,
        date: '2026-09-10',
        kind: 'transfer',
      });

      assert.equal((await spendingByEnvelope(db, SEPTEMBER)).totalCents, 0);
    });

    test('income is not negative spending, and an opening balance is not spending', async () => {
      await openAccount(db, {
        name: 'Second',
        kind: 'savings',
        openingBalanceCents: 1000000,
        openingDate: '2026-09-01',
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-01',
        amountCents: 320000,
        payeeRaw: 'PAYROLL',
        status: 'confirmed',
        lines: [{ envelopeId: env.unallocatedId, amountCents: 320000 }],
      });
      await spend(env.gasId, 4520, '2026-09-03');

      const report = await spendingByEnvelope(db, SEPTEMBER);
      assert.equal(report.totalCents, 4520, 'just the fuel');
    });

    test('money spent straight out of the pool does count', async () => {
      await spend(env.unallocatedId, 2500, '2026-09-04');
      assert.equal((await spendingByEnvelope(db, SEPTEMBER)).totalCents, 2500);
    });

    test('a refund reduces what the envelope spent', async () => {
      await spend(env.groceriesId, 12000, '2026-09-04');
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-08',
        amountCents: 2500,
        payeeRaw: 'ZEHRS REFUND',
        status: 'confirmed',
        lines: [{ envelopeId: env.groceriesId, amountCents: 2500 }],
      });

      assert.equal((await spendingByEnvelope(db, SEPTEMBER)).totalCents, 9500);
    });

    test('unreviewed spending is included, because the money has gone (RQ-4)', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-04',
        amountCents: -3000,
        payeeRaw: 'PENDING THING',
        lines: [{ envelopeId: env.gasId, amountCents: -3000 }],
      });

      assert.equal((await spendingByEnvelope(db, SEPTEMBER)).totalCents, 3000);
    });

    // -- trend (RP-2) -------------------------------------------------------

    test('a trend has a column for every month, including the empty ones', async () => {
      await spend(env.gasId, 5000, '2026-07-10');
      await spend(env.gasId, 7000, '2026-09-10');

      const trend = await monthlyTrend(db, { from: '2026-07-01', to: '2026-09-30' });
      assert.deepEqual(trend.months, ['2026-07', '2026-08', '2026-09']);

      const gas = trend.rows.find((row) => row.name === 'Gas')!;
      assert.deepEqual(gas.byMonth, [5000, 0, 7000], 'August is a zero, not a missing column');
      assert.equal(gas.totalCents, 12000);
      assert.deepEqual(trend.totalsByMonth, [5000, 0, 7000]);
    });

    test('a trend can be narrowed to chosen envelopes', async () => {
      await spend(env.gasId, 5000, '2026-09-10');
      await spend(env.groceriesId, 9000, '2026-09-10');

      const trend = await monthlyTrend(db, SEPTEMBER, { envelopeIds: [env.gasId] });
      assert.deepEqual(trend.rows.map((row) => row.name), ['Gas']);
      assert.equal(trend.totalCents, 5000);
    });

    test('the busiest envelopes come first, and a limit keeps the top of the list', async () => {
      await spend(env.gasId, 5000, '2026-09-10');
      await spend(env.groceriesId, 9000, '2026-09-10');

      const trend = await monthlyTrend(db, SEPTEMBER, { limit: 1 });
      assert.deepEqual(trend.rows.map((row) => row.name), ['Groceries']);
      assert.equal(
        trend.totalsByMonth[0],
        14000,
        'the totals still count everything, not just what is shown',
      );
    });

    // -- drill-down (RP-1) --------------------------------------------------

    test('the drill-down shows what made up a figure, at its share', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-05',
        amountCents: -10000,
        payeeRaw: 'COSTCO',
        status: 'confirmed',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });

      const rows = await transactionsInPeriod(db, SEPTEMBER, { envelopeId: env.gasId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.payeeRaw, 'COSTCO');
      assert.equal(rows[0]!.shareCents, -4000, "this envelope's share");
      assert.equal(rows[0]!.amountCents, -10000, 'of a larger transaction');
      assert.equal(rows[0]!.account, 'Chequing');
    });

    test('the drill-down for a whole period lists everything, newest first', async () => {
      await spend(env.gasId, 1000, '2026-09-01');
      await spend(env.gasId, 2000, '2026-09-20');

      const rows = await transactionsInPeriod(db, SEPTEMBER);
      assert.deepEqual(rows.map((row) => row.date), ['2026-09-20', '2026-09-01']);
    });
  },
);
