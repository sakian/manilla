import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from '../../db/client.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { archiveEnvelope } from '../envelopes/manage.ts';
import { AiCategorizer, costMilliCents } from '../categorize/ai.ts';
import {
  DEFAULT_MONTHLY_CALL_BUDGET,
  accuracy,
  aiSettings,
  aiUsage,
  cachedAnswers,
  clearAnswerCache,
  recordAiCall,
  rememberAnswers,
  setAiSettings,
} from './ai.ts';
import { loadExamples } from '../categorize/fromDb.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { suggestions } from '../../db/schema.ts';

/**
 * A stand-in for the SDK client. The suite makes no network calls and spends
 * nothing, which is the promise the README makes about `npm test`.
 */
function stubClient(
  reply: (system: string, user: string) => unknown,
  usage = { input_tokens: 500, cache_read_input_tokens: 400, output_tokens: 80 },
): { client: Anthropic; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];

  const client = {
    messages: {
      parse: async (request: {
        system: { text: string }[];
        messages: { content: string }[];
      }) => {
        const system = request.system[0]!.text;
        const user = request.messages[0]!.content;
        calls.push({ system, user });
        return { parsed_output: reply(system, user), usage };
      },
    },
  } as unknown as Anthropic;

  return { client, calls };
}

describe('what a call costs', () => {
  test('cached input is a tenth of the price, which is why the prompt is cached', () => {
    const cold = costMilliCents({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 });
    const warm = costMilliCents({ inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 });
    assert.equal(cold, 500, '1000 input tokens at $5/MTok is half a cent');
    assert.equal(warm, 50);
  });

  test('a realistic batch costs a fraction of a cent', () => {
    const cost = costMilliCents({
      inputTokens: 2000,
      cachedInputTokens: 1800,
      outputTokens: 400,
    });
    assert.ok(cost < 1500, `${cost} tenths of a cent is under 1.5 cents`);
  });
});

