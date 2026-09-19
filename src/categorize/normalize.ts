/**
 * Payee normalization (CA-1).
 *
 * Bank descriptions carry store numbers, terminal ids, cities and reference
 * codes that make every visit to the same merchant look unique. Collapsing
 * them to a stable key is what lets the history layer say "you have put this
 * merchant in Gas eleven times" instead of seeing eleven strangers.
 *
 * Every rule here is reversible in the sense that the raw description is kept
 * on the transaction; normalization only produces a matching key.
 */

/** Canadian provinces and territories, plus the US states that show up on cross-border charges. */
const REGIONS = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
  'CA', 'USA', 'US', 'WA', 'NY', 'CA-ON', 'MT', 'OR',
]);

/**
 * Cities are stripped only from the end of a description, so a merchant that is
 * named after a place ("CALGARY CO-OP") keeps its name while "SHELL CALGARY"
 * and "SHELL" collapse together. The list is deliberately partial; an unknown
 * city merely leaves a slightly noisier key, never a wrong one.
 */
const CITIES = new Set([
  'CALGARY', 'EDMONTON', 'RED DEER', 'LETHBRIDGE', 'AIRDRIE', 'BANFF', 'CANMORE',
  'VANCOUVER', 'VICTORIA', 'BURNABY', 'SURREY', 'KELOWNA', 'RICHMOND',
  'TORONTO', 'OTTAWA', 'MISSISSAUGA', 'HAMILTON', 'LONDON', 'KITCHENER',
  'MONTREAL', 'QUEBEC', 'LAVAL', 'GATINEAU',
  'WINNIPEG', 'SASKATOON', 'REGINA', 'HALIFAX', 'ST JOHNS', 'FREDERICTON',
]);

/**
 * Transaction-channel noise that banks prepend. Ordered longest-first so that
 * "VISA DEBIT PURCHASE" is stripped before the shorter "PURCHASE" can match.
 */
const PREFIXES = [
  'PREAUTHORIZED DEBIT',
  'PRE-AUTHORIZED DEBIT',
  'VISA DEBIT PURCHASE',
  'VISA DEBIT RETAIL PURCHASE',
  'INTERAC RETAIL PURCHASE',
  'INTERAC PURCHASE',
  'IDP PURCHASE',
  'POS PURCHASE',
  'DEBIT PURCHASE',
  'WWW PURCHASE',
  'POINT OF SALE PURCHASE',
  'RETAIL PURCHASE',
  'PURCHASE',
  'PAYMENT TO',
  'MISC PAYMENT',
  'POS',
];

const SUFFIXES = [
  'THANK YOU',
  'MERCI',
];

export type NormalizedPayee = {
  /** Stable matching key: uppercase, noise removed. */
  key: string;
  /** Title-cased version for display. */
  display: string;
};

function stripPrefixes(text: string): string {
  let result = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PREFIXES) {
      if (result.startsWith(prefix + ' ')) {
        result = result.slice(prefix.length + 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

/** Drop trailing location tokens: "TIM HORTONS CALGARY AB" -> "TIM HORTONS". */
function stripTrailingLocation(words: string[]): string[] {
  const result = [...words];
  while (result.length > 1) {
    const last = result[result.length - 1]!;
    if (!REGIONS.has(last) && !CITIES.has(last)) break;
    result.pop();
  }
  return result;
}

export function normalizePayee(raw: string): NormalizedPayee {
  let text = raw.toUpperCase().trim();

  // Some banks pack the merchant after a channel marker and a reference number.
  text = text.replace(/\s+/g, ' ');
  text = stripPrefixes(text);

  for (const suffix of SUFFIXES) {
    if (text.endsWith(' ' + suffix)) text = text.slice(0, -(suffix.length + 1));
  }

  // Amazon-style "AMZN MKTP CA*1A2B3C" and "SQ *COFFEE BAR": the marker splits
  // the processor from the merchant. Keep whichever side carries the name.
  const star = /^(SQ|TST|PAYPAL|PP|SP|WPY|IC)\s*\*\s*(.+)$/.exec(text);
  if (star) text = star[2]!;
  text = text.replace(/\*[A-Z0-9]{4,}\b/g, ' ');

  // Store and terminal numbers.
  text = text.replace(/#\s*\d+/g, ' ');
  text = text.replace(/\b\d{4,}\b/g, ' ');

  // Reference codes where a short letter prefix or suffix is glued to the
  // digits, so there is no word boundary to match: "SPOTIFY P1747", "REF00912".
  text = text.replace(/\b[A-Z]{1,3}\d{3,}\b/g, ' ');
  text = text.replace(/\b\d{3,}[A-Z]{1,3}\b/g, ' ');

  // Embedded dates such as "09/03" or "SEP 03".
  text = text.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ');

  // Leftover punctuation, but keep the dot in domains like NETFLIX.COM and the
  // hyphen in PETRO-CANADA, which are part of how the merchant is known.
  text = text.replace(/[^A-Z0-9.\- ]+/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  // Drop tokens that are punctuation only, left behind by "PAYMENT - THANK YOU".
  let words = text.split(' ').filter((word) => /[A-Z0-9]/.test(word));
  words = stripTrailingLocation(words);

  // A trailing bare number that survived (e.g. "PETRO-CANADA 123") is a store id.
  while (words.length > 1 && /^\d+$/.test(words[words.length - 1]!)) words.pop();

  const key = words.join(' ').replace(/[.\-]+$/, '').trim();
  const display = key
    .split(' ')
    .map((word) => (/^[A-Z]+\.[A-Z]+$/.test(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()))
    .join(' ');

  return { key: key || raw.toUpperCase().trim(), display: display || raw.trim() };
}
