'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../db/client.ts';
import {
  confirmTransactions,
  highConfidenceIds,
  recategorize,
} from '../src/queue/queue.ts';
import { convertToTransfer } from '../src/transactions/manage.ts';
import { requireUser } from './auth.ts';

// A server action is a POST endpoint, reachable without going through the page
// that renders the button, so each one checks the session itself (NF-3).

export async function confirmAction(ids: string[]) {
  await requireUser();
  const count = await confirmTransactions(db(), ids);
  revalidatePath('/review');
  revalidatePath('/');
  return { confirmed: count };
}

export async function confirmHighConfidenceAction() {
  await requireUser();
  const ids = await highConfidenceIds(db());
  const count = await confirmTransactions(db(), ids);
  revalidatePath('/review');
  revalidatePath('/');
  return { confirmed: count };
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
export async function markAsTransferAction(transactionId: string, toAccountId: string) {
  try {
    await requireUser();
    await convertToTransfer(db(), transactionId, { toAccountId });
    revalidatePath('/review');
    revalidatePath('/accounts');
    revalidatePath('/');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
