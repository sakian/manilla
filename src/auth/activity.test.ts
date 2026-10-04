import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import {
  describeActivity,
  markActivitySeen,
  recentActivity,
  recordActivity,
  summarizeUnseen,
  unseenActivity,
  type Activity,
} from './activity.ts';

const event = (overrides: Partial<Activity>): Activity => ({
  id: 'x',
  at: new Date('2026-10-04T12:00:00Z'),
  kind: 'passkey_added',
  subjectId: 'a',
  subjectName: 'Alex',
  actorId: 'a',
  actorName: 'Alex',
  detail: null,
  source: null,
  ...overrides,
});

test('each kind reads as a sentence', () => {
  assert.equal(describeActivity(event({ detail: 'Pixel 9' })), 'Alex added a passkey "Pixel 9"');
  assert.equal(
    describeActivity(event({ kind: 'recovery_code_used', source: '"sam@example.com"' })),
    'Alex signed in with a recovery code, from "sam@example.com"',
  );
  assert.equal(
    describeActivity(event({ kind: 'recovery_code_failed', subjectName: null, actorName: null, source: '"203.0.113.9" over Funnel' })),
    'A recovery code that did not match was tried, from "203.0.113.9" over Funnel',
  );
  assert.equal(
    describeActivity(event({ kind: 'member_removed', subjectId: 's', subjectName: 'Sam' })),
    'Alex removed Sam',
  );
  assert.equal(
    describeActivity(event({ kind: 'member_joined', subjectName: 'Sam', detail: 'Alex' })),
    'Sam joined, invited by Alex',
  );
  assert.equal(describeActivity(event({ kind: 'invite_created', detail: 'Sam' })), 'Alex invited Sam');
});

test('the notice leads with the newest, and counts failed codes as one thing', () => {
  assert.equal(summarizeUnseen([]), null);
  assert.deepEqual(summarizeUnseen([event({ kind: 'invite_created', detail: 'Sam' })]), {
    text: 'Alex invited Sam',
    urgent: false,
  });

  const failed = event({ kind: 'recovery_code_failed', actorId: null, actorName: null });
  assert.equal(
    summarizeUnseen([event({ kind: 'recovery_code_used', source: '"203.0.113.9" over Funnel' })])!.text,
    'Alex signed in with a recovery code',
    'where it came from is in Settings, not the one-line notice',
  );
  const summary = summarizeUnseen([
    event({ kind: 'invite_created', detail: 'Sam' }),
    failed,
    event({ detail: 'Laptop' }),
    failed,
  ]);
  assert.deepEqual(summary, {
    text: 'Alex invited Sam and 1 more; 2 recovery codes that did not match were tried',
    urgent: true,
  });
  assert.deepEqual(summarizeUnseen([failed]), {
    text: 'A recovery code that did not match was tried',
    urgent: true,
  });
});

const available = await databaseAvailable();

describe(
  'sign-in activity (NF-3)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('activity');
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    after(async () => {
      await closeDb(db);
    });

    const makeUser = async (name: string, createdAt = new Date('2026-10-01T00:00:00Z')) => {
      const [row] = await db.insert(users).values({ name, createdAt }).returning();
      return { id: row!.id, name };
    };
    const at = (iso: string) => new Date(iso);
    const quietly = { alertUrl: '' };

    test('a member sees what others did since they last looked', async () => {
      const alex = await makeUser('Alex');
      const sam = await makeUser('Sam');

      await recordActivity(db, { kind: 'passkey_added', subject: sam, actor: sam, at: at('2026-10-02T10:00:00Z') }, quietly);
      await recordActivity(db, { kind: 'passkey_added', subject: alex, actor: alex, at: at('2026-10-02T11:00:00Z') }, quietly);

      const forAlex = await unseenActivity(db, alex.id);
      assert.deepEqual(forAlex.map((row) => describeActivity(row)), ['Sam added a passkey'], 'not their own');

      await markActivitySeen(db, alex.id, at('2026-10-03T00:00:00Z'));
      assert.deepEqual(await unseenActivity(db, alex.id), []);

      await recordActivity(db, { kind: 'invite_created', actor: sam, detail: 'Pat', at: at('2026-10-04T09:00:00Z') }, quietly);
      assert.deepEqual((await unseenActivity(db, alex.id)).map((row) => describeActivity(row)), ['Sam invited Pat']);
    });

    test('recovery codes are shown even to the person they belong to', async () => {
      const alex = await makeUser('Alex');
      await recordActivity(db, { kind: 'recovery_code_used', subject: alex, actor: alex, at: at('2026-10-02T10:00:00Z') }, quietly);
      await recordActivity(db, { kind: 'recovery_code_failed', source: 'an unnamed client', at: at('2026-10-02T11:00:00Z') }, quietly);
      assert.equal((await unseenActivity(db, alex.id)).length, 2);
    });

    test('nothing from before someone joined is news to them', async () => {
      const alex = await makeUser('Alex');
      await recordActivity(db, { kind: 'recovery_code_failed', at: at('2026-10-02T10:00:00Z') }, quietly);
      const sam = await makeUser('Sam', at('2026-10-03T00:00:00Z'));
      assert.equal((await unseenActivity(db, sam.id)).length, 0);
      assert.equal((await unseenActivity(db, alex.id)).length, 1);
    });

    test('an event outlives the person it is about', async () => {
      const alex = await makeUser('Alex');
      const sam = await makeUser('Sam');
      await recordActivity(db, { kind: 'member_removed', subject: sam, actor: alex }, quietly);
      await db.delete(users).where((await import('drizzle-orm')).eq(users.id, sam.id));
      const [kept] = await recentActivity(db);
      assert.equal(describeActivity(kept!), 'Alex removed Sam');
      assert.equal(kept!.subjectId, null);
    });

    test('recent activity is newest first, and limited', async () => {
      const alex = await makeUser('Alex');
      for (let day = 1; day <= 5; day++) {
        await recordActivity(db, { kind: 'invite_created', actor: alex, detail: `P${day}`, at: at(`2026-10-0${day}T12:00:00Z`) }, quietly);
      }
      assert.deepEqual((await recentActivity(db, 2)).map((row) => row.detail), ['P5', 'P4']);
    });

    test('the webhook gets the line as plain text, and only when asked', async () => {
      const received: string[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          received.push(`${request.headers['content-type']}|${body}`);
          response.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const alertUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

      try {
        const alex = await makeUser('Alex');
        await recordActivity(db, { kind: 'invite_created', actor: alex, detail: 'Sam' }, { alertUrl });
        await recordActivity(db, { kind: 'recovery_code_failed' }, { alertUrl, alert: false });
        for (let i = 0; i < 50 && received.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
        await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(received, ['text/plain; charset=utf-8|Manilla: Alex invited Sam']);
      } finally {
        server.close();
      }
    });

    test('a webhook that is down costs nothing', async () => {
      const alex = await makeUser('Alex');
      await recordActivity(db, { kind: 'invite_created', actor: alex, detail: 'Sam' }, { alertUrl: 'http://127.0.0.1:1/' });
      assert.equal((await recentActivity(db)).length, 1);
    });
  },
);
