'use server';

import { revalidatePath } from 'next/cache';
import { db } from '../db/client.ts';
import {
  confirmTransactions,
  highConfidenceIds,
  recategorize,
} from '../src/queue/queue.ts';

export async function confirmAction(ids: string[]) {
  const count = await confirmTransactions(db(), ids);
  revalidatePath('/review');
  revalidatePath('/');
  return { confirmed: count };
}

export async function confirmHighConfidenceAction() {
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
