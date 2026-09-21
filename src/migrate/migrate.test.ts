import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { checkInvariant, envelopeBalances, openAccount } from '../ledger/ledger.ts';
import { listAccounts } from '../accounts/manage.ts';
import { listEnvelopes } from '../envelopes/manage.ts';
import {
  DEFAULT_SOURCE,
  MIGRATION_SOURCES,
  isMigrationSource,
  migrationSource,
} from './sources.ts';
import {
  CARRIED_OVER_NOTE,
  FILLED_NOTE,
  MIGRATED_NOTE,
  MigrationError,
  applyReconciliation,
  commitMigration,
  planMigration,
  reconcile,
  revertMigration,
  type MigrationMapping,
} from './migrate.ts';
import {
  closeDb,
  databaseAvailable,
  seedEnvelopes,
  setupTestDb,
  truncateAll,
  type Fixture,
} from '../ledger/testdb.ts';
import { envelopeMoves, envelopes, transactions } from '../../db/schema.ts';
import { eq } from 'drizzle-orm';

/**
 * A fixture shaped like the real export: D/M/Y dates, `Group:Name` envelopes,
 * splits in Details, income into [Available], paired envelope transfers, paired
 * account transfers, and a Fill Envelopes row carrying nothing.
 */
const EXPORT = [
  'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
  // Plain spending. 19/09 can only be D/M/Y, which settles the file.
  '19/09/2026,Vehicle:Gas,Chequing,SHELL 4471,,,-45.20,Cleared,',
  '03/09/2026,Living:Groceries,Chequing,ZEHRS,weekly shop,,-122.45,Cleared,',
  // A split parent: no envelope of its own, parts in Details.
  '05/09/2026,,Visa,COSTCO,,,-100.00,Cleared,Living:Groceries|-60.00||Vehicle:Gas|-40.00',
  // Income, as a split into the pool.
  '01/09/2026,,Chequing,PAYROLL,,,3200.00,Cleared,[Available]|3200.00',
  // An envelope-to-envelope move, exported as a matched pair.
  '10/09/2026,Vehicle:Gas,,Envelope Transfer,,,-25.00,Cleared,',
  '10/09/2026,Living:Groceries,,Envelope Transfer,,,25.00,Cleared,',
  // A transfer between the user's own accounts, also a pair.
  '12/09/2026,,Chequing,Payment to Visa,,,-500.00,Cleared,',
  '12/09/2026,,Visa,Payment to Visa,,,500.00,Cleared,',
  // A monthly fill marker: no amount, no breakdown, nothing to reproduce.
  '01/09/2026,,,Fill Envelopes,,,,Cleared,',
].join('\n');

describe('which apps can be migrated from', () => {
  test('every source is listed with what a user needs to find the file', () => {
    for (const source of MIGRATION_SOURCES) {
      assert.ok(source.label.length > 0, `${source.id} needs a label`);
      assert.ok(source.hint.length > 0, `${source.id} needs a hint`);
      assert.ok(source.poolEnvelope.length > 0, `${source.id} needs its pool named`);
    }
    assert.equal(
      new Set(MIGRATION_SOURCES.map((source) => source.id)).size,
      MIGRATION_SOURCES.length,
      'ids are how a choice is sent from the browser, so they cannot collide',
    );
  });

  test('nothing written into the ledger names the app it came from', () => {
    // These two strings end up in an envelope's history, where the user reads
    // them. Named apps belong in the registry above and nowhere else, so a
    // public repo does not editorialise about anyone's product.
    for (const note of [MIGRATED_NOTE, CARRIED_OVER_NOTE, FILLED_NOTE]) {
      for (const source of MIGRATION_SOURCES) {
        assert.ok(
          !note.toLowerCase().includes(source.label.toLowerCase()),
          `"${note}" names ${source.label}`,
        );
      }
    }
  });

  test('an unknown source is refused rather than quietly defaulted', () => {
    assert.ok(isMigrationSource(DEFAULT_SOURCE));
    assert.ok(!isMigrationSource('ynab'));
    assert.ok(!isMigrationSource(''));
    assert.throws(() => migrationSource('ynab'), /Not an app Manilla can migrate from/);
  });

  test('the plan records which app it read the files as', () => {
    const plan = planMigration([EXPORT]);
    assert.equal(plan.from, DEFAULT_SOURCE, 'and defaults rather than requiring it');

    const chosen = planMigration([EXPORT], { from: 'goodbudget' });
    assert.equal(chosen.from, 'goodbudget');
  });

  test("the source decides what counts as the export's income pool", () => {
    // The pool marker is the one format-specific fact the registry carries, so
    // the income row is only read as income because of it (FR-28).
    const plan = planMigration([EXPORT]);
    const pool = migrationSource(plan.from).poolEnvelope;

    const payroll = plan.transactions.find((transaction) => transaction.payeeRaw === 'PAYROLL')!;
    assert.deepEqual(payroll.lines, [{ envelope: pool, amountCents: 320000 }]);
    assert.ok(plan.envelopes.some((envelope) => envelope.name === pool));
  });
});

