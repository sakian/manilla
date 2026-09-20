import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import {
  accountBalances,
  checkInvariant,
  envelopeBalances,
  openAccount,
  recordTransaction,
} from '../ledger/ledger.ts';
import {
  TransactionError,
  convertToTransfer,
  createManualTransaction,
  createTransfer,
  deleteTransaction,
  deleteTransfer,
  transactionDetail,
  transferDetail,
  unmatchedTransferHalves,
  updateTransaction,
  updateTransfer,
} from './manage.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { transactionExternalIds, transactions } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'entering and correcting transactions',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;
    let savings: string;

    before(async () => {
      db = await setupTestDb('transactions');
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

    const balanceOf = async (envelopeId: string) =>
      (await envelopeBalances(db)).find((row) => row.envelopeId === envelopeId)!.balanceCents;

    const accountBalance = async (accountId: string) =>
      (await accountBalances(db)).find((row) => row.accountId === accountId)!.balanceCents;

    // -- creating (FR-2) ----------------------------------------------------

    test('a transaction typed in with its envelope is recorded and confirmed', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -2250,
        payeeRaw: 'Farmers market',
        lines: [{ envelopeId: env.groceriesId, amountCents: -2250 }],
      });

      const detail = await transactionDetail(db, id);
      assert.equal(detail!.status, 'confirmed', 'nothing left to review: they just said where');
      assert.equal(detail!.source, 'manual');
      assert.equal(detail!.payeeRaw, 'Farmers market');
      assert.equal(await balanceOf(env.groceriesId), -2250);
      assert.equal(await accountBalance(chequing), -2250);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a transaction entered without an envelope joins the review queue', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -1000,
        payeeRaw: 'Something I will sort out later',
      });

      const detail = await transactionDetail(db, id);
      assert.equal(detail!.status, 'pending_review');
      assert.deepEqual(detail!.lines, []);
    });

    test('a split has to add up, and says by how much when it does not (FR-4)', async () => {
      await assert.rejects(
        () =>
          createManualTransaction(db, {
            accountId: chequing,
            amountCents: -10000,
            payeeRaw: 'Costco',
            lines: [
              { envelopeId: env.groceriesId, amountCents: -6000 },
              { envelopeId: env.gasId, amountCents: -3000 },
            ],
          }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.match(error.message, /-\$90\.00/);
          assert.match(error.message, /-\$10\.00 unaccounted for/);
          return true;
        },
      );

      assert.equal((await db.select().from(transactions)).length, 0, 'nothing was written');
    });

    test('a split that adds up is recorded across the envelopes', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -10000,
        payeeRaw: 'Costco',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });

      const detail = await transactionDetail(db, id);
      assert.equal(detail!.lines.length, 2);
      assert.equal(await balanceOf(env.groceriesId), -6000);
      assert.equal(await balanceOf(env.gasId), -4000);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an empty description or a zero amount is refused', async () => {
      await assert.rejects(
        () => createManualTransaction(db, { accountId: chequing, amountCents: -100, payeeRaw: '  ' }),
        TransactionError,
      );
      await assert.rejects(
        () => createManualTransaction(db, { accountId: chequing, amountCents: 0, payeeRaw: 'Nothing' }),
        TransactionError,
      );
      await assert.rejects(
        () =>
          createManualTransaction(db, {
            accountId: chequing,
            amountCents: -100.5,
            payeeRaw: 'Half a cent',
          }),
        TransactionError,
      );
    });

    test('a malformed date is refused rather than coerced', async () => {
      await assert.rejects(
        () =>
          createManualTransaction(db, {
            accountId: chequing,
            date: '19/09/2026',
            amountCents: -100,
            payeeRaw: 'Corner shop',
          }),
        TransactionError,
      );
    });

    // -- editing (FR-2, RQ-5) ----------------------------------------------

    test('changing the amount of an unsplit transaction carries its envelope line', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -2250,
        payeeRaw: 'Farmers market',
        lines: [{ envelopeId: env.groceriesId, amountCents: -2250 }],
      });

      await updateTransaction(db, id, { amountCents: -3175 });

      assert.equal(await balanceOf(env.groceriesId), -3175);
      assert.equal(await accountBalance(chequing), -3175);
      assert.ok((await checkInvariant(db)).ok, 'both sides moved together');
    });

    test('changing the amount of a split transaction needs the new split with it', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -10000,
        payeeRaw: 'Costco',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -6000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });

      await assert.rejects(
        () => updateTransaction(db, id, { amountCents: -12000 }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.match(error.message, /needs the new split/);
          return true;
        },
      );

      // With the split supplied, it goes through.
      await updateTransaction(db, id, {
        amountCents: -12000,
        lines: [
          { envelopeId: env.groceriesId, amountCents: -8000 },
          { envelopeId: env.gasId, amountCents: -4000 },
        ],
      });
      assert.equal(await balanceOf(env.groceriesId), -8000);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('editing the description recomputes the key history matches on', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -4400,
        payeeRaw: 'SHELL #4471 CALGARY AB',
        lines: [{ envelopeId: env.gasId, amountCents: -4400 }],
      });

      await updateTransaction(db, id, { payeeRaw: 'ESSO 12345 TORONTO ON' });

      const [row] = await db.select().from(transactions);
      assert.equal(row!.payeeRaw, 'ESSO 12345 TORONTO ON');
      assert.equal(row!.payeeKey, 'ESSO', 'the normalized key followed the description');
    });

    test('a transaction can be moved to another account, ids and all', async () => {
      const id = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -4400,
        payeeRaw: 'SHELL',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -4400 }],
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
      });

      await updateTransaction(db, id, { accountId: savings });

      assert.equal(await accountBalance(chequing), 0);
      assert.equal(await accountBalance(savings), -4400);

      const [external] = await db.select().from(transactionExternalIds);
      assert.equal(
        external!.accountId,
        savings,
        'the bank id is scoped per account, so it moved too',
      );
    });

    test('a split can be turned back into no envelope at all', async () => {
      const id = await createManualTransaction(db, {
        accountId: chequing,
        amountCents: -10000,
        payeeRaw: 'Costco',
        lines: [{ envelopeId: env.groceriesId, amountCents: -10000 }],
      });

      await updateTransaction(db, id, { lines: [], status: 'pending_review' });

      const detail = await transactionDetail(db, id);
      assert.deepEqual(detail!.lines, []);
      assert.equal(detail!.status, 'pending_review');

      const report = await checkInvariant(db);
      assert.ok(report.ok, 'unassigned money is explained, not corruption');
      assert.equal(report.unassignedCents, -10000);
    });

    test('an archived envelope cannot be given a share', async () => {
      const { archiveEnvelope } = await import('../envelopes/manage.ts');
      const { createEnvelope, createGroup } = await import('../envelopes/manage.ts');
      const groupId = await createGroup(db, 'Old things');
      const retired = await createEnvelope(db, { groupId, name: 'Retired' });
      await archiveEnvelope(db, retired);

      await assert.rejects(
        () =>
          createManualTransaction(db, {
            accountId: chequing,
            amountCents: -500,
            payeeRaw: 'Something',
            lines: [{ envelopeId: retired, amountCents: -500 }],
          }),
        TransactionError,
      );
    });

    // -- deleting ------------------------------------------------------------

    test('deleting removes the transaction, its lines and its bank id', async () => {
      const id = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-19',
        amountCents: -4400,
        payeeRaw: 'SHELL',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -4400 }],
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
      });

      const result = await deleteTransaction(db, id);
      assert.equal(result.removed, 1);
      assert.equal(result.externalIds, 1, 'so the caller can say a re-import will offer it again');

      assert.equal((await db.select().from(transactions)).length, 0);
      assert.equal((await db.select().from(transactionExternalIds)).length, 0);
      assert.equal(await balanceOf(env.gasId), 0);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('an opening balance is corrected, never deleted', async () => {
      const funded = await openAccount(db, {
        name: 'Credit card',
        kind: 'credit_card',
        openingBalanceCents: -50000,
        openingDate: '2026-09-01',
      });

      const [opening] = await db.select().from(transactions);
      assert.equal(opening!.source, 'opening_balance');

      await assert.rejects(
        () => deleteTransaction(db, opening!.id),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.match(error.message, /opening balance/);
          return true;
        },
      );

      // Correcting it is the supported route, and keeps the books balanced.
      await updateTransaction(db, opening!.id, { amountCents: -42000 });
      assert.equal(await accountBalance(funded), -42000);
      assert.equal(await balanceOf(env.unallocatedId), -42000);
      assert.ok((await checkInvariant(db)).ok);
    });

    // -- account transfers (FR-5) -------------------------------------------

    test('a transfer moves money between accounts and counts as neither spending nor income', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-01',
        amountCents: 100000,
        payeeRaw: 'PAYROLL',
        status: 'confirmed',
        lines: [{ envelopeId: env.unallocatedId, amountCents: 100000 }],
      });

      const pairId = await createTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 40000,
        date: '2026-09-19',
      });

      assert.equal(await accountBalance(chequing), 60000);
      assert.equal(await accountBalance(savings), 40000);
      assert.equal(
        await balanceOf(env.unallocatedId),
        100000,
        'no envelope moved: the money is still assigned where it was',
      );
      assert.ok((await checkInvariant(db)).ok);

      const detail = await transferDetail(db, pairId);
      assert.equal(detail!.fromAccountId, chequing);
      assert.equal(detail!.toAccountId, savings);
      assert.equal(detail!.amountCents, 40000);
      assert.match(detail!.payeeRaw, /Chequing to Savings/);
    });

    test('a transfer half cannot be edited on its own', async () => {
      const pairId = await createTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 10000,
      });

      const [half] = await db.select().from(transactions);
      await assert.rejects(
        () => updateTransaction(db, half!.id, { amountCents: -5000 }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.match(error.message, /both halves/);
          return true;
        },
      );
      assert.ok(pairId);
    });

    test('editing a transfer moves both halves together', async () => {
      const pairId = await createTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 10000,
        date: '2026-09-19',
      });

      await updateTransfer(db, pairId, {
        amountCents: 25000,
        date: '2026-09-20',
        fromAccountId: savings,
        toAccountId: chequing,
      });

      assert.equal(await accountBalance(chequing), 25000);
      assert.equal(await accountBalance(savings), -25000);

      const detail = await transferDetail(db, pairId);
      assert.equal(detail!.date, '2026-09-20');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a transfer to the same account, or of nothing, is refused', async () => {
      await assert.rejects(
        () =>
          createTransfer(db, {
            fromAccountId: chequing,
            toAccountId: chequing,
            amountCents: 1000,
          }),
        Error,
      );
      await assert.rejects(
        () =>
          createTransfer(db, { fromAccountId: chequing, toAccountId: savings, amountCents: 0 }),
        TransactionError,
      );
    });

    test('deleting either half deletes the pair', async () => {
      const pairId = await createTransfer(db, {
        fromAccountId: chequing,
        toAccountId: savings,
        amountCents: 10000,
      });

      const [half] = await db.select().from(transactions);
      const result = await deleteTransaction(db, half!.id);

      assert.equal(result.removed, 2, 'both halves, or the books stop balancing');
      assert.equal((await db.select().from(transactions)).length, 0);
      assert.ok((await checkInvariant(db)).ok);
      await assert.rejects(() => deleteTransfer(db, pairId), TransactionError);
    });

    // -- an imported row that turns out to be a transfer (FR-5) --------------

    test('an imported payment to a card becomes a transfer, and no envelope moves', async () => {
      // How the chequing statement words it.
      const imported = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
        lines: [{ envelopeId: env.groceriesId, amountCents: -50000 }],
        externalIds: [{ kind: 'fitid', value: 'CHQ-1' }],
      });

      const pairId = await convertToTransfer(db, imported, { toAccountId: savings });

      assert.equal(await accountBalance(chequing), -50000);
      assert.equal(await accountBalance(savings), 50000);
      assert.equal(
        await balanceOf(env.groceriesId),
        0,
        'the envelope it was guessed into is released: paying a card is not spending',
      );

      const detail = await transactionDetail(db, imported);
      assert.equal(detail!.kind, 'account_transfer');
      assert.equal(detail!.status, 'confirmed');
      assert.deepEqual(detail!.lines, []);
      assert.ok((await checkInvariant(db)).ok);

      const transfer = await transferDetail(db, pairId);
      assert.equal(transfer!.fromAccountId, chequing);
      assert.equal(transfer!.toAccountId, savings);
      assert.equal(transfer!.amountCents, 50000);
    });

    test('the bank id stays on the half it arrived with', async () => {
      const imported = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
        externalIds: [{ kind: 'fitid', value: 'CHQ-1' }],
      });
      await convertToTransfer(db, imported, { toAccountId: savings });

      const ids = await db.select().from(transactionExternalIds);
      assert.equal(ids.length, 1);
      assert.equal(ids[0]!.transactionId, imported, 'on the chequing half, not the other one');
    });

    test('the half with no statement yet is the one waiting to be matched', async () => {
      const imported = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
        externalIds: [{ kind: 'fitid', value: 'CHQ-1' }],
      });
      await convertToTransfer(db, imported, { toAccountId: savings });

      assert.deepEqual(
        (await unmatchedTransferHalves(db, chequing)).map((half) => half.id),
        [],
        'the chequing half came from its own statement',
      );

      const waiting = await unmatchedTransferHalves(db, savings);
      assert.equal(waiting.length, 1);
      assert.equal(waiting[0]!.amountCents, 50000);
    });

    test('a transfer cannot be converted twice, or into its own account', async () => {
      const imported = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
      });

      await assert.rejects(
        () => convertToTransfer(db, imported, { toAccountId: chequing }),
        TransactionError,
      );

      await convertToTransfer(db, imported, { toAccountId: savings });
      await assert.rejects(
        () => convertToTransfer(db, imported, { toAccountId: savings }),
        (error: unknown) => {
          assert.ok(error instanceof TransactionError);
          assert.match(error.message, /already a transfer/);
          return true;
        },
      );
    });

    test('a transfer through an archived account is refused', async () => {
      const { archiveAccount } = await import('../accounts/manage.ts');
      await archiveAccount(db, savings);

      await assert.rejects(
        () =>
          createTransfer(db, {
            fromAccountId: chequing,
            toAccountId: savings,
            amountCents: 1000,
          }),
        TransactionError,
      );
    });
  },
);
