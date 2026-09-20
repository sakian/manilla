/**
 * Builds the categorization pipeline from what is in the database.
 *
 * The history index is built from confirmed transactions only. A pending
 * suggestion is not evidence - treating it as such would let one bad guess
 * reinforce itself on the next import.
 */

import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { envelopes, rules as rulesTable, transactions, txnLines } from '../../db/schema.ts';
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
};

/**
 * Assemble the pipeline. The AI layer is included only when a key is present
 * and the caller asks for it, so imports still work with AI switched off (NF-10).
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
  let ai: AiCategorizer | undefined;

  if (options.useAi && keyPresent) {
    // The model chooses among envelope ids, but sees readable names, so the
    // prompt maps one to the other.
    const ids = [...names.keys()];
    const examples: Record<string, string[]> = {};
    ai = new AiCategorizer(ids, examples);
  }

  return {
    categorizer: new Categorizer(rules, history, ai),
    history,
    names,
    ai,
  };
}
