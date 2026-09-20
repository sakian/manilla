/**
 * Bringing a history in from another envelope budgeting app (MG-1 to MG-9).
 *
 * Phase 0's loader reads the same export into training data for the categorizer;
 * this reads it into *transactions*, which is a different shape and a stricter
 * job. It reuses that loader's parsing primitives, because the rules they encode
 * were learned from a real 7,957-row file and getting any of them wrong corrupts
 * six years of history silently.
 *
 * What the real export turned out to contain, and what each fact means here:
 *
 *  - Dates are D/M/Y, decided once per file from rows that can only be read one
 *    way. Never per row.
 *  - Splits live in `Details` as `Envelope|Amount` pairs separated by `||`, on a
 *    parent row whose own `Envelope` is blank. No row carries both.
 *  - Income is a split into `[Available]`, which is FR-28's pool.
 *  - 284 "Envelope Transfer" rows are envelope-to-envelope moves, exported as
 *    matched pairs. All 284 pair by date and magnitude.
 *  - 312 rows carry neither an envelope nor a split. 310 of them pair the same
 *    way and are transfers between the user's own accounts (FR-5). The two that
 *    do not pair are zero-amount rows, and they are reported rather than guessed
 *    at (MG-4).
 *  - "Fill Envelopes" rows carry no amount and no per-envelope breakdown, so
 *    historical allocations cannot be recovered at all. Past *spending* rebuilds
 *    exactly; past envelope *balances* do not, and the reconciliation step
 *    exists to close that gap honestly rather than to hide it (MG-7).
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  accounts,
  envelopeGroups,
  envelopeMoves,
  envelopes,
  importBatches,
  transactionExternalIds,
  transactions,
  txnLines,
} from '../../db/schema.ts';
import { parseCsv, detectDelimiter, toRecords } from '../csv.ts';
import {
  detectColumns,
  detectDateFormat,
  parseDetails,
  parseExportDate,
  type ColumnMapping,
  type DateFormat,
} from '../goodbudget/load.ts';
import { parseAmount } from '../money.ts';
import { DEFAULT_SOURCE, migrationSource, type MigrationSourceId } from './sources.ts';
import { normalizePayee } from '../categorize/normalize.ts';

export class MigrationError extends Error {}

/** What a migrated envelope move says in the envelope's own history. */
export const MIGRATED_NOTE = 'Migrated from your previous budgeting app';

/** What the reconciliation adjustment says, for the same reason. */
export const CARRIED_OVER_NOTE = 'Opening balance carried over from your previous budgeting app';

/** The export's marker for "no account", which is not an account name. */
const NO_ACCOUNT = '[none]';
const FILL_PAYEE = 'fill envelopes';
const ENVELOPE_TRANSFER_PAYEE = 'envelope transfer';

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

export type PlannedLine = { envelope: string; amountCents: number };

export type PlannedTransaction = {
  /** Source row, for the report. */
  row: number;
  date: string;
  payeeRaw: string;
  memo?: string;
  account?: string;
  amountCents: number;
  lines: PlannedLine[];
  /** Stable identity for deduplicating across files and re-runs (MG-1). */
  externalId: string;
};

export type PlannedMove = {
  row: number;
  date: string;
  fromEnvelope: string;
  toEnvelope: string;
  amountCents: number;
  externalId: string;
};

export type PlannedTransfer = {
  row: number;
  date: string;
  fromAccount: string;
  toAccount: string;
  amountCents: number;
  payeeRaw: string;
  externalId: string;
};

export type Unrepresentable = { row: number; reason: string };

export type MigrationPlan = {
  mapping: ColumnMapping;
  dateFormat: DateFormat;
  dateEvidence: string;
  dateRange: { from: string; to: string } | null;
  /** Every envelope named anywhere in the file, with how often it is used. */
  envelopes: { name: string; group: string | null; uses: number }[];
  accounts: { name: string; uses: number }[];
  transactions: PlannedTransaction[];
  moves: PlannedMove[];
  transfers: PlannedTransfer[];
  counts: {
    spending: number;
    income: number;
    split: number;
    envelopeTransfer: number;
    accountTransfer: number;
    fill: number;
  };
  /** MG-4: what the export cannot represent, listed rather than guessed. */
  unrepresentable: Unrepresentable[];
  /** True when some rows name no account, so one has to be nominated for them. */
  needsDefaultAccount: boolean;
  warnings: string[];
  /** Which app the files were read as, so the commit reads them the same way. */
  from: MigrationSourceId;
};

