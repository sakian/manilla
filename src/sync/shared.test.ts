import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { bankConnections, bankFeedAccounts, transactions } from '../../db/schema.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { linkConnection } from './connections.ts';
import { page, transaction } from './plaidFixtures.ts';
import type { PlaidCall } from './plaidClient.ts';
import { decryptSecret } from './secret.ts';
import {
  chooseFeedAccount,
  fedElsewhere,
  feedKey,
  revokeEverywhere,
  syncEverywhere,
  type LedgerHandle,
} from './shared.ts';

const available = await databaseAvailable();
const key = randomBytes(32);
const decrypt = (stored: string) => decryptSecret(stored, key);

/** A Plaid for one login holding a personal chequing account and a business one. */
function fakePlaid() {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const call: PlaidCall = async (path, body) => {
    calls.push({ path, body });
    switch (path) {
      case '/item/public_token/exchange':
        return JSON.stringify({ access_token: 'access-1', item_id: 'item-1' });
      case '/accounts/get':
        return JSON.stringify({
          accounts: [
            { account_id: 'plaid-chq', name: 'Chequing', mask: '1000', type: 'depository', subtype: 'checking' },
            { account_id: 'plaid-biz', name: 'Business', mask: '3000', type: 'depository', subtype: 'checking' },
          ],
          item: { institution_id: null },
        });
      case '/transactions/sync': {
        const account = (body.options as { account_id: string }).account_id;
        return page({
          added: [
            transaction({ transaction_id: `${account}-1`, account_id: account, date: '2026-09-30', amount: '10.00', name: account }),
          ],
          next_cursor: `${account}-c1`,
        });
      }
      case '/item/remove':
        return '{}';
    }
    throw new Error(`Nothing scripted for ${path}`);
  };
  return { call, calls };
}

describe(
  'a connection shared between ledgers',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let personal: LedgerHandle;
    let business: LedgerHandle;
    let all: LedgerHandle[];
    let chequing: string;
    let operating: string;
    let connectionId: string;
    let plaid: ReturnType<typeof fakePlaid>;

    before(async () => {
      personal = { key: 'personal', name: 'Personal', db: await setupTestDb('shared_personal') };
      business = { key: 'business', name: 'Business', db: await setupTestDb('shared_business') };
      all = [personal, business];
    });

    beforeEach(async () => {
      await truncateAll(personal.db);
      await truncateAll(business.db);
      chequing = await openAccount(personal.db, { name: 'Chequing', kind: 'chequing' });
      operating = await openAccount(business.db, { name: 'Operating', kind: 'chequing' });
      // Both accounts' statements reach the 20th.
      await recordTransaction(personal.db, {
        accountId: chequing,
        date: '2026-09-20',
        amountCents: -100,
        payeeRaw: 'FROM A STATEMENT',
        source: 'file_import',
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
      });
      await recordTransaction(business.db, {
        accountId: operating,
        date: '2026-09-20',
        amountCents: -100,
        payeeRaw: 'FROM A STATEMENT',
        source: 'file_import',
        externalIds: [{ kind: 'fitid', value: 'FIT-1' }],
      });
      plaid = fakePlaid();
      connectionId = await linkConnection(personal.db, plaid.call, 'public-1', key);
    });

    after(async () => {
      await closeDb(personal.db);
      await closeDb(business.db);
    });

    const feedIn = async (db: Database, providerAccountId: string) =>
      (await db.select().from(bankFeedAccounts).where(eq(bankFeedAccounts.providerAccountId, providerAccountId)))[0];

    test('feeding an account in another ledger copies the connection there, token and all', async () => {
      const biz = (await feedIn(personal.db, 'plaid-biz'))!;
      const { startDate } = await chooseFeedAccount(all, personal, biz.id, { ledgerKey: 'business', accountId: operating });
      assert.equal(startDate, '2026-09-20', "from the business account's own statements");

      const [copy] = await business.db.select().from(bankConnections);
      const [original] = await personal.db.select().from(bankConnections);
      assert.equal(copy!.itemId, original!.itemId);
      assert.equal(decrypt(copy!.accessToken!), 'access-1');
      assert.equal((await feedIn(business.db, 'plaid-biz'))!.accountId, operating);
      assert.equal((await feedIn(business.db, 'plaid-chq'))!.accountId, null, 'the rest are listed, not fed');
      assert.equal((await feedIn(personal.db, 'plaid-biz'))!.accountId, null);

      const elsewhere = await fedElsewhere(personal, all, ['item-1']);
      assert.deepEqual(elsewhere.get(feedKey('item-1', 'plaid-biz')), {
        ledgerKey: 'business',
        ledgerName: 'Business',
        accountId: operating,
        accountName: 'Operating',
        startDate: '2026-09-20',
      });
    });

    test('one bank account feeds one ledger: choosing it in one frees it in the other', async () => {
      const biz = (await feedIn(personal.db, 'plaid-biz'))!;
      await chooseFeedAccount(all, personal, biz.id, { ledgerKey: 'business', accountId: operating });
      const spare = await openAccount(personal.db, { name: 'Spare', kind: 'chequing' });
      await chooseFeedAccount(all, personal, biz.id, { ledgerKey: 'personal', accountId: spare });

      assert.equal((await feedIn(personal.db, 'plaid-biz'))!.accountId, spare);
      assert.equal((await feedIn(business.db, 'plaid-biz'))!.accountId, null);
      assert.equal((await business.db.select().from(bankConnections)).length, 1, 'the copy stays, unfed');

      await chooseFeedAccount(all, personal, biz.id, null);
      assert.equal((await feedIn(personal.db, 'plaid-biz'))!.accountId, null);
    });

    test('a sync from either ledger brings each ledger its own accounts', async () => {
      await chooseFeedAccount(all, personal, (await feedIn(personal.db, 'plaid-chq'))!.id, {
        ledgerKey: 'personal',
        accountId: chequing,
      });
      await chooseFeedAccount(all, personal, (await feedIn(personal.db, 'plaid-biz'))!.id, {
        ledgerKey: 'business',
        accountId: operating,
      });

      const reports = await syncEverywhere(all, personal, connectionId, { call: plaid.call, key });
      assert.deepEqual(
        reports.map(({ ledger, report }) => [ledger.key, report.accounts.map((a) => a.added)]),
        [
          ['personal', [1]],
          ['business', [1]],
        ],
      );
      const payees = async (db: Database) => (await db.select().from(transactions)).map((t) => t.payeeRaw).sort();
      assert.deepEqual(await payees(personal.db), ['FROM A STATEMENT', 'plaid-chq']);
      assert.deepEqual(await payees(business.db), ['FROM A STATEMENT', 'plaid-biz']);
    });

    test('disconnecting tells Plaid once and forgets every copy', async () => {
      await chooseFeedAccount(all, personal, (await feedIn(personal.db, 'plaid-biz'))!.id, {
        ledgerKey: 'business',
        accountId: operating,
      });
      await revokeEverywhere(all, personal, connectionId, plaid.call, decrypt);

      assert.equal(plaid.calls.filter((c) => c.path === '/item/remove').length, 1);
      for (const ledger of all) {
        const [row] = await ledger.db.select().from(bankConnections);
        assert.ok(row!.revokedAt, ledger.key);
        assert.equal(row!.accessToken, null);
      }
      assert.equal((await feedIn(business.db, 'plaid-biz'))!.accountId, null);
    });
  },
);
