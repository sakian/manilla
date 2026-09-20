/**
 * The AI layer's settings, budget, cache and record (NF-5, NF-10, section 5).
 *
 * Everything here exists because the model costs money and sees data. The
 * controls the requirements ask for, and what each is actually for:
 *
 *  - **An off switch.** On by default, because the measured layer earns its
 *    place and the guards below are what make that safe rather than the switch
 *    being off. Nothing happens without an API key, the monthly budget caps the
 *    spend, and everything still works with it off - the history layer measured
 *    62.8% accepted unchanged on its own.
 *  - **A cache per merchant.** The answer is about a merchant, not a
 *    transaction, so "SHELL #4471 CALGARY" and "SHELL 2280" cost one call
 *    between them, ever. On the real history this is the difference between
 *    827 merchants and 7,957 transactions.
 *  - **A monthly call budget with a counter.** Checked before every call, not
 *    after, so it cannot be overrun by one batch.
 *  - **A record of every call.** Tokens, cost and errors, so a month that looks
 *    expensive can be explained rather than just totalled.
 *
 * What is sent is payee text, amount, date and the envelope names. Never an
 * account number, a balance, or anyone's name (NF-5).
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { aiCalls, aiSuggestionCache, appSettings, envelopes, suggestions } from '../../db/schema.ts';
import { monthStart, currentMonth, type MonthKey } from '../budget/month.ts';
import type { CallRecord } from '../categorize/ai.ts';
import type { Suggestion } from '../categorize/types.ts';

export const AI_ENABLED_KEY = 'ai_enabled';
export const AI_BUDGET_KEY = 'ai_monthly_call_budget';

/** Enough for a few hundred unknown merchants a month, at about $2 per thousand. */
export const DEFAULT_MONTHLY_CALL_BUDGET = 40;

export type AiSettings = {
  enabled: boolean;
  monthlyCallBudget: number;
};

export async function aiSettings(db: Database): Promise<AiSettings> {
  const rows = await db.select().from(appSettings);
  const values = new Map(rows.map((row) => [row.key, row.value]));

  const budget = Number(values.get(AI_BUDGET_KEY));

  return {
    // On unless explicitly switched off. The real guards are the API key having
    // to be present at all and the monthly budget, not the default: without a
    // key nothing calls anything, and with one the budget is checked before
    // every call.
    enabled: values.get(AI_ENABLED_KEY) !== 'false',
    monthlyCallBudget:
      Number.isSafeInteger(budget) && budget >= 0 ? budget : DEFAULT_MONTHLY_CALL_BUDGET,
  };
}

export async function setAiSettings(
  db: Database,
  update: Partial<AiSettings>,
): Promise<void> {
  const writes: { key: string; value: string }[] = [];

  if (update.enabled !== undefined) {
    writes.push({ key: AI_ENABLED_KEY, value: update.enabled ? 'true' : 'false' });
  }
  if (update.monthlyCallBudget !== undefined) {
    if (!Number.isSafeInteger(update.monthlyCallBudget) || update.monthlyCallBudget < 0) {
      throw new Error('The monthly call budget must be a whole number of calls');
    }
    writes.push({ key: AI_BUDGET_KEY, value: String(update.monthlyCallBudget) });
  }

  for (const write of writes) {
    await db
      .insert(appSettings)
      .values(write)
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: write.value, updatedAt: new Date() },
      });
  }
}

// ---------------------------------------------------------------------------
// What it has cost, and what is left
// ---------------------------------------------------------------------------

export type AiUsageReport = {
  month: MonthKey;
  calls: number;
  failedCalls: number;
  transactions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costMilliCents: number;
  budget: number;
  remaining: number;
  /** Merchants already answered for, which will never be asked about again. */
  cachedMerchants: number;
};

