/**
 * Builds the categorization pipeline from what is in the database.
 *
 * The history index is built from confirmed transactions only. A pending
 * suggestion is not evidence - treating it as such would let one bad guess
 * reinforce itself on the next import.
 */

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { envelopes, rules as rulesTable, transactions, txnLines } from '../../db/schema.ts';
import { aiSettings, aiUsage, cachedAnswers, recordAiCall } from '../ai/ai.ts';
import { HistoryIndex } from './history.ts';
import { Categorizer, type Rule } from './pipeline.ts';
import { AiCategorizer } from './ai.ts';
import type { LabeledTransaction } from './types.ts';

export type EnvelopeNames = Map<string, string>;

/** Confirmed, envelope-bearing transactions, as training data for the history layer. */
export async function loadHistory(db: Database): Promise<LabeledTransaction[]> {
  const rows = await db
    .select({
      date: transactions.date,
      payeeRaw: transactions.payeeRaw,
      amountCents: txnLines.amountCents,
      envelopeId: txnLines.envelopeId,
      account: transactions.accountId,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(txnLines.transactionId, transactions.id))
    .where(
      and(eq(transactions.status, 'confirmed'), eq(transactions.kind, 'spending')),
    );

  return rows.map((row) => ({
    date: row.date,
    payeeRaw: row.payeeRaw,
    amountCents: Number(row.amountCents),
    // The pipeline is keyed on envelope identity, so the id is the label.
    envelope: row.envelopeId,
    account: row.account,
  }));
}

/**
 * The rules that name an envelope. A rule can instead say a payee is a transfer
 * between the user's own accounts, which is not a categorization at all and is
 * applied by the import pipeline (FR-5).
 */
export async function loadRules(db: Database): Promise<Rule[]> {
  const rows = await db
    .select()
    .from(rulesTable)
    .where(isNotNull(rulesTable.envelopeId))
    .orderBy(rulesTable.position);

  return rows.map((row) => ({
    id: row.id,
    contains: row.contains,
    envelope: row.envelopeId!,
    ...(row.minCents !== null ? { minCents: Number(row.minCents) } : {}),
    ...(row.maxCents !== null ? { maxCents: Number(row.maxCents) } : {}),
    ...(row.accountId !== null ? { account: row.accountId } : {}),
  }));
}

/** Envelope id -> display name, for prompting the model and showing reasons. */
export async function loadEnvelopeNames(db: Database): Promise<EnvelopeNames> {
  const rows = await db
    .select({ id: envelopes.id, name: envelopes.name })
    .from(envelopes)
    .where(isNotNull(envelopes.id));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export type BuiltCategorizer = {
  categorizer: Categorizer;
  history: HistoryIndex;
  names: EnvelopeNames;
  ai: AiCategorizer | undefined;
  /** Why the AI layer is not in use, when it is not. */
  aiOff: string | null;
};

/**
 * The merchants each envelope is actually used for, as examples for the model
 * (CA-5, MG-8).
 *
 * Migrated history seeds this the moment it lands, which is the point: the model
 * is much better at "which of these envelopes does a new hardware shop belong
 * in" when it can see that Home Upkeep already contains Home Depot and Rona.
 * Most-used first, a handful each, because the prompt is cached and paid for
 * once but read on every call.
 */
export async function loadExamples(
  db: Database,
  perEnvelope = 8,
): Promise<Record<string, string[]>> {
  const rows = await db
    .select({
      envelopeId: txnLines.envelopeId,
      payeeKey: transactions.payeeKey,
      uses: sql<string>`count(*)`,
    })
    .from(txnLines)
    .innerJoin(transactions, eq(transactions.id, txnLines.transactionId))
    .where(and(eq(transactions.status, 'confirmed'), eq(transactions.kind, 'spending')))
    .groupBy(txnLines.envelopeId, transactions.payeeKey)
    .orderBy(desc(sql`count(*)`))
    .limit(5000);

  const examples: Record<string, string[]> = {};
  for (const row of rows) {
    const list = examples[row.envelopeId] ?? [];
    if (list.length >= perEnvelope) continue;
    if (!row.payeeKey || row.payeeKey.length < 2) continue;
    list.push(row.payeeKey);
    examples[row.envelopeId] = list;
  }
  return examples;
}

/**
 * Assemble the pipeline. The AI layer is included only when it is switched on,
 * a key is present and the monthly budget has room, so imports work unchanged
 * with it off (NF-10).
 */
export async function buildCategorizer(
  db: Database,
  options: { useAi?: boolean } = {},
): Promise<BuiltCategorizer> {
  const [history, rules, names] = await Promise.all([
    loadHistory(db).then((rows) => new HistoryIndex(rows)),
    loadRules(db),
    loadEnvelopeNames(db),
  ]);

  const keyPresent = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  const settings = await aiSettings(db);
  const wanted = options.useAi ?? settings.enabled;

  let ai: AiCategorizer | undefined;
  let aiOff: string | null = null;

  if (!wanted) {
    aiOff = 'The AI layer is switched off.';
  } else if (!keyPresent) {
    aiOff = 'No ANTHROPIC_API_KEY is set, so the AI layer cannot be used.';
  } else {
    const usage = await aiUsage(db);
    if (usage.remaining <= 0) {
      aiOff = `The monthly budget of ${usage.budget} calls is used up.`;
    } else {
      const [examples, answered] = await Promise.all([loadExamples(db), cachedAnswers(db)]);

      // Live envelopes only: the model should never propose one that has been
      // retired, and CA-8 says it may only choose from envelopes that exist.
      const live = await db
        .select({ id: envelopes.id, name: envelopes.name })
        .from(envelopes)
        .where(isNull(envelopes.archivedAt));

      ai = new AiCategorizer(live, examples, {
        onCall: (record) => recordAiCall(db, record),
        canCall: async () => (await aiUsage(db)).remaining > 0,
      });
      ai.seed(answered);
    }
  }

  return {
    categorizer: new Categorizer(rules, history, ai),
    history,
    names,
    ai,
    aiOff,
  };
}
