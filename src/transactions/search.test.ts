import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../../db/client.ts';
import { recordAccountTransfer, recordTransaction } from '../ledger/ledger.ts';
import { createAccount } from '../accounts/manage.ts';
import {
  describeQuery,
  filterChoices,
  isEmptyQuery,
  searchTransactions,
  UNCATEGORIZED,
} from './search.ts';
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
  'transaction search (VW-5, VW-6)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let chequing: string;
    let visa: string;

    before(async () => {
      db = await setupTestDb('search');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      chequing = await createAccount(db, { name: 'Main Chequing', kind: 'chequing' });
      visa = await createAccount(db, { name: 'Visa', kind: 'credit_card' });
    });

    after(async () => {
      await closeDb(db);
    });

    /** A small but varied history: two accounts, a split, a transfer, a refund. */
    async function seedHistory(): Promise<void> {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-01-05',
        amountCents: -4250,
        payeeRaw: 'PETRO CANADA #4471',
        status: 'confirmed',
        source: 'file_import',
        lines: [{ envelopeId: env.gasId, amountCents: -4250 }],
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-02-11',
        amountCents: -18900,
        payeeRaw: 'COSTCO WHOLESALE',
        memo: 'monthly stock-up',
        status: 'confirmed',
        source: 'file_import',
        lines: [
          { envelopeId: env.groceriesId, amountCents: -15000 },
          { envelopeId: env.gasId, amountCents: -3900 },
        ],
      });
      await recordTransaction(db, {
        accountId: visa,
        date: '2026-02-20',
        amountCents: -6500,
        payeeRaw: 'SAFEWAY 2280',
        source: 'file_import',
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-03-01',
        amountCents: 250000,
        payeeRaw: 'PAYROLL DEPOSIT',
        status: 'confirmed',
        source: 'file_import',
        lines: [{ envelopeId: env.unallocatedId, amountCents: 250000 }],
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-03-08',
        amountCents: 4250,
        payeeRaw: 'PETRO CANADA #4471',
        memo: 'refund',
        status: 'confirmed',
        source: 'file_import',
        lines: [{ envelopeId: env.gasId, amountCents: 4250 }],
      });
      await recordAccountTransfer(db, {
        fromAccountId: chequing,
        toAccountId: visa,
        amountCents: 50000,
        date: '2026-03-15',
        payeeRaw: 'TFR-TO C C',
      });
    }

    test('an empty query returns everything, newest first', async () => {
      await seedHistory();
      const found = await searchTransactions(db);

      assert.equal(found.total, 7, 'five spending rows, one refund, and both transfer halves');
      assert.equal(found.rows.length, 7);
      assert.equal(found.rows[0]!.date, '2026-03-15');
      assert.equal(found.rows.at(-1)!.date, '2026-01-05');
      assert.equal(found.hasMore, false);
    });

    test('text matches the payee, the memo and the normalized key', async () => {
      await seedHistory();

      const byPayee = await searchTransactions(db, { text: 'petro' });
      assert.equal(byPayee.total, 2, 'the charge and its refund');

      const byMemo = await searchTransactions(db, { text: 'stock-up' });
      assert.equal(byMemo.total, 1);
      assert.equal(byMemo.rows[0]!.payeeRaw, 'COSTCO WHOLESALE');

      // The stored key is normalized ("SAFEWAY 2280" -> "SAFEWAY"), so searching
      // the tidied-up name finds a row whose raw text still has the store number.
      const byKey = await searchTransactions(db, { text: 'SAFEWAY' });
      assert.equal(byKey.total, 1);
    });

    test('a % in the search text is a literal, not a wildcard', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-04-01',
        amountCents: -1000,
        payeeRaw: '100% SMOOTHIE CO',
        source: 'manual',
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-04-02',
        amountCents: -2000,
        payeeRaw: 'ANYTHING ELSE',
        source: 'manual',
      });

      const found = await searchTransactions(db, { text: '%' });
      assert.equal(found.total, 1, 'one payee actually contains a percent sign');
      assert.equal(found.rows[0]!.payeeRaw, '100% SMOOTHIE CO');
    });

    test('the amount range is on the size, so a refund matches its charge', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { minCents: 4000, maxCents: 5000 });

      assert.equal(found.total, 2, '-42.50 and +42.50 are both $42.50 in size');
      assert.deepEqual(
        found.rows.map((row) => row.amountCents).sort((a, b) => a - b),
        [-4250, 4250],
      );
    });

    test('direction separates money in from money out', async () => {
      await seedHistory();

      const out = await searchTransactions(db, { direction: 'out' });
      const inbound = await searchTransactions(db, { direction: 'in' });

      assert.equal(out.total, 4, 'three purchases and the leaving half of the transfer');
      assert.equal(inbound.total, 3, 'payroll, the refund, and the arriving half');
      assert.ok(out.rows.every((row) => row.amountCents < 0));
      assert.ok(inbound.rows.every((row) => row.amountCents > 0));
    });

    test('filtering by envelope finds a split by any of its shares', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { envelopeIds: [env.groceriesId] });

      assert.equal(found.total, 1);
      const [row] = found.rows;
      // The whole transaction comes back, not the matching share: this is the
      // ledger view. RP-5's share arithmetic belongs to the reports.
      assert.equal(row!.amountCents, -18900);
      assert.deepEqual(row!.envelopeNames, ['Gas', 'Groceries'], 'smallest share first');
    });

    test('"no envelope" finds transfers and unreviewed rows (VW-6)', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { envelopeIds: [UNCATEGORIZED] });

      assert.equal(found.total, 3, 'the uncategorized Safeway charge and both transfer halves');
      assert.ok(found.rows.every((row) => row.envelopeNames.length === 0));
    });

    test('envelope filters combine as "any of these"', async () => {
      await seedHistory();
      const found = await searchTransactions(db, {
        envelopeIds: [env.groceriesId, UNCATEGORIZED],
      });
      assert.equal(found.total, 4, 'the split, plus the three rows with no envelope');
    });

    test('a whole group of envelopes can be filtered at once', async () => {
      await seedHistory();
      const { createGroup, createEnvelope, editEnvelope } = await import('../envelopes/manage.ts');

      // Move Gas into its own group; Groceries stays in the seeded one.
      const vehicle = await createGroup(db, 'Vehicle');
      await editEnvelope(db, env.gasId, { groupId: vehicle });

      const byGroup = await searchTransactions(db, { envelopeGroupIds: [vehicle] });
      assert.equal(byGroup.total, 3, 'the fuel charge, its refund, and the split with a fuel share');

      const spare = await createEnvelope(db, { groupId: vehicle, name: 'Parking' });
      assert.ok(spare, 'an envelope with nothing in it adds nothing to the group');
      assert.equal((await searchTransactions(db, { envelopeGroupIds: [vehicle] })).total, 3);
    });

    test('a whole category of accounts can be filtered at once', async () => {
      await seedHistory();
      const { createAccountGroup, moveAccountToGroup } = await import('../accounts/groups.ts');

      const cards = await createAccountGroup(db, 'Cards');
      await moveAccountToGroup(db, visa, cards);

      const found = await searchTransactions(db, { accountGroupIds: [cards] });
      assert.equal(found.total, 2, 'everything in the Visa, and nothing from the chequing account');
      assert.ok(found.rows.every((row) => row.accountName === 'Visa'));
    });

    test('payee and memo can be searched apart from each other', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-04-01',
        amountCents: -1000,
        payeeRaw: 'WINDJAMMERS CAFE',
        source: 'manual',
      });
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-04-02',
        amountCents: -2000,
        payeeRaw: 'COSTCO WHOLESALE',
        memo: 'Windjammers',
        source: 'manual',
      });

      // The combined box finds both, which is what a quick search is for.
      assert.equal((await searchTransactions(db, { text: 'windjammers' })).total, 2);

      const byPayee = await searchTransactions(db, { payee: 'windjammers' });
      assert.equal(byPayee.total, 1);
      assert.equal(byPayee.rows[0]!.payeeRaw, 'WINDJAMMERS CAFE');

      const byMemo = await searchTransactions(db, { memo: 'windjammers' });
      assert.equal(byMemo.total, 1);
      assert.equal(byMemo.rows[0]!.payeeRaw, 'COSTCO WHOLESALE');
    });

    test('an account filter is what the account view runs (VW-5)', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { accountIds: [visa] });

      assert.equal(found.total, 2, 'the Safeway charge and the arriving transfer half');
      assert.ok(found.rows.every((row) => row.accountName === 'Visa'));
    });

    test('filters stack, and dates are inclusive at both ends', async () => {
      await seedHistory();
      const found = await searchTransactions(db, {
        accountIds: [chequing],
        from: '2026-02-11',
        to: '2026-03-01',
        direction: 'out',
      });

      assert.equal(found.total, 1);
      assert.equal(found.rows[0]!.date, '2026-02-11');
    });

    test('status finds what is still waiting to be reviewed', async () => {
      await seedHistory();
      const pending = await searchTransactions(db, { status: 'pending_review' });
      assert.equal(pending.total, 1);
      assert.equal(pending.rows[0]!.payeeRaw, 'SAFEWAY 2280');
    });

    test('kind isolates the transfers, which are never spending (FR-5)', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { kind: 'account_transfer' });

      assert.equal(found.total, 2);
      assert.ok(found.rows.every((row) => row.transferPairId !== null));
      assert.equal(
        new Set(found.rows.map((row) => row.transferPairId)).size,
        1,
        'both halves share one pair id',
      );
    });

    test('totals describe every match, not just the page', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { limit: 2 });

      assert.equal(found.rows.length, 2);
      assert.equal(found.total, 7);
      assert.equal(found.hasMore, true);
      assert.equal(found.outCents, 4250 + 18900 + 6500 + 50000);
      assert.equal(found.inCents, 250000 + 4250 + 50000);
      assert.equal(found.totalCents, found.inCents - found.outCents);
    });

    test('paging walks the whole result without repeating or dropping a row', async () => {
      await seedHistory();
      const seen: string[] = [];

      for (let offset = 0; ; offset += 3) {
        const page = await searchTransactions(db, { limit: 3, offset });
        seen.push(...page.rows.map((row) => row.id));
        if (!page.hasMore) break;
      }

      assert.equal(seen.length, 7);
      assert.equal(new Set(seen).size, 7, 'no row appears on two pages');
    });

    test('sorting by amount is by size, biggest first', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { sort: 'amount', order: 'desc' });
      const sizes = found.rows.map((row) => Math.abs(row.amountCents));
      assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
      assert.equal(sizes[0], 250000);
    });

    test('sorting by payee groups a merchant together whatever the bank wrote', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { sort: 'payee', order: 'asc' });
      const names = found.rows.map((row) => row.payeeRaw);

      const first = names.indexOf('PETRO CANADA #4471');
      const last = names.lastIndexOf('PETRO CANADA #4471');
      assert.equal(last - first, 1, 'both Petro Canada rows are adjacent');
    });

    test('a query that matches nothing is empty rather than an error', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { text: 'nothing called this' });

      assert.equal(found.total, 0);
      assert.equal(found.rows.length, 0);
      assert.equal(found.totalCents, 0);
      assert.equal(found.hasMore, false);
    });

    test('the limit is clamped, so a hand-edited URL cannot ask for everything', async () => {
      await seedHistory();
      const found = await searchTransactions(db, { limit: 100_000 });
      assert.equal(found.limit, 500);
    });

    test('filter choices list live envelopes and every account', async () => {
      await seedHistory();
      const choices = await filterChoices(db);

      assert.deepEqual(
        choices.accounts.map((account) => account.name),
        ['Main Chequing', 'Visa'],
      );
      assert.ok(choices.envelopes.some((envelope) => envelope.name === 'Groceries'));
      assert.ok(choices.envelopes.every((envelope) => envelope.groupName === 'Living'));
      assert.deepEqual(
        choices.envelopeGroups.map((group) => group.name),
        ['Living'],
      );
      assert.deepEqual(choices.accountGroups, [], 'no categories of account made yet');
    });
  },
);

