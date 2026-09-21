import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { envelopeBalances, moveBetweenEnvelopes, openAccount, recordTransaction } from '../ledger/ledger.ts';
import { envelopeActivity } from './activity.ts';
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
  'an envelope’s activity',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;

    before(async () => {
      db = await setupTestDb('activity');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    /** A month of Groceries: filled, spent from in a split, some moved to Gas. */
    async function month() {
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.groceriesId,
        amountCents: 40000,
        date: '2026-09-01',
        kind: 'allocation',
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-05',
        amountCents: -10000,
        payeeRaw: 'COSTCO',
        source: 'manual',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.groceriesId,
        toEnvelopeId: env.gasId,
        amountCents: 2500,
        date: '2026-09-10',
        kind: 'transfer',
      });
    }

    test('fills, spending and transfers read as one history, balance by balance', async () => {
      await month();
      const activity = await envelopeActivity(db, env.groceriesId);

      assert.equal(activity.total, 3);
      assert.deepEqual(
        activity.rows.map((row) =>
          row.type === 'move'
            ? ['move', row.move.otherEnvelopeName, row.move.amountCents, row.balanceAfterCents]
            : ['transaction', row.transaction.payeeRaw, row.shareCents, row.balanceAfterCents],
        ),
        [
          ['move', 'Gas', -2500, 31500],
          ['transaction', 'COSTCO', -6000, 34000],
          ['move', 'Available', 40000, 40000],
        ],
        'newest first; the split counts at Groceries’ share, not the whole $100',
      );

      const fill = activity.rows.at(-1)!;
      assert.ok(fill.type === 'move' && fill.move.otherIsPool && fill.move.kind === 'allocation');

      // The list ends where the envelope's own balance is.
      const card = (await envelopeBalances(db)).find((row) => row.envelopeId === env.groceriesId)!;
      assert.equal(activity.rows[0]!.balanceAfterCents, card.balanceCents);
    });

    test('a date window shows the envelope’s balance, not the window’s sum', async () => {
      await month();
      const activity = await envelopeActivity(db, env.groceriesId, {
        from: '2026-09-05',
        to: '2026-09-30',
        order: 'asc',
      });
      assert.equal(activity.total, 2, 'the fill on the 1st is outside the window');
      assert.deepEqual(
        activity.rows.map((row) => row.balanceAfterCents),
        [34000, 31500],
        'but it still counts towards the balance the window opens on',
      );
    });

    test('pages through a long history without losing count', async () => {
      await month();
      const first = await envelopeActivity(db, env.groceriesId, { limit: 2 });
      const second = await envelopeActivity(db, env.groceriesId, { limit: 2, offset: 2 });
      assert.equal(first.rows.length, 2);
      assert.ok(first.hasMore);
      assert.equal(second.rows.length, 1);
      assert.ok(!second.hasMore);
    });
  },
);