/**
 * A row's identity, for recognising it again on a second run or in an
 * overlapping file (MG-1).
 *
 * These exports carry no identifier, so one is derived from the content that
 * makes a row what it is. Genuinely identical rows - the same amount at the same
 * payee on the same day, which the real history does contain - are distinguished
 * by their occurrence number, so a file holding four of them keeps all four while
 * importing that file twice adds nothing.
 */
function identityOf(parts: string[], seen: Map<string, number>): string {
  const base = createHash('sha256').update(parts.join('\u0000')).digest('base64url').slice(0, 22);
  const occurrence = (seen.get(base) ?? 0) + 1;
  seen.set(base, occurrence);
  return occurrence === 1 ? base : `${base}#${occurrence}`;
}

/**
 * Read one or more export files into a plan. Writes nothing.
 *
 * `from` says which app the files came from, which decides the format-specific
 * facts in `sources.ts` - today only what that app calls its unallocated pool.
 * Rows are read in the shape that one format uses; a second app would bring its
 * own reader feeding this same plan.
 */
export function planMigration(
  sources: string[],
  options: { from?: MigrationSourceId } = {},
): MigrationPlan {
  const from = options.from ?? DEFAULT_SOURCE;
  const AVAILABLE = migrationSource(from).poolEnvelope;
  const warnings: string[] = [];
  const unrepresentable: Unrepresentable[] = [];
  const transactions: PlannedTransaction[] = [];
  const counts = {
    spending: 0,
    income: 0,
    split: 0,
    envelopeTransfer: 0,
    accountTransfer: 0,
    fill: 0,
  };

  const envelopeUses = new Map<string, number>();
  const accountUses = new Map<string, number>();
  const seen = new Map<string, number>();
  const dates: string[] = [];

  // Pairing candidates, gathered across every file and matched at the end.
  const envelopeTransferRows: {
    row: number;
    date: string;
    envelope: string;
    amountCents: number;
  }[] = [];
  const accountTransferRows: {
    row: number;
    date: string;
    account: string;
    amountCents: number;
    payeeRaw: string;
  }[] = [];

  let mapping: ColumnMapping = {};
  let dateFormat: DateFormat = 'ambiguous';
  let dateEvidence = 'not determined';
  let rowOffset = 0;

  for (const [fileIndex, source] of sources.entries()) {
    const table = parseCsv(source, detectDelimiter(source));
    const fileMapping = detectColumns(table.headers);
    const records = toRecords(table);

    const missing = (['date', 'payee', 'amount'] as const).filter((field) => !fileMapping[field]);
    if (missing.length > 0) {
      throw new MigrationError(
        `File ${fileIndex + 1} has no column for ${missing.join(', ')}. ` +
          `Headers seen: ${table.headers.join(', ') || '(none)'}`,
      );
    }

    const detected = detectDateFormat(records.map((record) => record[fileMapping.date!] ?? ''));
    if (detected.format === 'ambiguous') {
      warnings.push(
        `File ${fileIndex + 1}: the date format could not be settled (${detected.evidence}). ` +
          'Every row could be read either way, so nothing here should be committed until a file ' +
          'with an unambiguous date arrives.',
      );
    }

    if (fileIndex === 0) {
      mapping = fileMapping;
      dateFormat = detected.format;
      dateEvidence = detected.evidence;
    } else if (detected.format !== dateFormat && detected.format !== 'ambiguous') {
      warnings.push(
        `File ${fileIndex + 1} reads as ${detected.format} while the first reads as ${dateFormat}. ` +
          'Each file is parsed with its own format.',
      );
    }

    const field = (record: Record<string, string>, name: keyof ColumnMapping): string =>
      (fileMapping[name] ? (record[fileMapping[name]!] ?? '') : '').trim();

    records.forEach((record, index) => {
      const row = rowOffset + index + 2; // 1-based, plus the header
      const date = parseExportDate(field(record, 'date'), detected.format);
      if (!date) {
        unrepresentable.push({
          row,
          reason: `Unreadable date "${field(record, 'date')}"`,
        });
        return;
      }
      dates.push(date);

      const payeeRaw = field(record, 'payee');
      const envelope = field(record, 'envelope');
      const details = field(record, 'details');
      const rawAccount = field(record, 'account');
      const account = rawAccount === NO_ACCOUNT ? '' : rawAccount;
      const memo = field(record, 'notes');

      const rawAmount = field(record, 'amount');
      let amountCents = 0;
      if (rawAmount !== '') {
        try {
          const parsed = parseAmount(rawAmount);
          amountCents = parsed.cents;
          if (parsed.warning) warnings.push(`Row ${row}: ${parsed.warning}`);
        } catch (error) {
          unrepresentable.push({ row, reason: (error as Error).message });
          return;
        }
      }

      if (account) accountUses.set(account, (accountUses.get(account) ?? 0) + 1);

      // A monthly fill marker. No amount, no breakdown, nothing to reproduce.
      if (payeeRaw.toLowerCase() === FILL_PAYEE) {
        counts.fill += 1;
        return;
      }

      if (payeeRaw.toLowerCase() === ENVELOPE_TRANSFER_PAYEE) {
        counts.envelopeTransfer += 1;
        if (envelope === '') {
          unrepresentable.push({ row, reason: 'Envelope transfer with no envelope on it' });
          return;
        }
        envelopeUses.set(envelope, (envelopeUses.get(envelope) ?? 0) + 1);
        envelopeTransferRows.push({ row, date, envelope, amountCents });
        return;
      }

      const base = {
        row,
        date,
        payeeRaw: payeeRaw || '(no description)',
        ...(memo ? { memo } : {}),
        ...(account ? { account } : {}),
        amountCents,
      };

      if (envelope !== '') {
        counts.spending += 1;
        envelopeUses.set(envelope, (envelopeUses.get(envelope) ?? 0) + 1);
        transactions.push({
          ...base,
          lines: [{ envelope, amountCents }],
          externalId: identityOf([date, String(amountCents), payeeRaw, account, envelope], seen),
        });
        return;
      }

      const parts = parseDetails(details);
      if (parts.length > 0) {
        const intoPoolOnly = parts.every((part) => part.envelope === AVAILABLE);
        counts[intoPoolOnly ? 'income' : 'split'] += 1;

        const sum = parts.reduce((total, part) => total + part.amountCents, 0);
        if (sum !== amountCents) {
          unrepresentable.push({
            row,
            reason:
              `Split parts come to ${sum} but the row total is ${amountCents}. ` +
              'A transaction whose parts do not sum to the whole cannot be recorded (FR-4).',
          });
          return;
        }

        for (const part of parts) {
          envelopeUses.set(part.envelope, (envelopeUses.get(part.envelope) ?? 0) + 1);
        }

        transactions.push({
          ...base,
          lines: parts.map((part) => ({ envelope: part.envelope, amountCents: part.amountCents })),
          externalId: identityOf(
            [date, String(amountCents), payeeRaw, account, parts.map((p) => p.envelope).join('+')],
            seen,
          ),
        });
        return;
      }

      if (details !== '') {
        unrepresentable.push({ row, reason: `Unreadable Details "${details.slice(0, 60)}"` });
        return;
      }

      // No envelope and no split: a transfer between the user's own accounts.
      counts.accountTransfer += 1;
      accountTransferRows.push({ row, date, account, amountCents, payeeRaw });
    });

    rowOffset += records.length;
  }

  const moves = pairEnvelopeTransfers(envelopeTransferRows, unrepresentable, seen);
  const transfers = pairAccountTransfers(accountTransferRows, unrepresentable, seen);

  dates.sort();
  const envelopeList = [...envelopeUses.entries()]
    .map(([name, uses]) => ({
      name,
      group: name.includes(':') ? name.slice(0, name.indexOf(':')) : null,
      uses,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    mapping,
    dateFormat,
    dateEvidence,
    dateRange: dates.length > 0 ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
    envelopes: envelopeList,
    accounts: [...accountUses.entries()]
      .map(([name, uses]) => ({ name, uses }))
      .sort((left, right) => right.uses - left.uses),
    transactions,
    moves,
    transfers,
    counts,
    unrepresentable,
    needsDefaultAccount: transactions.some((transaction) => !transaction.account),
    warnings,
    from,
  };
}

/**
 * Match the two halves of each envelope-to-envelope move.
 *
 * These exports write one row per side, same date, equal and opposite. Pairing by
 * date and magnitude reproduced all 284 in the real export. A row with no partner
 * is listed rather than turned into a one-sided move, which would break the
 * invariant the whole ledger rests on.
 */
function pairEnvelopeTransfers(
  rows: { row: number; date: string; envelope: string; amountCents: number }[],
  unrepresentable: Unrepresentable[],
  seen: Map<string, number>,
): PlannedMove[] {
  const moves: PlannedMove[] = [];
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) {
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  }

  for (const [date, sameDay] of byDate) {
    const outgoing = sameDay.filter((row) => row.amountCents < 0);
    const incoming = sameDay.filter((row) => row.amountCents > 0);
    const taken = new Set<number>();

    // A zero-amount row has no side to be on, so it can never pair. Saying so is
    // the point of MG-4: a row that silently disappears is worse than one that
    // cannot be reproduced.
    for (const row of sameDay.filter((candidate) => candidate.amountCents === 0)) {
      unrepresentable.push({
        row: row.row,
        reason: `Envelope transfer of zero in ${row.envelope}; there is nothing to move`,
      });
    }

    for (const from of outgoing) {
      const match = incoming.find(
        (row) => !taken.has(row.row) && row.amountCents === -from.amountCents,
      );
      if (!match) {
        unrepresentable.push({
          row: from.row,
          reason: `Envelope transfer out of ${from.envelope} with no matching row into anything`,
        });
        continue;
      }
      taken.add(match.row);
      moves.push({
        row: from.row,
        date,
        fromEnvelope: from.envelope,
        toEnvelope: match.envelope,
        amountCents: -from.amountCents,
        externalId: identityOf(
          ['move', date, String(-from.amountCents), from.envelope, match.envelope],
          seen,
        ),
      });
    }

    for (const row of incoming) {
      if (taken.has(row.row)) continue;
      unrepresentable.push({
        row: row.row,
        reason: `Envelope transfer into ${row.envelope} with no matching row out of anything`,
      });
    }
  }

  return moves;
}

/** The same pairing for transfers between the user's own accounts (FR-5). */
function pairAccountTransfers(
  rows: { row: number; date: string; account: string; amountCents: number; payeeRaw: string }[],
  unrepresentable: Unrepresentable[],
  seen: Map<string, number>,
): PlannedTransfer[] {
  const transfers: PlannedTransfer[] = [];
  const byDate = new Map<string, typeof rows>();
  for (const row of rows) {
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
  }

  for (const [date, sameDay] of byDate) {
    const outgoing = sameDay.filter((row) => row.amountCents < 0);
    const incoming = sameDay.filter((row) => row.amountCents > 0);
    const taken = new Set<number>();

    for (const row of sameDay.filter((candidate) => candidate.amountCents === 0)) {
      unrepresentable.push({
        row: row.row,
        reason: `"${row.payeeRaw}" is a zero-amount row with no envelope; there is nothing to record`,
      });
    }

    for (const from of outgoing) {
      const match = incoming.find(
        (row) => !taken.has(row.row) && row.amountCents === -from.amountCents,
      );
      if (!match) {
        unrepresentable.push({
          row: from.row,
          reason:
            `"${from.payeeRaw}" has no envelope and no matching row on another account, ` +
            'so it is neither spending nor a transfer this can reproduce',
        });
        continue;
      }
      taken.add(match.row);
      transfers.push({
        row: from.row,
        date,
        fromAccount: from.account,
        toAccount: match.account,
        amountCents: -from.amountCents,
        payeeRaw: from.payeeRaw || match.payeeRaw || 'Account transfer',
        externalId: identityOf(
          ['transfer', date, String(-from.amountCents), from.account, match.account],
          seen,
        ),
      });
    }

    for (const row of incoming) {
      if (taken.has(row.row)) continue;
      unrepresentable.push({
        row: row.row,
        reason:
          `"${row.payeeRaw}" has no envelope and no matching row on another account, ` +
          'so it is neither spending nor a transfer this can reproduce',
      });
    }
  }

  return transfers;
}

// ---------------------------------------------------------------------------
// Mapping and committing (MG-3, MG-5, MG-6)
// ---------------------------------------------------------------------------

export type EnvelopeChoice =
  | { action: 'create'; name: string; group: string }
  | { action: 'existing'; envelopeId: string };

export type AccountChoice =
  | { action: 'create'; name: string; kind: 'chequing' | 'savings' | 'credit_card' | 'cash' | 'line_of_credit' }
  | { action: 'existing'; accountId: string };

export type MigrationMapping = {
  /** Keyed by the envelope name exactly as the export writes it. */
  envelopes: Record<string, EnvelopeChoice>;
  accounts: Record<string, AccountChoice>;
  /** Where rows that name no account are recorded. Required when the plan says so. */
  defaultAccountId?: string;
};

export type MigrationResult = {
  batchId: string;
  added: number;
  /** Rows already migrated by an earlier run or an overlapping file (MG-1). */
  duplicates: number;
  moves: number;
  transfers: number;
  envelopesCreated: number;
  accountsCreated: number;
};

/**
 * Write the plan (MG-2, MG-4, MG-5).
 *
 * All of it happens in one database transaction: a migration that half-applied
 * would leave six years of history in a state nobody could reason about, and
 * NF-2 asks for atomicity by name. Everything it writes is tagged with one import
 * batch, so the whole thing can be undone in one step (MG-6) - envelope moves
 * included, which is why they carry a batch id.
 *
 * Migrated history arrives Confirmed, because it already was: the user
 * categorized it in GoodBudget, and putting six years into the review queue
 * would be an insult rather than a safeguard (MG-5).
 */
export async function commitMigration(
  db: Database,
  plan: MigrationPlan,
  mapping: MigrationMapping,
  meta: { filename?: string } = {},
): Promise<MigrationResult> {
  if (plan.needsDefaultAccount && !mapping.defaultAccountId) {
    throw new MigrationError(
      'Some rows name no account. Nominate one for them before committing.',
    );
  }

  // Read back off the plan rather than passed in again, so a commit cannot be
  // run against a different format from the one the files were read as.
  const AVAILABLE = migrationSource(plan.from).poolEnvelope;

  for (const envelope of plan.envelopes) {
    if (envelope.name === AVAILABLE) continue; // Always the income pool.
    if (!mapping.envelopes[envelope.name]) {
      throw new MigrationError(`No decision made about the envelope "${envelope.name}"`);
    }
  }
  for (const account of plan.accounts) {
    if (!mapping.accounts[account.name]) {
      throw new MigrationError(`No decision made about the account "${account.name}"`);
    }
  }

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(importBatches)
      .values({
        source: 'goodbudget',
        filename: meta.filename ?? null,
        accountId: mapping.defaultAccountId ?? null,
      })
      .returning({ id: importBatches.id });
    const batchId = batch!.id;

    // -- envelopes ---------------------------------------------------------

    const [pool] = await tx.select().from(envelopes).where(eq(envelopes.isUnallocated, true)).limit(1);
    if (!pool) {
      throw new MigrationError(
        'There is no income pool to put income in. Run the initial setup before migrating.',
      );
    }

    const envelopeIds = new Map<string, string>([[AVAILABLE, pool.id]]);
    const groupIds = new Map<string, string>();
    let envelopesCreated = 0;

    const existingGroups = await tx.select().from(envelopeGroups);
    for (const group of existingGroups) groupIds.set(group.name, group.id);

    // What is already here, so "create" does not mean "create a second one".
    // Re-running a migration is a normal thing to do - a longer export, a file
    // that was split by date - and it should leave the chart of envelopes alone.
    const existingEnvelopes = await tx
      .select({ id: envelopes.id, name: envelopes.name, groupId: envelopes.groupId })
      .from(envelopes);
    const byGroupAndName = new Map(
      existingEnvelopes.map((row) => [`${row.groupId}\u0000${row.name.toLowerCase()}`, row.id]),
    );

    for (const [name, choice] of Object.entries(mapping.envelopes)) {
      if (choice.action === 'existing') {
        envelopeIds.set(name, choice.envelopeId);
        continue;
      }

      let groupId = groupIds.get(choice.group);
      if (!groupId) {
        const [created] = await tx
          .insert(envelopeGroups)
          .values({ name: choice.group, position: groupIds.size })
          .returning({ id: envelopeGroups.id });
        groupId = created!.id;
        groupIds.set(choice.group, groupId);
      }

      const already = byGroupAndName.get(`${groupId}\u0000${choice.name.toLowerCase()}`);
      if (already) {
        envelopeIds.set(name, already);
        continue;
      }

      const [created] = await tx
        .insert(envelopes)
        .values({ groupId, name: choice.name })
        .returning({ id: envelopes.id });
      envelopeIds.set(name, created!.id);
      byGroupAndName.set(`${groupId}\u0000${choice.name.toLowerCase()}`, created!.id);
      envelopesCreated += 1;
    }

    // -- accounts ----------------------------------------------------------

    const accountIds = new Map<string, string>();
    let accountsCreated = 0;

    const existingAccounts = await tx.select({ id: accounts.id, name: accounts.name }).from(accounts);
    const accountsByName = new Map(
      existingAccounts.map((row) => [row.name.toLowerCase(), row.id]),
    );

    for (const [name, choice] of Object.entries(mapping.accounts)) {
      if (choice.action === 'existing') {
        accountIds.set(name, choice.accountId);
        continue;
      }

      const already = accountsByName.get(choice.name.toLowerCase());
      if (already) {
        accountIds.set(name, already);
        continue;
      }

      const [created] = await tx
        .insert(accounts)
        .values({ name: choice.name, kind: choice.kind })
        .returning({ id: accounts.id });
      accountIds.set(name, created!.id);
      accountsByName.set(choice.name.toLowerCase(), created!.id);
      accountsCreated += 1;
    }

    const accountFor = (name: string | undefined): string => {
      if (!name) {
        if (!mapping.defaultAccountId) {
          throw new MigrationError('A row names no account and no default was nominated');
        }
        return mapping.defaultAccountId;
      }
      const id = accountIds.get(name);
      if (!id) throw new MigrationError(`No account mapped for "${name}"`);
      return id;
    };

    const envelopeFor = (name: string): string => {
      const id = envelopeIds.get(name);
      if (!id) throw new MigrationError(`No envelope mapped for "${name}"`);
      return id;
    };

    // -- what is already here (MG-1) ---------------------------------------

    const transactionIds = [
      ...plan.transactions.map((transaction) => transaction.externalId),
      ...plan.transfers.map((transfer) => transfer.externalId),
    ];

    const known = new Set<string>();
    for (let start = 0; start < transactionIds.length; start += 1000) {
      const slice = transactionIds.slice(start, start + 1000);
      if (slice.length === 0) break;
      const rows = await tx
        .select({ value: transactionExternalIds.value })
        .from(transactionExternalIds)
        .where(
          and(
            eq(transactionExternalIds.kind, 'goodbudget'),
            inArray(transactionExternalIds.value, slice),
          ),
        );
      for (const row of rows) known.add(row.value);
    }

    // An envelope move is not a transaction, so it carries its own identity
    // rather than a row in the external id table. Without this, a second run
    // would move the money a second time.
    const moveIds = plan.moves.map((move) => move.externalId);
    for (let start = 0; start < moveIds.length; start += 1000) {
      const slice = moveIds.slice(start, start + 1000);
      if (slice.length === 0) break;
      const rows = await tx
        .select({ externalId: envelopeMoves.externalId })
        .from(envelopeMoves)
        .where(inArray(envelopeMoves.externalId, slice));
      for (const row of rows) if (row.externalId) known.add(row.externalId);
    }

    // -- transactions ------------------------------------------------------

    let added = 0;
    let duplicates = 0;

    for (const planned of plan.transactions) {
      if (known.has(planned.externalId)) {
        duplicates += 1;
        continue;
      }

      const accountId = accountFor(planned.account);
      const [created] = await tx
        .insert(transactions)
        .values({
          accountId,
          date: planned.date,
          amountCents: planned.amountCents,
          payeeRaw: planned.payeeRaw,
          payeeKey: normalizePayee(planned.payeeRaw).key,
          memo: planned.memo ?? null,
          kind: 'spending',
          status: 'confirmed',
          source: 'goodbudget',
          importBatchId: batchId,
        })
        .returning({ id: transactions.id });

      const transactionId = created!.id;

      if (planned.lines.length > 0) {
        await tx.insert(txnLines).values(
          planned.lines.map((line) => ({
            transactionId,
            envelopeId: envelopeFor(line.envelope),
            amountCents: line.amountCents,
          })),
        );
      }

      await tx.insert(transactionExternalIds).values({
        transactionId,
        accountId,
        kind: 'goodbudget',
        value: planned.externalId,
      });

      added += 1;
    }

    // -- account transfers (FR-5) ------------------------------------------

    let transfersWritten = 0;
    for (const planned of plan.transfers) {
      if (known.has(planned.externalId)) {
        duplicates += 1;
        continue;
      }

      const fromAccountId = accountFor(planned.fromAccount || undefined);
      const toAccountId = accountFor(planned.toAccount || undefined);
      if (fromAccountId === toAccountId) {
        // Both halves landed on the same Manilla account, so the pair says
        // nothing. Recording it would be two rows that cancel out.
        duplicates += 1;
        continue;
      }

      const pairId = crypto.randomUUID();
      const halves = await tx
        .insert(transactions)
        .values([
          {
            accountId: fromAccountId,
            date: planned.date,
            amountCents: -planned.amountCents,
            payeeRaw: planned.payeeRaw,
            payeeKey: normalizePayee(planned.payeeRaw).key,
            kind: 'account_transfer' as const,
            status: 'confirmed' as const,
            source: 'goodbudget' as const,
            importBatchId: batchId,
            transferPairId: pairId,
          },
          {
            accountId: toAccountId,
            date: planned.date,
            amountCents: planned.amountCents,
            payeeRaw: planned.payeeRaw,
            payeeKey: normalizePayee(planned.payeeRaw).key,
            kind: 'account_transfer' as const,
            status: 'confirmed' as const,
            source: 'goodbudget' as const,
            importBatchId: batchId,
            transferPairId: pairId,
          },
        ])
        .returning({ id: transactions.id });

      await tx.insert(transactionExternalIds).values({
        transactionId: halves[0]!.id,
        accountId: fromAccountId,
        kind: 'goodbudget',
        value: planned.externalId,
      });

      transfersWritten += 1;
    }

    // -- envelope moves (FR-34) --------------------------------------------

    const freshMoves = plan.moves.filter((move) => !known.has(move.externalId));
    duplicates += plan.moves.length - freshMoves.length;

    if (freshMoves.length > 0) {
      await tx.insert(envelopeMoves).values(
        freshMoves.map((move) => ({
          fromEnvelopeId: envelopeFor(move.fromEnvelope),
          toEnvelopeId: envelopeFor(move.toEnvelope),
          amountCents: move.amountCents,
          date: move.date,
          kind: 'transfer' as const,
          // These notes end up in an envelope's history, where they are read by
          // the user rather than by us, so they name what happened and not the
          // app it came from (#11).
          note: MIGRATED_NOTE,
          importBatchId: batchId,
          externalId: move.externalId,
        })),
      );
    }

    await tx
      .update(importBatches)
      .set({ addedCount: added + transfersWritten, duplicateCount: duplicates })
      .where(eq(importBatches.id, batchId));

    return {
      batchId,
      added,
      duplicates,
      moves: freshMoves.length,
      transfers: transfersWritten,
      envelopesCreated,
      accountsCreated,
    };
  });
}

