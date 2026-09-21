/**
 * Manilla schema (section 9 of the requirements).
 *
 * Two ledgers that must always agree: accounts hold real money, envelopes hold
 * its assignment. Three decisions carry that invariant into the database rather
 * than leaving it to application code:
 *
 *  1. Money is `bigint` cents. Never a float, never `numeric` read as a float.
 *     `integer` would cap at about $21M, which is close enough to real balances
 *     to be worth avoiding.
 *  2. Dates are `date`, not `timestamptz`. A posting date is a calendar day; the
 *     Phase 0 OFX work showed how easily an instant shifts across a day boundary
 *     and lands a transaction in the wrong budget month.
 *  3. An account's opening balance is an ordinary transaction, not a column, so
 *     that money enters an envelope like any other and the invariant holds with
 *     no special case.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  bigint,
  date,
  timestamp,
  boolean,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Cents. Drizzle returns bigint columns as strings by default; `mode: 'number'` keeps them as safe integers. */
const cents = (name: string) => bigint(name, { mode: 'number' });

export const accountKind = pgEnum('account_kind', [
  'chequing',
  'savings',
  'credit_card',
  'cash',
  'line_of_credit',
]);

export const transactionStatus = pgEnum('transaction_status', ['pending_review', 'confirmed']);

export const transactionKind = pgEnum('transaction_kind', [
  /** Ordinary money in or out. Must have envelope lines summing to its amount. */
  'spending',
  /** Between the user's own accounts (FR-5). Has no envelope lines, and is never spending. */
  'account_transfer',
]);

/**
 * Where a transaction came from.
 *
 * `goodbudget` is a stored value rather than a label: it is written into rows,
 * read back by the migration's own dedupe, and renaming it means a data migration
 * for no user-visible gain. Nothing shows it to anyone - the app names apps only
 * in `src/migrate/sources.ts`.
 */
export const transactionSource = pgEnum('transaction_source', [
  'manual',
  'file_import',
  'bank_sync',
  'goodbudget',
  'opening_balance',
]);

/** Which layer produced a suggestion (CA-9). */
export const suggestionLayer = pgEnum('suggestion_layer', ['rule', 'history', 'ai']);

/** An envelope move is either funding from the unallocated pool, or a shuffle between envelopes. */
export const moveKind = pgEnum('move_kind', ['allocation', 'transfer']);

/** Which WebAuthn ceremony a stored challenge belongs to. */
export const webauthnPurpose = pgEnum('webauthn_purpose', ['registration', 'authentication']);

export const externalIdKind = pgEnum('external_id_kind', [
  /** OFX FITID. */
  'fitid',
  'aggregator',
  'goodbudget',
]);

