/**
 * The other side of money that crossed between ledgers (LG-6).
 *
 * Ledgers share nothing, so an owner's draw is two transactions: out of the
 * business ledger and into the household one, each entered where it belongs.
 * Two databases cannot be written in one transaction, so this does not try:
 * after the first is saved it offers the second as a form already filled in -
 * same amount and date, the other direction, a note saying where it came from -
 * which a person checks, gives an account and an envelope, and saves.
 *
 * The draft travels in the URL, so it is read back as untrusted: amount and
 * date are checked before they are put in front of anyone, and the person still
 * saves it themselves.
 */

import { NOTE_LIMIT } from '../transactions/limits.ts';

export type Direction = 'in' | 'out';

export type OtherSideDraft = {
  /** Positive; the direction says which way. */
  amountCents: number;
  direction: Direction;
  /** `YYYY-MM-DD`. */
  date: string;
  payee: string;
  note: string;
};

/** Apart from the screen's own filters, which already use `payee`, `date` and `dir`. */
const PARAM = {
  amount: 'sideAmount',
  direction: 'sideDir',
  date: 'sideDate',
  payee: 'sidePayee',
  note: 'sideNote',
} as const;

export const OTHER_SIDE_PARAMS: string[] = Object.values(PARAM);

const PAYEE_LIMIT = 200;

function isCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  // Round-trip through UTC to reject 2026-02-30; the string stays the value.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * The draft for the other ledger, from what was just saved in this one.
 * `amountCents` is signed as it was saved: negative left this ledger, so the
 * other side is money arriving.
 */
export function otherSideOf(
  saved: { amountCents: number; date: string; payee: string },
  fromLedger: string,
): OtherSideDraft {
  if (!Number.isSafeInteger(saved.amountCents) || saved.amountCents === 0) {
    throw new Error('The other side needs an amount in whole cents.');
  }
  if (!isCalendarDate(saved.date)) throw new Error(`Not a date: ${saved.date}`);
  const payee = saved.payee.trim().slice(0, PAYEE_LIMIT);
  return {
    amountCents: Math.abs(saved.amountCents),
    direction: saved.amountCents < 0 ? 'in' : 'out',
    date: saved.date,
    payee,
    note: `Other side of${payee ? ` "${payee}"` : ' a transaction'} in ${fromLedger}`.slice(
      0,
      NOTE_LIMIT,
    ),
  };
}

/** The draft as query parameters, for the link that opens it. */
export function draftQuery(draft: OtherSideDraft): Record<string, string> {
  return {
    [PARAM.amount]: String(draft.amountCents),
    [PARAM.direction]: draft.direction,
    [PARAM.date]: draft.date,
    [PARAM.payee]: draft.payee,
    [PARAM.note]: draft.note,
  };
}

/** A draft read back from the URL, or null if anything about it is off. */
export function draftFrom(get: (name: string) => string | null): OtherSideDraft | null {
  const amountText = get(PARAM.amount) ?? '';
  const amountCents = /^\d{1,15}$/.test(amountText) ? Number(amountText) : NaN;
  const direction = get(PARAM.direction);
  const date = get(PARAM.date) ?? '';
  const payee = get(PARAM.payee) ?? '';
  const note = get(PARAM.note) ?? '';

  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  if (direction !== 'in' && direction !== 'out') return null;
  if (!isCalendarDate(date)) return null;
  if (payee.length > PAYEE_LIMIT || note.length > NOTE_LIMIT) return null;
  return { amountCents, direction, date, payee, note };
}
