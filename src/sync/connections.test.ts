import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  bankConnections,
  bankFeedAccounts,
  syncHeldRows,
  transactionExternalIds,
  transactions,
} from '../../db/schema.ts';
import { checkInvariant, openAccount, recordTransaction } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import {
  ConnectionError,
  createLinkToken,
  linkConnection,
  listConnections,
  listHeld,
  resolveHeld,
  revokeConnection,
  setFeedAccount,
} from './connections.ts';
import { page, transaction } from './plaidFixtures.ts';
import { PlaidApiError, type PlaidCall } from './plaidClient.ts';
import { syncConnection } from './run.ts';
import { decryptSecret } from './secret.ts';

const available = await databaseAvailable();
const key = randomBytes(32);
const decrypt = (stored: string) => decryptSecret(stored, key);

/** A Plaid answering each path from a table, and noting what it was asked. */
function fakePlaid(answers: Record<string, (body: Record<string, unknown>) => string | PlaidApiError>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const call: PlaidCall = async (path, body) => {
    calls.push({ path, body });
    const answer = answers[path];
    if (!answer) throw new Error(`Nothing scripted for ${path}`);
    const result = answer(body);
    if (result instanceof PlaidApiError) throw result;
    return result;
  };
  return { call, calls };
}

const linking = {
  '/item/public_token/exchange': () => JSON.stringify({ access_token: 'access-sandbox-9', item_id: 'item-9' }),
  '/accounts/get': () =>
    JSON.stringify({
      accounts: [
        { account_id: 'plaid-chq', name: 'Chequing', mask: '1000', type: 'depository', subtype: 'checking' },
        { account_id: 'plaid-visa', name: 'Visa', mask: '2000', type: 'credit', subtype: 'credit card' },
      ],
      item: { institution_id: 'ins_42' },
    }),
  '/institutions/get_by_id': () => JSON.stringify({ institution: { name: 'A Canadian Bank' } }),
};