describe('asking the model', () => {
  const envelopes = [
    { id: 'env-gas', name: 'Gas' },
    { id: 'env-groceries', name: 'Groceries' },
  ];

  const transaction = (payeeRaw: string, amountCents = -4520) => ({
    date: '2026-09-19',
    payeeRaw,
    amountCents,
  });

  test('the model sees names and the ledger gets ids back', async () => {
    const { client, calls } = stubClient(() => ({
      results: [{ index: 0, envelope: 'Gas', confidence: 0.8, reason: 'a fuel station' }],
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    const [suggestion] = await ai.suggestBatch([transaction('PETRO CANADA 4471')]);

    assert.equal(suggestion!.envelope, 'env-gas', 'an id, which is what the ledger uses');
    assert.equal(suggestion!.layer, 'ai');
    assert.equal(suggestion!.reason, 'a fuel station');
    assert.match(calls[0]!.system, /- Gas/, 'and the prompt shows names, not ids');
    assert.equal(calls[0]!.system.includes('env-gas'), false);
  });

  test('only payee, amount and date are sent (NF-5)', async () => {
    const { client, calls } = stubClient(() => ({ results: [] }));
    const ai = new AiCategorizer(envelopes, {}, { client });

    await ai.suggestBatch([
      { date: '2026-09-19', payeeRaw: 'PETRO CANADA 4471', amountCents: -4520, account: 'secret-account-id' },
    ]);

    const sent = `${calls[0]!.system}\n${calls[0]!.user}`;
    // The readable form of the payee, which is what normalization produces.
    assert.match(sent, /Petro Canada/);
    assert.match(sent, /45\.20/);
    assert.match(sent, /2026-09-19/);
    assert.equal(sent.includes('secret-account-id'), false, 'no account identifier');
  });

  test('an envelope the model invented is refused (CA-8)', async () => {
    const { client } = stubClient(() => ({
      results: [{ index: 0, envelope: 'Holidays', confidence: 0.9, reason: 'sounds like a trip' }],
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    const [suggestion] = await ai.suggestBatch([transaction('SOMEWHERE NEW')]);

    assert.equal(suggestion!.envelope, null);
    assert.match(suggestion!.reason, /not an envelope/);
  });

  test('a confident answer is reused for that merchant, and costs one call', async () => {
    const { client, calls } = stubClient((_system, user) => ({
      results: user.split('\n').map((line) => ({
        index: Number(line.split('.')[0]),
        envelope: 'Gas',
        confidence: 0.92,
        reason: 'a fuel station',
      })),
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    await ai.suggestBatch([transaction('SHELL #4471 CALGARY AB')]);
    const [second] = await ai.suggestBatch([transaction('SHELL 2280')]);

    assert.equal(calls.length, 1, 'the second charge reused the confident answer');
    assert.equal(second!.envelope, 'env-gas');
    assert.equal(ai.fresh.size, 1);
  });

  test('an unsure answer is asked again, because the amount is doing the work', async () => {
    // The Amazon case from the Phase 0 findings: one merchant, many envelopes,
    // and only the amount tells them apart. Reusing one answer for all of them
    // measured about ten points worse than asking.
    const { client, calls } = stubClient((_system, user) => ({
      results: user.split('\n').map((line) => ({
        index: Number(line.split('.')[0]),
        envelope: 'Groceries',
        confidence: 0.35,
        reason: 'could be anything',
      })),
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    await ai.suggestBatch([transaction('AMZN Mktp CA', -3146)]);
    await ai.suggestBatch([transaction('AMZN Mktp CA', -12045)]);

    assert.equal(calls.length, 2, 'each charge got its own question');
    assert.equal(ai.fresh.size, 0, 'and nothing unsure was remembered');
  });

  test('several charges at one merchant are each asked about in the same call', async () => {
    const { client, calls } = stubClient((_system, user) => ({
      results: user.split('\n').map((line) => ({
        index: Number(line.split('.')[0]),
        envelope: 'Gas',
        confidence: 0.5,
        reason: 'maybe fuel',
      })),
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    const results = await ai.suggestBatch([
      transaction('SHELL #4471 CALGARY AB', -4520),
      transaction('SHELL 2280', -320),
      transaction('SHELL #1 TORONTO', -8800),
    ]);

    assert.equal(calls.length, 1, 'one call, because they batch');
    assert.equal(calls[0]!.user.split('\n').length, 3, 'but three questions in it');
    assert.equal(results.length, 3);
  });

  test('a seeded answer costs no call at all', async () => {
    const { client, calls } = stubClient(() => ({ results: [] }));
    const ai = new AiCategorizer(envelopes, {}, { client });

    ai.seed([
      [
        'SHELL',
        { envelope: 'env-gas', confidence: 0.9, layer: 'ai', reason: 'asked last month', alternatives: [] },
      ],
    ]);

    const [suggestion] = await ai.suggestBatch([transaction('SHELL #4471 CALGARY AB')]);
    assert.equal(calls.length, 0);
    assert.equal(suggestion!.envelope, 'env-gas');
  });

  test('a failed call stops the layer instead of failing the import (NF-10)', async () => {
    const records: unknown[] = [];
    const client = {
      messages: {
        parse: async () => {
          throw new Error('connection reset');
        },
      },
    } as unknown as Anthropic;

    const ai = new AiCategorizer(envelopes, {}, { client, onCall: (r) => void records.push(r) });
    const results = await ai.suggestBatch([transaction('ONE'), transaction('TWO')]);

    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.envelope === null), 'no suggestion, no throw');
    assert.match(ai.stopped ?? '', /connection reset/);
    assert.equal(records.length, 1, 'and the failure is recorded');
  });

  test('a failure is not remembered as an answer', async () => {
    const client = {
      messages: { parse: async () => { throw new Error('down'); } },
    } as unknown as Anthropic;

    const ai = new AiCategorizer(envelopes, {}, { client });
    await ai.suggestBatch([{ date: '2026-09-19', payeeRaw: 'SHELL', amountCents: -1000 }]);

    assert.equal(ai.fresh.size, 0, 'one bad minute must not become a permanent gap');
  });

  test('the budget is checked before a call, not after', async () => {
    const { client, calls } = stubClient(() => ({ results: [] }));
    const ai = new AiCategorizer(envelopes, {}, { client, canCall: () => false });

    const [suggestion] = await ai.suggestBatch([transaction('SOMEWHERE')]);
    assert.equal(calls.length, 0, 'nothing was spent');
    assert.match(suggestion!.reason, /budget/);
    assert.match(ai.stopped ?? '', /budget/);
  });

  test('usage adds up across batches, and the answers come back in order', async () => {
    // Two-letter suffixes, because normalization strips trailing numbers - which
    // is the point of it, and would otherwise make these one merchant.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const many = Array.from({ length: 30 }, (_, index) =>
      transaction(`SHOP ${letters[Math.floor(index / 26)]}${letters[index % 26]}`),
    );
    const { client, calls } = stubClient((_system, user) => ({
      results: user.split('\n').map((line) => ({
        index: Number(line.split('.')[0]),
        envelope: 'Gas',
        confidence: 0.6,
        reason: 'guess',
      })),
    }));

    const ai = new AiCategorizer(envelopes, {}, { client });
    const results = await ai.suggestBatch(many);

    assert.equal(calls.length, 2, '30 transactions across a batch size of 25');
    assert.equal(results.length, 30);
    assert.ok(results.every((result) => result.envelope === 'env-gas'));
    assert.equal(ai.usage.requests, 2);
    assert.equal(ai.usage.outputTokens, 160);
  });
});

const available = await databaseAvailable();

describe(
  'the AI layer in the app',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let accountId: string;

    before(async () => {
      db = await setupTestDb('ai');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    test('it is on by default, and the budget is what keeps it bounded', async () => {
      const settings = await aiSettings(db);
      assert.equal(settings.enabled, true);
      assert.equal(settings.monthlyCallBudget, DEFAULT_MONTHLY_CALL_BUDGET);
    });

    test('turning it off is remembered, so the default does not switch it back on', async () => {
      await setAiSettings(db, { enabled: false });
      assert.equal((await aiSettings(db)).enabled, false);
    });

    test('the switch and the budget are remembered', async () => {
      await setAiSettings(db, { enabled: true, monthlyCallBudget: 5 });
      const settings = await aiSettings(db);
      assert.equal(settings.enabled, true);
      assert.equal(settings.monthlyCallBudget, 5);

      await assert.rejects(() => setAiSettings(db, { monthlyCallBudget: -1 }));
    });

    test('usage counts calls and cost, and says what is left', async () => {
      await setAiSettings(db, { monthlyCallBudget: 10 });
      await recordAiCall(db, {
        model: 'claude-opus-5',
        transactions: 25,
        inputTokens: 2000,
        cachedInputTokens: 1800,
        outputTokens: 400,
        costMilliCents: 1110,
      }, '2026-09');

      const usage = await aiUsage(db, '2026-09');
      assert.equal(usage.calls, 1);
      assert.equal(usage.transactions, 25);
      assert.equal(usage.costMilliCents, 1110);
      assert.equal(usage.remaining, 9);
    });

    test('a failed call is counted apart from a successful one', async () => {
      await recordAiCall(db, {
        model: 'claude-opus-5',
        transactions: 3,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costMilliCents: 0,
        error: 'connection reset',
      }, '2026-09');

      const usage = await aiUsage(db, '2026-09');
      assert.equal(usage.calls, 0, 'a call that failed did not answer anything');
      assert.equal(usage.failedCalls, 1);
    });

    test('answers survive to the next import, keyed by merchant', async () => {
      const answers = new Map([
        [
          'SHELL',
          { envelope: env.gasId, confidence: 0.82, layer: 'ai' as const, reason: 'a fuel station', alternatives: [] },
        ],
      ]);

      assert.equal(await rememberAnswers(db, answers, 'claude-opus-5'), 1);

      const loaded = await cachedAnswers(db);
      assert.equal(loaded.get('SHELL')?.envelope, env.gasId);
      assert.equal(loaded.get('SHELL')?.layer, 'ai');
      assert.equal((await aiUsage(db)).cachedMerchants, 1);
    });

    test('an answer pointing at an archived envelope is dropped, not used', async () => {
      await rememberAnswers(
        db,
        new Map([
          ['SHELL', { envelope: env.gasId, confidence: 0.9, layer: 'ai' as const, reason: 'fuel', alternatives: [] }],
        ]),
        'claude-opus-5',
      );
      await archiveEnvelope(db, env.gasId);

      assert.equal((await cachedAnswers(db)).size, 0, 'asking again is cheaper than being wrong');
    });

    test('the cache can be cleared so the model is asked afresh', async () => {
      await rememberAnswers(
        db,
        new Map([
          ['SHELL', { envelope: env.gasId, confidence: 0.9, layer: 'ai' as const, reason: 'fuel', alternatives: [] }],
        ]),
        'claude-opus-5',
      );

      assert.equal(await clearAnswerCache(db), 1);
      assert.equal((await cachedAnswers(db)).size, 0);
    });

    test('examples are the merchants each envelope is actually used for (MG-8)', async () => {
      for (const payee of ['ZEHRS', 'ZEHRS', 'SOBEYS']) {
        await recordTransaction(db, {
          accountId,
          date: '2026-09-01',
          amountCents: -5000,
          payeeRaw: payee,
          status: 'confirmed',
          lines: [{ envelopeId: env.groceriesId, amountCents: -5000 }],
        });
      }

      const examples = await loadExamples(db);
      assert.deepEqual(examples[env.groceriesId]?.slice(0, 1), ['ZEHRS'], 'most used first');
      assert.ok(examples[env.groceriesId]?.includes('SOBEYS'));
      assert.equal(examples[env.gasId], undefined, 'an envelope with no history has no examples');
    });

    // -- accuracy (section 5's quality measure) ----------------------------

    const suggestionFor = async (
      payee: string,
      layer: 'rule' | 'history' | 'ai',
      confidence: number,
      proposed: string,
      accepted: string | null,
    ) => {
      const id = await recordTransaction(db, {
        accountId,
        date: '2026-09-01',
        amountCents: -1000,
        payeeRaw: payee,
        status: 'confirmed',
        lines: [{ envelopeId: accepted ?? proposed, amountCents: -1000 }],
      });
      await db.insert(suggestions).values({
        transactionId: id,
        envelopeId: proposed,
        layer,
        confidence,
        reason: 'because',
        acceptedEnvelopeId: accepted ?? proposed,
      });
    };

    test('accuracy is the share accepted unchanged, per layer', async () => {
      await suggestionFor('A', 'history', 0.9, env.gasId, env.gasId);
      await suggestionFor('B', 'history', 0.6, env.gasId, env.groceriesId);
      await suggestionFor('C', 'ai', 0.7, env.groceriesId, env.groceriesId);

      const report = await accuracy(db);
      const history = report.layers.find((row) => row.layer === 'history')!;
      assert.equal(history.decided, 2);
      assert.equal(history.acceptedUnchanged, 1);
      assert.equal(history.rate, 0.5);

      assert.equal(report.layers.find((row) => row.layer === 'ai')!.rate, 1);
      assert.equal(report.overall.decided, 3);
      assert.ok(Math.abs(report.overall.rate! - 2 / 3) < 0.001);
    });

    test('the high band is measured on its own, because only it is bulk-confirmed', async () => {
      await suggestionFor('A', 'history', 0.97, env.gasId, env.gasId);
      await suggestionFor('B', 'history', 0.96, env.gasId, env.groceriesId);
      await suggestionFor('C', 'history', 0.4, env.gasId, env.groceriesId);

      const report = await accuracy(db);
      assert.equal(report.highBandDecided, 2, 'the 0.4 one is not in the band');
      assert.equal(report.highBandPrecision, 0.5);
    });

    test('a suggestion nobody has confirmed is not evidence either way', async () => {
      const id = await recordTransaction(db, {
        accountId,
        date: '2026-09-01',
        amountCents: -1000,
        payeeRaw: 'PENDING',
        lines: [{ envelopeId: env.gasId, amountCents: -1000 }],
      });
      await db.insert(suggestions).values({
        transactionId: id,
        envelopeId: env.gasId,
        layer: 'ai',
        confidence: 0.9,
        reason: 'because',
      });

      const report = await accuracy(db);
      assert.equal(report.overall.decided, 0);
      assert.equal(report.overall.rate, null);
    });
  },
);
