import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { envelopeBalances, openAccount, recordTransaction } from '../ledger/ledger.ts';
import {
  BudgetError,
  budgetMonth,
  budgetWarnings,
  fundEnvelopes,
  getExpectedIncome,
  incomeReceived,
  monthAllocations,
  planFunding,
  reverseAllocation,
  reverseMonthFunding,
  setExpectedIncome,
  setPlanned,
  suggestExpectedIncome,
} from './budget.ts';
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
  'budget and allocation',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('budget');
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
      const all = await envelopeBalances(db);
      return all.find((row) => row.envelopeId === envelopeId)!.balanceCents;
    };

    /** Money arriving: an income transaction landing in the pool (FR-28). */
    const receiveIncome = async (cents: number, date = '2026-09-01') =>
      recordTransaction(db, {
        accountId,
        date,
        amountCents: cents,
        payeeRaw: 'PAYROLL DEPOSIT',
        status: 'confirmed',
        lines: [{ envelopeId: env.unallocatedId, amountCents: cents }],
      });

    const spend = async (envelopeId: string, cents: number, date = '2026-09-10') =>
      recordTransaction(db, {
        accountId,
        date,
        amountCents: -cents,
        payeeRaw: 'SHELL 4471',
        status: 'confirmed',
        lines: [{ envelopeId, amountCents: -cents }],
      });

    // -- the plan -----------------------------------------------------------

    test('a default plan applies to every month', async () => {
      await setPlanned(db, env.gasId, 20000);

      for (const month of ['2026-09', '2026-10', '2027-03']) {
        const budget = await budgetMonth(db, month, { today: '2026-09-19' });
        const gas = budget.rows.find((row) => row.envelopeId === env.gasId)!;
        assert.equal(gas.plannedCents, 20000, `${month} inherits the default`);
        assert.equal(gas.plannedIsOverride, false);
      }
    });

    test('a month override replaces the default for that month alone (FR-32)', async () => {
      await setPlanned(db, env.gasId, 20000);
      await setPlanned(db, env.gasId, 35000, { month: '2026-12' });

      const december = await budgetMonth(db, '2026-12', { today: '2026-09-19' });
      const gasInDecember = december.rows.find((row) => row.envelopeId === env.gasId)!;
      assert.equal(gasInDecember.plannedCents, 35000);
      assert.equal(gasInDecember.plannedIsOverride, true);
      assert.equal(gasInDecember.defaultPlannedCents, 20000, 'the default is still visible');

      const january = await budgetMonth(db, '2027-01', { today: '2026-09-19' });
      assert.equal(january.rows.find((row) => row.envelopeId === env.gasId)!.plannedCents, 20000);
    });

    test('clearing a default removes the row rather than storing zero', async () => {
      await setPlanned(db, env.gasId, 20000);
      await setPlanned(db, env.gasId, 0);
      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(budget.rows.find((row) => row.envelopeId === env.gasId)!.plannedCents, 0);
      assert.equal(budget.plannedTotalCents, 0);
    });

    test('the income pool cannot be budgeted for', async () => {
      await assert.rejects(() => setPlanned(db, env.unallocatedId, 100000), BudgetError);
    });

    test('a fractional or negative plan is refused', async () => {
      await assert.rejects(() => setPlanned(db, env.gasId, 100.5), BudgetError);
      await assert.rejects(() => setPlanned(db, env.gasId, -1), BudgetError);
    });

    // -- reading the month --------------------------------------------------

    test('the month shows balance, spending and allocation side by side', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 20000 }], {
        today: '2026-09-19',
      });
      await spend(env.gasId, 6550);

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      const gas = budget.rows.find((row) => row.envelopeId === env.gasId)!;

      assert.equal(gas.plannedCents, 20000);
      assert.equal(gas.allocatedCents, 20000);
      assert.equal(gas.spentCents, 6550, 'spending is reported as a positive number');
      assert.equal(gas.balanceCents, 13450);
      assert.equal(budget.unallocated.balanceCents, 380000);
    });

    test('spending in another month does not count against this one', async () => {
      await receiveIncome(400000);
      await spend(env.gasId, 5000, '2026-08-20');
      await spend(env.gasId, 7000, '2026-09-05');

      const september = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(september.rows.find((row) => row.envelopeId === env.gasId)!.spentCents, 7000);

      const august = await budgetMonth(db, '2026-08', { today: '2026-09-19' });
      assert.equal(august.rows.find((row) => row.envelopeId === env.gasId)!.spentCents, 5000);
    });

    test('a refund reduces the month spending rather than adding to it', async () => {
      await spend(env.groceriesId, 12000, '2026-09-04');
      await recordTransaction(db, {
        accountId,
        date: '2026-09-08',
        amountCents: 2500,
        payeeRaw: 'ZEHRS REFUND',
        status: 'confirmed',
        lines: [{ envelopeId: env.groceriesId, amountCents: 2500 }],
      });

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(budget.rows.find((row) => row.envelopeId === env.groceriesId)!.spentCents, 9500);
    });

    test('income arriving in the pool is not counted as the pool spending', async () => {
      await receiveIncome(400000);
      await spend(env.unallocatedId, 15000, '2026-09-12');

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(budget.incomeReceivedCents, 400000);
      assert.equal(
        budget.unallocated.spentCents,
        15000,
        'only what was actually spent straight out of the pool',
      );
    });

    test('an opening balance is neither income nor spending', async () => {
      await openAccount(db, {
        name: 'Savings',
        kind: 'savings',
        openingBalanceCents: 1000000,
        openingDate: '2026-09-01',
      });

      assert.equal(await incomeReceived(db, '2026-09'), 0);
      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(budget.incomeReceivedCents, 0);
      assert.equal(budget.unallocated.spentCents, 0);
      assert.equal(budget.unallocated.balanceCents, 1000000, 'but the money is there');
    });

    test('an account transfer is not income (FR-5)', async () => {
      await receiveIncome(250000);
      const second = await openAccount(db, { name: 'Savings', kind: 'savings' });
      const { recordAccountTransfer } = await import('../ledger/ledger.ts');
      await recordAccountTransfer(db, {
        fromAccountId: accountId,
        toAccountId: second,
        amountCents: 100000,
        date: '2026-09-15',
      });

      assert.equal(await incomeReceived(db, '2026-09'), 250000);
    });

    // -- funding ------------------------------------------------------------

    test('the funding preview proposes the plan and shows what it costs', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);
      await setPlanned(db, env.groceriesId, 90000);

      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });
      assert.equal(plan.lines.length, 2);
      assert.equal(plan.totalCents, 110000);
      assert.equal(plan.availableCents, 400000);
      assert.equal(plan.shortfallCents, 0);
      assert.ok(
        plan.lines.every((line) => line.proposedCents === line.plannedCents),
        'nothing funded yet, so the whole plan is proposed',
      );
    });

    test('an envelope with no plan is offered too, proposing nothing', async () => {
      await setPlanned(db, env.gasId, 20000);
      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });

      // Every envelope is fundable: "put whatever is left into Savings" is an
      // ordinary month and Savings has no monthly figure.
      assert.deepEqual(
        [...plan.lines.map((line) => line.envelopeId)].sort(),
        [env.gasId, env.groceriesId].sort(),
      );
      assert.ok(
        !plan.lines.some((line) => line.envelopeId === env.unallocatedId),
        'the pool is not funded from itself',
      );

      const groceries = plan.lines.find((line) => line.envelopeId === env.groceriesId)!;
      assert.equal(groceries.plannedCents, 0);
      assert.equal(groceries.proposedCents, 0);

      // So the one-click default is unchanged by their presence.
      assert.equal(plan.totalCents, 20000);
      assert.equal(plan.proposingCount, 1);
    });

    test('an unplanned envelope can be funded by typing an amount into it', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);

      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });
      const applied = await fundEnvelopes(
        db,
        '2026-09',
        // Exactly what the dialog sends: every line, most of them zero.
        plan.lines.map((line) => ({
          envelopeId: line.envelopeId,
          amountCents: line.envelopeId === env.groceriesId ? 150000 : line.proposedCents,
        })),
        { today: '2026-09-19' },
      );

      assert.equal(applied.moves, 2, 'zero rows write nothing');
      assert.equal(applied.totalCents, 170000);
      assert.equal(await balanceOf(env.groceriesId), 150000);
      assert.equal(await balanceOf(env.gasId), 20000);
    });

    test('funding twice does not fill twice: the second run proposes the remainder', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);

      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 8000 }], {
        today: '2026-09-19',
      });

      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });
      const gas = plan.lines.find((line) => line.envelopeId === env.gasId)!;
      assert.equal(gas.alreadyAllocatedCents, 8000);
      assert.equal(gas.proposedCents, 12000, 'only the remainder of the plan');

      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 12000 }], {
        today: '2026-09-19',
      });

      const after = await planFunding(db, '2026-09', { today: '2026-09-19' });
      assert.equal(after.lines.find((line) => line.envelopeId === env.gasId)!.proposedCents, 0);
      assert.equal(await balanceOf(env.gasId), 20000, 'funded exactly once over two runs');
    });

    test('an envelope funded past its plan proposes nothing, never a clawback', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 30000 }], {
        today: '2026-09-19',
      });

      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });
      assert.equal(plan.lines.find((line) => line.envelopeId === env.gasId)!.proposedCents, 0);
    });

    test('funding moves money out of the pool and into each envelope', async () => {
      await receiveIncome(400000);
      const result = await fundEnvelopes(
        db,
        '2026-09',
        [
          { envelopeId: env.gasId, amountCents: 20000 },
          { envelopeId: env.groceriesId, amountCents: 90000 },
        ],
        { today: '2026-09-19' },
      );

      assert.equal(result.moves, 2);
      assert.equal(result.totalCents, 110000);
      assert.equal(result.date, '2026-09-19');
      assert.equal(result.availableCents, 290000);
      assert.equal(await balanceOf(env.gasId), 20000);
      assert.equal(await balanceOf(env.groceriesId), 90000);
      assert.equal(await balanceOf(env.unallocatedId), 290000);
    });

    test('the amounts applied are the caller edited ones, not the plan (FR-29)', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);

      // The user trimmed the proposal in the preview before applying it.
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 15000 }], {
        today: '2026-09-19',
      });
      assert.equal(await balanceOf(env.gasId), 15000);
    });

    test('funding a past month is dated inside that month', async () => {
      await receiveIncome(400000, '2026-08-01');
      const result = await fundEnvelopes(
        db,
        '2026-08',
        [{ envelopeId: env.gasId, amountCents: 20000 }],
        { today: '2026-09-19' },
      );

      assert.equal(result.date, '2026-08-31');
      const august = await budgetMonth(db, '2026-08', { today: '2026-09-19' });
      assert.equal(august.rows.find((row) => row.envelopeId === env.gasId)!.allocatedCents, 20000);
      const september = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(september.rows.find((row) => row.envelopeId === env.gasId)!.allocatedCents, 0);
    });

    test('funding more than the pool holds is allowed and reported', async () => {
      await receiveIncome(50000);
      const result = await fundEnvelopes(
        db,
        '2026-09',
        [{ envelopeId: env.gasId, amountCents: 80000 }],
        { today: '2026-09-19' },
      );

      assert.equal(result.availableCents, -30000, 'the pool goes negative rather than refusing');

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.ok(
        budget.warnings.some((warning) => warning.kind === 'pool_overdrawn'),
        'and it is warned about',
      );
    });

    test('funding the pool from itself is refused', async () => {
      await assert.rejects(
        () =>
          fundEnvelopes(db, '2026-09', [{ envelopeId: env.unallocatedId, amountCents: 100 }], {
            today: '2026-09-19',
          }),
        BudgetError,
      );
    });

    test('funding an unknown envelope writes nothing at all', async () => {
      await receiveIncome(400000);
      await assert.rejects(
        () =>
          fundEnvelopes(
            db,
            '2026-09',
            [
              { envelopeId: env.gasId, amountCents: 20000 },
              { envelopeId: '00000000-0000-0000-0000-000000000000', amountCents: 5000 },
            ],
            { today: '2026-09-19' },
          ),
        BudgetError,
      );

      assert.equal(await balanceOf(env.gasId), 0, 'the good line was rolled back with the bad one');
      assert.equal(await balanceOf(env.unallocatedId), 400000);
    });

    // -- reversal (FR-30) ---------------------------------------------------

    test('an allocation is reversed by a contra entry, and the record survives', async () => {
      await receiveIncome(400000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 20000 }], {
        today: '2026-09-19',
      });

      const [allocation] = await monthAllocations(db, '2026-09');
      await reverseAllocation(db, allocation!.id);

      assert.equal(await balanceOf(env.gasId), 0);
      assert.equal(await balanceOf(env.unallocatedId), 400000);

      const records = await monthAllocations(db, '2026-09');
      assert.equal(records.length, 2, 'the original allocation is still on the record');
      assert.equal(records.filter((record) => record.isReversal).length, 1);
    });

    test('a reversed month shows no net allocation and can be re-funded', async () => {
      await receiveIncome(400000);
      await setPlanned(db, env.gasId, 20000);
      await setPlanned(db, env.groceriesId, 90000);
      await fundEnvelopes(
        db,
        '2026-09',
        [
          { envelopeId: env.gasId, amountCents: 20000 },
          { envelopeId: env.groceriesId, amountCents: 90000 },
        ],
        { today: '2026-09-19' },
      );

      const reversed = await reverseMonthFunding(db, '2026-09');
      assert.equal(reversed, 2);

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.equal(budget.allocatedTotalCents, 0);
      assert.equal(await balanceOf(env.unallocatedId), 400000);

      const plan = await planFunding(db, '2026-09', { today: '2026-09-19' });
      assert.equal(plan.totalCents, 110000, 'the whole plan is proposed again');
    });

    test('reversing a month twice does not send money back twice', async () => {
      await receiveIncome(400000);
      await fundEnvelopes(db, '2026-09', [{ envelopeId: env.gasId, amountCents: 20000 }], {
        today: '2026-09-19',
      });

      assert.equal(await reverseMonthFunding(db, '2026-09'), 1);
      assert.equal(await reverseMonthFunding(db, '2026-09'), 0, 'nothing left to reverse');
      assert.equal(await balanceOf(env.unallocatedId), 400000);
    });

    test('only an allocation is reversed here', async () => {
      const { moveBetweenEnvelopes } = await import('../ledger/ledger.ts');
      const moveId = await moveBetweenEnvelopes(db, {
        fromEnvelopeId: env.gasId,
        toEnvelopeId: env.groceriesId,
        amountCents: 1000,
        date: '2026-09-19',
        kind: 'transfer',
      });

      await assert.rejects(() => reverseAllocation(db, moveId), BudgetError);
    });

    // -- expected income (FR-27, FR-31) -------------------------------------

    test('expected income is stored, read back and clearable', async () => {
      assert.equal(await getExpectedIncome(db), null);
      await setExpectedIncome(db, 725000);
      assert.equal(await getExpectedIncome(db), 725000);
      await setExpectedIncome(db, 800000);
      assert.equal(await getExpectedIncome(db), 800000, 'setting it again overwrites');
      await setExpectedIncome(db, null);
      assert.equal(await getExpectedIncome(db), null);
    });

    test('expected income is suggested from complete months only', async () => {
      await receiveIncome(600000, '2026-06-01');
      await receiveIncome(700000, '2026-07-01');
      await receiveIncome(800000, '2026-08-01');
      // A partial current month, which must not drag the average down.
      await receiveIncome(100000, '2026-09-01');

      assert.equal(await suggestExpectedIncome(db, '2026-09', '2026-09-19'), 700000);
    });

    test('with no income history there is no suggestion to make', async () => {
      assert.equal(await suggestExpectedIncome(db, '2026-09', '2026-09-19'), null);
    });

    test('a plan beyond income is warned about, against expected income when set', () => {
      const warnings = budgetWarnings({
        plannedTotalCents: 800000,
        incomeReceivedCents: 100000,
        expectedIncomeCents: 725000,
        poolBalanceCents: 0,
      });

      const exceeded = warnings.find((warning) => warning.kind === 'planned_exceeds_income');
      assert.ok(exceeded);
      assert.equal(exceeded.basis, 'expected');
      assert.equal(exceeded.incomeCents, 725000);
    });

    test('without an expected figure the plan is measured against income received', () => {
      const warnings = budgetWarnings({
        plannedTotalCents: 800000,
        incomeReceivedCents: 900000,
        expectedIncomeCents: null,
        poolBalanceCents: 0,
      });

      assert.equal(
        warnings.filter((warning) => warning.kind === 'planned_exceeds_income').length,
        0,
        'more has arrived than is planned, so there is nothing to warn about',
      );
    });

