import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { incomeArrived, newlyOverdrawn, newlyUnusual, sendSyncNotice, syncNotice, syncNotices } from './notice.ts';
import type { Insight } from '../insights/insights.ts';
import type { ManagedGroup } from '../envelopes/manage.ts';

const one = { manyLedgers: false };
const waiting = (count: number, overdrawn: string[] = []) => ({ waiting: count, overdrawn });

test('a run that brought nothing says nothing', () => {
  assert.equal(syncNotice([], new Map(), one), null);
  assert.equal(
    syncNotice([{ ledger: 'Home', bank: 'Vancity', added: 0, held: 0 }], new Map([['Home', waiting(12)]]), one),
    null,
    'not even with older rows still waiting: that is not news',
  );
});

test('new transactions, and how many are waiting for review', () => {
  const notice = syncNotice(
    [
      { ledger: 'Home', bank: 'Vancity', added: 7, held: 2 },
      { ledger: 'Home', bank: 'Amex', added: 3, held: 0 },
    ],
    new Map([['Home', waiting(12)]]),
    one,
  );
  assert.deepEqual(notice, {
    kind: 'sync',
    text: 'Vancity 7 new, 2 held for you to check; Amex 3 new. 12 to review.',
    priority: 'default',
  });
});

test('a bank that wants signing in again is the urgent one', () => {
  const notice = syncNotice(
    [
      { ledger: 'Home', bank: 'Vancity', added: 0, held: 0, error: 'ITEM_LOGIN_REQUIRED' },
      { ledger: 'Home', bank: 'Amex', added: 0, held: 0, error: 'INSTITUTION_DOWN' },
    ],
    new Map(),
    one,
  );
  assert.equal(notice?.priority, 'high');
  assert.deepEqual(notice?.text.split('\n'), [
    'Vancity wants you to sign in again. Nothing more comes in until you do.',
    'Amex could not be synced (INSTITUTION_DOWN). It tries again tomorrow.',
  ]);
});

test('with more than one ledger, each line says which', () => {
  const notice = syncNotice(
    [
      { ledger: 'Personal', bank: 'Vancity', added: 4, held: 0 },
      { ledger: 'Business', bank: 'Amex', added: 1, held: 0 },
    ],
    new Map([
      ['Personal', waiting(4)],
      ['Business', waiting(0)],
    ]),
    { manyLedgers: true },
  );
  assert.deepEqual(notice?.text.split('\n'), ['Personal: Vancity 4 new. 4 to review.', 'Business: Amex 1 new.']);
});

test('an envelope the sync took below zero is its own notice, named without its amount', () => {
  const notices = syncNotices(
    [{ ledger: 'Home', bank: 'Vancity', added: 3, held: 0 }],
    new Map([['Home', waiting(3, ['Groceries'])]]),
    one,
  );
  assert.deepEqual(notices, [
    { kind: 'sync', text: 'Vancity 3 new. 3 to review.', priority: 'default' },
    { kind: 'overspent', text: 'Groceries is now overdrawn.', priority: 'default' },
  ]);
});

test('several overdrawn envelopes are listed, and past three the rest are counted', () => {
  const line = (names: string[]) =>
    syncNotices(
      [{ ledger: 'Personal', bank: 'Vancity', added: 9, held: 0 }],
      new Map([['Personal', waiting(0, names)]]),
      { manyLedgers: true },
    ).find((notice) => notice.kind === 'overspent')?.text;
  assert.equal(line(['Dining', 'Groceries']), 'Personal: Dining and Groceries are now overdrawn.');
  assert.equal(line(['Dining', 'Fuel', 'Groceries']), 'Personal: Dining, Fuel and Groceries are now overdrawn.');
  assert.equal(
    line(['Clothing', 'Dining', 'Fuel', 'Gifts', 'Groceries']),
    'Personal: Clothing, Dining, Fuel and 2 more are now overdrawn.',
  );
});

const insight = (transactionId: string, kind: Insight['kind'] = 'charge_jumped'): Insight =>
  kind === 'charge_jumped'
    ? { kind, transactionId, payee: 'BC HYDRO', date: '2026-10-03', cents: 21000, usualCents: 9000, charges: 11 }
    : { kind, transactionId, payee: 'NEW PLACE', date: '2026-10-03', cents: 90000, thresholdCents: 40000 };

