import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { credentials, invites, recoveryCodes, sessions, users } from '../../db/schema.ts';
import { closeDb, databaseAvailable, setupTestDb, truncateAll } from '../ledger/testdb.ts';
import { authConfig } from './config.ts';
import {
  INVITE_TTL_MS,
  MAX_PENDING_INVITES,
  beginJoin,
  createInvite,
  finishJoin,
  hashInviteToken,
  listMembers,
  listPendingInvites,
  lookUpInvite,
  removeMember,
  withdrawInvite,
} from './invites.ts';
import {
  AuthError,
  beginRegistration,
  finishRegistration,
  redeemRecoveryCode,
  setupState,
} from './passkeys.ts';
import { createSession, verifySession } from './session.ts';
import { softRegistration } from './testAuthenticator.ts';

const config = authConfig({ MANILLA_RP_ID: 'localhost', MANILLA_ORIGIN: 'http://localhost:3000' }, false);

const available = await databaseAvailable();

describe(
  'household members and invitations (NF-3)',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('invites');
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    after(async () => {
      await closeDb(db);
    });

    /** The first person, set up the way the sign-in page does it. */
    async function setUp(name = 'First'): Promise<string> {
      const begun = await beginRegistration(db, { userName: name, config });
      const response = softRegistration({
        challenge: begun.options.challenge,
        origin: config.origin,
        rpId: config.rpId,
      });
      const done = await finishRegistration(db, {
        challengeId: begun.challengeId,
        response,
        userName: name,
        config,
      });
      return done.userId;
    }

    async function join(token: string, name = 'Second') {
      const begun = await beginJoin(db, { token, name, config });
      const response = softRegistration({
        challenge: begun.options.challenge,
        origin: config.origin,
        rpId: config.rpId,
      });
      return finishJoin(db, { token, challengeId: begun.challengeId, response, name, config });
    }

    const refusedAs = (pattern: RegExp) => (error: unknown) => {
      assert.ok(error instanceof AuthError, String(error));
      assert.match(error.message, pattern);
      return true;
    };

    test('a software passkey goes through real verification', async () => {
      const userId = await setUp();
      const [stored] = await db.select().from(credentials);
      assert.equal(stored!.userId, userId);
      assert.equal((await setupState(db)).needsSetup, false);
    });

    test('an invitation makes a second person with their own way in', async () => {
      const first = await setUp('First');
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });

      assert.deepEqual(await lookUpInvite(db, token), { name: 'Second', invitedBy: 'First' });

      const joined = await join(token, 'Second');
      assert.notEqual(joined.userId, first);
      assert.equal(joined.recoveryCodes.length, 10);

      const members = await listMembers(db);
      assert.deepEqual(
        members.map(({ name, passkeys }) => ({ name, passkeys })),
        [
          { name: 'First', passkeys: 1 },
          { name: 'Second', passkeys: 1 },
        ],
      );

      // Their codes are theirs, and sign them in as themselves.
      assert.equal(await redeemRecoveryCode(db, joined.recoveryCodes[0]!), joined.userId);

      const [invite] = await db.select().from(invites);
      assert.ok(invite!.usedAt);
      assert.equal(invite!.usedBy, joined.userId);
    });

    test('only the hash of the token is stored', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      const [row] = await db.select().from(invites);
      assert.equal(row!.tokenHash, hashInviteToken(token));
      assert.ok(!JSON.stringify(row).includes(token));
    });

    test('an invitation works once', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      await join(token);

      assert.equal(await lookUpInvite(db, token), null);
      await assert.rejects(() => join(token, 'Third'), refusedAs(/already been used/));
      assert.equal((await db.select().from(users)).length, 2);
    });

    test('two attempts racing with one link make one person', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });

      // Both begin while the link is good, then both finish.
      const starts = await Promise.all([
        beginJoin(db, { token, name: 'A', config }),
        beginJoin(db, { token, name: 'B', config }),
      ]);
      const results = await Promise.allSettled(
        starts.map((begun, i) =>
          finishJoin(db, {
            token,
            challengeId: begun.challengeId,
            response: softRegistration({
              challenge: begun.options.challenge,
              origin: config.origin,
              rpId: config.rpId,
            }),
            name: i ? 'B' : 'A',
            config,
          }),
        ),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal((await db.select().from(users)).length, 2);
    });

    test('a failed passkey leaves the invitation usable', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });

      const begun = await beginJoin(db, { token, name: 'Second', config });
      const wrongChallenge = softRegistration({
        challenge: 'not-the-challenge',
        origin: config.origin,
        rpId: config.rpId,
      });
      await assert.rejects(() =>
        finishJoin(db, {
          token,
          challengeId: begun.challengeId,
          response: wrongChallenge,
          name: 'Second',
          config,
        }),
      );

      assert.ok(await lookUpInvite(db, token), 'still good');
      await join(token);
    });

    test('a lapsed invitation is refused', async () => {
      const first = await setUp();
      const made = new Date('2026-10-01T12:00:00Z');
      const { token } = await createInvite(db, { createdBy: first, name: 'Second', now: made });

      const justBefore = new Date(made.getTime() + INVITE_TTL_MS - 1000);
      const justAfter = new Date(made.getTime() + INVITE_TTL_MS + 1000);
      assert.ok(await lookUpInvite(db, token, justBefore));
      assert.equal(await lookUpInvite(db, token, justAfter), null);
      await assert.rejects(
        () => beginJoin(db, { token, name: 'Second', config, now: justAfter }),
        refusedAs(/expired/),
      );
    });

    test('a withdrawn invitation is refused, and a used one cannot be withdrawn', async () => {
      const first = await setUp();
      const withdrawn = await createInvite(db, { createdBy: first, name: 'Second' });
      await withdrawInvite(db, withdrawn.id);
      assert.equal(await lookUpInvite(db, withdrawn.token), null);

      const used = await createInvite(db, { createdBy: first, name: 'Third' });
      await join(used.token, 'Third');
      await withdrawInvite(db, used.id);
      assert.equal((await db.select().from(invites)).length, 1, 'the spent one is history');
    });

    test('a made-up token finds nothing', async () => {
      await setUp();
      assert.equal(await lookUpInvite(db, 'made-up'), null);
      await assert.rejects(
        () => beginJoin(db, { token: 'made-up', name: 'X', config }),
        refusedAs(/expired/),
      );
    });

    test('a name is needed, and is tidied', async () => {
      const first = await setUp();
      await assert.rejects(
        () => createInvite(db, { createdBy: first, name: '   ' }),
        refusedAs(/name is needed/),
      );
      await createInvite(db, { createdBy: first, name: '  Second   Person ' });
      assert.equal((await listPendingInvites(db))[0]!.name, 'Second Person');
    });

    test('only so many invitations wait at once', async () => {
      const first = await setUp();
      for (let i = 0; i < MAX_PENDING_INVITES; i++) {
        await createInvite(db, { createdBy: first, name: `Person ${i}` });
      }
      await assert.rejects(
        () => createInvite(db, { createdBy: first, name: 'One more' }),
        refusedAs(/already 5 invitations/),
      );
    });

    test('pending invitations are listed with who made them', async () => {
      const first = await setUp('First');
      await createInvite(db, { createdBy: first, name: 'Second' });
      const [pending] = await listPendingInvites(db);
      assert.equal(pending!.name, 'Second');
      assert.equal(pending!.createdByName, 'First');
    });

    test('open setup stays closed while any member has a passkey', async () => {
      const first = await setUp('First');
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      await join(token);

      // The first person's passkey goes (by hand: the app refuses the last one).
      await db.delete(credentials).where(eq(credentials.userId, first));
      assert.equal((await setupState(db)).needsSetup, false);
      await assert.rejects(
        () => beginRegistration(db, { userName: 'Stranger', config }),
        refusedAs(/already has a passkey/),
      );
    });

    test('removing someone takes their way in and nothing else', async () => {
      const first = await setUp('First');
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      const second = await join(token);
      const session = await createSession(db, second.userId);

      await removeMember(db, { actingUserId: first, userId: second.userId });

      assert.equal(await verifySession(db, session.token), null, 'signed out');
      assert.equal(await redeemRecoveryCode(db, second.recoveryCodes[1]!), null);
      assert.equal(
        (await db.select().from(credentials).where(eq(credentials.userId, second.userId))).length,
        0,
      );
      assert.equal((await db.select().from(sessions)).length, 0);
      assert.equal(
        (await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, first))).length,
        10,
        'the first person is untouched',
      );
      const [invite] = await db.select().from(invites);
      assert.equal(invite!.usedBy, null, 'the invitation is kept, without its newcomer');
    });

    test('nobody can remove themselves', async () => {
      const first = await setUp();
      await assert.rejects(
        () => removeMember(db, { actingUserId: first, userId: first }),
        refusedAs(/cannot remove yourself/),
      );
    });

    test('removing someone already gone says so', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      const second = await join(token);
      await removeMember(db, { actingUserId: first, userId: second.userId });
      await assert.rejects(
        () => removeMember(db, { actingUserId: first, userId: second.userId }),
        refusedAs(/no longer a member/),
      );
    });

    test('a challenge begun by a signed-in member cannot be spent on joining', async () => {
      const first = await setUp();
      const { token } = await createInvite(db, { createdBy: first, name: 'Second' });
      const addDevice = await beginRegistration(db, { userId: first, config });
      await assert.rejects(
        () =>
          finishJoin(db, {
            token,
            challengeId: addDevice.challengeId,
            response: softRegistration({
              challenge: addDevice.options.challenge,
              origin: config.origin,
              rpId: config.rpId,
            }),
            name: 'Second',
            config,
          }),
        refusedAs(/different sign-in/),
      );
      assert.ok(await lookUpInvite(db, token), 'and the invitation is untouched');
    });
  },
);
