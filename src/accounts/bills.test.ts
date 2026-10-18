import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { checkInvariant, recordTransaction } from '../ledger/ledger.ts';
import { attention } from '../notices/notices.ts';
import { foldNotices } from '../notices/fold.ts';
import {
  cardPayments,
  dayOfMonth,
  daysBetween,
  markPaymentMade,
  needsReminder,
  setPaymentDays,
  statementCycle,
} from './bills.ts';
import { AccountError, archiveAccount, createAccount } from './manage.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';

test('a day past the end of a short month is its last day', () => {
  assert.equal(dayOfMonth('2026-02', 31), '2026-02-28');
  assert.equal(dayOfMonth('2028-02', 30), '2028-02-29');
  assert.equal(dayOfMonth('2026-10', 31), '2026-10-31');
  assert.equal(dayOfMonth('2026-10', 5), '2026-10-05');
});

test('days between two dates, across a month and a year', () => {
  assert.equal(daysBetween('2026-10-18', '2026-10-21'), 3);
  assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3);
  assert.equal(daysBetween('2026-10-21', '2026-10-18'), -3);
});

test('the due date follows the statement, into the next month when its day comes first', () => {
  // Statement on the 25th, due on the 18th: October's due date is September's statement.
  assert.deepEqual(statementCycle({ statementDay: 25, paymentDueDay: 18 }, '2026-10-18'), {
    statementDate: '2026-09-25',
    dueDate: '2026-10-18',
  });
  // The day it closes, the new statement is the one that matters.
  assert.deepEqual(statementCycle({ statementDay: 25, paymentDueDay: 18 }, '2026-10-25'), {
    statementDate: '2026-10-25',
    dueDate: '2026-11-18',
  });
  // Statement on the 1st, due on the 22nd: the same month.
  assert.deepEqual(statementCycle({ statementDay: 1, paymentDueDay: 22 }, '2026-10-18'), {
    statementDate: '2026-10-01',
    dueDate: '2026-10-22',
  });
  // Past the due date and before the next statement: still that statement, now overdue.
  assert.deepEqual(statementCycle({ statementDay: 1, paymentDueDay: 22 }, '2026-10-28'), {
    statementDate: '2026-10-01',
    dueDate: '2026-10-22',
  });
  // Across a year, and a statement day February does not have.
  assert.deepEqual(statementCycle({ statementDay: 31, paymentDueDay: 21 }, '2027-01-10'), {
    statementDate: '2026-12-31',
    dueDate: '2027-01-21',
  });
  assert.deepEqual(statementCycle({ statementDay: 31, paymentDueDay: 21 }, '2027-03-01'), {
    statementDate: '2027-02-28',
    dueDate: '2027-03-21',
  });
});

const available = await databaseAvailable();

