'use server';

/**
 * Budget and allocation actions (FR-27 to FR-31).
 *
 * Amounts arrive as text, because that is what a form field holds, and are turned
 * into cents here rather than in the browser: the server is the only side whose
 * arithmetic the ledger trusts.
 */

import { revalidatePath } from 'next/cache';
import { db } from '../../db/client.ts';
import {
  fundEnvelopes,
  reverseAllocation,
  setExpectedIncome,
  setPlanned,
} from '../../src/budget/budget.ts';
import { assertMonth } from '../../src/budget/month.ts';
import { requireUser } from '../auth.ts';
import { centsFromInput } from '../amount.ts';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Plans and allocations are read on the envelopes screen, which is home. */
function refreshed(): void {
  revalidatePath('/');
}

export async function setPlannedAction(
  envelopeId: string,
  amount: string,
  month?: string,
): Promise<ActionResult> {
  try {
    await requireUser();
    const cents = centsFromInput(amount);
    await setPlanned(db(), envelopeId, cents, month ? { month: assertMonth(month) } : {});
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export async function setExpectedIncomeAction(amount: string): Promise<ActionResult> {
  try {
    await requireUser();
    const trimmed = amount.trim();
    await setExpectedIncome(db(), trimmed === '' ? null : centsFromInput(trimmed));
    refreshed();
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

/**
 * FR-29. The amounts are whatever the user left in the preview, not whatever the
 * plan says, which is what makes the preview editable rather than decorative.
 */
export async function fundEnvelopesAction(
  month: string,
  lines: { envelopeId: string; amount: string }[],
): Promise<ActionResult> {
  try {
    await requireUser();
    const amounts = lines
      .map((line) => ({ envelopeId: line.envelopeId, amountCents: centsFromInput(line.amount) }))
      .filter((line) => line.amountCents > 0);

    if (amounts.length === 0) {
      return { ok: false, error: 'Nothing to fund: every amount in the preview was zero.' };
    }

    const result = await fundEnvelopes(db(), assertMonth(month), amounts);
    refreshed();

    const total = (result.totalCents / 100).toFixed(2);
    return {
      ok: true,
      message:
        result.availableCents < 0
          ? `Moved $${total} into ${result.moves} envelopes. That is more than the pool held, so ` +
            `Available is now $${(result.availableCents / 100).toFixed(2)}.`
          : `Moved $${total} into ${result.moves} ${result.moves === 1 ? 'envelope' : 'envelopes'}.`,
    };
  } catch (error) {
    return failed(error);
  }
}

export async function reverseAllocationAction(moveId: string, month: string): Promise<ActionResult> {
  try {
    await requireUser();
    await reverseAllocation(db(), moveId);
    refreshed();
    return { ok: true, message: 'Sent back to Available.' };
  } catch (error) {
    return failed(error);
  }
}