// ---------------------------------------------------------------------------
// Identity. Single user for now, but keyed by row so multi-user is additive.
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** WebAuthn passkeys (NF-3). A user may register several devices. */
export const credentials = pgTable(
  'credentials',
  {
    id: text('id').primaryKey(), // base64url credential ID from the authenticator
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    publicKey: text('public_key').notNull(),
    /** Signature counter, for cloned-authenticator detection. */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [index('credentials_user_idx').on(table.userId)],
);

/** Single-use recovery codes, stored hashed, for a lost authenticator. */
export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [index('recovery_codes_user_idx').on(table.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

// ---------------------------------------------------------------------------
// Accounts and envelopes
// ---------------------------------------------------------------------------

/**
 * A category of accounts, the same shape as an envelope group.
 *
 * Accounts already carry a `kind`, which is what a statement needs to know, but
 * "Day to day" and "Long term" is how a household actually thinks about them and
 * no fixed list of kinds can express that.
 */
export const accountGroups = pgTable('account_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Nullable, unlike an envelope's group: accounts existed before groups did,
     * and inventing a group for them on migration would put a name nobody chose
     * on the screen. An account with no group is shown last, under "No group",
     * until it is given one.
     */
    groupId: uuid('group_id').references(() => accountGroups.id),
    name: text('name').notNull(),
    kind: accountKind('kind').notNull(),
    currency: text('currency').notNull().default('CAD'),
    /**
     * The account number as the bank's export reports it (OFX ACCTID), used to
     * map a statement to this account on re-import (FR-7).
     */
    externalAccountId: text('external_account_id'),
    position: integer('position').notNull().default(0),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('accounts_external_idx').on(table.externalAccountId),
    index('accounts_group_idx').on(table.groupId),
  ],
);

export const envelopeGroups = pgTable('envelope_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const envelopes = pgTable(
  'envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => envelopeGroups.id),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    /** FR-23: balances carry over month to month by default. */
    carryOver: boolean('carry_over').notNull().default(true),
    /**
     * The unallocated pool that income lands in (FR-28), equivalent to the
     * pool a migrated export names in `src/migrate/sources.ts`. Exactly one
     * envelope carries this flag.
     */
    isUnallocated: boolean('is_unallocated').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    index('envelopes_group_idx').on(table.groupId),
    // Enforces "exactly one unallocated envelope" at the database level.
    uniqueIndex('envelopes_one_unallocated_idx')
      .on(table.isUnallocated)
      .where(sql`${table.isUnallocated}`),
  ],
);

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: transactionSource('source').notNull(),
  filename: text('filename'),
  accountId: uuid('account_id').references(() => accounts.id),
  addedCount: integer('added_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** FR-13: an import can be undone wholesale. */
  revertedAt: timestamp('reverted_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    /** Calendar date as the bank stated it. Never a timestamp. */
    date: date('date').notNull(),
    amountCents: cents('amount_cents').notNull(),
    /** Exactly as the bank wrote it, kept for audit and re-normalization. */
    payeeRaw: text('payee_raw').notNull(),
    /** Normalized merchant key (CA-1); recomputed if normalization improves. */
    payeeKey: text('payee_key').notNull(),
    /** What the bank or the old app wrote alongside the payee. Sent to the model. */
    memo: text('memo'),
    /**
     * The user's own words about the transaction. Apart from `memo` so writing
     * one never overwrites what the bank said, and never sent to the model.
     */
    note: text('note'),
    checkNumber: text('check_number'),
    kind: transactionKind('kind').notNull().default('spending'),
    status: transactionStatus('status').notNull().default('pending_review'),
    source: transactionSource('source').notNull(),
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    /** Links the two halves of an account transfer (FR-5). */
    transferPairId: uuid('transfer_pair_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('transactions_account_date_idx').on(table.accountId, table.date),
    index('transactions_date_idx').on(table.date),
    index('transactions_status_idx').on(table.status),
    index('transactions_payee_key_idx').on(table.payeeKey),
    index('transactions_batch_idx').on(table.importBatchId),
  ],
);

/**
 * Every external identifier a transaction has ever had (FR-10, FR-18, MG-9).
 *
 * Kept as rows rather than a column because one transaction can accumulate
 * several: an id carried over by a migration, then a bank FITID when the same
 * transaction arrives in a statement, then an aggregator id if sync is enabled.
 * Matching on any of them is what stops a re-import creating a duplicate.
 */
export const transactionExternalIds = pgTable(
  'transaction_external_ids',
  {
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    kind: externalIdKind('kind').notNull(),
    value: text('value').notNull(),
    /** Scopes the id, since a FITID is only unique within one account. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.kind, table.value] }),
    index('external_ids_transaction_idx').on(table.transactionId),
  ],
);

/**
 * One envelope's share of a transaction. An unsplit transaction has exactly one
 * line; an account transfer has none.
 */
export const txnLines = pgTable(
  'txn_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    envelopeId: uuid('envelope_id')
      .notNull()
      .references(() => envelopes.id),
    amountCents: cents('amount_cents').notNull(),
  },
  (table) => [
    index('txn_lines_transaction_idx').on(table.transactionId),
    index('txn_lines_envelope_idx').on(table.envelopeId),
  ],
);

/**
 * What the pipeline proposed, kept separate from the confirmed lines so that
 * accuracy stays measurable after the user corrects something (CA-9).
 */
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    envelopeId: uuid('envelope_id').references(() => envelopes.id),
    layer: suggestionLayer('layer').notNull(),
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    /** Set when the user accepted or overrode it, for the accuracy report. */
    acceptedEnvelopeId: uuid('accepted_envelope_id').references(() => envelopes.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('suggestions_transaction_idx').on(table.transactionId)],
);

// ---------------------------------------------------------------------------
// Envelope money movement
// ---------------------------------------------------------------------------

/**
 * Allocation from the unallocated pool, or a transfer between envelopes
 * (FR-29, FR-30, FR-34). Stored as dated records so that changing this month's
 * budget never rewrites last month's history.
 */
export const envelopeMoves = pgTable(
  'envelope_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromEnvelopeId: uuid('from_envelope_id')
      .notNull()
      .references(() => envelopes.id),
    toEnvelopeId: uuid('to_envelope_id')
      .notNull()
      .references(() => envelopes.id),
    amountCents: cents('amount_cents').notNull(),
    date: date('date').notNull(),
    kind: moveKind('kind').notNull(),
    note: text('note'),
    /**
     * Set when the move came from an import rather than a person, so undoing
     * that import takes its envelope moves with it (FR-13, MG-6). A migration
     * brings in years of envelope-to-envelope transfers, and an undo that left
     * them behind would be no undo at all.
     */
    importBatchId: uuid('import_batch_id').references(() => importBatches.id),
    /**
     * Identity for a move that came from a file, so importing that file twice
     * does not move the money twice (MG-1). Null for moves a person made, which
     * are never replayed from anywhere.
     */
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('envelope_moves_date_idx').on(table.date),
    index('envelope_moves_from_idx').on(table.fromEnvelopeId),
    index('envelope_moves_to_idx').on(table.toEnvelopeId),
    index('envelope_moves_batch_idx').on(table.importBatchId),
    uniqueIndex('envelope_moves_external_idx').on(table.externalId),
  ],
);

/**
 * Planned monthly amount per envelope (FR-27, FR-32). A null `month` is the
 * default that applies to every month; a dated row overrides it for that month.
 */
export const budgetLines = pgTable(
  'budget_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    envelopeId: uuid('envelope_id')
      .notNull()
      .references(() => envelopes.id, { onDelete: 'cascade' }),
    /** First day of the month, or null for the standing default. */
    month: date('month'),
    plannedCents: cents('planned_cents').notNull(),
  },
  (table) => [uniqueIndex('budget_lines_envelope_month_idx').on(table.envelopeId, table.month)],
);

