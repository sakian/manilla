import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';
import { runAs } from '../audit/actor.ts';
import { transactionHistory } from '../audit/history.ts';
import { attention } from '../notices/notices.ts';
import { saveSubscription, setDeviceKinds, listDevices } from '../push/push.ts';
import { handOver, pendingCount, pendingTransactions, saveReview } from './queue.ts';
import {
  HandoverError,
  handOverTo,
  handoverMessage,
  reviewOpensOn,
  setReviewOpensOn,
} from './handover.ts';

test('the notification says who, how many, and how many are waiting in all', () => {
  assert.deepEqual(handoverMessage({ from: 'Alex', handed: 1, waiting: 1 }), {
    title: 'Manilla review',
    body: 'Alex handed you a transaction to review.',
  });
  assert.equal(
    handoverMessage({ from: 'Alex', handed: 2, waiting: 5, ledger: 'Business' }).body,
    'Alex handed you 2 transactions to review in Business. 5 are waiting for you now.',
  );
});

const available = await databaseAvailable();

describe(
  'handing review to someone else (RQ-7)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    // One database stands in for both the home database and the ledger's.
    let db: Database;
    let env: Fixture;
    let accountId: string;
    let alex: string;
    let sam: string;

    before(async () => {
      db = await setupTestDb('handover');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      [alex, sam] = (await db.insert(users).values([{ name: 'Alex' }, { name: 'Sam' }]).returning()).map((row) => row.id) as [string, string];
    });

    after(async () => {
      await closeDb(db);
    });

    const waiting = (payee: string) =>
      recordTransaction(db, {
        accountId,
        date: '2026-10-01',
        amountCents: -1000,
        payeeRaw: payee,
        source: 'bank_sync',
        status: 'pending_review',
      });

    /** A push service that takes everything, and remembers where each message went. */
    function pushService() {
      const posted: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        posted.push(String(url));
        return new Response(null, { status: 201 });
      }) as typeof globalThis.fetch;
      return { posted, fetch };
    }

    const browserAt = (endpoint: string) => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    };

    test('what is handed to someone is in their list and their count, and still in everyone’s', async () => {
      const [a, b, c] = [await waiting('ONE'), await waiting('TWO'), await waiting('THREE')];
      assert.equal(await handOver(db, [a, b], sam), 2);

      assert.deepEqual((await pendingTransactions(db, { handedTo: sam })).map((row) => row.id).sort(), [a, b].sort());
      assert.deepEqual(await pendingTransactions(db, { handedTo: alex }), []);
      assert.equal(await pendingCount(db, { handedTo: sam }), 2);
      assert.equal(await pendingCount(db), 3, 'the full list keeps them');
      const all = await pendingTransactions(db);
      assert.equal(all.find((row) => row.id === c)!.handedToId, null);
      assert.equal(all.find((row) => row.id === a)!.handedToId, sam);
    });

    test('a handover can be passed on, but there is no handing back to nobody', async () => {
      const id = await waiting('ONE');
      await handOver(db, [id], sam);
      await handOver(db, [id], alex);
      assert.equal(await pendingCount(db, { handedTo: sam }), 0);
      assert.equal(await pendingCount(db, { handedTo: alex }), 1);
    });

    test('once anyone reviews it, it is off every list', async () => {
      const id = await waiting('ONE');
      await handOver(db, [id], sam);
      const result = await runAs({ id: alex, name: 'Alex' }, () =>
        saveReview(db, [{ transactionId: id, envelopeId: env.groceriesId }]),
      );
      assert.equal(result.confirmed, 1);
      assert.equal(await pendingCount(db, { handedTo: sam }), 0);
      assert.equal(await pendingCount(db), 0);
    });

    test('only rows still waiting can be handed over', async () => {
      const done = await recordTransaction(db, {
        accountId,
        date: '2026-10-01',
        amountCents: -1000,
        payeeRaw: 'DONE',
        status: 'confirmed',
        lines: [{ envelopeId: env.groceriesId, amountCents: -1000 }],
      });
      assert.equal(await handOver(db, [done], sam), 0);
    });

    test('handing over tells that person alone, on the devices that take it', async () => {
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/alex'), 'Alex phone');
      await saveSubscription(db, sam, browserAt('https://fcm.googleapis.com/fcm/send/sam-phone'), 'Sam phone');
      await saveSubscription(db, sam, browserAt('https://fcm.googleapis.com/fcm/send/sam-laptop'), 'Sam laptop');
      const laptop = (await listDevices(db, sam)).find((device) => device.label === 'Sam laptop')!;
      await setDeviceKinds(db, sam, laptop.id, { handed: false });
      assert.equal((await listDevices(db, sam)).find((device) => device.label === 'Sam phone')!.handed, true, 'on unless turned off');

      const ids = [await waiting('ONE'), await waiting('TWO')];
      const service = pushService();
      const result = await runAs({ id: alex, name: 'Alex' }, () =>
        handOverTo(db, db, { ids, to: sam, from: { id: alex, name: 'Alex' } }, { fetch: service.fetch }),
      );
      assert.equal(result.handed, 2);
      assert.equal(result.to, 'Sam');
      assert.equal(await result.sent, 1);
      assert.deepEqual(service.posted, ['https://fcm.googleapis.com/fcm/send/sam-phone']);
    });

    test('nobody is told about nothing', async () => {
      await saveSubscription(db, sam, browserAt('https://fcm.googleapis.com/fcm/send/sam'), 'Sam phone');
      const service = pushService();
      const result = await handOverTo(db, db, { ids: [], to: sam, from: { id: alex, name: 'Alex' } }, { fetch: service.fetch });
      assert.equal(result.handed, 0);
      assert.deepEqual(service.posted, []);
    });

    test('only to a member, and not to yourself', async () => {
      const ids = [await waiting('ONE')];
      await assert.rejects(handOverTo(db, db, { ids, to: alex, from: { id: alex, name: 'Alex' } }), HandoverError);
      await assert.rejects(
        handOverTo(db, db, { ids, to: crypto.randomUUID(), from: { id: alex, name: 'Alex' } }),
        HandoverError,
      );
      assert.equal(await pendingCount(db, { handedTo: alex }), 0);
    });

    test('the history says who handed it over and to whom', async () => {
      const id = await waiting('ONE');
      await runAs({ id: alex, name: 'Alex' }, () => handOver(db, [id], sam));
      const history = await transactionHistory(db, id, new Map([[sam, 'Sam']]));
      assert.equal(history[0]!.who, 'Alex');
      assert.deepEqual(history[0]!.changes, ['handed to Sam for review']);
    });

    test('each person chooses which view their review list opens on', async () => {
      assert.equal(await reviewOpensOn(db, sam), 'all', 'everything, unless they choose otherwise');
      await setReviewOpensOn(db, sam, 'mine');
      assert.equal(await reviewOpensOn(db, sam), 'mine');
      assert.equal(await reviewOpensOn(db, alex), 'all', 'and only for themselves');
      await assert.rejects(setReviewOpensOn(db, sam, 'other' as 'all'), HandoverError);
    });

    describe('the notice on the home screen', () => {
      const reviewNotice = async (viewer?: { userId: string; opensOn: 'all' | 'mine' }) =>
        (await attention(db, '2026-10', viewer ? { viewer } : {})).notices.find((notice) => notice.kind === 'awaiting_review');

      test('opening on everything: the total, and how many are yours when any are', async () => {
        const ids = [await waiting('ONE'), await waiting('TWO'), await waiting('THREE')];
        assert.deepEqual(
          { count: (await reviewNotice({ userId: alex, opensOn: 'all' }))?.count, mine: (await reviewNotice({ userId: alex, opensOn: 'all' }))?.mine },
          { count: 3, mine: 0 },
        );
        await handOver(db, ids.slice(0, 1), alex);
        const notice = await reviewNotice({ userId: alex, opensOn: 'all' });
        assert.equal(notice?.count, 3);
        assert.equal(notice?.mine, 1);
        assert.equal(notice?.view, 'all');
      });

      test('opening on what is handed to you: only that, and nothing when there is none', async () => {
        const ids = [await waiting('ONE'), await waiting('TWO')];
        assert.equal(await reviewNotice({ userId: sam, opensOn: 'mine' }), undefined, 'waiting, but not for Sam');
        await handOver(db, ids.slice(0, 1), sam);
        const notice = await reviewNotice({ userId: sam, opensOn: 'mine' });
        assert.equal(notice?.count, 1);
        assert.equal(notice?.view, 'mine');
      });

      test('without a viewer it counts everything, as before', async () => {
        await waiting('ONE');
        assert.equal((await reviewNotice())?.count, 1);
      });
    });
  },
);