describe('describing a query', () => {
  test('an empty query says so', () => {
    assert.equal(describeQuery({}), 'Everything, newest first');
    assert.ok(isEmptyQuery({}));
    assert.ok(isEmptyQuery({ text: '   ' }));
    assert.ok(isEmptyQuery({ payee: '', memo: '   ', envelopeGroupIds: [], accountGroupIds: [] }));
    assert.ok(!isEmptyQuery({ envelopeGroupIds: ['g1'] }));
    assert.ok(!isEmptyQuery({ accountGroupIds: ['g1'] }));
    assert.ok(!isEmptyQuery({ memo: 'blender' }));
  });

  test('a filled query reads as a sentence', () => {
    const described = describeQuery(
      {
        text: 'costco',
        direction: 'out',
        minCents: 5000,
        maxCents: 20000,
        from: '2026-01-01',
        to: '2026-03-31',
        envelopeIds: ['e1', UNCATEGORIZED],
      },
      { envelopes: new Map([['e1', 'Groceries']]) },
    );

    assert.equal(
      described,
      'Transactions matching “costco”, money out, from Groceries or no envelope, ' +
        'between $50.00 and $200.00, between 2026-01-01 and 2026-03-31',
    );
    assert.ok(!isEmptyQuery({ text: 'costco' }));
  });
});
