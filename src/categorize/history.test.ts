import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryIndex } from './history.ts';
import { bandOf } from './pipeline.ts';
import type { LabeledTransaction } from './types.ts';

const txn = (
  date: string,
  payeeRaw: string,
  amountCents: number,
  envelope: string,
): LabeledTransaction => ({ date, payeeRaw, amountCents, envelope });

test('a repeated merchant is suggested with high confidence', () => {
  const index = new HistoryIndex([
    txn('2025-06-01', 'SHELL #4471 CALGARY AB', -6200, 'Gas'),
    txn('2025-07-01', 'SHELL #2280', -5800, 'Gas'),
    txn('2025-08-01', 'SHELL #4471', -6400, 'Gas'),
  ]);

  const suggestion = index.suggest({ date: '2025-09-01', payeeRaw: 'SHELL #9910 AIRDRIE AB', amountCents: -6100 });
  assert.equal(suggestion.envelope, 'Gas');
  assert.equal(suggestion.layer, 'history');
  assert.ok(suggestion.confidence > 0.85, `expected high confidence, got ${suggestion.confidence}`);
  assert.match(suggestion.reason, /3 of 3/);
});

test('an unseen merchant yields no suggestion', () => {
  const index = new HistoryIndex([txn('2025-06-01', 'SHELL #4471', -6200, 'Gas')]);
  assert.equal(index.suggest({ date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -540 }).envelope, null);
});

test('a single sighting is a hint, not a conclusion', () => {
  const index = new HistoryIndex([txn('2025-08-01', 'BLUE DOOR COFFEE', -540, 'Dining')]);
  const suggestion = index.suggest({ date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -560 });

  // Worth showing as a suggestion, but it must not clear the auto-confirm bar.
  assert.equal(suggestion.envelope, 'Dining');
  assert.equal(bandOf(suggestion.confidence), 'medium', `got ${suggestion.confidence}`);
});

test('confidence grows with consistent repetition', () => {
  // The months immediately before the query date: decay is tested separately.
  const months = ['2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01'];
  const seen = (count: number) => {
    const history = months.slice(-count).map((date) => txn(date, 'BLUE DOOR COFFEE', -540, 'Dining'));
    return new HistoryIndex(history).suggest({
      date: '2025-09-01',
      payeeRaw: 'BLUE DOOR COFFEE',
      amountCents: -540,
    }).confidence;
  };

  assert.ok(seen(1) < seen(2) && seen(2) < seen(4), 'more evidence, more confidence');
  assert.equal(bandOf(seen(1)), 'medium', 'one sighting is only a suggestion');
  assert.equal(bandOf(seen(6)), 'high', 'six consistent recent sightings are auto-confirmable');
});

test('recent decisions outweigh old ones', () => {
  const index = new HistoryIndex([
    txn('2023-01-01', 'CALGARY CO-OP', -8000, 'Groceries'),
    txn('2023-02-01', 'CALGARY CO-OP', -8200, 'Groceries'),
    txn('2025-08-01', 'CALGARY CO-OP', -4000, 'Household'),
    txn('2025-08-20', 'CALGARY CO-OP', -4200, 'Household'),
  ]);

  const suggestion = index.suggest({ date: '2025-09-01', payeeRaw: 'CALGARY CO-OP', amountCents: -4100 });
  assert.equal(suggestion.envelope, 'Household', 'the recent pattern wins');
  assert.equal(suggestion.alternatives[0]?.envelope, 'Groceries', 'the old one is still offered');
});

test('the amount signal separates two envelopes at one merchant', () => {
  // Same store, two habits: a tank of fuel and a bag of snacks.
  const history = [
    txn('2025-07-01', 'PETRO-CANADA 12345', -6500, 'Gas'),
    txn('2025-07-15', 'PETRO-CANADA 12345', -6800, 'Gas'),
    txn('2025-08-01', 'PETRO-CANADA 12345', -700, 'Snacks'),
    txn('2025-08-10', 'PETRO-CANADA 12345', -650, 'Snacks'),
  ];
  const index = new HistoryIndex(history);

  const tank = index.suggest({ date: '2025-09-01', payeeRaw: 'PETRO-CANADA 999', amountCents: -6600 });
  const snack = index.suggest({ date: '2025-09-01', payeeRaw: 'PETRO-CANADA 999', amountCents: -680 });

  assert.equal(tank.envelope, 'Gas');
  assert.equal(snack.envelope, 'Snacks');
});

test('the index never learns from the future', () => {
  const index = new HistoryIndex([
    txn('2025-06-01', 'BLUE DOOR COFFEE', -540, 'Dining'),
    txn('2025-12-01', 'BLUE DOOR COFFEE', -540, 'Gifts'),
  ]);

  const suggestion = index.suggest({ date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -540 });
  assert.equal(suggestion.envelope, 'Dining');
  assert.match(suggestion.reason, /1 of 1/, 'the December transaction is invisible on 1 September');
});

test('envelopes() lists what the AI layer may choose from', () => {
  const index = new HistoryIndex([
    txn('2025-06-01', 'SHELL', -6200, 'Gas'),
    txn('2025-06-02', 'SAFEWAY', -9000, 'Groceries'),
    txn('2025-06-03', 'SHELL', -6000, 'Gas'),
  ]);
  assert.deepEqual(index.envelopes(), ['Gas', 'Groceries']);
  assert.equal(index.timesSeen('SHELL #4471 CALGARY AB'), 2);
});
