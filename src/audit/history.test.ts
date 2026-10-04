/**
 * Who made each change (NF-2): the person travels with the work and the
 * trigger writes them down. Like audit.test.ts, these go through the app's own
 * write paths, because the point is that none of them can forget.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { auditLog, transactions } from '../../db/schema.ts';
import { openAccount } from '../ledger/ledger.ts';
import {
  createManualTransaction,
  setTransactionNote,
  updateTransaction,
} from '../transactions/manage.ts';
import { confirmTransactions } from '../queue/queue.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';
import { actAs, actorSetting, currentActor, runAs } from './actor.ts';
import { transactionHistory } from './history.ts';
import { formatMoney } from '../money.ts';

const ALEX = { id: '00000000-0000-4000-8000-00000000a1e7', name: 'Alex' };
const SAM = { id: '00000000-0000-4000-8000-0000000005a3', name: 'Sam' };

test('the setting is the person as JSON, or nothing', () => {
  assert.equal(actorSetting(undefined), null);
  assert.deepEqual(JSON.parse(actorSetting(ALEX)!), ALEX);
  assert.equal(JSON.parse(actorSetting({ id: null, name: 'x'.repeat(100) })!).name.length, 60);
});

test('actAs covers the rest of the action and nothing beside it', async () => {
  const seen: (string | undefined)[] = [];
  const requireUser = async (who: typeof ALEX) => ({ userId: who.id, userName: who.name });
  // Shaped like a real action: the session is awaited first, always.
  const action = async (who: typeof ALEX) => {
    actAs(await requireUser(who));
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(currentActor()?.name);
  };
  await Promise.all([action(ALEX), action(SAM)]);
  assert.deepEqual(seen.sort(), ['Alex', 'Sam']);
  assert.equal(currentActor(), undefined, 'and the caller is untouched');
});

const available = await databaseAvailable();

describe(
  'who changed it (NF-2)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;

    before(async () => {
      db = await setupTestDb('history');
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

    const groceries = () =>
      createManualTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -2250,
        payeeRaw: 'Farmers market',
        lines: [{ envelopeId: env.groceriesId, amountCents: -2250 }],
      });

    test('a change made as someone carries their id and name', async () => {
      const id = await groceries();
      await runAs(ALEX, () => updateTransaction(db, id, { payeeRaw: 'Farmers Market' }));

      const [entry] = await entries();
      assert.equal(entry!.actorId, ALEX.id);
      assert.equal(entry!.actorName, 'Alex');
    });

    test('a change nobody claimed says so rather than guessing', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { payeeRaw: 'Farmers Market' });
      const [entry] = await entries();
      assert.equal(entry!.actorId, null);
      assert.equal(entry!.actorName, null);
    });

    test("one person's name never lands on the next change on a pooled connection", async () => {
      const id = await groceries();
      for (let i = 0; i < 5; i++) {
        await runAs(ALEX, () => updateTransaction(db, id, { payeeRaw: `Market ${i}` }));
      }
      await updateTransaction(db, id, { payeeRaw: 'Unclaimed' });
      const last = (await entries()).at(-1)!;
      assert.equal(last.actorName, null);
    });

    test('a setting that is not a person still lets the change through', async () => {
      const id = await groceries();
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('manilla.actor', 'not json', true)`);
        await tx.update(transactions).set({ payeeRaw: 'Still saved' }).where(eq(transactions.id, id));
      });
      const [entry] = await entries();
      assert.equal(entry!.actorName, null);
      const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
      assert.equal(row!.payeeRaw, 'Still saved');
    });

    test('the writes that used to run outside a transaction are claimed too', async () => {
      const id = await groceries();
      // Entered by hand it is confirmed already, and confirming that again is
      // no change to record.
      await db.update(transactions).set({ status: 'pending_review' }).where(eq(transactions.id, id));
      await db.delete(auditLog);
      await runAs(SAM, async () => {
        await setTransactionNote(db, id, 'birthday');
        await confirmTransactions(db, [id]);
      });
      const names = (await entries()).map((row) => row.actorName);
      assert.ok(names.length >= 2);
      assert.ok(names.every((name) => name === 'Sam'), JSON.stringify(names));
    });

    test('concurrent actions keep their own names', async () => {
      const first = await groceries();
      const second = await groceries();
      await Promise.all([
        runAs(ALEX, () => updateTransaction(db, first, { payeeRaw: 'A' })),
        runAs(SAM, () => updateTransaction(db, second, { payeeRaw: 'B' })),
      ]);
      const rows = await entries();
      assert.equal(rows.find((row) => row.rowId === first)!.actorName, 'Alex');
      assert.equal(rows.find((row) => row.rowId === second)!.actorName, 'Sam');
    });

    test('the history reads as sentences, newest first, one entry per save', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { date: '2026-09-20' });
      await runAs(ALEX, () => updateTransaction(db, id, { payeeRaw: 'Market', date: '2026-09-21' }));
      await runAs(SAM, () =>
        updateTransaction(db, id, { lines: [{ envelopeId: env.gasId, amountCents: -2250 }] }),
      );
      await runAs(SAM, () => setTransactionNote(db, id, 'fuel, not food'));

      const history = await transactionHistory(db, id);
      assert.deepEqual(
        history.map(({ who, changes }) => ({ who, changes: [...changes].sort() })),
        [
          { who: 'Sam', changes: ['note "fuel, not food"'] },
          { who: 'Sam', changes: [`envelopes changed (was Groceries ${formatMoney(-2250)})`] },
          { who: 'Alex', changes: ['date 2026-09-20 → 2026-09-21', 'payee "Farmers market" → "Market"'] },
          { who: null, changes: ['date 2026-09-19 → 2026-09-20'] },
        ].map((entry) => ({ ...entry, changes: entry.changes.sort() })),
        'compared with each entry sorted, since column order is not promised',
      );
    });

    test('saving the same split again is not an envelope change', async () => {
      const id = await groceries();
      await runAs(ALEX, () =>
        updateTransaction(db, id, {
          payeeRaw: 'Market',
          lines: [{ envelopeId: env.groceriesId, amountCents: -2250 }],
        }),
      );
      const history = await transactionHistory(db, id);
      assert.deepEqual(history.map((entry) => entry.changes), [['payee "Farmers market" → "Market"']]);
    });

    test('a transaction nobody has changed has no history', async () => {
      const id = await groceries();
      assert.deepEqual(await transactionHistory(db, id), []);
    });
  },
);
