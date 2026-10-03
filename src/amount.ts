/**
 * Turning what someone typed into cents.
 *
 * `parseAmount` is the parser the import pipeline uses, and it is deliberately
 * strict: it throws on anything empty and flags anything ambiguous. A form field
 * needs one softer rule - a blank box means zero, not an error - and nothing else
 * about the parsing changes, because a budget typed as "1,234.50" has to land on
 * the same cents as a statement that says the same thing (NF-1).
 *
 * The flag is where a form has to be stricter than an import, not softer. An
 * import can carry a warning to a screen that shows it; a form field cannot, so
 * "1.234" - a thousand, written the European way, or one dollar and change -
 * used to save as $1.23 without a word. Whoever typed it is right there to say
 * which they meant, so it is refused with a question rather than guessed at.
 *
 * Here rather than in app/ because the browser and every server action both
 * call it, and only src/ is reachable by the test runner (#16).
 */

import { formatCents, parseAmount } from './money.ts';

export class AmountError extends Error {}

export function centsFromInput(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;

  let parsed: ReturnType<typeof parseAmount>;
  try {
    parsed = parseAmount(trimmed);
  } catch {
    throw new AmountError(`"${text}" is not an amount`);
  }
  if (parsed.warning) {
    throw new AmountError(
      `"${trimmed}" has more than two digits after the point. Write cents with two, or a thousand as 1000 or 1,000.`,
    );
  }
  return parsed.cents;
}

/**
 * For putting cents back into an editable field: no currency symbol, no commas.
 *
 * Which is exactly `formatCents`, and has to stay exactly `formatCents` - what
 * this writes into the box is what `centsFromInput` above reads back out of it,
 * and that round-trip is asserted in src/money.test.ts.
 */
export const inputFromCents = formatCents;
