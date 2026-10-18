/**
 * Credit card payments coming due (FR-38).
 *
 * The minimum comes off by itself, so a card is never missed outright - what
 * gets forgotten is paying the rest before interest starts. A reminder only
 * helps if it goes away by itself once the money has gone, or it becomes
 * something to dismiss every month, so "paid" is worked out from the ledger:
 * what the card owed at the close of its last statement, against what has been
 * paid or credited to it since. An automatic minimum counts towards that, and
 * on its own never covers it.
 *
 * A payment made at the bank can take a day or two to show up here, which is
 * what marking a statement paid is for. It covers that one statement only, so
 * a mark cannot quietly turn the reminders off for good.
 *
 * Everything is calendar dates as strings, like the rest of the ledger: a due
 * date is a day on a statement, not an instant.
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, transactions } from '../../db/schema.ts';
import { addMonths, localToday, monthEnd, monthOf, type MonthKey } from '../budget/month.ts';
import { AccountError } from './manage.ts';

/** How many days before the due date the reminder starts. */
export const REMIND_DAYS = 5;

export type PaymentDays = { statementDay: number; paymentDueDay: number };

/** Day `day` of `month`, or the month's last day when it is shorter: the 31st in February is the 28th or 29th. */
export function dayOfMonth(month: MonthKey, day: number): string {
  const last = monthEnd(month);
  const clamped = Math.min(day, Number(last.slice(8)));
  return `${month}-${String(clamped).padStart(2, '0')}`;
}

/** Whole days from `from` to `to`, negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * The latest statement to have closed by `today`, and the due date that
 * follows it: the first due day after the statement, which is next month
 * when the due day comes earlier in the month than the statement day.
 */
export function statementCycle(days: PaymentDays, today: string): { statementDate: string; dueDate: string } {
  const thisMonth = monthOf(today);
  let statementDate = dayOfMonth(thisMonth, days.statementDay);
  if (statementDate > today) statementDate = dayOfMonth(addMonths(thisMonth, -1), days.statementDay);
  const statementMonth = monthOf(statementDate);
  let dueDate = dayOfMonth(statementMonth, days.paymentDueDay);
  if (dueDate <= statementDate) dueDate = dayOfMonth(addMonths(statementMonth, 1), days.paymentDueDay);
  return { statementDate, dueDate };
}

export type CardPayment = {
  accountId: string;
  name: string;
  statementDate: string;
  dueDate: string;
  /** What the card owed when the statement closed, as a positive figure; zero when it owed nothing. */
  statementCents: number;
  /** Payments and credits to the card since the statement closed. */
  paidCents: number;
  /** What is left of the statement, never below zero. */
  remainingCents: number;
  /** Days until it is due: 0 on the day, negative once it has passed. */
  daysLeft: number;
  /** Someone said it was paid before the payment reached the ledger. */
  markedPaid: boolean;
};

/** Covered by payments, or said to be. */
export function isSettled(payment: CardPayment): boolean {
  return payment.remainingCents === 0 || payment.markedPaid;
}

/** Whether to remind about it today: not settled, and due within {@link REMIND_DAYS} or already past. */
export function needsReminder(payment: CardPayment): boolean {
  return !isSettled(payment) && payment.daysLeft <= REMIND_DAYS;
}

/**
 * Every live credit card with its days set, and where its latest statement
 * stands. One query per card: a household has one or two, and each needs
 * sums cut at its own statement date.
 */
export async function cardPayments(db: Database, today: string = localToday()): Promise<CardPayment[]> {
  const cards = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      statementDay: accounts.statementDay,
      paymentDueDay: accounts.paymentDueDay,
      markedFor: accounts.paymentMarkedFor,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.kind, 'credit_card'),
        isNull(accounts.archivedAt),
        isNotNull(accounts.statementDay),
        isNotNull(accounts.paymentDueDay),
      ),
    );

  return Promise.all(
    cards.map(async (card) => {
      const { statementDate, dueDate } = statementCycle(
        { statementDay: card.statementDay!, paymentDueDay: card.paymentDueDay! },
        today,
      );
      // A card's balance is negative while it is owed. Everything dated on or
      // before the closing day was on the statement; anything into the card
      // after it - the payment, the automatic minimum, a refund - counts
      // against it.
      const [row] = await db
        .select({
          balance: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.date} <= ${statementDate}), 0)::bigint`,
          credits: sql<string>`coalesce(sum(${transactions.amountCents}) filter (where ${transactions.date} > ${statementDate} and ${transactions.amountCents} > 0), 0)::bigint`,
        })
        .from(transactions)
        .where(eq(transactions.accountId, card.id));
      const statementCents = Math.max(0, -Number(row?.balance ?? 0));
      const paidCents = Number(row?.credits ?? 0);
      return {
        accountId: card.id,
        name: card.name,
        statementDate,
        dueDate,
        statementCents,
        paidCents,
        remainingCents: Math.max(0, statementCents - paidCents),
        daysLeft: daysBetween(today, dueDate),
        markedPaid: card.markedFor === dueDate,
      };
    }),
  );
}

function cleanDay(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new AccountError(`The ${what} has to be a day of the month, 1 to 31`);
  }
  return value;
}

/** Set a credit card's statement and due days, or pass null to stop reminding about it. */
export async function setPaymentDays(db: Database, accountId: string, days: PaymentDays | null): Promise<void> {
  const [account] = await db
    .select({ kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new AccountError(`No such account: ${accountId}`);
  if (days !== null && account.kind !== 'credit_card') {
    throw new AccountError('Payment reminders are for credit cards');
  }
  const statementDay = days === null ? null : cleanDay(days.statementDay, 'statement day');
  const paymentDueDay = days === null ? null : cleanDay(days.paymentDueDay, 'due day');
  if (statementDay !== null && statementDay === paymentDueDay) {
    throw new AccountError('The statement day and the due day cannot be the same day');
  }
  await db.update(accounts).set({ statementDay, paymentDueDay }).where(eq(accounts.id, accountId));
}

/**
 * Say the current statement is paid, or take that back. Recorded against its
 * due date, so the next statement is reminded about as usual.
 */
export async function markPaymentMade(
  db: Database,
  accountId: string,
  paid: boolean,
  today: string = localToday(),
): Promise<void> {
  const [payment] = (await cardPayments(db, today)).filter((card) => card.accountId === accountId);
  if (!payment) throw new AccountError('That account has no payment reminder set up');
  await db
    .update(accounts)
    .set({ paymentMarkedFor: paid ? payment.dueDate : null })
    .where(eq(accounts.id, accountId));
}