/**
 * A WebAuthn ceremony in flight (NF-3).
 *
 * The challenge lives server-side and is deleted the moment it is used, which is
 * what makes a passkey assertion single-use. Keeping it in a cookie instead
 * would hand the value that proves freshness to the party being authenticated.
 */
export const webauthnChallenges = pgTable(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    challenge: text('challenge').notNull(),
    purpose: webauthnPurpose('purpose').notNull(),
    /** Set when the ceremony belongs to a known user, i.e. adding a device. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('webauthn_challenges_expires_idx').on(table.expiresAt)],
);

/**
 * What the model answered for a merchant, kept so the same merchant is never
 * asked about twice (section 5's cost controls).
 *
 * Keyed by the normalized payee, because that is the thing the answer is really
 * about: "SHELL #4471 CALGARY" and "SHELL 2280" are one merchant and deserve one
 * call between them. Clearing a row simply means the next transaction from that
 * merchant is asked about again.
 */
export const aiSuggestionCache = pgTable(
  'ai_suggestion_cache',
  {
    payeeKey: text('payee_key').primaryKey(),
    envelopeId: uuid('envelope_id').references(() => envelopes.id, { onDelete: 'cascade' }),
    confidence: real('confidence').notNull(),
    reason: text('reason').notNull(),
    /** The model that answered, so a cache from an older one can be told apart. */
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_cache_envelope_idx').on(table.envelopeId)],
);

/**
 * One row per call to the model (NF-5, NF-11).
 *
 * Kept per call rather than as a monthly counter so the budget, the cost and the
 * "what did it actually do" question all read from the same record, and a month
 * that looks expensive can be explained rather than just totalled.
 */
export const aiCalls = pgTable(
  'ai_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** First day of the month, for the monthly budget. */
    month: date('month').notNull(),
    model: text('model').notNull(),
    transactions: integer('transactions').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cachedInputTokens: integer('cached_input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Tenths of a cent, since one call costs well under a cent. */
    costMilliCents: integer('cost_milli_cents').notNull(),
    /** Set when the call failed, so degradation is visible rather than silent. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ai_calls_month_idx').on(table.month)],
);

/**
 * Single-row-per-key settings, for the handful of values that are the user's
 * choice rather than data: expected monthly income (FR-27), and the AI off
 * switch and call budget (NF-5).
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * User rules (CA-2), normally created in one click from a correction.
 *
 * A rule answers one of two questions about a payee, and never both:
 *
 *  - which envelope its spending belongs in (`envelope_id`), or
 *  - that it is not spending at all, but a transfer to another of your own
 *    accounts (`transfer_account_id`) - the monthly "Tfr-to C C" that pays the
 *    credit card off the chequing account (FR-5).
 *
 * The check constraint is what keeps that honest: a rule with both would be a
 * rule with no meaning, and one with neither would silently match and do
 * nothing.
 */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Matched against the normalized payee key. */
    contains: text('contains').notNull(),
    envelopeId: uuid('envelope_id').references(() => envelopes.id, { onDelete: 'cascade' }),
    /** Set instead of an envelope when the payee means a transfer (FR-5). */
    transferAccountId: uuid('transfer_account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    minCents: cents('min_cents'),
    maxCents: cents('max_cents'),
    accountId: uuid('account_id').references(() => accounts.id),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rules_position_idx').on(table.position),
    check(
      'rules_one_outcome',
      sql`(${table.envelopeId} is null) <> (${table.transferAccountId} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/**
 * One name per table for the shape a select returns.
 *
 * Kept complete rather than trimmed to what is imported today: the value is in
 * being able to reach for `TxnLine` without first going and writing the line
 * that declares it, and an incomplete list of these is worse than none.
 *
 * Drizzle's `relations()` declarations used to sit here too. They were never
 * referenced - nothing in Manilla uses the `db.query` builder's `with:`, every
 * read is the select builder - and a reader who saw them would reasonably go
 * looking for the joins they imply.
 */
export type Account = typeof accounts.$inferSelect;
export type AccountGroup = typeof accountGroups.$inferSelect;
export type Envelope = typeof envelopes.$inferSelect;
export type EnvelopeGroup = typeof envelopeGroups.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TxnLine = typeof txnLines.$inferSelect;
export type EnvelopeMove = typeof envelopeMoves.$inferSelect;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type Credential = typeof credentials.$inferSelect;
export type User = typeof users.$inferSelect;
