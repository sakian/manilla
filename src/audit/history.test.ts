/**
 * Who made each change (NF-2): the person travels with the work and the
 * trigger writes them down. Like audit.test.ts, these go through the app's own
 * write paths, because the point is that none of them can forget.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { auditLog, envelopeMoves, transactions } from '../../db/schema.ts';
import { openAccount } from '../ledger/ledger.ts';
import {
  createManualTransaction,
  updateTransaction,
} from '../transactions/manage.ts';
import { addMessage, editMessage, removeMessage } from '../transactions/thread.ts';
import { confirmTransactions } from '../queue/queue.ts';
import { fundEnvelopes, reverseAllocation } from '../budget/budget.ts';
import { envelopeHistory } from '../envelopes/manage.ts';
import { envelopeActivity } from '../envelopes/activity.ts';
import { transferBetweenEnvelopes } from '../envelopes/transfer.ts';
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
        await updateTransaction(db, id, { payeeRaw: 'Birthday' });
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

    test('whoever adds a transaction is kept on it, since the trail records only changes', async () => {
      const id = await runAs(ALEX, groceries);
      const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
      assert.equal(row!.createdById, ALEX.id);
      assert.equal(row!.createdByName, 'Alex');

      const unclaimed = await groceries();
      const [other] = await db.select().from(transactions).where(eq(transactions.id, unclaimed));
      assert.equal(other!.createdByName, null, 'nobody said, so it does not guess');
    });

    test('every way of moving money between envelopes says who did it', async () => {
      await createManualTransaction(db, {
        accountId: chequing,
        date: '2026-09-01',
        amountCents: 100000,
        payeeRaw: 'Pay',
        lines: [{ envelopeId: env.unallocatedId, amountCents: 100000 }],
      });
      await runAs(ALEX, () =>
        fundEnvelopes(db, '2026-09', [{ envelopeId: env.groceriesId, amountCents: 30000 }], {
          today: '2026-09-02',
        }),
      );
      // These two used to write outside a transaction, where no name reached
      // the database at all.
      await runAs(SAM, () =>
        transferBetweenEnvelopes(db, {
          fromEnvelopeId: env.groceriesId,
          toEnvelopeId: env.gasId,
          amountCents: 5000,
          date: '2026-09-03',
        }),
      );
      const [allocation] = await db.select().from(envelopeMoves).where(eq(envelopeMoves.toEnvelopeId, env.groceriesId));
      await runAs(SAM, () => reverseAllocation(db, allocation!.id));

      const moves = await db.select().from(envelopeMoves).orderBy(asc(envelopeMoves.createdAt), asc(envelopeMoves.date));
      assert.deepEqual(
        moves.map((move) => [move.kind, move.createdById, move.createdByName]),
        [
          ['allocation', ALEX.id, 'Alex'],
          ['transfer', SAM.id, 'Sam'],
          ['allocation', SAM.id, 'Sam'],
        ],
      );

      // Both places an envelope's moves are listed.
      const history = await envelopeHistory(db, env.groceriesId);
      const listed = history.flatMap((event) => (event.kind === 'transaction' ? [] : [event.by]));
      assert.deepEqual(listed.sort(), ['Alex', 'Sam', 'Sam']);
      const { rows } = await envelopeActivity(db, env.groceriesId);
      const shown = rows.flatMap((row) => (row.type === 'move' ? [row.move.by] : []));
      assert.deepEqual(shown.sort(), ['Alex', 'Sam', 'Sam']);
    });

    test('the history reads as sentences, newest first, one entry per save', async () => {
      const id = await groceries();
      await updateTransaction(db, id, { date: '2026-09-20' });
      await runAs(ALEX, () => updateTransaction(db, id, { payeeRaw: 'Market', date: '2026-09-21' }));
      await runAs(SAM, () =>
        updateTransaction(db, id, { lines: [{ envelopeId: env.gasId, amountCents: -2250 }] }),
      );
      await runAs(SAM, () => addMessage(db, id, 'fuel, not food'));

      const history = await transactionHistory(db, id);
      assert.deepEqual(
        history.map(({ who, changes }) => ({ who, changes: [...changes].sort() })),
        [
          { who: 'Sam', changes: ['wrote "fuel, not food"'] },
          { who: 'Sam', changes: [`envelopes changed (was Groceries ${formatMoney(-2250)})`] },
          { who: 'Alex', changes: ['date 2026-09-20 → 2026-09-21', 'payee "Farmers market" → "Market"'] },
          { who: null, changes: ['date 2026-09-19 → 2026-09-20'] },
          { who: null, changes: ['added'] },
        ].map((entry) => ({ ...entry, changes: entry.changes.sort() })),
        'compared with each entry sorted, since column order is not promised',
      );
    });

    test('a message changed or taken back is in the trail, in the name of whoever did it', async () => {
      const id = await groceries();
      const sam = { id: crypto.randomUUID(), name: 'Sam' };
      const message = await runAs(sam, () => addMessage(db, id, 'for the trip'));
      await runAs(sam, () => editMessage(db, message.id, sam.id, 'for the cottage'));
      const second = await runAs(sam, () => addMessage(db, id, 'never mind'));
      await runAs(sam, () => removeMessage(db, second.id, sam.id));
      const said = (await transactionHistory(db, id)).flatMap((entry) => entry.changes.map((change) => `${entry.who}: ${change}`));
      assert.ok(said.includes('Sam: changed "for the trip" to "for the cottage"'), JSON.stringify(said));
      assert.ok(said.includes('Sam: removed "never mind"'), JSON.stringify(said));
      assert.ok(said.includes('Sam: wrote "for the cottage"'), 'the message as it stands, when it was first written');
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
      assert.deepEqual(history.map((entry) => entry.changes), [
        ['payee "Farmers market" → "Market"'],
        ['added'],
      ]);
    });

    test('a transaction nobody has changed has only its arrival, and who brought it', async () => {
      const id = await runAs(SAM, groceries);
      const history = await transactionHistory(db, id);
      assert.deepEqual(
        history.map(({ who, changes }) => ({ who, changes })),
        [{ who: 'Sam', changes: ['added'] }],
      );
    });
  },
);
