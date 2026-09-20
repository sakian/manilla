/**
 * AI layer (CA-5, CA-8).
 *
 * Called only for payees the rule and history layers could not place. The model
 * sees payee text, amount, date and the envelope list - never account numbers,
 * balances or names (NF-5).
 *
 * The envelope list is passed in the system prompt so it can be cached across
 * batches; only the transactions themselves vary per request.
 *
 * The model is shown envelope *names* and answers with names, because a name is
 * what it can reason about; the ledger works in ids, so the mapping happens here
 * at the boundary. Showing it the ids would be a prompt full of UUIDs, and no
 * answer worth the tokens.
 *
 * A call that fails does not throw. The layer above has a history suggestion in
 * hand and an import in progress, and neither should stop because a network is
 * having a bad minute (NF-10). The failure is recorded and reported instead.
 */

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { formatCents } from '../money.ts';
import { normalizePayee } from './normalize.ts';
import type { Suggestion, UnlabeledTransaction } from './types.ts';
import { NO_SUGGESTION } from './types.ts';

/** Exported so the answer cache records which model gave each answer. */
export const AI_MODEL = 'claude-opus-5';
const MODEL = AI_MODEL;
const UNKNOWN = 'UNKNOWN';

/** Batching keeps the per-transaction cost down; 25 fits comfortably in one response. */
export const BATCH_SIZE = 25;

/**
 * How sure the model has to be before its answer is reused for that merchant.
 *
 * Section 5 asks for an answer cached per merchant so a repeat never costs a
 * second call. Measured against three held-out months, doing that for *every*
 * answer costs about ten points of accuracy, and the reason is in the Phase 0
 * findings: 68% of transactions happen at merchants used for more than one
 * envelope, and what separates them is the amount. One answer for "AMAZON"
 * applied to every Amazon charge throws that signal away.
 *
 * So the cache is kept for the merchants it is safe for. A confident answer
 * means the merchant is unambiguous - a fuel station is a fuel station - and is
 * reused. An unsure one means the amount is doing the work, and that
 * transaction is asked about on its own terms.
 */
export const CACHEABLE_CONFIDENCE = 0.8;

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

export type EnvelopeChoice = { id: string; name: string };

/**
 * Anthropic's published rates for the model this uses, in dollars per million
 * tokens. Cached input is a tenth of the price, which is the whole reason the
 * envelope list sits in a cached system prompt.
 */
const PRICE_PER_MTOK = { input: 5, cachedInput: 0.5, output: 25 } as const;

/** What a call cost, in tenths of a cent - one call is well under a cent. */
export function costMilliCents(usage: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const dollars =
    ((usage.inputTokens - usage.cachedInputTokens) * PRICE_PER_MTOK.input +
      usage.cachedInputTokens * PRICE_PER_MTOK.cachedInput +
      usage.outputTokens * PRICE_PER_MTOK.output) /
    1_000_000;
  return Math.round(dollars * 100_000);
}

export type CallRecord = {
  model: string;
  transactions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMilliCents: number;
  error?: string;
};

export type AiOptions = {
  client?: Anthropic;
  /** Told about every call, successful or not, for the budget and the log. */
  onCall?: (record: CallRecord) => void | Promise<void>;
  /** Asked before every call. Returning false stops the layer for this run. */
  canCall?: () => boolean | Promise<boolean>;
};