test('the income average spans six complete months, not three', async () => {
      // Two-weekly pay: three cheques land in some months, two in others. A
      // three-month window would read whichever rhythm it happened to catch.
      await receiveIncome(600000, '2026-03-01');
      await receiveIncome(400000, '2026-04-01');
      await receiveIncome(600000, '2026-05-01');
      await receiveIncome(400000, '2026-06-01');
      await receiveIncome(600000, '2026-07-01');
      await receiveIncome(400000, '2026-08-01');

      assert.equal(await suggestExpectedIncome(db, '2026-09', '2026-09-19'), 500000);
    });

    test('a month with no income at all is left out rather than counted as zero', async () => {
      await receiveIncome(600000, '2026-07-01');
      await receiveIncome(800000, '2026-08-01');

      assert.equal(
        await suggestExpectedIncome(db, '2026-09', '2026-09-19'),
        700000,
        'the four earlier months had no income, so they are not evidence of a pay cut',
      );
    });

    test('with nothing stated the plan is measured against the measured average', () => {
      const warnings = budgetWarnings({
        plannedTotalCents: 800000,
        incomeReceivedCents: 100000,
        expectedIncomeCents: null,
        averageIncomeCents: 700000,
        poolBalanceCents: 0,
      });

      const exceeded = warnings.find((warning) => warning.kind === 'planned_exceeds_income');
      assert.ok(exceeded, 'the plan asks for more than six months of history says arrives');
      assert.equal(exceeded.basis, 'average');
      assert.equal(exceeded.incomeCents, 700000);
    });

    test('a stated figure still wins over the average', () => {
      const warnings = budgetWarnings({
        plannedTotalCents: 800000,
        incomeReceivedCents: 100000,
        expectedIncomeCents: 900000,
        averageIncomeCents: 700000,
        poolBalanceCents: 0,
      });

      assert.equal(
        warnings.filter((warning) => warning.kind === 'planned_exceeds_income').length,
        0,
        'they said to expect 9,000, and the plan is inside it',
      );
    });

    // -- what an envelope usually costs (#7) --------------------------------

    test('each row carries last month and a twelve-month average', async () => {
      await spend(env.gasId, 20000, '2026-08-14');
      await spend(env.gasId, 10000, '2026-08-28');
      await spend(env.gasId, 30000, '2026-02-03');
      // This month's own spending belongs to spentCents, not to the history.
      await spend(env.gasId, 5000, '2026-09-10');

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      const gas = budget.rows.find((row) => row.envelopeId === env.gasId)!;

      assert.equal(gas.spentCents, 5000, 'this month');
      assert.equal(gas.lastMonthSpentCents, 30000, 'August');
      assert.equal(
        gas.averageSpentCents,
        5000,
        '$600 across the twelve complete months before September, divided by twelve',
      );
    });

    test('spending older than a year is outside the average', async () => {
      await spend(env.gasId, 120000, '2025-08-20');
      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      const gas = budget.rows.find((row) => row.envelopeId === env.gasId)!;

      assert.equal(gas.lastMonthSpentCents, 0);
      assert.equal(gas.averageSpentCents, 0, 'September 2025 onwards is the window');
    });

    test('a refund in the window reduces the average rather than raising it', async () => {
      await spend(env.gasId, 24000, '2026-08-01');
      await recordTransaction(db, {
        accountId,
        date: '2026-08-15',
        amountCents: 12000,
        payeeRaw: 'SHELL 4471 REFUND',
        status: 'confirmed',
        lines: [{ envelopeId: env.gasId, amountCents: 12000 }],
      });

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      const gas = budget.rows.find((row) => row.envelopeId === env.gasId)!;

      assert.equal(gas.lastMonthSpentCents, 12000, 'net of the refund');
      assert.equal(gas.averageSpentCents, 1000);
    });

    test('income left in the pool is warned about (FR-31)', async () => {
      await receiveIncome(400000);
      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      const warning = budget.warnings.find((item) => item.kind === 'income_unallocated');
      assert.ok(warning);
      assert.equal(warning.cents, 400000);
    });

    test('a fully allocated month warns about nothing', async () => {
      await receiveIncome(110000);
      await setExpectedIncome(db, 110000);
      await setPlanned(db, env.gasId, 20000);
      await setPlanned(db, env.groceriesId, 90000);
      await fundEnvelopes(
        db,
        '2026-09',
        [
          { envelopeId: env.gasId, amountCents: 20000 },
          { envelopeId: env.groceriesId, amountCents: 90000 },
        ],
        { today: '2026-09-19' },
      );

      const budget = await budgetMonth(db, '2026-09', { today: '2026-09-19' });
      assert.deepEqual(budget.warnings, []);
    });
  },
);
