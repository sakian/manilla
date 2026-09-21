/**
 * Standing rules (CA-2), of both kinds.
 *
 * A rule is the cheapest layer in the categorization pipeline and the only one
 * the user writes by hand, usually by correcting something once and saying
 * "always". There are two things it can say:
 *
 *  - this payee's spending belongs in that envelope, or
 *  - this payee is not spending at all: it is money moving to another of your
 *    own accounts (FR-5).
 *
 * The second kind exists because the first cannot express it. "Tfr-to C C" on
 * the chequing statement is the monthly credit-card payment, and no envelope is
 * the right answer for it - the spending already happened when the card was
 * used. Before transfer rules it had to be marked by hand every month.
 *
 * Matching is on the *normalized* payee key, so a rule written once from
 * "Tfr-to C C" keeps matching when the bank appends a reference number.
 */

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, appSettings, envelopes, rules } from '../../db/schema.ts';
import { normalizePayee } from '../categorize/normalize.ts';

export class RuleError extends Error {}

export type TransferRule = {
  id: string;
  contains: string;
  transferAccountId: string;
  minCents: number | null;
  maxCents: number | null;
  /** When set, the rule only applies to rows imported into that account. */
  accountId: string | null;
};

/** Every rule, both kinds, with the names they point at, for the settings list. */
export type ListedRule = {
  id: string;
  contains: string;
  outcome: { kind: 'envelope'; name: string } | { kind: 'transfer'; name: string };
  minCents: number | null;
  maxCents: number | null;
  onlyAccountName: string | null;
  createdAt: Date;
};

export async function listRules(db: Database): Promise<ListedRule[]> {
  const rows = await db
    .select({
      id: rules.id,
      contains: rules.contains,
      envelopeName: envelopes.name,
      minCents: rules.minCents,
      maxCents: rules.maxCents,
      createdAt: rules.createdAt,
      transferAccountId: rules.transferAccountId,
      accountId: rules.accountId,
    })
    .from(rules)
    .leftJoin(envelopes, eq(envelopes.id, rules.envelopeId))
    .orderBy(asc(rules.position), desc(rules.createdAt));

  // The account columns are two different joins onto the same table, so they are
  // resolved separately rather than with a third alias for one label each.
  const accountRows = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
  const accountNames = new Map(accountRows.map((row) => [row.id, row.name]));

  return rows.map((row) => ({
    id: row.id,
    contains: row.contains,
    outcome: row.transferAccountId
      ? {
          kind: 'transfer' as const,
          name: accountNames.get(row.transferAccountId) ?? 'another account',
        }
      : { kind: 'envelope' as const, name: row.envelopeName ?? 'an envelope' },
    minCents: row.minCents === null ? null : Number(row.minCents),
    maxCents: row.maxCents === null ? null : Number(row.maxCents),
    onlyAccountName: row.accountId ? (accountNames.get(row.accountId) ?? null) : null,
    createdAt: row.createdAt,
  }));
}

/** Only the transfer rules, for the import pipeline. */
export async function listTransferRules(db: Database): Promise<TransferRule[]> {
  const rows = await db
    .select({
      id: rules.id,
      contains: rules.contains,
      transferAccountId: rules.transferAccountId,
      minCents: rules.minCents,
      maxCents: rules.maxCents,
      accountId: rules.accountId,
    })
    .from(rules)
    .where(isNotNull(rules.transferAccountId))
    .orderBy(asc(rules.position));

  return rows.map((row) => ({
    id: row.id,
    contains: row.contains,
    transferAccountId: row.transferAccountId!,
    minCents: row.minCents === null ? null : Number(row.minCents),
    maxCents: row.maxCents === null ? null : Number(row.maxCents),
    accountId: row.accountId,
  }));
}

/**
 * The first transfer rule that applies, or nothing.
 *
 * Deliberately the same shape of test as the envelope rules use: a substring of
 * the normalized payee key, optionally narrowed by amount range and by the
 * account the row is being imported into.
 */
export function matchTransferRule(
  transferRules: TransferRule[],
  row: { payeeRaw: string; amountCents: number; accountId: string },
): TransferRule | undefined {
  const { key } = normalizePayee(row.payeeRaw);

  return transferRules.find((rule) => {
    if (!key.includes(rule.contains.toUpperCase())) return false;
    if (rule.accountId !== null && rule.accountId !== row.accountId) return false;

    const amount = Math.abs(row.amountCents);
    if (rule.minCents !== null && amount < rule.minCents) return false;
    if (rule.maxCents !== null && amount > rule.maxCents) return false;

    // A rule that points at the account the row is already in would ask for a
    // transfer from an account to itself.
    return rule.transferAccountId !== row.accountId;
  });
}

export type NewTransferRule = {
  /** Taken from the payee that prompted it, normalized. */
  contains: string;
  transferAccountId: string;
  /** Narrow the rule to rows imported into one account. */
  accountId?: string;
  minCents?: number;
  maxCents?: number;
};