function systemPrompt(envelopes: EnvelopeChoice[], examples: ExamplesByEnvelope): string {
  const lines = envelopes.map((envelope) => {
    const merchants = (examples[envelope.id] ?? []).slice(0, 8);
    return merchants.length > 0
      ? `- ${envelope.name} (past merchants: ${merchants.join(', ')})`
      : `- ${envelope.name}`;
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
  private envelopes: EnvelopeChoice[];
  private idByName: Map<string, string>;
  private examples: ExamplesByEnvelope;
  private cache = new Map<string, Suggestion>();
  private options: AiOptions;
  /** Set when the budget ran out or a call failed, so the run stops asking. */
  stopped: string | null = null;
  usage: AiUsage = { requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  constructor(
    envelopes: EnvelopeChoice[],
    examples: ExamplesByEnvelope = {},
    options: AiOptions = {},
  ) {
    this.client = options.client ?? new Anthropic();
    this.envelopes = envelopes;
    this.idByName = new Map(envelopes.map((envelope) => [envelope.name, envelope.id]));
    this.examples = examples;
    this.options = options;
  }

  /** Seed the per-run cache from what has already been asked (section 5). */
  seed(answers: Iterable<[string, Suggestion]>): void {
    for (const [payeeKey, suggestion] of answers) this.cache.set(payeeKey, suggestion);
  }

  /** What this run decided, so the caller can remember it for next time. */
  fresh = new Map<string, Suggestion>();

  /**
   * Suggest an envelope for each transaction.
   *
   * Asked per transaction, not per merchant: the amount is a real signal and
   * sharing one answer across a merchant's charges discards it. Confident
   * answers are cached per merchant afterwards, which is where the saving comes
   * from without costing accuracy (CACHEABLE_CONFIDENCE).
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

        // Only a real, confident answer is worth remembering. Caching "we could
        // not reach the model" would turn one bad minute into a permanent gap,
        // and caching an unsure answer is worse than not caching at all - see
        // CACHEABLE_CONFIDENCE.
        if (suggestion.layer === 'ai' && suggestion.confidence >= CACHEABLE_CONFIDENCE) {
          const key = normalizePayee(item.transaction.payeeRaw).key;
          this.cache.set(key, suggestion);
          this.fresh.set(key, suggestion);
        }
      });

      if (this.stopped) break;
    }

    return out.map((suggestion) => suggestion ?? NO_SUGGESTION);
  }

  private async callModel(transactions: UnlabeledTransaction[]): Promise<Suggestion[]> {
    if (this.stopped) return transactions.map(() => NO_SUGGESTION);

    if (this.options.canCall && !(await this.options.canCall())) {
      this.stopped = 'The monthly call budget for the AI layer is used up.';
      return transactions.map(() => ({ ...NO_SUGGESTION, reason: this.stopped! }));
    }

    let response;
    try {
      response = await this.client.messages.parse({
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
    } catch (error) {
      // NF-10: the import carries on without this layer rather than failing.
      const message = error instanceof Error ? error.message : String(error);
      this.stopped = `The AI layer stopped after an error: ${message}`;
      await this.options.onCall?.({
        model: MODEL,
        transactions: transactions.length,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        costMilliCents: 0,
        error: message,
      });
      return transactions.map(() => NO_SUGGESTION);
    }

    const inputTokens = response.usage.input_tokens;
    const cachedInputTokens = response.usage.cache_read_input_tokens ?? 0;
    const outputTokens = response.usage.output_tokens;

    this.usage.requests += 1;
    this.usage.inputTokens += inputTokens;
    this.usage.cachedInputTokens += cachedInputTokens;
    this.usage.outputTokens += outputTokens;

    await this.options.onCall?.({
      model: MODEL,
      transactions: transactions.length,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costMilliCents: costMilliCents({ inputTokens, cachedInputTokens, outputTokens }),
    });

    const parsed = response.parsed_output;
    if (!parsed) return transactions.map(() => NO_SUGGESTION);

    const byIndex = new Map(parsed.results.map((result) => [result.index, result]));

    return transactions.map((_, index) => {
      const result = byIndex.get(index);
      if (!result || result.envelope === UNKNOWN) return NO_SUGGESTION;

      // CA-8: the model may only choose from envelopes that exist. It answers in
      // names; the ledger works in ids.
      const envelopeId = this.idByName.get(result.envelope);
      if (!envelopeId) {
        return {
          ...NO_SUGGESTION,
          reason: `Model proposed "${result.envelope}", which is not an envelope`,
        };
      }

      return {
        envelope: envelopeId,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        layer: 'ai',
        reason: result.reason,
        alternatives: [],
      };
    });
  }
}
