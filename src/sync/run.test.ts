import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  bankConnections,
  bankFeedAccounts,
  importBatches,
  syncHeldRows,
  transactionExternalIds,
  transactions,
} from '../../db/schema.ts';
import { checkInvariant, openAccount, recordTransaction } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { commitImport, previewImport } from '../import/ofxImport.ts';
import { page, transaction } from './plaidFixtures.ts';
import { PlaidApiError, type PlaidCall } from './plaidClient.ts';
import { syncConnection } from './run.ts';
import { connectionsDue } from './schedule.ts';
import { encryptSecret } from './secret.ts';

const available = await databaseAvailable();
const key = randomBytes(32);

/**
 * A Plaid that answers /transactions/sync from a script, one queue per
 * account, and records the cursor each request carried.
 */
function fakePlaid(script: Record<string, (string | PlaidApiError)[]>) {
  const requests: { account: string; cursor?: string }[] = [];
  const call: PlaidCall = async (path, body) => {
    assert.equal(path, '/transactions/sync');
    assert.equal(body.access_token, 'access-sandbox-1', 'the token is decrypted before use');
    const account = (body.options as { account_id: string }).account_id;
    requests.push({ account, ...(body.cursor ? { cursor: body.cursor as string } : {}) });
    const next = script[account]?.shift();
    if (next === undefined) throw new Error(`Nothing scripted for ${account}`);
    if (next instanceof PlaidApiError) throw next;
    return next;
  };
  return { call, requests };
}

/** A Plaid transaction in `plaid-chq`, the chequing feed. */
const chq = (fields: Record<string, unknown> & { amount: string }) =>
  transaction({ account_id: 'plaid-chq', ...fields });

