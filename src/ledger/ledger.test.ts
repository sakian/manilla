import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import {
  LedgerError,
  accountBalances,
  checkInvariant,
  envelopeBalances,
  moveBetweenEnvelopes,
  openAccount,
  recordAccountTransfer,
  recordTransaction,
  setTransactionEnvelopes,
  unallocatedEnvelope,
} from './ledger.ts';
import {
  closeDb,
  databaseAvailable,
  pgErrorCode,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from './testdb.ts';
import { envelopes } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'ledger',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;

    before(async () => {
      db = await setupTestDb();
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
    });

    after(async () => {
      // postgres.js keeps the socket open and would hold the test runner up.
      await closeDb(db);
    });

    const balanceOf = async (envelopeId: string) => {
      const all = await envelopeBalances(db);
      return all.find((row) => row.envelopeId === envelopeId)!.balanceCents;
    };

    test('an opening balance lands in the unallocated envelope', async () => {
      const accountId = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 500000,
        openingDate: '2026-01-01',
      });

      const [account] = await accountBalances(db);
      assert.equal(account!.accountId, accountId);
      assert.equal(account!.balanceCents, 500000);
      assert.equal(await balanceOf(env.unallocatedId), 500000);

      const report = await checkInvariant(db);
      assert.ok(report.ok, 'the two sides agree from the very first account');
      assert.equal(report.unassignedCents, 0);
    });

    test('spending moves money out of both an account and an envelope', async () => {
      const accountId = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 100000,
        openingDate: '2026-01-01',
      });
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.gasId,
        amountCents: 20000,
        date: '2026-01-01',
        kind: 'allocation',
      });

      await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -4520,
        payeeRaw: 'SHELL #4471 CALGARY AB',
        lines: [{ envelopeId: env.gasId, amountCents: -4520 }],
      });

      assert.equal((await accountBalances(db))[0]!.balanceCents, 95480);
      assert.equal(await balanceOf(env.gasId), 15480);
      assert.equal(await balanceOf(env.unallocatedId), 80000);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a split must sum to the transaction amount', async () => {
      const accountId = await openAccount(db, { name: 'Visa', kind: 'credit_card' });

      await assert.rejects(
        recordTransaction(db, {
          accountId,
          date: '2026-01-05',
          amountCents: -3640,
          payeeRaw: 'AMZN Mktp CA',
          lines: [
            { envelopeId: env.gasId, amountCents: -1200 },
            { envelopeId: env.groceriesId, amountCents: -2000 },
          ],
        }),
        (error: Error) => error instanceof LedgerError && /does not balance/.test(error.message),
      );

      // Nothing was written: the whole insert is one transaction (NF-2).
      assert.equal((await accountBalances(db))[0]!.balanceCents, 0);
    });

    test('a valid split is recorded across several envelopes', async () => {
      const accountId = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
      await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -3640,
        payeeRaw: 'AMZN Mktp CA',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -1200 },
          { envelopeId: env.gasId, amountCents: -2440 },
        ],
      });

      assert.equal(await balanceOf(env.groceriesId), -1200);
      assert.equal(await balanceOf(env.gasId), -2440);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an uncategorized transaction is unassigned, not corruption', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -4520,
        payeeRaw: 'SOMEWHERE NEW',
      });

      const report = await checkInvariant(db);
      assert.equal(report.accountTotalCents, -4520);
      assert.equal(report.envelopeTotalCents, 0);
      assert.equal(report.unassignedCents, -4520, 'the gap is explained by the review queue');
      assert.equal(report.unexplainedCents, 0);
      assert.ok(report.ok);
    });

    test('categorizing a pending transaction closes the gap', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      const transactionId = await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -4520,
        payeeRaw: 'SHELL #4471',
      });

      await setTransactionEnvelopes(db, transactionId, [
        { envelopeId: env.gasId, amountCents: -4520 },
      ], { confirm: true });

      const report = await checkInvariant(db);
      assert.equal(report.unassignedCents, 0);
      assert.equal(await balanceOf(env.gasId), -4520);
      assert.ok(report.ok);
    });

    test('recategorizing replaces lines rather than adding to them', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      const transactionId = await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -4520,
        payeeRaw: 'SHELL #4471',
        lines: [{ envelopeId: env.gasId, amountCents: -4520 }],
      });

      await setTransactionEnvelopes(db, transactionId, [
        { envelopeId: env.groceriesId, amountCents: -4520 },
      ]);

      assert.equal(await balanceOf(env.gasId), 0, 'the old line is gone');
      assert.equal(await balanceOf(env.groceriesId), -4520);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an account transfer moves money without touching any envelope', async () => {
      const chequing = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 100000,
        openingDate: '2026-01-01',
      });
      const savings = await openAccount(db, { name: 'Savings', kind: 'savings' });

      await recordAccountTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 25000,
        date: '2026-01-10',
      });

      const balances = await accountBalances(db);
      const byId = new Map(balances.map((row) => [row.accountId, row.balanceCents]));
      assert.equal(byId.get(chequing), 75000);
      assert.equal(byId.get(savings), 25000);

      // Envelopes are untouched, and the pair nets to zero so the check holds.
      assert.equal(await balanceOf(env.unallocatedId), 100000);
      const report = await checkInvariant(db);
      assert.ok(report.ok);
      assert.equal(report.unassignedCents, 0, 'transfers are not unassigned spending');
    });

    test('an envelope transfer moves money between envelopes only', async () => {
      const accountId = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 100000,
        openingDate: '2026-01-01',
      });

      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.gasId,
        amountCents: 30000,
        date: '2026-01-02',
        kind: 'allocation',
      });
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.gasId,
        toEnvelopeId: env.groceriesId,
        amountCents: 5000,
        date: '2026-01-03',
        kind: 'transfer',
        note: 'covering an overspend',
      });

      assert.equal(await balanceOf(env.unallocatedId), 70000);
      assert.equal(await balanceOf(env.gasId), 25000);
      assert.equal(await balanceOf(env.groceriesId), 5000);
      assert.equal((await accountBalances(db)).find((a) => a.accountId === accountId)!.balanceCents, 100000);
      assert.ok((await checkInvariant(db)).ok, 'moving between envelopes cannot change the totals');
    });

    test('envelopes may go negative when overspent', async () => {
      const accountId = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        openingBalanceCents: 100000,
        openingDate: '2026-01-01',
      });
      await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.unallocatedId,
        toEnvelopeId: env.gasId,
        amountCents: 2000,
        date: '2026-01-01',
        kind: 'allocation',
      });
      await recordTransaction(db, {
        accountId,
        date: '2026-01-05',
        amountCents: -9000,
        payeeRaw: 'SHELL',
        lines: [{ envelopeId: env.gasId, amountCents: -9000 }],
      });

      assert.equal(await balanceOf(env.gasId), -7000, 'FR-24: overspending is shown, not blocked');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('nonsensical moves and transfers are refused', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });

      await assert.rejects(
        moveBetweenEnvelopes(db, {
          fromEnvelopeId: env.gasId,
          toEnvelopeId: env.gasId,
          amountCents: 100,
          date: '2026-01-01',
          kind: 'transfer',
        }),
        /from an envelope to itself/,
      );

      await assert.rejects(
        moveBetweenEnvelopes(db, {
          fromEnvelopeId: env.gasId,
          toEnvelopeId: env.groceriesId,
          amountCents: -100,
          date: '2026-01-01',
          kind: 'transfer',
        }),
        /must be positive/,
      );

      await assert.rejects(
        recordAccountTransfer(db, {
          fromAccountId: accountId,
          toAccountId: accountId,
          amountCents: 100,
          date: '2026-01-01',
        }),
        /itself/,
      );
    });

    test('an account transfer cannot be given envelopes', async () => {
      const a = await openAccount(db, { name: 'A', kind: 'chequing' });
      const b = await openAccount(db, { name: 'B', kind: 'savings' });
      const [outgoing] = await recordAccountTransfer(db, {
        fromAccountId: a,
        toAccountId: b,
        amountCents: 1000,
        date: '2026-01-01',
      });

      await assert.rejects(
        setTransactionEnvelopes(db, outgoing, [{ envelopeId: env.gasId, amountCents: -1000 }]),
        /no envelopes/,
      );
    });

    test('dates come back as plain calendar strings', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId,
        date: '2026-01-01',
        amountCents: -100,
        payeeRaw: 'X',
        lines: [{ envelopeId: env.gasId, amountCents: -100 }],
      });

      const rows = await db.query.transactions.findMany();
      assert.equal(rows[0]!.date, '2026-01-01');
      assert.equal(typeof rows[0]!.date, 'string', 'never a Date object (see db/client.ts)');
    });

    test('the payee key is normalized on write, ready for the history layer', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      await recordTransaction(db, {
        accountId,
        date: '2026-01-01',
        amountCents: -100,
        payeeRaw: 'SHELL #4471 CALGARY AB',
        lines: [{ envelopeId: env.gasId, amountCents: -100 }],
      });

      const rows = await db.query.transactions.findMany();
      assert.equal(rows[0]!.payeeKey, 'SHELL');
    });

    test('a second unallocated envelope is refused by the database', async () => {
      // The partial unique index is what guarantees "exactly one income pool",
      // so this must hold even if application code forgets to check.
      await assert.rejects(
        db.insert(envelopes).values({
          groupId: env.groupId,
          name: 'Another pool',
          isUnallocated: true,
        }),
        // 23505 = unique_violation. Drizzle wraps the driver error, so the code
        // is on `cause` rather than in the message.
        (error: Error) => pgErrorCode(error) === '23505',
      );
      assert.equal((await unallocatedEnvelope(db)).id, env.unallocatedId);
    });
  },
);
