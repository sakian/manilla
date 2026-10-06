import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import type { Database } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { openAccount, recordTransaction } from '../ledger/ledger.ts';
import { closeDb, databaseAvailable, seedEnvelopes, setupTestDb, truncateAll, type Fixture } from '../ledger/testdb.ts';
import { listDevices, saveSubscription, setDeviceKinds } from './push.ts';
import { editMessage, reviewStates, tellAboutEdit } from './edits.ts';

test('what the others read: who did what to how many', () => {
  const said = (notice: Parameters<typeof editMessage>[1], ledger?: string) => editMessage('Talia', notice, ledger).body;
  assert.equal(said({ kind: 'review', action: 'reviewed', count: 6 }, 'Personal'), 'Talia reviewed 6 transactions in Personal.');
  assert.equal(said({ kind: 'review', action: 'reviewed', count: 1 }), 'Talia reviewed a transaction.');
  assert.equal(said({ kind: 'review', action: 'changed', count: 1 }), 'Talia changed a transaction waiting for review.');
  assert.equal(said({ kind: 'review', action: 'deleted', count: 2 }), 'Talia deleted 2 transactions waiting for review.');
  assert.equal(said({ kind: 'changes', action: 'changed', count: 2 }, 'Opifex'), 'Talia changed 2 reviewed transactions in Opifex.');
  assert.equal(said({ kind: 'changes', action: 'deleted', count: 1 }), 'Talia deleted a reviewed transaction.');
  assert.equal(said({ kind: 'changes', action: 'sent back', count: 1 }), 'Talia sent a reviewed transaction back to review.');
  assert.equal(editMessage('Talia', { kind: 'review', action: 'reviewed', count: 1 }).title, 'Manilla review activity');
  assert.equal(editMessage('Talia', { kind: 'changes', action: 'changed', count: 1 }).title, 'Manilla changes');
});

const available = await databaseAvailable();

describe(
  'telling the household about changes',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;
    let env: Fixture;
    let mark: string;
    let talia: string;

    before(async () => {
      db = await setupTestDb('edits');
    });

    beforeEach(async () => {
      await truncateAll(db);
      env = await seedEnvelopes(db);
      [mark, talia] = (await db.insert(users).values([{ name: 'Mark' }, { name: 'Talia' }]).returning()).map((row) => row.id) as [string, string];
    });

    after(async () => {
      await closeDb(db);
    });

    const browserAt = (endpoint: string) => {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    };

    function pushService() {
      const posted: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        posted.push(String(url));
        return new Response(null, { status: 201 });
      }) as typeof globalThis.fetch;
      return { posted, fetch };
    }

    test('both kinds start off, and each is told only to devices that turned it on', async () => {
      await saveSubscription(db, mark, browserAt('https://fcm.googleapis.com/fcm/send/mark'), 'Mark phone');
      const [phone] = await listDevices(db, mark);
      assert.equal(phone!.review, false);
      assert.equal(phone!.changes, false);

      const service = pushService();
      const tell = (kind: 'review' | 'changes') =>
        tellAboutEdit(
          db,
          {
            actor: { id: talia, name: 'Talia' },
            notice: kind === 'review' ? { kind, action: 'reviewed', count: 3 } : { kind, action: 'changed', count: 1 },
          },
          { fetch: service.fetch },
        ).then(({ sent }) => sent);

      assert.equal(await tell('review'), 0, 'off until turned on');
      await setDeviceKinds(db, mark, phone!.id, { review: true });
      assert.equal(await tell('review'), 1);
      assert.equal(await tell('changes'), 0, 'the other kind is its own switch');
      assert.deepEqual(service.posted, ['https://fcm.googleapis.com/fcm/send/mark']);
    });

    test('never to the person who made the change, and nothing for nothing', async () => {
      await saveSubscription(db, talia, browserAt('https://fcm.googleapis.com/fcm/send/talia'), 'Talia phone');
      const [phone] = await listDevices(db, talia);
      await setDeviceKinds(db, talia, phone!.id, { review: true });
      const service = pushService();

      const own = await tellAboutEdit(
        db,
        { actor: { id: talia, name: 'Talia' }, notice: { kind: 'review', action: 'reviewed', count: 2 } },
        { fetch: service.fetch },
      );
      const none = await tellAboutEdit(
        db,
        { actor: { id: mark, name: 'Mark' }, notice: { kind: 'review', action: 'reviewed', count: 0 } },
        { fetch: service.fetch },
      );
      assert.equal(await own.sent, 0);
      assert.equal(await none.sent, 0);
      assert.deepEqual(service.posted, []);
    });

    test('whether a transaction is waiting or reviewed is read before it changes', async () => {
      const accountId = await openAccount(db, { name: 'Chequing', kind: 'chequing' });
      const waiting = await recordTransaction(db, {
        accountId,
        date: '2026-10-01',
        amountCents: -1000,
        payeeRaw: 'WAITING',
        status: 'pending_review',
      });
      const reviewed = await recordTransaction(db, {
        accountId,
        date: '2026-10-01',
        amountCents: -1000,
        payeeRaw: 'REVIEWED',
        status: 'confirmed',
        lines: [{ envelopeId: env.groceriesId, amountCents: -1000 }],
      });
      assert.deepEqual(await reviewStates(db, [waiting, reviewed]), { waiting: 1, reviewed: 1 });
      assert.deepEqual(await reviewStates(db, []), { waiting: 0, reviewed: 0 });
    });
  },
);
