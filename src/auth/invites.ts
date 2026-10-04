/**
 * More than one person in a household (NF-3).
 *
 * Everyone who signs in sees and changes the same books: a member is a set of
 * passkeys and recovery codes, not an owner of anything. So joining is only
 * ever about sign-in, and removing someone touches nothing but their way in.
 *
 * A member brings another in with an invitation link rather than a recovery
 * code. A recovery code is a lasting credential for the person who holds it; an
 * invitation is spent by the first passkey it registers, lapses after a few
 * days, can be withdrawn, and makes the newcomer a person of their own with
 * their own codes - so losing their phone, or their leaving, never involves
 * anybody else's.
 *
 * The token lives in the link's fragment (`/login/join#...`), which a browser
 * never sends, so it does not land in a proxy's or server's request log. The
 * page hands it to the actions itself.
 */

import { createHash, randomBytes } from 'node:crypto';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { credentials, invites, recoveryCodes, users } from '../../db/schema.ts';
import { authConfig, type AuthConfig } from './config.ts';
import {
  AuthError,
  consumeChallenge,
  createChallenge,
  hashRecoveryCode,
  makeRecoveryCodes,
  verifyNewPasskey,
} from './passkeys.ts';

/** Long enough to reach someone over a weekend, short enough to be forgotten safely. */
export const INVITE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Outstanding at once. More than this is a link being made for nobody in particular. */
export const MAX_PENDING_INVITES = 5;

const NAME_MAX = 60;

const SPENT =
  'This invitation has expired, been withdrawn, or already been used. Ask for a new link.';

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('base64url');
}

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
  if (!clean) throw new AuthError('A name is needed, so everyone can tell who is who.');
  return clean;
}

/** Still usable: not spent, not withdrawn (deleted), not lapsed. */
function usable(tokenHash: string, now: Date) {
  return and(eq(invites.tokenHash, tokenHash), isNull(invites.usedAt), gt(invites.expiresAt, now));
}

// ---------------------------------------------------------------------------
// Making and withdrawing
// ---------------------------------------------------------------------------

export type CreatedInvite = { id: string; token: string; expiresAt: Date };

export async function createInvite(
  db: Database,
  input: { createdBy: string; name: string; now?: Date },
): Promise<CreatedInvite> {
  const now = input.now ?? new Date();
  const name = cleanName(input.name);

  const pending = await listPendingInvites(db, now);
  if (pending.length >= MAX_PENDING_INVITES) {
    throw new AuthError(
      `There are already ${pending.length} invitations waiting. Withdraw one you no longer need first.`,
    );
  }

  // 256 bits: it is the whole of the credential until the passkey exists.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const [row] = await db
    .insert(invites)
    .values({ tokenHash: hashInviteToken(token), name, createdBy: input.createdBy, expiresAt })
    .returning({ id: invites.id });

  return { id: row!.id, token, expiresAt };
}

export type PendingInvite = {
  id: string;
  name: string;
  createdByName: string;
  createdAt: Date;
  expiresAt: Date;
};

export async function listPendingInvites(
  db: Database,
  now: Date = new Date(),
): Promise<PendingInvite[]> {
  return db
    .select({
      id: invites.id,
      name: invites.name,
      createdByName: users.name,
      createdAt: invites.createdAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.createdBy))
    .where(and(isNull(invites.usedAt), gt(invites.expiresAt, now)))
    .orderBy(asc(invites.createdAt));
}

/**
 * Withdraw an invitation nobody has used. A spent one is history and stays.
 * Returns who it was for, or null if there was nothing to withdraw.
 */
export async function withdrawInvite(db: Database, inviteId: string): Promise<string | null> {
  const [row] = await db
    .delete(invites)
    .where(and(eq(invites.id, inviteId), isNull(invites.usedAt)))
    .returning({ name: invites.name });
  return row?.name ?? null;
}

// ---------------------------------------------------------------------------
// Joining
// ---------------------------------------------------------------------------

