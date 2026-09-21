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
  pairTransferHalves,
  recategorize,
  saveReview,
  splitTransaction,
  transferCandidates,
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

    const balanceOf = async (envelopeId: string) => {
      const { envelopeBalances } = await import('../ledger/ledger.ts');
      return (await envelopeBalances(db)).find((row) => row.envelopeId === envelopeId)!.balanceCents;
    };

    /** A pending transaction, optionally with a suggestion already applied. */
    async function pending(options: {
      payee: string;
      amountCents: number;
      date?: string;
      envelopeId?: string;
      confidence?: number;
      account?: string;
    }) {
      const id = await recordTransaction(db, {
        accountId: options.account ?? accountId,
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

    // -- finding the other half of a transfer -------------------------------

    test('an equal and opposite row in another account is offered as the other half', async () => {
      const { openAccount: open } = await import('../ledger/ledger.ts');
      const visa = await open(db, { name: 'Visa', kind: 'credit_card' });

      const leaving = await pending({
        payee: 'TFR-TO C C',
        amountCents: -50000,
        date: '2026-03-15',
      });
      await recordTransaction(db, {
        accountId: visa,
        date: '2026-03-17',
        amountCents: 50000,
        payeeRaw: 'PAYMENT RECEIVED',
        source: 'file_import',
        status: 'pending_review',
      });

      const found = await transferCandidates(db);

      // Both rows are waiting, so both are told about it - whichever one you are
      // looking at should say so, not just whichever happens to sort first.
      assert.equal(found.length, 2);

      const candidate = found.find((row) => row.transactionId === leaving)!;
      assert.ok(candidate, 'the second statement completes the pair');
      assert.equal(candidate.accountId, visa);
      assert.equal(candidate.accountName, 'Visa');
      assert.equal(candidate.otherDate, '2026-03-17');
      assert.equal(
        found.find((row) => row.transactionId === candidate.otherId)!.otherId,
        leaving,
        'and each points at the other',
      );
    });

    test('pairing two halves joins the rows that exist rather than writing a third', async () => {
      const { openAccount: open, accountBalances } = await import('../ledger/ledger.ts');
      const visa = await open(db, { name: 'Visa', kind: 'credit_card' });

      const leaving = await pending({
        payee: 'TFR-TO C C',
        amountCents: -50000,
        date: '2026-03-15',
        envelopeId: env.gasId,
      });
      const arriving = await recordTransaction(db, {
        accountId: visa,
        date: '2026-03-17',
        amountCents: 50000,
        payeeRaw: 'PAYMENT RECEIVED',
        source: 'file_import',
        status: 'pending_review',
      });

      await pairTransferHalves(db, leaving, arriving);

      const all = await db.select().from(transactions);
      assert.equal(all.length, 2, 'two statements, two rows - not a fabricated third');
      assert.ok(all.every((row) => row.kind === 'account_transfer'));
      assert.ok(all.every((row) => row.status === 'confirmed'));
      assert.equal(new Set(all.map((row) => row.transferPairId)).size, 1);

      assert.equal(await balanceOf(env.gasId), 0, 'a transfer is not spending and never was');
      assert.equal(await pendingCount(db), 0);
      assert.ok((await checkInvariant(db)).ok);

      const balances = await accountBalances(db);
      assert.equal(balances.find((row) => row.accountId === visa)!.balanceCents, 50000);
    });

    test('pairing refuses anything that is not two halves of one transfer', async () => {
      const { openAccount: open } = await import('../ledger/ledger.ts');
      const visa = await open(db, { name: 'Visa', kind: 'credit_card' });

      const out = await pending({ payee: 'TFR', amountCents: -50000 });
      const sameAccount = await pending({ payee: 'REFUND', amountCents: 50000 });
      const wrongAmount = await recordTransaction(db, {
        accountId: visa,
        date: '2026-03-16',
        amountCents: 49900,
        payeeRaw: 'NEARLY',
        source: 'file_import',
        status: 'pending_review',
      });

      await assert.rejects(
        () => pairTransferHalves(db, out, sameAccount),
        /two different accounts/,
      );
      await assert.rejects(() => pairTransferHalves(db, out, wrongAmount), /cancel out exactly/);
      await assert.rejects(
        () => pairTransferHalves(db, out, '00000000-0000-0000-0000-000000000000'),
        /have to exist/,
      );
    });

    test('the same account, a different amount, or too long apart is not a pair', async () => {
      const { openAccount: open } = await import('../ledger/ledger.ts');
      const visa = await open(db, { name: 'Visa', kind: 'credit_card' });

      await pending({ payee: 'TFR-TO C C', amountCents: -50000, date: '2026-03-15' });

      // Same amount, same account: two sides of nothing.
      await pending({ payee: 'REFUND', amountCents: 50000, date: '2026-03-15' });
      // Right shape, wrong account pairing is fine - but three weeks later.
      await recordTransaction(db, {
        accountId: visa,
        date: '2026-04-06',
        amountCents: 50000,
        payeeRaw: 'TOO LATE',
        source: 'file_import',
        status: 'pending_review',
      });

      assert.deepEqual(await transferCandidates(db), []);
    });

    test('a row already half of a transfer is not offered as half of another', async () => {
      const { openAccount: open } = await import('../ledger/ledger.ts');
      const { convertToTransfer } = await import('../transactions/manage.ts');
      const visa = await open(db, { name: 'Visa', kind: 'credit_card' });
      const savings = await open(db, { name: 'Savings', kind: 'savings' });

      await pending({ payee: 'TFR-TO C C', amountCents: -50000, date: '2026-03-15' });
      const claimed = await recordTransaction(db, {
        accountId: visa,
        date: '2026-03-16',
        amountCents: 50000,
        payeeRaw: 'ALREADY PAIRED',
        source: 'file_import',
        status: 'confirmed',
      });
      await convertToTransfer(db, claimed, { toAccountId: savings });

      assert.deepEqual(await transferCandidates(db), [], 'it belongs to something already');
    });

    // -- saving a sitting's decisions ---------------------------------------

    test('saving writes only the rows decided, and leaves the rest waiting', async () => {
      const shell = await pending({ payee: 'SHELL', amountCents: -4520 });
      const safeway = await pending({ payee: 'SAFEWAY', amountCents: -9000 });
      const mystery = await pending({ payee: 'WHO KNOWS', amountCents: -1000 });

      const result = await saveReview(db, [
        { transactionId: shell, envelopeId: env.gasId },
        { transactionId: safeway, envelopeId: env.groceriesId },
      ]);

      assert.deepEqual(result, { confirmed: 2, failed: [] });

      const waiting = await pendingTransactions(db);
      assert.deepEqual(
        waiting.map((row) => row.id),
        [mystery],
        'an undecided row is untouched, not confirmed and not emptied',
      );

      const [row] = await db.select().from(transactions).where(eq(transactions.id, shell));
      assert.equal(row!.status, 'confirmed');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('saving records what was accepted, so accuracy stays measurable (CA-9)', async () => {
      // This is what stopped happening when the queue moved from confirming each
      // row to staging and saving: nothing wrote accepted_envelope_id any more,
      // and the accuracy figure on the settings page went stale in silence.
      const kept = await pending({
        payee: 'SHELL',
        amountCents: -4520,
        envelopeId: env.gasId,
        confidence: 0.97,
      });
      const overridden = await pending({
        payee: 'SAFEWAY',
        amountCents: -9000,
        envelopeId: env.gasId,
        confidence: 0.6,
      });

      await saveReview(db, [
        { transactionId: kept, envelopeId: env.gasId },
        { transactionId: overridden, envelopeId: env.groceriesId },
      ]);

      const rows = await db.select().from(suggestions);
      const accepted = new Map(rows.map((row) => [row.transactionId, row.acceptedEnvelopeId]));

      assert.equal(accepted.get(kept), env.gasId, 'kept: the suggestion was right');
      assert.equal(
        accepted.get(overridden),
        env.groceriesId,
        'overridden: what was kept, not what was proposed - that is the disagreement',
      );
    });

    test('a row with no suggestion saves without one being invented', async () => {
      const id = await pending({ payee: 'NEVER SEEN', amountCents: -1000 });
      await saveReview(db, [{ transactionId: id, envelopeId: env.gasId }]);

      assert.equal((await db.select().from(suggestions)).length, 0);
      assert.equal(await balanceOf(env.gasId), -1000);
    });

    test('saving into an archived envelope is refused (FR-25)', async () => {
      const { archiveEnvelope } = await import('../envelopes/manage.ts');
      const id = await pending({ payee: 'SHELL', amountCents: -4520 });
      await archiveEnvelope(db, env.gasId);

      const result = await saveReview(db, [{ transactionId: id, envelopeId: env.gasId }]);

      // An archived envelope holding money is the one thing FR-25 exists to
      // prevent: a balance that is not on screen but is still in the totals.
      assert.equal(result.confirmed, 0);
      assert.match(result.failed[0]!.error, /archived/);
      assert.equal(await balanceOf(env.gasId), 0);
      assert.equal(await pendingCount(db), 1, 'and it is still waiting, not half-saved');
    });

    test('saving nothing is allowed and writes nothing', async () => {
      await pending({ payee: 'SHELL', amountCents: -4520 });
      assert.deepEqual(await saveReview(db, []), { confirmed: 0, failed: [] });
      assert.equal(await pendingCount(db), 1);
    });

    test('a decision can change the envelope the suggestion proposed', async () => {
      const id = await pending({
        payee: 'SHELL',
        amountCents: -4520,
        envelopeId: env.gasId,
        confidence: 0.98,
      });

      await saveReview(db, [{ transactionId: id, envelopeId: env.groceriesId }]);

      assert.equal(await balanceOf(env.gasId), 0, 'the proposed line is replaced, not added to');
      assert.equal(await balanceOf(env.groceriesId), -4520);
    });

    test('one bad decision is reported and the good ones still save', async () => {
      const good = await pending({ payee: 'SHELL', amountCents: -4520 });

      const result = await saveReview(db, [
        { transactionId: good, envelopeId: env.gasId },
        {
          transactionId: '00000000-0000-0000-0000-000000000000',
          envelopeId: env.gasId,
        },
      ]);

      assert.equal(result.confirmed, 1, 'twelve good decisions are not thrown away by one bad row');
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0]!.error, /No such transaction/);
      assert.equal(await pendingCount(db), 0);
    });

    test('a decision can lay down a rule for next time (CA-2)', async () => {
      const id = await pending({ payee: 'SHELL 4471 CALGARY', amountCents: -4520 });

      await saveReview(db, [
        { transactionId: id, envelopeId: env.gasId, createRule: true },
      ]);

      const [rule] = await db.select().from(rules).where(eq(rules.envelopeId, env.gasId));
      assert.ok(rule, 'the correction becomes a standing rule');
      assert.equal(rule!.contains, 'SHELL');
    });

    test('the queue lists what is waiting, oldest first', async () => {
      await pending({ payee: 'SAFEWAY', amountCents: -9000, date: '2026-02-10' });
      await pending({ payee: 'SHELL', amountCents: -4520, date: '2026-01-10' });

      const rows = await pendingTransactions(db);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.payeeDisplay, 'Shell', 'oldest first, whatever order they arrived in');
      assert.equal(await pendingCount(db), 2);
    });

    test('each account’s rows read together, in the accounts screen’s order', async () => {
      const { createAccountGroup, moveAccountToGroup } = await import('../accounts/groups.ts');
      const visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
      const savings = await openAccount(db, { name: 'Savings', kind: 'savings' });
      // Cards before banking on this household's accounts screen; Savings has no
      // category, so it comes last.
      const cards = await createAccountGroup(db, 'Cards');
      const banking = await createAccountGroup(db, 'Banking');
      await moveAccountToGroup(db, visa, cards);
      await moveAccountToGroup(db, accountId, banking);

      await pending({ payee: 'SAVINGS FEE', amountCents: -100, date: '2026-01-01', account: savings });
      await pending({ payee: 'SHELL', amountCents: -4520, date: '2026-01-20' });
      await pending({ payee: 'NETFLIX', amountCents: -1699, date: '2026-01-15', account: visa });
      await pending({ payee: 'SAFEWAY', amountCents: -9000, date: '2026-01-05' });
      await pending({ payee: 'SPOTIFY', amountCents: -1199, date: '2026-01-02', account: visa });

      const rows = await pendingTransactions(db);
      assert.deepEqual(
        rows.map((row) => `${row.accountName} ${row.date}`),
        [
          'Visa 2026-01-02',
          'Visa 2026-01-15',
          'Chequing 2026-01-05',
          'Chequing 2026-01-20',
          'Savings 2026-01-01',
        ],
      );
    });

    test('the cap keeps the oldest, whichever account they are in', async () => {
      const visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
      await pending({ payee: 'SHELL', amountCents: -100, date: '2026-01-10' });
      await pending({ payee: 'SHELL', amountCents: -200, date: '2026-01-11' });
      await pending({ payee: 'NETFLIX', amountCents: -300, date: '2026-01-01', account: visa });

      // Grouping by account inside the query would have kept Chequing's two and
      // left out the card's older one.
      const rows = await pendingTransactions(db, { limit: 2 });
      assert.deepEqual(rows.map((row) => row.date).sort(), ['2026-01-01', '2026-01-10']);
    });

    test('a note comes with its row', async () => {
      const id = await pending({ payee: 'SHELL', amountCents: -4520 });
      const { setTransactionNote } = await import('../transactions/manage.ts');
      await setTransactionNote(db, id, 'rental car');
      assert.equal((await pendingTransactions(db))[0]!.note, 'rental car');
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
