'use server';

/**
 * Bank feed actions (FR-15 to FR-20).
 *
 * Every one of these begins with `requireUser()`: a server action is a POST
 * endpoint reachable without the page that renders its button, and these ones
 * reach a bank.
 */

import { revalidatePath } from 'next/cache';
import { connectionFor, homeDb } from '../../db/client.ts';
import { allLedgers, currentLedger, ledgerDb } from '../ledger.ts';
import { requireUser } from '../auth.ts';
import type { Failure } from '../login/actions.ts';
import { createLinkToken, linkConnection, resolveHeld } from '../../src/sync/connections.ts';
import { plaidCall, plaidConfigFromEnv } from '../../src/sync/plaidClient.ts';
import {
  chooseFeedAccount,
  revokeEverywhere,
  syncEverywhere,
  type LedgerHandle,
} from '../../src/sync/shared.ts';
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

/**
 * Every ledger, and the open one. A connection can feed accounts in any of
 * them, so the actions that change one reach them all (src/sync/shared.ts).
 */
async function ledgers(): Promise<{ all: LedgerHandle[]; current: LedgerHandle }> {
  const [list, open] = await Promise.all([allLedgers(), currentLedger()]);
  const all = list.map((ledger) => ({ key: ledger.key, name: ledger.name, db: connectionFor(ledger.database) }));
  return { all, current: all.find((ledger) => ledger.key === open.key)! };
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

/**
 * Feed a bank account into an account, given as `ledger:account`, or into none
 * when `choice` is empty.
 */
export async function setFeedAccountAction(
  feedAccountId: string,
  choice: string,
): Promise<{ ok: true; startDate: string | null } | Failure> {
  try {
    await requireUser();
    const { all, current } = await ledgers();
    const split = choice.indexOf(':');
    const target = choice ? { ledgerKey: choice.slice(0, split), accountId: choice.slice(split + 1) } : null;
    const { startDate } = await chooseFeedAccount(all, current, feedAccountId, target);
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
    const { all, current } = await ledgers();
    // Every ledger this login feeds, so one press brings them all up to date.
    const reports = await syncEverywhere(all, current, connectionId, { call, key, account: homeDb() });
    const total = (field: 'added' | 'linked' | 'held' | 'earlier') =>
      reports.reduce((sum, { report }) => sum + report.accounts.reduce((inner, a) => inner + a[field], 0), 0);
    const error = reports.find(({ report }) => report.error)?.report.error;
    revalidatePath('/', 'layout');
    return {
      ok: true,
      added: total('added'),
      linked: total('linked'),
      held: total('held'),
      earlier: total('earlier'),
      ...(error ? { error } : {}),
    };
  } catch (error) {
    return failed(error);
  }
}

export async function revokeBankAction(connectionId: string): Promise<{ ok: true } | Failure> {
  try {
    await requireUser();
    const { call, decrypt } = plaid();
    const { all, current } = await ledgers();
    await revokeEverywhere(all, current, connectionId, call, decrypt);
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
