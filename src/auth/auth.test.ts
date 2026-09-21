import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { AuthConfigError, authConfig, isSecureOrigin } from './config.ts';
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  createSession,
  destroyAllSessions,
  destroySession,
  hashToken,
  purgeExpiredSessions,
  verifySession,
} from './session.ts';
import {
  AuthError,
  beginAuthentication,
  beginRegistration,
  countUnusedRecoveryCodes,
  finishRegistration,
  hashRecoveryCode,
  listDevices,
  makeRecoveryCode,
  makeRecoveryCodes,
  normalizeRecoveryCode,
  primaryUser,
  redeemRecoveryCode,
  regenerateRecoveryCodes,
  removeDevice,
  renameDevice,
  setupState,
} from './passkeys.ts';
import {
  closeDb,
  databaseAvailable,
  setupTestDb,
  truncateAll,
} from '../ledger/testdb.ts';
import { credentials, recoveryCodes, sessions, users, webauthnChallenges } from '../../db/schema.ts';

const LOCAL = { MANILLA_RP_ID: 'localhost', MANILLA_ORIGIN: 'http://localhost:3000' };
const TAILNET = {
  MANILLA_RP_ID: 'manilla.example-tailnet.ts.net',
  MANILLA_ORIGIN: 'https://manilla.example-tailnet.ts.net',
};

describe('relying-party configuration (NF-3)', () => {
  test('a local development pair is accepted', () => {
    const config = authConfig(LOCAL, false);
    assert.equal(config.rpId, 'localhost');
    assert.equal(config.origin, 'http://localhost:3000');
    assert.equal(config.rpName, 'Manilla');
  });

  test('the hostname in the origin must be the relying-party id', () => {
    assert.throws(
      () =>
        authConfig(
          { MANILLA_RP_ID: 'manilla.example.ts.net', MANILLA_ORIGIN: 'https://other.example.ts.net' },
          false,
        ),
      (error: unknown) => {
        assert.ok(error instanceof AuthConfigError);
        assert.match(error.message, /must be the hostname/);
        return true;
      },
    );
  });

  test('missing values fail with instructions rather than a stack trace', () => {
    assert.throws(() => authConfig({}, false), AuthConfigError);
    assert.throws(() => authConfig({ MANILLA_RP_ID: 'localhost' }, false), AuthConfigError);
  });

  test('an origin with a path is refused, because the browser never sends one', () => {
    assert.throws(
      () =>
        authConfig({ MANILLA_RP_ID: 'localhost', MANILLA_ORIGIN: 'http://localhost:3000/app' }, false),
      AuthConfigError,
    );
  });

  test('a nonsense origin is refused', () => {
    assert.throws(
      () => authConfig({ MANILLA_RP_ID: 'localhost', MANILLA_ORIGIN: 'localhost:3000' }, false),
      AuthConfigError,
    );
  });

  test('production refuses localhost, as docker-compose.yml promises', () => {
    assert.throws(
      () => authConfig(LOCAL, true),
      (error: unknown) => {
        assert.ok(error instanceof AuthConfigError);
        assert.match(error.message, /still "localhost" in production/);
        return true;
      },
    );
  });

  test('production refuses plain HTTP on a real hostname', () => {
    assert.throws(
      () =>
        authConfig(
          {
            MANILLA_RP_ID: 'manilla.example-tailnet.ts.net',
            MANILLA_ORIGIN: 'http://manilla.example-tailnet.ts.net',
          },
          true,
        ),
      (error: unknown) => {
        assert.ok(error instanceof AuthConfigError);
        assert.match(error.message, /must be https in production/);
        return true;
      },
    );
  });

  test('the Tailscale pair from the deployment notes is accepted in production', () => {
    const config = authConfig(TAILNET, true);
    assert.equal(config.rpId, 'manilla.example-tailnet.ts.net');
    assert.equal(config.origin, 'https://manilla.example-tailnet.ts.net');
  });

  test('a custom relying-party name comes through', () => {
    assert.equal(authConfig({ ...LOCAL, MANILLA_RP_NAME: 'Home budget' }, false).rpName, 'Home budget');
  });

  test('only https and localhost count as secure origins', () => {
    assert.equal(isSecureOrigin('https://manilla.example-tailnet.ts.net'), true);
    assert.equal(isSecureOrigin('http://localhost:3000'), true);
    assert.equal(isSecureOrigin('http://manilla.example-tailnet.ts.net'), false);
    assert.equal(isSecureOrigin('not a url'), false);
  });
});

