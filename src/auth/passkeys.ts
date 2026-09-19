/**
 * Passkey registration and sign-in (NF-3).
 *
 * WebAuthn is used rather than a password because this app holds a full financial
 * history and is reachable, over Tailscale, from a phone. A passkey is phishing-
 * resistant by construction: the credential is bound to the origin, so there is
 * nothing to type into the wrong site and nothing to reuse elsewhere.
 *
 * Decisions worth stating:
 *
 *  - **Challenges live in the database and are deleted on use.** A challenge is
 *    what makes an assertion fresh rather than replayable; storing it in a cookie
 *    would hand that guarantee to the party being authenticated. `consumeChallenge`
 *    deletes the row in the same statement that reads it, so a response can be
 *    presented exactly once.
 *  - **User verification is required, not preferred.** A passkey the device hands
 *    over without a fingerprint or PIN is one factor, and NF-3 asks for two.
 *  - **Recovery codes exist because a single authenticator is a single point of
 *    failure.** A dropped phone should not mean a lost ledger. They are stored
 *    hashed and single-use, and signing in with one only gets you far enough to
 *    register a new passkey.
 *  - **The last passkey cannot be deleted.** Removing it would lock the account to
 *    recovery codes alone, which is a decision nobody makes deliberately.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  credentials,
  recoveryCodes,
  users,
  webauthnChallenges,
} from '../../db/schema.ts';
import { authConfig, type AuthConfig } from './config.ts';

export class AuthError extends Error {}

/** How long a ceremony may take before its challenge is stale. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const RECOVERY_CODE_COUNT = 10;

// ---------------------------------------------------------------------------
// Who exists
// ---------------------------------------------------------------------------

export type Identity = { id: string; name: string };

/**
 * The single user, if there is one.
 *
 * Version 1 is single-user (section 2), but the schema is keyed by row so a second
 * login is additive later. Until then "the user" means the only one.
 */
export async function primaryUser(db: Database): Promise<Identity | undefined> {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  return row;
}

export type SetupState = {
  /** True before anybody has registered: the first visit sets up the account. */
  needsSetup: boolean;
  user?: Identity;
  credentialCount: number;
  unusedRecoveryCodes: number;
};

export async function setupState(db: Database): Promise<SetupState> {
  const user = await primaryUser(db);
  if (!user) return { needsSetup: true, credentialCount: 0, unusedRecoveryCodes: 0 };

  const [keys, codes] = await Promise.all([
    db.select({ id: credentials.id }).from(credentials).where(eq(credentials.userId, user.id)),
    db
      .select({ id: recoveryCodes.id })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt))),
  ]);

  return {
    needsSetup: keys.length === 0,
    user,
    credentialCount: keys.length,
    unusedRecoveryCodes: codes.length,
  };
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

async function createChallenge(
  db: Database,
  challenge: string,
  purpose: 'registration' | 'authentication',
  userId?: string,
  now: Date = new Date(),
): Promise<string> {
  // Opportunistic cleanup: a ceremony nobody finished leaves a row behind, and
  // this is the only code path that ever creates one.
  await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));

  const [row] = await db
    .insert(webauthnChallenges)
    .values({
      challenge,
      purpose,
      userId: userId ?? null,
      expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
    })
    .returning({ id: webauthnChallenges.id });

  return row!.id;
}

/**
 * Read a challenge and delete it in the same statement, so it can only be spent
 * once even if two responses arrive together.
 */
