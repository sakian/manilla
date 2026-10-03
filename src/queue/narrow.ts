/**
 * Narrowing the envelope picker by what has been typed (RQ-3, issue #32).
 *
 * Kept apart from `queue.ts` because the picker runs in the browser, and that
 * file brings the database with it.
 */

import type { EnvelopeOption } from './queue.ts';

export type EnvelopeGroup = { name: string; envelopes: EnvelopeOption[] };

/** Every envelope under its own heading, in the order they arrive. */
export function groupEnvelopes(envelopes: EnvelopeOption[]): EnvelopeGroup[] {
  const groups: EnvelopeGroup[] = [];
  for (const envelope of envelopes) {
    const last = groups.at(-1);
    if (last && last.name === envelope.groupName) last.envelopes.push(envelope);
    else groups.push({ name: envelope.groupName, envelopes: [envelope] });
  }
  return groups;
}

/** Case and accents ignored: "cafe" should find "Café". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * The envelopes matching `query`, still under their headings and in the same
 * order, so a narrowed list reads like the whole one with rows missing.
 *
 * Every word typed must appear somewhere in the envelope's name or its
 * category's. The category counts because the list shows both, and two
 * envelopes called "Insurance" are told apart only by theirs: "car ins" finds
 * the one under Car. Order is never re-ranked, because Enter takes the first
 * match and the first match should be the one at the top of the screen.
 */
export function narrowEnvelopes(envelopes: EnvelopeOption[], query: string): EnvelopeGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return groupEnvelopes(envelopes);
  return groupEnvelopes(
    envelopes.filter((envelope) => {
      const haystack = `${fold(envelope.name)} ${fold(envelope.groupName)}`;
      return words.every((word) => haystack.includes(word));
    }),
  );
}
