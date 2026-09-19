'use server';

/** Account management actions (FR-1). */

import { revalidatePath } from 'next/cache';
import { db } from '../../db/client.ts';
import {
  archiveAccount,
  createAccount,
  editAccount,
  isAccountKind,
  unarchiveAccount,
  type AccountKind,
} from '../../src/accounts/manage.ts';
import { requireUser } from '../auth.ts';
import { centsFromInput } from '../amount.ts';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(): void {
  revalidatePath('/accounts');
  revalidatePath('/');
}

export async function createAccountAction(input: {
  name: string;
  kind: string;
  openingBalance: string;
  openingDate?: string;
  externalAccountId?: string;
}): Promise<ActionResult> {
  try {
    await requireUser();
    if (!isAccountKind(input.kind)) return { ok: false, error: `Not an account kind: ${input.kind}` };

    await createAccount(db(), {
      name: input.name,
      kind: input.kind as AccountKind,
      openingBalanceCents: centsFromInput(input.openingBalance),
      ...(input.openingDate ? { openingDate: input.openingDate } : {}),
      ...(input.externalAccountId ? { externalAccountId: input.externalAccountId } : {}),
    });

    refreshed();
    return { ok: true, message: 'Account added.' };
  } catch (error) {
    return failed(error);
  }
}

export async function editAccountAction(
  accountId: string,
  edit: { name?: string; kind?: string; externalAccountId?: string | null },
): Promise<ActionResult> {
  try {
    await requireUser();
    if (edit.kind !== undefined && !isAccountKind(edit.kind)) {
      return { ok: false, error: `Not an account kind: ${edit.kind}` };
    }

    await editAccount(db(), accountId, {
      ...(edit.name !== undefined ? { name: edit.name } : {}),
      ...(edit.kind !== undefined ? { kind: edit.kind as AccountKind } : {}),
      ...(edit.externalAccountId !== undefined
        ? { externalAccountId: edit.externalAccountId }
        : {}),
    });

    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveAccountAction(accountId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await archiveAccount(db(), accountId);
    refreshed();
    return { ok: true, message: 'Account archived.' };
  } catch (error) {
    return failed(error);
  }
}

export async function unarchiveAccountAction(accountId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await unarchiveAccount(db(), accountId);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
