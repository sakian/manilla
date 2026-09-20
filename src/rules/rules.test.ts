import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { openAccount } from '../ledger/ledger.ts';
import { archiveAccount } from '../accounts/manage.ts';
import {
  RuleError,
  countRules,
  createTransferRule,
  deleteRule,
  listRules,
  listTransferRules,
  matchTransferRule,
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
import { rules } from '../../db/schema.ts';

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
  },
);
