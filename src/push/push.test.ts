import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.ts';
import { appSettings, users } from '../../db/schema.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import {
  anyoneListening,
  applicationServerKey,
  checkSubscription,
  deviceLabel,
  listDevices,
  notifyMembers,
  removeDevice,
  saveSubscription,
  setDeviceKinds,
  testDevice,
} from './push.ts';
import type { Subscription } from './webpush.ts';

function browserAt(endpoint: string): Subscription {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

test('only real push services, and only whole subscriptions', () => {
  for (const endpoint of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QAbc',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ]) {
    assert.equal(checkSubscription(browserAt(endpoint)).endpoint, endpoint);
  }
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://192.168.1.1/fcm/send/abc',
    'https://localhost/x',
    'https://evilgoogleapis.com/x',
    'https://googleapis.com.example.net/x',
  ]) {
    assert.throws(() => checkSubscription(browserAt(endpoint)), /not one Manilla knows/, endpoint);
  }
  assert.throws(() => checkSubscription(null), /not a push subscription/);
  const keyless = browserAt('https://fcm.googleapis.com/fcm/send/abc');
  keyless.keys.auth = 'short';
  assert.throws(() => checkSubscription(keyless), /missing its keys/);
});

test('a browser is named by what it says it is', () => {
  assert.equal(
    deviceLabel('Mozilla/5.0 (Android 15; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0'),
    'Android · Firefox',
  );
  assert.equal(
    deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'),
    'iPhone · Safari',
  );
  assert.equal(
    deviceLabel('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'),
    'Android · Chrome',
  );
  assert.equal(
    deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0'),
    'Windows · Edge',
  );
  assert.equal(deviceLabel(''), 'A browser');
});

const available = await databaseAvailable();

