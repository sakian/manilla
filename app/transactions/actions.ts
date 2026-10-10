'use server';

/**
 * Entering, correcting and removing transactions (FR-2, FR-4, FR-5).
 *
 * The browser sends amounts as positive numbers plus a direction, because "money
 * out, $45.20" is how people think and "-4520" is how the ledger stores it. The
 * sign is applied here, once, on the server: a form that can put the wrong sign
 * on a number is a form that can quietly invert a month.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { allLedgers, currentLedger, ledgerDb, rememberLedger } from '../ledger.ts';
import { draftQuery, otherSideOf } from '../../src/ledgers/otherSide.ts';
import {
  createManualTransaction,
  createTransfer,
  deleteTransaction,
  deleteTransfer,
  sendBackToReview,
  transactionDetail,
  updateTransaction,
  updateTransfer,
} from '../../src/transactions/manage.ts';
import { requireUser } from '../auth.ts';
import { actAs } from '../../src/audit/actor.ts';
import { transactionHistory } from '../../src/audit/history.ts';
import { listMembers } from '../../src/auth/invites.ts';
import { reviewStates } from '../../src/push/edits.ts';
import { tellOthers } from '../editNotices.ts';
import { homeDb } from '../../db/client.ts';
import { displayInstant } from '../../src/budget/month.ts';
import type { Message } from '../../src/transactions/thread.ts';
import type { ThreadPeople } from '../Thread.tsx';
import { centsFromInput } from '../../src/amount.ts';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** What a new transaction was saved as, signed as stored: the start of its other side (LG-6). */
export type SavedEntry = { amountCents: number; date: string; payee: string };

