import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryIndex } from './history.ts';
import { Categorizer, bandOf, matchRule, type Rule } from './pipeline.ts';
import type { AiCategorizer } from './ai.ts';
import type { LabeledTransaction, Suggestion, UnlabeledTransaction } from './types.ts';
import { NO_SUGGESTION } from './types.ts';

const txn = (
  date: string,
  payeeRaw: string,
  amountCents: number,
  envelope: string,
): LabeledTransaction => ({ date, payeeRaw, amountCents, envelope });

/** Stands in for the model so the pipeline can be tested without network or spend. */
function fakeAi(answers: Record<string, Suggestion>) {
  const calls: UnlabeledTransaction[][] = [];
  const stub = {
    calls,
    suggestBatch(transactions: UnlabeledTransaction[]) {
      calls.push(transactions);
      return Promise.resolve(
        transactions.map((t) => answers[t.payeeRaw] ?? NO_SUGGESTION),
      );
    },
  };
  return stub as unknown as AiCategorizer & { calls: UnlabeledTransaction[][] };
}

test('confidence bands', () => {
  assert.equal(bandOf(0.97), 'high');
  assert.equal(bandOf(0.95), 'high');
  // 0.85 is deliberately NOT auto-confirmable: measured precision there was
  // 79.5%, so bulk-confirming would introduce an error in roughly one in five.
  assert.equal(bandOf(0.85), 'medium');
  assert.equal(bandOf(0.7), 'medium');
  assert.equal(bandOf(0.49), 'low');
  assert.equal(bandOf(0), 'low');
});

test('rules match on payee, amount range and account', () => {
  const rules: Rule[] = [
    { id: '1', contains: 'SHELL', envelope: 'Gas' },
    { id: '2', contains: 'CO-OP', envelope: 'Snacks', maxCents: 2000 },
    { id: '3', contains: 'ETRANSFER', envelope: 'Allowance', account: 'chequing' },
  ];

  assert.equal(matchRule(rules, { date: '2025-09-01', payeeRaw: 'SHELL #4471', amountCents: -6200 })?.envelope, 'Gas');
  assert.equal(matchRule(rules, { date: '2025-09-01', payeeRaw: 'CALGARY CO-OP', amountCents: -1500 })?.envelope, 'Snacks');
  assert.equal(matchRule(rules, { date: '2025-09-01', payeeRaw: 'CALGARY CO-OP', amountCents: -9000 }), undefined, 'over the ceiling');
  assert.equal(matchRule(rules, { date: '2025-09-01', payeeRaw: 'ETRANSFER', amountCents: -5000, account: 'savings' }), undefined, 'wrong account');
});

test('a rule wins outright and never reaches the AI', async () => {
  const ai = fakeAi({});
  const categorizer = new Categorizer(
    [{ id: '1', contains: 'SHELL', envelope: 'Gas' }],
    new HistoryIndex([]),
    ai,
  );

  const [suggestion] = await categorizer.suggestAll([
    { date: '2025-09-01', payeeRaw: 'SHELL #4471', amountCents: -6200 },
  ]);

  assert.equal(suggestion!.envelope, 'Gas');
  assert.equal(suggestion!.layer, 'rule');
  assert.equal(suggestion!.confidence, 1);
  assert.equal(ai.calls.length, 0, 'the model was not called');
});

test('confident history short-circuits the AI', async () => {
  const ai = fakeAi({});
  const history = new HistoryIndex([
    txn('2025-06-01', 'SHELL #4471', -6200, 'Gas'),
    txn('2025-07-01', 'SHELL #2280', -5800, 'Gas'),
    txn('2025-08-01', 'SHELL #9910', -6400, 'Gas'),
  ]);

  const [suggestion] = await new Categorizer([], history, ai).suggestAll([
    { date: '2025-09-01', payeeRaw: 'SHELL #1122', amountCents: -6100 },
  ]);

  assert.equal(suggestion!.layer, 'history');
  assert.equal(ai.calls.length, 0, 'no spend on a merchant we already know');
});

test('an unknown merchant falls through to the AI', async () => {
  const ai = fakeAi({
    'BLUE DOOR COFFEE': { envelope: 'Dining', confidence: 0.8, layer: 'ai', reason: 'a coffee shop', alternatives: [] },
  });

  const [suggestion] = await new Categorizer([], new HistoryIndex([]), ai).suggestAll([
    { date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -540 },
  ]);

  assert.equal(suggestion!.envelope, 'Dining');
  assert.equal(suggestion!.layer, 'ai');
  assert.equal(ai.calls.length, 1);
});

test('without an AI layer the pipeline still works', async () => {
  const [suggestion] = await new Categorizer([], new HistoryIndex([])).suggestAll([
    { date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -540 },
  ]);

  assert.equal(suggestion!.envelope, null, 'degrades to uncategorized, not to a crash');
  assert.equal(suggestion!.layer, 'none');
});

test('weak history is kept when the model is weaker still', async () => {
  const ai = fakeAi({
    'BLUE DOOR COFFEE': { envelope: 'Gifts', confidence: 0.2, layer: 'ai', reason: 'a guess', alternatives: [] },
  });
  const history = new HistoryIndex([txn('2025-08-01', 'BLUE DOOR COFFEE', -540, 'Dining')]);

  const [suggestion] = await new Categorizer([], history, ai).suggestAll([
    { date: '2025-09-01', payeeRaw: 'BLUE DOOR COFFEE', amountCents: -560 },
  ]);

  assert.equal(suggestion!.envelope, 'Dining');
  assert.equal(suggestion!.layer, 'history');
});
