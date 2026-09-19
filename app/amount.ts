/**
 * Turning what someone typed into cents.
 *
 * `parseAmount` is the parser the import pipeline uses, and it is deliberately
 * strict: it throws on anything empty and flags anything ambiguous. A form field
 * needs one softer rule - a blank box means zero, not an error - and nothing else
 * about the parsing changes, because a budget typed as "1,234.50" has to land on
 * the same cents as a statement that says the same thing (NF-1).
 */

import { parseAmount } from '../src/money.ts';

export class AmountError extends Error {}

export function centsFromInput(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;

  try {
    const { cents } = parseAmount(trimmed);
    return cents;
  } catch {
    throw new AmountError(`"${text}" is not an amount`);
  }
}

/** For putting cents back into an editable field: no currency symbol, no commas. */
export function inputFromCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
