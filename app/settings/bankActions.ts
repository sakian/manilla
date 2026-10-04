'use server';

/**
 * Bank feed actions (FR-15 to FR-20).
 *
 * Every one of these begins with `requireUser()`: a server action is a POST
 * endpoint reachable without the page that renders its button, and these ones
 * reach a bank.
 */

import { revalidatePath } from 'next/cache';
import { homeDb } from '../../db/client.ts';
import { ledgerDb } from '../ledger.ts';
import { requireUser } from '../auth.ts';
import type { Failure } from '../login/actions.ts';
import {
  createLinkToken,
  linkConnection,
  resolveHeld,
  revokeConnection,
  setFeedAccount,
} from '../../src/sync/connections.ts';
import { plaidCall, plaidConfigFromEnv } from '../../src/sync/plaidClient.ts';
import { syncConnection } from '../../src/sync/run.ts';
import { decryptSecret, secretKeyFromEnv } from '../../src/sync/secret.ts';

function failed(error: unknown): Failure {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Plaid and the key, or the reason they are not set up. */
function plaid() {
  const call = plaidCall(plaidConfigFromEnv());
  const key = secretKeyFromEnv();
  return { call, key, decrypt: (stored: string) => decryptSecret(stored, key) };
}

/** A token to open Plaid's window with: a new bank, or the same login again. */
export async function createLinkTokenAction(
  connectionId?: string,
): Promise<{ ok: true; linkToken: string } | Failure> {
  try {
    const session = await requireUser();
    const { call, decrypt } = plaid();
    const linkToken = await createLinkToken(await ledgerDb(), call, {
      userId: session.userId,
      ...(connectionId ? { connectionId, decrypt } : {}),
    });
    return { ok: true, linkToken };
  } catch (error) {
    return failed(error);
  }
}

/** What Plaid's window handed back after a new login. */
export async function linkBankAction(publicToken: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const { call, key } = plaid();
    await linkConnection(await ledgerDb(), call, publicToken, key);
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setFeedAccountAction(
  feedAccountId: string,
  accountId: string | null,
): Promise<{ ok: true; startDate: string | null } | Failure> {
  try {
    await requireUser();
    const { startDate } = await setFeedAccount(await ledgerDb(), feedAccountId, accountId);
    revalidatePath('/settings');
    return { ok: true, startDate };
  } catch (error) {
    return failed(error);
  }
}

export type SyncNowResult =
  | {
      ok: true;
      added: number;
      linked: number;
      held: number;
      earlier: number;
      /** Why it stopped: Plaid's code, and its words for developers. */
      error?: { code: string; message: string };
    }
  | Failure;

export async function syncNowAction(connectionId: string): Promise<SyncNowResult> {
  try {
    await requireUser();
    const { call, key } = plaid();
    const report = await syncConnection(await ledgerDb(), connectionId, { call, key, account: homeDb() });
    const total = (field: 'added' | 'linked' | 'held' | 'earlier') =>
      report.accounts.reduce((sum, account) => sum + account[field], 0);
    revalidatePath('/', 'layout');
    return {
      ok: true,
      added: total('added'),
      linked: total('linked'),
      held: total('held'),
      earlier: total('earlier'),
      ...(report.error ? { error: report.error } : {}),
    };
  } catch (error) {
    return failed(error);
  }
}

export async function revokeBankAction(connectionId: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const { call, decrypt } = plaid();
    await revokeConnection(await ledgerDb(), call, connectionId, decrypt);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function resolveHeldAction(
  heldId: string,
  action: 'add' | 'link' | 'dismiss',
): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    await resolveHeld(await ledgerDb(), heldId, action);
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
