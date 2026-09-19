/**
 * Money is stored as an integer number of cents (NF-1). Nothing in Manilla may
 * represent an amount as a float: `0.1 + 0.2 !== 0.3` is not acceptable in a
 * ledger that has to reconcile to the cent.
 *
 * Bank files are inconsistent about separators, so parsing is done on the digit
 * string rather than via `parseFloat`. Anything ambiguous is reported rather
 * than silently guessed.
 */

export type ParsedAmount = {
  cents: number;
  /** Set when the text could reasonably have been read another way. */
  warning?: string;
};

const CLEAN = /[\s '`$€£¥]/g;

/**
 * Parse a monetary string into integer cents.
 *
 * Separator rules, in order:
 *   - both `.` and `,` present  -> the rightmost one is the decimal separator
 *   - one separator, 3 trailing digits, comma -> thousands ("1,234")
 *   - one separator, 3 trailing digits, period -> decimal per the OFX spec, flagged
 *   - one separator, any other count -> decimal separator
 *   - no separator -> whole units
 */
export function parseAmount(raw: string): ParsedAmount {
  const text = raw.replace(CLEAN, '');
  if (text === '') throw new Error('Empty amount');

  // Accounting-style negatives: (123.45)
  const parenthesised = /^\((.*)\)$/.exec(text);
  const unwrapped = parenthesised ? parenthesised[1]! : text;

  // Sign may lead or trail. Both OFX and CSV exports do each.
  const signMatch = /^([+-]?)(.*?)([+-]?)$/.exec(unwrapped)!;
  const leading = signMatch[1]!;
  const trailing = signMatch[3]!;
  const body = signMatch[2]!;
  if (leading && trailing) throw new Error(`Two signs in amount: ${raw}`);
  const negative = parenthesised !== null || leading === '-' || trailing === '-';

  if (!/^[\d.,]+$/.test(body) || !/\d/.test(body)) {
    throw new Error(`Not a number: ${raw}`);
  }

  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  const warnings: string[] = [];
  let decimalAt = -1;

  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = Math.max(lastDot, lastComma);
    const trailingDigits = body.length - only - 1;
    const isComma = only === lastComma;
    if (trailingDigits === 3 && isComma) {
      decimalAt = -1; // "1,234" reads as thousands
    } else {
      decimalAt = only;
      if (trailingDigits === 3) {
        warnings.push(
          `"${raw}" read as ${body.slice(0, only)}.${body.slice(only + 1)}; could be a thousands separator`,
        );
      }
    }
  }

  const whole = (decimalAt >= 0 ? body.slice(0, decimalAt) : body).replace(/[.,]/g, '');
  const fraction = decimalAt >= 0 ? body.slice(decimalAt + 1).replace(/[.,]/g, '') : '';

  if (fraction.length > 2) {
    warnings.push(`"${raw}" has ${fraction.length} decimal places; rounded to cents`);
  }

  // Round half-up on the third decimal rather than truncating.
  const padded = (fraction + '00').slice(0, 2);
  const roundUp = fraction.length > 2 && Number(fraction[2]) >= 5;
  const magnitude = Number(whole || '0') * 100 + Number(padded) + (roundUp ? 1 : 0);

  if (!Number.isSafeInteger(magnitude)) throw new Error(`Amount out of range: ${raw}`);

  return {
    cents: negative ? -magnitude : magnitude,
    ...(warnings.length > 0 ? { warning: warnings.join('; ') } : {}),
  };
}

/** Display helper. Formatting for the UI comes later; this is for spike output. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
