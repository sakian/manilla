import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Database } from '../../db/client.ts';
import { parseOfx, type OfxStatement } from '../ofx/parse.ts';
import {
  openAccount,
  accountBalances,
  checkInvariant,
  envelopeBalances,
  recordTransaction,
} from '../ledger/ledger.ts';
import {
  balanceCheckpoints,
  commitImport,
  importHistory,
  previewImport,
  resolveAccount,
  revertImport,
  type RowDecision,
} from './ofxImport.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { transactions, txnLines } from '../../db/schema.ts';

const available = await databaseAvailable();

const sample = (name: string) =>
  readFileSync(new URL(`../../data/samples/${name}`, import.meta.url), 'utf8');

/** The bank statement fixture, as a single statement. */
function bankStatement(): OfxStatement {
  return parseOfx(sample('bank-ofx1.ofx')).statements[0]!;
}

describe(
  'ofx import',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('import');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, {
        name: 'Chequing',
        kind: 'chequing',
        externalAccountId: '1234567',
      });
    });

    after(async () => {
      await closeDb(db);
    });

    const acceptAll = new Map<number, RowDecision>();

    test('the statement maps to an account by its bank account number', async () => {
      const found = await resolveAccount(db, bankStatement());
      assert.equal(found?.id, accountId, 'FR-7: remembered mapping');
    });

    test('a first import classifies every row as new', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.equal(preview.counts.new, 5);
      assert.equal(preview.counts.duplicate, 0);
      assert.equal(preview.counts.possible_duplicate, 0);
    });

    test('importing writes the transactions and their bank ids', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      const result = await commitImport(db, preview, acceptAll, { filename: 'bank.ofx' });

      assert.equal(result.added, 5);
      const rows = await db.select().from(transactions);
      assert.equal(rows.length, 5);
      assert.ok(rows.every((row) => row.status === 'pending_review'), 'FR-12');
      assert.ok(rows.every((row) => row.source === 'file_import'));

      // The account balance now reflects the statement.
      const [balance] = await accountBalances(db);
      assert.equal(balance!.balanceCents, 320000 - 4520 - 120455 - 15000 - 8813);
    });

    test('re-importing the same file changes nothing (FR-11)', async () => {
      const first = await previewImport(db, bankStatement(), accountId, { categorize: false });
      await commitImport(db, first, acceptAll);

      const second = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.equal(second.counts.new, 0);
      assert.equal(second.counts.duplicate, 5, 'matched on FITID');

      const result = await commitImport(db, second, acceptAll);
      assert.equal(result.added, 0);
      assert.equal((await db.select().from(transactions)).length, 5);
    });

    test('an overlapping date range adds only what is genuinely new', async () => {
      const full = bankStatement();
      const partial: OfxStatement = { ...full, transactions: full.transactions.slice(0, 3) };

      await commitImport(
        db,
        await previewImport(db, partial, accountId, { categorize: false }),
        acceptAll,
      );

      const second = await previewImport(db, full, accountId, { categorize: false });
      assert.equal(second.counts.duplicate, 3);
      assert.equal(second.counts.new, 2);

      await commitImport(db, second, acceptAll);
      assert.equal((await db.select().from(transactions)).length, 5);
    });

    test('identical charges on one day are all imported, not deduplicated', async () => {
      // The real GoodBudget history contained four identical $3.75 vending
      // charges on one day. Different FITIDs mean these are four purchases.
      const statement: OfxStatement = {
        ...bankStatement(),
        transactions: [0, 1, 2, 3].map((n) => ({
          fitId: `VEND-${n}`,
          type: 'DEBIT',
          posted: '2025-09-03',
          amountCents: -375,
          name: 'CAD SODA SNACK VENDING',
          warnings: [],
        })),
      };

      const preview = await previewImport(db, statement, accountId, { categorize: false });
      assert.equal(preview.counts.new, 4, 'all four are new');
      assert.equal(preview.counts.possible_duplicate, 0, 'and none look suspicious');

      const result = await commitImport(db, preview, acceptAll);
      assert.equal(result.added, 4);
    });

    test('a look-alike with no shared id is flagged, never dropped', async () => {
      // Simulates the GoodBudget migration meeting the bank feed (MG-9): the
      // same purchase already exists, entered from another source.
      await recordTransaction(db, {
        accountId,
        date: '2025-09-03',
        amountCents: -4520,
        payeeRaw: 'SHELL #4471 CALGARY AB',
        source: 'goodbudget',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -4520 }],
      });

      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.equal(preview.counts.possible_duplicate, 1);
      assert.equal(preview.counts.new, 4);

      const flagged = preview.rows.find((row) => row.verdict === 'possible_duplicate')!;
      assert.match(flagged.reason, /no shared bank id/);
      assert.ok(flagged.existingId, 'it points at what it matched');
    });

    test('linking a look-alike attaches the bank id instead of duplicating', async () => {
      const existingId = await recordTransaction(db, {
        accountId,
        date: '2025-09-03',
        amountCents: -4520,
        payeeRaw: 'SHELL #4471 CALGARY AB',
        source: 'goodbudget',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: -4520 }],
      });

      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      const flagged = preview.rows.find((row) => row.verdict === 'possible_duplicate')!;

      const decisions = new Map<number, RowDecision>([
        [flagged.index, { action: 'link', transactionId: existingId }],
      ]);
      const result = await commitImport(db, preview, decisions);

      assert.equal(result.linked, 1);
      assert.equal(result.added, 4, 'the other four still import');
      assert.equal((await db.select().from(transactions)).length, 5, 'no duplicate created');

      // And now the bank id is known, so a re-import recognises it.
      const again = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.equal(again.counts.duplicate, 5);
      assert.equal(again.counts.new, 0);
    });

    test('the statement balance is checked against the result (FR-14)', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.ok(preview.balanceCheck, 'the file carries a ledger balance');
      assert.equal(preview.balanceCheck!.statedCents, 482194);
      // The fixture's transactions do not add up to its stated balance, which is
      // exactly the mismatch FR-14 exists to surface.
      assert.equal(preview.balanceCheck!.matches, false);
      assert.equal(preview.balanceCheck!.projectedCents, 171212);
    });

    test('each statement leaves a balance checkpoint, and a repeat leaves no second', async () => {
      for (let run = 0; run < 2; run += 1) {
        await commitImport(
          db,
          await previewImport(db, bankStatement(), accountId, { categorize: false }),
          acceptAll,
        );
      }
      const checkpoints = await balanceCheckpoints(db, accountId);
      assert.equal(checkpoints.length, 1);
      assert.deepEqual(checkpoints[0], {
        asOf: '2025-09-04',
        statedCents: 482194,
        ledgerCents: 171212,
        differenceCents: 171212 - 482194,
        changeCents: null,
        previousAsOf: null,
      });
    });

    test('a change between checkpoints says which weeks to look in', async () => {
      const full = bankStatement();
      const byDate = [...full.transactions].sort((a, b) => a.posted.localeCompare(b.posted));
      const sum = (rows: typeof byDate) => rows.reduce((total, row) => total + row.amountCents, 0);
      const early = byDate.slice(0, 3);

      // The first statement agrees with the ledger exactly.
      const first: OfxStatement = {
        ...full,
        transactions: early,
        ledgerBalanceCents: sum(early),
        ledgerBalanceAsOf: early[2]!.posted,
      };
      // The second says the bank holds $10 more than those five rows make: a
      // deposit the ledger never saw, somewhere after the first statement.
      const second: OfxStatement = {
        ...full,
        ledgerBalanceCents: sum(byDate) + 1000,
        ledgerBalanceAsOf: byDate[4]!.posted,
      };
      for (const statement of [first, second]) {
        await commitImport(
          db,
          await previewImport(db, statement, accountId, { categorize: false }),
          acceptAll,
        );
      }

      const [before, after] = await balanceCheckpoints(db, accountId);
      assert.equal(before!.differenceCents, 0);
      assert.equal(after!.differenceCents, -1000);
      assert.equal(after!.changeCents, -1000, 'the gap opened between the two');
      assert.equal(after!.previousAsOf, early[2]!.posted);
    });

    test('imported money is assigned immediately so the dashboard stays honest', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      await commitImport(db, preview, acceptAll);

      // Nothing was categorized (no history yet), so it all sits unassigned -
      // reported as such rather than as corruption.
      const report = await checkInvariant(db);
      assert.ok(report.ok);
      assert.equal(report.unexplainedCents, 0);
      assert.notEqual(report.unassignedCents, 0);
    });

    test('an import can be undone whole (FR-13)', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      const { batchId } = await commitImport(db, preview, acceptAll);
      assert.equal((await db.select().from(transactions)).length, 5);

      const removed = await revertImport(db, batchId);
      assert.equal(removed, 5);
      assert.equal((await db.select().from(transactions)).length, 0);

      // The bank ids went with them, so the file can be imported again.
      const after = await previewImport(db, bankStatement(), accountId, { categorize: false });
      assert.equal(after.counts.new, 5);
    });

    test('income with nowhere else to go lands in the income pool (FR-28)', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { useAi: false });
      const payroll = preview.rows.find((row) => row.transaction.amountCents > 0)!;

      assert.equal(payroll.suggestion?.envelope, env.unallocatedId);
      assert.equal(payroll.suggestion?.layer, 'rule');
      assert.match(payroll.suggestion!.reason, /until you allocate it/);

      await commitImport(db, preview, acceptAll);

      // It is applied at once so the pool is accurate before review is finished,
      // and still awaits confirmation like everything else (RQ-4, FR-12).
      const balances = await envelopeBalances(db);
      const pool = balances.find((row) => row.envelopeId === env.unallocatedId)!;
      assert.equal(pool.balanceCents, 320000);
    });

    test('a refund at a known merchant is not treated as income', async () => {
      // History says this merchant's money comes out of Groceries...
      for (const date of ['2025-06-03', '2025-07-03', '2025-08-03']) {
        await recordTransaction(db, {
          accountId,
          date,
          amountCents: -12000,
          payeeRaw: 'SAFEWAY #212',
          status: 'confirmed',
          lines: [{ envelopeId: env.groceriesId, amountCents: -12000 }],
        });
      }

      // ...so money coming back from it belongs there too, not in the pool.
      const statement = bankStatement();
      const refund = { ...statement.transactions[1]!, fitId: 'refund-1', amountCents: 2500 };
      const preview = await previewImport(
        db,
        { ...statement, transactions: [refund] },
        accountId,
        { useAi: false },
      );

      assert.equal(preview.rows[0]!.suggestion?.envelope, env.groceriesId);
      assert.equal(preview.rows[0]!.suggestion?.layer, 'history');
    });

    test('a confident suggestion moves the money; an unsure one only offers to', async () => {
      const { envelopeBalances } = await import('../ledger/ledger.ts');

      // Ten past trips to one place: history is sure about the next one. The
      // dates all precede the statement, because the history layer refuses to
      // learn from decisions made after the transaction it is judging.
      for (let at = 0; at < 10; at += 1) {
        await recordTransaction(db, {
          accountId,
          date: `2025-07-0${(at % 9) + 1}`,
          amountCents: -5000 - at,
          payeeRaw: 'SAFEWAY #212',
          status: 'confirmed',
          lines: [{ envelopeId: env.groceriesId, amountCents: -5000 - at }],
        });
      }
      // And one place the money has gone two ways from, in equal measure on the
      // same day for the same amount - so neither the recency nor the amount
      // signal can break the tie, and the top candidate sits at exactly half.
      for (const envelopeId of [env.groceriesId, env.gasId, env.groceriesId, env.gasId]) {
        await recordTransaction(db, {
          accountId,
          date: '2025-07-15',
          amountCents: -3000,
          payeeRaw: 'E-TRANSFER',
          status: 'confirmed',
          lines: [{ envelopeId, amountCents: -3000 }],
        });
      }

      const statement = bankStatement();
      const base = statement.transactions[1]!;
      const preview = await previewImport(
        db,
        {
          ...statement,
          transactions: [
            { ...base, fitId: 'sure-1', name: 'SAFEWAY #212', amountCents: -6000 },
            { ...base, fitId: 'unsure-1', name: 'E-TRANSFER', amountCents: -9900 },
          ],
        },
        accountId,
        { useAi: false },
      );

      const before = await envelopeBalances(db);
      const balanceOf = (rows: typeof before, id: string) =>
        rows.find((row) => row.envelopeId === id)!.balanceCents;

      await commitImport(db, preview, acceptAll);
      const after = await envelopeBalances(db);

      // The confident one is applied, so the envelope screen is worth reading
      // before anything has been reviewed (RQ-4)...
      assert.equal(
        balanceOf(after, env.groceriesId),
        balanceOf(before, env.groceriesId) - 6000,
        'a suggestion worth believing moves the money',
      );

      // ...and the unsure one is offered without moving anything, because a
      // guess should not quietly change a balance nobody has agreed to.
      const row = (fitId: string) => preview.rows.find((r) => r.transaction.fitId === fitId)!;
      assert.ok(row('sure-1').suggestion!.confidence >= 0.5);
      assert.ok(row('unsure-1').suggestion!.confidence < 0.5, 'a coin flip is not a pattern');
      assert.equal(
        balanceOf(after, env.gasId),
        balanceOf(before, env.gasId),
        'the unsure guess moved nothing',
      );

      // Its money is unassigned, which the ledger already has a word for.
      const invariant = await checkInvariant(db);
      assert.ok(invariant.ok);
      assert.equal(invariant.unassignedCents, -9900);
    });

    test('an unsure suggestion is still offered in the queue', async () => {
      const { pendingTransactions } = await import('../queue/queue.ts');

      for (const envelopeId of [env.groceriesId, env.gasId, env.groceriesId, env.gasId]) {
        await recordTransaction(db, {
          accountId,
          date: '2025-07-15',
          amountCents: -3000,
          payeeRaw: 'E-TRANSFER',
          status: 'confirmed',
          lines: [{ envelopeId, amountCents: -3000 }],
        });
      }

      const statement = bankStatement();
      const preview = await previewImport(
        db,
        {
          ...statement,
          transactions: [
            { ...statement.transactions[1]!, fitId: 'unsure-1', name: 'E-TRANSFER', amountCents: -9900 },
          ],
        },
        accountId,
        { useAi: false },
      );
      await commitImport(db, preview, acceptAll);

      // Reading the proposal from the suggestion as well as from the ledger is
      // what keeps this row from arriving with nothing to say for itself.
      const [row] = await pendingTransactions(db);
      assert.ok(row!.envelopeId, 'the guess is still there to accept or reject');
      assert.equal(row!.band, 'low');

      // It just has not moved any money.
      assert.equal((await db.select().from(txnLines)).length, 4, 'only the seeded lines');
    });

    test('the import log says what each run did, and what survives of it', async () => {
      const preview = await previewImport(db, bankStatement(), accountId, { categorize: false });
      const { batchId } = await commitImport(db, preview, acceptAll, {
        filename: 'accountactivity.ofx',
      });

      const [batch] = await importHistory(db);
      assert.equal(batch!.id, batchId);
      assert.equal(batch!.filename, 'accountactivity.ofx');
      assert.equal(batch!.accountName, 'Chequing');
      assert.equal(batch!.addedCount, 5);
      assert.equal(batch!.remaining, 5);
      assert.equal(batch!.revertedAt, null);

      // Deleting one of its transactions by hand leaves the log honest about it.
      const { deleteTransaction } = await import('../transactions/manage.ts');
      const rows = await db.select().from(transactions);
      await deleteTransaction(db, rows[0]!.id);
      assert.equal((await importHistory(db))[0]!.remaining, 4);

      await revertImport(db, batchId);
      const [after] = await importHistory(db);
      assert.equal(after!.remaining, 0);
      assert.ok(after!.revertedAt, 'and records that it was undone');
    });

    test('the other half of a transfer is recognised, not imported again (FR-5)', async () => {
      const visa = await openAccount(db, {
        name: 'Visa',
        kind: 'credit_card',
        externalAccountId: '7654321',
      });

      // The chequing statement's payment row, marked as a transfer to the card.
      const { convertToTransfer } = await import('../transactions/manage.ts');
      const payment = await recordTransaction(db, {
        accountId,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
        externalIds: [{ kind: 'fitid', value: 'CHQ-1' }],
      });
      await convertToTransfer(db, payment, { toAccountId: visa });

      // Now the card's own statement arrives, wording it differently and posting
      // it two days later.
      const statement: OfxStatement = {
        ...bankStatement(),
        accountId: '7654321',
        transactions: [
          {
            fitId: 'VISA-1',
            posted: '2026-09-12',
            amountCents: 50000,
            name: 'PAYMENT - THANK YOU',
            type: 'CREDIT',
            warnings: [],
          },
        ],
      };

      const preview = await previewImport(db, statement, visa, { categorize: false });
      assert.equal(preview.rows[0]!.verdict, 'transfer_half');
      assert.match(preview.rows[0]!.reason, /other side of the transfer/);
      assert.equal(preview.counts.new, 0);

      const before = (await db.select().from(transactions)).length;
      await commitImport(db, preview, new Map());
      assert.equal(
        (await db.select().from(transactions)).length,
        before,
        'linked to the half already here rather than recorded twice',
      );

      // The card's id is now on that half, so re-importing recognises it outright.
      const again = await previewImport(db, statement, visa, { categorize: false });
      assert.equal(again.rows[0]!.verdict, 'duplicate');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a transfer half is claimed once, so two payments do not collapse into one', async () => {
      const visa = await openAccount(db, {
        name: 'Visa',
        kind: 'credit_card',
        externalAccountId: '7654321',
      });
      const { convertToTransfer } = await import('../transactions/manage.ts');

      for (const fitId of ['CHQ-1', 'CHQ-2']) {
        const payment = await recordTransaction(db, {
          accountId,
          date: '2026-09-10',
          amountCents: -50000,
          payeeRaw: 'Tfr-to C C',
          externalIds: [{ kind: 'fitid', value: fitId }],
        });
        await convertToTransfer(db, payment, { toAccountId: visa });
      }

      const statement: OfxStatement = {
        ...bankStatement(),
        accountId: '7654321',
        transactions: [
          { fitId: 'VISA-1', posted: '2026-09-10', amountCents: 50000, name: 'PAYMENT', type: 'CREDIT', warnings: [] },
          { fitId: 'VISA-2', posted: '2026-09-10', amountCents: 50000, name: 'PAYMENT', type: 'CREDIT', warnings: [] },
        ],
      };

      const preview = await previewImport(db, statement, visa, { categorize: false });
      assert.deepEqual(
        preview.rows.map((row) => row.verdict),
        ['transfer_half', 'transfer_half'],
      );
      assert.notEqual(
        preview.rows[0]!.existingId,
        preview.rows[1]!.existingId,
        'each payment matched a different half',
      );
    });

    test('an ordinary purchase is not mistaken for a transfer half', async () => {
      const visa = await openAccount(db, {
        name: 'Visa',
        kind: 'credit_card',
        externalAccountId: '7654321',
      });
      const { convertToTransfer } = await import('../transactions/manage.ts');
      const payment = await recordTransaction(db, {
        accountId,
        date: '2026-09-10',
        amountCents: -50000,
        payeeRaw: 'Tfr-to C C',
      });
      await convertToTransfer(db, payment, { toAccountId: visa });

      const statement: OfxStatement = {
        ...bankStatement(),
        accountId: '7654321',
        transactions: [
          // Same amount, but a month later and money out rather than in.
          { fitId: 'VISA-9', posted: '2026-10-12', amountCents: -50000, name: 'BIG PURCHASE', type: 'DEBIT', warnings: [] },
        ],
      };

      const preview = await previewImport(db, statement, visa, { categorize: false });
      assert.equal(preview.rows[0]!.verdict, 'new');
    });

    test('a standing rule imports a payee as a transfer, with no envelope (CA-2, FR-5)', async () => {
      const visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
      const { createTransferRule } = await import('../rules/rules.ts');
      await createTransferRule(db, {
        contains: 'TFR-TO C C',
        transferAccountId: visa,
        accountId,
      });

      const statement: OfxStatement = {
        ...bankStatement(),
        transactions: [
          {
            fitId: 'CHQ-9',
            posted: '2026-09-10',
            amountCents: -50000,
            name: 'Tfr-to C C 0000123456',
            type: 'DEBIT',
            warnings: [],
          },
        ],
      };

      const preview = await previewImport(db, statement, accountId);
      assert.equal(preview.rows[0]!.verdict, 'new');
      assert.equal(preview.rows[0]!.transferTo?.accountId, visa);
      assert.match(preview.rows[0]!.reason, /Your rule/);
      assert.equal(preview.rows[0]!.suggestion, undefined, 'a transfer is not categorized');

      await commitImport(db, preview, acceptAll);

      // Both halves, no envelope, nothing waiting in the queue.
      const written = await db.select().from(transactions);
      assert.equal(written.length, 2);
      assert.ok(written.every((row) => row.kind === 'account_transfer'));
      assert.ok(written.every((row) => row.status === 'confirmed'));
      assert.equal(written[0]!.transferPairId, written[1]!.transferPairId);

      const balances = await accountBalances(db);
      assert.equal(balances.find((row) => row.accountId === accountId)!.balanceCents, -50000);
      assert.equal(balances.find((row) => row.accountId === visa)!.balanceCents, 50000);
      assert.ok((await checkInvariant(db)).ok);

      // Re-importing the same statement recognises it by the bank's id.
      const again = await previewImport(db, statement, accountId, { categorize: false });
      assert.equal(again.rows[0]!.verdict, 'duplicate');
    });

    test('a rule for one account does not fire on a statement from another', async () => {
      const visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
      const savings = await openAccount(db, {
        name: 'Savings',
        kind: 'savings',
        externalAccountId: '9999999',
      });
      const { createTransferRule } = await import('../rules/rules.ts');
      await createTransferRule(db, {
        contains: 'TFR-TO C C',
        transferAccountId: visa,
        accountId,
      });

      const statement: OfxStatement = {
        ...bankStatement(),
        accountId: '9999999',
        transactions: [
          {
            fitId: 'SAV-1',
            posted: '2026-09-10',
            amountCents: -50000,
            name: 'Tfr-to C C',
            type: 'DEBIT',
            warnings: [],
          },
        ],
      };

      const preview = await previewImport(db, statement, savings, { categorize: false });
      assert.equal(preview.rows[0]!.transferTo, undefined, 'the rule is scoped to chequing');
    });

    test('history from earlier imports drives the suggestions', async () => {
      // Confirmed history for this merchant...
      for (const date of ['2025-06-03', '2025-07-03', '2025-08-03']) {
        await recordTransaction(db, {
          accountId,
          date,
          amountCents: -4400,
          payeeRaw: 'SHELL #2280',
          source: 'manual',
          status: 'confirmed',
          lines: [{ envelopeId: env.gasId, amountCents: -4400 }],
        });
      }

      const preview = await previewImport(db, bankStatement(), accountId, { useAi: false });
      const shell = preview.rows.find((row) => row.transaction.name.startsWith('SHELL'))!;

      assert.equal(shell.suggestion?.envelope, env.gasId, 'normalization matched the merchant');
      assert.equal(shell.suggestion?.layer, 'history');
      assert.ok(shell.suggestion!.confidence > 0.8);

      await commitImport(db, preview, acceptAll);

      // RQ-4: the suggested envelope is applied at once, but stays unconfirmed.
      // Selected by source, since the seeded history shares the payee key.
      const rows = await db.select().from(transactions);
      const imported = rows.filter((row) => row.source === 'file_import' && row.payeeKey === 'SHELL');
      assert.equal(imported.length, 1);
      assert.equal(imported[0]!.status, 'pending_review');
      assert.ok((await checkInvariant(db)).ok);
    });
  },
);