export async function aiUsage(
  db: Database,
  month: MonthKey = currentMonth(),
): Promise<AiUsageReport> {
  const [totals] = await db
    .select({
      calls: sql<string>`count(*) filter (where ${aiCalls.error} is null)`,
      failedCalls: sql<string>`count(*) filter (where ${aiCalls.error} is not null)`,
      transactions: sql<string>`coalesce(sum(${aiCalls.transactions}), 0)`,
      inputTokens: sql<string>`coalesce(sum(${aiCalls.inputTokens}), 0)`,
      cachedInputTokens: sql<string>`coalesce(sum(${aiCalls.cachedInputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${aiCalls.outputTokens}), 0)`,
      costMilliCents: sql<string>`coalesce(sum(${aiCalls.costMilliCents}), 0)`,
    })
    .from(aiCalls)
    .where(eq(aiCalls.month, monthStart(month)));

  const [cached] = await db
    .select({ count: sql<string>`count(*)` })
    .from(aiSuggestionCache);

  const settings = await aiSettings(db);
  const calls = Number(totals?.calls ?? 0);

  return {
    month,
    calls,
    failedCalls: Number(totals?.failedCalls ?? 0),
    transactions: Number(totals?.transactions ?? 0),
    inputTokens: Number(totals?.inputTokens ?? 0),
    cachedInputTokens: Number(totals?.cachedInputTokens ?? 0),
    outputTokens: Number(totals?.outputTokens ?? 0),
    costMilliCents: Number(totals?.costMilliCents ?? 0),
    budget: settings.monthlyCallBudget,
    remaining: Math.max(0, settings.monthlyCallBudget - calls),
    cachedMerchants: Number(cached?.count ?? 0),
  };
}

/** Record one call, successful or not (NF-11). */
export async function recordAiCall(
  db: Database,
  record: CallRecord,
  month: MonthKey = currentMonth(),
): Promise<void> {
  await db.insert(aiCalls).values({
    month: monthStart(month),
    model: record.model,
    transactions: record.transactions,
    inputTokens: record.inputTokens,
    cachedInputTokens: record.cachedInputTokens,
    outputTokens: record.outputTokens,
    costMilliCents: record.costMilliCents,
    error: record.error ?? null,
  });
}

