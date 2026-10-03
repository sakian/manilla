/**
 * How far through its money an envelope is, against how far through the month
 * we are (VW-1, VW-2, #3).
 *
 * What the envelope had this month is what it has spent plus what it still
 * holds: the carry-over, the month's funding and any transfers all land in one
 * of those two, so nothing has to be added up separately. The bar is the spent
 * share of that, and the pace marker is the share of the month gone.
 */

import { monthEnd, monthOf } from './month.ts';

export type Progress = {
  /** Spent as a share of what the envelope had this month, 0 to 1. */
  share: number;
  /** What it had to spend this month: spent plus what is left. */
  availableCents: number;
  /** More spent than it had; the bar is full and says so. */
  overspent: boolean;
  /**
   * Spending is running ahead of the month - 80% gone by the 10th. Only for a
   * part-spent envelope: a bill paid in full on the 1st is done, not ahead.
   */
  ahead: boolean;
};

/**
 * How far ahead of the month spending has to be before it is called out. Without
 * a margin, an envelope spent in step with the month flickers in and out of
 * "ahead" from one day to the next.
 */
export const AHEAD_MARGIN = 0.1;

/** The share of the month gone by the end of `today`: the 10th of a 30-day month is 1/3. */
export function monthPace(today: string): number {
  const days = Number(monthEnd(monthOf(today)).slice(8));
  return Number(today.slice(8, 10)) / days;
}

/**
 * The bar for one envelope, or null until there is something to draw: nothing
 * spent this month, and not overspent.
 *
 * An empty bar used to be drawn for money held but not yet spent. Early in the
 * month that was every bar, and an empty track with only the pace tick on it
 * looks like a slider waiting to be dragged. Bars now appear as spending does.
 *
 * `spentCents` is the month's net spending as a positive number, as the budget
 * reports it; refunds beyond spending make it negative, which draws as nothing
 * spent.
 */
export function envelopeProgress(
  figures: { spentCents: number; balanceCents: number },
  pace: number,
): Progress | null {
  const { spentCents, balanceCents } = figures;
  const availableCents = spentCents + balanceCents;
  const overspent = balanceCents < 0;

  if (spentCents <= 0 && !overspent) return null;
  if (availableCents <= 0) return { share: 1, availableCents, overspent, ahead: false };

  const share = Math.min(1, Math.max(0, spentCents / availableCents));
  return {
    share,
    availableCents,
    overspent,
    ahead: !overspent && share < 1 && share > pace + AHEAD_MARGIN,
  };
}
