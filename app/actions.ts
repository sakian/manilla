'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { homeDb } from '../db/client.ts';
import { allLedgers, currentLedger, ledgerDb, rememberLedger } from './ledger.ts';
import { handOverTo, writeAbout } from '../src/queue/handover.ts';
import { editMessage, removeMessage } from '../src/transactions/thread.ts';
import { reviewStates } from '../src/push/edits.ts';
import { tellOthers } from './editNotices.ts';
import { refreshRuleSuggestionCount } from '../src/rules/rules.ts';
import { pairTransferHalves, saveReview, type ReviewDecision } from '../src/queue/queue.ts';
import { convertToTransfer, transactionDetail } from '../src/transactions/manage.ts';
import { createTransferRule } from '../src/rules/rules.ts';
import { dismissInsight } from '../src/insights/insights.ts';
import { requireUser } from './auth.ts';
import { actAs } from '../src/audit/actor.ts';

// A server action is a POST endpoint, reachable without going through the page
// that renders the button, so each one checks the session itself (NF-3).

/**
 * Save a sitting's worth of decisions at once (RQ-2).
 *
 * The queue stages everything in the browser and posts it here in one go, so a
 * half-finished sitting leaves the ledger exactly as it was.
 */
export async function saveReviewAction(decisions: ReviewDecision[]) {
  const session = actAs(await requireUser());
  const connection = await ledgerDb();
  const result = await saveReview(connection, decisions);
  await tellOthers(session, { kind: 'review', action: 'reviewed', count: result.confirmed });
  // Confirming rows is how a payee becomes worth a rule, so the count is stale
  // the moment this returns.
  await refreshRuleSuggestionCount(connection);
  revalidatePath('/review');
  revalidatePath('/transactions');
  revalidatePath('/');
  return result;
}

/**
 * Hand rows to another member for a second look, and tell them (RQ-7).
 *
 * Written straight away rather than staged with the envelope decisions: it is
 * a different question - who should decide - and the person handed to is told
 * as soon as it is done. The notification goes after the answer, so a slow
 * push service does not hold the screen up.
 */
export async function handOverAction(transactionIds: string[], toUserId: string, note = '') {
  try {
    const session = actAs(await requireUser());
    const [ledgers, open] = await Promise.all([allLedgers(), currentLedger()]);
    const result = await handOverTo(await ledgerDb(), homeDb(), {
      ids: transactionIds,
      to: toUserId,
      from: { id: session.userId, name: session.userName },
      note,
      ...(ledgers.length > 1 ? { ledger: { key: open.key, name: open.name } } : {}),
    });
    after(() => result.sent);
    revalidatePath('/review');
    revalidatePath('/');
    return { ok: true as const, handed: result.handed, to: result.to };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Write in a transaction's thread (RQ-7). On a handed-over row the person at
 * the other end of the handover is told; on any other row it is a change like
 * a note always was, and the household hears as they chose to.
 */
export async function writeAboutAction(transactionId: string, body: string) {
  try {
    const session = actAs(await requireUser());
    const [ledgers, open] = await Promise.all([allLedgers(), currentLedger()]);
    const result = await writeAbout(await ledgerDb(), homeDb(), {
      transactionId,
      body,
      from: { id: session.userId, name: session.userName },
      ...(ledgers.length > 1 ? { ledger: { key: open.key, name: open.name } } : {}),
    });
    after(() => result.sent);
    if (!result.handed) {
      await tellOthers(
        session,
        result.status === 'pending_review'
          ? { kind: 'review', action: 'changed', count: 1 }
          : { kind: 'changes', action: 'changed', count: 1 },
      );
    }
    revalidateThreads();
    return { ok: true as const, message: result.message };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Change your own message; anyone else's is refused (src/transactions/thread.ts). */
export async function editMessageAction(messageId: string, body: string) {
  try {
    const session = actAs(await requireUser());
    const connection = await ledgerDb();
    const message = await editMessage(connection, messageId, session.userId, body);
    revalidateThreads();
    return { ok: true as const, message };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeMessageAction(messageId: string) {
  try {
    const session = actAs(await requireUser());
    await removeMessage(await ledgerDb(), messageId, session.userId);
    revalidateThreads();
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Everywhere a thread, or the latest of one, is shown. */
function revalidateThreads() {
  revalidatePath('/review');
  revalidatePath('/review/notes');
  revalidatePath('/transactions');
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
    const session = actAs(await requireUser());
    const connection = await ledgerDb();

    // Read the normalized payee before converting, since the rule matches on it.
    const detail = options.createRule ? await transactionDetail(connection, transactionId) : null;

    const before = await reviewStates(connection, [transactionId]);
    await convertToTransfer(connection, transactionId, { toAccountId });
    await tellOthers(
      session,
      { kind: 'review', action: 'reviewed', count: before.waiting },
      { kind: 'changes', action: 'changed', count: before.reviewed },
    );

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
    revalidatePath('/settings', 'layout');
    revalidatePath('/');
    return { ok: true as const, ruleMade };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * FR-5. Two rows that are the two halves of one transfer, joined.
 *
 * Different from marking a single row as a transfer: there both sides do not
 * exist yet and the other is written, whereas here the bank sent two statements
 * and writing a third would move the money twice.
 */
export async function pairTransferAction(firstId: string, secondId: string) {
  try {
    const session = actAs(await requireUser());
    const connection = await ledgerDb();
    const before = await reviewStates(connection, [firstId, secondId]);
    await pairTransferHalves(connection, firstId, secondId);
    await tellOthers(
      session,
      { kind: 'review', action: 'reviewed', count: before.waiting },
      { kind: 'changes', action: 'changed', count: before.reviewed },
    );
    revalidatePath('/review');
    revalidatePath('/transactions');
    revalidatePath('/');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Open another ledger (LG-3).
 *
 * Only an existing ledger can be chosen: the value is looked up in the list,
 * never used as a database name, so this cannot point the app anywhere new.
 * Lands on the home screen rather than staying put, because the page being
 * looked at - one envelope, one transaction - is an id in the other ledger's
 * books and means nothing in this one.
 */
export async function switchLedgerAction(form: FormData) {
  actAs(await requireUser());
  const wanted = String(form.get('ledger') ?? '');
  const ledger = (await allLedgers()).find((candidate) => candidate.key === wanted);
  if (!ledger) throw new Error('No such ledger');

  await rememberLedger(ledger.key);
  revalidatePath('/', 'layout');
  redirect('/');
}

/** AI-6, in part: "that charge was expected", so it is not mentioned again. */
export async function dismissInsightAction(transactionId: string) {
  actAs(await requireUser());
  await dismissInsight(await ledgerDb(), transactionId);
  revalidatePath('/', 'layout');
  return { ok: true as const };
}