/** Undo a whole migration, envelope moves included (MG-6). */
export async function revertMigration(db: Database, batchId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(envelopeMoves).where(eq(envelopeMoves.importBatchId, batchId));
    const removed = await tx
      .delete(transactions)
      .where(eq(transactions.importBatchId, batchId))
      .returning({ id: transactions.id });
    await tx
      .update(importBatches)
      .set({ revertedAt: new Date() })
      .where(eq(importBatches.id, batchId));
    return removed.length;
  });
}

// ---------------------------------------------------------------------------
// Reconciliation (MG-7)
// ---------------------------------------------------------------------------

export type ReconcileLine = {
  envelopeId: string;
  name: string;
  groupName: string;
  isUnallocated: boolean;
  /** What the migrated history adds up to here. */
  computedCents: number;
  /** What GoodBudget says it should be, when the user has said. */
  expectedCents: number | null;
  differenceCents: number;
};

export type Reconciliation = {
  lines: ReconcileLine[];
  /** Total across every envelope the user gave a figure for. */
  differenceCents: number;
  /** Envelopes still without a figure, so the report can say it is incomplete. */
  unanswered: number;
};

/**
 * Compare migrated balances with the ones GoodBudget shows (MG-7).
 *
 * They will not agree, and the reason is structural rather than a bug: the export
 * records what was *spent* out of each envelope but not what was ever *put in*,
 * because "Fill Envelopes" rows carry no amounts. So every envelope comes out
 * short by exactly what it was filled with over the years. This is the report
 * that says so per envelope, and `applyReconciliation` is the one step that
 * closes it - as a dated, visible adjustment, not a silent correction.
 */