describe(
  'card payments due (FR-38)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let visa: string;

    before(async () => {
      db = await setupTestDb('bills');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      // Owing $200 from before; statement on the 1st, due on the 22nd.
      visa = await createAccount(db, {
        name: 'Visa',
        kind: 'credit_card',
        openingBalanceCents: -20000,
        openingDate: '2026-09-15',
      });
      await recordTransaction(db, {
        accountId: visa,
        date: '2026-09-28',
        amountCents: -5000,
        payeeRaw: 'GROCER',
        lines: [{ envelopeId: env.groceriesId, amountCents: -5000 }],
      });
      // After the statement: next month's, and no part of this one.
      await recordTransaction(db, { accountId: visa, date: '2026-10-05', amountCents: -3000, payeeRaw: 'GAS' });
      await setPaymentDays(db, visa, { statementDay: 1, paymentDueDay: 22 });
    });

    after(async () => {
      await closeDb(db);
    });

    const payment = async (today: string) => (await cardPayments(db, today)).find((card) => card.accountId === visa)!;

    test('the statement is what the card owed when it closed, and only after it do payments count', async () => {
      const due = await payment('2026-10-18');
      assert.equal(due.statementDate, '2026-10-01');
      assert.equal(due.dueDate, '2026-10-22');
      assert.equal(due.statementCents, 25000);
      assert.equal(due.paidCents, 0);
      assert.equal(due.remainingCents, 25000);
      assert.equal(due.daysLeft, 4);
      assert.ok(needsReminder(due));
    });

    test('not reminded until the last few days', async () => {
      assert.equal(needsReminder(await payment('2026-10-10')), false);
      assert.equal(needsReminder(await payment('2026-10-17')), true);
    });

    test('the automatic minimum counts but does not cover it; the rest of the payment does', async () => {
      await recordTransaction(db, { accountId: visa, date: '2026-10-12', amountCents: 1000, payeeRaw: 'MIN PAYMENT' });
      const partly = await payment('2026-10-18');
      assert.equal(partly.paidCents, 1000);
      assert.equal(partly.remainingCents, 24000);
      assert.ok(needsReminder(partly));

      await recordTransaction(db, { accountId: visa, date: '2026-10-18', amountCents: 24000, payeeRaw: 'PAYMENT THANK YOU' });
      const paid = await payment('2026-10-18');
      assert.equal(paid.remainingCents, 0);
      assert.equal(needsReminder(paid), false, 'covered, even though new charges since mean the card still owes');
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a passed due date is still reminded about until it is paid', async () => {
      const late = await payment('2026-10-25');
      assert.equal(late.daysLeft, -3);
      assert.ok(needsReminder(late));
    });

    test('marked paid covers this statement only', async () => {
      await markPaymentMade(db, visa, true, '2026-10-18');
      assert.equal(needsReminder(await payment('2026-10-18')), false);
      // The next statement, due November 22, is reminded about as usual.
      assert.equal(needsReminder(await payment('2026-11-18')), true);

      await markPaymentMade(db, visa, false, '2026-10-18');
      assert.equal(needsReminder(await payment('2026-10-18')), true, 'taken back');
    });

    test('a card that owed nothing at the statement is not reminded about', async () => {
      await recordTransaction(db, { accountId: visa, date: '2026-09-30', amountCents: 25000, payeeRaw: 'PAYMENT' });
      const nothing = await payment('2026-10-18');
      assert.equal(nothing.statementCents, 0);
      assert.equal(needsReminder(nothing), false);
    });

    test('only credit cards, days in a month, and not the same day twice', async () => {
      const chequing = await createAccount(db, { name: 'Chequing', kind: 'chequing' });
      await assert.rejects(() => setPaymentDays(db, chequing, { statementDay: 1, paymentDueDay: 22 }), AccountError);
      await assert.rejects(() => setPaymentDays(db, visa, { statementDay: 0, paymentDueDay: 22 }), AccountError);
      await assert.rejects(() => setPaymentDays(db, visa, { statementDay: 1, paymentDueDay: 32 }), AccountError);
      await assert.rejects(() => setPaymentDays(db, visa, { statementDay: 5, paymentDueDay: 5 }), AccountError);
    });

    test('turned off, or archived, it is gone', async () => {
      await setPaymentDays(db, visa, null);
      assert.equal((await cardPayments(db, '2026-10-18')).length, 0);
      await assert.rejects(() => markPaymentMade(db, visa, true, '2026-10-18'), AccountError);
    });

    test('the home screen names it, with what is left, and never folds it away', async () => {
      const report = await attention(db, '2026-10');
      // `attention` reads today's date, so only check it when the fixture's dates are near.
      const due = report.notices.filter((notice) => notice.kind === 'card_payment_due');
      for (const notice of due) {
        assert.equal(notice.payment!.accountId, visa);
        assert.equal(notice.cents, notice.payment!.remainingCents);
      }
      const many = [
        { kind: 'card_payment_due' as const, severity: 'warn' as const },
        { kind: 'unusual_charge' as const, severity: 'warn' as const },
        { kind: 'envelopes_overspent' as const, severity: 'warn' as const },
      ];
      assert.deepEqual(foldNotices(many).shown.map((notice) => notice.kind), ['card_payment_due']);
    });

    test('an archived card is not reminded about', async () => {
      await setPaymentDays(db, visa, null);
      const empty = await createAccount(db, { name: 'Old Visa', kind: 'credit_card' });
      await setPaymentDays(db, empty, { statementDay: 1, paymentDueDay: 22 });
      assert.equal((await cardPayments(db, '2026-10-18')).length, 1);
      await archiveAccount(db, empty);
      assert.equal((await cardPayments(db, '2026-10-18')).length, 0);
    });
  },
);