describe('recovery codes', () => {
  test('a code is three readable groups and avoids look-alike letters', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = makeRecoveryCode();
      assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.equal(/[ILOU]/.test(code), false, `${code} contains a look-alike letter`);
    }
  });

  test('a set of codes is all distinct', () => {
    const codes = makeRecoveryCodes(10);
    assert.equal(new Set(codes).size, 10);
  });

  test('case and punctuation are noise when typing one back', () => {
    const code = makeRecoveryCode();
    assert.equal(normalizeRecoveryCode(code.toLowerCase()), normalizeRecoveryCode(code));
    assert.equal(normalizeRecoveryCode(code.replace(/-/g, ' ')), normalizeRecoveryCode(code));
    assert.equal(hashRecoveryCode(code.toLowerCase().replace(/-/g, '')), hashRecoveryCode(code));
  });
});

const available = await databaseAvailable();

describe(
  'sessions and passkeys',
  { skip: available ? false : 'No Postgres reachable; run `docker compose up -d db`' },
  () => {
    let db: Database;

    before(async () => {
      db = await setupTestDb('auth');
    });

    beforeEach(async () => {
      await truncateAll(db);
    });

    after(async () => {
      await closeDb(db);
    });

    const makeUser = async (name = 'Me') => {
      const [row] = await db.insert(users).values({ name }).returning({ id: users.id });
      return row!.id;
    };

    const makeCredential = async (userId: string, id: string) => {
      await db.insert(credentials).values({
        id,
        userId,
        publicKey: Buffer.from('not-a-real-key').toString('base64url'),
        counter: 0,
        label: id,
      });
    };

    // -- sessions ----------------------------------------------------------

    test('a session round-trips, and the token itself is never stored', async () => {
      const userId = await makeUser('Mark');
      const { token } = await createSession(db, userId);

      const active = await verifySession(db, token);
      assert.ok(active);
      assert.equal(active.userId, userId);
      assert.equal(active.userName, 'Mark');

      const [row] = await db.select().from(sessions);
      assert.equal(row!.id, hashToken(token));
      assert.equal(row!.id.includes(token), false, 'the cookie value is not in the database');
    });

    test('an unknown or absent token is simply not a session', async () => {
      assert.equal(await verifySession(db, undefined), null);
      assert.equal(await verifySession(db, 'made-up'), null);
    });

    test('an idle session lapses and its row is cleared away', async () => {
      const userId = await makeUser();
      const start = new Date('2026-09-19T08:00:00Z');
      const { token } = await createSession(db, userId, start);

      const justInside = new Date(start.getTime() + IDLE_TIMEOUT_MS - 1000);
      assert.ok(await verifySession(db, token, justInside));

      const pastIt = new Date(start.getTime() + IDLE_TIMEOUT_MS * 2);
      assert.equal(await verifySession(db, token, pastIt), null);
      assert.equal((await db.select().from(sessions)).length, 0);
    });

    test('using a session extends it, but never past the absolute cap', async () => {
      const userId = await makeUser();
      const start = new Date('2026-09-01T08:00:00Z');
      const { token, expiresAt } = await createSession(db, userId, start);

      // Well into the second half of the idle window: this use should extend it.
      const later = new Date(start.getTime() + IDLE_TIMEOUT_MS * 0.9);
      const extended = await verifySession(db, token, later);
      assert.ok(extended);
      assert.ok(extended.expiresAt > expiresAt, 'the idle timeout moved out');

      // Stand in for a month of daily use: the idle timeout has been carried along
      // to just short of the absolute cap.
      const nearCap = new Date(start.getTime() + ABSOLUTE_TIMEOUT_MS - 20 * 60_000);
      await db
        .update(sessions)
        .set({ expiresAt: nearCap })
        .where(eq(sessions.id, hashToken(token)));

      const clipped = await verifySession(db, token, new Date(nearCap.getTime() - 60_000));
      assert.ok(clipped, 'still a live session');
      assert.equal(
        clipped.expiresAt.getTime(),
        clipped.endsAt.getTime(),
        'the extension is clipped to the cap rather than reaching past it',
      );

      // And past the cap, no amount of activity helps.
      const after = new Date(start.getTime() + ABSOLUTE_TIMEOUT_MS + 1000);
      assert.equal(await verifySession(db, token, after), null);
    });

    test('an early use does not write to the database for nothing', async () => {
      const userId = await makeUser();
      const start = new Date('2026-09-19T08:00:00Z');
      const { token, expiresAt } = await createSession(db, userId, start);

      const soon = new Date(start.getTime() + 60_000);
      const active = await verifySession(db, token, soon);
      assert.equal(active!.expiresAt.getTime(), expiresAt.getTime(), 'unchanged');
    });

    test('signing out drops that session and leaves the others', async () => {
      const userId = await makeUser();
      const phone = await createSession(db, userId);
      const laptop = await createSession(db, userId);

      await destroySession(db, phone.token);
      assert.equal(await verifySession(db, phone.token), null);
      assert.ok(await verifySession(db, laptop.token));
    });

    test('signing out everywhere drops all of them', async () => {
      const userId = await makeUser();
      const phone = await createSession(db, userId);
      const laptop = await createSession(db, userId);

      assert.equal(await destroyAllSessions(db, userId), 2);
      assert.equal(await verifySession(db, phone.token), null);
      assert.equal(await verifySession(db, laptop.token), null);
    });

    test('purging removes lapsed sessions and keeps live ones', async () => {
      const userId = await makeUser();
      await createSession(db, userId, new Date('2026-01-01T00:00:00Z'));
      const live = await createSession(db, userId, new Date());

      assert.ok(await verifySession(db, live.token));
      assert.equal(await purgeExpiredSessions(db), 0, 'the sign-in above already swept');
    });

    // A session nobody comes back to is never met by `verifySession`, so without
    // a sweep somewhere the table only ever grows.
    test('signing in sweeps the sessions nobody came back to', async () => {
      const userId = await makeUser();
      await createSession(db, userId, new Date('2026-01-01T00:00:00Z'));
      await createSession(db, userId, new Date('2026-02-01T00:00:00Z'));

      const live = await createSession(db, userId, new Date());

      const rows = await db.select().from(sessions);
      assert.equal(rows.length, 1, 'both lapsed rows went on the way in');
      assert.ok(await verifySession(db, live.token));
    });

    // -- registration and challenges --------------------------------------

    test('first-run setup offers registration, and stores a challenge for it', async () => {
      const state = await setupState(db);
      assert.equal(state.needsSetup, true);
      assert.equal(state.credentialCount, 0);

      const begun = await beginRegistration(db, {
        userName: 'Mark',
        config: authConfig(LOCAL, false),
      });

      assert.ok(begun.options.challenge);
      assert.equal(begun.options.rp.id, 'localhost');
      assert.equal(begun.options.authenticatorSelection?.userVerification, 'required');
      assert.equal(begun.options.authenticatorSelection?.residentKey, 'required');

      const [stored] = await db.select().from(webauthnChallenges);
      assert.equal(stored!.id, begun.challengeId);
      assert.equal(stored!.purpose, 'registration');
      assert.equal(stored!.challenge, begun.options.challenge);
    });

    test('once a passkey exists, open registration is refused', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');

      await assert.rejects(
        () => beginRegistration(db, { config: authConfig(LOCAL, false) }),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /already has a passkey/);
          return true;
        },
      );
    });

    test('adding a device offers the existing one as excluded', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');

      const begun = await beginRegistration(db, {
        userId,
        config: authConfig(LOCAL, false),
      });
      assert.deepEqual(
        begun.options.excludeCredentials?.map((credential) => credential.id),
        ['credential-one'],
      );
    });

    test('a challenge is spent by the first attempt, however that attempt ends', async () => {
      const begun = await beginRegistration(db, {
        userName: 'Mark',
        config: authConfig(LOCAL, false),
      });

      // A response the authenticator never produced: verification must fail.
      await assert.rejects(() =>
        finishRegistration(db, {
          challengeId: begun.challengeId,
          response: {
            id: 'made-up',
            rawId: 'made-up',
            type: 'public-key',
            clientExtensionResults: {},
            response: { clientDataJSON: '', attestationObject: '' },
          } as never,
          config: authConfig(LOCAL, false),
        }),
      );

      assert.equal((await db.select().from(webauthnChallenges)).length, 0, 'challenge consumed');

      await assert.rejects(
        () =>
          finishRegistration(db, {
            challengeId: begun.challengeId,
            response: {} as never,
            config: authConfig(LOCAL, false),
          }),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /no longer valid/);
          return true;
        },
      );

      assert.equal(await primaryUser(db), undefined, 'and no user was created');
    });

    test('a registration challenge cannot be spent as an authentication one', async () => {
      const begun = await beginRegistration(db, {
        userName: 'Mark',
        config: authConfig(LOCAL, false),
      });

      const { finishAuthentication } = await import('./passkeys.ts');
      await assert.rejects(
        () =>
          finishAuthentication(db, {
            challengeId: begun.challengeId,
            response: { id: 'made-up' } as never,
            config: authConfig(LOCAL, false),
          }),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /no longer valid/);
          return true;
        },
      );
    });

    test('an expired challenge is refused', async () => {
      const begun = await beginRegistration(db, {
        userName: 'Mark',
        config: authConfig(LOCAL, false),
      });
      await db
        .update(webauthnChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(webauthnChallenges.id, begun.challengeId));

      await assert.rejects(
        () =>
          finishRegistration(db, {
            challengeId: begun.challengeId,
            response: {} as never,
            config: authConfig(LOCAL, false),
          }),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /expired/);
          return true;
        },
      );
    });

    test('a sign-in challenge names no credentials, so the page gives nothing away', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');

      const begun = await beginAuthentication(db, { config: authConfig(LOCAL, false) });
      assert.equal(begun.options.allowCredentials, undefined);
      assert.equal(begun.options.userVerification, 'required');

      const [stored] = await db.select().from(webauthnChallenges);
      assert.equal(stored!.purpose, 'authentication');
    });

    test('signing in with an unregistered passkey is refused', async () => {
      const begun = await beginAuthentication(db, { config: authConfig(LOCAL, false) });
      const { finishAuthentication } = await import('./passkeys.ts');

      await assert.rejects(
        () =>
          finishAuthentication(db, {
            challengeId: begun.challengeId,
            response: { id: 'never-registered' } as never,
            config: authConfig(LOCAL, false),
          }),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /not registered/);
          return true;
        },
      );
    });

    test('starting a ceremony clears out challenges nobody finished', async () => {
      await beginAuthentication(db, { config: authConfig(LOCAL, false) });
      await db
        .update(webauthnChallenges)
        .set({ expiresAt: new Date(Date.now() - 1000) });

      await beginAuthentication(db, { config: authConfig(LOCAL, false) });
      const rows = await db.select().from(webauthnChallenges);
      assert.equal(rows.length, 1, 'the stale one went with the new one being made');
    });

    // -- devices ------------------------------------------------------------

    test('devices are listed oldest first and can be renamed', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');
      await makeCredential(userId, 'credential-two');

      await renameDevice(db, userId, 'credential-two', '  Pixel 9  ');
      const devices = await listDevices(db, userId);
      assert.equal(devices.length, 2);
      assert.equal(devices.find((device) => device.id === 'credential-two')!.label, 'Pixel 9');
    });

    test('the only passkey cannot be removed', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');

      await assert.rejects(
        () => removeDevice(db, userId, 'credential-one'),
        (error: unknown) => {
          assert.ok(error instanceof AuthError);
          assert.match(error.message, /only passkey/);
          return true;
        },
      );
      assert.equal((await listDevices(db, userId)).length, 1);
    });

    test('a second passkey can be removed once there is a spare', async () => {
      const userId = await makeUser();
      await makeCredential(userId, 'credential-one');
      await makeCredential(userId, 'credential-two');

      await removeDevice(db, userId, 'credential-two');
      assert.deepEqual(
        (await listDevices(db, userId)).map((device) => device.id),
        ['credential-one'],
      );
    });

    // -- recovery codes -----------------------------------------------------

    test('a recovery code signs in once and only once', async () => {
      const userId = await makeUser();
      const codes = await regenerateRecoveryCodes(db, userId);
      assert.equal(codes.length, 10);
      assert.equal(await countUnusedRecoveryCodes(db, userId), 10);

      assert.equal(await redeemRecoveryCode(db, codes[3]!), userId);
      assert.equal(await redeemRecoveryCode(db, codes[3]!), null, 'the same code will not work twice');
      assert.equal(await countUnusedRecoveryCodes(db, userId), 9);
    });

    test('a code is accepted however it was typed', async () => {
      const userId = await makeUser();
      const codes = await regenerateRecoveryCodes(db, userId);
      assert.equal(await redeemRecoveryCode(db, codes[0]!.toLowerCase().replace(/-/g, ' ')), userId);
    });

    test('an unknown code is rejected without a hint', async () => {
      const userId = await makeUser();
      await regenerateRecoveryCodes(db, userId);
      assert.equal(await redeemRecoveryCode(db, 'ZZZZ-ZZZZ-ZZZZ'), null);
      assert.equal(await redeemRecoveryCode(db, ''), null);
      assert.equal(await countUnusedRecoveryCodes(db, userId), 10, 'and nothing was spent');
    });

    test('only the hash of a code is stored', async () => {
      const userId = await makeUser();
      const codes = await regenerateRecoveryCodes(db, userId);
      const rows = await db.select().from(recoveryCodes);
      const stored = rows.map((row) => row.codeHash);

      for (const code of codes) {
        assert.equal(stored.includes(code), false);
        assert.equal(stored.includes(normalizeRecoveryCode(code)), false);
      }
      assert.ok(stored.includes(hashRecoveryCode(codes[0]!)));
    });

    test('regenerating replaces the whole set, so old codes stop working', async () => {
      const userId = await makeUser();
      const first = await regenerateRecoveryCodes(db, userId);
      const second = await regenerateRecoveryCodes(db, userId);

      assert.equal(await redeemRecoveryCode(db, first[0]!), null);
      assert.equal(await redeemRecoveryCode(db, second[0]!), userId);
    });
  },
);