describe(
  'a bank connection sync',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let chequing: string;
    let connectionId: string;
    let gasId: string;

    before(async () => {
      db = await setupTestDb('sync');
    });

    beforeEach(async () => {
      await truncateAll(db);
      gasId = (await seedEnvelopes(db)).gasId;
      chequing = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      const [connection] = await db
        .insert(bankConnections)
        .values({ provider: 'plaid', itemId: 'item-1', accessToken: encryptSecret('access-sandbox-1', key) })
        .returning({ id: bankConnections.id });
      connectionId = connection!.id;
      await db.insert(bankFeedAccounts).values([
        { connectionId, providerAccountId: 'plaid-chq', name: 'Chequing', accountId: chequing },
        // Seen by the connection, but nobody has said which account it is.
        { connectionId, providerAccountId: 'plaid-savings', name: 'Savings' },
      ]);
    });

    after(async () => {
      await closeDb(db);
    });

    const sync = (call: PlaidCall) => syncConnection(db, connectionId, { call, key });
    const held = () => db.select().from(syncHeldRows);
    const cursorOf = async () =>
      (await db.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.providerAccountId, 'plaid-chq')))[0]!
        .cursor;

    test('posted transactions are imported for review; pending ones wait; unlinked accounts are not fetched', async () => {
      const plaid = fakePlaid({
        'plaid-chq': [
          page({
            added: [
              chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '45.20', name: 'SHELL C04471' }),
              chq({ transaction_id: 'p-2', date: '2026-09-12', amount: '12.00', name: 'COFFEE', pending: true }),
            ],
            next_cursor: 'c1',
          }),
        ],
      });

      const report = await sync(plaid.call);
      assert.equal(report.error, undefined);
      assert.deepEqual(plaid.requests, [{ account: 'plaid-chq' }], 'savings is never asked for');
      assert.equal(report.accounts[0]!.added, 1);

      const rows = await db.select().from(transactions);
      assert.equal(rows.length, 1, 'the pending charge is not imported');
      assert.equal(rows[0]!.amountCents, -4520);
      assert.equal(rows[0]!.source, 'bank_sync');
      assert.equal(rows[0]!.status, 'pending_review', 'FR-17: it waits for review');
      const [batch] = await db.select().from(importBatches);
      assert.equal(batch!.source, 'bank_sync');
      assert.equal(await cursorOf(), 'c1');

      const [connection] = await db.select().from(bankConnections);
      assert.ok(connection!.lastSyncedAt);
      assert.ok((await checkInvariant(db)).ok);
    });

    test('a pending charge that posts arrives once, as its posting (FR-19)', async () => {
      const plaid = fakePlaid({
        'plaid-chq': [
          page({
            added: [chq({ transaction_id: 'pend-1', date: '2026-09-12', amount: '40.00', name: 'BISTRO', pending: true })],
            next_cursor: 'c1',
          }),
          page({
            added: [
              chq({
                transaction_id: 'post-1',
                date: '2026-09-14',
                amount: '46.00',
                name: 'BISTRO',
                pending_transaction_id: 'pend-1',
              }),
            ],
            removed: [{ transaction_id: 'pend-1', account_id: 'plaid-chq' }],
            next_cursor: 'c2',
          }),
        ],
      });
      await sync(plaid.call);
      await sync(plaid.call);

      assert.deepEqual(plaid.requests, [{ account: 'plaid-chq' }, { account: 'plaid-chq', cursor: 'c1' }]);
      const rows = await db.select().from(transactions);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.amountCents, -4600, 'the posted amount, tip and all');
      assert.equal(rows[0]!.date, '2026-09-14');
      assert.deepEqual(await held(), [], 'the pending removal is nothing to ask about');
    });

    test('changes fetched again after a failure add nothing twice (FR-11)', async () => {
      const changes = () =>
        page({ added: [chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '9.99', name: 'APP STORE' })], next_cursor: 'c1' });
      await sync(fakePlaid({ 'plaid-chq': [changes()] }).call);
      // As if the cursor had never been stored.
      await db.update(bankFeedAccounts).set({ cursor: null });
      const report = await sync(fakePlaid({ 'plaid-chq': [changes()] }).call);

      assert.equal((await db.select().from(transactions)).length, 1);
      assert.equal(report.accounts[0]!.added, 0);
      assert.equal((await db.select().from(importBatches)).length, 1, 'and no empty batch for the import log');
    });

    test('a statement file already holding the transaction gets the feed id, not a copy (FR-18)', async () => {
      const file = await previewImport(
        db,
        {
          transactions: [
            { fitId: 'FIT-1', type: 'DEBIT', posted: '2026-09-10', amountCents: -4520, name: 'SHELL C04471 CALGARY AB', warnings: [] },
          ],
        },
        chequing,
        { categorize: false },
      );
      await commitImport(db, file, new Map());

      const report = await sync(
        fakePlaid({
          'plaid-chq': [page({ added: [chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '45.20', name: 'Shell' })] })],
        }).call,
      );
      assert.equal(report.accounts[0]!.linked, 1);
      assert.equal((await db.select().from(transactions)).length, 1);
      const kinds = (await db.select().from(transactionExternalIds)).map((row) => row.kind).sort();
      assert.deepEqual(kinds, ['aggregator', 'fitid']);
    });

    test('a look-alike is held for a person, not dropped and not doubled', async () => {
      await recordTransaction(db, {
        accountId: chequing,
        date: '2026-09-08',
        amountCents: -4520,
        payeeRaw: 'SHELL C04471',
        source: 'goodbudget',
        status: 'confirmed',
        lines: [{ envelopeId: gasId, amountCents: -4520 }],
      });
      await sync(
        fakePlaid({
          'plaid-chq': [
            page({
              added: [chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '45.20', name: 'SHELL C04471' })],
              next_cursor: 'c1',
            }),
          ],
        }).call,
      );

      assert.equal((await db.select().from(transactions)).length, 1, 'not imported beside it');
      const [row] = await held();
      assert.equal(row!.reason, 'possible_duplicate');
      assert.equal(row!.externalId, 'p-1');
      assert.equal(row!.amountCents, -4520);
      assert.ok(row!.transactionId, 'it points at what it looks like');
      assert.equal(await cursorOf(), 'c1', 'and the sync moves on');
    });

    test('a row still waiting is not held a second time', async () => {
      const again = () => page({ added: [chq({ transaction_id: 'p-1', amount: '12.202726' })], next_cursor: 'c1' });
      await sync(fakePlaid({ 'plaid-chq': [again()] }).call);
      await db.update(bankFeedAccounts).set({ cursor: null });
      const report = await sync(fakePlaid({ 'plaid-chq': [again()] }).call);
      assert.equal((await held()).length, 1);
      assert.equal(report.accounts[0]!.held, 0);
    });

    test('an amount that had to be rounded is held, not imported', async () => {
      await sync(
        fakePlaid({ 'plaid-chq': [page({ added: [chq({ transaction_id: 'p-1', amount: '12.202726' })] })] }).call,
      );
      assert.equal((await db.select().from(transactions)).length, 0);
      const [row] = await held();
      assert.equal(row!.reason, 'rounded');
      assert.match(row!.detail, /rounded to 12\.20/);
    });

    test('the bank changing or withdrawing an imported transaction is held, never applied unseen', async () => {
      const plaid = fakePlaid({
        'plaid-chq': [
          page({
            added: [
              chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '20.00', name: 'A' }),
              chq({ transaction_id: 'p-2', date: '2026-09-10', amount: '30.00', name: 'B' }),
              chq({ transaction_id: 'p-3', date: '2026-09-10', amount: '50.00', name: 'C' }),
            ],
            next_cursor: 'c1',
          }),
          page({
            modified: [
              chq({ transaction_id: 'p-1', date: '2026-09-10', amount: '25.00', name: 'A' }),
              // Only the wording changed: nothing a person decided depends on it.
              chq({ transaction_id: 'p-2', date: '2026-09-10', amount: '30.00', name: 'B, reworded' }),
            ],
            removed: [{ transaction_id: 'p-3', account_id: 'plaid-chq' }],
            next_cursor: 'c2',
          }),
        ],
      });
      await sync(plaid.call);
      await sync(plaid.call);

      const rows = (await held()).sort((a, b) => a.reason.localeCompare(b.reason));
      assert.deepEqual(
        rows.map((row) => [row.reason, row.externalId]),
        [
          ['changed', 'p-1'],
          ['withdrawn', 'p-3'],
        ],
      );
      assert.match(rows[0]!.detail, /-25\.00 on 2026-09-10; here it is -20\.00/);
      const amounts = (await db.select().from(transactions)).map((row) => row.amountCents).sort((a, b) => a - b);
      assert.deepEqual(amounts, [-5000, -3000, -2000], 'nothing here changed by itself');
    });

    test('a login the bank wants again stops the sync, says why, and keeps the cursor', async () => {
      await db.update(bankFeedAccounts).set({ cursor: 'c0' }).where(eq(bankFeedAccounts.providerAccountId, 'plaid-chq'));
      const report = await sync(
        fakePlaid({
          'plaid-chq': [
            new PlaidApiError({ code: 'ITEM_LOGIN_REQUIRED', type: 'ITEM_ERROR', status: 400, message: 'login again' }),
          ],
        }).call,
      );
      assert.equal(report.error?.code, 'ITEM_LOGIN_REQUIRED');
      const [connection] = await db.select().from(bankConnections);
      assert.equal(connection!.errorCode, 'ITEM_LOGIN_REQUIRED');
      assert.equal(connection!.lastSyncedAt, null);
      assert.ok(connection!.lastAttemptAt);
      assert.equal(await cursorOf(), 'c0');

      // The next sync that works clears it.
      await sync(fakePlaid({ 'plaid-chq': [page({ next_cursor: 'c1' })] }).call);
      const [after] = await db.select().from(bankConnections);
      assert.equal(after!.errorCode, null);
    });

    test('a connection is due a day after its last attempt, unless it is waiting for its login', async () => {
      const now = new Date('2026-10-04T12:00:00Z');
      const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
      assert.deepEqual(await connectionsDue(db, now), [connectionId], 'never tried');

      await db.update(bankConnections).set({ lastAttemptAt: hoursAgo(3) });
      assert.deepEqual(await connectionsDue(db, now), []);
      await db.update(bankConnections).set({ lastAttemptAt: hoursAgo(21) });
      assert.deepEqual(await connectionsDue(db, now), [connectionId]);

      // A bank that was down is tried again tomorrow; a login only a person can fix is not.
      await db.update(bankConnections).set({ errorCode: 'INSTITUTION_DOWN' });
      assert.deepEqual(await connectionsDue(db, now), [connectionId]);
      await db.update(bankConnections).set({ errorCode: 'ITEM_LOGIN_REQUIRED' });
      assert.deepEqual(await connectionsDue(db, now), []);

      await db.update(bankConnections).set({ errorCode: null, accessToken: null, revokedAt: now });
      assert.deepEqual(await connectionsDue(db, now), []);
    });

    test('straight after connecting, nothing is ready yet: no error, no cursor, not called synced', async () => {
      const report = await sync(fakePlaid({ 'plaid-chq': [page({ next_cursor: '' })] }).call);
      assert.equal(report.error, undefined);
      assert.equal(report.accounts[0]!.notReady, true);
      assert.equal(await cursorOf(), null);
      const [connection] = await db.select().from(bankConnections);
      assert.equal(connection!.lastSyncedAt, null, 'the screen must not say "synced just now" with nothing in');
      assert.equal(connection!.errorCode, null);
      assert.equal((await db.select().from(importBatches)).length, 0);
    });

    test('a response that cannot be read stops the sync and is kept on the connection', async () => {
      const report = await sync(fakePlaid({ 'plaid-chq': ['{"added": "not a list"}'] }).call);
      assert.equal(report.error?.code, 'UNREADABLE_RESPONSE');
      const [connection] = await db.select().from(bankConnections);
      assert.equal(connection!.errorCode, 'UNREADABLE_RESPONSE');
      assert.match(connection!.errorMessage!, /has_more|not a list/);
    });

    test('a revoked connection fetches nothing', async () => {
      await db.update(bankConnections).set({ accessToken: null, revokedAt: new Date() });
      const plaid = fakePlaid({});
      const report = await sync(plaid.call);
      assert.equal(report.error?.code, 'REVOKED');
      assert.deepEqual(plaid.requests, []);
    });
  },
);