describe('reading an export', () => {
  test('the file settles its own date format, and rows are read as D/M/Y', () => {
    const plan = planMigration([EXPORT]);
    assert.equal(plan.dateFormat, 'dmy');
    assert.equal(plan.dateRange?.from, '2026-09-01');
    assert.equal(plan.dateRange?.to, '2026-09-19');
  });

  test('every kind of row is counted, including the ones it cannot reproduce', () => {
    const plan = planMigration([EXPORT]);
    assert.equal(plan.counts.spending, 2);
    assert.equal(plan.counts.split, 1);
    assert.equal(plan.counts.income, 1);
    assert.equal(plan.counts.envelopeTransfer, 2, 'two rows, one move');
    assert.equal(plan.counts.accountTransfer, 2, 'two rows, one transfer');
    assert.equal(plan.counts.fill, 1);
    assert.deepEqual(plan.unrepresentable, [], 'nothing in this file is beyond it');
  });

  test('a split becomes one transaction with parts that sum to the whole', () => {
    const plan = planMigration([EXPORT]);
    const costco = plan.transactions.find((transaction) => transaction.payeeRaw === 'COSTCO')!;
    assert.equal(costco.amountCents, -10000);
    assert.deepEqual(
      costco.lines.map((line) => [line.envelope, line.amountCents]),
      [
        ['Living:Groceries', -6000],
        ['Vehicle:Gas', -4000],
      ],
    );
  });

  test('income is a line into the pool, not spending', () => {
    const plan = planMigration([EXPORT]);
    const payroll = plan.transactions.find((transaction) => transaction.payeeRaw === 'PAYROLL')!;
    assert.equal(payroll.amountCents, 320000);
    assert.deepEqual(payroll.lines, [{ envelope: '[Available]', amountCents: 320000 }]);
  });

  test('envelope transfers pair up into a single move', () => {
    const plan = planMigration([EXPORT]);
    assert.equal(plan.moves.length, 1);
    assert.deepEqual(
      [plan.moves[0]!.fromEnvelope, plan.moves[0]!.toEnvelope, plan.moves[0]!.amountCents],
      ['Vehicle:Gas', 'Living:Groceries', 2500],
    );
  });

  test('account transfers pair up into a single transfer', () => {
    const plan = planMigration([EXPORT]);
    assert.equal(plan.transfers.length, 1);
    assert.deepEqual(
      [plan.transfers[0]!.fromAccount, plan.transfers[0]!.toAccount, plan.transfers[0]!.amountCents],
      ['Chequing', 'Visa', 50000],
    );
  });

  test('a transfer half with no partner is reported, never made one-sided', () => {
    const lonely = [
      'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
      '19/09/2026,Vehicle:Gas,,Envelope Transfer,,,-25.00,Cleared,',
      '19/09/2026,,Chequing,Mystery,,,-500.00,Cleared,',
    ].join('\n');

    const plan = planMigration([lonely]);
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.transfers.length, 0);
    assert.equal(plan.unrepresentable.length, 2);
    assert.match(plan.unrepresentable[0]!.reason, /no matching row/);
    assert.match(plan.unrepresentable[1]!.reason, /neither spending nor a transfer/);
  });

  test('a zero-amount row is reported rather than quietly dropped (MG-4)', () => {
    const zeroes = [
      'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
      '19/09/2026,,Chequing,ZERO DOLLAR AUTH,,,0.00,Cleared,',
      '19/09/2026,Vehicle:Gas,,Envelope Transfer,,,0.00,Cleared,',
    ].join('\n');

    const plan = planMigration([zeroes]);
    assert.equal(plan.transactions.length, 0);
    assert.equal(plan.transfers.length, 0);
    assert.equal(plan.moves.length, 0);
    assert.equal(plan.unrepresentable.length, 2, 'both are listed, neither is guessed at');
    assert.ok(plan.unrepresentable.every((item) => /nothing to (record|move)/.test(item.reason)));
  });

  test('a split whose parts do not sum to the whole is reported, not written', () => {
    const wrong = [
      'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
      '19/09/2026,,Chequing,COSTCO,,,-100.00,Cleared,Living:Groceries|-60.00||Vehicle:Gas|-30.00',
    ].join('\n');

    const plan = planMigration([wrong]);
    assert.equal(plan.transactions.length, 0);
    assert.match(plan.unrepresentable[0]!.reason, /do not sum to the whole/);
  });

  test('envelopes and accounts are listed with their group and their usage', () => {
    const plan = planMigration([EXPORT]);
    const gas = plan.envelopes.find((envelope) => envelope.name === 'Vehicle:Gas')!;
    assert.equal(gas.group, 'Vehicle');
    assert.equal(gas.uses, 3, 'spending, a split part and an envelope transfer');
    assert.ok(plan.envelopes.some((envelope) => envelope.name === '[Available]'));
    assert.deepEqual(
      plan.accounts.map((account) => account.name).sort(),
      ['Chequing', 'Visa'],
    );
  });

  test('identical rows are kept apart, so four real charges stay four', () => {
    const repeated = [
      'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
      ...Array.from({ length: 4 }, () => '19/09/2026,Living:Groceries,Chequing,VENDING,,,-3.75,Cleared,'),
    ].join('\n');

    const plan = planMigration([repeated]);
    assert.equal(plan.transactions.length, 4);
    assert.equal(new Set(plan.transactions.map((t) => t.externalId)).size, 4);
  });

  test('the same file read twice gives the same identities', () => {
    const first = planMigration([EXPORT]).transactions.map((t) => t.externalId);
    const second = planMigration([EXPORT]).transactions.map((t) => t.externalId);
    assert.deepEqual(first, second);
  });

  test('several files are read as one run, and what they share is read once (MG-1)', () => {
    // This used to plan eight: occurrences were counted across files, so the
    // second copy of each row looked like a fifth to eighth genuine charge and
    // the commit had nothing to tell it otherwise.
    const plan = planMigration([EXPORT, EXPORT]);
    assert.equal(plan.transactions.length, 4);
    assert.equal(plan.overlapped, EXPORT.split('\n').length - 1);
  });

  test('files that overlap bring the shared rows once, and repeats within one file stay', () => {
    const head = 'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details';
    const vending = '19/09/2026,Living:Groceries,Chequing,VENDING,,,-3.75,Cleared,';
    const august = [head, '28/08/2026,Vehicle:Gas,Chequing,SHELL,,,-40.00,Cleared,', vending, vending];
    const september = [head, vending, vending, '20/09/2026,Vehicle:Gas,Chequing,ESSO,,,-30.00,Cleared,'];

    const plan = planMigration([august.join('\n'), september.join('\n')]);
    assert.equal(plan.transactions.length, 4, 'shell, two vending, esso');
    assert.equal(plan.overlapped, 2);
  });
});