async function consumeChallenge(
  db: Database,
  challengeId: string,
  purpose: 'registration' | 'authentication',
  now: Date = new Date(),
): Promise<{ challenge: string; userId: string | null }> {
  const [row] = await db
    .delete(webauthnChallenges)
    .where(and(eq(webauthnChallenges.id, challengeId), eq(webauthnChallenges.purpose, purpose)))
    .returning({
      challenge: webauthnChallenges.challenge,
      userId: webauthnChallenges.userId,
      expiresAt: webauthnChallenges.expiresAt,
    });

  if (!row) {
    throw new AuthError('That sign-in attempt is no longer valid. Start again.');
  }
  if (row.expiresAt <= now) {
    throw new AuthError('That took too long and the challenge expired. Start again.');
  }

  return { challenge: row.challenge, userId: row.userId };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export type BeginRegistration = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

/**
 * Start registering a passkey.
 *
 * With no `userId` this is first-run setup and is refused once a passkey exists,
 * so the sign-in page cannot be used to add an authenticator to somebody else's
 * ledger. With a `userId` it is "add this device", and the caller is responsible
 * for having checked the session first.
 */
export async function beginRegistration(
  db: Database,
  options: { userId?: string; userName?: string; config?: AuthConfig } = {},
): Promise<BeginRegistration> {
  const config = options.config ?? authConfig();
  const state = await setupState(db);

  if (!options.userId && !state.needsSetup) {
    throw new AuthError(
      'This Manilla already has a passkey. Sign in first, then add another device from Settings.',
    );
  }

  const userId = options.userId ?? state.user?.id;
  const userName = options.userName ?? state.user?.name ?? 'Manilla';

  const existing = userId
    ? await db
        .select({ id: credentials.id, transports: credentials.transports })
        .from(credentials)
        .where(eq(credentials.userId, userId))
    : [];

  const created = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName,
    userDisplayName: userName,
    attestationType: 'none',
    // Discoverable credential with user verification: one tap, two factors, and
    // no username to type.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // A device already registered should not be offered again.
    excludeCredentials: existing.map((row) => ({
      id: row.id,
      ...(row.transports ? { transports: row.transports.split(',') } : {}),
    })),
  });

  const challengeId = await createChallenge(
    db,
    created.challenge,
    'registration',
    userId ?? undefined,
  );

  return { challengeId, options: created };
}

export type FinishRegistration = {
  userId: string;
  credentialId: string;
  /** Present only on first-run setup, and shown to the user exactly once. */
  recoveryCodes?: string[];
};

export async function finishRegistration(
  db: Database,
  input: {
    challengeId: string;
    response: RegistrationResponseJSON;
    label?: string;
    /** The signed-in user, when this is "add a device" rather than setup. */
    userId?: string;
    userName?: string;
    config?: AuthConfig;
  },
): Promise<FinishRegistration> {
  const config = input.config ?? authConfig();
  const pending = await consumeChallenge(db, input.challengeId, 'registration');

  // The challenge remembers who started the ceremony; a caller claiming to be
  // somebody else does not get to finish it.
  if (pending.userId && input.userId && pending.userId !== input.userId) {
    throw new AuthError('That registration was started by a different sign-in.');
  }

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: pending.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  });

  if (!verification.verified) {
    throw new AuthError('That authenticator could not be verified.');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const label = (input.label ?? '').trim() || describeDevice(credentialDeviceType, credentialBackedUp);

  return db.transaction(async (tx) => {
    let userId = pending.userId ?? input.userId;
    let issueRecoveryCodes = false;

    if (!userId) {
      const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
      if (existing) {
        userId = existing.id;
      } else {
        const [created] = await tx
          .insert(users)
          .values({ name: (input.userName ?? '').trim() || 'Me' })
          .returning({ id: users.id });
        userId = created!.id;
      }
      issueRecoveryCodes = true;
    }

    await tx.insert(credentials).values({
      id: credential.id,
      userId,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports?.length ? credential.transports.join(',') : null,
      label,
    });

    let codes: string[] | undefined;
    if (issueRecoveryCodes) {
      codes = makeRecoveryCodes();
      await tx.insert(recoveryCodes).values(
        codes.map((code) => ({ userId: userId!, codeHash: hashRecoveryCode(code) })),
      );
    }

    return {
      userId: userId!,
      credentialId: credential.id,
      ...(codes ? { recoveryCodes: codes } : {}),
    };
  });
}

function describeDevice(deviceType: string, backedUp: boolean): string {
  if (deviceType === 'multiDevice') return backedUp ? 'Synced passkey' : 'Multi-device passkey';
  return 'This device';
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export type BeginAuthentication = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

/**
 * Start a sign-in.
 *
 * No `allowCredentials` list is sent: the credentials are discoverable, so the
 * browser offers whichever passkey it holds for this origin. That also means the
 * page gives away nothing about which authenticators are registered.
 */
export async function beginAuthentication(
  db: Database,
  options: { config?: AuthConfig } = {},
): Promise<BeginAuthentication> {
  const config = options.config ?? authConfig();

  const created = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
  });

  const challengeId = await createChallenge(db, created.challenge, 'authentication');
  return { challengeId, options: created };
}

