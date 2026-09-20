'use server';

/**
 * Settings actions: the passkeys and sessions behind NF-3.
 *
 * Every one of these begins with `requireUser()`. A server action is a POST
 * endpoint that happens to be written in TypeScript, so the session check belongs
 * inside the action and not only in the page that renders the button.
 */

import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { db } from '../../db/client.ts';
import {
  beginRegistration,
  finishRegistration,
  regenerateRecoveryCodes,
  removeDevice,
  renameDevice,
} from '../../src/auth/passkeys.ts';
import { destroyAllSessions } from '../../src/auth/session.ts';
import { deleteRule } from '../../src/rules/rules.ts';
import { eraseAllData } from '../../src/export/export.ts';
import { clearAnswerCache, setAiSettings } from '../../src/ai/ai.ts';
import { currentSession, endSession, requireUser } from '../auth.ts';
import type { BeginResult, Failure } from '../login/actions.ts';

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function beginAddDeviceAction(): Promise<
  BeginResult<PublicKeyCredentialCreationOptionsJSON>
> {
  try {
    const session = await requireUser();
    const begun = await beginRegistration(db(), {
      userId: session.userId,
      userName: session.userName,
    });
    return { ok: true, ...begun };
  } catch (error) {
    return failed(error);
  }
}

export async function finishAddDeviceAction(input: {
  challengeId: string;
  response: RegistrationResponseJSON;
  label: string;
}): Promise<{ ok: true } | Failure> {
  try {
    const session = await requireUser();
    await finishRegistration(db(), {
      challengeId: input.challengeId,
      response: input.response,
      userId: session.userId,
      label: input.label,
    });
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function renameDeviceAction(
  credentialId: string,
  label: string,
): Promise<{ ok: true } | Failure> {
  try {
    const session = await requireUser();
    await renameDevice(db(), session.userId, credentialId, label);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function removeDeviceAction(
  credentialId: string,
): Promise<{ ok: true } | Failure> {
  try {
    const session = await requireUser();
    await removeDevice(db(), session.userId, credentialId);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteRuleAction(ruleId: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    await deleteRule(db(), ruleId);
    revalidatePath('/settings');
    revalidatePath('/review');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * NF-6's delete-everything. The phrase has to be typed out: a button that wipes
 * six years of history should be impossible to press by accident, and a
 * confirmation dialog is one stray tap.
 */
export async function eraseEverythingAction(
  phrase: string,
): Promise<{ ok: true; removed: Record<string, number> } | Failure> {
  try {
    await requireUser();
    if (phrase.trim().toLowerCase() !== 'erase everything') {
      return { ok: false, error: 'Not erased: the phrase did not match.' };
    }

    const removed = await eraseAllData(db());
    revalidatePath('/settings');
    revalidatePath('/');
    revalidatePath('/accounts');
    revalidatePath('/envelopes');
    revalidatePath('/budget');
    return { ok: true, removed };
  } catch (error) {
    return failed(error);
  }
}

export async function setAiSettingsAction(update: {
  enabled?: boolean;
  monthlyCallBudget?: number;
}): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    await setAiSettings(db(), update);
    revalidatePath('/settings');
    revalidatePath('/import');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function clearAiCacheAction(): Promise<{ ok: true; removed: number } | Failure> {
  try {
    await requireUser();
    const removed = await clearAnswerCache(db());
    revalidatePath('/settings');
    return { ok: true, removed };
  } catch (error) {
    return failed(error);
  }
}

export async function regenerateRecoveryCodesAction(): Promise<
  { ok: true; codes: string[] } | Failure
> {
  try {
    const session = await requireUser();
    const codes = await regenerateRecoveryCodes(db(), session.userId);
    revalidatePath('/settings');
    return { ok: true, codes };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Sign out of every device, for a phone left in a taxi. This session goes with
 * them, which is why it ends at the sign-in page.
 */
export async function signOutEverywhereAction(): Promise<void> {
  const session = await currentSession();
  if (session) {
    await destroyAllSessions(db(), session.userId);
    await endSession();
  }
  redirect('/login');
}
