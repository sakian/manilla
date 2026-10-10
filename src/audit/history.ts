/**
 * A transaction's audit trail as a person would tell it (NF-2).
 *
 * The trail stores columns as they were and as they became; this turns them
 * into "amount −$12.00 → −$14.50" and "envelopes changed (was Groceries)". One
 * save writes several rows - the transaction and each of its envelope lines -
 * and they share the moment their database transaction began, so rows with the
 * same moment and the same person are one entry.
 *
 * Only updates and deletions are in the trail (the trigger skips inserts), so
 * the oldest entry - how it arrived, and who brought it - comes from the
 * transaction itself, which says when it came and who made it.
 *
 * What people wrote about it (its thread, RQ-7) is told here too: a message
 * shares its moment and person with whatever was saved beside it, so a
 * handover and its note are one entry. An edit or removal of a message is in
 * the trail like any other change.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { accounts, auditLog, envelopes, transactionMessages, transactions } from '../../db/schema.ts';
import { formatMoney } from '../money.ts';

export type HistoryEntry = {
  at: Date;
  /** Null for changes made before the trail recorded who. */
  who: string | null;
  changes: string[];
};

type Row = typeof auditLog.$inferSelect;
type Json = Record<string, unknown>;

const money = (value: unknown) => formatMoney(Number(value));
const quoted = (value: unknown) => (value == null || value === '' ? 'nothing' : `"${String(value)}"`);

export async function transactionHistory(
  db: Database,
  transactionId: string,
  /** Members by id, from the home database, so a handover can name who it went to (RQ-7). */
  members: Map<string, string> = new Map(),
): Promise<HistoryEntry[]> {
  const [rows, [arrival], messages] = await Promise.all([
    db.select().from(auditLog).where(eq(auditLog.transactionId, transactionId)).orderBy(asc(auditLog.id)),
    db
      .select({ at: transactions.createdAt, who: transactions.createdByName, source: transactions.source })
      .from(transactions)
      .where(eq(transactions.id, transactionId)),
    db
      .select({ at: transactionMessages.createdAt, who: transactionMessages.authorName, body: transactionMessages.body })
      .from(transactionMessages)
      .where(eq(transactionMessages.transactionId, transactionId))
      .orderBy(asc(transactionMessages.createdAt), asc(transactionMessages.id)),
  ]);
  const arrived: HistoryEntry[] = arrival
    ? [{ at: arrival.at, who: arrival.who, changes: [ARRIVED[arrival.source]] }]
    : [];
  if (rows.length === 0 && messages.length === 0) return arrived;

  const names = { ...(await namesFor(db, rows)), member: members };
  const entries: HistoryEntry[] = [];

  for (const row of rows) {
    const who = row.actorName ?? null;
    const last = entries[entries.length - 1];
    const entry =
      last && last.at.getTime() === row.at.getTime() && last.who === who
        ? last
        : { at: row.at, who, changes: [] as string[] };
    if (entry !== last) entries.push(entry);
    entry.changes.push(...describe(row, names));
  }

  for (const message of messages) {
    const said = `wrote ${quoted(message.body)}`;
    const same = entries.find((entry) => entry.at.getTime() === message.at.getTime() && entry.who === message.who);
    if (same) same.changes.push(said);
    else entries.push({ at: message.at, who: message.who, changes: [said] });
  }
  entries.sort((a, b) => a.at.getTime() - b.at.getTime());

  // A save that deleted several lines says so once.
  for (const entry of entries) entry.changes = mergeLineRemovals(entry.changes);
  return [...entries.filter((entry) => entry.changes.length > 0).reverse(), ...arrived];
}

const ARRIVED: Record<(typeof transactions.$inferSelect)['source'], string> = {
  manual: 'added',
  file_import: 'imported from a file',
  bank_sync: 'synced from the bank',
  goodbudget: 'brought over from GoodBudget',
  opening_balance: 'added as the opening balance',
};

type Names = { account: Map<string, string>; envelope: Map<string, string>; member?: Map<string, string> };