/**
 * Shaped like an envelope or category export: every row names its envelope, and
 * each fill carries that envelope's share - which the full export never does.
 * Spending comes along too, and so does one side of an envelope transfer.
 */
const CATEGORY_EXPORT = [
  'Date,Envelope,Account,Name,Notes,"Check #",Amount,Status,Details',
  '01/09/2026,Vehicle:Gas,[none],"Fill Envelopes",,,150.00,,',
  '01/09/2026,Vehicle:Insurance,[none],"Fill Envelopes",,,"1,200.00",,',
  '19/09/2026,Vehicle:Gas,Chequing,SHELL 4471,,,-45.20,Cleared,',
  '10/09/2026,Vehicle:Gas,,"Envelope Transfer",,,-25.00,,',
  // Twice on one day in one file: the old app really filled it twice.
  '01/08/2026,Vehicle:Gas,[none],"Fill Envelopes",,,150.00,,',
  '01/08/2026,Vehicle:Gas,[none],"Fill Envelopes",,,150.00,,',
].join('\n');

/** One envelope from the category above, exported on its own as well. */
const ENVELOPE_EXPORT = [
  'Date,Envelope,Account,Name,Notes,"Check #",Amount,Status,Details',
  '01/09/2026,Vehicle:Insurance,[none],"Fill Envelopes",,,"1,200.00",,',
].join('\n');

