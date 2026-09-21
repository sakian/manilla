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
  outcome:
    | { kind: 'envelope'; name: string; envelopeId: string }
    | { kind: 'transfer'; name: string; accountId: string };
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
      envelopeId: rules.envelopeId,
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
          accountId: row.transferAccountId,
        }
      : {
          kind: 'envelope' as const,
          name: row.envelopeName ?? 'an envelope',
          envelopeId: row.envelopeId!,
        },
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

export type RuleEdit = {
  contains: string;
  /** The envelope for an envelope rule, the account for a transfer rule. */
  targetId: string;
  minCents: number | null;
  maxCents: number | null;
};

/**
 * Change what a rule matches and where it sends it.
 *
 * A rule keeps its kind. Turning "this is spending in Gas" into "this is a
 * transfer to Visa" is a different statement about the money, and deleting one
 * and making the other says so more plainly than an edit that flips it.
 *
 * Nothing already recorded changes: rules are consulted when a transaction
 * arrives, and an edit is a new instruction, not a correction of history.
 */
export async function updateRule(db: Database, ruleId: string, edit: RuleEdit): Promise<void> {
  const [rule] = await db
    .select({ envelopeId: rules.envelopeId, transferAccountId: rules.transferAccountId })
    .from(rules)
    .where(eq(rules.id, ruleId))
    .limit(1);
  if (!rule) throw new RuleError('That rule no longer exists.');

  const contains = edit.contains.trim().toUpperCase();
  if (contains.length < 3) {
    throw new RuleError(
      'A rule needs at least three characters to match on, or it will catch things it should not.',
    );
  }

  for (const [label, value] of [
    ['smallest', edit.minCents],
    ['largest', edit.maxCents],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RuleError(`The ${label} amount has to be zero or more.`);
    }
  }
  if (edit.minCents !== null && edit.maxCents !== null && edit.minCents > edit.maxCents) {
    throw new RuleError('The smallest amount is larger than the largest, so nothing would match.');
  }

  if (rule.envelopeId !== null) {
    const [envelope] = await db
      .select({ archivedAt: envelopes.archivedAt })
      .from(envelopes)
      .where(eq(envelopes.id, edit.targetId))
      .limit(1);
    if (!envelope) throw new RuleError('No such envelope.');
    if (envelope.archivedAt !== null) {
      throw new RuleError('That envelope is archived, so nothing should be sent to it.');
    }
  } else {
    const [account] = await db
      .select({ archivedAt: accounts.archivedAt })
      .from(accounts)
      .where(eq(accounts.id, edit.targetId))
      .limit(1);
    if (!account) throw new RuleError('No such account.');
    if (account.archivedAt !== null) {
      throw new RuleError('That account is archived, so nothing should be transferred to it.');
    }
  }

  await db
    .update(rules)
    .set({
      contains,
      ...(rule.envelopeId !== null
        ? { envelopeId: edit.targetId }
        : { transferAccountId: edit.targetId }),
      minCents: edit.minCents,
      maxCents: edit.maxCents,
    })
    .where(eq(rules.id, ruleId));
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

/**
 * Below this a habit is a coincidence. It was five, which proved too eager: a
 * rule outranks history for good, so it wants a payee sorted one way for most of
 * a year of monthly bills, not a few weeks of coffee.
 */
export const RULE_SUGGESTION_MINIMUM = 10;

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

/**
 * Take back a "no", so the payee can be suggested again when it qualifies.
 * Declining sticks on purpose, which is also why there has to be a way to
 * change your mind.
 */
export async function undismissRuleSuggestion(db: Database, contains: string): Promise<void> {
  const already = await dismissedRuleSuggestions(db);
  if (!already.includes(contains)) return;

  const value = JSON.stringify(already.filter((item) => item !== contains));
  await db
    .update(appSettings)
    .set({ value, updatedAt: new Date() })
    .where(eq(appSettings.key, DISMISSED_KEY));
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
  const limit = options.limit ?? 20;
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
    -- The payee breaks ties. Counts tie all the time, and without it the order
    -- among them was whatever the plan produced - which changes when a rule is
    -- added, so answering one suggestion reshuffled the rest.
    order by count(*) desc, t.payee_key
    -- Room for the declined ones, which are dropped below rather than here.
    limit ${limit + dismissed.size}
  `);

  return rows
    .filter((row) => !dismissed.has(row.payee_key))
    .slice(0, limit)
    .map((row) => ({
      contains: row.payee_key,
      display: normalizePayee(row.display).display,
      envelopeId: row.envelope_id,
      envelopeName: row.envelope_name,
      uses: Number(row.uses),
    }));
}

const SUGGESTION_COUNT_KEY = 'rule_suggestion_count';

/** Where the stored count stops counting; past it, the screen says "100+". */
export const SUGGESTION_COUNT_CAP = 100;

/**
 * How many rules are worth suggesting, cached.
 *
 * `suggestedRules` scans every confirmed line and anti-joins the rules table on
 * an unindexable `LIKE`, which is fine on the settings page and much too much on
 * every screen - and the notice that says "3 rules Manilla could write" belongs
 * on every screen or nowhere, because nobody visits settings to find out.
 *
 * So the count is written whenever it can change: a review saved, a suggestion
 * accepted, a suggestion declined. Reading it is one indexed row. A count that
 * drifts shows a notice leading to a page that says something slightly different,
 * which is the cheapest kind of wrong to be.
 */
export async function ruleSuggestionCount(db: Database): Promise<number> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, SUGGESTION_COUNT_KEY))
    .limit(1);

  const count = Number(row?.value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/** Recount and store it. Called from wherever the answer could have changed. */
export async function refreshRuleSuggestionCount(db: Database): Promise<number> {
  return (await suggestAndCount(db)).total;
}

/**
 * The suggestions to show, and how many there are in all - storing that count
 * as it goes.
 *
 * The settings page runs the search anyway, so it saves what it found. Relying
 * on the actions alone left the count stale whenever the answer changed without
 * one: raising the threshold kept "24 rules Manilla could write" on every screen
 * while the page it led to had nothing to show, and nothing on that page to
 * press that would recount.
 */
export async function suggestAndCount(
  db: Database,
  options: { limit?: number } = {},
): Promise<{ suggestions: SuggestedRule[]; total: number }> {
  const found = await suggestedRules(db, { limit: SUGGESTION_COUNT_CAP });
  const value = String(found.length);

  await db
    .insert(appSettings)
    .values({ key: SUGGESTION_COUNT_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });

  return { suggestions: found.slice(0, options.limit ?? 20), total: found.length };
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
