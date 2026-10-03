/**
 * The audit trail (NF-2, #8) is written by a trigger, so these go through the
 * app's own write paths - the ones a person reaches - rather than poking rows
 * directly: the point is that none of them can change money without it showing.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { auditLog, envelopeMoves, transactions } from '../../db/schema.ts';
import { openAccount } from '../ledger/ledger.ts';
import {
  createManualTransaction,
  deleteTransaction,
  sendBackToReview,
  updateTransaction,
} from '../transactions/manage.ts';
import { eraseAllData, exportLedger } from '../export/export.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';

const available = await databaseAvailable();

describe(
  'the audit trail',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;

    before(async () => {
      db = await setupTestDb('audit');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const entries = () => db.select().from(auditLog).orderBy(asc(auditLog.id));

    const groceries = (amountCents = -2250) =>
      createManualTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents,
        payeeRaw: 'Farmers market',
        lines: [{ envelopeId: env.groceriesId, amountCents }],
      });

    test('creating something records nothing: the row says when it came', async () => {
      await groceries();
      assert.deepEqual(await entries(), []);
    });

    test('an edit records what each changed column was and became, and nothing else', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { date: '2026-09-20', payeeRaw: 'Farmers Market (Sat)' });

      const [entry, ...rest] = (await entries()).filter((row) => row.tableName === 'transactions');
      assert.equal(rest.length, 0);
      assert.equal(entry!.action, 'update');
      assert.equal(entry!.rowId, id);
      assert.equal(entry!.transactionId, id);
      assert.deepEqual(entry!.before, { date: '2026-09-19', payee_raw: 'Farmers market', payee_key: 'FARMERS MARKET' });
      assert.deepEqual(entry!.after, {
        date: '2026-09-20',
        payee_raw: 'Farmers Market (Sat)',
        payee_key: (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!.payeeKey,
      });
      assert.ok(!('updated_at' in (entry!.before as object)), 'a timestamp moving is not a change');
    });

    test('changing the envelope keeps the line it replaced, under its transaction', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { lines: [{ envelopeId: env.gasId, amountCents: -2250 }] });

      const removed = (await entries()).find((row) => row.tableName === 'txn_lines' && row.action === 'delete');
      assert.ok(removed, 'the old split is on record');
      assert.equal(removed.transactionId, id, 'and findable from the transaction');
      assert.equal((removed.before as { envelope_id: string }).envelope_id, env.groceriesId);
      assert.equal((removed.before as { amount_cents: number }).amount_cents, -2250);
    });

    test('a change of amount is recorded in cents, as a whole number', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { amountCents: -2575 });

      const change = (await entries()).find((row) => row.tableName === 'transactions')!;
      assert.deepEqual(change.before, { amount_cents: -2250 });
      assert.deepEqual(change.after, { amount_cents: -2575 });
    });

    test('a deletion keeps the whole row, and its lines', async () => {
      const id = await groceries();
      await deleteTransaction(db, id);

      const rows = await entries();
      const gone = rows.find((row) => row.tableName === 'transactions')!;
      assert.equal(gone.action, 'delete');
      assert.equal(gone.after, null);
      assert.equal((gone.before as { payee_raw: string }).payee_raw, 'Farmers market');
      assert.equal((gone.before as { amount_cents: number }).amount_cents, -2250);
      assert.ok(
        rows.some((row) => row.tableName === 'txn_lines' && row.transactionId === id),
        'the envelope it was in goes on record with it',
      );
    });

    test('sending a transaction back to review records the confirmation it undid', async () => {
      const id = await groceries();
      await sendBackToReview(db, id);

      const status = (await entries()).find(
        (row) => row.tableName === 'transactions' && 'status' in (row.before as object),
      )!;
      assert.deepEqual(status.before, { status: 'confirmed' });
      assert.deepEqual(status.after, { status: 'pending_review' });
    });

    test('a move changed or removed is on record too', async () => {
      const [move] = await db
        .insert(envelopeMoves)
        .values({
          fromEnvelopeId: env.unallocatedId,
          toEnvelopeId: env.gasId,
          amountCents: 5000,
          date: '2026-09-01',
          kind: 'allocation',
        })
        .returning({ id: envelopeMoves.id });
      await db.update(envelopeMoves).set({ amountCents: 6000 }).where(eq(envelopeMoves.id, move!.id));
      await db.delete(envelopeMoves).where(eq(envelopeMoves.id, move!.id));

      const rows = (await entries()).filter((row) => row.tableName === 'envelope_moves');
      assert.deepEqual(
        rows.map((row) => [row.action, row.before, row.transactionId]),
        [
          ['update', { amount_cents: 5000 }, null],
          ['delete', rows[1]!.before, null],
        ],
      );
      assert.equal((rows[1]!.before as { amount_cents: number }).amount_cents, 6000);
    });

    test('the entry is part of the change: a change rolled back leaves no entry', async () => {
      const id = await groceries();
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.update(transactions).set({ payeeRaw: 'Never mind' }).where(eq(transactions.id, id));
          throw new Error('rolled back');
        }),
      );
      assert.deepEqual(await entries(), []);
    });

    test('the export carries the trail, and erasing everything takes it too', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { payeeRaw: 'Market' });
      const exported = await exportLedger(db);
      assert.equal(exported.auditLog.length, (await entries()).length);
      assert.ok(exported.auditLog.length > 0);
      assert.equal(exported.counts.auditEntries, exported.auditLog.length);

      await eraseAllData(db);
      assert.deepEqual(await entries(), [], 'an erase that kept a copy of everything would be no erase');
    });
  },
);
