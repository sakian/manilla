import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { bankConnections } from '../../db/schema.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { PlaidApiError, type PlaidCall } from './plaidClient.ts';
import { encryptSecret } from './secret.ts';
import {
  liveCopiesOf,
  parseWebhook,
  plaidKeys,
  registerWebhooks,
  verifyWebhook,
  wantsSync,
  webhookUrlFromEnv,
  type KeySource,
  type PlaidKey,
} from './webhook.ts';

/** A key pair standing in for Plaid's, its public half as /webhook_verification_key/get gives it. */
function plaidKeyPair(): { privateKey: KeyObject; key: PlaidKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey,
    key: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, expired_at: null },
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The Plaid-Verification header Plaid would send with `body`. */
function signedToken(
  body: string,
  privateKey: KeyObject,
  options: { kid?: string; alg?: string; iat?: number; bodyHash?: string } = {},
): string {
  const header = b64({ alg: options.alg ?? 'ES256', kid: options.kid ?? 'key-1', typ: 'JWT' });
  const payload = b64({
    iat: options.iat ?? Math.floor(Date.now() / 1000),
    request_body_sha256: options.bodyHash ?? createHash('sha256').update(body).digest('hex'),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

// Plaid's own formatting, which is what the hash covers.
const BODY = JSON.stringify(
  {
    environment: 'sandbox',
    historical_update_complete: true,
    initial_update_complete: true,
    item_id: 'item-1',
    webhook_code: 'SYNC_UPDATES_AVAILABLE',
    webhook_type: 'TRANSACTIONS',
  },
  null,
  2,
);

describe('checking a webhook is from Plaid', () => {
  const plaid = plaidKeyPair();
  const asked: string[] = [];
  const keys: KeySource = async (kid) => {
    asked.push(kid);
    return kid === 'key-1' ? plaid.key : null;
  };
  beforeEach(() => {
    asked.length = 0;
  });

  test('a webhook Plaid signed is accepted', async () => {
    assert.deepEqual(await verifyWebhook(BODY, signedToken(BODY, plaid.privateKey), keys), { ok: true });
  });

  test('a body changed after signing is refused', async () => {
    const token = signedToken(BODY, plaid.privateKey);
    const verdict = await verifyWebhook(BODY.replace('item-1', 'item-2'), token, keys);
    assert.equal(verdict.ok, false);
  });

  test('so is the same body with its whitespace changed, since the hash is of the bytes', async () => {
    const verdict = await verifyWebhook(JSON.stringify(JSON.parse(BODY)), signedToken(BODY, plaid.privateKey), keys);
    assert.equal(verdict.ok, false);
  });

  test('one signed by some other key is refused', async () => {
    const stranger = plaidKeyPair();
    const verdict = await verifyWebhook(BODY, signedToken(BODY, stranger.privateKey), keys);
    assert.deepEqual(verdict, { ok: false, reason: 'the signature does not match' });
  });

  test('one more than five minutes old, or from the future, is refused', async () => {
    const now = Date.now();
    const stale = signedToken(BODY, plaid.privateKey, { iat: Math.floor(now / 1000) - 301 });
    const early = signedToken(BODY, plaid.privateKey, { iat: Math.floor(now / 1000) + 301 });
    assert.equal((await verifyWebhook(BODY, stale, keys, now)).ok, false);
    assert.equal((await verifyWebhook(BODY, early, keys, now)).ok, false);
    const recent = signedToken(BODY, plaid.privateKey, { iat: Math.floor(now / 1000) - 240 });
    assert.equal((await verifyWebhook(BODY, recent, keys, now)).ok, true);
  });

  test('a token choosing another algorithm is refused without asking Plaid for a key', async () => {
    for (const alg of ['none', 'HS256', 'RS256']) {
      const verdict = await verifyWebhook(BODY, signedToken(BODY, plaid.privateKey, { alg }), keys);
      assert.equal(verdict.ok, false, alg);
    }
    assert.deepEqual(asked, []);
  });

  test('what can be checked without Plaid is, so made-up requests cost no Plaid call', async () => {
    const old = signedToken(BODY, plaid.privateKey, { kid: 'invented', iat: 1 });
    const otherBody = signedToken(BODY, plaid.privateKey, { kid: 'invented', bodyHash: 'ab'.repeat(32) });
    for (const token of [null, '', 'not-a-jwt', 'a.b.c', old, otherBody]) {
      assert.equal((await verifyWebhook(BODY, token, keys)).ok, false, String(token));
    }
    assert.deepEqual(asked, []);
  });

  test('a key Plaid does not know, or has expired, is refused', async () => {
    const unknown = await verifyWebhook(BODY, signedToken(BODY, plaid.privateKey, { kid: 'key-9' }), keys);
    assert.deepEqual(unknown, { ok: false, reason: 'Plaid has no key key-9' });

    const expired: KeySource = async () => ({ ...plaid.key, expired_at: 1_700_000_000 });
    const verdict = await verifyWebhook(BODY, signedToken(BODY, plaid.privateKey), expired);
    assert.deepEqual(verdict, { ok: false, reason: 'key key-1 has expired' });
  });
});

describe("Plaid's verification keys", () => {
  const plaid = plaidKeyPair();

  function keyService() {
    const asked: string[] = [];
    const call: PlaidCall = async (path, body) => {
      assert.equal(path, '/webhook_verification_key/get');
      const kid = String(body.key_id);
      asked.push(kid);
      if (kid === 'down') {
        throw new PlaidApiError({ code: 'INTERNAL_SERVER_ERROR', type: 'API_ERROR', status: 500, message: 'oops' });
      }
      if (!kid.startsWith('key-')) {
        throw new PlaidApiError({
          code: 'INVALID_WEBHOOK_VERIFICATION_KEY_ID',
          type: 'INVALID_INPUT',
          status: 400,
          message: 'invalid key_id provided',
        });
      }
      return JSON.stringify({ key: { ...plaid.key, kid, alg: 'ES256', use: 'sig', created_at: 1 }, request_id: 'r' });
    };
    return { call, asked };
  }

  test('a key is fetched once and then remembered', async () => {
    const service = keyService();
    const keys = plaidKeys(service.call);
    assert.equal((await keys('key-1'))?.x, plaid.key.x);
    assert.equal((await keys('key-1'))?.x, plaid.key.x);
    assert.deepEqual(service.asked, ['key-1']);
  });

  test('an id Plaid never issued is remembered as none', async () => {
    const service = keyService();
    const keys = plaidKeys(service.call);
    assert.equal(await keys('made-up'), null);
    assert.equal(await keys('made-up'), null);
    assert.deepEqual(service.asked, ['made-up']);
  });

  test('only so many new ids are looked up an hour', async () => {
    const service = keyService();
    let now = 0;
    const keys = plaidKeys(service.call, { lookupsPerHour: 3, now: () => now });
    for (const kid of ['a', 'b', 'c', 'd', 'e']) await keys(kid);
    assert.deepEqual(service.asked, ['a', 'b', 'c']);
    now += 60 * 60 * 1000 + 1;
    await keys('key-1');
    assert.deepEqual(service.asked, ['a', 'b', 'c', 'key-1'], 'and more again the next hour');
  });

  test('a key is asked about again after a day, in case Plaid expired it', async () => {
    const service = keyService();
    let now = 0;
    const keys = plaidKeys(service.call, { now: () => now });
    await keys('key-1');
    now += 24 * 60 * 60 * 1000 + 1;
    await keys('key-1');
    assert.deepEqual(service.asked, ['key-1', 'key-1']);
  });

  test('Plaid failing is not taken as the key not existing', async () => {
    const service = keyService();
    const keys = plaidKeys(service.call);
    await assert.rejects(keys('down'), PlaidApiError);
    await assert.rejects(keys('down'), PlaidApiError, 'and is asked again next time');
  });
});

describe('what a webhook asks for', () => {
  test('the parts acted on are read from the body', () => {
    assert.deepEqual(parseWebhook(BODY), { type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE', itemId: 'item-1' });
    assert.deepEqual(
      parseWebhook(
        JSON.stringify({
          webhook_type: 'ITEM',
          webhook_code: 'ERROR',
          item_id: 'item-1',
          error: { error_code: 'ITEM_LOGIN_REQUIRED', error_type: 'ITEM_ERROR' },
        }),
      ),
      { type: 'ITEM', code: 'ERROR', itemId: 'item-1', errorCode: 'ITEM_LOGIN_REQUIRED' },
    );
    assert.equal(parseWebhook('not json'), null);
    assert.equal(parseWebhook(JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'X' })), null);
  });

  test('new transactions and a broken login are synced; the rest is acknowledged and left', () => {
    const hook = (type: string, code: string) => ({ type, code, itemId: 'item-1' });
    assert.equal(wantsSync(hook('TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE')), true);
    assert.equal(wantsSync(hook('ITEM', 'ERROR')), true);
    // The older webhooks Plaid sends alongside, for /transactions/get.
    assert.equal(wantsSync(hook('TRANSACTIONS', 'DEFAULT_UPDATE')), false);
    assert.equal(wantsSync(hook('ITEM', 'NEW_ACCOUNTS_AVAILABLE')), false);
    assert.equal(wantsSync(hook('ITEM', 'PENDING_EXPIRATION')), false);
    assert.equal(wantsSync(hook('ITEM', 'WEBHOOK_UPDATE_ACKNOWLEDGED')), false);
  });

  test('the address is used only when it is https', () => {
    const url = 'https://manilla.example.ts.net/api/plaid/webhook';
    assert.equal(webhookUrlFromEnv({ PLAID_WEBHOOK_URL: url }), url);
    assert.equal(webhookUrlFromEnv({ PLAID_WEBHOOK_URL: ` ${url} ` }), url);
    assert.equal(webhookUrlFromEnv({}), null);
    assert.equal(webhookUrlFromEnv({ PLAID_WEBHOOK_URL: '' }), null);
    assert.equal(webhookUrlFromEnv({ PLAID_WEBHOOK_URL: 'http://localhost:3000/api/plaid/webhook' }), null);
    assert.equal(webhookUrlFromEnv({ PLAID_WEBHOOK_URL: 'manilla.example.ts.net' }), null);
  });
});

const available = await databaseAvailable();

describe(
  'webhooks and the connections they are about',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    const key = randomBytes(32);
    const url = 'https://manilla.example.ts.net/api/plaid/webhook';
    let personal: Database;
    let business: Database;

    before(async () => {
      personal = await setupTestDb('webhook_personal');
      business = await setupTestDb('webhook_business');
    });

    beforeEach(async () => {
      await truncateAll(personal);
      await truncateAll(business);
    });

    after(async () => {
      await closeDb(personal);
      await closeDb(business);
    });

    const connect = async (
      db: Database,
      itemId: string,
      fields: Partial<typeof bankConnections.$inferInsert> = {},
    ) =>
      (
        await db
          .insert(bankConnections)
          .values({ provider: 'plaid', itemId, accessToken: encryptSecret(`access-${itemId}`, key), ...fields })
          .returning({ id: bankConnections.id })
      )[0]!.id;

    test('a webhook syncs the live copies of its login, and nothing else', async () => {
      const mine = await connect(personal, 'item-1');
      await connect(personal, 'item-2');
      await connect(personal, 'item-1-old', { revokedAt: new Date(), accessToken: null });
      const theirs = await connect(business, 'item-1');

      assert.deepEqual(await liveCopiesOf('item-1')(personal), [mine]);
      assert.deepEqual(await liveCopiesOf('item-1')(business), [theirs]);
      assert.deepEqual(await liveCopiesOf('item-9')(personal), []);
    });

    test('a login waiting for someone to sign in again is left to them', async () => {
      await connect(personal, 'item-1', { errorCode: 'ITEM_LOGIN_REQUIRED' });
      const other = await connect(business, 'item-1', { errorCode: 'PRODUCT_NOT_READY' });
      assert.deepEqual(await liveCopiesOf('item-1')(personal), []);
      assert.deepEqual(await liveCopiesOf('item-1')(business), [other], 'another error is worth a sync');
    });

    test('each live login is pointed at the address once, however many ledgers hold it', async () => {
      await connect(personal, 'item-1');
      await connect(business, 'item-1');
      await connect(personal, 'item-2');
      await connect(personal, 'item-3');
      await connect(personal, 'item-gone', { revokedAt: new Date(), accessToken: null });

      const asked: { path: string; token: unknown; webhook?: unknown }[] = [];
      const call: PlaidCall = async (path, body) => {
        asked.push({ path, token: body.access_token, ...(body.webhook ? { webhook: body.webhook } : {}) });
        if (path === '/item/get') {
          // item-2 is already pointed here; item-3 has been revoked at the bank.
          if (body.access_token === 'access-item-3') {
            throw new PlaidApiError({ code: 'ITEM_NOT_FOUND', type: 'ITEM_ERROR', status: 400, message: 'gone' });
          }
          return JSON.stringify({ item: { webhook: body.access_token === 'access-item-2' ? url : '' } });
        }
        return JSON.stringify({ item: {} });
      };
      const logged: string[] = [];
      const result = await registerWebhooks([personal, business], url, { call, key }, (line) => logged.push(line));

      assert.deepEqual(result, { updated: 1, failed: 1 });
      assert.deepEqual(
        asked.filter((a) => a.path === '/item/webhook/update'),
        [{ path: '/item/webhook/update', token: 'access-item-1', webhook: url }],
      );
      assert.equal(asked.filter((a) => a.token === 'access-item-1').length, 2, 'one /item/get, one update');
      assert.equal(logged.length, 1);
      assert.doesNotMatch(logged[0]!, /access-/, 'no token in the log');

      const [kept] = await personal.select().from(bankConnections).where(eq(bankConnections.itemId, 'item-3'));
      assert.equal(kept!.revokedAt, null, 'a failure here changes nothing');
    });
  },
);
