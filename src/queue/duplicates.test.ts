import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { checkInvariant, openAccount, recordTransaction } from '../ledger/ledger.ts';
import { convertToTransfer } from '../transactions/manage.ts';
import { DuplicateError, duplicateCandidates, mergeDuplicate } from './duplicates.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { transactionExternalIds, transactionMessages, transactions } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'a waiting row that is a second record of one already here (FR-18)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let chequing: string;
    let visa: string;

    before(async () => {
      db = await setupTestDb('duplicates');
    });

    beforeEach(async () => {
      await truncateAll(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
    });

    after(async () => {
      await closeDb(db);
    });

    /** The card's half of a payment, written from the chequing side and linked to a statement file. */
    async function paidCard(): Promise<string> {
      const payment = await recordTransaction(db, {
        accountId: chequing,
        date: '2026-11-05',
        amountCents: -50000,
        payeeRaw: 'TFR-TO C/C',
        source: 'bank_sync',
        externalIds: [{ kind: 'aggregator', value: 'plaid-chq' }],
      });
      await convertToTransfer(db, payment, { toAccountId: visa });
      const half = (await db.select().from(transactions)).find((row) => row.accountId === visa)!;
      await db.insert(transactionExternalIds).values({
        transactionId: half.id,
        accountId: visa,
        kind: 'fitid',
        value: 'VISA-1',
      });
      return half.id;
    }

    const fromFeed = (date: string, value: string, payeeRaw = 'PAYMENT - THANK YOU') =>
      recordTransaction(db, {
        accountId: visa,
        date,
        amountCents: 50000,
        payeeRaw,
        source: 'bank_sync',
        status: 'pending_review',
        externalIds: [{ kind: 'aggregator', value }],
      });

    test('the payment the feed sent again is offered as the transfer already here', async () => {
      const half = await paidCard();
      const waiting = await fromFeed('2026-11-06', 'plaid-visa');

      const [candidate] = await duplicateCandidates(db);
      assert.equal(candidate?.transactionId, waiting);
      assert.equal(candidate?.existingId, half);
      assert.equal(candidate?.existingIsTransfer, true);
    });

    test('merging moves the bank id and the notes, and leaves one record', async () => {
      const half = await paidCard();
      const waiting = await fromFeed('2026-11-06', 'plaid-visa');
      await db.insert(transactionMessages).values({ transactionId: waiting, body: 'Is this the Visa payment?' });

      await mergeDuplicate(db, waiting, half);

      const visaRows = (await db.select().from(transactions)).filter((row) => row.accountId === visa);
      assert.deepEqual(visaRows.map((row) => row.id), [half]);
      const ids = (await db.select().from(transactionExternalIds))
        .filter((row) => row.transactionId === half)
        .map((row) => row.value)
        .sort();
      assert.deepEqual(ids, ['VISA-1', 'plaid-visa'], 'so the feed recognises it from now on');
      const [message] = await db.select().from(transactionMessages);
      assert.equal(message?.transactionId, half);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('two entries from the same source are two transactions, not one', async () => {
      const first = await fromFeed('2026-11-06', 'plaid-1', 'AMZN Mktp CA');
      await db.update(transactions).set({ status: 'confirmed' });
      const second = await fromFeed('2026-11-06', 'plaid-2', 'AMZN Mktp CA');

      assert.deepEqual(await duplicateCandidates(db), []);
      await assert.rejects(() => mergeDuplicate(db, second, first), DuplicateError);
    });

    test('a reviewed transaction is never merged away, and amounts have to agree', async () => {
      const half = await paidCard();
      const waiting = await fromFeed('2026-11-06', 'plaid-visa');
      await assert.rejects(() => mergeDuplicate(db, half, waiting), DuplicateError);

      const other = await recordTransaction(db, {
        accountId: visa,
        date: '2026-11-06',
        amountCents: 49999,
        payeeRaw: 'PAYMENT - THANK YOU',
        status: 'pending_review',
      });
      await assert.rejects(() => mergeDuplicate(db, other, half), DuplicateError);
    });

    test('nothing a week away is offered', async () => {
      await paidCard();
      await fromFeed('2026-11-12', 'plaid-visa');
      assert.deepEqual(await duplicateCandidates(db), []);
    });
  },
);
