import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { checkInvariant, openAccount, recordTransaction } from '../ledger/ledger.ts';
import {
  confirmTransactions,
  envelopeOptions,
  highConfidenceIds,
  pendingCount,
  pendingTransactions,
  recategorize,
  splitTransaction,
} from './queue.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { rules, suggestions, transactions } from '../../db/schema.ts';

const available = await databaseAvailable();

describe(
  'review queue',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('queue');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    /** A pending transaction, optionally with a suggestion already applied. */
    async function pending(options: {
      payee: string;
      amountCents: number;
      date?: string;
      envelopeId?: string;
      confidence?: number;
    }) {
      const id = await recordTransaction(db, {
        accountId,
        date: options.date ?? '2026-02-01',
        amountCents: options.amountCents,
        payeeRaw: options.payee,
        source: 'file_import',
        status: 'pending_review',
        ...(options.envelopeId
          ? { lines: [{ envelopeId: options.envelopeId, amountCents: options.amountCents }] }
          : {}),
      });

      if (options.envelopeId && options.confidence !== undefined) {
        await db.insert(suggestions).values({
          transactionId: id,
          envelopeId: options.envelopeId,
          layer: 'history',
          confidence: options.confidence,
          reason: 'test',
        });
      }
      return id;
    }

    test('the queue lists what is waiting, newest first', async () => {
      await pending({ payee: 'SHELL', amountCents: -4520, date: '2026-01-10' });
      await pending({ payee: 'SAFEWAY', amountCents: -9000, date: '2026-02-10' });

      const rows = await pendingTransactions(db);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.payeeDisplay, 'Safeway', 'newest first');
      assert.equal(await pendingCount(db), 2);
    });

    test('confirmed transactions leave the queue', async () => {
      const id = await pending({
        payee: 'SHELL',
        amountCents: -4520,
        envelopeId: env.gasId,
        confidence: 0.97,
      });

      assert.equal(await confirmTransactions(db, [id]), 1);
      assert.equal(await pendingCount(db), 0);

      const [row] = await db.select().from(transactions).where(eq(transactions.id, id));
      assert.equal(row!.status, 'confirmed');
    });

    test('a row with no envelope cannot be confirmed', async () => {
      // Confirming would assert an answer nobody gave.
      const id = await pending({ payee: 'SOMEWHERE NEW', amountCents: -1000 });
      assert.equal(await confirmTransactions(db, [id]), 0);
      assert.equal(await pendingCount(db), 1);
    });

    test('only the high band is offered for bulk confirmation', async () => {
      const confident = await pending({
        payee: 'SHELL',
        amountCents: -4520,
        envelopeId: env.gasId,
        confidence: 0.97,
      });
      await pending({
        payee: 'AMZN',
        amountCents: -3000,
        envelopeId: env.groceriesId,
        confidence: 0.6,
      });
      await pending({ payee: 'UNKNOWN', amountCents: -500 });

      const ids = await highConfidenceIds(db);
      assert.deepEqual(ids, [confident], 'measured precision says only 0.95+ is safe');

      await confirmTransactions(db, ids);
      assert.equal(await pendingCount(db), 2, 'the rest still need a human');
    });

    test('confidence is exposed as a band for the UI', async () => {
      await pending({ payee: 'A', amountCents: -100, envelopeId: env.gasId, confidence: 0.97 });
      await pending({ payee: 'B', amountCents: -100, envelopeId: env.gasId, confidence: 0.7 });
      await pending({ payee: 'C', amountCents: -100, envelopeId: env.gasId, confidence: 0.2 });

      const bands = (await pendingTransactions(db)).map((row) => row.band).sort();
      assert.deepEqual(bands, ['high', 'low', 'medium']);
    });

    test('recategorizing moves the money and confirms the row', async () => {
      const id = await pending({
        payee: 'AMZN Mktp CA',
        amountCents: -3000,
        envelopeId: env.gasId,
        confidence: 0.55,
      });

      await recategorize(db, { transactionId: id, envelopeId: env.groceriesId });

      assert.equal(await pendingCount(db), 0);
      const rows = await pendingTransactions(db);
      assert.equal(rows.length, 0);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a correction can become a standing rule in one step', async () => {
      const id = await pending({ payee: 'SQ *BLUE DOOR COFFEE', amountCents: -540 });

      await recategorize(db, {
        transactionId: id,
        envelopeId: env.groceriesId,
        createRule: true,
      });

      const saved = await db.select().from(rules);
      assert.equal(saved.length, 1);
      assert.equal(saved[0]!.contains, 'BLUE DOOR COFFEE', 'the rule keys on the normalized payee');
      assert.equal(saved[0]!.envelopeId, env.groceriesId);
    });

    test('confirming records what was accepted, for accuracy tracking', async () => {
      const id = await pending({
        payee: 'SHELL',
        amountCents: -4520,
        envelopeId: env.gasId,
        confidence: 0.97,
      });
      await confirmTransactions(db, [id]);

      const [row] = await db.select().from(suggestions).where(eq(suggestions.transactionId, id));
      assert.equal(row!.acceptedEnvelopeId, env.gasId, 'accepted unchanged');
    });

    test('an override is visible as a disagreement with the suggestion', async () => {
      const id = await pending({
        payee: 'AMZN',
        amountCents: -3000,
        envelopeId: env.gasId,
        confidence: 0.6,
      });
      await recategorize(db, { transactionId: id, envelopeId: env.groceriesId });

      const [row] = await db.select().from(suggestions).where(eq(suggestions.transactionId, id));
      assert.equal(row!.envelopeId, env.gasId, 'what was suggested');
      // The confirmed line now differs, which is what the accuracy report reads.
      const rows = await db.query.txnLines.findMany();
      assert.equal(rows[0]!.envelopeId, env.groceriesId);
    });

    test('a transaction can be split across envelopes from the queue', async () => {
      const id = await pending({ payee: 'AMZN Mktp CA', amountCents: -3640 });

      await splitTransaction(db, id, [
        { envelopeId: env.groceriesId, amountCents: -1200 },
        { envelopeId: env.gasId, amountCents: -2440 },
      ]);

      assert.equal(await pendingCount(db), 0);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a split that does not balance is refused', async () => {
      const id = await pending({ payee: 'AMZN Mktp CA', amountCents: -3640 });
      await assert.rejects(
        splitTransaction(db, id, [
          { envelopeId: env.groceriesId, amountCents: -1200 },
          { envelopeId: env.gasId, amountCents: -1000 },
        ]),
        /does not balance/,
      );
      assert.equal(await pendingCount(db), 1, 'the row is untouched');
    });

    test('envelope options come back grouped and ordered', async () => {
      const options = await envelopeOptions(db);
      assert.equal(options.length, 3);
      assert.ok(options.every((option) => option.groupName === 'Living'));
      assert.deepEqual(options.map((option) => option.name), ['Available', 'Gas', 'Groceries']);
    });

    test('the age indicator counts days waiting', async () => {
      const id = await pending({ payee: 'OLD', amountCents: -100 });
      await db
        .update(transactions)
        .set({ createdAt: new Date(Date.now() - 12 * 86_400_000) })
        .where(eq(transactions.id, id));

      const [row] = await pendingTransactions(db);
      assert.equal(row!.ageDays, 12, 'RQ-6');
    });
  },
);