describe('fills from envelope and category exports', () => {
  test('an envelope export is recognised, and only its fills are taken', () => {
    const plan = planMigration([EXPORT, CATEGORY_EXPORT]);
    assert.equal(plan.envelopeExports, 1);
    assert.equal(plan.transactions.length, 4, 'the spending is the full export’s alone');
    assert.equal(plan.moves.length, 1, 'and so is the transfer, which it has both halves of');
    assert.equal(plan.coveredElsewhere, 2);
    assert.deepEqual(
      plan.fills.map((fill) => [fill.date, fill.envelope, fill.amountCents]),
      [
        ['2026-09-01', 'Vehicle:Gas', 15000],
        ['2026-09-01', 'Vehicle:Insurance', 120000],
        ['2026-08-01', 'Vehicle:Gas', 15000],
        ['2026-08-01', 'Vehicle:Gas', 15000],
      ],
    );
    assert.equal(plan.counts.fill, 1, 'the full export’s marker is still just a marker');
  });

  test('an envelope that was only ever filled is still offered for mapping', () => {
    const plan = planMigration([EXPORT, CATEGORY_EXPORT]);
    assert.ok(plan.envelopes.some((envelope) => envelope.name === 'Vehicle:Insurance'));
  });

  test('a category and one of its envelopes, exported both ways, fill it once', () => {
    const plan = planMigration([EXPORT, CATEGORY_EXPORT, ENVELOPE_EXPORT]);
    assert.equal(plan.fills.filter((fill) => fill.envelope === 'Vehicle:Insurance').length, 1);
    assert.equal(plan.overlapped, 1);
  });

  test('a short export borrows the date format the others settle', () => {
    // Nothing above the 12th: on its own this could be the 9th of January.
    const plan = planMigration([EXPORT, ENVELOPE_EXPORT.replace('01/09/2026', '09/01/2026')]);
    assert.equal(plan.fills[0]!.date, '2026-01-09');
    assert.ok(!plan.warnings.some((warning) => /could not be settled/.test(warning)));
  });

  test('envelope exports alone say the full export is missing', () => {
    const plan = planMigration([CATEGORY_EXPORT]);
    assert.equal(plan.transactions.length, 0);
    assert.ok(plan.warnings.some((warning) => /full export/.test(warning)));
  });
});

const available = await databaseAvailable();

