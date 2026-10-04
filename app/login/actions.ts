'use server';

/**
 * Sign-in actions (NF-3).
 *
 * These are the only actions in the app that run without a session, so each one
 * states plainly what makes it safe to be public:
 *
 *  - `beginSetup` / `finishSetup` work only while no passkey exists at all, and
 *    in production only from a tailnet user (src/auth/reach.ts). Once a passkey
 *    exists, registration needs a session and happens in Settings.
 *  - `beginSignIn` / `finishSignIn` prove possession of a registered passkey.
 *  - `signInWithRecoveryCode` spends a single-use code that only the user has,
 *    after a few wrong ones makes each further try wait longer (#14), and is
 *    refused over Funnel, so the internet has nothing to guess at.
 *  - `lookUpInvite` / `beginJoin` / `finishJoin` need an invitation token: 256
 *    random bits that a member made in Settings, which lapse in days and work
 *    once (src/auth/invites.ts). They are open to Funnel on purpose - reaching
 *    someone without Tailscale is what an invitation is for.
 *
 * Failures come back as values rather than exceptions, because a thrown error in
 * a server action reaches the browser as a blank "something went wrong" in
 * production, and "that code has already been used" is worth reading.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { homeDb } from '../../db/client.ts';
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  redeemRecoveryCode,
  setupState,
} from '../../src/auth/passkeys.ts';
import { personOf, recordActivity } from '../../src/auth/activity.ts';
import { beginJoin, finishJoin, lookUpInvite, type InviteView } from '../../src/auth/invites.ts';
import {
  RECOVERY_NEEDS_TAILNET,
  firstSetupGate,
  recoveryAllowed,
  requestReach,
} from '../../src/auth/reach.ts';
import { describeWait, recoveryThrottle } from '../../src/auth/throttle.ts';
import { currentSession, endSession, startSession } from '../auth.ts';

export type Failure = { ok: false; error: string };

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export type BeginResult<Options> = { ok: true; challengeId: string; options: Options } | Failure;

export async function beginSetupAction(
  name: string,
): Promise<BeginResult<PublicKeyCredentialCreationOptionsJSON>> {
  try {
    const state = await setupState(homeDb());
    if (!state.needsSetup) {
      return { ok: false, error: 'This Manilla is already set up. Sign in with your passkey.' };
    }
    const gate = firstSetupGate(requestReach(await headers()));
    if (!gate.allowed) return { ok: false, error: gate.reason };

    const begun = await beginRegistration(homeDb(), { userName: name });
    return { ok: true, ...begun };
  } catch (error) {
    return failed(error);
  }
}

export type SetupResult = { ok: true; recoveryCodes: string[] } | Failure;

export async function finishSetupAction(input: {
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
}): Promise<SetupResult> {
  try {
    const state = await setupState(homeDb());
    if (!state.needsSetup) {
      return { ok: false, error: 'This Manilla is already set up. Sign in with your passkey.' };
    }
    const gate = firstSetupGate(requestReach(await headers()));
    if (!gate.allowed) return { ok: false, error: gate.reason };

    const { userId, recoveryCodes } = await finishRegistration(homeDb(), {
      challengeId: input.challengeId,
      response: input.response,
      userName: input.name,
      label: 'First device',
    });

    await startSession(userId);
    return { ok: true, recoveryCodes: recoveryCodes ?? [] };
  } catch (error) {
    return failed(error);
  }
}

export async function beginSignInAction(): Promise<
  BeginResult<PublicKeyCredentialRequestOptionsJSON>
> {
  try {
    const begun = await beginAuthentication(homeDb());
    return { ok: true, ...begun };
  } catch (error) {
    return failed(error);
  }
}

export type SignInResult = { ok: true } | Failure;

export async function finishSignInAction(input: {
  challengeId: string;
  response: AuthenticationResponseJSON;
}): Promise<SignInResult> {
  try {
    const { userId } = await finishAuthentication(homeDb(), {
      challengeId: input.challengeId,
      response: input.response,
    });
    await startSession(userId);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The way back in from a lost authenticator. A code is spent whether or not the
 * rest of the flow completes, which is the point of it being single-use.
 */