function failed(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function refreshed(): void {
  revalidatePath('/accounts');
  revalidatePath('/envelopes');
  revalidatePath('/review');
  revalidatePath('/');
}

/**
 * Everything one transaction needs to be edited, fetched when a row is opened
 * rather than for every row in the list.
 */
export async function transactionDetailAction(transactionId: string): Promise<
  | {
      ok: true;
      transaction: {
        id: string;
        accountId: string;
        date: string;
        amountCents: number;
        payeeRaw: string;
        /** The bank's, shown and never edited. */
        memo: string | null;
        kind: 'spending' | 'account_transfer';
        status: 'pending_review' | 'confirmed';
        transferPairId: string | null;
        source: string;
        lines: { envelopeId: string; amountCents: number }[];
        thread: { messages: Message[]; people: ThreadPeople };
      };
    }
  | { ok: false; error: string }
> {
  try {
    const session = actAs(await requireUser());
    const [detail, members] = await Promise.all([
      transactionDetail(await ledgerDb(), transactionId),
      listMembers(homeDb()),
    ]);
    if (!detail) return { ok: false, error: 'That transaction is no longer there.' };

    return {
      ok: true,
      transaction: {
        id: detail.id,
        accountId: detail.accountId,
        date: detail.date,
        amountCents: detail.amountCents,
        payeeRaw: detail.payeeRaw,
        memo: detail.memo,
        kind: detail.kind,
        status: detail.status,
        transferPairId: detail.transferPairId,
        source: detail.source,
        lines: detail.lines.map((line) => ({
          envelopeId: line.envelopeId,
          amountCents: line.amountCents,
        })),
        thread: {
          messages: detail.messages,
          people: {
            me: session.userId,
            handedToId: detail.handedToId,
            handedById: detail.handedById,
            names: Object.fromEntries(members.map((member) => [member.id, member.name])),
          },
        },
      },
    };
  } catch (error) {
    return failed(error);
  }
}

export type Direction = 'out' | 'in';

/** Positive cents from the form, signed by the direction the user chose. */
function signed(amount: string, direction: Direction): number {
  const cents = centsFromInput(amount);
  if (cents < 0) {
    throw new Error('Enter the amount as a positive number and choose in or out');
  }
  return direction === 'out' ? -cents : cents;
}

export type TransactionFields = {
  accountId: string;
  date: string;
  direction: Direction;
  amount: string;
  payeeRaw: string;
  note?: string;
  /** Empty for "leave it to the review queue"; several rows for a split (FR-4). */
  lines: { envelopeId: string; amount: string }[];
};

function linesFrom(fields: TransactionFields): { envelopeId: string; amountCents: number }[] {
  return fields.lines
    .filter((line) => line.envelopeId && line.amount.trim() !== '')
    .map((line) => ({
      envelopeId: line.envelopeId,
      amountCents: signed(line.amount, fields.direction),
    }))
    .filter((line) => line.amountCents !== 0);
}

export async function createTransactionAction(
  fields: TransactionFields,
): Promise<{ ok: true; message: string; saved: SavedEntry } | { ok: false; error: string }> {
  try {
    actAs(await requireUser());
    const lines = linesFrom(fields);
    const amountCents = signed(fields.amount, fields.direction);

    await createManualTransaction(await ledgerDb(), {
      accountId: fields.accountId,
      date: fields.date,
      amountCents,
      payeeRaw: fields.payeeRaw,
      ...(fields.note ? { note: fields.note } : {}),
      ...(lines.length > 0 ? { lines } : {}),
    });

    refreshed();
    return {
      ok: true,
      saved: { amountCents, date: fields.date, payee: fields.payeeRaw.trim() },
      message:
        lines.length > 0
          ? 'Recorded.'
          : 'Recorded, and waiting in the review queue for an envelope.',
    };
  } catch (error) {
    return failed(error);
  }
}

export async function updateTransactionAction(
  transactionId: string,
  fields: TransactionFields,
): Promise<ActionResult> {
  try {
    const session = actAs(await requireUser());
    const lines = linesFrom(fields);
    const connection = await ledgerDb();
    const before = await reviewStates(connection, [transactionId]);

    await updateTransaction(connection, transactionId, {
      accountId: fields.accountId,
      date: fields.date,
      amountCents: signed(fields.amount, fields.direction),
      payeeRaw: fields.payeeRaw,
      lines,
      // Giving it an envelope by hand is the same statement confirming makes.
      ...(lines.length > 0 ? { status: 'confirmed' as const } : {}),
    });
    // An envelope given to one still waiting reviews it; anything else changes it.
    await tellOthers(
      session,
      { kind: 'review', action: lines.length > 0 ? 'reviewed' : 'changed', count: before.waiting },
      { kind: 'changes', action: 'changed', count: before.reviewed },
    );

    refreshed();
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteTransactionAction(transactionId: string): Promise<ActionResult> {
  try {
    const session = actAs(await requireUser());
    const connection = await ledgerDb();
    // The one asked about: a transfer's other half goes with it, but it is one deletion.
    const before = await reviewStates(connection, [transactionId]);
    const result = await deleteTransaction(connection, transactionId);
    await tellOthers(
      session,
      { kind: 'review', action: 'deleted', count: before.waiting },
      { kind: 'changes', action: 'deleted', count: before.reviewed },
    );
    refreshed();

    return {
      ok: true,
      message:
        result.removed > 1
          ? 'Both halves of the transfer are gone.'
          : result.externalIds > 0
            ? 'Deleted. The bank id went with it, so importing that statement again will offer it ' +
              'as a new row.'
            : 'Deleted.',
    };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Put a transaction back in the review queue (#9).
 *
 * The opposite of confirming, not a delete: the row and the bank's id stay, and
 * only the categorizing is undone. For a transfer this unwinds the pairing, which
 * is why the message has to say what happened to the other half - a fabricated
 * half disappears, and a half that came from its own statement goes back in the
 * queue with the first.
 */
export async function sendBackToReviewAction(transactionId: string): Promise<ActionResult> {
  try {
    const session = actAs(await requireUser());
    const result = await sendBackToReview(await ledgerDb(), transactionId);
    refreshed();
    await tellOthers(session, { kind: 'changes', action: 'sent back', count: result.queued > 0 ? 1 : 0 });

    if (result.queued === 0) {
      return { ok: true, message: 'That was already waiting in the review queue.' };
    }

    const queued =
      result.queued === 1
        ? 'Back in the review queue.'
        : `Both halves are back in the review queue, as ${result.queued} separate transactions.`;

    return {
      ok: true,
      message:
        result.removed > 0
          ? `${queued} The other side of the transfer was never on a statement, so it is gone.`
          : queued,
    };
  } catch (error) {
    return failed(error);
  }
}

export type TransferFields = {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  date: string;
  payeeRaw?: string;
};

export async function createTransferAction(fields: TransferFields): Promise<ActionResult> {
  try {
    actAs(await requireUser());
    await createTransfer(await ledgerDb(), {
      fromAccountId: fields.fromAccountId,
      toAccountId: fields.toAccountId,
      amountCents: centsFromInput(fields.amount),
      date: fields.date,
      ...(fields.payeeRaw ? { payeeRaw: fields.payeeRaw } : {}),
    });

    refreshed();
    return { ok: true, message: 'Transfer recorded. It counts as neither spending nor income.' };
  } catch (error) {
    return failed(error);
  }
}

export async function updateTransferAction(
  pairId: string,
  fields: TransferFields,
): Promise<ActionResult> {
  try {
    const session = actAs(await requireUser());
    await updateTransfer(await ledgerDb(), pairId, {
      fromAccountId: fields.fromAccountId,
      toAccountId: fields.toAccountId,
      amountCents: centsFromInput(fields.amount),
      date: fields.date,
      ...(fields.payeeRaw ? { payeeRaw: fields.payeeRaw } : {}),
    });

    refreshed();
    // A transfer is settled when it is made, so changing it is changing something reviewed.
    await tellOthers(session, { kind: 'changes', action: 'changed', count: 1 });
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteTransferAction(pairId: string): Promise<ActionResult> {
  try {
    const session = actAs(await requireUser());
    await deleteTransfer(await ledgerDb(), pairId);
    refreshed();
    await tellOthers(session, { kind: 'changes', action: 'deleted', count: 1 });
    return { ok: true, message: 'Both halves of the transfer are gone.' };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Switch to another ledger with the other side of `saved` ready to enter (LG-6).
 *
 * A POST rather than a link: opening a ledger changes which books every later
 * screen writes to, and a link could be followed from anywhere. Only a ledger
 * that exists, and not the one already open; the draft is rebuilt here from
 * what was saved, and checked again when the form reads it.
 */
export async function recordOtherSideAction(ledgerKey: string, saved: SavedEntry): Promise<void> {
  actAs(await requireUser());
  const from = await currentLedger();
  const to = (await allLedgers()).find((ledger) => ledger.key === ledgerKey);
  if (!to || to.key === from.key) throw new Error('No such ledger to record it in');

  const draft = otherSideOf(saved, from.name);
  await rememberLedger(to.key);
  revalidatePath('/', 'layout');
  redirect(`/transactions?${new URLSearchParams({ new: 'transaction', ...draftQuery(draft) })}`);
}

/** One entry in a transaction's history, ready to show. */
export type HistoryView = { key: string; when: string; who: string | null; changes: string[] };

/** The server's own clock and zone, like every other date on screen. */
const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * What has been changed on a transaction, and by whom (NF-2). Asked for when
 * the history is opened rather than with every row in a list.
 */
export async function transactionHistoryAction(
  transactionId: string,
): Promise<{ ok: true; history: HistoryView[] } | { ok: false; error: string }> {
  try {
    actAs(await requireUser());
    const members = new Map((await listMembers(homeDb())).map((member) => [member.id, member.name]));
    const history = await transactionHistory(await ledgerDb(), transactionId, members);
    return {
      ok: true,
      history: history.map((entry, index) => ({
        key: `${entry.at.toISOString()}-${index}`,
        when: `${displayInstant(entry.at)}, ${timeOfDay.format(entry.at)}`,
        who: entry.who,
        changes: entry.changes,
      })),
    };
  } catch (error) {
    return failed(error);
  }
}