export type FinishAuthentication = {
  userId: string;
  credentialId: string;
};

export async function finishAuthentication(
  db: Database,
  input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
    config?: AuthConfig;
    now?: Date;
  },
): Promise<FinishAuthentication> {
  const config = input.config ?? authConfig();
  const now = input.now ?? new Date();
  const pending = await consumeChallenge(db, input.challengeId, 'authentication', now);

  const [stored] = await db
    .select()
    .from(credentials)
    .where(eq(credentials.id, input.response.id))
    .limit(1);

  if (!stored) {
    throw new AuthError('That passkey is not registered with this Manilla.');
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: pending.challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    credential: {
      id: stored.id,
      publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
      counter: Number(stored.counter),
      ...(stored.transports ? { transports: stored.transports.split(',') } : {}),
    },
  });

  if (!verification.verified) {
    throw new AuthError('That passkey could not be verified.');
  }

  // The counter only ever goes up; the library rejects a replay, and storing the
  // new value is what lets it (FIDO calls this cloned-authenticator detection).
  await db
    .update(credentials)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: now })
    .where(eq(credentials.id, stored.id));

  return { userId: stored.userId, credentialId: stored.id };
}

// ---------------------------------------------------------------------------
// Registered devices
// ---------------------------------------------------------------------------

export type RegisteredDevice = {
  id: string;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
};

export async function listDevices(db: Database, userId: string): Promise<RegisteredDevice[]> {
  return db
    .select({
      id: credentials.id,
      label: credentials.label,
      createdAt: credentials.createdAt,
      lastUsedAt: credentials.lastUsedAt,
    })
    .from(credentials)
    .where(eq(credentials.userId, userId))
    .orderBy(asc(credentials.createdAt));
}

export async function renameDevice(
  db: Database,
  userId: string,
  credentialId: string,
  label: string,
): Promise<void> {
  const clean = label.trim().slice(0, 60);
  if (!clean) throw new AuthError('A device needs a name');
  await db
    .update(credentials)
    .set({ label: clean })
    .where(and(eq(credentials.id, credentialId), eq(credentials.userId, userId)));
}

/** Removing the last passkey would leave recovery codes as the only way in. */
export async function removeDevice(
  db: Database,
  userId: string,
  credentialId: string,
): Promise<void> {
  const devices = await listDevices(db, userId);
  if (devices.length <= 1) {
    throw new AuthError(
      'This is the only passkey registered. Add another device first, or you would be locked out ' +
        'to recovery codes alone.',
    );
  }
  await db
    .delete(credentials)
    .where(and(eq(credentials.id, credentialId), eq(credentials.userId, userId)));
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Crockford-style base32 without the letters that get misread by eye (I, L, O, U),
 * because these get written on paper and typed back in months later.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function codeGroup(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

/** Three groups of four: 60 bits of entropy, readable aloud. */
export function makeRecoveryCode(): string {
  return `${codeGroup(4)}-${codeGroup(4)}-${codeGroup(4)}`;
}

export function makeRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => makeRecoveryCode());
}

/** Case and dashes are noise; the entropy is in the characters. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('base64url');
}

/** Replace the whole set. The old codes stop working, which is the point. */
export async function regenerateRecoveryCodes(db: Database, userId: string): Promise<string[]> {
  const codes = makeRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx
      .insert(recoveryCodes)
      .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
  });
  return codes;
}

/**
 * Spend a recovery code. Returns the user it belonged to, or null.
 *
 * The code is marked used rather than deleted, so "9 of 10 codes left" stays
 * honest and a code cannot be spent twice.
 */
export async function redeemRecoveryCode(
  db: Database,
  code: string,
  now: Date = new Date(),
): Promise<string | null> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return null;

  const hash = hashRecoveryCode(normalized);
  const [row] = await db
    .update(recoveryCodes)
    .set({ usedAt: now })
    .where(and(eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
    .returning({ userId: recoveryCodes.userId });

  return row?.userId ?? null;
}

export async function countUnusedRecoveryCodes(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  return rows.length;
}