export async function recoveryCodeSignInAction(code: string): Promise<SignInResult> {
  try {
    // Before the throttle, so a stranger's guesses never count against the
    // owner's own attempts from home.
    if (!recoveryAllowed(requestReach(await headers()))) {
      return { ok: false, error: RECOVERY_NEEDS_TAILNET };
    }

    // Checked before the code is: while the wait runs, no code is looked at or
    // spent, right or wrong, or the wait would be no wait at all.
    const wait = recoveryThrottle.waitFor(RECOVERY);
    if (wait > 0) {
      return {
        ok: false,
        error: `Too many recovery codes that did not match. Try again in ${describeWait(wait)}, or sign in with a passkey.`,
      };
    }

    const userId = await redeemRecoveryCode(homeDb(), code);
    if (!userId) {
      const { failures, waitMs } = recoveryThrottle.failed(RECOVERY);
      const source = await who();
      console.warn(
        `[manilla] a recovery code did not match (${failures} in a row) from ${source}` +
          (waitMs > 0 ? `; the next try waits ${describeWait(waitMs)}` : ''),
      );
      // Every one is kept and shown; a phone hears at five in a row, when it
      // stops looking like a typo, and at every five after.
      await recordActivity(
        homeDb(),
        { kind: 'recovery_code_failed', source },
        { alert: failures % 5 === 0 },
      );
      return { ok: false, error: 'That recovery code is not one of yours, or has been used already.' };
    }
    recoveryThrottle.succeeded(RECOVERY);
    const person = await personOf(homeDb(), userId);
    await recordActivity(homeDb(), {
      kind: 'recovery_code_used',
      subject: person,
      actor: person,
      source: await who(),
    });
    await startSession(userId);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

const RECOVERY = 'recovery-code';

export async function lookUpInviteAction(
  token: string,
): Promise<{ ok: true; invite: InviteView } | Failure> {
  try {
    const invite = await lookUpInvite(homeDb(), token);
    if (!invite) {
      return {
        ok: false,
        error:
          'This invitation has expired, been withdrawn, or already been used. Ask for a new link.',
      };
    }
    return { ok: true, invite };
  } catch (error) {
    return failed(error);
  }
}

export async function beginJoinAction(
  token: string,
  name: string,
): Promise<BeginResult<PublicKeyCredentialCreationOptionsJSON>> {
  try {
    const begun = await beginJoin(homeDb(), { token, name });
    return { ok: true, ...begun };
  } catch (error) {
    return failed(error);
  }
}

export async function finishJoinAction(input: {
  token: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  name: string;
}): Promise<SetupResult> {
  try {
    const { userId, recoveryCodes, invitedBy } = await finishJoin(homeDb(), input);
    const source = await who();
    console.info(
      `[manilla] ${JSON.stringify(input.name.trim().slice(0, 60))} joined with an invitation, from ${source}`,
    );
    const person = await personOf(homeDb(), userId);
    await recordActivity(homeDb(), {
      kind: 'member_joined',
      subject: person,
      actor: person,
      detail: invitedBy,
      source,
    });
    await startSession(userId);
    return { ok: true, recoveryCodes };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Who tried, for the log: the tailnet login `tailscale serve` puts on every
 * request it proxies, else the forwarded address - marked as public when it came
 * through Funnel. For a person to read only - the throttle never trusts either,
 * since behind anything but `tailscale serve` a header is what the sender wrote.
 */
async function who(): Promise<string> {
  const request = await headers();
  const named =
    request.get('tailscale-user-login') ?? request.get('x-forwarded-for')?.split(',')[0] ?? null;
  const client = named ? JSON.stringify(named.trim().slice(0, 100)) : 'an unnamed client';
  return requestReach(request) === 'funnel' ? `${client} over Funnel` : client;
}

export async function signOutAction(): Promise<void> {
  // Signing out is only meaningful with a session, and does no harm without one.
  if (await currentSession()) await endSession();
  redirect('/login');
}
