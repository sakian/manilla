import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardPayment } from '../accounts/bills.ts';
import { billsToTell, checkForBills, EARLIEST_HOUR } from './bills.ts';
import type { Database } from '../../db/client.ts';

const visa = (daysLeft: number, overrides: Partial<CardPayment> = {}): CardPayment => ({
  accountId: 'a1',
  name: 'Visa',
  statementDate: '2026-10-01',
  dueDate: '2026-10-22',
  statementCents: 25000,
  paidCents: 0,
  remainingCents: 25000,
  daysLeft,
  markedPaid: false,
  ...overrides,
});

const home = (payment: CardPayment) => [{ key: 'manilla', name: 'Household', payments: [payment] }];

test('nothing due, nothing said', () => {
  assert.deepEqual(billsToTell({}, home(visa(10)), '2026-10-12'), { text: null, told: {} });
});

test('each step towards the due date is said once, and never what is owed', () => {
  const soon = billsToTell({}, home(visa(5)), '2026-10-17');
  assert.equal(soon.text, 'Visa is due Oct 22, in 5 days.');
  assert.doesNotMatch(soon.text!, /\$|250/);

  assert.equal(billsToTell(soon.told, home(visa(4)), '2026-10-18').text, null, 'not every hour, or every day');

  const tomorrow = billsToTell(soon.told, home(visa(1)), '2026-10-21');
  assert.equal(tomorrow.text, "Visa is due tomorrow and the statement isn't paid yet.");
  assert.equal(billsToTell(tomorrow.told, home(visa(0)), '2026-10-22').text, null, 'the day itself was the step before');

  const late = billsToTell(tomorrow.told, home(visa(-1)), '2026-10-23');
  assert.equal(late.text, "Visa was due Oct 22 and the statement isn't paid yet.");
  assert.equal(billsToTell(late.told, home(visa(-2)), '2026-10-24').text, null);
});

test('set up late, it says the step it is at, not every one before', () => {
  const said = billsToTell({}, home(visa(1)), '2026-10-21');
  assert.equal(said.text, "Visa is due tomorrow and the statement isn't paid yet.");
});

test('paid, or marked paid, is not said', () => {
  assert.equal(billsToTell({}, home(visa(3, { remainingCents: 0, paidCents: 25000 })), '2026-10-19').text, null);
  assert.equal(billsToTell({}, home(visa(3, { markedPaid: true })), '2026-10-19').text, null);
});

test('the next statement is news again, and old ones are let go', () => {
  const october = billsToTell({}, home(visa(5)), '2026-10-17');
  const november = billsToTell(october.told, home(visa(5, { statementDate: '2026-11-01', dueDate: '2026-11-22' })), '2026-11-17');
  assert.equal(november.text, 'Visa is due Nov 22, in 5 days.');
  assert.deepEqual(Object.keys(november.told).sort(), ['manilla:a1:2026-10-22', 'manilla:a1:2026-11-22']);

  const later = billsToTell(november.told, [], '2026-12-15');
  assert.deepEqual(Object.keys(later.told), ['manilla:a1:2026-11-22'], 'October is forgotten after forty days');
});

test('with more than one ledger, it says which', () => {
  const said = billsToTell(
    {},
    [
      { key: 'manilla', name: 'Household', payments: [] },
      { key: 'manilla_ledger_business', name: 'Business', payments: [visa(5)] },
    ],
    '2026-10-17',
  );
  assert.equal(said.text, 'Business: Visa is due Oct 22, in 5 days.');
});

test('nothing is looked at before morning', async () => {
  const early = new Date(2026, 9, 21, EARLIEST_HOUR - 1, 30);
  // A database that throws if touched: the hour alone decides.
  const untouchable = new Proxy({}, { get: () => { throw new Error('touched'); } }) as Database;
  assert.equal(await checkForBills(untouchable, { homeDatabase: 'manilla', now: early }), null);
});
