import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { users } from '../../db/schema.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { ensureIncomePool, openAccount } from '../ledger/ledger.ts';
import { NOTHING_TOLD, checkForProblems, problemsToTell, type ProblemsSeen } from './problems.ts';
import { saveSubscription, setDeviceKinds, listDevices } from './push.ts';

const home = (ok: boolean) => ({ key: 'manilla', name: 'Household', ok });
const seen = (overrides: Partial<ProblemsSeen>): ProblemsSeen => ({ ledgers: [home(true)], disk: 0.5, ...overrides });

test('nothing wrong, nothing said', () => {
  assert.deepEqual(problemsToTell(NOTHING_TOLD, seen({})), { text: null, urgent: false, told: NOTHING_TOLD });
});

test('a ledger that stops adding up is said once, and again only after it has been put right', () => {
  const first = problemsToTell(NOTHING_TOLD, seen({ ledgers: [home(false)] }));
  assert.equal(first.text, 'The envelopes and the accounts no longer add up. Open Manilla before trusting any figure in it.');
  assert.equal(first.urgent, true);

  const still = problemsToTell(first.told, seen({ ledgers: [home(false)] }));
  assert.equal(still.text, null, 'not every hour while it lasts');

  const fixed = problemsToTell(still.told, seen({}));
  assert.deepEqual(fixed.told, NOTHING_TOLD);
  assert.notEqual(problemsToTell(fixed.told, seen({ ledgers: [home(false)] })).text, null, 'a return is news');
});

test('with more than one ledger, it says which', () => {
  const said = problemsToTell(NOTHING_TOLD, {
    ledgers: [home(true), { key: 'manilla_ledger_business', name: 'Business', ok: false }],
    disk: null,
  });
  assert.match(said.text!, /^Business: The envelopes/);
});

test('a filling disk is said as it crosses each line, and not while it hovers', () => {
  const warn = problemsToTell(NOTHING_TOLD, seen({ disk: 0.91 }));
  assert.equal(warn.text, "The server's disk is 91% full. When it fills, Manilla stops saving changes, and the backups stop with it.");
  assert.equal(warn.urgent, false);

  assert.equal(problemsToTell(warn.told, seen({ disk: 0.93 })).text, null);
  assert.equal(problemsToTell(warn.told, seen({ disk: 0.89 })).told.disk, 'warn', 'just under the line is not recovered');
  assert.equal(problemsToTell(warn.told, seen({ disk: null })).told.disk, 'warn', 'unreadable is not recovered either');

  const bad = problemsToTell(warn.told, seen({ disk: 0.975 }));
  assert.match(bad.text!, /98% full/);
  assert.equal(bad.urgent, true);

  const cleared = problemsToTell(bad.told, seen({ disk: 0.6 }));
  assert.equal(cleared.told.disk, null);
  assert.notEqual(problemsToTell(cleared.told, seen({ disk: 0.92 })).text, null);
});

const available = await databaseAvailable();

describe(
  'the hourly look for problems (#87)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('problems');
    });

    beforeEach(async () => {
      await truncateAll(db);
      await ensureIncomePool(db);
    });

    after(async () => {
      await closeDb(db);
    });

    function browser(endpoint: string) {
      const ecdh = createECDH('prime256v1');
      ecdh.generateKeys();
      return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    }

    test('a broken ledger reaches the browsers that asked, once', async () => {
      const [alex] = await db.insert(users).values({ name: 'Alex' }).returning();
      await saveSubscription(db, alex!.id, browser('https://fcm.googleapis.com/fcm/send/on'), 'on');
      await saveSubscription(db, alex!.id, browser('https://fcm.googleapis.com/fcm/send/off'), 'off');
      const on = (await listDevices(db, alex!.id)).find((device) => device.label === 'on')!;
      await setDeviceKinds(db, alex!.id, on.id, { problems: true });

      const posted: string[] = [];
      const options = {
        homeDatabase: 'manilla_test_problems',
        ledgerDb: () => db,
        disk: async () => 0.4,
        fetch: (async (url: string | URL | Request) => {
          posted.push(String(url));
          return new Response(null, { status: 201 });
        }) as typeof fetch,
      };

      assert.equal(await checkForProblems(db, options), null, 'a ledger that adds up');

      await openAccount(db, { name: 'Chequing', kind: 'chequing', openingBalanceCents: 10_000, openingDate: '2026-10-01' });
      // What no write in the app can do: an envelope line that no longer matches its transaction.
      await db.transaction((tx) => tx.execute(sql`update txn_lines set amount_cents = amount_cents - 100`));

      assert.match((await checkForProblems(db, options))!, /no longer add up/);
      assert.deepEqual(posted, ['https://fcm.googleapis.com/fcm/send/on']);
      assert.equal(await checkForProblems(db, options), null, 'said once');
      assert.equal(posted.length, 1);
    });

    test('nobody listening, nothing looked at', async () => {
      let looked = false;
      const said = await checkForProblems(db, {
        homeDatabase: 'manilla_test_problems',
        ledgerDb: () => db,
        disk: async () => {
          looked = true;
          return 0.99;
        },
      });
      assert.equal(said, null);
      assert.equal(looked, false);
    });
  },
);