export async function reconcile(
  db: Database,
  expected: Record<string, number> = {},
): Promise<Reconciliation> {
  const { envelopeBalances } = await import('../ledger/ledger.ts');
  const balances = await envelopeBalances(db);

  const lines = balances.map((balance): ReconcileLine => {
    const stated = expected[balance.envelopeId];
    return {
      envelopeId: balance.envelopeId,
      name: balance.name,
      groupName: balance.groupName,
      isUnallocated: balance.isUnallocated,
      computedCents: balance.balanceCents,
      expectedCents: stated === undefined ? null : stated,
      differenceCents: stated === undefined ? 0 : stated - balance.balanceCents,
    };
  });

  return {
    lines,
    differenceCents: lines.reduce((sum, line) => sum + line.differenceCents, 0),
    unanswered: lines.filter((line) => line.expectedCents === null && !line.isUnallocated).length,
  };
}

/**
 * Write the adjustments that make the migrated balances match GoodBudget.
 *
 * Each one is an ordinary dated envelope move to or from the income pool, noted
 * as what it is. That keeps the invariant - a move never changes the total, so
 * the pool absorbs the difference and envelopes plus accounts still agree
 * (FR-37) - and it leaves the adjustment visible in the envelope's history
 * rather than hidden in a balance that came from nowhere.
 *
 * The pool going negative afterwards is a real finding, not a failure: it means
 * the envelope balances carried over from GoodBudget add up to more than the
 * accounts actually hold.
 */
