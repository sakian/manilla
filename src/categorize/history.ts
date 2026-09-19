/**
 * History layer (CA-3, CA-4).
 *
 * Suggests the envelope you have most often used for the same normalized payee,
 * weighted so that recent decisions count more than old ones, and nudged by how
 * closely the amount matches what you normally spend at that merchant.
 *
 * Confidence deliberately stays low when the evidence is thin. One prior visit
 * to a merchant is a hint, not a conclusion, and the review queue treats the
 * two differently.
 */

import { normalizePayee } from './normalize.ts';
import type { Candidate, LabeledTransaction, Suggestion, UnlabeledTransaction } from './types.ts';
import { NO_SUGGESTION } from './types.ts';

export type HistoryOptions = {
  /** Days after which a past decision carries half its original weight. */
  halfLifeDays: number;
  /**
   * Evidence scale. Confidence grows as `1 - exp(-weight / evidenceTau)`, so one
   * sighting lands mid-band (a suggestion worth a glance) and three consistent
   * ones clear the auto-confirm threshold.
   */
  evidenceTau: number;
  /**
   * How hard the amount signal discriminates between two envelopes seen at the
   * same merchant. It only matters when a payee has more than one envelope in
   * its history, so a merchant with varying amounts but one envelope is unaffected.
   */
  amountFloor: number;
  /** Ceiling, so the history layer never claims certainty on its own. */
  maxConfidence: number;
};

export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = {
  halfLifeDays: 180,
  evidenceTau: 1.0,
  amountFloor: 0.25,
  maxConfidence: 0.97,
};

type Observation = {
  envelope: string;
  amountCents: number;
  date: string;
};

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: string): number {
  // Both are plain `YYYY-MM-DD`, so UTC parsing is exact and timezone-free.
  return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export class HistoryIndex {
  private byPayee = new Map<string, Observation[]>();
  private options: HistoryOptions;

  constructor(transactions: LabeledTransaction[] = [], options: Partial<HistoryOptions> = {}) {
    this.options = { ...DEFAULT_HISTORY_OPTIONS, ...options };
    for (const transaction of transactions) this.add(transaction);
  }

  add(transaction: LabeledTransaction): void {
    const { key } = normalizePayee(transaction.payeeRaw);
    const list = this.byPayee.get(key);
    const observation: Observation = {
      envelope: transaction.envelope,
      amountCents: transaction.amountCents,
      date: transaction.date,
    };
    if (list) list.push(observation);
    else this.byPayee.set(key, [observation]);
  }

  /** How many times this payee has been seen. Used to decide whether to call the AI layer. */
  timesSeen(payeeRaw: string): number {
    return this.byPayee.get(normalizePayee(payeeRaw).key)?.length ?? 0;
  }

  /** Every envelope name known to the index, for prompting the AI layer. */
  envelopes(): string[] {
    const names = new Set<string>();
    for (const list of this.byPayee.values()) for (const o of list) names.add(o.envelope);
    return [...names].sort();
  }

  suggest(transaction: UnlabeledTransaction): Suggestion {
    const { key, display } = normalizePayee(transaction.payeeRaw);
    const observations = this.byPayee.get(key);
    if (!observations || observations.length === 0) return NO_SUGGESTION;

    // Only look at decisions made before this transaction, so an evaluation
    // cannot accidentally learn from the future.
    const past = observations.filter((o) => o.date <= transaction.date);
    if (past.length === 0) return NO_SUGGESTION;

    const weights = new Map<string, number>();
    const amounts = new Map<string, number[]>();
    let total = 0;

    for (const observation of past) {
      const age = Math.max(0, daysBetween(observation.date, transaction.date));
      const weight = Math.pow(0.5, age / this.options.halfLifeDays);
      weights.set(observation.envelope, (weights.get(observation.envelope) ?? 0) + weight);
      total += weight;

      const seen = amounts.get(observation.envelope);
      if (seen) seen.push(observation.amountCents);
      else amounts.set(observation.envelope, [observation.amountCents]);
    }

    // Amount signal (CA-4): a charge close to what this merchant usually costs
    // for a given envelope reinforces that envelope. A fuel-sized charge at a
    // gas station looks like Gas; a snack-sized one is less certain.
    for (const [envelope, list] of amounts) {
      const typical = Math.abs(median(list));
      const actual = Math.abs(transaction.amountCents);
      if (typical === 0) continue;
      const ratio = Math.min(typical, actual) / Math.max(typical, actual);
      // 1.0 at an identical amount, falling towards `amountFloor` as they diverge.
      const floor = this.options.amountFloor;
      weights.set(envelope, weights.get(envelope)! * (floor + (1 - floor) * ratio));
    }

    const adjustedTotal = [...weights.values()].reduce((sum, w) => sum + w, 0);
    const ranked: Candidate[] = [...weights.entries()]
      .map(([envelope, weight]) => ({ envelope, confidence: weight / adjustedTotal }))
      .sort((a, b) => b.confidence - a.confidence);

    const top = ranked[0]!;
    // Thin evidence is discounted: a single sighting cannot reach the top band.
    const evidence = 1 - Math.exp(-total / this.options.evidenceTau);
    const confidence = Math.min(top.confidence * evidence, this.options.maxConfidence);

    const count = past.filter((o) => o.envelope === top.envelope).length;
    return {
      envelope: top.envelope,
      confidence,
      layer: 'history',
      reason: `${display}: ${count} of ${past.length} past transaction${past.length === 1 ? '' : 's'} went to ${top.envelope}`,
      alternatives: ranked.slice(1, 3),
    };
  }
}