export async function createTransferRule(
  db: Database,
  input: NewTransferRule,
): Promise<string> {
  const contains = input.contains.trim().toUpperCase();
  if (contains.length < 3) {
    throw new RuleError(
      'A rule needs at least three characters to match on, or it will catch things it should not.',
    );
  }

  const [account] = await db
    .select({ id: accounts.id, archivedAt: accounts.archivedAt })
    .from(accounts)
    .where(eq(accounts.id, input.transferAccountId))
    .limit(1);
  if (!account) throw new RuleError(`No such account: ${input.transferAccountId}`);
  if (account.archivedAt !== null) {
    throw new RuleError('That account is archived, so nothing should be transferred to it.');
  }

  // A second rule for the same payee and destination would fire twice and mean
  // the same thing once.
  const existing = await db
    .select({ id: rules.id })
    .from(rules)
    .where(
      and(
        eq(rules.contains, contains),
        eq(rules.transferAccountId, input.transferAccountId),
        input.accountId ? eq(rules.accountId, input.accountId) : isNull(rules.accountId),
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const [last] = await db
    .select({ position: rules.position })
    .from(rules)
    .orderBy(desc(rules.position))
    .limit(1);

  const [created] = await db
    .insert(rules)
    .values({
      contains,
      transferAccountId: input.transferAccountId,
      position: (last?.position ?? -1) + 1,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.minCents !== undefined ? { minCents: input.minCents } : {}),
      ...(input.maxCents !== undefined ? { maxCents: input.maxCents } : {}),
    })
    .returning({ id: rules.id });

  return created!.id;
}

export async function deleteRule(db: Database, ruleId: string): Promise<void> {
  await db.delete(rules).where(eq(rules.id, ruleId));
}

/** How many rules there are, for the settings summary. */
export async function countRules(db: Database): Promise<{ envelope: number; transfer: number }> {
  const [row] = await db
    .select({
      envelope: sql<string>`count(*) filter (where ${rules.envelopeId} is not null)`,
      transfer: sql<string>`count(*) filter (where ${rules.transferAccountId} is not null)`,
    })
    .from(rules);

  return { envelope: Number(row?.envelope ?? 0), transfer: Number(row?.transfer ?? 0) };
}

// ---------------------------------------------------------------------------
// Rules the history could write for you (CA-2)
// ---------------------------------------------------------------------------

/**
 * A rule is never written on your behalf.
 *
 * The app does learn - the history layer reads what you confirmed last time and
 * suggests from it, which is why a merchant you have sorted twenty times arrives
 * pre-filled. That learning needs no rules, and writing them silently would be
 * worse than useless: a rule fires before history looks at anything, so a wrong
 * one keeps being wrong where history would have drifted towards the truth.
 *
 * What is worth doing is noticing when one would help and asking. A payee sorted
 * the same way often enough, never sorted anywhere else, with no rule already -
 * that is a standing instruction you have been giving by hand.
 */
export type SuggestedRule = {
  /** The normalized payee the rule would match. */
  contains: string;
  /** How it reads on a statement, for saying it out loud. */
  display: string;
  envelopeId: string;
  envelopeName: string;
  /** How many confirmed transactions back it up. */
  uses: number;
};

/** Below this a habit is a coincidence; a rule wants more than a couple of goes. */
export const RULE_SUGGESTION_MINIMUM = 5;

const DISMISSED_KEY = 'dismissed_rule_suggestions';

/**
 * Payees you have said no about.
 *
 * Kept so a declined suggestion stays declined. A merchant you deliberately sort
 * two ways - a shop you buy both groceries and birthday presents at - will go on
 * looking like a rule for ever, and being asked about it every month is worse
 * than not being asked at all.
 */
export async function dismissedRuleSuggestions(db: Database): Promise<string[]> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, DISMISSED_KEY))
    .limit(1);

  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    // A setting nobody can read is a setting that has nothing to say.
    return [];
  }
}

export async function dismissRuleSuggestion(db: Database, contains: string): Promise<void> {
  const already = await dismissedRuleSuggestions(db);
  if (already.includes(contains)) return;

  const value = JSON.stringify([...already, contains]);
  await db
    .insert(appSettings)
    .values({ key: DISMISSED_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function suggestedRules(
  db: Database,
  options: { minimum?: number; limit?: number } = {},
): Promise<SuggestedRule[]> {
  const minimum = options.minimum ?? RULE_SUGGESTION_MINIMUM;
  const dismissed = new Set(await dismissedRuleSuggestions(db));

  // Raw rather than built up in Drizzle: this groups by a normalized key, counts
  // distinct envelopes per payee and only keeps the payees with exactly one, and
  // spelling that out is clearer than assembling it from fragments.
  const rows = await db.execute<{
    payee_key: string;
    display: string;
    envelope_id: string;
    envelope_name: string;
    uses: string;
  }>(sql`
    select
      t.payee_key,
      min(t.payee_raw) as display,
      min(l.envelope_id::text) as envelope_id,
      min(e.name) as envelope_name,
      count(*) as uses
    from transactions t
    join txn_lines l on l.transaction_id = t.id
    join envelopes e on e.id = l.envelope_id
    where t.status = 'confirmed'
      and t.kind = 'spending'
      and t.source <> 'opening_balance'
      and e.archived_at is null
      and t.payee_key <> ''
      -- A payee an existing rule already covers has nothing to suggest.
      and not exists (
        select 1 from rules r
        where r.envelope_id is not null and t.payee_key like '%' || r.contains || '%'
      )
    group by t.payee_key
    having count(distinct l.envelope_id) = 1 and count(*) >= ${minimum}
    order by count(*) desc
    limit ${options.limit ?? 20}
  `);

  return rows
    .filter((row) => !dismissed.has(row.payee_key))
    .map((row) => ({
      contains: row.payee_key,
      display: normalizePayee(row.display).display,
      envelopeId: row.envelope_id,
      envelopeName: row.envelope_name,
      uses: Number(row.uses),
    }));
}

/** Accept one suggestion, which is the only way a rule gets written (CA-2). */
export async function createEnvelopeRule(
  db: Database,
  input: { contains: string; envelopeId: string },
): Promise<void> {
  const contains = input.contains.trim().toUpperCase();
  if (contains.length === 0) throw new RuleError('A rule needs something to match on');

  await db
    .insert(rules)
    .values({ contains, envelopeId: input.envelopeId })
    .onConflictDoNothing();
}
