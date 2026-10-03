/**
 * The envelope lines a transaction form means (FR-4, #37).
 *
 * The first line's amount box shows the transaction's total as a placeholder,
 * which reads as "this line is the whole amount" - and choosing an envelope
 * without typing that number again is the obvious thing to do. But a
 * placeholder is not a value: the line went to the server blank, was dropped as
 * unfinished, and the transaction landed in the review queue with no envelope,
 * to be given the same one a second time.
 *
 * So a line with an envelope and nothing typed takes whatever the other lines
 * leave - the whole amount when it is the only one. Only when it is the only
 * such line: with two blank, which gets what is a guess, and those are left out
 * as before. Kept apart from the form so it can be tested (#16).
 */

import { formatCents, parseAmount } from '../money.ts';

export type LineDraft = { envelopeId: string; amount: string };

/**
 * The same lines, with the one blank line that has an envelope given the rest
 * of `totalCents`. Lines stay in place, so a form can show what each will save.
 */
export function fillBlankLine(drafts: LineDraft[], totalCents: number): LineDraft[] {
  const blank = drafts.filter((line) => line.envelopeId && line.amount.trim() === '');
  if (blank.length !== 1) return drafts;

  let assigned = 0;
  for (const line of drafts) {
    if (!line.envelopeId || line.amount.trim() === '') continue;
    try {
      assigned += parseAmount(line.amount).cents;
    } catch {
      // Still being typed. The server checks the lines add up before saving.
    }
  }

  const rest = totalCents - assigned;
  if (rest <= 0) return drafts;
  return drafts.map((line) => (line === blank[0] ? { ...line, amount: formatCents(rest) } : line));
}

/** The lines worth sending: an envelope and an amount, given or filled in. */
export function linesToSave(drafts: LineDraft[], totalCents: number): LineDraft[] {
  return fillBlankLine(drafts, totalCents).filter(
    (line) => line.envelopeId && line.amount.trim() !== '',
  );
}