describe(
  'notifications from Manilla (#87)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('push');
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    after(async () => {
      await closeDb(db);
    });

    const makeUser = async (name: string) => {
      const [row] = await db.insert(users).values({ name }).returning();
      return row!.id;
    };

    /** A push service that answers each endpoint as told, and remembers who it heard from. */
    function pushService(answers: Record<string, number> = {}) {
      const posted: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        posted.push(String(url));
        return new Response(null, { status: answers[String(url)] ?? 201 });
      }) as typeof globalThis.fetch;
      return { posted, fetch };
    }

    test('the key is made once and kept', async () => {
      const first = await applicationServerKey(db);
      const both = await Promise.all([applicationServerKey(db), applicationServerKey(db)]);
      assert.deepEqual(both, [first, first]);
    });

    test('the same browser saying yes again is one device, whoever it is now for', async () => {
      const alex = await makeUser('Alex');
      const sam = await makeUser('Sam');
      const tablet = browserAt('https://fcm.googleapis.com/fcm/send/tablet');
      await saveSubscription(db, alex, tablet, 'Android · Chrome');
      await saveSubscription(db, alex, tablet, 'Android · Chrome');
      assert.equal((await listDevices(db, alex)).length, 1);

      await saveSubscription(db, sam, tablet, 'Android · Chrome');
      assert.equal((await listDevices(db, alex)).length, 0);
      assert.equal((await listDevices(db, sam)).length, 1);
    });

    test('each browser hears only what it asked for, and not what its person did', async () => {
      const alex = await makeUser('Alex');
      const sam = await makeUser('Sam');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/alex-phone'), 'p');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/alex-laptop'), 'l');
      await saveSubscription(db, sam, browserAt('https://web.push.apple.com/sam-phone'), 's');
      const [phone, laptop] = await listDevices(db, alex);
      const [samPhone] = await listDevices(db, sam);
      await setDeviceKinds(db, alex, phone!.id, { sync: true, signin: true });
      await setDeviceKinds(db, alex, laptop!.id, { signin: true });
      await setDeviceKinds(db, sam, samPhone!.id, { sync: true, signin: true });

      const service = pushService();
      const sync = await notifyMembers(db, { kind: 'sync' }, { title: 't', body: 'b' }, { fetch: service.fetch });
      assert.equal(await sync.sent, 2);
      assert.deepEqual(service.posted.sort(), [
        'https://fcm.googleapis.com/fcm/send/alex-phone',
        'https://web.push.apple.com/sam-phone',
      ]);

      service.posted.length = 0;
      const signin = await notifyMembers(db, { kind: 'signin', except: alex }, { title: 't', body: 'b' }, { fetch: service.fetch });
      assert.equal(await signin.sent, 1);
      assert.deepEqual(service.posted, ['https://web.push.apple.com/sam-phone']);

      assert.equal(await anyoneListening(db, 'sync'), true);
      await setDeviceKinds(db, sam, laptop!.id, { sync: false, signin: false });
      assert.equal((await listDevices(db, alex)).find((device) => device.label === 'l')!.signin, true, "not Sam's to change");
    });

    test('each message a push service takes is logged, naming the kind and the device', async () => {
      const alex = await makeUser('Alex');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/alex-phone'), 'Android · Chrome');
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: string) => lines.push(line);
      try {
        const { sent } = await notifyMembers(db, { kind: 'overspent' }, { title: 't', body: 'b' }, { fetch: pushService().fetch });
        await sent;
      } finally {
        console.log = log;
      }
      assert.deepEqual(lines, ['[manilla] fcm.googleapis.com took the overspent notification for Android · Chrome (201)']);
    });

    test('a browser starts with only the two about spending turned on', async () => {
      const alex = await makeUser('Alex');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/new'), 'new');
      const [device] = await listDevices(db, alex);
      assert.deepEqual(
        { sync: device!.sync, overspent: device!.overspent, unusual: device!.unusual, problems: device!.problems, signin: device!.signin },
        { sync: false, overspent: true, unusual: true, problems: false, signin: false },
      );
      assert.equal(await anyoneListening(db, 'sync'), false);
      assert.equal(await anyoneListening(db, 'unusual'), true);
    });

    test('a browser that has unsubscribed is forgotten; one that is busy is kept', async () => {
      const alex = await makeUser('Alex');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/gone'), 'gone');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/busy'), 'busy');
      const service = pushService({
        'https://fcm.googleapis.com/fcm/send/gone': 410,
        'https://fcm.googleapis.com/fcm/send/busy': 429,
      });
      const warn = console.warn;
      console.warn = () => {};
      try {
        const { sent } = await notifyMembers(db, { kind: 'overspent' }, { title: 't', body: 'b' }, { fetch: service.fetch });
        assert.equal(await sent, 0);
      } finally {
        console.warn = warn;
      }
      assert.deepEqual((await listDevices(db, alex)).map((device) => device.label), ['busy']);
    });

    test('the test button reaches one browser, and removing is only of your own', async () => {
      const alex = await makeUser('Alex');
      const sam = await makeUser('Sam');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/one'), 'one');
      await saveSubscription(db, alex, browserAt('https://fcm.googleapis.com/fcm/send/two'), 'two');
      const service = pushService();
      const [, two] = await listDevices(db, alex);
      await setDeviceKinds(db, alex, two!.id, { sync: false, signin: false, overspent: false, unusual: false });
      const endpoint = 'https://fcm.googleapis.com/fcm/send/two';
      assert.deepEqual(await testDevice(db, alex, endpoint, { fetch: service.fetch }), { ok: true }, 'even with everything off');
      assert.deepEqual(service.posted, [endpoint]);
      assert.deepEqual(
        await testDevice(db, sam, endpoint, { fetch: service.fetch }),
        { ok: false, forgotten: true, error: 'Manilla no longer has this device on its list. Turn notifications on again.' },
        "not someone else's browser",
      );
      assert.equal(service.posted.length, 1);

      const warn = console.warn;
      console.warn = () => {};
      try {
        const refused = await testDevice(db, alex, endpoint, {
          fetch: (async () => new Response('push subscription has unsubscribed or expired.', { status: 410 })) as typeof fetch,
        });
        assert.deepEqual(refused, {
          ok: false,
          forgotten: true,
          error:
            'The push service (fcm.googleapis.com) says this device is not subscribed (410: push subscription has unsubscribed or expired.). Turn notifications on again.',
        });
      } finally {
        console.warn = warn;
      }
      assert.deepEqual((await listDevices(db, alex)).map((device) => device.label), ['one'], 'and it is forgotten');

      const [one] = await listDevices(db, alex);
      await removeDevice(db, sam, one!.id);
      assert.equal((await listDevices(db, alex)).length, 1);
      await removeDevice(db, alex, one!.id);
      assert.deepEqual(await listDevices(db, alex), []);
    });

    test('nobody listening means nothing is sent and no key is made', async () => {
      const service = pushService();
      const { sent } = await notifyMembers(db, { kind: 'overspent' }, { title: 't', body: 'b' }, { fetch: service.fetch });
      assert.equal(await sent, 0);
      assert.equal(await anyoneListening(db, 'overspent'), false);
      assert.deepEqual(service.posted, []);
      assert.deepEqual(await db.select().from(appSettings), []);
    });
  },
);