describe(
  'bank connections',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let chequing: string;
    let gasId: string;

    before(async () => {
      db = await setupTestDb('connections');
    });

    beforeEach(async () => {
      await truncateAll(db);
      gasId = (await seedEnvelopes(db)).gasId;
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
    });

    after(async () => {
      await closeDb(db);
    });

    const link = async () => {
      const plaid = fakePlaid(linking);
      return { id: await linkConnection(db, plaid.call, 'public-sandbox-1', key), plaid };
    };
    const feedNamed = async (name: string) =>
      (await db.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.name, name)))[0]!;

    test('linking stores the token encrypted and lists the accounts, none fed yet (FR-20)', async () => {
      const { id } = await link();
      const [connection] = await db.select().from(bankConnections);
      assert.equal(connection!.id, id);
      assert.equal(connection!.institutionName, 'A Canadian Bank');
      assert.ok(!connection!.accessToken!.includes('access-sandbox-9'), 'not stored readable');
      assert.equal(decrypt(connection!.accessToken!), 'access-sandbox-9');

      const [summary] = await listConnections(db);
      assert.deepEqual(
        summary!.accounts.map((a) => [a.name, a.mask, a.accountId]),
        [
          ['Chequing', '1000', null],
          ['Visa', '2000', null],
        ],
      );
    });

    test('a link token asks for transactions in Canada, or for the same login again', async () => {
      const { id } = await link();
      const plaid = fakePlaid({ '/link/token/create': () => JSON.stringify({ link_token: 'link-1' }) });
      assert.equal(await createLinkToken(db, plaid.call, { userId: 'u1' }), 'link-1');
      assert.deepEqual(plaid.calls[0]!.body.products, ['transactions']);
      assert.deepEqual(plaid.calls[0]!.body.country_codes, ['CA']);
      assert.equal(plaid.calls[0]!.body.access_token, undefined);

      await createLinkToken(db, plaid.call, { userId: 'u1', connectionId: id, decrypt });
      assert.equal(plaid.calls[1]!.body.access_token, 'access-sandbox-9', 'update mode keeps the connection');
      assert.equal(plaid.calls[1]!.body.products, undefined);
    });

    test('a link token names the webhook address only when there is one', async () => {
      const { id } = await link();
      const plaid = fakePlaid({ '/link/token/create': () => JSON.stringify({ link_token: 'link-1' }) });
      const webhook = 'https://manilla.example.ts.net/api/plaid/webhook';
      await createLinkToken(db, plaid.call, { userId: 'u1', webhook });
      await createLinkToken(db, plaid.call, { userId: 'u1', connectionId: id, decrypt, webhook });
      await createLinkToken(db, plaid.call, { userId: 'u1', webhook: null });
      assert.deepEqual(
        plaid.calls.map((c) => c.body.webhook),
        [webhook, webhook, undefined],
      );
    });

    test("a linked account starts the day of its latest statement row, and its history before that is left out", async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-20',
        amountCents: -1000,
        payeeRaw: 'FROM A STATEMENT',
        source: 'file_import',
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
        lines: [{ envelopeId: gasId, amountCents: -1000 }],
      });
      // Migrated history has no bank id, so it says nothing about where statements reached.
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-25',
        amountCents: -500,
        payeeRaw: 'MIGRATED',
        source: 'goodbudget',
      });
      const { id } = await link();
      const feed = await feedNamed('Chequing');
      assert.deepEqual(await setFeedAccount(db, feed.id, chequing), { startDate: '2026-09-20' });

      const plaid = fakePlaid({
        '/transactions/sync': () =>
          page({
            added: [
              transaction({ transaction_id: 'old', account_id: 'plaid-chq', date: '2026-09-19', amount: '7.00', name: 'OLD' }),
              // The statement's own row, the same day: linked, not added.
              transaction({ transaction_id: 'same', account_id: 'plaid-chq', date: '2026-09-20', amount: '10.00', name: 'X' }),
              transaction({ transaction_id: 'new', account_id: 'plaid-chq', date: '2026-09-28', amount: '3.00', name: 'NEW' }),
            ],
          }),
      });
      const report = await syncConnection(db, id, { call: plaid.call, key });
      assert.deepEqual(
        [report.accounts[0]!.added, report.accounts[0]!.linked, report.accounts[0]!.earlier],
        [1, 1, 1],
      );
      assert.equal((await db.select().from(transactions)).length, 3);
    });

    test('a line of credit cannot be fed: Plaid never syncs its transactions', async () => {
      await link();
      await db
        .update(bankFeedAccounts)
        .set({ type: 'loan', subtype: 'line of credit' })
        .where(eq(bankFeedAccounts.name, 'Visa'));
      await assert.rejects(setFeedAccount(db, (await feedNamed('Visa')).id, chequing), /does not sync transactions for a line of credit/);
    });

    test('only what Plaid syncs is offered', async () => {
      const { unsyncable } = await import('./connections.ts');
      assert.equal(unsyncable('depository', 'checking'), null);
      assert.equal(unsyncable('credit', 'credit card'), null);
      assert.equal(unsyncable('loan', 'mortgage'), null);
      assert.equal(unsyncable('loan', 'student'), null);
      assert.equal(unsyncable('loan', 'line of credit'), 'unsupported');
      assert.equal(unsyncable('loan', 'auto'), 'unsupported');
      assert.equal(unsyncable('investment', 'rrsp'), 'investment');
      assert.equal(unsyncable(null, null), null, 'unknown is tried, not hidden');
    });

    test('an investment account cannot be fed, since its holdings are not transactions', async () => {
      await link();
      await db.update(bankFeedAccounts).set({ type: 'investment' }).where(eq(bankFeedAccounts.name, 'Visa'));
      await assert.rejects(setFeedAccount(db, (await feedNamed('Visa')).id, chequing), /investment/);
    });

    test('with no statement rows, a feed starts at the latest transaction of any kind', async () => {
      // A migrated history has no bank ids to match on; two years of feed
      // history over it would count most of it twice.
      await recordTransaction(db, {
        accountId: chequing,
        date: '2025-06-10',
        amountCents: -500,
        payeeRaw: 'MIGRATED',
        source: 'goodbudget',
      });
      await link();
      assert.deepEqual(await setFeedAccount(db, (await feedNamed('Chequing')).id, chequing), {
        startDate: '2025-06-10',
      });
    });

    test('an empty account starts today, never with the whole history', async () => {
      await link();
      const { localToday } = await import('../budget/month.ts');
      assert.deepEqual(await setFeedAccount(db, (await feedNamed('Chequing')).id, chequing), {
        startDate: localToday(),
      });
    });

    test('one Manilla account takes one feed, since two would import everything twice', async () => {
      await link();
      await setFeedAccount(db, (await feedNamed('Chequing')).id, chequing);
      await assert.rejects(setFeedAccount(db, (await feedNamed('Visa')).id, chequing), ConnectionError);
      // Unlinking frees it.
      await setFeedAccount(db, (await feedNamed('Chequing')).id, null);
      await setFeedAccount(db, (await feedNamed('Visa')).id, chequing);
    });

    test('revoking tells Plaid, erases the token and frees the accounts, keeping what was imported', async () => {
      const { id } = await link();
      await setFeedAccount(db, (await feedNamed('Chequing')).id, chequing);
      await recordTransaction(db, { accountId: chequing, date: '2026-09-01', amountCents: -100, payeeRaw: 'KEPT', source: 'bank_sync' });

      const plaid = fakePlaid({ '/item/remove': () => '{}' });
      await revokeConnection(db, plaid.call, id, decrypt);
      assert.equal(plaid.calls[0]!.body.access_token, 'access-sandbox-9');

      const [connection] = await db.select().from(bankConnections);
      assert.equal(connection!.accessToken, null);
      assert.ok(connection!.revokedAt);
      assert.equal((await feedNamed('Chequing')).accountId, null);
      assert.deepEqual(await listConnections(db), []);
      assert.equal((await db.select().from(transactions)).length, 1);
    });

    test('a login Plaid has already forgotten is still revoked here', async () => {
      const { id } = await link();
      const gone = new PlaidApiError({ code: 'ITEM_NOT_FOUND', type: 'INVALID_INPUT', status: 400, message: 'gone' });
      await revokeConnection(db, fakePlaid({ '/item/remove': () => gone }).call, id, decrypt);
      assert.equal((await db.select().from(bankConnections))[0]!.accessToken, null);
    });

    describe('settling what a sync held back', () => {
      let feedId: string;
      let lookAlike: string;

      beforeEach(async () => {
        await link();
        feedId = (await feedNamed('Chequing')).id;
        lookAlike = await recordTransaction(db, {
          accountId: chequing,
          date: '2026-09-08',
          amountCents: -4520,
          payeeRaw: 'SHELL',
          source: 'goodbudget',
          status: 'confirmed',
          lines: [{ envelopeId: gasId, amountCents: -4520 }],
        });
      });

      const hold = async (fields: Partial<typeof syncHeldRows.$inferInsert> = {}) =>
        (
          await db
            .insert(syncHeldRows)
            .values({
              feedAccountId: feedId,
              accountId: chequing,
              reason: 'possible_duplicate',
              externalId: 'p-1',
              date: '2026-09-10',
              amountCents: -4520,
              payeeRaw: 'SHELL',
              transactionId: lookAlike,
              detail: 'Same amount and payee',
              ...fields,
            })
            .returning({ id: syncHeldRows.id })
        )[0]!.id;

      test('linking a look-alike gives the existing transaction the feed id', async () => {
        await resolveHeld(db, await hold(), 'link');
        const ids = await db.select().from(transactionExternalIds);
        assert.deepEqual(
          ids.map((row) => [row.transactionId, row.kind, row.value]),
          [[lookAlike, 'aggregator', 'p-1']],
        );
        assert.equal((await db.select().from(transactions)).length, 1);
        assert.deepEqual(await listHeld(db), []);
      });

      test('adding a look-alike imports it as its own transaction, for review', async () => {
        await resolveHeld(db, await hold(), 'add');
        const rows = await db.select().from(transactions);
        assert.equal(rows.length, 2);
        const added = rows.find((row) => row.id !== lookAlike)!;
        assert.equal(added.source, 'bank_sync');
        assert.equal(added.status, 'pending_review');
        assert.ok((await checkInvariant(db)).ok);
      });

      test('dismissing leaves everything as it was', async () => {
        await resolveHeld(db, await hold({ reason: 'withdrawn', transactionId: lookAlike }), 'dismiss');
        assert.equal((await db.select().from(transactions)).length, 1);
        assert.deepEqual(await listHeld(db), []);
      });

      test('only what makes sense for each is allowed, and only once', async () => {
        const changed = await hold({ reason: 'changed' });
        await assert.rejects(resolveHeld(db, changed, 'add'), /Only a look-alike or a rounded amount/);
        await assert.rejects(resolveHeld(db, changed, 'link'), /Only a look-alike/);
        await resolveHeld(db, changed, 'dismiss');
        await assert.rejects(resolveHeld(db, changed, 'dismiss'), /already been settled/);
      });

      test('the held list says which account each is in', async () => {
        await hold();
        const [row] = await listHeld(db);
        assert.equal(row!.accountName, 'Chequing');
        assert.equal(row!.amountCents, -4520);
        assert.deepEqual(row!.here, { payeeRaw: 'SHELL', date: '2026-09-08', amountCents: -4520 });
      });
    });
  },
);
