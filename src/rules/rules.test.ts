import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { openAccount } from '../ledger/ledger.ts';
import { archiveAccount } from '../accounts/manage.ts';
import {
  RuleError,
  countRules,
  createEnvelopeRule,
  createTransferRule,
  deleteRule,
  dismissRuleSuggestion,
  dismissedRuleSuggestions,
  listRules,
  listTransferRules,
  matchTransferRule,
  suggestedRules,
  RULE_SUGGESTION_MINIMUM,
  ruleSuggestionCount,
  suggestAndCount,
  undismissRuleSuggestion,
  updateRule,
  type TransferRule,
} from './rules.ts';
import {
  closeDb,
  databaseAvailable,
  pgErrorCode,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { appSettings, envelopes, rules } from '../../db/schema.ts';
import { normalizePayee } from '../categorize/normalize.ts';

/**
 * `contains` is matched against the normalized payee key, and normalization
 * keeps the hyphen: "Tfr-to C C 0000123456" becomes "TFR-TO C C".
 */
const rule = (over: Partial<TransferRule> = {}): TransferRule => ({
  id: 'r1',
  contains: 'TFR-TO C C',
  transferAccountId: 'visa',
  minCents: null,
  maxCents: null,
  accountId: null,
  ...over,
});

describe('matching a transfer rule', () => {
  test('matches on the normalized payee, so bank noise does not break it', () => {
    const matched = matchTransferRule([rule()], {
      payeeRaw: 'Tfr-to C C 0000123456',
      amountCents: -50000,
      accountId: 'chequing',
    });
    assert.ok(matched, 'the reference number normalizes away');
  });

  test('a different payee does not match', () => {
    assert.equal(
      matchTransferRule([rule()], {
        payeeRaw: 'Send E-tfr',
        amountCents: -10000,
        accountId: 'chequing',
      }),
      undefined,
      'an Interac payment to a person is spending, not a transfer',
    );
  });

  test('a rule scoped to one account does not fire on another', () => {
    const scoped = [rule({ accountId: 'chequing' })];
    assert.ok(
      matchTransferRule(scoped, {
        payeeRaw: 'Tfr-to C C',
        amountCents: -50000,
        accountId: 'chequing',
      }),
    );
    assert.equal(
      matchTransferRule(scoped, {
        payeeRaw: 'Tfr-to C C',
        amountCents: -50000,
        accountId: 'savings',
      }),
      undefined,
    );
  });

  test('an amount range narrows it', () => {
    const narrow = [rule({ minCents: 10000, maxCents: 100000 })];
    assert.ok(
      matchTransferRule(narrow, { payeeRaw: 'Tfr-to C C', amountCents: -50000, accountId: 'c' }),
    );
    assert.equal(
      matchTransferRule(narrow, { payeeRaw: 'Tfr-to C C', amountCents: -500, accountId: 'c' }),
      undefined,
      'below the range',
    );
    assert.equal(
      matchTransferRule(narrow, { payeeRaw: 'Tfr-to C C', amountCents: -200000, accountId: 'c' }),
      undefined,
      'above it',
    );
  });

  test('a rule pointing at the account the row is already in is skipped', () => {
    assert.equal(
      matchTransferRule([rule({ transferAccountId: 'chequing' })], {
        payeeRaw: 'Tfr-to C C',
        amountCents: -50000,
        accountId: 'chequing',
      }),
      undefined,
      'an account cannot transfer to itself',
    );
  });

  test('the first rule in order wins', () => {
    const matched = matchTransferRule(
      [rule({ id: 'first', transferAccountId: 'visa' }), rule({ id: 'second', transferAccountId: 'loc' })],
      { payeeRaw: 'Tfr-to C C', amountCents: -50000, accountId: 'chequing' },
    );
    assert.equal(matched?.id, 'first');
  });
});

const available = await databaseAvailable();

describe(
  'storing rules',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;
    let visa: string;

    before(async () => {
      db = await setupTestDb('rules');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      visa = await openAccount(db, { name: 'Visa', kind: 'credit_card' });
    });

    after(async () => {
      await closeDb(db);
    });

    /** Just enough history to be worth a rule, whatever the threshold is today. */
    const enough = RULE_SUGGESTION_MINIMUM;

    /** `count` confirmed transactions from one payee, all in one envelope. */
    async function history(payee: string, envelopeId: string, count: number) {
      const { recordTransaction } = await import('../ledger/ledger.ts');
      for (let at = 0; at < count; at += 1) {
        await recordTransaction(db, {
          accountId: chequing,
          date: `2026-0${(at % 9) + 1}-0${(at % 9) + 1}`,
          amountCents: -1000 - at,
          payeeRaw: payee,
          status: 'confirmed',
          source: 'file_import',
          lines: [{ envelopeId, amountCents: -1000 - at }],
        });
      }
    }

    test('a payee sorted the same way often enough is worth a rule', async () => {
      await history('NETFLIX.COM 866-579-7172', env.gasId, enough);

      const [suggestion] = await suggestedRules(db);
      assert.ok(suggestion);
      // The rule matches the normalized key, not the text the bank wrote, so a
      // reference number appended next month still hits it.
      assert.equal(suggestion.contains, normalizePayee('NETFLIX.COM 866-579-7172').key);
      assert.equal(suggestion.envelopeId, env.gasId);
      assert.equal(suggestion.uses, enough);
    });

    test('a habit needs more than a few goes', async () => {
      await history('SOMEWHERE NEW', env.gasId, enough - 1);
      assert.deepEqual(await suggestedRules(db), [], 'one short of the minimum is not a rule');

      await history('SOMEWHERE NEW', env.gasId, 1);
      assert.equal((await suggestedRules(db)).length, 1, 'and the minimum itself is');
    });

    test('a payee you deliberately sort two ways is not a rule', async () => {
      await history('COSTCO WHOLESALE', env.gasId, enough);
      await history('COSTCO WHOLESALE', env.groceriesId, 3);

      assert.deepEqual(
        await suggestedRules(db),
        [],
        'one payee, two envelopes: no single answer to write down',
      );
    });

    test('a payee an existing rule already covers has nothing to suggest', async () => {
      await history('SHELL 4471 CALGARY', env.gasId, enough);
      assert.equal((await suggestedRules(db)).length, 1);

      await createEnvelopeRule(db, { contains: 'SHELL', envelopeId: env.gasId });
      assert.deepEqual(await suggestedRules(db), []);
    });

    test('nothing is written on your behalf: accepting is what writes it', async () => {
      await history('FREEDOM MOBILE', env.gasId, enough);

      assert.equal(await countRules(db).then((counts) => counts.envelope), 0);

      const [suggestion] = await suggestedRules(db);
      await createEnvelopeRule(db, {
        contains: suggestion!.contains,
        envelopeId: suggestion!.envelopeId,
      });

      const listed = await listRules(db);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.contains, normalizePayee('FREEDOM MOBILE').key);
      assert.deepEqual(listed[0]!.outcome, { kind: 'envelope', name: 'Gas', envelopeId: env.gasId });
    });

    test('a declined suggestion stays declined', async () => {
      await history('THE CORNER SHOP', env.gasId, enough);
      assert.equal((await suggestedRules(db)).length, 1);

      await dismissRuleSuggestion(db, normalizePayee('THE CORNER SHOP').key);
      assert.deepEqual(await suggestedRules(db), [], 'being asked every month is worse than not');

      // Declining one says nothing about the others.
      await history('SOMEWHERE ELSE', env.groceriesId, enough);
      assert.equal((await suggestedRules(db)).length, 1);
      assert.deepEqual(await dismissedRuleSuggestions(db), [
        normalizePayee('THE CORNER SHOP').key,
      ]);
    });

    test('suggestions keep their order, ties included, as you answer them', async () => {
      // Equal counts are common - every payee at the minimum ties with every
      // other - and with only the count to go on, Postgres was free to hand the
      // ties back in any order. Adding a rule changes the query's plan, so the
      // list came back reshuffled after every "Add it".
      await history('ZULU HARDWARE', env.gasId, enough);
      await history('ALPHA BAKERY', env.gasId, enough);
      await history('MIKE GARAGE', env.gasId, enough + 3);
      await history('BRAVO BOOKS', env.gasId, enough);

      const names = async () => (await suggestedRules(db)).map((rule) => rule.contains);
      const key = (payee: string) => normalizePayee(payee).key;
      assert.deepEqual(await names(), [
        key('MIKE GARAGE'),
        key('ALPHA BAKERY'),
        key('BRAVO BOOKS'),
        key('ZULU HARDWARE'),
      ]);

      await createEnvelopeRule(db, { contains: key('MIKE GARAGE'), envelopeId: env.gasId });
      assert.deepEqual(await names(), [key('ALPHA BAKERY'), key('BRAVO BOOKS'), key('ZULU HARDWARE')]);
    });

    test('a declined suggestion does not take a place in the list', async () => {
      await history('FIRST PLACE', env.gasId, enough + 2);
      await history('SECOND PLACE', env.gasId, enough + 1);
      await history('THIRD PLACE', env.gasId, enough);

      await dismissRuleSuggestion(db, normalizePayee('FIRST PLACE').key);
      assert.deepEqual(
        (await suggestedRules(db, { limit: 2 })).map((rule) => rule.contains),
        [normalizePayee('SECOND PLACE').key, normalizePayee('THIRD PLACE').key],
      );
    });

    test('unconfirmed history is not evidence of a habit', async () => {
      const { recordTransaction } = await import('../ledger/ledger.ts');
      for (let at = 0; at < 8; at += 1) {
        await recordTransaction(db, {
          accountId: chequing,
          date: '2026-02-01',
          amountCents: -1000 - at,
          payeeRaw: 'NOT REVIEWED YET',
          source: 'file_import',
          lines: [{ envelopeId: env.gasId, amountCents: -1000 - at }],
        });
      }

      assert.deepEqual(await suggestedRules(db), [], 'a suggestion nobody accepted proves nothing');
    });

    test('a transfer rule round-trips, upper-cased and scoped', async () => {
      await createTransferRule(db, {
        contains: 'tfr-to c c',
        transferAccountId: visa,
        accountId: chequing,
      });

      const [stored] = await listTransferRules(db);
      assert.equal(stored!.contains, 'TFR-TO C C');
      assert.equal(stored!.transferAccountId, visa);
      assert.equal(stored!.accountId, chequing);
    });

    test('making the same rule twice makes one rule', async () => {
      const first = await createTransferRule(db, {
        contains: 'TFR TO C C',
        transferAccountId: visa,
        accountId: chequing,
      });
      const second = await createTransferRule(db, {
        contains: 'TFR TO C C',
        transferAccountId: visa,
        accountId: chequing,
      });

      assert.equal(first, second);
      assert.equal((await listTransferRules(db)).length, 1);
    });

    test('a rule needs something substantial to match on', async () => {
      await assert.rejects(
        () => createTransferRule(db, { contains: 'a', transferAccountId: visa }),
        RuleError,
      );
    });

    test('a rule cannot point at an archived account', async () => {
      await archiveAccount(db, visa);
      await assert.rejects(
        () => createTransferRule(db, { contains: 'TFR TO C C', transferAccountId: visa }),
        RuleError,
      );
    });

    test('the database refuses a rule that means both things, or neither', async () => {
      await assert.rejects(
        () =>
          db.insert(rules).values({
            contains: 'BOTH',
            envelopeId: env.gasId,
            transferAccountId: visa,
          }),
        (error: unknown) => {
          assert.equal(pgErrorCode(error), '23514', 'the check constraint, not application code');
          return true;
        },
      );

      await assert.rejects(
        () => db.insert(rules).values({ contains: 'NEITHER' }),
        (error: unknown) => {
          assert.equal(pgErrorCode(error), '23514');
          return true;
        },
      );
    });

    test('the settings list shows both kinds with what they point at', async () => {
      await db.insert(rules).values({ contains: 'SHELL', envelopeId: env.gasId });
      await createTransferRule(db, {
        contains: 'TFR TO C C',
        transferAccountId: visa,
        accountId: chequing,
      });

      const listed = await listRules(db);
      assert.equal(listed.length, 2);

      const transfer = listed.find((item) => item.outcome.kind === 'transfer')!;
      assert.equal(transfer.outcome.name, 'Visa');
      assert.equal(transfer.onlyAccountName, 'Chequing');

      const envelope = listed.find((item) => item.outcome.kind === 'envelope')!;
      assert.equal(envelope.outcome.name, 'Gas');
      assert.equal(envelope.onlyAccountName, null);

      assert.deepEqual(await countRules(db), { envelope: 1, transfer: 1 });
    });

    test('a transfer rule is kept out of the categorizer', async () => {
      const { loadRules } = await import('../categorize/fromDb.ts');
      await db.insert(rules).values({ contains: 'SHELL', envelopeId: env.gasId });
      await createTransferRule(db, { contains: 'TFR TO C C', transferAccountId: visa });

      const forCategorizer = await loadRules(db);
      assert.deepEqual(
        forCategorizer.map((item) => item.contains),
        ['SHELL'],
        'a transfer is not a categorization',
      );
    });

    test('forgetting a rule leaves the rest alone', async () => {
      const id = await createTransferRule(db, { contains: 'TFR TO C C', transferAccountId: visa });
      await createTransferRule(db, { contains: 'TFR-FR SAVINGS', transferAccountId: chequing });

      await deleteRule(db, id);
      assert.deepEqual(
        (await listTransferRules(db)).map((item) => item.contains),
        ['TFR-FR SAVINGS'],
      );
    });

    // -- editing -----------------------------------------------------------

    const onlyRule = async () => (await listRules(db))[0]!;

    test('a rule can be edited: what it matches, where it sends it, and its range', async () => {
      await createEnvelopeRule(db, { contains: 'DUNBAR DENTAL', envelopeId: env.gasId });
      const rule = await onlyRule();

      await updateRule(db, rule.id, {
        contains: ' dental ',
        targetId: env.groceriesId,
        minCents: 1000,
        maxCents: 50000,
      });

      const edited = await onlyRule();
      assert.equal(edited.contains, 'DENTAL', 'upper-cased and trimmed, as a new rule is');
      assert.deepEqual(edited.outcome, {
        kind: 'envelope',
        name: 'Groceries',
        envelopeId: env.groceriesId,
      });
      assert.equal(edited.minCents, 1000);
      assert.equal(edited.maxCents, 50000);
    });

    test('a transfer rule stays a transfer rule, pointed at another account', async () => {
      const savings = await openAccount(db, { name: 'Savings', kind: 'savings' });
      await createTransferRule(db, { contains: 'TFR TO C C', transferAccountId: visa });
      const rule = await onlyRule();

      await updateRule(db, rule.id, {
        contains: 'TFR TO SAV',
        targetId: savings,
        minCents: null,
        maxCents: null,
      });
      assert.deepEqual((await onlyRule()).outcome, {
        kind: 'transfer',
        name: 'Savings',
        accountId: savings,
      });
    });

    test('an edit that would make a bad rule is refused, and changes nothing', async () => {
      await createEnvelopeRule(db, { contains: 'DUNBAR DENTAL', envelopeId: env.gasId });
      const rule = await onlyRule();
      const edit = { contains: 'DENTAL', targetId: env.gasId, minCents: null, maxCents: null };

      await assert.rejects(updateRule(db, rule.id, { ...edit, contains: 'DE' }), RuleError);
      await assert.rejects(
        updateRule(db, rule.id, { ...edit, minCents: 5000, maxCents: 1000 }),
        /nothing would match/,
      );
      await assert.rejects(updateRule(db, rule.id, { ...edit, minCents: -1 }), RuleError);

      const [archived] = await db
        .insert(envelopes)
        .values({ groupId: env.groupId, name: 'Old', archivedAt: new Date() })
        .returning({ id: envelopes.id });
      await assert.rejects(updateRule(db, rule.id, { ...edit, targetId: archived!.id }), /archived/);

      assert.equal((await onlyRule()).contains, 'DUNBAR DENTAL');
    });

    // -- declined, and asked again ------------------------------------------

    test('a "no" can be taken back, and the payee is suggested again', async () => {
      await history('THE CORNER SHOP', env.gasId, enough);
      const key = normalizePayee('THE CORNER SHOP').key;

      await dismissRuleSuggestion(db, key);
      assert.deepEqual(await suggestedRules(db), []);

      await undismissRuleSuggestion(db, key);
      assert.deepEqual(await dismissedRuleSuggestions(db), []);
      assert.equal((await suggestedRules(db))[0]?.contains, key);
    });

    // -- the stored count ---------------------------------------------------

    test('looking at the suggestions corrects a stale count', async () => {
      // What raising the threshold left behind: a count from the old rules, and
      // nothing on the settings page to press that would recount.
      await db
        .insert(appSettings)
        .values({ key: 'rule_suggestion_count', value: '24' })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: '24' } });
      await history('ONE REAL HABIT', env.gasId, enough);

      const { suggestions, total } = await suggestAndCount(db);
      assert.equal(suggestions.length, 1);
      assert.equal(total, 1);
      assert.equal(await ruleSuggestionCount(db), 1);
    });
  },
);