/** Account and envelope names, current ones, for every id the rows mention. */
async function namesFor(db: Database, rows: Row[]): Promise<Names> {
  const accountIds = new Set<string>();
  const envelopeIds = new Set<string>();
  for (const row of rows) {
    for (const side of [row.before as Json, row.after as Json | null]) {
      if (!side) continue;
      if (typeof side.account_id === 'string') accountIds.add(side.account_id);
      if (typeof side.envelope_id === 'string') envelopeIds.add(side.envelope_id);
    }
  }
  const [accountRows, envelopeRows] = await Promise.all([
    accountIds.size
      ? db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(inArray(accounts.id, [...accountIds]))
      : [],
    envelopeIds.size
      ? db.select({ id: envelopes.id, name: envelopes.name }).from(envelopes).where(inArray(envelopes.id, [...envelopeIds]))
      : [],
  ]);
  return {
    account: new Map(accountRows.map((row) => [row.id, row.name])),
    envelope: new Map(envelopeRows.map((row) => [row.id, row.name])),
  };
}

const REMOVED_LINE = 'removed line: ';

function describe(row: Row, names: Names): string[] {
  const before = row.before as Json;
  const after = (row.after ?? {}) as Json;
  const envelope = (id: unknown) => names.envelope.get(String(id)) ?? 'an envelope since removed';
  const account = (id: unknown) => names.account.get(String(id)) ?? 'an account since removed';

  if (row.tableName === 'transactions') {
    if (row.action === 'delete') return ['deleted'];
    const changes: string[] = [];
    for (const column of Object.keys(before)) {
      const was = before[column];
      const now = after[column];
      switch (column) {
        case 'amount_cents':
          changes.push(`amount ${money(was)} → ${money(now)}`);
          break;
        case 'date':
          changes.push(`date ${String(was)} → ${String(now)}`);
          break;
        case 'payee_raw':
          changes.push(`payee ${quoted(was)} → ${quoted(now)}`);
          break;
        case 'account_id':
          changes.push(`moved from ${account(was)} to ${account(now)}`);
          break;
        case 'note':
          changes.push(now ? `note ${quoted(now)}` : 'note removed');
          break;
        case 'memo':
          changes.push(`memo ${quoted(was)} → ${quoted(now)}`);
          break;
        case 'check_number':
          changes.push(`cheque number ${quoted(was)} → ${quoted(now)}`);
          break;
        case 'status':
          changes.push(now === 'confirmed' ? 'confirmed' : 'sent to review');
          break;
        case 'kind':
          changes.push(now === 'account_transfer' ? 'made a transfer' : 'no longer a transfer');
          break;
        case 'handed_to_id':
          changes.push(`handed to ${names.member?.get(String(now)) ?? 'someone no longer a member'} for review`);
          break;
        // payee_key follows payee_raw; the rest are bookkeeping nobody acts on.
      }
    }
    return changes;
  }

  if (row.tableName === 'txn_lines') {
    if (row.action === 'delete') {
      return [`${REMOVED_LINE}${envelope(before.envelope_id)} ${money(before.amount_cents)}`];
    }
    const changes: string[] = [];
    if ('envelope_id' in before) {
      changes.push(`${envelope(before.envelope_id)} → ${envelope(after.envelope_id)}`);
    }
    if ('amount_cents' in before) {
      const which = envelope(after.envelope_id ?? before.envelope_id);
      changes.push(`${which} ${money(before.amount_cents)} → ${money(after.amount_cents)}`);
    }
    return changes;
  }

  if (row.tableName === 'transaction_messages') {
    if (row.action === 'delete') return [`removed ${quoted(before.body)}`];
    if ('body' in before) return [`changed ${quoted(before.body)} to ${quoted(after.body)}`];
    return [];
  }

  return [];
}

/**
 * Saving a transaction replaces its envelope lines, so the trail sees every old
 * line deleted. Said as one change, with what the split used to be.
 */
function mergeLineRemovals(changes: string[]): string[] {
  const removed = changes.filter((change) => change.startsWith(REMOVED_LINE));
  if (removed.length === 0) return changes;
  const rest = changes.filter((change) => !change.startsWith(REMOVED_LINE));
  const was = removed.map((change) => change.slice(REMOVED_LINE.length)).join(', ');
  return [...rest, `envelopes changed (was ${was})`];
}