export type InviteView = { name: string; invitedBy: string };

/** What the join page may show for a token, or null if it would not work. */
export async function lookUpInvite(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<InviteView | null> {
  const [row] = await db
    .select({ name: invites.name, invitedBy: users.name })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.createdBy))
    .where(usable(hashInviteToken(token), now))
    .limit(1);
  return row ?? null;
}

export async function beginJoin(
  db: Database,
  input: { token: string; name: string; config?: AuthConfig; now?: Date },
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const config = input.config ?? authConfig();
  const name = cleanName(input.name);
  if (!(await lookUpInvite(db, input.token, input.now))) throw new AuthError(SPENT);

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: name,
    userDisplayName: name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = await createChallenge(db, options.challenge, 'registration');
  return { challengeId, options };
}

export type Joined = { userId: string; recoveryCodes: string[]; invitedBy: string | null };

/**
 * Register the newcomer's passkey and spend the invitation, together or not at
 * all.
 *
 * The passkey is verified before the invitation is touched, so a cancelled or
 * failed attempt leaves the link working. Claiming it is then a single
 * conditional update, so two attempts racing with one link make one person.
 */
export async function finishJoin(
  db: Database,
  input: {
    token: string;
    challengeId: string;
    response: RegistrationResponseJSON;
    name: string;
    label?: string;
    config?: AuthConfig;
    now?: Date;
  },
): Promise<Joined> {
  const config = input.config ?? authConfig();
  const now = input.now ?? new Date();
  const name = cleanName(input.name);
  const pending = await consumeChallenge(db, input.challengeId, 'registration', now);
  // A challenge that belongs to a signed-in member is for adding their device.
  if (pending.userId) throw new AuthError('That registration was started by a different sign-in.');

  const passkey = await verifyNewPasskey(pending.challenge, input.response, input.label, config);

  return db.transaction(async (tx) => {
    const [invite] = await tx
      .update(invites)
      .set({ usedAt: now })
      .where(usable(hashInviteToken(input.token), now))
      .returning({ id: invites.id, createdBy: invites.createdBy });
    if (!invite) throw new AuthError(SPENT);
    const [inviter] = await tx
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, invite.createdBy));

    const [user] = await tx.insert(users).values({ name }).returning({ id: users.id });
    const userId = user!.id;
    await tx.insert(credentials).values({ ...passkey, userId });

    const codes = makeRecoveryCodes();
    await tx
      .insert(recoveryCodes)
      .values(codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })));
    await tx.update(invites).set({ usedBy: userId }).where(eq(invites.id, invite.id));

    return { userId, recoveryCodes: codes, invitedBy: inviter?.name ?? null };
  });
}

// ---------------------------------------------------------------------------
// Who is in
// ---------------------------------------------------------------------------

export type Member = { id: string; name: string; joinedAt: Date; passkeys: number };

export async function listMembers(db: Database): Promise<Member[]> {
  return db
    .select({
      id: users.id,
      name: users.name,
      joinedAt: users.createdAt,
      passkeys: count(credentials.id),
    })
    .from(users)
    .leftJoin(credentials, eq(credentials.userId, users.id))
    .groupBy(users.id)
    .orderBy(asc(users.createdAt));
}

/**
 * Take someone's way in away: their passkeys, recovery codes and sessions go
 * with them, so a signed-in browser of theirs is signed out at its next request.
 * Nothing they entered goes, because none of it was theirs alone.
 *
 * Not yourself: that is how a household ends up with nobody who can sign in.
 */
export async function removeMember(
  db: Database,
  input: { actingUserId: string; userId: string },
): Promise<{ id: string; name: string }> {
  if (input.actingUserId === input.userId) {
    throw new AuthError('You cannot remove yourself. Someone else in the household can.');
  }
  const removed = await db
    .delete(users)
    .where(eq(users.id, input.userId))
    .returning({ id: users.id, name: users.name });
  if (!removed[0]) throw new AuthError('That person is no longer a member.');
  return removed[0];
}
