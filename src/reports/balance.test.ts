import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { envelopeMoves } from '../../db/schema.ts';
import { envelopeBalances, openAccount } from '../ledger/ledger.ts';
import { createManualTransaction } from '../transactions/manage.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';
import { envelopeBalanceSeries, monthEndBalances, toSeries } from './balance.ts';

test('a series is the balance going in, after each change, and at the end', () => {
  const series = toSeries(
    5000,
    [
      { date: '2026-09-03', cents: -2000 },
      { date: '2026-09-20', cents: 10000 },
    ],
    '2026-09-01',
    '2026-09-30',
  );
  assert.deepEqual(series.points, [
    { date: '2026-09-01', balanceCents: 5000 },
    { date: '2026-09-03', balanceCents: 3000 },
    { date: '2026-09-20', balanceCents: 13000 },
    { date: '2026-09-30', balanceCents: 13000 },
  ]);
});

test('a change on the last day is the last point, not followed by a copy of it', () => {
  const series = toSeries(0, [{ date: '2026-09-30', cents: 500 }], '2026-09-01', '2026-09-30');
  assert.equal(series.points.length, 2);
});

test('the table view is the balance at the end of each month', () => {
  const series = toSeries(
    1000,
    [
      { date: '2026-08-15', cents: 500 },
      { date: '2026-10-02', cents: -200 },
    ],
    '2026-08-01',
    '2026-10-03',
  );
  assert.deepEqual(monthEndBalances(series), [
    { month: '2026-08', balanceCents: 1500 },
    { month: '2026-09', balanceCents: 1500 },
    { month: '2026-10', balanceCents: 1300 },
  ]);
});

const available = await databaseAvailable();

describe(
  "an envelope's balance over time",
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;

    before(async () => {
      db = await setupTestDb('balance_series');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const fund = (date: string, cents: number) =>
      db.insert(envelopeMoves).values({
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.gasId,
        amountCents: cents,
        date,
        kind: 'allocation',
      });

    const spend = (date: string, cents: number) =>
      createManualTransaction(db, {
        accountId: chequing,
        date,
        amountCents: -cents,
        payeeRaw: 'SHELL',
        lines: [{ envelopeId: env.gasId, amountCents: -cents }],
      });

    test('it starts from what came before the period, and ends at the real balance', async () => {
      await fund('2026-08-01', 20000);
      await spend('2026-08-20', 4000);
      await fund('2026-09-01', 20000);
      await spend('2026-09-05', 6000);
      await spend('2026-09-05', 1500);
      await db.insert(envelopeMoves).values({
        fromEnvelopeId: env.gasId,
        toEnvelopeId: env.groceriesId,
        amountCents: 2500,
        date: '2026-09-12',
        kind: 'transfer',
      });

      const series = await envelopeBalanceSeries(
        db,
        env.gasId,
        { from: '2026-09-01', to: '2026-09-30' },
        '2026-10-03',
      );
      assert.deepEqual(series.points, [
        { date: '2026-09-01', balanceCents: 16000 },
        { date: '2026-09-01', balanceCents: 36000 },
        { date: '2026-09-05', balanceCents: 28500 },
        { date: '2026-09-12', balanceCents: 26000 },
        { date: '2026-09-30', balanceCents: 26000 },
      ]);
      const gas = (await envelopeBalances(db)).find((row) => row.envelopeId === env.gasId)!;
      assert.equal(series.points.at(-1)!.balanceCents, gas.balanceCents);
    });

    test('a period running into the future stops at today', async () => {
      await fund('2026-10-01', 5000);
      const series = await envelopeBalanceSeries(
        db,
        env.gasId,
        { from: '2026-01-01', to: '2026-12-31' },
        '2026-10-03',
      );
      assert.equal(series.end, '2026-10-03');
    });

    test('"all time" starts where the envelope does, not in 1970', async () => {
      await fund('2025-04-01', 5000);
      await spend('2025-04-09', 1000);
      const series = await envelopeBalanceSeries(
        db,
        env.gasId,
        { from: '1970-01-01', to: '2999-12-31' },
        '2026-10-03',
      );
      assert.equal(series.start, '2025-04-01');
      assert.deepEqual(series.points.slice(0, 2), [
        { date: '2025-04-01', balanceCents: 0 },
        { date: '2025-04-01', balanceCents: 5000 },
      ]);
    });

    test('an envelope that never moved is a flat line at zero', async () => {
      const series = await envelopeBalanceSeries(
        db,
        env.groceriesId,
        { from: '2026-09-01', to: '2026-09-30' },
        '2026-10-03',
      );
      assert.deepEqual(series.points, [
        { date: '2026-09-01', balanceCents: 0 },
        { date: '2026-09-30', balanceCents: 0 },
      ]);
    });
  },
);