test('unusual charges are their own notice, saying what kind without the payee or amount', () => {
  const unusual = (found: Insight[]) =>
    syncNotices(
      [{ ledger: 'Home', bank: 'Vancity', added: 2, held: 0 }],
      new Map([['Home', { waiting: 2, overdrawn: [], unusual: found }]]),
      one,
    ).find((notice) => notice.kind === 'unusual')?.text;
  assert.equal(unusual([]), undefined);
  assert.equal(unusual([insight('a')]), 'A regular charge came in well above its usual.');
  assert.equal(unusual([insight('a', 'large_new_payee')]), 'A large first charge from a new payee.');
  assert.equal(
    unusual([insight('a'), insight('b'), insight('c', 'large_new_payee')]),
    '2 regular charges came in well above their usual, and a large first charge from a new payee.',
  );
  assert.doesNotMatch(unusual([insight('a'), insight('b', 'large_new_payee')])!, /HYDRO|NEW PLACE|\d{3}/);
});

test('only charges the sync brought in are news', () => {
  assert.deepEqual(
    newlyUnusual([insight('old')], [insight('new'), insight('old')]).map((found) => found.transactionId),
    ['new'],
  );
});

test('income the sync placed in Available is said with the rest of the sync', () => {
  const notice = syncNotice(
    [{ ledger: 'Home', bank: 'Vancity', added: 1, held: 0 }],
    new Map([['Home', { waiting: 0, overdrawn: [], income: true }]]),
    one,
  );
  assert.deepEqual(notice?.text.split('\n'), ['Vancity 1 new.', 'Income came in: Available has money to give to envelopes.']);
});

test('income has arrived when the pool grew and has something in it', () => {
  const pool = (balanceCents: number): ManagedGroup[] => [
    {
      id: 'g',
      name: 'Income',
      position: 0,
      archivedAt: null,
      envelopes: [
        { id: 'pool', name: 'Available', groupId: 'g', groupName: 'Income', position: 0, carryOver: true, isUnallocated: true, archivedAt: null, balanceCents },
      ],
    },
  ];
  assert.equal(incomeArrived(pool(0), pool(250000)), true);
  assert.equal(incomeArrived(pool(-500000), pool(-250000)), false, 'still overdrawn: nothing to give out');
  assert.equal(incomeArrived(pool(1000), pool(1000)), false);
  assert.equal(incomeArrived(pool(1000), pool(400)), false);
});

test('only envelopes that crossed zero count as newly overdrawn', () => {
  const envelope = (id: string, name: string, balanceCents: number, extra: object = {}) => ({
    id,
    name,
    groupId: 'g',
    groupName: 'Everyday',
    position: 0,
    carryOver: true,
    isUnallocated: false,
    archivedAt: null,
    balanceCents,
    ...extra,
  });
  const ledger = (...envelopes: ReturnType<typeof envelope>[]): ManagedGroup[] => [
    { id: 'g', name: 'Everyday', position: 0, archivedAt: null, envelopes },
  ];
  const before = ledger(
    envelope('groceries', 'Groceries', 5000),
    envelope('dining', 'Dining', -1200),
    envelope('fuel', 'Fuel', 0),
    envelope('gifts', 'Gifts', 800),
    envelope('pool', 'Available', 100, { isUnallocated: true }),
  );
  const after = ledger(
    envelope('groceries', 'Groceries', -340), // crossed: named
    envelope('dining', 'Dining', -4500), // already overdrawn: not news
    envelope('fuel', 'Fuel', -1), // from exactly zero: crossed
    envelope('gifts', 'Gifts', 0), // emptied, not overdrawn
    envelope('pool', 'Available', -900, { isUnallocated: true }), // the pool is not an envelope here
  );
  assert.deepEqual(newlyOverdrawn(before, after), ['Fuel', 'Groceries']);
});

test('ntfy gets the title, priority and the page a tap opens', async () => {
  const received: Record<string, string | undefined>[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ body, title: req.headers.title as string, priority: req.headers.priority as string, click: req.headers.click as string });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/topic`;
    await sendSyncNotice(url, { kind: 'sync', text: 'Vancity 1 new.', priority: 'high' }, 'https://manilla.example.ts.net');
    await sendSyncNotice(url, { kind: 'overspent', text: 'Fuel is now overdrawn.', priority: 'default' }, undefined);
    assert.deepEqual(received, [
      { body: 'Vancity 1 new.', title: 'Manilla bank sync', priority: 'high', click: 'https://manilla.example.ts.net/' },
      { body: 'Fuel is now overdrawn.', title: 'Manilla overspent envelopes', priority: 'default', click: undefined },
    ]);
  } finally {
    server.close();
  }
});

test('a notification service that is down costs the sync nothing', async () => {
  await sendSyncNotice('http://127.0.0.1:1/', { kind: 'sync', text: 'x', priority: 'default' }, undefined);
});
