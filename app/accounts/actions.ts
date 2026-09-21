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
import {
  archiveAccountGroup,
  createAccountGroup,
  moveAccountToGroup,
  nudgeAccountGroup,
  renameAccountGroup,
  unarchiveAccountGroup,
} from '../../src/accounts/groups.ts';
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

// ---------------------------------------------------------------------------
// Categories (FR-1, FR-3)
// ---------------------------------------------------------------------------

export async function createAccountGroupAction(name: string): Promise<ActionResult> {
  try {
    await requireUser();
    await createAccountGroup(db(), name);
    refreshed();
    return { ok: true, message: 'Category added.' };
  } catch (error) {
    return failed(error);
  }
}

export async function renameAccountGroupAction(
  groupId: string,
  name: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    await renameAccountGroup(db(), groupId, name);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveAccountGroupAction(groupId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await archiveAccountGroup(db(), groupId);
    refreshed();
    return {
      ok: true,
      message: 'Category archived. Its accounts are still here, without a category.',
    };
  } catch (error) {
    return failed(error);
  }
}

export async function unarchiveAccountGroupAction(groupId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await unarchiveAccountGroup(db(), groupId);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function nudgeAccountGroupAction(
  groupId: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  try {
    await requireUser();
    await nudgeAccountGroup(db(), groupId, direction);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** An empty string means "no category", which is a real choice here. */
export async function moveAccountToGroupAction(
  accountId: string,
  groupId: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    await moveAccountToGroup(db(), accountId, groupId === '' ? null : groupId);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
