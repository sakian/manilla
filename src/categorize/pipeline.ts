/**
 * The layered pipeline from section 5: rules, then history, then AI.
 *
 * Each layer stops the chain when it is confident enough, so the AI layer only
 * sees what the cheap deterministic layers could not place. That ordering is
 * what keeps the running cost near zero once history has built up.
 */

import { normalizePayee } from './normalize.ts';
import type { HistoryIndex } from './history.ts';
import type { AiCategorizer } from './ai.ts';
import type { Suggestion, UnlabeledTransaction } from './types.ts';
import { NO_SUGGESTION } from './types.ts';

/** CA-2: a user rule, normally created in one click from a correction. */
export type Rule = {
  id: string;
  /** Matched against the normalized payee key, case-insensitively. */
  contains: string;
  envelope: string;
  minCents?: number;
  maxCents?: number;
  account?: string;
};

export type Band = 'high' | 'medium' | 'low';

/**
 * CA-7. `high` is pre-assigned and bulk-confirmable; `medium` is shown as a
 * suggestion to glance at; `low` is left uncategorized with candidates listed.
 */
export const BAND_THRESHOLDS = { high: 0.85, medium: 0.5 } as const;

export function bandOf(confidence: number): Band {
  if (confidence >= BAND_THRESHOLDS.high) return 'high';
  if (confidence >= BAND_THRESHOLDS.medium) return 'medium';
  return 'low';
}

export function matchRule(rules: Rule[], transaction: UnlabeledTransaction): Rule | undefined {
  const { key } = normalizePayee(transaction.payeeRaw);
  return rules.find((rule) => {
    if (!key.includes(rule.contains.toUpperCase())) return false;
    if (rule.account !== undefined && rule.account !== transaction.account) return false;
    const amount = Math.abs(transaction.amountCents);
    if (rule.minCents !== undefined && amount < rule.minCents) return false;
    if (rule.maxCents !== undefined && amount > rule.maxCents) return false;
    return true;
  });
}

export type CategorizerOptions = {
  /**
   * History confidence at or above which the AI layer is not consulted.
   * Lower values save money; higher values buy accuracy on thin history.
   */
  aiThreshold: number;
};

export const DEFAULT_OPTIONS: CategorizerOptions = { aiThreshold: 0.7 };

export class Categorizer {
  private rules: Rule[];
  private history: HistoryIndex;
  private ai: AiCategorizer | undefined;
  private options: CategorizerOptions;

  constructor(
    rules: Rule[],
    history: HistoryIndex,
    ai?: AiCategorizer,
    options: Partial<CategorizerOptions> = {},
  ) {
    this.rules = rules;
    this.history = history;
    this.ai = ai;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async suggestAll(transactions: UnlabeledTransaction[]): Promise<Suggestion[]> {
    const out = new Array<Suggestion>(transactions.length);
    const needsAi: { position: number; transaction: UnlabeledTransaction; fallback: Suggestion }[] = [];

    transactions.forEach((transaction, position) => {
      const rule = matchRule(this.rules, transaction);
      if (rule) {
        out[position] = {
          envelope: rule.envelope,
          confidence: 1,
          layer: 'rule',
          reason: `Your rule: payee contains "${rule.contains}"`,
          alternatives: [],
        };
        return;
      }

      const fromHistory = this.history.suggest(transaction);
      if (fromHistory.envelope && fromHistory.confidence >= this.options.aiThreshold) {
        out[position] = fromHistory;
        return;
      }

      needsAi.push({ position, transaction, fallback: fromHistory });
    });

    if (needsAi.length === 0) return out;

    if (!this.ai) {
      for (const item of needsAi) out[item.position] = item.fallback;
      return out;
    }

    const suggestions = await this.ai.suggestBatch(needsAi.map((item) => item.transaction));
    needsAi.forEach((item, index) => {
      const fromAi = suggestions[index] ?? NO_SUGGESTION;
      // Keep whichever layer is more confident; history that nearly cleared the
      // threshold should not be thrown away for a hesitant model answer.
      out[item.position] =
        fromAi.envelope !== null && fromAi.confidence >= item.fallback.confidence
          ? fromAi
          : item.fallback.envelope
            ? item.fallback
            : fromAi;
    });

    return out;
  }
}
