'use server';

/**
 * Envelope management, transfers and covering an overspend
 * (FR-21 to FR-25, FR-34, FR-35).
 */

import { revalidatePath } from 'next/cache';
import { db } from '../../db/client.ts';
import {
  archiveEnvelope,
  archiveGroup,
  createEnvelope,
  createGroup,
  editEnvelope,
  nudgeGroup,
  renameGroup,
  unarchiveEnvelope,
  unarchiveGroup,
} from '../../src/envelopes/manage.ts';
import {
  coverFrom,
  coverPlan,
  transferBetweenEnvelopes,
  type CoverPlan,
} from '../../src/envelopes/transfer.ts';
import { requireUser } from '../auth.ts';
import { centsFromInput } from '../amount.ts';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(envelopeId?: string): void {
  revalidatePath('/envelopes');
  revalidatePath('/');
  if (envelopeId) revalidatePath(`/envelopes/${envelopeId}`);
}

// -- groups -----------------------------------------------------------------

export async function createGroupAction(name: string): Promise<ActionResult> {
  try {
    await requireUser();
    await createGroup(db(), name);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function renameGroupAction(groupId: string, name: string): Promise<ActionResult> {
  try {
    await requireUser();
    await renameGroup(db(), groupId, name);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function archiveGroupAction(groupId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await archiveGroup(db(), groupId);
    refreshed();
    return { ok: true, message: 'Group archived.' };
  } catch (error) {
    return failed(error);
  }
}

export async function unarchiveGroupAction(groupId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await unarchiveGroup(db(), groupId);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

// -- envelopes ---------------------------------------------------------------

export async function createEnvelopeAction(
  groupId: string,
  name: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    await createEnvelope(db(), { groupId, name });
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function editEnvelopeAction(
  envelopeId: string,
  edit: { name?: string; groupId?: string; carryOver?: boolean },
): Promise<ActionResult> {
  try {
    await requireUser();
    await editEnvelope(db(), envelopeId, edit);
    refreshed(envelopeId);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Groups are ordered by hand; envelopes are alphabetical inside them, so only
 * this one exists.
 */
export async function nudgeGroupAction(
  groupId: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  try {
    await requireUser();
    await nudgeGroup(db(), groupId, direction);
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/** Move an envelope into another group (FR-21). */
export async function moveEnvelopeToGroupAction(
  envelopeId: string,
  groupId: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    await editEnvelope(db(), envelopeId, { groupId });
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * FR-25. `moveBalanceTo` is what turns "you must move the balance first" into one
 * step rather than two, and the refusal when it is missing is deliberate.
 */
export async function archiveEnvelopeAction(
  envelopeId: string,
  moveBalanceTo?: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    await archiveEnvelope(db(), envelopeId, moveBalanceTo ? { moveBalanceTo } : {});
    refreshed(envelopeId);
    return { ok: true, message: 'Envelope archived.' };
  } catch (error) {
    return failed(error);
  }
}

export async function unarchiveEnvelopeAction(envelopeId: string): Promise<ActionResult> {
  try {
    await requireUser();
    await unarchiveEnvelope(db(), envelopeId);
    refreshed(envelopeId);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

// -- moving money ------------------------------------------------------------

/** FR-34. */
export async function transferAction(input: {
  fromEnvelopeId: string;
  toEnvelopeId: string;
  amount: string;
  date?: string;
  note?: string;
}): Promise<ActionResult> {
  try {
    await requireUser();
    const amountCents = centsFromInput(input.amount);
    await transferBetweenEnvelopes(db(), {
      fromEnvelopeId: input.fromEnvelopeId,
      toEnvelopeId: input.toEnvelopeId,
      amountCents,
      ...(input.date ? { date: input.date } : {}),
      ...(input.note ? { note: input.note } : {}),
    });
    refreshed(input.toEnvelopeId);
    refreshed(input.fromEnvelopeId);
    return { ok: true, message: 'Moved.' };
  } catch (error) {
    return failed(error);
  }
}

/** FR-35's suggestion, fetched when the dialog opens rather than on every page. */
export async function coverPlanAction(
  envelopeId: string,
): Promise<{ ok: true; plan: CoverPlan } | { ok: false; error: string }> {
  try {
    await requireUser();
    return { ok: true, plan: await coverPlan(db(), envelopeId) };
  } catch (error) {
    return failed(error);
  }
}

/** FR-35. */
export async function coverAction(
  envelopeId: string,
  sources: { envelopeId: string; amount: string }[],
): Promise<ActionResult> {
  try {
    await requireUser();
    const lines = sources
      .map((source) => ({
        envelopeId: source.envelopeId,
        amountCents: centsFromInput(source.amount),
      }))
      .filter((source) => source.amountCents > 0);

    if (lines.length === 0) {
      return { ok: false, error: 'Nothing to move: every amount was zero.' };
    }

    const moved = await coverFrom(db(), envelopeId, lines);
    refreshed(envelopeId);
    return {
      ok: true,
      message: `Covered from ${moved} ${moved === 1 ? 'envelope' : 'envelopes'}.`,
    };
  } catch (error) {
    return failed(error);
  }
}
