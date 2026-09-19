/**
 * AI layer (CA-5, CA-8).
 *
 * Called only for payees the rule and history layers could not place. The model
 * sees payee text, amount, date and the envelope list - never account numbers,
 * balances or names (NF-5).
 *
 * The envelope list is passed in the system prompt so it can be cached across
 * batches; only the transactions themselves vary per request.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { formatCents } from '../money.ts';
import { normalizePayee } from './normalize.ts';
import type { Suggestion, UnlabeledTransaction } from './types.ts';
import { NO_SUGGESTION } from './types.ts';

const MODEL = 'claude-opus-5';
const UNKNOWN = 'UNKNOWN';

/** Batching keeps the per-transaction cost down; 25 fits comfortably in one response. */
export const BATCH_SIZE = 25;

const ResultSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().describe('The transaction number given in the request'),
      envelope: z.string().describe(`An envelope name exactly as listed, or "${UNKNOWN}"`),
      confidence: z.number().describe('0 to 1: how sure you are'),
      reason: z.string().describe('One short clause explaining the choice'),
    }),
  ),
});

export type AiUsage = {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type ExamplesByEnvelope = Record<string, string[]>;

function systemPrompt(envelopes: string[], examples: ExamplesByEnvelope): string {
  const lines = envelopes.map((envelope) => {
    const merchants = (examples[envelope] ?? []).slice(0, 8);
    return merchants.length > 0
      ? `- ${envelope} (past merchants: ${merchants.join(', ')})`
      : `- ${envelope}`;
  });

  return [
    'You sort personal bank transactions into the budget envelopes below.',
    '',
    'Envelopes:',
    ...lines,
    '',
    'Rules:',
    `- Choose an envelope name exactly as written above, or "${UNKNOWN}" if none fits.`,
    '- Never invent an envelope name.',
    '- Use the merchant name first. Use the amount as a secondary signal: a fuel-sized',
    '  charge at a gas station is fuel, a small one at the same place may be a snack.',
    '- A positive amount is money coming in; a negative amount is money going out.',
    '- Set confidence below 0.5 when the merchant is genuinely ambiguous. A wrong',
    '  high-confidence answer costs the user more than an honest low-confidence one.',
    '- Reply for every transaction, using the index given.',
  ].join('\n');
}

function userPrompt(transactions: UnlabeledTransaction[]): string {
  return transactions
    .map((transaction, index) => {
      const { display } = normalizePayee(transaction.payeeRaw);
      const memo = transaction.memo ? ` | memo: ${transaction.memo}` : '';
      return `${index}. ${display} | ${formatCents(transaction.amountCents)} | ${transaction.date}${memo}`;
    })
    .join('\n');
}

export class AiCategorizer {
  private client: Anthropic;
  private envelopes: string[];
  private examples: ExamplesByEnvelope;
  private cache = new Map<string, Suggestion>();
  usage: AiUsage = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  constructor(envelopes: string[], examples: ExamplesByEnvelope = {}, client?: Anthropic) {
    this.client = client ?? new Anthropic();
    this.envelopes = envelopes;
    this.examples = examples;
  }

  /**
   * Suggest an envelope for each transaction. Results are cached per normalized
   * payee, so a merchant that repeats within a run costs one call, not many.
   */
  async suggestBatch(transactions: UnlabeledTransaction[]): Promise<Suggestion[]> {
    const out = new Array<Suggestion>(transactions.length);
    const pending: { position: number; transaction: UnlabeledTransaction }[] = [];

    transactions.forEach((transaction, position) => {
      const cached = this.cache.get(normalizePayee(transaction.payeeRaw).key);
      if (cached) out[position] = cached;
      else pending.push({ position, transaction });
    });

    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const slice = pending.slice(start, start + BATCH_SIZE);
      const suggestions = await this.callModel(slice.map((item) => item.transaction));
      slice.forEach((item, index) => {
        const suggestion = suggestions[index] ?? NO_SUGGESTION;
        out[item.position] = suggestion;
        this.cache.set(normalizePayee(item.transaction.payeeRaw).key, suggestion);
      });
    }

    return out.map((suggestion) => suggestion ?? NO_SUGGESTION);
  }

  private async callModel(transactions: UnlabeledTransaction[]): Promise<Suggestion[]> {
    const response = await this.client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: systemPrompt(this.envelopes, this.examples),
          // The envelope list is identical across batches, so cache it.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt(transactions) }],
      output_config: {
        effort: 'low',
        format: zodOutputFormat(ResultSchema),
      },
    });

    this.usage.requests += 1;
    this.usage.inputTokens += response.usage.input_tokens;
    this.usage.cachedInputTokens += response.usage.cache_read_input_tokens ?? 0;
    this.usage.outputTokens += response.usage.output_tokens;

    const parsed = response.parsed_output;
    if (!parsed) return transactions.map(() => NO_SUGGESTION);

    const known = new Set(this.envelopes);
    const byIndex = new Map(parsed.results.map((result) => [result.index, result]));

    return transactions.map((_, index) => {
      const result = byIndex.get(index);
      if (!result || result.envelope === UNKNOWN) return NO_SUGGESTION;

      // CA-8: the model may only choose from envelopes that exist.
      if (!known.has(result.envelope)) {
        return {
          ...NO_SUGGESTION,
          reason: `Model proposed "${result.envelope}", which is not an envelope`,
        };
      }

      return {
        envelope: result.envelope,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        layer: 'ai',
        reason: result.reason,
        alternatives: [],
      };
    });
  }
}
