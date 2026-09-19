'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../db/client.ts';
import {
  confirmTransactions,
  highConfidenceIds,
  recategorize,
} from '../src/queue/queue.ts';
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