export async function applyReconciliation(
  db: Database,
  adjustments: { envelopeId: string; differenceCents: number }[],
  options: { date: string; batchId?: string } = { date: new Date().toISOString().slice(0, 10) },
): Promise<number> {
  const real = adjustments.filter((adjustment) => adjustment.differenceCents !== 0);
  if (real.length === 0) return 0;

  const [pool] = await db.select().from(envelopes).where(eq(envelopes.isUnallocated, true)).limit(1);
  if (!pool) throw new MigrationError('There is no income pool to adjust against.');

  if (real.some((adjustment) => adjustment.envelopeId === pool.id)) {
    throw new MigrationError(
      'The income pool is what the adjustments come from, so it cannot be adjusted itself. ' +
        'Whatever is left in it after the others is its balance.',
    );
  }

  await db.insert(envelopeMoves).values(
    real.map((adjustment) => ({
      // A shortfall is money moving in; a surplus is money moving back out.
      fromEnvelopeId: adjustment.differenceCents > 0 ? pool.id : adjustment.envelopeId,
      toEnvelopeId: adjustment.differenceCents > 0 ? adjustment.envelopeId : pool.id,
      amountCents: Math.abs(adjustment.differenceCents),
      date: options.date,
      kind: 'allocation' as const,
      note: CARRIED_OVER_NOTE,
      importBatchId: options.batchId ?? null,
    })),
  );

  return real.length;
}