describe(
  'migrating an export',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;

    before(async () => {
      db = await setupTestDb('migrate');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
    });

    after(async () => {
      await closeDb(db);
    });

    const mappingFor = (): MigrationMapping => ({
      envelopes: {
        'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId },
        'Living:Groceries': { action: 'existing', envelopeId: env.groceriesId },
      },
      accounts: {
        Chequing: { action: 'create', name: 'Chequing', kind: 'chequing' },
        Visa: { action: 'create', name: 'Visa', kind: 'credit_card' },
      },
    });

    const balanceOf = async (envelopeId: string) =>
      (await envelopeBalances(db)).find((row) => row.envelopeId === envelopeId)!.balanceCents;

    test('a migration writes history, transfers and moves, and the books balance', async () => {
      const plan = planMigration([EXPORT]);
      const result = await commitMigration(db, plan, mappingFor(), { filename: 'history.csv' });

      assert.equal(result.added, 4, 'two plain, one split, one income');
      assert.equal(result.transfers, 1);
      assert.equal(result.moves, 1);
      assert.equal(result.accountsCreated, 2);
      assert.equal(result.duplicates, 0);

      // Gas: -45.20 spending, -40.00 of the split, -25.00 moved out.
      assert.equal(await balanceOf(env.gasId), -11020);
      // Groceries: -122.45, -60.00 of the split, +25.00 moved in.
      assert.equal(await balanceOf(env.groceriesId), -15745);
      // The pool holds the income.
      assert.equal(await balanceOf(env.unallocatedId), 320000);

      const report = await checkInvariant(db);
      assert.ok(report.ok, 'envelopes and accounts agree');
      assert.equal(report.unassignedCents, 0, 'nothing arrived uncategorized');
    });

    test('migrated history arrives confirmed, and marked as migrated (MG-5)', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      const rows = await db.select().from(transactions);

      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.status === 'confirmed'));
      assert.ok(rows.every((row) => row.source === 'goodbudget'));
    });

    test('the export’s Notes arrive as notes, not as a bank memo', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      const [zehrs] = await db.select().from(transactions).where(eq(transactions.payeeRaw, 'ZEHRS'));
      assert.equal(zehrs!.note, 'weekly shop', 'typed by the user in the old app');
      assert.equal(zehrs!.memo, null);
    });

    test('the rule suggestions a migration earns are counted, not left stale', async () => {
      const {
        RULE_SUGGESTION_MINIMUM,
        ruleSuggestionCount,
        refreshRuleSuggestionCount,
        suggestedRules,
      } = await import('../rules/rules.ts');

      // Six years of history is the biggest producer of "this payee always goes
      // to one envelope" evidence there is, so a migration is exactly when the
      // suggestion list fills up. The count behind the notice is cached, because
      // working it out is one of the two heaviest queries the notices run - and a
      // cache is only as good as whoever invalidates it.
      const repeated = [
        'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
        ...Array.from(
          { length: RULE_SUGGESTION_MINIMUM },
          (_, at) =>
            `${String(at + 1).padStart(2, '0')}/09/2026,Vehicle:Gas,Chequing,SHELL 4471,,,-45.20,Cleared,`,
        ),
        // One row a D/M/Y file can only be read one way, to settle the format.
        '19/09/2026,Vehicle:Gas,Chequing,PETRO CANADA,,,-60.00,Cleared,',
      ].join('\n');

      assert.equal(await ruleSuggestionCount(db), 0, 'nothing before anything is written');

      await commitMigration(db, planMigration([repeated]), mappingFor());

      const earned = await suggestedRules(db);
      assert.ok(earned.length > 0, 'one payee, one envelope, six times over');

      // What the action does after committing. Without it the app finishes the
      // one operation that fills this list and then says nothing about it.
      assert.equal(await refreshRuleSuggestionCount(db), earned.length);
      assert.equal(await ruleSuggestionCount(db), earned.length);

      // And taking the history back out takes the evidence with it.
      const [batch] = await db.select().from(transactions).limit(1);
      assert.ok(batch);
      await revertMigration(db, batch.importBatchId!);
      assert.equal(await refreshRuleSuggestionCount(db), 0);
    });

    test('running the same export again adds nothing (MG-1)', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      const before = (await db.select().from(transactions)).length;

      const second = await commitMigration(db, planMigration([EXPORT]), mappingFor());
      assert.equal(second.added, 0);
      assert.equal(second.transfers, 0);
      assert.equal(second.moves, 0);
      assert.ok(second.duplicates > 0);
      assert.equal((await db.select().from(transactions)).length, before);
    });

    test('creating an envelope that is already there merges into it instead (MG-3)', async () => {
      // The fixture already has Living:Groceries, and the export names the same
      // envelope. Making a second one with the same name in the same group would
      // split the history across two envelopes that read identically.
      const result = await commitMigration(db, planMigration([EXPORT]), {
        envelopes: {
          'Vehicle:Gas': { action: 'create', name: 'Gas', group: 'Vehicle' },
          'Living:Groceries': { action: 'create', name: 'Groceries', group: 'Living' },
        },
        accounts: mappingFor().accounts,
      });

      assert.equal(result.envelopesCreated, 1, 'only the one that was genuinely new');
      const living = (await listEnvelopes(db)).find((group) => group.name === 'Living')!;
      assert.equal(
        living.envelopes.filter((envelope) => envelope.name === 'Groceries').length,
        1,
      );
    });

    test('a second run reuses the chart of envelopes rather than doubling it', async () => {
      // Groups the fixture does not already have, so "create" really creates.
      const creating = {
        envelopes: {
          'Vehicle:Gas': { action: 'create' as const, name: 'Gas', group: 'Vehicle' },
          'Living:Groceries': { action: 'create' as const, name: 'Groceries', group: 'Household' },
        },
        accounts: mappingFor().accounts,
      };

      const first = await commitMigration(db, planMigration([EXPORT]), creating);
      assert.equal(first.envelopesCreated, 2);
      assert.equal(first.accountsCreated, 2);

      const second = await commitMigration(db, planMigration([EXPORT]), creating);
      assert.equal(second.envelopesCreated, 0, 'the same names in the same groups already exist');
      assert.equal(second.accountsCreated, 0);

      const groups = await listEnvelopes(db);
      const vehicle = groups.find((group) => group.name === 'Vehicle')!;
      assert.deepEqual(vehicle.envelopes.map((envelope) => envelope.name), ['Gas']);
      assert.equal((await listAccounts(db)).filter((a) => a.name === 'Chequing').length, 1);
    });

    test('an overlapping second file only brings what is new', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());

      const extra = [
        'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
        '19/09/2026,Vehicle:Gas,Chequing,SHELL 4471,,,-45.20,Cleared,',
        '20/09/2026,Vehicle:Gas,Chequing,PETRO CANADA,,,-51.10,Cleared,',
      ].join('\n');

      const mapping = mappingFor();
      mapping.accounts.Chequing = { action: 'existing', accountId: (await listAccounts(db)).find((a) => a.name === 'Chequing')!.id };
      mapping.accounts.Visa = { action: 'existing', accountId: (await listAccounts(db)).find((a) => a.name === 'Visa')!.id };

      const result = await commitMigration(db, planMigration([extra]), mapping);
      assert.equal(result.added, 1, 'only the row that was not already here');
      assert.equal(result.duplicates, 1);
    });

    test('envelopes can be created from the export, group and all (MG-3)', async () => {
      const plan = planMigration([EXPORT]);
      const result = await commitMigration(db, plan, {
        envelopes: {
          'Vehicle:Gas': { action: 'create', name: 'Gas', group: 'Vehicle' },
          'Living:Groceries': { action: 'create', name: 'Groceries', group: 'Household' },
        },
        accounts: mappingFor().accounts,
      });

      assert.equal(result.envelopesCreated, 2);
      const groups = await listEnvelopes(db);
      const vehicle = groups.find((group) => group.name === 'Vehicle')!;
      assert.deepEqual(vehicle.envelopes.map((envelope) => envelope.name), ['Gas']);
      assert.ok(groups.find((group) => group.name === 'Household'));
    });

    test('two GoodBudget envelopes can be merged into one (MG-3)', async () => {
      const result = await commitMigration(db, planMigration([EXPORT]), {
        envelopes: {
          'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId },
          'Living:Groceries': { action: 'existing', envelopeId: env.gasId },
        },
        accounts: mappingFor().accounts,
      });

      assert.equal(result.envelopesCreated, 0);
      // Everything landed in one envelope, and the move became a no-op within it.
      assert.equal(await balanceOf(env.groceriesId), 0);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('income always lands in the pool, whatever the mapping says', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      assert.equal(await balanceOf(env.unallocatedId), 320000);
    });

    test('a migration refuses to start with an envelope nobody decided about', async () => {
      await assert.rejects(
        () =>
          commitMigration(db, planMigration([EXPORT]), {
            envelopes: { 'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId } },
            accounts: mappingFor().accounts,
          }),
        (error: unknown) => {
          assert.ok(error instanceof MigrationError);
          assert.match(error.message, /Living:Groceries/);
          return true;
        },
      );
      assert.equal((await db.select().from(transactions)).length, 0, 'and writes nothing');
    });

    test('rows with no account need one nominated', async () => {
      const orphan = [
        'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
        '19/09/2026,Vehicle:Gas,[none],CASH FOR FUEL,,,-20.00,Cleared,',
      ].join('\n');

      const plan = planMigration([orphan]);
      assert.equal(plan.needsDefaultAccount, true);

      await assert.rejects(
        () =>
          commitMigration(db, plan, {
            envelopes: { 'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId } },
            accounts: {},
          }),
        MigrationError,
      );

      const cash = await openAccount(db, { name: 'Cash', kind: 'cash' });
      const result = await commitMigration(db, plan, {
        envelopes: { 'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId } },
        accounts: {},
        defaultAccount: { action: 'existing', accountId: cash },
      });
      assert.equal(result.added, 1);
    });

    test('rows with no account can go to an account the migration creates', async () => {
      // A fresh install has no accounts to nominate; the export's own must do.
      const mixed = [
        'Date,Envelope,Account,Name,Notes,Check #,Amount,Status,Details',
        '18/09/2026,Vehicle:Gas,Chequing,SHELL,,,-40.00,Cleared,',
        '19/09/2026,Vehicle:Gas,[none],CASH FOR FUEL,,,-20.00,Cleared,',
      ].join('\n');
      const plan = planMigration([mixed]);
      assert.equal(plan.rowsWithoutAccount, 1);

      const result = await commitMigration(db, plan, {
        envelopes: { 'Vehicle:Gas': { action: 'existing', envelopeId: env.gasId } },
        accounts: { Chequing: { action: 'create', name: 'Chequing', kind: 'chequing' } },
        defaultAccount: { action: 'create', name: 'Chequing', kind: 'chequing' },
      });
      assert.equal(result.added, 2);
      assert.equal(result.accountsCreated, 1, 'the same account, not a second one by that name');

      const rows = await db.select().from(transactions);
      assert.equal(new Set(rows.map((row) => row.accountId)).size, 1);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('fills rebuild envelope balances, out of the pool (#7)', async () => {
      const plan = planMigration([EXPORT, CATEGORY_EXPORT, ENVELOPE_EXPORT]);
      const [insurance] = await db
        .insert(envelopes)
        .values({ groupId: env.groupId, name: 'Insurance' })
        .returning({ id: envelopes.id });
      const result = await commitMigration(db, plan, {
        ...mappingFor(),
        envelopes: {
          ...mappingFor().envelopes,
          'Vehicle:Insurance': { action: 'existing', envelopeId: insurance!.id },
        },
      });
      assert.equal(result.fills, 4);

      // Gas: three fills of 150.00, less -45.20, -40.00 of the split, -25.00 moved.
      assert.equal(await balanceOf(env.gasId), 45000 - 11020);
      assert.equal(await balanceOf(insurance!.id), 120000);
      // The pool paid for every fill: 3200.00 of income less 1650.00 filled.
      assert.equal(await balanceOf(env.unallocatedId), 320000 - 165000);
      assert.ok((await checkInvariant(db)).ok);

      const filled = await db.select().from(envelopeMoves).where(eq(envelopeMoves.note, FILLED_NOTE));
      assert.equal(filled.length, 4);
      assert.ok(filled.every((move) => move.kind === 'allocation'));
    });

    test('fills can be added by a later run, and a repeat adds none', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());

      const withGas = {
        ...mappingFor(),
        envelopes: {
          ...mappingFor().envelopes,
          'Vehicle:Insurance': { action: 'create' as const, name: 'Insurance', group: 'Vehicle' },
        },
      };
      const second = await commitMigration(db, planMigration([EXPORT, CATEGORY_EXPORT]), withGas);
      assert.equal(second.added, 0, 'the history is already in');
      assert.equal(second.fills, 4);

      const third = await commitMigration(db, planMigration([EXPORT, CATEGORY_EXPORT]), withGas);
      assert.equal(third.fills, 0);
      assert.equal(await balanceOf(env.gasId), 45000 - 11020);
    });

    test('a fill taken back out moves money back to the pool', async () => {
      const unfill = [
        'Date,Envelope,Account,Name,Notes,"Check #",Amount,Status,Details',
        '15/09/2026,Vehicle:Gas,[none],"Fill Envelopes",,,-20.00,,',
        '01/09/2026,Vehicle:Gas,[none],"Fill Envelopes",,,100.00,,',
      ].join('\n');
      await commitMigration(db, planMigration([EXPORT, unfill]), mappingFor());
      assert.equal(await balanceOf(env.gasId), 8000 - 11020);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a migration can be undone whole, envelope moves included (MG-6)', async () => {
      const { batchId } = await commitMigration(db, planMigration([EXPORT]), mappingFor());

      const removed = await revertMigration(db, batchId);
      assert.equal(removed, 6, 'four transactions plus both halves of the transfer');
      assert.equal((await db.select().from(transactions)).length, 0);
      assert.equal(await balanceOf(env.gasId), 0, 'and the envelope move went with them');
      assert.equal(await balanceOf(env.groceriesId), 0);
      assert.ok((await checkInvariant(db)).ok);
    });

    // -- reconciliation (MG-7) ---------------------------------------------

    test('reconciliation reports the gap the export cannot close', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());

      // What GoodBudget actually shows for these envelopes today.
      const report = await reconcile(db, {
        [env.gasId]: 15000,
        [env.groceriesId]: 22000,
      });

      const gas = report.lines.find((line) => line.envelopeId === env.gasId)!;
      assert.equal(gas.computedCents, -11020, 'spending only: nothing ever filled it');
      assert.equal(gas.expectedCents, 15000);
      assert.equal(gas.differenceCents, 26020);
      assert.equal(report.differenceCents, 26020 + 37745);
    });

    test('an envelope with no figure given is left alone and counted', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      const report = await reconcile(db, { [env.gasId]: 15000 });

      const groceries = report.lines.find((line) => line.envelopeId === env.groceriesId)!;
      assert.equal(groceries.expectedCents, null);
      assert.equal(groceries.differenceCents, 0);
      assert.equal(report.unanswered, 1, 'the pool is not counted as unanswered');
    });

    test('applying the adjustments makes the balances match, out of the pool', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      const before = await reconcile(db, { [env.gasId]: 15000, [env.groceriesId]: 22000 });

      const written = await applyReconciliation(
        db,
        before.lines.map((line) => ({
          envelopeId: line.envelopeId,
          differenceCents: line.differenceCents,
        })),
        { date: '2026-09-19' },
      );
      assert.equal(written, 2);

      assert.equal(await balanceOf(env.gasId), 15000);
      assert.equal(await balanceOf(env.groceriesId), 22000);
      assert.equal(
        await balanceOf(env.unallocatedId),
        320000 - 26020 - 37745,
        'the pool gave up exactly what the envelopes gained',
      );

      const after = await reconcile(db, { [env.gasId]: 15000, [env.groceriesId]: 22000 });
      assert.equal(after.differenceCents, 0);
      assert.ok((await checkInvariant(db)).ok, 'and the two ledgers still agree');
    });

    test('the pool cannot be adjusted against itself', async () => {
      await assert.rejects(
        () =>
          applyReconciliation(
            db,
            [{ envelopeId: env.unallocatedId, differenceCents: 100 }],
            { date: '2026-09-19' },
          ),
        MigrationError,
      );
    });

    test('adjustments show up in the envelope history as what they are', async () => {
      await commitMigration(db, planMigration([EXPORT]), mappingFor());
      await applyReconciliation(db, [{ envelopeId: env.gasId, differenceCents: 26020 }], {
        date: '2026-09-19',
      });

      const { envelopeHistory } = await import('../envelopes/manage.ts');
      const history = await envelopeHistory(db, env.gasId);
      const adjustment = history.find((event) => event.kind === 'allocation')!;
      assert.equal(adjustment.amountCents, 26020);
      // The note names what happened rather than the app it came from, because
      // it is read in the envelope's own history by the user (#11).
      assert.equal(adjustment.description, CARRIED_OVER_NOTE);
      assert.doesNotMatch(adjustment.description, /goodbudget/i);
    });
  },
);
