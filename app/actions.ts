'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../db/client.ts';
import { recategorize, saveReview, type ReviewDecision } from '../src/queue/queue.ts';
import { convertToTransfer, transactionDetail } from '../src/transactions/manage.ts';
import { createTransferRule } from '../src/rules/rules.ts';
import { requireUser } from './auth.ts';

// A server action is a POST endpoint, reachable without going through the page
// that renders the button, so each one checks the session itself (NF-3).

/**
 * Save a sitting's worth of decisions at once (RQ-2).
 *
 * The queue stages everything in the browser and posts it here in one go, so a
 * half-finished sitting leaves the ledger exactly as it was.
 */
export async function saveReviewAction(decisions: ReviewDecision[]) {
  await requireUser();
  const result = await saveReview(db(), decisions);
  revalidatePath('/review');
  revalidatePath('/transactions');
  revalidatePath('/');
  return result;
}

export async function recategorizeAction(
  transactionId: string,
  envelopeId: string,
  options: { createRule?: boolean } = {},
) {
  await requireUser();
  await recategorize(db(), {
    transactionId,
    envelopeId,
    confirm: true,
    createRule: options.createRule,
  });
  revalidatePath('/review');
  revalidatePath('/');
  return { ok: true };
}

/**
 * FR-5. A row the bank shows as money leaving one of your accounts and arriving
 * in another of them is not spending, and no envelope should move for it. This
 * turns the imported row into one half of a transfer and writes the other.
 */
export async function markAsTransferAction(
  transactionId: string,
  toAccountId: string,
  options: { createRule?: boolean } = {},
) {
  try {
    await requireUser();
    const connection = db();

    // Read the normalized payee before converting, since the rule matches on it.
    const detail = options.createRule ? await transactionDetail(connection, transactionId) : null;

    await convertToTransfer(connection, transactionId, { toAccountId });

    let ruleMade = false;
    if (detail) {
      const { normalizePayee } = await import('../src/categorize/normalize.ts');
      const contains = normalizePayee(detail.payeeRaw).key;
      // Scoped to the account it arrived in: "Tfr-to C C" on the chequing
      // statement means the card payment, and should not fire elsewhere.
      await createTransferRule(connection, {
        contains,
        transferAccountId: toAccountId,
        accountId: detail.accountId,
      });
      ruleMade = true;
    }

    revalidatePath('/review');
    revalidatePath('/accounts');
    revalidatePath('/settings');
    revalidatePath('/');
    return { ok: true as const, ruleMade };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
