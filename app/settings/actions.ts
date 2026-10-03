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
import { homeDb } from '../../db/client.ts';
import { homeDatabase, ledgerDb, rememberLedger } from '../ledger.ts';
import { openLedger, renameLedger } from '../../src/ledgers/registry.ts';
import {
  beginRegistration,
  finishRegistration,
  regenerateRecoveryCodes,
  removeDevice,
  renameDevice,
} from '../../src/auth/passkeys.ts';
import { destroyAllSessions } from '../../src/auth/session.ts';
import {
  createEnvelopeRule,
  deleteRule,
  dismissRuleSuggestion,
  refreshRuleSuggestionCount,
  undismissRuleSuggestion,
  updateRule,
  type RuleEdit,
} from '../../src/rules/rules.ts';
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
    const begun = await beginRegistration(homeDb(), {
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
    await finishRegistration(homeDb(), {
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
    await renameDevice(homeDb(), session.userId, credentialId, label);
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
    await removeDevice(homeDb(), session.userId, credentialId);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Change a rule. The count is redone because a rule that matches less can let a
 * payee back into the suggestions, and one that matches more can take some out.
 */
export async function updateRuleAction(
  ruleId: string,
  edit: RuleEdit,
): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const connection = await ledgerDb();
    await updateRule(connection, ruleId, edit);
    await refreshRuleSuggestionCount(connection);
    revalidatePath('/settings');
    revalidatePath('/review');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Take back a "no", so the payee can be suggested again. */
export async function undismissRuleAction(contains: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const connection = await ledgerDb();
    await undismissRuleSuggestion(connection, contains);
    await refreshRuleSuggestionCount(connection);
    revalidatePath('/settings');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteRuleAction(ruleId: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const connection = await ledgerDb();
    await deleteRule(connection, ruleId);
    await refreshRuleSuggestionCount(connection);
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

    const removed = await eraseAllData(await ledgerDb());
    revalidatePath('/settings');
    revalidatePath('/');
    revalidatePath('/accounts');
    revalidatePath('/envelopes');
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
    // The account's, not the ledger's: one budget covers every ledger (LG-5).
    await setAiSettings(homeDb(), update);
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
    const removed = await clearAnswerCache(await ledgerDb());
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
    const codes = await regenerateRecoveryCodes(homeDb(), session.userId);
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
    await destroyAllSessions(homeDb(), session.userId);
    await endSession();
  }
  redirect('/login');
}

/** CA-2: accept one suggestion, which is the only way an envelope rule is written. */
export async function acceptRuleAction(contains: string, envelopeId: string) {
  try {
    await requireUser();
    const connection = await ledgerDb();
    await createEnvelopeRule(connection, { contains, envelopeId });
    await refreshRuleSuggestionCount(connection);
    revalidatePath('/settings');
    revalidatePath('/');
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Say no, and stop being asked about that payee. */
export async function dismissRuleAction(contains: string) {
  try {
    await requireUser();
    const connection = await ledgerDb();
    await dismissRuleSuggestion(connection, contains);
    await refreshRuleSuggestionCount(connection);
    revalidatePath('/settings');
    revalidatePath('/');
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Open a new, empty ledger and switch to it (LG-2). Its database is created and
 * brought up to schema before this returns, which takes a moment; four ledgers
 * is the most, and the home one counts.
 */
export async function openLedgerAction(
  name: string,
): Promise<{ ok: true; name: string } | Failure> {
  try {
    await requireUser();
    const ledger = await openLedger(homeDb(), process.env.DATABASE_URL ?? '', homeDatabase(), name);
    // The person who just opened it is about to set it up.
    await rememberLedger(ledger.key);
    revalidatePath('/', 'layout');
    return { ok: true, name: ledger.name };
  } catch (error) {
    return failed(error);
  }
}

/** Rename a ledger, the home one included. Its database keeps its name. */
export async function renameLedgerAction(key: string, name: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    await renameLedger(homeDb(), homeDatabase(), key, name);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