/** The recent calls, newest first, for the settings page. */
export async function recentAiCalls(db: Database, limit = 10) {
  return db.select().from(aiCalls).orderBy(desc(aiCalls.createdAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// The merchant cache
// ---------------------------------------------------------------------------

/**
 * What the model has already said, keyed by normalized payee.
 *
 * An answer pointing at an envelope that has since been archived or deleted is
 * dropped rather than returned: it would put money somewhere the user has
 * retired, and asking again is cheap.
 */
export async function cachedAnswers(db: Database): Promise<Map<string, Suggestion>> {
  const rows = await db
    .select({
      payeeKey: aiSuggestionCache.payeeKey,
      envelopeId: aiSuggestionCache.envelopeId,
      confidence: aiSuggestionCache.confidence,
      reason: aiSuggestionCache.reason,
      archivedAt: envelopes.archivedAt,
    })
    .from(aiSuggestionCache)
    .leftJoin(envelopes, eq(envelopes.id, aiSuggestionCache.envelopeId));

  const answers = new Map<string, Suggestion>();
  for (const row of rows) {
    if (!row.envelopeId || row.archivedAt !== null) continue;
    answers.set(row.payeeKey, {
      envelope: row.envelopeId,
      confidence: row.confidence,
      layer: 'ai',
      reason: row.reason,
      alternatives: [],
    });
  }
  return answers;
}

export async function rememberAnswers(
  db: Database,
  answers: Map<string, Suggestion>,
  model: string,
): Promise<number> {
  const rows = [...answers.entries()].filter(([, suggestion]) => suggestion.envelope !== null);
  if (rows.length === 0) return 0;

  for (const [payeeKey, suggestion] of rows) {
    await db
      .insert(aiSuggestionCache)
      .values({
        payeeKey,
        envelopeId: suggestion.envelope,
        confidence: suggestion.confidence,
        reason: suggestion.reason,
        model,
      })
      .onConflictDoUpdate({
        target: aiSuggestionCache.payeeKey,
        set: {
          envelopeId: suggestion.envelope,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
          model,
        },
      });
  }

  return rows.length;
}

/** Forget what the model said, so it is asked again. */
export async function clearAnswerCache(db: Database): Promise<number> {
  const removed = await db.delete(aiSuggestionCache).returning({ key: aiSuggestionCache.payeeKey });
  return removed.length;
}

// ---------------------------------------------------------------------------
// Whether it is any good (section 5's quality measure)
// ---------------------------------------------------------------------------

export type LayerAccuracy = {
  layer: string;
  decided: number;
  acceptedUnchanged: number;
  /** 0 to 1, or null when nothing has been confirmed yet. */
  rate: number | null;
};

export type AccuracyReport = {
  layers: LayerAccuracy[];
  overall: LayerAccuracy;
  /** Of the suggestions in the auto-confirmable band, how many were right. */
  highBandPrecision: number | null;
  highBandDecided: number;
};

/**
 * The share of suggestions accepted without change, per layer.
 *
 * `accepted_envelope_id` is written when a transaction is confirmed, so this
 * compares what was proposed against what was kept - the same measure Phase 0
 * used on held-out months, now running continuously on real confirmations.
 * Only confirmed rows count: a suggestion nobody has looked at is not evidence
 * either way.
 */
export async function accuracy(db: Database, since?: string): Promise<AccuracyReport> {
  const rows = await db
    .select({
      layer: suggestions.layer,
      decided: sql<string>`count(*)`,
      accepted: sql<string>`count(*) filter (where ${suggestions.acceptedEnvelopeId} = ${suggestions.envelopeId})`,
      highDecided: sql<string>`count(*) filter (where ${suggestions.confidence} >= 0.95)`,
      highAccepted: sql<string>`count(*) filter (where ${suggestions.confidence} >= 0.95 and ${suggestions.acceptedEnvelopeId} = ${suggestions.envelopeId})`,
    })
    .from(suggestions)
    .where(
      since
        ? and(
            sql`${suggestions.acceptedEnvelopeId} is not null`,
            gte(suggestions.createdAt, new Date(since)),
          )
        : sql`${suggestions.acceptedEnvelopeId} is not null`,
    )
    .groupBy(suggestions.layer);

  const layers: LayerAccuracy[] = rows.map((row) => ({
    layer: row.layer,
    decided: Number(row.decided),
    acceptedUnchanged: Number(row.accepted),
    rate: Number(row.decided) > 0 ? Number(row.accepted) / Number(row.decided) : null,
  }));

  const decided = layers.reduce((sum, row) => sum + row.decided, 0);
  const accepted = layers.reduce((sum, row) => sum + row.acceptedUnchanged, 0);
  const highDecided = rows.reduce((sum, row) => sum + Number(row.highDecided), 0);
  const highAccepted = rows.reduce((sum, row) => sum + Number(row.highAccepted), 0);

  return {
    layers: layers.sort((left, right) => right.decided - left.decided),
    overall: {
      layer: 'all',
      decided,
      acceptedUnchanged: accepted,
      rate: decided > 0 ? accepted / decided : null,
    },
    highBandPrecision: highDecided > 0 ? highAccepted / highDecided : null,
    highBandDecided: highDecided,
  };
}

/**
 * Merchants the history layer has never seen, which are the ones the model
 * would actually be asked about. Phase 0 measured this at about 9% of
 * transactions, and it is the honest answer to "what would turning this on
 * cost me".
 */
export async function unknownMerchantEstimate(db: Database): Promise<number> {
  const [row] = await db
    .select({
      count: sql<string>`count(distinct t.payee_key)`,
    })
    .from(sql`transactions t`)
    .where(
      sql`t.status = 'pending_review' and not exists (
        select 1 from transactions h
        join txn_lines l on l.transaction_id = h.id
        where h.status = 'confirmed' and h.payee_key = t.payee_key
      ) and not exists (
        select 1 from ai_suggestion_cache c where c.payee_key = t.payee_key
      )`,
    );

  return Number(row?.count ?? 0);
}
